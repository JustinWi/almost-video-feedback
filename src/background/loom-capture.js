/*
 * Video import capture (service worker). Classic script -> globalThis.SCF.loomCapture.
 * Named for Loom, where it started; it drives YouTube watch pages the same way.
 *
 * Drives the video page (via LOOM_SEEK / YOUTUBE_SEEK messages to the content script) to each
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

  // Per-site messages + how long one seek may take. A YouTube seek may first sit out
  // an ad break (up to 3 minutes in the page) and then download the part of the
  // video it jumps to, so it gets a much longer leash. adCheck: after each grab, ask
  // the page whether an ad popped up meanwhile (that frame is then retaken).
  const SITES = {
    loom: { probe: MSG.LOOM_PROBE, seek: MSG.LOOM_SEEK, seekTimeoutMs: 4000, fallbackTitle: 'Loom video', adCheck: false },
    youtube: { probe: MSG.YOUTUBE_PROBE, seek: MSG.YOUTUBE_SEEK, seekTimeoutMs: 210000, fallbackTitle: 'YouTube video', adCheck: true },
  };
  const AD_RETAKES = 3; // per target, frames thrown away because an ad started mid-grab

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
   *          dir:string, store:object, kind?:'loom'|'youtube', onProgress?:function}} a
   * @returns {Promise<{frames:number, segments:number, title?:string, url?:string, lastMs?:number, error?:string}>}
   */
  async function runImport(a) {
    const { tabId, windowId, startedAt, settings, dir, store } = a;
    const onProgress = a.onProgress || function () {};
    const site = SITES[a.kind] || SITES.loom;

    const probe = await sendToTab(tabId, { type: site.probe }, site.seekTimeoutMs);
    if (!probe || !probe.ok) return { frames: 0, segments: 0, error: (probe && probe.error) || 'probe-failed' };
    if (!probe.hasTranscript) return { frames: 0, segments: 0, error: 'no-transcript' };

    const segments = probe.segments;
    const title = probe.title || site.fallbackTitle;
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
    let retakes = 0;
    let adBreaks = []; // reported by the page when it's put back (YouTube only)
    try {
      for (let i = 0; i < targets.length; i++) {
        const ms = targets[i];
        onProgress({ done: i, total: targets.length, phase: 'capturing' });
        const seek = await sendToTab(tabId, { type: site.seek, ms }, site.seekTimeoutMs);
        if (seek && seek.error === 'ad-stuck') return { frames: seq, segments: segments.length, error: 'ad-stuck', adBreaks };
        await delay(settle);
        let dataUrl;
        try { dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts); } catch (e) { dataUrl = null; }
        if (site.adCheck && dataUrl) {
          const now = await sendToTab(tabId, { type: site.seek, adCheck: true }, 2000);
          if (now && now.ad) {
            // an ad started between the seek and the grab: drop the frame, redo this target
            if (retakes < AD_RETAKES) { retakes += 1; i -= 1; } else retakes = 0;
            continue;
          }
        }
        retakes = 0;
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
      const back = await sendToTab(tabId, { type: site.seek, restore: true }, 1000); // un-mute, restore controls
      if (back && Array.isArray(back.ads)) adBreaks.splice(0, adBreaks.length, ...back.ads);
    }
    // every capture failed (tab hidden behind another / window minimized): say so
    // instead of saving a bundle with a transcript and no pictures
    if (seq === 0 && targets.length) return { frames: 0, segments: segments.length, error: 'no-frames', adBreaks };
    onProgress({ done: targets.length, total: targets.length, phase: 'done' });
    // lastMs = end of the video we covered, so the bundle's duration is meaningful
    const lastTarget = targets.length ? targets[targets.length - 1] : 0;
    const lastSeg = segments.length ? segments[segments.length - 1].ms : 0;
    return { frames: seq, segments: segments.length, title, url, adBreaks, lastMs: Math.max(lastTarget, lastSeg) };
  }

  root.SCF.loomCapture = { runImport, cropToRect };
})(typeof globalThis !== 'undefined' ? globalThis : self);
