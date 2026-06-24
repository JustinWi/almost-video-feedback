/*
 * On-page annotation overlay (experimental). A full-viewport canvas painted into
 * the page so the marks show up in the screenshots, with several switchable
 * "modes" for calling out areas while you talk. Classic content script ->
 * globalThis.SCF_ANNOTATE. content.js starts/stops it and switches the mode.
 *
 * The canvas is pointer-events:none (never blocks the page); we read mouse
 * positions from document listeners. Pen mode is the one exception — it
 * suppresses the context menu so a right-drag can draw.
 *
 * Modes (all variations on "let me point at things"):
 *   off        - nothing
 *   comet      - short neon trail that follows the cursor (~0.8s fade)
 *   glow       - longer, thicker trail (~2.4s) so a full circle stays readable
 *   pen        - right-drag draws persistent strokes; double-right-click clears
 *   autocircle - circle the cursor and it draws a fading ring around that area
 *   spotlight  - dims the page except a soft circle around the cursor
 *   ripple     - each left-click emits an expanding ring where you clicked
 */
(function () {
  'use strict';

  const MODES = [
    { id: 'off', label: 'Annotate: off' },
    { id: 'comet', label: 'Comet trail' },
    { id: 'glow', label: 'Glow trail' },
    { id: 'pen', label: 'Pen (right-drag)' },
    { id: 'autocircle', label: 'Auto-circle' },
    { id: 'spotlight', label: 'Spotlight' },
    { id: 'ripple', label: 'Click ripple' },
  ];
  const MODE_IDS = MODES.map((m) => m.id);

  let host = null;
  let canvas = null;
  let ctx = null;
  let dpr = 1;

  let mode = 'off';
  let running = false;
  let rafId = null;
  let color = '#ff2d95';

  // per-mode buffers
  let trail = []; // {x,y,t}
  let strokes = []; // [[{x,y}...]] persistent pen strokes
  let curStroke = null;
  let circles = []; // {x,y,rx,ry,t}
  let ripples = []; // {x,y,t}
  const cursor = { x: -1, y: -1, seen: false };

  // autocircle + pen bookkeeping
  let moveBuf = [];
  let lastCircleAt = 0;
  let lastRightClickAt = 0;
  let rightMoved = 0;

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

  function resetBuffers() {
    trail = [];
    strokes = [];
    curStroke = null;
    circles = [];
    ripples = [];
    moveBuf = [];
    rightMoved = 0;
  }

  // ------------------------------------------------------------- canvas setup

  function sizeCanvas() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
  }

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__scf_annotate_host';
    host.style.cssText =
      'all:initial;position:fixed;left:0;top:0;width:100%;height:100%;margin:0;padding:0;' +
      'pointer-events:none;z-index:2147483646;';
    const sh = host.attachShadow({ mode: 'open' });
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;display:block;';
    sh.appendChild(canvas);
    (document.documentElement || document.body).appendChild(host);
    ctx = canvas.getContext('2d');
    sizeCanvas();
  }

  // ----------------------------------------------------------------- drawing

  function loop() {
    if (!running || mode === 'off') {
      rafId = null;
      return;
    }
    render();
    rafId = requestAnimationFrame(loop);
  }

  function kick() {
    if (running && mode !== 'off' && !rafId) rafId = requestAnimationFrame(loop);
  }

  function render() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const t = nowMs();
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (mode === 'spotlight') renderSpotlight(w, h);
    else if (mode === 'comet' || mode === 'glow') renderTrail(t);
    else if (mode === 'pen') renderStrokes();
    else if (mode === 'autocircle') renderCircles(t);
    else if (mode === 'ripple') renderRipples(t);
  }

  function renderTrail(t) {
    const life = mode === 'glow' ? 2400 : 800;
    const baseW = mode === 'glow' ? 11 : 6;
    const glow = mode === 'glow' ? 18 : 10;
    while (trail.length && t - trail[0].t > life) trail.shift();
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    for (let i = 1; i < trail.length; i++) {
      const p0 = trail[i - 1];
      const p1 = trail[i];
      const a = Math.max(0, 1 - (t - p1.t) / life);
      ctx.globalAlpha = a;
      ctx.lineWidth = baseW * (0.35 + 0.65 * a);
      ctx.shadowBlur = glow * a;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    // bright head
    if (trail.length) {
      const head = trail[trail.length - 1];
      ctx.globalAlpha = 1;
      ctx.shadowBlur = glow;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(head.x, head.y, mode === 'glow' ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  function strokePath(points) {
    if (!points.length) return;
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  function renderStrokes() {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 4;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.globalAlpha = 1;
    for (const s of strokes) strokePath(s);
    if (curStroke) strokePath(curStroke);
    ctx.shadowBlur = 0;
  }

  function renderCircles(t) {
    const life = 2400;
    circles = circles.filter((c) => t - c.t < life);
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.lineWidth = 4;
    for (const c of circles) {
      const a = Math.max(0, 1 - (t - c.t) / life);
      const grow = 1 + 0.08 * (1 - a);
      ctx.globalAlpha = a;
      ctx.shadowBlur = 14 * a;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, c.rx * grow, c.ry * grow, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  function renderRipples(t) {
    const life = 720;
    ripples = ripples.filter((r) => t - r.t < life);
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    for (const r of ripples) {
      const k = (t - r.t) / life;
      const a = Math.max(0, 1 - k);
      ctx.globalAlpha = a;
      ctx.lineWidth = 3;
      ctx.shadowBlur = 12 * a;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 12 + 52 * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  function renderSpotlight(w, h) {
    if (!cursor.seen) return;
    const r = 120;
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(8,10,20,0.55)';
    ctx.fillRect(0, 0, w, h);
    // punch a soft hole where the cursor is
    ctx.globalCompositeOperation = 'destination-out';
    const g = ctx.createRadialGradient(cursor.x, cursor.y, 0, cursor.x, cursor.y, r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.65, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // neon ring on the edge
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  // --------------------------------------------------------------- gestures

  function maybeCircle(t) {
    const g = (typeof globalThis !== 'undefined' ? globalThis : self).SCF_GESTURE;
    if (!g || moveBuf.length < 8 || t - lastCircleAt < 1100) return;
    const res = g.analyzeGesture(moveBuf, { circleMinPathPx: 230, circleRatio: 2.6 });
    if (!res.isCircle) return;
    lastCircleAt = t;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of moveBuf) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    circles.push({
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      rx: Math.max(30, (maxX - minX) / 2 + 16),
      ry: Math.max(26, (maxY - minY) / 2 + 16),
      t,
    });
    moveBuf = [];
    kick();
  }

  // ----------------------------------------------------------------- input

  function onMove(e) {
    const t = nowMs();
    cursor.x = e.clientX;
    cursor.y = e.clientY;
    cursor.seen = true;

    if (mode === 'pen' && curStroke && e.buttons & 2) {
      const last = curStroke[curStroke.length - 1];
      if (last) rightMoved += Math.hypot(e.clientX - last.x, e.clientY - last.y);
      curStroke.push({ x: e.clientX, y: e.clientY });
      return;
    }
    if (mode === 'comet' || mode === 'glow') {
      if (!trail.length || t - trail[trail.length - 1].t >= 16) {
        trail.push({ x: e.clientX, y: e.clientY, t });
      }
    } else if (mode === 'autocircle') {
      moveBuf.push({ x: e.clientX, y: e.clientY, t });
      const cutoff = t - 1000;
      while (moveBuf.length && moveBuf[0].t < cutoff) moveBuf.shift();
      maybeCircle(t);
    }
    kick();
  }

  function onDown(e) {
    if (mode === 'ripple' && e.button === 0) {
      ripples.push({ x: e.clientX, y: e.clientY, t: nowMs() });
      kick();
    } else if (mode === 'pen' && e.button === 2) {
      curStroke = [{ x: e.clientX, y: e.clientY }];
      rightMoved = 0;
      kick();
    }
  }

  function onUp(e) {
    if (mode !== 'pen' || e.button !== 2) return;
    const t = nowMs();
    if (rightMoved < 8) {
      // a right-click, not a drag: double-right-click clears the board
      if (t - lastRightClickAt < 450) {
        strokes = [];
        lastRightClickAt = 0;
      } else {
        lastRightClickAt = t;
      }
      curStroke = null;
    } else {
      if (curStroke && curStroke.length >= 2) strokes.push(curStroke);
      curStroke = null;
    }
    kick();
  }

  function onContextMenu(e) {
    if (mode === 'pen') e.preventDefault(); // so right-drag can draw
  }

  function attach() {
    on(document, 'mousemove', onMove, { passive: true });
    on(document, 'mousedown', onDown, true);
    on(document, 'mouseup', onUp, true);
    on(document, 'contextmenu', onContextMenu, true);
    on(window, 'resize', sizeCanvas, { passive: true });
  }

  // --------------------------------------------------------------- lifecycle

  function setMode(m) {
    const next = MODE_IDS.indexOf(m) === -1 ? 'off' : m;
    mode = next;
    resetBuffers();
    if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    kick();
    return mode;
  }

  function start(initialMode, col) {
    if (col) color = col;
    ensureHost();
    if (!running) {
      running = true;
      attach();
    }
    setMode(initialMode || 'off');
  }

  function stop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    offAll();
    resetBuffers();
    cursor.seen = false;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = canvas = ctx = null;
    mode = 'off';
  }

  const api = { start, stop, setMode, MODES, MODE_IDS };
  const root = typeof globalThis !== 'undefined' ? globalThis : self;
  root.SCF_ANNOTATE = api;
})();
