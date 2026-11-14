/*
 * One-click update for an unpacked install: download the release zip, check every file
 * against the release's own list (release-files.json, sha256 per file), write the files
 * into the extension's folder, then chrome.runtime.reload().
 *
 * Chrome won't let an extension write to its own folder, so the person grants it once:
 * they pick the folder in Chrome's folder picker (File System Access API) on the update
 * page, and the handle is kept in IndexedDB. The menu then updates with no new tab, as
 * long as Chrome still holds that "edit files" permission; when it doesn't, the update
 * page asks for it again with one click.
 *
 * Pure helpers (stripTop, safePath, verifyRelease, planWrites, describeError) are
 * dual-exported and tested; the rest needs a browser page (popup / update page).
 * Needs SCF_ZIP (zip.js) loaded first.
 */
(function (root) {
  'use strict';

  const TOP = 'almost-video-feedback/'; // the one folder inside every release zip
  const LISTING = 'release-files.json';
  const MARKER = 'avf-folder-check.txt'; // written + deleted again to prove a folder is the live one
  const STATE_KEY = 'selfUpdate'; // chrome.storage.local: { from, to, state, at, error? }

  // ---------------------------------------------------------------- pure

  function stripTop(name) {
    return typeof name === 'string' && name.indexOf(TOP) === 0 ? name.slice(TOP.length) : null;
  }

  // relative, forward slashes, no '.', '..' or empty parts: nothing can land outside the folder
  function safePath(p) {
    return (
      typeof p === 'string' && !!p && p[0] !== '/' && p.indexOf('\\') === -1 &&
      p.split('/').every((s) => s && s !== '.' && s !== '..')
    );
  }

  // The unzipped release against its own list. hashes: { path: sha256 } of every file in
  // the zip except the list itself. -> { ok, problems: [plain sentences] }
  function verifyRelease(listing, hashes, wantVersion, manifestVersion) {
    if (!listing || !listing.files || typeof listing.files !== 'object') {
      return { ok: false, problems: ['The download has no file list (release-files.json) to check it against.'] };
    }
    const problems = [];
    if (wantVersion && listing.version !== wantVersion) {
      problems.push('The download is v' + listing.version + ', not v' + wantVersion + '.');
    }
    if (manifestVersion !== listing.version) {
      problems.push("The download's manifest.json says v" + manifestVersion + ', its file list says v' + listing.version + '.');
    }
    const have = hashes || {};
    for (const p of Object.keys(listing.files)) {
      if (!safePath(p)) problems.push('The file list has an unsafe name: ' + p);
      else if (!(p in have)) problems.push('Missing from the download: ' + p);
      else if (have[p] !== listing.files[p]) problems.push("Doesn't match the release's file list: " + p);
    }
    for (const p of Object.keys(have)) {
      if (!(p in listing.files)) problems.push('In the download but not on its file list: ' + p);
    }
    return { ok: problems.length === 0, problems };
  }

  // What to write, in order, and what to delete. manifest.json goes last so a folder
  // caught half way still reads as the old version; the list goes just before it.
  // oldListing: the folder's current release-files.json (null for git clones and
  // installs older than the list): only files a release put there are ever removed.
  function planWrites(newListing, oldListing) {
    const files = Object.keys(newListing.files).filter((p) => p !== 'manifest.json' && p !== LISTING).sort();
    const write = files.concat([LISTING, 'manifest.json']);
    const remove =
      oldListing && oldListing.files
        ? Object.keys(oldListing.files).filter((p) => !(p in newListing.files) && p !== LISTING && safePath(p)).sort()
        : [];
    return { write, remove };
  }

  // an UpdateError (or anything thrown) -> one sentence for the menu
  function describeError(e, fromVersion) {
    const still = fromVersion ? " You're still on v" + fromVersion + '.' : '';
    const stage = e && e.stage;
    if (stage === 'download') return "Couldn't download the new version from GitHub (" + e.message + '). Check your internet connection and click Update again.' + still;
    if (stage === 'check') return 'The download didn\'t pass the check: ' + e.message + ' Nothing in your folder was changed.' + still;
    if (stage === 'write') return "Your Mac didn't let me save " + (e.path || 'a file') + '. I put back the files I had already changed.' + still;
    return 'The update stopped: ' + ((e && e.message) || 'unknown error') + '.' + still;
  }

  // ---------------------------------------------------------------- browser

  class UpdateError extends Error {
    constructor(stage, message, extra) {
      super(message);
      this.stage = stage;
      Object.assign(this, extra || {});
    }
  }

  // the folder handle, kept in this extension's IndexedDB
  const DB = 'avf-self-update';
  const STORE = 'handles';
  const KEY = 'extension-folder';
  function idb() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function saveFolder(handle) {
    const db = await idb();
    try {
      await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).put(handle, KEY);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  }
  async function loadFolder() {
    try {
      const db = await idb();
      try {
        return await new Promise((resolve, reject) => {
          const q = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
          q.onsuccess = () => resolve(q.result || null);
          q.onerror = () => reject(q.error);
        });
      } finally {
        db.close();
      }
    } catch (e) {
      return null;
    }
  }

  // ask: may show Chrome's "Allow editing?" box (needs a click to have just happened)
  async function hasPermission(dir, ask) {
    const o = { mode: 'readwrite' };
    try {
      if ((await dir.queryPermission(o)) === 'granted') return true;
      if (!ask) return false;
      return (await dir.requestPermission(o)) === 'granted';
    } catch (e) {
      return false;
    }
  }

  async function fileHandle(dir, path, create) {
    const segs = path.split('/');
    let d = dir;
    for (const s of segs.slice(0, -1)) d = await d.getDirectoryHandle(s, { create });
    return d.getFileHandle(segs[segs.length - 1], { create });
  }
  async function readBytes(dir, path) {
    try {
      const fh = await fileHandle(dir, path, false);
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null;
      throw e;
    }
  }
  async function writeBytes(dir, path, bytes) {
    const fh = await fileHandle(dir, path, true);
    const w = await fh.createWritable(); // lands on disk only at close(), all at once
    try {
      await w.write(bytes);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (e2) { /* already closed */ }
      throw e;
    }
  }
  async function removeFile(dir, path) {
    const segs = path.split('/');
    let d = dir;
    try {
      for (const s of segs.slice(0, -1)) d = await d.getDirectoryHandle(s);
      await d.removeEntry(segs[segs.length - 1]);
    } catch (e) {
      if (!(e && e.name === 'NotFoundError')) throw e;
    }
  }

  const dec = (b) => new TextDecoder().decode(b);
  async function sha256Hex(bytes) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let s = '';
    for (const b of d) s += b.toString(16).padStart(2, '0');
    return s;
  }

  // Is this the folder Chrome runs the extension from? -> { ok, git } | { ok: false, reason }
  //   'no-permission' | 'not-extension' (no Almost Video Feedback manifest) | 'other-copy'
  //   (a copy of the extension, but not the one Chrome loaded)
  // Proof: write a random note into the folder, read it back through the extension's own
  // address (Chrome serves an unpacked extension's files live from disk), delete it.
  async function checkFolder(dir) {
    if (!(await hasPermission(dir, false))) return { ok: false, reason: 'no-permission' };
    let m = null;
    try {
      m = JSON.parse(dec(await readBytes(dir, 'manifest.json')));
    } catch (e) {
      /* not readable */
    }
    if (!m || m.name !== chrome.runtime.getManifest().name) return { ok: false, reason: 'not-extension' };
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let live = false;
    try {
      await writeBytes(dir, MARKER, new TextEncoder().encode(token));
    } catch (e) {
      return { ok: false, reason: 'no-permission' };
    }
    try {
      const r = await fetch(chrome.runtime.getURL(MARKER) + '?t=' + Date.now(), { cache: 'no-store' });
      live = r.ok && (await r.text()).trim() === token;
    } catch (e) {
      live = false;
    } finally {
      try { await removeFile(dir, MARKER); } catch (e) { /* best effort */ }
    }
    if (!live) return { ok: false, reason: 'other-copy' };
    let git = false;
    try {
      await dir.getDirectoryHandle('.git');
      git = true;
    } catch (e) {
      try {
        await dir.getFileHandle('.git'); // a worktree's .git is a file
        git = true;
      } catch (e2) { /* not git */ }
    }
    return { ok: true, git };
  }

  async function download(url, onProgress) {
    let res;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (e) {
      throw new UpdateError('download', 'no connection');
    }
    if (!res.ok) throw new UpdateError('download', 'GitHub answered ' + res.status);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !res.body.getReader) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress({ phase: 'download', done: got, total });
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  // Download, check, write. Resolves { version, written, removed }; throws UpdateError
  // (stage 'download' | 'check' | 'write'). A failure while writing puts every file it
  // had already changed back as it was.
  async function run({ dir, zipUrl, version, onProgress }) {
    const p = onProgress || (() => {});
    const ZIP = root.SCF_ZIP;
    p({ phase: 'download', done: 0, total: 0 });
    const bytes = await download(zipUrl, p);

    p({ phase: 'check' });
    const files = {};
    let listingBytes = null;
    try {
      for (const e of ZIP.readZipEntries(bytes)) {
        if (/\/$/.test(e.name)) continue; // a folder entry
        const rel = stripTop(e.name);
        if (rel === null || !safePath(rel)) throw new Error('unexpected file ' + e.name);
        const data = await ZIP.entryBytes(e);
        if (rel === LISTING) listingBytes = data;
        else files[rel] = data;
      }
    } catch (e) {
      throw new UpdateError('check', 'the zip is damaged (' + e.message + ').');
    }
    let listing = null;
    let manifestVersion = null;
    try { listing = JSON.parse(dec(listingBytes)); } catch (e) { /* reported below */ }
    try { manifestVersion = JSON.parse(dec(files['manifest.json'])).version; } catch (e) { /* reported below */ }
    const hashes = {};
    for (const k of Object.keys(files)) hashes[k] = await sha256Hex(files[k]);
    const v = verifyRelease(listing, hashes, version, manifestVersion);
    if (!v.ok) throw new UpdateError('check', v.problems[0], { problems: v.problems });

    let oldListing = null;
    try {
      const b = await readBytes(dir, LISTING);
      if (b) oldListing = JSON.parse(dec(b));
    } catch (e) {
      oldListing = null;
    }
    const plan = planWrites(listing, oldListing);
    const data = Object.assign({}, files, { [LISTING]: listingBytes });
    const backup = new Map(); // path -> old bytes, or null when the file is new
    const changed = [];
    const steps = plan.write.length + plan.remove.length;
    let current = null;
    try {
      for (const path of plan.write) {
        current = path;
        backup.set(path, await readBytes(dir, path));
        await writeBytes(dir, path, data[path]);
        changed.push(path);
        p({ phase: 'write', done: changed.length, total: steps });
      }
      for (const path of plan.remove) {
        current = path;
        const old = await readBytes(dir, path);
        if (old) {
          backup.set(path, old);
          await removeFile(dir, path);
          changed.push(path);
        }
        p({ phase: 'write', done: plan.write.length + plan.remove.indexOf(path) + 1, total: steps });
      }
    } catch (e) {
      for (const path of changed.slice().reverse()) {
        const old = backup.get(path);
        try {
          if (old) await writeBytes(dir, path, old);
          else await removeFile(dir, path);
        } catch (e2) { /* best effort */ }
      }
      throw new UpdateError('write', (e && e.message) || 'write failed', { path: current });
    }
    return { version: listing.version, written: plan.write.length, removed: plan.remove.length };
  }

  async function getState() {
    try {
      return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || null;
    } catch (e) {
      return null;
    }
  }
  async function setState(s) {
    try {
      await chrome.storage.local.set({ [STATE_KEY]: s });
    } catch (e) { /* ignore */ }
  }

  // The whole update, for the menu and the update page alike. target = { version, zipUrl }.
  // isBusy(): resolves true while a recording / save / import runs (reloading would lose it).
  // -> { ok: true } just before the restart, or { ok: false, message }
  async function updateTo({ dir, target, onProgress, isBusy }) {
    const from = chrome.runtime.getManifest().version;
    await setState({ from, to: target.version, state: 'writing', at: Date.now() });
    try {
      await run({ dir, zipUrl: target.zipUrl, version: target.version, onProgress });
    } catch (e) {
      const message = describeError(e, from);
      await setState({ from, to: target.version, state: 'failed', at: Date.now(), error: message });
      return { ok: false, message };
    }
    await setState({ from, to: target.version, state: 'done', at: Date.now() });
    if (isBusy && (await isBusy())) {
      // the files are in; the menu's "Update now" finishes once the recording is saved
      return { ok: false, pending: true, message: 'v' + target.version + ' is in your folder. A recording is still running or saving, so click Update now once it has finished.' };
    }
    if (onProgress) onProgress({ phase: 'restart' });
    setTimeout(() => chrome.runtime.reload(), 300); // closes this page; the new version reopens the menu
    return { ok: true };
  }

  // progress -> { pct, label } for a bar
  function progressText(ev, version) {
    if (!ev) return { pct: 0, label: '' };
    if (ev.phase === 'download') {
      const pct = ev.total ? Math.round((ev.done / ev.total) * 40) : 5;
      const kb = Math.round((ev.done || 0) / 1024);
      return { pct, label: 'Downloading v' + version + (kb ? ' · ' + kb + ' KB' : '') + '…' };
    }
    if (ev.phase === 'check') return { pct: 45, label: 'Checking every file…' };
    if (ev.phase === 'write') return { pct: 50 + Math.round((ev.done / Math.max(1, ev.total)) * 45), label: 'Writing file ' + ev.done + ' of ' + ev.total + '…' };
    if (ev.phase === 'restart') return { pct: 100, label: 'Restarting with v' + version + '…' };
    return { pct: 0, label: '' };
  }

  const pure = { TOP, LISTING, MARKER, STATE_KEY, stripTop, safePath, verifyRelease, planWrites, describeError, progressText };
  const api = Object.assign({}, pure, {
    UpdateError, saveFolder, loadFolder, hasPermission, checkFolder, run, updateTo, getState, setState,
  });
  root.SCF = root.SCF || {};
  root.SCF.selfUpdate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
