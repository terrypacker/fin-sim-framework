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
 * scenario-probe — load a saved scenario export, run it with param overrides,
 * and report SOLVENCY alongside the terminal (design/80 P1).
 *
 * The harvest lab (`harvest-lab.mjs`) drives a synthetic params bag through the
 * optimizer's isolated-registry path. This is the other end: a REAL exported
 * scenario (persons, accounts, properties, events, 200+ params) run through the
 * real `ScenarioLoader`, which is what the user actually saves and re-runs — and
 * therefore what a harvest has to leave in a working state.
 *
 * It exists because design/80 §9 flags the attribution of the die-with-zero
 * insolvency to the drawdown levers as INFERRED. Flipping one param at a time on
 * the real failing scenario is what turns that into a measurement.
 */

import { readFileSync } from 'node:fs';

import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario }    from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';

/** Load the `{ scenarios: [...] }` export shape; returns the first (or named) cfg. */
export function loadScenario(file, name = null) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const list = doc.scenarios ?? (Array.isArray(doc) ? doc : [doc]);
  const cfg = name ? list.find(s => s.name === name || s.id === name) : list[0];
  if (!cfg) throw new Error(`no scenario ${name ?? '[first]'} in ${file}`);
  return cfg;
}

/**
 * Deep-clone a cfg via JSON round-trip.
 *
 * NOT `structuredClone`: `ScenarioLoader.load` stamps a live scenario CLASS onto
 * the cfg it loads, so a cfg that has been run once is no longer structured-
 * cloneable. The source here is a JSON export by construction, so the round-trip
 * is lossless — and it strips exactly the loader's leavings.
 */
export const cloneCfg = cfg => JSON.parse(JSON.stringify(cfg));

/** Deep-clone a cfg and apply `{ paramName: value }` overrides to its params list. */
export function withParams(cfg, overrides = {}) {
  const next = cloneCfg(cfg);
  const missing = [];
  for (const [name, value] of Object.entries(overrides)) {
    const p = (next.params ?? []).find(pp => (pp.key ?? pp.name) === name);
    // A miss here is the two-param-stores trap in probe form: a silent no-op that
    // reads as "the lever did nothing". Report it rather than swallowing it.
    if (!p) { missing.push(name); continue; }
    p.value = value;
  }
  if (missing.length) throw new Error(`param(s) not in scenario: ${missing.join(', ')}`);
  return next;
}

/** Read `{ paramName: value }` out of a cfg's params list. */
export function readParams(cfg, names) {
  const out = {};
  for (const n of names) out[n] = (cfg.params ?? []).find(p => (p.key ?? p.name) === n)?.value;
  return out;
}

function silence() {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  return () => { console.log = log; console.warn = warn; };
}

/**
 * Run one cfg to simEnd and return the solvency-first summary.
 *
 * `telemetry:'off'` — none of these fields read the journal, and it is ~12x on a
 * 44-year run (design 78 §4.4), which is what makes a one-param-at-a-time sweep
 * practical at all.
 */
export function runCfg(cfgIn, { to = null, verbose = false, telemetry = 'off' } = {}) {
  // Load against a private copy: the loader mutates the cfg it is handed, so a
  // caller re-using one cfg across arms would carry state between runs.
  const cfg = cloneCfg(cfgIn);
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:      services.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  scenario.buildSim({ telemetry });
  new ScenarioLoader().load(cfg, services);

  const restore = verbose ? null : silence();
  try {
    scenario.sim.stepTo(to ? new Date(to) : new Date(cfg.simEnd));
  } finally {
    restore?.();
  }

  const s = scenario.sim.state;
  return {
    solvent:           !(s.scenarioFailed ?? false),
    outOfFundsDate:    s.outOfFundsDate ? new Date(s.outOfFundsDate).toISOString().slice(0, 10) : null,
    cumulativeDeficit: s.cumulativeDeficit ?? 0,
    deficitMonths:     s.deficitMonths ?? 0,
    netWorth:          s.metrics?.netWorth ?? null,
    netLiquidity:      s.metrics?.netLiquidity ?? null,
    state:             s,
  };
}

export const fmtUsd = n => (Number.isFinite(n) ? '$' + Math.round(n).toLocaleString() : '—');

/** One line per arm: solvency verdict first, terminal second. */
export function reportArm(label, r, { width = 34 } = {}) {
  const verdict = r.solvent
    ? '✅ SOLVENT'
    : `❌ RUIN ${r.outOfFundsDate} (${r.deficitMonths}mo, ${fmtUsd(r.cumulativeDeficit)})`;
  console.log(`  ${label.padEnd(width)} ${verdict.padEnd(46)} NW ${fmtUsd(r.netWorth)}`);
}
