/*
 * Web Speech wrapper shared by the two places transcription can run:
 *   - 'frame': the hidden extension-origin recognizer iframe (src/recognizer/*).
 *     Uses the EXTENSION's one-time microphone grant, so most sites never prompt.
 *   - 'page':  directly in the top-frame content script, using the page's own
 *     microphone permission (Chrome asks once per site). The fallback for sites
 *     whose Permissions-Policy only lets their own origin use the mic — e.g.
 *     claude.ai sends `microphone=(self "https://*.claudemcpcontent.com")`, so an
 *     extension iframe can never get the mic there.
 *
 * Classic script -> globalThis.SCF_SPEECH; the pure helpers are also exported
 * for the Node unit tests.
 */
(function (root) {
  'use strict';

  const PERMISSION_ERRORS = ['not-allowed', 'service-not-allowed'];

  /** A recognizer error that means "this context may not use the microphone". */
  function isPermissionError(err) {
    return PERMISSION_ERRORS.indexOf(String(err || '').toLowerCase()) !== -1;
  }

  /**
   * Where to run transcription after an error. A permission error in the iframe
   * falls back to the page; a permission error in the page is final ('blocked').
   * Any other error (no-speech, network, aborted…) keeps the current mode.
   */
  function nextMicMode(mode, err) {
    if (!isPermissionError(err)) return mode;
    return mode === 'frame' ? 'page' : 'blocked';
  }

  /**
   * Build a self-restarting continuous recognizer.
   * @param {{lang:string, source:'frame'|'page', post:(msg:object)=>void}} opts
   * @returns {{start:()=>void, stop:()=>void}}
   */
  function create(opts) {
    const MSG = root.SCF.MSG;
    const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
    const lang = opts.lang || 'en-US';
    const source = opts.source;
    const post = opts.post;

    let recognition = null;
    let wantRunning = false;
    let running = false;
    let restartTimer = null;

    function build() {
      const r = new SR();
      r.continuous = true;
      r.interimResults = true;
      r.lang = lang;
      r.onstart = () => {
        running = true;
        post({ type: MSG.MIC_LISTENING });
      };
      // fires once the user agent actually starts capturing audio — the truest
      // "we're listening now" signal for the overlay
      r.onaudiostart = () => {
        post({ type: MSG.MIC_LISTENING });
      };
      r.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          const text = res[0] && res[0].transcript ? res[0].transcript : '';
          if (res.isFinal) {
            const f = text.trim();
            if (f) post({ type: MSG.TRANSCRIPT_SEGMENT, final: true, text: f, t: Date.now() });
          } else {
            interim += text;
          }
        }
        if (interim.trim()) {
          post({ type: MSG.TRANSCRIPT_SEGMENT, final: false, text: interim.trim(), t: Date.now() });
        }
      };
      r.onerror = (event) => {
        const err = event.error || 'unknown';
        if (isPermissionError(err)) wantRunning = false;
        post({ type: MSG.TRANSCRIBE_ERROR, error: err, source });
      };
      r.onend = () => {
        running = false;
        if (wantRunning) {
          clearTimeout(restartTimer);
          restartTimer = setTimeout(() => {
            if (!wantRunning) return;
            try {
              recognition.start();
            } catch (e) {
              try {
                recognition = build();
                recognition.start();
              } catch (e2) {
                post({ type: MSG.TRANSCRIBE_ERROR, error: 'restart-failed', source });
              }
            }
          }, 250);
        }
      };
      return r;
    }

    function start() {
      if (!SR) {
        post({ type: MSG.TRANSCRIBE_ERROR, error: 'speech-recognition-unavailable', source });
        return;
      }
      wantRunning = true;
      if (running) return;
      if (!recognition) recognition = build();
      try {
        recognition.start();
      } catch (e) {
        /* throws if called while starting */
      }
    }

    // Graceful stop: the recognizer still delivers its last final segment.
    function stop() {
      wantRunning = false;
      clearTimeout(restartTimer);
      if (recognition) {
        try {
          recognition.stop();
        } catch (e) {
          /* ignore */
        }
      }
    }

    return { start, stop };
  }

  const api = { isPermissionError, nextMicMode, create };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SCF_SPEECH = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
