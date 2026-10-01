/*
 * Which pages hold a video we can import (Loom share, YouTube watch), plus a
 * small clean-up for scraped transcript lines. Pure (no chrome/DOM).
 *
 * Dual-exported: module.exports for Node tests, globalThis.SCF.videoSource in
 * the service worker, popup, and content scripts.
 */
(function (root) {
  'use strict';

  const YOUTUBE_HOST = /^(www\.|m\.)?youtube\.com$/i;
  const LOOM_HOST = /(^|\.)loom\.com$/i;

  /**
   * @param {string} url
   * @returns {{kind:'loom'|'youtube', label:string}|null}
   */
  function sourceForUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (LOOM_HOST.test(u.hostname) && /\/share\//.test(u.pathname)) return { kind: 'loom', label: 'Loom' };
    if (YOUTUBE_HOST.test(u.hostname)) {
      if (u.pathname === '/watch' && u.searchParams.get('v')) return { kind: 'youtube', label: 'YouTube' };
      if (/^\/live\/[\w-]+\/?$/.test(u.pathname)) return { kind: 'youtube', label: 'YouTube' };
    }
    return null;
  }

  /**
   * Scraped transcript rows -> clean, sorted segments. Drops rows with a bad
   * time or no letters/digits (YouTube pads with "- -" and ". . ." lines), keeps
   * the first caption when two rows share a time, and collapses whitespace.
   * @param {Array<{ms:number, text:string}>} rows
   * @returns {Array<{ms:number, text:string}>}
   */
  function cleanSegments(rows) {
    const out = [];
    const seen = new Set();
    const sorted = (rows || [])
      .filter((r) => r && typeof r.ms === 'number' && r.ms >= 0)
      .map((r) => ({ ms: Math.round(r.ms), text: String(r.text == null ? '' : r.text).replace(/\s+/g, ' ').trim() }))
      .sort((a, b) => a.ms - b.ms);
    for (const r of sorted) {
      if (!/[\p{L}\p{N}]/u.test(r.text) || seen.has(r.ms)) continue;
      seen.add(r.ms);
      out.push(r);
    }
    return out;
  }

  const api = { sourceForUrl, cleanSegments };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SCF = root.SCF || {};
    root.SCF.videoSource = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
