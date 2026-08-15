/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * evt-tax-payment-section-988.test.mjs — design 87 §14.4 item 1 (G12).
 *
 * Paying a tax bill out of a foreign-currency deposit disposes of nonfunctional
 * currency, and it is the ONE place `§988(e)(3)(B)`'s carve-out bites: §988(e)(3)
 * adopts §212 "other than that part of section 212 dealing with expenses incurred in
 * connection with taxes", so the disposition is PERSONAL — capital, with the \$200
 * exclusion — even on an account whose every other expense is unambiguously §212.
 * That is what the per-disposition `businessFraction` was built for, and until now
 * nothing exercised it.
 *
 *   TAX988-1  an AU tax payment out of an AUD pool realizes, with the sign the FX implies.
 *   TAX988-2  CONTROL — the same payment at an unmoved basis rate realizes nothing.
 *   TAX988-3  G12 — the carve-out overrides a fully-§212 account, plus its control.
 *   TAX988-4  a personal LOSS is disallowed outright, and the \$200 floor does not reach it.
 *   TAX988-5  US tax out of a USD pool realizes nothing — functional currency is never §988.
 *   TAX988-6  a same-bracket top-up must not hide the GROSS disposition (the `units` axis).
 *   TAX988-7  end-to-end: a real AU FY settle reaches the JOURNAL, plus its zero control.
 *
 * Run with: node --test tests/unit/evt-tax-payment-section-988.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { AuTaxPaymentDebitReducer, UsTaxPaymentDebitReducer }
  from '../../src/finance/tax/tax-settle-classes.js';
import { createCurrencyLotObserver } from '../../src/finance/account-rules/currency-lot-observer.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { ALLOCATION }     from '../../src/finance/holdings/allocation.js';
import { ACCOUNT_ROLES }  from '../../src/finance/state/account-roles.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }    from '../../src/index.js';

beforeEach(() => ServiceRegistry.resetAll());

// AUD per USD, matching `effectiveExchangeRates.USD_AUD`: a HIGHER number is a WEAKER
// AUD, so holding AUD across a rise is a loss to a USD taxpayer.
const STRONG = 1.30;
const WEAK   = 1.55;

const DATE = new Date('2030-06-30');

/** A deposit: one CASH sleeve, which is what `isCurrencyLotPool` accepts. */
function deposit({ stateKey, balance, currency = 'AUD', country = 'AU', role, ...rest }) {
  return {
    id: stateKey, stateKey, country, role,
    currency: { code: currency, symbol: '$' },
    balance,
    holdings: [{ id: `${stateKey}-cash`, allocation: ALLOCATION.CASH,
                 marketValue: balance, costBasis: balance }],
    minimumBalance: 0,
    ownerId: 'primary',
    ...rest,
  };
}

function makeState({ rate = WEAK, accounts = [] } = {}) {
  const state = {
    effectiveExchangeRates: { USD_AUD: rate },
    people: { primary: { id: 'primary', residency: 'AU', birthDate: new Date('1966-01-01') } },
  };
  for (const a of accounts) state[a.stateKey] = a;
  return state;
}

function makeReducer(Reducer, stateKey) {
  return new Reducer({
    accountService: new AccountService(),
    stateRegistry: { getStateKey: () => stateKey, getFlaggedStateKey: () => null },
  });
}

/**
 * Run one tax-payment debit inside an observer bracket — the same bracket
 * `simulation.js` puts around every reducer — and return what the observer emitted.
 *
 * Bracketing the REAL reducer rather than hand-rolling an action is the point: the
 * declaration has to survive the reducer's own control flow (the absent-account early
 * return, the replenish top-up, the cap to available balance) to reach the observer.
 */
function payTax(reducer, state, action, { observer = createCurrencyLotObserver() } = {}) {
  const token = observer.before(state);
  const result = reducer.reduce(state, action, DATE);
  if (result?.state) Object.assign(state, result.state);
  const emitted = observer.after(state, token, action, DATE);
  return { emitted, result, observer };
}

const round = (n) => Math.round(n * 100) / 100;

// ══════════════════════════════════════════════════════════════════════════════

test('TAX988-1 an AU tax payment out of an AUD pool realizes §988', () => {
  // 10,000 AUD acquired at 1.30 carries 7,692.31 USD of basis. Paid at 1.55 it
  // discharges only 6,451.61 USD of liability — a real economic loss of 1,240.69.
  const state = makeState({
    rate: WEAK,
    accounts: [deposit({ stateKey: 'auSavingsAccount', balance: 60000,
                         role: ACCOUNT_ROLES.AU_SAVINGS, fxBasisRate: STRONG })],
  });
  const r = makeReducer(AuTaxPaymentDebitReducer, 'auSavingsAccount');

  const { emitted } = payTax(r, state, { type: 'AU_TAX_PAYMENT_DEBIT', amount: 10000 });

  assert.equal(emitted.length, 1, 'exactly one disposition');
  const expected = 10000 / WEAK - 10000 / STRONG;
  assert.ok(Math.abs(emitted[0].gross - expected) < 0.01,
    `gross ${emitted[0].gross} should be ${expected}`);
  assert.ok(emitted[0].gross < 0, 'a weakening AUD is a loss to a USD taxpayer');
  assert.equal(emitted[0].accountKey, 'auSavingsAccount');
  assert.equal(emitted[0].currency, 'AUD');
  assert.equal(round(state.auSavingsAccount.balance), 50000, 'the tax was actually paid');
});

test('TAX988-2 CONTROL — the same payment at an unmoved basis rate realizes nothing', () => {
  // Design 87 §7 trap 5: an FX-pinned run is not a zero control unless the ACQUISITION
  // rate is pinned to it too, because §988 measures acquisition → disposition rather
  // than the rate of change. Without this row TAX988-1 would pass equally well against
  // an emitter that fired on everything.
  const state = makeState({
    rate: WEAK,
    accounts: [deposit({ stateKey: 'auSavingsAccount', balance: 60000,
                         role: ACCOUNT_ROLES.AU_SAVINGS, fxBasisRate: WEAK })],
  });
  const r = makeReducer(AuTaxPaymentDebitReducer, 'auSavingsAccount');

  const { emitted } = payTax(r, state, { type: 'AU_TAX_PAYMENT_DEBIT', amount: 10000 });

  assert.deepEqual(emitted, [], 'basis rate == disposition rate ⇒ no gain to book');
  assert.equal(round(state.auSavingsAccount.balance), 50000, 'the tax was still paid');
});

test('TAX988-3 G12 — a tax payment is PERSONAL even on a fully-§212 account', () => {
  // The account is declared 100% income-producing: `currencyPoolBusinessFraction` reads
  // 1 off it, and every other disposition from this pool would be ordinary §988. The
  // carve-out says this one is not.
  const auAccount = () => deposit({
    stateKey: 'auSavingsAccount', balance: 60000, role: ACCOUNT_ROLES.AU_SAVINGS,
    fxBasisRate: WEAK, deductibleFraction: 1,
  });
  // AUD STRENGTHENS (1.55 → 1.30), so this is a GAIN — the direction where ordinary and
  // capital actually diverge. A loss would be disallowed either way and prove nothing.
  const state = makeState({ rate: STRONG, accounts: [auAccount()] });
  const r = makeReducer(AuTaxPaymentDebitReducer, 'auSavingsAccount');

  const { emitted } = payTax(r, state, { type: 'AU_TAX_PAYMENT_DEBIT', amount: 10000 });

  assert.equal(emitted.length, 1);
  assert.ok(emitted[0].gross > 0, 'a strengthening AUD is a gain');
  assert.equal(emitted[0].amount, 0,
    'nothing ordinary: §988(e)(3)(B) carves tax out of §212');
  assert.ok(emitted[0].capitalGain > 0,
    `the whole gain is capital, got ${emitted[0].capitalGain}`);
  assert.ok(Math.abs(emitted[0].capitalGain - emitted[0].gross) < 0.01);

  // ── the working-detector control ────────────────────────────────────────────
  // Same pool, same units, same rates — but a disposition that does NOT declare a
  // fraction, so the observer falls back to the account's scalar. It must book the
  // whole thing as ORDINARY. Without this the assertions above would pass just as well
  // against an observer that had lost the ability to book ordinary income at all, or
  // against an account whose `deductibleFraction` never reached the fallback.
  const control = makeState({ rate: STRONG, accounts: [auAccount()] });
  const obs = createCurrencyLotObserver();
  const token = obs.before(control);
  new AccountService().transaction(control.auSavingsAccount, -10000, DATE);
  const ctlEmitted = obs.after(control, token,
    { type: 'EXPENSE_DEBIT', section988: { kind: 'DISPOSE', accountKey: 'auSavingsAccount' } }, DATE);

  assert.equal(ctlEmitted.length, 1);
  assert.ok(ctlEmitted[0].amount > 0,
    'CONTROL: the same disposition WITHOUT the carve-out is ordinary §988');
  assert.equal(ctlEmitted[0].capitalGain, 0, 'CONTROL: and nothing falls to capital');
  assert.ok(Math.abs(ctlEmitted[0].gross - emitted[0].gross) < 0.01,
    'CONTROL: the AMOUNT is identical — only the character differs');
});

test('TAX988-4 a personal LOSS is disallowed outright — §165(c), Quijano', () => {
  const state = makeState({
    rate: WEAK,
    accounts: [deposit({ stateKey: 'auSavingsAccount', balance: 60000,
                         role: ACCOUNT_ROLES.AU_SAVINGS, fxBasisRate: STRONG,
                         deductibleFraction: 1 })],
  });
  const r = makeReducer(AuTaxPaymentDebitReducer, 'auSavingsAccount');

  const { emitted } = payTax(r, state, { type: 'AU_TAX_PAYMENT_DEBIT', amount: 10000 });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].amount, 0, 'no ordinary deduction — the carve-out cuts both ways');
  assert.equal(emitted[0].capitalGain, 0, 'a loss is not a capital GAIN');
  assert.ok(emitted[0].disallowedLoss > 0, 'it is disallowed, not merely deferred');
  // The asymmetry that costs real money: the \$200 floor is written for gain only.
  assert.equal(emitted[0].deMinimis, 0);
});

test('TAX988-5 a US tax payment out of a USD pool realizes nothing', () => {
  // The declaration is stamped by the shared base for both subclasses, deliberately. A
  // USD balance is the taxpayer's FUNCTIONAL currency and is never §988 property
  // (§988(c)(1)(C) reaches nonfunctional currency only), so `isCurrencyLotPool` never
  // tracks it and the stamp is inert — which is what makes stamping in the base safe.
  const state = makeState({
    rate: WEAK,
    accounts: [deposit({ stateKey: 'usSavingsAccount', balance: 60000, currency: 'USD',
                         country: 'US', role: ACCOUNT_ROLES.US_SAVINGS })],
  });
  const r = makeReducer(UsTaxPaymentDebitReducer, 'usSavingsAccount');

  const { emitted } = payTax(r, state, { type: 'US_TAX_PAYMENT_DEBIT', amount: 10000 });

  assert.deepEqual(emitted, []);
  assert.equal(round(state.usSavingsAccount.balance), 50000);
  // Stamped anyway, so a scenario that ever wires US_SAVINGS in a foreign currency is
  // right by default rather than silently understating.
  assert.equal(state.usSavingsAccount.fxBasisUsd, undefined, 'a USD pool is not tracked at all');
});

test('TAX988-6 a same-bracket top-up must not hide the GROSS disposition', () => {
  // `replenishSavings` runs INSIDE this reducer, so a short tax account is credited and
  // then debited within one observer bracket and only its NET movement is visible. Here
  // the net is zero — the top-up exactly funds the bill — so without the declared
  // `units` the disposition would vanish entirely. Under pro-rata a net movement is not
  // arithmetically equivalent to a credit followed by a debit, which is why the amount
  // has to be declared by the reducer that moved it (design 87 §6, §14.3 bug 3).
  const state = makeState({
    rate: WEAK,
    accounts: [
      deposit({ stateKey: 'auSavingsAccount', balance: 0,
                role: ACCOUNT_ROLES.AU_SAVINGS, fxBasisRate: STRONG }),
      // A sibling AUD pool the sweep can reach: same currency, so the top-up is a
      // `(a)(1)(iii)(E)` non-recognition transfer that CARRIES basis at 1.30.
      deposit({ stateKey: 'auOffsetAccount', balance: 40000, drawdownPriority: 1,
                role: ACCOUNT_ROLES.AU_SAVINGS, fxBasisRate: STRONG }),
    ],
  });
  const r = makeReducer(AuTaxPaymentDebitReducer, 'auSavingsAccount');

  const { emitted } = payTax(r, state, { type: 'AU_TAX_PAYMENT_DEBIT', amount: 10000 });

  assert.equal(round(state.auSavingsAccount.balance), 0, 'net movement on the tax pool is zero');
  assert.equal(round(state.auOffsetAccount.balance), 30000, 'the sibling funded it');
  assert.equal(emitted.length, 1, 'the disposition survives a zero net movement');
  // The carried basis is the SIBLING's 1.30, not the tax pool's own history, so the loss
  // is the full 10,000 AUD measured 1.30 → 1.55.
  const expected = 10000 / WEAK - 10000 / STRONG;
  assert.ok(Math.abs(emitted[0].gross - expected) < 0.01,
    `gross ${emitted[0].gross} should be ${expected} — basis carried at the sibling's rate`);
});

// ─── TAX988-7 · end to end ────────────────────────────────────────────────────────────

/**
 * A minimal AU-resident plan whose only income is AU savings interest, so an AU fiscal
 * year genuinely settles and the debit reducer genuinely runs. `auBasisRate` is the
 * pool's authored acquisition rate; leaving it null is the zero control (design 87 §10 —
 * an unstamped pool is stamped at spot and thereafter measures that rate against itself).
 */
function loadAuTaxScenario({ auBasisRate = null, rate = 1.55 } = {}) {
  const services = ServiceRegistry.getInstance();
  const config = {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_AU_CROSS_BORDER'],
    simStart: '2026-01-01', simEnd: '2028-01-01',
    parameters: {
      monthlyExpenses: 0, inflationAdjust: false, inflationRate: 0, auInflationRate: 0,
      rothGrowthRate: 0, iraGrowthRate: 0, k401GrowthRate: 0,
      brokerageGrowthRate: 0, brokerageDividendRate: 0, fixedIncomeInterestRate: 0,
      usSavingsInterestRate: 0, auSavingsInterestRate: 0.12,
      superGrowthRate: 0, auStockGrowthRate: 0, auStockDividendRate: 0,
      exchangeRateUsdToAud: rate, intlTransferFeeUsd: 0,
    },
    persons: [{
      __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1966-01-01',
      citizen: ['US', 'AU'], lifeExpectancy: 90, monthlyWage: 0,
      retirementDate: '2025-01-01', socialSecurityMonthly: 0,
    }],
    accounts: [
      { __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings',
        role: 'us-savings', stateKey: 'usSavingsAccount',
        initialValue: 1000, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' } },
      { __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings',
        role: 'au-savings', stateKey: 'auSavingsAccount',
        initialValue: 1000000, ownershipType: 'sole', ownerId: 'primary',
        minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: '$' },
        ...(auBasisRate != null ? { fxBasisRate: auBasisRate } : {}) },
    ],
  };
  const scenario = new BaseScenario({
    context: services.simulationContext,
    simStart: new Date(config.simStart), simEnd: new Date(config.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(structuredClone(config), services);
  scenario.sim.stepTo(new Date('2028-01-01'));
  return scenario.sim;
}

const journalOf = (sim, type) => sim.journal.journal
  .filter(e => e.action?.type === type)
  .map(e => e.action.data ?? e.action);

test('TAX988-7 an AU fiscal-year settle disposes currency, and it reaches the JOURNAL', () => {
  // The unit rows above bracket the reducer directly, which cannot see `pickPayload`.
  // This one runs a whole plan: two AU fiscal years settle, each debit disposes, and the
  // declaration has to be in the toolset's `fields` map or the journal shows nothing —
  // design 87 §7 trap 1, and the failure [[payload-manifest-gate-unwired]] records.
  const sim = loadAuTaxScenario({ auBasisRate: 1.20, rate: 1.55 });

  const debits = journalOf(sim, 'AU_TAX_PAYMENT_DEBIT');
  const gains  = journalOf(sim, 'SECTION_988_GAIN');
  assert.equal(debits.length, 2, 'two AU fiscal years settled');
  assert.equal(gains.length, 2, 'each tax payment disposed of currency');

  for (const d of debits) {
    assert.equal(d.section988?.kind, 'DISPOSE', 'the declaration survived pickPayload');
    assert.equal(d.section988.businessFraction, 0, 'G12: tax is carved out of §212');
    assert.ok(Math.abs(d.section988.units - d.amount) < 0.01, 'gross units == the debit');
  }
  // AUD acquired at 1.20 and spent at 1.55 buys fewer dollars than its basis, and the
  // whole loss is personal, so none of it is deductible.
  for (const g of gains) {
    assert.ok(g.gross < 0);
    assert.equal(g.amount, 0, 'no ordinary §988 deduction');
    assert.ok(g.disallowedLoss > 0, 'disallowed under §165(c), not deferred');
  }
});

test('TAX988-7b CONTROL — with no authored basis rate the same plan realizes nothing', () => {
  // Design 87 §10: an unstamped pool is stamped at the spot of its first movement and
  // thereafter measures that rate against itself, so it UNDERSTATES §988 rather than
  // inventing it. With FX pinned there is nothing else for a gain to come from, so this
  // proves TAX988-7's numbers are the authored basis doing work — not the emitter firing
  // on everything that moves.
  const sim = loadAuTaxScenario({ auBasisRate: null, rate: 1.55 });

  assert.equal(journalOf(sim, 'AU_TAX_PAYMENT_DEBIT').length, 2, 'the same two settles ran');
  assert.equal(journalOf(sim, 'SECTION_988_GAIN').length, 0,
    'basis rate == spot at every movement ⇒ nothing to realize');
});
