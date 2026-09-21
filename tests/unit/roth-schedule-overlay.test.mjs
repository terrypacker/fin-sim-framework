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
 * roth-schedule-overlay.test.mjs
 *
 * DESIGN 39 §14.10 — the ROTH persistence half. An MPC session decides one conversion year at a
 * time. On a window-form plan (start/end/maxBracket, empty schedule) it used to save only the
 * decided rows, and the toolset reads a non-empty schedule as the WHOLE plan, so a Rebuild or a
 * design 81 replay cancelled every year the session never decided. Measured on the author's
 * plan at several percent of terminal wealth (§14.9.10). `rothConversionScheduleMode: OVERLAY`
 * keeps those years on the window.
 *
 * ROV-1  OVERLAY with nothing to override compiles the window's own events, in its own order
 * ROV-2  OVERLAY: a row overrides its year, 0 skips it, a row outside the window adds a year
 * ROV-3  REPLACE (the default) is unchanged: the schedule is the whole plan
 * ROV-4  actuate on a window plan switches to OVERLAY and saves a skip as an explicit 0 row;
 *        an authored REPLACE schedule is left alone
 * ROV-5  the design 81 fold sets OVERLAY when the authored plan was window-form, and only then
 * ROV-6  the Rebuild: what actuate saved, compiled from t₀, is the live plan in EVERY year
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { US_ROTH_CONVERSION, BRACKET_BASE_YEAR } from '../../src/scenarios/toolsets/us-roth-conversion-toolset.js';
import { foldQueueLeverRuns }      from '../../src/finance/mpc/run-compile-fold.js';
import { yearKey }                 from '../../src/finance/mpc/lever-schedule.js';
import { COCKPIT_CONTROLS }        from '../../src/finance/mpc/cockpit-controller.js';
import { OptimizationProblem }     from '../../src/finance/optimization/optimization-problem.js';
import { OPTIMIZATION_OBJECTIVES } from '../../src/finance/optimization/optimization-objectives.js';
import { ServiceRegistry }         from '../../src/services/service-registry.js';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }          from '../../src/scenarios/scenario-loader.js';
import { ScenarioSerializer }      from '../../src/scenarios/scenario-serializer.js';
import { applyParamBagToConfig }   from '../../src/scenarios/scenario-param-apply.js';

const ROTH = COCKPIT_CONTROLS.ROTH;
const TYPE = 'ROTH_CONVERSION_POLICY_EVALUATE';

// ─── the toolset, at its seam ─────────────────────────────────────────────────

const WINDOW = { rothConversionEnabled: true, rothConversionStartYear: 2031,
                 rothConversionEndYear: 2034, rothConversionMaxBracket: 0.22 };

/** One owner, so every event is one year. */
function eventsFor(params) {
  const context = {
    parameters: params,
    startDate: new Date(Date.UTC(2030, 0, 1)),
    people:   [{ id: 'primary', name: 'P', birthDate: '1978-04-15' }],
    accounts: [{ role: 'ira', ownerId: 'primary', stateKey: 'iraAccount' },
               { role: 'roth-ira', ownerId: 'primary', stateKey: 'rothAccount' }],
  };
  return US_ROTH_CONVERSION.schedules(context)
    .filter(e => e.type === TYPE)
    .map(e => [new Date(e.date).getUTCFullYear(), e.data.targetIncome]);
}

const windowTarget = (year) => eventsFor(WINDOW).find(([y]) => y === year)[1];

test('ROV-1: OVERLAY with nothing to override compiles the window itself', () => {
  assert.deepEqual(eventsFor({ ...WINDOW, rothConversionScheduleMode: 'OVERLAY' }), eventsFor(WINDOW));
  assert.deepEqual(eventsFor(WINDOW).map(([y]) => y), [2031, 2032, 2033, 2034]);
});

test('ROV-2: OVERLAY — a row overrides its year, 0 skips it, a row outside the window adds one', () => {
  const ev = eventsFor({ ...WINDOW, rothConversionScheduleMode: 'OVERLAY', rothConversionSchedule: [
    { year: 2032, incomeTarget: 0 },
    { year: 2033, incomeTarget: 50_000 },
    { year: 2036, incomeTarget: 70_000 },
  ] });
  assert.deepEqual(ev.map(([y]) => y), [2031, 2032, 2033, 2034, 2036], 'window ∪ rows, in year order');
  assert.equal(ev[0][1], windowTarget(2031), 'an undecided year keeps the window fill');
  assert.equal(ev[1][1], 0, 'a 0 row is an event at 0: the handler converts nothing');
  assert.ok(Math.abs(ev[2][1] - 50_000 * Math.pow(1.03, 2033 - BRACKET_BASE_YEAR)) < 1e-6, 'the row\'s own target');
  assert.equal(ev[3][1], windowTarget(2034));
});

test('ROV-3: REPLACE, the default, reads the schedule as the whole plan (unchanged)', () => {
  const rows = [{ year: 2033, incomeTarget: 50_000 }];
  assert.deepEqual(eventsFor({ ...WINDOW, rothConversionSchedule: rows }).map(([y]) => y), [2033]);
  assert.deepEqual(eventsFor({ ...WINDOW, rothConversionScheduleMode: 'REPLACE',
    rothConversionSchedule: rows }).map(([y]) => y), [2033]);
});

// ─── the three writers ────────────────────────────────────────────────────────

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2060, 0, 1));
const BASE = {
  spendingStrategy:     ['EXPLICIT_BANDS'],
  spendingExpenseBands: [{ startAge: 45, monthlyAmount: 9000 }],
  rothConversionEnabled: true, rothConversionStartYear: 2046, rothConversionEndYear: 2055,
  rothConversionSchedule: [],
  // PINNED. The live sim is built from this bag directly and the compile from the resolved base;
  // left unset, the two disagree about the owner (the design 39 §14.9.7 trap: the toolset's
  // schema default against the template's), and the comparison is between two plans.
  rothConversionOwner: 'both',
};

const quiet = (fn) => {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
};

/** A live sim built the way the app builds the active scenario, params LIST included. */
function liveSim(params) {
  return quiet(() => {
    const registry = new ServiceRegistry();
    const scenario = new IntlRetirementScenario({
      context: registry.simulationContext, params, simStart: SIM_START, simEnd: SIM_END,
    });
    scenario.buildSim({ telemetry: 'off' });
    const cfg = ScenarioSerializer.serializeScenario(
      IntlRetirementScenario.buildDefaultConfig({}, SIM_START, SIM_END));
    cfg.params = [
      { name: 'rothConversionSchedule', value: params.rothConversionSchedule ?? [] },
      { name: 'inflationRate', value: 0.03 },
    ];
    applyParamBagToConfig(cfg, params);
    new ScenarioLoader().load(cfg, registry);
    return { sim: scenario.sim, services: registry, cfg };
  });
}

/** Decide `realTarget` for the next conversion year at the live sim's clock, and actuate it. */
function actuateAt(live, base, asOf, realTarget) {
  quiet(() => live.sim.stepTo(asOf));
  const prepared = ROTH.prepareBaseParams({ baseParams: base, asOf });
  const vars = ROTH.buildVariables({ baseParams: prepared, asOf, range: ROTH.defaultRange });
  quiet(() => ROTH.actuate({ services: live.services, scenario: live.cfg,
    candidate: { [vars[0].paramKey]: realTarget }, vars }));
  return vars[0]._year;
}

const saved = (cfg, name) => cfg.params.find(p => (p.key ?? p.name) === name)?.value;

test('ROV-4: actuate on a window plan switches to OVERLAY; a skip is an explicit 0 row', () => {
  const live = liveSim(BASE);
  const y1 = actuateAt(live, BASE, new Date(Date.UTC(2047, 0, 1)), 120_000);
  assert.equal(saved(live.cfg, 'rothConversionScheduleMode'), 'OVERLAY');
  assert.deepEqual(saved(live.cfg, 'rothConversionSchedule'), [{ year: y1, incomeTarget: 120_000 }]);

  const y2 = actuateAt(live, BASE, new Date(Date.UTC(2048, 0, 1)), 0);
  assert.deepEqual(saved(live.cfg, 'rothConversionSchedule'),
    [{ year: y1, incomeTarget: 120_000 }, { year: y2, incomeTarget: 0 }],
    'under OVERLAY absence means "the window", so a skip has to be written down');

  // An authored schedule under REPLACE is the author's plan: absent years are THEIR skips.
  const authored = { ...BASE, rothConversionSchedule: [{ year: 2050, incomeTarget: 90_000 }] };
  const live2 = liveSim(authored);
  actuateAt(live2, authored, new Date(Date.UTC(2047, 0, 1)), 0);
  assert.equal(saved(live2.cfg, 'rothConversionScheduleMode') ?? 'REPLACE', 'REPLACE');
  assert.deepEqual(saved(live2.cfg, 'rothConversionSchedule'), [{ year: 2050, incomeTarget: 90_000 }],
    'REPLACE keeps its old meaning: a skip removes nothing that is not there');
});

test('ROV-5: the design 81 fold sets OVERLAY when the authored plan was window-form, only then', () => {
  const run = { r: { decisions: [
    { date: new Date(Date.UTC(2047, 0, 1)).toISOString(), lever: 'ROTH', key: yearKey(2047), value: 120_000 },
  ] } };
  const onWindow = foldQueueLeverRuns({ ...BASE, mpcRuns: run, mpcActiveRun: 'r' });
  assert.equal(onWindow.rothConversionScheduleMode, 'OVERLAY');
  assert.deepEqual(onWindow.rothConversionSchedule, [{ year: 2047, incomeTarget: 120_000 }]);

  const onAuthored = foldQueueLeverRuns({ ...BASE, mpcRuns: run, mpcActiveRun: 'r',
    rothConversionSchedule: [{ year: 2050, incomeTarget: 90_000 }] });
  assert.equal(onAuthored.rothConversionScheduleMode, undefined, 'an authored schedule keeps REPLACE');
  assert.equal(BASE.rothConversionScheduleMode, undefined, 'the caller\'s bag is not mutated');
});

test('ROV-6: the Rebuild — what actuate saved, compiled from t₀, is the live plan in every year', () => {
  // The defect this closes, stated as the invariant: after a session, the scenario on disk and
  // the sim the user just watched describe the same conversions — past years included, which
  // a future-only fix would still have cancelled.
  const live = liveSim(BASE);
  actuateAt(live, BASE, new Date(Date.UTC(2047, 0, 1)), 120_000);
  actuateAt(live, BASE, new Date(Date.UTC(2048, 0, 1)), 0);

  const rebuilt = { ...BASE,
    rothConversionSchedule:     saved(live.cfg, 'rothConversionSchedule'),
    rothConversionScheduleMode: saved(live.cfg, 'rothConversionScheduleMode') };
  const all = (q) => q.filter(e => e.type === TYPE)
    .map(e => `${new Date(e.date).toISOString().slice(0, 10)} ${e.data.iraKey} ${e.data.targetIncome}`)
    .sort();
  const compiled = quiet(() => {
    const p = new OptimizationProblem({ variables: [], baseParams: rebuilt,
      objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH, simStart: SIM_START, simEnd: SIM_END,
      initialState: { kind: 'compile', cfgTemplate: null } });
    return p._seededSim({ ...p._resolveBase(), endDate: SIM_END }).cloneQueue();
  });
  const liveFuture = all(live.sim.cloneQueue());
  const now = new Date(live.sim.currentDate).toISOString().slice(0, 10);
  assert.deepEqual(all(compiled).filter(s => s.slice(0, 10) > now), liveFuture,
    'the rebuilt plan\'s future conversions are the live queue\'s, to the bit');
  const years = new Set(all(compiled).map(s => s.slice(0, 4)));
  for (let y = 2046; y <= 2055; y++) assert.ok(years.has(String(y)), `${y} lost on the Rebuild`);
});
