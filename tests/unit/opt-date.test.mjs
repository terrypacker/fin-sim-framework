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
 * Design 117 phase 1 — the optimizer's Date variable, NORMAL_DATE, and date anchors.
 *
 * A DATE is authored and reported as ISO days; every solver searches it as an integer
 * month count (a year count when anchored). These tests pin both halves: the codec, and
 * that no caller ever meets a month count — including the end-to-end rollout, where a
 * DATE candidate has to move the simulation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES, OPTIMIZATION_OBJECTIVES, isIntegralVariable }
  from '../../src/finance/optimization/optimization-objectives.js';
import { dateOrdinal, ordinalToIso, dateSolverView, paramCandidate, parseDateAnchor }
  from '../../src/finance/optimization/opt-date.js';
import { valuesForConfig } from '../../src/finance/optimization/opt-values.js';
import { GridSearchSolver } from '../../src/finance/optimization/solvers/grid-search-solver.js';
import { RandomSolver } from '../../src/finance/optimization/solvers/random-solver.js';
import { PatternSearchSolver } from '../../src/finance/optimization/solvers/pattern-search-solver.js';
import { SimulatedAnnealingSolver } from '../../src/finance/optimization/solvers/simulated-annealing-solver.js';
import { CemSolver } from '../../src/finance/optimization/solvers/cem-solver.js';
import { harvestSweepVariables, sweepKindOf } from '../../src/finance/param-schema-utils.js';
import { optRowFor } from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { mcRowFor, variablesMissingCenter } from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { createDistribution, DISTRIBUTION_TYPES } from '../../src/simulation-framework/distributions.js';
import { perturbParams } from '../../src/finance/monte-carlo/parallel/mc-worker-core.js';
import { nearestIndex } from '../../src/finance/monte-carlo/mc-grid.js';
import { makeSeededRng } from '../../src/finance/optimization/solvers/solver-support.js';

const SALE = { paramKey: 'saleDate', type: OPT_PARAM_TYPES.DATE, min: '2030-01-15', max: '2031-12-15', step: 1 };
const MOVE = { paramKey: 'moveDate', type: OPT_PARAM_TYPES.DATE, min: '2028-07-01', max: '2034-07-01', step: 1,
  anchor: '07-01' };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// ─── codec ──────────────────────────────────────────────────────────────────

describe('opt-date codec', () => {
  test('a month ordinal round-trips, keeping the day', () => {
    const n = dateOrdinal('2031-07-15');
    assert.equal(n, 2031 * 12 + 6);
    assert.equal(ordinalToIso(n, null, 15), '2031-07-15');
    assert.equal(ordinalToIso(n + 6, null, 15), '2032-01-15', 'crosses the year');
  });

  test('the day clamps to the month: 31 Jan + 1 month is the last day of February', () => {
    assert.equal(ordinalToIso(dateOrdinal('2031-01-31') + 1, null, 31), '2031-02-28');
    assert.equal(ordinalToIso(dateOrdinal('2032-01-31') + 1, null, 31), '2032-02-29');
  });

  test('an anchored ordinal is the year, and decodes to the anchor day', () => {
    assert.equal(dateOrdinal('2031-07-01', '07-01'), 2031);
    assert.equal(ordinalToIso(2033, '07-01'), '2033-07-01');
    assert.deepEqual(parseDateAnchor('07-01'), { month0: 6, day: 1 });
    assert.equal(parseDateAnchor('7-1'), null);
    assert.equal(parseDateAnchor('13-01'), null);
  });

  test('the solver view is integral, numeric and idempotent', () => {
    const v = dateSolverView(SALE);
    assert.equal(v.min, 2030 * 12);
    assert.equal(v.max, 2031 * 12 + 11);
    assert.equal(v._day, 15);
    assert.ok(isIntegralVariable(v));
    assert.strictEqual(dateSolverView(v), v);
    const m = dateSolverView(MOVE);
    assert.deepEqual([m.min, m.max, m.anchor], [2028, 2034, '07-01']);
  });

  test('paramCandidate converts DATE values only, and leaves an ISO value alone', () => {
    const vars = [SALE, { paramKey: 'x', type: OPT_PARAM_TYPES.INTEGER, min: 0, max: 9, step: 1 }];
    const c = { saleDate: 2030 * 12 + 4, x: 3 };
    assert.deepEqual(paramCandidate(vars, c), { saleDate: '2030-05-15', x: 3 });
    const iso = { saleDate: '2031-02-15', x: 3 };
    assert.strictEqual(paramCandidate(vars, iso), iso, 'nothing to change → same object');
  });

  test('valuesForConfig enumerates an authored DATE by its step', () => {
    assert.equal(valuesForConfig(SALE).length, 24);
    assert.equal(valuesForConfig({ ...SALE, step: 6 }).length, 4);
    assert.deepEqual(valuesForConfig(MOVE), [2028, 2029, 2030, 2031, 2032, 2033, 2034]);
  });
});

// ─── OptimizationProblem ─────────────────────────────────────────────────────

describe('OptimizationProblem with a DATE variable', () => {
  const problem = () => new OptimizationProblem({ variables: [SALE, MOVE] });

  test('encode takes ISO days (or ordinals); decode rounds and clamps in solver space', () => {
    const p = problem();
    assert.deepEqual(p.encode({ saleDate: '2030-03-15', moveDate: '2031-07-01' }), [2030 * 12 + 2, 2031]);
    assert.deepEqual(p.encode({ saleDate: 2030 * 12 + 2, moveDate: 2031 }), [2030 * 12 + 2, 2031]);
    assert.deepEqual(p.decode([2030 * 12 + 2.4, 2040]), { saleDate: 2030 * 12 + 2, moveDate: 2034 });
    assert.deepEqual(p.paramCandidate(p.decode([2029 * 12, 2031.6])),
      { saleDate: '2030-01-15', moveDate: '2032-07-01' });
  });

  test('randomCandidate stays in bounds; every anchored value is on its anchor day', () => {
    const p = problem();
    const rng = makeSeededRng(7);
    for (let i = 0; i < 50; i++) {
      const c = p.paramCandidate(p.randomCandidate(rng));
      assert.match(c.saleDate, ISO);
      assert.ok(c.saleDate >= '2030-01-15' && c.saleDate <= '2031-12-15', c.saleDate);
      assert.match(c.moveDate, /^20(2[89]|3[0-4])-07-01$/);
    }
  });

  test('_applyCandidate writes an ISO day into the params, never a month count', () => {
    const p = problem();
    const params = p._applyCandidate({}, { saleDate: 2031 * 12 + 1, moveDate: 2030 });
    assert.deepEqual(params, { saleDate: '2031-02-15', moveDate: '2030-07-01' });
  });

  test('candidateCount is the product of the DATE value counts', () => {
    assert.equal(problem().candidateCount(), 24 * 7);
  });
});

// ─── Solvers ─────────────────────────────────────────────────────────────────

/** An analytic problem: the score peaks at a target date. No simulation runs. */
class TargetDateProblem extends OptimizationProblem {
  constructor(variables, target) {
    super({ variables });
    this.target = Date.parse(target);
    this.seen = [];
  }
  evaluate(candidate) {
    const c = this.paramCandidate(candidate);
    this.seen.push(c.saleDate);
    const score = -Math.abs(Date.parse(c.saleDate) - this.target) / 86_400_000;
    return { result: { saleDate: c.saleDate }, score };
  }
}

describe('every solver searches a DATE and reports ISO days', () => {
  const VAR = { paramKey: 'saleDate', type: OPT_PARAM_TYPES.DATE, min: '2030-01-15', max: '2033-12-15', step: 1 };
  const TARGET = '2032-05-15';
  const solvers = [
    ['grid',      () => new GridSearchSolver()],
    ['random',    () => new RandomSolver({ budget: 200, seed: 3 })],
    ['pattern',   () => new PatternSearchSolver({ budget: 120, seed: 3 })],
    ['annealing', () => new SimulatedAnnealingSolver({ budget: 200, seed: 3 })],
    ['cem',       () => new CemSolver({ budget: 240, seed: 3 })],
  ];
  for (const [name, make] of solvers) {
    test(`${name}: finds the target, ISO days throughout, best is one of the candidates`, async () => {
      const p   = new TargetDateProblem([VAR], TARGET);
      const out = await make().solve(p);
      assert.equal(out.best.candidate.saleDate, TARGET, `${name} best ${out.best.candidate.saleDate}`);
      assert.ok(out.candidates.every(c => ISO.test(c.candidate.saleDate)));
      assert.ok(out.candidates.includes(out.best), 'best is compared by identity downstream');
      assert.ok(p.seen.every(d => ISO.test(d) && d.endsWith('-15')), 'every evaluated value is a 15th');
    });
  }

  test('a warm start given as an ISO day is accepted', async () => {
    const p = new TargetDateProblem([VAR], TARGET);
    const out = await new PatternSearchSolver({ budget: 60, seed: 1, start: { saleDate: '2032-01-15' } }).solve(p);
    assert.equal(out.best.candidate.saleDate, TARGET);
    assert.equal(p.seen[0], '2032-01-15', 'the search starts where it was told to');
  });
});

// ─── Harvest ─────────────────────────────────────────────────────────────────

describe('a Date schema entry harvests a DATE row (Opt) and a date row (MC)', () => {
  const schema = [
    { key: 'saleDate', type: 'Date', opt: true, mc: true, group: 'G' },
    { key: 'moveDate', type: 'Date', opt: true, mc: true, group: 'G', dateAnchor: '07-01' },
    { key: 'buyDate',  type: 'Date', opt: true, mc: true, group: 'G', sweepUnset: true },
    // A Date-typed key is a date whatever its name says.
    { key: 'oddYear',  type: 'Date', opt: true, mc: true, group: 'G' },
  ];
  const base = { saleDate: '2031-03-15', moveDate: '2031-07-01', buyDate: null, oddYear: '2031-01-01' };
  const window = { from: 2026, to: 2060 };
  const opt = harvestSweepVariables([], schema, base,
    { flag: 'opt', rowFor: (k, c, e) => optRowFor(k, c, e, window) });
  const mc  = harvestSweepVariables([], schema, base, { flag: 'mc', rowFor: mcRowFor });
  const by  = (list, k) => list.find(v => v.paramKey === k);

  test('Opt: ±2 years around the date, monthly; anchored rows step years on the anchor', () => {
    assert.deepEqual(by(opt, 'saleDate'), { ...by(opt, 'saleDate'),
      type: OPT_PARAM_TYPES.DATE, min: '2029-03-15', max: '2033-03-15', step: 1, sweepKind: 'date' });
    const move = by(opt, 'moveDate');
    assert.deepEqual([move.min, move.max, move.anchor], ['2029-07-01', '2033-07-01', '07-01']);
    assert.equal(valuesForConfig(move).length, 5);
    assert.equal(sweepKindOf(schema[3], 'opt', base.oddYear), 'date');
  });

  test('Opt: an unset sweepUnset date searches the plan window', () => {
    const buy = by(opt, 'buyDate');
    assert.deepEqual([buy.unset, buy.min, buy.max], [true, '2026-01-01', '2060-01-01']);
  });

  test('MC: UNIFORM_DATE ±2 years by default; the anchor rides on the row', () => {
    const sale = by(mc, 'saleDate');
    assert.deepEqual([sale.type, sale.min, sale.max], [DISTRIBUTION_TYPES.UNIFORM_DATE, '2029-03-15', '2033-03-15']);
    assert.equal(by(mc, 'moveDate').anchor, '07-01');
  });

  test('MC: an unset date is a centerless NORMAL_DATE that cannot run until given a mean', () => {
    const buy = by(mc, 'buyDate');
    assert.equal(buy.type, DISTRIBUTION_TYPES.NORMAL_DATE);
    assert.equal(buy.mean, undefined);
    assert.equal(variablesMissingCenter([{ ...buy, enabled: true }]).length, 1);
    assert.equal(variablesMissingCenter([{ ...buy, enabled: true, mean: '2040-03-01' }]).length, 0);
  });
});

// ─── MC distributions ────────────────────────────────────────────────────────

describe('NORMAL_DATE and date anchors in Monte Carlo', () => {
  const draws = (cfg, n = 400) => Array.from({ length: n }, (_, i) =>
    perturbParams({}, i, [{ paramKey: 'd', enabled: true, ...cfg }]).d);

  test('NORMAL_DATE samples ISO days around its mean, σ in days', () => {
    const out = draws({ type: DISTRIBUTION_TYPES.NORMAL_DATE, mean: '2035-01-15', stdDev: 30 });
    assert.ok(out.every(d => ISO.test(d)));
    const days = out.map(d => (Date.parse(d) - Date.parse('2035-01-15')) / 86_400_000);
    const mean = days.reduce((a, b) => a + b, 0) / days.length;
    const sd   = Math.sqrt(days.reduce((a, b) => a + (b - mean) ** 2, 0) / days.length);
    assert.ok(Math.abs(mean) < 6, `mean offset ${mean}`);
    assert.ok(sd > 24 && sd < 36, `sd ${sd}`);
  });

  test('σ 0 returns the mean day', () => {
    assert.equal(createDistribution({ type: DISTRIBUTION_TYPES.NORMAL_DATE, mean: '2035-01-15', stdDev: 0 })
      .sample(Math.random), '2035-01-15');
  });

  test('an anchored date draw always lands on the anchor day', () => {
    for (const type of [DISTRIBUTION_TYPES.UNIFORM_DATE, DISTRIBUTION_TYPES.NORMAL_DATE]) {
      const cfg = type === DISTRIBUTION_TYPES.UNIFORM_DATE
        ? { type, min: '2029-07-01', max: '2033-07-01', anchor: '07-01' }
        : { type, mean: '2031-07-01', stdDev: 400, anchor: '07-01' };
      const out = draws(cfg);
      assert.ok(out.every(d => d.endsWith('-07-01')), `${type}: ${out.find(d => !d.endsWith('-07-01'))}`);
      assert.ok(new Set(out).size > 2, `${type} still varies the year`);
    }
  });

  test('a NORMAL_DATE row has its date center checked by the run guard', () => {
    assert.equal(variablesMissingCenter([{ enabled: true, type: DISTRIBUTION_TYPES.NORMAL_DATE, mean: 'soon' }]).length, 1);
    assert.equal(variablesMissingCenter([{ enabled: true, type: DISTRIBUTION_TYPES.UNIFORM_DATE, min: '2030-01-01' }]).length, 1);
  });
});

describe('MC grid: a date axis finds the plan cell by time', () => {
  test('nearest by time, never a year against a date', () => {
    const values = ['2030-01-15', '2030-07-15', '2031-01-15'];
    assert.equal(nearestIndex(values, '2030-06-01'), 1);
    assert.equal(nearestIndex(values, new Date(Date.UTC(2030, 11, 20))), 2);
    assert.equal(nearestIndex(values, 2030), null);
    assert.equal(nearestIndex([2030, 2031], '2031-01-01'), null);
    assert.equal(nearestIndex([2030, 2031], 2030.8), 1);
  });
});

// ─── Liveness: a DATE candidate moves a real rollout ────────────────────────

describe('liveness: a DATE lever on a loaded plan moves the result (design 117 §5.4)', () => {
  test('person.primary.retirementDate as a DATE: later retirement, more wages, higher net worth', () => {
    const simStart = new Date(Date.UTC(2026, 0, 1));
    const simEnd   = new Date(Date.UTC(2028, 0, 1));
    const variable = { paramKey: 'person.primary.retirementDate', type: OPT_PARAM_TYPES.DATE,
      min: '2026-03-01', max: '2027-12-01', step: 1 };
    const p = new OptimizationProblem({ variables: [variable], simStart, simEnd,
      objective: OPTIMIZATION_OBJECTIVES.MAX_NET_WORTH });
    // Solver-space values, exactly what a solver hands the problem.
    const early = p.evaluate({ [variable.paramKey]: dateOrdinal('2026-03-01') });
    const late  = p.evaluate({ [variable.paramKey]: dateOrdinal('2027-09-01') });
    assert.ok(Number.isFinite(early.score) && Number.isFinite(late.score));
    assert.ok(late.score > early.score,
      `eighteen more months of wages must raise net worth: ${early.score} vs ${late.score}`);
    // And the ISO day itself is accepted too (a warm start, a committed MPC candidate).
    const iso = p.evaluate({ [variable.paramKey]: '2027-09-01' });
    assert.equal(iso.score, late.score);
  });
});
