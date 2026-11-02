import { describe, expect, it } from 'vitest';
import { arrangeAll, checkLayout, clearanceBands, findFreeSpot, requiredGap } from '../src/core/layout.ts';
import { parseGcode } from '../src/core/gcode.ts';
import type { Placement } from '../src/core/types.ts';
import { CLEARANCE, load, potToyLike } from './helpers.ts';

const bed = { width: 200, depth: 200, originCenter: false };

describe('requiredGap', () => {
  it('steps with the rise above the nozzle tip', () => {
    expect(requiredGap(0.2, CLEARANCE, 0.2)).toBe(0);
    expect(requiredGap(3, CLEARANCE, 0.2)).toBe(2.5);
    expect(requiredGap(4, CLEARANCE, 0.2)).toBe(2.5);
    expect(requiredGap(10, CLEARANCE, 0.2)).toBe(30);
    expect(requiredGap(10, { ...CLEARANCE, gantryHeight: 8 }, 0.2)).toBe(Infinity);
  });
});

describe('clearanceBands', () => {
  it('groups a 20 mm cylinder into three bands', () => {
    const obj = load('cylinder.gcode');
    const bands = clearanceBands(obj, CLEARANCE, obj.firstLayerHeight).sort((a, b) => a.need - b.need);
    expect(bands.map((b) => b.need)).toEqual([0, 2.5, 30]);
    expect(bands[2].zFrom).toBeCloseTo(4.2, 6);
  });
});

describe('checkLayout', () => {
  const a = load('cylinder.gcode');
  const b = load('tube.gcode');
  const at = (x: number, y: number): Placement => ({ x, y, rot: 0 });

  it('passes two objects far apart and fails them close together', () => {
    expect(checkLayout([a, b], [at(50, 50), at(150, 150)], CLEARANCE, bed).violations).toEqual([]);
    const close = checkLayout([a, b], [at(50, 50), at(90, 50)], CLEARANCE, bed);
    expect(close.collides).toBe(true);
    expect(close.violations[0].kind).toBe('gap');
    expect(close.violations[0].need).toBe(30);
    const over = checkLayout([a, b], [at(50, 50), at(55, 50)], CLEARANCE, bed);
    expect(over.violations[0].kind).toBe('overlap');
  });

  it('lets a short object sit close to a later tall one', () => {
    const shortPot = parseGcode(potToyLike(0, 0, 10, 1), 'short'); // 3 mm tall, under the 4 mm nozzle height
    const tall = load('cylinder.gcode');
    // pot radius 10, cylinder with skirt radius ~16.2, nozzle radius 2.5, 1 mm to spare
    const ok = checkLayout([shortPot, tall], [at(50, 50), at(50 + 10 + 2.5 + 16.2 + 1, 50)], CLEARANCE, bed);
    expect(ok.violations).toEqual([]);
    const tight = checkLayout([shortPot, tall], [at(50, 50), at(50 + 10 + 2.5 + 16.2 - 1, 50)], CLEARANCE, bed);
    expect(tight.violations[0].kind).toBe('gap');
    expect(tight.violations[0].need).toBe(2.5);
    // the other way round the tall one is first and needs the shroud radius
    const bad = checkLayout([tall, shortPot], [at(50 + 10 + 2.5 + 16.2 + 1, 50), at(50, 50)], CLEARANCE, bed);
    expect(bad.violations[0].kind).toBe('gap');
  });

  it('requires objects taller than the gantry to go last', () => {
    const r = checkLayout([a, b], [at(50, 50), at(150, 150)], { ...CLEARANCE, gantryHeight: 10 }, bed);
    expect(r.violations.map((v) => v.kind)).toEqual(['order']);
    const r2 = checkLayout([b, a], [at(150, 150), at(50, 50)], { ...CLEARANCE, gantryHeight: 10 }, bed);
    expect(r2.violations.map((v) => v.kind)).toEqual(['order']);
  });

  it('flags objects off the bed', () => {
    const r = checkLayout([a], [at(5, 100)], CLEARANCE, bed);
    expect(r.violations.map((v) => v.kind)).toEqual(['bed']);
    expect(r.collides).toBe(false);
  });
});

describe('placement', () => {
  it('arranges a handful of objects without conflicts', () => {
    const objs = [load('cylinder.gcode'), load('tube.gcode'), load('two_towers.gcode'), load('cylinder.gcode')];
    const placements: Placement[] = objs.map((o) => ({ x: o.center.x, y: o.center.y, rot: 0 }));
    const unplaced = arrangeAll(objs, placements, CLEARANCE, bed);
    expect(unplaced).toEqual([]);
    expect(checkLayout(objs, placements, CLEARANCE, bed).violations).toEqual([]);
    // front-left first
    expect(placements[0].x).toBeLessThan(placements[1].x);
  });

  it('reports when nothing fits', () => {
    const objs = [load('cylinder.gcode'), load('cylinder.gcode')];
    const placements: Placement[] = objs.map((o) => ({ x: o.center.x, y: o.center.y, rot: 0 }));
    const tiny = { width: 40, depth: 40, originCenter: true };
    expect(findFreeSpot(objs, placements, 0, [], CLEARANCE, tiny)).not.toBeNull();
    const p0 = findFreeSpot(objs, placements, 0, [], CLEARANCE, tiny)!;
    placements[0] = p0;
    expect(findFreeSpot(objs, placements, 1, [0], CLEARANCE, tiny)).toBeNull();
  });
});
