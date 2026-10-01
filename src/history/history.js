(function () {
  'use strict';
  const store = self.SCF.sessionStore;
  const exporter = self.SCF.exporter;
  const ZIP = self.SCF_ZIP;
  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
    );
  }
  function pad(n) {
    return String(n).padStart(2, '0');
  }
  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    return m ? m + 'm' + pad(s % 60) + 's' : s + 's';
  }
  function stamp(ms) {
    const d = new Date(ms);
    return (
      d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
    );
  }
  function clipFor(rec) {
    const path = rec.mdPath
      ? rec.mdPath
      : rec.dir
        ? 'in your Downloads folder at ' + rec.dir + '/feedback.md'
        : '(feedback.md in the shared zip / your Downloads/ai-feedback folder)';
    return exporter.promptText(path, rec.purpose);
  }
  function elText(el) {
    if (!el) return '';
    let sel = el.tag ? el.tag.toLowerCase() : '';
    if (el.id) sel += '#' + el.id;
    if (el.classes) {
      const c = String(el.classes).trim().split(/\s+/).slice(0, 2).join('.');
      if (c) sel += '.' + c;
    }
    const label = el.text || el.ariaLabel || el.title || '';
    return (sel ? '<code>' + esc(sel) + '</code>' : '') + (label ? ' “' + esc(label.slice(0, 80)) + '”' : '');
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---- per-session structured data (reuse the exporter's correlation) ----
  function metaFor(rec) {
    return {
      startedAt: rec.startedAt, endedAt: rec.endedAt, startedAtText: rec.startedAtText,
      source: rec.source || null, purpose: rec.purpose,
    };
  }
  function structured(rec) {
    const meta = metaFor(rec);
    const bundle = exporter.build(rec.events || [], meta);
    return { bundle, json: JSON.parse(bundle.json) };
  }

  async function buildBody(rec, bodyEl) {
    const { json } = structured(rec);
    const shots = await store.getHistoryShots(rec.id);
    const urlBySeq = {};
    const urls = [];
    for (const s of shots) {
      const u = URL.createObjectURL(s.blob);
      urlBySeq[s.seq] = u;
      urls.push(u);
    }
    bodyEl._urls = urls;

    const selected = new Set();
    let lastIdx = -1;
    const figures = [];

    // selection toolbar
    let selBar = null;
    if (json.screenshots.length) {
      selBar = document.createElement('div');
      selBar.className = 'sel-bar';
      selBar.innerHTML =
        '<label><input type="checkbox" class="sel-all" /> Select all</label>' +
        '<span class="sel-hint muted">tip: click a screenshot to select · shift-click for a range</span>' +
        '<span class="sel-count"></span><span class="sel-spacer"></span>' +
        '<button class="sel-del btn danger" disabled>🗑 Delete selected</button>';
      bodyEl.appendChild(selBar);
    }

    const grid = document.createElement('div');
    grid.className = 'shots-grid';
    for (const sh of json.screenshots) {
      const fig = document.createElement('figure');
      fig.dataset.seq = sh.seq;
      const url = urlBySeq[sh.seq];
      const spoken = (sh.spoken || []).map((s) => '<div>“' + esc(s) + '”</div>').join('');
      fig.innerHTML =
        '<input type="checkbox" class="sel-cb" tabindex="-1" aria-label="select screenshot" />' +
        (url ? '<img src="' + url + '" loading="lazy" />' : '') +
        '<figcaption>' +
        '<div class="cap-head"><span class="cap-time">' + esc(exporter.relTime(sh.relMs)) + '</span>' +
        '<span>' + esc((exporter.TRIGGER_LABEL[sh.trigger] || sh.trigger)) + '</span></div>' +
        (sh.element ? '<div class="cap-el">' + elText(sh.element) + '</div>' : '') +
        (sh.selectionText ? '<div class="cap-el">selected: “' + esc(sh.selectionText.slice(0, 120)) + '”</div>' : '') +
        (spoken ? '<div class="spoken">' + spoken + '</div>' : '') +
        '</figcaption>';
      const img = fig.querySelector('img');
      if (img && url) {
        img.addEventListener('click', (e) => {
          e.stopPropagation(); // image opens full-size; doesn't toggle selection
          window.open(url, '_blank');
        });
      }
      grid.appendChild(fig);
      figures.push(fig);
    }
    if (!json.screenshots.length) {
      const none = document.createElement('div');
      none.className = 'muted';
      none.textContent = 'No screenshots in this session.';
      grid.appendChild(none);
    }
    bodyEl.appendChild(grid);

    // ---- selection wiring ----
    function syncSel() {
      for (const fig of figures) {
        const on = selected.has(Number(fig.dataset.seq));
        fig.classList.toggle('selected', on);
        const cb = fig.querySelector('.sel-cb');
        if (cb) cb.checked = on;
      }
      if (!selBar) return;
      const n = selected.size;
      selBar.querySelector('.sel-count').textContent = n ? n + ' selected' : '';
      selBar.querySelector('.sel-del').disabled = n === 0;
      const all = selBar.querySelector('.sel-all');
      all.checked = n > 0 && n === figures.length;
      all.indeterminate = n > 0 && n < figures.length;
    }
    grid.addEventListener('click', (e) => {
      if (e.target.tagName === 'IMG') return;
      const fig = e.target.closest('figure');
      if (!fig) return;
      const seq = Number(fig.dataset.seq);
      const idx = figures.indexOf(fig);
      if (e.shiftKey && lastIdx >= 0) {
        const a = Math.min(lastIdx, idx);
        const b = Math.max(lastIdx, idx);
        const turnOn = !selected.has(seq);
        for (let i = a; i <= b; i++) {
          const s = Number(figures[i].dataset.seq);
          if (turnOn) selected.add(s); else selected.delete(s);
        }
      } else {
        if (selected.has(seq)) selected.delete(seq); else selected.add(seq);
        lastIdx = idx;
      }
      syncSel();
    });
    if (selBar) {
      selBar.querySelector('.sel-all').addEventListener('change', (e) => {
        selected.clear();
        if (e.target.checked) figures.forEach((f) => selected.add(Number(f.dataset.seq)));
        syncSel();
      });
      selBar.querySelector('.sel-del').addEventListener('click', () =>
        deleteSelected(rec, bodyEl, Array.from(selected))
      );
    }

    // ---- editable transcript (fix mis-hearings) ----
    const transcripts = (rec.events || [])
      .filter((e) => e.type === 'transcript' && e.final && e.text != null)
      .sort((a, b) => a.t - b.t);

    const tHead = document.createElement('div');
    tHead.className = 'tx-head';
    tHead.innerHTML =
      '<span class="section-title" style="margin:0">Transcript</span>' +
      '<span class="tx-hint">edit any line to fix what was misheard, then Save</span>';
    if (transcripts.length) {
      // the whole transcript as text, for pasting or keeping as a file
      const txCopy = document.createElement('button');
      txCopy.className = 'btn tx-action';
      txCopy.textContent = '📋 Copy transcript';
      const txSave = document.createElement('button');
      txSave.className = 'btn tx-action';
      txSave.textContent = '⬇ Download .md';
      txCopy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(exporter.transcriptMarkdown(rec.events || [], metaFor(rec)));
          toast('Transcript copied');
        } catch (e) {
          toast('Copy failed');
        }
      });
      txSave.addEventListener('click', () => {
        const md = exporter.transcriptMarkdown(rec.events || [], metaFor(rec));
        const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'transcript-' + stamp(rec.startedAt) + '.md';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast('Saved ' + a.download + ' to Downloads');
      });
      tHead.append(txCopy, txSave);
    }
    bodyEl.appendChild(tHead);

    if (!transcripts.length) {
      const none = document.createElement('div');
      none.className = 'transcript';
      none.textContent = '(no speech was transcribed)';
      bodyEl.appendChild(none);
    } else {
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn primary tx-save';
      saveBtn.textContent = 'Save transcript';
      saveBtn.disabled = true;

      const editor = document.createElement('div');
      editor.className = 'tx-editor';
      transcripts.forEach((tr, idx) => {
        const row = document.createElement('div');
        row.className = 'tx-row';
        const time = document.createElement('span');
        time.className = 'tx-time';
        time.textContent = exporter.relTime(tr.t - rec.startedAt);
        const ta = document.createElement('textarea');
        ta.className = 'tx-input';
        ta.rows = 1;
        ta.value = tr.text;
        ta.dataset.key = tr.id != null ? 'id:' + tr.id : 'ix:' + idx;
        ta.addEventListener('input', () => {
          autoGrow(ta);
          saveBtn.disabled = false;
        });
        row.append(time, ta);
        editor.appendChild(row);
      });
      bodyEl.appendChild(editor);
      editor.querySelectorAll('.tx-input').forEach(autoGrow);

      saveBtn.addEventListener('click', async () => {
        const byKey = {};
        transcripts.forEach((tr, idx) => {
          byKey[tr.id != null ? 'id:' + tr.id : 'ix:' + idx] = tr;
        });
        editor.querySelectorAll('.tx-input').forEach((inp) => {
          const ev = byKey[inp.dataset.key];
          if (ev) ev.text = inp.value.trim();
        });
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        await store.saveHistory(rec); // transcripts are refs into rec.events, so this persists the edits
        const card = bodyEl.closest('.card');
        if (card) card._rec = rec;
        revokeBody(bodyEl);
        await buildBody(rec, bodyEl);
        toast('Transcript saved');
      });
      bodyEl.appendChild(saveBtn);
    }

    if (rec.mdPath) {
      const p = document.createElement('code');
      p.className = 'path';
      p.textContent = rec.mdPath;
      bodyEl.appendChild(p);
    }
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  }

  function revokeBody(bodyEl) {
    if (bodyEl && bodyEl._urls) {
      bodyEl._urls.forEach((u) => URL.revokeObjectURL(u));
      bodyEl._urls = null;
    }
    if (bodyEl) bodyEl.innerHTML = '';
  }

  async function shareOrDownload(blob, filename) {
    try {
      const file = new File([blob], filename, { type: 'application/zip' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Almost Video Feedback',
          text: 'UI feedback bundle for an AI coding agent.',
        });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user dismissed the share sheet
      // otherwise fall through to download
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Saved ' + filename + ' to Downloads');
  }

  async function shareSession(rec, btn) {
    const orig = btn.textContent;
    btn.textContent = 'Zipping…';
    btn.disabled = true;
    try {
      const { bundle } = structured(rec);
      const shots = await store.getHistoryShots(rec.id);
      const bySeq = {};
      shots.forEach((s) => (bySeq[s.seq] = s));
      const entries = [
        { name: 'feedback.md', text: bundle.markdown },
        { name: 'session.json', text: bundle.json },
      ];
      if (rec.source) entries.push({ name: exporter.TRANSCRIPT_FILE, text: bundle.transcriptMarkdown });
      for (const s of bundle.screenshots) {
        const shot = bySeq[s.seq];
        if (shot && shot.blob) entries.push({ name: s.file, blob: shot.blob });
      }
      const blob = await ZIP.buildZip(entries);
      await shareOrDownload(blob, 'ai-feedback-' + stamp(rec.startedAt) + '.zip');
    } catch (e) {
      toast('Could not create the zip: ' + (e && e.message ? e.message : e));
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  }

  async function copyPrompt(rec) {
    try {
      await navigator.clipboard.writeText(clipFor(rec));
      toast('Prompt copied — paste it into your agent');
    } catch (e) {
      toast('Copy failed');
    }
  }

  async function deleteSession(rec, card) {
    if (!confirm('Delete this recording? This removes it from the library (the files in Downloads stay).')) return;
    await store.deleteHistory(rec.id);
    const body = card.querySelector('.card-body');
    revokeBody(body);
    card.remove();
    refreshCount();
  }

  async function deleteSelected(rec, bodyEl, seqs) {
    if (!seqs.length) return;
    const n = seqs.length;
    if (!confirm(
      'Remove ' + n + ' screenshot' + (n > 1 ? 's' : '') + ' from this recording?\n\n' +
      'This updates the library copy used for viewing and sharing. The original files already ' +
      'saved to your Downloads folder are not changed.'
    )) return;
    const updated = await store.deleteHistoryShots(rec.id, seqs);
    const card = bodyEl.closest('.card');
    if (card) {
      card._rec = updated || rec;
      const sub = card.querySelector('.sub');
      if (sub) sub.textContent = summarize(card._rec);
    }
    revokeBody(bodyEl);
    await buildBody((card && card._rec) || updated || rec, bodyEl);
    toast('Removed ' + n + ' screenshot' + (n > 1 ? 's' : ''));
  }

  function summarize(rec) {
    const page = (rec.pages && rec.pages[0]) || null;
    const host = page ? (() => { try { return new URL(page.url).host; } catch (e) { return page.url; } })() : '';
    return (
      fmtDuration(rec.durationMs || 0) + ' · ' +
      (rec.screenshotCount || 0) + ' shots · ' +
      (rec.transcriptCount || 0) + ' spoken' +
      (host ? ' · ' + host : '')
    );
  }

  function renderCard(rec) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = rec.id;
    card._rec = rec; // kept current as screenshots are deleted

    const head = document.createElement('div');
    head.className = 'card-head';
    head.innerHTML =
      '<span class="expand">▶</span>' +
      '<div class="card-title"><div class="when">' +
      (rec.purpose === 'reference' ? '<span class="tag ref">Reference</span> ' : '') +
      (rec.source && rec.source.title ? esc(rec.source.title) + ' <span class="muted">· ' : '') +
      esc(rec.startedAtText || new Date(rec.startedAt).toLocaleString()) +
      (rec.source && rec.source.title ? '</span>' : '') + '</div>' +
      '<div class="sub muted">' + esc(summarize(rec)) + '</div></div>';

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const share = document.createElement('button');
    share.className = 'btn primary';
    share.innerHTML = '📤 <span class="label">Share</span>';
    share.title = 'Share / export as a .zip';
    const copy = document.createElement('button');
    copy.className = 'btn';
    copy.innerHTML = '📋 <span class="label">Copy prompt</span>';
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.innerHTML = '🗑 <span class="label">Delete</span>';
    actions.append(share, copy, del);
    head.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'card-body';

    card.append(head, body);

    head.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions')) return; // clicks on buttons don't toggle
      const open = card.classList.toggle('open');
      if (open && !body._urls) buildBody(card._rec, body);
      else if (!open) revokeBody(body);
    });
    share.addEventListener('click', (e) => { e.stopPropagation(); shareSession(card._rec, share); });
    copy.addEventListener('click', (e) => { e.stopPropagation(); copyPrompt(card._rec); });
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(card._rec, card); });

    return card;
  }

  function refreshCount() {
    const n = $('list').children.length;
    $('count').textContent = n + (n === 1 ? ' recording' : ' recordings');
    $('empty').hidden = n > 0;
    $('clear').hidden = n === 0;
  }

  async function load() {
    const rows = await store.listHistory();
    const list = $('list');
    list.innerHTML = '';
    for (const rec of rows) list.appendChild(renderCard(rec));
    refreshCount();

    // deep-link: ?id=<session> opens that recording expanded
    const id = new URLSearchParams(location.search).get('id');
    if (id) {
      const sel = window.CSS && CSS.escape ? CSS.escape(id) : id;
      const card = list.querySelector('[data-id="' + sel + '"]');
      const rec = rows.find((r) => r.id === id);
      if (card && rec) {
        card.classList.add('open');
        buildBody(rec, card.querySelector('.card-body'));
        card.scrollIntoView({ block: 'start' });
      }
    }
  }

  $('clear').addEventListener('click', async () => {
    if (!confirm('Delete ALL recordings from the library?')) return;
    await store.clearHistory();
    await load();
    toast('Library cleared');
  });

  window.addEventListener('pagehide', () => {
    document.querySelectorAll('.card-body').forEach(revokeBody);
  });

  load();
})();
