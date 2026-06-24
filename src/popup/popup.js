(function () {
  'use strict';
  const { MSG } = self.SCF;
  const $ = (id) => document.getElementById(id);

  let state = { recording: false, screenshots: 0, startedAt: null, lastResult: null };
  let timerInt = null;
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

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function startTimer() {
    stopTimer();
    timerInt = setInterval(() => {
      if (state.recording && state.startedAt) {
        $('timer').textContent = fmtTime(Date.now() - state.startedAt);
      }
    }, 500);
  }
  function stopTimer() {
    if (timerInt) clearInterval(timerInt);
    timerInt = null;
  }

  function render() {
    const pill = $('state-pill');
    const primary = $('primary');

    // error banner
    $('error-banner').hidden = !lastError;
    if (lastError) $('error-banner').textContent = lastError;

    if (state.recording) {
      pill.className = 'pill recording';
      pill.textContent = 'Recording';
      $('live').hidden = false;
      $('shots').textContent = (state.screenshots || 0) + ' shots';
      primary.textContent = 'Stop recording';
      primary.className = 'primary recording';
      primary.disabled = false;
      $('force').hidden = false;
      $('result').hidden = true;
      $('recent').hidden = true;
      startTimer();
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
      stopTimer();
    } else {
      pill.className = 'pill idle';
      pill.textContent = 'Idle';
      $('live').hidden = true;
      primary.textContent = 'Start recording';
      primary.className = 'primary';
      primary.disabled = false;
      $('force').hidden = true;
      stopTimer();
      renderResult();
      $('recent').hidden = recentCount === 0;
    }
  }

  function renderResult() {
    const lr = state.lastResult;
    if (lr && lr.mdPath) {
      $('result').hidden = false;
      const ss = lr.screenshots || 0;
      const sp = lr.transcriptSegments || 0;
      $('result-meta').textContent =
        ss + ' screenshot' + (ss === 1 ? '' : 's') + ' · ' + sp + ' spoken segment' + (sp === 1 ? '' : 's');
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

  async function load() {
    const s = await send({ type: MSG.GET_STATE });
    if (s) {
      state.recording = s.recording;
      state.saving = s.saving;
      state.screenshots = s.screenshots;
      state.startedAt = s.startedAt;
      state.lastResult = s.lastResult;
    }
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
      state.screenshots = s.screenshots;
      state.startedAt = s.startedAt;
      state.lastResult = s.lastResult || state.lastResult;
      if (msg.error) lastError = msg.error;
      render();
    } else if (msg.type === 'export_done') {
      state.saving = false;
      state.recording = false;
      state.lastResult = msg.result;
      render();
      loadRecent(); // a new recording was just archived
    }
  });

  load();
  startMeter();
})();
