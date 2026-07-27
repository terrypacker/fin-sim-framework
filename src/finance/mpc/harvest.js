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
 * Harvest — copy a completed MPC run's decisions back into scenario params
 * (design/39 §13).
 *
 * The cockpit is a DISCOVERY surface; this is the copy-out step. It reads the
 * decision-record log (§13.2 — not the controller, which is rebuilt after every
 * Apply and whose `committed` bag has already collapsed the time dimension),
 * routes each epoch's values back to the lever that owns them, and produces a
 * reviewable `HarvestPlan`. Nothing writes a param without passing through the
 * plan: `harvestDecisions()` builds it, the cockpit renders it, and
 * `applyHarvestPlan()` (harvest-apply.js) executes it.
 *
 * Three forms (§13.3), chosen by the PLANT rather than by preference:
 *   - SCHEDULE — the per-epoch sequence baked into a time-keyed param the plant
 *                already reads (spending bands, the per-year schedules, the
 *                allocation glidepath). Faithful to what the controller did.
 *   - POINT    — one value: the last (or modal) epoch's decision. Arbitrary
 *                whenever the decisions actually varied, so it ALWAYS warns.
 *   - RESOLVE  — re-solve the best STATIC value over the whole run (§13.6.6).
 *                Layered on top by harvest-resolve.js; POINT is its fallback.
 */

export const HARVEST_FORMS = {
  SCHEDULE: 'SCHEDULE',
  POINT:    'POINT',
  RESOLVE:  'RESOLVE',
};

/** Collapse rules for POINT (§13.6.3). */
export const COLLAPSE_RULES = { LAST: 'last', MODAL: 'modal' };

/**
 * An enabling-param requirement of the form "this multi-valued param must
 * CONTAIN x" — for the `EnumMulti` params (`spendingStrategy`,
 * `behavioralStrategies`) where a plain assignment would clobber the user's other
 * selected strategies. `applyHarvestPlan` appends rather than replaces.
 */
export function requiresIncludes(value) { return { includes: value }; }

/** True when `to` is an `includes` requirement rather than a plain value. */
export function isIncludesRequirement(to) {
  return !!to && typeof to === 'object' && !Array.isArray(to) && 'includes' in to;
}

/** Whether the scenario's current value already satisfies a requirement. */
export function requirementSatisfied(from, to) {
  if (isIncludesRequirement(to)) {
    return Array.isArray(from) ? from.includes(to.includes) : from === to.includes;
  }
  return _sameValue(from, to);
}

/**
 * Build a HarvestPlan from a run's decision records.
 *
 * @param {object[]} records  - `readDecisionRecords(graph, { runId })`, oldest first.
 * @param {object}   opts
 * @param {object}   opts.controlsByKey - { [COCKPIT_CONTROLS key]: controlSpec }.
 * @param {object}  [opts.baseParams]   - the scenario's current flat params (the diff's "from").
 * @param {object}  [opts.birth]        - { birthDate } of the primary, for age-keyed bakes.
 * @param {object}  [opts.epsilon]      - per-form collapse tolerances.
 * @param {string}  [opts.collapse]     - COLLAPSE_RULES for POINT levers.
 * @param {Date}    [opts.simStart]     - plan start, for the glidepath's prepended anchor.
 * @returns {{
 *   runId, epochs, epochRange: [string|null, string|null], levers: string[],
 *   goal: object|null,
 *   entries:  Array<{ paramKey, lever, form, from, to, epochs, label, varied }>,
 *   requires: Array<{ paramKey, from, to, reason, lever }>,
 *   warnings: string[],
 * }}
 */
export function harvestDecisions(records = [], {
  controlsByKey = {},
  baseParams    = {},
  birth         = null,
  epsilon       = {},
  collapse      = COLLAPSE_RULES.LAST,
  simStart      = null,
} = {}) {
  const rows = [...records].sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate)));
  const leverKeys = [...new Set(rows.flatMap(r => r.controlKeys ?? []))];

  const entries  = [];
  const requires = [];
  const warnings = [];

  for (const key of leverKeys) {
    const control = controlsByKey[key];
    if (!control) {
      warnings.push(`Lever “${key}” is no longer registered — its decisions were skipped.`);
      continue;
    }
    const epochs = _epochsFor(rows, key);
    if (!epochs.length) continue;

    const ctx = { epochs, baseParams, birth, epsilon, collapse, simStart, control };
    let out;
    try {
      out = control.harvest
        ? control.harvest(ctx)
        : pointHarvest(ctx);
    } catch (err) {
      warnings.push(`Lever “${control.label ?? key}” could not be harvested: ${err?.message ?? err}`);
      continue;
    }

    for (const [paramKey, value] of Object.entries(out?.params ?? {})) {
      entries.push({
        paramKey,
        lever:  control.label ?? key,
        leverKey: key,
        form:   out?.form ?? HARVEST_FORMS.POINT,
        from:   baseParams?.[paramKey],
        to:     value,
        epochs: epochs.length,
        label:  out?.labels?.[paramKey] ?? null,
        varied: out?.varied?.[paramKey] ?? false,
      });
    }
    // Enabling params (§13.5 rule 3): declared statically on the spec and/or
    // returned by the hook. Without these the bake is INERT — a harvested
    // drawdownWeight does nothing unless drawdownStrategy is WEIGHTED.
    const req = { ...(control.harvestRequires ?? {}), ...(out?.requires ?? {}) };
    for (const [paramKey, to] of Object.entries(req)) {
      const from = baseParams?.[paramKey];
      if (requirementSatisfied(from, to)) continue;    // already satisfied
      requires.push({
        paramKey, from, to, lever: control.label ?? key,
        reason: isIncludesRequirement(to)
          ? `“${control.label ?? key}” has no effect unless ${paramKey} includes ${_short(to.includes)}`
          : `“${control.label ?? key}” has no effect unless ${paramKey} = ${_short(to)}`,
      });
    }
    warnings.push(...(out?.warnings ?? []));
  }

  const runId = rows.find(r => r.runId != null)?.runId ?? null;
  return {
    runId,
    epochs: rows.length,
    epochRange: [rows[0]?.asOfDate ?? null, rows[rows.length - 1]?.asOfDate ?? null],
    levers: leverKeys,
    goal:   rows[rows.length - 1]?.goalMetric ?? null,
    entries, requires, warnings,
  };
}

/**
 * The POINT default (§13.6.3) — used for any lever without a `harvest` hook.
 *
 * Keeps the last (or modal) epoch's value per paramKey and, whenever the
 * decisions actually varied, says so with numbers. Silence is never an option: a
 * collapsed lever that looks clean in the diff is how a harvest ends up
 * "successful" while the re-run diverges.
 */
export function pointHarvest({ epochs, collapse = COLLAPSE_RULES.LAST, control = null }) {
  const params = {};
  const labels = {};
  const varied = {};
  const warnings = [];
  const label = control?.label ?? 'lever';

  for (const paramKey of _paramKeysOf(epochs)) {
    const series = epochs
      .map(e => e.candidate?.[paramKey])
      .filter(v => v !== undefined);
    if (!series.length) continue;

    const last  = series[series.length - 1];
    const modal = _modal(series);
    const changes = _changeCount(series);
    const pick = collapse === COLLAPSE_RULES.MODAL ? modal.value : last;

    params[paramKey] = pick;
    varied[paramKey] = changes > 0;
    labels[paramKey] = changes > 0
      ? `${_short(pick)} (${collapse === COLLAPSE_RULES.MODAL ? 'modal' : 'last'} of ${series.length} epochs)`
      : `${_short(pick)} (constant across ${series.length} epochs)`;

    if (changes > 0) {
      const spread = _numericSpread(series);
      warnings.push(
        `“${label}” · ${paramKey}: changed in ${changes} of ${series.length} epochs` +
        (spread ? ` (range ${_short(spread.min)}–${_short(spread.max)})` : '') +
        ` — freezing the ${collapse === COLLAPSE_RULES.MODAL ? 'modal' : 'last'} decision ` +
        `${_short(pick)}; the re-run will differ from the cockpit trajectory.` +
        (modal.count > 1 && collapse !== COLLAPSE_RULES.MODAL
          ? ` (${_short(modal.value)} held for ${modal.count} of ${series.length}.)` : ''),
      );
    }
  }
  return { form: HARVEST_FORMS.POINT, params, labels, varied, warnings };
}

// ─── Shared helpers for the per-lever hooks ──────────────────────────────────

/**
 * Collapse a `{ key, value }` series, dropping an entry whose value is within
 * `eps` of its predecessor. Used by the band/anchor bakes to turn ~20 epochs into
 * a handful of legible knots (§13.6.1 / §13.6.4).
 *
 * @param {Array<{key:number, value:*}>} points  - ascending by key.
 * @param {(a:*,b:*)=>number} distance           - |a − b| for the value type.
 * @param {number} eps
 */
export function collapseConsecutive(points, distance, eps) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && distance(prev.value, p.value) <= eps) continue;
    out.push(p);
  }
  return out;
}

/** Whole years of age at `date` for a birthDate (mirrors the reducers' age math). */
export function ageAt(birthDate, date) {
  if (!birthDate || !date) return null;
  const d = new Date(date), b = new Date(birthDate);
  if (Number.isNaN(d.getTime()) || Number.isNaN(b.getTime())) return null;
  const years = d.getUTCFullYear() - b.getUTCFullYear();
  const had = d.getUTCMonth() > b.getUTCMonth()
    || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() >= b.getUTCDate());
  return had ? years : years - 1;
}

/** The primary's birthDate from whichever source the caller has (§13.6.1: the
 *  scenario's persons, NOT the disposable snapshot state). */
export function resolveBirthDate({ persons = null, state = null } = {}) {
  const p = Array.isArray(persons) ? persons.find(x => x?.birthDate) : null;
  if (p?.birthDate) return p.birthDate;
  const people = state?.people ?? {};
  const first = people[Object.keys(people)[0]];
  return first?.birthDate ?? state?.personBirthDate ?? null;
}

// ─── internals ───────────────────────────────────────────────────────────────

/** Per-epoch view of one lever: its own variable subset + the matching candidate slice. */
function _epochsFor(rows, key) {
  const out = [];
  for (const r of rows) {
    if ((r.controlKeys ?? []).length && !r.controlKeys.includes(key)) continue;
    const all = r.controlVars ?? [];
    // Records written before multi-lever tagging carry untagged vars; with a
    // single active lever those are unambiguously its own.
    const tagged = all.some(v => v?._controlKey);
    const vars = tagged ? all.filter(v => v._controlKey === key) : all;
    if (!vars.length) continue;
    const keys = new Set(vars.map(v => v.paramKey));
    const candidate = {};
    for (const [k, v] of Object.entries(r.controlParams ?? {})) {
      if (keys.has(k)) candidate[k] = v;
    }
    out.push({ asOfDate: r.asOfDate, candidate, vars, record: r });
  }
  return out;
}

function _paramKeysOf(epochs) {
  const keys = [];
  for (const e of epochs) {
    for (const k of Object.keys(e.candidate ?? {})) if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

/** How many times the value changed from one epoch to the next. */
function _changeCount(series) {
  let n = 0;
  for (let i = 1; i < series.length; i++) if (!_sameValue(series[i - 1], series[i])) n++;
  return n;
}

/** The most-held value and how many epochs held it. */
function _modal(series) {
  const counts = new Map();
  for (const v of series) {
    const k = _short(v);
    const e = counts.get(k) ?? { value: v, count: 0 };
    e.count += 1;
    counts.set(k, e);
  }
  let best = { value: series[series.length - 1], count: 0 };
  for (const e of counts.values()) if (e.count > best.count) best = e;
  return best;
}

function _numericSpread(series) {
  const nums = series.filter(v => Number.isFinite(Number(v))).map(Number);
  if (nums.length < 2) return null;
  const min = Math.min(...nums), max = Math.max(...nums);
  return min === max ? null : { min, max };
}

function _sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (a == null || b == null) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

function _short(v) {
  if (v == null) return '—';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  }
  if (typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > 60 ? `${s.slice(0, 57)}…` : s;
    } catch { return '[object]'; }
  }
  return String(v);
}

export const _internals = { _epochsFor, _modal, _changeCount, _sameValue, _short };
