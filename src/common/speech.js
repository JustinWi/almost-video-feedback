/*
 * Web Speech recognizer for the LAST-RESORT fallback: it runs directly in the
 * top-frame content script, on the page's own microphone permission (Chrome asks
 * once per site). Used only after both the extension-origin iframe and the
 * offscreen document failed on a site — e.g. claude.ai sends
 * `microphone=(self "https://*.claudemcpcontent.com")`, which refuses the iframe.
 * The service worker decides when (see mic-triage.js pageFallback) and tells the
 * content script via REC_MODE. Every message it posts carries src: 'page'.
 *
 * Classic script -> globalThis.SCF_SPEECH; isPermissionError is also exported
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
   * Build a self-restarting continuous recognizer.
   * @param {{lang:string, post:(msg:object)=>void}} opts
   * @returns {{start:()=>void, stop:()=>void}}
   */
  function create(opts) {
    const MSG = root.SCF.MSG;
    const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
    const lang = opts.lang || 'en-US';
    const post = opts.post;
    const src = 'page';

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
        post({ type: MSG.MIC_LISTENING, src });
      };
      r.onaudiostart = () => {
        post({ type: MSG.MIC_LISTENING, src });
      };
      r.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          const text = res[0] && res[0].transcript ? res[0].transcript : '';
          if (res.isFinal) {
            const f = text.trim();
            if (f) post({ type: MSG.TRANSCRIPT_SEGMENT, final: true, text: f, t: Date.now(), src });
          } else {
            interim += text;
          }
        }
        if (interim.trim()) {
          post({ type: MSG.TRANSCRIPT_SEGMENT, final: false, text: interim.trim(), t: Date.now(), src });
        }
      };
      r.onerror = (event) => {
        const err = event.error || 'unknown';
        if (isPermissionError(err) || err === 'audio-capture') wantRunning = false;
        post({ type: MSG.TRANSCRIBE_ERROR, error: err, src });
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
                post({ type: MSG.TRANSCRIBE_ERROR, error: 'restart-failed', src });
              }
            }
          }, 250);
        }
      };
      return r;
    }

    function start() {
      if (!SR) {
        post({ type: MSG.TRANSCRIBE_ERROR, error: 'speech-recognition-unavailable', src });
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

  const api = { isPermissionError, create };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SCF_SPEECH = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
