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

  .grip {
    display: flex; align-items: center; gap: 8px;
    flex: 0 0 auto;
    cursor: grab;
    touch-action: none;
    padding-right: 2px;
  }
  .grip:active { cursor: grabbing; }
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

  /* clear-drawing button (shown only while a drawing is present) */
  .clearink.is-hidden { display: none !important; }
  .panel.minimized .clearink { display: none !important; }

  /* minimized: just the grip (dot + timer + shots) + expand button */
  .panel.minimized .sep,
  .panel.minimized .text,
  .panel.minimized .btns .shoot,
  .panel.minimized .btns .stop { display: none; }
  .panel.minimized { padding: 7px 10px; gap: 8px; }
  `;
})(typeof globalThis !== 'undefined' ? globalThis : self);
