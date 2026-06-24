/*
 * Perceptual hashing for "cull near-identical screenshots" (dedup-by-diff).
 *
 * dHash (difference hash): downscale to 9x8 grayscale, then for each row record
 * whether each pixel is brighter than its right neighbour -> 8x8 = 64 bits.
 * Two images with a small Hamming distance are visually near-identical.
 *
 * Pure module: in the browser it attaches to globalThis.SCF.imageHash; in Node
 * (tests) it exports via module.exports. No DOM/Canvas dependency here — callers
 * pass an {width, height, data} ImageData-like object (RGBA, length w*h*4).
 */
(function () {
  'use strict';

  const HASH_W = 9; // 8 comparisons per row
  const HASH_H = 8;

  function luminance(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b;
  }

  // Convert a 64-char binary string to a 16-char hex string.
  function bitsToHex(bits) {
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    return hex;
  }

  /**
   * @param {{width:number,height:number,data:Uint8ClampedArray|number[]}} imageData
   *        Expected to be HASH_W x HASH_H (9x8) RGBA. If larger, the top-left
   *        9x8 block is sampled (callers should resize via canvas first).
   * @returns {string} 16-char hex dHash
   */
  function dHash(imageData) {
    const { width, data } = imageData;
    let bits = '';
    for (let y = 0; y < HASH_H; y++) {
      for (let x = 0; x < HASH_W - 1; x++) {
        const i1 = (y * width + x) * 4;
        const i2 = (y * width + (x + 1)) * 4;
        const g1 = luminance(data[i1], data[i1 + 1], data[i1 + 2]);
        const g2 = luminance(data[i2], data[i2 + 1], data[i2 + 2]);
        bits += g1 > g2 ? '1' : '0';
      }
    }
    return bitsToHex(bits);
  }

  const POPCOUNT = (() => {
    const t = new Array(16);
    for (let i = 0; i < 16; i++) {
      t[i] = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1);
    }
    return t;
  })();

  /** Hamming distance between two equal-length hex hashes (0..64). */
  function hammingDistance(hexA, hexB) {
    if (!hexA || !hexB || hexA.length !== hexB.length) return 64;
    let d = 0;
    for (let i = 0; i < hexA.length; i++) {
      const x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
      d += POPCOUNT[x];
    }
    return d;
  }

  /** True when two hashes are within `threshold` bits => visually duplicate. */
  function isDuplicate(hexA, hexB, threshold) {
    return hammingDistance(hexA, hexB) <= threshold;
  }

  // ---- region-aware change detection (for click dedup) --------------------
  // A coarse dHash can't "see" a small UI change (a toggle, a menu) because the
  // whole screen is squashed to 9x8. So for clicks we keep a slightly larger
  // grayscale thumbnail and ask two questions: did much of the *page* change, or
  // did the small area *around the click* change? Either one => keep the frame.

  /**
   * Flatten an RGBA ImageData-like object to a grayscale Uint8 array (0..255),
   * one byte per pixel, row-major. Caller resizes to the thumbnail size first.
   */
  function toGray(imageData) {
    const { width, height, data } = imageData;
    const out = new Uint8Array(width * height);
    for (let i = 0, p = 0; p < out.length; i += 4, p++) {
      out[p] = luminance(data[i], data[i + 1], data[i + 2]) | 0;
    }
    return out;
  }

  /**
   * Fraction (0..1) of cells whose grayscale value moved by more than `eps`,
   * optionally restricted to a box. `box` is {x0,y0,x1,y1} in cell coords
   * (x1/y1 exclusive). Mismatched/empty inputs => 1 (treat as fully changed).
   */
  function changeRatio(a, b, w, h, box, eps) {
    if (!a || !b || a.length !== w * h || b.length !== w * h) return 1;
    const e = eps == null ? 18 : eps;
    const x0 = box ? Math.max(0, Math.min(w, box.x0 | 0)) : 0;
    const y0 = box ? Math.max(0, Math.min(h, box.y0 | 0)) : 0;
    const x1 = box ? Math.max(x0, Math.min(w, box.x1 | 0)) : w;
    const y1 = box ? Math.max(y0, Math.min(h, box.y1 | 0)) : h;
    const cells = (x1 - x0) * (y1 - y0);
    if (cells <= 0) return 0;
    let changed = 0;
    for (let y = y0; y < y1; y++) {
      let i = y * w + x0;
      for (let x = x0; x < x1; x++, i++) {
        if (Math.abs(a[i] - b[i]) > e) changed++;
      }
    }
    return changed / cells;
  }

  /**
   * A square box (in cell coords) of half-size `radius` centered on a click given
   * in normalized viewport coords (nx,ny in 0..1). Clamped to the grid.
   */
  function regionBox(w, h, nx, ny, radius) {
    const cx = Math.round((nx || 0) * w);
    const cy = Math.round((ny || 0) * h);
    return { x0: cx - radius, y0: cy - radius, x1: cx + radius + 1, y1: cy + radius + 1 };
  }

  const api = {
    HASH_W,
    HASH_H,
    luminance,
    bitsToHex,
    dHash,
    hammingDistance,
    isDuplicate,
    toGray,
    changeRatio,
    regionBox,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    const root = typeof globalThis !== 'undefined' ? globalThis : self;
    root.SCF = root.SCF || {};
    root.SCF.imageHash = api;
  }
})();
