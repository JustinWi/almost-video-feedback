/*
 * Build-time sanity check (no browser needed):
 *  - manifest.json parses
 *  - every file the manifest references exists
 *  - a few code-referenced pages exist
 *  - every .js file passes `node --check` (syntax)
 * Run: node scripts/verify.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
let problems = 0;
function ok(m) { console.log('  ✓ ' + m); }
function bad(m) { problems++; console.log('  ✗ ' + m); }

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

console.log('manifest:');
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  ok('manifest.json parses');
} catch (e) {
  bad('manifest.json invalid: ' + e.message);
  process.exit(1);
}

// version sync: manifest.json (what Chrome reads) and package.json must agree.
// `npm run bump` updates both together; this guards against editing only one.
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version === pkg.version) ok('version in sync: ' + manifest.version);
  else bad('version mismatch: manifest.json ' + manifest.version + ' != package.json ' + pkg.version + ' (run npm run bump)');
} catch (e) {
  bad('package.json invalid: ' + e.message);
}

const refs = [];
refs.push(manifest.background && manifest.background.service_worker);
(manifest.content_scripts || []).forEach((cs) => {
  (cs.js || []).forEach((j) => refs.push(j));
  (cs.css || []).forEach((c) => refs.push(c));
});
if (manifest.action && manifest.action.default_popup) refs.push(manifest.action.default_popup);
if (manifest.options_page) refs.push(manifest.options_page);
Object.values((manifest.action && manifest.action.default_icon) || {}).forEach((p) => refs.push(p));
Object.values(manifest.icons || {}).forEach((p) => refs.push(p));

console.log('referenced files:');
for (const r of refs.filter(Boolean)) {
  if (exists(r)) ok(r);
  else bad('missing: ' + r);
}

// pages referenced from code, not the manifest
console.log('code-referenced pages:');
['src/offscreen/offscreen.html', 'src/offscreen/offscreen.js', 'src/popup/popup.js', 'src/options/options.js', 'src/history/history.html', 'src/history/history.js', 'src/common/zip.js', 'src/recognizer/recognizer.html', 'src/recognizer/recognizer.js'].forEach((p) => {
  if (exists(p)) ok(p);
  else bad('missing: ' + p);
});

// syntax-check every JS file
console.log('syntax (node --check):');
function walk(dir, acc) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      walk(full, acc);
    } else if (/\.(js|cjs|mjs)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}
const jsFiles = walk(root, []);
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    ok(path.relative(root, f));
  } catch (e) {
    bad(path.relative(root, f) + ' — ' + (e.stderr ? e.stderr.toString().split('\n')[0] : e.message));
  }
}

console.log('\n' + (problems ? problems + ' problem(s)' : 'all checks passed'));
process.exit(problems ? 1 : 0);
