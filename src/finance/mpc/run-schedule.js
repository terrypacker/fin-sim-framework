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

/**
 * Every decision the run ever made — for each (lever, key), the LAST row — regardless of date.
 *
 * `activeDecisionsAt` answers "what is in force now", which is what a reducer riding a period
 * advance needs. The two QUEUE levers (§6.3) need the other question: their rows fold into
 * year-keyed schedule params at COMPILE, before any clock exists, and a year-keyed schedule
 * already carries its own dates. Collapsing to the last row per key is the same last-wins rule
 * `activeDecisionsAt` applies, with the window opened to the whole run.
 *
 * `run.decisions` is sorted ascending, so a plain forward pass leaves the last row per key.
 *
 * @param {{decisions:Array}|null} run
 * @returns {Map<string, Array>|null} byLever, or null when the run decided nothing
 */
export function allDecisionsOf(run) {
  const rows = run?.decisions;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return activeDecisionsAt(run, rows[rows.length - 1].dateMs)?.byLever ?? null;
}

/**
 * DESIGN 81 §7 / D8 — the params a rollout seeded at "now" should compile against.
 *
 * A recorded run is an ordinary param, so `MpcCockpitPlugin._ensureController` picks it up
 * through `_paramsToMap(scenario.params)` like anything else — which means Advise at epoch 12
 * would solve against a world where epochs 13–44 are ALREADY DECIDED. The controller would be
 * optimising against its own answers, and the futures fan would be a fan of plans that already
 * contain their own futures.
 *
 * D8 settles it with a rule rather than a mode flag: a rollout seeded at "now" sees only rows
 * STRICTLY BEFORE "now". That one rule is right in all three cases — a fresh run sees nothing,
 * a resumed run sees its own committed past (which is exactly the realized plan), and
 * "re-solve from epoch k" gets the prefix and nothing else, for free.
 *
 * Strictly before, not at-or-before: a row dated exactly at "now" is the decision this epoch is
 * about to make. Including it would seed the search with its own answer.
 *
 * Non-destructive, and that is load-bearing. "Now" only moves forward, so truncating
 * `this.committed` in place at epoch 1 would delete rows epoch 12 is entitled to see. The
 * controller calls this per rollout instead of once.
 *
 * @param {object} params   the scenario parameter bag
 * @param {Date|string|number} asOf  the snapshot's "now"
 * @returns {object} `params` itself when nothing is selected, else a copy with the active run
 *                   truncated (and the selection cleared when nothing survives)
 */
export function truncateActiveRunAt(params, asOf) {
  const asOfMs = asOf != null ? new Date(asOf).getTime() : NaN;
  if (!Number.isFinite(asOfMs)) return params;

  const run = resolveActiveMpcRun(params);
  if (!run) return params;

  const kept = run.decisions.filter(r => r.dateMs < asOfMs);
  if (kept.length === run.decisions.length) return params;

  // Nothing survives ⇒ clear the SELECTION rather than leave an entry with no rows. An empty
  // `decisions` array resolves to null anyway (with a warning), and a warning on every rollout
  // of every fresh run is noise the user cannot act on.
  if (kept.length === 0) return { ...params, mpcActiveRun: null };

  return {
    ...params,
    mpcRuns: {
      ...params.mpcRuns,
      [run.runId]: { ...params.mpcRuns[run.runId], decisions: kept.map(r => ({ ...r })) },
    },
  };
}
