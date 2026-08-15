/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * consumption-intent-gap.test.mjs — design 89 §5.1 steps B and D.
 *
 * Three reducers consume one `EXPENSE_DEBIT`:
 *
 *   ExpenseDebitReducer               PRIORITY.CASH_FLOW  moves min(amount, balance),
 *                                                        stamps action.realizedAmount
 *   AccumulateConsumptionReducer      PRIORITY.METRICS    books realizedAmount
 *   AccumulateConsumptionUtilityReducer PRIORITY.METRICS  books realizedAmount
 *
 * The last two build `cumulativeConsumption` and `cumulativeConsumptionUtility` —
 * what the `consumption`, `crra` and `DIE_WITH_TARGET` objectives maximize.
 *
 * ─── history, because the shape of this file is the history ──────────────────
 *
 * Until design 89 §5.4 (step D) the accumulators read `action.amount` — the money
 * the strategy ASKED for — while the money that moved was capped at the balance. On
 * a plan that ran short they diverged, so the objectives were paid for spending the
 * household never received: 53% / 276% / 660% overstatement under 2x / 4x / 8x
 * expense stress (§5.2), and exactly zero on any solvent plan, because the cap only
 * binds when short.
 *
 * This file began as the CHARACTERISATION of that defect (step B). Its assertions
 * were labelled `[INVERTED BY STEP D]` or `[PINNED]` according to whether they were
 * expected to flip, and the labelling was verified by mutation rather than reasoned
 * about — which is how two mislabelled assertions were found. Step D then landed and
 * the five inverted assertions were rewritten to their realized-side form; the
 * `→ was:` notes record what each one used to say.
 *
 * What each group is for now:
 *
 *   CONTROL — a solvent debit, where realized == intent. It was the working-detector
 *             control for the old defect and it still earns its place: it is the
 *             only group that proves the fix did NOT change solvent behaviour, which
 *             is the whole basis for step D's blast radius being small.
 *   THE GAP — that realized is now what is booked, that it survives FX and
 *             deflation, and that BOTH accumulators moved (the `crra` objective
 *             reads the second one, so a one-file fix would have left half the
 *             defect in place).
 *   ORDERING — the fix is order-dependent where the defect was not. Reading a
 *             stamped field is only correct because CASH_FLOW precedes METRICS, so
 *             that precedence is pinned here. Without this, moving the debit reducer
 *             later would send the accumulators to their `?? action.amount` fallback
 *             and silently restore the old behaviour.
 *   UNITS   — §5.2's unlooked-for finding, deliberately NOT fixed by step D:
 *             `cumulativeDeficit` is not in the same unit as `cumulativeConsumption`,
 *             so the penalty term cannot cleanly offset a reward. Recorded as scope
 *             belonging to the objective work (§5.4.3).
 *
 * Run with: node --test tests/unit/consumption-intent-gap.test.mjs
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { ExpenseDebitReducer }              from '../../src/finance/reducers/expense-debit-reducer.js';
import { AccumulateConsumptionReducer }     from '../../src/finance/reducers/accumulate-consumption-reducer.js';
import { AccumulateConsumptionUtilityReducer } from '../../src/finance/reducers/accumulate-consumption-utility-reducer.js';
import { AccumulateDeficitReducer }         from '../../src/finance/reducers/accumulate-deficit-reducer.js';
import { blendExpensePriceLevel, residencePriceLevel } from '../../src/finance/spending/expense-price-level.js';
import { makeAccount, makeAction, makePeople, makeServices } from '../helpers/reducer-fixtures.js';

const DATE  = new Date('2040-06-30');
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/**
 * Dispatch one EXPENSE_DEBIT through all three reducers in the sim's own priority
 * order — CASH_FLOW first, then the two METRICS accumulators — and report what
 * each of them booked.
 *
 * Running the accumulators AFTER the debit is deliberate and load-bearing: it is
 * the order the engine uses. It was what proved the old defect was not a sequencing
 * problem (they booked intent even with the shortfall already visible in state), and
 * it is now what makes the fix work at all — `realizedAmount` is stamped by the
 * debit, so an accumulator running first would see nothing.
 */
function spend({ balance, amount, currency = 'USD', priceLevel = 1, rate = 1, ...extra }) {
  const stateKey = currency === 'AUD' ? 'auSavingsAccount' : 'usSavingsAccount';
  const cc       = currency === 'AUD' ? 'AU' : 'US';

  let state = {
    people:                 makePeople({ residency: cc }),
    cumulativeConsumption:  0,
    cumulativeConsumptionUtility: 0,
    inflationAccumulator:   { [cc]: priceLevel },
    effectiveExchangeRates: { USD_AUD: rate },
    [stateKey]:             makeAccount({ stateKey, currency, country: cc, balance }),
  };

  const action = makeAction('EXPENSE_DEBIT', { amount, targetKey: stateKey, ...extra });
  const before = state[stateKey].balance;

  state = new ExpenseDebitReducer(makeServices()).reduce(state, action, DATE);
  const realized = before - state[stateKey].balance;

  state = new AccumulateConsumptionReducer().reduce(state, action, DATE);
  state = new AccumulateConsumptionUtilityReducer().reduce(state, action, DATE);

  // What the accumulators WOULD have booked had they read the money that moved.
  const toReal = (v) => (currency === 'AUD' ? v / rate : v) / priceLevel;

  return {
    realized,
    realizedReal: toReal(realized),
    intentReal:   toReal(amount),
    consumption:  state.cumulativeConsumption,
    utility:      state.cumulativeConsumptionUtility,
    state,
  };
}

// ─── CONTROL ──────────────────────────────────────────────────────────────────

describe('control: the detector works on a solvent debit', () => {
  test('realized equals intent, and consumption equals both', () => {
    const r = spend({ balance: 10_000, amount: 2_000, priceLevel: 2 });

    close(r.realized, 2_000);            // nothing was capped
    close(r.realizedReal, r.intentReal); // so the two candidate sources agree
    close(r.consumption, 1_000);         // 2000 nominal / 2.0 price level

    // The gap this file exists to detect is ZERO here. That is the point of the
    // control: it proves the assertions below can distinguish the two cases.
    close(r.consumption - r.realizedReal, 0);
  });

  test('AUD is FX-converted then deflated, and still agrees when solvent', () => {
    const r = spend({ balance: 10_000, amount: 3_600, currency: 'AUD', rate: 1.5, priceLevel: 1.2 });

    close(r.realized, 3_600);
    close(r.consumption, 2_000);         // 3600 AUD / 1.5 = 2400 USD / 1.2 = 2000 real
    close(r.consumption - r.realizedReal, 0);
  });
});

// ─── THE GAP ──────────────────────────────────────────────────────────────────

describe('what is booked when the cap binds', () => {
  test('ExpenseDebitReducer caps at the balance; the account never goes negative', () => {
    const r = spend({ balance: 500, amount: 2_000 });
    close(r.realized, 500);
    close(r.state.usSavingsAccount.balance, 0);
  });

  test('cumulativeConsumption books the CAPPED DEBIT, not intent', () => {
    const r = spend({ balance: 500, amount: 2_000, priceLevel: 2 });

    // → was: close(r.consumption, 1_000) — the full 2,000 asked for, deflated.
    close(r.consumption, 250);              // 500 actually spent / 2.0 price level
    close(r.consumption, r.realizedReal);
    assert.ok(r.consumption < r.intentReal,
      'the accumulator no longer books money the household did not receive');
  });

  test('the overstatement that used to exist is gone, to the cent', () => {
    const balance = 500, amount = 2_000, priceLevel = 2;
    const r = spend({ balance, amount, priceLevel });

    // → was: close(r.consumption - r.realizedReal, (amount - balance) / priceLevel)
    // The old gap WAS the capped-away money; it is now zero, and this asserts the
    // exact quantity that disappeared rather than merely that something shrank.
    close(r.consumption - r.realizedReal, 0);
    close(r.intentReal - r.consumption, (amount - balance) / priceLevel);
  });

  test('the CRRA companion moved too — a one-file fix would have missed it', () => {
    const capped  = spend({ balance: 500,    amount: 2_000, priceLevel: 2 });
    const solvent = spend({ balance: 10_000, amount: 2_000, priceLevel: 2 });

    // → was: close(capped.utility, solvent.utility) — identical, because both booked
    // intent. AccumulateConsumptionUtilityReducer is what `MAX_CRRA_UTILITY` reads,
    // and that objective has NO deficit penalty (design 89 §5.4.1), so this is the
    // one place the overstatement had nothing at all opposing it.
    assert.ok(capped.utility < solvent.utility,
      'a month the household could not fund must score lower utility');
    assert.ok(capped.realized < solvent.realized,
      'control: the two runs really did spend different amounts of money');
  });

  test('the realized figure survives FX conversion and deflation', () => {
    const r = spend({ balance: 600, amount: 3_600, currency: 'AUD', rate: 1.5, priceLevel: 1.2 });

    // → was: close(r.consumption, 2_000) — the full 3,600 AUD, converted + deflated.
    close(r.realized, 600);
    close(r.consumption, 600 / 1.5 / 1.2);   // 600 AUD /1.5 = 400 USD /1.2 = 333.33 real
    close(r.consumption, r.realizedReal);
  });

  test('a month the household could not fund at all books ZERO consumption', () => {
    // The edge the `?? action.amount` fallback must not swallow: balance 0 means the
    // debit moved nothing, so realizedAmount is 0 — and 0 is a value, not an absence.
    // Booking `amount` here is exactly the ruin case design 89 §5.4.1 cares about.
    const r = spend({ balance: 0, amount: 2_000, priceLevel: 2 });

    close(r.realized, 0);
    close(r.consumption, 0);
    close(r.utility, 0);
  });
});

// ─── ORDERING ─────────────────────────────────────────────────────────────────

describe('the fix is order-dependent, so the order is pinned', () => {
  test('ExpenseDebitReducer runs strictly before both accumulators', () => {
    const debit   = new ExpenseDebitReducer(makeServices()).priority;
    const consume = new AccumulateConsumptionReducer().priority;
    const utility = new AccumulateConsumptionUtilityReducer().priority;

    // Reading a stamped field is only correct because CASH_FLOW precedes METRICS.
    // Move the debit reducer later and the accumulators fall back to `action.amount`
    // — silently restoring the pre-step-D behaviour with every other test in this
    // file still passing, because they drive the reducers in explicit order.
    assert.ok(debit < consume, `ExpenseDebitReducer (${debit}) must precede AccumulateConsumptionReducer (${consume})`);
    assert.ok(debit < utility, `ExpenseDebitReducer (${debit}) must precede AccumulateConsumptionUtilityReducer (${utility})`);
  });

  test('the fallback still serves a bare EXPENSE_DEBIT with no debit reducer', () => {
    // Reducer-level callers (see accumulate-reducers.test.mjs, crra-objective.test.mjs)
    // dispatch EXPENSE_DEBIT directly. With no realizedAmount stamped there is no
    // cap to respect, so `amount` is the right reading — and this pins that the
    // fallback exists, so removing it is a deliberate act rather than an accident.
    const state = {
      cumulativeConsumption: 0,
      usSavingsAccount: { currency: { code: 'USD' } },
      inflationAccumulator: { US: 2 },
    };
    const out = new AccumulateConsumptionReducer()
      .reduce(state, makeAction('EXPENSE_DEBIT', { amount: 2_000, targetKey: 'usSavingsAccount' }));

    close(out.cumulativeConsumption, 1_000);
  });
});

// ─── UNITS ────────────────────────────────────────────────────────────────────

describe('the penalty term is not in the same unit as the reward', () => {
  test('cumulativeDeficit accumulates RAW — no FX, no deflation', () => {
    const state = {
      cumulativeDeficit: 0, deficitMonths: 0,
      effectiveExchangeRates: { USD_AUD: 1.5 },
      inflationAccumulator:   { AU: 1.2, US: 1.2 },
    };
    const out = new AccumulateDeficitReducer()
      .reduce(state, makeAction('ACCUMULATE_DEFICIT', { amount: 3_600 }), DATE);

    // 3,600 in, 3,600 out. An AUD deficit and a USD deficit on the same run are
    // added together at face value, in nominal dollars.
    close(out.cumulativeDeficit, 3_600);
    assert.equal(out.deficitMonths, 1);
  });

  test('the same nominal AUD amount enters consumption as 2,000 and the deficit as 3,600', () => {
    const consumed = spend({ balance: 10_000, amount: 3_600, currency: 'AUD', rate: 1.5, priceLevel: 1.2 });
    const deficit  = new AccumulateDeficitReducer().reduce(
      { cumulativeDeficit: 0, deficitMonths: 0 },
      makeAction('ACCUMULATE_DEFICIT', { amount: 3_600 }), DATE);

    close(consumed.consumption,      2_000);   // real base-year USD
    close(deficit.cumulativeDeficit, 3_600);   // nominal, mixed-currency

    // Design 89 §5.2: an objective that adds a reward in one unit to a penalty in
    // another cannot be reasoned about by re-weighting them. This is recorded as
    // scope belonging to the objective work, NOT to design 89 — see §5.2's last
    // bullet before changing anything here.
    assert.ok(deficit.cumulativeDeficit !== consumed.consumption,
      'the two accumulators are in different units — this is the finding, not a bug in the test');
  });
});

// ─── PRICE LEVEL (design 89 §5.6, step E) ─────────────────────────────────────

describe('the deflator comes from the emitter, not from the account currency', () => {
  test('a stamped priceLevel overrides the currency-derived one', () => {
    // The account is USD, so the old code would have deflated by inflationAccumulator.US.
    // The emitter says this money was incurred at a level of 4 (an AU-indexed property
    // cost paid from a US account, say), and the emitter wins.
    const state = {
      cumulativeConsumption: 0,
      usSavingsAccount: { currency: { code: 'USD' } },
      inflationAccumulator: { US: 2, AU: 4 },
    };
    const out = new AccumulateConsumptionReducer().reduce(state,
      makeAction('EXPENSE_DEBIT', { amount: 2_000, targetKey: 'usSavingsAccount', priceLevel: 4 }));

    close(out.cumulativeConsumption, 500);   // 2000 / 4, NOT 2000 / 2
  });

  test('currency still comes from the account — the two axes are independent', () => {
    // AUD account (so FX applies) but a US-indexed price level: both must be honoured,
    // which is only possible because they are read from different places.
    const state = {
      cumulativeConsumption: 0,
      auSavingsAccount: { currency: { code: 'AUD' } },
      effectiveExchangeRates: { USD_AUD: 1.5 },
      inflationAccumulator: { US: 2, AU: 4 },
    };
    const out = new AccumulateConsumptionReducer().reduce(state,
      makeAction('EXPENSE_DEBIT', { amount: 3_000, targetKey: 'auSavingsAccount', priceLevel: 2 }));

    close(out.cumulativeConsumption, 1_000);   // 3000 AUD /1.5 = 2000 USD /2 = 1000 real
  });

  test('an unstamped action still falls back to the account currency', () => {
    // Hand-dispatched EXPENSE_DEBITs (accumulate-reducers.test.mjs, crra-objective.test.mjs)
    // carry no priceLevel. Pinned so removing the fallback is deliberate.
    const state = {
      cumulativeConsumption: 0,
      auSavingsAccount: { currency: { code: 'AUD' } },
      effectiveExchangeRates: { USD_AUD: 1.5 },
      inflationAccumulator: { AU: 1.2 },
    };
    const out = new AccumulateConsumptionReducer().reduce(state,
      makeAction('EXPENSE_DEBIT', { amount: 1_800, targetKey: 'auSavingsAccount' }));

    close(out.cumulativeConsumption, 1_000);
  });

  test('the CRRA companion honours the stamped level too', () => {
    // Same money, same account, DIFFERENT stamped index. If the utility reducer had
    // been left reading the currency-derived level it would score these identically —
    // which is precisely the drift that made step D a two-file fix.
    const state = () => ({
      cumulativeConsumptionUtility: 0,
      usSavingsAccount: { currency: { code: 'USD' } },
      inflationAccumulator: { US: 2 },
    });
    const r = new AccumulateConsumptionUtilityReducer();
    const cheap = r.reduce(state(), makeAction('EXPENSE_DEBIT',
      { amount: 2_000, targetKey: 'usSavingsAccount', priceLevel: 2 }));   // 1000 real
    const dear  = r.reduce(state(), makeAction('EXPENSE_DEBIT',
      { amount: 2_000, targetKey: 'usSavingsAccount', priceLevel: 8 }));   // 250 real

    close(cheap.cumulativeConsumptionUtility, AccumulateConsumptionUtilityReducer.utility(1_000));
    close(dear.cumulativeConsumptionUtility,  AccumulateConsumptionUtilityReducer.utility(250));
    assert.ok(dear.cumulativeConsumptionUtility < cheap.cumulativeConsumptionUtility,
      'the same nominal spend buys less real consumption at a higher price level');
  });
});

describe('blendExpensePriceLevel: the harmonic mean, and why not the arithmetic one', () => {
  test('a single component returns that component\'s level unchanged', () => {
    close(blendExpensePriceLevel(1_000 / 2, 1_000), 2);
  });

  test('two components blend so the deflated total is EXACT', () => {
    // 600 at level 2 (=300 real) + 400 at level 4 (=100 real) => 400 real of 1000 nominal.
    const deflated = 600 / 2 + 400 / 4;
    const blend    = blendExpensePriceLevel(deflated, 1_000);

    close(1_000 / blend, deflated);   // the property that makes it correct
    close(blend, 2.5);                // harmonic: 1000/400

    // The arithmetic mean would be 0.6*2 + 0.4*4 = 2.8, giving 357.1 real — a 10.7%
    // understatement of real consumption that no single-property test could catch.
    assert.ok(Math.abs(1_000 / 2.8 - deflated) > 40);
  });

  test('a zero or absent debit is a no-op level of 1, never a divide-by-zero', () => {
    close(blendExpensePriceLevel(0, 0), 1);
    close(blendExpensePriceLevel(0, 1_000), 1);
    assert.ok(Number.isFinite(blendExpensePriceLevel(0, 1_000)));
  });
});

describe('residencePriceLevel: the axis InflationAdjustReducer actually uses', () => {
  const state = {
    people: { p1: { residency: 'AU' } },
    inflationAccumulator: { US: 2, AU: 4 },
  };

  test('reads the RESIDENCE country, not a currency', () => {
    close(residencePriceLevel(state), 4);
  });

  test('US residence reads the US level', () => {
    close(residencePriceLevel({ ...state, people: { p1: { residency: 'US' } } }), 2);
  });

  test('missing people or accumulator degrades to 1 rather than NaN', () => {
    close(residencePriceLevel({}), 1);
    close(residencePriceLevel({ people: { p1: { residency: 'AU' } } }), 1);
  });
});
