/*
 * Vimeo video-page bridge for the video import (content script, top frame).
 * Attaches to globalThis.SCF_VIMEO. Same contract as loom-import.js:
 *   VIMEO_PROBE -> {ok, hasTranscript, segments:[{ms,text}], title, error?}
 *   VIMEO_SEEK  -> {ok, rect, dpr, landed}   ({restore:true} puts the player back)
 *
 * On vimeo.com/<id> the player sits in the page itself (no iframe): one <video>
 * inside .vp-video-wrapper, with a <track> per caption language (checked
 * 2026-11-25). Vimeo draws captions with its own code, so switching the track
 * on does not load its cues; instead we fetch the track's .vtt file (on
 * captions.vimeo.com, a signed URL the page already holds) and read it with
 * SCF.videoSource.parseVtt. Cues on the track itself are the fallback.
 *
 * Third-party DOM, so this is best-effort; re-check selectors when it breaks.
 */
(function (root) {
  'use strict';
  if (root.SCF_VIMEO) return;
  const SCF = root.SCF || {};
  const MSG = SCF.MSG || {};
  const videoSource = SCF.videoSource;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVimeoVideo() {
    const s = videoSource && videoSource.sourceForUrl(location.href);
    return !!(s && s.kind === 'vimeo');
  }

  function findVideo() {
    const main = document.querySelector('.vp-video-wrapper video');
    if (main) return main;
    const vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) return null;
    return vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  }

  // The box that holds the picture and everything Vimeo paints over it. Known
  // class first; otherwise the highest ancestor still the size of the video.
  function findPlayer(v) {
    if (!v) return null;
    const known = v.closest('.js-player, .player, .vp-player');
    if (known) return known;
    const r = v.getBoundingClientRect();
    let best = v.parentElement;
    for (let el = v.parentElement; el && el !== document.body; el = el.parentElement) {
      const e = el.getBoundingClientRect();
      if (Math.abs(e.width - r.width) > 4 || Math.abs(e.height - r.height) > 4) break;
      best = el;
    }
    return best;
  }

  function videoTitle() {
    const h1 = document.querySelector('h1');
    const t = h1 && (h1.textContent || '').trim();
    if (t) return t;
    return (document.title || 'Vimeo video')
      .replace(/\s*\|[^|]*Vimeo\s*$/i, '').replace(/\s+on Vimeo\s*$/i, '').trim();
  }

  function trackElements(v) {
    return v ? Array.from(v.querySelectorAll('track')) : [];
  }

  // The player adds its <track>s once it has loaded the video's details.
  async function waitForTracks(v, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (trackElements(v).length || (v.textTracks && v.textTracks.length)) return;
      await delay(300);
    }
  }

  async function fromVttFile(trackEl) {
    if (!trackEl || !trackEl.src) return [];
    try {
      // captions.vimeo.com answers any site (Access-Control-Allow-Origin: *), which
      // a request carrying cookies is refused under; the URL is already signed
      const resp = await fetch(trackEl.src, { credentials: 'omit' });
      if (!resp.ok) return [];
      return videoSource.cleanSegments(videoSource.parseVtt(await resp.text()));
    } catch (e) {
      console.warn('[scf] Vimeo caption file could not be read', e && e.message);
      return [];
    }
  }

  // Fallback: wake the chosen text track ('hidden' loads cues, shows nothing)
  // and read its cues once their count stops growing.
  async function fromTextTrack(v, index) {
    const tt = v.textTracks && v.textTracks[index];
    if (!tt) return [];
    const was = tt.mode;
    if (tt.mode === 'disabled') { try { tt.mode = 'hidden'; } catch (e) { /* ignore */ } }
    const until = Date.now() + 6000;
    let last = -1;
    let rows = [];
    while (Date.now() < until) {
      const cues = tt.cues;
      rows = cues ? Array.from(cues).map((c) => ({ ms: c.startTime * 1000, text: c.text.replace(/<[^>]*>/g, '') })) : [];
      if (rows.length && rows.length === last) break;
      last = rows.length;
      await delay(400);
    }
    if (was === 'disabled') { try { tt.mode = 'disabled'; } catch (e) { /* ignore */ } }
    return videoSource.cleanSegments(rows);
  }

  async function probe() {
    if (!isVimeoVideo()) return { ok: false, error: 'not-a-vimeo-video' };
    let v = findVideo();
    if (!v) { await delay(2000); v = findVideo(); }
    if (!v) return { ok: false, error: 'no-video-found' };
    await waitForTracks(v, 8000);
    const title = videoTitle();
    const els = trackElements(v);
    const described = els.length
      ? els.map((t) => ({ kind: t.kind, label: t.label, language: t.srclang, default: t.default }))
      : Array.from(v.textTracks || []).map((t) => ({ kind: t.kind, label: t.label, language: t.language }));
    const pick = videoSource.pickCaptionTrack(described);
    if (pick === -1) return { ok: true, hasTranscript: false, segments: [], title };
    let segs = await fromVttFile(els[pick]);
    if (!segs.length) segs = await fromTextTrack(v, pick);
    if (!segs.length) return { ok: true, hasTranscript: false, segments: [], title };
    // same guard as Loom / YouTube: a read that came back as one repeated line,
    // or stopped well short of the video, fails loudly instead of saving
    const check = SCF.loomTimeline && SCF.loomTimeline.checkSegments;
    if (check) {
      const verdict = check(segs, { durationMs: isFinite(v.duration) ? Math.round(v.duration * 1000) : 0 });
      if (!verdict.ok) return { ok: false, error: verdict.reason === 'partial' ? 'transcript-partial' : 'transcript-unreadable', detail: verdict.reason, title };
      segs = verdict.segments;
    }
    return { ok: true, hasTranscript: true, segments: segs, title };
  }

  // --- player driving (for frame capture) ---
  let styleEl = null;
  let marked = [];
  let before = null; // { time, muted } to put back when the import ends

  // Vimeo's control bar sets its own visibility, so hiding its parent isn't
  // enough: hide every element in the player, then show only the chain from the
  // player down to the <video>. Visibility (unlike opacity) can be turned back
  // on by a child, which is what lets the picture through.
  function setControlsHidden(hidden, v) {
    if (hidden) {
      if (styleEl || !v) return;
      const player = findPlayer(v);
      if (!player) return;
      player.setAttribute('data-scf-vimeo-player', '1');
      marked = [player];
      for (let el = v; el && el !== player; el = el.parentElement) {
        el.setAttribute('data-scf-vimeo-keep', '1');
        marked.push(el);
      }
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-scf-vimeo', '1');
      styleEl.textContent = '[data-scf-vimeo-player] *{visibility:hidden !important;}'
        + '[data-scf-vimeo-player] [data-scf-vimeo-keep]{visibility:visible !important;}';
      document.documentElement.appendChild(styleEl);
    } else {
      if (styleEl) { styleEl.remove(); styleEl = null; }
      for (const el of marked) {
        el.removeAttribute('data-scf-vimeo-player');
        el.removeAttribute('data-scf-vimeo-keep');
      }
      marked = [];
    }
  }

  function raf2() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  function once(target, event, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; target.removeEventListener(event, finish); resolve(); } };
      target.addEventListener(event, finish);
      setTimeout(finish, timeoutMs);
    });
  }

  // A tab opened in the background may have no media loaded yet (readyState 0),
  // so a seek does nothing. A muted play/pause makes the player fetch the video.
  async function ensureLoaded(v) {
    if (v.readyState >= 1) return;
    const loaded = once(v, 'loadedmetadata', 6000);
    try { v.play().catch(() => { /* autoplay refused; the seek may still load it */ }); } catch (e) { /* ignore */ }
    await loaded;
    try { v.pause(); } catch (e) { /* ignore */ }
  }

  // Seek, then wait until the new frame is on screen: Vimeo streams the video
  // in pieces and has to fetch the piece we jumped to.
  async function seekVideo(v, sec) {
    const seeked = once(v, 'seeked', 5000);
    const painted = new Promise((resolve) => {
      if (!v.requestVideoFrameCallback) return resolve();
      v.requestVideoFrameCallback(() => resolve());
    });
    try { v.currentTime = sec; } catch (e) { return; }
    await seeked;
    if (v.readyState < 2) await once(v, 'loadeddata', 3000);
    // a seek to the frame already showing never paints a new one, so don't wait long
    await Promise.race([painted, delay(1500)]);
  }

  function visibleRect(v) {
    const r = v.getBoundingClientRect();
    const x = Math.max(r.left, 0);
    const y = Math.max(r.top, 0);
    const right = Math.min(r.right, window.innerWidth);
    const bottom = Math.min(r.bottom, window.innerHeight);
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  }

  async function seekTo(ms, restore) {
    const v = findVideo();
    if (!v) return { ok: false, error: 'no-video' };
    if (restore) {
      setControlsHidden(false);
      if (before) {
        try { v.currentTime = before.time; v.muted = before.muted; } catch (e) { /* ignore */ }
        before = null;
      }
      return { ok: true };
    }
    if (!before) {
      before = { time: v.currentTime || 0, muted: v.muted };
      // the player must be on screen for the tab capture to see it
      if (v.getBoundingClientRect().top < 0) window.scrollTo(0, 0);
    }
    try { v.muted = true; } catch (e) { /* ignore */ }
    await ensureLoaded(v);
    try { v.pause(); } catch (e) { /* ignore */ }
    setControlsHidden(true, v);
    const sec = Math.max(0, ms / 1000);
    await seekVideo(v, sec);
    await raf2();
    const landed = Math.abs((v.currentTime || 0) - sec) < 2;
    return { ok: true, rect: visibleRect(v), dpr: window.devicePixelRatio || 1, landed };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === MSG.VIMEO_PROBE) { probe().then(sendResponse); return true; }
    if (msg.type === MSG.VIMEO_SEEK) { seekTo(msg.ms, msg.restore).then(sendResponse); return true; }
    return false;
  });

  root.SCF_VIMEO = { isVimeoVideo, probe, seekTo, _findVideo: findVideo };
})(typeof globalThis !== 'undefined' ? globalThis : self);
