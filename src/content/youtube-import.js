/*
 * YouTube watch-page bridge for the video import (content script, top frame).
 * Attaches to globalThis.SCF_YOUTUBE. Same contract as loom-import.js:
 *   YOUTUBE_PROBE -> {ok, hasTranscript, segments:[{ms,text}], title, error?}
 *   YOUTUBE_SEEK  -> {ok, rect, dpr}   ({restore:true} puts the player back,
 *                                        {adCheck:true} -> {ad} is an ad on screen right now)
 *
 * Ads: YouTube plays an ad in the same <video> as the real one, so a frame grabbed
 * during an ad shows the ad. Whenever an ad is on, we stop and let it play muted
 * (its countdown only runs while it plays). Once YouTube shows Skip, we end the ad:
 * YouTube ignores a script's click on Skip (checked 2026-10-01: 34 clicks, no
 * effect), so we jump the ad's video to its last moment, which YouTube treats as
 * the ad finishing. Ads without a Skip button play out in full. Then we jump back
 * to where we were.
 *
 * Transcript: opens YouTube's own transcript panel (the "Show transcript" button
 * in the description, found by its renderer, so it works in any UI language)
 * and reads its rows. Two layouts exist in the wild: the 2025+ view-model rows
 * (transcript-segment-view-model) and the older ytd-transcript-segment-renderer.
 * Third-party DOM, so this is best-effort; re-check selectors when it breaks.
 */
(function (root) {
  'use strict';
  if (root.SCF_YOUTUBE) return;
  const SCF = root.SCF || {};
  const MSG = SCF.MSG || {};
  const parseTimestamp = SCF.loomTimeline && SCF.loomTimeline.parseTimestamp;
  const videoSource = SCF.videoSource;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function isYouTubeWatch() {
    const s = videoSource && videoSource.sourceForUrl(location.href);
    return !!(s && s.kind === 'youtube');
  }

  function findPlayer() {
    return document.querySelector('#movie_player');
  }

  function findVideo() {
    const p = findPlayer();
    const main = p && p.querySelector('video.html5-main-video');
    if (main) return main;
    const vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) return null;
    return vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  }

  function videoTitle() {
    const h1 = document.querySelector('h1.ytd-watch-metadata');
    const t = h1 && (h1.textContent || '').trim();
    if (t) return t;
    // og:title goes stale after in-app navigation, so the tab title comes next
    return (document.title || 'YouTube video').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
  }

  function text(el) {
    return el ? (el.textContent || '').trim() : '';
  }

  function readSegments() {
    if (!parseTimestamp) return [];
    const rows = [];
    // 2025+ layout
    for (const seg of document.querySelectorAll('transcript-segment-view-model')) {
      const ts = text(seg.querySelector('.ytwTranscriptSegmentViewModelTimestamp'));
      const ms = parseTimestamp(ts);
      if (ms == null) continue;
      let caption = text(seg.querySelector('span.ytAttributedStringHost'));
      if (!caption) {
        const a11y = text(seg.querySelector('.ytwTranscriptSegmentViewModelTimestampA11yLabel'));
        caption = text(seg).replace(ts, '').replace(a11y, '');
      }
      rows.push({ ms, text: caption });
    }
    // older layout
    for (const seg of document.querySelectorAll('ytd-transcript-segment-renderer')) {
      const ms = parseTimestamp(text(seg.querySelector('.segment-timestamp')));
      if (ms == null) continue;
      rows.push({ ms, text: text(seg.querySelector('.segment-text')) });
    }
    return videoSource ? videoSource.cleanSegments(rows) : rows;
  }

  function openTranscriptPanel() {
    const btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
    if (!btn) return false;
    try { btn.click(); } catch (e) { return false; }
    return true;
  }

  // Wait until the panel has rows and the count has stopped growing.
  async function waitForSegments(timeoutMs) {
    const until = Date.now() + timeoutMs;
    let last = -1;
    let segs = [];
    while (Date.now() < until) {
      segs = readSegments();
      if (segs.length && segs.length === last) return segs;
      last = segs.length;
      await delay(400);
    }
    return segs;
  }

  // --- ads ---
  const SKIP_SELECTORS = [
    '.ytp-skip-ad-button', '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button',
    'button[id^="skip-button"]', '.videoAdUiSkipButton',
  ];
  const AD_MAX_MS = 180000; // give up on one ad break after 3 minutes
  const AD_START_GRACE_MS = 400; // a mid-roll starts a beat after we seek past its cue point

  function adShowing() {
    const p = findPlayer();
    return !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
  }

  // The skip button sits in the DOM during the countdown but takes no space until it's live.
  function findSkipButton() {
    const p = findPlayer();
    if (!p) return null;
    for (const sel of SKIP_SELECTORS) {
      for (const b of p.querySelectorAll(sel)) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && !b.disabled) return b;
      }
    }
    return null;
  }

  function tellPopup(phase) {
    try { chrome.runtime.sendMessage({ type: MSG.IMPORT_PROGRESS, progress: { phase } }, () => void chrome.runtime.lastError); } catch (e) { /* popup closed */ }
  }

  // Every ad break this import met, handed back to the service worker at the end
  // so the bundle (session.json) and the popup can say what happened.
  let adLog = [];

  // Sit out the current ad break (several ads can play back to back). atMs = the
  // video moment we were heading for. Resolves true once the real video is back,
  // false if it never came back.
  async function clearAds(atMs) {
    if (!adShowing()) return true;
    tellPopup('ad');
    const startedAt = Date.now();
    const until = startedAt + AD_MAX_MS;
    let lastClick = 0;
    let clicks = 0;
    while (adShowing() && Date.now() < until) {
      const ad = findVideo();
      try {
        ad.muted = true;
        if (ad.paused) ad.play().catch(() => { /* retried next tick */ });
      } catch (e) { /* ignore */ }
      const skip = findSkipButton();
      if (skip && Date.now() - lastClick > 1000) {
        lastClick = Date.now();
        clicks += 1;
        try { skip.click(); } catch (e) { /* ignored by YouTube today; harmless */ }
        // what actually ends it: the ad reaching its own end
        try { if (isFinite(ad.duration) && ad.duration > 1) ad.currentTime = ad.duration - 0.1; } catch (e) { /* plays out */ }
      }
      await delay(300);
    }
    const stuck = adShowing();
    // "skipped" = the ad went away within a moment of our skip; otherwise it ran out
    const how = stuck ? 'stuck' : clicks && Date.now() - lastClick < 2500 ? 'skipped' : 'ended';
    const entry = { atMs: Math.round(atMs || 0), how, waitedMs: Date.now() - startedAt, skipClicks: clicks };
    adLog.push(entry);
    console.log('[scf] YouTube ad break', entry);
    if (stuck) return false;
    await delay(500); // let the player swap the real video back in
    return true;
  }

  async function probe() {
    if (!isYouTubeWatch()) return { ok: false, error: 'not-a-youtube-video' };
    if (!findVideo()) return { ok: false, error: 'no-video-found' };
    adLog = []; // a new import starts here
    if (!(await clearAds(0))) return { ok: false, error: 'ad-stuck' };
    let segs = readSegments();
    if (!segs.length && openTranscriptPanel()) segs = await waitForSegments(10000);
    const title = videoTitle();
    if (!segs.length) return { ok: true, hasTranscript: false, segments: [], title };
    return { ok: true, hasTranscript: true, segments: segs, title };
  }

  // --- player driving (for frame capture) ---
  let styleEl = null;
  let before = null; // { time, muted } to put back when the import ends

  function setControlsHidden(hidden) {
    if (hidden) {
      if (styleEl) return;
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-scf-youtube', '1');
      // everything YouTube paints over the picture: controls, captions, spinner,
      // end cards, the "cued" thumbnail shown before the video has played
      const sel = [
        '.ytp-chrome-bottom', '.ytp-chrome-top', '.ytp-gradient-bottom', '.ytp-gradient-top',
        '.ytp-caption-window-container', '.ytp-spinner', '.ytp-bezel', '.ytp-bezel-text-wrapper',
        '.ytp-pause-overlay', '.ytp-ce-element', '.ytp-cards-teaser', '.ytp-cards-button',
        '.ytp-paid-content-overlay', '.ytp-cued-thumbnail-overlay', '.ytp-tooltip', '.iv-branding',
        '.html5-endscreen', '.ytp-autonav-endscreen-countdown-overlay', '.ytp-suggested-action',
        '.ytp-overlays-container', '.ytp-ad-overlay-container', '.ytp-ad-overlay-slot', '.ytp-ad-image-overlay',
      ].map((s) => '#movie_player ' + s).join(',');
      styleEl.textContent = sel + '{opacity:0 !important;visibility:hidden !important;}';
      document.documentElement.appendChild(styleEl);
    } else if (styleEl) {
      styleEl.remove();
      styleEl = null;
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

  // A tab opened in the background has no media loaded yet (readyState 0), so a
  // seek does nothing. A muted play/pause makes the player fetch the video.
  async function ensureLoaded(v) {
    if (v.readyState >= 1) return;
    const loaded = once(v, 'loadedmetadata', 6000);
    // play() never settles in a tab Chrome considers hidden, so don't wait on it
    try { v.play().catch(() => { /* autoplay refused; the seek may still load it */ }); } catch (e) { /* ignore */ }
    await loaded;
    try { v.pause(); } catch (e) { /* ignore */ }
  }

  // Seek, then wait until the new frame is actually on screen: YouTube has to
  // download the part of the video we jumped to, which can take a second or two.
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
    const p = findPlayer();
    const pr = p ? p.getBoundingClientRect() : r;
    // the <video> can be wider/taller than the player that clips it; take the overlap,
    // clipped to the viewport
    const x = Math.max(r.left, pr.left, 0);
    const y = Math.max(r.top, pr.top, 0);
    const right = Math.min(r.right, pr.right, window.innerWidth);
    const bottom = Math.min(r.bottom, pr.bottom, window.innerHeight);
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  }

  async function seekTo(ms, restore, adCheck) {
    if (adCheck) return { ok: true, ad: adShowing() };
    const v = findVideo();
    if (!v) return { ok: false, error: 'no-video' };
    if (restore) {
      setControlsHidden(false);
      if (before) {
        try { v.currentTime = before.time; v.muted = before.muted; } catch (e) { /* ignore */ }
        before = null;
      }
      return { ok: true, ads: adLog };
    }
    if (!before) {
      before = { time: v.currentTime || 0, muted: v.muted };
      // the player must be on screen for the tab capture to see it
      const p = findPlayer();
      if (p && p.getBoundingClientRect().top < 0) window.scrollTo(0, 0);
    }
    try { v.muted = true; } catch (e) { /* ignore */ }
    await ensureLoaded(v);
    setControlsHidden(true);
    // Seeking past a mid-roll's cue point starts it; after the ad, YouTube resumes
    // at the cue point, not our target, so seek again. A few rounds covers ads
    // stacked at nearby cue points.
    for (let round = 0; round < 4; round++) {
      if (!(await clearAds(ms))) return { ok: false, error: 'ad-stuck' };
      try { v.pause(); } catch (e) { /* ignore */ }
      await seekVideo(v, Math.max(0, ms / 1000));
      await delay(AD_START_GRACE_MS);
      if (!adShowing()) break;
    }
    if (adShowing()) return { ok: false, error: 'ad-stuck' };
    await raf2();
    return { ok: true, rect: visibleRect(v), dpr: window.devicePixelRatio || 1 };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === MSG.YOUTUBE_PROBE) { probe().then(sendResponse); return true; }
    if (msg.type === MSG.YOUTUBE_SEEK) { seekTo(msg.ms, msg.restore, msg.adCheck).then(sendResponse); return true; }
    return false;
  });

  root.SCF_YOUTUBE = { isYouTubeWatch, probe, seekTo, readSegments, adShowing, clearAds, _findVideo: findVideo };
})(typeof globalThis !== 'undefined' ? globalThis : self);
