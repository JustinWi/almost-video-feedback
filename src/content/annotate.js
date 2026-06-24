/*
 * On-page drawing while recording (a telestrator). A full-viewport canvas painted
 * into the page so the marks show up in the screenshots. Classic content script
 * -> globalThis.SCF_ANNOTATE.
 *
 * Draw: hold the secondary mouse button and drag.
 *   - Windows/Linux: right-button drag.
 *   - macOS: Control-click + drag (two-finger trackpad drag is reserved for
 *     scrolling, so we use Control-click, which is the Mac "secondary click").
 * A plain secondary click is left alone, so the page's normal context menu still
 * works. Double secondary-click clears the drawing; so does clear().
 *
 * The canvas is pointer-events:none and never blocks the page — we read the mouse
 * from document listeners and only suppress the context menu while actually drawing
 * (or on the 2nd click of a clear).
 */
(function () {
  'use strict';

  const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
  const SECONDARY_LABEL = IS_MAC ? 'Control-click' : 'right-click';
  const DRAG_PX = 8; // movement beyond this is a draw, not a click
  const DOUBLE_MS = 450; // window for a double secondary-click -> clear

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
  let lastMenuAt = 0; // timestamp of the last plain secondary-click (for double-click)

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

  function isSecondaryDown(e) {
    return e.button === 2 || (IS_MAC && e.button === 0 && e.ctrlKey);
  }
  function secondaryHeld(e) {
    return (e.buttons & 2) !== 0 || (IS_MAC && (e.buttons & 1) !== 0 && e.ctrlKey);
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
    if (curStroke) strokePath(curStroke);
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
    const secondary = e.button === 2 || (IS_MAC && e.button === 0 && e.ctrlKey);
    if (!secondary) return;
    if (rightMoved >= DRAG_PX && curStroke && curStroke.length >= 2) {
      strokes.push(curStroke);
      curStroke = null;
      emitInk();
      if (onDraw) {
        try {
          onDraw();
        } catch (_) {
          /* ignore */
        }
      }
    } else {
      // a plain secondary click — the double-click test lives in onContextMenu
      curStroke = null;
    }
    scheduleRender();
  }

  // Double-click-to-clear is detected here, NOT on mouseup: the contextmenu event
  // fires reliably for every secondary click even when a menu is already open,
  // whereas a 2nd mouseup can be swallowed by the open menu (which is why double-
  // click looked like "two single clicks").
  function onContextMenu(e) {
    if (!running) return;
    const t = nowMs();
    if (rightMoved >= DRAG_PX) {
      // we just drew -> swallow the menu; not a click
      e.preventDefault();
      rightMoved = 0;
      lastMenuAt = 0;
      return;
    }
    if (lastMenuAt && t - lastMenuAt < DOUBLE_MS) {
      // 2nd secondary-click in quick succession -> clear (and suppress this menu)
      e.preventDefault();
      lastMenuAt = 0;
      clear();
    } else {
      // 1st secondary-click -> let the page's native menu show
      lastMenuAt = t;
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
  const root = typeof globalThis !== 'undefined' ? globalThis : self;
  root.SCF_ANNOTATE = api;
})();
