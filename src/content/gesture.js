/*
 * Mouse-gesture math for deciding "the user is gesturing at something".
 * Pure functions so they can be unit-tested in Node; in the content script
 * (classic, shared isolated-world scope) they attach to globalThis.SCF_GESTURE.
 *
 * Two signals:
 *   - circling/scribbling: a long path packed into a small bounding box
 *     (high pathLength / boundingBoxDiagonal ratio).
 *   - dwell-after-movement: handled with timers in content.js, using
 *     totalDistance() here to confirm the user actually moved first.
 */
(function () {
  'use strict';

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** Total length of the polyline through the points. */
  function pathLength(points) {
    let len = 0;
    for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
    return len;
  }

  /** Diagonal of the axis-aligned bounding box of the points. */
  function boundingBoxDiagonal(points) {
    if (points.length === 0) return 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const w = maxX - minX;
    const h = maxY - minY;
    return Math.sqrt(w * w + h * h);
  }

  /**
   * Decide whether a set of recent points (already windowed by the caller to a
   * short time span) looks like the user circling/scribbling over a target.
   * @param {{x:number,y:number}[]} points
   * @param {{circleMinPathPx:number, circleRatio:number}} opts
   */
  function analyzeGesture(points, opts) {
    const len = pathLength(points);
    const diag = boundingBoxDiagonal(points) || 1;
    const ratio = len / diag;
    const isCircle = len >= opts.circleMinPathPx && ratio >= opts.circleRatio;
    return { pathLength: len, bboxDiag: diag, ratio, isCircle };
  }

  /**
   * Shift-constrained drawing (like Photoshop): snap `p` onto the horizontal or
   * vertical line through `anchor`, whichever axis the pointer moved along more.
   * A tie (incl. no movement) snaps horizontal.
   */
  function snapAxis(anchor, p) {
    const dx = Math.abs(p.x - anchor.x);
    const dy = Math.abs(p.y - anchor.y);
    return dx >= dy ? { x: p.x, y: anchor.y } : { x: anchor.x, y: p.y };
  }

  const api = { dist, pathLength, boundingBoxDiagonal, analyzeGesture, snapAxis };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    const root = typeof globalThis !== 'undefined' ? globalThis : self;
    root.SCF_GESTURE = api;
  }
})();
