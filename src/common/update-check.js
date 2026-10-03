/*
 * Update-check logic (pure, dual-exported, unit-tested).
 *
 * Unpacked extensions don't auto-update, so the service worker asks GitHub once
 * a day for the latest release and prompts when it's newer than the running
 * version. This module is the decision half — parse a version tag, compare it
 * to the manifest's, and turn a GitHub "latest release" API response into the
 * {version, zipUrl, pageUrl} the prompt needs. No chrome.* here; the fetch,
 * alarm, badge, and notification live in src/background/updater.js.
 */
(function (root) {
  'use strict';

  // 'v0.9.0' / '0.9.0' / '0.9' -> [0, 9, 0]; anything non-numeric -> null
  function parseVersion(s) {
    if (typeof s !== 'string') return null;
    const m = s.trim().replace(/^v/i, '');
    if (!/^\d+(\.\d+){0,2}$/.test(m)) return null;
    const parts = m.split('.').map((n) => parseInt(n, 10));
    while (parts.length < 3) parts.push(0);
    return parts;
  }

  // true only when `remote` is a well-formed version strictly newer than `local`
  function isNewer(remote, local) {
    const r = parseVersion(remote);
    const l = parseVersion(local);
    if (!r || !l) return false;
    for (let i = 0; i < 3; i++) {
      if (r[i] !== l[i]) return r[i] > l[i];
    }
    return false;
  }

  // Is a daily check due? True when never checked, overdue, or the clock moved
  // backwards past plausibility (a stored future timestamp must not wedge it).
  function checkDue(nowMs, lastCheckAtMs, intervalMs) {
    if (!lastCheckAtMs) return true;
    if (lastCheckAtMs > nowMs + intervalMs) return true;
    return nowMs - lastCheckAtMs >= intervalMs;
  }

  // GitHub /releases/latest JSON -> { version, zipUrl, pageUrl, name } | null.
  // Prefers the release's own zip asset; falls back to the stable
  // /releases/latest/download/ URL so a release missing the asset still updates.
  function parseReleaseInfo(release, fallbackZipUrl) {
    if (!release || typeof release.tag_name !== 'string') return null;
    const parsed = parseVersion(release.tag_name);
    if (!parsed) return null;
    let zipUrl = fallbackZipUrl || null;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const exact = assets.find((a) => a && a.name === 'almost-video-feedback.zip');
    const anyZip = exact || assets.find((a) => a && /\.zip$/i.test(a.name || ''));
    if (anyZip && anyZip.browser_download_url) zipUrl = anyZip.browser_download_url;
    return {
      version: parsed.join('.'),
      zipUrl,
      pageUrl: release.html_url || 'https://github.com/JustinWi/almost-video-feedback/releases/latest',
      name: release.name || release.tag_name,
    };
  }

  // -> { version, zipUrl, pageUrl } when the release is newer, else null
  function decideUpdate(releaseInfo, currentVersion) {
    if (!releaseInfo || !isNewer(releaseInfo.version, currentVersion)) return null;
    return { version: releaseInfo.version, zipUrl: releaseInfo.zipUrl, pageUrl: releaseInfo.pageUrl };
  }

  const api = { parseVersion, isNewer, checkDue, parseReleaseInfo, decideUpdate };

  root.SCF = root.SCF || {};
  root.SCF.updateCheck = root.SCF.updateCheck || api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
