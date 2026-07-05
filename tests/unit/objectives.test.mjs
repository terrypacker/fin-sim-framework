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
import assert from 'node:assert/strict';

import {
  OPTIMIZATION_OBJECTIVES, DEFAULT_TERMINAL_WEALTH_PENALTY, DEFAULT_DEFICIT_PENALTY,
  DIE_WITH_TARGET_FAMILY, resolveDieWithTargetKey, groupedObjectiveOptions,
  resolveTerminalKey, terminalAxesFor,
} from '../../src/finance/optimization/optimization-objectives.js';
import { OptimizationProblem } from '../../src/finance/optimization/optimization-problem.js';

const { DIE_WITH_TARGET, DIE_WITH_TARGET_LIQUID, CRRA_DIE_WITH_TARGET, MIN_LIFETIME_TAXES, MAX_NET_WORTH }
  = OPTIMIZATION_OBJECTIVES;

// ─── DIE_WITH_TARGET ──────────────────────────────────────────────────────────

describe('DIE_WITH_TARGET objective', () => {
  test('is a maximize objective', () => {
    assert.strictEqual(DIE_WITH_TARGET.direction, 'maximize');
  });

  test('penalty is two-sided (over- and under-shooting the target cost equally)', () => {
    const base = { lifetimeConsumption: 1_000_000, terminalWealthTarget: 500_000, terminalWealthTargetPenalty: 10 };
    const over  = DIE_WITH_TARGET.evaluate({ ...base, finalNetWorthUsd: 600_000 });
    const under = DIE_WITH_TARGET.evaluate({ ...base, finalNetWorthUsd: 400_000 });
    assert.strictEqual(over, under);
    assert.strictEqual(over, 1_000_000 - 10 * 100_000);
  });

  test('a large penalty makes the target binding (hitting it beats more consumption off-target)', () => {
    const onTarget  = DIE_WITH_TARGET.evaluate({
      lifetimeConsumption: 1_000_000, finalNetWorthUsd: 0, terminalWealthTarget: 0, terminalWealthTargetPenalty: 10 });
    const offTarget = DIE_WITH_TARGET.evaluate({
      lifetimeConsumption: 1_100_000, finalNetWorthUsd: 50_000, terminalWealthTarget: 0, terminalWealthTargetPenalty: 10 });
    assert.ok(onTarget > offTarget, `${onTarget} should beat ${offTarget}`);
  });

  test('falls back to the default penalty weight when unset', () => {
    const score = DIE_WITH_TARGET.evaluate({
      lifetimeConsumption: 0, finalNetWorthUsd: 100, terminalWealthTarget: 0 });
    assert.strictEqual(score, -DEFAULT_TERMINAL_WEALTH_PENALTY * 100);
  });

  test('windowed: subtracts the snapshot consumption (MPC horizon)', () => {
    const result   = { lifetimeConsumption: 1_000_000, finalNetWorthUsd: 0, terminalWealthTarget: 0, terminalWealthTargetPenalty: 10 };
    const snapshot = { state: { cumulativeConsumption: 200_000 } };
    assert.strictEqual(DIE_WITH_TARGET.evaluate(result, { snapshot }), 800_000);
  });

  test('deflates the terminal anchor to real base-year before penalizing the miss', () => {
    // terminalPriceLevel = 2 ⇒ a $1.0M NOMINAL terminal is $500k REAL; against a
    // $500k real target the miss is zero → pure consumption reward. The target is
    // now interpreted in base-year ("today's") dollars, matching the real reward.
    const onRealTarget = DIE_WITH_TARGET.evaluate({
      lifetimeConsumption: 1_000_000, finalNetWorthUsd: 1_000_000,
      terminalPriceLevel: 2, terminalWealthTarget: 500_000, terminalWealthTargetPenalty: 10 });
    assert.strictEqual(onRealTarget, 1_000_000, 'nominal $1M / 2 = real $500k == target → no penalty');

    // The same nominal terminal is OVER the target in real terms by $100k when the
    // target is $400k real: penalty = λ·100k, deflated miss (not the nominal $600k).
    const offRealTarget = DIE_WITH_TARGET.evaluate({
      lifetimeConsumption: 1_000_000, finalNetWorthUsd: 1_000_000,
      terminalPriceLevel: 2, terminalWealthTarget: 400_000, terminalWealthTargetPenalty: 10 });
    assert.strictEqual(offRealTarget, 1_000_000 - 10 * 100_000, 'penalty is on the REAL $100k miss');
  });

  test('absent a price level the terminal anchor is taken at par (backward compatible)', () => {
    const score = DIE_WITH_TARGET.evaluate({
      lifetimeConsumption: 1_000_000, finalNetWorthUsd: 600_000,
      terminalWealthTarget: 500_000, terminalWealthTargetPenalty: 10 });
    assert.strictEqual(score, 1_000_000 - 10 * 100_000, 'no terminalPriceLevel ⇒ deflator 1');
  });

  test('a solvent plan (no deficit) is unaffected by the deficit penalty', () => {
    // cumulativeDeficit defaults to 0 → penalty term is 0, so the score is exactly
    // the original consumption − λ·|NW − target| formula (interior optimum intact).
    const score = DIE_WITH_TARGET.evaluate({
      lifetimeConsumption: 1_000_000, finalNetWorthUsd: 600_000,
      terminalWealthTarget: 500_000, terminalWealthTargetPenalty: 10 });
    assert.strictEqual(score, 1_000_000 - 10 * 100_000);
  });
});

// ─── Deficit penalty: "die with target" must not reward insolvency (design/39) ─

describe('die-with-target deficit penalty', () => {
  // Reproduces the live bug: a $30k-spend rollout drove finalNetLiquidity to 0
  // (floored) next to a $5k target while running $23M into deficit. Without a
  // solvency term the optimizer preferred going broke; with it, a safe plan wins.
  const bankrupt = {
    lifetimeConsumption: 12_095_394, finalNetWorthUsd: 0, finalNetLiquidity: 0,
    cumulativeDeficit: 23_209_136, scenarioFailed: true,
    terminalWealthTarget: 5_000, terminalWealthTargetPenalty: 10,
  };
  const solvent = {
    lifetimeConsumption: 4_000_000, finalNetWorthUsd: 1_000_000, finalNetLiquidity: 1_000_000,
    cumulativeDeficit: 0, scenarioFailed: false,
    terminalWealthTarget: 5_000, terminalWealthTargetPenalty: 10,
  };

  test('LIQUID: a solvent plan now beats the bankrupting max-spend plan', () => {
    assert.ok(
      DIE_WITH_TARGET_LIQUID.evaluate(solvent) > DIE_WITH_TARGET_LIQUID.evaluate(bankrupt),
      'the deficit penalty must dominate the spurious near-target reward of going broke');
  });

  test('LIQUID: without the deficit the bankrupt-shaped plan would have won (documents the bug)', () => {
    // Strip the deficit → the old formula, under which insolvency scored best.
    const wasWinning = { ...bankrupt, cumulativeDeficit: 0 };
    assert.ok(
      DIE_WITH_TARGET_LIQUID.evaluate(wasWinning) > DIE_WITH_TARGET_LIQUID.evaluate(solvent),
      'absent any deficit, max-spend-to-target out-scores the safe plan — the original behavior');
  });

  test('penalty applies to DIE_WITH_TARGET and CRRA_DIE_WITH_TARGET too', () => {
    assert.ok(DIE_WITH_TARGET.evaluate(solvent) > DIE_WITH_TARGET.evaluate(bankrupt));
    const u = { lifetimeConsumptionUtility: 1000 };
    assert.ok(
      CRRA_DIE_WITH_TARGET.evaluate({ ...solvent, ...u }) >
      CRRA_DIE_WITH_TARGET.evaluate({ ...bankrupt, ...u }));
  });

  test('penalty is μ·deficit, windowed by the snapshot accumulator', () => {
    const result   = { lifetimeConsumption: 0, finalNetWorthUsd: 0, terminalWealthTarget: 0,
                       terminalWealthTargetPenalty: 10, cumulativeDeficit: 1_000 };
    const snapshot = { state: { cumulativeDeficit: 400 } };       // 600 incurred in-window
    assert.strictEqual(DIE_WITH_TARGET.evaluate(result, { snapshot }), -DEFAULT_DEFICIT_PENALTY * 600);
  });

  test('deficitPenalty param overrides the default weight', () => {
    const result = { lifetimeConsumption: 0, finalNetWorthUsd: 0, terminalWealthTarget: 0,
                     terminalWealthTargetPenalty: 10, cumulativeDeficit: 100, deficitPenalty: 7 };
    assert.strictEqual(DIE_WITH_TARGET.evaluate(result), -7 * 100);
  });
});

// ─── MIN_LIFETIME_TAXES ───────────────────────────────────────────────────────

describe('MIN_LIFETIME_TAXES objective', () => {
  test('is a minimize objective reading cumulativeTaxesPaid', () => {
    assert.strictEqual(MIN_LIFETIME_TAXES.direction, 'minimize');
    assert.strictEqual(MIN_LIFETIME_TAXES.evaluate({ cumulativeTaxesPaid: 50_000 }), 50_000);
  });

  test('windowed: taxes within the window are terminal − snapshot accumulator', () => {
    const result   = { cumulativeTaxesPaid: 50_000 };
    const snapshot = { state: { cumulativeTaxesPaid: 20_000 } };
    assert.strictEqual(MIN_LIFETIME_TAXES.evaluate(result, { snapshot }), 30_000);
  });
});

// ─── Die-With-Target family (2×2 grouping, design/39) ────────────────────────

describe('Die-With-Target family', () => {
  test('is a complete 2×2×2 over running × scope × tax-basis, all tagged with family + variant', () => {
    const family = Object.entries(OPTIMIZATION_OBJECTIVES)
      .filter(([, o]) => o.family === DIE_WITH_TARGET_FAMILY);
    assert.equal(family.length, 8, 'eight variants (running × {worth,liquid} × {nominal,afterTax})');
    const variants = family.map(([, o]) => `${o.variant.running}|${o.variant.terminal}`).sort();
    assert.deepStrictEqual(variants, [
      'consumption|afterTaxLiquid', 'consumption|afterTaxWorth',
      'consumption|liquid',        'consumption|worth',
      'crra|afterTaxLiquid',       'crra|afterTaxWorth',
      'crra|liquid',               'crra|worth',
    ]);
  });

  test('resolveDieWithTargetKey maps each axis pair to its concrete key', () => {
    assert.equal(resolveDieWithTargetKey({ running: 'consumption', terminal: 'worth'  }), 'DIE_WITH_TARGET');
    assert.equal(resolveDieWithTargetKey({ running: 'consumption', terminal: 'liquid' }), 'DIE_WITH_TARGET_LIQUID');
    assert.equal(resolveDieWithTargetKey({ running: 'crra',        terminal: 'worth'  }), 'CRRA_DIE_WITH_TARGET');
    assert.equal(resolveDieWithTargetKey({ running: 'crra',        terminal: 'liquid' }), 'CRRA_DIE_WITH_TARGET_LIQUID');
    assert.equal(resolveDieWithTargetKey({ running: 'consumption', terminal: 'afterTaxWorth'  }), 'DIE_WITH_TARGET_AFTERTAX');
    assert.equal(resolveDieWithTargetKey({ running: 'consumption', terminal: 'afterTaxLiquid' }), 'DIE_WITH_TARGET_AFTERTAX_LIQUID');
    assert.equal(resolveDieWithTargetKey({ running: 'crra',        terminal: 'afterTaxWorth'  }), 'CRRA_DIE_WITH_TARGET_AFTERTAX');
    assert.equal(resolveDieWithTargetKey({}), 'DIE_WITH_TARGET', 'defaults to consumption×worth');
  });

  test('resolveTerminalKey folds (scope, basis) to the terminal-measure key; terminalAxesFor inverts it', () => {
    assert.equal(resolveTerminalKey({ scope: 'worth',  basis: 'nominal'  }), 'worth');
    assert.equal(resolveTerminalKey({ scope: 'liquid', basis: 'nominal'  }), 'liquid');
    assert.equal(resolveTerminalKey({ scope: 'worth',  basis: 'afterTax' }), 'afterTaxWorth');
    assert.equal(resolveTerminalKey({ scope: 'liquid', basis: 'afterTax' }), 'afterTaxLiquid');
    assert.equal(resolveTerminalKey({}), 'worth', 'defaults to worth×nominal');
    assert.deepStrictEqual(terminalAxesFor('afterTaxLiquid'), { scope: 'liquid', basis: 'afterTax' });
    assert.deepStrictEqual(terminalAxesFor('worth'),          { scope: 'worth',  basis: 'nominal'  });
  });

  test('after-tax variants anchor on the after-tax terminal result keys', () => {
    const base = { lifetimeConsumption: 1000, terminalWealthTarget: 500_000, terminalWealthTargetPenalty: 10,
                   finalNetWorthUsd: 9e9, finalNetLiquidity: 9e9 };   // nominal keys must be ignored
    const worth = OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET_AFTERTAX.evaluate(
      { ...base, finalAfterTaxNetWorth: 500_000 });
    assert.strictEqual(worth, 1000, 'after-tax worth on target → pure reward, ignores nominal worth');
    const liquid = OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET_AFTERTAX_LIQUID.evaluate(
      { ...base, finalAfterTaxNetLiquidity: 400_000 });
    assert.strictEqual(liquid, 1000 - 10 * 100_000, 'penalty is on the after-tax liquidity miss');
  });

  test('MAX_AFTER_TAX_* maximizers read the after-tax result keys', () => {
    assert.equal(OPTIMIZATION_OBJECTIVES.MAX_AFTER_TAX_NET_WORTH.direction, 'maximize');
    assert.equal(OPTIMIZATION_OBJECTIVES.MAX_AFTER_TAX_NET_WORTH.evaluate({ finalAfterTaxNetWorth: 1234 }), 1234);
    assert.equal(OPTIMIZATION_OBJECTIVES.MAX_AFTER_TAX_NET_LIQUIDITY.evaluate({ finalAfterTaxNetLiquidity: 77 }), 77);
  });

  test('the new CRRA × Liquid variant: utility reward, anchored on terminal liquidity', () => {
    const obj = OPTIMIZATION_OBJECTIVES.CRRA_DIE_WITH_TARGET_LIQUID;
    assert.equal(obj.direction, 'maximize');
    // Reward = lifetimeConsumptionUtility; penalty on |finalNetLiquidity − target|;
    // finalNetWorthUsd must NOT enter (that's the worth variant).
    const base = {
      lifetimeConsumptionUtility: 1000, terminalWealthTarget: 500_000,
      terminalWealthTargetPenalty: 10, finalNetWorthUsd: 9_999_999,
    };
    const onTarget  = obj.evaluate({ ...base, finalNetLiquidity: 500_000 });
    const offTarget = obj.evaluate({ ...base, finalNetLiquidity: 400_000 });
    assert.strictEqual(onTarget, 1000, 'on-liquidity-target → pure utility, ignores net worth');
    assert.strictEqual(offTarget, 1000 - 10 * 100_000, 'penalty is on the liquidity miss');
  });

  test('CRRA default λ auto-scales by the run marginal utility (no re-tune on basis switch)', () => {
    const crra = OPTIMIZATION_OBJECTIVES.CRRA_DIE_WITH_TARGET;
    const mu   = 2e-6;   // dollars→utils shadow price for this run
    const base = { lifetimeConsumptionUtility: 1000, terminalWealthTarget: 500_000,
                   consumptionMarginalUtility: mu };
    const onTarget  = crra.evaluate({ ...base, finalNetWorthUsd: 500_000 });
    const offTarget = crra.evaluate({ ...base, finalNetWorthUsd: 400_000 });
    assert.strictEqual(onTarget, 1000, 'on target → pure utility');
    assert.strictEqual(offTarget, 1000 - (DEFAULT_TERMINAL_WEALTH_PENALTY * mu) * 100_000,
      'λ defaulted to DEFAULT·u′(c̄), converting the dollar miss into utils');
  });

  test('consumption basis ignores marginal utility (λ stays the dollar default)', () => {
    const off = OPTIMIZATION_OBJECTIVES.DIE_WITH_TARGET.evaluate({
      lifetimeConsumption: 1_000_000, terminalWealthTarget: 500_000,
      finalNetWorthUsd: 400_000, consumptionMarginalUtility: 2e-6,   // present but unused
    });
    assert.strictEqual(off, 1_000_000 - DEFAULT_TERMINAL_WEALTH_PENALTY * 100_000);
  });

  test('explicit terminalWealthTargetPenalty still overrides the CRRA auto-scale', () => {
    const off = OPTIMIZATION_OBJECTIVES.CRRA_DIE_WITH_TARGET.evaluate({
      lifetimeConsumptionUtility: 1000, terminalWealthTarget: 500_000, finalNetWorthUsd: 400_000,
      consumptionMarginalUtility: 2e-6, terminalWealthTargetPenalty: 3,
    });
    assert.strictEqual(off, 1000 - 3 * 100_000);
  });

  test('groupedObjectiveOptions collapses the family into one entry, keeps singles', () => {
    const grouped = groupedObjectiveOptions();
    const families = grouped.filter(o => o.kind === 'family');
    assert.equal(families.length, 1, 'one collapsed family entry');
    assert.equal(families[0].family, DIE_WITH_TARGET_FAMILY);
    // None of the four concrete family keys appear as standalone entries.
    const singleKeys = grouped.filter(o => o.kind === 'single').map(o => o.key);
    for (const k of ['DIE_WITH_TARGET', 'DIE_WITH_TARGET_LIQUID', 'CRRA_DIE_WITH_TARGET', 'CRRA_DIE_WITH_TARGET_LIQUID']) {
      assert.ok(!singleKeys.includes(k), `${k} is grouped, not standalone`);
    }
    assert.ok(singleKeys.includes('MAX_NET_WORTH'), 'standalone objectives still listed');
  });
});

// ─── Terminal objectives keep the pure single-arg shape ──────────────────────

describe('terminal objectives', () => {
  test('MAX_NET_WORTH ignores the snapshot argument', () => {
    assert.strictEqual(MAX_NET_WORTH.evaluate({ finalNetWorthUsd: 123 }), 123);
    assert.strictEqual(MAX_NET_WORTH.evaluate({ finalNetWorthUsd: 123 }, { snapshot: { state: {} } }), 123);
  });
});

// ─── Integration: accumulators are wired and scored ──────────────────────────

describe('lifetime accumulators in a real rollout', () => {
  test('evaluate() surfaces positive lifetime taxes and consumption', () => {
    const problem = new OptimizationProblem({
      variables: [],
      objective: MIN_LIFETIME_TAXES,
      simStart: new Date(Date.UTC(2026, 0, 1)),
      simEnd:   new Date(Date.UTC(2031, 0, 1)),
    });
    const { result } = problem.evaluate({});
    assert.ok(result.lifetimeConsumption > 0, 'expenses should accumulate consumption');
    assert.ok(result.cumulativeTaxesPaid >= 0 && Number.isFinite(result.cumulativeTaxesPaid));
  });
});
