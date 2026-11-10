/*
 * Mic-failure triage (pure logic, dual-exported, unit-tested).
 *
 * A "not-allowed" from Web Speech in the recognizer iframe has three very
 * different causes, each needing a different response:
 *   - the PAGE's Permissions-Policy blocks microphone for embedded frames
 *     (nothing the user can grant fixes it -> run recognition in the offscreen
 *     document instead, which no page policy can touch)
 *   - the EXTENSION's mic permission isn't persistently granted (revoked, or
 *     granted "this time only" via the popup meter -> tell the user exactly
 *     which button to click; a fallback can't prompt and would fail the same way)
 *   - Chrome's speech SERVICE failed even though the mic is fine
 * The recognizer reports what it observed (policyAllowed from the document's
 * permissions policy, permState from navigator.permissions); this classifies
 * that evidence into { kind, fallback }.
 *
 * kind: 'page-blocked' | 'permission' | 'service' | 'no-audio' | 'blocked' | 'timeout' | 'sandboxed' | 'other'
 * fallback: whether the SW should retry recognition in the offscreen document.
 * When the evidence is inconclusive (no permState), fallback doubles as the
 * probe: it succeeds if the page was the blocker, and fails with a precise
 * 'permission' verdict from getUserMedia if the grant was the problem.
 */
(function (root) {
  'use strict';

  function classify(input) {
    const i = input || {};
    const error = String(i.error || '').toLowerCase();
    const src = i.src === 'offscreen' ? 'offscreen' : 'iframe';
    const permKnownBad = i.permState === 'denied' || i.permState === 'prompt';
    const result = (kind, fallback) => ({ kind, fallback: !!fallback && src !== 'offscreen' });

    if (error === 'audio-capture' || error === 'offscreen-no-audio') return result('no-audio', false);

    // The iframe stayed silent: a page sandboxed without allow-scripts loads it
    // but never runs it. The content script reports this, since the iframe can't.
    if (error === 'recognizer-silent') return result('page-blocked', true);

    // The overlay's start-up deadline passed with no live mic from the offscreen
    // doc or the page (e.g. a mic grab that never settles).
    if (error === 'start-timeout') return result('timeout', false);

    // A CSP-sandboxed page (opaque origin) can't hold a mic grant of its own.
    if (error === 'sandboxed-page') return result('sandboxed', false);

    if (error === 'not-allowed' || error === 'service-not-allowed') {
      if (i.policyAllowed === false) return result('page-blocked', true);
      if (permKnownBad) return result('permission', false);
      if (error === 'service-not-allowed') return result('service', true);
      // not-allowed with permission granted/unknown and no policy verdict:
      // ambiguous — let the offscreen attempt disambiguate
      return result('blocked', true);
    }

    // no-speech / network / aborted / restart-failed / unavailable: transient or
    // terminal-but-quiet; the recognizer's own restart loop handles these
    return result('other', false);
  }

  /**
   * Last resort, after the offscreen fallback also failed (e.g. it heard nothing
   * for 7s): may the SW run speech in the recorded page itself, on the SITE's own
   * mic permission (Chrome asks once per site)? Not for a dead speech service,
   * which no host can fix, and never from any other source.
   */
  function pageFallback(verdict, src) {
    if (src !== 'offscreen' || !verdict) return false;
    return ['page-blocked', 'blocked', 'permission', 'no-audio', 'timeout'].indexOf(verdict.kind) !== -1;
  }

  root.SCF = root.SCF || {};
  root.SCF.micTriage = root.SCF.micTriage || { classify, pageFallback };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classify, pageFallback };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
