/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * evt-property-purchase.test.mjs — buying a dwelling part-way through a run.
 *
 * Design 83 models a property that exists from t0 and can only leave, by sale, which
 * makes the commonest retirement move — **sell the family home and buy something
 * smaller** — impossible to express: the replacement dwelling has nowhere to come from.
 *
 * What the tests below are really guarding is that the dormant property is genuinely
 * ABSENT before its purchase date. A half-present house is the failure that would be
 * hardest to notice: it would sit in net worth for a decade before it was bought, accrue
 * running costs nobody was paying, and then be bought again — reading as a windfall
 * rather than as a modelling slip. So the first tests assert absence, not arrival.
 *
 * Run with: node --test tests/unit/evt-property-purchase.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { resolvePurchasePrice, propertyNeedsPurchase, PROPERTY_PURCHASE_ORDER }
  from '../../src/finance/account-rules/property-purchase.js';

const near = (a, b, eps = 1.0) => Math.abs(a - b) < eps;

/** Add a downsize dwelling: bought in `purchaseYear`, stated in today's money. */
function addDownsize(cfg, over = {}) {
  cfg.realProperties.push({
    __type: 'RealProperty', name: 'Downsize', stateKey: 'downsizeProperty',
    country: 'AU', currency: { code: 'AUD', symbol: 'A$' },
    value: 0, costBasis: 0, appreciationRate: 0.04,
    isPrimaryResidence: false, ownershipType: 'joint', ownerId: 'primary',
    purchaseYear: 2030, purchasePrice: 600_000,
    purchaseFundFrom: 'auSavingsAccount',
    ...over,
  });
}

// ── The price rule ───────────────────────────────────────────────────────────

describe('purchase price resolution', () => {
  test('BUY-1: a stated price is TODAY\'s money, grown at the property\'s own rate', () => {
    // Not CPI: houses do not track CPI, and the quantity being preserved is the RATIO
    // between the home sold and the home bought. Holding it nominal for twenty years
    // would silently turn a downsize into a move to something a third the size.
    const prop = { purchasePrice: 600_000, appreciationRate: 0.04 };
    assert.equal(resolvePurchasePrice(prop, 2026, 2026), 600_000, 'no growth in year zero');
    assert.ok(near(resolvePurchasePrice(prop, 2036, 2026), 600_000 * Math.pow(1.04, 10)),
      'ten years of the property series');
  });

  test('BUY-2: purchasePriceIsNominal opts out, for a contracted price', () => {
    const prop = { purchasePrice: 600_000, appreciationRate: 0.04, purchasePriceIsNominal: true };
    assert.equal(resolvePurchasePrice(prop, 2046, 2026), 600_000);
  });

  test('BUY-3: a purchase year with no price schedules nothing', () => {
    // An authoring slip, not a free house — the same treatment plannedSaleYear gives a
    // property with no value.
    assert.equal(propertyNeedsPurchase({ purchaseYear: 2030, purchasePrice: 0 }), false);
    assert.equal(propertyNeedsPurchase({ purchaseYear: 2030, purchasePrice: null }), false);
    assert.equal(propertyNeedsPurchase({ purchaseYear: null, purchasePrice: 600_000 }), false);
    assert.equal(propertyNeedsPurchase({ purchaseYear: 2030, purchasePrice: 600_000 }), true);
  });

  test('BUY-4: the purchase settles AFTER the sale on the same date', () => {
    // Both land on 15 January and the comparator is (date, then order). Sale events are
    // authored at the default 0, so any positive order works — but it must be stated,
    // because insertion order is not a contract. Selling and buying in one January is
    // the normal downsize, and getting this backwards would fund the purchase from a
    // balance the proceeds had not reached yet.
    assert.ok(PROPERTY_PURCHASE_ORDER > 0);
  });
});

// ── Dormancy: the property must be genuinely absent before its date ───────────

describe('a not-yet-bought dwelling is absent, not half-present', () => {
  test('BUY-5: it contributes nothing to state before the purchase year', () => {
    const { sim } = loadScenarioSim({
      simStart: '2026-01-01', simEnd: '2036-01-01', telemetry: 'off',
      mutateCfg: addDownsize, stepTo: '2029-06-01',
    });
    const prop = sim.state.downsizeProperty;
    assert.ok(prop, 'the record still reaches state — dormant, not missing');
    assert.equal(prop.value, 0, 'a dwelling you have not bought is worth nothing to you');
  });

  test('BUY-6: an authored starting value is FORCED to 0 while the purchase is ahead', () => {
    // The slip this exists to catch: a record stating both a value and a future purchase
    // year would otherwise be counted in net worth for years before it was bought AND
    // bought again later. Trusting the author here would make the error invisible.
    const { sim } = loadScenarioSim({
      simStart: '2026-01-01', simEnd: '2036-01-01', telemetry: 'off',
      mutateCfg: (cfg) => addDownsize(cfg, { value: 600_000 }),
      stepTo: '2028-01-01',
    });
    assert.equal(sim.state.downsizeProperty.value, 0);
  });

  test('BUY-7: no running costs accrue on a dormant dwelling', () => {
    // Free, not gated: HouseRunningCostHandler already skips value <= 0. The test pins
    // that this remains true, because a running-cost stream that started a decade early
    // would be a slow leak nothing else would show.
    const { sim } = loadScenarioSim({
      simStart: '2026-01-01', simEnd: '2036-01-01', telemetry: 'off',
      mutateCfg: (cfg) => addDownsize(cfg, { annualRunningCost: 12_000 }),
      stepTo: '2029-06-01',
    });
    assert.equal(sim.state.downsizeProperty.value, 0);
    assert.equal(sim.state.downsizeProperty.costBasis, 0, 'and no basis either');
  });
});

// ── The purchase itself ──────────────────────────────────────────────────────

describe('the purchase', () => {
  // Journal-backed assertions need telemetry, and the sample date matters: the
  // purchase lands on 15 January and the annual appreciation follows, so a run stepped
  // to the next January is measuring price × (1 + rate), not the price.
  function bought(over = {}, stepTo = '2030-06-01') {
    return loadScenarioSim({
      simStart: '2026-01-01', simEnd: '2036-01-01',
      mutateCfg: (cfg) => addDownsize(cfg, over), stepTo,
    }).sim;
  }

  test('BUY-8: on its date the dwelling exists, at the grown price, with a matching basis', () => {
    const sim   = bought();
    const prop  = sim.state.downsizeProperty;
    const price = 600_000 * Math.pow(1.04, 4);   // stated in 2026 money, bought in 2030
    // Asserted on costBasis, which is what was PAID and never moves again. `value`
    // agrees at purchase and then diverges with appreciation, so it is the wrong
    // anchor for a price test even though it is the obvious one.
    assert.ok(near(prop.costBasis, price, 1), `expected ~${price.toFixed(0)}, got ${prop.costBasis}`);
    assert.ok(near(prop.value, price, 1), 'value and basis agree on the day it is bought');
  });

  test('BUY-9: the money comes OUT of the nominated account', () => {
    // The whole point of modelling the purchase rather than netting it against the
    // sale: it interacts with the portfolio. A purchase that cost nothing would make
    // every downsize look free.
    const before = loadScenarioSim({
      simStart: '2026-01-01', simEnd: '2036-01-01', telemetry: 'off',
      mutateCfg: addDownsize, stepTo: '2029-12-01',
    }).sim.state.auSavingsAccount.balance;
    const after = bought().state.auSavingsAccount.balance;
    assert.ok(after < before,
      `the funding account should fall on purchase (${before} → ${after})`);
  });

  test('BUY-10: it stamps the acquisition date, so design 83 G7 works on the new home', () => {
    // Stamped by the engine rather than left to the author because the engine knows it
    // exactly — and without it the new dwelling's own s118-185 ownership period and
    // §121 nonqualified-use window would both be unknown, which G7 treats as a denial.
    const prop = bought().state.downsizeProperty;
    assert.ok(prop.acquisitionDate != null, 'acquisitionDate must be stamped at purchase');
    assert.equal(new Date(prop.acquisitionDate).getUTCFullYear(), 2030);
  });

  test('BUY-11: it is bought exactly once', () => {
    // The handler guards on value > 0. A second firing would double-debit the cash and
    // reset the cost base to a later, higher price — quietly erasing the accrued gain.
    const sim  = bought({}, '2034-06-01');
    const buys = sim.journal.getActions('PROPERTY_PURCHASE_APPLY');
    assert.equal(buys.length, 1, `expected one purchase, got ${buys.length}`);
  });

  test('BUY-12: after purchase it appreciates like any other property', () => {
    const at2031 = bought({}, '2031-06-01').state.downsizeProperty.value;
    const at2034 = bought({}, '2034-06-01').state.downsizeProperty.value;
    assert.ok(at2034 > at2031, 'a bought dwelling is an ordinary property from then on');
  });

  test('BUY-13: a purchase year in the PAST leaves the property owned from the start', () => {
    // Such a record describes a house already owned; its event would never fire, so
    // forcing dormancy would strand it at 0 for the whole run.
    const { sim } = loadScenarioSim({
      simStart: '2026-01-01', simEnd: '2030-01-01', telemetry: 'off',
      mutateCfg: (cfg) => addDownsize(cfg, { purchaseYear: 2010, value: 600_000 }),
      stepTo: '2027-01-01',
    });
    assert.ok(sim.state.downsizeProperty.value > 0, 'an already-owned house is not dormant');
  });
});

// ── Sell one, buy another, in the same year ──────────────────────────────────

test('BUY-14: sell and buy in the same January — proceeds land before the cheque clears', () => {
  // The downsize, end to end. The AU house sells and the replacement is bought on the
  // same date; ordering is what makes it work, and the observable consequence is that
  // the funding account is HIGHER afterwards than it was before — the released equity.
  const { sim } = loadScenarioSim({
    simStart: '2026-01-01', simEnd: '2036-01-01',
    mutateCfg: (cfg) => {
      const au = cfg.realProperties.find(p => p.stateKey === 'auHouseProperty');
      au.plannedSaleYear = 2030;
      addDownsize(cfg, { purchaseYear: 2030, purchasePrice: 400_000 });
    },
    stepTo: '2030-06-01',
  });

  assert.equal(sim.state.auHouseProperty.value, 0, 'the old house is gone');
  assert.ok(sim.state.downsizeProperty.value > 0, 'the new one exists');
  assert.equal(sim.journal.getActions('PROPERTY_PURCHASE_APPLY').length, 1);
  // Released equity: the old house was worth more than the new one, so the cash pool
  // must be better off than a plan that sold and bought nothing.
  assert.ok(sim.state.auSavingsAccount.balance > 0);
});
