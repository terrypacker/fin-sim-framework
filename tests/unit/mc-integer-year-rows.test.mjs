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
 * mc-integer-year-rows.test.mjs — design 98 W0b (F10); the year rows it was written for
 * are dates since design 117.
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
import { resolveRecordCenters }   from '../../src/scenarios/scenario-param-apply.js';

// Every year row this file was written for became a DATE in design 117: the house sales
// (phase 2) and the two moves (phase 4). The integer rounding is still the mechanism for
// any year row (W0b-2/3, on a synthetic row); W0b-1/4 pin what the moves are now.
const YEAR_ROW = { paramKey: 'someYear', type: DISTRIBUTION_TYPES.NORMAL, mean: 2031, stdDev: 1.5,
  integer: true, enabled: true };

function moveRow(params, paramKey, override, opts) {
  const config = new IntlRetirementMcConfig();
  if (override) config.applyOverride(paramKey, override);
  return config.buildVariables(params, opts).find(v => v.paramKey === paramKey);
}

/** The calendar year a consumer actually runs for a sampled value. */
const effectiveYear = (v) => new Date(Date.UTC(v, 0, 1)).getUTCFullYear();

test('W0b-1: the two moves are date rows pinned to their day, emitted only when set', () => {
  const params = { stateMoveDate: '2031-01-01', moveDate: '2030-07-01' };
  for (const [key, anchor] of [['stateMoveDate', '01-01'], ['moveDate', '07-01']]) {
    const row = moveRow(params, key);
    assert.ok(row, `${key} row should be emitted`);
    assert.deepEqual([row.type, row.anchor, row.integer], [DISTRIBUTION_TYPES.UNIFORM_DATE, anchor, undefined]);
    assert.equal(row.enabled, false, `${key} ships disabled — no default run moves`);
  }
  assert.equal(moveRow({}, 'stateMoveDate'), undefined, 'an unset move has no row');
});

test('W0b-1b: a house sale is a DATE row now, with no integer rounding to fight', () => {
  // Harvested per property, so it needs the cfg whose records carry the dates.
  const cfg = IntlRetirementScenario.buildDefaultConfig({
    'prop.usHouseProperty.plannedSaleDate': '2035-01-15', 'prop.auHouseProperty.plannedSaleDate': '2040-01-15' });
  const params = resolveRecordCenters(cfg);
  for (const [key, day] of [['prop.usHouseProperty.plannedSaleDate', '2035-01-15'],
                            ['prop.auHouseProperty.plannedSaleDate', '2040-01-15']]) {
    const row = moveRow(params, key, null, { cfg });
    assert.ok(row, `${key} row should be emitted`);
    assert.equal(row.type, DISTRIBUTION_TYPES.UNIFORM_DATE);
    assert.equal(row.integer, undefined, 'a date is never rounded as a number');
    assert.equal(row.enabled, false);
    const [lo, hi] = [Number(day.slice(0, 4)) - 2, Number(day.slice(0, 4)) + 2];
    assert.deepStrictEqual([row.min, row.max], [`${lo}${day.slice(4)}`, `${hi}${day.slice(4)}`]);
  }
});

test('W0b-2: an integer row samples integers, centred on its mean (not half a year early)', () => {
  const N = 2000;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const v = perturbParams({}, i, [YEAR_ROW]).someYear;
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

test('W0b-4: a sampled state move lands on its 1 Jan and moves residency that day', () => {
  const base = { residencyState: '', stateMoveDate: '2031-01-01', stateMoveDestination: 'NE' };
  const row  = moveRow(base, 'stateMoveDate',
    { enabled: true, type: DISTRIBUTION_TYPES.NORMAL_DATE, mean: '2031-12-20', stdDev: 0 });
  const params = perturbParams(base, 0, [row]);
  assert.equal(params.stateMoveDate, '2032-01-01', 'the draw snaps to the nearest 1 Jan, which r.params records');

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
