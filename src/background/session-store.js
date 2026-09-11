/*
 * Durable session buffer backed by IndexedDB.
 *
 * The MV3 service worker can be evicted mid-session; everything we need for the
 * final export (the event timeline + screenshot blobs) is written here as it
 * happens, so a restart re-reads it instead of losing data. Classic script,
 * attaches to globalThis.SCF.sessionStore.
 *
 * Stores:
 *   meta        { key, value }            // 'session' -> session metadata
 *   events      { id++, t, type, ... }    // transcript | screenshot | navigation
 *   screenshots { seq, blob, mime }       // raw image bytes, referenced by event.seq
 */
(function (root) {
  'use strict';
  root.SCF = root.SCF || {};

  const DB_NAME = 'scf-sessions';
  const DB_VERSION = 2;
  const HISTORY_MAX = 40; // keep the most recent N archived sessions
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('events')) {
          db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('screenshots')) {
          db.createObjectStore('screenshots', { keyPath: 'seq' });
        }
        // archived (past) sessions for the recordings library
        if (!db.objectStoreNames.contains('history')) {
          db.createObjectStore('history', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('historyShots')) {
          const hs = db.createObjectStore('historyShots', { keyPath: 'key' });
          hs.createIndex('byId', 'id', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(storeNames, mode, fn) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeNames, mode);
          let result;
          t.oncomplete = () => resolve(result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error || new Error('tx aborted'));
          result = fn(t);
        })
    );
  }

  function reqProm(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function reset() {
    await tx(['meta', 'events', 'screenshots'], 'readwrite', (t) => {
      t.objectStore('meta').clear();
      t.objectStore('events').clear();
      t.objectStore('screenshots').clear();
    });
  }

  async function setMeta(value) {
    await tx('meta', 'readwrite', (t) => {
      t.objectStore('meta').put({ key: 'session', value });
    });
    return value;
  }

  async function getMeta() {
    const row = await tx('meta', 'readonly', (t) => {
      const out = {};
      const r = t.objectStore('meta').get('session');
      r.onsuccess = () => (out.v = r.result);
      return out;
    });
    return row && row.v ? row.v.value : null;
  }

  async function patchMeta(patch) {
    const cur = (await getMeta()) || {};
    return setMeta(Object.assign({}, cur, patch));
  }

  async function addEvent(evt) {
    let id;
    await tx('events', 'readwrite', (t) => {
      const r = t.objectStore('events').add(evt);
      r.onsuccess = () => (id = r.result);
    });
    return id;
  }

  // Merge a patch into one stored event (e.g. a corrected transcript segment).
  // Returns the updated event, or null if the id doesn't exist.
  async function updateEvent(id, patch) {
    let updated = null;
    await tx('events', 'readwrite', (t) => {
      const os = t.objectStore('events');
      const r = os.get(id);
      r.onsuccess = () => {
        if (!r.result) return;
        updated = Object.assign({}, r.result, patch, { id });
        os.put(updated);
      };
    });
    return updated;
  }

  async function deleteEvent(id) {
    await tx('events', 'readwrite', (t) => {
      t.objectStore('events').delete(id);
    });
  }

  async function addScreenshot(seq, blob, mime) {
    await tx('screenshots', 'readwrite', (t) => {
      t.objectStore('screenshots').put({ seq, blob, mime });
    });
  }

  async function getEvents() {
    const events = await tx('events', 'readonly', (t) =>
      reqAll(t.objectStore('events'))
    );
    // primary order = timestamp, tiebreak by insertion id
    events.sort((a, b) => a.t - b.t || a.id - b.id);
    return events;
  }

  async function getScreenshot(seq) {
    return tx('screenshots', 'readonly', (t) => {
      const out = {};
      const r = t.objectStore('screenshots').get(seq);
      r.onsuccess = () => (out.v = r.result);
      return out;
    }).then((o) => (o && o.v ? o.v : null));
  }

  function reqAll(store) {
    // wrapper that lets the surrounding tx() resolve with the collected array
    const results = [];
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      }
    };
    return results;
  }

  async function counts() {
    return tx(['events', 'screenshots'], 'readonly', (t) => {
      const out = { events: 0, screenshots: 0 };
      t.objectStore('events').count().onsuccess = function () {
        out.events = this.result;
      };
      t.objectStore('screenshots').count().onsuccess = function () {
        out.screenshots = this.result;
      };
      return out;
    });
  }

  // -------------------------------------------------------------- history

  // Archive a finished session: a lightweight summary+timeline record plus the
  // screenshot blobs (kept separately so the list query stays cheap).
  async function archiveSession(record, shots) {
    await tx(['history', 'historyShots'], 'readwrite', (t) => {
      t.objectStore('history').put(record);
      const hs = t.objectStore('historyShots');
      for (const s of shots || []) {
        hs.put({ key: record.id + '/' + s.seq, id: record.id, seq: s.seq, blob: s.blob, mime: s.mime });
      }
    });
    await pruneHistory(HISTORY_MAX);
    return record.id;
  }

  async function listHistory() {
    const rows = await tx('history', 'readonly', (t) => reqAll(t.objectStore('history')));
    rows.sort((a, b) => b.startedAt - a.startedAt);
    return rows;
  }

  async function getHistory(id) {
    return tx('history', 'readonly', (t) => {
      const out = {};
      const r = t.objectStore('history').get(id);
      r.onsuccess = () => (out.v = r.result);
      return out;
    }).then((o) => (o && o.v ? o.v : null));
  }

  async function getHistoryShots(id) {
    const rows = await tx('historyShots', 'readonly', (t) => {
      const results = [];
      const idx = t.objectStore('historyShots').index('byId');
      const cur = idx.openCursor(IDBKeyRange.only(id));
      cur.onsuccess = (e) => {
        const c = e.target.result;
        if (c) {
          results.push(c.value);
          c.continue();
        }
      };
      return results;
    });
    rows.sort((a, b) => a.seq - b.seq);
    return rows;
  }

  async function deleteHistory(id) {
    const shots = await getHistoryShots(id);
    await tx(['history', 'historyShots'], 'readwrite', (t) => {
      t.objectStore('history').delete(id);
      const hs = t.objectStore('historyShots');
      for (const s of shots) hs.delete(s.key);
    });
  }

  // Remove specific screenshots (by seq) from an archived session: drop the
  // blobs and the matching screenshot events, recompute the count. Original
  // Downloads files are untouched. Returns the updated record.
  async function deleteHistoryShots(id, seqs) {
    const set = new Set((seqs || []).map(Number));
    if (!set.size) return getHistory(id);
    await tx('historyShots', 'readwrite', (t) => {
      const hs = t.objectStore('historyShots');
      for (const seq of set) hs.delete(id + '/' + seq);
    });
    const rec = await getHistory(id);
    if (rec) {
      rec.events = (rec.events || []).filter((e) => !(e.type === 'screenshot' && set.has(e.seq)));
      rec.screenshotCount = rec.events.filter((e) => e.type === 'screenshot').length;
      await tx('history', 'readwrite', (t) => {
        t.objectStore('history').put(rec);
      });
    }
    return rec;
  }

  async function pruneHistory(max) {
    const rows = await listHistory();
    if (rows.length <= max) return;
    const drop = rows.slice(max); // oldest beyond the cap
    for (const r of drop) await deleteHistory(r.id);
  }

  // Persist edits to an archived session record (e.g. corrected transcript text).
  async function saveHistory(rec) {
    await tx('history', 'readwrite', (t) => {
      t.objectStore('history').put(rec);
    });
    return rec;
  }

  async function clearHistory() {
    await tx(['history', 'historyShots'], 'readwrite', (t) => {
      t.objectStore('history').clear();
      t.objectStore('historyShots').clear();
    });
  }

  root.SCF.sessionStore = {
    reset,
    setMeta,
    getMeta,
    patchMeta,
    addEvent,
    updateEvent,
    deleteEvent,
    addScreenshot,
    getEvents,
    getScreenshot,
    counts,
    archiveSession,
    listHistory,
    getHistory,
    getHistoryShots,
    deleteHistory,
    deleteHistoryShots,
    pruneHistory,
    saveHistory,
    clearHistory,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
