import type { BBox, Placement, Vec2 } from './types.ts';

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function bboxOf(pts: Vec2[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxCenter(b: BBox): Vec2 {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/** Euclidean gap between two boxes; 0 when they overlap. */
export function bboxDistance(a: BBox, b: BBox): number {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Convex hull (Andrew's monotone chain), CCW, collinear points dropped. Degenerate inputs come back as is. */
export function convexHull(pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return pts.map((p) => ({ x: p.x, y: p.y }));
  const s = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Vec2[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 1 ? hull : s.slice(0, 1);
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function segmentsIntersect(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const d1 = orient(q1, q2, p1), d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1), d4 = orient(p1, p2, q2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Squared distance from p to segment ab. */
export function pointSegmentDist2(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * vx - p.x, cy = a.y + t * vy - p.y;
  return cx * cx + cy * cy;
}

/** Do two closed polygons overlap as regions (share interior, or one contains the other)? */
export function polygonsOverlap(a: Vec2[], b: Vec2[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return true;
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i], p2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(p1, p2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/** Minimum distance between the boundaries of two polygons (0 when they touch or cross). */
export function polygonDistance(a: Vec2[], b: Vec2[]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i], p2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const q1 = b[j], q2 = b[(j + 1) % b.length];
      if (segmentsIntersect(p1, p2, q1, q2)) return 0;
      const d = Math.min(pointSegmentDist2(q1, p1, p2), pointSegmentDist2(p1, q1, q2));
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/**
 * Gap between two polygons as regions: the boundary distance, or -1 when they overlap.
 * Closest points are returned for drawing.
 */
export function polygonGap(a: Vec2[], b: Vec2[]): { gap: number; pa: Vec2; pb: Vec2 } {
  if (polygonsOverlap(a, b)) return { gap: -1, pa: a[0], pb: b[0] };
  let best = Infinity, pa = a[0], pb = b[0];
  const consider = (p: Vec2, s1: Vec2, s2: Vec2, pIsA: boolean) => {
    const vx = s2.x - s1.x, vy = s2.y - s1.y;
    const l2 = vx * vx + vy * vy;
    let t = l2 === 0 ? 0 : ((p.x - s1.x) * vx + (p.y - s1.y) * vy) / l2;
    t = Math.max(0, Math.min(1, t));
    const c = { x: s1.x + t * vx, y: s1.y + t * vy };
    const d = dist(p, c);
    if (d < best) { best = d; if (pIsA) { pa = p; pb = c; } else { pa = c; pb = p; } }
  };
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i], p2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const q1 = b[j], q2 = b[(j + 1) % b.length];
      consider(q1, p1, p2, false);
      consider(p1, q1, q2, true);
    }
  }
  return { gap: best, pa, pb };
}

/** Map a point from an object's own (as-sliced) coordinates to the bed, given its centre and placement. */
export function placePoint(p: Vec2, center: Vec2, pl: Placement): Vec2 {
  const a = (pl.rot * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const dx = p.x - center.x, dy = p.y - center.y;
  return { x: pl.x + dx * c - dy * s, y: pl.y + dx * s + dy * c };
}

/** Rotate a vector (not a point) by the placement's rotation. */
export function rotateVec(v: Vec2, rotDeg: number): Vec2 {
  const a = (rotDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

export function placePolygon(poly: Vec2[], center: Vec2, pl: Placement): Vec2[] {
  return poly.map((p) => placePoint(p, center, pl));
}

/** Expand a polygon's bbox by a margin on all sides. */
export function bboxExpand(b: BBox, m: number): BBox {
  return { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
}

export function bboxContains(outer: BBox, inner: BBox, tol = 1e-6): boolean {
  return inner.minX >= outer.minX - tol && inner.maxX <= outer.maxX + tol && inner.minY >= outer.minY - tol && inner.maxY <= outer.maxY + tol;
}
