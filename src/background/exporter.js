/*
 * Build the agent-facing bundle (feedback.md + session.json) from the timeline.
 *
 * Pure module (no chrome/DOM): input is the event array + session meta, output is
 * strings + the list of screenshots to write. Dual-exported so it is unit-testable
 * in Node; in the browser it attaches to globalThis.SCF.exporter.
 *
 * Correlation: each finalized transcript segment is assigned to the single nearest
 * screenshot in time (within MAX_ASSOC_MS). Transcript with no nearby screenshot is
 * rendered inline as a standalone spoken note, in chronological order.
 */
(function () {
  'use strict';

  const MAX_ASSOC_MS = 8000;

  const TRIGGER_LABEL = {
    start: '▶️ Recording started',
    navigation: '🌐 Page loaded',
    route: '🌐 Navigated (in-app)',
    click: '🖱️ Clicked',
    selection: '✏️ Selected text',
    circle: '🔵 Circled / pointed at',
    dwell: '🖱️ Paused on',
    scroll: '📜 Scrolled',
    heartbeat: '⏱️ Periodic snapshot',
    forced: '📸 Manual screenshot',
    frame: '🎞️ Video frame',
  };

  function pad(n, w) {
    return String(n).padStart(w || 2, '0');
  }

  function relTime(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : pad(m) + ':' + pad(sec);
  }

  function fileFor(seq) {
    return 'screenshots/' + pad(seq, 4) + '.png';
  }

  function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    if (m === 0) return sec + 's';
    return m + 'm' + pad(sec) + 's';
  }

  function formatElement(el) {
    if (!el) return '';
    let sel = el.tag ? el.tag.toLowerCase() : '';
    if (el.id) sel += '#' + el.id;
    if (el.classes) {
      const cls = String(el.classes).trim().split(/\s+/).slice(0, 2).join('.');
      if (cls) sel += '.' + cls;
    }
    const bits = [];
    if (sel) bits.push('`' + sel + '`');
    const label = el.text || el.ariaLabel || el.title || '';
    if (label) bits.push('“' + String(label).slice(0, 80) + '”');
    if (el.role) bits.push('(role: ' + el.role + ')');
    return bits.join(' ');
  }

  function instructionHeader(meta) {
    const when = meta && meta.startedAtText ? meta.startedAtText : '';
    return [
      '# UI / UX feedback for an AI coding agent',
      '',
      'A human reviewed a running web app and recorded spoken + visual feedback' +
        (when ? ' on ' + when : '') + '. This file is that review in chronological order.',
      '',
      '**How to use this file:**',
      '1. Read each entry below together with the screenshot it references in `screenshots/`.',
      '2. The quoted text is what the reviewer *said* at that moment — treat it as the' +
        ' feedback / instructions to act on.',
      '3. The screenshot, page URL, and clicked/selected-element metadata tell you *where*' +
        ' the feedback applies. Use them to localize each change in the codebase.',
      '4. Work through every item and implement the requested fixes.',
      '',
    ].join('\n');
  }

  /**
   * @param {Array} events  timeline events ({t,type,...})
   * @param {Object} meta    session meta ({startedAt, endedAt, startedAtText, ...})
   * @returns {{markdown:string, json:string, screenshots:Array<{seq:number,file:string}>}}
   */
  function build(events, meta) {
    meta = meta || {};
    const startedAt = meta.startedAt || (events[0] && events[0].t) || 0;
    const endedAt = meta.endedAt || (events.length ? events[events.length - 1].t : startedAt);

    const screenshots = events
      .filter((e) => e.type === 'screenshot')
      .sort((a, b) => a.t - b.t);
    const transcripts = events
      .filter((e) => e.type === 'transcript' && e.final && e.text && e.text.trim())
      .sort((a, b) => a.t - b.t);

    // assign each transcript to its nearest screenshot in time
    const assigned = new Map(); // seq -> [text...]
    const floating = []; // {t, text}
    for (const tr of transcripts) {
      let best = null;
      let bestDt = Infinity;
      for (const sh of screenshots) {
        const dt = Math.abs(sh.t - tr.t);
        if (dt < bestDt) {
          bestDt = dt;
          best = sh;
        }
      }
      if (best && bestDt <= MAX_ASSOC_MS) {
        if (!assigned.has(best.seq)) assigned.set(best.seq, []);
        assigned.get(best.seq).push(tr.text.trim());
      } else {
        floating.push({ t: tr.t, text: tr.text.trim() });
      }
    }

    // pages visited (in first-seen order)
    const pages = [];
    const seenPages = new Set();
    for (const e of events) {
      const u = e.url;
      if (u && !seenPages.has(u)) {
        seenPages.add(u);
        pages.push({ url: u, title: e.title || '' });
      }
    }

    // ----- markdown -----
    const out = [];
    out.push(instructionHeader(meta));
    out.push('**Session:** ' + (meta.startedAtText || '') +
      ' · duration ' + formatDuration(endedAt - startedAt) +
      ' · ' + screenshots.length + ' screenshots');
    if (pages.length) {
      out.push('');
      out.push('**Pages visited:**');
      for (const p of pages) {
        out.push('- ' + p.url + (p.title ? ' — ' + p.title : ''));
      }
    }
    out.push('\n---\n');

    // chronological render: interleave screenshots + floating transcript
    const blocks = [];
    for (const sh of screenshots) blocks.push({ kind: 'shot', t: sh.t, sh });
    for (const fl of floating) blocks.push({ kind: 'note', t: fl.t, text: fl.text });
    blocks.sort((a, b) => a.t - b.t);

    let currentUrl = null;
    for (const b of blocks) {
      if (b.kind === 'shot') {
        const sh = b.sh;
        if (sh.url && sh.url !== currentUrl) {
          currentUrl = sh.url;
          out.push('## ' + currentUrl + (sh.title ? '  —  ' + sh.title : '') + '\n');
        }
        const label = TRIGGER_LABEL[sh.trigger] || sh.trigger;
        out.push('### [' + relTime(sh.t - startedAt) + '] ' + label);
        const elStr = formatElement(sh.element);
        if (elStr) out.push('**Target:** ' + elStr);
        if (sh.selectionText) out.push('**Selected text:** “' + sh.selectionText.slice(0, 200) + '”');
        const said = assigned.get(sh.seq);
        if (said && said.length) {
          out.push('');
          out.push(said.map((s) => '> ' + s).join('\n> \n'));
        }
        out.push('');
        out.push('![' + (label) + '](' + fileFor(sh.seq) + ')');
        out.push('\n');
      } else {
        out.push('_[' + relTime(b.t - startedAt) + '] spoken:_ ' + b.text + '\n');
      }
    }

    if (screenshots.length === 0 && floating.length === 0) {
      out.push('_(No screenshots or transcript were captured in this session.)_');
    }

    const markdown = out.join('\n');

    // ----- json -----
    const json = JSON.stringify(
      {
        version: 1,
        startedAt,
        endedAt,
        startedAtText: meta.startedAtText || null,
        durationMs: endedAt - startedAt,
        pages,
        screenshots: screenshots.map((sh) => ({
          seq: sh.seq,
          file: fileFor(sh.seq),
          t: sh.t,
          relMs: sh.t - startedAt,
          trigger: sh.trigger,
          url: sh.url || null,
          title: sh.title || null,
          element: sh.element || null,
          selectionText: sh.selectionText || null,
          scrollY: sh.scrollY != null ? sh.scrollY : null,
          spoken: assigned.get(sh.seq) || [],
        })),
        transcript: transcripts.map((tr) => ({
          t: tr.t,
          relMs: tr.t - startedAt,
          text: tr.text.trim(),
        })),
      },
      null,
      2
    );

    return {
      markdown,
      json,
      screenshots: screenshots.map((sh) => ({ seq: sh.seq, file: fileFor(sh.seq) })),
    };
  }

  const api = { build, relTime, formatElement, formatDuration, fileFor, TRIGGER_LABEL };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    const root = typeof globalThis !== 'undefined' ? globalThis : self;
    root.SCF = root.SCF || {};
    root.SCF.exporter = api;
  }
})();
