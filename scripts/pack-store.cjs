/*
 * Build a Chrome Web Store upload package. Unlike pack.cjs (which wraps files in
 * a top folder for "Load unpacked"), the Web Store requires manifest.json at the
 * ZIP ROOT. Ships only the runnable extension + license — no dev docs.
 * Run: node scripts/pack-store.cjs  ->  dist/almost-video-feedback-store.zip
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zip = require('../src/common/zip.js');

const root = path.join(__dirname, '..');
const FILES = ['manifest.json', 'LICENSE'];
const DIRS = ['icons', 'src'];

function walk(dir, acc) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const files = [];
for (const f of FILES) {
  const p = path.join(root, f);
  if (fs.existsSync(p)) files.push(p);
}
for (const d of DIRS) {
  const p = path.join(root, d);
  if (fs.existsSync(p)) walk(p, files);
}

// names are relative to repo root => manifest.json is at the zip root
const entries = files.map((full) => ({
  name: path.relative(root, full).split(path.sep).join('/'),
  data: new Uint8Array(fs.readFileSync(full)),
}));

const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'almost-video-feedback-store.zip');
fs.writeFileSync(out, Buffer.from(zip.buildZipBytes(entries)));

// quick manifest description length check (CWS summary limit is 132)
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const len = (manifest.description || '').length;
console.log('wrote dist/almost-video-feedback-store.zip — ' + entries.length + ' files, ' + fs.statSync(out).size + ' bytes');
console.log('manifest.description: ' + len + ' chars ' + (len <= 132 ? '(ok, <= 132)' : '(TOO LONG, must be <= 132)'));
