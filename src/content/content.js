/*
 * Content script (top frame). Renders the in-page overlay, tracks the inputs
 * that signal "screenshot-worthy moment", coordinates hiding the overlay during
 * a capture, and shows live transcript + capture toasts.
 *
 * Loaded after protocol.js, overlay-style.js, dom-descriptor.js, gesture.js, so
 * it can use SCF, SCF_OVERLAY_CSS, SCF_DOM, SCF_GESTURE from the shared scope.
 */
(function () {
  'use strict';
  if (window.__scfContentLoaded) return;
  window.__scfContentLoaded = true;

  const { MSG, TRIGGER } = self.SCF;
  const gesture = self.SCF_GESTURE;
  const dom = self.SCF_DOM;
  const CSS = self.SCF_OVERLAY_CSS;

  const DEFAULT_TRIGGERS = {
    start: true, navigation: true, route: true, click: true, selection: true,
    circle: true, dwell: true, scroll: true, heartbeat: true,
  };
  const cfg = {
    showOverlay: true,
    clickCaptureDelayMs: 150,
    scrollIdleMs: 500,
    scrollMinDeltaPx: 200,
    dwellMs: 400,
    dwellMinMovePx: 120,
    circleMinPathPx: 320,
    circleRatio: 3.2,
    annotate: true,
    annotateColor: '#ff2d95',
    triggers: Object.assign({}, DEFAULT_TRIGGERS),
  };
  const annotate = self.SCF_ANNOTATE || null;
  const speechLib = self.SCF_SPEECH || null;
  let annotateCaptureTimer = null;
  // draw: a pencil tracing a hand-drawn loop (the loop is "ink" pink, like real marks)
  const PEN_SVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path class="ink" stroke-width="1.9" d="M9.6 14.6C6 13.6 2.6 15 2.6 17.6c0 2.6 3.6 3.9 7.2 3.2 3-.6 4.6-2.2 4-3.9"/>' +
    '<path stroke-width="1.9" d="M11 13.8l8.3-8.3a2 2 0 0 0-2.8-2.8L8.2 11l-.9 3.7z"/>' +
    '<path stroke-width="1.6" d="M15 4.2l2.8 2.8"/></svg>';
  // clear drawings: a pink scribble with a red ✕ — about the marks, not the transcript
  const CLEAR_SVG =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path stroke="#ff2d95" stroke-width="2.3" d="M2.4 18.8c1.4-4 4-5.4 5.4-3.6 1.3 1.7-.6 4.2 1.4 4.8 2 .6 3.5-1.8 5-4"/>' +
    '<circle cx="17.2" cy="6.8" r="5.6" fill="#f43f5e"/>' +
    '<path stroke="#fff" stroke-width="2" d="M15 4.6l4.4 4.4M19.4 4.6L15 9"/></svg>';

  let recording = false;
  let micListening = false; // true once the recognizer is actually capturing audio
  let paused = false;

  // overlay refs
  let hostEl = null;
  let panelEl = null;
  let textEl = null;
  let recLabelEl = null;
  let shotsEl = null;
  let miniEl = null;
  let pauseBtnEl = null;
  let clearInkEl = null;
  let penBtnEl = null;
  let shootBtnEl = null;
  let stopBtnEl = null;
  let shadowEl = null;
  let shortcuts = {}; // command name -> Chrome's label for it (e.g. '⌥⇧D'), for tooltips

  // while paused, the finalized segments ({id,t,text}) shown as editable text
  let editorSegments = null;
  let editorTimer = null;

  // overlay UI state
  let shotCount = 0;
  let minimized = false;
  let overlayPos = null; // {x,y} top-left in viewport px; null = default bottom-center
  let dragging = false;

  // transcript display
  let finalText = '';
  let interimText = '';

  // input-tracking state
  const listeners = [];
  const moveBuf = [];
  let lastMoveProcessed = 0;
  let lastMovePoint = null;
  let movedAccum = 0;
  let dwellTimer = null;
  let lastCircleAt = 0;
  let lastDwellAt = 0;
  let scrollIdleTimer = null;
  let lastScrollCaptureY = 0;
  let lastSelectionText = '';

  // route detection
  let origPush = null;
  let origReplace = null;
  let routeTimer = null;
  let lastRouteUrl = location.href;

  // speech recognition runs in an extension-origin iframe (injected here) so it
  // uses the extension's one-time microphone permission instead of prompting on
  // every site. Transcript flows iframe -> service worker -> this overlay.
  // Some sites (claude.ai) only allow their own origin to use the mic, so the
  // iframe is refused; then we run Web Speech right here with the page's own mic
  // permission (Chrome asks once for that site). micMode: 'frame' | 'page' | 'blocked'.
  let recIframe = null;
  let pageSpeech = null;
  let micMode = 'frame';
  let recLang = 'en-US';
  let micErrorMsg = '';

  // keepalive port so the service worker isn't evicted during quiet stretches
  let kaPort = null;
  let kaTimer = null;

  const now = () => performance.now();

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (e) {
      /* SW not ready */
    }
  }
  function ask(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        cb(res);
      });
    } catch (e) {
      cb(null);
    }
  }
  function requestCapture(trigger, meta) {
    send({ type: MSG.REQUEST_CAPTURE, trigger, meta: meta || {} });
  }
  function withPage(meta) {
    return Object.assign({ url: location.href, title: document.title }, meta || {});
  }

  // ---- on-page drawing (telestrator) -------------------------------------
  function showClearBtn(show) {
    if (clearInkEl) clearInkEl.classList.toggle('is-hidden', !show);
  }
  function onAnnotated() {
    // capture once the drawing settles so the shot includes the finished mark
    clearTimeout(annotateCaptureTimer);
    annotateCaptureTimer = setTimeout(() => {
      if (recording) requestCapture(TRIGGER.ANNOTATE, withPage({}));
    }, 600);
  }
  function penOn() {
    return !!(annotate && annotate.isPenMode && annotate.isPenMode());
  }
  function syncPenBtn(on) {
    if (!penBtnEl) return;
    penBtnEl.classList.toggle('on', !!on);
    penBtnEl.setAttribute('aria-pressed', on ? 'true' : 'false');
    refreshTips();
  }

  // Instant hover tooltips (CSS, from data-tip) that carry the keyboard shortcut,
  // so it's visible the first time you point at a button — no native-title delay.
  function tip(el, text) {
    if (!el) return;
    el.setAttribute('data-tip', text);
    el.setAttribute('aria-label', text.replace(/\s*\n\s*/g, '. '));
    el.removeAttribute('title');
  }
  function withKey(text, command) {
    return shortcuts[command] ? text + '   ' + shortcuts[command] : text;
  }
  function refreshTips() {
    tip(pauseBtnEl, paused ? 'Resume recording' : 'Pause recording\nWhile paused you can fix misheard words');
    tip(shootBtnEl, withKey('Screenshot now', 'force-screenshot'));
    tip(
      penBtnEl,
      penOn()
        ? withKey('Stop drawing', 'toggle-draw') + '\nor press Esc'
        : withKey('Draw on the page', 'toggle-draw') + '\nHold Shift for a straight line'
    );
    tip(clearInkEl, withKey('Clear all drawings', 'clear-drawings') + '\nYour transcript is kept');
    tip(miniEl, minimized ? 'Expand' : 'Minimize');
    tip(stopBtnEl, withKey('Stop & save', 'toggle-recording'));
  }
  function loadShortcuts() {
    ask({ type: MSG.GET_SHORTCUTS }, (res) => {
      shortcuts = res && typeof res === 'object' ? res : {};
      refreshTips();
    });
  }
  function startAnnotate() {
    if (!annotate || cfg.annotate === false) return;
    try {
      // report this (top) frame's ink to the SW, which aggregates across every
      // frame and tells us whether to show the clear button (ANNOTATE_INK_ANY)
      annotate.onInkChange((has) => send({ type: MSG.ANNOTATE_INK, hasInk: has }));
      annotate.onAnnotated(onAnnotated);
      if (annotate.onPenChange) annotate.onPenChange(syncPenBtn);
      annotate.start(cfg.annotateColor || '#ff2d95');
    } catch (e) {
      /* ignore */
    }
  }
  function stopAnnotate() {
    clearTimeout(annotateCaptureTimer);
    if (!annotate) return;
    try {
      annotate.stop();
    } catch (e) {
      /* ignore */
    }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"'`]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c])
    );
  }

  // ----------------------------------------------------------------- overlay

  function buildOverlay() {
    if (hostEl) return;
    hostEl = document.createElement('div');
    hostEl.id = '__scf_overlay_host';
    hostEl.style.cssText =
      'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
    const shadow = hostEl.attachShadow({ mode: 'open' });
    shadowEl = shadow;
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    panelEl = document.createElement('div');
    panelEl.className = 'panel';

    // grip (drag handle): the whole left status zone — ⋮⋮ dots + REC dot/label +
    // shots count, stretched to the bar's full height. Transcript + buttons never drag.
    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = 'Drag to move';
    const dots = document.createElement('div');
    dots.className = 'dots';
    dots.setAttribute('aria-hidden', 'true');
    grip.appendChild(dots);
    const dot = document.createElement('div');
    dot.className = 'dot';
    const recLabel = document.createElement('span');
    recLabel.className = 'reclabel';
    recLabel.textContent = 'REC';
    recLabelEl = recLabel;
    shotsEl = document.createElement('span');
    shotsEl.className = 'shots';
    shotsEl.textContent = '📸 0';
    grip.append(dot, recLabel, shotsEl);

    const sep = document.createElement('div');
    sep.className = 'sep';

    textEl = document.createElement('div');
    textEl.className = 'text';

    // clear-drawing button — sits right after the pen, only while a drawing is
    // present (kept away from the transcript so it can't read as "delete text")
    clearInkEl = null;
    if (annotate && cfg.annotate !== false) {
      clearInkEl = document.createElement('button');
      clearInkEl.className = 'clearink is-hidden';
      clearInkEl.innerHTML = CLEAR_SVG;
      clearInkEl.addEventListener('click', () => {
        send({ type: MSG.CLEAR_ANNOTATIONS }); // clears every frame via the SW
      });
      if (annotate.hasInk && annotate.hasInk()) clearInkEl.classList.remove('is-hidden');
    }

    const btns = document.createElement('div');
    btns.className = 'btns';
    const pause = document.createElement('button');
    pause.className = 'pause';
    pause.textContent = '⏸';
    pause.addEventListener('click', () => send({ type: MSG.TOGGLE_PAUSE }));
    pauseBtnEl = pause;
    const shoot = document.createElement('button');
    shoot.className = 'shoot';
    shoot.textContent = '📸';
    shootBtnEl = shoot;
    shoot.addEventListener('click', () => requestCapture(TRIGGER.FORCED, withPage({})));
    // pen toggle: while on, a plain left-drag draws on the page (Esc turns it off)
    penBtnEl = null;
    if (annotate && annotate.setPenMode && cfg.annotate !== false) {
      penBtnEl = document.createElement('button');
      penBtnEl.className = 'pen';
      penBtnEl.innerHTML = PEN_SVG;
      penBtnEl.addEventListener('click', () => annotate.setPenMode(!penOn()));
      syncPenBtn(penOn());
    }
    const mini = document.createElement('button');
    mini.className = 'mini';
    mini.textContent = '–';
    mini.addEventListener('click', () => setMinimized(!minimized));
    miniEl = mini;
    const stop = document.createElement('button');
    stop.className = 'stop';
    stop.textContent = '⏹';
    stopBtnEl = stop;
    stop.addEventListener('click', () => send({ type: MSG.STOP_RECORDING }));
    btns.append(pause, shoot);
    if (penBtnEl) btns.append(penBtnEl);
    if (clearInkEl) btns.append(clearInkEl);
    btns.append(mini, stop);

    // typing in the transcript editor must not reach the page's own shortcuts
    ['keydown', 'keyup', 'keypress'].forEach((type) =>
      panelEl.addEventListener(type, (e) => e.stopPropagation())
    );

    panelEl.append(grip, sep, textEl, btns);
    shadow.appendChild(panelEl);
    (document.documentElement || document.body).appendChild(hostEl);

    enableDrag(grip);
    // restore saved position + minimized state, then apply
    try {
      chrome.storage.local.get(['overlayPos', 'overlayMin'], (got) => {
        overlayPos = got && got.overlayPos ? got.overlayPos : null;
        applyPosition();
        setMinimized(!!(got && got.overlayMin), true);
      });
    } catch (e) {
      applyPosition();
    }
    applyPosition();
    updateShots();
    applyMicState();
    loadShortcuts();
  }

  // Until the recognizer reports it's actually capturing audio, the bar shows a
  // "starting microphone…" state (spinner) instead of the live recording UI, so it
  // never looks like we're recording before the mic is on.
  function applyMicState() {
    const starting = !paused && !micListening && !micErrorMsg;
    if (panelEl) {
      panelEl.classList.toggle('starting', starting);
      panelEl.classList.toggle('paused', paused);
    }
    if (recLabelEl) {
      recLabelEl.textContent = paused ? 'PAUSED' : micErrorMsg ? '⚠' : micListening ? 'REC' : 'Starting…';
    }
    if (pauseBtnEl) pauseBtnEl.textContent = paused ? '▶' : '⏸';
    refreshTips();
    renderTranscript();
  }

  function destroyOverlay() {
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    hostEl = panelEl = textEl = recLabelEl = shotsEl = miniEl = pauseBtnEl = clearInkEl = penBtnEl = null;
    shootBtnEl = stopBtnEl = shadowEl = null;
  }

  function panelSize() {
    if (!panelEl) return { w: 360, h: 56 };
    const r = panelEl.getBoundingClientRect();
    return { w: r.width || 360, h: r.height || 56 };
  }

  function defaultPos() {
    const { w, h } = panelSize();
    return {
      x: Math.max(8, Math.round((window.innerWidth - w) / 2)),
      y: Math.max(8, window.innerHeight - h - 22),
    };
  }

  function clampPos(p) {
    const { w, h } = panelSize();
    return {
      x: Math.min(Math.max(8, p.x), Math.max(8, window.innerWidth - w - 8)),
      y: Math.min(Math.max(8, p.y), Math.max(8, window.innerHeight - h - 8)),
    };
  }

  function applyPosition() {
    if (!panelEl) return;
    placePanel(clampPos(overlayPos || defaultPos()));
  }

  // near the top of the window, tooltips open below the bar instead of off-screen
  function placePanel(p) {
    panelEl.style.left = p.x + 'px';
    panelEl.style.top = p.y + 'px';
    panelEl.classList.toggle('near-top', p.y < 72);
  }

  function setMinimized(on, skipSave) {
    minimized = !!on;
    if (minimized && penOn()) annotate.setPenMode(false); // its button is hidden when minimized
    if (panelEl) panelEl.classList.toggle('minimized', minimized);
    if (miniEl) miniEl.textContent = minimized ? '+' : '–';
    refreshTips();
    // re-clamp since the size changed
    requestAnimationFrame(applyPosition);
    if (!skipSave) {
      try {
        chrome.storage.local.set({ overlayMin: minimized });
      } catch (e) {
        /* ignore */
      }
    }
  }

  function updateShots() {
    if (shotsEl) shotsEl.textContent = '📸 ' + shotCount;
  }

  function enableDrag(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !panelEl) return;
      dragging = true;
      panelEl.classList.add('dragging');
      const start = panelEl.getBoundingClientRect();
      const offX = e.clientX - start.left;
      const offY = e.clientY - start.top;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      const onMove = (ev) => {
        if (!dragging) return;
        overlayPos = clampPos({ x: ev.clientX - offX, y: ev.clientY - offY });
        placePanel(overlayPos);
      };
      const onUp = (ev) => {
        dragging = false;
        if (panelEl) panelEl.classList.remove('dragging');
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch (_) {
          /* ignore */
        }
        if (overlayPos) {
          try {
            chrome.storage.local.set({ overlayPos });
          } catch (_) {
            /* ignore */
          }
        }
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
      e.preventDefault();
    });
  }

  function renderTranscript() {
    if (!textEl) return;
    const editing = !!(paused && editorSegments);
    textEl.classList.toggle('editing', editing);
    if (editing) {
      renderEditor();
      return;
    }
    if (micErrorMsg) {
      textEl.innerHTML = '<span class="micerror">' + escapeHtml(micErrorMsg) + '</span>';
      return;
    }
    if (!finalText && !interimText) {
      const ph = paused
        ? 'Paused — resume to keep recording'
        : micListening
          ? 'Listening… speak your feedback'
          : micMode === 'page'
            ? 'Starting microphone… if Chrome asks, allow it for this site'
            : 'Starting microphone…';
      textEl.innerHTML = '<span class="placeholder">' + ph + '</span>';
      return;
    }
    const tail = finalText.slice(-400);
    textEl.innerHTML =
      escapeHtml(tail) +
      (interimText ? ' <span class="interim">' + escapeHtml(interimText) + '</span>' : '');
    // keep the most recent words in view (newest at the bottom)
    textEl.scrollTop = textEl.scrollHeight;
  }

  // ------------------------------------------- fix misheard words (paused)

  // Fetch the finalized segments once the mic is off. Waits a beat: the
  // recognizer flushes its last final segment just after it stops.
  function loadEditor() {
    clearTimeout(editorTimer);
    editorTimer = setTimeout(() => {
      ask({ type: MSG.GET_TRANSCRIPT }, (res) => {
        if (!paused || !recording) return;
        editorSegments = (res && res.segments) || [];
        renderTranscript();
      });
    }, 700);
  }

  function closeEditor() {
    clearTimeout(editorTimer);
    // blurring commits whatever segment is mid-edit
    const active = shadowEl && shadowEl.activeElement;
    if (active && active.blur) active.blur();
    editorSegments = null;
    if (textEl) textEl.classList.remove('editing');
  }

  function commitSegment(seg, el) {
    const next = el.textContent.replace(/\s+/g, ' ').trim();
    if (next === seg.text) return;
    const id = seg.id;
    seg.text = next;
    if (!next) editorSegments = (editorSegments || []).filter((s) => s.id !== id);
    ask({ type: MSG.EDIT_TRANSCRIPT, id, text: next }, (res) => {
      if (res && typeof res.transcript === 'string') finalText = res.transcript;
      if (!next) renderTranscript();
    });
    el.classList.add('saved');
    setTimeout(() => el.classList.remove('saved'), 900);
  }

  function renderEditor() {
    // never rebuild under the caret — it would throw away what's being typed
    const active = shadowEl && shadowEl.activeElement;
    if (active && textEl.contains(active)) return;
    textEl.textContent = '';
    const hint = document.createElement('div');
    hint.className = 'edithint';
    hint.textContent = editorSegments.length
      ? '✎ Click any words to fix them · Enter saves · Esc undoes · empty a line to delete it'
      : 'Paused — nothing transcribed yet. Resume to keep recording';
    textEl.appendChild(hint);
    for (const seg of editorSegments) {
      const el = document.createElement('span');
      el.className = 'seg';
      try {
        el.contentEditable = 'plaintext-only';
      } catch (_) {
        el.contentEditable = 'true';
      }
      el.spellcheck = true;
      el.textContent = seg.text;
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          el.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          el.textContent = seg.text;
          el.blur();
        }
      });
      el.addEventListener('blur', () => commitSegment(seg, el));
      textEl.append(el, document.createTextNode(' '));
    }
    textEl.scrollTop = textEl.scrollHeight;
    requestAnimationFrame(applyPosition); // the bar grew — keep it on screen
  }


  // --------------------------------------------------------------- tracking

  function isOurs(e) {
    if (!hostEl) return false;
    if (e.target === hostEl) return true;
    const path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(hostEl) !== -1;
  }

  function addL(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  function onMouseDown(e) {
    if (!recording || isOurs(e) || e.button !== 0 || !cfg.triggers.click || penOn()) return;
    const el = dom.describe(e.target) || dom.describeAtPoint(e.clientX, e.clientY, hostEl);
    // normalized viewport coords so the worker can dedup the area *around* the click
    const cx = window.innerWidth ? e.clientX / window.innerWidth : 0.5;
    const cy = window.innerHeight ? e.clientY / window.innerHeight : 0.5;
    setTimeout(() => {
      if (recording) requestCapture(TRIGGER.CLICK, withPage({ element: el, clickX: cx, clickY: cy }));
    }, cfg.clickCaptureDelayMs);
  }

  function onMouseUp(e) {
    if (!recording || isOurs(e) || !cfg.triggers.selection || penOn()) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const txt = sel ? String(sel).trim() : '';
      if (txt && txt.length >= 2 && txt !== lastSelectionText) {
        lastSelectionText = txt;
        let el = null;
        try {
          const node = sel.anchorNode;
          el = dom.describe(node && node.nodeType === 1 ? node : node && node.parentElement);
        } catch (_) {
          /* ignore */
        }
        requestCapture(TRIGGER.SELECTION, withPage({ selectionText: txt.slice(0, 400), element: el }));
      }
    }, 10);
  }

  function scheduleDwell() {
    if (!cfg.triggers.dwell) return;
    clearTimeout(dwellTimer);
    dwellTimer = setTimeout(() => {
      if (!recording) return;
      const t = now();
      if (t - lastDwellAt < 1200) return;
      if (movedAccum >= cfg.dwellMinMovePx) {
        lastDwellAt = t;
        movedAccum = 0;
        const el = lastMovePoint ? dom.describeAtPoint(lastMovePoint.x, lastMovePoint.y, hostEl) : null;
        requestCapture(TRIGGER.DWELL, withPage({ element: el }));
      }
    }, cfg.dwellMs);
  }

  function onMouseMove(e) {
    if (!recording || dragging || penOn()) return; // a pen stroke isn't a "circling" gesture
    const t = now();
    if (lastMovePoint) {
      movedAccum += Math.hypot(e.clientX - lastMovePoint.x, e.clientY - lastMovePoint.y);
    }
    lastMovePoint = { x: e.clientX, y: e.clientY };

    if (t - lastMoveProcessed >= 30) {
      lastMoveProcessed = t;
      moveBuf.push({ x: e.clientX, y: e.clientY, t });
      const cutoff = t - 1200;
      while (moveBuf.length && moveBuf[0].t < cutoff) moveBuf.shift();

      if (cfg.triggers.circle && moveBuf.length >= 6 && t - lastCircleAt > 1500) {
        const g = gesture.analyzeGesture(moveBuf, cfg);
        if (g.isCircle) {
          lastCircleAt = t;
          movedAccum = 0;
          const el = dom.describeAtPoint(e.clientX, e.clientY, hostEl);
          requestCapture(TRIGGER.CIRCLE, withPage({ element: el }));
        }
      }
    }
    scheduleDwell();
  }

  function onScroll() {
    if (!recording || !cfg.triggers.scroll) return;
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      if (!recording) return;
      const y = window.scrollY || window.pageYOffset || 0;
      if (Math.abs(y - lastScrollCaptureY) >= cfg.scrollMinDeltaPx) {
        lastScrollCaptureY = y;
        requestCapture(TRIGGER.SCROLL, withPage({ scrollY: Math.round(y) }));
      }
    }, cfg.scrollIdleMs);
  }

  function startTracking() {
    addL(document, 'mousedown', onMouseDown, true);
    addL(document, 'mouseup', onMouseUp, true);
    addL(document, 'mousemove', onMouseMove, { passive: true });
    addL(window, 'scroll', onScroll, { passive: true });
  }
  function stopTracking() {
    for (const [target, type, fn, opts] of listeners) {
      try {
        target.removeEventListener(type, fn, opts);
      } catch (_) {
        /* ignore */
      }
    }
    listeners.length = 0;
    clearTimeout(dwellTimer);
    clearTimeout(scrollIdleTimer);
    moveBuf.length = 0;
    lastMovePoint = null;
    movedAccum = 0;
  }

  // ----------------------------------------------------------- route changes

  function onRoute() {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      if (!recording || location.href === lastRouteUrl) return;
      lastRouteUrl = location.href;
      send({ type: MSG.ROUTE_CHANGED, url: location.href, title: document.title });
      setTimeout(() => {
        if (recording && cfg.triggers.route) requestCapture(TRIGGER.ROUTE, withPage({}));
      }, 450);
    }, 250);
  }

  let wrapPush = null;
  let wrapReplace = null;
  function patchHistory() {
    if (origPush) return;
    origPush = history.pushState;
    origReplace = history.replaceState;
    try {
      wrapPush = function () {
        const r = origPush.apply(this, arguments);
        onRoute();
        return r;
      };
      wrapReplace = function () {
        const r = origReplace.apply(this, arguments);
        onRoute();
        return r;
      };
      history.pushState = wrapPush;
      history.replaceState = wrapReplace;
    } catch (_) {
      /* some pages freeze history */
    }
    window.addEventListener('popstate', onRoute);
    window.addEventListener('hashchange', onRoute);
  }

  function unpatchHistory() {
    try {
      // only restore if our wrapper is still installed; if the page re-patched
      // on top of us, leave its wrapper alone (don't clobber the page's router)
      if (origPush && history.pushState === wrapPush) history.pushState = origPush;
      if (origReplace && history.replaceState === wrapReplace) history.replaceState = origReplace;
    } catch (_) {
      /* ignore */
    }
    origPush = origReplace = wrapPush = wrapReplace = null;
    window.removeEventListener('popstate', onRoute);
    window.removeEventListener('hashchange', onRoute);
  }

  // ------------------------------------------------------- speech recognition

  // Inject the extension-origin recognizer iframe. It runs Web Speech using the
  // extension's microphone permission (granted once) and streams transcript to
  // the service worker, which forwards it back here via TRANSCRIPT_UPDATE.
  function startRecognizer() {
    if (recIframe || pageSpeech) return;
    micErrorMsg = '';
    if (micMode === 'blocked') micMode = 'page'; // resuming = retry, the user may have allowed it
    if (micMode === 'page') {
      if (!speechLib) return;
      pageSpeech = speechLib.create({ lang: recLang, source: 'page', post: send });
      pageSpeech.start();
      return;
    }
    try {
      recIframe = document.createElement('iframe');
      recIframe.src =
        chrome.runtime.getURL('src/recognizer/recognizer.html') + '?lang=' + encodeURIComponent(recLang);
      recIframe.allow = 'microphone';
      recIframe.setAttribute('aria-hidden', 'true');
      recIframe.style.cssText =
        'position:fixed;width:1px;height:1px;left:-9999px;top:-9999px;border:0;opacity:0;pointer-events:none;';
      (document.documentElement || document.body).appendChild(recIframe);
    } catch (e) {
      /* ignore */
    }
  }

  function stopRecognizer() {
    if (recIframe && recIframe.parentNode) recIframe.parentNode.removeChild(recIframe);
    recIframe = null;
    if (pageSpeech) pageSpeech.stop(); // graceful: its last final segment still arrives
    pageSpeech = null;
  }

  // The recognizer was refused the mic. From the iframe -> retry with the page's
  // own mic; from the page itself -> tell the user how to unblock this site.
  function onMicRefused(msg) {
    const src = msg.source === 'page' ? 'page' : 'frame';
    const next = speechLib ? speechLib.nextMicMode(src, msg.error || 'not-allowed') : 'blocked';
    if (next === 'page') {
      if (micMode !== 'frame') return; // a late error from an iframe we already replaced
      micMode = 'page';
      stopRecognizer();
      if (recording && !paused) startRecognizer();
    } else if (next === 'blocked') {
      micMode = 'blocked';
      stopRecognizer();
      micErrorMsg =
        '⚠️ Microphone blocked for this site — click the site-settings icon left of the address bar, allow Microphone, then press ⏸ and ▶.';
    }
    applyMicState();
  }

  // ----------------------------------------------------------------- keepalive

  function startKeepalive() {
    try {
      kaPort = chrome.runtime.connect({ name: 'keepalive' });
      kaPort.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        kaPort = null;
      });
    } catch (e) {
      kaPort = null;
    }
    clearInterval(kaTimer);
    kaTimer = setInterval(() => {
      try {
        if (kaPort) kaPort.postMessage({ t: Date.now() });
        else if (recording) startKeepalive();
      } catch (e) {
        kaPort = null;
      }
    }, 20000);
  }

  function stopKeepalive() {
    clearInterval(kaTimer);
    kaTimer = null;
    if (kaPort) {
      try {
        kaPort.disconnect();
      } catch (e) {
        /* ignore */
      }
      kaPort = null;
    }
  }

  // --------------------------------------------------------------- sessions

  function onSessionStarted(msg) {
    if (msg.settings) {
      Object.assign(cfg, msg.settings);
      cfg.triggers = Object.assign({}, DEFAULT_TRIGGERS, msg.settings.triggers || {});
    }
    recording = true;
    paused = !!msg.paused; // a re-arm during a pause stays paused
    micListening = false; // show "starting microphone…" until the recognizer is live
    // a re-armed overlay (followed focus to a new window, or a navigation) gets
    // the transcript so far, so it doesn't look like we lost what you said
    finalText = msg.transcript || '';
    interimText = '';
    micErrorMsg = '';
    shotCount = 0;
    lastSelectionText = '';
    lastScrollCaptureY = window.scrollY || 0;
    lastRouteUrl = location.href;
    recLang = (cfg.language || 'en-US');
    if (cfg.showOverlay !== false) buildOverlay();
    startAnnotate();
    startTracking();
    patchHistory();
    if (!paused) startRecognizer(); // don't turn the mic on if we re-armed while paused
    else loadEditor(); // re-armed while paused -> the transcript is editable here too
    startKeepalive();
    send({ type: MSG.PAGE_INFO, url: location.href, title: document.title });
  }

  function onSessionStopped() {
    recording = false;
    paused = false;
    micListening = false;
    stopRecognizer();
    stopKeepalive();
    stopTracking();
    stopAnnotate();
    unpatchHistory();
    closeEditor();
    destroyOverlay();
    finalText = '';
    interimText = '';
    micErrorMsg = '';
  }

  function onSessionPaused() {
    paused = true;
    micListening = false;
    stopRecognizer(); // turn the mic off while paused
    applyMicState();
    loadEditor(); // ...and let the user fix misheard words meanwhile
  }

  function onSessionResumed() {
    closeEditor(); // commits a segment that's mid-edit
    paused = false;
    micListening = false; // mic restarts -> "starting microphone…" until it's live again
    startRecognizer();
    applyMicState();
  }

  // -------------------------------------------------- "saved" page toast
  // Shown at the top of the page when a recording finishes, so the user knows
  // it's ready even if the extension isn't pinned. Independent of the overlay.
  const TOAST_CSS = `
    :host{ all: initial; }
    .t{ position: fixed; top: 20px; left: 50%; transform: translate(-50%,-22px);
      display:flex; align-items:center; gap:13px; max-width:92vw;
      padding:13px 18px 15px; border-radius:15px;
      background:linear-gradient(180deg, rgba(20,18,24,.96), rgba(14,12,16,.96));
      border:1px solid rgba(255,255,255,.14);
      box-shadow:0 20px 60px -16px rgba(0,0,0,.7), 0 0 0 1px rgba(255,69,58,.18), 0 0 40px -10px rgba(255,69,58,.35);
      backdrop-filter:blur(10px); color:#f4f2ee; opacity:0; pointer-events:auto; cursor:pointer;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      z-index:2147483647; transition:opacity .32s ease, transform .42s cubic-bezier(.2,.9,.25,1); overflow:hidden; }
    .t.in{ opacity:1; transform:translate(-50%,0); }
    .t.out{ opacity:0; transform:translate(-50%,-22px); }
    .ic{ flex:0 0 auto; width:34px; height:34px; border-radius:10px; display:grid; place-items:center;
      background:radial-gradient(circle at 35% 30%, #34d399, #059669); box-shadow:0 4px 14px -4px rgba(16,185,129,.7); }
    .ic svg{ display:block; animation:pop .45s .08s both cubic-bezier(.2,1.6,.4,1); }
    @keyframes pop{ from{ transform:scale(.2); opacity:0 } to{ transform:scale(1); opacity:1 } }
    .tx .h{ font-weight:800; font-size:14.5px; letter-spacing:-.01em; }
    .tx .s{ font-size:12.5px; color:#b9b4ab; margin-top:2px; }
    .tx .s kbd{ font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; background:rgba(255,255,255,.1);
      border:1px solid rgba(255,255,255,.16); border-radius:5px; padding:1px 5px; color:#e7e4dd; }
    .bar{ position:absolute; left:0; bottom:0; height:3px; width:100%;
      background:linear-gradient(90deg,#ff453a,#fb7185); transform-origin:left; animation:deplete 6s linear forwards; }
    @keyframes deplete{ from{ transform:scaleX(1) } to{ transform:scaleX(0) } }`;

  function showSavedToast() {
    try {
      const prev = document.getElementById('__scf_toast_host');
      if (prev) prev.remove();
      const host = document.createElement('div');
      host.id = '__scf_toast_host';
      host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
      const sh = host.attachShadow({ mode: 'open' });
      const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || '');
      sh.innerHTML =
        '<style>' + TOAST_CSS + '</style>' +
        '<div class="t" id="t">' +
        '<div class="ic"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#06281c" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg></div>' +
        '<div class="tx"><div class="h">Instructions copied</div>' +
        '<div class="s">Paste them into your AI — <kbd>' + (isMac ? '⌘V' : 'Ctrl+V') + '</kbd></div></div>' +
        '<div class="bar"></div></div>';
      (document.documentElement || document.body).appendChild(host);
      const t = sh.getElementById('t');
      requestAnimationFrame(() => t.classList.add('in'));
      let done = false;
      const dismiss = () => {
        if (done) return;
        done = true;
        t.classList.remove('in');
        t.classList.add('out');
        setTimeout(() => host.remove(), 460);
      };
      const to = setTimeout(dismiss, 6000);
      t.addEventListener('click', () => {
        clearTimeout(to);
        dismiss();
      });
    } catch (e) {
      /* ignore */
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case MSG.SESSION_STARTED:
        onSessionStarted(msg);
        break;
      case MSG.SESSION_STOPPED:
        onSessionStopped();
        break;
      case MSG.SESSION_PAUSED:
        onSessionPaused();
        break;
      case MSG.SESSION_RESUMED:
        onSessionResumed();
        break;
      case MSG.SAVED_NOTICE:
        showSavedToast();
        break;
      case MSG.RECOGNIZER_STOP:
        // stopping: flush the page-mic recognizer's last words (the iframe gets
        // this message directly from the SW)
        if (pageSpeech) pageSpeech.stop();
        break;
      case MSG.MIC_LISTENING:
        if (!micListening) {
          micListening = true;
          applyMicState();
        }
        break;
      case MSG.TRANSCRIPT_UPDATE:
        if (msg.micError) {
          onMicRefused(msg);
        } else if (msg.final) {
          finalText += (finalText ? ' ' : '') + msg.text;
          interimText = '';
          if (paused) loadEditor(); // the last words flushed in after pausing
          else renderTranscript();
        } else {
          interimText = msg.text;
          renderTranscript();
        }
        break;
      case MSG.SCREENSHOT_TOAST:
        // no flashing toast — just bump the static counter in the bar
        shotCount = msg.seq || shotCount + 1;
        updateShots();
        break;
      case MSG.ANNOTATE_INK_ANY:
        // any frame (this one or an iframe) has a drawing -> show the clear button
        showClearBtn(!!msg.any);
        break;
      case MSG.CLEAR_ANNOTATIONS:
        if (annotate && annotate.clear) annotate.clear();
        break;
      case MSG.TOGGLE_PEN:
        // the draw shortcut (a Chrome command, so it works even with focus in an iframe)
        if (recording && annotate && annotate.setPenMode && cfg.annotate !== false) {
          annotate.setPenMode(!penOn());
        }
        break;
      default:
        break;
    }
  });

  // announce readiness so the SW can re-arm the overlay after a navigation
  send({ type: MSG.CONTENT_READY });
})();
