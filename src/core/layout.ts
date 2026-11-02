/**
 * Collision checks between sequentially printed objects, and automatic placement.
 *
 * When object B is printed after object A, the nozzle starts at the bed next to a finished A.
 * So every slab of A at height z must keep the XY distance from B's nozzle positions that the
 * clearance model demands for a rise of z above the tip: none within one layer, nozzleRadius up to
 * nozzleHeight, shroudRadius up to gantryHeight, and beyond the gantry height A cannot be printed
 * before B at all.
 */
import { bboxContains, bboxDistance, bboxOf, convexHull, placePolygon, polygonGap } from './geom.ts';
import type { GcodeObject } from './gcode.ts';
import type { BBox, BedSettings, ClearanceModel, Placement, Vec2 } from './types.ts';

/** Minimum XY gap that material rising `rise` above the nozzle tip must keep from the nozzle axis. */
export function requiredGap(rise: number, c: ClearanceModel, layerHeight: number): number {
  if (rise <= layerHeight * 1.001) return 0;
  if (rise <= c.nozzleHeight) return c.nozzleRadius;
  if (rise <= c.gantryHeight) return c.shroudRadius;
  return Infinity;
}

export interface Band {
  need: number;
  /** Lowest slab top in the band, for messages. */
  zFrom: number;
  hull: Vec2[];
}

/** Group an object's slabs by the gap they need from a later object's nozzle, hull per group. */
export function clearanceBands(obj: GcodeObject, c: ClearanceModel, layerHeight: number): Band[] {
  const groups = new Map<number, { zFrom: number; pts: Vec2[] }>();
  for (const s of obj.slabs) {
    const need = requiredGap(s.zTop, c, layerHeight);
    let g = groups.get(need);
    if (!g) { g = { zFrom: s.zTop, pts: [] }; groups.set(need, g); }
    g.pts.push(...s.hull);
  }
  return [...groups.entries()].map(([need, g]) => ({ need, zFrom: g.zFrom, hull: convexHull(g.pts) }));
}

export type ViolationKind = 'overlap' | 'gap' | 'order' | 'bed';

export interface Violation {
  kind: ViolationKind;
  /** Index of the earlier object (or the object itself for 'bed'). */
  a: number;
  /** Index of the later object, -1 for 'bed'. */
  b: number;
  need: number;
  have: number;
  /** Closest points on the bed, for drawing. */
  pa?: Vec2;
  pb?: Vec2;
  message: string;
}

export function bedBox(bed: BedSettings): BBox {
  return bed.originCenter
    ? { minX: -bed.width / 2, minY: -bed.depth / 2, maxX: bed.width / 2, maxY: bed.depth / 2 }
    : { minX: 0, minY: 0, maxX: bed.width, maxY: bed.depth };
}

/** Bed-space hull of everywhere the nozzle goes while printing the object. */
export function placedNozzleHull(obj: GcodeObject, pl: Placement): Vec2[] {
  return placePolygon(obj.nozzleHull, obj.center, pl);
}

const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '∞');

/**
 * Check one ordered pair: `a` printed before `b`. Returns the worst violation or null.
 * `bandsA` must be clearanceBands(a, clearance, b.firstLayerHeight) or equivalent.
 */
export function checkPair(ai: number, a: GcodeObject, pa: Placement, bandsA: Band[], bi: number, b: GcodeObject, pb: Placement): Violation | null {
  const nozzleB = placedNozzleHull(b, pb);
  const boxB = bboxOf(nozzleB);
  let worst: Violation | null = null;
  for (const band of bandsA) {
    const hull = placePolygon(band.hull, a.center, pa);
    if (band.need === Infinity) {
      const v: Violation = { kind: 'order', a: ai, b: bi, need: Infinity, have: 0, message: `${a.name} rises above the gantry height from ${fmt(band.zFrom)} mm, so it cannot be printed before ${b.name}. Print it last.` };
      return v;
    }
    if (bboxDistance(bboxOf(hull), boxB) > band.need) continue;
    const g = polygonGap(hull, nozzleB);
    if (g.gap < 0) {
      worst = { kind: 'overlap', a: ai, b: bi, need: band.need, have: 0, pa: g.pa, pb: g.pb, message: `${a.name} and ${b.name} overlap.` };
      return worst;
    }
    if (g.gap < band.need - 1e-6) {
      const v: Violation = {
        kind: 'gap', a: ai, b: bi, need: band.need, have: g.gap, pa: g.pa, pb: g.pb,
        message: `${b.name} is ${fmt(g.gap)} mm from ${a.name}, which stands ${fmt(band.zFrom)} mm or more above the bed; ${fmt(band.need)} mm is needed.`,
      };
      if (!worst || v.need - v.have > worst.need - worst.have) worst = v;
    }
  }
  return worst;
}

export interface LayoutCheck {
  violations: Violation[];
  /** Whether any pair conflicts (bed warnings are not counted). */
  collides: boolean;
}

/** Check every ordered pair and the bed bounds. `objs` are in print order. */
export function checkLayout(objs: GcodeObject[], placements: Placement[], clearance: ClearanceModel, bed: BedSettings): LayoutCheck {
  const violations: Violation[] = [];
  const bedRect = bedBox(bed);
  const bands = objs.map((o, i) => clearanceBands(o, clearance, objs[Math.min(i + 1, objs.length - 1)].firstLayerHeight));
  for (let i = 0; i < objs.length; i++) {
    const hull = placedNozzleHull(objs[i], placements[i]);
    if (!bboxContains(bedRect, bboxOf(hull))) {
      violations.push({ kind: 'bed', a: i, b: -1, need: 0, have: 0, message: `${objs[i].name} reaches outside the bed.` });
    }
  }
  for (let i = 0; i < objs.length; i++) {
    for (let j = i + 1; j < objs.length; j++) {
      const v = checkPair(i, objs[i], placements[i], bands[i], j, objs[j], placements[j]);
      if (v) violations.push(v);
    }
  }
  return { violations, collides: violations.some((v) => v.kind !== 'bed') };
}

/** Does object `idx` at `pl` fit on the bed and against every object in `others` (both orders)? */
function fits(objs: GcodeObject[], placements: Placement[], bands: Band[][], idx: number, pl: Placement, others: number[], bedRect: BBox): boolean {
  const hull = placedNozzleHull(objs[idx], pl);
  if (!bboxContains(bedRect, bboxOf(hull))) return false;
  for (const o of others) {
    const [i, j] = o < idx ? [o, idx] : [idx, o];
    const pi = i === idx ? pl : placements[i], pj = j === idx ? pl : placements[j];
    if (checkPair(i, objs[i], pi, bands[i], j, objs[j], pj)) return false;
  }
  return true;
}

/**
 * First bed position (scanning front row first, left to right) where object `idx` fits against
 * the objects listed in `others`, keeping its rotation. null when nothing fits.
 */
export function findFreeSpot(objs: GcodeObject[], placements: Placement[], idx: number, others: number[], clearance: ClearanceModel, bed: BedSettings, step = 5): Placement | null {
  const bedRect = bedBox(bed);
  const bands = objs.map((o, i) => clearanceBands(o, clearance, objs[Math.min(i + 1, objs.length - 1)].firstLayerHeight));
  const rot = placements[idx].rot;
  // footprint of the rotated nozzle hull, to keep the scan inside the bed
  const hull0 = placedNozzleHull(objs[idx], { x: 0, y: 0, rot });
  const box0 = bboxOf(hull0);
  const margin = 2;
  const x0 = bedRect.minX - box0.minX + margin, x1 = bedRect.maxX - box0.maxX - margin;
  const y0 = bedRect.minY - box0.minY + margin, y1 = bedRect.maxY - box0.maxY - margin;
  if (x1 < x0 || y1 < y0) return null;
  for (let y = y0; y <= y1 + 1e-9; y += step) {
    for (let x = x0; x <= x1 + 1e-9; x += step) {
      const pl = { x, y, rot };
      if (fits(objs, placements, bands, idx, pl, others, bedRect)) return pl;
    }
  }
  // last chance: the far corner exactly
  const pl = { x: x1, y: y1, rot };
  return fits(objs, placements, bands, idx, pl, others, bedRect) ? pl : null;
}

/** Re-place every object in print order from the front-left corner. Returns the indices that did not fit. */
export function arrangeAll(objs: GcodeObject[], placements: Placement[], clearance: ClearanceModel, bed: BedSettings): number[] {
  const unplaced: number[] = [];
  const placed: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    const pl = findFreeSpot(objs, placements, i, placed, clearance, bed);
    if (pl) { placements[i] = pl; placed.push(i); } else unplaced.push(i);
  }
  return unplaced;
}
