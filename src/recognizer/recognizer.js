/*
 * Web Speech transcription, running inside the extension-origin iframe that the
 * content script injects into the page. Because this document is the extension
 * origin, it uses the EXTENSION's microphone permission (granted once, e.g. via
 * the popup), so the user is never prompted per website.
 *
 * Auto-starts on load (the content script only injects it during a live session)
 * and streams results to the service worker, which forwards them to the overlay.
 * The recognizer itself lives in src/common/speech.js (shared with the content
 * script's page-origin fallback).
 */
(function () {
  'use strict';
  const MSG = self.SCF.MSG;

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

  const speech = self.SCF_SPEECH.create({ lang, source: 'frame', post });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.RECOGNIZER_STOP) speech.stop();
  });

  speech.start();
})();
