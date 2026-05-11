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

test('EW-1: BrokerageAccount has allowsEarlyWithdrawal false', () => {
  assert.strictEqual(new BrokerageAccount(0).allowsEarlyWithdrawal, false);
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
  const state  = { target, roth, personBirthDate: new Date(1990, 0, 1), isAuResident: false };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 5000, date);

  // Target gets 2000 (contrib) + 3000 net (= 3333.33 gross × 0.9)
  assert.ok(Math.abs(target.balance - 5000) < 0.01);
  assert.strictEqual(roth.contributionBasis, 0);

  // One ROTH_WITHDRAWAL_EARNINGS_TAX action covering the earnings portion
  assert.strictEqual(pendingTaxActions.length, 1);
  assert.strictEqual(pendingTaxActions[0].type, 'ROTH_WITHDRAWAL_EARNINGS_TAX');
  assert.ok(pendingTaxActions[0].penaltyAmount > 0);
  assert.strictEqual(pendingTaxActions[0].isAuResident, false);
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
  const state  = { target, roth, personBirthDate: new Date(1990, 0, 1), isAuResident: true };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 9000, date);

  assert.strictEqual(pendingTaxActions[0].isAuResident, true);
});

test('EW-3: Roth earnings at or above age 59.5 — no penalty', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const roth   = new RothAccount(10000, { contributionBasis: 0, earningsBasis: 10000, drawdownPriority: 1 });
  // Person born 1966-01-01 → age 60 at date (>= 59.5, eligible — drawn in phase 1)
  const state  = { target, roth, personBirthDate: new Date(1966, 0, 1), isAuResident: false };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 5000, date);

  assert.ok(Math.abs(target.balance - 5000) < 0.01);
  assert.deepStrictEqual(pendingTaxActions, []); // eligible withdrawal — no penalty action
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
  const state  = { target, ira, personBirthDate: new Date(1990, 0, 1), isAuResident: true };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 9000, date);

  const earningsTax = pendingTaxActions.find(a => a.type === 'IRA_WITHDRAWAL_EARNINGS_TAX');
  assert.ok(earningsTax, 'IRA_WITHDRAWAL_EARNINGS_TAX action expected');
  assert.strictEqual(earningsTax.isAuResident, true);
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

test('EW-7: pendingTaxActions is empty for phase-1-only drawdown', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const brok   = new BrokerageAccount(20000, { country: 'US', currency: USD, drawdownPriority: 1 });
  const state  = { target, brok, personBirthDate: new Date(1990, 0, 1) };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 5000, date);
  assert.deepStrictEqual(pendingTaxActions, []);
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
