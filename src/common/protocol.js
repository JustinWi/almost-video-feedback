/*
 * Shared message protocol + small constants.
 * Loaded as a classic script in every context (service worker via importScripts,
 * content script via the content_scripts list, and pages via <script>).
 * Attaches a single namespace to globalThis so all realms agree on the strings.
 */
(function (root) {
  'use strict';

  const MSG = {
    // content -> service worker
    CONTENT_READY: 'content_ready',
    REQUEST_CAPTURE: 'request_capture',
    PAGE_INFO: 'page_info',
    ROUTE_CHANGED: 'route_changed',
    PREPARE_CAPTURE_ACK: 'prepare_capture_ack',

    // service worker -> content
    SESSION_STARTED: 'session_started',
    SESSION_STOPPED: 'session_stopped',
    SAVED_NOTICE: 'saved_notice',
    PREPARE_CAPTURE: 'prepare_capture',
    CAPTURE_DONE: 'capture_done',
    TRANSCRIPT_UPDATE: 'transcript_update',
    SCREENSHOT_TOAST: 'screenshot_toast',
    STATUS: 'status',

    // popup/options <-> service worker
    GET_STATE: 'get_state',
    START_RECORDING: 'start_recording',
    STOP_RECORDING: 'stop_recording',
    COPY_LAST: 'copy_last',
    CHECK_MIC: 'check_mic',
    OPEN_PERMISSION: 'open_permission',
    FORCE_SHOT: 'force_shot',

    // service worker <-> offscreen
    OFFSCREEN_READY: 'offscreen_ready',
    OFFSCREEN_START: 'offscreen_start',
    OFFSCREEN_STOP: 'offscreen_stop',

    // service worker <-> recognizer iframe (Web Speech at the extension origin)
    RECOGNIZER_STOP: 'recognizer_stop',
    TRANSCRIPT_SEGMENT: 'transcript_segment',
    TRANSCRIBE_ERROR: 'transcribe_error',
    COPY_TO_CLIPBOARD: 'copy_to_clipboard',
    KEEPALIVE: 'keepalive',
  };

  // Screenshot trigger types. Priority triggers bypass the dedup cull.
  const TRIGGER = {
    START: 'start',
    NAVIGATION: 'navigation',
    ROUTE: 'route',
    CLICK: 'click',
    SELECTION: 'selection',
    CIRCLE: 'circle',
    DWELL: 'dwell',
    SCROLL: 'scroll',
    HEARTBEAT: 'heartbeat',
    FORCED: 'forced',
  };

  // Priority triggers bypass the dedup cull: deliberate, high-intent actions the
  // user expects to capture. A click is intentional and often produces a small UI
  // change the coarse 9x8 dedup hash can't see, so it must never be culled.
  // (Ambient triggers — dwell/scroll/heartbeat — stay cullable to avoid spam.)
  const PRIORITY_TRIGGERS = new Set([
    TRIGGER.START,
    TRIGGER.NAVIGATION,
    TRIGGER.ROUTE,
    TRIGGER.CLICK,
    TRIGGER.SELECTION,
    TRIGGER.CIRCLE,
    TRIGGER.FORCED,
  ]);

  // Merge into the shared namespace without clobbering modules that may have
  // attached first (robust to importScripts/<script> load order).
  root.SCF = root.SCF || {};
  root.SCF.MSG = root.SCF.MSG || MSG;
  root.SCF.TRIGGER = root.SCF.TRIGGER || TRIGGER;
  root.SCF.PRIORITY_TRIGGERS = root.SCF.PRIORITY_TRIGGERS || PRIORITY_TRIGGERS;

  // Dual-export for Node unit tests (see test/run.cjs).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MSG, TRIGGER, PRIORITY_TRIGGERS };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
