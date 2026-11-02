/**
 * Reader for complete G-code print jobs from any slicer that writes absolute XY moves:
 * PrusaSlicer and derivatives (so TRAvel web and WeaveSlicer output), pot toy, and plain files.
 * A job is split into header (start G-code), body (the object) and footer (end G-code); the
 * body is kept as text so it can be re-emitted verbatim apart from the XY words.
 */
import { bboxCenter, bboxOf, convexHull, placePoint, rotateVec } from './geom.ts';
import type { BBox, Placement, Vec2 } from './types.ts';

export type Config = Record<string, string>;

export interface MachineState {
  x: number;
  y: number;
  z: number;
  /** E axis value as the firmware sees it: absolute position, or running total in relative mode. */
  e: number;
  /** Filament currently retracted (mm), 0 when primed. */
  retracted: number;
  feed: number;
  relativeE: boolean;
  /** G91 in effect. */
  relativeXYZ: boolean;
  firmwareRetracted: boolean;
  /** Last M104/M109 hotend temperature, NaN if none seen. */
  hotend: number;
  /** Last M140/M190 bed temperature, NaN if none seen. */
  bed: number;
  /** Last M106 S value (0 after M107), NaN if none seen. */
  fan: number;
}

/** Material printed within one horizontal slab of an object, as a convex hull in the object's own coordinates. */
export interface Slab {
  /** Top of the slab (highest extrusion Z in it). */
  zTop: number;
  hull: Vec2[];
}

export interface GcodeObject {
  name: string;
  source: string;
  header: string[];
  body: string[];
  footer: string[];
  config: Config;
  /** Machine state after replaying the header. */
  startState: MachineState;
  /** Machine state after replaying header and body. */
  endState: MachineState;
  /** Target of the first XY move in the body, and the Z the nozzle is at when that move happens. */
  firstXY: Vec2 | null;
  zAtFirstXY: number;
  slabs: Slab[];
  /** Convex hull of every XY position the nozzle visits in the body (extrusions and travels). */
  nozzleHull: Vec2[];
  /** Bounding box and centre of the extruded material. */
  bbox: BBox;
  center: Vec2;
  /** Highest extrusion Z. */
  height: number;
  /** Lowest extrusion Z, i.e. the first layer height. */
  firstLayerHeight: number;
  /** Total extrusion path length (mm). */
  extrusionLength: number;
  layerChanges: number;
  warnings: string[];
}

/** Material is bucketed into slabs this tall; thin enough that a first layer sits in a slab of its own. */
export const SLAB_HEIGHT = 0.25;

export function newState(): MachineState {
  return { x: 0, y: 0, z: 0, e: 0, retracted: 0, feed: 0, relativeE: false, relativeXYZ: false, firmwareRetracted: false, hotend: NaN, bed: NaN, fan: NaN };
}

export function parseWords(code: string): Map<string, number> {
  const words = new Map<string, number>();
  // no exponent form: slicers never write it, and it would make glued words like Y10E1 ambiguous
  const re = /([A-Za-z])(-?\d*\.?\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) words.set(m[1].toUpperCase(), parseFloat(m[2]));
  return words;
}

/** Split a line into its command part and its comment (without the semicolon). */
export function splitComment(line: string): [string, string | null] {
  const i = line.indexOf(';');
  return i < 0 ? [line, null] : [line.slice(0, i), line.slice(i + 1)];
}

export function parseConfig(lines: string[]): Config {
  const cfg: Config = {};
  let inBlock = false;
  for (const line of lines) {
    if (/^;\s*(prusaslicer|superslicer|orcaslicer|bambu)?_?config\s*=\s*begin/i.test(line) || /^; CONFIG_BLOCK_START/.test(line)) { inBlock = true; continue; }
    if (/^;\s*\w*_?config\s*=\s*end/i.test(line) || /^; CONFIG_BLOCK_END/.test(line)) { inBlock = false; continue; }
    if (!inBlock) continue;
    const m = /^;\s*([\w.]+)\s*=\s*(.*)$/.exec(line);
    if (m) cfg[m[1]] = m[2].trim();
  }
  return cfg;
}

/** Parse a config value that may be a plain number or a percentage of `base`. */
export function numOrPercent(v: string | undefined, base: number, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const t = v.split(',')[0].trim();
  if (t.endsWith('%')) return (parseFloat(t) / 100) * base;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : fallback;
}

export interface MoveEvent {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  /** Filament advanced during the move (positive = extruding). */
  de: number;
  hasXY: boolean;
}

/**
 * Replay G-code lines through a machine state. Handles G0/G1 (XYZ, E, F), G2/G3 endpoints,
 * G90/G91, M82/M83, G92, G10/G11, temperatures and fan. Every XYZ move is reported to `onMove`.
 */
export function simulate(lines: string[], st: MachineState, onMove?: (m: MoveEvent, lineIndex: number) => void): void {
  for (let i = 0; i < lines.length; i++) {
    const [code] = splitComment(lines[i]);
    const t = code.trim();
    if (t === '') continue;
    const cmd = /^([GMT]\d+)/.exec(t)?.[1];
    if (!cmd) continue;
    switch (cmd) {
      case 'G0': case 'G1': case 'G00': case 'G01': case 'G2': case 'G3': case 'G02': case 'G03': {
        const w = parseWords(t);
        const from = { x: st.x, y: st.y, z: st.z };
        const hasXY = w.has('X') || w.has('Y');
        let nx = st.x, ny = st.y, nz = st.z;
        if (st.relativeXYZ) {
          nx += w.get('X') ?? 0; ny += w.get('Y') ?? 0; nz += w.get('Z') ?? 0;
        } else {
          nx = w.get('X') ?? st.x; ny = w.get('Y') ?? st.y; nz = w.get('Z') ?? st.z;
        }
        if (w.has('F')) st.feed = w.get('F')!;
        let de = 0;
        if (w.has('E')) {
          const ev = w.get('E')!;
          de = st.relativeE ? ev : ev - st.e;
          st.e = st.relativeE ? st.e + ev : ev;
        }
        if (de < 0) st.retracted += -de;
        else if (de > 0 && !hasXY) st.retracted = Math.max(0, st.retracted - de);
        else if (de > 0 && st.retracted > 0) st.retracted = 0;
        st.x = nx; st.y = ny; st.z = nz;
        if (onMove && (hasXY || w.has('Z'))) onMove({ from, to: { x: nx, y: ny, z: nz }, de, hasXY }, i);
        break;
      }
      case 'G90': st.relativeXYZ = false; break;
      case 'G91': st.relativeXYZ = true; break;
      case 'M82': st.relativeE = false; break;
      case 'M83': st.relativeE = true; break;
      case 'G92': {
        const w = parseWords(t);
        if (w.has('E')) st.e = w.get('E')!;
        if (w.has('X')) st.x = w.get('X')!;
        if (w.has('Y')) st.y = w.get('Y')!;
        if (w.has('Z')) st.z = w.get('Z')!;
        break;
      }
      case 'G10': st.firmwareRetracted = true; break;
      case 'G11': st.firmwareRetracted = false; break;
      case 'M104': case 'M109': { const s = parseWords(t).get('S'); if (s !== undefined) st.hotend = s; break; }
      case 'M140': case 'M190': { const s = parseWords(t).get('S'); if (s !== undefined) st.bed = s; break; }
      case 'M106': { st.fan = parseWords(t).get('S') ?? 255; break; }
      case 'M107': st.fan = 0; break;
      case 'M83': break;
    }
  }
}

const isMove = (code: string) => /^\s*G0?[0-3](?![\d.])/i.test(code);

/** Index of the line that extrudes while moving in XY (first or last), or -1. Cheap text scan, no state. */
function findExtrusionMove(lines: string[], from: number, to: number, step: 1 | -1, relativeE: boolean): number {
  let lastE = NaN;
  if (!relativeE && step === -1) {
    // absolute E: walk forward once to know E before each line
    const eBefore = new Float64Array(lines.length);
    let e = 0;
    for (let i = 0; i < lines.length; i++) {
      eBefore[i] = e;
      const [code] = splitComment(lines[i]);
      if (!/^\s*G(0?[0-3]|92)\b/i.test(code)) continue;
      const w = parseWords(code);
      if (w.has('E')) e = w.get('E')!;
    }
    for (let i = from; i !== to; i += step) {
      const [code] = splitComment(lines[i]);
      if (!isMove(code)) continue;
      const w = parseWords(code);
      if ((w.has('X') || w.has('Y')) && w.has('E') && w.get('E')! > eBefore[i] + 1e-9) return i;
    }
    return -1;
  }
  for (let i = from; i !== to; i += step) {
    const [code] = splitComment(lines[i]);
    if (/^\s*G92\b/i.test(code)) { const w = parseWords(code); if (w.has('E')) lastE = w.get('E')!; continue; }
    if (!isMove(code)) continue;
    const w = parseWords(code);
    if (!w.has('E')) continue;
    const ev = w.get('E')!;
    const de = relativeE ? ev : (Number.isNaN(lastE) ? 0 : ev - lastE);
    if (!relativeE) lastE = ev;
    if ((w.has('X') || w.has('Y')) && de > 1e-9) return i;
  }
  return -1;
}

export function parseGcode(text: string, name = 'object'): GcodeObject {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const warnings: string[] = [];
  const config = parseConfig(lines);
  const source = detectSource(lines);
  const relativeEHint = config.use_relative_e_distances === '1' || lines.some((l) => /^\s*M83\b/.test(l));

  // --- header / body boundary ------------------------------------------------
  let bodyStart = lines.findIndex((l) => l.startsWith(';LAYER_CHANGE'));
  let layerChanges = 0;
  if (bodyStart >= 0) {
    layerChanges = lines.reduce((n, l) => n + (l.startsWith(';LAYER_CHANGE') ? 1 : 0), 0);
  } else {
    const firstExt = findExtrusionMove(lines, 0, lines.length, 1, relativeEHint);
    if (firstExt < 0) throw new Error(`${name}: no extrusion moves found.`);
    bodyStart = firstExt;
    for (let i = firstExt - 1; i >= 0; i--) {
      const [code] = splitComment(lines[i]);
      if (!isMove(code)) continue;
      const w = parseWords(code);
      if ((w.has('X') || w.has('Y')) && !w.has('E')) { bodyStart = i; break; }
      if (w.has('E')) break;
    }
    warnings.push('No ;LAYER_CHANGE markers; guessed that the object starts at the first travel before the first extrusion.');
  }

  // --- body / footer boundary ------------------------------------------------
  let footerStart = -1;
  for (let i = lines.length - 1; i > bodyStart; i--) {
    if (lines[i].startsWith(';TYPE:Custom')) { footerStart = i; break; }
  }
  if (footerStart >= 0) {
    // PrusaSlicer turns the fan off right before the end G-code; keep that with the footer.
    let j = footerStart - 1;
    while (j > bodyStart && lines[j].trim() === '') j--;
    if (/^M107\b/.test(lines[j])) footerStart = j;
  } else {
    const lastExt = findExtrusionMove(lines, lines.length - 1, bodyStart - 1, -1, relativeEHint);
    if (lastExt < 0) throw new Error(`${name}: no extrusion moves found in the object.`);
    footerStart = lastExt + 1;
    warnings.push('No end G-code marker (;TYPE:Custom); everything after the last extrusion is treated as end G-code.');
  }

  const header = lines.slice(0, bodyStart);
  const body = lines.slice(bodyStart, footerStart);
  const footer = lines.slice(footerStart);

  // --- replay ----------------------------------------------------------------
  const startState = newState();
  simulate(header, startState);
  const st: MachineState = { ...startState };

  const slabPts = new Map<number, { zTop: number; pts: Vec2[] }>();
  const nozzlePts: Vec2[] = [];
  let firstXY = null as Vec2 | null;
  let zAtFirstXY = st.z;
  let height = -Infinity, firstLayerHeight = Infinity, extrusionLength = 0;
  let relativeMoves = 0;
  const addSlabPt = (x: number, y: number, z: number) => {
    const k = Math.max(0, Math.ceil(z / SLAB_HEIGHT - 1e-9) - 1);
    let a = slabPts.get(k);
    if (!a) { a = { zTop: z, pts: [] }; slabPts.set(k, a); }
    if (z > a.zTop) a.zTop = z;
    a.pts.push({ x, y });
  };
  simulate(body, st, (m) => {
    if (!m.hasXY) return;
    if (st.relativeXYZ) relativeMoves++;
    if (!firstXY) { firstXY = { x: m.to.x, y: m.to.y }; zAtFirstXY = m.from.z; }
    nozzlePts.push({ x: m.to.x, y: m.to.y });
    if (m.de > 0) {
      const z = m.to.z;
      if (z > height) height = z;
      if (z < firstLayerHeight) firstLayerHeight = z;
      extrusionLength += Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
      // material lands at the move's end height; a long descent while extruding (pot toy's
      // first move) leaves only a thread in the air, so the start height is ignored
      addSlabPt(m.from.x, m.from.y, z);
      addSlabPt(m.to.x, m.to.y, z);
    }
  });
  if (relativeMoves > 0) warnings.push(`${relativeMoves} relative (G91) XY move(s) in the object; they are rotated but not translated, which is only right if the object also moves back absolutely.`);
  if (!Number.isFinite(height)) throw new Error(`${name}: no extrusion moves found in the object.`);
  if (!firstXY) throw new Error(`${name}: the object has no XY moves.`);

  const slabs: Slab[] = [...slabPts.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => ({ zTop: s.zTop, hull: convexHull(s.pts) }));
  const allMaterial: Vec2[] = [];
  for (const s of slabs) allMaterial.push(...s.hull);
  const bbox = bboxOf(allMaterial);
  const center = bboxCenter(bbox);

  return {
    name, source, header, body, footer, config, startState, endState: st, firstXY, zAtFirstXY,
    slabs, nozzleHull: convexHull(nozzlePts), bbox, center, height, firstLayerHeight, extrusionLength,
    layerChanges, warnings,
  };
}

function detectSource(lines: string[]): string {
  for (const l of lines.slice(0, 5)) {
    const m = /^; generated by (\w+Slicer[^\s]*|Bambu Studio|Cura[^\s]*)\s*([\d.]+)?/i.exec(l);
    if (m) return m[2] ? `${m[1]} ${m[2]}` : m[1];
    if (/^;\{.*"points"/.test(l)) return 'pot toy';
  }
  if (lines.some((l) => l.startsWith(';{') && /"layer_height"/.test(l))) return 'pot toy';
  if (lines.some((l) => /TRAvel web/.test(l))) return 'TRAvel web';
  return 'unknown';
}

const f3 = (v: number) => {
  const s = v.toFixed(3);
  return (s.replace(/\.?0+$/, '') || '0').replace(/^-0$/, '0');
};

/**
 * Re-emit the body of an object with every XY word moved by the placement. Lines with no XY
 * (or I/J arc offsets) are copied verbatim. In absolute mode a moved line always carries both
 * X and Y so a rotation cannot leave one axis stale.
 */
export function transformBody(obj: GcodeObject, pl: Placement): string[] {
  const st: MachineState = { ...obj.startState };
  const out: string[] = new Array(obj.body.length);
  const rotate = Math.abs(pl.rot) > 1e-9;
  for (let i = 0; i < obj.body.length; i++) {
    const line = obj.body[i];
    const [code, comment] = splitComment(line);
    if (!isMove(code)) {
      out[i] = line;
      simulate([line], st);
      continue;
    }
    const w = parseWords(code);
    const hasX = w.has('X'), hasY = w.has('Y');
    const hasIJ = w.has('I') || w.has('J');
    if (!hasX && !hasY && !hasIJ) { out[i] = line; simulate([line], st); continue; }

    const repl = new Map<string, number>();
    if (hasX || hasY) {
      if (st.relativeXYZ) {
        const v = rotateVec({ x: w.get('X') ?? 0, y: w.get('Y') ?? 0 }, pl.rot);
        if (hasX || rotate) repl.set('X', v.x);
        if (hasY || rotate) repl.set('Y', v.y);
      } else {
        const p = placePoint({ x: w.get('X') ?? st.x, y: w.get('Y') ?? st.y }, obj.center, pl);
        if (hasX || rotate) repl.set('X', p.x);
        if (hasY || rotate) repl.set('Y', p.y);
      }
    }
    if (hasIJ && rotate) {
      const v = rotateVec({ x: w.get('I') ?? 0, y: w.get('J') ?? 0 }, pl.rot);
      repl.set('I', v.x); repl.set('J', v.y);
    }
    const done = new Set<string>();
    const trail = /\s*$/.exec(code)![0];
    let newCode = code.replace(/([XYIJxyij])(-?\d*\.?\d+)/g, (m, k: string) => {
      const K = k.toUpperCase();
      if (!repl.has(K)) return m;
      done.add(K);
      return K + f3(repl.get(K)!);
    }).replace(/\s+$/, '');
    if (repl.has('X') && !done.has('X')) {
      const x = 'X' + f3(repl.get('X')!);
      const yAt = /[Yy]-?\d*\.?\d+/.exec(newCode);
      newCode = yAt ? newCode.slice(0, yAt.index) + x + ' ' + newCode.slice(yAt.index) : newCode + ' ' + x;
    }
    if (repl.has('Y') && !done.has('Y')) {
      const y = 'Y' + f3(repl.get('Y')!);
      const xAt = /[Xx]-?\d*\.?\d+/.exec(newCode);
      newCode = xAt ? newCode.slice(0, xAt.index + xAt[0].length) + ' ' + y + newCode.slice(xAt.index + xAt[0].length) : newCode + ' ' + y;
    }
    for (const k of ['I', 'J']) if (repl.has(k) && !done.has(k)) newCode += ' ' + k + f3(repl.get(k)!);
    out[i] = newCode + trail + (comment !== null ? ';' + comment : '');
    simulate([line], st);
  }
  return out;
}
