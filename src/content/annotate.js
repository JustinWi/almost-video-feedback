/*
 * On-page drawing while recording (a telestrator). A full-viewport canvas painted
 * into the page so the marks show up in the screenshots. Classic content script
 * -> globalThis.SCF_ANNOTATE.
 *
 * Draw: a right-button drag (Windows/Linux/Mac mouse), OR a Control+Option+left
 * drag (the safe combo on a Mac trackpad — two-finger drag is scrolling and plain
 * Control-click is the OS secondary-click; Control+Option also works elsewhere).
 * A plain right-click / Control-click still opens the page's normal menu. Clearing:
 * double the draw gesture (double right-click, or double Control+Option-click), or
 * clear().
 *
 * The canvas is pointer-events:none and never blocks the page — we read the mouse
 * from document listeners and only suppress the context menu while actually drawing,
 * for the Control+Option modifier, or on the 2nd click of a clear.
 */
(function () {
  'use strict';
  const root = typeof globalThis !== 'undefined' ? globalThis : self;
  if (root.SCF_ANNOTATE) return; // already injected in this frame (top frame loads it twice)

  const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
  // Draw gesture: right-button drag everywhere, plus Control+Option+left drag (the
  // safe, intuitive combo on a Mac — plain Control-click stays the native menu, and
  // it doesn't collide with Control+scroll zoom). Control+Option also works on
  // Windows/Linux as an alternative to right-drag.
  const SECONDARY_LABEL = IS_MAC ? 'Control-Option-click' : 'right-click';
  const DRAG_PX = 8; // movement beyond this is a draw, not a click
  const DOUBLE_MS = 450; // window for a double tap -> clear

  let host = null;
  let shadow = null;
  let canvas = null;
  let ctx = null;
  let dpr = 1;

  let running = false;
  let color = '#ff2d95';
  let rafId = null;

  let strokes = []; // committed: [[{x,y}...]]
  let curStroke = null;
  let rightMoved = 0;
  let lastMenuAt = 0; // last right-click tap (double-right-click clear, via contextmenu)
  let lastTapAt = 0; // last Control+Option tap (double-tap clear, via mouseup)

  let hintEl = null;
  let hintTimer = null;

  let onInk = null; // (hasInk:boolean) => void
  let onDraw = null; // () => void, a stroke was just committed

  const nowMs = () => performance.now();
  const handlers = [];

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    handlers.push([target, type, fn, opts]);
  }
  function offAll() {
    for (const [t, ty, fn, o] of handlers) {
      try {
        t.removeEventListener(ty, fn, o);
      } catch (_) {
        /* ignore */
      }
    }
    handlers.length = 0;
  }

  function isCtrlOptLeft(e) {
    return e.button === 0 && e.ctrlKey && e.altKey;
  }
  function isSecondaryDown(e) {
    return e.button === 2 || isCtrlOptLeft(e);
  }
  function secondaryHeld(e) {
    return (e.buttons & 2) !== 0 || ((e.buttons & 1) !== 0 && e.ctrlKey && e.altKey);
  }

  // ------------------------------------------------------------- canvas setup

  function sizeCanvas() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scheduleRender();
  }

  const HINT_CSS =
    '.scf-hint{position:absolute;transform:translate(-50%,-100%);padding:5px 10px;border-radius:8px;' +
    'background:rgba(17,24,39,.92);color:#fff;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,' +
    '"Segoe UI",Roboto,Helvetica,Arial,sans-serif;white-space:nowrap;box-shadow:0 6px 20px rgba(0,0,0,.4);' +
    'border:1px solid rgba(255,45,149,.55);opacity:0;transition:opacity .25s ease;pointer-events:none;}' +
    '.scf-hint.in{opacity:1;}';

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__scf_annotate_host';
    host.style.cssText =
      'all:initial;position:fixed;left:0;top:0;width:100%;height:100%;margin:0;padding:0;' +
      'pointer-events:none;z-index:2147483646;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = HINT_CSS;
    shadow.appendChild(style);
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;display:block;';
    shadow.appendChild(canvas);
    (document.documentElement || document.body).appendChild(host);
    ctx = canvas.getContext('2d');
    sizeCanvas();
  }

  // --------------------------------------------------------------- rendering

  function scheduleRender() {
    if (!running || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      render();
    });
  }

  function strokePath(points) {
    if (!points.length) return;
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  function render() {
    if (!ctx) return;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 4;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    for (const s of strokes) strokePath(s);
    // don't paint a 1-point in-progress stroke — a tap/click shouldn't leave a dot
    if (curStroke && curStroke.length >= 2) strokePath(curStroke);
    ctx.shadowBlur = 0;
  }

  // ------------------------------------------------------------------- hint

  function hideHint() {
    if (hintTimer) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
    hintEl = null;
  }

  // Flash a fading message above the most recent stroke.
  function flashHint(text) {
    if (!shadow) return;
    hideHint();
    const s = strokes.length ? strokes[strokes.length - 1] : curStroke;
    let cx = window.innerWidth / 2;
    let top = window.innerHeight / 2;
    if (s && s.length) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      for (const p of s) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
      }
      cx = (minX + maxX) / 2;
      top = minY;
    }
    hintEl = document.createElement('div');
    hintEl.className = 'scf-hint';
    hintEl.textContent = text;
    hintEl.style.left = Math.round(cx) + 'px';
    hintEl.style.top = Math.max(10, Math.round(top) - 12) + 'px';
    shadow.appendChild(hintEl);
    const el = hintEl;
    requestAnimationFrame(() => {
      if (el === hintEl) el.classList.add('in');
    });
    hintTimer = setTimeout(() => {
      if (el === hintEl) el.classList.remove('in');
      setTimeout(() => {
        if (el === hintEl) hideHint();
      }, 600);
    }, 2200);
  }

  // Show the "double-click to clear" hint for the first few drawings ever. The
  // counter is shared storage so the budget is roughly global across frames.
  function maybeHint() {
    try {
      chrome.storage.local.get('annotHintsLeft', (got) => {
        let left = got && typeof got.annotHintsLeft === 'number' ? got.annotHintsLeft : 3;
        if (left <= 0) return;
        left -= 1;
        flashHint('Double ' + SECONDARY_LABEL + ' to clear');
        try {
          chrome.storage.local.set({ annotHintsLeft: left });
        } catch (e) {
          /* ignore */
        }
      });
    } catch (e) {
      /* ignore */
    }
  }

  // ----------------------------------------------------------------- input

  function emitInk() {
    if (onInk) {
      try {
        onInk(strokes.length > 0);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function onDown(e) {
    if (!running || !isSecondaryDown(e)) return;
    curStroke = [{ x: e.clientX, y: e.clientY }];
    rightMoved = 0;
    scheduleRender();
  }

  function onMove(e) {
    if (!running || !curStroke) return;
    if (!secondaryHeld(e)) {
      // button released off-window: drop the in-progress stroke
      curStroke = null;
      scheduleRender();
      return;
    }
    const last = curStroke[curStroke.length - 1];
    if (last) rightMoved += Math.hypot(e.clientX - last.x, e.clientY - last.y);
    curStroke.push({ x: e.clientX, y: e.clientY });
    scheduleRender();
  }

  function onUp(e) {
    if (!running) return;
    if (e.button !== 2 && !isCtrlOptLeft(e)) return;
    if (rightMoved >= DRAG_PX && curStroke && curStroke.length >= 2) {
      strokes.push(curStroke);
      curStroke = null;
      emitInk();
      maybeHint();
      if (onDraw) {
        try {
          onDraw();
        } catch (_) {
          /* ignore */
        }
      }
    } else {
      curStroke = null;
      // A Control+Option tap doesn't open a menu (we suppress it), so mouseup is
      // reliable — detect the double-tap-to-clear here. (Right-clicks are handled
      // in onContextMenu, since an open native menu can swallow the 2nd mouseup.)
      if (isCtrlOptLeft(e)) {
        const t = nowMs();
        if (lastTapAt && t - lastTapAt < DOUBLE_MS) {
          lastTapAt = 0;
          clear();
        } else {
          lastTapAt = t;
        }
      }
    }
    scheduleRender();
  }

  function onContextMenu(e) {
    if (!running) return;
    // Control+Option is our draw modifier -> never show a menu for it (clearing is
    // handled on mouseup). A plain Control-click (no Option) still gets the menu.
    if (e.ctrlKey && e.altKey) {
      e.preventDefault();
      return;
    }
    const t = nowMs();
    if (rightMoved >= DRAG_PX) {
      e.preventDefault(); // we just drew -> swallow the menu
      rightMoved = 0;
      lastMenuAt = 0;
      return;
    }
    // Double right-click clears. Detected here (not mouseup): contextmenu fires
    // reliably for each right-click even when a menu is already open.
    if (lastMenuAt && t - lastMenuAt < DOUBLE_MS) {
      e.preventDefault();
      lastMenuAt = 0;
      clear();
    } else {
      lastMenuAt = t; // 1st right-click -> let the native menu show
    }
  }

  function attach() {
    on(document, 'mousedown', onDown, true);
    on(document, 'mousemove', onMove, { passive: true });
    on(document, 'mouseup', onUp, true);
    on(document, 'contextmenu', onContextMenu, true);
    on(window, 'resize', sizeCanvas, { passive: true });
  }

  // --------------------------------------------------------------- lifecycle

  function clear() {
    strokes = [];
    curStroke = null;
    hideHint();
    if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    emitInk();
    scheduleRender();
  }

  function start(col) {
    if (col) color = col;
    ensureHost();
    if (!running) {
      running = true;
      attach();
    }
    scheduleRender();
  }

  function stop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    offAll();
    hideHint();
    strokes = [];
    curStroke = null;
    lastMenuAt = 0;
    lastTapAt = 0;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = shadow = canvas = ctx = null;
  }

  const api = {
    start,
    stop,
    clear,
    flashHint,
    IS_MAC,
    SECONDARY_LABEL,
    onInkChange(fn) {
      onInk = fn;
    },
    onAnnotated(fn) {
      onDraw = fn;
    },
    hasInk() {
      return strokes.length > 0;
    },
  };
  root.SCF_ANNOTATE = api;

  // ----------------------------------------------------- sub-frame bootstrap
  // In an iframe there is no overlay / content.js, so wire the drawing layer
  // straight to the service worker: start/stop with the session, report ink, and
  // request a capture after a drawing. The top frame is driven by content.js.
  if (window.top !== window.self) {
    const SCF = root.SCF || {};
    const MSG = SCF.MSG || {};
    const TRIGGER = SCF.TRIGGER || {};
    let capTimer = null;
    const sx = (m) => {
      try {
        chrome.runtime.sendMessage(m, () => void chrome.runtime.lastError);
      } catch (e) {
        /* SW not ready */
      }
    };

    api.onInkChange((has) => sx({ type: MSG.ANNOTATE_INK, hasInk: has }));
    api.onAnnotated(() => {
      clearTimeout(capTimer);
      capTimer = setTimeout(() => {
        sx({ type: MSG.REQUEST_CAPTURE, trigger: TRIGGER.ANNOTATE, meta: { url: location.href, title: document.title } });
      }, 600);
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === MSG.SESSION_STARTED) {
        if (!msg.settings || msg.settings.annotate !== false) {
          api.start(msg.settings && msg.settings.annotateColor);
        }
      } else if (msg.type === MSG.SESSION_STOPPED) {
        api.stop();
      } else if (msg.type === MSG.CLEAR_ANNOTATIONS) {
        api.clear();
      }
    });

    // we may have loaded after the session already started -> ask the SW
    sx({ type: MSG.ANNOTATE_READY });
  }
})();
