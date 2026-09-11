/*
 * Regenerate Chrome Web Store promo images from docs/store-assets.html using
 * headless Chrome. Each box is isolated via ?shot=<id> and captured at its exact
 * pixel size. Run: node scripts/gen-store-images.cjs
 *
 * Outputs into docs/store/. Add/adjust entries in SHOTS to (re)generate more.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const src = path.join(root, 'docs', 'store-assets.html');
const outDir = path.join(root, 'docs', 'store');

const SHOTS = [
  { id: 's3', w: 1280, h: 800, out: '04-draw-and-loom.png' },
  { id: 'marquee', w: 1400, h: 560, out: 'marquee-1400x560.png' },
  { id: 'tile', w: 440, h: 280, out: 'promo-tile-440x280.png' },
];

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) {
      /* ignore */
    }
  }
  throw new Error('Chrome not found — set CHROME_PATH');
}

const chrome = findChrome();
const fileUrl = 'file:///' + src.replace(/\\/g, '/');

for (const s of SHOTS) {
  const out = path.join(outDir, s.out);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    '--screenshot=' + out,
    '--window-size=' + s.w + ',' + s.h,
    '--virtual-time-budget=6000',
    fileUrl + '?shot=' + s.id,
  ];
  execFileSync(chrome, args, { stdio: 'ignore' });
  const sz = fs.existsSync(out) ? fs.statSync(out).size : 0;
  console.log((sz ? 'wrote ' : 'FAILED ') + path.relative(root, out) + '  ' + s.w + 'x' + s.h + '  ' + sz + ' bytes');
}
