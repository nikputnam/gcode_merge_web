# G-code merge

A browser tool that combines several sliced G-code jobs into one file that prints the objects
one after another, with the objects arranged on the bed by hand and checked against an
extruder clearance model so the nozzle and extruder body never run into a finished object.

It is a companion to [TRAvel web](https://github.com/nikputnam/travel_slicer_web),
[WeaveSlicer](https://github.com/nikputnam/weaveSlicer3) and
[pot toy](https://github.com/nikputnam/pot-toy): slice or generate each object with whichever
tool suits it, then merge the results into one print job here. It also replaces pot toy's
"copies" option for anything that is not a grid of identical pots.

## Workflow

1. Produce one complete `.gcode` file per object: PrusaSlicer (or OrcaSlicer, SuperSlicer,
   Bambu Studio), TRAvel web, WeaveSlicer, pot toy, or anything that writes absolute XY moves.
2. Open the app (hosted at https://nikputnam.github.io/gcode_merge_web/ or `npm run dev`
   locally) and drop the files in. Each object appears as its footprint on the bed; drop the
   same file twice, or press ⧉, for more copies.
3. Drag the footprints where you want them (shift snaps to 5 mm; arrow keys nudge the selected
   object, R rotates it), or press **Arrange all**. The list on the left is the print order.
   Red outlines and a red measuring line show pairs that are too close for the extruder.
4. Set the bed size and the extruder clearance for your printer (they are remembered).
5. **Merge & preview** shows the whole job in 3D; **Download G-code** saves it.

## How the objects are joined

- The first object's start G-code opens the file, and the tallest object's end G-code closes
  it (its end G-code was written for a print at least that tall).
- Every object's body is copied exactly as sliced, with only the X and Y words moved (and I/J
  arc offsets rotated). Extrusion, feeds, fan and temperature commands inside the body are
  untouched.
- Between objects the nozzle retracts (unless the object already ended retracted), lifts above
  the tallest finished object plus the travel lift, travels to where the next object's body
  begins, and comes down. Then the state the next object's own start G-code would have left is
  restored: relative or absolute E (M82/M83), the E value (G92), hotend and bed temperature
  and fan if they differ, and the feed rate. The body then runs as if it had followed its own
  start G-code.
- Objects from different slicer profiles can be mixed; a warning says when a start G-code
  differs from the first object's.

## Clearance model

The same stepped-radius model as TRAvel web. When object B is printed after object A, the
nozzle starts at the bed next to a finished A, so every part of A at height *z* above the bed
must keep an XY distance from everywhere B's nozzle goes:

| part of A | required gap from B |
| --- | --- |
| within one layer of the bed | none (footprints must not overlap) |
| up to *nozzle height* | *nozzle radius* |
| up to *gantry height* | *shroud radius* |
| above *gantry height* | impossible: A must be printed after B, and only one such object can exist |

Only the part of an object above each threshold counts, so a short object (a coaster, a tile)
can sit close to the objects printed after it. **Shortest first** reorders the list to take
advantage of that.

The checks and the auto-arrangement use the convex hull of each object's material in each
height band against the convex hull of everywhere the later object's nozzle goes, including
its travel moves and skirt. Measure your extruder from the nozzle tip and add a millimetre or
two of margin.

## Layout

| file | role |
| --- | --- |
| `src/core/gcode.ts` | reads a job into header / body / footer, replays the machine state, measures the object, and re-emits a body moved to a placement |
| `src/core/layout.ts` | the clearance checks between ordered pairs and the free-spot search used for auto placement |
| `src/core/merge.ts` | joins the objects into one file with the transitions described above, and builds the preview |
| `src/core/geom.ts` | convex hulls, polygon gaps, placement transforms |
| `src/ui/bedView.ts` | the draggable top-down bed view |
| `src/ui/viewer.ts` | the three.js preview |
| `src/main.ts` | the page logic |

Everything in `src/core` is independent of the DOM, so a command-line or PrusaSlicer
post-processing front end can be added later.

## Development

```
npm install
npm run dev        # app on http://localhost:5173 (add ?samples to load the sample files)
npm test           # vitest; fixtures in test/fixtures/gcode come from travel_slicer_web's `npm run fixtures`
npm run samples    # regenerate public/samples from the fixtures and the synthetic pot toy file
npm run build
```
