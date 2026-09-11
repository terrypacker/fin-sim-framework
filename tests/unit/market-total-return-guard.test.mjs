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
 * market-total-return-guard.test.mjs — design 99 P1.
 *
 * Pins design 99 §2.1 BEFORE the equity cut-over (P2) so the cut-over can prove it kept
 * every number: on each library plan, every equity account earns its market's TOTAL return
 * on a lot in its own market —
 *
 *   taxable (US brokerage, AU stock):  price growth + paid dividend = the total
 *   wrapper (Roth / IRA / 401(k)):     growth = the total   (the dividend is a carve-out OF it)
 *   super:                             gross growth = the total   (before the fund's earnings tax)
 *
 * The totals were 7% everywhere until design 99 P5b sourced them (docs/market-returns/
 * SOURCES.md), so each account is checked against its OWN market's default.
 *
 * It is measured through the plan's REAL handler instances, not through rate-map keys.
 * That is the point: P2 deletes the `<market>::<stateKey>` seeding, the role params and
 * the account dividend rates, and moves the yield onto the synthetic market securities —
 * this file must stay green across all of that WITHOUT EDITS. The probe lot carries its
 * synthetic `securityId` so that after P2 the yield really is read from the security.
 *
 * The probe state uses `baseGrowthRates` as the effective map and drops the regime and
 * security overlays, so it tests the authored plan rather than whatever a regime did.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { GOLDEN_SPECS }        from '../helpers/golden-specs.js';
import { runGolden }           from '../helpers/golden-harness.js';
import { syntheticSecurityId } from '../../src/finance/holdings/security.js';
import { RATE_KEYS }           from '../../src/finance/economic-regimes/rate-keys.js';
import { marketReturnFor }     from '../../src/finance/economic-regimes/market-returns.js';

const LOT = 100_000;

/** A market's default TOTAL return — what every account holding it must earn. */
const totalOf = rateKey => marketReturnFor({}, rateKey).total;

/** The handlers that produce an equity account's return. Growth, then dividends paid on top. */
const GROWTH_HANDLERS = new Set([
  'IntlRothEarningsHandler', 'IntlIraEarningsHandler', 'IntlK401EarningsHandler',
  'IntlUsStockEarningsHandler', 'IntlAuStockEarningsHandler', 'SuperEarningsHandler',
]);
const DIVIDEND_HANDLERS = new Set(['DividendScheduledHandler', 'IntlAuStockDividendHandler']);

const PLANS = ['cross-border-reference', 'us-single-homeowner', 'au-single-homeowner'];

/** A month of the plan: enough to load it and wire every handler. */
function loadPlan(name) {
  const spec = GOLDEN_SPECS.find(s => s.name === name);
  assert.ok(spec, `golden spec ${name}`);
  const simEnd = new Date(spec.simStart.getTime());
  simEnd.setUTCMonth(simEnd.getUTCMonth() + 1);
  return runGolden({ ...spec, name: `${name}-d99-guard`, simEnd });
}

const stateKeyOf = h => h._stateKeyFixed ?? h.stateRegistry.getStateKey(h.role, h.ownerId);

/** Every equity account's growth + dividend handlers, keyed by stateKey. */
function equityAccounts(sim) {
  const seen = new Set();
  const byKey = new Map();
  for (const list of sim.handlers.map.values()) {
    for (const h of list) {
      if (seen.has(h)) continue;
      seen.add(h);
      const cls = h.constructor.name;
      const isGrowth = GROWTH_HANDLERS.has(cls);
      if (!isGrowth && !DIVIDEND_HANDLERS.has(cls)) continue;
      const stateKey = stateKeyOf(h);
      if (!byKey.has(stateKey)) byKey.set(stateKey, { growth: [], dividend: [] });
      byKey.get(stateKey)[isGrowth ? 'growth' : 'dividend'].push(h);
    }
  }
  return byKey;
}

/** The state a handler sees: one lot on `rateKey`, the authored rates, no overlays. */
function probeState(state, stateKey, rateKey) {
  return {
    ...state,
    effectiveGrowthRates:         { ...state.baseGrowthRates },
    effectiveDividendAdjustments: {},
    securityReturnOverlay:        null,
    [stateKey]: {
      ...state[stateKey],
      balance:  LOT,
      holdings: [{
        id: 'd99-probe', marketValue: LOT, costBasis: LOT, allocation: 'EQUITY',
        rateKey, securityId: syntheticSecurityId(rateKey),
      }],
    },
  };
}

/** The one money action a handler returns; super's GROSS, before the fund's tax. */
function earned(actions) {
  const a = actions.find(x => typeof x?.type === 'string' && typeof x.amount === 'number');
  return a ? (a.grossAmount ?? a.amount) : 0;
}

/** One year's return on the probe lot: growth plus every dividend paid on top. */
function annualReturn(state, stateKey, { growth, dividend }, rateKey) {
  const s = probeState(state, stateKey, rateKey);
  return [...growth, ...dividend].reduce((sum, h) => sum + earned(h.call({ state: s })), 0);
}

describe('design 99 §2.1 — every equity account earns its market\'s total', () => {
  for (const name of PLANS) {
    test(`P1-1 ${name}`, () => {
      const { sim, state } = loadPlan(name);
      const accounts = equityAccounts(sim);
      assert.ok(accounts.size >= 2, `${name}: found ${accounts.size} equity accounts`);
      for (const [stateKey, hs] of accounts) {
        assert.equal(hs.growth.length, 1, `${stateKey}: exactly one growth handler`);
        const rateKey = hs.growth[0].rateKey;
        const got  = annualReturn(state, stateKey, hs, rateKey);
        const want = LOT * totalOf(rateKey);
        assert.ok(Math.abs(got - want) < 0.01,
          `${name} ${stateKey} (${rateKey}): ${got} on ${LOT}, want ${want}`);
      }
    });
  }

  test('P1-1: the taxable accounts really do pay a dividend on top', () => {
    // Without this the guard above would pass with every dividend handler missing — the
    // growth alone at 7% would satisfy it, which is exactly the double-count P2 must not
    // reintroduce in the other direction.
    const { sim, state } = loadPlan('cross-border-reference');
    const accounts = equityAccounts(sim);
    for (const stateKey of ['usStockAccount', 'auStockAccount']) {
      const hs = accounts.get(stateKey);
      assert.ok(hs, `${stateKey} found`);
      assert.equal(hs.dividend.length, 1, `${stateKey}: one dividend handler`);
      const s = probeState(state, stateKey, hs.growth[0].rateKey);
      assert.ok(earned(hs.dividend[0].call({ state: s })) > 0, `${stateKey} pays a dividend`);
    }
  });
});

describe('design 99 P2 — the cross-market lot', () => {
  test('an AU-market lot in a US brokerage earns AU\'s total', () => {
    // Before P2: 6% on the bare AU key + the brokerage's own 2% dividend = 8%. Since P2
    // the lot takes AU's price (7% − 4%) and AU's 4% yield — the market's, not the
    // account's. Was a `todo` in P1; P2 made it pass.
    const { sim, state } = loadPlan('cross-border-reference');
    const hs = equityAccounts(sim).get('usStockAccount');
    const got  = annualReturn(state, 'usStockAccount', hs, RATE_KEYS.EQUITY_AU);
    const want = LOT * totalOf(RATE_KEYS.EQUITY_AU);
    assert.ok(Math.abs(got - want) < 0.01, `${got} on ${LOT}, want ${want}`);
  });
});
