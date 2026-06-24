(function () {
  'use strict';
  const cfg = self.SCF_CONFIG;

  const FIELDS = [
    { id: 'language', path: 'language', type: 'text' },
    { id: 'captureFormat', path: 'captureFormat', type: 'select' },
    { id: 'jpegQuality', path: 'jpegQuality', type: 'int' },
    { id: 'dedupHammingThreshold', path: 'dedupHammingThreshold', type: 'int' },
    { id: 'clickDedup', path: 'clickDedup', type: 'select' },
    { id: 'annotate', path: 'annotate', type: 'checkbox' },
    { id: 'maxScreenshots', path: 'maxScreenshots', type: 'int' },
    { id: 'minCaptureIntervalMs', path: 'minCaptureIntervalMs', type: 'int' },
    { id: 'heartbeatSeconds', path: 'heartbeatSeconds', type: 'int' },
    { id: 'scrollIdleMs', path: 'scrollIdleMs', type: 'int' },
    { id: 'scrollMinDeltaPx', path: 'scrollMinDeltaPx', type: 'int' },
    { id: 'dwellMs', path: 'dwellMs', type: 'int' },
    { id: 'dwellMinMovePx', path: 'dwellMinMovePx', type: 'int' },
    { id: 'circleMinPathPx', path: 'circleMinPathPx', type: 'int' },
    { id: 'circleRatio', path: 'circleRatio', type: 'float' },
    { id: 'showOverlay', path: 'showOverlay', type: 'checkbox' },
    { id: 'clickStartsRecording', path: 'clickStartsRecording', type: 'checkbox' },
    { id: 't_start', path: 'triggers.start', type: 'checkbox' },
    { id: 't_navigation', path: 'triggers.navigation', type: 'checkbox' },
    { id: 't_route', path: 'triggers.route', type: 'checkbox' },
    { id: 't_click', path: 'triggers.click', type: 'checkbox' },
    { id: 't_selection', path: 'triggers.selection', type: 'checkbox' },
    { id: 't_circle', path: 'triggers.circle', type: 'checkbox' },
    { id: 't_dwell', path: 'triggers.dwell', type: 'checkbox' },
    { id: 't_scroll', path: 'triggers.scroll', type: 'checkbox' },
    { id: 't_heartbeat', path: 'triggers.heartbeat', type: 'checkbox' },
  ];

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, val) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = val;
  }

  function populate(settings) {
    for (const f of FIELDS) {
      const el = document.getElementById(f.id);
      if (!el) continue;
      const val = getPath(settings, f.path);
      if (f.type === 'checkbox') el.checked = !!val;
      else el.value = val == null ? '' : val;
    }
  }

  function gather() {
    const out = {};
    for (const f of FIELDS) {
      const el = document.getElementById(f.id);
      if (!el) continue;
      let val;
      if (f.type === 'checkbox') val = el.checked;
      else if (f.type === 'int') val = parseInt(el.value, 10);
      else if (f.type === 'float') val = parseFloat(el.value);
      else val = el.value;
      if ((f.type === 'int' || f.type === 'float') && Number.isNaN(val)) continue;
      setPath(out, f.path, val);
    }
    return out;
  }

  function flashSaved() {
    const s = document.getElementById('saved');
    s.textContent = '✓ Saved';
    s.classList.add('show');
    setTimeout(() => s.classList.remove('show'), 1200);
  }

  let saveTimer = null;
  async function onChange() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await cfg.save(gather());
      flashSaved();
    }, 250);
  }

  document.addEventListener('change', (e) => {
    if (e.target && e.target.id) onChange();
  });

  document.getElementById('reset').addEventListener('click', async () => {
    const defaults = await cfg.reset();
    populate(defaults);
    flashSaved();
  });
  document.getElementById('shortcuts').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  // platform-aware wording for the drawing gesture (Mac uses Control-click)
  (function () {
    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
    if (!isMac) return;
    const d = document.getElementById('annotateDesc');
    if (d) {
      d.textContent =
        'Control-click and drag to draw in neon pink (two-finger scroll and a plain ' +
        'Control-click still work as usual). Double Control-click (or the ⌫ button on the overlay) clears.';
    }
  })();

  cfg.load().then(populate);
})();
