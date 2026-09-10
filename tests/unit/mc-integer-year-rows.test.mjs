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
 * mc-integer-year-rows.test.mjs — design 98 W0b (F10).
 *
 * MC samples year axes from a continuous distribution, and every consumer turns the
 * year into a date with `Date.UTC(year, …)`, which TRUNCATES. Unrounded, a symmetric
 * draw around 2031 lands on years averaging ~2030.5 — the axis runs half a year early.
 * A row carrying `integer: true` has its sample rounded in `perturbParams`, so
 * `r.params` records the year the sim actually ran.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { perturbParams }          from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
import { IntlRetirementMcConfig } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { DISTRIBUTION_TYPES }     from '../../src/simulation-framework/distributions.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

const YEAR_ROWS = ['stateMoveYear', 'usHouseSaleYear', 'auHouseSaleYear'];

function yearRow(params, paramKey, override) {
  const config = new IntlRetirementMcConfig();
  if (override) config.applyOverride(paramKey, override);
  return config.buildVariables(params).find(v => v.paramKey === paramKey);
}

/** The calendar year a consumer actually runs for a sampled value. */
const effectiveYear = (v) => new Date(Date.UTC(v, 0, 1)).getUTCFullYear();

test('W0b-1: the state-move and house-sale-year rows declare integer: true', () => {
  const params = { stateMoveYear: 2031, usHouseSaleYear: 2035, auHouseSaleYear: 2040 };
  for (const key of YEAR_ROWS) {
    const row = yearRow(params, key);
    assert.ok(row, `${key} row should be emitted`);
    assert.equal(row.integer, true, `${key} must carry integer: true`);
    assert.equal(row.enabled, false, `${key} ships disabled — no default run moves`);
  }
});

test('W0b-2: an integer row samples integers, centred on its mean (not half a year early)', () => {
  const base = { stateMoveYear: 2031 };
  const row  = yearRow(base, 'stateMoveYear', { enabled: true });
  assert.equal(row.integer, true, 'the flag survives a panel override');

  const N = 2000;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const v = perturbParams(base, i, [row]).stateMoveYear;
    assert.ok(Number.isInteger(v), `iteration ${i} sampled a non-integer year ${v}`);
    sum += effectiveYear(v);
  }
  const mean = sum / N;
  // Unrounded (pre-W0b) this averaged ~2030.5: Date.UTC truncates every draw.
  assert.ok(Math.abs(mean - 2031) < 0.1, `effective year mean ${mean.toFixed(3)} should be within 0.1 of 2031`);
});

test('W0b-3: a row without integer: true is written unrounded', () => {
  const base = { inflationRate: 0.03 };
  const row  = { paramKey: 'inflationRate', type: DISTRIBUTION_TYPES.NORMAL, mean: 0.03, stdDev: 0.01, enabled: true };
  const v = perturbParams(base, 0, [row]).inflationRate;
  assert.ok(!Number.isInteger(v) && v !== 0.03, `rate row must keep its continuous sample, got ${v}`);
});

test('W0b-4: a sampled 2031.9 moves state residency on 1 Jan 2032, not 2031', () => {
  const base = { residencyState: '', stateMoveYear: 2031, stateMoveDestination: 'NE' };
  const row  = yearRow(base, 'stateMoveYear',
    { enabled: true, type: DISTRIBUTION_TYPES.CONSTANT, value: 2031.9 });
  const params = perturbParams(base, 0, [row]);
  assert.equal(params.stateMoveYear, 2032, 'r.params records the year the sim runs');

  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = IntlRetirementScenario.buildDefaultConfig(params, undefined, undefined);
  const scenario = new BaseScenario({
    context: services.simulationContext, initialState: cfg.initialState ?? {},
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  const sim = scenario.sim;

  sim.stepTo(new Date(Date.UTC(2031, 5, 30)));
  assert.equal(sim.state.people.primary.residencyState ?? null, null, 'still no state through 2031');
  sim.stepTo(new Date(Date.UTC(2032, 0, 2)));
  assert.equal(sim.state.people.primary.residencyState, 'NE', 'moves on 1 Jan 2032');
});
