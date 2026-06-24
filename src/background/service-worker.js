/*
 * Orchestrator service worker (classic; loads helpers via importScripts).
 *
 * Owns the session state machine, routes messages between popup / content /
 * offscreen, drives navigation + heartbeat captures, the hotkeys, the toolbar
 * badge, and the final export + clipboard hand-off.
 */
importScripts(
  '../common/protocol.js',
  '../common/config.js',
  'image-hash.js',
  'session-store.js',
  'exporter.js',
  'capture.js',
  'downloads.js'
);

const { MSG, TRIGGER } = self.SCF;
const store = self.SCF.sessionStore;
const capture = self.SCF.capture;

// In-memory session (mirrors the durable meta in IndexedDB).
let session = null; // { active, startedAt, startedAtText, tabId, windowId, settings }
let lastResult = null;
let creatingOffscreen = null;
// Stays true through the post-stop flush window so the final spoken segment
// (which arrives a few hundred ms after we stop recognition) is still recorded.
let transcriptOpen = false;
let stopping = false; // true while a stop is saving/exporting (popup shows "Saving…")
let starting = false; // true between a start request and session becoming active (debounces icon double-clicks)
let recoverPromise = null; // resolves once mid-session state has been restored

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- utilities

function capturable(url) {
  if (!url) return false;
  return !/^(chrome|edge|about|view-source|chrome-extension|devtools|moz-extension):/i.test(url) &&
    !/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url);
}

function setBadge(mode) {
  if (mode === 'recording') {
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#e11d48' });
    chrome.action.setTitle({ title: 'Recording feedback — click to stop' });
  } else if (mode === 'saving') {
    chrome.action.setBadgeText({ text: '…' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    chrome.action.setTitle({ title: 'Saving feedback…' });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Almost Video Feedback' });
  }
}

function notifyContent(tabId, msg) {
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
  } catch (e) {
    /* no receiver */
  }
}

function broadcast(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch (e) {
    /* no receiver */
  }
}

async function sendToOffscreen(msg) {
  try {
    return await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
  } catch (e) {
    return null; // offscreen not present
  }
}

function statePayload() {
  return {
    recording: !!(session && session.active),
    saving: stopping,
    startedAt: session ? session.startedAt : null,
    screenshots: capture.getSeq(),
    tabId: session ? session.tabId : null,
    lastResult,
  };
}

function openPopup() {
  try {
    if (chrome.action.openPopup) chrome.action.openPopup().catch(() => {});
  } catch (e) {
    /* not available / no focused window */
  }
}

// Click-to-record: when the setting is on and we're idle, clear the action popup
// so a click fires chrome.action.onClicked (which starts recording immediately).
// While recording (or when the setting is off) the popup is restored, so a click
// opens it as usual.
async function applyActionMode() {
  let clickStarts = true;
  try {
    const s = await self.SCF_CONFIG.load();
    clickStarts = s.clickStartsRecording !== false;
  } catch (e) {
    /* default true */
  }
  const recording = !!(session && session.active);
  const popup = clickStarts && !recording ? '' : 'src/popup/popup.html';
  try {
    await chrome.action.setPopup({ popup });
  } catch (e) {
    /* ignore */
  }
}

function broadcastStatus() {
  broadcast({ type: MSG.STATUS, state: statePayload() });
}

// --------------------------------------------------------------- offscreen

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy the feedback file path to the clipboard when a recording is saved.',
    })
    .catch((e) => {
      // someone else created it in the meantime — that's fine
      if (!/single offscreen/i.test(e.message || '')) console.warn('[scf] offscreen create:', e.message);
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (e) {
      /* already closed */
    }
  }
}

// Inject the content script for tabs that were already open before the extension
// loaded (manifest injection only covers tabs navigated after install). The
// content files guard against double-initialization, so this is idempotent.
// The file list comes straight from the manifest so the two can never drift.
function contentScriptFiles() {
  const cs = (chrome.runtime.getManifest().content_scripts || [])[0];
  return (cs && cs.js) || [];
}
async function ensureContentScript(tabId) {
  const files = contentScriptFiles();
  if (!files.length) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch (e) {
    /* restricted page or already present */
  }
}

// ------------------------------------------------------------ session flow

async function startRecording(requestedTabId) {
  if (starting || (session && session.active)) return statePayload();
  starting = true;

  let tab;
  if (requestedTabId != null) {
    tab = await chrome.tabs.get(requestedTabId).catch(() => null);
  } else {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs[0];
  }
  if (!tab || !capturable(tab.url)) {
    starting = false;
    broadcast({ type: MSG.STATUS, state: statePayload(), error: 'This page can\'t be recorded (try a normal http/https tab).' });
    return statePayload();
  }

  const settings = await self.SCF_CONFIG.load();
  await store.reset();
  const startedAt = Date.now();
  const startedAtText = new Date(startedAt).toLocaleString();

  session = {
    active: true,
    startedAt,
    startedAtText,
    tabId: tab.id,
    windowId: tab.windowId,
    settings,
  };
  starting = false; // session.active now guards re-entry; don't leave this stuck if a later await throws
  await store.setMeta({
    active: true,
    startedAt,
    startedAtText,
    tabId: tab.id,
    windowId: tab.windowId,
    lastUrl: tab.url,
    lastTitle: tab.title,
  });

  capture.begin({ windowId: tab.windowId, tabId: tab.id, settings, lastUrl: tab.url, lastTitle: tab.title, startedAt });
  capture.hooks.onKept = () => broadcastStatus();
  transcriptOpen = true;

  // Screenshots are written to Downloads during the recording (so stop is fast);
  // hide the download shelf for the whole session so it doesn't pop up repeatedly.
  self.SCF.downloads.setDownloadUi(false);

  setBadge('recording');
  applyActionMode(); // recording -> icon click opens the popup (which stops)
  ensureOffscreen(); // pre-warm the clipboard doc so the save is instant (no await)

  if (settings.triggers.heartbeat) {
    chrome.alarms.create('heartbeat', { periodInMinutes: Math.max(0.5, settings.heartbeatSeconds / 60) });
  }

  // Arm the (usually already-injected) content script immediately so the overlay
  // appears instantly; inject in the background for tabs that predate the
  // extension (their CONTENT_READY re-arms them). Don't block start on injection.
  notifyContent(tab.id, { type: MSG.SESSION_STARTED, settings, startedAt });
  ensureContentScript(tab.id);

  if (settings.triggers.start) {
    capture.request(TRIGGER.START, { url: tab.url, title: tab.title });
  }

  broadcastStatus();
  return statePayload();
}

async function stopRecording(opts) {
  if (!session || !session.active) return lastResult || statePayload();
  const openMenu = !opts || opts.openMenu !== false;

  const s = session;
  s.active = false;
  stopping = true;
  setBadge('saving');
  // pop the menu open so the user sees it saving + the result + recent list
  // (skip when the stop came from the already-open popup)
  if (openMenu) openPopup();
  broadcastStatus();
  chrome.alarms.clear('heartbeat');
  capture.end();

  // Ask the recognizer iframe to flush its final segment (transcriptOpen keeps
  // handleTranscript writing it), then tear down the overlay + iframe.
  broadcast({ type: MSG.RECOGNIZER_STOP });
  await delay(500);
  transcriptOpen = false;
  notifyContent(s.tabId, { type: MSG.SESSION_STOPPED });

  const endedAt = Date.now();
  await store.patchMeta({ active: false, endedAt });

  // build + write the bundle
  const events = await store.getEvents();
  const meta = await store.getMeta();
  const bundle = self.SCF.exporter.build(events, meta);
  let written = { mdPath: null, folderPath: null };
  try {
    written = await self.SCF.downloads.writeSession(bundle, meta.startedAt);
  } catch (e) {
    console.warn('[scf] export failed:', e && e.message);
  }
  // restore the download shelf shortly after (let the md/json writes settle)
  setTimeout(() => self.SCF.downloads.setDownloadUi(true), 1500);

  const clip = self.SCF.downloads.clipboardText(written.mdPath, written.dir);
  await ensureOffscreen(); // offscreen is only needed here, for the clipboard write
  await sendToOffscreen({ type: MSG.COPY_TO_CLIPBOARD, text: clip });

  const transcriptCount = events.filter((e) => e.type === 'transcript' && e.final).length;

  // archive the session for the recordings library (persists across sessions;
  // reset() on the next start only clears the live stores, not history)
  try {
    const shots = [];
    for (const s of bundle.screenshots) {
      const shot = await store.getScreenshot(s.seq);
      if (shot && shot.blob) shots.push({ seq: s.seq, blob: shot.blob, mime: shot.mime });
    }
    const pages = [];
    const seenPages = new Set();
    for (const e of events) {
      if (e.url && !seenPages.has(e.url)) {
        seenPages.add(e.url);
        pages.push({ url: e.url, title: e.title || '' });
      }
    }
    await store.archiveSession(
      {
        id: String(meta.startedAt),
        startedAt: meta.startedAt,
        endedAt,
        startedAtText: meta.startedAtText,
        durationMs: endedAt - meta.startedAt,
        pages,
        screenshotCount: bundle.screenshots.length,
        transcriptCount,
        mdPath: written.mdPath,
        folderPath: written.folderPath,
        dir: written.dir,
        events,
      },
      shots
    );
  } catch (e) {
    console.warn('[scf] archive failed:', e && e.message);
  }

  lastResult = {
    mdPath: written.mdPath,
    folderPath: written.folderPath,
    clip,
    screenshots: bundle.screenshots.length,
    transcriptSegments: transcriptCount,
    at: endedAt,
  };
  await chrome.storage.local.set({ lastResult });

  await closeOffscreen();
  setBadge('idle');
  session = null;
  stopping = false;
  applyActionMode(); // idle -> clicking the icon starts the next recording

  // in-page toast so the user knows it's ready even if the popup didn't open /
  // the extension isn't pinned
  notifyContent(s.tabId, { type: MSG.SAVED_NOTICE });

  broadcastStatus();
  broadcast({ type: 'export_done', result: lastResult });
  return lastResult;
}

async function toggleRecording() {
  if (session && session.active) return stopRecording();
  return startRecording();
}

// ------------------------------------------------------------- nav + alarms

chrome.webNavigation.onCompleted.addListener((d) => {
  if (!session || !session.active) return;
  if (d.tabId !== session.tabId || d.frameId !== 0) return;
  capture.setContext({ lastUrl: d.url });
  store.patchMeta({ lastUrl: d.url }).catch(() => {});
  setTimeout(() => {
    chrome.tabs.get(session.tabId, (tab) => {
      const title = tab && tab.title;
      if (title) {
        capture.setContext({ lastTitle: title });
        store.patchMeta({ lastTitle: title }).catch(() => {});
      }
      store.addEvent({ t: Date.now(), type: 'navigation', url: d.url, title: title || null });
      capture.request(TRIGGER.NAVIGATION, { url: d.url, title: title || null });
    });
  }, (session.settings && session.settings.navSettleMs) || 500);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat' && session && session.active) {
    capture.request(TRIGGER.HEARTBEAT, {});
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-recording') toggleRecording();
  else if (command === 'force-screenshot' && session && session.active) {
    capture.request(TRIGGER.FORCED, {});
  }
});

// ------------------------------------------------------ follow focus
// During a session, move the recording (overlay, input tracking, recognizer,
// captures) to whatever tab/window the user focuses, so reviewing a multi-tab
// flow is captured continuously.
let followTimer = null;
function scheduleFollowFocus() {
  if (!session || !session.active) return;
  clearTimeout(followTimer);
  followTimer = setTimeout(followFocus, 250);
}

async function followFocus() {
  if (!session || !session.active) return;
  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs[0];
  } catch (e) {
    return;
  }
  if (!tab || tab.id === session.tabId) return; // already recording this tab
  if (!capturable(tab.url)) return; // ignore chrome:// etc. — keep the previous tab

  const oldTabId = session.tabId;
  session.tabId = tab.id;
  session.windowId = tab.windowId;
  capture.setContext({ tabId: tab.id, windowId: tab.windowId, lastUrl: tab.url, lastTitle: tab.title });
  store.patchMeta({ tabId: tab.id, windowId: tab.windowId, lastUrl: tab.url, lastTitle: tab.title }).catch(() => {});

  // tear down the overlay/recognizer on the old tab, arm the newly-focused one
  notifyContent(oldTabId, { type: MSG.SESSION_STOPPED });
  await ensureContentScript(tab.id);
  notifyContent(tab.id, { type: MSG.SESSION_STARTED, settings: session.settings, startedAt: session.startedAt });

  // capture the newly-focused view + record the page change
  store.addEvent({ t: Date.now(), type: 'navigation', url: tab.url, title: tab.title || null });
  capture.request(TRIGGER.NAVIGATION, { url: tab.url, title: tab.title || null });
}

chrome.tabs.onActivated.addListener(scheduleFollowFocus);
chrome.windows.onFocusChanged.addListener((winId) => {
  if (winId !== chrome.windows.WINDOW_ID_NONE) scheduleFollowFocus();
});

// click-to-record: only fires when the popup is empty (fast mode + idle)
chrome.action.onClicked.addListener(async () => {
  if (recoverPromise) await recoverPromise;
  if (!(session && session.active)) startRecording();
});

// re-apply the action mode when the setting changes from the options page
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) applyActionMode();
});

// --------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case MSG.GET_STATE:
      (async () => {
        if (recoverPromise) await recoverPromise; // accurate state after a SW restart
        if (!lastResult) {
          const got = await chrome.storage.local.get('lastResult');
          lastResult = got.lastResult || null;
        }
        sendResponse(statePayload());
      })();
      return true;

    case MSG.START_RECORDING:
      (async () => {
        if (recoverPromise) await recoverPromise;
        // only first-party extension pages (no sender.tab) may target a tab id;
        // a content script can't ask the SW to record an arbitrary tab
        const reqTab = sender && sender.tab ? undefined : msg.tabId;
        sendResponse(await startRecording(reqTab));
      })();
      return true;

    case MSG.STOP_RECORDING:
      // open the menu only when the stop came from the page overlay (not the
      // already-open popup, which has no sender.tab)
      (async () => {
        if (recoverPromise) await recoverPromise;
        sendResponse(await stopRecording({ openMenu: !!(sender && sender.tab) }));
      })();
      return true;

    case MSG.COPY_LAST:
      (async () => {
        if (!lastResult) {
          const got = await chrome.storage.local.get('lastResult');
          lastResult = got.lastResult || null;
        }
        if (lastResult && lastResult.clip) {
          await ensureOffscreen();
          await sendToOffscreen({ type: MSG.COPY_TO_CLIPBOARD, text: lastResult.clip });
          if (!(session && session.active)) await closeOffscreen();
        }
        sendResponse(lastResult);
      })();
      return true;

    case MSG.FORCE_SHOT:
      if (session && session.active) capture.request(TRIGGER.FORCED, {});
      return false;

    // ---- from content scripts ----
    case MSG.CONTENT_READY:
      if (session && session.active && sender.tab && sender.tab.id === session.tabId) {
        notifyContent(session.tabId, {
          type: MSG.SESSION_STARTED,
          settings: session.settings,
          startedAt: session.startedAt,
        });
      }
      return false;

    case MSG.REQUEST_CAPTURE:
      if (session && session.active && sender.tab && sender.tab.id === session.tabId) {
        capture.request(msg.trigger, msg.meta || {});
      }
      return false;

    case MSG.PAGE_INFO:
    case MSG.ROUTE_CHANGED:
      if (session && session.active && sender.tab && sender.tab.id === session.tabId) {
        capture.setContext({ lastUrl: msg.url, lastTitle: msg.title });
        store.patchMeta({ lastUrl: msg.url, lastTitle: msg.title }).catch(() => {});
        if (msg.type === MSG.ROUTE_CHANGED) {
          store.addEvent({ t: Date.now(), type: 'navigation', url: msg.url, title: msg.title || null });
        }
      }
      return false;

    // ---- transcription from the content script ----
    case MSG.TRANSCRIPT_SEGMENT:
      // gate on transcriptOpen (not session.active) so the final segment that
      // flushes in during the post-stop window is still recorded
      if (transcriptOpen && session && sender.tab && sender.tab.id === session.tabId) {
        handleTranscript(msg);
      }
      return false;

    // ---- from offscreen ----
    case MSG.OFFSCREEN_READY:
      return false;

    case MSG.TRANSCRIBE_ERROR:
      handleTranscribeError(msg);
      return false;

    case MSG.KEEPALIVE:
      return false;

    default:
      return false;
  }
});

function handleTranscript(msg) {
  // transcription comes from the recognizer iframe; store finalized segments
  // through the post-stop flush window, and forward everything to the overlay.
  const t = msg.t || Date.now();
  if (msg.final && transcriptOpen) {
    store.addEvent({ t, type: 'transcript', final: true, text: msg.text });
  }
  if (session && session.active) {
    notifyContent(session.tabId, { type: MSG.TRANSCRIPT_UPDATE, final: !!msg.final, text: msg.text });
  }
}

function handleTranscribeError(msg) {
  const err = (msg.error || '').toLowerCase();
  console.warn('[scf] transcribe error:', msg.error);
  if (err.includes('not-allowed') || err.includes('service-not-allowed')) {
    if (session && session.active) notifyContent(session.tabId, { type: MSG.TRANSCRIPT_UPDATE, micError: true });
    broadcast({
      type: MSG.STATUS,
      state: statePayload(),
      error: 'Microphone was blocked. Allow it for the extension (toolbar popup), then restart recording.',
    });
  }
}

// ---- keepalive port from offscreen keeps the SW alive during long silences ----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    port.onMessage.addListener(() => {});
    port.onDisconnect.addListener(() => void chrome.runtime.lastError);
  }
});

// ------------------------------------------------------------- recovery

async function recover() {
  try {
    const meta = await store.getMeta();
    if (meta && meta.active) {
      const settings = await self.SCF_CONFIG.load();
      session = {
        active: true,
        startedAt: meta.startedAt,
        startedAtText: meta.startedAtText,
        tabId: meta.tabId,
        windowId: meta.windowId,
        settings,
      };
      capture.restore(
        { windowId: meta.windowId, tabId: meta.tabId, settings, lastUrl: meta.lastUrl, lastTitle: meta.lastTitle, startedAt: meta.startedAt },
        meta.lastSeq || 0,
        meta.lastKeptHash || null
      );
      capture.hooks.onKept = () => broadcastStatus();
      transcriptOpen = true;
      self.SCF.downloads.setDownloadUi(false);
      setBadge('recording');
      if (settings.triggers.heartbeat) {
        chrome.alarms.create('heartbeat', { periodInMinutes: Math.max(0.5, settings.heartbeatSeconds / 60) });
      }
      // the content script is still running in the tab and kept its recognition
      // going across the SW restart; nothing else to restart here.
    } else {
      // no active session — make sure the download shelf isn't left suppressed
      // from a prior recording that was abandoned without a clean stop
      self.SCF.downloads.setDownloadUi(true);
    }
  } catch (e) {
    console.warn('[scf] recover failed:', e && e.message);
  }
}

chrome.runtime.onStartup.addListener(() => {
  recoverPromise = recover();
  recoverPromise.then(applyActionMode);
});
chrome.runtime.onInstalled.addListener(() => {
  setBadge('idle');
  applyActionMode();
});
recoverPromise = recover();
recoverPromise.then(applyActionMode);
