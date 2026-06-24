/*
 * Bump the extension version in manifest.json AND package.json together, so the
 * two never drift (scripts/verify.cjs enforces that they match).
 *
 * Usage:
 *   node scripts/bump.cjs            # patch: 0.1.0 -> 0.1.1  (default)
 *   node scripts/bump.cjs minor      #        0.1.0 -> 0.2.0
 *   node scripts/bump.cjs major      #        0.1.0 -> 1.0.0
 *   node scripts/bump.cjs 1.4.2      # set an explicit X.Y.Z
 *
 * manifest.json is the source of truth for the current version (it's what Chrome
 * reads). We edit the files textually so their formatting is left untouched.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const TARGETS = ['manifest.json', 'package.json'];
// matches `"version": "1.2.3"` but not `"manifest_version"` / `"minimum_chrome_version"`
const VERSION_RE = /("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")/;

const arg = (process.argv[2] || 'patch').toLowerCase();

const manifestSrc = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
const m = manifestSrc.match(VERSION_RE);
if (!m) {
  console.error('bump: could not find a "version": "X.Y.Z" in manifest.json');
  process.exit(1);
}
const [major, minor, patch] = [Number(m[2]), Number(m[3]), Number(m[4])];
const current = `${major}.${minor}.${patch}`;

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else if (arg === 'major') next = `${major + 1}.0.0`;
else if (arg === 'minor') next = `${major}.${minor + 1}.0`;
else if (arg === 'patch') next = `${major}.${minor}.${patch + 1}`;
else {
  console.error(`bump: unknown argument "${arg}" — use patch | minor | major | X.Y.Z`);
  process.exit(1);
}

for (const rel of TARGETS) {
  const full = path.join(root, rel);
  const src = fs.readFileSync(full, 'utf8');
  if (!VERSION_RE.test(src)) {
    console.error(`bump: no "version" field in ${rel}`);
    process.exit(1);
  }
  fs.writeFileSync(full, src.replace(VERSION_RE, `$1${next}$5`));
}

console.log(`version ${current} -> ${next}  (manifest.json + package.json)`);
console.log('next: npm test && npm run verify && npm run pack');
console.log(`then: git commit, then  gh release create v${next} dist/almost-video-feedback.zip`);
