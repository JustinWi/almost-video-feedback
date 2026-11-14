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
  const fc = self.SCF.folderCheck;
  const STABLE_MS = self.SCF_CONFIG.DEFAULTS.folderStableMs;

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
    target = ready ? step.version : null;
    $('cur').textContent = current;
    $('next').textContent = step.version;
    $('next2').textContent = step.version;
    $('ready').hidden = !ready;
    $('howto').hidden = ready;
    // the one-click update leads; the copy-by-hand steps stay below it as the fallback
    const auto = !ready && !!su && !!(upd && upd.zipUrl);
    $('auto').hidden = !auto;
    $('byhand-title').hidden = !auto;
    if (auto) prepareAuto();
    const diskKnown = !ready && u.onDisk;
    $('disk-line').hidden = !diskKnown;
    if (diskKnown) $('disk').textContent = u.onDisk;
    if (!ready && !autoBusy) pollTimer = setTimeout(refresh, POLL_MS);
    else if (ready) watchCopy();
  }

  // ---- one-click update: pick the folder once, then download + check + write + restart ----
  const su = self.SCF.selfUpdate;
  const GIT_OK_KEY = 'selfUpdateGitOk';
  let autoBusy = false;
  let prepared = false;

  function reasonText(reason) {
    if (reason === 'not-extension') return "That folder isn't Almost Video Feedback: there's no manifest.json for it inside.";
    if (reason === 'other-copy') {
      return 'That folder is a copy of Almost Video Feedback, but not the one Chrome is running. To find the right one, open chrome://extensions, click Details on the Almost Video Feedback card and look under "Source".';
    }
    if (reason === 'no-permission') return "Chrome didn't give permission to change that folder.";
    return '';
  }
  function autoMsg(text, isErr) {
    const m = $('auto-msg');
    m.textContent = text || '';
    m.hidden = !text;
    m.classList.toggle('err', !!isErr);
  }
  function autoText(title, text, button) {
    $('auto-title').textContent = title;
    $('auto-text').textContent = text;
    $('auto-go').textContent = button;
  }
  function pickMode() {
    autoText(
      'First time only: show the extension where its folder is',
      'Pick the folder you loaded the extension from on chrome://extensions (the one with manifest.json inside), then click Edit files when Chrome asks. After this, Update in the toolbar menu does everything.',
      'Pick the folder and update'
    );
  }
  // word the card for what the click will need: a folder pick, Chrome's OK, or nothing
  async function prepareAuto() {
    if (prepared) return;
    prepared = true;
    const dir = await su.loadFolder();
    if (!dir) return pickMode();
    if (!(await su.hasPermission(dir, false))) {
      return autoText(
        'Chrome needs your OK to update the files',
        'Click the button, then Allow (or Edit files) in the box Chrome shows. The update then runs by itself and the menu reopens on the new version.',
        'Allow and update'
      );
    }
    const f = await su.checkFolder(dir);
    if (!f.ok) {
      pickMode();
      return autoMsg(reasonText(f.reason) + ' Pick the right folder.', true);
    }
    autoText('Ready to update', 'One click. The progress shows here, then the extension restarts and the menu opens on the new version.', 'Update');
  }

  function autoProgress(ev, version) {
    const t = su.progressText(ev, version);
    $('auto-progress').hidden = false;
    $('auto-fill').style.width = t.pct + '%';
    $('auto-label').textContent = t.label;
  }
  async function isBusy() {
    const s = await send({ type: MSG.GET_STATE });
    return !!(s && (s.recording || s.saving || s.busy));
  }

  async function autoGo(gitOk) {
    const target = upd;
    if (autoBusy || !target || !target.zipUrl) return;
    autoBusy = true;
    clearTimeout(pollTimer);
    $('auto-go').disabled = true;
    $('auto-git').hidden = true;
    autoMsg('');
    let restarting = false;
    try {
      if (await isBusy()) return autoMsg('A recording or video import is still running or saving. Let it finish, then click again.', true);
      let dir = await su.loadFolder();
      let f = null;
      if (dir && (await su.hasPermission(dir, true))) f = await su.checkFolder(dir);
      if (!f || !f.ok) {
        if (dir && !f) {
          // Chrome's OK was refused or dismissed; the click it came from is used up
          pickMode();
          return autoMsg("Chrome didn't give permission. Click the button again and pick the folder.", true);
        }
        try {
          dir = await window.showDirectoryPicker({ id: 'avf-extension-folder', mode: 'readwrite', startIn: 'documents' });
        } catch (e) {
          if (e && e.name === 'AbortError') return autoMsg('No folder picked. Click the button to try again.');
          pickMode();
          return autoMsg('Click the button once more to pick the folder.', true);
        }
        f = await su.checkFolder(dir);
        if (!f.ok) return autoMsg(reasonText(f.reason) + ' Click the button to pick another folder.', true);
        await su.saveFolder(dir);
      }
      if (f.git && !gitOk) {
        let remembered = false;
        try {
          remembered = !!(await chrome.storage.local.get(GIT_OK_KEY))[GIT_OK_KEY];
        } catch (e) { /* ask */ }
        if (!remembered) {
          $('auto-git').hidden = false;
          return;
        }
      }
      autoProgress({ phase: 'download', done: 0, total: 0 }, target.version);
      const r = await su.updateTo({ dir, target, isBusy, onProgress: (ev) => autoProgress(ev, target.version) });
      if (r.ok) {
        restarting = true; // this page closes as the extension restarts
        return;
      }
      $('auto-progress').hidden = true;
      autoMsg(r.message, !r.pending);
    } catch (e) {
      autoMsg('The update stopped: ' + ((e && e.message) || 'unknown error') + '.', true);
    } finally {
      if (!restarting) {
        autoBusy = false;
        $('auto-go').disabled = false;
        prepared = false;
        refresh();
      }
    }
  }

  $('auto-go').addEventListener('click', () => autoGo(false));
  $('auto-git-go').addEventListener('click', async () => {
    if ($('auto-git-remember').checked) {
      try {
        await chrome.storage.local.set({ [GIT_OK_KEY]: true });
      } catch (e) { /* ask again next time */ }
    }
    autoGo(true);
  });
  $('auto-git-cancel').addEventListener('click', () => {
    $('auto-git').hidden = true;
  });

  // every folder check goes through here, so a mismatch that stops changing (edited
  // files, not a copy) is seen whichever button or poll looked last
  let mismatch = null; // folderCheck.track() state
  async function checkFolder() {
    const r = await fc.check().catch(() => ({ ok: null }));
    mismatch = fc.track(mismatch, r, Date.now(), STABLE_MS);
    return r;
  }
  // "Reload anyway" only for the release being updated to, already on disk (the ready
  // view). In the how-to view the folder still holds the OLD version's files and listing,
  // so a stable mismatch there is a copy of the new release stalled half way (a dialog
  // behind Chrome): reloading can only load a mix, never finish the update.
  let target = null; // step.version while the ready view is shown
  const canForce = (r) => !!(mismatch && mismatch.modified && target && r.version === target);
  const refusal = (r) => (canForce(r) ? fc.describeModified(r) : fc.describe(r));

  // Ready by manifest.json, but a zip copy may still be landing: hold the button
  // until every file the release lists matches, re-checking every few seconds.
  let copyMsgShown = false; // only clear the message this check put up, not a "still recording" one
  async function watchCopy() {
    const r = await checkFolder();
    const copying = r.ok === false;
    $('update-now').disabled = copying;
    if (copying || copyMsgShown) $('update-now-msg').hidden = !copying;
    $('update-now-anyway').hidden = !(copying && canForce(r));
    copyMsgShown = copying;
    if (copying) {
      $('update-now-msg').textContent = refusal(r);
      clearTimeout(pollTimer);
      pollTimer = setTimeout(refresh, POLL_MS);
    }
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
    const onDisk = await readDiskVersion();
    const current = chrome.runtime.getManifest().version;
    return { current, available, onDisk, step: self.SCF.updateCheck.nextStep(current, available, onDisk) };
  }

  // the folder's manifest.json, which Chrome serves live from disk (null: unreadable)
  async function readDiskVersion() {
    try {
      return (await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json()).version;
    } catch (e) {
      return null;
    }
  }

  async function refresh() {
    render(await freshUpdateState());
  }

  // reloading kills a recording that is still being made or saved, so check first
  // (folder check first: it can take a couple of seconds, and the idle check must be the last word)
  // anyway: the "Reload anyway" button, which passes only while the mismatch is still
  // the same stable one (a copy that started since is refused like any other)
  async function reloadWhenIdle(msgEl, anywayEl, anyway) {
    const r = await checkFolder();
    if (r.ok === false && !(anyway && canForce(r))) {
      msgEl.hidden = false;
      msgEl.textContent = refusal(r);
      anywayEl.hidden = !canForce(r);
      return;
    }
    const s = await send({ type: MSG.GET_STATE });
    if (s && (s.recording || s.saving || s.busy)) {
      msgEl.hidden = false;
      msgEl.textContent = 'A recording or video import is still running or saving. Let it finish, then click again.';
      return;
    }
    chrome.runtime.reload(); // loads the folder's files; closes this page (expected)
  }

  $('update-now').addEventListener('click', () => reloadWhenIdle($('update-now-msg'), $('update-now-anyway')));
  $('update-now-anyway').addEventListener('click', () => reloadWhenIdle($('update-now-msg'), $('update-now-anyway'), true));

  $('dl').addEventListener('click', () => {
    if (!upd || !upd.zipUrl) return;
    chrome.downloads.download({ url: upd.zipUrl }, () => {
      void chrome.runtime.lastError;
      $('dl-done').hidden = false;
      $('s1').classList.add('done');
    });
  });

  $('reload').addEventListener('click', () => reloadWhenIdle($('reload-msg'), $('reload-anyway')));
  $('reload-anyway').addEventListener('click', () => reloadWhenIdle($('reload-msg'), $('reload-anyway'), true));

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
