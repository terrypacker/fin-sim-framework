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
 * early-withdrawal.test.mjs
 *
 * Tests for EW-1 through EW-9: early withdrawal drawdown via replenishSavings.
 *
 * EW-1  allowsEarlyWithdrawal flag defaults (Roth/IRA/401k=true, Super=false)
 * EW-2  Roth contribution drawdown — always accessible, no penalty, no tax
 * EW-3  Roth earnings drawdown  — 10% penalty if age < 59.5; AU ordinary income if resident
 * EW-4  IRA early drawdown      — US ordinary income + 10% penalty; AU ordinary income if resident
 * EW-5  401k early drawdown     — US ordinary income + 10% penalty; no AU tax
 * EW-6  Net cash to target      — penalty deducted from deposit, never credited
 * EW-7  pendingTaxActions       — returned and chainable by callers
 * EW-8  Rules from module       — getEarlyWithdrawalRules on UsAccountModule
 * EW-9  Super not eligible      — allowsEarlyWithdrawal false, never drawn early
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EventBus }          from '../../src/simulation-framework/event-bus.js';
import { Graph }             from '../../src/graph/graph.js';
import { GraphQueryApi }     from '../../src/graph/graph-query-api.js';
import { AccountService }    from '../../src/finance/services/account-service.js';
import { USD, AUD, CheckingAccount } from '../../src/finance/assets/account.js';
import {
  RothAccount, TraditionalIRAAccount, FourOhOneKAccount,
  SuperannuationAccount, BrokerageAccount,
} from '../../src/finance/assets/investment-account.js';
import { getUsEarlyWithdrawalRules }  from '../../src/finance/account-rules/us/us-early-withdrawal-rules.js';
import { UsAccountModule2026 }        from '../../src/finance/account-rules/us/us-account-module-2026.js';
import { ACCOUNT_TYPE }               from '../../src/finance/assets/account.js';

/** Builds a minimal AccountService (no graph wiring needed for unit tests). */
function makeSvc() {
  const graph = new Graph();
  return new AccountService(graph, new GraphQueryApi(graph), new EventBus());
}

// ══════════════════════════════════════════════════════════════════════════════
// EW-1: allowsEarlyWithdrawal defaults
// ══════════════════════════════════════════════════════════════════════════════

test('EW-1: RothAccount has allowsEarlyWithdrawal true by default', () => {
  assert.strictEqual(new RothAccount(0).allowsEarlyWithdrawal, true);
});

test('EW-1: TraditionalIRAAccount has allowsEarlyWithdrawal true by default', () => {
  assert.strictEqual(new TraditionalIRAAccount(0).allowsEarlyWithdrawal, true);
});

test('EW-1: FourOhOneKAccount has allowsEarlyWithdrawal true by default', () => {
  assert.strictEqual(new FourOhOneKAccount(0).allowsEarlyWithdrawal, true);
});

test('EW-9: SuperannuationAccount has allowsEarlyWithdrawal false', () => {
  assert.strictEqual(new SuperannuationAccount(0).allowsEarlyWithdrawal, false);
});

test('EW-1: BrokerageAccount is not an early-withdrawal (penalty) account', () => {
  // Brokerage no longer carries allowsEarlyWithdrawal (design 53 §2); absent → falsy,
  // so the early-withdrawal penalty drawdown loop skips it.
  assert.ok(!new BrokerageAccount(0).allowsEarlyWithdrawal);
});

// ══════════════════════════════════════════════════════════════════════════════
// EW-8: Rules from the US account module
// ══════════════════════════════════════════════════════════════════════════════

test('EW-8: getUsEarlyWithdrawalRules returns 10%/59.5 for Roth', () => {
  const rules = getUsEarlyWithdrawalRules(ACCOUNT_TYPE.ROTH);
  assert.strictEqual(rules.penaltyRate,   0.10);
  assert.strictEqual(rules.ageThreshold,  59.5);
});

test('EW-8: getUsEarlyWithdrawalRules returns 10%/59.5 for 401k', () => {
  const rules = getUsEarlyWithdrawalRules(ACCOUNT_TYPE.FOUR_OH_ONE_K);
  assert.strictEqual(rules.penaltyRate,   0.10);
  assert.strictEqual(rules.ageThreshold,  59.5);
});

test('EW-8: getUsEarlyWithdrawalRules returns 10%/60.0 for IRA', () => {
  const rules = getUsEarlyWithdrawalRules(ACCOUNT_TYPE.TRADITIONAL_IRA);
  assert.strictEqual(rules.penaltyRate,   0.10);
  assert.strictEqual(rules.ageThreshold,  60.0);
});

test('EW-8: UsAccountModule2026.getEarlyWithdrawalRules delegates to rules table', () => {
  const mod = new UsAccountModule2026();
  const rules = mod.getEarlyWithdrawalRules(ACCOUNT_TYPE.ROTH);
  assert.strictEqual(rules.penaltyRate,  0.10);
  assert.strictEqual(rules.ageThreshold, 59.5);
});

test('EW-8: getUsEarlyWithdrawalRules returns null for non-retirement account types', () => {
  assert.strictEqual(getUsEarlyWithdrawalRules(ACCOUNT_TYPE.BROKERAGE), null);
  assert.strictEqual(getUsEarlyWithdrawalRules(ACCOUNT_TYPE.SAVINGS),   null);
});

// ══════════════════════════════════════════════════════════════════════════════
// EW-2: Roth contribution drawdown — always accessible, no penalty, no tax
// ══════════════════════════════════════════════════════════════════════════════

test('EW-2: Roth contributions drawn in phase 1 even when person is under 59.5', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const roth   = new RothAccount(10000, { contributionBasis: 8000, earningsBasis: 2000, drawdownPriority: 1 });
  const state  = { target, roth, personBirthDate: new Date(1990, 0, 1), isAuResident: false }; // age 36

  const { drawnKeys, pendingTaxActions } = svc.replenishSavings(state, 'target', 5000, date);

  assert.strictEqual(target.balance,             5000);  // full amount deposited
  assert.strictEqual(roth.balance,               5000);  // 10000 - 5000
  assert.strictEqual(roth.contributionBasis,     3000);  // 8000 - 5000
  assert.strictEqual(roth.earningsBasis,         2000);  // unchanged
  assert.deepStrictEqual(pendingTaxActions,      []);    // no tax actions for contributions
  assert.deepStrictEqual(drawnKeys,              ['roth']);
});

test('EW-2: Roth contributions are drawn before phase-2 earnings', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  // 4000 contrib basis, 6000 earnings basis; deficit is 4000 (exactly exhausts contributions)
  const roth   = new RothAccount(10000, { contributionBasis: 4000, earningsBasis: 6000, drawdownPriority: 1 });
  const state  = { target, roth, personBirthDate: new Date(1990, 0, 1), isAuResident: false };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 4000, date);

  assert.strictEqual(target.balance,         4000); // covered entirely from contributions
  assert.strictEqual(roth.contributionBasis, 0);
  assert.strictEqual(roth.earningsBasis,     6000); // untouched
  assert.deepStrictEqual(pendingTaxActions,  []);   // no penalty for contribution-only draw
});

// ══════════════════════════════════════════════════════════════════════════════
// EW-3: Roth earnings drawdown — 10% penalty + optional AU tax
// ══════════════════════════════════════════════════════════════════════════════

test('EW-3: Roth earnings drawn in phase 2 after contributions exhausted', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  // 2000 contrib, 8000 earnings; need 5000 → 2000 from contrib (phase 1), 3000 net from earnings (phase 2)
  const roth   = new RothAccount(10000, { contributionBasis: 2000, earningsBasis: 8000, drawdownPriority: 1 });
  const state  = { target, roth, people: { primary: { birthDate: new Date(1990, 0, 1), residency: 'US' } } };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 5000, date);

  // Target gets 2000 (contrib) + 3000 net (= 3333.33 gross × 0.9)
  assert.ok(Math.abs(target.balance - 5000) < 0.01);
  assert.strictEqual(roth.contributionBasis, 0);

  // One ROTH_WITHDRAWAL_EARNINGS_TAX action covering the earnings portion
  assert.strictEqual(pendingTaxActions.length, 1);
  assert.strictEqual(pendingTaxActions[0].type, 'ROTH_WITHDRAWAL_EARNINGS_TAX');
  assert.ok(pendingTaxActions[0].penaltyAmount > 0);
  assert.notStrictEqual(pendingTaxActions[0].residency, 'AU');
});

test('EW-3: Roth earnings penalty is 10% of gross withdrawal', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  // No contributions — all earnings; need 4500 net → gross = 4500/0.9 = 5000, penalty = 500
  const roth   = new RothAccount(10000, { contributionBasis: 0, earningsBasis: 10000, drawdownPriority: 1 });
  const state  = { target, roth, personBirthDate: new Date(1990, 0, 1), isAuResident: false };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 4500, date);

  assert.ok(Math.abs(target.balance - 4500) < 0.01);
  assert.ok(Math.abs(roth.balance   - 5000) < 0.01);  // 10000 - 5000 gross
  assert.strictEqual(pendingTaxActions[0].type, 'ROTH_WITHDRAWAL_EARNINGS_TAX');
  assert.ok(Math.abs(pendingTaxActions[0].amount        - 5000) < 0.01);
  assert.ok(Math.abs(pendingTaxActions[0].penaltyAmount -  500) < 0.01);
});

test('EW-3: Roth earnings drawdown includes AU ordinary income when AU resident', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const roth   = new RothAccount(10000, { contributionBasis: 0, earningsBasis: 10000, drawdownPriority: 1 });
  const state  = { target, roth, people: { primary: { birthDate: new Date(1990, 0, 1), residency: 'AU' } } };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 9000, date);

  assert.strictEqual(pendingTaxActions[0].residency, 'AU');
});

test('EW-3: Roth earnings at or above age 59.5 — no penalty', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const roth   = new RothAccount(10000, { contributionBasis: 0, earningsBasis: 10000, drawdownPriority: 1 });
  // Person born 1966-01-01 → age 60 at date (>= 59.5, eligible — drawn in phase 1)
  const state  = { target, roth, people: { primary: { birthDate: new Date(1966, 0, 1), residency: 'US' } } };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 5000, date);

  assert.ok(Math.abs(target.balance - 5000) < 0.01);
  // No PENALTY — which is what EW-3 is about. This used to assert no action AT ALL,
  // conflating the two, and that is precisely how design 84 G7 hid: an age-eligible
  // Roth drawn by the generic path emitted nothing, so an AU resident's s99B charge
  // was never raised. The action is emitted; its penalty is zero.
  assert.strictEqual(pendingTaxActions.length, 1);
  assert.strictEqual(pendingTaxActions[0].type, 'ROTH_WITHDRAWAL_EARNINGS_TAX');
  assert.strictEqual(pendingTaxActions[0].penaltyAmount, 0);
  assert.strictEqual(pendingTaxActions[0].amount, 5000);
  // US resident ⇒ the reducer books nothing from it, so this stays economically a
  // no-op on that side of the border (IRC §408A(d)(1)).
  assert.strictEqual(pendingTaxActions[0].residency, 'US');
});

test('EW-3b: age-eligible Roth earnings drawn by an AU resident raise s99B (design 84 G7)', () => {
  // The regression guard for G7. Past 59.5 the Roth is penalty-free-ELIGIBLE, so the
  // ordinary drawdown path — the one that funds spending and tax bills — drains it
  // through `_drawPenaltyFree`. Australia taxes those earnings as trust income under
  // s99B ITAA 1936 with no foreign tax credit, so the action must carry `residency`
  // and the owning account, or the charge silently never happens.
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const roth   = new RothAccount(10000, { contributionBasis: 2000, earningsBasis: 8000, drawdownPriority: 1 });
  const state  = { target, roth, people: { primary: { birthDate: new Date(1966, 0, 1), residency: 'AU' } } };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 5000, date);

  const earnings = pendingTaxActions.filter(a => a.type === 'ROTH_WITHDRAWAL_EARNINGS_TAX');
  assert.strictEqual(earnings.length, 1, 'the s99B charge is raised');
  assert.strictEqual(earnings[0].residency, 'AU', 'residency reaches the tax module');
  assert.ok(earnings[0].stateKey, 'attributed to an account (design 76 per-person)');
  assert.strictEqual(earnings[0].penaltyAmount, 0, 'age-eligible ⇒ no §72(t)');
  // Contributions come out first and are corpus under s99B(2)(a): of the 5000 drawn,
  // 2000 is corpus and only 3000 is assessable.
  assert.strictEqual(earnings[0].amount, 3000, 'only the earnings slice is assessable');
});

// ══════════════════════════════════════════════════════════════════════════════
// EW-4: IRA early drawdown
// ══════════════════════════════════════════════════════════════════════════════

test('EW-4: IRA drawn in phase 2 when person is below minimumAge', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  // contributionBasis=5000 < gross=10000, so both contrib and earnings portions are generated
  const ira    = new TraditionalIRAAccount(20000, { contributionBasis: 5000, earningsBasis: 15000, drawdownPriority: 1 });
  const state  = { target, ira, personBirthDate: new Date(1990, 0, 1), isAuResident: false }; // age 36

  const { drawnKeys, pendingTaxActions } = svc.replenishSavings(state, 'target', 9000, date);

  // 9000 net = 10000 gross × 0.9 (10% penalty); 5000 from contrib, 5000 from earnings
  assert.ok(Math.abs(target.balance - 9000) < 0.01);
  assert.deepStrictEqual(drawnKeys, ['ira']);
  // Tax actions: IRA_WITHDRAWAL_CONTRIB_TAX for contributions portion, IRA_WITHDRAWAL_EARNINGS_TAX for earnings
  const types = pendingTaxActions.map(a => a.type);
  assert.ok(types.includes('IRA_WITHDRAWAL_CONTRIB_TAX'));
  assert.ok(types.includes('IRA_WITHDRAWAL_EARNINGS_TAX'));
});

test('EW-4: IRA draws contributions first for basis tracking', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  // 20000 contrib, 0 earnings — all should be IRA_WITHDRAWAL_CONTRIB_TAX
  const ira    = new TraditionalIRAAccount(20000, { contributionBasis: 20000, earningsBasis: 0, drawdownPriority: 1 });
  const state  = { target, ira, personBirthDate: new Date(1990, 0, 1), isAuResident: false };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 9000, date);

  const types = pendingTaxActions.map(a => a.type);
  assert.ok(types.includes('IRA_WITHDRAWAL_CONTRIB_TAX'));
  assert.ok(!types.includes('IRA_WITHDRAWAL_EARNINGS_TAX'));
});

test('EW-4: IRA earnings withdrawal includes AU ordinary income when AU resident', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const ira    = new TraditionalIRAAccount(20000, { contributionBasis: 0, earningsBasis: 20000, drawdownPriority: 1 });
  const state  = { target, ira, people: { primary: { birthDate: new Date(1990, 0, 1), residency: 'AU' } } };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 9000, date);

  const earningsTax = pendingTaxActions.find(a => a.type === 'IRA_WITHDRAWAL_EARNINGS_TAX');
  assert.ok(earningsTax, 'IRA_WITHDRAWAL_EARNINGS_TAX action expected');
  assert.strictEqual(earningsTax.residency, 'AU');
});

test('EW-4: IRA contribution withdrawal has no AU tax field', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const ira    = new TraditionalIRAAccount(20000, { contributionBasis: 20000, earningsBasis: 0, drawdownPriority: 1 });
  const state  = { target, ira, personBirthDate: new Date(1990, 0, 1), isAuResident: true };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 9000, date);

  const contribTax = pendingTaxActions.find(a => a.type === 'IRA_WITHDRAWAL_CONTRIB_TAX');
  assert.ok(contribTax, 'IRA_WITHDRAWAL_CONTRIB_TAX action expected');
  assert.strictEqual(contribTax.isAuResident, undefined); // no AU field on contrib action
});

// ══════════════════════════════════════════════════════════════════════════════
// EW-5: 401k early drawdown
// ══════════════════════════════════════════════════════════════════════════════

test('EW-5: 401k drawn in phase 2 with 10% penalty', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const k401   = new FourOhOneKAccount(20000, { contributionBasis: 15000, earningsBasis: 5000, drawdownPriority: 1 });
  const state  = { target, k401, personBirthDate: new Date(1990, 0, 1), isAuResident: false };

  const { drawnKeys, pendingTaxActions } = svc.replenishSavings(state, 'target', 9000, date);

  assert.ok(Math.abs(target.balance - 9000) < 0.01); // 10000 gross × 0.9
  assert.deepStrictEqual(drawnKeys, ['k401']);
  assert.strictEqual(pendingTaxActions.length, 1);
  assert.strictEqual(pendingTaxActions[0].type, 'K401_WITHDRAWAL_TAX');
  assert.ok(Math.abs(pendingTaxActions[0].amount        - 10000) < 0.01);
  assert.ok(Math.abs(pendingTaxActions[0].penaltyAmount -  1000) < 0.01);
});

test('EW-5: 401k early withdrawal has no AU tax in action', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const k401   = new FourOhOneKAccount(20000, { drawdownPriority: 1 });
  const state  = { target, k401, personBirthDate: new Date(1990, 0, 1), isAuResident: true };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 9000, date);

  assert.strictEqual(pendingTaxActions[0].isAuResident, undefined);
});

test('EW-5: 401k draws earnings before contributions for basis tracking', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  // 5000 earnings, 15000 contributions; gross = 9000/0.9 = 10000
  const k401   = new FourOhOneKAccount(20000, { contributionBasis: 15000, earningsBasis: 5000, drawdownPriority: 1 });
  const state  = { target, k401, personBirthDate: new Date(1990, 0, 1), isAuResident: false };

  svc.replenishSavings(state, 'target', 9000, date);

  // 5000 from earnings (exhausted), 5000 from contributions
  assert.strictEqual(k401.earningsBasis,     0);
  assert.strictEqual(k401.contributionBasis, 10000); // 15000 - 5000
});

// ══════════════════════════════════════════════════════════════════════════════
// EW-6: Net cash to target — penalty never credited
// ══════════════════════════════════════════════════════════════════════════════

test('EW-6: target receives gross minus penalty, not gross', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const k401   = new FourOhOneKAccount(20000, { drawdownPriority: 1 });
  const state  = { target, k401, personBirthDate: new Date(1990, 0, 1), isAuResident: false };

  svc.replenishSavings(state, 'target', 9000, date);

  // gross = 10000, penalty = 1000, net = 9000
  assert.ok(Math.abs(target.balance - 9000)  < 0.01);
  assert.ok(Math.abs(k401.balance   - 10000) < 0.01); // 20000 - 10000 gross
});

test('EW-6: penalty amount is tracked in pendingTaxActions, not deposited', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const k401   = new FourOhOneKAccount(20000, { drawdownPriority: 1 });
  const state  = { target, k401, personBirthDate: new Date(1990, 0, 1), isAuResident: false };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 9000, date);

  const totalInflow  = target.balance;                        // 9000
  const penaltyInAction = pendingTaxActions[0].penaltyAmount; // 1000
  // gross = net + penalty
  assert.ok(Math.abs(totalInflow + penaltyInAction - 10000) < 0.01);
});

// ══════════════════════════════════════════════════════════════════════════════
// EW-7: pendingTaxActions returned and chainable
// ══════════════════════════════════════════════════════════════════════════════

test('EW-7: pendingTaxActions contains STOCK_WITHDRAWAL_TAX for phase-1 brokerage draw (even zero gain)', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  // Holding carried at cost (costBasis == marketValue, as _bootstrapDefaultHolding
  // seeds it) — gain=0 but the sale is still tracked for Form 8949. Brokerage CGT now
  // comes from holdings FIFO (design 53 P1), not earningsBasis.
  const brok   = new BrokerageAccount(20000, { country: 'US', currency: USD, drawdownPriority: 1 });
  brok.holdings = [{ id: 'h1', marketValue: 20000, costBasis: 20000 }];
  const state  = { target, brok, personBirthDate: new Date(1990, 0, 1) };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 5000, date);
  assert.strictEqual(pendingTaxActions.length, 1);
  assert.strictEqual(pendingTaxActions[0].type, 'STOCK_WITHDRAWAL_TAX');
  assert.strictEqual(pendingTaxActions[0].gain, 0);
  assert.ok(Math.abs(pendingTaxActions[0].proceeds  - 5000) < 0.01);
  assert.ok(Math.abs(pendingTaxActions[0].costBasis - 5000) < 0.01);
});

test('EW-7: pendingTaxActions contains one action per early-withdrawal source touched', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  // Two early-withdrawal accounts; deficit requires both
  const k401a  = new FourOhOneKAccount(5000, { drawdownPriority: 1 });
  const k401b  = new FourOhOneKAccount(5000, { drawdownPriority: 2 });
  const state  = { target, k401a, k401b, personBirthDate: new Date(1990, 0, 1), isAuResident: false };

  // 9000 net = 10000 gross — needs both k401a (5000 gross → 4500 net) and k401b
  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 9000, date);

  assert.strictEqual(pendingTaxActions.length, 2);
  assert.ok(pendingTaxActions.every(a => a.type === 'K401_WITHDRAWAL_TAX'));
});

// ══════════════════════════════════════════════════════════════════════════════
// EW-10: earlyWithdrawalTaxActions — the shared §6 core (design 45)
// Phase 2 only ever passes Roth as earnings-only; these cover the scheduled-decant
// shapes (contrib-first Roth, penalty-free contributions) the reducer will use.
// ══════════════════════════════════════════════════════════════════════════════

test('EW-10: Roth core penalizes only the earnings portion, contributions free', () => {
  const svc  = makeSvc();
  const roth = new RothAccount(40000, { contributionBasis: 30000, earningsBasis: 10000 });
  // Decant the whole balance: 30k contrib (free) + 10k earnings (penalized).
  const { fromContrib, fromEarnings } = svc.reduceLedgerForWithdrawal(roth, 40000);
  const { penalty, taxActions } = svc.earlyWithdrawalTaxActions(roth, { fromContrib, fromEarnings, penaltyRate: 0.10, residency: 'US' });

  assert.strictEqual(fromContrib,  30000); // contributions out first (penalty-free)
  assert.strictEqual(fromEarnings, 10000);
  assert.ok(Math.abs(penalty - 1000) < 1e-9);            // 10% of the 10k earnings only
  assert.strictEqual(taxActions.length, 1);              // contributions emit nothing
  assert.strictEqual(taxActions[0].type, 'ROTH_WITHDRAWAL_EARNINGS_TAX');
  assert.ok(Math.abs(taxActions[0].amount        - 10000) < 1e-9);
  assert.ok(Math.abs(taxActions[0].penaltyAmount -  1000) < 1e-9);
  assert.strictEqual(taxActions[0].residency, 'US');
});

test('EW-10: Roth core with a contributions-only draw emits no action and no penalty', () => {
  const svc  = makeSvc();
  const roth = new RothAccount(40000, { contributionBasis: 30000, earningsBasis: 10000 });
  const { fromContrib, fromEarnings } = svc.reduceLedgerForWithdrawal(roth, 20000); // all from contrib
  const { penalty, taxActions } = svc.earlyWithdrawalTaxActions(roth, { fromContrib, fromEarnings, penaltyRate: 0.10 });

  assert.strictEqual(fromEarnings, 0);
  assert.strictEqual(penalty, 0);
  assert.deepStrictEqual(taxActions, []);
});

test('EW-10: IRA core penalizes the whole gross, split into contrib + earnings actions', () => {
  const svc = makeSvc();
  const ira = new TraditionalIRAAccount(20000, { contributionBasis: 5000, earningsBasis: 15000 });
  const { fromContrib, fromEarnings } = svc.reduceLedgerForWithdrawal(ira, 10000); // 5k contrib + 5k earnings
  const { penalty, taxActions } = svc.earlyWithdrawalTaxActions(ira, { fromContrib, fromEarnings, penaltyRate: 0.10, residency: 'AU' });

  assert.ok(Math.abs(penalty - 1000) < 1e-9);            // 10% of the full 10k
  const byType = Object.fromEntries(taxActions.map(a => [a.type, a]));
  assert.ok(Math.abs(byType.IRA_WITHDRAWAL_CONTRIB_TAX.penaltyAmount  - 500) < 1e-9);
  assert.ok(Math.abs(byType.IRA_WITHDRAWAL_EARNINGS_TAX.penaltyAmount - 500) < 1e-9);
  assert.strictEqual(byType.IRA_WITHDRAWAL_EARNINGS_TAX.residency, 'AU');
  assert.strictEqual(byType.IRA_WITHDRAWAL_CONTRIB_TAX.residency, undefined); // contrib carries no AU field
});

test('EW-10: above the age gate (penaltyRate 0) the actions carry zero penalty', () => {
  const svc  = makeSvc();
  const k401 = new FourOhOneKAccount(10000, { contributionBasis: 6000, earningsBasis: 4000 });
  const { fromContrib, fromEarnings } = svc.reduceLedgerForWithdrawal(k401, 10000);
  const { penalty, taxActions } = svc.earlyWithdrawalTaxActions(k401, { fromContrib, fromEarnings, penaltyRate: 0 });

  assert.strictEqual(penalty, 0);
  assert.strictEqual(taxActions[0].type, 'K401_WITHDRAWAL_TAX');
  assert.ok(Math.abs(taxActions[0].amount - 10000) < 1e-9);
  assert.strictEqual(taxActions[0].penaltyAmount, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// EW-11: (B) early-withdrawal-before-brokerage drawdown ordering (design 45 §7)
// A deficit needing both taxable brokerage and a penalty early withdrawal: the
// flag decides whether the penalty draw runs before realizing capital gains.
// ══════════════════════════════════════════════════════════════════════════════

/** Under-age-gate household (age 50 at DATE_B): 40k brokerage (25% gain), 100k IRA. */
function makeOrderingState({ flag = false, iraBalance = 100_000 } = {}) {
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const brok   = new BrokerageAccount(40_000, { country: 'US', currency: USD, earningsBasis: 10_000, drawdownPriority: 2 });
  const ira    = new TraditionalIRAAccount(iraBalance, { contributionBasis: iraBalance * 0.4, earningsBasis: iraBalance * 0.6, drawdownPriority: 3 });
  const state  = { target, brok, ira, people: { primary: { birthDate: new Date(1980, 0, 1), residency: 'US' } } };
  if (flag) state.earlyWithdrawalBeforeBrokerage = true;
  return { target, brok, ira, state };
}
const DATE_B = new Date(2030, 0, 1);   // age 50 — below the 59.5/60 early-withdrawal gates

test('EW-11: default — taxable brokerage is sold first; IRA covers only the residual', () => {
  const svc = makeSvc();
  const { target, brok, ira, state } = makeOrderingState();
  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 50_000, DATE_B);

  assert.ok(Math.abs(target.balance - 50_000) < 0.01);
  assert.ok(Math.abs(brok.balance   -      0) < 0.01);               // brokerage fully sold (Phase 1)
  assert.ok(Math.abs(ira.balance - (100_000 - 10_000 / 0.9)) < 0.5); // IRA covers only the last 10k net
  const types = pendingTaxActions.map(a => a.type);
  assert.ok(types.includes('STOCK_WITHDRAWAL_TAX'), 'gains realized on the brokerage sale');
  assert.ok(types.some(t => t.startsWith('IRA_WITHDRAWAL')));
});

test('EW-11: flag on — penalty early withdrawal runs first; brokerage untouched', () => {
  const svc = makeSvc();
  const { target, brok, ira, state } = makeOrderingState({ flag: true });
  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 50_000, DATE_B);

  assert.ok(Math.abs(target.balance - 50_000) < 0.01);
  assert.ok(Math.abs(brok.balance   - 40_000) < 0.01);               // brokerage held back — no sale
  assert.ok(Math.abs(ira.balance - (100_000 - 50_000 / 0.9)) < 0.5); // IRA covers the whole deficit
  const types = pendingTaxActions.map(a => a.type);
  assert.ok(!types.includes('STOCK_WITHDRAWAL_TAX'), 'no capital gains realized');
  assert.ok(types.some(t => t.startsWith('IRA_WITHDRAWAL')));
});

test('EW-11: flag on — brokerage backstops in Phase 3 when early withdrawal is exhausted', () => {
  const svc = makeSvc();
  const { target, brok, ira, state } = makeOrderingState({ flag: true, iraBalance: 30_000 });
  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 50_000, DATE_B);

  assert.ok(Math.abs(target.balance - 50_000) < 0.01);
  assert.ok(Math.abs(ira.balance    -      0) < 0.01);               // IRA drained (30k gross → 27k net)
  assert.ok(Math.abs(brok.balance - (40_000 - 23_000)) < 0.5);      // brokerage backstops the residual 23k
  const types = pendingTaxActions.map(a => a.type);
  assert.ok(types.includes('STOCK_WITHDRAWAL_TAX'), 'Phase-3 backstop realizes gains');
  assert.ok(types.some(t => t.startsWith('IRA_WITHDRAWAL')));
});

// ══════════════════════════════════════════════════════════════════════════════
// EW-9: Super never drawn early
// ══════════════════════════════════════════════════════════════════════════════

test('EW-9: SuperannuationAccount is never drawn before age 60 even when no other source exists', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'AU', currency: AUD });
  const sup    = new SuperannuationAccount(100000, { drawdownPriority: 1 });
  const state  = { target, sup, personBirthDate: new Date(1990, 0, 1), isAuResident: true };

  assert.throws(
    () => svc.replenishSavings(state, 'target', 5000, date),
    { name: 'InsufficientFundsError' }
  );
  assert.strictEqual(sup.balance, 100000); // completely untouched
});
