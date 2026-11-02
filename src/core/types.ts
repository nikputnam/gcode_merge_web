/** Shared data model for the merge tool. Distances in mm, angles in degrees unless noted. */

export interface Vec2 {
  x: number;
  y: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Extruder collision model, the same stepped-radius model TRAvel web uses: looking down the
 * nozzle axis, printed material at XY distance d from the nozzle may stand above the tip by at
 * most one layer within nozzleRadius, at most nozzleHeight within shroudRadius, and at most
 * gantryHeight beyond that.
 */
export interface ClearanceModel {
  nozzleRadius: number;
  nozzleHeight: number;
  shroudRadius: number;
  /** Infinity when nothing spans the bed above the extruder. */
  gantryHeight: number;
}

/** Where an object goes on the bed: its footprint centre lands at (x, y) after rotating by rot degrees CCW about that centre. */
export interface Placement {
  x: number;
  y: number;
  rot: number;
}

export interface BedSettings {
  width: number;
  depth: number;
  /** true for printers whose origin is the bed centre (deltas), false for a front-left corner origin. */
  originCenter: boolean;
}

export interface MergeSettings {
  clearance: ClearanceModel;
  bed: BedSettings;
  /** Extra height above the tallest finished object for the travel between objects. */
  travelLift: number;
  /** Travel speed (mm/s); undefined = from the first file's config, falling back to a default. */
  travelSpeed?: number;
  /** Retraction before the travel between objects (mm); undefined = from the file's config. */
  retractLength?: number;
  /** Retraction speed (mm/s); undefined = from the file's config. */
  retractSpeed?: number;
}
