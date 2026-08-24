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
 * golden-harness.js — run a golden scenario and pin its ENTIRE end state.
 *
 * Why a fixture and not a scalar:
 *
 * The original golden (cross-border-relief-scenario.test.mjs) asserted two
 * numbers at ±1%. Reviewing the 17 regolds documented in that file's own comment
 * block, NINE of them moved both metrics by less than 1% — design 66 §G4
 * (−0.08%), §G10a (+0.06%), §G10b ($1), design 71 §14 (+0.55%), design 76 §0
 * (+0.28%), P4 (−0.33%), P5 (−0.01%), design 77 (+0.56%). Every one of those
 * would have left the test GREEN. The comment log is a record of deltas measured
 * by hand outside the test, not of failures the test produced. Two of the real
 * bugs in that log were caught by the FTC-US-9 invariant test instead, and the
 * comment says so; a third was caught by a runtime warning on a live scenario.
 *
 * A ±1% band on a 44-year compounding run is simply not a tripwire. So the golden
 * now pins the whole final state and compares it exactly. A regold stops being
 * "the number moved" and becomes a reviewable diff that names the field.
 *
 * This is only possible because the simulation is bit-reproducible: two runs, in
 * the same process or in different processes, produce a byte-identical
 * JSON.stringify(sim.state) (verified 2026-08-07 — sha256 stable across
 * processes, 32,091 chars for the reference scenario). Holding ids are stable
 * slugs ('h-us-equity'), not UUIDs, so nothing in state is run-dependent.
 *
 * Numbers are trimmed to 12 significant digits before comparison. Float64 carries
 * ~15–17, so this discards only the last few ULPs — enough to survive a V8 or
 * platform change in Math.pow/Math.exp, while still catching a one-cent move on a
 * ten-million-dollar balance.
 *
 * REGOLDING: run with REGOLD=1 to rewrite every fixture from the current code,
 * then READ THE DIFF before committing:
 *
 *     REGOLD=1 node --test tests/unit/golden-scenarios.test.mjs
 *     git diff tests/fixtures/
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

const HERE         = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, '..', 'fixtures');

/** Set REGOLD=1 to rewrite fixtures instead of asserting against them. */
export const REGOLD = process.env.REGOLD === '1';

/** Significant digits retained when normalizing a float for comparison. */
const SIG_DIGITS = 12;

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Trim a float to SIG_DIGITS significant digits so last-ULP differences between
 * V8 versions / platforms cannot fail a fixture. Integers, NaN and ±Infinity pass
 * through unchanged (JSON turns the last two into null either way, which is the
 * honest representation of "this went non-finite").
 */
function normalizeNumber(n) {
  if (!Number.isFinite(n) || Number.isInteger(n)) return n;
  return Number(n.toPrecision(SIG_DIGITS));
}

/**
 * Deep-copy `value` into a comparison-stable plain object: numbers trimmed, Dates
 * rendered as ISO strings, object keys sorted so a fixture diff reflects changed
 * VALUES rather than changed insertion order. Sorting matters because state keys
 * are added in event-execution order, so an unrelated scheduling change would
 * otherwise reshuffle the whole file.
 */
export function normalizeState(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return normalizeNumber(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeState);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = normalizeState(value[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return undefined; // functions / symbols never belong in a state fixture
}

// ─── Running ──────────────────────────────────────────────────────────────────

/**
 * A golden spec.
 *
 * @typedef  {object} GoldenSpec
 * @property {string}   name        fixture basename — tests/fixtures/golden-<name>.json
 * @property {string}   description what this golden is FOR (which features it exercises)
 * @property {Function} [cls]       scenario class; defaults to IntlRetirementScenario
 * @property {Date}     simStart
 * @property {Date}     simEnd
 * @property {object}   [params]    scenario + toolset params handed to buildDefaultConfig
 * @property {function} [mutateCfg] (cfg) ⇒ void — structural edits the param bag can't express
 */

/**
 * Build, load and run one golden spec to its simEnd.
 *
 * Runs with `telemetry: 'journal'` because the coverage gate reads
 * `sim.journal.journal[].action.type` to learn which action types this golden
 * actually exercises — that set is the whole point of the gate, and it cannot be
 * recovered from final state.
 *
 * @param   {GoldenSpec} spec
 * @returns {{ sim, state, snapshot: object, firedActionTypes: Set<string>,
 *             wiredActionTypes: Set<string>, cfg: object }}
 */
/**
 * The cfg a golden runs, built exactly once here so that any OTHER test wanting to drive
 * the same scenario (bond-par-conservation.test.mjs instruments its reducers) gets a
 * byte-identical configuration rather than a near-copy. A near-copy that missed the FX
 * pin below would measure a different world and report a difference as a defect.
 */
export function buildGoldenCfg(spec) {
  // Defaulted rather than required: every golden predating the second prebuilt
  // scenario is an IntlRetirementScenario run and says so by omission.
  const ScenarioCls = spec.cls ?? IntlRetirementScenario;
  // FX is PINNED for every golden, overriding the scenario default. The goldens
  // exist to guard tax and account mechanics; with a stochastic FX process the
  // exchange rate becomes an input drawn from the RNG, and every fixture field
  // downstream of a conversion would move whenever an unrelated change shifted
  // draw ordering. That turns a fixture diff from evidence into noise. A spec may
  // still opt in via `params.fxProcessModel` if its subject IS the FX path.
  const cfg = ScenarioCls.buildDefaultConfig(
    { fxProcessModel: 'NONE', ...(spec.params ?? {}) }, spec.simStart, spec.simEnd);
  spec.mutateCfg?.(cfg);
  return cfg;
}

export function runGolden(spec) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = buildGoldenCfg(spec);

  const scenario = new BaseScenario({
    context:      services.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  scenario.buildSim({ telemetry: 'journal' });
  new ScenarioLoader().load(cfg, services);

  // The simulation narrates OUT_OF_FUNDS and similar to console; a golden run is
  // expected to be noisy and the noise is not the assertion.
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(new Date(cfg.simEnd)); }
  finally { console.log = log; console.warn = warn; }

  const firedActionTypes = new Set(
    scenario.sim.journal.journal.map(e => e.action?.type).filter(Boolean));
  const wiredActionTypes = new Set(
    (cfg.reducers ?? []).flatMap(r => r.reducedActionTypes ?? []));

  return {
    sim:      scenario.sim,
    state:    scenario.sim.state,
    snapshot: normalizeState(scenario.sim.state),
    firedActionTypes,
    wiredActionTypes,
    cfg,
  };
}

/**
 * Memoized runGolden — the fixture assertions and the coverage gate both need
 * every golden's run, and `node --test` executes one file in one process, so a
 * single map keeps each scenario to exactly one execution per file.
 */
const _runs = new Map();
export function getGoldenRun(spec) {
  if (!_runs.has(spec.name)) _runs.set(spec.name, runGolden(spec));
  return _runs.get(spec.name);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Every non-finite number in a state tree, as `dotted.path = NaN|Infinity`.
 *
 * Worth a dedicated check because JSON hides these: `JSON.stringify(NaN)` is the
 * string `"null"`, so a NaN and a genuine null are indistinguishable once a
 * fixture is written, and a fixture diff would read the nonsense "null → null".
 * They are also sticky — nothing recomputes a poisoned field — and
 * `x ?? 0` does NOT catch NaN, so the usual defensive idiom lets them through
 * into saved scenarios. The first run of this harness found two: EVT-27 had been
 * writing NaN into `auStockAccount.contributionBasis`/`.earningsBasis` for the
 * whole 24-year reference run.
 */
export function findNonFinite(state) {
  const bad = [];
  (function walk(v, path) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) bad.push(`${path} = ${v}`);
      return;
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    }
  })(state, '');
  return bad;
}

export const fixturePath = name => join(FIXTURE_DIR, `golden-${name}.json`);

export function readFixture(name) {
  const p = fixturePath(name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeFixture(name, snapshot) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(fixturePath(name), JSON.stringify(snapshot, null, 1) + '\n');
}

/**
 * Flatten a normalized snapshot to `dotted.path -> scalar`, so a mismatch can be
 * reported as the handful of fields that actually moved rather than as two 32KB
 * blobs the reader has to diff by eye.
 */
function flatten(value, prefix = '', out = {}) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value);
    if (entries.length === 0) out[prefix] = Array.isArray(value) ? '[]' : '{}';
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = value;
  }
  return out;
}

/**
 * Compare a snapshot against its committed fixture, returning a human-readable
 * report of the differing leaves (empty string when they match).
 */
export function diffAgainstFixture(name, snapshot, { maxRows = 40 } = {}) {
  const expected = readFixture(name);
  if (expected == null) return `no fixture at ${fixturePath(name)} — run with REGOLD=1 to create it`;

  const a = flatten(expected);
  const b = flatten(snapshot);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const rows = [];
  for (const k of keys) {
    if (Object.is(a[k], b[k])) continue;
    const was = k in a ? JSON.stringify(a[k]) : '(absent)';
    const now = k in b ? JSON.stringify(b[k]) : '(absent)';
    rows.push({ k, was, now });
  }
  if (rows.length === 0) return '';

  const w = Math.min(52, Math.max(...rows.slice(0, maxRows).map(r => r.k.length)));
  const lines = rows.slice(0, maxRows).map(r =>
    `  ${r.k.padEnd(w)}  ${r.was}  →  ${r.now}`);
  if (rows.length > maxRows) lines.push(`  … and ${rows.length - maxRows} more`);
  return `${rows.length} field(s) differ from tests/fixtures/golden-${name}.json:\n`
       + lines.join('\n')
       + `\n\nIf this change is intentional, confirm each line above is correct, then`
       + `\nregold:  REGOLD=1 node --test tests/unit/golden-scenarios.test.mjs`;
}
