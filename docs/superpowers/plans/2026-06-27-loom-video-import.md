# Loom Video Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a `loom.com/share/...` page, let the user click "Import this Loom video" to turn the Loom transcript + video into the same `feedback.md` + screenshots bundle the live recorder produces.

**Architecture:** A second *source* feeding the existing export pipeline. The Loom transcript (text + per-segment ms) is scraped in a content script; the service worker seeks the Loom player to a set of target times and grabs clean, cropped frames via `captureVisibleTab`; both become the same `screenshot` + `transcript` timeline events, so `exporter.build` / `downloads.writeSession` / archive are reused unchanged.

**Tech Stack:** MV3 Chrome extension, classic scripts only (no `import`/`export`; service worker uses `importScripts`, content/page files attach to `globalThis`). Pure logic dual-exported (`module.exports` + global) and unit-tested in `test/run.cjs`. No build step, no runtime deps.

## Global Constraints

- **No build step / no runtime deps / no `import`/`export`** in worker or content scripts. Worker pulls modules via `importScripts`; content files attach to `globalThis` (e.g. `SCF`, `SCF_LOOM`).
- **Cross-context messages go through `src/common/protocol.js`** — add a constant, never hard-code a type string.
- **Tunables go through `src/common/config.js`** — no scattered magic numbers.
- **Pure logic uses the dual-export pattern and gets a test** in `test/run.cjs`.
- **Keep permissions minimal** — this feature needs NO new manifest permission (`<all_urls>` host access + `tabs`/`scripting`/`downloads` already cover it). Do not add any.
- **Keep `feedback.md` stable** — `exporter.build`'s output shape is the contract with the downstream AI; only additive changes, update its tests.
- **Required checks before every commit:** `npm test` (pure-logic units, must be green) and `npm run verify` (manifest + every referenced file exists + `node --check` every `.js`). Both must pass.
- Browser-bound behavior (DOM scrape, player seek, frame crop) **cannot** be proven by unit tests — state it as needing a human to load the unpacked extension and verify.

## Cross-module interface (names every task must use verbatim)

- `protocol.js` `MSG`: `IMPORT_LOOM: 'import_loom'`, `LOOM_PROBE: 'loom_probe'`, `LOOM_SEEK: 'loom_seek'`, `IMPORT_PROGRESS: 'import_progress'`. `TRIGGER`: `FRAME: 'frame'`.
- `config.js` `DEFAULTS`: `loomFrameFloorSeconds: 15`, `loomSeekSettleMs: 350`.
- `exporter.js` `TRIGGER_LABEL.frame = '🎞️ Video frame'`.
- `SCF.loomTimeline.parseTimestamp(str) -> number|null` (ms), `SCF.loomTimeline.buildTargets(timesMs, opts) -> number[]` (sorted, unique). Pure, dual-exported.
- `SCF_LOOM` (content) responds to: `LOOM_PROBE -> {ok, hasTranscript, segments:[{ms,text}], title, error}`; `LOOM_SEEK {ms, restore} -> {ok, rect:{x,y,width,height}, dpr, error}`.
- `SCF.loomCapture.runImport({tabId, windowId, startedAt, settings, dir, store, onProgress}) -> Promise<{frames, segments, lastMs, error}>`.
- service worker helper: `exportAndArchive(events, meta, endedAt) -> Promise<lastResult>` (shared by stop + import).

---

### Task 1: Protocol, config, and exporter trigger label

**Files:**
- Modify: `src/common/protocol.js` (add `MSG` + `TRIGGER` constants)
- Modify: `src/common/config.js:37-39` area (add two `DEFAULTS` keys)
- Modify: `src/background/exporter.js:17-28` (`TRIGGER_LABEL` map)
- Test: `test/run.cjs` (exporter section)

**Interfaces:**
- Produces: `MSG.IMPORT_LOOM/LOOM_PROBE/LOOM_SEEK/IMPORT_PROGRESS`, `TRIGGER.FRAME`, `DEFAULTS.loomFrameFloorSeconds`, `DEFAULTS.loomSeekSettleMs`, `TRIGGER_LABEL.frame`. Consumed by Tasks 2–6.

- [ ] **Step 1: Write the failing test** — append to the `exporter:` section of `test/run.cjs` (after the `relTime` test, before `empty session`):

```js
test('frame trigger renders a video-frame label', () => {
  const ev = [{ id: 1, t: 1000, type: 'screenshot', seq: 1, trigger: 'frame', url: 'https://www.loom.com/share/abc', title: 'Demo' }];
  const r = exporter.build(ev, { startedAt: 1000, endedAt: 1000, startedAtText: 'x' });
  assert.ok(r.markdown.includes('🎞️ Video frame'), 'frame label rendered');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/run.cjs`
Expected: FAIL — the `frame trigger renders a video-frame label` case fails (label not in markdown).

- [ ] **Step 3: Add the trigger label** — in `src/background/exporter.js`, inside `TRIGGER_LABEL`, add a line after `forced: '📸 Manual screenshot',`:

```js
    frame: '🎞️ Video frame',
```

- [ ] **Step 4: Add protocol constants** — in `src/common/protocol.js`, inside the `MSG` object, add after the `KEEPALIVE: 'keepalive',` line:

```js
    // popup -> service worker: import a Loom share video into a bundle
    IMPORT_LOOM: 'import_loom',
    // service worker <-> content (Loom page): scrape transcript / seek player
    LOOM_PROBE: 'loom_probe',
    LOOM_SEEK: 'loom_seek',
    // service worker -> popup: import progress ticks
    IMPORT_PROGRESS: 'import_progress',
```

In the same file, inside the `TRIGGER` object, add after `ANNOTATE: 'annotate',`:

```js
    FRAME: 'frame', // a frame grabbed from an imported video (Loom import)
```

(Do **not** add `FRAME` to `PRIORITY_TRIGGERS`; Loom frames are deduped by their own path, not by `capture.js`.)

- [ ] **Step 5: Add config tunables** — in `src/common/config.js`, inside `DEFAULTS`, add after the `maxScreenshots: 300,` line:

```js

    // Loom import (turning a loom.com/share video into a bundle)
    loomFrameFloorSeconds: 15, // if two transcript timestamps are >this apart, fill the gap with extra frames
    loomSeekSettleMs: 350, // wait after seeking the player before capturing, so the frame has painted
```

- [ ] **Step 6: Run tests + verify**

Run: `node test/run.cjs && npm run verify`
Expected: all tests PASS (including the new one); verify prints "all checks passed".

- [ ] **Step 7: Commit**

```bash
git add src/common/protocol.js src/common/config.js src/background/exporter.js test/run.cjs
git commit -m "feat(loom): add import protocol constants, config knobs, frame trigger label"
```

---

### Task 2: Pure Loom timeline module (`loom-timeline.js`)

**Files:**
- Create: `src/background/loom-timeline.js`
- Modify: `test/run.cjs` (require + new section)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `SCF.loomTimeline.parseTimestamp(str) -> number|null` (ms); `SCF.loomTimeline.buildTargets(timesMs, {floorMs, maxFrames}) -> number[]`. Used by Task 3 (parseTimestamp) and Task 4 (buildTargets).

- [ ] **Step 1: Write the failing tests** — in `test/run.cjs`, add the require near the top (after the `const exporter = ...` line):

```js
const loomTimeline = require('../src/background/loom-timeline.js');
```

Then add a new section before the `console.log('zip:');` line:

```js
console.log('loom-timeline:');

test('parseTimestamp parses mm:ss and h:mm:ss to ms', () => {
  assert.strictEqual(loomTimeline.parseTimestamp('00:00'), 0);
  assert.strictEqual(loomTimeline.parseTimestamp('00:09'), 9000);
  assert.strictEqual(loomTimeline.parseTimestamp('01:05'), 65000);
  assert.strictEqual(loomTimeline.parseTimestamp('1:02:03'), 3723000);
});

test('parseTimestamp rejects junk', () => {
  assert.strictEqual(loomTimeline.parseTimestamp('hello'), null);
  assert.strictEqual(loomTimeline.parseTimestamp(''), null);
  assert.strictEqual(loomTimeline.parseTimestamp(null), null);
});

test('buildTargets always includes t=0 and every segment time, sorted+unique', () => {
  const r = loomTimeline.buildTargets([9000, 9000, 2000], { floorMs: 15000, maxFrames: 300 });
  assert.deepStrictEqual(r, [0, 2000, 9000]);
});

test('buildTargets fills gaps larger than floorMs', () => {
  // 0 -> 40000 is a 40s gap; floor 15s -> insert 15000, 30000
  const r = loomTimeline.buildTargets([40000], { floorMs: 15000, maxFrames: 300 });
  assert.deepStrictEqual(r, [0, 15000, 30000, 40000]);
});

test('buildTargets respects maxFrames by even subsampling (keeps first + last)', () => {
  const segs = [10000, 20000, 30000, 40000, 50000]; // anchors incl 0 -> 6 targets
  const r = loomTimeline.buildTargets(segs, { floorMs: 60000, maxFrames: 3 });
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0], 0);
  assert.strictEqual(r[r.length - 1], 50000);
});

test('buildTargets on empty segments yields just [0]', () => {
  assert.deepStrictEqual(loomTimeline.buildTargets([], { floorMs: 15000, maxFrames: 300 }), [0]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/run.cjs`
Expected: FAIL — `Cannot find module '../src/background/loom-timeline.js'`.

- [ ] **Step 3: Create the module** — write `src/background/loom-timeline.js`:

```js
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
```

- [ ] **Step 4: Run tests + verify**

Run: `node test/run.cjs && npm run verify`
Expected: all PASS; verify prints "all checks passed" (it `node --check`s the new file).

- [ ] **Step 5: Commit**

```bash
git add src/background/loom-timeline.js test/run.cjs
git commit -m "feat(loom): pure timeline module (parseTimestamp + buildTargets) with tests"
```

---

### Task 3: Loom page content module (`loom-import.js`)

**Browser-bound — not unit-testable.** Verified by `npm run verify` (syntax/manifest) + manual load. The transcript selectors and control-overlay hiding are **best-effort heuristics that must be tuned against the live Loom DOM**; the module keys off the visible `mm:ss` timestamp pattern (stable across Loom redesigns) rather than fragile class names, and falls back to the video's native `textTracks` when present.

**Files:**
- Create: `src/content/loom-import.js`
- Modify: `manifest.json` (add the file to the **first** `content_scripts` entry's `js` array)

**Interfaces:**
- Consumes: `SCF.MSG` (Task 1), `SCF.loomTimeline.parseTimestamp` (Task 2).
- Produces: a content-script message responder — `LOOM_PROBE -> {ok, hasTranscript, segments:[{ms,text}], title, error}`; `LOOM_SEEK {ms, restore} -> {ok, rect:{x,y,width,height}, dpr, error}`. Used by Task 4.

- [ ] **Step 1: Create the module** — write `src/content/loom-import.js`:

```js
/*
 * Loom share-page bridge for the import feature (content script, top frame).
 * Attaches to globalThis.SCF_LOOM. Scrapes the transcript and drives the player
 * so the service worker can grab frames via captureVisibleTab.
 *
 * Heuristic + brittle by nature (third-party DOM): transcript cues are found by
 * the visible mm:ss timestamp pattern, with a fallback to the <video> textTracks.
 * Verify/adjust against the live Loom page (see docs plan, Task 3).
 */
(function (root) {
  'use strict';
  if (root.SCF_LOOM) return;
  const MSG = (root.SCF && root.SCF.MSG) || {};
  const parseTimestamp = root.SCF && root.SCF.loomTimeline && root.SCF.loomTimeline.parseTimestamp;

  function isLoomShare() {
    return /(^|\.)loom\.com$/i.test(location.hostname) && /\/share\//.test(location.pathname);
  }

  function findVideo() {
    // largest <video> on the page is the player
    const vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) return null;
    return vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  }

  function videoTitle() {
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return og.content;
    return (document.title || 'Loom video').replace(/\s*[|·-]\s*Loom\s*$/i, '').trim();
  }

  // Try the video's native caption track first (clean timing, no scraping).
  function fromTextTracks() {
    const v = findVideo();
    if (!v || !v.textTracks || !v.textTracks.length) return null;
    for (const tt of v.textTracks) {
      const cues = tt.cues;
      if (cues && cues.length) {
        const segs = [];
        for (let i = 0; i < cues.length; i++) {
          const c = cues[i];
          const text = (c.text || '').replace(/\s+/g, ' ').trim();
          if (text) segs.push({ ms: Math.round(c.startTime * 1000), text });
        }
        if (segs.length) return segs;
      }
    }
    return null;
  }

  // Fall back to scraping the rendered transcript panel by timestamp pattern.
  function fromDom() {
    if (!parseTimestamp) return null;
    const tsRe = /^\d{1,2}:\d{2}(?::\d{2})?$/;
    const segs = [];
    // Walk text nodes; whenever an element's trimmed text is exactly a timestamp,
    // pair it with the caption text that follows in the same cue container.
    const all = document.querySelectorAll('button, span, div, p, li');
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (!tsRe.test(t)) continue;
      const ms = parseTimestamp(t);
      if (ms == null) continue;
      // caption = nearest following sibling / parent's text minus the stamp
      let caption = '';
      const row = el.closest('li, [role="listitem"], div') || el.parentElement;
      if (row) caption = (row.textContent || '').replace(t, '').replace(/\s+/g, ' ').trim();
      if (!caption && el.nextElementSibling) caption = (el.nextElementSibling.textContent || '').replace(/\s+/g, ' ').trim();
      if (caption && caption.length > 1) segs.push({ ms, text: caption });
    }
    // de-dup by ms (the walk can hit the same cue twice), keep first caption
    const seen = new Set();
    const out = [];
    for (const s of segs.sort((a, b) => a.ms - b.ms)) {
      if (seen.has(s.ms)) continue;
      seen.add(s.ms);
      out.push(s);
    }
    return out.length ? out : null;
  }

  // Open the Transcript tab (it often lazy-renders) before scraping.
  function openTranscriptTab() {
    const tabs = Array.from(document.querySelectorAll('button, [role="tab"], a'));
    const t = tabs.find((b) => /transcript/i.test((b.textContent || '').trim()) && (b.textContent || '').trim().length < 20);
    if (t) { try { t.click(); } catch (e) { /* ignore */ } return true; }
    return false;
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function probe() {
    if (!isLoomShare()) return { ok: false, error: 'not-a-loom-share-page' };
    if (!findVideo()) return { ok: false, error: 'no-video-found' };
    let segs = fromTextTracks();
    if (!segs) {
      openTranscriptTab();
      await delay(600); // let the panel render
      segs = fromTextTracks() || fromDom();
    }
    if (!segs || !segs.length) return { ok: true, hasTranscript: false, segments: [], title: videoTitle() };
    return { ok: true, hasTranscript: true, segments: segs, title: videoTitle() };
  }

  // --- player driving (for frame capture) ---
  let styleEl = null;
  function setControlsHidden(hidden) {
    if (hidden) {
      if (styleEl) return;
      styleEl = document.createElement('style');
      styleEl.setAttribute('data-scf-loom', '1');
      // best-effort: hide common player control overlays so frames are clean.
      // TUNE against the live Loom DOM if controls still bleed into frames.
      styleEl.textContent =
        '[class*="controls" i],[class*="overlay" i],[class*="scrubber" i],' +
        'video::-webkit-media-controls{opacity:0 !important;pointer-events:none !important;}';
      document.documentElement.appendChild(styleEl);
    } else if (styleEl) {
      styleEl.remove();
      styleEl = null;
    }
  }

  function raf2() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  function seekVideo(v, sec) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; v.removeEventListener('seeked', finish); resolve(); } };
      v.addEventListener('seeked', finish);
      try { v.currentTime = sec; } catch (e) { finish(); }
      setTimeout(finish, 1200); // don't hang if 'seeked' never fires
    });
  }

  async function seekTo(ms, restore) {
    const v = findVideo();
    if (!v) return { ok: false, error: 'no-video' };
    if (restore) { setControlsHidden(false); try { v.muted = false; } catch (e) {} return { ok: true }; }
    try { v.muted = true; v.pause(); } catch (e) { /* ignore */ }
    setControlsHidden(true);
    await seekVideo(v, Math.max(0, ms / 1000));
    await raf2();
    const r = v.getBoundingClientRect();
    return { ok: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, dpr: window.devicePixelRatio || 1 };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === MSG.LOOM_PROBE) { probe().then(sendResponse); return true; }
    if (msg.type === MSG.LOOM_SEEK) { seekTo(msg.ms, msg.restore).then(sendResponse); return true; }
    return false;
  });

  root.SCF_LOOM = { isLoomShare, probe, seekTo, _findVideo: findVideo };
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

- [ ] **Step 2: Register it in the manifest** — in `manifest.json`, in the **first** `content_scripts` entry (the `all_frames: false` one), add `loom-timeline.js` + `loom-import.js` to the `js` array so the page has the timestamp parser available. Change the `js` array to:

```json
      "js": [
        "src/common/protocol.js",
        "src/background/loom-timeline.js",
        "src/content/overlay-style.js",
        "src/content/dom-descriptor.js",
        "src/content/gesture.js",
        "src/content/annotate.js",
        "src/content/loom-import.js",
        "src/content/content.js"
      ],
```

(Leave the second `all_frames: true` entry unchanged — Loom driving is top-frame only.)

- [ ] **Step 3: Verify (syntax + manifest references)**

Run: `npm run verify`
Expected: "all checks passed" — both new files resolve and `node --check` clean.

- [ ] **Step 4: Manual sanity (flag as human-required)**

This step CANNOT be unit-tested. On a real Chrome with the unpacked extension loaded, open a `loom.com/share/...` video that has a transcript, open DevTools console on the page, and run:

```js
SCF_LOOM.isLoomShare(); // expect true
await SCF_LOOM.probe();  // expect {ok:true, hasTranscript:true, segments:[{ms,text}...], title}
```

Confirm `segments` has sensible `ms` (ascending) and caption text. If empty, adjust the selectors in `fromDom()` / `openTranscriptTab()` to match the live Loom DOM. **Record in the commit/PR that this needs human verification.**

- [ ] **Step 5: Commit**

```bash
git add src/content/loom-import.js manifest.json
git commit -m "feat(loom): content module to scrape transcript + drive the player (browser-verify)"
```

---

### Task 4: Service-worker capture module (`loom-capture.js`)

**Browser-bound — not unit-testable** (uses `chrome.tabs.captureVisibleTab`, `OffscreenCanvas`, `createImageBitmap`). The `buildTargets` math it calls is covered by Task 2. Verified by `npm run verify` + manual.

**Files:**
- Create: `src/background/loom-capture.js`

**Interfaces:**
- Consumes: `SCF.MSG`/`SCF.TRIGGER` (Task 1), `SCF.loomTimeline.buildTargets` (Task 2), `SCF.imageHash` (existing), `SCF.exporter.fileFor` + `SCF.downloads.saveShot` (existing), and the `store` passed in.
- Produces: `SCF.loomCapture.runImport({tabId, windowId, startedAt, settings, dir, store, onProgress}) -> Promise<{frames, segments, lastMs, error}>` (`lastMs` = end of video covered, for bundle duration). Used by Task 5.

- [ ] **Step 1: Create the module** — write `src/background/loom-capture.js`:

```js
/*
 * Loom import capture (service worker). Classic script -> globalThis.SCF.loomCapture.
 *
 * Drives the Loom page (via LOOM_SEEK messages to the content script) to each
 * target time, captures the visible tab, crops to the video rect, dedups, and
 * stores screenshot + transcript events on the same timeline the live recorder
 * uses. captureVisibleTab sees cross-origin video pixels (rendered output), so
 * there is no canvas-taint problem.
 */
(function (root) {
  'use strict';
  root.SCF = root.SCF || {};
  const { MSG, TRIGGER } = root.SCF;
  const imageHash = root.SCF.imageHash;
  const loomTimeline = root.SCF.loomTimeline;
  const exporter = root.SCF.exporter;
  const downloads = root.SCF.downloads;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  function sendToTab(tabId, msg, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs || 4000);
      try {
        chrome.tabs.sendMessage(tabId, msg, (resp) => {
          void chrome.runtime.lastError;
          if (!done) { done = true; clearTimeout(to); resolve(resp == null ? null : resp); }
        });
      } catch (e) { if (!done) { done = true; clearTimeout(to); resolve(null); } }
    });
  }

  // Crop a captureVisibleTab dataURL to a CSS rect (scaled by dpr). Falls back to
  // the full frame if the rect is unusable.
  async function cropToRect(dataUrl, rect, dpr, mime) {
    const blob = await (await fetch(dataUrl)).blob();
    if (!rect || !rect.width || !rect.height) return blob;
    const bitmap = await createImageBitmap(blob);
    const sx = Math.max(0, Math.round(rect.x * dpr));
    const sy = Math.max(0, Math.round(rect.y * dpr));
    const sw = Math.min(bitmap.width - sx, Math.round(rect.width * dpr));
    const sh = Math.min(bitmap.height - sy, Math.round(rect.height * dpr));
    if (sw <= 0 || sh <= 0) { bitmap.close(); return blob; }
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    bitmap.close();
    return await canvas.convertToBlob(
      mime === 'image/jpeg' ? { type: 'image/jpeg', quality: 0.9 } : { type: 'image/png' }
    );
  }

  async function hashOf(blob) {
    try {
      const bitmap = await createImageBitmap(blob);
      const c = new OffscreenCanvas(imageHash.HASH_W, imageHash.HASH_H);
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bitmap, 0, 0, imageHash.HASH_W, imageHash.HASH_H);
      const h = imageHash.dHash(x.getImageData(0, 0, imageHash.HASH_W, imageHash.HASH_H));
      bitmap.close();
      return h;
    } catch (e) { return null; }
  }

  /**
   * @param {{tabId:number, windowId:number, startedAt:number, settings:object,
   *          dir:string, store:object, onProgress?:function}} a
   * @returns {Promise<{frames:number, segments:number, error?:string}>}
   */
  async function runImport(a) {
    const { tabId, windowId, startedAt, settings, dir, store } = a;
    const onProgress = a.onProgress || function () {};

    const probe = await sendToTab(tabId, { type: MSG.LOOM_PROBE }, 8000);
    if (!probe || !probe.ok) return { frames: 0, segments: 0, error: (probe && probe.error) || 'probe-failed' };
    if (!probe.hasTranscript) return { frames: 0, segments: 0, error: 'no-transcript' };

    const segments = probe.segments;
    const title = probe.title || 'Loom video';
    const url = (await chrome.tabs.get(tabId).catch(() => null) || {}).url || null;

    const floorMs = (settings.loomFrameFloorSeconds || 15) * 1000;
    const maxFrames = settings.maxScreenshots || 300;
    const targets = loomTimeline.buildTargets(segments.map((s) => s.ms), { floorMs, maxFrames });

    const mime = settings.captureFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
    const opts = settings.captureFormat === 'jpeg' ? { format: 'jpeg', quality: settings.jpegQuality || 90 } : { format: 'png' };
    const threshold = settings.dedupHammingThreshold != null ? settings.dedupHammingThreshold : 6;
    const settle = settings.loomSeekSettleMs || 350;

    let seq = 0;
    let lastHash = null;
    for (let i = 0; i < targets.length; i++) {
      const ms = targets[i];
      onProgress({ done: i, total: targets.length, phase: 'capturing' });
      const seek = await sendToTab(tabId, { type: MSG.LOOM_SEEK, ms }, 4000);
      await delay(settle);
      let dataUrl;
      try { dataUrl = await chrome.tabs.captureVisibleTab(windowId, opts); } catch (e) { dataUrl = null; }
      if (!dataUrl) continue; // tab not foreground / capture failed -> skip this target
      const rect = seek && seek.ok ? seek.rect : null;
      const dpr = seek && seek.ok ? (seek.dpr || 1) : 1;
      const blob = await cropToRect(dataUrl, rect, dpr, mime);

      const hash = await hashOf(blob);
      if (hash && lastHash && imageHash.hammingDistance(lastHash, hash) <= threshold) continue; // unchanged -> cull
      if (hash) lastHash = hash;

      seq += 1;
      await store.addScreenshot(seq, blob, mime);
      await store.addEvent({
        t: startedAt + ms, type: 'screenshot', seq, mime,
        trigger: TRIGGER.FRAME, url, title, element: null, selectionText: null, scrollY: null, hash: hash || null,
      });
      if (dir && downloads && exporter) downloads.saveShot(dir, exporter.fileFor(seq), blob, mime).catch(() => {});
    }

    // transcript events (final segments) on the same timeline
    for (const s of segments) {
      if (s.text && s.text.trim()) await store.addEvent({ t: startedAt + s.ms, type: 'transcript', final: true, text: s.text.trim() });
    }

    await sendToTab(tabId, { type: MSG.LOOM_SEEK, restore: true }, 1000); // un-mute, restore controls
    onProgress({ done: targets.length, total: targets.length, phase: 'done' });
    // lastMs = end of the video we covered, so the bundle's duration is meaningful
    const lastTarget = targets.length ? targets[targets.length - 1] : 0;
    const lastSeg = segments.length ? segments[segments.length - 1].ms : 0;
    return { frames: seq, segments: segments.length, lastMs: Math.max(lastTarget, lastSeg) };
  }

  root.SCF.loomCapture = { runImport, cropToRect };
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

- [ ] **Step 2: Verify**

Run: `npm run verify`
Expected: "all checks passed" (file `node --check`s clean; not yet imported by the worker — that's Task 5).

- [ ] **Step 3: Commit**

```bash
git add src/background/loom-capture.js
git commit -m "feat(loom): service-worker capture module (seek + captureVisibleTab + crop + dedup)"
```

---

### Task 5: Wire the import into the service worker

**Files:**
- Modify: `src/background/service-worker.js` (importScripts list; extract `exportAndArchive`; add `importLoom`; handle `IMPORT_LOOM`)

**Browser-bound** for the import path; the extracted `exportAndArchive` must keep the live stop path identical. Verified by `npm run verify` + manual (a normal recording must still save correctly, and a Loom import must produce a bundle).

**Interfaces:**
- Consumes: `SCF.loomCapture.runImport` (Task 4), `MSG.IMPORT_LOOM`/`IMPORT_PROGRESS` (Task 1).
- Produces: handles `IMPORT_LOOM`, broadcasts `IMPORT_PROGRESS` + `export_done`.

- [ ] **Step 1: Add the new modules to importScripts** — in `src/background/service-worker.js`, change the `importScripts(...)` call to include the two new files (order matters: `loom-timeline` before `loom-capture`, both after `image-hash`/`exporter`/`downloads`):

```js
importScripts(
  '../common/protocol.js',
  '../common/config.js',
  'image-hash.js',
  'session-store.js',
  'exporter.js',
  'loom-timeline.js',
  'capture.js',
  'downloads.js',
  'loom-capture.js'
);
```

- [ ] **Step 2: Extract `exportAndArchive` from `stopRecording`** — add this helper function just **above** `async function stopRecording(opts) {`:

```js
// Shared finalize: build the bundle, write it, copy the clipboard prompt, archive
// the session, and set lastResult. Used by both stopRecording and importLoom.
async function exportAndArchive(events, meta, endedAt) {
  const bundle = self.SCF.exporter.build(events, meta);
  let written = { mdPath: null, folderPath: null, dir: null };
  try {
    written = await self.SCF.downloads.writeSession(bundle, meta.startedAt);
  } catch (e) {
    console.warn('[scf] export failed:', e && e.message);
  }
  setTimeout(() => self.SCF.downloads.setDownloadUi(true), 1500);

  const clip = self.SCF.downloads.clipboardText(written.mdPath, written.dir);
  await ensureOffscreen();
  await sendToOffscreen({ type: MSG.COPY_TO_CLIPBOARD, text: clip });

  const transcriptCount = events.filter((e) => e.type === 'transcript' && e.final).length;

  try {
    const shots = [];
    for (const s of bundle.screenshots) {
      const shot = await store.getScreenshot(s.seq);
      if (shot && shot.blob) shots.push({ seq: s.seq, blob: shot.blob, mime: shot.mime });
    }
    const pages = [];
    const seenPages = new Set();
    for (const e of events) {
      if (e.url && !seenPages.has(e.url)) { seenPages.add(e.url); pages.push({ url: e.url, title: e.title || '' }); }
    }
    await store.archiveSession(
      {
        id: String(meta.startedAt), startedAt: meta.startedAt, endedAt,
        startedAtText: meta.startedAtText, durationMs: endedAt - meta.startedAt,
        pages, screenshotCount: bundle.screenshots.length, transcriptCount,
        mdPath: written.mdPath, folderPath: written.folderPath, dir: written.dir, events,
      },
      shots
    );
  } catch (e) {
    console.warn('[scf] archive failed:', e && e.message);
  }

  lastResult = {
    id: String(meta.startedAt), mdPath: written.mdPath, folderPath: written.folderPath, dir: written.dir,
    clip, screenshots: bundle.screenshots.length, transcriptSegments: transcriptCount, at: endedAt,
  };
  await chrome.storage.local.set({ lastResult });
  return lastResult;
}
```

- [ ] **Step 3: Make `stopRecording` use the helper** — in `stopRecording`, replace the block that starts at `// build + write the bundle` and ends at `await chrome.storage.local.set({ lastResult });` (i.e. the lines from `const events = await store.getEvents();` through the `lastResult = {...}` assignment and its `chrome.storage.local.set`) with:

```js
  // build + write the bundle (shared with the Loom import path)
  const events = await store.getEvents();
  const meta = await store.getMeta();
  await exportAndArchive(events, meta, endedAt);
```

Leave everything after it (`await closeOffscreen();`, `setBadge('idle');`, etc.) unchanged.

- [ ] **Step 4: Add the `importLoom` orchestrator** — add this function just **above** `async function toggleRecording() {`:

```js
let importing = false;

async function importLoom(requestedTabId) {
  if (importing || (session && session.active)) return { error: 'busy' };
  let tab = requestedTabId != null
    ? await chrome.tabs.get(requestedTabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab || !/(^|\.)loom\.com$/i.test(new URL(tab.url || 'about:blank').hostname)) {
    return { error: 'not-a-loom-page' };
  }

  importing = true;
  setBadge('saving');
  const settings = await self.SCF_CONFIG.load();
  await store.reset();
  const startedAt = Date.now();
  const startedAtText = new Date(startedAt).toLocaleString();
  const dir = self.SCF.downloads.sessionDir(startedAt);
  self.SCF.downloads.setDownloadUi(false);
  await store.setMeta({ active: false, startedAt, startedAtText, tabId: tab.id, windowId: tab.windowId, lastUrl: tab.url, lastTitle: tab.title });

  await ensureContentScript(tab.id); // make sure loom-import.js is present
  let res;
  try {
    res = await self.SCF.loomCapture.runImport({
      tabId: tab.id, windowId: tab.windowId, startedAt, settings, dir, store,
      onProgress: (p) => broadcast({ type: MSG.IMPORT_PROGRESS, progress: p }),
    });
  } catch (e) {
    res = { error: (e && e.message) || 'import-failed' };
  }

  if (res && res.error) {
    importing = false;
    setBadge('idle');
    self.SCF.downloads.setDownloadUi(true);
    const human = res.error === 'no-transcript'
      ? 'This Loom video has no transcript to import.'
      : 'Couldn\'t import this Loom video (' + res.error + '). Keep the Loom tab visible and try again.';
    broadcast({ type: MSG.STATUS, state: statePayload(), error: human });
    return { error: res.error };
  }

  const endedAt = startedAt + (res.lastMs || 0);
  await store.patchMeta({ active: false, endedAt });
  const events = await store.getEvents();
  const meta = await store.getMeta();
  await exportAndArchive(events, meta, Math.max(endedAt, meta.startedAt + 1000));
  await closeOffscreen();

  importing = false;
  setBadge('idle');
  broadcastStatus();
  broadcast({ type: 'export_done', result: lastResult });
  return lastResult;
}
```

- [ ] **Step 5: Handle the `IMPORT_LOOM` message** — in the `chrome.runtime.onMessage` switch, add a case after the `MSG.START_RECORDING` case:

```js
    case MSG.IMPORT_LOOM:
      (async () => {
        if (recoverPromise) await recoverPromise;
        const reqTab = sender && sender.tab ? undefined : msg.tabId;
        sendResponse(await importLoom(reqTab));
      })();
      return true;
```

- [ ] **Step 6: Verify**

Run: `node test/run.cjs && npm run verify`
Expected: all PASS; "all checks passed".

- [ ] **Step 7: Manual sanity (flag as human-required)** — load unpacked. (a) Do a **normal** recording (start/talk/stop) and confirm the bundle still writes + clipboard set (regression check on the `exportAndArchive` extraction). (b) On a Loom share page, trigger an import via the SW console: `chrome.runtime.sendMessage({type: SCF.MSG.IMPORT_LOOM})` and confirm a bundle lands in `Downloads/ai-feedback/`. Check the `service worker` console for `[scf]` errors.

- [ ] **Step 8: Commit**

```bash
git add src/background/service-worker.js
git commit -m "feat(loom): wire IMPORT_LOOM into the service worker (shared export/archive helper)"
```

---

### Task 6: Popup — detect Loom + Import button + progress

**Files:**
- Modify: `src/popup/popup.html` (add Import button + progress line)
- Modify: `src/popup/popup.js` (detect Loom share tab; wire `IMPORT_LOOM` + `IMPORT_PROGRESS`)

**Browser-bound.** Verified by `npm run verify` + manual.

**Interfaces:**
- Consumes: `MSG.IMPORT_LOOM`/`IMPORT_PROGRESS` (Task 1), `export_done` broadcast (existing).

- [ ] **Step 1: Add the button + progress to the popup HTML** — in `src/popup/popup.html`, immediately **after** the `<button id="force" ...>` line, add:

```html
      <button id="import-loom" class="secondary" hidden>🎬 Import this Loom video</button>
      <div id="import-progress" class="hint muted" hidden></div>
```

- [ ] **Step 2: Detect a Loom share tab and toggle the button** — in `src/popup/popup.js`, add this helper near the top (after the `const $ = ...` line):

```js
  function isLoomShareUrl(url) {
    try { const u = new URL(url); return /(^|\.)loom\.com$/i.test(u.hostname) && /\/share\//.test(u.pathname); }
    catch (e) { return false; }
  }
  let loomTab = null; // the active tab if it's an importable Loom share page
  async function detectLoom() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      loomTab = tab && isLoomShareUrl(tab.url) ? tab : null;
    } catch (e) { loomTab = null; }
    const btn = $('import-loom');
    if (btn) btn.hidden = !(loomTab && !state.recording && !state.saving);
  }
```

- [ ] **Step 3: Wire the Import button + progress** — in `src/popup/popup.js`, add after the existing `$('force').addEventListener(...)` line:

```js
  $('import-loom').addEventListener('click', async () => {
    if (!loomTab) return;
    lastError = '';
    const btn = $('import-loom');
    btn.disabled = true;
    $('import-progress').hidden = false;
    $('import-progress').textContent = 'Reading transcript…';
    await send({ type: MSG.IMPORT_LOOM, tabId: loomTab.id });
    // export_done (or a STATUS error) will refresh the UI
  });
```

In the `chrome.runtime.onMessage` listener at the bottom, add an `IMPORT_PROGRESS` branch (before the `export_done` branch):

```js
    } else if (msg.type === MSG.IMPORT_PROGRESS) {
      const p = msg.progress || {};
      const el = $('import-progress');
      el.hidden = false;
      el.textContent = p.phase === 'done'
        ? 'Building bundle…'
        : 'Capturing frame ' + ((p.done || 0) + 1) + ' / ' + (p.total || '?') + '…';
```

- [ ] **Step 4: Re-run detection on load + on export done** — in `src/popup/popup.js`, call `detectLoom()` at the end of `load()` (after `loadRecent();`), and inside the `export_done` branch add `$('import-progress').hidden = true; $('import-loom').disabled = false; detectLoom();` after `loadRecent();`.

- [ ] **Step 5: Verify**

Run: `npm run verify`
Expected: "all checks passed".

- [ ] **Step 6: Manual sanity (flag as human-required)** — load unpacked, open a Loom share page, open the popup: the **"🎬 Import this Loom video"** button shows (and is hidden on non-Loom pages). Click it; the progress line counts frames; on completion the "✅ Recording saved" result + clipboard prompt appear, and the bundle is in `Downloads/ai-feedback/`.

- [ ] **Step 7: Commit**

```bash
git add src/popup/popup.html src/popup/popup.js
git commit -m "feat(loom): popup Import button + progress for Loom share pages"
```

---

### Task 7: Docs + version bump

**Files:**
- Modify: `AGENTS.md` (file map), `README.md` (feature mention)
- Modify: `manifest.json` + `package.json` (version, via `npm run bump:minor`)

**Interfaces:** none (docs + release).

- [ ] **Step 1: Update the AGENTS.md file map** — in `AGENTS.md`, in the "Quick file map" table, add rows for the new files. After the `| Capture + dedup | ... |` row add:

```md
| Loom import | `src/content/loom-import.js` (scrape transcript + drive player), `src/background/loom-capture.js` (seek + `captureVisibleTab` + crop), `src/background/loom-timeline.js` (pure target-time math) |
```

- [ ] **Step 2: Mention the feature in README** — in `README.md`, add a short line under the feature/overview section noting: "Import a Loom share video: on a `loom.com/share/...` page, click *Import this Loom video* to turn its transcript + frames into the same `feedback.md` bundle."  (Match the README's existing tone/section; keep it one or two sentences.)

- [ ] **Step 3: Run the full check suite**

Run: `npm test && npm run verify`
Expected: both green.

- [ ] **Step 4: Bump the version** (user-facing feature → minor):

Run: `npm run bump:minor`
Expected: `manifest.json` + `package.json` move from `0.5.0` to `0.6.0` together.

- [ ] **Step 5: Verify version sync**

Run: `npm run verify`
Expected: "version in sync: 0.6.0" + "all checks passed".

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md README.md manifest.json package.json
git commit -m "docs(loom): document Loom import + bump to 0.6.0"
```

---

## Final verification (whole feature)

- [ ] `npm test` green (loom-timeline + exporter frame-label tests included).
- [ ] `npm run verify` green (manifest references resolve; all `.js` `node --check` clean; version in sync).
- [ ] **Human, in Chrome (cannot be unit-tested):** load unpacked → open a Loom share video with a transcript → popup shows "Import this Loom video" → click → frames capture, progress counts → `Downloads/ai-feedback/{ts}/` has `feedback.md` (transcript-anchored frames, sensible `00:09`-style times), `session.json`, and clean cropped `screenshots/`. A video **without** a transcript shows "This Loom video has no transcript to import." A normal live recording still saves correctly (regression). Service-worker console has no `[scf]` errors.

## Notes for the implementer

- The **transcript scrape selectors** (`fromDom`/`openTranscriptTab`) and the **control-overlay hiding** CSS in `loom-import.js` are best-effort against a third-party DOM. If `SCF_LOOM.probe()` returns no segments, or frames show Loom's player controls, tune those against the live page — this is expected and is the main thing a human must verify.
- `captureVisibleTab` only sees the **foreground** tab; the import loop skips a target if capture returns null. That's why the popup tells the user to keep the Loom tab visible.
- Everything downstream of the timeline (`exporter`, `downloads`, archive, history) is unchanged — a Loom import and a live recording produce byte-compatible bundle shapes.
