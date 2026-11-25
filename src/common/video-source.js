/*
 * Which pages hold a video we can import (Loom share, YouTube watch, Vimeo
 * video), plus a small clean-up for scraped transcript lines and a reader for
 * WebVTT caption files (Vimeo's transcript). Pure (no chrome/DOM).
 *
 * Dual-exported: module.exports for Node tests, globalThis.SCF.videoSource in
 * the service worker, popup, and content scripts.
 */
(function (root) {
  'use strict';

  const YOUTUBE_HOST = /^(www\.|m\.)?youtube\.com$/i;
  const LOOM_HOST = /(^|\.)loom\.com$/i;
  const VIMEO_HOST = /^(www\.)?vimeo\.com$/i;
  // vimeo.com/123, vimeo.com/123/abcdef12 (unlisted link), and the same video
  // inside a channel, group, showcase or album. player.vimeo.com is left out: it
  // refuses to play many videos outside the site that embeds them.
  const VIMEO_VIDEO_PATH = /^\/(?:(?:channels\/[\w-]+|groups\/[\w-]+\/videos|showcase\/\d+\/video|album\/\d+\/video)\/)?\d{3,}(?:\/[0-9a-f]{6,})?\/?$/i;

  /**
   * @param {string} url
   * @returns {{kind:'loom'|'youtube'|'vimeo', label:string}|null}
   */
  function sourceForUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (LOOM_HOST.test(u.hostname) && /\/share\//.test(u.pathname)) return { kind: 'loom', label: 'Loom' };
    if (YOUTUBE_HOST.test(u.hostname)) {
      if (u.pathname === '/watch' && u.searchParams.get('v')) return { kind: 'youtube', label: 'YouTube' };
      if (/^\/live\/[\w-]+\/?$/.test(u.pathname)) return { kind: 'youtube', label: 'YouTube' };
    }
    if (VIMEO_HOST.test(u.hostname) && VIMEO_VIDEO_PATH.test(u.pathname)) return { kind: 'vimeo', label: 'Vimeo' };
    return null;
  }

  // "01:02:03.456" or "02:03.456" (comma also accepted) -> ms, else null
  function vttTime(s) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(String(s || '').trim());
    if (!m) return null;
    return ((+(m[1] || 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + Math.round(+(m[4] + '00').slice(0, 3));
  }

  function decodeEntities(s) {
    return s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'').replace(/&amp;/g, '&');
  }

  /**
   * A WebVTT caption file -> [{ms, text}] (cue start + its words, tags stripped).
   * Skips the header, NOTE / STYLE / REGION blocks and cue ids. Not cleaned or
   * sorted: pass the result through cleanSegments.
   * @param {string} vtt
   * @returns {Array<{ms:number, text:string}>}
   */
  function parseVtt(vtt) {
    const out = [];
    const blocks = String(vtt || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split('\n');
      const at = lines.findIndex((l) => l.indexOf('-->') !== -1);
      if (at === -1) continue; // header, NOTE, STYLE, REGION
      const ms = vttTime(lines[at].split('-->')[0]);
      if (ms == null) continue;
      const text = decodeEntities(lines.slice(at + 1).join(' ').replace(/<[^>]*>/g, ''));
      out.push({ ms, text });
    }
    return out;
  }

  /**
   * Which caption track to read, from the <track> elements a player offers.
   * Order: the track marked default; else a hand-made track in the same language
   * as the auto-generated one (better words, same speech); else the
   * auto-generated one (it follows what was said); else the first.
   * @param {Array<{kind?:string, label?:string, language?:string, default?:boolean}>} tracks
   * @returns {number} index into tracks, or -1 when none hold captions
   */
  function pickCaptionTrack(tracks) {
    const list = (tracks || []).map((t, i) => ({ t: t || {}, i }))
      .filter(({ t }) => !t.kind || t.kind === 'subtitles' || t.kind === 'captions');
    if (!list.length) return -1;
    const isAuto = ({ t }) => /autogen|auto-generated/i.test((t.language || '') + ' ' + (t.label || ''));
    const base = ({ t }) => String(t.language || '').toLowerCase().split('-')[0];
    const def = list.find(({ t }) => t.default);
    if (def) return def.i;
    const auto = list.find(isAuto);
    if (auto) {
      const human = list.find((x) => !isAuto(x) && base(x) && base(x) === base(auto));
      return (human || auto).i;
    }
    return list[0].i;
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

  const api = { sourceForUrl, cleanSegments, parseVtt, pickCaptionTrack };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SCF = root.SCF || {};
    root.SCF.videoSource = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
