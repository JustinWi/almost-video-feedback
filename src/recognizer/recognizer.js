/*
 * Web Speech transcription, running inside the extension-origin iframe that the
 * content script injects into the page. Because this document is the extension
 * origin, it uses the EXTENSION's microphone permission (granted once, e.g. via
 * the popup), so the user is never prompted per website.
 *
 * Auto-starts on load (the content script only injects it during a live session)
 * and streams results to the service worker, which forwards them to the overlay.
 */
(function () {
  'use strict';
  const MSG = self.SCF.MSG;
  const SR = self.SpeechRecognition || self.webkitSpeechRecognition;

  let recognition = null;
  let wantRunning = false;
  let running = false;
  let restartTimer = null;
  let lang = 'en-US';
  try {
    lang = new URLSearchParams(location.search).get('lang') || 'en-US';
  } catch (e) {
    /* ignore */
  }

  function post(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (e) {
      /* SW asleep */
    }
  }

  function build() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.onstart = () => {
      running = true;
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
      if (err === 'not-allowed' || err === 'service-not-allowed') wantRunning = false;
      post({ type: MSG.TRANSCRIBE_ERROR, error: err });
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
              post({ type: MSG.TRANSCRIBE_ERROR, error: 'restart-failed' });
            }
          }
        }, 250);
      }
    };
    return r;
  }

  function start() {
    if (!SR) {
      post({ type: MSG.TRANSCRIBE_ERROR, error: 'speech-recognition-unavailable' });
      return;
    }
    wantRunning = true;
    if (running) return;
    if (!recognition) recognition = build();
    recognition.lang = lang;
    try {
      recognition.start();
    } catch (e) {
      /* throws if called while starting */
    }
  }

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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.RECOGNIZER_STOP) stop();
  });

  start();
})();
