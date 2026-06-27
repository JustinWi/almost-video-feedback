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
    const maxFrames = opts.maxFrames > 0 ? opts.maxFrames : 300;

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

  const api = { parseTimestamp, buildTargets };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SCF = root.SCF || {};
    root.SCF.loomTimeline = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
