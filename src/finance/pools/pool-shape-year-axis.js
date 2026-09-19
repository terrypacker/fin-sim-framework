/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The shape-switch YEAR axis — design 110 leg C, phase 9 (§6.4, design 109 Q1).
 *
 * Design 109 Q1's question is *"what does moving the bridge shape two years earlier do"*, and it
 * flags the trap in the obvious answer: `liquidityGraphSchedule[i].year` is a nested path into an
 * object param, a dotted key is dropped by the param `set()`, and *"an axis that reads as
 * authored and is inert is this repo's most expensive recurring defect"*. Its own conclusion was
 * *"a flat scalar companion param rather than a path into the array"* — which is §6.2's answer,
 * arrived at independently, so §6.4 folded the two together: build the mechanism once, then add
 * this behind it.
 *
 * ── a SHIFT, not a year, and for §10.3's reason ─────────────────────────────────────
 *
 * The key is **`shape.<shapeId>.yearShift`, default 0**, applied to every schedule row that
 * selects that shape.
 *
 * The parallel with the pool factor is exact and the argument is the same one §10.3 already
 * settled. A shape id can carry SEVERAL authored years: `_normalizeSchedule` refuses two rows in
 * one YEAR but says nothing about one shape appearing twice, so `[{2035, bridge}, {2045, late},
 * {2055, bridge}]` is a legal plan in which `bridge` is scheduled twice on purpose. An absolute
 * `shape.<id>.year` swept to 2040 would set BOTH of those rows to 2040 — which is not even
 * expressible, because two rows in one year is a refusal, so the axis would turn a legal plan
 * into a failing one at every cell but its own. A shift moves both and preserves the gap between
 * them, which is the schedule's shape, exactly as the factor preserves a pool's profile.
 *
 * It is also the more direct reading of the question. "Two years earlier" IS `-2`; an absolute
 * year makes the author compute it, and makes a grid of 2033/2035/2037 mean different distances
 * on two different plans.
 *
 * `0` is the identity, so a plan nobody sweeps normalizes the authored array itself.
 *
 * ── what this deliberately does NOT do ──────────────────────────────────────────────
 *
 * **No second validator** (§17.2). A shift that lands one switch on another's year is REFUSED by
 * `_normalizeSchedule`'s own duplicate-year rule, with its own sentence. That is the honest
 * behaviour — silently coalescing two switches would run a schedule nobody wrote — and it is the
 * same bargain the PERCENT pool target takes. It does mean a wide shift on a plan whose switches
 * are close together will have failing cells, which `poolAxisProblems` says up front.
 *
 * **Only SCHEDULED shapes get an axis.** A shape no row selects governs nothing (there is
 * already an advisory for it), so an axis on it would move nothing at every value — the dead
 * lever this design has now shipped once and does not intend to ship twice.
 *
 * **The base graph has no axis.** The period before the first row is the `liquidityGraph` param
 * and is not a named shape (`resolveLiquidityGraphSchedule` reports its `shapeId` as null
 * deliberately). When it ends is decided by the FIRST row, so shifting that row's shape is how
 * you move it; there is nothing else to address.
 */

/** The generated namespace this axis lives in (see `GENERATED_KEY_PREFIXES`). */
export const SHAPE_KEY_PREFIX = 'shape.';

/** The one field the namespace carries. */
export const SHAPE_YEAR_SHIFT_FIELD = 'yearShift';

/** Identity — the value a plan nobody sweeps runs at. */
export const SHAPE_YEAR_SHIFT_DEFAULT = 0;

/** How far a grid or a solver may move a switch, in years. */
export const SHAPE_YEAR_SHIFT_RANGE = Object.freeze({ min: -5, max: 5, step: 1 });

/** The param key for one shape's switch-year shift. */
export function shapeYearShiftKey(shapeId) {
  return `${SHAPE_KEY_PREFIX}${shapeId}.${SHAPE_YEAR_SHIFT_FIELD}`;
}

/**
 * The shape id in a `shape.<shapeId>.yearShift` key, or null for anything else.
 *
 * A shape id is an object key and nothing narrows it today, so — exactly as for a pool id — the
 * id is everything between the prefix and the trailing field rather than one dot-free token.
 * Narrowing it retroactively would invalidate plans that already load.
 */
export function parseShapeYearShiftKey(key) {
  if (typeof key !== 'string' || !key.startsWith(SHAPE_KEY_PREFIX)) return null;
  const suffix = `.${SHAPE_YEAR_SHIFT_FIELD}`;
  if (!key.endsWith(suffix)) return null;
  const id = key.slice(SHAPE_KEY_PREFIX.length, key.length - suffix.length);
  return id.length > 0 ? id : null;
}

/**
 * The shifts a params bag carries, as `shapeId → whole years`.
 *
 * Identity and nonsense are both dropped, so the common case returns an empty map and
 * `applyShapeYearShifts` can hand back the caller's own array — which is what keeps an unswept
 * plan byte-identical rather than merely equal.
 *
 * A fractional shift is dropped rather than rounded: `_normalizeSchedule` requires a whole year,
 * so rounding here would silently decide something the normalizer would have refused.
 */
export function shapeYearShiftsFrom(params) {
  const out = new Map();
  if (!params || typeof params !== 'object') return out;
  for (const key of Object.keys(params)) {
    const shapeId = parseShapeYearShiftKey(key);
    if (shapeId == null) continue;
    const n = Number(params[key]);
    if (!Number.isInteger(n) || n === SHAPE_YEAR_SHIFT_DEFAULT) continue;
    out.set(shapeId, n);
  }
  return out;
}

/**
 * A raw `[{ year, shape }]` schedule with each shifted shape's rows moved. Returns the SAME
 * array when nothing changed.
 *
 * Rows are left in their authored ORDER: `_normalizeSchedule` sorts by year itself, so sorting
 * here would be a second authority on the ordering and would change which row an index-keyed
 * error message names.
 */
export function applyShapeYearShifts(rawSchedule, shifts) {
  if (!Array.isArray(rawSchedule) || shifts.size === 0) return rawSchedule;
  let touched = false;
  const out = rawSchedule.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const shift = shifts.get(row.shape);
    if (shift === undefined || !Number.isInteger(Number(row.year))) return row;
    touched = true;
    return { ...row, year: Number(row.year) + shift };
  });
  return touched ? out : rawSchedule;
}

/**
 * Every SCHEDULED shape, with the years it is authored to take over in.
 *
 * Reads the raw schedule, for the reason every other axis list does: this runs on an unloaded
 * param bag where the plan may not compile at all, and a list that throws would take the whole
 * Opt / grid panel with it. A row naming a shape that does not exist is simply skipped — the
 * normalizer is the authority on that, and an axis for a shape nobody has is a dead lever.
 *
 * @returns {Array<{ shapeId: string, years: number[] }>}
 */
export function scheduledShapeAxes(params) {
  const schedule = params?.liquidityGraphSchedule;
  if (!Array.isArray(schedule)) return [];
  const shapes = params?.liquidityShapes;
  const known = (shapes && typeof shapes === 'object' && !Array.isArray(shapes))
    ? new Set(Object.keys(shapes)) : new Set();
  const byId = new Map();
  for (const row of schedule) {
    if (!row || typeof row !== 'object') continue;
    const { shape } = row;
    const year = Number(row.year);
    if (typeof shape !== 'string' || !shape || !known.has(shape) || !Number.isInteger(year)) continue;
    const entry = byId.get(shape) ?? { shapeId: shape, years: [] };
    entry.years.push(year);
    byId.set(shape, entry);
  }
  for (const entry of byId.values()) entry.years.sort((a, b) => a - b);
  return [...byId.values()];
}

/**
 * The label a shape-year axis carries.
 *
 * Names the authored years the shift moves, and — when a shape is scheduled more than once —
 * says that one key moves all of them. That is the same obligation §6.4 put on the pool axis and
 * it is the whole reason this is a shift: the reader has to be able to see that the gap between
 * two switches is being preserved rather than collapsed.
 */
export function shapeYearShiftLabel(row) {
  const years = row.years.join(', ');
  const many = row.years.length > 1 ? ` — one key, ${row.years.length} switches, gap preserved` : '';
  return `Shape '${row.shapeId}' switch year ± (from ${years})${many}`;
}

/** The plan value of every shape axis: `0`, for each shape the schedule selects. */
export function resolveShapeYearShiftCenters(params) {
  const centers = {};
  for (const { shapeId } of scheduledShapeAxes(params)) {
    centers[shapeYearShiftKey(shapeId)] = SHAPE_YEAR_SHIFT_DEFAULT;
  }
  return centers;
}
