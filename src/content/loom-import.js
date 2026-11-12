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
  const check = root.SCF && root.SCF.loomTimeline && root.SCF.loomTimeline.checkSegments;

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

  // WebVTT cue text can carry markup (<v 0>speaker</v>, <c>, <i>): keep the words only
  function cueWords(s) {
    return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Try the video's native caption track first (clean timing, no scraping).
  // woken: tracks we switched on ourselves; a track the player already uses goes first
  function fromTextTracks(woken) {
    const v = findVideo();
    if (!v || !v.textTracks || !v.textTracks.length) return null;
    const tracks = Array.from(v.textTracks)
      .filter((tt) => tt.kind === 'captions' || tt.kind === 'subtitles') // not chapters / metadata
      .sort((a, b) => ((woken || []).includes(a) ? 1 : 0) - ((woken || []).includes(b) ? 1 : 0));
    for (const tt of tracks) {
      const cues = tt.cues;
      if (cues && cues.length) {
        const segs = [];
        for (let i = 0; i < cues.length; i++) {
          const c = cues[i];
          const text = cueWords(c.text);
          if (text) segs.push({ ms: Math.round(c.startTime * 1000), text });
        }
        if (segs.length) return segs;
      }
    }
    return null;
  }

  // A caption track the viewer switched off ('disabled') never loads its cues:
  // switch it to 'hidden' (loads cues, shows nothing), so captions-off viewers
  // still get the clean track instead of the page scrape. Returns the old modes.
  function wakeTextTracks() {
    const v = findVideo();
    const was = [];
    if (!v || !v.textTracks) return was;
    for (const tt of v.textTracks) {
      if ((tt.kind === 'captions' || tt.kind === 'subtitles') && tt.mode === 'disabled') {
        was.push(tt);
        try { tt.mode = 'hidden'; } catch (e) { /* ignore */ }
      }
    }
    return was;
  }

  // One transcript row's words: its text without the timestamp and without any
  // control inside it (Loom 2026-11 puts a "Copy snippet" button next to each stamp).
  function rowWords(row, stamp) {
    const c = row.cloneNode(true);
    c.querySelectorAll('button, [role="button"], svg, time, [aria-hidden="true"]').forEach((n) => n.remove());
    return (c.textContent || '').replace(stamp, '').replace(/\s+/g, ' ').trim();
  }

  const tsRe = /^\d{1,2}:\d{2}(?::\d{2})?$/;
  // no \b: Loom runs a stamp straight into the next label ("0:01Copy snippet")
  const stampsIn = (s) => (String(s).match(/(?<!\d)\d{1,2}:\d{2}(?!\d)/g) || []).length;

  // Loom's transcript list: one [data-testid="transcript-row-N"] per cue, the stamp
  // in a timestampContainer and the words in a sibling *_transcript_* element.
  function readRows(byMs) {
    for (const row of document.querySelectorAll('[data-testid^="transcript-row-"]')) {
      const stampEl = Array.from(row.querySelectorAll('span, div, time, button')).find((e) => tsRe.test((e.textContent || '').trim()));
      if (!stampEl) continue;
      const stamp = stampEl.textContent.trim();
      const ms = parseTimestamp(stamp);
      if (ms == null || byMs.has(ms)) continue;
      const wordsEl = row.querySelector('[class*="_transcript_"], [class*="transcript-text" i], [data-testid*="transcript-text" i]');
      const text = (wordsEl && (wordsEl.textContent || '').replace(/\s+/g, ' ').trim()) || rowWords(row, stamp);
      if (text) byMs.set(ms, text);
    }
  }

  // The list may hold only part of the transcript (signed out, the 2026-11 share
  // page listed 12 of 29 rows, up to 2:19 of 6:05, however it was scrolled or played):
  // checkSegments' coverage test refuses that instead of saving the start alone.
  function fromRows() {
    if (!parseTimestamp) return null;
    const byMs = new Map();
    readRows(byMs);
    const segs = Array.from(byMs, ([ms, text]) => ({ ms, text })).sort((a, b) => a.ms - b.ms);
    return segs.length ? segs : null;
  }

  // Fall back to scraping the rendered transcript panel by timestamp pattern.
  function fromDom() {
    if (!parseTimestamp) return null;
    const segs = [];
    // Whenever an element's trimmed text is exactly a timestamp, climb to the
    // smallest ancestor that also holds words (controls stripped) and no second
    // timestamp: that ancestor is the cue's row. The player's "0:04 / 6:05" has two
    // stamps and no words, so it never counts.
    const all = document.querySelectorAll('button, span, div, p, li');
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (!tsRe.test(t)) continue;
      const ms = parseTimestamp(t);
      if (ms == null) continue;
      let caption = '';
      let a = el.parentElement;
      for (let up = 0; a && up < 6 && !caption; up++, a = a.parentElement) {
        if (stampsIn(a.textContent || '') > 1) break;
        const w = rowWords(a, t);
        if (/\p{L}{2,}/u.test(w)) caption = w;
      }
      if (caption) segs.push({ ms, text: caption });
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
      const woken = wakeTextTracks();
      openTranscriptTab();
      // let the panel render and a woken track fetch its cues (until the count settles)
      let last = -1;
      for (let i = 0; i < 12; i++) {
        await delay(300);
        const s = fromTextTracks(woken);
        const n = s ? s.length : 0;
        if (n && n === last) { segs = s; break; }
        last = n;
        segs = s;
      }
      woken.forEach((tt) => { try { tt.mode = 'disabled'; } catch (e) { /* ignore */ } });
      segs = segs || fromRows() || fromDom();
    }
    if (!segs || !segs.length) return { ok: true, hasTranscript: false, segments: [], title: videoTitle() };
    // fail loudly on a scrape that read a button label (or one repeated line) for every
    // cue, or one that stops well before the video does
    const v = findVideo();
    const durationMs = v && isFinite(v.duration) ? Math.round(v.duration * 1000) : 0;
    const verdict = check ? check(segs, { durationMs }) : { ok: true, segments: segs };
    if (!verdict.ok) return { ok: false, error: verdict.reason === 'partial' ? 'transcript-partial' : 'transcript-unreadable', detail: verdict.reason, title: videoTitle() };
    return { ok: true, hasTranscript: true, segments: verdict.segments, title: videoTitle() };
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
    // landed = the player finished the seek and has a picture for it; a player that
    // never loaded (readyState 0) or is still seeking would hand back the old frame
    const settled = () => !v.seeking && v.readyState >= 2;
    let kicked = false;
    for (let i = 0; i < 20 && !settled(); i++) {
      if (i === 4 && v.readyState < 2 && !kicked) {
        kicked = true; // nudge a player that never loaded: a muted play/pause fetches data
        try { const p = v.play(); if (p && p.then) p.then(() => v.pause()).catch(() => {}); else v.pause(); } catch (e) { /* ignore */ }
      }
      await delay(100);
    }
    try { v.pause(); } catch (e) { /* ignore */ }
    await raf2();
    const r = v.getBoundingClientRect();
    return { ok: true, landed: settled(), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, dpr: window.devicePixelRatio || 1 };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === MSG.LOOM_PROBE) { probe().then(sendResponse); return true; }
    if (msg.type === MSG.LOOM_SEEK) { seekTo(msg.ms, msg.restore).then(sendResponse); return true; }
    return false;
  });

  // _scrape: the two page scrapers, for the saved-page fixture check (test/fixtures)
  root.SCF_LOOM = { isLoomShare, probe, seekTo, _findVideo: findVideo, _scrape: async () => ({ rows: fromRows(), dom: fromDom() }), _cueWords: cueWords };
})(typeof globalThis !== 'undefined' ? globalThis : self);
