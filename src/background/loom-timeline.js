/*
 * Pure timeline math for the Loom import (no chrome/DOM). Decides WHICH video
 * times to grab a frame at, given the transcript segment times.
 *
 * Dual-exported: module.exports for Node tests, globalThis.SCF.loomTimeline in
 * the service worker (loaded via importScripts).
 */
(function (root) {
  'use strict';

  // "01:05" -> 65000, "1:02:03" -> 3723000, junk -> null.
  function parseTimestamp(str) {
    if (typeof str !== 'string') return null;
    const m = str.trim().match(/^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/);
    if (!m) return null;
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const min = parseInt(m[2], 10);
    const sec = parseInt(m[3], 10);
    return ((h * 60 + min) * 60 + sec) * 1000;
  }

  function sortedUnique(nums) {
    return Array.from(new Set(nums)).sort((a, b) => a - b);
  }

  /**
   * @param {number[]} timesMs   transcript segment start times (ms into the video)
   * @param {{floorMs:number, maxFrames:number}} opts
   * @returns {number[]} sorted, unique frame target times (ms)
   */
  function buildTargets(timesMs, opts) {
    opts = opts || {};
    const floorMs = opts.floorMs > 0 ? opts.floorMs : 15000;
    const maxFrames = opts.maxFrames > 0 ? opts.maxFrames : 1000;

    // anchors: t=0 + every (valid, non-negative) segment time
    const anchors = sortedUnique([0].concat((timesMs || []).filter((t) => typeof t === 'number' && t >= 0).map((t) => Math.round(t))));

    // fill any gap wider than floorMs with intermediate frames
    const filled = [];
    for (let i = 0; i < anchors.length; i++) {
      filled.push(anchors[i]);
      const next = anchors[i + 1];
      if (next != null) {
        for (let t = anchors[i] + floorMs; t < next; t += floorMs) filled.push(t);
      }
    }
    let targets = sortedUnique(filled);

    // safety cap: even subsample, always keeping the first and last
    if (targets.length > maxFrames) {
      if (maxFrames <= 1) return [targets[0]];
      const out = [];
      const step = (targets.length - 1) / (maxFrames - 1);
      for (let i = 0; i < maxFrames; i++) out.push(targets[Math.round(i * step)]);
      targets = sortedUnique(out);
    }
    return targets;
  }

  // Words a scraper reads by mistake when it lands on a control instead of a caption
  // (Loom 2026-11: a "Copy snippet" button beside every stamp gave a 29-line
  // transcript of nothing but "Copy snippet").
  const UI_LABEL = /^(copy snippet|copy|copy link|copy text|share|more actions|more|search|edit|delete|reply|react|like|comment|translate|download|show more|show less|jump to|play|pause)$/i;

  /**
   * Sanity-check scraped transcript segments before they become the transcript.
   * Drops lines that are a UI label or hold no words; refuses the whole scrape when
   * most lines were labels, one line repeats for most cues, or (given the video's
   * length) the lines stop well before the video does (a partial list or a
   * caption track still loading).
   * @param {{ms:number, text:string}[]} segs
   * @param {{durationMs?:number}} [opts]
   * @returns {{ok:true, segments:object[]} | {ok:false, reason:string}}
   */
  function checkSegments(segs, opts) {
    const all = (segs || []).filter((s) => s && typeof s.text === 'string');
    const kept = all.filter((s) => {
      const t = s.text.replace(/\s+/g, ' ').trim();
      return t && !UI_LABEL.test(t) && /\p{L}/u.test(t);
    });
    if (!kept.length) return { ok: false, reason: all.length ? 'ui-labels' : 'no-words' };
    if (all.length >= 3 && kept.length * 2 < all.length) return { ok: false, reason: 'ui-labels' };
    const durationMs = (opts && opts.durationMs) || 0;
    const lastMs = Math.max(...kept.map((s) => s.ms || 0));
    if (durationMs >= 120000 && lastMs < durationMs * 0.4) return { ok: false, reason: 'partial' };
    if (kept.length >= 5) {
      const counts = new Map();
      let top = 0;
      for (const s of kept) {
        const k = s.text.trim().toLowerCase();
        const n = (counts.get(k) || 0) + 1;
        counts.set(k, n);
        if (n > top) top = n;
      }
      if (top * 2 > kept.length) return { ok: false, reason: 'repeated-line' };
    }
    return { ok: true, segments: kept };
  }

  const api = { parseTimestamp, buildTargets, checkSegments };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SCF = root.SCF || {};
    root.SCF.loomTimeline = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
