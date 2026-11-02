import { describe, expect, it } from 'vitest';
import { parseGcode, simulate, transformBody, newState } from '../src/core/gcode.ts';
import { bboxOf, convexHull, polygonGap } from '../src/core/geom.ts';
import { load, potToyLike } from './helpers.ts';

describe('parseGcode on PrusaSlicer output', () => {
  const obj = load('cylinder.gcode');

  it('splits header, body and footer at the markers', () => {
    expect(obj.header[obj.header.length - 1]).toBe('M107');
    expect(obj.body[0]).toBe(';LAYER_CHANGE');
    expect(obj.footer[0]).toBe('M107');
    expect(obj.footer[1]).toBe(';TYPE:Custom');
    expect(obj.footer.some((l) => l.startsWith('; prusaslicer_config = begin'))).toBe(true);
    expect(obj.header.length + obj.body.length + obj.footer.length).toBe(6468);
  });

  it('reads the machine state the header leaves', () => {
    expect(obj.startState.relativeE).toBe(true);
    expect(obj.startState.hotend).toBe(210);
    expect(obj.startState.bed).toBe(60);
    expect(obj.startState.fan).toBe(0);
    expect(obj.source).toMatch(/PrusaSlicer 2\.9/);
  });

  it('measures the object', () => {
    expect(obj.height).toBeCloseTo(20, 1);
    expect(obj.firstLayerHeight).toBeCloseTo(0.2, 3);
    expect(obj.layerChanges).toBe(100);
    expect(obj.slabs.length).toBe(80);
    expect(obj.slabs[0].zTop).toBeCloseTo(0.2, 6);
    expect(obj.center.x).toBeCloseTo(110, 0);
    expect(obj.center.y).toBeCloseTo(110, 0);
    // the brim makes the footprint a bit larger than the 10 mm radius tube
    expect(obj.bbox.maxX - obj.bbox.minX).toBeGreaterThan(20);
    expect(obj.bbox.maxX - obj.bbox.minX).toBeLessThan(34);
    expect(obj.extrusionLength).toBeGreaterThan(6000);
    expect(obj.firstXY).toEqual({ x: 98.284, y: 98.855 });
    expect(obj.zAtFirstXY).toBeCloseTo(0.4, 6);
    expect(obj.endState.retracted).toBeCloseTo(1, 6);
  });
});

describe('parseGcode on a pot toy style file', () => {
  const text = potToyLike(100, 100, 30, 20);
  const obj = parseGcode(text, 'pot');

  it('falls back to the last extrusion for the footer', () => {
    expect(obj.source).toBe('pot toy');
    expect(obj.startState.relativeE).toBe(false);
    expect(obj.startState.e).toBe(0); // pot toy primes inside the body, after its ;LAYER_CHANGE
    expect(obj.footer[0]).toMatch(/^G1 E[\d.]+ F900$/);
    expect(obj.footer).toContain('G91 ; set relative coordination');
    expect(obj.body[0]).toBe(';LAYER_CHANGE');
    expect(obj.warnings.some((w) => /end G-code marker/.test(w))).toBe(true);
  });

  it('measures the spiral', () => {
    expect(obj.height).toBeCloseTo(1.5 + 20 * 1.5, 3);
    expect(obj.zAtFirstXY).toBe(70);
    expect(obj.firstXY).toEqual({ x: 130, y: 100 });
    const b = bboxOf(obj.nozzleHull);
    expect(b.minX).toBeCloseTo(70, 0);
    expect(b.maxX).toBeCloseTo(130, 0);
    expect(obj.endState.e).toBeGreaterThan(100);
  });
});

describe('transformBody', () => {
  const obj = load('cylinder.gcode');

  it('translates every XY word and nothing else', () => {
    const moved = transformBody(obj, { x: obj.center.x + 50, y: obj.center.y - 20, rot: 0 });
    expect(moved.length).toBe(obj.body.length);
    const st = { ...obj.startState };
    const pts: { x: number; y: number }[] = [];
    simulate(moved, st, (m) => { if (m.de > 0 && m.hasXY) pts.push({ x: m.to.x, y: m.to.y }); });
    const b = bboxOf(pts);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(obj.center.x + 50, 1);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(obj.center.y - 20, 1);
    expect(st.e).toBeCloseTo(obj.endState.e, 6);
    expect(st.z).toBeCloseTo(obj.endState.z, 6);
    // non-move lines and E/F words untouched
    for (let i = 0; i < moved.length; i++) {
      if (!/^G[01]\b/.test(obj.body[i])) expect(moved[i]).toBe(obj.body[i]);
      else expect(moved[i].replace(/[XY]-?[\d.]+\s?/g, '')).toBe(obj.body[i].replace(/[XY]-?[\d.]+\s?/g, ''));
    }
  });

  it('rotates about the object centre and keeps arcs consistent', () => {
    const text = [
      'G90', 'M83', ';LAYER_CHANGE', 'G1 X10 Y0 F3000', 'G1 X20 Y0 E1', 'G1 Y10 E1', 'G2 X10 Y0 I-5 J-5 E2', 'G1X20Y10E1 ; glued words', 'M107', ';TYPE:Custom', 'M84',
    ].join('\n');
    const o = parseGcode(text, 't');
    const moved = transformBody(o, { x: 0, y: 0, rot: 90 });
    // (20,0) relative to centre (15,5) is (5,-5); rotated 90° CCW -> (5,5)
    expect(moved[2]).toBe('G1 X5 Y5 E1');
    // a Y-only move gets an explicit X after rotation
    expect(moved[3]).toBe('G1 X-5 Y5 E1');
    expect(moved[4]).toBe('G2 X5 Y-5 I5 J-5 E2');
    expect(moved[5]).toBe('G1X-5Y5E1 ; glued words');
  });
});

describe('geometry', () => {
  it('convex hull and polygon gap', () => {
    const sq = (x: number, y: number, s: number) => convexHull([{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }, { x: x + s / 2, y: y + s / 2 }]);
    const a = sq(0, 0, 10), b = sq(15, 0, 10), c = sq(5, 5, 10);
    expect(a.length).toBe(4);
    expect(polygonGap(a, b).gap).toBeCloseTo(5, 6);
    expect(polygonGap(a, c).gap).toBe(-1);
  });

  it('simulate tracks retraction in both E modes', () => {
    const st = newState();
    simulate(['M83', 'G1 E-1', 'G1 X1 Y1 E0.5', 'G1 E1', 'M82', 'G92 E0', 'G1 E-2', 'G1 E0'], st);
    expect(st.retracted).toBe(0);
    expect(st.relativeE).toBe(false);
  });
});
