/** Writes the sample files the "Load sample files" button fetches: two PrusaSlicer fixtures and a pot toy style spiral. */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { potToyLike } from '../test/helpers.ts';

const root = join(import.meta.dirname, '..');
const out = join(root, 'public', 'samples');
mkdirSync(out, { recursive: true });
for (const f of ['cylinder.gcode', 'tube.gcode', 'two_towers.gcode']) copyFileSync(join(root, 'test', 'fixtures', 'gcode', f), join(out, f));
writeFileSync(join(out, 'pot.gcode'), potToyLike(100, 100, 25, 24));
console.log('wrote samples to', out);
