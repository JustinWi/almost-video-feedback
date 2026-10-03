/*
 * Guided update page. Opened from the update notification, the popup banner,
 * or the options page. Reads the pending-update state from the service worker,
 * downloads the release zip, and finishes with chrome.runtime.reload() so the
 * freshly-replaced files load without a trip to chrome://extensions.
 */
(function () {
  'use strict';
  const MSG = self.SCF.MSG;
  const $ = (id) => document.getElementById(id);

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    });
  }

  let upd = null;

  // u = the updater's state: { current, available: {version, zipUrl, pageUrl} | null }
  function render(u) {
    const current = chrome.runtime.getManifest().version;
    upd = (u && u.available) || null;
    $('hasupdate').style.display = upd ? '' : 'none';
    $('uptodate').style.display = upd ? 'none' : 'block';
    if (upd) {
      $('cur').textContent = current;
      $('next').textContent = upd.version;
      $('next2').textContent = upd.version;
    } else {
      $('cur2').textContent = current;
    }
  }

  $('dl').addEventListener('click', () => {
    if (!upd || !upd.zipUrl) return;
    chrome.downloads.download({ url: upd.zipUrl }, () => {
      void chrome.runtime.lastError;
      $('dl-done').hidden = false;
      $('s1').classList.add('done');
    });
  });

  $('reload').addEventListener('click', () => {
    // reloads the unpacked extension from disk; kills this page (expected)
    chrome.runtime.reload();
  });

  $('openext').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions' });
  });

  $('recheck').addEventListener('click', async () => {
    $('recheck-status').textContent = 'checking…';
    const u = await send({ type: MSG.UPDATE_CHECK_NOW });
    render(u);
    if (!(u && u.available)) $('recheck-status').textContent = 'still the latest ✓';
  });

  send({ type: MSG.GET_STATE }).then((s) => render(s && s.update));
})();
