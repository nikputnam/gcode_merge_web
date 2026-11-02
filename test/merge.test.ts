import { describe, expect, it } from 'vitest';
import { newState, parseGcode, simulate, type MachineState } from '../src/core/gcode.ts';
import { mergeJob } from '../src/core/merge.ts';
import type { Placement } from '../src/core/types.ts';
import { SETTINGS, fixture, load, potToyLike } from './helpers.ts';

const at = (x: number, y: number, rot = 0): Placement => ({ x, y, rot });

/** Replay a whole merged file and collect the facts the tests need. */
function replay(gcode: string) {
  const lines = gcode.split('\n');
  const st: MachineState = newState();
  let extrusion = 0, minDe = 0, maxZ = 0;
  const travelsAbove: number[] = [];
  const moves: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; de: number; line: number }[] = [];
  simulate(lines, st, (m, i) => {
    moves.push({ ...m, line: i });
    if (m.de > 0 && m.hasXY) extrusion += Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
    if (m.de < minDe) minDe = m.de;
    if (m.to.z > maxZ && !st.relativeXYZ) maxZ = m.to.z;
    if (m.hasXY && m.de <= 0 && Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y) > 20) travelsAbove.push(m.from.z);
  });
  return { lines, st, extrusion, minDe, maxZ, travelsAbove, moves };
}

describe('mergeJob with two PrusaSlicer objects', () => {
  const a = load('cylinder.gcode');
  const b = load('tube.gcode');
  const res = mergeJob([a, b], [at(50, 50), at(150, 150)], SETTINGS);
  const r = replay(res.gcode);

  it('uses one start and one end G-code', () => {
    expect(r.lines.filter((l) => l === 'G28 ; home all axes').length).toBe(1);
    expect(r.lines.filter((l) => l.startsWith('M190')).length).toBe(1);
    expect(r.lines.filter((l) => l === 'M84     ; disable motors').length).toBe(1);
    expect(r.lines.filter((l) => l.startsWith('; prusaslicer_config = begin')).length).toBe(1);
    expect(res.footerFrom).toBe(0); // the 20 mm cylinder is taller than the 15 mm tube
    expect(res.warnings.filter((w) => /start G-code differs/.test(w))).toEqual([]);
  });

  it('prints both objects in full, in order', () => {
    expect(r.extrusion).toBeCloseTo(a.extrusionLength + b.extrusionLength, 0);
    const firstB = r.lines.indexOf('; ---- object 2: tube ----');
    expect(firstB).toBeGreaterThan(0);
    const aMoves = r.moves.filter((m) => m.line < firstB && m.de > 0);
    const bMoves = r.moves.filter((m) => m.line > firstB && m.de > 0);
    expect(Math.max(...aMoves.map((m) => m.to.x))).toBeLessThan(80);
    expect(Math.min(...bMoves.map((m) => m.to.x))).toBeGreaterThan(120);
  });

  it('lifts above the first object before travelling to the second', () => {
    const firstB = r.lines.indexOf('; ---- object 2: tube ----');
    const transition = r.moves.filter((m) => m.line > firstB && m.line < firstB + 12);
    const long = transition.find((m) => Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y) > 50)!;
    expect(long).toBeDefined();
    expect(long.from.z).toBeCloseTo(a.height + SETTINGS.travelLift, 6);
    expect(long.to.z).toBeCloseTo(a.height + SETTINGS.travelLift, 6);
    // it lands on the second object's first XY target, then descends to where its body expects to be
    const bFirst = r.moves.find((m) => m.line > long.line && m.to.z < 1)!;
    expect(bFirst.from.x).toBeCloseTo(long.to.x, 3);
    expect(bFirst.to.z).toBeCloseTo(b.zAtFirstXY, 6);
    expect(r.minDe).toBeGreaterThanOrEqual(-1.0001);
  });

  it('keeps extrusion continuous through the transition', () => {
    const firstB = r.lines.indexOf('; ---- object 2: tube ----');
    // the first object ends retracted by 1 mm (its own last move), so the transition does not retract again
    const bodyStart = r.lines.indexOf(';LAYER_CHANGE', firstB);
    const chunk = r.lines.slice(firstB, bodyStart);
    expect(chunk.filter((l) => /^G1 E-/.test(l)).length).toBe(0);
    // ...and primes once before handing over to the body
    expect(chunk.filter((l) => /^G1 E1 F/.test(l)).length).toBe(1);
    // same temperature throughout, so nothing is re-sent
    expect(chunk.some((l) => /^M109/.test(l))).toBe(false);
  });

  it('replays a different first-layer temperature from the second object\'s start G-code', () => {
    const hot = parseGcode(fixture('tube.gcode').replace(/M10[49] S210/g, (m) => m.replace('210', '215')), 'hot');
    const res = mergeJob([a, hot], [at(50, 50), at(150, 150)], SETTINGS);
    const i = res.gcode.split('\n').indexOf('; ---- object 2: hot ----');
    const chunk = res.gcode.split('\n').slice(i, i + 12);
    expect(chunk).toContain('M109 S215');
    expect(res.warnings.some((w) => /start G-code differs/.test(w))).toBe(true);
  });

  it('builds a preview per object', () => {
    const idx = new Set(res.preview.map((p) => p.objIndex));
    expect([...idx].sort()).toEqual([0, 1]);
    expect(res.preview.some((p) => p.kind === 'travel' && p.objIndex === 1)).toBe(true);
  });
});

describe('mergeJob with mixed sources', () => {
  const pot = parseGcode(potToyLike(100, 100, 30, 10), 'pot');
  const cyl = load('cylinder.gcode');

  it('switches E mode and restores absolute E for the next body and the end G-code', () => {
    const res = mergeJob([cyl, pot], [at(40, 40), at(140, 140)], SETTINGS);
    const r = replay(res.gcode);
    const i = r.lines.indexOf('; ---- object 2: pot ----');
    const chunk = r.lines.slice(i, i + 12);
    expect(chunk).toContain('M82');
    // the cylinder left 1 mm retracted; the pot's body expects E=0 and primes itself
    expect(chunk.some((l) => /^G92 E-1$/.test(l))).toBe(true);
    expect(chunk.some((l) => /^G1 E0 F/.test(l))).toBe(true);
    expect(chunk.some((l) => /^G1 Z70 F/.test(l))).toBe(true); // the pot's body expects Z70
    expect(r.extrusion).toBeCloseTo(cyl.extrusionLength + pot.extrusionLength, 0);
    expect(r.minDe).toBeGreaterThanOrEqual(-1.0001);
    expect(res.footerFrom).toBe(0); // 20 mm cylinder vs 16.5 mm pot
    expect(res.warnings.some((w) => /start G-code differs/.test(w))).toBe(true);
    expect(r.st.relativeE).toBe(true);
  });

  it('the other way round restores the pot footer E value', () => {
    const res = mergeJob([pot, cyl], [at(60, 60), at(150, 150)], SETTINGS);
    const r = replay(res.gcode);
    const i = r.lines.indexOf('; ---- object 2: cylinder ----');
    const chunk = r.lines.slice(i, i + 12);
    expect(chunk).toContain('M83');
    expect(chunk.some((l) => /^G1 E-1 F900$/.test(l))).toBe(true); // retract, already in relative mode
    expect(chunk.some((l) => /^G1 E1 F900$/.test(l))).toBe(true);
    expect(chunk.some((l) => /^M109 S210$/.test(l))).toBe(true);
    expect(r.extrusion).toBeCloseTo(cyl.extrusionLength + pot.extrusionLength, 0);
    expect(r.minDe).toBeGreaterThanOrEqual(-1.0001);
    expect(res.footerFrom).toBe(1); // the cylinder is taller, so its end G-code closes the file
    expect(r.lines).toContain('M84     ; disable motors');
    expect(r.lines).not.toContain('G91 ; set relative coordination');
  });

  it('uses the pot end G-code with its E value restored when the pot is tallest', () => {
    const tallPot = parseGcode(potToyLike(100, 100, 30, 20), 'tallpot'); // 31.5 mm
    const res = mergeJob([cyl, tallPot], [at(40, 40), at(140, 140)], SETTINGS);
    const r = replay(res.gcode);
    expect(res.footerFrom).toBe(1);
    expect(r.lines).toContain('G91 ; set relative coordination');
    const endIdx = r.lines.indexOf('; ---- end G-code from tallpot ----');
    expect(r.lines[endIdx + 1]).toMatch(/^G92 E[\d.]+$/);
    expect(parseFloat(r.lines[endIdx + 1].slice(5))).toBeCloseTo(tallPot.endState.e, 4);
    expect(r.minDe).toBeGreaterThanOrEqual(-1.0001);
  });
});

describe('mergeJob with copies', () => {
  it('prints the same object three times at three places', () => {
    const o = load('cylinder.gcode');
    const res = mergeJob([o, o, o], [at(40, 40), at(100, 40), at(160, 40)], SETTINGS);
    const r = replay(res.gcode);
    expect(r.extrusion).toBeCloseTo(3 * o.extrusionLength, 0);
    expect(res.objects.length).toBe(3);
    const prints = r.lines.filter((l) => /^; ---- object \d/.test(l));
    expect(prints.length).toBe(2);
  });

  it('rotates a copy', () => {
    const o = load('two_towers.gcode');
    const res = mergeJob([o, o], [at(60, 100, 0), at(140, 100, 90)], SETTINGS);
    const r = replay(res.gcode);
    const i = r.lines.indexOf('; ---- object 2: two_towers ----');
    const second = r.moves.filter((m) => m.line > i && m.de > 0);
    const xs = second.map((m) => m.to.x), ys = second.map((m) => m.to.y);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    expect(w).toBeCloseTo(o.bbox.maxY - o.bbox.minY, 0);
    expect(h).toBeCloseTo(o.bbox.maxX - o.bbox.minX, 0);
  });
});
