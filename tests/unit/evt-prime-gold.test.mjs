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
 * evt-prime-gold.test.mjs
 *
 * Design 56 Phase 4 — the GOLD holding: commodity growth on its own key (decoupled
 * from equity forward returns and central-bank Prime), US 28% collectibles CGT on
 * disposal (AU ordinary CGT if resident), and an after-tax metric that sizes gold's
 * latent 28% liability.
 *
 *   GOLD-1  resolveRateKey routes GOLD → RATE_KEYS.GOLD regardless of account role
 *   GOLD-2  effectiveGrowthRates.GOLD tracks goldGrowthRate, independent of equity/Prime
 *   GOLD-3  computeHoldingsGrowth grows a gold sleeve at the GOLD rate, equity at its own
 *   GOLD-4  consumeHoldingsFifo tallies the collectible (gold) proceeds/basis slice
 *   GOLD-5  StockWithdrawalApplyReducer routes the gold gain → COLLECTIBLE_SALE_TAX (28%),
 *           the rest → STOCK_WITHDRAWAL_TAX (ordinary brokerage CGT)
 *   GOLD-6  computeAfterTaxValue discounts the gold gain at 28%, the equity gain at 15%;
 *           a gold-less account is byte-for-byte the pre-56 single-rate discount
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { resolveRateKey }         from '../../src/finance/holdings/default-allocations.js';
import { ALLOCATION }             from '../../src/finance/holdings/allocation.js';
import { ACCOUNT_ROLES }          from '../../src/finance/state/account-roles.js';
import { RATE_KEYS }              from '../../src/finance/economic-regimes/rate-keys.js';
import { computeHoldingsGrowth }  from '../../src/finance/holdings/holdings-earnings.js';
import { consumeHoldingsFifo }    from '../../src/finance/holdings/holdings-fifo.js';
import { computeAfterTaxValue }   from '../../src/finance/derived-metrics/after-tax.js';
import { StockWithdrawalApplyReducer } from '../../src/finance/account-rules/us/us-brokerage-classes.js';
import { makeAccount, makeServices }   from '../helpers/reducer-fixtures.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2032, 0, 1));

/** Build the default config, apply `mutate(cfg)`, run to SE, return sim.state. */
function run(mutate = () => {}) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd: SE });
  sc.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(IntlRetirementScenario.buildDefaultConfig({}, SS, SE));
  cfg.parameters = { ...(cfg.parameters ?? {}) };
  mutate(cfg);
  new ScenarioLoader().load(cfg, reg);
  sc.sim.silent = true; sc.sim.journal.enabled = false;
  sc.sim.stepTo(SE);
  return sc.sim.state;
}

const growth = (state, key) => state.effectiveGrowthRates?.[key] ?? NaN;

// ─── GOLD-1: rate-key resolution ────────────────────────────────────────────────

test('GOLD-1: resolveRateKey routes GOLD → RATE_KEYS.GOLD regardless of account role', () => {
  // A gold sleeve in ANY account earns the country-agnostic commodity rate — the
  // allocation wins over the account role (like CASH), so a gold lot in a US_STOCK
  // brokerage does NOT grow at the equity rate.
  assert.strictEqual(resolveRateKey('US', ALLOCATION.GOLD, ACCOUNT_ROLES.US_STOCK), RATE_KEYS.GOLD);
  assert.strictEqual(resolveRateKey('AU', ALLOCATION.GOLD, ACCOUNT_ROLES.AU_STOCK), RATE_KEYS.GOLD);
  assert.strictEqual(resolveRateKey('US', ALLOCATION.GOLD, null),                    RATE_KEYS.GOLD);
  // Equity is unchanged (still role-keyed).
  assert.strictEqual(resolveRateKey('US', ALLOCATION.EQUITY, ACCOUNT_ROLES.US_STOCK), RATE_KEYS.EQUITY_US);
});

// ─── GOLD-2: seeded growth series, decoupled from equity & Prime ─────────────────

test('GOLD-2: effectiveGrowthRates.GOLD tracks goldGrowthRate, independent of equity/Prime', () => {
  const base = run();
  assert.ok(Math.abs(growth(base, RATE_KEYS.GOLD) - 0.05) < 1e-9,
    `default gold rate must be the goldGrowthRate seed 0.05, got ${growth(base, RATE_KEYS.GOLD)}`);

  // Moving goldGrowthRate moves GOLD but NOT equity or Prime (its own commodity key).
  const hot = run(cfg => { cfg.parameters.goldGrowthRate = 0.11; });
  assert.ok(Math.abs(growth(hot, RATE_KEYS.GOLD) - 0.11) < 1e-9,
    `raising goldGrowthRate must lift the GOLD series, got ${growth(hot, RATE_KEYS.GOLD)}`);
  assert.ok(Math.abs(growth(hot, 'EQUITY_US::usStockAccount') - growth(base, 'EQUITY_US::usStockAccount')) < 1e-9,
    'a gold move must NOT touch the brokerage equity growth rate');
  assert.ok(Math.abs((hot.effectiveInterestRates?.PRIME_US ?? 0) - (base.effectiveInterestRates?.PRIME_US ?? 0)) < 1e-9,
    'a gold move must NOT touch central-bank Prime');
});

// ─── GOLD-3: a gold sleeve grows at the GOLD rate ───────────────────────────────

test('GOLD-3: computeHoldingsGrowth grows a gold sleeve at the GOLD rate, equity at its own', () => {
  const state = {
    effectiveGrowthRates: { GOLD: 0.10, 'EQUITY_US::acct': 0.05 },
    acct: {
      stateKey: 'acct',
      holdings: [
        { id: 'g', allocation: ALLOCATION.GOLD,   rateKey: RATE_KEYS.GOLD,        marketValue: 1000, costBasis: 400 },
        { id: 'e', allocation: ALLOCATION.EQUITY, rateKey: 'EQUITY_US', marketValue: 1000, costBasis: 600 },
      ],
    },
  };
  const { amount, holdingActions } = computeHoldingsGrowth({
    state, stateKey: 'acct', fallbackRate: 0.05, fallbackRateKey: 'EQUITY_US',
  });
  // gold: 1000 × 0.10 = 100 ; equity: 1000 × 0.05 = 50 → total 150
  assert.equal(amount, 150);
  const goldAct = holdingActions.find(a => a.holdingId === 'g');
  assert.equal(goldAct.marketValueDelta, 100, 'the gold sleeve must grow at the 10% GOLD rate');
});

// ─── GOLD-4: FIFO tallies the collectible slice ─────────────────────────────────

test('GOLD-4: consumeHoldingsFifo tallies the collectible (gold) proceeds/basis slice', () => {
  const holdings = [
    { id: 'g', allocation: ALLOCATION.GOLD,   marketValue: 10000, costBasis: 4000, purchaseDate: '2020-01-01' },
    { id: 'e', allocation: ALLOCATION.EQUITY, marketValue: 10000, costBasis: 6000, purchaseDate: '2021-01-01' },
  ];
  // Sell 15,000 → FIFO consumes the gold lot fully (10k) then 5k of equity.
  const r = consumeHoldingsFifo(holdings, 15000);
  assert.equal(r.collectibleProceeds, 10000, 'the whole gold lot is collectible proceeds');
  assert.equal(r.collectibleBasis,     4000, 'the whole gold lot basis is collectible basis');
  // The equity slice: 5k proceeds, basis share 6000 × (5000/10000) = 3000.
  assert.equal(r.realizedBasis, 4000 + 3000);
});

// ─── GOLD-5: disposal routes the gold gain to the 28% collectibles path ─────────

test('GOLD-5: StockWithdrawalApplyReducer routes the gold gain → COLLECTIBLE_SALE_TAX, rest → STOCK_WITHDRAWAL_TAX', () => {
  const usStockAccount = makeAccount({
    stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK,
    holdings: [
      { id: 'g', allocation: ALLOCATION.GOLD,   marketValue: 10000, costBasis: 4000, purchaseDate: new Date('2020-01-01') },
      { id: 'e', allocation: ALLOCATION.EQUITY, marketValue: 10000, costBasis: 6000, purchaseDate: new Date('2021-01-01') },
    ],
  });
  const state = { usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', balance: 5000 }), usStockAccount };

  // Sell 15,000: gold lot fully (gain 6000 @ 28%) + 5k equity (gain 2000 @ ordinary CGT).
  const next = new StockWithdrawalApplyReducer(makeServices()).reduce(
    state, { type: 'STOCK_WITHDRAWAL_APPLY', salePrice: 15000, residency: 'US' });

  const coll   = next.next.find(a => a.type === 'COLLECTIBLE_SALE_TAX');
  const equity = next.next.find(a => a.type === 'STOCK_WITHDRAWAL_TAX');
  assert.ok(coll,   'a gold sale must emit COLLECTIBLE_SALE_TAX (28% collectibles path)');
  assert.equal(coll.gain, 6000, 'the collectible gain is the gold lot gain (10000 − 4000)');
  assert.ok(equity, 'the equity slice must still emit STOCK_WITHDRAWAL_TAX');
  assert.equal(equity.gain, 2000, 'the equity gain is 5000 proceeds − 3000 basis share');
  // Proceeds credited in full to cash; balance is the remaining equity lot.
  assert.equal(next.usSavingsAccount.balance, 20000);
  assert.equal(next.usStockAccount.balance,    5000);
});

test('GOLD-5b: a gold-free sale is unchanged — one STOCK_WITHDRAWAL_TAX, no collectible action', () => {
  const usStockAccount = makeAccount({
    stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK,
    holdings: [{ id: 'e', allocation: ALLOCATION.EQUITY, marketValue: 20000, costBasis: 12000 }],
  });
  const state = { usSavingsAccount: makeAccount({ stateKey: 'usSavingsAccount', balance: 0 }), usStockAccount };
  const next = new StockWithdrawalApplyReducer(makeServices()).reduce(
    state, { type: 'STOCK_WITHDRAWAL_APPLY', salePrice: 10000, residency: 'US' });
  assert.ok(!next.next.some(a => a.type === 'COLLECTIBLE_SALE_TAX'), 'no gold ⇒ no collectible tax');
  const equity = next.next.find(a => a.type === 'STOCK_WITHDRAWAL_TAX');
  assert.equal(equity.gain, 4000, 'ordinary CGT gain = 10000 − (12000 × 10000/20000)');
});

// ─── GOLD-6: after-tax sizes the latent 28% gold liability ──────────────────────

test('GOLD-6: computeAfterTaxValue discounts the gold gain at 28%, the equity gain at 15%', () => {
  const withGold = makeAccount({
    stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK,
    holdings: [
      { id: 'e', allocation: ALLOCATION.EQUITY, marketValue: 10000, costBasis: 6000 }, // gain 4000
      { id: 'g', allocation: ALLOCATION.GOLD,   marketValue: 10000, costBasis: 4000 }, // gain 6000
    ],
  });
  // balance 20000 − (0.15 × 4000 equity) − (0.28 × 6000 gold) = 20000 − 600 − 1680.
  const v = computeAfterTaxValue(withGold, {}, null);
  assert.ok(Math.abs(v - 17720) < 1e-6, `gold liability must be sized at 28%, got ${v}`);

  // A gold-less brokerage is byte-for-byte the pre-56 single cap-gains discount.
  const noGold = makeAccount({
    stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK,
    holdings: [{ id: 'e', allocation: ALLOCATION.EQUITY, marketValue: 10000, costBasis: 6000 }],
  });
  const vNoGold = computeAfterTaxValue(noGold, {}, null);
  assert.ok(Math.abs(vNoGold - (10000 - 0.15 * 4000)) < 1e-6, `gold-less account must be unchanged, got ${vNoGold}`);
});
