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
 * DESIGN 81 §4 — a bag of recorded MPC runs, and a scalar that selects one.
 *
 *   mpcRuns        { '<runId>': { source, decisions: [{ date, lever, key, value }, …] } }
 *   mpcActiveRun   '<runId>' | null   — which one governs this run of the plan
 *   mpcRunEnabled  true               — the OFF switch that KEEPS the selection
 *
 * This file holds the two selectors and nothing else. The discipline is design 109 §7's,
 * recorded there and worth repeating: ONE resolver and ONE selector, exported, called by
 * every consumer — normalizing the same object three times with three slightly different
 * option sets is how it comes to mean three things.
 *
 * ─── why a bag plus a scalar, and not one flat schedule param (§4.1) ─────────────
 *
 * A single `mpcDecisionSchedule: [ … ]` array works and is simpler to describe. It is also a
 * dead end: a scenario would hold one plan at a time, the provenance would have to live in a
 * sibling param that can drift from it, and — the load-bearing one — an ARRAY CANNOT BE AN
 * AXIS. `DecisionPoint.options` are `{ value, label }` pairs and `makeLeafEntry` writes
 * `p.value = leafParams[p.name]`; a scalar run id is a perfect option value, a four-hundred-row
 * array is not. The indirection is what makes "compare two recorded runs" a `DecisionPoint`
 * over one param, an `ENUM` variable for the optimizer and a `params` entry for `variant.mjs`,
 * with no new machinery in any of the three.
 */

/** A recorded run's decision rows, normalized: `dateMs` attached, sorted, junk dropped. */
function _normalizeDecisions(rows, runId) {
  const out = [];
  for (const [i, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const dateMs = row?.date != null ? new Date(row.date).getTime() : NaN;
    if (!Number.isFinite(dateMs) || !row?.lever || !row?.key) {
      console.warn(`mpcRuns: '${runId}' decision row ${i} is missing a date, lever or key `
        + '(design 81 §4.4 — a row is four scalar columns); the row is ignored.');
      continue;
    }
    out.push({ date: row.date, dateMs, lever: String(row.lever), key: String(row.key), value: row.value });
  }
  // Ascending by date, then lever, then key. The tie-break is not decoration: two rows for
  // the same (lever, key) on the same date are a last-wins collapse, and "last" has to mean
  // the same thing on every load or a scenario replays differently on a re-read.
  out.sort((a, b) => a.dateMs - b.dateMs
    || a.lever.localeCompare(b.lever)
    || a.key.localeCompare(b.key));
  return out;
}

/**
 * The run that governs this scenario, or **null**.
 *
 * Null when the switch is off, when nothing is selected, or when the selection names an entry
 * the bag does not have. That last case WARNS: design 81 §15's sharp edge — a dangling
 * selection must degrade to "no run" *visibly*, because the alternative is a scenario that
 * silently plays the base plan while the panel says it is playing a recorded one.
 *
 * Note the gate is on the SELECTION, not on the bag. A scenario may carry ten recorded runs
 * and play none of them; that is what makes the bag safe to accumulate (D4).
 *
 * @param {object} params  the scenario parameter bag (`context.parameters`).
 * @returns {{runId:string, source:object|null, decisions:Array}|null}
 */
export function resolveActiveMpcRun(params) {
  if (params?.mpcRunEnabled === false) return null;
  const runId = params?.mpcActiveRun;
  if (typeof runId !== 'string' || runId === '') return null;

  const bag   = params?.mpcRuns;
  const entry = (bag && typeof bag === 'object' && !Array.isArray(bag)) ? bag[runId] : null;
  if (!entry) {
    console.warn(`mpcActiveRun: '${runId}' is not an entry of \`mpcRuns\`, so no recorded run `
      + 'governs this plan and it runs as the base scenario (design 81 §15). Select an '
      + 'existing run, or clear the selection.');
    return null;
  }

  const decisions = _normalizeDecisions(entry.decisions, runId);
  if (decisions.length === 0) {
    console.warn(`mpcActiveRun: '${runId}' has no usable decision rows, so it changes nothing.`);
    return null;
  }
  return { runId, source: entry.source ?? null, decisions };
}

/**
 * The decisions IN FORCE at `asOfMs` — for each (lever, key), the latest row dated at or
 * before it — grouped by lever, with the date of the most recent row applied.
 *
 * "At or before", so a row takes effect at the first period advance ON or after its date
 * (D6). The lag that creates is real and deterministic: on a semi-annual advance cadence a
 * decision recorded in March bites in July. The panel shows the date a decision became LIVE,
 * not the date recorded.
 *
 * `throughMs` is the whole change detector. The active set can only change when a new row's
 * date is crossed, so one scalar — the greatest row date not after "now" — decides whether
 * this period has anything to do, for every lever at once.
 *
 * @param {{decisions:Array}|null} run
 * @param {number} asOfMs
 * @returns {{throughMs:number, byLever:Map<string, Array>}|null}
 */
export function activeDecisionsAt(run, asOfMs) {
  const rows = run?.decisions;
  if (!Array.isArray(rows) || rows.length === 0 || !Number.isFinite(asOfMs)) return null;

  const latest = new Map();          // `${lever}\u0000${key}` -> row
  let throughMs = null;
  for (const row of rows) {
    if (row.dateMs > asOfMs) break;  // sorted ascending — everything after this is future
    latest.set(`${row.lever}\u0000${row.key}`, row);
    throughMs = row.dateMs;
  }
  if (throughMs == null) return null;

  const byLever = new Map();
  for (const row of latest.values()) {
    if (!byLever.has(row.lever)) byLever.set(row.lever, []);
    byLever.get(row.lever).push(row);
  }
  for (const list of byLever.values()) list.sort((a, b) => a.key.localeCompare(b.key));
  return { throughMs, byLever };
}
