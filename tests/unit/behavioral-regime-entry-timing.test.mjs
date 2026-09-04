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
 * behavioral-regime-entry-timing.test.mjs
 *
 * design/29 §3 names the trigger for five strategies as REGIME ENTRY — PanicSell
 * (§3.1), ContributionSuspension (§3.2), OpportunisticRebalance (§3.5),
 * DownturnRothConversion (§3.6) and CashBucketDrawdown (§3.7). Every one of them
 * was wired to `['US_PERIOD_ADVANCE', 'AU_PERIOD_ADVANCE']` alone, so each one
 * actually fired at the next 1 Jan or 1 Jul, whichever came first — 1 to 5 months
 * after the shock in a two-country plan, and up to a year in a US-only one. The
 * trailing edge was worse: the household stayed in crisis posture (contributions
 * suspended, cash-bucket drawdown on) for up to six months AFTER its crisis ended.
 *
 * Every per-reducer unit test in the suite passed throughout, because they all call
 * `reduce()` directly with a period-advance action — they pin what the reducer does
 * once it runs, and nothing pinned WHEN it runs. That is the gap this file fills, so
 * the assertions here are deliberately about dates rather than about amounts.
 */

import { test, describe } from 'node:test';
import assert              from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';

import { PanicSellReducer }                    from '../../src/finance/behavioral/panic-sell-reducer.js';
import { OpportunisticRebalanceReducer }       from '../../src/finance/behavioral/opportunistic-rebalance-reducer.js';
import { DownturnRothConversionReducer }       from '../../src/finance/behavioral/downturn-roth-conversion-reducer.js';
import { ContributionSuspensionToggleReducer } from '../../src/finance/behavioral/contribution-suspension-toggle-reducer.js';
import { CashBucketDrawdownReducer }           from '../../src/finance/behavioral/cash-bucket-drawdown-reducer.js';
import { RegimeAwareSpendingReducer }          from '../../src/finance/spending/strategies/regime-aware-spending-reducer.js';
import { RegimeApplyReducer }                  from '../../src/finance/economic-regimes/regime-apply-reducer.js';

const REGIME_ACTIONS = ['ADD_REGIME_APPLY', 'REMOVE_REGIME_APPLY', 'RECOMPUTE_REGIMES'];

const REGIME_TRIGGERED = [
  ['PanicSell',              new PanicSellReducer({ allAccounts: [] })],
  ['OpportunisticRebalance', new OpportunisticRebalanceReducer()],
  ['DownturnRothConversion', new DownturnRothConversionReducer()],
  ['ContributionSuspension', new ContributionSuspensionToggleReducer()],
  ['CashBucketDrawdown',     new CashBucketDrawdownReducer()],
  ['RegimeAwareSpending',    new RegimeAwareSpendingReducer()],
];

describe('regime-entry trigger wiring', () => {

  for (const [name, reducer] of REGIME_TRIGGERED) {
    test(`RET-1 ${name}: reduces the regime actions, not only the period advances`, () => {
      for (const t of REGIME_ACTIONS) {
        assert.ok(reducer.reducedActionTypes.includes(t),
          `${name} does not reduce ${t}, so it cannot see a regime until the next period boundary`);
      }
      // Still annual-capable: the boundary is a legitimate second chance to react,
      // and removing it would change more than the timing.
      assert.ok(reducer.reducedActionTypes.includes('US_PERIOD_ADVANCE'));
    });

    test(`RET-2 ${name}: runs after RegimeApplyReducer, which owns the stack`, () => {
      // RegimeApplyReducer is what DROPS a recovered regime, at PRE_PROCESS + 1. A
      // reducer ahead of it reads the pre-drop stack, so it would miss the exit edge
      // on the final recovery tick — the last one scheduled — and fall back to
      // waiting for a period boundary, which is the bug all over again.
      assert.ok(reducer.priority > new RegimeApplyReducer().priority,
        `${name} at priority ${reducer.priority} runs before RegimeApplyReducer`);
    });
  }
});

describe('regime-entry timing in a full sim', () => {

  // 17-month stress leg (MARKET_CRASH_2008_LITE), started deliberately off both
  // period boundaries: Oct 2028 + 17 months ends Mar 2030. Neither date is a 1 Jan
  // or a 1 Jul, so a reaction that lands on one is riding the calendar, not the
  // regime — which is exactly the failure this pins.
  const SHOCK_ON  = '2028-10';
  const SHOCK_OFF = '2030-03';

  function trackFlags() {
    const seen = [];
    const { sim } = loadScenarioSim({
      params: {
        behavioralStrategies: ['PANIC_SELL', 'CONTRIBUTION_SUSPENSION',
          'OPPORTUNISTIC_REBALANCE', 'DOWNTURN_ROTH_CONVERSION', 'CASH_BUCKET_DRAWDOWN'],
        spendingStrategy: ['FIXED', 'REGIME_AWARE'],
        contributionSuspensionMinSeverity: null,
        cashBucketMinSeverity:             null,
        shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2028-10-01' }],
      },
      simStart:  new Date(Date.UTC(2028, 0, 1)),
      simEnd:    new Date(Date.UTC(2030, 5, 1)),
      telemetry: 'off',
    });

    let prev = null;
    for (let t = Date.UTC(2028, 0, 20); t <= Date.UTC(2030, 4, 20);) {
      const d = new Date(t);
      sim.stepTo(d);
      const s = sim.state;
      const row = {
        suspended:  !!s.contributionsSuspended,
        cashBucket: !!s.regimeActions?.drawdown_source_override?.active,
        spendCut:   !!s.regimeActions?.spending_discretionary_cut?.active,
        panicSell:  !!(s.regimeActions?.panic_sell?.firedForShocks ?? []).length,
        roth:       !!(s.regimeActions?.downturn_roth_conversion?.firedForShocks ?? []).length,
      };
      const key = JSON.stringify(row);
      if (key !== prev) seen.push({ month: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, ...row });
      prev = key;
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 20);
    }
    return seen;
  }

  const transitions = trackFlags();
  const firstWhere  = (pred) => transitions.find(pred)?.month ?? null;

  test('RET-3: the toggles turn ON in the month the shock lands, not at the next boundary', () => {
    assert.strictEqual(firstWhere(r => r.suspended),  SHOCK_ON, 'ContributionSuspension');
    assert.strictEqual(firstWhere(r => r.cashBucket), SHOCK_ON, 'CashBucketDrawdown');
    assert.strictEqual(firstWhere(r => r.spendCut),   SHOCK_ON, 'RegimeAwareSpending');
  });

  test('RET-4: the once-per-shock strategies fire in the month the shock lands', () => {
    assert.strictEqual(firstWhere(r => r.panicSell), SHOCK_ON, 'PanicSell');
    assert.strictEqual(firstWhere(r => r.roth),      SHOCK_ON, 'DownturnRothConversion');
  });

  test('RET-5: the toggles turn OFF when the stress leg ends, not at the next boundary', () => {
    // The trailing edge. Before the fix these stayed on until 1 Jul 2030 — four
    // months of crisis posture after the crisis, which costs real contributions.
    const onThenOff = (key) => transitions.filter(r => r[key] === false).at(-1)?.month;
    assert.strictEqual(onThenOff('suspended'),  SHOCK_OFF, 'ContributionSuspension');
    assert.strictEqual(onThenOff('cashBucket'), SHOCK_OFF, 'CashBucketDrawdown');
    assert.strictEqual(onThenOff('spendCut'),   SHOCK_OFF, 'RegimeAwareSpending');
  });
});
