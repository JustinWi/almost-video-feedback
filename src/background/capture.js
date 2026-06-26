/*
 * Capture pipeline (service worker). Classic script -> globalThis.SCF.capture.
 *
 * Responsibilities:
 *   - single-flight queue with a min-interval rate limit (captureVisibleTab is
 *     browser-capped at ~2/s) and burst coalescing for noisy triggers
 *   - hide the page overlay during the capture so our own UI never appears in
 *     the screenshot (handshake with the content script, with a timeout fallback)
 *   - dedup near-identical frames via dHash Hamming distance (priority triggers
 *     bypass the cull); keep what's left in the IndexedDB session store
 */
(function (root) {
  'use strict';
  root.SCF = root.SCF || {};
  const { MSG, PRIORITY_TRIGGERS } = root.SCF;
  const imageHash = root.SCF.imageHash;
  const store = root.SCF.sessionStore;

  // Grayscale thumbnail size for region-aware click dedup (bigger than the 9x8
  // dHash so the area around a click is actually resolvable).
  const THUMB_W = 64;
  const THUMB_H = 40;

  const state = {
    enabled: false,
    paused: false,
    busy: false,
    queue: [],
    lastCaptureAt: 0,
    lastKeptHash: null,
    lastKeptThumb: null, // Uint8Array gray thumbnail of the last kept frame
    seq: 0,
    ctx: null, // { windowId, tabId, settings, lastUrl, lastTitle }
    timer: null,
  };

  // Optional hooks the orchestrator can set.
  const hooks = { onKept: null, onCapturedRaw: null };

  let captureIdCounter = 0;

  function begin(ctx) {
    state.enabled = true;
    state.paused = false;
    state.busy = false;
    state.queue = [];
    state.lastCaptureAt = 0;
    state.lastKeptHash = null;
    state.lastKeptThumb = null;
    state.seq = 0;
    state.ctx = ctx;
    state.dir =
      root.SCF.downloads && ctx && ctx.startedAt ? root.SCF.downloads.sessionDir(ctx.startedAt) : null;
  }

  // Restore capture state after a service-worker restart mid-session.
  function restore(ctx, lastSeq, lastHash) {
    begin(ctx);
    state.seq = lastSeq || 0;
    state.lastKeptHash = lastHash || null;
  }

  function end() {
    state.enabled = false;
    state.queue = [];
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function setContext(patch) {
    if (state.ctx) Object.assign(state.ctx, patch);
  }

  function getSeq() {
    return state.seq;
  }

  function setPaused(p) {
    state.paused = !!p;
    if (state.paused) state.queue = []; // drop anything queued; nothing captures while paused
  }

  function request(trigger, meta) {
    if (!state.enabled || state.paused || !state.ctx) return;
    const settings = state.ctx.settings;
    // Respect per-trigger toggles, but forced/start are always allowed.
    if (
      settings && settings.triggers && settings.triggers[trigger] === false &&
      trigger !== 'forced' && trigger !== 'start'
    ) {
      return;
    }
    const priority = PRIORITY_TRIGGERS.has(trigger);
    const item = { trigger, meta: meta || {}, priority, at: Date.now() };

    // Collapse a run of non-priority requests into the latest one.
    const last = state.queue[state.queue.length - 1];
    if (last && !last.priority && !priority) {
      state.queue[state.queue.length - 1] = item;
    } else {
      state.queue.push(item);
    }

    // Safety cap: never let the queue grow unbounded; drop oldest non-priority.
    if (state.queue.length > 8) {
      const idx = state.queue.findIndex((q) => !q.priority);
      state.queue.splice(idx >= 0 ? idx : 0, 1);
    }

    pump();
  }

  function pump() {
    if (state.busy || !state.enabled || state.queue.length === 0) return;
    const minInterval = (state.ctx.settings && state.ctx.settings.minCaptureIntervalMs) || 650;
    const wait = minInterval - (Date.now() - state.lastCaptureAt);
    if (wait > 0) {
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null;
          pump();
        }, wait);
      }
      return;
    }
    const req = state.queue.shift();
    state.busy = true;
    doCapture(req)
      .catch((err) => console.warn('[scf] capture failed:', err && err.message))
      .finally(() => {
        state.busy = false;
        state.lastCaptureAt = Date.now();
        pump();
      });
  }

  function sendToContent(tabId, msg, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const to = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(null);
        }
      }, timeoutMs || 300);
      try {
        chrome.tabs.sendMessage(tabId, msg, (resp) => {
          void chrome.runtime.lastError; // swallow "no receiver"
          if (!done) {
            done = true;
            clearTimeout(to);
            resolve(resp == null ? null : resp);
          }
        });
      } catch (e) {
        if (!done) {
          done = true;
          clearTimeout(to);
          resolve(null);
        }
      }
    });
  }

  // Decode once, produce both signatures: the 9x8 dHash (whole-frame dedup) and a
  // larger grayscale thumbnail (region-aware click dedup).
  async function computeSignature(blob) {
    const bitmap = await createImageBitmap(blob);
    const c1 = new OffscreenCanvas(imageHash.HASH_W, imageHash.HASH_H);
    const x1 = c1.getContext('2d', { willReadFrequently: true });
    x1.drawImage(bitmap, 0, 0, imageHash.HASH_W, imageHash.HASH_H);
    const hash = imageHash.dHash(x1.getImageData(0, 0, imageHash.HASH_W, imageHash.HASH_H));

    const c2 = new OffscreenCanvas(THUMB_W, THUMB_H);
    const x2 = c2.getContext('2d', { willReadFrequently: true });
    x2.drawImage(bitmap, 0, 0, THUMB_W, THUMB_H);
    const thumb = imageHash.toGray(x2.getImageData(0, 0, THUMB_W, THUMB_H));

    bitmap.close();
    return { hash, thumb };
  }

  // Region-aware "should this click frame be culled?" -> true means cull.
  // Keep when the area around the click changed OR the whole frame changed a lot;
  // cull only when essentially nothing changed (a click that did nothing visible).
  function clickShouldCull(thumb, lastThumb, meta, settings) {
    if (!thumb || !lastThumb) return false; // no basis to compare -> keep
    const radius = settings.clickRegionRadius || 9;
    const eps = settings.clickChangeEps != null ? settings.clickChangeEps : 18;
    const localT = settings.clickLocalChange != null ? settings.clickLocalChange : 0.04;
    const globalT = settings.clickGlobalChange != null ? settings.clickGlobalChange : 0.012;
    const nx = meta && meta.clickX != null ? meta.clickX : 0.5;
    const ny = meta && meta.clickY != null ? meta.clickY : 0.5;
    const box = imageHash.regionBox(THUMB_W, THUMB_H, nx, ny, radius);
    const local = imageHash.changeRatio(thumb, lastThumb, THUMB_W, THUMB_H, box, eps);
    const global = imageHash.changeRatio(thumb, lastThumb, THUMB_W, THUMB_H, null, eps);
    return !(local >= localT || global >= globalT);
  }

  async function doCapture(req) {
    const ctx = state.ctx;
    if (!ctx) return;
    const settings = ctx.settings || {};
    const tabId = ctx.tabId;

    // The overlay is intentionally NOT hidden during capture (it would flicker);
    // it's a movable/minimizable bar the user can position out of shots.
    let dataUrl;
    const opts =
      settings.captureFormat === 'jpeg'
        ? { format: 'jpeg', quality: settings.jpegQuality || 90 }
        : { format: 'png' };
    dataUrl = await chrome.tabs.captureVisibleTab(ctx.windowId, opts);

    if (!dataUrl) return;

    const mime = settings.captureFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await (await fetch(dataUrl)).blob();

    // 4) dedup
    let hash = null;
    let thumb = null;
    try {
      const sig = await computeSignature(blob);
      hash = sig.hash;
      thumb = sig.thumb;
    } catch (e) {
      // if signatures fail, fall through and keep the frame
    }
    const threshold = settings.dedupHammingThreshold != null ? settings.dedupHammingThreshold : 6;

    if (req.trigger === 'click') {
      // Clicks are deliberate; how they dedup is configurable.
      const mode = settings.clickDedup || 'smart';
      if (mode === 'smart') {
        if (clickShouldCull(thumb, state.lastKeptThumb, req.meta, settings)) return;
      } else if (mode === 'global') {
        if (hash && state.lastKeptHash && imageHash.hammingDistance(state.lastKeptHash, hash) <= threshold) return;
      }
      // 'always' -> never culled
    } else if (
      !req.priority &&
      hash &&
      state.lastKeptHash &&
      imageHash.hammingDistance(state.lastKeptHash, hash) <= threshold
    ) {
      return; // visually unchanged -> cull
    }

    // 5) safety cap on total screenshots
    const cap = settings.maxScreenshots || 300;
    if (state.seq >= cap) {
      console.warn('[scf] screenshot cap reached (' + cap + '), skipping further captures');
      return;
    }

    // 6) keep it
    state.seq += 1;
    const seq = state.seq;
    if (hash) state.lastKeptHash = hash;
    if (thumb) state.lastKeptThumb = thumb;

    await store.addScreenshot(seq, blob, mime);
    const meta = req.meta || {};
    const evt = {
      t: req.at || Date.now(),
      type: 'screenshot',
      seq,
      mime,
      trigger: req.trigger,
      url: meta.url || ctx.lastUrl || null,
      title: meta.title || ctx.lastTitle || null,
      element: meta.element || null,
      selectionText: meta.selectionText || null,
      scrollY: meta.scrollY != null ? meta.scrollY : null,
      hash: hash || null,
    };
    await store.addEvent(evt);
    store.patchMeta({ lastKeptHash: state.lastKeptHash, lastSeq: seq }).catch(() => {});

    // write the PNG to Downloads now, during the recording, so stop stays fast
    if (state.dir && root.SCF.downloads && root.SCF.exporter) {
      root.SCF.downloads.saveShot(state.dir, root.SCF.exporter.fileFor(seq), blob, mime).catch(() => {});
    }

    // 7) UI feedback + hook
    sendToContent(tabId, { type: MSG.SCREENSHOT_TOAST, seq, trigger: req.trigger }, 100);
    if (typeof hooks.onKept === 'function') {
      try {
        hooks.onKept({ seq, trigger: req.trigger });
      } catch (e) {
        /* ignore */
      }
    }
  }

  root.SCF.capture = { begin, restore, end, setContext, setPaused, request, getSeq, hooks, _state: state };
})(typeof globalThis !== 'undefined' ? globalThis : self);
