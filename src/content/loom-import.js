/*
 * Loom share-page bridge for the import feature (content script, top frame).
 * Attaches to globalThis.SCF_LOOM. Scrapes the transcript and drives the player
 * so the service worker can grab frames via captureVisibleTab.
 *
 * Heuristic + brittle by nature (third-party DOM): transcript cues are found by
 * the visible mm:ss timestamp pattern, with a fallback to the <video> textTracks.
 * Verify/adjust against the live Loom page (see docs plan, Task 3).
 */
(function (root) {
  'use strict';
  if (root.SCF_LOOM) return;
  const MSG = (root.SCF && root.SCF.MSG) || {};
  const parseTimestamp = root.SCF && root.SCF.loomTimeline && root.SCF.loomTimeline.parseTimestamp;

  function isLoomShare() {
    return /(^|\.)loom\.com$/i.test(location.hostname) && /\/share\//.test(location.pathname);
  }

  function findVideo() {
    // largest <video> on the page is the player
    const vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) return null;
    return vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  }

  function videoTitle() {
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return og.content;
    return (document.title || 'Loom video').replace(/\s*[|·-]\s*Loom\s*$/i, '').trim();
  }

  // Try the video's native caption track first (clean timing, no scraping).
  function fromTextTracks() {
    const v = findVideo();
    if (!v || !v.textTracks || !v.textTracks.length) return null;
    for (const tt of v.textTracks) {
      const cues = tt.cues;
      if (cues && cues.length) {
        const segs = [];
        for (let i = 0; i < cues.length; i++) {
          const c = cues[i];
          const text = (c.text || '').replace(/\s+/g, ' ').trim();
          if (text) segs.push({ ms: Math.round(c.startTime * 1000), text });
        }
        if (segs.length) return segs;
      }
    }
    return null;
  }

  // Fall back to scraping the rendered transcript panel by timestamp pattern.
  function fromDom() {
    if (!parseTimestamp) return null;
    const tsRe = /^\d{1,2}:\d{2}(?::\d{2})?$/;
    const segs = [];
    // Walk text nodes; whenever an element's trimmed text is exactly a timestamp,
    // pair it with the caption text that follows in the same cue container.
    const all = document.querySelectorAll('button, span, div, p, li');
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (!tsRe.test(t)) continue;
      const ms = parseTimestamp(t);
      if (ms == null) continue;
      // caption = nearest following sibling / parent's text minus the stamp
      let caption = '';
      const row = el.closest('li, [role="listitem"], div') || el.parentElement;
      if (row) caption = (row.textContent || '').replace(t, '').replace(/\s+/g, ' ').trim();
      if (!caption && el.nextElementSibling) caption = (el.nextElementSibling.textContent || '').replace(/\s+/g, ' ').trim();
      if (caption && caption.length > 1) segs.push({ ms, text: caption });
    }
    // de-dup by ms (the walk can hit the same cue twice), keep first caption
    const seen = new Set();
    const out = [];
    for (const s of segs.sort((a, b) => a.ms - b.ms)) {
      if (seen.has(s.ms)) continue;
      seen.add(s.ms);
      out.push(s);
    }
    return out.length ? out : null;
  }

  // Open the Transcript tab (it often lazy-renders) before scraping.
  function openTranscriptTab() {
    const tabs = Array.from(document.querySelectorAll('button, [role="tab"], a'));
    const t = tabs.find((b) => /transcript/i.test((b.textContent || '').trim()) && (b.textContent || '').trim().length < 20);
    if (t) { try { t.click(); } catch (e) { /* ignore */ } return true; }
    return false;
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function probe() {
    if (!isLoomShare()) return { ok: false, error: 'not-a-loom-share-page' };
    if (!findVideo()) return { ok: false, error: 'no-video-found' };
    let segs = fromTextTracks();
    if (!segs) {
      openTranscriptTab();
      await delay(600); // let the panel render
      segs = fromTextTracks() || fromDom();
    }
    if (!segs || !segs.length) return { ok: true, hasTranscript: false, segments: [], title: videoTitle() };
    return { ok: true, hasTranscript: true, segments: segs, title: videoTitle() };
  }

  // --- player driving (for frame capture) ---
  let styleEl = null;
  function setControlsHidden(hidden) {
    if (hidden) {
      if (styleEl) return;
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-scf-loom', '1');
      // best-effort: hide common player control overlays so frames are clean.
      // TUNE against the live Loom DOM if controls still bleed into frames.
      styleEl.textContent =
        '[class*="controls" i],[class*="overlay" i],[class*="scrubber" i],' +
        'video::-webkit-media-controls{opacity:0 !important;pointer-events:none !important;}';
      document.documentElement.appendChild(styleEl);
    } else if (styleEl) {
      styleEl.remove();
      styleEl = null;
    }
  }

  function raf2() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  function seekVideo(v, sec) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; v.removeEventListener('seeked', finish); resolve(); } };
      v.addEventListener('seeked', finish);
      try { v.currentTime = sec; } catch (e) { finish(); }
      setTimeout(finish, 1200); // don't hang if 'seeked' never fires
    });
  }

  async function seekTo(ms, restore) {
    const v = findVideo();
    if (!v) return { ok: false, error: 'no-video' };
    if (restore) { setControlsHidden(false); try { v.muted = false; } catch (e) {} return { ok: true }; }
    try { v.muted = true; v.pause(); } catch (e) { /* ignore */ }
    setControlsHidden(true);
    await seekVideo(v, Math.max(0, ms / 1000));
    await raf2();
    const r = v.getBoundingClientRect();
    return { ok: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, dpr: window.devicePixelRatio || 1 };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === MSG.LOOM_PROBE) { probe().then(sendResponse); return true; }
    if (msg.type === MSG.LOOM_SEEK) { seekTo(msg.ms, msg.restore).then(sendResponse); return true; }
    return false;
  });

  root.SCF_LOOM = { isLoomShare, probe, seekTo, _findVideo: findVideo };
})(typeof globalThis !== 'undefined' ? globalThis : self);
