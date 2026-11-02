import { parseGcode, type GcodeObject } from './core/gcode.ts';
import { arrangeAll, bedBox, checkLayout, findFreeSpot, type Violation } from './core/layout.ts';
import { mergeJob, type MergeResult } from './core/merge.ts';
import type { BedSettings, MergeSettings } from './core/types.ts';
import { BedView, OBJECT_COLORS, type BedItem } from './ui/bedView.ts';
import { Viewer } from './ui/viewer.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string): number | undefined => {
  const v = $<HTMLInputElement>(id).value.trim();
  return v === '' ? undefined : parseFloat(v);
};

const items: BedItem[] = [];
let selected = -1;
let colorSeq = 0;
let result: MergeResult | null = null;
let violations: Violation[] = [];
let viewer: Viewer | null = null;

const SETTING_IDS = ['bedWidth', 'bedDepth', 'originCenter', 'nozzleRadius', 'nozzleHeight', 'shroudRadius', 'gantryHeight', 'travelLift', 'travelSpeed', 'retractLength', 'retractSpeed'];

function readBed(): BedSettings {
  return { width: num('bedWidth') ?? 200, depth: num('bedDepth') ?? 200, originCenter: $<HTMLInputElement>('originCenter').checked };
}

function readSettings(): MergeSettings {
  return {
    clearance: {
      nozzleRadius: num('nozzleRadius') ?? 2.5,
      nozzleHeight: num('nozzleHeight') ?? 4,
      shroudRadius: num('shroudRadius') ?? 30,
      gantryHeight: num('gantryHeight') ?? Infinity,
    },
    bed: readBed(),
    travelLift: num('travelLift') ?? 2,
    travelSpeed: num('travelSpeed'),
    retractLength: num('retractLength'),
    retractSpeed: num('retractSpeed'),
  };
}

function saveSettings() {
  const o: Record<string, string | boolean> = {};
  for (const id of SETTING_IDS) {
    const el = $<HTMLInputElement>(id);
    o[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  localStorage.setItem('gcode_merge_settings', JSON.stringify(o));
}

function loadSettings() {
  try {
    const o = JSON.parse(localStorage.getItem('gcode_merge_settings') ?? '{}');
    for (const id of SETTING_IDS) {
      if (!(id in o)) continue;
      const el = $<HTMLInputElement>(id);
      if (el.type === 'checkbox') el.checked = !!o[id]; else el.value = String(o[id]);
    }
  } catch { /* ignore */ }
}

function message(cls: string, text: string) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  $('messages').appendChild(d);
}

const objs = () => items.map((i) => i.obj);
const pls = () => items.map((i) => i.pl);

const bedView = new BedView($<HTMLCanvasElement>('bed'), {
  onSelect: (i) => { selected = i; refresh(); },
  onMove: (i, pl) => { items[i].pl = pl; refresh(); },
  onNudge: (i, dx, dy, drot) => {
    const p = items[i].pl;
    items[i].pl = { x: p.x + dx, y: p.y + dy, rot: ((p.rot + drot) % 360 + 360) % 360 };
    refresh();
  },
});

/** Re-check the layout and redraw everything. Call after any change. */
function refresh() {
  result = null;
  $<HTMLButtonElement>('download').disabled = true;
  const settings = readSettings();
  violations = items.length ? checkLayout(objs(), pls(), settings.clearance, settings.bed).violations : [];
  $('messages').innerHTML = '';
  for (const v of violations) message(v.kind === 'bed' ? 'warn' : 'err', v.message);
  for (const it of items) for (const w of it.obj.warnings) message('warn', `${it.obj.name}: ${w}`);
  renderList();
  bedView.set(items, settings.bed, violations, selected);
  const has = items.length > 0;
  for (const id of ['arrange', 'sortHeight', 'clear', 'merge']) $<HTMLButtonElement>(id).disabled = !has;
  $('stats').innerHTML = has
    ? `<table><tr><td>Objects</td><td>${items.length}</td></tr><tr><td>Tallest</td><td>${Math.max(...items.map((i) => i.obj.height)).toFixed(1)} mm</td></tr><tr><td>Extrusion distance</td><td>${(items.reduce((a, i) => a + i.obj.extrusionLength, 0) / 1000).toFixed(2)} m</td></tr></table>`
    : '';
  $('dropText').textContent = has ? `${items.length} object(s) loaded; drop more to add` : 'Drop .gcode files here or click to choose';
}

function renderList() {
  const host = $('objects');
  host.innerHTML = '';
  if (!items.length) { host.innerHTML = '<div class="empty">No objects yet.</div>'; return; }
  const bad = new Set<number>();
  for (const v of violations) { bad.add(v.a); if (v.b >= 0) bad.add(v.b); }
  items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'obj' + (i === selected ? ' selected' : '') + (bad.has(i) ? ' bad' : '');
    row.innerHTML = `
      <span class="sw" style="background:${it.color}"></span>
      <span class="name" title="${it.obj.name}">${i + 1}. ${it.obj.name}</span>
      <span class="btns">
        <button data-act="up" title="Print earlier">▲</button>
        <button data-act="down" title="Print later">▼</button>
        <button data-act="dup" title="Add another copy">⧉</button>
        <button data-act="del" title="Remove">✕</button>
      </span>
      <span class="meta">${it.obj.height.toFixed(1)} mm tall, ${(it.obj.bbox.maxX - it.obj.bbox.minX).toFixed(0)} × ${(it.obj.bbox.maxY - it.obj.bbox.minY).toFixed(0)} mm, ${it.obj.source}${it.obj.startState.relativeE ? '' : ', absolute E'}</span>
      <span class="pos">X <input type="number" data-f="x" value="${it.pl.x.toFixed(1)}" step="1" /> Y <input type="number" data-f="y" value="${it.pl.y.toFixed(1)}" step="1" /> rot <input type="number" data-f="rot" value="${it.pl.rot.toFixed(0)}" step="15" />°</span>`;
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const act = (e.target as HTMLElement).dataset.act;
      if (act === 'up' && i > 0) { [items[i - 1], items[i]] = [items[i], items[i - 1]]; selected = i - 1; }
      else if (act === 'down' && i < items.length - 1) { [items[i + 1], items[i]] = [items[i], items[i + 1]]; selected = i + 1; }
      else if (act === 'dup') { addItem(it.obj, it.pl.rot); return; }
      else if (act === 'del') { items.splice(i, 1); selected = -1; }
      else selected = i;
      refresh();
    });
    row.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
      const f = inp.dataset.f as 'x' | 'y' | 'rot';
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) { it.pl = { ...it.pl, [f]: v }; refresh(); }
    }));
    host.appendChild(row);
  });
}

/** Add an object at its sliced position if that is free, otherwise at the first free spot. */
function addItem(obj: GcodeObject, rot = 0) {
  const settings = readSettings();
  const item: BedItem = { obj, pl: { x: obj.center.x, y: obj.center.y, rot }, color: OBJECT_COLORS[colorSeq++ % OBJECT_COLORS.length] };
  items.push(item);
  const idx = items.length - 1;
  const others = items.slice(0, idx).map((_, i) => i);
  const asIs = checkLayout(objs(), pls(), settings.clearance, settings.bed).violations.some((v) => v.a === idx || v.b === idx);
  if (asIs || rot !== 0) {
    const spot = findFreeSpot(objs(), pls(), idx, others, settings.clearance, settings.bed);
    if (spot) item.pl = spot;
  }
  selected = idx;
  refresh();
}

async function loadFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    try {
      const text = await f.text();
      addItem(parseGcode(text, f.name.replace(/\.(gcode|gco|g)$/i, '')));
    } catch (e) {
      message('err', `${f.name}: ${(e as Error).message}`);
    }
  }
}

async function loadSamples() {
  for (const name of ['cylinder', 'tube', 'pot']) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}samples/${name}.gcode`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      addItem(parseGcode(await res.text(), name));
    } catch (err) {
      message('err', `sample ${name}: ${(err as Error).message}`);
    }
  }
}

function ensureMerged(): MergeResult | null {
  if (result) return result;
  if (!items.length) return null;
  const settings = readSettings();
  try {
    result = mergeJob(objs(), pls(), settings);
  } catch (e) {
    message('err', (e as Error).message);
    return null;
  }
  for (const w of result.warnings) if (!items.some((it) => it.obj.warnings.some((ow) => w.endsWith(ow)))) message('warn', w);
  if (violations.some((v) => v.kind !== 'bed')) message('err', 'The layout has collisions (see above). The file can still be downloaded, but check it carefully.');
  message('info', `Start G-code from ${items[0].obj.name}, end G-code from ${result.objects[result.footerFrom].name} (the tallest).`);
  $<HTMLButtonElement>('download').disabled = false;
  return result;
}

function showTab(preview: boolean) {
  $('tabArrange').classList.toggle('active', !preview);
  $('tabPreview').classList.toggle('active', preview);
  $('arrangeView').hidden = preview;
  $('previewView').hidden = !preview;
  $('previewCtl').hidden = !preview;
  if (preview) {
    const r = ensureMerged();
    if (!r) return;
    if (!viewer) viewer = new Viewer($('previewView'));
    viewer.setPaths(r.preview, bedBox(readBed()));
    const range = $<HTMLInputElement>('objRange');
    range.max = String(viewer.objectCount);
    range.value = range.max;
    $('objLabel').textContent = 'all';
    viewer.showUpTo(viewer.objectCount);
  } else {
    bedView.draw();
  }
}

// --- wiring ------------------------------------------------------------------
loadSettings();
for (const id of SETTING_IDS) $(id).addEventListener('change', () => { saveSettings(); refresh(); });

$('file').addEventListener('change', (e) => {
  const fl = (e.target as HTMLInputElement).files;
  if (fl) loadFiles(fl);
  (e.target as HTMLInputElement).value = '';
});
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer?.files) loadFiles(e.dataTransfer.files);
});
// dropping on the bed works too
const bedHost = $('arrangeView');
bedHost.addEventListener('dragover', (e) => e.preventDefault());
bedHost.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer?.files) loadFiles(e.dataTransfer.files); });
$('samples').addEventListener('click', (e) => { e.preventDefault(); loadSamples(); });

$('arrange').addEventListener('click', () => {
  const s = readSettings();
  const p = pls();
  const unplaced = arrangeAll(objs(), p, s.clearance, s.bed);
  items.forEach((it, i) => { it.pl = p[i]; });
  refresh();
  if (unplaced.length) message('err', `No room on the bed for: ${unplaced.map((i) => items[i].obj.name).join(', ')}. They were left where they were.`);
});
$('sortHeight').addEventListener('click', () => {
  const sel = selected >= 0 ? items[selected] : null;
  items.sort((a, b) => a.obj.height - b.obj.height);
  selected = sel ? items.indexOf(sel) : -1;
  refresh();
});
$('clear').addEventListener('click', () => { items.length = 0; selected = -1; refresh(); });
$('merge').addEventListener('click', () => showTab(true));
$('download').addEventListener('click', () => {
  const r = ensureMerged();
  if (!r) return;
  const blob = new Blob([r.gcode], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const names = items.map((i) => i.obj.name);
  a.download = (names.length > 2 ? `${names[0]}+${names.length - 1}more` : names.join('+')) + '_merged.gcode';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('tabArrange').addEventListener('click', () => showTab(false));
$('tabPreview').addEventListener('click', () => showTab(true));
$('objRange').addEventListener('input', (e) => {
  if (!viewer) return;
  const n = parseInt((e.target as HTMLInputElement).value, 10);
  $('objLabel').textContent = n >= viewer.objectCount ? 'all' : String(n);
  viewer.showUpTo(n);
});
$('showTravel').addEventListener('change', (e) => viewer?.setTravelVisible((e.target as HTMLInputElement).checked));

refresh();
// ?samples opens the app with the sample files loaded; ?samples&preview also opens the 3D preview
const params = new URLSearchParams(location.search);
if (params.has('samples')) loadSamples().then(() => { if (params.has('preview')) showTab(true); });
