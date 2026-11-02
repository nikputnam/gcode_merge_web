/** Top-down view of the bed with draggable object footprints and the collision checks drawn on. */
import { convexHull, placePolygon, pointInPolygon } from '../core/geom.ts';
import type { GcodeObject } from '../core/gcode.ts';
import { bedBox, placedNozzleHull, type Violation } from '../core/layout.ts';
import type { BedSettings, Placement, Vec2 } from '../core/types.ts';

export const OBJECT_COLORS = ['#4fc3f7', '#ffb74d', '#81c784', '#e57373', '#ba68c8', '#fff176', '#4db6ac', '#f06292', '#a1887f', '#90a4ae', '#7986cb', '#aed581'];

export interface BedItem {
  obj: GcodeObject;
  pl: Placement;
  color: string;
}

export interface BedViewCallbacks {
  onSelect(index: number): void;
  onMove(index: number, pl: Placement): void;
  onNudge(index: number, dx: number, dy: number, drot: number): void;
}

const materialHullCache = new WeakMap<GcodeObject, Vec2[]>();
function materialHull(obj: GcodeObject): Vec2[] {
  let h = materialHullCache.get(obj);
  if (!h) {
    const pts: Vec2[] = [];
    for (const s of obj.slabs) pts.push(...s.hull);
    h = convexHull(pts);
    materialHullCache.set(obj, h);
  }
  return h;
}

export class BedView {
  private ctx: CanvasRenderingContext2D;
  private items: BedItem[] = [];
  private bed: BedSettings = { width: 200, depth: 200, originCenter: false };
  private violations: Violation[] = [];
  private selected = -1;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private drag: { index: number; dx: number; dy: number } | null = null;
  private canvas: HTMLCanvasElement;
  private cb: BedViewCallbacks;

  constructor(canvas: HTMLCanvasElement, cb: BedViewCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement ?? canvas);
    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('keydown', (e) => this.onKey(e));
  }

  set(items: BedItem[], bed: BedSettings, violations: Violation[], selected: number) {
    this.items = items; this.bed = bed; this.violations = violations; this.selected = selected;
    this.draw();
  }

  /** Canvas pixel -> bed mm. */
  private toBed(px: number, py: number): Vec2 {
    return { x: (px - this.ox) / this.scale, y: (this.oy - py) / this.scale };
  }
  private toPx(p: Vec2): Vec2 {
    return { x: this.ox + p.x * this.scale, y: this.oy - p.y * this.scale };
  }

  private hit(p: Vec2): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (pointInPolygon(p, placedNozzleHull(it.obj, it.pl))) return i;
    }
    return -1;
  }

  private eventBed(e: PointerEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return this.toBed(e.clientX - r.left, e.clientY - r.top);
  }

  private onDown(e: PointerEvent) {
    this.canvas.focus();
    const p = this.eventBed(e);
    const i = this.hit(p);
    this.cb.onSelect(i);
    if (i < 0) return;
    const it = this.items[i];
    this.drag = { index: i, dx: it.pl.x - p.x, dy: it.pl.y - p.y };
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    if (!this.drag) {
      this.canvas.style.cursor = this.hit(this.eventBed(e)) >= 0 ? 'grab' : 'default';
      return;
    }
    const p = this.eventBed(e);
    const snap = e.shiftKey ? 5 : 0.5;
    const it = this.items[this.drag.index];
    const x = Math.round((p.x + this.drag.dx) / snap) * snap;
    const y = Math.round((p.y + this.drag.dy) / snap) * snap;
    this.cb.onMove(this.drag.index, { x, y, rot: it.pl.rot });
  }

  private onUp(e: PointerEvent) {
    if (this.drag) this.canvas.releasePointerCapture(e.pointerId);
    this.drag = null;
  }

  private onKey(e: KeyboardEvent) {
    if (this.selected < 0) return;
    const step = e.shiftKey ? 10 : 1;
    const map: Record<string, [number, number, number]> = {
      ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0], ArrowUp: [0, step, 0], ArrowDown: [0, -step, 0],
      r: [0, 0, 15], R: [0, 0, -15],
    };
    const m = map[e.key];
    if (!m) return;
    e.preventDefault();
    this.cb.onNudge(this.selected, m[0], m[1], m[2]);
  }

  draw() {
    const host = this.canvas.parentElement ?? this.canvas;
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const box = bedBox(this.bed);
    const pad = 36;
    this.scale = Math.min((w - 2 * pad) / (box.maxX - box.minX), (h - 2 * pad) / (box.maxY - box.minY));
    this.ox = (w - (box.maxX + box.minX) * this.scale) / 2;
    this.oy = (h + (box.maxY + box.minY) * this.scale) / 2;

    // bed and grid
    const a = this.toPx({ x: box.minX, y: box.maxY }), b = this.toPx({ x: box.maxX, y: box.minY });
    ctx.fillStyle = '#23262e';
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.lineWidth = 1;
    for (let x = Math.ceil(box.minX / 10) * 10; x <= box.maxX; x += 10) {
      const p = this.toPx({ x, y: 0 });
      ctx.strokeStyle = x % 50 === 0 ? '#3d4250' : '#2c303a';
      ctx.beginPath(); ctx.moveTo(p.x, a.y); ctx.lineTo(p.x, b.y); ctx.stroke();
    }
    for (let y = Math.ceil(box.minY / 10) * 10; y <= box.maxY; y += 10) {
      const p = this.toPx({ x: 0, y });
      ctx.strokeStyle = y % 50 === 0 ? '#3d4250' : '#2c303a';
      ctx.beginPath(); ctx.moveTo(a.x, p.y); ctx.lineTo(b.x, p.y); ctx.stroke();
    }
    ctx.strokeStyle = '#7a8090';
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fillStyle = '#8a90a0';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`X ${box.minX} … ${box.maxX} mm (front edge at the bottom)`, (a.x + b.x) / 2, b.y + 16);
    ctx.save();
    ctx.translate(a.x - 8, (a.y + b.y) / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText(`Y ${box.minY} … ${box.maxY} mm`, 0, 0);
    ctx.restore();

    const bad = new Map<number, string>();
    for (const v of this.violations) {
      const col = v.kind === 'bed' ? '#ffa726' : '#ff5252';
      bad.set(v.a, col);
      if (v.b >= 0) bad.set(v.b, col);
    }

    // objects
    this.items.forEach((it, i) => {
      const nozzle = placePolygon(it.obj.nozzleHull, it.obj.center, it.pl);
      const mat = placePolygon(materialHull(it.obj), it.obj.center, it.pl);
      ctx.beginPath();
      nozzle.forEach((p, k) => { const q = this.toPx(p); k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      ctx.closePath();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = it.color + '88';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      mat.forEach((p, k) => { const q = this.toPx(p); k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      ctx.closePath();
      ctx.fillStyle = it.color + (i === this.selected ? '77' : '44');
      ctx.fill();
      ctx.strokeStyle = bad.get(i) ?? it.color;
      ctx.lineWidth = i === this.selected ? 3 : bad.has(i) ? 2 : 1.5;
      ctx.stroke();
      const c = this.toPx({ x: it.pl.x, y: it.pl.y });
      ctx.fillStyle = '#fff';
      ctx.font = `${i === this.selected ? 'bold ' : ''}12px system-ui, sans-serif`;
      ctx.fillText(`${i + 1}  ${it.obj.name}`, c.x, c.y - 2);
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#ffffffbb';
      ctx.fillText(`${it.obj.height.toFixed(1)} mm tall`, c.x, c.y + 11);
    });

    // violations
    for (const v of this.violations) {
      if (!v.pa || !v.pb || v.kind === 'overlap') continue;
      const p = this.toPx(v.pa), q = this.toPx(v.pb);
      ctx.strokeStyle = '#ff5252';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.fillStyle = '#ff8a80';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${v.have.toFixed(1)} / ${v.need.toFixed(1)} mm`, (p.x + q.x) / 2, (p.y + q.y) / 2 - 5);
    }
  }
}
