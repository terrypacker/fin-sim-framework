/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { Account, USD }       from '../../src/finance/assets/account.js';
import { BrokerageAccount }   from '../../src/finance/assets/investment-account.js';
import { Holding }            from '../../src/finance/holdings/holding.js';
import { ALLOCATION }         from '../../src/finance/holdings/allocation.js';
import { promoteToUnitised, syncHolding, indexedRedemptionValue, split } from '../../src/finance/holdings/holding-utils.js';

function makeStockAccount() {
  return new BrokerageAccount(25_000, {   // 12k + 8k equity + 5k bond = Σ marketValue
    name:    'US Stock',
    role:    'us-stock',
    country: 'US',
    currency: USD,
    ownerId: 'primary',
    contributionBasis: 12_000,
    earningsBasis:      8_000,
    holdings: [
      new Holding({
        id: 'hldA', allocation: ALLOCATION.EQUITY, marketValue: 12_000, costBasis: 9_000,
        purchaseDate: new Date(Date.UTC(2020, 5, 15)), acquisitionPriceLevel: 1.08,
        rateKey: 'EQUITY_US', label: 'ITOT',
      }),
      new Holding({
        id: 'hldB', allocation: ALLOCATION.EQUITY, marketValue: 8_000, costBasis: 7_000,
        purchaseDate: new Date(Date.UTC(2022, 2, 1)),  rateKey: 'EQUITY_US', label: 'VOO',
      }),
      new Holding({
        id: 'hldC', allocation: ALLOCATION.BOND, marketValue: 5_000, costBasis: 5_000,
        rateKey: 'FIXED_INCOME_US', couponRate: 0.03, duration: 6,
        couponFrequency: 4,   // design 66 §G10a (non-default: quarterly)
        taxExemption: 'federal', issuingState: 'CA', label: 'CA muni',   // design 66 §G2
        // design 66 §G5/§G6: an inflation-linked / zero-coupon flag pair round-trips.
        inflationLinked: true, zeroCoupon: false,
        // design 66 §G8: a ladder rung's roll-to-tail term round-trips.
        rollAtMaturity: true, rollTermYears: 5,
      }),
    ],
  });
}

test('Holdings round-trip: serialize → deserialize preserves multi-sleeve holdings', () => {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const original = makeStockAccount();
  original.stateKey = 'usStockAccount';

  // Serialize
  const serialized = ScenarioSerializer._serializeAccount(original);
  assert.ok(Array.isArray(serialized.holdings), 'serialized account carries holdings array');
  assert.equal(serialized.holdings.length, 3);
  assert.equal(serialized.holdings[0].__type, 'Holding');

  // Deserialize → fresh account
  const restored = ScenarioSerializer._makeAccount(serialized);
  assert.equal(restored.holdings.length, 3);
  // design 66 §G2: the BOND sleeve's tax-treatment fields survive the round-trip.
  const muni = restored.holdings.find(h => h.id === 'hldC');
  assert.equal(muni.taxExemption, 'federal', 'muni taxExemption preserved');
  assert.equal(muni.issuingState, 'CA',      'muni issuingState preserved');
  assert.equal(muni.couponRate,   0.03,      'couponRate preserved');
  assert.equal(muni.couponFrequency, 4,      'couponFrequency preserved (design 66 §G10a)');
  assert.equal(muni.inflationLinked, true,   'inflationLinked preserved (design 66 §G5)');
  assert.equal(muni.zeroCoupon,      false,  'zeroCoupon preserved (design 66 §G6)');
  assert.equal(muni.rollAtMaturity,  true,   'rollAtMaturity preserved (design 66 §G8)');
  assert.equal(muni.rollTermYears,   5,      'rollTermYears preserved (design 66 §G8)');
  assert.equal(restored.holdings[0].id, 'hldA');
  assert.equal(restored.holdings[0].allocation, 'EQUITY');
  assert.equal(restored.holdings[0].marketValue, 12_000);
  assert.equal(restored.holdings[0].costBasis,    9_000);
  assert.equal(restored.holdings[0].rateKey,      'EQUITY_US');
  assert.equal(restored.holdings[0].label,        'ITOT');
  assert.equal(restored.holdings[0].purchaseDate.toISOString(), original.holdings[0].purchaseDate.toISOString());
  assert.equal(restored.holdings[0].acquisitionPriceLevel, 1.08);
  // design 66 §G10a: a holding authored without couponFrequency defaults to 2 (semi-annual).
  assert.equal(restored.holdings[0].couponFrequency, 2, 'couponFrequency defaults to 2 when absent');
  assert.equal(restored.holdings[1].id, 'hldB');
});

test('Holdings round-trip: §4.4 invariant survives serialize → deserialize → register', () => {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const original = makeStockAccount();
  original.stateKey = 'usStockAccount';

  const serialized = ScenarioSerializer._serializeAccount(original);
  const restored   = ScenarioSerializer._makeAccount(serialized);
  services.accountService.register(restored);

  // Invariant: balance === Σ holdings.marketValue
  const sum = restored.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0);
  assert.equal(+sum.toFixed(2), +restored.balance.toFixed(2));
});

test('Holdings round-trip: missing holdings field triggers default-holding bootstrap', () => {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  // Legacy serialized account with no `holdings` field
  const legacyData = {
    __type: 'BrokerageAccount',
    id:               null,
    name:             'Legacy Stock',
    type:             'brokerage',
    role:             'us-stock',
    initialValue:     50_000,
    country:          'US',
    currency:         USD,
    ownerId:          'primary',
    contributionBasis: 50_000,
    earningsBasis:    0,
    stateKey:         'usStockAccount',
  };
  const restored = ScenarioSerializer._makeAccount(legacyData);
  // No holdings yet — empty array
  assert.equal(restored.holdings.length, 0);
  services.accountService.register(restored);
  // Bootstrap fires inside register → exactly one default holding
  assert.equal(restored.holdings.length, 1);
  assert.equal(restored.holdings[0].marketValue, 50_000);
  assert.equal(restored.holdings[0].allocation, 'EQUITY');  // role=us-stock
});

// ─── The unitised representation (design 93 §5a) ───────────────────────────────

describe('Holding — unitised fields (design 93 §5)', () => {
  // The five fields are ASSIGNED ONLY WHEN PRESENT, and that is load-bearing rather than
  // tidy: `normalizeState` keeps explicit nulls, so defaulting them would add five fields
  // to every holding in every golden fixture and make an unrelated diff on every future
  // change. This test is what stops someone "simplifying" that away.
  test('a scalar holding gains no unitised fields at all', () => {
    const h = new Holding({ allocation: 'EQUITY', marketValue: 1000, costBasis: 900 });
    for (const f of ['units', 'parPerUnit', 'pricePerUnit', 'cpiIndexRatio', 'securityId']) {
      assert.ok(!(f in h), `scalar holding must not carry '${f}' — an explicit null moves every fixture`);
      assert.ok(!(f in h.toJSON()), `toJSON must omit '${f}' when absent`);
    }
  });

  test('the unitised fields round-trip when present', () => {
    const h = new Holding({
      allocation: 'BOND', marketValue: 980, costBasis: 1000, faceValue: 1000,
      maturityDate: new Date(Date.UTC(2035, 0, 1)),
      units: 10, parPerUnit: 100, pricePerUnit: 98, cpiIndexRatio: 1.07,
    });
    const back = Holding.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
    assert.equal(back.units, 10);
    assert.equal(back.parPerUnit, 100);
    assert.equal(back.pricePerUnit, 98);
    assert.equal(back.cpiIndexRatio, 1.07);
  });

  test('promoteToUnitised is value-preserving, and only promotes individual bonds', () => {
    const bond = { allocation: 'BOND', marketValue: 980, costBasis: 1000, faceValue: 1000,
                   maturityDate: new Date(Date.UTC(2035, 0, 1)) };
    const up = promoteToUnitised(bond);
    // design 93 §5b — `parPerUnit` is INSTRUMENT-level (§6.2), so it is the standard 100
    // and the position's size lives in `units`. A par equal to the whole face would be
    // position-scaled and could never move onto a shared `Security` under Option C.
    assert.equal(up.units, 10);
    assert.equal(up.parPerUnit, 100);
    assert.equal(up.pricePerUnit, 98);
    // The whole point: syncHolding must reproduce the numbers that were already there.
    const synced = syncHolding(up);
    assert.equal(synced.marketValue, 980, 'promotion must not move market value');
    assert.equal(synced.faceValue,   1000, 'promotion must not move par');

    // A bond FUND has no maturity and no par, so there is nothing to count units of.
    const fund = { allocation: 'BOND', marketValue: 500, costBasis: 500 };
    assert.equal(promoteToUnitised(fund), fund, 'a fund is left scalar');
    const eq = { allocation: 'EQUITY', marketValue: 500, costBasis: 500 };
    assert.equal(promoteToUnitised(eq), eq, 'equity is left scalar under Option A');
  });

  test('promoting a seasoned TIPS recovers its indexation from the price it was carrying', () => {
    // design 93 §5b. Under the scalar convention a TIPS's accretion was added to
    // `marketValue`, so the stored price IS the indexed principal. Promoting at a flat
    // ratio of 1 would redeem a seasoned TIPS at its ORIGINAL par and destroy every dollar
    // of indexation it had earned — a migration that loses money is not a migration.
    const seasoned = promoteToUnitised({
      allocation: 'BOND', marketValue: 12_000, costBasis: 11_000, faceValue: 10_000,
      maturityDate: new Date(Date.UTC(2035, 0, 1)), inflationLinked: true,
    });
    assert.equal(seasoned.cpiIndexRatio, 1.2, '12,000 of principal against 10,000 of par');
    assert.equal(indexedRedemptionValue(seasoned), 12_000,
      'promotion reproduces the pre-93 max(marketValue, faceValue) exactly at the moment it happens');

    // Marked BELOW original par, the ratio floors at 1: the instrument is sitting on its
    // deflation floor, which is where the Treasury actually puts it.
    const marked = promoteToUnitised({
      allocation: 'BOND', marketValue: 9_500, costBasis: 10_000, faceValue: 10_000,
      maturityDate: new Date(Date.UTC(2035, 0, 1)), inflationLinked: true,
    });
    assert.equal(marked.cpiIndexRatio, 1);
    assert.equal(indexedRedemptionValue(marked), 10_000, 'the floor pays original par');
  });

  test('split() moves units and price inversely and leaves every dollar total alone', () => {
    // design 93 §6.2 item 5, and its history is the point. §4 tried to write this against
    // {marketValue, costBasis, faceValue} and found it UNREPRESENTABLE — twice the units at
    // half the price is a literal no-op on dollar totals, so there was nothing to write.
    // That negative result was the argument for storing units. This is the same operation
    // against the unitised representation, and it is the cheapest proof the substrate can
    // express what Option C exists for.
    const lot = promoteToUnitised({
      allocation: 'BOND', marketValue: 12_000, costBasis: 9_000, faceValue: 10_000,
      maturityDate: new Date(Date.UTC(2035, 0, 1)),
    });
    const two = split(lot, 2);
    assert.equal(two.units,        200, 'twice the units');
    assert.equal(two.pricePerUnit,  60, 'at half the price');
    assert.equal(two.parPerUnit,    50, 'and half the par per unit — par is PER UNIT');
    assert.equal(two.marketValue, 12_000, 'value unchanged');
    assert.equal(two.faceValue,   10_000, 'and so is the principal the position stands for');
    assert.equal(two.costBasis,    9_000, 'a split is not a disposal — basis does not move');

    // Reverse splits are the same operation with ratio < 1.
    const rev = split(lot, 0.1);
    assert.equal(rev.units,          10);
    assert.equal(rev.pricePerUnit, 1_200);
    assert.equal(rev.marketValue, 12_000);

    // A SCALAR holding is still a no-op, and correctly so: there is no count to double.
    // That is §4's finding, now confined to the mode that has no units rather than being
    // true of the whole model.
    const scalar = { allocation: 'EQUITY', marketValue: 100, costBasis: 80 };
    assert.equal(split(scalar, 2), scalar, 'unchanged object — nothing to write');
  });

  test('a TIPS redeems off its index ratio, never off its market price', () => {
    // design 93 §5.3: the live bug. marketValue carries rate marks that never wash out
    // for a TIPS (they are excluded from pull-to-par), so redemption read off the price
    // pays out accumulated noise. 7% CPI accretion on 1,000 of par is 1,070 — whatever
    // the market happens to say.
    const tips = syncHolding(promoteToUnitised({
      allocation: 'BOND', marketValue: 1_040, costBasis: 1_070, faceValue: 1_000,
      maturityDate: new Date(Date.UTC(2035, 0, 1)), inflationLinked: true,
    }));
    const withRatio = { ...tips, cpiIndexRatio: 1.07 };
    assert.equal(indexedRedemptionValue(withRatio), 1_070);

    // Deflation floor: the ratio below 1 must not reduce redemption below original par.
    assert.equal(indexedRedemptionValue({ ...tips, cpiIndexRatio: 0.94 }), 1_000);
  });

  test('securityId is reserved and stays null under Option A', () => {
    const h = new Holding({ allocation: 'BOND', marketValue: 100, securityId: 'sec-1' });
    assert.equal(h.securityId, 'sec-1', 'the field carries a value when one is given');
    const plain = new Holding({ allocation: 'BOND', marketValue: 100 });
    assert.ok(!('securityId' in plain), 'but is absent by default — Option C is not on yet');
  });
});
