# Loom Video Import — Design Spec

**Date:** 2026-06-27
**Status:** Approved by user → ready to plan.

## 1. Purpose

Today **Almost Video Feedback** records spoken + visual feedback *live* on a web app and emits a
bundle (`feedback.md` + `session.json` + screenshots) for an AI coding agent. This feature adds a
**second source for that same bundle**: an existing **Loom** share video that already has a
transcript.

When the user is on a `loom.com/share/...` page, they can click **"Import this Loom video"**. The
extension:

1. Reads the Loom **transcript** (text + per-segment timing) from the page.
2. **Seeks the Loom player** to a set of target timestamps and captures a **clean, cropped frame**
   of the video at each.
3. Builds the **same** timeline of `transcript` + `screenshot` events the live recorder produces.
4. Runs the existing `exporter.build(...)` and `downloads.writeSession(...)` to write an identical
   bundle to `Downloads/ai-feedback/{timestamp}/`, and copies the same clipboard prompt.

The result: a Loom review video becomes an Almost Video Feedback session with no re-recording.

### Out of scope (YAGNI)

- Non-Loom sites / arbitrary `<video>` + transcript. Loom only for v1.
- Importing from a Loom URL while *not* on the page (no "paste a URL" flow). Must be on the open
  Loom tab so we can drive its real player. (Earlier considered; dropped for v1.)
- Audio re-transcription. We use Loom's existing transcript; we never run speech recognition here.
- DRM / download of the underlying video file.

## 2. Why this approach (the two load-bearing decisions)

### 2a. Clean frames via `captureVisibleTab` + crop — NOT canvas pixel-read

Reading the `<video>` element's pixels onto a canvas is the obvious way to get "clean frames" and
the **wrong** one: Loom's video is cross-origin (their CDN) and was created by Loom's player, so
`drawImage(video)` **taints** the canvas and `toDataURL()`/`getImageData()` throw `SecurityError`.
We can't add `crossorigin` after the fact, and modern Loom streams via HLS/MediaSource (`blob:`
src), so we can't re-open a clean element either.

Instead we reuse `chrome.tabs.captureVisibleTab` (already the extension's capture path). It captures
the **rendered compositor output**, so it sees cross-origin video pixels fine — it is a privileged
screenshot, not a DOM canvas read. The content script reports the video's `getBoundingClientRect()`;
the service worker **crops** the full-tab PNG to that rect (scaled by `devicePixelRatio`) in an
`OffscreenCanvas` (already used for dedup hashing). → Clean, video-only frames, no taint risk, reuse
of the proven path.

**Consequences / caveats (must verify against the live Loom DOM during implementation):**
- Loom paints a **player control overlay** (play button, scrubber) over a paused video. Before each
  capture we inject CSS to hide it; selectors are Loom-specific and brittle. If hiding fails we still
  produce a frame — just with controls visible. Graceful fallback: if the video rect can't be
  resolved, capture the **full tab** un-cropped.
- `captureVisibleTab` only sees the **foreground/active** tab. Import runs while the Loom tab is
  visible; the user must not switch tabs mid-import. This is acceptable for a short review video and
  is surfaced in the progress UI.

### 2b. Cadence: transcript-anchored + t=0 + periodic floor; dedup culls the rest

Frames are anchored **one per transcript segment** (each segment's start time), so screenshots go
hand-in-hand with speech and map 1:1 onto the exporter's existing transcript→nearest-screenshot
association (dt≈0). On top of that backbone:

- **Always a frame at t=0** (opening state, even if the first transcript segment starts later).
- **Periodic floor:** when two consecutive transcript timestamps are more than
  `loomFrameFloorSeconds` (default **15s**) apart, inject intermediate target time(s) so long
  static-transcript stretches with on-screen motion aren't under-covered.
- **Over-capture is self-correcting:** choppy/fast transcripts that yield many near-identical frames
  are culled by the existing dHash + Hamming dedup. No new dedup logic.

If the video has **no transcript** (transcription disabled or still processing), we stop with a clear
message — the feature is transcript-anchored and has nothing to anchor to.

## 3. Components & changes

| Area | File | Change |
|---|---|---|
| Protocol | `src/common/protocol.js` | Add message constants: `IMPORT_LOOM` (popup→SW), `LOOM_PROBE` / `LOOM_PROBE_RESULT` (SW↔content: "is this an importable Loom page + transcript + video rect"), `LOOM_SEEK` (SW→content: seek player to ms, hide controls, report rect), `LOOM_SEEK_DONE` (content→SW), `IMPORT_PROGRESS` (SW→popup). |
| Config | `src/common/config.js` | Add `loomFrameFloorSeconds: 15`, `loomSeekSettleMs` (wait after seek before capture, default ~350), `loomMaxFrames` (reuse `maxScreenshots` cap = 300). |
| **New** content module | `src/content/loom-import.js` | Loom-page logic (classic, attaches to `globalThis.SCF_LOOM`): detect Loom share page; open + scrape the transcript panel into `[{ms, text}]`; locate the `<video>`; on `LOOM_SEEK` mute+pause+seek the player, hide control overlay, wait for paint, report `getBoundingClientRect()`. Added to the top-frame `content_scripts` entry in `manifest.json`. |
| **New** pure module | `src/background/loom-timeline.js` | Pure, dual-exported + unit-tested. `buildTargets(segments, opts)` → sorted list of target frame times (t=0 + per-segment + floor-fill) and the transcript-event list. No chrome/DOM. |
| Orchestration | `src/background/service-worker.js` | `IMPORT_LOOM` handler: probe page → scrape transcript → compute targets via `loom-timeline` → for each target: `LOOM_SEEK`, then `captureVisibleTab`, crop to rect, dedup, store as a `screenshot` event (`trigger: 'frame'`, `url`=share URL, `title`=video title) → push transcript events → `exporter.build` → `downloads.writeSession` → clipboard. Emits `IMPORT_PROGRESS`. Reuses the existing session-store + downloads + archive path. |
| Capture/crop | `src/background/capture.js` (or a small helper) | Add a crop step: given a full-tab dataURL + a CSS rect + dpr, return a cropped blob via `OffscreenCanvas`. Reuse existing blob/store plumbing. |
| Exporter | `src/background/exporter.js` | Add `frame: '🎞️ Video frame'` to `TRIGGER_LABEL`. Optionally add an "Imported from Loom: <url>" line to the header (format otherwise unchanged — AGENTS.md rule 7). Update exporter tests for the new label. |
| Popup | `src/popup/popup.js` / `.html` | When the active tab is a `loom.com/share/...` page (and a probe says it's importable), show **"Import this Loom video"** as the primary action; **"Start recording"** remains available below. Show import progress ("Capturing frame 4/12…") and the final saved path. |

## 4. Data flow

```
Popup (on loom.com/share) — primary button → MSG.IMPORT_LOOM
  ↓
Service worker:
  1. LOOM_PROBE → content(loom-import): transcript present? video present?  → LOOM_PROBE_RESULT
  2. scrape transcript → segments[] = [{ms, text}]
  3. targets[] = loomTimeline.buildTargets(segments, {floorSeconds, maxFrames})   // t=0 + per-seg + floor
  4. for each target ms:
        LOOM_SEEK(ms) → content: mute+pause+seek, hide controls, settle, report rect → LOOM_SEEK_DONE
        captureVisibleTab → crop to rect(dpr) → dedup(dHash) → store screenshot event (trigger:'frame')
        emit IMPORT_PROGRESS(i/total)
  5. push transcript events (final:true) at their ms
  6. events = store.getEvents()
  7. exporter.build(events, meta{startedAtText, source:'loom', loomUrl, title})
  8. downloads.writeSession(bundle) → feedback.md + session.json + screenshots/
  9. clipboard prompt with absolute feedback.md path; archive session
  ↓
Popup shows saved path (same as a live session).
```

Event shapes are **identical** to the live recorder, so `exporter.build` and everything downstream
are unchanged in behavior. Timeline `t` values are `importStartedAt + segment.ms` (monotonic), so
relative times in `feedback.md` read as `00:09`, `00:43`, … exactly like a live session.

## 5. Error handling

- **Not a Loom share page / probe fails:** popup simply shows the normal "Start recording" primary;
  no import button. No error.
- **No transcript:** abort with a visible message ("This Loom video has no transcript to import").
- **Video element not found / rect unresolved:** fall back to full-tab capture (un-cropped) and warn
  once; continue so the user still gets a bundle.
- **`captureVisibleTab` fails (tab not foreground):** surface "Keep the Loom tab visible during
  import" and stop cleanly; partial frames already stored are discarded (no half-bundle written).
- **Seek/paint race:** fixed settle delay (`loomSeekSettleMs`) plus a 2-rAF wait in the content
  script before reporting ready; if a frame never paints, skip that target and continue.
- **Long video:** capped at `maxScreenshots` (300); if exceeded, stop adding frames and note the cap
  in progress + a line in `feedback.md`.

## 6. Testing

**Unit (pure, `test/run.cjs`):**
- `loom-timeline.buildTargets`: t=0 always present; one target per segment; floor-fills gaps >
  `floorSeconds`; respects `maxFrames`; sorted + de-duplicated times; empty-segments → just t=0 (or
  abort path handled by caller).
- `exporter`: new `frame` trigger label renders; existing snapshot/format tests still pass.

**Manual (browser-bound — flag as needing a human; cannot be proven by unit tests):**
1. Load unpacked; open a real `loom.com/share/...` video **with** a transcript.
2. Popup shows "Import this Loom video"; click it.
3. Transcript tab opens/loads; frames capture as the player seeks; progress counts up.
4. `Downloads/ai-feedback/{ts}/` has `feedback.md` (transcript-anchored frames, sensible relative
   times), `session.json`, and clean **cropped** `screenshots/` (no/minimal Loom chrome).
5. Open a Loom video **without** a transcript → clear "no transcript" message, no bundle.
6. Service worker console (`chrome://extensions`) has no `[scf]` errors.

## 7. Definition of done (per AGENTS.md)

- `npm test` + `npm run verify` green (new `loom-timeline` tests added; manifest references resolve).
- No new runtime dep / build step; no `import`/`export` in worker or content scripts
  (`loom-import.js` attaches to `globalThis`; `loom-timeline.js` dual-exports).
- New messages via `protocol.js`; new tunables via `config.js` (+ options control if user-facing).
- Pure logic (`loom-timeline.js`) has tests.
- Docs updated (README/AGENTS file map) for the new source + files.
- Manually loaded in Chrome and sanity-checked, **or explicitly flagged as needing a human** for the
  Loom-DOM-dependent parts (transcript scrape selectors, control-overlay hiding, crop fidelity).
- Version bump (`npm run bump:minor`) — user-facing feature.
```
