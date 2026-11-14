/*
 * Tiny dependency-free test runner for the pure-logic modules.
 * Run: node test/run.cjs
 */
'use strict';
const assert = require('assert');
const imageHash = require('../src/background/image-hash.js');
const gesture = require('../src/content/gesture.js');
const exporter = require('../src/background/exporter.js');
const loomTimeline = require('../src/background/loom-timeline.js');
const zip = require('../src/common/zip.js');
const protocol = require('../src/common/protocol.js');
const speech = require('../src/common/speech.js');
const transcript = require('../src/common/transcript.js');
const micTriage = require('../src/background/mic-triage.js');
const updateCheck = require('../src/common/update-check.js');
const folderCheck = require('../src/common/folder-check.js');
const videoSource = require('../src/common/video-source.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + (err && err.message ? err.message : err));
  }
}

// ---- helpers ----
function gradientImage(increasing) {
  const w = imageHash.HASH_W; // 9
  const h = imageHash.HASH_H; // 8
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1);
      const v = Math.round((increasing ? t : 1 - t) * 255);
      const i = (y * w + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function circlePoints(cx, cy, r, loops, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 * loops;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

console.log('image-hash:');

test('bitsToHex maps nibbles', () => {
  assert.strictEqual(imageHash.bitsToHex('0000'.repeat(16)), '0'.repeat(16));
  assert.strictEqual(imageHash.bitsToHex('1111'.repeat(16)), 'f'.repeat(16));
  assert.strictEqual(imageHash.bitsToHex('1010'.repeat(16)), 'a'.repeat(16));
});

test('dHash of increasing gradient is all zeros', () => {
  // left darker than right => g1 > g2 is false => 0 bits
  assert.strictEqual(imageHash.dHash(gradientImage(true)), '0'.repeat(16));
});

test('dHash of decreasing gradient is all ones', () => {
  assert.strictEqual(imageHash.dHash(gradientImage(false)), 'f'.repeat(16));
});

test('hammingDistance: identical = 0, opposite = 64', () => {
  assert.strictEqual(imageHash.hammingDistance('0'.repeat(16), '0'.repeat(16)), 0);
  assert.strictEqual(imageHash.hammingDistance('0'.repeat(16), 'f'.repeat(16)), 64);
});

test('hammingDistance counts single bit', () => {
  assert.strictEqual(imageHash.hammingDistance('0000000000000001', '0000000000000000'), 1);
  assert.strictEqual(imageHash.hammingDistance('0000000000000003', '0000000000000000'), 2);
});

test('hammingDistance mismatched/empty => 64', () => {
  assert.strictEqual(imageHash.hammingDistance('', 'abc'), 64);
  assert.strictEqual(imageHash.hammingDistance(null, 'abc'), 64);
});

test('isDuplicate respects threshold', () => {
  assert.strictEqual(imageHash.isDuplicate('0000000000000003', '0000000000000000', 6), true);
  assert.strictEqual(imageHash.isDuplicate('00000000000000ff', '0000000000000000', 6), false); // 8 bits
});

console.log('triggers:');

test('click is a priority trigger (evaluated individually, not coalesced)', () => {
  // Priority means a click is never collapsed into a neighbouring request and never
  // hits the blunt whole-frame cull; its own region-aware dedup decides keep/cull.
  assert.ok(protocol.PRIORITY_TRIGGERS.has(protocol.TRIGGER.CLICK));
});

test('priority-trigger contract: intentional triggers bypass the blunt cull, ambient ones do not', () => {
  const P = protocol.PRIORITY_TRIGGERS;
  for (const t of ['start', 'navigation', 'route', 'click', 'selection', 'circle', 'forced', 'annotate']) {
    assert.ok(P.has(t), t + ' should bypass the whole-frame cull');
  }
  for (const t of ['dwell', 'scroll', 'heartbeat']) {
    assert.ok(!P.has(t), t + ' should remain subject to the whole-frame cull');
  }
});

console.log('region dedup:');

test('toGray flattens RGBA to luminance bytes', () => {
  const data = Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255]);
  const g = imageHash.toGray({ width: 2, height: 1, data });
  assert.strictEqual(g[0], 255);
  assert.strictEqual(g[1], 0);
});

test('changeRatio: identical => 0, mismatched length => 1', () => {
  const a = new Uint8Array(16).fill(100);
  const b = new Uint8Array(16).fill(100);
  assert.strictEqual(imageHash.changeRatio(a, b, 4, 4, null, 18), 0);
  assert.strictEqual(imageHash.changeRatio(a, new Uint8Array(9), 4, 4, null, 18), 1);
});

test('changeRatio: respects eps and counts changed cells globally', () => {
  const a = new Uint8Array(16).fill(100);
  const b = new Uint8Array(16).fill(100);
  b[5] = 200; // one cell, delta 100
  assert.strictEqual(imageHash.changeRatio(a, b, 4, 4, null, 18), 1 / 16);
  assert.strictEqual(imageHash.changeRatio(a, b, 4, 4, null, 150), 0); // below eps
});

test('changeRatio: a box isolates a local change the global ratio barely sees', () => {
  const a = new Uint8Array(16).fill(100);
  const b = new Uint8Array(16).fill(100);
  b[5] = 200; // cell at (x=1,y=1)
  const box = imageHash.regionBox(4, 4, 0.25, 0.25, 0); // centered on (1,1), 1 cell
  assert.strictEqual(imageHash.changeRatio(a, b, 4, 4, box, 18), 1); // 100% of the box
  assert.ok(imageHash.changeRatio(a, b, 4, 4, null, 18) < 0.1); // tiny globally
});

test('regionBox centers a square of half-size radius on the click', () => {
  assert.deepStrictEqual(imageHash.regionBox(64, 40, 0.5, 0.5, 9), { x0: 23, y0: 11, x1: 42, y1: 30 });
});

console.log('gesture:');

test('pathLength of a 3-4-5 segment', () => {
  assert.strictEqual(gesture.pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 5);
  assert.strictEqual(gesture.pathLength([{ x: 1, y: 1 }]), 0);
});

test('boundingBoxDiagonal', () => {
  assert.strictEqual(gesture.boundingBoxDiagonal([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 5);
  assert.strictEqual(gesture.boundingBoxDiagonal([]), 0);
});

const OPTS = { circleMinPathPx: 320, circleRatio: 3.2 };

test('straight long drag is NOT a circle', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 400, y: 0 }];
  const r = gesture.analyzeGesture(pts, OPTS);
  assert.strictEqual(r.isCircle, false);
  assert.ok(r.ratio < 1.5, 'ratio should be ~1 for a straight line, got ' + r.ratio);
});

test('tight repeated circling IS a circle', () => {
  const pts = circlePoints(100, 100, 20, 3, 60);
  const r = gesture.analyzeGesture(pts, OPTS);
  assert.ok(r.pathLength >= 320, 'pathLength ' + r.pathLength);
  assert.ok(r.ratio >= 3.2, 'ratio ' + r.ratio);
  assert.strictEqual(r.isCircle, true);
});

test('one small loop is not enough path to trigger', () => {
  const pts = circlePoints(100, 100, 10, 1, 24); // circumference ~63px
  const r = gesture.analyzeGesture(pts, OPTS);
  assert.strictEqual(r.isCircle, false);
});

console.log('exporter:');

const sampleEvents = [
  { id: 1, t: 1000, type: 'screenshot', seq: 1, trigger: 'start', url: 'http://app/', title: 'App' },
  { id: 2, t: 2000, type: 'transcript', final: true, text: 'the save button is broken' },
  {
    id: 3, t: 2500, type: 'screenshot', seq: 2, trigger: 'click', url: 'http://app/', title: 'App',
    element: { tag: 'BUTTON', id: 'save', classes: 'btn primary', text: 'Save' },
  },
  { id: 4, t: 60000, type: 'transcript', final: true, text: 'unrelated note far away' },
];
const sampleMeta = { startedAt: 1000, endedAt: 61000, startedAtText: '2026-06-20 14:30' };

test('build returns sequential screenshot files', () => {
  const r = exporter.build(sampleEvents, sampleMeta);
  assert.strictEqual(r.screenshots.length, 2);
  assert.strictEqual(r.screenshots[0].file, 'screenshots/0001.png');
  assert.strictEqual(r.screenshots[1].file, 'screenshots/0002.png');
});

test('markdown embeds screenshots, quotes, pages, element', () => {
  const r = exporter.build(sampleEvents, sampleMeta);
  assert.ok(r.markdown.includes('screenshots/0002.png'), 'image ref');
  assert.ok(r.markdown.includes('the save button is broken'), 'nearest-screenshot quote');
  assert.ok(r.markdown.includes('Pages visited'), 'pages section');
  assert.ok(r.markdown.includes('http://app/'), 'page url');
  assert.ok(r.markdown.includes('button#save'), 'element selector');
  assert.ok(r.markdown.includes('Save'), 'element text');
});

test('far-away transcript becomes a floating spoken note', () => {
  const r = exporter.build(sampleEvents, sampleMeta);
  assert.ok(r.markdown.includes('unrelated note far away'));
  assert.ok(/spoken:/.test(r.markdown), 'rendered as a spoken note');
});

test('json has correct shape and counts', () => {
  const r = exporter.build(sampleEvents, sampleMeta);
  const j = JSON.parse(r.json);
  assert.strictEqual(j.durationMs, 60000);
  assert.strictEqual(j.screenshots.length, 2);
  assert.strictEqual(j.transcript.length, 2);
  assert.deepStrictEqual(j.screenshots[1].spoken, ['the save button is broken']);
});

test('relTime formats mm:ss and h:mm:ss', () => {
  assert.strictEqual(exporter.relTime(0), '00:00');
  assert.strictEqual(exporter.relTime(65000), '01:05');
  assert.strictEqual(exporter.relTime(3661000), '1:01:01');
});

test('frame trigger renders a video-frame label', () => {
  const ev = [{ id: 1, t: 1000, type: 'screenshot', seq: 1, trigger: 'frame', url: 'https://www.loom.com/share/abc', title: 'Demo' }];
  const r = exporter.build(ev, { startedAt: 1000, endedAt: 1000, startedAtText: 'x' });
  assert.ok(r.markdown.includes('🎞️ Video frame'), 'frame label rendered');
});

test('empty session still builds', () => {
  const r = exporter.build([], {});
  assert.ok(typeof r.markdown === 'string' && r.markdown.length > 0);
  assert.strictEqual(r.screenshots.length, 0);
});

// ---- imported videos: reference vs feedback, transcript file ----
const ytEvents = [
  { id: 1, t: 1000, type: 'screenshot', seq: 1, trigger: 'frame', url: 'https://www.youtube.com/watch?v=abc', title: 'Talk' },
  { id: 2, t: 1000 + 6000, type: 'transcript', final: true, text: 'Thank you.' },
  { id: 3, t: 1000 + 125000, type: 'transcript', final: true, text: 'Stay hungry.' },
];
const ytSource = { kind: 'youtube', url: 'https://www.youtube.com/watch?v=abc', title: 'Talk' };

test('reference import: header says reference material, not feedback to act on', () => {
  const r = exporter.build(ytEvents, { startedAt: 1000, endedAt: 200000, startedAtText: 'x', source: ytSource, purpose: 'reference' });
  assert.ok(r.markdown.startsWith('# Reference video'), 'reference title');
  assert.ok(/not feedback/i.test(r.markdown), 'says it is not feedback');
  assert.ok(!r.markdown.includes('implement the requested fixes'), 'no fix-it instruction');
  assert.ok(r.markdown.includes('https://www.youtube.com/watch?v=abc'), 'source url');
  assert.ok(r.markdown.includes('transcript.md'), 'points at the transcript file');
  assert.ok(/said in the video:/.test(r.markdown), 'floating lines read as said in the video');
  const j = JSON.parse(r.json);
  assert.strictEqual(j.purpose, 'reference');
  assert.deepStrictEqual(j.source, ytSource);
});

test('feedback import keeps the fix-it header but names the source video', () => {
  const r = exporter.build(ytEvents, { startedAt: 1000, endedAt: 200000, startedAtText: 'x', source: ytSource });
  assert.ok(r.markdown.startsWith('# UI / UX feedback'), 'feedback title');
  assert.ok(r.markdown.includes('**Source video:** Talk'), 'source line');
  assert.strictEqual(JSON.parse(r.json).purpose, 'feedback');
});

test('ad breaks met during an import are recorded in session.json', () => {
  const adBreaks = [{ atMs: 204000, how: 'skipped', waitedMs: 5400, skipClicks: 1 }];
  const j = JSON.parse(exporter.build(ytEvents, { startedAt: 1000, source: ytSource, adBreaks }).json);
  assert.deepStrictEqual(j.adBreaks, adBreaks);
  assert.deepStrictEqual(JSON.parse(exporter.build(ytEvents, { startedAt: 1000, source: ytSource }).json).adBreaks, []);
  assert.strictEqual(JSON.parse(exporter.build(sampleEvents, sampleMeta).json).adBreaks, undefined, 'live recordings: no field');
});

test('live recordings are unchanged: no source line, no transcript-file pointer', () => {
  const r = exporter.build(sampleEvents, sampleMeta);
  assert.ok(!r.markdown.includes('Source video'));
  assert.ok(!r.markdown.includes('transcript.md'));
});

test('transcriptMarkdown lists every line with its video timestamp', () => {
  const md = exporter.transcriptMarkdown(ytEvents, { startedAt: 1000, source: ytSource });
  assert.ok(md.startsWith('# Transcript: Talk'), 'title');
  assert.ok(md.includes('Source: https://www.youtube.com/watch?v=abc'), 'source');
  assert.ok(md.includes('[00:06] Thank you.'), 'first line');
  assert.ok(md.includes('[02:05] Stay hungry.'), 'second line');
  assert.ok(md.indexOf('Thank you.') < md.indexOf('Stay hungry.'), 'chronological');
  assert.strictEqual(exporter.build(ytEvents, { startedAt: 1000, source: ytSource }).transcriptMarkdown, md);
});

test('transcriptMarkdown for a live recording uses the session date as its title', () => {
  const md = exporter.transcriptMarkdown(sampleEvents, sampleMeta);
  assert.ok(md.startsWith('# Transcript: recording of 2026-06-20 14:30'));
  assert.ok(md.includes('[00:01] the save button is broken'));
});

test('promptText: feedback asks for fixes, reference asks to read and wait', () => {
  const fb = exporter.promptText('/d/feedback.md');
  assert.ok(/address each item/.test(fb) && fb.includes('/d/feedback.md'));
  const ref = exporter.promptText('/d/feedback.md', 'reference');
  assert.ok(/reference/i.test(ref) && /not a list of changes/i.test(ref), 'reference wording');
  assert.ok(ref.includes('/d/feedback.md') && ref.includes('transcript.md'));
  assert.ok(!/address each item/.test(ref));
});

// ---- video-source (which pages can be imported) ----
test('video-source: recognises YouTube watch and live pages', () => {
  assert.strictEqual(videoSource.sourceForUrl('https://www.youtube.com/watch?v=UF8uR6Z6KLc').kind, 'youtube');
  assert.strictEqual(videoSource.sourceForUrl('https://youtube.com/watch?v=abc&t=30s').kind, 'youtube');
  assert.strictEqual(videoSource.sourceForUrl('https://m.youtube.com/watch?v=abc').kind, 'youtube');
  assert.strictEqual(videoSource.sourceForUrl('https://www.youtube.com/live/abc123').kind, 'youtube');
  assert.strictEqual(videoSource.sourceForUrl('https://www.youtube.com/watch?v=abc').label, 'YouTube');
});

test('video-source: YouTube pages without a single video are not importable', () => {
  assert.strictEqual(videoSource.sourceForUrl('https://www.youtube.com/'), null);
  assert.strictEqual(videoSource.sourceForUrl('https://www.youtube.com/watch'), null);
  assert.strictEqual(videoSource.sourceForUrl('https://www.youtube.com/@stanford'), null);
  assert.strictEqual(videoSource.sourceForUrl('https://www.youtube.com/results?search_query=jobs'), null);
  assert.strictEqual(videoSource.sourceForUrl('https://notyoutube.com/watch?v=abc'), null);
});

test('video-source: Loom share pages still detected, other pages are not', () => {
  assert.strictEqual(videoSource.sourceForUrl('https://www.loom.com/share/abc123').kind, 'loom');
  assert.strictEqual(videoSource.sourceForUrl('https://www.loom.com/looms/videos'), null);
  assert.strictEqual(videoSource.sourceForUrl('https://example.com/'), null);
  assert.strictEqual(videoSource.sourceForUrl('chrome://extensions'), null);
  assert.strictEqual(videoSource.sourceForUrl(''), null);
  assert.strictEqual(videoSource.sourceForUrl(null), null);
});

test('video-source: cleanSegments sorts, de-dups, tidies, and drops punctuation-only lines', () => {
  const out = videoSource.cleanSegments([
    { ms: 15000, text: '  - Thank   you. ' },
    { ms: 6000, text: '- -' },
    { ms: 24000, text: 'Stay\nhungry' },
    { ms: 15000, text: 'duplicate time' },
    { ms: 894000, text: '. . .' },
    { ms: -5, text: 'bad time' },
    { ms: 30000, text: '[Music]' },
  ]);
  assert.deepStrictEqual(out, [
    { ms: 15000, text: '- Thank you.' },
    { ms: 24000, text: 'Stay hungry' },
    { ms: 30000, text: '[Music]' },
  ]);
  assert.deepStrictEqual(videoSource.cleanSegments(null), []);
});

console.log('loom-timeline:');

test('parseTimestamp parses mm:ss and h:mm:ss to ms', () => {
  assert.strictEqual(loomTimeline.parseTimestamp('00:00'), 0);
  assert.strictEqual(loomTimeline.parseTimestamp('00:09'), 9000);
  assert.strictEqual(loomTimeline.parseTimestamp('01:05'), 65000);
  assert.strictEqual(loomTimeline.parseTimestamp('1:02:03'), 3723000);
});

test('parseTimestamp rejects junk', () => {
  assert.strictEqual(loomTimeline.parseTimestamp('hello'), null);
  assert.strictEqual(loomTimeline.parseTimestamp(''), null);
  assert.strictEqual(loomTimeline.parseTimestamp(null), null);
});

test('checkSegments refuses the 2026-11-12 "Copy snippet" x29 scrape', () => {
  // the real broken import: every cue's text was Loom's copy button label
  const times = [1, 12, 29, 50, 62, 75, 88, 101, 115, 128, 140, 152, 166, 180, 193, 205, 218, 230, 243, 256, 270, 283, 296, 310, 322, 335, 347, 355, 363];
  const r = loomTimeline.checkSegments(times.map((s) => ({ ms: s * 1000, text: 'Copy snippet' })));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'ui-labels');
});

test('checkSegments refuses one line repeated for most cues, keeps real lines', () => {
  const rep = loomTimeline.checkSegments([1, 2, 3, 4, 5, 6].map((i) => ({ ms: i, text: i === 6 ? 'something else here' : 'Same caption text' })));
  assert.strictEqual(rep.ok, false);
  assert.strictEqual(rep.reason, 'repeated-line');
  const good = loomTimeline.checkSegments([
    { ms: 1000, text: "All right. I'd like to see if we could automate the refund" },
    { ms: 12000, text: 'Copy snippet' }, // a stray label is dropped, not fatal
    { ms: 13000, text: '/ 6:05' }, // the player's clock: no words
    { ms: 29000, text: 'So the way the process works right now' },
    { ms: 50000, text: 'Okay.' },
  ]);
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.segments.map((s) => s.ms).join(','), '1000,29000,50000');
  assert.strictEqual(loomTimeline.checkSegments([]).ok, false);
  // short real transcripts and one-character CJK cues are fine
  assert.strictEqual(loomTimeline.checkSegments([{ ms: 0, text: 'Okay.' }, { ms: 1, text: 'Okay.' }, { ms: 2, text: 'Thanks, bye.' }]).ok, true);
  assert.strictEqual(loomTimeline.checkSegments([{ ms: 0, text: '你' }, { ms: 1, text: '好' }]).ok, true);
  // a music-heavy YouTube video: "[Music]" repeats legitimately
  const music = [0, 1, 2, 3, 4, 5].map((i) => ({ ms: i * 1000, text: i === 5 ? 'thanks for watching' : '[Music]' }));
  assert.strictEqual(loomTimeline.checkSegments(music).ok, true);
});

test('checkSegments refuses a transcript that stops well before the video (partial list)', () => {
  // live Loom share page signed out: rows only up to 2:19 of a 6:05 video
  const segs = [1, 12, 29, 50, 62, 75, 88, 101, 115, 128, 133, 139].map((s) => ({ ms: s * 1000, text: 'words at ' + s }));
  assert.strictEqual(loomTimeline.checkSegments(segs, { durationMs: 365000 }).reason, 'partial');
  assert.strictEqual(loomTimeline.checkSegments(segs.concat([{ ms: 350000, text: 'the end' }]), { durationMs: 365000 }).ok, true);
  assert.strictEqual(loomTimeline.checkSegments(segs, {}).ok, true); // length unknown: no coverage check
});

test('buildTargets always includes t=0 and every segment time, sorted+unique', () => {
  const r = loomTimeline.buildTargets([9000, 9000, 2000], { floorMs: 15000, maxFrames: 300 });
  assert.deepStrictEqual(r, [0, 2000, 9000]);
});

test('buildTargets fills gaps larger than floorMs', () => {
  // 0 -> 40000 is a 40s gap; floor 15s -> insert 15000, 30000
  const r = loomTimeline.buildTargets([40000], { floorMs: 15000, maxFrames: 300 });
  assert.deepStrictEqual(r, [0, 15000, 30000, 40000]);
});

test('buildTargets respects maxFrames by even subsampling (keeps first + last)', () => {
  const segs = [10000, 20000, 30000, 40000, 50000]; // anchors incl 0 -> 6 targets
  const r = loomTimeline.buildTargets(segs, { floorMs: 60000, maxFrames: 3 });
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0], 0);
  assert.strictEqual(r[r.length - 1], 50000);
});

test('buildTargets on empty segments yields just [0]', () => {
  assert.deepStrictEqual(loomTimeline.buildTargets([], { floorMs: 15000, maxFrames: 300 }), [0]);
});

console.log('zip:');

test('crc32 of "123456789" is 0xCBF43926', () => {
  const bytes = Buffer.from('123456789', 'ascii');
  assert.strictEqual(zip.crc32(bytes), 0xcbf43926);
});

test('buildZipBytes produces a valid-looking archive', () => {
  const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
  const bytes = zip.buildZipBytes([
    { name: 'feedback.md', data: enc('# hello') },
    { name: 'screenshots/0001.png', data: new Uint8Array([1, 2, 3, 4]) },
  ]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // first local file header signature PK\x03\x04
  assert.strictEqual(dv.getUint32(0, true), 0x04034b50);
  // EOCD is the last 22 bytes
  const eocd = bytes.length - 22;
  assert.strictEqual(dv.getUint32(eocd, true), 0x06054b50, 'EOCD signature');
  assert.strictEqual(dv.getUint16(eocd + 10, true), 2, 'total entries');
  // central dir offset points at a central-directory header PK\x01\x02
  const cdOff = dv.getUint32(eocd + 16, true);
  assert.strictEqual(dv.getUint32(cdOff, true), 0x02014b50, 'central dir signature');
});

test('buildZipBytes round-trips entry names + data', () => {
  const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
  const name = 'session.json';
  const data = enc('{"a":1}');
  const bytes = zip.buildZipBytes([{ name, data }]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLen = dv.getUint16(26, true);
  const storedName = Buffer.from(bytes.slice(30, 30 + nameLen)).toString('utf8');
  assert.strictEqual(storedName, name);
  const storedData = Buffer.from(bytes.slice(30 + nameLen, 30 + nameLen + data.length)).toString('utf8');
  assert.strictEqual(storedData, '{"a":1}');
});

console.log('inkPathData (strokes -> SVG path):');

test('each stroke becomes its own subpath, so strokes never join up', () => {
  const one = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
  const two = [{ x: 5, y: 6 }, { x: 7.5, y: 8 }, { x: 9, y: 10 }];
  assert.strictEqual(gesture.inkPathData([one, two]), 'M1 2L3 4M5 6L7.5 8L9 10');
});

test('no strokes means an empty path', () => {
  assert.strictEqual(gesture.inkPathData([]), '');
});

console.log('snapAxis (Shift = straight line):');

test('mostly-horizontal drag snaps to a horizontal line', () => {
  assert.deepStrictEqual(gesture.snapAxis({ x: 100, y: 100 }, { x: 180, y: 112 }), { x: 180, y: 100 });
});

test('mostly-vertical drag snaps to a vertical line', () => {
  assert.deepStrictEqual(gesture.snapAxis({ x: 100, y: 100 }, { x: 94, y: 20 }), { x: 100, y: 20 });
});

test('no movement or a perfect diagonal snaps horizontal', () => {
  assert.deepStrictEqual(gesture.snapAxis({ x: 5, y: 5 }, { x: 5, y: 5 }), { x: 5, y: 5 });
  assert.deepStrictEqual(gesture.snapAxis({ x: 0, y: 0 }, { x: 30, y: 30 }), { x: 30, y: 0 });
});

console.log('speech (page-mic recognizer):');

test('permission errors are recognized, others are not', () => {
  assert.ok(speech.isPermissionError('not-allowed'));
  assert.ok(speech.isPermissionError('service-not-allowed'));
  assert.ok(!speech.isPermissionError('no-speech'));
  assert.ok(!speech.isPermissionError('aborted'));
  assert.ok(!speech.isPermissionError(undefined));
});

test("page-mic deadline holds only while Chrome's site-mic prompt is open", () => {
  // Web Speech fires no start/audiostart until the prompt is answered
  assert.strictEqual(speech.waitsOnPrompt('prompt'), true);
  // answered, or no way to tell: a mic that stays silent past the deadline times out
  for (const s of ['granted', 'denied', undefined, null, '', 'PROMPT']) {
    assert.strictEqual(speech.waitsOnPrompt(s), false, String(s));
  }
});

test('speech.answersPrompt: Allow or Block restarts the page-mic deadline', () => {
  assert.strictEqual(speech.answersPrompt('granted'), true);
  assert.strictEqual(speech.answersPrompt('denied'), true);
  // still open, or no way to tell: keep waiting on the existing deadline
  for (const s of ['prompt', undefined, null, '', 'GRANTED']) {
    assert.strictEqual(speech.answersPrompt(s), false, String(s));
  }
});

console.log('transcript (edit while paused):');

const txEvents = [
  { id: 1, t: 100, type: 'transcript', final: true, text: 'the button is to small' },
  { id: 2, t: 200, type: 'screenshot', seq: 1 },
  { id: 3, t: 300, type: 'transcript', final: true, text: 'make it bread' },
  { id: 4, t: 400, type: 'transcript', final: false, text: 'interim' },
];

test('finalSegments keeps only finalized transcript text, with ids', () => {
  assert.deepStrictEqual(transcript.finalSegments(txEvents), [
    { id: 1, t: 100, text: 'the button is to small' },
    { id: 3, t: 300, text: 'make it bread' },
  ]);
});

test('joinTranscript joins finals with a space', () => {
  assert.strictEqual(transcript.joinTranscript(txEvents), 'the button is to small make it bread');
});

test('applyEdit replaces one segment and leaves the rest untouched', () => {
  const out = transcript.applyEdit(txEvents, 3, '  make it   red\n');
  assert.strictEqual(out.find((e) => e.id === 3).text, 'make it red');
  assert.strictEqual(out.find((e) => e.id === 1).text, 'the button is to small');
  assert.strictEqual(out.length, 4);
  assert.strictEqual(txEvents[2].text, 'make it bread', 'input not mutated');
});

test('applyEdit with empty text deletes the segment', () => {
  const out = transcript.applyEdit(txEvents, 1, '   ');
  assert.strictEqual(out.length, 3);
  assert.strictEqual(transcript.joinTranscript(out), 'make it bread');
});

test('applyEdit never touches non-transcript events or unknown ids', () => {
  assert.deepStrictEqual(transcript.applyEdit(txEvents, 2, 'x'), txEvents);
  assert.deepStrictEqual(transcript.applyEdit(txEvents, 99, 'x'), txEvents);
});

// ---- mic-triage: classify why speech recognition failed ----

test('a recognizer iframe that never reported falls back like a page block', () => {
  // a page sandboxed without allow-scripts loads the iframe but never runs it
  const v = micTriage.classify({ error: 'recognizer-silent', src: 'iframe' });
  assert.deepStrictEqual(v, { kind: 'page-blocked', fallback: true });
});

test('a fallback recognizer that misses its start-up deadline is a timeout, then tries the page', () => {
  const v = micTriage.classify({ error: 'start-timeout', src: 'offscreen' });
  assert.deepStrictEqual(v, { kind: 'timeout', fallback: false });
  assert.strictEqual(micTriage.pageFallback(v, 'offscreen'), true);
  // ...and a page mic that times out is the end of the line
  assert.strictEqual(micTriage.pageFallback(micTriage.classify({ error: 'start-timeout', src: 'page' }), 'page'), false);
});

test('a CSP-sandboxed page reports sandboxed, with no further fallback', () => {
  const v = micTriage.classify({ error: 'sandboxed-page', src: 'page' });
  assert.deepStrictEqual(v, { kind: 'sandboxed', fallback: false });
  assert.strictEqual(micTriage.pageFallback(v, 'page'), false);
});

test('mic-triage: page Permissions-Policy block -> page-blocked + offscreen fallback', () => {
  const v = micTriage.classify({ error: 'not-allowed', src: 'iframe', policyAllowed: false, permState: 'granted' });
  assert.deepStrictEqual(v, { kind: 'page-blocked', fallback: true });
});

test('mic-triage: policy verdict wins even with permission unknown', () => {
  const v = micTriage.classify({ error: 'service-not-allowed', src: 'iframe', policyAllowed: false, permState: null });
  assert.deepStrictEqual(v, { kind: 'page-blocked', fallback: true });
});

test('mic-triage: permission prompt (the "Allow this time" trap) -> permission, no fallback', () => {
  const v = micTriage.classify({ error: 'not-allowed', src: 'iframe', policyAllowed: true, permState: 'prompt' });
  assert.deepStrictEqual(v, { kind: 'permission', fallback: false });
});

test('mic-triage: permission denied -> permission, no fallback', () => {
  const v = micTriage.classify({ error: 'not-allowed', src: 'iframe', policyAllowed: null, permState: 'denied' });
  assert.deepStrictEqual(v, { kind: 'permission', fallback: false });
});

test('mic-triage: not-allowed despite granted permission -> ambiguous, fallback probes', () => {
  const v = micTriage.classify({ error: 'not-allowed', src: 'iframe', policyAllowed: true, permState: 'granted' });
  assert.deepStrictEqual(v, { kind: 'blocked', fallback: true });
});

test('mic-triage: not-allowed with no diagnostics at all -> fallback probes', () => {
  const v = micTriage.classify({ error: 'not-allowed' });
  assert.deepStrictEqual(v, { kind: 'blocked', fallback: true });
});

test('mic-triage: service-not-allowed with granted mic -> service, one fallback try', () => {
  const v = micTriage.classify({ error: 'service-not-allowed', src: 'iframe', policyAllowed: true, permState: 'granted' });
  assert.deepStrictEqual(v, { kind: 'service', fallback: true });
});

test('mic-triage: service-not-allowed with ungranted mic reads as permission', () => {
  const v = micTriage.classify({ error: 'service-not-allowed', src: 'iframe', policyAllowed: true, permState: 'prompt' });
  assert.deepStrictEqual(v, { kind: 'permission', fallback: false });
});

test('mic-triage: offscreen source never falls back further', () => {
  const v = micTriage.classify({ error: 'not-allowed', src: 'offscreen', policyAllowed: null, permState: 'granted' });
  assert.strictEqual(v.fallback, false);
});

test('mic-triage: hardware/no-audio failures are terminal', () => {
  assert.deepStrictEqual(micTriage.classify({ error: 'audio-capture', src: 'iframe' }), { kind: 'no-audio', fallback: false });
  assert.deepStrictEqual(micTriage.classify({ error: 'offscreen-no-audio', src: 'offscreen' }), { kind: 'no-audio', fallback: false });
});

test('mic-triage: transient recognizer errors classify as other, no UI reaction', () => {
  for (const error of ['no-speech', 'network', 'aborted', 'restart-failed', 'speech-recognition-unavailable']) {
    const v = micTriage.classify({ error, src: 'iframe' });
    assert.deepStrictEqual(v, { kind: 'other', fallback: false }, error);
  }
});

// ---- last resort: speech in the page itself (claude.ai) ----

test('mic-triage: offscreen heard nothing -> try the page mic (Chrome asks once per site)', () => {
  const v = micTriage.classify({ error: 'offscreen-no-audio', src: 'offscreen' });
  assert.strictEqual(micTriage.pageFallback(v, 'offscreen'), true);
});

test('mic-triage: offscreen refused too (page block / permission) -> try the page mic', () => {
  for (const kind of ['page-blocked', 'blocked', 'permission']) {
    assert.strictEqual(micTriage.pageFallback({ kind, fallback: false }, 'offscreen'), true, kind);
  }
});

test('mic-triage: a dead speech service or transient error never moves to the page', () => {
  assert.strictEqual(micTriage.pageFallback({ kind: 'service', fallback: false }, 'offscreen'), false);
  assert.strictEqual(micTriage.pageFallback({ kind: 'other', fallback: false }, 'offscreen'), false);
});

test('mic-triage: only an offscreen failure can lead to the page mic', () => {
  assert.strictEqual(micTriage.pageFallback({ kind: 'page-blocked', fallback: true }, 'iframe'), false);
  assert.strictEqual(micTriage.pageFallback({ kind: 'blocked', fallback: true }, 'page'), false);
  assert.strictEqual(micTriage.pageFallback(null, 'offscreen'), false);
});

// ---- update-check: version compare + release parsing (drives the daily prompt) ----

console.log('update-check:');

test('parseVersion accepts v-prefix and pads to three parts', () => {
  assert.deepStrictEqual(updateCheck.parseVersion('v0.9.0'), [0, 9, 0]);
  assert.deepStrictEqual(updateCheck.parseVersion('1.2'), [1, 2, 0]);
  assert.deepStrictEqual(updateCheck.parseVersion(' 10.0.3 '), [10, 0, 3]);
});

test('parseVersion rejects junk (no prompt from a malformed tag)', () => {
  for (const bad of ['', 'latest', '1.2.3-beta', 'v1..2', '1.2.3.4', null, undefined, 9]) {
    assert.strictEqual(updateCheck.parseVersion(bad), null, String(bad));
  }
});

test('isNewer: strict, per-part numeric compare', () => {
  assert.strictEqual(updateCheck.isNewer('0.9.0', '0.8.0'), true);
  assert.strictEqual(updateCheck.isNewer('0.10.0', '0.9.1'), true); // numeric, not lexicographic
  assert.strictEqual(updateCheck.isNewer('1.0.0', '0.99.99'), true);
  assert.strictEqual(updateCheck.isNewer('0.9.0', '0.9.0'), false);
  assert.strictEqual(updateCheck.isNewer('0.8.9', '0.9.0'), false);
  assert.strictEqual(updateCheck.isNewer('garbage', '0.9.0'), false);
});

test('checkDue: never-checked, overdue, and future-timestamp clock skew are all due', () => {
  const DAY = 24 * 60 * 60 * 1000;
  assert.strictEqual(updateCheck.checkDue(1000, null, DAY), true);
  assert.strictEqual(updateCheck.checkDue(2 * DAY, DAY - 1, DAY), true);
  assert.strictEqual(updateCheck.checkDue(DAY + 500, DAY, DAY), false);
  assert.strictEqual(updateCheck.checkDue(1000, 5 * DAY, DAY), true); // stored future time must not wedge checks
});

const releaseFixture = {
  tag_name: 'v9.9.9',
  name: 'v9.9.9',
  html_url: 'https://github.com/JustinWi/almost-video-feedback/releases/tag/v9.9.9',
  assets: [
    { name: 'something-else.txt', browser_download_url: 'https://example.com/x.txt' },
    { name: 'almost-video-feedback.zip', browser_download_url: 'https://example.com/avf.zip' },
  ],
};

test('parseReleaseInfo picks the named zip asset', () => {
  const info = updateCheck.parseReleaseInfo(releaseFixture, 'https://fallback/zip');
  assert.strictEqual(info.version, '9.9.9');
  assert.strictEqual(info.zipUrl, 'https://example.com/avf.zip');
  assert.strictEqual(info.pageUrl, releaseFixture.html_url);
});

test('parseReleaseInfo falls back to the stable latest/download URL when the asset is missing', () => {
  const info = updateCheck.parseReleaseInfo({ tag_name: 'v2.0.0', assets: [] }, 'https://fallback/zip');
  assert.strictEqual(info.zipUrl, 'https://fallback/zip');
});

test('parseReleaseInfo rejects a response without a usable tag', () => {
  assert.strictEqual(updateCheck.parseReleaseInfo({}, 'f'), null);
  assert.strictEqual(updateCheck.parseReleaseInfo({ tag_name: 'nightly' }, 'f'), null);
  assert.strictEqual(updateCheck.parseReleaseInfo(null, 'f'), null);
});

test('simulated "newer version available" end-to-end: fixture -> prompt state', () => {
  // the exact pipeline the SW runs on each daily check
  const info = updateCheck.parseReleaseInfo(releaseFixture, 'https://fallback/zip');
  const upd = updateCheck.decideUpdate(info, '0.9.0');
  assert.deepStrictEqual(upd, {
    version: '9.9.9',
    zipUrl: 'https://example.com/avf.zip',
    pageUrl: releaseFixture.html_url,
  });
});

test('Web Store installs skip the GitHub update check; unpacked/sideloaded ones need it', () => {
  assert.strictEqual(updateCheck.needsGithubCheck('normal'), false);
  assert.strictEqual(updateCheck.needsGithubCheck('development'), true);
  assert.strictEqual(updateCheck.needsGithubCheck('sideload'), true);
  assert.strictEqual(updateCheck.needsGithubCheck('admin'), true);
  assert.strictEqual(updateCheck.needsGithubCheck(undefined), true);
});

test('nextStep: one-click reload when the folder already has the new version', () => {
  const avail = { version: '0.10.3' };
  // Justin's case: repo folder pulled to 0.10.3, Chrome still running 0.10.2
  assert.deepStrictEqual(updateCheck.nextStep('0.10.2', avail, '0.10.3'), { kind: 'reload', version: '0.10.3' });
  // folder ahead of the release we know about (or no check yet): reload still finishes it
  assert.deepStrictEqual(updateCheck.nextStep('0.10.2', avail, '0.10.4'), { kind: 'reload', version: '0.10.4' });
  assert.deepStrictEqual(updateCheck.nextStep('0.10.2', null, '0.10.3'), { kind: 'reload', version: '0.10.3' });
  // folder still old -> the files have to be replaced first
  assert.deepStrictEqual(updateCheck.nextStep('0.10.2', avail, '0.10.2'), { kind: 'replace', version: '0.10.3' });
  // folder half-way (newer than running, older than the release) -> still replace
  assert.deepStrictEqual(updateCheck.nextStep('0.10.1', avail, '0.10.2'), { kind: 'replace', version: '0.10.3' });
  // can't read the folder -> fall back to the release prompt
  assert.deepStrictEqual(updateCheck.nextStep('0.10.2', avail, null), { kind: 'replace', version: '0.10.3' });
});

test('nextStep: nothing once the running version is the latest', () => {
  assert.strictEqual(updateCheck.nextStep('0.10.3', { version: '0.10.3' }, '0.10.3'), null);
  assert.strictEqual(updateCheck.nextStep('0.10.3', null, '0.10.3'), null);
  assert.strictEqual(updateCheck.nextStep('0.10.3', null, null), null);
  // stale "available" for an older version never prompts
  assert.strictEqual(updateCheck.nextStep('0.10.3', { version: '0.10.2' }, '0.10.3'), null);
});

test('folderCheck: Update now waits for a zip copy-over to finish', () => {
  const listing = { version: '0.10.7', files: { 'manifest.json': 'aa', 'src/a.js': 'bb', 'src/b.js': 'cc' } };
  // every file matches -> go
  assert.deepStrictEqual(folderCheck.compareListing(listing, '0.10.7', { 'manifest.json': 'aa', 'src/a.js': 'bb', 'src/b.js': 'cc' }),
    { ok: true, total: 3, bad: [], version: '0.10.7', found: {} });
  // mid-copy: one old, one not there yet -> hold
  const mid = folderCheck.compareListing(listing, '0.10.7', { 'manifest.json': 'aa', 'src/a.js': 'old', 'src/b.js': null });
  assert.deepStrictEqual(mid, { ok: false, total: 3, bad: ['src/a.js', 'src/b.js'], version: '0.10.7', found: { 'src/a.js': 'old', 'src/b.js': null } });
  assert.ok(/1 of 3 done/.test(folderCheck.describe(mid)));
  // no listing (git checkout), or one left from another version -> unknown, reload goes ahead
  assert.strictEqual(folderCheck.compareListing(null, '0.10.7', {}).ok, null);
  assert.strictEqual(folderCheck.compareListing(listing, '0.10.8', {}).ok, null);
  assert.strictEqual(folderCheck.compareListing(listing, null, {}).ok, null);
});

test('folderCheck.track: a mismatch that stops changing is edited files, a changing one is a copy', () => {
  const listing = { version: '9.0.1', files: { 'manifest.json': 'aa', 'src/a.js': 'bb', 'src/b.js': 'cc' } };
  const cmp = (a, b) => folderCheck.compareListing(listing, '9.0.1', { 'manifest.json': 'aa', 'src/a.js': a, 'src/b.js': b });
  const STABLE = 10000;
  // nothing to fingerprint: a match, unknown, or a refusal with no hashes (manifest mid-write)
  assert.strictEqual(folderCheck.signature(cmp('bb', 'cc')), null);
  assert.strictEqual(folderCheck.signature({ ok: null, total: 0, bad: [] }), null);
  assert.strictEqual(folderCheck.signature({ ok: false, total: 0, bad: ['manifest.json'] }), null);
  // the fingerprint covers which files differ AND what they hold now
  assert.notStrictEqual(folderCheck.signature(cmp('x1', 'cc')), folderCheck.signature(cmp('x2', 'cc')));
  assert.notStrictEqual(folderCheck.signature(cmp('x1', 'cc')), folderCheck.signature(cmp('x1', null)));
  // same mismatch held: copying until stableMs, then modified
  let t = folderCheck.track(null, cmp('edited', 'cc'), 1000, STABLE);
  assert.strictEqual(t.modified, false);
  t = folderCheck.track(t, cmp('edited', 'cc'), 1000 + STABLE - 1, STABLE);
  assert.strictEqual(t.modified, false);
  t = folderCheck.track(t, cmp('edited', 'cc'), 1000 + STABLE, STABLE);
  assert.strictEqual(t.modified, true);
  // a copy (re)starting changes the mismatch: back to copying, clock restarts
  t = folderCheck.track(t, cmp('edited', null), 1000 + STABLE + 2500, STABLE);
  assert.strictEqual(t.modified, false);
  assert.strictEqual(t.since, 1000 + STABLE + 2500);
  // a still-changing copy never turns into modified, however long it runs
  t = null;
  for (let i = 0; i < 20; i++) t = folderCheck.track(t, cmp('part' + i, null), i * 2500, STABLE);
  assert.strictEqual(t.modified, false);
  // a refusal with no hashes in between resets; a match resets
  t = folderCheck.track({ sig: folderCheck.signature(cmp('e', 'cc')), since: 0, modified: true },
    { ok: false, total: 0, bad: ['manifest.json'] }, 99999, STABLE);
  assert.strictEqual(t.modified, false);
  assert.strictEqual(folderCheck.track(t, cmp('bb', 'cc'), 999999, STABLE).modified, false);
  // plain words: count, version, singular/plural
  assert.ok(/^1 file in your extension folder doesn't match the v9\.0\.1 release/.test(folderCheck.describeModified(cmp('e', 'cc'))));
  assert.ok(/^2 files .* don't match/.test(folderCheck.describeModified(cmp('e', 'f'))));
  assert.ok(/reload anyway/.test(folderCheck.describeModified(cmp('e', 'f'))));
});

test('decideUpdate stays silent when current version is same or newer', () => {
  const info = updateCheck.parseReleaseInfo({ tag_name: 'v0.9.0', assets: [] }, 'f');
  assert.strictEqual(updateCheck.decideUpdate(info, '0.9.0'), null);
  assert.strictEqual(updateCheck.decideUpdate(info, '1.0.0'), null);
  assert.strictEqual(updateCheck.decideUpdate(null, '0.9.0'), null);
});

// ---- screenshot limit (per-recording cap) ----
const config = require('../src/common/config.js');

test('screenshot cap defaults to 1000', () => {
  assert.strictEqual(config.DEFAULTS.maxScreenshots, 1000);
});

test('migrate raises a saved old-default 300 cap to 1000, once', () => {
  const m = config.migrate({ maxScreenshots: 300, language: 'en-GB' });
  assert.strictEqual(m.changed, true);
  assert.strictEqual(m.settings.maxScreenshots, 1000);
  assert.strictEqual(m.settings.language, 'en-GB'); // nothing else touched
  assert.strictEqual(m.settings.settingsRev, config.SETTINGS_REV);
  // after the one-time upgrade, a deliberate 300 sticks
  const again = config.migrate({ maxScreenshots: 300, settingsRev: config.SETTINGS_REV });
  assert.strictEqual(again.changed, false);
  assert.strictEqual(again.settings.maxScreenshots, 300);
});

test('migrate raises a saved 12s offscreen mic deadline to 15s, once', () => {
  const m = config.migrate({ offscreenMicStartMs: 12000, settingsRev: 2, maxScreenshots: 300 });
  assert.strictEqual(m.changed, true);
  assert.strictEqual(m.settings.offscreenMicStartMs, 15000);
  assert.strictEqual(m.settings.maxScreenshots, 300); // rev-2 step already ran: a saved 300 is a choice
  assert.strictEqual(config.DEFAULTS.offscreenMicStartMs, 15000);
  const again = config.migrate({ offscreenMicStartMs: 12000, settingsRev: config.SETTINGS_REV });
  assert.strictEqual(again.changed, false);
});

test('migrate leaves a user-chosen non-300 cap alone', () => {
  assert.strictEqual(config.migrate({ maxScreenshots: 500 }).settings.maxScreenshots, 500);
  assert.strictEqual(config.migrate({ maxScreenshots: 2000 }).settings.maxScreenshots, 2000);
});

test('protocol has the screenshot-limit messages', () => {
  assert.strictEqual(typeof protocol.MSG.SCREENSHOT_CAP, 'string');
  assert.strictEqual(typeof protocol.MSG.SCREENSHOT_CAP_DISMISS, 'string');
});

test('capNotice reads "Screenshot limit reached at mm:ss; later entries have no pictures."', () => {
  assert.strictEqual(
    exporter.capNotice(23 * 60000 + 12000),
    'Screenshot limit reached at 23:12; later entries have no pictures.'
  );
});

test('feedback.md marks the moment the limit was hit, after the last shot', () => {
  const t0 = 1000000;
  const ev = [
    { t: t0, type: 'screenshot', seq: 1, trigger: 'start', url: 'https://a/' },
    { t: t0 + 60000, type: 'screenshot', seq: 2, trigger: 'click', url: 'https://a/' },
    { t: t0 + 60000, type: 'cap', cap: 2 },
    { t: t0 + 90000, type: 'transcript', final: true, text: 'this part has no picture' },
  ];
  const r = exporter.build(ev, { startedAt: t0, endedAt: t0 + 100000, startedAtText: 'x' });
  const md = r.markdown;
  const line = 'Screenshot limit reached at 01:00; later entries have no pictures.';
  assert.ok(md.includes(line), 'notice line present');
  assert.ok(md.indexOf('shot-0002') < md.indexOf(line), 'after the last screenshot');
  assert.ok(md.indexOf(line) < md.indexOf('this part has no picture'), 'before the picture-less speech');
  assert.ok(md.includes('2 screenshots (limit of 2 reached at 01:00)'), 'header says so');
  assert.deepStrictEqual(JSON.parse(r.json).screenshotLimit, { cap: 2, reachedRelMs: 60000 });
});

test('feedback.md has no limit line when the cap was never hit', () => {
  const r = exporter.build(sampleEvents, sampleMeta);
  assert.ok(!r.markdown.includes('Screenshot limit reached'));
  assert.strictEqual(JSON.parse(r.json).screenshotLimit, null);
});

// Runs the real capture pipeline (capture.js) against a stubbed chrome API.
async function runCapture(cap, attempts) {
  const shots = [];
  const hits = [];
  let grabs = 0;
  globalThis.chrome = {
    runtime: { lastError: null },
    tabs: {
      captureVisibleTab: async () => {
        grabs++;
        return 'data:image/png;base64,iVBORw0KGgo=';
      },
      sendMessage: (id, msg, cb) => cb && cb(),
    },
  };
  globalThis.SCF.imageHash = imageHash;
  globalThis.SCF.sessionStore = {
    addScreenshot: async (seq) => shots.push(seq),
    addEvent: async () => {},
    patchMeta: async () => {},
  };
  delete require.cache[require.resolve('../src/background/capture.js')];
  require('../src/background/capture.js');
  const capture = globalThis.SCF.capture;
  capture.begin({ windowId: 1, tabId: 1, settings: { maxScreenshots: cap, minCaptureIntervalMs: 1, triggers: {} } });
  capture.hooks.onCapReached = (x) => hits.push(x);
  const idle = async () => {
    while (capture._state.busy || capture._state.queue.length || capture._state.timer) {
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  for (let i = 0; i < attempts; i++) {
    capture.request('forced', {});
    await idle();
  }
  capture.end();
  return { shots, hits, grabs };
}

const asyncTests = [];
function atest(name, fn) {
  asyncTests.push({ name, fn });
}

atest('capture keeps exactly `cap` shots, fires the warning hook once, then stops grabbing frames', async () => {
  const r = await runCapture(5, 9);
  assert.deepStrictEqual(r.shots, [1, 2, 3, 4, 5]);
  assert.strictEqual(r.hits.length, 1, 'warning fired once');
  assert.strictEqual(r.hits[0].cap, 5);
  assert.strictEqual(r.hits[0].seq, 5);
  assert.strictEqual(typeof r.hits[0].t, 'number');
  assert.strictEqual(r.grabs, 5, 'no captureVisibleTab calls past the cap');
});

atest('capture under the cap never fires the warning', async () => {
  const r = await runCapture(5, 4);
  assert.strictEqual(r.shots.length, 4);
  assert.strictEqual(r.hits.length, 0);
});

// folder-check against a fake extension folder: { path: string body | 'MISSING' }
function fakeFolder(files) {
  global.chrome = { runtime: { getURL: (p) => 'ext:/' + p } };
  global.fetch = async (url) => {
    const body = files[url.slice(5)];
    if (body === undefined || body === 'MISSING') throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => JSON.parse(body), arrayBuffer: async () => new TextEncoder().encode(body).buffer };
  };
}

atest('folderCheck.check: refuses half-written or still-landing copies, waits out a late listing', async () => {
  const M = (v) => JSON.stringify({ version: v });
  const crypto = require('crypto');
  const h = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const L = (v, files) => JSON.stringify({ version: v, files });
  // manifest.json caught mid-write -> refuse
  fakeFolder({ 'manifest.json': '{"vers' });
  assert.strictEqual((await folderCheck.check({ settleMs: 0 })).ok, false);
  // listing present but truncated -> refuse
  fakeFolder({ 'manifest.json': M('0.10.8'), 'release-files.json': '{"version":"0.10.8","fi' });
  assert.strictEqual((await folderCheck.check({ settleMs: 0 })).ok, false);
  // listing newer than the manifest (zip order: listing first, manifest last) -> still landing
  fakeFolder({ 'manifest.json': M('0.10.8'), 'release-files.json': L('0.10.9', {}) });
  assert.strictEqual((await folderCheck.check({ settleMs: 0 })).ok, false);
  // no listing (git checkout), or one left from an older version -> unknown, reload allowed
  fakeFolder({ 'manifest.json': M('0.10.8') });
  assert.strictEqual((await folderCheck.check({ settleMs: 0 })).ok, null);
  fakeFolder({ 'manifest.json': M('0.10.8'), 'release-files.json': L('0.10.7', {}) });
  assert.strictEqual((await folderCheck.check({ settleMs: 0 })).ok, null);
  // the listing lands during the settle wait -> it gets checked
  const files = { 'manifest.json': M('0.10.8'), 'src/a.js': 'old' };
  fakeFolder(files);
  const p = folderCheck.check({ settleMs: 30 });
  files['release-files.json'] = L('0.10.8', { 'src/a.js': h('new') });
  const r = await p;
  assert.deepStrictEqual([r.ok, r.bad], [false, ['src/a.js']]);
  files['src/a.js'] = 'new';
  assert.strictEqual((await folderCheck.check({ settleMs: 0 })).ok, true);
  delete global.chrome;
  delete global.fetch;
});

// ---- what's new: release notes between two versions ----
const releaseNotes = require('../src/common/release-notes.js');

test('release notes: list items become plain points (bold, links and code marks gone)', () => {
  const body = '**Click the icon to see your recordings.**\n\n- **New choice:** pick [Open the menu](https://x.y) here.\n* The `⌘⇧Y` shortcut records\n  - a sub-point is left out\n\nUpdate: download the zip below.';
  assert.deepStrictEqual(releaseNotes.bodyToPoints(body), ['New choice: pick Open the menu here.', 'The ⌘⇧Y shortcut records']);
});

test('release notes: a body without a list gives its paragraphs, minus headings and the how-to line', () => {
  const body = '## Fixes\n\nLoom imports read every line again.\n\nUpdate: copy the zip over your folder.';
  assert.deepStrictEqual(releaseNotes.bodyToPoints(body), ['Loom imports read every line again.']);
  assert.deepStrictEqual(releaseNotes.bodyToPoints(''), []);
});

test('release notes: only versions newer than the running one, newest first, drafts left out', () => {
  const rel = (tag, extra) => Object.assign({ tag_name: tag, body: '- point ' + tag, html_url: 'u/' + tag, published_at: '2026-11-1' }, extra);
  const list = [rel('v0.10.11'), rel('v0.10.14'), rel('v0.10.13', { draft: true }), rel('v0.10.12'), rel('v0.10.15', { prerelease: true }), rel('nightly')];
  const out = releaseNotes.notesBetween(list, '0.10.11');
  assert.deepStrictEqual(out.map((n) => n.version), ['0.10.14', '0.10.12']);
  assert.deepStrictEqual(out[0].points, ['point v0.10.14']);
  assert.strictEqual(out[0].url, 'u/v0.10.14');
  assert.deepStrictEqual(releaseNotes.notesBetween(list, '0.10.11', '0.10.12').map((n) => n.version), ['0.10.12']);
});

test('release notes: the list address comes from the latest-release address', () => {
  assert.strictEqual(
    releaseNotes.listUrl('https://api.github.com/repos/JustinWi/almost-video-feedback/releases/latest'),
    'https://api.github.com/repos/JustinWi/almost-video-feedback/releases?per_page=30'
  );
});

// ---- zip reading ----
test('zip: readZipEntries reads back what buildZipBytes wrote', () => {
  const enc = (s) => new Uint8Array(Buffer.from(s));
  const bytes = zip.buildZipBytes([{ name: 'a/one.txt', data: enc('hello') }, { name: 'a/b/two.json', data: enc('{"x":1}') }]);
  const got = zip.readZipEntries(bytes);
  assert.deepStrictEqual(got.map((e) => [e.name, e.method, Buffer.from(e.data).toString()]), [
    ['a/one.txt', 0, 'hello'],
    ['a/b/two.json', 0, '{"x":1}'],
  ]);
  assert.throws(() => zip.readZipEntries(enc('not a zip at all, just text padding it out')), /not a zip/);
});

atest('zip: entryBytes inflates a DEFLATE entry', async () => {
  const raw = require('zlib').deflateRawSync(Buffer.from('compressed text '.repeat(20)));
  const out = await zip.entryBytes({ name: 'x', method: 8, data: new Uint8Array(raw) });
  assert.strictEqual(Buffer.from(out).toString(), 'compressed text '.repeat(20));
});

// ---- one-click update ----
const selfUpdate = require('../src/common/self-update.js');
const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');

test('self-update: only paths inside the release folder are accepted', () => {
  assert.strictEqual(selfUpdate.stripTop('almost-video-feedback/src/a.js'), 'src/a.js');
  assert.strictEqual(selfUpdate.stripTop('other/src/a.js'), null);
  assert.deepStrictEqual(
    ['src/a.js', 'manifest.json', '../x', 'a/../b', '/etc/x', 'a\\b', '', 'a//b'].map(selfUpdate.safePath),
    [true, true, false, false, false, false, false, false]
  );
});

test('self-update: a download passes only when every file matches its list', () => {
  const listing = { version: '0.10.13', files: { 'manifest.json': sha('m'), 'src/a.js': sha('a') } };
  const good = { 'manifest.json': sha('m'), 'src/a.js': sha('a') };
  assert.deepStrictEqual(selfUpdate.verifyRelease(listing, good, '0.10.13', '0.10.13'), { ok: true, problems: [] });
  const bad = selfUpdate.verifyRelease(listing, { 'manifest.json': sha('m'), 'src/a.js': sha('tampered'), 'src/extra.js': sha('e') }, '0.10.13', '0.10.13');
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.problems, ["Doesn't match the release's file list: src/a.js", 'In the download but not on its file list: src/extra.js']);
  assert.match(selfUpdate.verifyRelease(listing, { 'manifest.json': sha('m') }, '0.10.13', '0.10.13').problems[0], /Missing from the download: src\/a\.js/);
  assert.match(selfUpdate.verifyRelease(listing, good, '0.10.14', '0.10.13').problems[0], /is v0\.10\.13, not v0\.10\.14/);
  assert.strictEqual(selfUpdate.verifyRelease(null, good, '0.10.13', '0.10.13').ok, false);
  assert.strictEqual(selfUpdate.verifyRelease({ version: '1.0.0', files: { '../evil': 'x' } }, { '../evil': 'x' }, '1.0.0', '1.0.0').ok, false);
});

test('self-update: manifest.json is written last, the list just before it, and only listed files are removed', () => {
  const next = { files: { 'src/b.js': 1, 'manifest.json': 1, 'src/a.js': 1 } };
  const old = { files: { 'src/a.js': 1, 'src/gone.js': 1, 'manifest.json': 1 } };
  assert.deepStrictEqual(selfUpdate.planWrites(next, old), {
    write: ['src/a.js', 'src/b.js', 'release-files.json', 'manifest.json'],
    remove: ['src/gone.js'],
  });
  assert.deepStrictEqual(selfUpdate.planWrites(next, null).remove, []); // a git clone: delete nothing
});

test('self-update: every failure says what happened and that the old version is still running', () => {
  assert.match(selfUpdate.describeError({ stage: 'download', message: 'GitHub answered 404' }, '0.10.12'), /^Couldn't download .*GitHub answered 404.*still on v0\.10\.12\.$/);
  assert.match(selfUpdate.describeError({ stage: 'check', message: 'Missing from the download: src/a.js' }, '0.10.12'), /Nothing in your folder was changed/);
  assert.match(selfUpdate.describeError({ stage: 'write', path: 'src/x.js' }, '0.10.12'), /didn't let me save src\/x\.js\. I put back/);
});

// an in-memory folder that behaves like a File System Access directory handle
function memFolder(files, failOn) {
  const nf = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
  const at = (prefix) => ({
    async getDirectoryHandle(name, o) {
      const p = prefix + name + '/';
      if (!Object.keys(files).some((k) => k.indexOf(p) === 0) && !(o && o.create)) throw nf();
      return at(p);
    },
    async getFileHandle(name, o) {
      const p = prefix + name;
      if (!(p in files) && !(o && o.create)) throw nf();
      return {
        async getFile() { return new Blob([files[p]]); },
        async createWritable() {
          let buf = null;
          return {
            async write(b) { if (p === failOn) throw new Error('disk full'); buf = b; },
            async close() { files[p] = Buffer.from(buf).toString(); },
            async abort() {},
          };
        },
      };
    },
    async removeEntry(name) { if (!(prefix + name in files)) throw nf(); delete files[prefix + name]; },
    async queryPermission() { return 'granted'; },
  });
  return at('');
}

function releaseZip(version, files) {
  const enc = (s) => new Uint8Array(Buffer.from(s));
  const listing = { version, files: {} };
  for (const [k, v] of Object.entries(files)) listing.files[k] = sha(v);
  const entries = [{ name: 'almost-video-feedback/release-files.json', data: enc(JSON.stringify(listing)) }];
  for (const [k, v] of Object.entries(files)) entries.push({ name: 'almost-video-feedback/' + k, data: enc(v) });
  return { bytes: zip.buildZipBytes(entries), listing };
}

atest('self-update: run downloads, checks, writes every file and removes the one the release dropped', async () => {
  const oldListing = { version: '0.10.12', files: { 'manifest.json': sha('{"version":"0.10.12"}'), 'src/a.js': sha('old a'), 'src/gone.js': sha('gone') } };
  const folder = { 'manifest.json': '{"version":"0.10.12"}', 'src/a.js': 'old a', 'src/gone.js': 'gone', 'release-files.json': JSON.stringify(oldListing), 'notes.txt': 'mine' };
  const rel = releaseZip('0.10.13', { 'manifest.json': '{"version":"0.10.13"}', 'src/a.js': 'new a', 'src/new/b.js': 'b' });
  global.SCF_ZIP = zip;
  global.fetch = async () => new Response(rel.bytes, { headers: { 'content-length': String(rel.bytes.length) } });
  const seen = [];
  try {
    const r = await selfUpdate.run({ dir: memFolder(folder), zipUrl: 'z', version: '0.10.13', onProgress: (e) => seen.push(e.phase) });
    assert.deepStrictEqual(r, { version: '0.10.13', written: 4, removed: 1 });
    assert.deepStrictEqual(folder['src/a.js'], 'new a');
    assert.deepStrictEqual(folder['src/new/b.js'], 'b');
    assert.strictEqual(folder['manifest.json'], '{"version":"0.10.13"}');
    assert.strictEqual(JSON.parse(folder['release-files.json']).version, '0.10.13');
    assert.ok(!('src/gone.js' in folder), 'the dropped file is removed');
    assert.strictEqual(folder['notes.txt'], 'mine', 'a file no release put there is left alone');
    assert.deepStrictEqual([...new Set(seen)], ['download', 'check', 'write']);
  } finally {
    delete global.fetch;
    delete global.SCF_ZIP;
  }
});

atest('self-update: a tampered download writes nothing; a failed write puts the old files back', async () => {
  const folder = { 'manifest.json': '{"version":"0.10.12"}', 'src/a.js': 'old a' };
  const before = JSON.stringify(folder);
  const rel = releaseZip('0.10.13', { 'manifest.json': '{"version":"0.10.13"}', 'src/a.js': 'new a', 'src/b.js': 'b' });
  global.SCF_ZIP = zip;
  try {
    // same zip, one byte changed inside src/a.js ('new a' -> 'new b')
    const bad = Uint8Array.from(rel.bytes);
    const at = Buffer.from(bad).indexOf('new a');
    bad[at + 4] = 'b'.charCodeAt(0);
    global.fetch = async () => new Response(bad);
    await assert.rejects(selfUpdate.run({ dir: memFolder(folder), zipUrl: 'z', version: '0.10.13' }), (e) => e.stage === 'check' && /src\/a\.js/.test(e.message));
    assert.strictEqual(JSON.stringify(folder), before);

    // writing stops at src/b.js (after src/a.js was already replaced)
    global.fetch = async () => new Response(rel.bytes);
    await assert.rejects(selfUpdate.run({ dir: memFolder(folder, 'src/b.js'), zipUrl: 'z', version: '0.10.13' }), (e) => e.stage === 'write' && e.path === 'src/b.js');
    assert.strictEqual(JSON.stringify(folder), before);

    global.fetch = async () => new Response('', { status: 404 });
    await assert.rejects(selfUpdate.run({ dir: memFolder(folder), zipUrl: 'z', version: '0.10.13' }), (e) => e.stage === 'download' && /404/.test(e.message));
  } finally {
    delete global.fetch;
    delete global.SCF_ZIP;
  }
});

test('self-update: the progress bar moves forward through each phase', () => {
  const t = (e) => selfUpdate.progressText(e, '0.10.13');
  const pcts = [t({ phase: 'download', done: 50, total: 100 }), t({ phase: 'check' }), t({ phase: 'write', done: 10, total: 50 }), t({ phase: 'write', done: 50, total: 50 }), t({ phase: 'restart' })].map((x) => x.pct);
  assert.deepStrictEqual(pcts, pcts.slice().sort((a, b) => a - b));
  assert.strictEqual(t({ phase: 'write', done: 31, total: 49 }).label, 'Writing file 31 of 49…');
  assert.strictEqual(t({ phase: 'restart' }).pct, 100);
});

(async () => {
  for (const t of asyncTests) {
    try {
      await t.fn();
      passed++;
      console.log('  ✓ ' + t.name);
    } catch (err) {
      failed++;
      console.log('  ✗ ' + t.name);
      console.log('    ' + (err && err.message ? err.message : err));
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
