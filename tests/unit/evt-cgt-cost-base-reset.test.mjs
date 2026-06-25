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
 * evt-cgt-cost-base-reset.test.mjs
 *
 * AU CGT cost-base reset on becoming a tax resident (ITAA97 s855-45, design 36
 * §12.2). A US-citizen AU-resident is taxed by both countries on the same
 * proceeds, but AU measures the gain from a stepped-up cost base (market value
 * at the move) while the US keeps the original basis — a genuine dual cost base.
 *
 * Covers:
 *   - the country-agnostic step-up policy flag
 *   - consumeHoldingsFifo per-country realized basis (FIFO sale path)
 *   - recordResidencyChange gating (BROKERAGE only; retirement accounts skipped)
 *   - the account-level proportional drawdown path (replenishSavings → _drawPenaltyFree)
 *   - tax-module routing: usCGT += gain, auCGT += auGain, ftcYTD += auGain
 *
 * Run with: node --test tests/unit/evt-cgt-cost-base-reset.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { USD, CheckingAccount } from '../../src/finance/assets/account.js';
import { BrokerageAccount, RothAccount } from '../../src/finance/assets/investment-account.js';
import { consumeHoldingsFifo } from '../../src/finance/holdings/holdings-fifo.js';
import { stepsUpCostBaseOnResidency } from '../../src/finance/tax/residency-cost-base-policy.js';
import { UsTaxModule2026 } from '../../src/finance/tax/us/us-tax-module-2026.js';
import { AuTaxModule2026 } from '../../src/finance/tax/au/au-tax-module-2026.js';

const EPS = 0.01;
const near = (a, b) => Math.abs(a - b) < EPS;

function makeSvc() {
  const graph = new Graph();
  return new AccountService(graph, new GraphQueryApi(graph), new EventBus());
}

// ── Policy ──────────────────────────────────────────────────────────────────

test('policy: AU steps up cost base on residency; US and unknown do not', () => {
  assert.strictEqual(stepsUpCostBaseOnResidency('AU'), true);
  assert.strictEqual(stepsUpCostBaseOnResidency('US'), false);
  assert.strictEqual(stepsUpCostBaseOnResidency('XX'), false);
  assert.strictEqual(stepsUpCostBaseOnResidency(undefined), false);
});

// ── consumeHoldingsFifo per-country basis ────────────────────────────────────

test('consumeHoldingsFifo: no per-country base → empty map, gain from costBasis', () => {
  const holdings = [{ allocation: 'EQUITY', marketValue: 1000, costBasis: 400 }];
  const r = consumeHoldingsFifo(holdings, 1000);
  assert.ok(near(r.realizedBasis, 400));
  assert.deepStrictEqual(r.realizedBasisByCountry, {});
});

test('consumeHoldingsFifo: AU step-up → realizedBasisByCountry.AU uses stepped-up base', () => {
  // Lot bought for 400, market value 1000 at the move → AU base = 1000.
  const holdings = [{ allocation: 'EQUITY', marketValue: 1000, costBasis: 400, costBaseByCountry: { AU: 1000 } }];
  const r = consumeHoldingsFifo(holdings, 1000);
  assert.ok(near(r.realizedBasis, 400));        // US basis (original)
  assert.ok(near(r.realizedBasisByCountry.AU, 1000)); // AU basis (stepped up)
});

test('consumeHoldingsFifo: partial consume splits both bases pro-rata', () => {
  const holdings = [{ allocation: 'EQUITY', marketValue: 1000, costBasis: 400, costBaseByCountry: { AU: 1000 } }];
  const r = consumeHoldingsFifo(holdings, 250); // consume 25%
  assert.ok(near(r.realizedBasis, 100));            // 25% of 400
  assert.ok(near(r.realizedBasisByCountry.AU, 250)); // 25% of 1000
  // Remaining lot keeps 75% of each base.
  assert.strictEqual(r.newHoldings.length, 1);
  assert.ok(near(r.newHoldings[0].costBasis, 300));
  assert.ok(near(r.newHoldings[0].costBaseByCountry.AU, 750));
});

test('consumeHoldingsFifo: mixed lots — lot without AU entry falls back to costBasis', () => {
  const holdings = [
    { allocation: 'EQUITY', marketValue: 1000, costBasis: 400, costBaseByCountry: { AU: 1000 }, purchaseDate: '2020-01-01' }, // pre-move, stepped up
    { allocation: 'EQUITY', marketValue: 1000, costBasis: 900, purchaseDate: '2032-01-01' },                                  // post-move, no reset
  ];
  const r = consumeHoldingsFifo(holdings, 2000); // consume both (FIFO)
  assert.ok(near(r.realizedBasis, 1300));            // 400 + 900
  assert.ok(near(r.realizedBasisByCountry.AU, 1900)); // 1000 (stepped) + 900 (fallback to costBasis)
});

// ── recordResidencyChange gating ─────────────────────────────────────────────

test('recordResidencyChange: BROKERAGE step-up stamps account + per-lot AU base', () => {
  const svc = makeSvc();
  const brok = new BrokerageAccount(1000, { earningsBasis: 600, contributionBasis: 400 });
  brok.holdings = [{ allocation: 'EQUITY', marketValue: 1000, costBasis: 400 }];
  svc.recordResidencyChange(brok, { country: 'AU', stepUp: true });
  assert.ok(near(brok.costBaseStepUpByCountry.AU, 600)); // pre-move unrealized gain
  assert.ok(near(brok.holdings[0].costBaseByCountry.AU, 1000)); // market value at move
  assert.ok(near(brok.balanceAtResidencyChange, 1000));
});

test('recordResidencyChange: retirement account (Roth) is NOT stepped up', () => {
  const svc = makeSvc();
  const roth = new RothAccount(1000, { earningsBasis: 600 });
  roth.holdings = [{ allocation: 'EQUITY', marketValue: 1000, costBasis: 400 }];
  svc.recordResidencyChange(roth, { country: 'AU', stepUp: true });
  assert.strictEqual(roth.costBaseStepUpByCountry, null);
  assert.strictEqual(roth.holdings[0].costBaseByCountry, undefined);
});

test('recordResidencyChange: no step-up when destination country does not apply one', () => {
  const svc = makeSvc();
  const brok = new BrokerageAccount(1000, { earningsBasis: 600 });
  brok.holdings = [{ allocation: 'EQUITY', marketValue: 1000, costBasis: 400 }];
  svc.recordResidencyChange(brok, { country: 'US', stepUp: false });
  assert.strictEqual(brok.costBaseStepUpByCountry, null);
  assert.strictEqual(brok.holdings[0].costBaseByCountry, undefined);
});

test('recordResidencyChange: second call does not overwrite the step-up snapshot', () => {
  const svc = makeSvc();
  const brok = new BrokerageAccount(1000, { earningsBasis: 600 });
  brok.holdings = [{ allocation: 'EQUITY', marketValue: 1000, costBasis: 400 }];
  svc.recordResidencyChange(brok, { country: 'AU', stepUp: true });
  brok.earningsBasis = 1234;             // pretend earnings grew after the move
  brok.holdings[0].marketValue = 5000;
  svc.recordResidencyChange(brok, { country: 'AU', stepUp: true }); // no-op
  assert.ok(near(brok.costBaseStepUpByCountry.AU, 600));
  assert.ok(near(brok.holdings[0].costBaseByCountry.AU, 1000));
});

// ── Account-level proportional drawdown (the §3 analysis path) ────────────────

test('replenishSavings: AU drawdown excludes pre-move appreciation (auGain < gain)', () => {
  const svc    = makeSvc();
  const date   = new Date(2032, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const brok   = new BrokerageAccount(20000, {
    country: 'US', currency: USD, drawdownPriority: 1,
    earningsBasis: 8000, contributionBasis: 12000,
  });
  // Move: AU forgives the 8000 pre-move unrealized gain.
  svc.recordResidencyChange(brok, { country: 'AU', stepUp: true });
  // Post-move appreciation: +4000 (balance & earningsBasis grow; step-up fixed).
  brok.balance       += 4000;
  brok.earningsBasis += 4000;            // now balance 24000, earningsBasis 12000

  const state = {
    target, brok,
    people: { primary: { residency: 'AU', birthDate: new Date(1960, 0, 1) } },
  };

  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 6000, date);
  const tax = pendingTaxActions.find(a => a.type === 'STOCK_WITHDRAWAL_TAX');
  assert.ok(tax, 'emits STOCK_WITHDRAWAL_TAX');
  // withdraw 6000 of 24000: gain = 6000 * (12000/24000) = 3000.
  assert.ok(near(tax.gain, 3000), `gain ${tax.gain}`);
  // step-up consumed = 8000 * (6000/24000) = 2000 → auGain = 3000 - 2000 = 1000.
  assert.ok(near(tax.auGain, 1000), `auGain ${tax.auGain}`);
  // step-up depletes 8000 → 6000.
  assert.ok(near(brok.costBaseStepUpByCountry.AU, 6000));
});

test('replenishSavings: no step-up recorded → auGain equals gain', () => {
  const svc    = makeSvc();
  const date   = new Date(2026, 0, 1);
  const target = new CheckingAccount(0, { country: 'US', currency: USD });
  const brok   = new BrokerageAccount(20000, {
    country: 'US', currency: USD, drawdownPriority: 1,
    earningsBasis: 8000, contributionBasis: 12000,
  });
  const state = { target, brok, people: { primary: { residency: 'US', birthDate: new Date(1960, 0, 1) } } };
  const { pendingTaxActions } = svc.replenishSavings(state, 'target', 5000, date);
  const tax = pendingTaxActions.find(a => a.type === 'STOCK_WITHDRAWAL_TAX');
  assert.ok(near(tax.gain, 2000));
  assert.ok(near(tax.auGain, 2000)); // no reset → auGain === gain
});

// ── Tax-module routing ───────────────────────────────────────────────────────

test('US STOCK_WITHDRAWAL_TAX: AU resident routes gain→US, auGain→AU & FTC', () => {
  const fns  = new UsTaxModule2026().getReducerFns();
  const fn   = fns.get('STOCK_WITHDRAWAL_TAX');
  const base = { usCapitalGainsYTD: 0, auCapitalGainsYTD: 0, ftcYTD: 0 };
  const next = fn(base, { type: 'STOCK_WITHDRAWAL_TAX', gain: 1000, auGain: 400, residency: 'AU' });
  assert.ok(near(next.usCapitalGainsYTD, 1000)); // US: original basis
  assert.ok(near(next.auCapitalGainsYTD, 400));  // AU: stepped-up basis
  assert.ok(near(next.ftcYTD, 400));             // pre-move gain (600) earns no credit
});

test('US STOCK_WITHDRAWAL_TAX: non-AU resident books US gain only', () => {
  const fn = new UsTaxModule2026().getReducerFns().get('STOCK_WITHDRAWAL_TAX');
  const next = fn({ usCapitalGainsYTD: 0, auCapitalGainsYTD: 0, ftcYTD: 0 },
    { type: 'STOCK_WITHDRAWAL_TAX', gain: 1000, auGain: 400, residency: 'US' });
  assert.ok(near(next.usCapitalGainsYTD, 1000));
  assert.ok(near(next.auCapitalGainsYTD, 0));
  assert.ok(near(next.ftcYTD, 0));
});

test('US STOCK_WITHDRAWAL_TAX: back-compat — missing auGain falls back to gain', () => {
  const fn = new UsTaxModule2026().getReducerFns().get('STOCK_WITHDRAWAL_TAX');
  const next = fn({ usCapitalGainsYTD: 0, auCapitalGainsYTD: 0, ftcYTD: 0 },
    { type: 'STOCK_WITHDRAWAL_TAX', gain: 1000, residency: 'AU' });
  assert.ok(near(next.auCapitalGainsYTD, 1000));
  assert.ok(near(next.ftcYTD, 1000));
});

test('AU AU_STOCK_WITHDRAWAL_TAX: AU resident routes auGain to AU CGT & FTC', () => {
  const fn = new AuTaxModule2026().getReducerFns().get('AU_STOCK_WITHDRAWAL_TAX');
  // No state.people → scalar (non-perPerson) accumulators.
  const next = fn({ usCapitalGainsYTD: 0, auCapitalGainsYTD: 0, ftcYTD: 0 },
    { type: 'AU_STOCK_WITHDRAWAL_TAX', gain: 1000, auGain: 400, residency: 'AU' });
  assert.ok(near(next.usCapitalGainsYTD, 1000));
  assert.ok(near(next.auCapitalGainsYTD, 400));
  assert.ok(near(next.ftcYTD, 400));
});
