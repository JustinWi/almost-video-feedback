/*
 * CSS for the in-page overlay, injected into a shadow root so the host page's
 * styles can't touch it (and ours can't touch the page). Classic content script
 * -> globalThis.SCF_OVERLAY_CSS.
 *
 * The panel is a single fixed, draggable, minimizable bar. It is NOT hidden
 * during screenshots (no flicker); minimize it if you want it out of a shot.
 */
(function (root) {
  'use strict';
  root.SCF_OVERLAY_CSS = `
  :host { all: initial; }

  .panel {
    position: fixed;
    left: 0; top: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(820px, 92vw);
    width: max-content;
    background: rgba(17, 24, 39, .82);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: #f9fafb;
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 14px;
    padding: 9px 12px;
    box-shadow: 0 10px 40px rgba(0,0,0,.45);
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    pointer-events: auto;
    user-select: none;
  }

  /* drag handle: the whole left status zone, stretched over the bar's padding so
     it's a full-height target (~115x50px) marked by always-visible grip dots */
  .grip {
    display: flex; align-items: center; gap: 8px;
    flex: 0 0 auto;
    align-self: stretch;
    margin: -9px 0 -9px -12px;
    padding: 9px 6px 9px 8px;
    border-radius: 13px 0 0 13px;
    cursor: grab;
    touch-action: none;
    transition: background .15s ease;
  }
  .grip:hover { background: rgba(255,255,255,.07); }
  .panel.dragging .grip { background: rgba(255,255,255,.12); cursor: grabbing; }
  .panel.dragging { box-shadow: 0 16px 50px rgba(0,0,0,.55); }
  .dots {
    width: 8px; height: 16px; flex: 0 0 auto;
    background-image: radial-gradient(circle, rgba(255,255,255,.9) 1.3px, transparent 1.6px);
    background-size: 4px 5.33px;
    opacity: .45;
    transition: opacity .15s ease;
  }
  .grip:hover .dots, .panel.dragging .dots { opacity: 1; }
  .reclabel { font-size: 11px; font-weight: 700; letter-spacing: .6px; color: #fecdd3; }
  .dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: #f43f5e;
    box-shadow: 0 0 0 0 rgba(244,63,94,.7);
    animation: pulse 1.4s infinite;
    flex: 0 0 auto;
  }
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0 rgba(244,63,94,.7); }
    70%  { box-shadow: 0 0 0 9px rgba(244,63,94,0); }
    100% { box-shadow: 0 0 0 0 rgba(244,63,94,0); }
  }

  /* "starting microphone…" state — a spinner instead of the red REC dot */
  .panel.starting .dot {
    box-sizing: border-box;
    background: transparent;
    border: 2px solid rgba(255,255,255,.22);
    border-top-color: #f59e0b;
    box-shadow: none;
    animation: scfspin .7s linear infinite;
  }
  .panel.starting .reclabel { color: #fcd34d; }
  @keyframes scfspin { to { transform: rotate(360deg); } }

  /* paused state — a static amber dot (no pulse) */
  .panel.paused .dot { background: #f59e0b; box-shadow: none; animation: none; }
  .panel.paused .reclabel { color: #fcd34d; }
  button.pause { font-size: 12px; }
  button.pause:hover { background: rgba(245,158,11,.28); border-color: rgba(245,158,11,.55); }
  .shots { font-size: 11.5px; opacity: .75; }

  .sep { width:1px; height:22px; background: rgba(255,255,255,.14); flex:0 0 auto; }

  .text {
    flex: 1 1 auto;
    min-width: 220px;
    height: 2.7em;        /* ~2 lines; we scroll to the bottom to show the newest words */
    overflow: hidden;
    font-size: 13.5px;
    line-height: 1.35;
    color: #e5e7eb;
    white-space: normal;
  }
  .text .interim { color: #9ca3af; }
  .text .placeholder { color: #9ca3af; font-style: italic; }
  .text .micerror { color: #fca5a5; font-weight: 600; }

  .btns { display:flex; gap:6px; flex:0 0 auto; }
  button {
    all: unset;
    cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 30px; height: 30px;
    font-size: 14px; font-weight: 600;
    color: #f9fafb;
    background: rgba(255,255,255,.10);
    border: 1px solid rgba(255,255,255,.16);
    border-radius: 9px;
    padding: 0 8px;
    transition: background .12s ease, transform .06s ease;
  }
  button:hover { background: rgba(255,255,255,.18); }
  button:active { transform: scale(.94); }
  button.shoot:hover { background: rgba(16,185,129,.30); border-color: rgba(16,185,129,.6); }
  button.stop:hover { background: rgba(244,63,94,.30); border-color: rgba(244,63,94,.6); }

  .mini { font-size: 17px; line-height: 1; }

  /* pen (draw on the page) toggle — neon pink while on */
  button.pen svg, button.clearink svg { display: block; }
  button.pen .ink { stroke: #ff2d95; }
  button.pen:hover { background: rgba(255,45,149,.26); border-color: rgba(255,45,149,.55); }
  button.pen.on,
  button.pen.on:hover {
    background: #ff2d95; border-color: #ff2d95; color: #fff;
    box-shadow: 0 0 0 3px rgba(255,45,149,.28);
  }
  button.pen.on .ink { stroke: #fff; }
  button.clearink:hover { background: rgba(244,63,94,.24); border-color: rgba(244,63,94,.55); }

  /* paused: the transcript turns into editable segments to fix misheard words */
  .text.editing {
    height: auto;
    max-height: 9.6em;
    min-width: 320px;
    overflow-y: auto;
    user-select: text;
    -webkit-user-select: text;
  }
  .edithint { font-size: 11.5px; font-weight: 600; color: #fcd34d; margin-bottom: 3px; }
  .seg {
    cursor: text;
    user-select: text;
    -webkit-user-select: text;
    outline: none;
    border-radius: 4px;
    padding: 0 1px;
    border-bottom: 1px dashed rgba(252,211,77,.45);
    transition: background .5s ease;
  }
  .seg:hover { background: rgba(255,255,255,.08); }
  .seg:focus { background: rgba(252,211,77,.16); border-bottom-color: #fcd34d; color: #fff; }
  .seg.saved { background: rgba(16,185,129,.30); }

  /* clear-drawing button (shown only while a drawing is present) */
  .clearink.is-hidden { display: none !important; }
  .panel.minimized .clearink { display: none !important; }

  /* minimized: just the grip (dot + REC + shots) + expand button */
  .panel.minimized .sep,
  .panel.minimized .text,
  .panel.minimized .btns .pause,
  .panel.minimized .btns .shoot,
  .panel.minimized .btns .pen,
  .panel.minimized .btns .stop { display: none; }
  .panel.minimized { padding: 7px 10px; gap: 8px; }
  .panel.minimized .grip { margin: -7px 0 -7px -10px; padding: 7px 6px 7px 7px; }

  /* instant hover tooltips carrying the keyboard shortcut (text from data-tip);
     above the bar, or below it when the bar sits near the top of the window */
  button[data-tip] { position: relative; }
  button[data-tip]:hover::after {
    content: attr(data-tip);
    position: absolute;
    left: 50%; bottom: calc(100% + 9px);
    transform: translateX(-50%);
    white-space: pre;
    text-align: center;
    padding: 6px 9px;
    border-radius: 8px;
    background: rgba(17,24,39,.97);
    color: #f9fafb;
    font-size: 11.5px; font-weight: 600; line-height: 1.45;
    border: 1px solid rgba(255,255,255,.16);
    box-shadow: 0 8px 24px rgba(0,0,0,.45);
    pointer-events: none;
    z-index: 2;
  }
  .btns button[data-tip]:last-child:hover::after { left: auto; right: 0; transform: none; text-align: right; }
  .panel.near-top button[data-tip]:hover::after { bottom: auto; top: calc(100% + 9px); }
  `;
})(typeof globalThis !== 'undefined' ? globalThis : self);
