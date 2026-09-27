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
 * evt-fixed-rate-loan.test.mjs — design 113, fixed-rate loans, fixed periods and splits.
 *
 *   FRL-1: resolveLoanRate per rate type; a loan with no rate type resolves as before.
 *   FRL-2: a US 30-year FIXED loan does not move when Prime does; a variable one does.
 *   FRL-3: a FIXED_PERIOD P&I loan re-amortises at the revert rate when the period ends,
 *          anchored on the balance at expiry.
 *   FRL-4: the offset rule inside a fixed window, and a legacy loan keeps its offset.
 *   FRL-5: a split: the offset is counted once across the parts, fixed part excluded.
 *   FRL-6: the extra-repayment cap holds the year's extra principal to the cap.
 *   FRL-7: break cost — priced only inside the window, only when rates have fallen.
 *   FRL-8: a sale discharges every loan on the property and pays the break cost.
 *   FRL-9: the rate terms round-trip through the serializer, and onto a synthesized loan.
 *   FRL-10: end to end — an authored fixed-period mortgage reaches the running sim and
 *           pays its fixed rate, then the revert rate.
 *
 * Run with: node --test tests/unit/evt-fixed-rate-loan.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { USD, AUD, LoanAccount } from '../../src/finance/assets/account.js';
import {
  LoanPaymentHandler, LoanPaymentApplyReducer, LOAN_RATE_TYPE,
  resolveLoanRate, effectivePrincipal, loanBreakCost, synthesizeLoanForProperty,
  findLoansForProperty,
} from '../../src/finance/account-rules/loan-classes.js';
import { AuHouseSaleHandler, AuHouseSaleApplyReducer } from '../../src/finance/account-rules/au/au-real-property-classes.js';
import { loansForOffset } from '../../src/finance/pools/pool-metrics.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { makeAccount, makeServices } from '../helpers/reducer-fixtures.js';
import { loadScenarioSim } from '../helpers/scenario-harness.js';

const { VARIABLE, FIXED, FIXED_PERIOD } = LOAN_RATE_TYPE;

const yearMs = (y) => Date.UTC(y, 0, 1);

/** A state whose tax periods sit in `year`, with Prime set for both countries. */
function withClock(state, year, prime = 0.04) {
  return {
    ...state,
    currentPeriods: { US: { startMs: yearMs(year) }, AU: { startMs: yearMs(year) } },
    effectiveInterestRates: { PRIME_US: prime, PRIME_AU: prime },
  };
}

function loan(overrides = {}) {
  return {
    type: 'loan', kind: 'account', stateKey: 'hLoan', balance: 500_000,
    interestRate: 0.06, monthlyPayment: 3_000, linkedPropertyKey: 'h',
    country: 'AU', currency: AUD, minimumBalance: 0, drawdownPriority: null, holdings: [],
    paymentSourceKey: 'cash',
    ...overrides,
  };
}

function cash(balance = 5_000_000, overrides = {}) {
  return {
    type: 'savings', kind: 'account', stateKey: 'cash', balance,
    country: 'AU', currency: AUD, minimumBalance: 0, drawdownPriority: 1, holdings: [],
    ...overrides,
  };
}

function offset(balance) {
  return {
    type: 'offset', kind: 'account', stateKey: 'off', balance, offsetsPropertyKey: 'h',
    country: 'AU', currency: AUD, minimumBalance: 0, drawdownPriority: 2, holdings: [],
  };
}

/**
 * Drive monthly LOAN_PAYMENTs from January of `startYear` through the real handler and
 * reducer. `primeAt(year, month)` sets Prime; returns the final state and each payment.
 */
function runMonths(state, startYear, months, { primeAt = () => 0.04 } = {}) {
  const g = new Graph();
  const svc = new AccountService(g, new GraphQueryApi(g), new EventBus());
  const handler = new LoanPaymentHandler();
  const reducer = new LoanPaymentApplyReducer({ accountService: svc });
  const payments = [];
  for (let m = 0; m < months; m++) {
    const year = startYear + Math.floor(m / 12);
    const month = m % 12;
    state = withClock(state, year, primeAt(year, month));
    const date = new Date(Date.UTC(year, month, 15));
    for (const action of handler.call({ state, date })) {
      if (action.type !== 'LOAN_PAYMENT_APPLY') continue;
      payments.push({ year, month, loanKey: action.loanKey, payment: action.payment, interest: action.interest });
      const r = reducer.reduce(state, action);
      state = r.state ?? r;
    }
  }
  return { state, payments };
}

// ── FRL-1 ────────────────────────────────────────────────────────────────────

test('FRL-1: resolveLoanRate follows the rate type; no rate type resolves as before', () => {
  const s = withClock({}, 2030, 0.05);
  // Legacy: a spread makes it variable, none makes it fixed.
  assert.equal(resolveLoanRate(s, loan({ primeSpread: 0.02 })), 0.07);
  assert.equal(resolveLoanRate(s, loan({ primeSpread: null })), 0.06);
  // FIXED ignores Prime even when a spread is present.
  assert.equal(resolveLoanRate(s, loan({ rateType: FIXED, primeSpread: 0.02 })), 0.06);
  // VARIABLE is Prime + spread.
  assert.equal(resolveLoanRate(s, loan({ rateType: VARIABLE, primeSpread: 0.02 })), 0.07);
  // FIXED_PERIOD: the fixed rate before the year, the revert spread from it.
  const fp = loan({ rateType: FIXED_PERIOD, fixedRateUntilYear: 2031, primeSpread: 0.025 });
  assert.equal(resolveLoanRate(withClock({}, 2030, 0.05), fp), 0.06);
  assert.ok(Math.abs(resolveLoanRate(withClock({}, 2031, 0.05), fp) - 0.075) < 1e-12);
  // No Prime configured: the absolute revert rate.
  const noPrime = { currentPeriods: { AU: { startMs: yearMs(2032) } } };
  assert.equal(resolveLoanRate(noPrime, loan({ rateType: FIXED_PERIOD, fixedRateUntilYear: 2031,
    revertInterestRate: 0.068 })), 0.068);
  // No Fixed Until Year: fixed for life.
  assert.equal(resolveLoanRate(withClock({}, 2090, 0.09), loan({ rateType: FIXED_PERIOD })), 0.06);
});

// ── FRL-2 ────────────────────────────────────────────────────────────────────

test('FRL-2: a US 30-year fixed loan ignores a Prime hike; a variable loan pays it', () => {
  const primeAt = (y) => (y < 2032 ? 0.04 : 0.07);
  const base = { interestRate: 0.06, monthlyPayment: 3_000, country: 'US', currency: USD };
  const fixed = runMonths({ hLoan: loan({ ...base, rateType: FIXED, maturityYear: 2056 }), cash: cash() },
    2030, 48, { primeAt });
  const variable = runMonths({ hLoan: loan({ ...base, rateType: VARIABLE, interestRate: 0, primeSpread: 0.02 }),
    cash: cash() }, 2030, 48, { primeAt });

  const lastFixed = fixed.payments.at(-1);
  const lastVar   = variable.payments.at(-1);
  // Fixed: the interest is always balance × 6% / 12 — the hike never reaches it.
  assert.ok(Math.abs(lastFixed.interest / fixed.payments.at(-2).interest - 1) < 0.01);
  assert.ok(fixed.state.hLoan.balance < variable.state.hLoan.balance,
    'the variable loan pays 9% after the hike, so it amortises more slowly');
  // Variable interest in the last month is at 9%; fixed at 6%.
  assert.ok(lastVar.interest > lastFixed.interest * 1.4);
});

// ── FRL-3 ────────────────────────────────────────────────────────────────────

test('FRL-3: a fixed period ends in a re-amortised payment at the revert rate, anchored at expiry', () => {
  const l = loan({ rateType: FIXED_PERIOD, interestRate: 0.055, fixedRateUntilYear: 2033,
                   primeSpread: 0.03, maturityYear: 2055, monthlyPayment: 3_200 });
  const primeAt = () => 0.04;                       // revert rate = 7%
  const { state, payments } = runMonths({ hLoan: l, cash: cash() }, 2030, 5 * 12, { primeAt });

  const before = payments.filter(p => p.year < 2033);
  const after  = payments.filter(p => p.year >= 2033);
  for (const p of before) assert.equal(p.payment, 3_200);

  // The anchor is the balance on the first payment of 2033.
  assert.ok(state.hLoan.postFixedPrincipal > 0);
  assert.equal(state.hLoan.postFixedFromYear, 2033);
  const i = 0.07 / 12, n = (2055 - 2033) * 12;
  const expected = state.hLoan.postFixedPrincipal * i / (1 - Math.pow(1 + i, -n));
  for (const p of after) assert.ok(Math.abs(p.payment - expected) < 1e-6, `${p.payment} vs ${expected}`);
  // And it is a step-up: 7% over the remaining term costs more than 3,200.
  assert.ok(expected > 3_200);
});

// ── FRL-4 ────────────────────────────────────────────────────────────────────

test('FRL-4: no offset inside a fixed window unless allowed; it returns when the window ends', () => {
  const fp = { rateType: FIXED_PERIOD, fixedRateUntilYear: 2032, primeSpread: 0.02 };
  const at = (y, l) => withClock({ hLoan: l, off: offset(200_000) }, y);

  assert.equal(effectivePrincipal(at(2030, loan(fp)), 'hLoan', loan(fp)), 500_000);
  const allowed = loan({ ...fp, offsetWhileFixed: true });
  assert.equal(effectivePrincipal(at(2030, allowed), 'hLoan', allowed), 300_000);
  assert.equal(effectivePrincipal(at(2032, loan(fp)), 'hLoan', loan(fp)), 300_000);

  // A legacy spread-less loan is fixed in RATE but keeps its offset (no rate type).
  const legacy = loan();
  assert.equal(effectivePrincipal(at(2030, legacy), 'hLoan', legacy), 300_000);

  // The pool ceiling only counts loans the offset can currently reduce.
  const s = at(2030, loan(fp));
  assert.deepEqual(loansForOffset(s, s.off), []);
  assert.deepEqual(loansForOffset(at(2032, loan(fp)), offset(1)).map(l => l.stateKey), ['hLoan']);
});

// ── FRL-5 ────────────────────────────────────────────────────────────────────

test('FRL-5: a split counts the offset once — variable part first, fixed part excluded', () => {
  const variable = loan({ stateKey: 'hLoan', balance: 300_000, rateType: VARIABLE, primeSpread: 0.02 });
  const fixedPart = loan({ stateKey: 'hFixedLoan', balance: 200_000, rateType: FIXED_PERIOD,
                           fixedRateUntilYear: 2033 });
  const s = withClock({ hLoan: variable, hFixedLoan: fixedPart, off: offset(350_000) }, 2030);

  assert.deepEqual(findLoansForProperty(s, 'h').map(l => l.stateKey), ['hLoan', 'hFixedLoan']);
  // The variable part is fully offset; the fixed part takes none, so the other 50k is idle.
  assert.equal(effectivePrincipal(s, 'hLoan', variable), 0);
  assert.equal(effectivePrincipal(s, 'hFixedLoan', fixedPart), 200_000);

  // Allow offset on the fixed part too: the 50k left over reaches it, and no more.
  const allowed = { ...fixedPart, offsetWhileFixed: true };
  const s2 = { ...s, hFixedLoan: allowed };
  assert.equal(effectivePrincipal(s2, 'hLoan', variable), 0);
  assert.equal(effectivePrincipal(s2, 'hFixedLoan', allowed), 150_000);
});

// ── FRL-6 ────────────────────────────────────────────────────────────────────

test('FRL-6: extra repayments inside the fixed window are capped per calendar year', () => {
  // Scheduled P&I on 500k at 6% over ~25 years is ~3,220/month; paying 5,000 is ~1,780 extra.
  const l = loan({ rateType: FIXED_PERIOD, fixedRateUntilYear: 2035, maturityYear: 2055,
                   monthlyPayment: 5_000, fixedExtraRepaymentCap: 10_000 });
  const capped   = runMonths({ hLoan: l, cash: cash() }, 2030, 24);
  const uncapped = runMonths({ hLoan: { ...l, fixedExtraRepaymentCap: null }, cash: cash() }, 2030, 24);

  // The cap binds within each year, and resets in January.
  assert.equal(capped.state.hLoan.fixedExtraYear, 2031);
  assert.ok(Math.abs(capped.state.hLoan.fixedExtraYtd - 10_000) < 0.01);
  const y1 = capped.payments.filter(p => p.year === 2030);
  assert.equal(y1[0].payment, 5_000);                 // the first months are under the cap
  assert.ok(y1.at(-1).payment < 5_000);               // by December it has bitten
  // Uncapped pays roughly 2 × (21.4k − 10k) more extra principal over the two years, plus
  // the interest that extra principal no longer accrues — so a little over 22.8k.
  const gap = capped.state.hLoan.balance - uncapped.state.hLoan.balance;
  assert.ok(gap > 22_000 && gap < 27_000, `gap ${gap}`);
});

// ── FRL-7 ────────────────────────────────────────────────────────────────────

test('FRL-7: break cost — inside the window, when rates have fallen, and only if charged', () => {
  const l = loan({ rateType: FIXED_PERIOD, interestRate: 0.06, fixedRateUntilYear: 2033,
                   breakCostOnPayoff: true, fixedAtPrimeRate: 0.05 });
  const date = new Date(Date.UTC(2030, 0, 15));        // 36 months left in the window

  const fell = loanBreakCost(withClock({}, 2030, 0.03), l, date);
  assert.equal(fell.months, 36);
  assert.ok(Math.abs(fell.drop - 0.02) < 1e-12);
  // 500k × 2%/12 × annuity(36 months at the 4% re-lend rate).
  const i = 0.04 / 12;
  const expected = 500_000 * 0.02 / 12 * (1 - Math.pow(1 + i, -36)) / i;
  assert.ok(Math.abs(fell.amount - expected) < 0.01);

  assert.equal(loanBreakCost(withClock({}, 2030, 0.06), l, date).amount, 0, 'rates rose: no fee');
  assert.equal(loanBreakCost(withClock({}, 2033, 0.03), l, date).amount, 0, 'window over: no fee');
  assert.equal(loanBreakCost(withClock({}, 2030, 0.03), { ...l, breakCostOnPayoff: false }, date).amount, 0);
  // A FIXED loan's window ends at maturity; without one there is nothing to price.
  assert.equal(loanBreakCost(withClock({}, 2030, 0.03), { ...l, rateType: FIXED }, date).amount, 0);
  assert.ok(loanBreakCost(withClock({}, 2030, 0.03), { ...l, rateType: FIXED, maturityYear: 2050 }, date).amount > fell.amount);
});

// ── FRL-8 ────────────────────────────────────────────────────────────────────

test('FRL-8: a sale discharges every loan on the property and pays the break cost', () => {
  const variable = loan({ stateKey: 'auHouseLoan', linkedPropertyKey: 'auHouse', balance: 300_000,
                          rateType: VARIABLE, primeSpread: 0.02 });
  const fixedPart = loan({ stateKey: 'auFixedLoan', linkedPropertyKey: 'auHouse', balance: 200_000,
                           rateType: FIXED_PERIOD, interestRate: 0.06, fixedRateUntilYear: 2033,
                           breakCostOnPayoff: true, fixedAtPrimeRate: 0.05 });
  const savings = { ...makeAccount({ stateKey: 'auSavingsAccount', currency: 'AUD',
    holdings: [{ id: 'h', marketValue: 1_000, costBasis: 1_000 }] }) };
  let state = withClock({
    auSavingsAccount: savings,
    auHouse: { stateKey: 'auHouse', value: 900_000, mortgageBalance: 0, country: 'AU' },
    auHouseLoan: variable, auFixedLoan: fixedPart,
  }, 2030, 0.03);
  const date = new Date(Date.UTC(2030, 0, 15));

  const actions = new AuHouseSaleHandler().call({
    data: { stateKey: 'auHouse', salePrice: 900_000, costBasis: 500_000,
            saleDestinationAccount: 'auSavingsAccount' },
    state, date,
  });
  const apply = actions.find(a => a.type === 'AU_HOUSE_SALE_APPLY');
  assert.equal(apply.mortgageBalance, 500_000);
  assert.deepEqual(apply.loanKeys, ['auHouseLoan', 'auFixedLoan']);
  const expectedFee = loanBreakCost(state, fixedPart, date).amount;
  assert.ok(expectedFee > 0);
  assert.equal(apply.breakCost, expectedFee);
  // Both loans are snapshotted so neither chart freezes at its pre-sale balance.
  const snapped = actions.filter(a => a.type === 'RECORD_BALANCE').map(a => a.fieldPath);
  assert.ok(snapped.includes('auHouseLoan.balance') && snapped.includes('auFixedLoan.balance'));

  const next = new AuHouseSaleApplyReducer(makeServices()).reduce(state, apply, date);
  const after = next.state ?? next;
  assert.equal(after.auHouseLoan.balance, 0);
  assert.equal(after.auFixedLoan.balance, 0);
  assert.ok(Math.abs(after.auSavingsAccount.balance - (1_000 + 900_000 - 500_000 - expectedFee)) < 0.01);
});

// ── FRL-9 ────────────────────────────────────────────────────────────────────

test('FRL-9: the rate terms round-trip, and a mortgage carries them onto its loan', () => {
  const terms = { rateType: FIXED_PERIOD, fixedRateUntilYear: 2031, revertInterestRate: 0.07,
                  offsetWhileFixed: true, breakCostOnPayoff: true, fixedExtraRepaymentCap: 10_000,
                  fixedAtPrimeRate: 0.041 };
  const acct = new LoanAccount(400_000, { interestRate: 0.055, country: 'AU', ...terms });
  const back = ScenarioSerializer._makeAccount(ScenarioSerializer._serializeAccount(acct));
  for (const [k, v] of Object.entries(terms)) assert.equal(back[k], v, k);

  const synthesized = synthesizeLoanForProperty({
    stateKey: 'h', mortgageBalance: 300_000, mortgageInterestRate: 0.055, country: 'AU',
    mortgageRateType: FIXED, mortgageBreakCostOnPayoff: true,
  });
  assert.equal(synthesized.rateType, FIXED);
  assert.equal(synthesized.breakCostOnPayoff, true);
  // Unset terms are not projected at all, so a legacy mortgage's entry is unchanged.
  assert.equal('fixedRateUntilYear' in synthesized, false);
  const legacy = synthesizeLoanForProperty({ stateKey: 'h', mortgageBalance: 1, country: 'AU' });
  assert.equal('rateType' in legacy, false);

  // The property record's own save/load, and a legacy property writes none of the fields.
  const prop = ScenarioSerializer._makeRealProperty({ stateKey: 'h', value: 1, country: 'AU',
    mortgageRateType: FIXED_PERIOD, mortgageFixedRateUntilYear: 2031, mortgageOffsetWhileFixed: false });
  const saved = ScenarioSerializer._serializeRealProperty(prop);
  assert.equal(saved.mortgageRateType, FIXED_PERIOD);
  assert.equal(saved.mortgageOffsetWhileFixed, false, 'false is a real answer and must survive');
  const reloaded = ScenarioSerializer._makeRealProperty(saved);
  assert.equal(reloaded.mortgageFixedRateUntilYear, 2031);
  const plain = ScenarioSerializer._serializeRealProperty(
    ScenarioSerializer._makeRealProperty({ stateKey: 'h', value: 1, country: 'AU' }));
  assert.equal('mortgageRateType' in plain, false);
});

// ── FRL-10 ───────────────────────────────────────────────────────────────────

test('FRL-10: a fixed-period mortgage authored on a property reaches the running sim', () => {
  const { sim } = loadScenarioSim({
    telemetry: 'off',
    mutateCfg: (cfg) => {
      const p = cfg.realProperties.find(r => r.stateKey === 'auHouseProperty');
      Object.assign(p, {
        mortgageBalance: 400_000, mortgageInterestRate: 0.055, monthlyMortgage: 2_500,
        mortgageMaturityYear: 2050,
        mortgageRateType: FIXED_PERIOD, mortgageFixedRateUntilYear: 2028, mortgagePrimeSpread: 0.03,
      });
    },
  });
  sim.stepTo(new Date('2027-06-30'));
  const loanKey = 'auHousePropertyLoan';
  let l = sim.state[loanKey];
  assert.equal(l.rateType, FIXED_PERIOD);
  assert.equal(resolveLoanRate(sim.state, l), 0.055, 'inside the window: the fixed rate');
  assert.ok(l.fixedAtPrimeRate != null, 'Prime at fix stamped by the first payment');

  sim.stepTo(new Date('2029-06-30'));
  l = sim.state[loanKey];
  const prime = sim.state.effectiveInterestRates.PRIME_AU;
  assert.ok(Math.abs(resolveLoanRate(sim.state, l) - (prime + 0.03)) < 1e-12, 'after it: Prime + revert');
  assert.equal(l.postFixedFromYear, 2028, 'the post-fixed anchor was taken in the expiry year');
});
