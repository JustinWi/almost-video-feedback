/*
 * Default settings + storage helpers. Classic script.
 * Used by the service worker (importScripts) and the popup/options pages.
 * The content script does NOT load this; it receives the relevant settings in
 * the SESSION_STARTED payload.
 */
(function (root) {
  'use strict';
  if (root.SCF_CONFIG) return;

  // Bumped when a migration in migrate() below must run once on saved settings.
  const SETTINGS_REV = 2;

  const DEFAULTS = {
    settingsRev: SETTINGS_REV,

    // Transcription
    transcriptEngine: 'webspeech', // swappable; only 'webspeech' wired in v1
    language: 'en-US',

    // Capture format
    captureFormat: 'png', // 'png' | 'jpeg'
    jpegQuality: 90,

    // Dedup (cull-by-diff). Hamming distance over a 64-bit dHash.
    // Lower threshold = stricter "they look the same" = more aggressive culling.
    dedupHammingThreshold: 6,

    // How click screenshots are deduped:
    //   'smart'  - keep if the area *around the click* changed OR the page changed
    //              a lot (catches toggles the coarse dHash misses, culls dead clicks)
    //   'always' - every click captures (never culled)
    //   'global' - treat clicks like other frames (whole-screen dHash dedup)
    clickDedup: 'smart',
    // 'smart' tunables (biased toward keeping — a missed change is worse than an
    // extra frame). The box around a click is small/tight so a toggle dominates it.
    clickRegionRadius: 5, // half-size (in 64x40 thumbnail cells) of the box around a click
    clickLocalChange: 0.02, // >=2% of the local box changed -> keep
    clickGlobalChange: 0.008, // >=0.8% of the whole frame changed -> keep
    clickChangeEps: 16, // 0..255 luminance delta per cell that counts as changed

    // Rate limiting / safety
    minCaptureIntervalMs: 650, // captureVisibleTab is browser-capped ~2/s
    // Per-recording screenshot limit. Reaching it puts a big warning on the page and
    // a line in feedback.md; the recording (and transcript) carries on without pictures.
    maxScreenshots: 1000,

    // Loom import (turning a loom.com/share video into a bundle)
    loomFrameFloorSeconds: 15, // if two transcript timestamps are >this apart, fill the gap with extra frames
    loomSeekSettleMs: 350, // wait after seeking the player before capturing, so the frame has painted

    // Trigger toggles
    triggers: {
      start: true,
      navigation: true,
      route: true,
      click: true,
      selection: true,
      circle: true,
      dwell: true,
      scroll: true,
      heartbeat: true,
    },

    // Trigger tuning
    clickCaptureDelayMs: 150,
    navSettleMs: 500,
    heartbeatSeconds: 30,
    scrollIdleMs: 500,
    scrollMinDeltaPx: 200,
    dwellMs: 400,
    dwellMinMovePx: 120,
    circleMinPathPx: 320, // total path length within the gesture window
    circleRatio: 3.2, // pathLength / boundingBoxDiagonal above this = "circling"

    // UI
    showOverlay: true,
    // clicking the toolbar icon starts a recording immediately (no popup) when idle
    clickStartsRecording: true,

    // Updates. Unpacked installs don't auto-update, so once a day the extension
    // asks GitHub for the latest release tag and prompts when it's newer. The
    // request carries no user data (see README "Privacy"). The URL is a tunable
    // so a test can point the check at a fixture.
    updateCheck: true,
    updateCheckUrl: 'https://api.github.com/repos/JustinWi/almost-video-feedback/releases/latest',

    // On-page drawing while recording: the overlay's ✎ pen toggle (then left-drag), or
    // right-drag / Control+Option+left-drag (the safe combo on a Mac) to draw on the
    // page so you can point at things — the
    // marks land in the screenshots. On by default; turn off here. Drawn in neon pink.
    annotate: true,
    annotateColor: '#ff2d95',
  };

  function deepMerge(base, over) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!over || typeof over !== 'object') return out;
    for (const k of Object.keys(over)) {
      if (
        over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) &&
        base[k] && typeof base[k] === 'object'
      ) {
        out[k] = deepMerge(base[k], over[k]);
      } else {
        out[k] = over[k];
      }
    }
    return out;
  }

  /**
   * One-time upgrades of saved settings. save() stores the whole merged object, so
   * a saved blob pins every default it was saved with — e.g. the old 300-shot cap.
   * Pure: returns {settings, changed}; load() persists when changed.
   */
  function migrate(saved) {
    const s = Object.assign({}, saved || {});
    const rev = s.settingsRev || 1;
    if (rev >= SETTINGS_REV) return { settings: s, changed: false };
    // rev 2 (v0.10.0): the screenshot cap's default went 300 -> 1000. A saved 300 is
    // almost always the old default riding along, not a choice — raise it once.
    if (rev < 2 && s.maxScreenshots === 300) s.maxScreenshots = 1000;
    s.settingsRev = SETTINGS_REV;
    return { settings: s, changed: true };
  }

  async function load() {
    const got = await chrome.storage.local.get('settings');
    const saved = got.settings || {};
    if (Object.keys(saved).length) {
      const m = migrate(saved);
      if (m.changed) {
        await chrome.storage.local.set({ settings: m.settings });
        return deepMerge(DEFAULTS, m.settings);
      }
    }
    return deepMerge(DEFAULTS, saved);
  }

  async function save(partial) {
    const current = await load();
    const merged = deepMerge(current, partial);
    await chrome.storage.local.set({ settings: merged });
    return merged;
  }

  async function reset() {
    await chrome.storage.local.set({ settings: {} });
    return deepMerge(DEFAULTS, {});
  }

  root.SCF_CONFIG = { DEFAULTS, SETTINGS_REV, load, save, reset, deepMerge, migrate };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SCF_CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : self);
