import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PreviewPath } from '../core/merge.ts';
import type { BBox } from '../core/types.ts';
import { OBJECT_COLORS } from './bedView.ts';

/** Three.js line preview of the merged job, one colour per object, travels in red. */
export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private extrude?: THREE.LineSegments;
  private travel?: THREE.LineSegments;
  private bed?: THREE.Object3D;
  /** Cumulative line-segment vertex counts at the end of each object. */
  private extrudeEnds: number[] = [];
  private travelEnds: number[] = [];
  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(150, -200, 150);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.scene.background = new THREE.Color('#1b1e24');
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => { this.controls.update(); this.renderer.render(this.scene, this.camera); });
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setPaths(paths: PreviewPath[], bed: BBox) {
    for (const o of [this.extrude, this.travel]) if (o) { this.scene.remove(o); o.geometry.dispose(); }
    if (this.bed) this.scene.remove(this.bed);
    const ex: number[] = [], exc: number[] = [], tr: number[] = [];
    this.extrudeEnds = []; this.travelEnds = [];
    let objIdx = -1;
    const pushEnds = () => { this.extrudeEnds.push(ex.length / 3); this.travelEnds.push(tr.length / 3); };
    for (const p of paths) {
      const idx = Math.max(p.objIndex, 0);
      while (objIdx < idx) { if (objIdx >= 0) pushEnds(); objIdx++; }
      const c = new THREE.Color(OBJECT_COLORS[idx % OBJECT_COLORS.length]);
      for (let i = 3; i < p.xyz.length; i += 3) {
        const target = p.kind === 'travel' ? tr : ex;
        target.push(p.xyz[i - 3], p.xyz[i - 2], p.xyz[i - 1], p.xyz[i], p.xyz[i + 1], p.xyz[i + 2]);
        if (p.kind !== 'travel') exc.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    pushEnds();
    const mk = (pos: number[], col?: number[], mat?: THREE.LineBasicMaterial) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      if (col) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      return new THREE.LineSegments(g, mat ?? new THREE.LineBasicMaterial({ vertexColors: true }));
    };
    this.extrude = mk(ex, exc);
    this.travel = mk(tr, undefined, new THREE.LineBasicMaterial({ color: 0xff5252, transparent: true, opacity: 0.8 }));
    this.scene.add(this.extrude, this.travel);

    const bw = bed.maxX - bed.minX, bd = bed.maxY - bed.minY;
    const grid = new THREE.GridHelper(Math.max(bw, bd), Math.round(Math.max(bw, bd) / 10), 0x556, 0x334);
    grid.rotation.x = Math.PI / 2;
    grid.position.set((bed.minX + bed.maxX) / 2, (bed.minY + bed.maxY) / 2, 0);
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(bed.minX, bed.minY, 0), new THREE.Vector3(bed.maxX, bed.minY, 0),
        new THREE.Vector3(bed.maxX, bed.maxY, 0), new THREE.Vector3(bed.minX, bed.maxY, 0),
      ]),
      new THREE.LineBasicMaterial({ color: 0x8a90a0 }),
    );
    this.bed = new THREE.Group();
    this.bed.add(grid, outline, new THREE.AxesHelper(20));
    this.scene.add(this.bed);

    const box = new THREE.Box3().setFromObject(this.extrude);
    if (!box.isEmpty()) {
      const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length();
      this.controls.target.copy(c);
      this.camera.position.set(c.x + s * 0.6, c.y - s * 1.0, c.z + s * 0.7);
      this.camera.near = s / 1000; this.camera.far = s * 20; this.camera.updateProjectionMatrix();
    }
    this.resize();
  }

  get objectCount() { return this.extrudeEnds.length; }

  /** Show only the first n objects. */
  showUpTo(n: number) {
    if (!this.extrude || !this.travel) return;
    const i = Math.min(Math.max(n, 1), this.extrudeEnds.length) - 1;
    if (i < 0) return;
    this.extrude.geometry.setDrawRange(0, this.extrudeEnds[i]);
    this.travel.geometry.setDrawRange(0, this.travelEnds[i]);
  }

  setTravelVisible(v: boolean) { if (this.travel) this.travel.visible = v; }
}
