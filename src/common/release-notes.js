/*
 * "What's new" for the toolbar menu: turn GitHub's release list into the versions
 * between the one running and the newest, each with its main points as plain text.
 *
 * Pure and dual-exported: pages get SCF.releaseNotes, Node (tests) gets module.exports.
 * GitHub's /repos/<owner>/<repo>/releases JSON goes in; nothing here touches the network.
 */
(function (root) {
  'use strict';

  function parts(v) {
    const m = String(v == null ? '' : v).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  function cmp(a, b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  }

  // markdown -> plain text: links keep their words, emphasis and code marks go
  function plain(s) {
    return String(s)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,:;!?]|$)/g, '$1$2')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // A release body's main points: its top-level list items; without a list, its first
  // few paragraphs (headings and the "Update: …" how-to line left out).
  function bodyToPoints(md, max) {
    const limit = max || 8;
    const text = String(md == null ? '' : md).replace(/\r/g, '');
    const bullets = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^ ?(?:[-*+]|\d+[.)])\s+(.*)$/);
      if (m) {
        const t = plain(m[1]);
        if (t) bullets.push(t);
      }
    }
    if (bullets.length) return bullets.slice(0, limit);
    return text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p && !/^#/.test(p) && !/^\**update\b/i.test(p))
      .map(plain)
      .filter(Boolean)
      .slice(0, Math.min(limit, 3));
  }

  // -> [{ version, date, url, points }], newest first: published releases newer than
  // `fromVersion` and, when given, no newer than `toVersion`.
  function notesBetween(releases, fromVersion, toVersion) {
    const from = parts(fromVersion);
    const to = toVersion ? parts(toVersion) : null;
    const out = [];
    for (const r of Array.isArray(releases) ? releases : []) {
      if (!r || r.draft || r.prerelease) continue;
      const v = parts(r.tag_name);
      if (!v) continue;
      if (from && cmp(v, from) <= 0) continue;
      if (to && cmp(v, to) > 0) continue;
      out.push({ version: v.join('.'), date: r.published_at || null, url: r.html_url || null, points: bodyToPoints(r.body) });
    }
    out.sort((a, b) => cmp(parts(b.version), parts(a.version)));
    return out.filter((x, i) => i === 0 || x.version !== out[i - 1].version);
  }

  // the release list's address, from the "latest release" one the updater already uses
  function listUrl(latestUrl) {
    return String(latestUrl || '').replace(/\/releases\/latest\/?$/, '/releases') + '?per_page=30';
  }

  const api = { bodyToPoints, notesBetween, listUrl, plain };
  root.SCF = root.SCF || {};
  root.SCF.releaseNotes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
