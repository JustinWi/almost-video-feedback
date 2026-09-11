/*
 * Pure helpers for the live transcript (finalized spoken segments stored as
 * `{ id, t, type: 'transcript', final: true, text }` events). Used by the service
 * worker to list / fix segments while a recording is paused. Classic script ->
 * globalThis.SCF_TRANSCRIPT; dual-exported for the Node unit tests.
 */
(function (root) {
  'use strict';

  function isFinalSegment(e) {
    return !!(e && e.type === 'transcript' && e.final && e.text);
  }

  /** Finalized segments in timeline order, as `{ id, t, text }`. */
  function finalSegments(events) {
    return (events || []).filter(isFinalSegment).map((e) => ({ id: e.id, t: e.t, text: e.text }));
  }

  /** The running transcript: every finalized segment joined by a space. */
  function joinTranscript(events) {
    return finalSegments(events).map((s) => s.text).join(' ');
  }

  /** Tidy user-edited text: collapse whitespace (incl. newlines) and trim. */
  function normalizeEdit(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  /**
   * Apply one edit to an event list (returns a new array). Empty text removes
   * the segment; an unknown id or a non-transcript event leaves the list as is.
   */
  function applyEdit(events, id, text) {
    const clean = normalizeEdit(text);
    const out = [];
    for (const e of events || []) {
      if (e && e.id === id && isFinalSegment(e)) {
        if (clean) out.push(Object.assign({}, e, { text: clean }));
        continue;
      }
      out.push(e);
    }
    return out;
  }

  const api = { finalSegments, joinTranscript, normalizeEdit, applyEdit };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SCF_TRANSCRIPT = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
