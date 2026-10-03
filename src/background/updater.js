/*
 * Daily update check + prompt. Loaded into the service worker via importScripts.
 *
 * Unpacked installs never auto-update, so once a day (chrome.alarms, plus a
 * catch-up on browser start for alarms missed while Chrome was closed) this
 * fetches GitHub's "latest release" for the repo and, when it's newer than the
 * running version, prompts: toolbar badge (only while idle — never over the
 * recording/paused badge), one Chrome notification per new version (not a daily
 * nag), and a banner in the popup. All prompts lead to src/update/update.html,
 * which walks through the update and ends in chrome.runtime.reload().
 *
 * PRIVACY: the check is a single unauthenticated GET of
 * https://api.github.com/repos/.../releases/latest. It carries no user data —
 * no page URLs, no recordings, no identifiers; it can be turned off in
 * Settings → Updates. Decision logic is pure + tested in common/update-check.js.
 *
 * Manual test without publishing a release (service-worker console):
 *   SCF.updater.simulate('9.9.9')  // fakes "newer available": badge + notification + banner
 *   SCF.updater.clear()            // back to normal
 */
(function (root) {
  'use strict';
  const LIB = root.SCF.updateCheck;
  const ALARM = 'update-check';
  const STORE_KEY = 'updateState'; // { available, lastCheckAt, lastNotifiedVersion }
  const CHECK_EVERY_MIN = 24 * 60;
  // run a catch-up check on SW boot when the last one is older than this
  // (the daily alarm can't fire while the browser is closed)
  const BOOT_CATCHUP_MS = 20 * 60 * 60 * 1000;
  const FALLBACK_ZIP =
    'https://github.com/JustinWi/almost-video-feedback/releases/latest/download/almost-video-feedback.zip';
  const NOTIF_ID = 'scf-update';

  let available = null; // in-memory mirror so setBadge() can read it synchronously
  let onChange = () => {};

  const current = () => chrome.runtime.getManifest().version;

  async function getStore() {
    const got = await chrome.storage.local.get(STORE_KEY);
    return got[STORE_KEY] || {};
  }
  async function patchStore(patch) {
    const next = Object.assign({}, await getStore(), patch);
    await chrome.storage.local.set({ [STORE_KEY]: next });
    return next;
  }

  async function init(opts) {
    if (opts && opts.onChange) onChange = opts.onChange;
    try {
      const st = await getStore();
      if (st.available && !LIB.isNewer(st.available.version, current())) {
        // we're now running the version we prompted about — clear the prompt
        // and confirm once (only if the user actually saw an "available" nudge)
        const done = st.available.version;
        await patchStore({ available: null });
        available = null;
        if (st.lastNotifiedVersion === done) {
          notify('Updated to v' + current() + ' ✓', "You're on the latest version.");
        }
      } else {
        available = st.available || null;
      }
      onChange();
      // create the daily alarm only if absent — re-creating on every SW wake
      // would reset the countdown each time and it would never fire
      chrome.alarms.get(ALARM, (a) => {
        if (!a) chrome.alarms.create(ALARM, { periodInMinutes: CHECK_EVERY_MIN, delayInMinutes: 2 });
      });
      if (LIB.checkDue(Date.now(), st.lastCheckAt, BOOT_CATCHUP_MS)) check(false);
    } catch (e) {
      console.warn('[scf] updater init failed:', e && e.message);
    }
  }

  async function check(force) {
    try {
      const settings = await root.SCF_CONFIG.load();
      if (!force && settings.updateCheck === false) return state();
      const url = settings.updateCheckUrl || root.SCF_CONFIG.DEFAULTS.updateCheckUrl;
      const res = await fetch(url, { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const info = LIB.parseReleaseInfo(await res.json(), FALLBACK_ZIP);
      await setAvailable(LIB.decideUpdate(info, current()));
    } catch (e) {
      // offline / rate-limited / bad fixture: stay quiet, try again next cycle
      console.warn('[scf] update check failed:', e && e.message);
      await patchStore({ lastCheckAt: Date.now() });
    }
    return state();
  }

  async function setAvailable(upd) {
    const st = await patchStore({ available: upd, lastCheckAt: Date.now() });
    available = upd;
    onChange();
    if (upd && st.lastNotifiedVersion !== upd.version) {
      await patchStore({ lastNotifiedVersion: upd.version });
      notify(
        'Almost Video Feedback v' + upd.version + ' is out',
        'Click to update — it takes about a minute. (You have v' + current() + '.)'
      );
    }
  }

  function notify(title, message) {
    try {
      chrome.notifications.create(NOTIF_ID, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title,
        message,
        priority: 1,
      });
    } catch (e) {
      /* notifications unavailable — badge + popup banner still prompt */
    }
  }

  function openUpdatePage() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/update/update.html') });
  }

  chrome.notifications.onClicked.addListener((id) => {
    if (id !== NOTIF_ID) return;
    chrome.notifications.clear(id);
    if (available) openUpdatePage();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) check(false);
  });

  function state() {
    return { current: current(), available };
  }

  // dev helpers for the service-worker console (see header)
  async function simulate(version) {
    await setAvailable({
      version: version || '9.9.9',
      zipUrl: FALLBACK_ZIP,
      pageUrl: 'https://github.com/JustinWi/almost-video-feedback/releases/latest',
    });
    return state();
  }
  async function clear() {
    await patchStore({ available: null, lastNotifiedVersion: null });
    available = null;
    onChange();
    return state();
  }

  root.SCF.updater = {
    init,
    check,
    state,
    simulate,
    clear,
    openUpdatePage,
    availableNow: () => available,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
