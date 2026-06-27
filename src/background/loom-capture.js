/*
 * Loom import capture (service worker). Classic script -> globalThis.SCF.loomCapture.
 *
 * Drives the Loom page (via LOOM_SEEK messages to the content script) to each
 * target time, captures the visible tab, crops to the video rect, dedups, and
 * stores screenshot + transcript events on the same timeline the live recorder
 * uses. captureVisibleTab sees cross-origin video pixels (rendered output), so
 * there is no canvas-taint problem.
 */
(function (root) {
  'use strict';
  root.SCF = root.SCF || {};
  const { MSG, TRIGGER } = root.SCF;
  const imageHash = root.SCF.imageHash;
  const loomTimeline = root.SCF.loomTimeline;
  const exporter = root.SCF.exporter;
  const downloads = root.SCF.downloads;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function sendToTab(tabId, msg, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs || 4000);
      try {
        chrome.tabs.sendMessage(tabId, msg, (resp) => {
          void chrome.runtime.lastError;
          if (!done) { done = true; clearTimeout(to); resolve(resp == null ? null : resp); }
        });
      } catch (e) { if (!done) { done = true; clearTimeout(to); resolve(null); } }
    });
  }

  // Crop a captureVisibleTab dataURL to a CSS rect (scaled by dpr). Falls back to
  // the full frame if the rect is unusable.
  async function cropToRect(dataUrl, rect, dpr, mime) {
    const blob = await (await fetch(dataUrl)).blob();
    if (!rect || !rect.width || !rect.height) return blob;
    const bitmap = await createImageBitmap(blob);
    const sx = Math.max(0, Math.round(rect.x * dpr));
    const sy = Math.max(0, Math.round(rect.y * dpr));
    const sw = Math.min(bitmap.width - sx, Math.round(rect.width * dpr));
    const sh = Math.min(bitmap.height - sy, Math.round(rect.height * dpr));
    if (sw <= 0 || sh <= 0) { bitmap.close(); return blob; }
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    bitmap.close();
    return await canvas.convertToBlob(
      mime === 'image/jpeg' ? { type: 'image/jpeg', quality: 0.9 } : { type: 'image/png' }
    );
  }

  async function hashOf(blob) {
    try {
      const bitmap = await createImageBitmap(blob);
      const c = new OffscreenCanvas(imageHash.HASH_W, imageHash.HASH_H);
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bitmap, 0, 0, imageHash.HASH_W, imageHash.HASH_H);
      const h = imageHash.dHash(x.getImageData(0, 0, imageHash.HASH_W, imageHash.HASH_H));
      bitmap.close();
      return h;
    } catch (e) { return null; }
  }

  /**
   * @param {{tabId:number, windowId:number, startedAt:number, settings:object,
   *          dir:string, store:object, onProgress?:function}} a
   * @returns {Promise<{frames:number, segments:number, error?:string}>}
   */
  async function runImport(a) {
    const { tabId, windowId, startedAt, settings, dir, store } = a;
    const onProgress = a.onProgress || function () {};

    const probe = await sendToTab(tabId, { type: MSG.LOOM_PROBE }, 8000);
    if (!probe || !probe.ok) return { frames: 0, segments: 0, error: (probe && probe.error) || 'probe-failed' };
    if (!probe.hasTranscript) return { frames: 0, segments: 0, error: 'no-transcript' };

    const segments = probe.segments;
    const title = probe.title || 'Loom video';
    const url = (await chrome.tabs.get(tabId).catch(() => null) || {}).url || null;

    const floorMs = (settings.loomFrameFloorSeconds || 15) * 1000;
    const maxFrames = settings.maxScreenshots || 300;
    const targets = loomTimeline.buildTargets(segments.map((s) => s.ms), { floorMs, maxFrames });

    const mime = settings.captureFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
    const opts = settings.captureFormat === 'jpeg' ? { format: 'jpeg', quality: settings.jpegQuality || 90 } : { format: 'png' };
    const threshold = settings.dedupHammingThreshold != null ? settings.dedupHammingThreshold : 6;
    const settle = settings.loomSeekSettleMs || 350;

    let seq = 0;
    let lastHash = null;
    try {
      for (let i = 0; i < targets.length; i++) {
        const ms = targets[i];
        onProgress({ done: i, total: targets.length, phase: 'capturing' });
        const seek = await sendToTab(tabId, { type: MSG.LOOM_SEEK, ms }, 4000);
        await delay(settle);
        let dataUrl;
        try { dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts); } catch (e) { dataUrl = null; }
        if (!dataUrl) continue; // tab not foreground / capture failed -> skip this target
        const rect = seek && seek.ok ? seek.rect : null;
        const dpr = seek && seek.ok ? (seek.dpr || 1) : 1;
        const blob = await cropToRect(dataUrl, rect, dpr, mime);

        const hash = await hashOf(blob);
        if (hash && lastHash && imageHash.hammingDistance(lastHash, hash) <= threshold) continue; // unchanged -> cull
        if (hash) lastHash = hash;

        seq += 1;
        await store.addScreenshot(seq, blob, mime);
        await store.addEvent({
          t: startedAt + ms, type: 'screenshot', seq, mime,
          trigger: TRIGGER.FRAME, url, title, element: null, selectionText: null, scrollY: null, hash: hash || null,
        });
        if (dir && downloads && exporter) downloads.saveShot(dir, exporter.fileFor(seq), blob, mime).catch(() => {});
      }

      // transcript events (final segments) on the same timeline
      for (const s of segments) {
        if (s.text && s.text.trim()) await store.addEvent({ t: startedAt + s.ms, type: 'transcript', final: true, text: s.text.trim() });
      }
    } finally {
      await sendToTab(tabId, { type: MSG.LOOM_SEEK, restore: true }, 1000); // un-mute, restore controls
    }
    onProgress({ done: targets.length, total: targets.length, phase: 'done' });
    // lastMs = end of the video we covered, so the bundle's duration is meaningful
    const lastTarget = targets.length ? targets[targets.length - 1] : 0;
    const lastSeg = segments.length ? segments[segments.length - 1].ms : 0;
    return { frames: seq, segments: segments.length, lastMs: Math.max(lastTarget, lastSeg) };
  }

  root.SCF.loomCapture = { runImport, cropToRect };
})(typeof globalThis !== 'undefined' ? globalThis : self);
