/*
 * Guided update page. Opened from the update notification, the popup banner,
 * or the options page. Asks the service worker what the update needs:
 *   - the extension folder already holds the new version (git pull / files copied)
 *     -> one "Update now" button (chrome.runtime.reload());
 *   - the folder still has the old files -> download the zip, copy it over, reload.
 * While the files still need replacing it re-checks the folder every few seconds,
 * so after a git pull or copy-over the page switches to "Update now" by itself.
 */
(function () {
  'use strict';
  const MSG = self.SCF.MSG;
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 2500;

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    });
  }

  let upd = null; // the release we know of: {version, zipUrl, pageUrl} | null
  let pollTimer = null;

  // u = the updater's state: { current, available, onDisk, step: {kind, version} | null }
  function render(u) {
    const current = chrome.runtime.getManifest().version;
    const step = (u && u.step) || null;
    upd = (u && u.available) || null;
    $('hasupdate').style.display = step ? '' : 'none';
    $('uptodate').style.display = step ? 'none' : 'block';
    clearTimeout(pollTimer);
    if (!step) {
      $('cur2').textContent = current;
      return;
    }
    const ready = step.kind === 'reload';
    $('cur').textContent = current;
    $('next').textContent = step.version;
    $('next2').textContent = step.version;
    $('ready').hidden = !ready;
    $('howto').hidden = ready;
    const diskKnown = !ready && u.onDisk;
    $('disk-line').hidden = !diskKnown;
    if (diskKnown) $('disk').textContent = u.onDisk;
    if (!ready) pollTimer = setTimeout(refresh, POLL_MS);
  }

  // Update state with the folder's version re-read. The SW answers UPDATE_STATE from
  // v0.10.4 on; this page is served live from the folder, so it can be newer than
  // the SW still running (exactly the "files updated, not reloaded" case). Then work
  // the step out here from GET_STATE + the folder's manifest.json.
  async function freshUpdateState() {
    const u = await send({ type: MSG.UPDATE_STATE });
    if (u && 'step' in u) return u;
    const g = await send({ type: MSG.GET_STATE });
    const available = (g && g.update && g.update.available) || null;
    let onDisk = null;
    try {
      onDisk = (await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json()).version;
    } catch (e) {
      /* unreadable: fall back to the release prompt */
    }
    const current = chrome.runtime.getManifest().version;
    return { current, available, onDisk, step: self.SCF.updateCheck.nextStep(current, available, onDisk) };
  }

  async function refresh() {
    render(await freshUpdateState());
  }

  // reloading kills a recording that is still being made or saved, so check first
  async function reloadWhenIdle(msgEl) {
    const s = await send({ type: MSG.GET_STATE });
    if (s && (s.recording || s.saving || s.busy)) {
      msgEl.hidden = false;
      msgEl.textContent = 'A recording or video import is still running or saving. Let it finish, then click again.';
      return;
    }
    chrome.runtime.reload(); // loads the folder's files; closes this page (expected)
  }

  $('update-now').addEventListener('click', () => reloadWhenIdle($('update-now-msg')));

  $('dl').addEventListener('click', () => {
    if (!upd || !upd.zipUrl) return;
    chrome.downloads.download({ url: upd.zipUrl }, () => {
      void chrome.runtime.lastError;
      $('dl-done').hidden = false;
      $('s1').classList.add('done');
    });
  });

  $('reload').addEventListener('click', () => reloadWhenIdle($('reload-msg')));

  $('openext').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions' });
  });

  $('recheck').addEventListener('click', async () => {
    $('recheck-status').textContent = 'checking…';
    await send({ type: MSG.UPDATE_CHECK_NOW });
    const u = await freshUpdateState();
    render(u);
    if (!(u && u.step)) $('recheck-status').textContent = 'still the latest ✓';
  });

  refresh();
})();
