(function () {
  'use strict';
  const { MSG } = self.SCF;
  const $ = (id) => document.getElementById(id);

  const videoSource = self.SCF.videoSource;
  const exporter = self.SCF.exporter;
  const REF_KEY = 'importAsReference'; // remembers the reference tick between imports
  const fc = self.SCF.folderCheck;
  const FOLDER_STABLE_MS = self.SCF_CONFIG.DEFAULTS.folderStableMs;
  const FOLDER_POLL_MS = 2500;
  let mismatch = null; // folderCheck.track() state while this popup is open
  let folderMsg = ''; // why Update now was refused; kept over re-renders until the folder matches
  let folderTimer = null;
  let videoTab = null; // the active tab if it holds an importable video (Loom share / YouTube watch)
  let videoSrc = null; // { kind, label } for videoTab
  let lastProgress = { done: 0, total: 0 }; // last capture tick, so an ad pause keeps the bar in place
  // Drive the import progress bar. `total === 0` shows an empty bar (e.g. while the
  // transcript is still being read); pass a labelOverride for non-counting phases.
  function setImportProgress(done, total, labelOverride) {
    const fill = $('ip-fill');
    const label = $('ip-label');
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    if (fill) fill.style.width = pct + '%';
    if (label) {
      label.textContent = labelOverride
        ? labelOverride
        : 'Capturing frame ' + Math.min(done + 1, total) + ' / ' + total + '  ·  ' + pct + '%';
    }
  }
  async function detectVideo() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      videoSrc = tab ? videoSource.sourceForUrl(tab.url) : null;
      videoTab = videoSrc ? tab : null;
    } catch (e) { videoTab = null; videoSrc = null; }
    $('import-box').hidden = !(videoTab && !state.recording && !state.saving);
    if (!videoSrc) return;
    $('import-video').textContent = (videoSrc.kind === 'youtube' ? '▶️' : '🎬') + ' Import this ' + videoSrc.label + ' video';
    // the reference choice is offered on YouTube, where most videos aren't feedback
    const refRow = $('import-ref-row');
    refRow.hidden = videoSrc.kind !== 'youtube';
    if (!refRow.hidden) {
      try {
        const got = await chrome.storage.local.get(REF_KEY);
        $('import-ref').checked = !!got[REF_KEY];
      } catch (e) { /* default unticked */ }
    }
  }

  let state = { recording: false, screenshots: 0, startedAt: null, lastResult: null };
  let lastError = '';
  let recentCount = 0;
  const store = self.SCF && self.SCF.sessionStore;

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    });
  }

  // ---- live microphone meter (confirms the mic is capturing) ----
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let meterRAF = null;
  let meterData = null;

  async function startMeter() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const lbl = $('meter-label');
      lbl.textContent =
        e && e.name === 'NotAllowedError' ? 'mic blocked' : 'no microphone';
      lbl.className = 'meter-label err';
      return;
    }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const src = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      meterData = new Uint8Array(analyser.fftSize);
      $('meter-label').textContent = 'speak to test';
      $('meter-label').className = 'meter-label muted';
      loopMeter();
    } catch (e) {
      $('meter-label').textContent = 'meter error';
      $('meter-label').className = 'meter-label err';
    }
  }

  function loopMeter() {
    meterRAF = requestAnimationFrame(loopMeter);
    if (!analyser) return;
    analyser.getByteTimeDomainData(meterData);
    let sum = 0;
    for (let i = 0; i < meterData.length; i++) {
      const v = (meterData[i] - 128) / 128;
      sum += v * v;
    }
    const level = Math.min(1, Math.sqrt(sum / meterData.length) * 3.4);
    const fill = $('meter-fill');
    fill.style.width = Math.round(level * 100) + '%';
    fill.style.background = level > 0.55 ? '#f43f5e' : level > 0.16 ? '#22c55e' : '#3b82f6';
    if (level > 0.06) {
      const lbl = $('meter-label');
      lbl.textContent = 'mic working ✓';
      lbl.className = 'meter-label ok';
    }
  }

  function stopMeter() {
    if (meterRAF) cancelAnimationFrame(meterRAF);
    meterRAF = null;
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (audioCtx) {
      try {
        audioCtx.close();
      } catch (e) {
        /* ignore */
      }
      audioCtx = null;
    }
    analyser = null;
  }

  // some browsers start the AudioContext suspended until a gesture
  document.addEventListener('pointerdown', () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  });
  window.addEventListener('pagehide', stopMeter);
  window.addEventListener('unload', stopMeter);

  function render() {
    const pill = $('state-pill');
    const primary = $('primary');

    // error banner
    $('error-banner').hidden = !lastError;
    if (lastError) $('error-banner').textContent = lastError;

    // update banner — the popup opens after every save, so even click-to-record
    // users (who never see the idle popup) get the nudge here
    const upd = state.update && state.update.step;
    $('update-banner').hidden = !upd;
    if (upd) {
      const ready = upd.kind === 'reload';
      $('update-text').textContent = ready
        ? folderMsg || 'v' + upd.version + ' is ready in your extension folder'
        : 'v' + upd.version + ' is out — you have v' + chrome.runtime.getManifest().version;
      $('update-go').textContent = ready ? '⟳ Update now' : 'How to update';
      // reloading mid-save would lose the recording being written
      $('update-go').disabled = ready && !!(state.saving || state.recording || state.busy || importBusy());
      $('update-go').title = $('update-go').disabled ? 'Wait for the recording or import to finish' : '';
      // edited files, not a copy: Update now would only refuse again, so it waits (as on
      // the update page) and the quiet "Reload anyway" is the way past
      const anyway = ready && !!folderMsg && !!mismatch && mismatch.modified;
      $('update-anyway').hidden = !anyway;
      $('update-banner').classList.toggle('has-anyway', anyway);
      $('update-anyway').disabled = !!(state.saving || state.recording || state.busy || importBusy());
      $('update-anyway').title = $('update-anyway').disabled ? 'Wait for the recording or import to finish' : '';
      if (anyway) $('update-go').disabled = true;
    }

    if (state.recording) {
      pill.className = 'pill recording';
      pill.textContent = 'Recording';
      $('live').hidden = false;
      $('shots').textContent = (state.screenshots || 0) + ' shots';
      primary.textContent = '■ Stop recording';
      primary.className = 'primary recording';
      primary.disabled = false;
      $('force').hidden = false;
      $('result').hidden = true;
      $('recent').hidden = true;
    } else if (state.saving) {
      pill.className = 'pill saving';
      pill.textContent = 'Saving';
      $('live').hidden = true;
      $('result').hidden = true;
      $('recent').hidden = true;
      primary.textContent = 'Saving…';
      primary.className = 'primary';
      primary.disabled = true;
      $('force').hidden = true;
    } else {
      pill.className = 'pill idle';
      pill.textContent = 'Idle';
      $('live').hidden = true;
      primary.textContent = '● Start recording';
      primary.className = 'primary start';
      primary.disabled = false;
      $('force').hidden = true;
      renderResult();
      $('recent').hidden = recentCount === 0;
    }
    renderClickHelp();
  }

  // ---- what a click on the toolbar icon does (+ the start/stop shortcut) ----
  let hotkey = ''; // e.g. "⇧⌘Y"; empty when the user removed the shortcut
  let clickStarts = null; // settings.clickStartsRecording; null until loaded
  function renderClickHelp() {
    const idle = !state.recording && !state.saving;
    $('hotkey-hint').hidden = !(idle && hotkey);
    if (hotkey) $('hotkey-key').textContent = hotkey;
    // on a Loom / YouTube page the icon always opens this menu, so "starts a recording" would be wrong here
    const show = idle && clickStarts !== null && !(clickStarts && videoTab);
    $('click-mode').hidden = !show;
    if (show) {
      $('click-mode-text').textContent = clickStarts
        ? 'Clicking the icon starts a recording'
        : 'Clicking the icon opens this menu';
      $('click-mode-change').title = clickStarts
        ? 'Make a click on the icon open this menu instead'
        : 'Make a click on the icon start a recording straight away';
    }
  }
  async function loadClickHelp() {
    try {
      const s = await self.SCF_CONFIG.load();
      clickStarts = s.clickStartsRecording !== false;
    } catch (e) {
      clickStarts = null;
    }
    try {
      const cmds = await chrome.commands.getAll();
      const c = (cmds || []).find((x) => x.name === 'toggle-recording');
      hotkey = (c && c.shortcut) || '';
    } catch (e) {
      hotkey = '';
    }
    renderClickHelp();
  }
  $('click-mode-change').addEventListener('click', async () => {
    if (clickStarts === null) return;
    const next = !clickStarts;
    try {
      // the service worker hears the settings change and swaps the icon's behavior
      await self.SCF_CONFIG.save({ clickStartsRecording: next });
      clickStarts = next;
    } catch (e) {
      /* leave the line as it was */
    }
    renderClickHelp();
  });

  // "no ads", "1 ad skipped", "2 ads (1 skipped, 1 waited out)"
  function adSummary(ads) {
    if (!ads.length) return 'no ads';
    const skipped = ads.filter((a) => a.how === 'skipped').length;
    const n = ads.length + ' ad' + (ads.length === 1 ? '' : 's');
    if (skipped === ads.length) return n + ' skipped';
    if (!skipped) return n + ' waited out';
    return n + ' (' + skipped + ' skipped, ' + (ads.length - skipped) + ' waited out)';
  }

  function renderResult() {
    const lr = state.lastResult;
    if (lr && lr.mdPath) {
      $('result').hidden = false;
      $('result-title').textContent = lr.purpose === 'reference'
        ? '✅ Reference video saved'
        : lr.source ? '✅ Video imported' : '✅ Recording saved';
      $('copy-transcript').hidden = !(lr.transcriptSegments > 0);
      const ss = lr.screenshots || 0;
      const sp = lr.transcriptSegments || 0;
      $('result-meta').textContent =
        ss + ' screenshot' + (ss === 1 ? '' : 's') + ' · ' + sp + ' spoken segment' + (sp === 1 ? '' : 's') +
        (lr.adBreaks ? ' · ' + adSummary(lr.adBreaks) : '');
    } else {
      $('result').hidden = true;
    }
  }

  // ---- recent recordings (last 3, with thumbnails) ----
  let recentUrls = [];
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"'`]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c])
    );
  }
  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    return m ? m + 'm' + String(s % 60).padStart(2, '0') + 's' : s + 's';
  }
  function shortWhen(rec) {
    try {
      return new Date(rec.startedAt).toLocaleString([], {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
    } catch (e) {
      return rec.startedAtText || '';
    }
  }
  function recSub(rec) {
    const page = rec.pages && rec.pages[0];
    let host = '';
    if (page) {
      try { host = new URL(page.url).host; } catch (e) { host = page.url; }
    }
    return fmtDur(rec.durationMs || 0) + ' · ' + (rec.screenshotCount || 0) + ' shots' + (host ? ' · ' + host : '');
  }
  function clipFor(rec) {
    const path = rec.mdPath
      ? rec.mdPath
      : rec.dir
        ? 'in your Downloads folder at ' + rec.dir + '/feedback.md'
        : '(in your Downloads/ai-feedback folder)';
    return (
      'I recorded visual + spoken feedback on my web app. Please read the feedback file and ' +
      'address each item. Screenshots are referenced relative to the file, in the same folder.\n\n' +
      'Feedback file: ' + path
    );
  }
  function openRecordings(id) {
    let url = chrome.runtime.getURL('src/history/history.html');
    if (id) url += '?id=' + encodeURIComponent(id);
    chrome.tabs.create({ url });
  }
  // two-step confirm so a stray click can't delete a recording
  function armConfirm(btn, confirmLabel, onConfirm) {
    if (btn.dataset.armed === '1') {
      clearTimeout(+btn.dataset.timer);
      btn.dataset.armed = '0';
      onConfirm();
      return;
    }
    const orig = btn.textContent;
    btn.dataset.armed = '1';
    btn.textContent = confirmLabel;
    btn.classList.add('armed');
    btn.dataset.timer = String(setTimeout(() => {
      btn.dataset.armed = '0';
      btn.textContent = orig;
      btn.classList.remove('armed');
    }, 2600));
  }
  async function deleteRecording(id) {
    await send({ type: MSG.DELETE_RECORDING, id });
    if (state.lastResult && state.lastResult.id === id) {
      state.lastResult = null;
      $('result').hidden = true;
    }
    loadRecent();
  }
  async function copyRecent(rec, btn) {
    try {
      await navigator.clipboard.writeText(clipFor(rec));
      const o = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => (btn.textContent = o), 1200);
    } catch (e) {
      /* ignore */
    }
  }
  async function firstShotUrl(rec) {
    try {
      if (!store) return null;
      const shots = await store.getHistoryShots(rec.id);
      if (shots && shots[0] && shots[0].blob) return URL.createObjectURL(shots[0].blob);
    } catch (e) {
      /* ignore */
    }
    return null;
  }
  function renderRecentCard(rec, url) {
    const card = document.createElement('div');
    card.className = 'recent-card';
    card.title = 'Click to view this recording';
    // url is a blob: object URL we created; text is escaped
    card.innerHTML =
      (url
        ? '<img class="rc-thumb" src="' + url + '" alt="" />'
        : '<div class="rc-thumb rc-ph"><span class="rc-recdot"></span></div>') +
      '<div class="rc-meta"><div class="rc-when">' + esc(shortWhen(rec)) + '</div>' +
      '<div class="rc-sub">' + esc(recSub(rec)) + '</div></div>' +
      '<div class="rc-actions">' +
      '<button class="rc-btn rc-copy" title="Copy prompt for this recording">📋</button>' +
      '<button class="rc-btn rc-del" title="Delete this recording">🗑</button></div>';
    card.addEventListener('click', (e) => {
      if (e.target.closest('.rc-actions')) return;
      openRecordings(rec.id);
    });
    card.querySelector('.rc-copy').addEventListener('click', (e) => {
      e.stopPropagation();
      copyRecent(rec, e.currentTarget);
    });
    card.querySelector('.rc-del').addEventListener('click', (e) => {
      e.stopPropagation();
      armConfirm(e.currentTarget, '✓?', () => deleteRecording(rec.id));
    });
    return card;
  }
  async function loadRecent() {
    recentUrls.forEach((u) => URL.revokeObjectURL(u));
    recentUrls = [];
    let rows = [];
    try {
      if (store) rows = await store.listHistory();
    } catch (e) {
      /* ignore */
    }
    rows = rows.slice(0, 3);
    recentCount = rows.length;
    const list = $('recent-list');
    list.innerHTML = '';
    for (const rec of rows) {
      const url = await firstShotUrl(rec);
      if (url) recentUrls.push(url);
      list.appendChild(renderRecentCard(rec, url));
    }
    if (!state.recording && !state.saving) $('recent').hidden = recentCount === 0;
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

  const importBusy = () => !$('import-progress').hidden; // an import started from this popup

  async function load() {
    // also on the early return below: the menu that opens after a save is where
    // click-to-record users find out the icon can open this menu instead
    loadClickHelp();
    const s = await send({ type: MSG.GET_STATE });
    if (s) {
      state.recording = s.recording;
      state.saving = s.saving;
      state.busy = !!s.busy;
      state.screenshots = s.screenshots;
      state.startedAt = s.startedAt;
      state.lastResult = s.lastResult;
      if (s.update && 'step' in s.update) state.update = s.update;
    }
    // re-read the extension folder's version (a git pull / copy-over shows up here)
    freshUpdateState().then((u) => {
      if (u) {
        state.update = u;
        render();
      }
    });
    // Clicking the toolbar icon while recording stops the recording automatically
    // (the menu then shows "Saving…" -> the saved result + recent list).
    if (state.recording && !state.saving) {
      state.recording = false;
      state.saving = true;
      render();
      send({ type: MSG.STOP_RECORDING });
      loadRecent();
      return;
    }
    render();
    loadRecent();
    detectVideo().then(renderClickHelp);
  }

  // primary button
  $('primary').addEventListener('click', async () => {
    lastError = '';
    if (state.recording) {
      state.saving = true;
      state.recording = false;
      render();
      await send({ type: MSG.STOP_RECORDING });
      // export_done broadcast will refresh us
      return;
    }
    // Start recording. The content script will prompt for the page's microphone
    // the first time (Chrome's standard in-page mic prompt), then remember it.
    await send({ type: MSG.START_RECORDING });
    window.close(); // get out of the way so the user can interact with the page
  });

  $('force').addEventListener('click', () => send({ type: MSG.FORCE_SHOT }));

  $('import-ref').addEventListener('change', (e) => {
    try { chrome.storage.local.set({ [REF_KEY]: e.target.checked }); } catch (err) { /* ignore */ }
  });

  $('import-video').addEventListener('click', async () => {
    if (!videoTab) return;
    lastError = '';
    const btn = $('import-video');
    btn.disabled = true;
    $('import-ref').disabled = true;
    $('import-progress').hidden = false;
    setImportProgress(0, 0, 'Reading transcript…');
    const reference = videoSrc && videoSrc.kind === 'youtube' && $('import-ref').checked;
    const resp = await send({ type: MSG.IMPORT_VIDEO, tabId: videoTab.id, reference });
    // success arrives via the export_done broadcast; on failure, un-stick the UI here
    if (!resp || resp.error || !resp.mdPath) {
      $('import-progress').hidden = true;
      btn.disabled = false;
      $('import-ref').disabled = false;
      detectVideo();
    }
  });

  // Copy the last recording's full transcript ("[mm:ss] line" per segment).
  $('copy-transcript').addEventListener('click', async () => {
    const lr = state.lastResult;
    const btn = $('copy-transcript');
    const orig = btn.textContent;
    try {
      const rec = lr && store ? await store.getHistory(lr.id) : null;
      if (!rec) throw new Error('not found');
      const meta = { startedAt: rec.startedAt, startedAtText: rec.startedAtText, source: rec.source };
      await navigator.clipboard.writeText(exporter.transcriptMarkdown(rec.events || [], meta));
      btn.textContent = '✓ Copied';
    } catch (e) {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => (btn.textContent = orig), 1400);
  });
  $('copy').addEventListener('click', async () => {
    await send({ type: MSG.COPY_LAST });
    const btn = $('copy');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => (btn.textContent = orig), 1400);
  });
  $('discard').addEventListener('click', (e) => {
    const id = state.lastResult && state.lastResult.id;
    if (!id) return;
    armConfirm(e.currentTarget, 'Delete?', () => deleteRecording(id));
  });
  // hash the folder against the release's file list; a refusal is kept in folderMsg and
  // re-checked while the popup stays open, so a finished copy (or a stable edit) shows by itself
  async function checkFolder() {
    const r = await fc.check().catch(() => ({ ok: null }));
    mismatch = fc.track(mismatch, r, Date.now(), FOLDER_STABLE_MS);
    folderMsg = r.ok !== false ? '' : mismatch.modified ? fc.describeModified(r) : fc.describe(r);
    clearTimeout(folderTimer);
    if (folderMsg) folderTimer = setTimeout(recheckFolder, FOLDER_POLL_MS);
    return r;
  }
  async function recheckFolder() {
    const upd = state.update && state.update.step;
    if (!folderMsg || !upd || upd.kind !== 'reload') return;
    await checkFolder();
    render();
  }
  // anyway: "Reload anyway", which passes only while the mismatch is still the same
  // stable one (a copy that started since is refused like any other)
  async function updateNow(anyway) {
    // a zip still being copied over would load half old, half new files
    $('update-go').disabled = true;
    $('update-anyway').disabled = true;
    const r = await checkFolder(); // every path below re-renders (re-enabling both) or reloads
    if (r.ok === false && !(anyway && mismatch.modified)) {
      render();
      return;
    }
    // a recording or import may have started during the check: the idle test is the last word
    if (state.saving || state.recording || state.busy || importBusy()) {
      render();
      return;
    }
    chrome.runtime.reload(); // loads the new files from the folder; closes this popup
  }
  $('update-go').addEventListener('click', () => {
    const upd = state.update && state.update.step;
    if (upd && upd.kind === 'reload') return updateNow(false);
    chrome.tabs.create({ url: chrome.runtime.getURL('src/update/update.html') });
    window.close();
  });
  $('update-anyway').addEventListener('click', () => updateNow(true));

  $('recordings').addEventListener('click', () => openRecordings());
  $('view').addEventListener('click', () => openRecordings());
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('shortcuts').addEventListener('click', () =>
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
  );

  // live updates from the SW
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === MSG.STATUS) {
      const s = msg.state || {};
      state.recording = s.recording;
      state.saving = !!s.saving;
      state.busy = !!s.busy;
      state.screenshots = s.screenshots;
      state.startedAt = s.startedAt;
      state.lastResult = s.lastResult || state.lastResult;
      // a service worker older than these files sends no `step`: keep what freshUpdateState() worked out
      if (s.update && 'step' in s.update) state.update = s.update;
      if (msg.error) lastError = msg.error;
      render();
    } else if (msg.type === MSG.IMPORT_PROGRESS) {
      const p = msg.progress || {};
      $('import-progress').hidden = false;
      if (p.phase === 'done') setImportProgress(p.total || 0, p.total || 0, 'Building bundle…');
      // from the YouTube page: keep the bar where it was, say why it's paused
      else if (p.phase === 'ad') setImportProgress(lastProgress.done, lastProgress.total, 'Ad playing: paused, skipping it as soon as YouTube allows…');
      else {
        lastProgress = { done: p.done || 0, total: p.total || 0 };
        setImportProgress(lastProgress.done, lastProgress.total);
      }
    } else if (msg.type === 'export_done') {
      state.saving = false;
      state.recording = false;
      state.lastResult = msg.result;
      render();
      loadRecent(); // a new recording was just archived
      $('import-progress').hidden = true;
      $('import-video').disabled = false;
      $('import-ref').disabled = false;
      detectVideo();
    }
  });

  load();
  startMeter();
})();
