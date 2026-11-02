import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGcode, type GcodeObject } from '../src/core/gcode.ts';
import type { ClearanceModel, MergeSettings } from '../src/core/types.ts';

export function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', 'gcode', name), 'utf8');
}

export function load(name: string): GcodeObject {
  return parseGcode(fixture(name), name.replace(/\.gcode$/, ''));
}

export const CLEARANCE: ClearanceModel = { nozzleRadius: 2.5, nozzleHeight: 4, shroudRadius: 30, gantryHeight: Infinity };

export const SETTINGS: MergeSettings = {
  clearance: CLEARANCE,
  bed: { width: 200, depth: 200, originCenter: false },
  travelLift: 2,
};

/**
 * A pot-toy style job: absolute E, custom clay-printer start/end G-code, a continuous spiral
 * wall of `turns` turns and radius r centred on (cx, cy), with the bottom raster omitted.
 */
export function potToyLike(cx: number, cy: number, r: number, turns: number, layerHeight = 1.5): string {
  const L: string[] = [];
  L.push(';{"points":[[1,2]],"layer_height":' + layerHeight + '}');
  L.push('; bed_height: 0');
  L.push('; layer_height: ' + layerHeight);
  L.push('M107', ';TYPE:Custom', 'G28 ; home all axes', '', 'G21', 'G90', 'M82 ; use absolute distances for extrusion', 'G92 E0', '; Filament gcode', 'M107');
  L.push(';LAYER_CHANGE', ';Z:' + layerHeight, ';HEIGHT:' + layerHeight);
  L.push('G1 Z70 F9000', 'G1 E-.3 F900', 'G92 E0', 'G1 E.4 F900', 'M204 S150', ';TYPE:External perimeter', ';WIDTH:3', 'G1 F3360');
  const n = 36;
  L.push(`G1 X${(cx + r).toFixed(3)} Y${cy.toFixed(3)}`);
  let e = 0, px = cx + r, py = cy;
  let layer = 1;
  for (let i = 1; i <= n * turns; i++) {
    const a = (2 * Math.PI * i) / n;
    const z = layerHeight + (layerHeight * i) / n;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    e += 0.4 * Math.hypot(x - px, y - py);
    const li = Math.floor(z / layerHeight + 1e-6);
    if (li > layer) { L.push(';LAYER_CHANGE', ';Z:' + z.toFixed(3), ';HEIGHT:' + layerHeight); layer = li; }
    L.push(`G1 X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(3)} E${e.toFixed(3)}`);
    px = x; py = y;
  }
  L.push(`G1 E${(e - 0.5).toFixed(3)} F900`, 'G92 E0', 'G91 ; set relative coordination', 'G1 Z50 F300 ;move up', 'G90 ; set absolute coordination', 'G1 X200  F2400 ; home X axis');
  return L.join('\n') + '\n';
}
