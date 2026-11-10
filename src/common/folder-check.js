/*
 * Has the new release finished landing in the extension folder?
 *
 * A release zip carries release-files.json: { version, files: { "src/x.js": sha256hex } }.
 * Before "Update now" calls chrome.runtime.reload(), the popup and the update page
 * hash every listed file on disk and compare, so a click while Explorer is still
 * copying the zip over can't load half old, half new code.
 *
 * No listing, or one from another version (a git checkout never has one) -> unknown
 * ({ ok: null }) and the reload goes ahead as before.
 *
 * Classic script: sets self.SCF.folderCheck; compareListing is also exported for tests.
 */
(function (root) {
  'use strict';
  const LISTING = 'release-files.json';

  // pure: -> { ok: true | false | null, total, bad: [paths] }
  function compareListing(listing, diskVersion, hashes) {
    if (!listing || !listing.files || !diskVersion || listing.version !== diskVersion) {
      return { ok: null, total: 0, bad: [] };
    }
    const paths = Object.keys(listing.files);
    const bad = paths.filter((p) => !hashes || hashes[p] !== listing.files[p]);
    return { ok: bad.length === 0, total: paths.length, bad };
  }

  async function readFolder(rel, as) {
    const r = await fetch(chrome.runtime.getURL(rel), { cache: 'no-store' });
    if (!r.ok) throw new Error(rel + ' ' + r.status);
    return as === 'json' ? r.json() : r.arrayBuffer();
  }

  async function sha256Hex(buf) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    let s = '';
    for (const b of d) s += b.toString(16).padStart(2, '0');
    return s;
  }

  const SETTLE_MS = 1500;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // -> the listing object, null (absent), or 'unreadable' (present but not JSON: mid-write)
  async function readListing() {
    let r;
    try {
      r = await fetch(chrome.runtime.getURL(LISTING), { cache: 'no-store' });
    } catch (e) {
      return null;
    }
    if (!r.ok) return null;
    try {
      return await r.json();
    } catch (e) {
      return 'unreadable';
    }
  }

  async function readDiskVersion() {
    try {
      return (await readFolder('manifest.json', 'json')).version || null;
    } catch (e) {
      return null; // missing, or caught mid-write
    }
  }

  // dotted numeric versions: is a newer than b?
  function newer(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0;
    }
    return false;
  }

  // Reads the folder itself (manifest.json and the listing), twice if the first look
  // isn't conclusive, so a copy that is still landing is caught either way round.
  async function check(opts) {
    const settleMs = opts && opts.settleMs != null ? opts.settleMs : SETTLE_MS;
    const usable = (l, v) => l && l !== 'unreadable' && l.files && l.version === v;
    let disk = await readDiskVersion();
    let listing = await readListing();
    if (!disk || !usable(listing, disk)) {
      // Explorer may write manifest.json a moment before release-files.json: give a
      // copy-over time to bring the matching listing before calling it "no listing"
      await sleep(settleMs);
      disk = await readDiskVersion();
      listing = await readListing();
    }
    const refuse = (bad) => ({ ok: false, total: 0, bad });
    // a manifest.json caught mid-write can't be read: never reload into that
    if (!disk) return refuse(['manifest.json']);
    if (listing === 'unreadable') return refuse([LISTING]);
    // the zip holds the listing first and manifest.json last: a listing newer than the
    // manifest means the copy is still landing
    if (listing && listing.files && newer(listing.version, disk)) return refuse(['manifest.json']);
    if (!usable(listing, disk)) return compareListing(null); // git checkout, or a listing left from an older version
    const diskVersion = disk;
    const hashes = {};
    await Promise.all(
      Object.keys(listing.files).map(async (p) => {
        try {
          hashes[p] = await sha256Hex(await readFolder(p));
        } catch (e) {
          hashes[p] = null; // missing or unreadable mid-copy
        }
      })
    );
    return compareListing(listing, diskVersion, hashes);
  }

  // plain words for a copy that isn't finished
  function describe(r) {
    const done = r.total - r.bad.length;
    const count = r.total ? ' (' + done + ' of ' + r.total + ' done)' : '';
    return 'The new files are still being copied into your extension folder' + count +
      '. Wait a moment, then click again. If this doesn\'t change, copy the zip\'s files over again.';
  }

  const api = { LISTING, compareListing, check, describe };

  root.SCF = root.SCF || {};
  root.SCF.folderCheck = root.SCF.folderCheck || api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
