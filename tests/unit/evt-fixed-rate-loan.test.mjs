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
 *   FRL-11: §6.1 — at a constant Prime a variable P&I loan pays its authored payment,
 *           exactly, and a loan whose rate does not follow Prime gets no schedule.
 *   FRL-12: §6.1 — a variable P&I loan re-amortises when Prime moves and still retires
 *           at maturity, up or down; without a maturity the authored payment is held.
 *   FRL-13: §6.1 — the anchored post-IO payment re-amortises from the SCHEDULED balance,
 *           so a rate cut no longer leaves a balloon at maturity.
 *   FRL-14: §6.1 — an offset still shortens the loan across a reset: the schedule does
 *           not follow the actual balance.
 *   FRL-15: Q5 — on an AU loan (tax period from 1 July) the extra-repayment cap and the
 *           break cost count months to the 1 July boundary the engine enforces, in
 *           both halves of the year; a US loan is unchanged.
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
  resolveLoanRate, effectivePrincipal, loanBreakCost, synthesizeLoanForProperty, capFixedExtraRepayment,
  findLoansForProperty, resolvePaymentSchedule, PAYMENT_SCHEDULE_PHASE, loanClock,
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
  const fp = loan({ rateType: FIXED_PERIOD, fixedRateUntil: '2031-01-01', primeSpread: 0.025 });
  assert.equal(resolveLoanRate(withClock({}, 2030, 0.05), fp), 0.06);
  assert.ok(Math.abs(resolveLoanRate(withClock({}, 2031, 0.05), fp) - 0.075) < 1e-12);
  // No Prime configured: the absolute revert rate.
  const noPrime = { currentPeriods: { AU: { startMs: yearMs(2032) } } };
  assert.equal(resolveLoanRate(noPrime, loan({ rateType: FIXED_PERIOD, fixedRateUntil: '2031-01-01',
    revertInterestRate: 0.068 })), 0.068);
  // No Fixed Until Year: fixed for life.
  assert.equal(resolveLoanRate(withClock({}, 2090, 0.09), loan({ rateType: FIXED_PERIOD })), 0.06);
});

// ── FRL-2 ────────────────────────────────────────────────────────────────────

test('FRL-2: a US 30-year fixed loan ignores a Prime hike; a variable loan pays it', () => {
  const primeAt = (y) => (y < 2032 ? 0.04 : 0.07);
  const base = { interestRate: 0.06, monthlyPayment: 3_000, country: 'US', currency: USD };
  const fixed = runMonths({ hLoan: loan({ ...base, rateType: FIXED, maturityDate: '2056-01-01' }), cash: cash() },
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
  const l = loan({ rateType: FIXED_PERIOD, interestRate: 0.055, fixedRateUntil: '2033-01-01',
                   primeSpread: 0.03, maturityDate: '2055-01-01', monthlyPayment: 3_200 });
  const primeAt = () => 0.04;                       // revert rate = 7%
  const { state, payments } = runMonths({ hLoan: l, cash: cash() }, 2030, 5 * 12, { primeAt });

  const before = payments.filter(p => p.year < 2033);
  const after  = payments.filter(p => p.year >= 2033);
  for (const p of before) assert.equal(p.payment, 3_200);

  // The anchor is the balance on the first payment of 2033.
  assert.ok(state.hLoan.postFixedPrincipal > 0);
  assert.equal(state.hLoan.postFixedFromMonth, 2033 * 12, 'the month index of that payment');
  const i = 0.07 / 12, n = (2055 - 2033) * 12;
  const expected = state.hLoan.postFixedPrincipal * i / (1 - Math.pow(1 + i, -n));
  for (const p of after) assert.ok(Math.abs(p.payment - expected) < 1e-6, `${p.payment} vs ${expected}`);
  // And it is a step-up: 7% over the remaining term costs more than 3,200.
  assert.ok(expected > 3_200);
});

// ── FRL-4 ────────────────────────────────────────────────────────────────────

test('FRL-4: no offset inside a fixed window unless allowed; it returns when the window ends', () => {
  const fp = { rateType: FIXED_PERIOD, fixedRateUntil: '2032-01-01', primeSpread: 0.02 };
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
                           fixedRateUntil: '2033-01-01' });
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
  const l = loan({ rateType: FIXED_PERIOD, fixedRateUntil: '2035-01-01', maturityDate: '2055-01-01',
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
  const l = loan({ rateType: FIXED_PERIOD, interestRate: 0.06, fixedRateUntil: '2033-01-01',
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
  // The sale's own date decides whether the window is over (design 117: the month clock).
  assert.equal(loanBreakCost(withClock({}, 2033, 0.03), l, new Date(Date.UTC(2033, 0, 15))).amount, 0,
    'window over: no fee');
  assert.equal(loanBreakCost(withClock({}, 2030, 0.03), { ...l, breakCostOnPayoff: false }, date).amount, 0);
  // A FIXED loan's window ends at maturity; without one there is nothing to price.
  assert.equal(loanBreakCost(withClock({}, 2030, 0.03), { ...l, rateType: FIXED }, date).amount, 0);
  assert.ok(loanBreakCost(withClock({}, 2030, 0.03), { ...l, rateType: FIXED, maturityDate: '2050-01-01' }, date).amount > fell.amount);
});

// ── FRL-8 ────────────────────────────────────────────────────────────────────

test('FRL-8: a sale discharges every loan on the property and pays the break cost', () => {
  const variable = loan({ stateKey: 'auHouseLoan', linkedPropertyKey: 'auHouse', balance: 300_000,
                          rateType: VARIABLE, primeSpread: 0.02 });
  const fixedPart = loan({ stateKey: 'auFixedLoan', linkedPropertyKey: 'auHouse', balance: 200_000,
                           rateType: FIXED_PERIOD, interestRate: 0.06, fixedRateUntil: '2033-01-01',
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
  const terms = { rateType: FIXED_PERIOD, fixedRateUntil: '2031-01-01', revertInterestRate: 0.07,
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
  assert.equal('fixedRateUntil' in synthesized, false);
  const legacy = synthesizeLoanForProperty({ stateKey: 'h', mortgageBalance: 1, country: 'AU' });
  assert.equal('rateType' in legacy, false);

  // The property record's own save/load, and a legacy property writes none of the fields.
  const prop = ScenarioSerializer._makeRealProperty({ stateKey: 'h', value: 1, country: 'AU',
    mortgageRateType: FIXED_PERIOD, mortgageFixedRateUntil: '2031-01-01', mortgageOffsetWhileFixed: false });
  const saved = ScenarioSerializer._serializeRealProperty(prop);
  assert.equal(saved.mortgageRateType, FIXED_PERIOD);
  assert.equal(saved.mortgageOffsetWhileFixed, false, 'false is a real answer and must survive');
  const reloaded = ScenarioSerializer._makeRealProperty(saved);
  assert.equal(reloaded.mortgageFixedRateUntil, '2031-01-01');
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
        // A real AU plan: its terms end on 1 July, the day the AU period year turns.
        mortgageMaturityDate: '2050-07-01',
        mortgageRateType: FIXED_PERIOD, mortgageFixedRateUntil: '2028-07-01', mortgagePrimeSpread: 0.03,
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
  assert.equal(l.postFixedFromMonth, 2028 * 12 + 6, 'the post-fixed anchor was taken at the July 2028 payment');
});

// ── FRL-11 … FRL-14: payment reset when the rate moves (§6.1) ─────────────────

/** Level monthly payment, the textbook formula. */
const pmt = (p, r, n) => { const i = r / 12; return p * i / (1 - Math.pow(1 + i, -n)); };

/** A variable P&I loan at Prime 4% + 2% = 6%, paying exactly the 25-year schedule to 2055. */
const variablePI = (overrides = {}) => loan({
  rateType: VARIABLE, interestRate: 0, primeSpread: 0.02, maturityDate: '2055-01-01',
  monthlyPayment: pmt(500_000, 0.06, 300), ...overrides,
});

test('FRL-11: at a constant Prime the authored payment is paid exactly; a fixed loan has no schedule', () => {
  const l = variablePI({ monthlyPayment: 3_500 });
  const { state, payments } = runMonths({ hLoan: l, cash: cash() }, 2030, 60);
  for (const p of payments) assert.equal(p.payment, 3_500);
  const s = state.hLoan.paymentSchedule;
  assert.equal(s.phase, PAYMENT_SCHEDULE_PHASE.PLAIN);
  assert.equal(s.fromMonth, 2030 * 12, 'stamped once, by the first payment');
  assert.equal(s.months, 300);
  assert.ok(Math.abs(s.extra - (3_500 - pmt(500_000, 0.06, 300))) < 1e-9);

  // Not following Prime ⇒ nothing stamped: FIXED, a spread-less legacy loan, inside a
  // fixed window, and a variable loan with no maturity.
  const s0 = withClock({}, 2030, 0.04);
  for (const other of [
    loan({ rateType: FIXED, maturityDate: '2055-01-01' }),
    loan({ maturityDate: '2055-01-01' }),
    loan({ rateType: FIXED_PERIOD, fixedRateUntil: '2033-01-01', primeSpread: 0.02, maturityDate: '2055-01-01' }),
    variablePI({ maturityDate: null }),
  ]) {
    assert.equal(resolvePaymentSchedule(s0, other, 500_000, 0.06, 2030 * 12, new Date(Date.UTC(2030, 0, 15))), null);
  }
});

test('FRL-12: a variable P&I loan re-amortises when Prime moves and still retires at maturity', () => {
  for (const [label, after] of [['rise', 0.06], ['cut', 0.02]]) {
    const primeAt = (y) => (y < 2040 ? 0.04 : after);
    const { state, payments } = runMonths({ hLoan: variablePI(), cash: cash() }, 2030, 25 * 12, { primeAt });
    const before = payments.filter(p => p.year < 2040);
    const reset  = payments.filter(p => p.year >= 2040);
    for (const p of before) assert.ok(Math.abs(p.payment - pmt(500_000, 0.06, 300)) < 1e-9);
    // The new level: the 10-year scheduled balance over the 15 years left, at the new rate.
    const b10 = 500_000 * Math.pow(1.005, 120) - pmt(500_000, 0.06, 300) * (Math.pow(1.005, 120) - 1) / 0.005;
    const expected = pmt(b10, after + 0.02, 180);
    for (const p of reset.slice(0, -1)) assert.ok(Math.abs(p.payment - expected) < 1e-6, `${label}: ${p.payment} vs ${expected}`);
    // Retired by maturity: at most cents left entering 2055 (the reducer rounds to cents).
    assert.ok(state.hLoan.balance < 5, `${label}: ${state.hLoan.balance} left at maturity`);
  }

  // No maturity: nothing to amortise against, the authored payment is held.
  const primeAt = (y) => (y < 2032 ? 0.04 : 0.07);
  const { payments } = runMonths({ hLoan: variablePI({ maturityDate: null, monthlyPayment: 3_300 }),
    cash: cash() }, 2030, 48, { primeAt });
  for (const p of payments) assert.equal(p.payment, 3_300);
});

test('FRL-13: the post-IO payment re-amortises from the scheduled balance — no balloon after a cut', () => {
  const io = loan({ rateType: VARIABLE, interestRate: 0, primeSpread: 0.02, interestOnly: true,
                    interestOnlyUntil: '2030-01-01', postIoPrincipal: 500_000, maturityDate: '2055-01-01',
                    monthlyPayment: 0 });
  const primeAt = (y) => (y < 2040 ? 0.04 : 0.02);
  const { state, payments } = runMonths({ hLoan: io, cash: cash() }, 2030, 25 * 12, { primeAt });
  // The pre-§6.1 formula paid pmt(500k, 4%, 300) from 2040 and left ~$45k for the balloon.
  const old = pmt(500_000, 0.04, 300);
  assert.ok(payments.find(p => p.year === 2040).payment > old + 100);
  assert.ok(state.hLoan.balance < 5, `${state.hLoan.balance} left at maturity`);
});

test('FRL-14: an offset still shortens the loan across a reset', () => {
  const primeAt = (y) => (y < 2035 ? 0.04 : 0.06);
  const withOffset = { hLoan: variablePI(), cash: cash(), off: offset(250_000) };
  const { state, payments } = runMonths(withOffset, 2030, 25 * 12, { primeAt });
  // The payment tracks the schedule, not the (offset-accelerated) balance: level between
  // resets, and the loan is gone years before 2055.
  const reset = payments.filter(p => p.year >= 2035);
  const level = reset[0].payment;
  for (const p of reset.slice(0, -1)) assert.equal(p.payment, level);
  assert.equal(state.hLoan.balance, 0);
  assert.ok(payments.at(-1).year < 2050, `retired in ${payments.at(-1).year}`);
});

test('FRL-15: AU month counts run to the 1 July boundary the tax period enforces', () => {
  // The AU financial year that started 1 July 2029; the US year is the calendar one.
  const clock = (auStartYear, usYear, prime) => ({
    currentPeriods: { AU: { startMs: Date.UTC(auStartYear, 6, 1) }, US: { startMs: yearMs(usYear) } },
    effectiveInterestRates: { PRIME_US: prime, PRIME_AU: prime },
  });
  const jan = new Date(Date.UTC(2030, 0, 15));        // AU period year 2029
  const aug = new Date(Date.UTC(2029, 7, 15));        // AU period year 2029

  // Break cost: the window ends when the period year reaches 2033, i.e. 1 July 2033.
  // The window ends on 1 July 2033 — the date an AU term year always meant (design 117).
  const l = loan({ rateType: FIXED_PERIOD, interestRate: 0.06, fixedRateUntil: '2033-07-01',
                   breakCostOnPayoff: true, fixedAtPrimeRate: 0.05 });
  const s = clock(2029, 2030, 0.03);
  assert.equal(loanBreakCost(s, l, jan).months, 42, 'Jan 2030 → Jul 2033');
  assert.equal(loanBreakCost(s, l, aug).months, 47, 'Aug 2029 → Jul 2033');
  // A US loan's window still ends on 1 January.
  const us = { ...l, country: 'US', currency: USD, fixedRateUntil: '2033-01-01' };
  assert.equal(loanBreakCost(s, us, jan).months, 36);

  // Extra cap: the schedule it measures "extra" against runs to 1 July of the maturity year.
  const capped = loan({ rateType: FIXED_PERIOD, fixedRateUntil: '2035-07-01', maturityDate: '2055-07-01',
                        fixedExtraRepaymentCap: 1e9 });
  const { extra } = capFixedExtraRepayment(capped, 5_000, 500_000, 0.06, loanClock(s, capped, jan), jan, s);
  assert.ok(Math.abs(extra - (5_000 - pmt(500_000, 0.06, 2055 * 12 + 6 - (2030 * 12)))) < 1e-9);
  // Without a state the date still says when the term ends: there is no hidden convention
  // to fall back on any more (design 117 closed design 113 Q6), so the count is the same.
  const bare = capFixedExtraRepayment(capped, 5_000, 500_000, 0.06, 2030 * 12, jan).extra;
  assert.ok(Math.abs(bare - extra) < 1e-9);
});

// ── FRL-16/17 — design 117 phase 5: loan terms are dates ────────────────────

test('FRL-16: a mid-year IO end takes effect with that month\'s payment, not at a year boundary', () => {
  // A US loan, interest-only until 20 May 2031: Jan–Apr pay interest only, May steps up.
  const io = loan({ country: 'US', currency: USD, interestOnly: true, interestOnlyUntil: '2031-05-20',
                    postIoPrincipal: 500_000, maturityDate: '2051-05-20', monthlyPayment: 0 });
  const { payments } = runMonths({ hLoan: io, cash: cash() }, 2031, 8);
  const interestOnly = payments.filter(p => p.month < 4);
  const amortising   = payments.filter(p => p.month >= 4);
  for (const p of interestOnly) assert.ok(Math.abs(p.payment - p.interest) < 1e-9, `IO in month ${p.month}`);
  for (const p of amortising)   assert.ok(p.payment > p.interest + 1, `P&I from May, month ${p.month}`);
  // Re-amortised over the 240 months from May 2031 to May 2051.
  assert.ok(Math.abs(amortising[0].payment - pmt(500_000, 0.06, 240)) < 1e-6);
});

test('FRL-17: an AU loan can now end a fixed period on 1 January (design 113 Q6, closed)', () => {
  // A real AU tax year (from 1 July 2029). As a YEAR, "2030" ended an AU fixed period on
  // 1 July 2030; as a date the author can say 1 January 2030 and mean it.
  const s = {
    currentPeriods: { AU: { startMs: Date.UTC(2029, 6, 1) }, US: { startMs: yearMs(2030) } },
    effectiveInterestRates: { PRIME_AU: 0.04, PRIME_US: 0.04 },
  };
  const fp = loan({ rateType: FIXED_PERIOD, interestRate: 0.055, primeSpread: 0.03, fixedRateUntil: '2030-01-01' });
  const dec = new Date(Date.UTC(2029, 11, 31)), jan = new Date(Date.UTC(2030, 0, 31));
  assert.equal(resolveLoanRate(s, fp, loanClock(s, fp, dec)), 0.055, 'December: still fixed');
  assert.ok(Math.abs(resolveLoanRate(s, fp, loanClock(s, fp, jan)) - 0.07) < 1e-12, 'January: Prime + 3%');
  // And a migrated AU year still ends on 1 July — the day it always did.
  const migrated = loan({ rateType: FIXED_PERIOD, interestRate: 0.055, primeSpread: 0.03, fixedRateUntil: '2030-07-01' });
  assert.equal(resolveLoanRate(s, migrated, loanClock(s, migrated, jan)), 0.055);
});
