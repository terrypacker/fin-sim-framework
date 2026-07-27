/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { checkHarvestFeasibility, foldHarvestPlan, feasibilityOfResult, describeFeasibility }
  from '../../src/finance/mpc/harvest-feasibility.js';
import { applyHarvestPlan } from '../../src/finance/mpc/harvest-apply.js';
import { HARVEST_FORMS, requiresIncludes } from '../../src/finance/mpc/harvest.js';

/*
 * Design 80 F1 — feasibility is a GATE on the harvest, checked before apply.
 *
 * The failure this exists to catch: a run that is solvent at every epoch bakes
 * into a scenario that goes out-of-funds mid-plan, and NOTHING notices — because
 * the only check in place (§13.7) compares the two on the goal's own metric, and
 * `finalNetLiquidity` is degenerate at target 0 (a bankrupt plan and a perfect
 * spend-down both read $0). So the tests below assert two separable things:
 *
 *   1. the check RUNS THE PLAN THE WRITER WILL WRITE — same entries, same
 *      enabling params. A check of a different bag is worse than no check;
 *   2. the verdict is solvency, taken from the simulation, never a percentage.
 *
 * The rollout is stubbed through the `makeProblem` DI seam (mirroring
 * `resolveStaticLevers`), so these stay unit-speed; the seam is also what lets
 * the ruin/solvent split be exercised deterministically rather than by finding a
 * scenario that happens to fail.
 */

const SIM_START = new Date(Date.UTC(2026, 0, 1));
const SIM_END   = new Date(Date.UTC(2070, 0, 1));

/** A HarvestPlan with the shapes the real harvest produces: a SCHEDULE bake, a
 *  POINT collapse, and an enabling param that must ride along. */
function planFixture() {
  return {
    runId: 'run:1',
    entries: [
      { paramKey: 'spendingExpenseBands', lever: 'Monthly Spending', leverKey: 'SPENDING',
        form: HARVEST_FORMS.SCHEDULE, from: undefined,
        to: [{ startAge: 47, monthlyAmount: 9941 }, { startAge: 60, monthlyAmount: 8559 }] },
      { paramKey: 'drawdownWeight::super', lever: 'Drawdown Order', leverKey: 'DRAWDOWN_WEIGHTS',
        form: HARVEST_FORMS.POINT, from: 1, to: 0.0398 },
    ],
    requires: [
      { paramKey: 'spendingStrategy', from: ['FIXED'], to: requiresIncludes('EXPLICIT_BANDS'),
        reason: 'inert otherwise', lever: 'Monthly Spending' },
      { paramKey: 'drawdownStrategy', from: 'TAX_EFFICIENT', to: 'WEIGHTED',
        reason: 'inert otherwise', lever: 'Drawdown Order' },
    ],
    warnings: [],
  };
}

/** A stub problem that returns a fixed result and records the params it saw. */
function stubProblem(result, spy = {}) {
  return (opts) => {
    spy.opts = opts;
    return { evaluate: () => ({ result, score: 0 }) };
  };
}

const RUINED = {
  finalNetLiquidity: 0, scenarioFailed: true,
  cumulativeDeficit: 5_705_589, deficitMonths: 194,
  outOfFundsDate: new Date(Date.UTC(2051, 3, 30)),
};
const SOLVENT = {
  finalNetLiquidity: 106_476, scenarioFailed: false,
  cumulativeDeficit: 0, deficitMonths: 0, outOfFundsDate: null,
};

describe('design 80 F1 — the fold matches what applyHarvestPlan writes', () => {
  test('every form is folded, not just the SCHEDULE bakes', () => {
    const folded = foldHarvestPlan({ spendingExpenseBands: [], 'drawdownWeight::super': 1 }, planFixture());
    assert.equal(folded['drawdownWeight::super'], 0.0398, 'POINT entries are folded too');
    assert.equal(folded.spendingExpenseBands.length, 2);
  });

  test('enabling params ride along, with EnumMulti appended rather than clobbered', () => {
    const folded = foldHarvestPlan({ spendingStrategy: ['FIXED'], drawdownStrategy: 'TAX_EFFICIENT' }, planFixture());
    // The whole point of the `includes` requirement: the user's other selected
    // strategies survive. A plain assignment here would verify a scenario the
    // writer never produces.
    assert.deepEqual(folded.spendingStrategy, ['FIXED', 'EXPLICIT_BANDS']);
    assert.equal(folded.drawdownStrategy, 'WEIGHTED');
  });

  test('an already-satisfied requirement is left alone', () => {
    const folded = foldHarvestPlan({ spendingStrategy: ['EXPLICIT_BANDS'] }, planFixture());
    assert.deepEqual(folded.spendingStrategy, ['EXPLICIT_BANDS'], 'no duplicate append');
  });

  test('the fold never mutates the caller’s params', () => {
    const base = { spendingExpenseBands: [{ startAge: 45, monthlyAmount: 5500 }], spendingStrategy: ['FIXED'] };
    foldHarvestPlan(base, planFixture());
    assert.deepEqual(base.spendingExpenseBands, [{ startAge: 45, monthlyAmount: 5500 }]);
    assert.deepEqual(base.spendingStrategy, ['FIXED']);
  });

  test('the folded bag equals what applyHarvestPlan produces — the two cannot drift', () => {
    const base = { spendingExpenseBands: [], 'drawdownWeight::super': 1, spendingStrategy: ['FIXED'], drawdownStrategy: 'TAX_EFFICIENT' };
    const plan = planFixture();

    const scenario = { params: Object.entries(base).map(([name, value]) => ({ name, value })) };
    applyHarvestPlan(scenario, plan);
    const written = Object.fromEntries(scenario.params.map(p => [p.name, p.value]));

    assert.deepEqual(foldHarvestPlan(base, plan), written);
  });
});

describe('design 80 F1 — the verdict is solvency, from the simulation', () => {
  test('an infeasible plan is reported with its ruin date and magnitude', () => {
    const out = checkHarvestFeasibility({
      plan: planFixture(), baseParams: {}, simStart: SIM_START, simEnd: SIM_END,
      makeProblem: stubProblem(RUINED),
    });
    assert.equal(out.feasible, false);
    assert.equal(out.cumulativeDeficit, 5_705_589);
    assert.equal(out.deficitMonths, 194);
    assert.equal(new Date(out.outOfFundsDate).toISOString().slice(0, 10), '2051-04-30');
    assert.match(describeFeasibility(out), /runs out of money in Apr 2051/);
  });

  test('a solvent plan passes', () => {
    const out = checkHarvestFeasibility({
      plan: planFixture(), baseParams: {}, simStart: SIM_START, simEnd: SIM_END,
      makeProblem: stubProblem(SOLVENT),
    });
    assert.equal(out.feasible, true);
    assert.equal(out.shortfall, 0);
    assert.match(describeFeasibility(out), /Solvent/);
  });

  test('`scenarioFailed` with no accrued deficit is still infeasible', () => {
    // A rollout can be flagged failed on the last step before the shortfall
    // accumulates — `infeasibilityOf`'s case, inherited rather than re-derived.
    const out = checkHarvestFeasibility({
      plan: planFixture(), baseParams: {}, simStart: SIM_START, simEnd: SIM_END,
      makeProblem: stubProblem({ ...SOLVENT, scenarioFailed: true }),
    });
    assert.equal(out.feasible, false);
  });

  test('the ruined and the solvent plan are INDISTINGUISHABLE on the goal metric', () => {
    // The load-bearing reason F1 exists (design 80 §2.6): under DIE_WITH_TARGET_LIQUID
    // with target 0, "went broke in 2051" scores a PERFECT ZERO on the goal's own
    // terminal term — the same as a flawless spend-down. Any fidelity check built on
    // that metric passes a bankrupt plan; only the solvency axis separates them.
    const target = 0;
    assert.equal(Math.abs(RUINED.finalNetLiquidity - target), 0, 'ruin reads as ON TARGET');
    assert.equal(feasibilityOfResult(RUINED).feasible, false);
    assert.equal(feasibilityOfResult({ ...SOLVENT, finalNetLiquidity: 0 }).feasible, true);
  });

  test('the check runs from t₀ over the whole horizon, not from a snapshot', () => {
    // A saved scenario re-runs from the beginning; a check that started at "now"
    // would skip exactly the years the age-keyed bakes most distort.
    const spy = {};
    checkHarvestFeasibility({
      plan: planFixture(), baseParams: { inflationRate: 0.03 },
      simStart: SIM_START, simEnd: SIM_END, cfgTemplate: { id: 'cfg' },
      makeProblem: stubProblem(SOLVENT, spy),
    });
    assert.equal(spy.opts.initialState.kind, 'compile');
    assert.equal(spy.opts.initialState.cfgTemplate.id, 'cfg');
    assert.deepEqual(spy.opts.variables, [], 'no search — one candidate, one run');
    assert.equal(spy.opts.simEnd, SIM_END);
    assert.equal(spy.opts.baseParams.inflationRate, 0.03, 'base params carried through');
    assert.equal(spy.opts.baseParams['drawdownWeight::super'], 0.0398, 'with the plan folded on');
  });

  test('a plan with ONE entry is a valid input (design 81 promotion gate)', () => {
    const out = checkHarvestFeasibility({
      plan: { entries: [{ paramKey: 'drawdownWeight::super', to: 0.5, form: HARVEST_FORMS.POINT }] },
      baseParams: {}, simStart: SIM_START, simEnd: SIM_END,
      makeProblem: stubProblem(SOLVENT),
    });
    assert.equal(out.feasible, true);
    assert.equal(out.params['drawdownWeight::super'], 0.5);
  });

  test('a check that cannot run reports UNKNOWN, not a verdict', () => {
    // Unverifiable ≠ infeasible: a broken check must not become a silent veto on
    // the user's own plan, nor a silent pass.
    const out = checkHarvestFeasibility({
      plan: planFixture(), baseParams: {}, simStart: SIM_START, simEnd: SIM_END,
      makeProblem: () => { throw new Error('compile blew up'); },
    });
    assert.equal(out.feasible, null);
    assert.match(out.error, /compile blew up/);
    assert.match(describeFeasibility(out), /could not be checked/);
  });
});
