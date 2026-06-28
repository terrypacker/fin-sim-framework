/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe }          from 'node:test';
import assert                      from 'node:assert/strict';
import { CockpitController, COCKPIT_CONTROLS } from '../../src/finance/mpc/cockpit-controller.js';
import { makeInitialSnapshot }     from '../../src/finance/mpc/mpc-controller.js';
import { OPTIMIZATION_OBJECTIVES, OPT_PARAM_TYPES } from '../../src/finance/optimization/optimization-objectives.js';
import { Graph }                   from '../../src/graph/graph.js';
import { EDGE_TYPES }              from '../../src/graph/edge.js';
import { ExplicitBandsSpendingReducer } from '../../src/finance/spending/strategies/explicit-bands-spending-reducer.js';

/*
 * Design 39 Step 5 — cockpit headless brain (CockpitController). Drives the three
 * cockpit verbs (advise / apply / advance) over the real snapshot-seeded problem.
 */

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2033, 0, 1));
const NOW       = new Date(Date.UTC(2029, 0, 1));
const BASE = {
  spendingStrategy:     ['EXPLICIT_BANDS'],
  spendingExpenseBands: [{ startAge: 48, monthlyAmount: 5000 }],
};

function makeController(graph, parentId) {
  const snapshot = makeInitialSnapshot({ simStart: SIM_START, simEnd: SIM_END, asOfDate: NOW, baseParams: BASE });
  const c = new CockpitController({
    simStart: SIM_START, simEnd: SIM_END, baseParams: BASE,
    objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
    control: COCKPIT_CONTROLS.SPENDING, graph, parentId,
  });
  c.setSnapshot(snapshot);
  return c;
}

describe('COCKPIT_CONTROLS.ROTH — next actionable conversion year (design 42)', () => {
  const bp = { rothConversionMonth: 12, rothConversionDay: 1 };   // Dec 1 conversions

  test('at Dec 31 (this year already fired) the lever targets NEXT year', () => {
    const asOf = new Date(Date.UTC(2027, 11, 31));
    const committed = COCKPIT_CONTROLS.ROTH.prepareBaseParams({ baseParams: bp, asOf });
    assert.ok(committed.rothConversionSchedule.some(e => e.year === 2028), 'schedule entry for 2028');
    assert.ok(!committed.rothConversionSchedule.some(e => e.year === 2027), 'not the already-fired 2027');
    const vars = COCKPIT_CONTROLS.ROTH.buildVariables({ baseParams: committed, asOf });
    assert.equal(vars[0]._year, 2028, 'variable targets 2028');
  });

  test('early in the year (before the conversion date) targets THIS year', () => {
    const asOf = new Date(Date.UTC(2027, 0, 15));   // Jan 15 — Dec 1 still ahead
    const vars = COCKPIT_CONTROLS.ROTH.buildVariables({
      baseParams: COCKPIT_CONTROLS.ROTH.prepareBaseParams({ baseParams: bp, asOf }), asOf });
    assert.equal(vars[0]._year, 2027);
  });

  test('skips to the window start when standing before it (2026 → window 2028)', () => {
    const asOf = new Date(Date.UTC(2026, 0, 1));
    const windowed = { ...bp, rothConversionStartYear: 2028, rothConversionEndYear: 2035 };
    const committed = COCKPIT_CONTROLS.ROTH.prepareBaseParams({ baseParams: windowed, asOf });
    const vars = COCKPIT_CONTROLS.ROTH.buildVariables({ baseParams: committed, asOf });
    assert.equal(vars[0]._year, 2028, 'targets the first window year, not the inert 2026');
  });
});

describe('CockpitController — windowed horizon (design 41)', () => {
  test('setHorizonYears flows into the problem _scoreEnd (clamped to simEnd, gated by objective)', () => {
    const c = makeController();   // NOW=2029, simEnd=2033, objective MAX_NET_WORTH (windowable)
    c.setHorizonYears(2);
    assert.equal(+c._problem([])._scoreEnd(), +new Date(Date.UTC(2031, 0, 1)), 'now + H');
    c.setHorizonYears(10);
    assert.equal(+c._problem([])._scoreEnd(), +SIM_END, 'clamped to simEnd');
    c.setHorizonYears(null);
    assert.equal(+c._problem([])._scoreEnd(), +SIM_END, 'full horizon when unset');
    // A non-windowable goal ignores the window entirely.
    c.setHorizonYears(2);
    c.setObjective(OPTIMIZATION_OBJECTIVES.MIN_LIFETIME_TAXES);
    assert.equal(+c._problem([])._scoreEnd(), +SIM_END, 'non-windowable goal forced to full horizon');
  });

  test('setHorizonYears normalizes non-positive to null (full horizon)', () => {
    const c = makeController();
    c.setHorizonYears(0);
    assert.equal(c.horizonYears, null);
    c.setHorizonYears(-3);
    assert.equal(c.horizonYears, null);
  });
});

describe('CockpitController — advise', () => {
  test('returns a recommended move + a fan of per-step trajectories', async () => {
    const c = makeController();
    const advice = await c.advise({ solverKey: 'GRID', fanSize: 4, seriesPoints: 8 });

    assert.ok(advice.recommended.candidate['spendingExpenseBands[0].monthlyAmount'] != null,
      'recommends a band amount');
    assert.match(advice.recommended.label, /monthly spend/i, 'human-legible move label');
    assert.ok(Number.isFinite(advice.recommended.result.finalNetWorthUsd), 'recommended terminal is finite');

    assert.ok(advice.fan.length >= 1 && advice.fan.length <= 4, 'fan respects fanSize');
    assert.ok(advice.fan.some(f => f.recommended), 'one fan line is the recommended path');
    for (const line of advice.fan) {
      assert.equal(line.dates.length, 8, 'each fan line has seriesPoints samples');
      assert.equal(line.netWorth.length, 8);
      assert.ok(line.netWorth.every(Number.isFinite), 'finite net-worth series');
      assert.equal(+line.dates[0], +NOW, 'fan lines start at "now"');
    }
  });

  test('controlRange widens the search space the lever explores', async () => {
    const c = makeController();
    c.setControlRange({ min: 4000, max: 20000, step: 8000 });   // grid: 4000,12000,20000
    const advice = await c.advise({ solverKey: 'GRID' });
    const amounts = advice.candidates.map(x => x.candidate['spendingExpenseBands[0].monthlyAmount']);
    assert.ok(amounts.includes(20000), 'range max (20000) is searched');
    assert.ok(Math.max(...amounts) > 12000, 'search exceeds the old hardcoded 12000 cap');
  });

  test('MAX_NET_WORTH recommends the lowest spend (least drawdown) among the grid', async () => {
    const c = makeController();
    const advice = await c.advise({ solverKey: 'GRID' });
    // Lower spending ⇒ more assets retained ⇒ higher terminal net worth.
    const amount = advice.recommended.candidate['spendingExpenseBands[0].monthlyAmount'];
    const amounts = advice.candidates.map(x => x.candidate['spendingExpenseBands[0].monthlyAmount']);
    assert.equal(amount, Math.min(...amounts), 'recommended is the min-spend candidate for MAX_NET_WORTH');
  });
});

describe('CockpitController — apply + advance', () => {
  test('apply commits the chosen control forward and records a DERIVES_FROM decision record', () => {
    const graph = new Graph();
    graph.addNode({ id: 'p:base', layer: 'scenario', name: 'Base' });
    const c = makeController(graph, 'p:base');

    const candidate = { 'spendingExpenseBands[0].monthlyAmount': 8000 };
    const { result, committedParams, recordId } = c.apply(candidate);

    assert.ok(Number.isFinite(result.finalNetWorthUsd), 'apply returns a finite terminal');
    assert.equal(committedParams.spendingExpenseBands[0].monthlyAmount, 8000, 'control committed forward (nested path)');
    assert.ok(recordId, 'a decision-record id is returned');

    // Step 5c: the record lands in the 'decision' layer, never 'scenario'.
    assert.equal(graph.getNode(recordId).layer, 'decision');
    assert.equal(graph.byLayer('scenario').some(n => n.id === recordId), false);

    const edges = graph.getOutgoing(recordId, EDGE_TYPES.DERIVES_FROM);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].to, 'p:base', 'decision record points back to its parent');

    // The record carries the goal's primary metric (design/40) so the save-points
    // log can show the goal-anchored value, not just net worth.
    assert.deepEqual(graph.getNode(recordId).goalMetric,
      { key: 'finalNetWorthUsd', label: 'Net Worth' });
  });

  test('apply records the goal metric for a non-net-worth objective', () => {
    const graph = new Graph();
    graph.addNode({ id: 'p:base', layer: 'scenario', name: 'Base' });
    const c = makeController(graph, 'p:base');
    c.setObjective(OPTIMIZATION_OBJECTIVES.MAX_NET_LIQUIDITY);
    const { recordId } = c.apply({ 'spendingExpenseBands[0].monthlyAmount': 8000 });
    assert.deepEqual(graph.getNode(recordId).goalMetric,
      { key: 'finalNetLiquidity', label: 'Net Liquidity' });
  });

  test('SPENDING.buildVariables targets the band active at "now", not the last band', () => {
    const baseParams = { spendingExpenseBands: [{ startAge: 48, monthlyAmount: 5000 }, { startAge: 65, monthlyAmount: 6000 }, { startAge: 85, monthlyAmount: 7000 }] };
    const state = { people: { p1: { birthDate: new Date(Date.UTC(1978, 0, 1)) } } };
    const at = (y) => COCKPIT_CONTROLS.SPENDING.buildVariables({ baseParams, asOf: new Date(Date.UTC(y, 5, 1)), state })[0]._bandIndex;
    assert.equal(at(2030), 0, 'age 52 → first band (48)');
    assert.equal(at(2055), 1, 'age 77 → middle band (65)');
    assert.equal(at(2070), 2, 'age 92 → last band (85)');
    assert.equal(at(2020), 0, 'below the first band → first/upcoming band');
  });

  test('control appliesTo gates the lever to the right scenario shape', () => {
    assert.equal(COCKPIT_CONTROLS.SPENDING.appliesTo({ spendingStrategy: ['EXPLICIT_BANDS'] }), true);
    assert.equal(COCKPIT_CONTROLS.SPENDING.appliesTo({ spendingStrategy: ['AGE_BANDED'] }), false);
    assert.equal(COCKPIT_CONTROLS.SPENDING.appliesTo({ spendingStrategy: 'EXPLICIT_BANDS' }), true);
    assert.equal(COCKPIT_CONTROLS.ROTH.appliesTo({ rothConversionEnabled: true }), true);
    assert.equal(COCKPIT_CONTROLS.ROTH.appliesTo({ rothConversionEnabled: false }), false);
  });

  test('SPENDING.actuate re-wires the live reducer forward + persists the param (Phase B)', () => {
    const reducer = new ExplicitBandsSpendingReducer({ bands: [{ startAge: 48, monthlyAmount: 5000 }] });
    let updated = null;
    const reducerService = {
      getAll: () => [reducer],
      updateReducer: (r, changes) => { updated = { r, changes }; Object.assign(r, changes); },
    };
    const scenario = { params: [{ key: 'spendingExpenseBands', value: [{ startAge: 48, monthlyAmount: 5000 }] }] };
    const vars = [{ paramKey: 'spendingExpenseBands[0].monthlyAmount', _bandIndex: 0 }];

    const ok = COCKPIT_CONTROLS.SPENDING.actuate({
      services: { reducerService }, scenario,
      candidate: { 'spendingExpenseBands[0].monthlyAmount': 9000 }, vars,
    });

    assert.equal(ok, true, 'actuation hit the live plan');
    assert.equal(updated.changes.bands[0].monthlyAmount, 9000, 'live reducer re-wired to the new amount');
    assert.equal(scenario.params[0].value[0].monthlyAmount, 9000, 'scenario param persisted for consistency');
  });

  test('SPENDING.actuate returns false (graceful) when no live EXPLICIT_BANDS reducer', () => {
    const ok = COCKPIT_CONTROLS.SPENDING.actuate({
      services: { reducerService: { getAll: () => [] } }, scenario: null,
      candidate: { 'spendingExpenseBands[0].monthlyAmount': 9000 },
      vars: [{ paramKey: 'spendingExpenseBands[0].monthlyAmount', _bandIndex: 0 }],
    });
    assert.equal(ok, false);
  });

  test('ROTH is live-actuatable (Step 10)', () => {
    assert.equal(COCKPIT_CONTROLS.ROTH.liveActuatable, true);
    assert.equal(typeof COCKPIT_CONTROLS.ROTH.actuate, 'function');
  });

  test('ROTH.actuate re-wires the future conversion event forward + persists the param', () => {
    const year = 2030;
    const vars = [{ paramKey: 'rothConversionSchedule[0].incomeTarget', _year: year }];
    const candidate = { 'rothConversionSchedule[0].incomeTarget': 100_000 };  // real base-year USD
    const scenario = { params: [
      { key: 'rothConversionSchedule', value: [] },
      { key: 'inflationRate',          value: 0.03 },
    ] };

    const futureEvt = { type: 'ROTH_CONVERSION_POLICY_EVALUATE', date: new Date(Date.UTC(2030, 11, 1)), data: { targetIncome: 50_000 } };
    const otherYear = { type: 'ROTH_CONVERSION_POLICY_EVALUATE', date: new Date(Date.UTC(2031, 11, 1)), data: { targetIncome: 50_000 } };
    const pastEvt   = { type: 'ROTH_CONVERSION_POLICY_EVALUATE', date: new Date(Date.UTC(2030,  0, 1)), data: { targetIncome: 50_000 } };
    const sim = { currentDate: new Date(Date.UTC(2030, 5, 1)), queue: { data: [futureEvt, otherYear, pastEvt] } };
    const services = { simulationRegistry: { getPrimary: () => sim } };

    const ok = COCKPIT_CONTROLS.ROTH.actuate({ services, scenario, candidate, vars });

    assert.equal(ok, true, 'actuation hit a live conversion event');
    const expectedNominal = 100_000 * Math.pow(1.03, year - 2025);
    assert.ok(Math.abs(futureEvt.data.targetIncome - expectedNominal) < 1e-6, 'future event re-wired to the nominal target');
    assert.equal(otherYear.data.targetIncome, 50_000, 'a different year is left untouched');
    assert.equal(pastEvt.data.targetIncome,   50_000, 'a same-year event already in the past (≤ now) is untouched (forward-effective)');

    const entry = scenario.params[0].value.find(e => e.year === year);
    assert.ok(entry && entry.incomeTarget === 100_000, 'real target persisted to the scenario schedule param');
  });

  test('ROTH.actuate returns false (graceful) when there is no live conversion event to re-wire', () => {
    const vars = [{ paramKey: 'rothConversionSchedule[0].incomeTarget', _year: 2030 }];
    const candidate = { 'rothConversionSchedule[0].incomeTarget': 100_000 };
    const scenario = { params: [{ key: 'rothConversionSchedule', value: [] }] };

    const ok = COCKPIT_CONTROLS.ROTH.actuate({
      services: { simulationRegistry: { getPrimary: () => null } }, scenario, candidate, vars,
    });
    assert.equal(ok, false);
    // The decision is still persisted (not lost) for a later Rebuild / recompiled Advise.
    assert.equal(scenario.params[0].value[0].incomeTarget, 100_000, 'param persisted even without a live event');
  });

  test('advance moves "now" forward and keeps the realized past', () => {
    const c = makeController();
    const before = new Date(c.snapshot.date);
    const NEXT = new Date(Date.UTC(2031, 0, 1));
    const snap = c.advance(NEXT);
    assert.equal(+snap.date, +NEXT, 'now advanced to the next epoch');
    assert.ok(snap.date > before, 'time moved forward');
    assert.ok(snap.state && Array.isArray(snap.queue), 'a valid forward snapshot was produced');
    assert.equal(c.lastAdvice, null, 'advice is cleared after advancing');
  });
});

describe('COCKPIT_CONTROLS.ROTH — continuous income-target lever (Step 9)', () => {
  const ROTH = COCKPIT_CONTROLS.ROTH;
  const asOf = new Date(Date.UTC(2030, 5, 1));   // 2030

  test('is a numeric lever with a real-USD income-target default range (0 = OFF)', () => {
    assert.equal(ROTH.numeric, true);
    assert.equal(ROTH.defaultRange.min, 0, 'min 0 = OFF (no conversion)');
    assert.ok(ROTH.defaultRange.max > 0, 'a positive cap');
  });

  test('prepareBaseParams appends a now-year entry, preserves prior years, stays chronological', () => {
    const out = ROTH.prepareBaseParams({
      baseParams: { rothConversionSchedule: [{ year: 2028, incomeTarget: 50000 }] }, asOf,
    });
    assert.deepEqual(out.rothConversionSchedule.map(e => e.year), [2028, 2030]);
    assert.equal(out.rothConversionSchedule.find(e => e.year === 2030).incomeTarget, 0, 'new entry defaults OFF');
    assert.equal(out.rothConversionSchedule.find(e => e.year === 2028).incomeTarget, 50000, 'prior year preserved');
  });

  test('prepareBaseParams is idempotent — no duplicate entry for the same year', () => {
    const once  = ROTH.prepareBaseParams({ baseParams: {}, asOf });
    const twice = ROTH.prepareBaseParams({ baseParams: once, asOf });
    assert.equal(twice.rothConversionSchedule.filter(e => e.year === 2030).length, 1);
  });

  test('buildVariables targets the now-year entry index with a CONTINUOUS variable', () => {
    const baseParams = ROTH.prepareBaseParams({
      baseParams: { rothConversionSchedule: [{ year: 2029, incomeTarget: 0 }] }, asOf,
    });
    const vars = ROTH.buildVariables({ baseParams, asOf, range: ROTH.defaultRange });
    assert.equal(vars.length, 1);
    assert.equal(vars[0].paramKey, 'rothConversionSchedule[1].incomeTarget', 'the 2030 entry sits after 2029');
    assert.equal(vars[0].type, OPT_PARAM_TYPES.CONTINUOUS);
    assert.equal(vars[0].min, 0);
    assert.equal(vars[0]._year, 2030);
  });

  test('describe: OFF reads as no conversion; a positive target shows dollars + derived bracket', () => {
    const vars = [{ paramKey: 'rothConversionSchedule[0].incomeTarget' }];
    assert.match(ROTH.describe({ 'rothConversionSchedule[0].incomeTarget': 0 }, vars), /No Roth conversion/i);
    const label = ROTH.describe({ 'rothConversionSchedule[0].incomeTarget': 120000 }, vars);
    assert.match(label, /\$120,000/, 'shows the real income target');
    assert.match(label, /%\s*bracket/, 'shows the derived marginal bracket');
  });
});

describe('CockpitController — ROTH control wiring (Step 9)', () => {
  function makeRothController() {
    const base = { rothConversionEnabled: true };
    const snapshot = makeInitialSnapshot({ simStart: SIM_START, simEnd: SIM_END, asOfDate: NOW, baseParams: base });
    const c = new CockpitController({
      simStart: SIM_START, simEnd: SIM_END, baseParams: base,
      objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH,
      control: COCKPIT_CONTROLS.ROTH,
    });
    c.setControlRange({ min: 0, max: 100000, step: 50000 });   // coarse grid → fast
    c.setSnapshot(snapshot);
    return c;
  }

  test('advise recommends an income target and apply commits it into the schedule at the now-year', async () => {
    const c = makeRothController();
    const advice = await c.advise({ solverKey: 'GRID' });

    const key = 'rothConversionSchedule[0].incomeTarget';   // NOW=2029 → first/only entry
    assert.ok(key in advice.recommended.candidate, 'recommends an income target for the now-year entry');
    assert.match(advice.recommended.label, /Roth conversion|Fill ordinary income/i, 'human-legible label');

    const chosen = advice.recommended.candidate[key];
    const { committedParams } = c.apply(advice.recommended.candidate);
    const entry = committedParams.rothConversionSchedule.find(e => e.year === NOW.getUTCFullYear());
    assert.ok(entry, 'schedule has an entry scaffolded for the now-year');
    assert.equal(entry.incomeTarget, chosen, 'applied income target committed at the now-year');
  });
});

describe('CockpitController — autoRun (autopilot)', () => {
  test('chains advise→apply→advance each year to simEnd and logs every epoch', async () => {
    const c = makeController();
    const log = await c.autoRun({ solverKey: 'GRID' });

    // NOW=2029 → SIM_END=2033, stepYears=1 ⇒ epochs at 2029,2030,2031,2032.
    assert.equal(log.length, 4, 'one epoch per year from "now" to simEnd');
    log.forEach((rec, i) => {
      assert.equal(rec.epoch, i, 'epochs are numbered in order');
      assert.ok(rec.candidate['spendingExpenseBands[0].monthlyAmount'] != null, 'each epoch accepted a move');
      assert.ok(Number.isFinite(rec.applied.result.finalNetWorthUsd), 'each epoch committed a finite projection');
    });
    assert.equal(+log[0].date, +NOW, 'first epoch is at "now"');
    assert.ok(new Date(c.snapshot.date) >= SIM_END, 'autopilot ran "now" to the end of the horizon');
  });

  test('onEpoch fires per epoch and shouldStop halts the loop early', async () => {
    const c = makeController();
    const seen = [];
    const log = await c.autoRun({
      solverKey: 'GRID',
      onEpoch: (rec) => { seen.push(+rec.date); },
      shouldStop: () => seen.length >= 2,   // stop after two committed epochs
    });
    assert.equal(seen.length, 2, 'onEpoch fired for each committed epoch');
    assert.equal(log.length, 2, 'shouldStop halted the loop early');
    assert.ok(new Date(c.snapshot.date) < SIM_END, 'stopped before reaching the horizon end');
  });

  test('autoRun throws without a snapshot', async () => {
    const c = new CockpitController({ simStart: SIM_START, simEnd: SIM_END, baseParams: BASE });
    await assert.rejects(() => c.autoRun(), /call setSnapshot/);
  });
});
