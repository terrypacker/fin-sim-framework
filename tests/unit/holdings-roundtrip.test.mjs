/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { Account, USD }       from '../../src/finance/assets/account.js';
import { BrokerageAccount }   from '../../src/finance/assets/investment-account.js';
import { Holding }            from '../../src/finance/holdings/holding.js';
import { ALLOCATION }         from '../../src/finance/holdings/allocation.js';

function makeStockAccount() {
  return new BrokerageAccount(20_000, {
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
  assert.equal(serialized.holdings.length, 2);
  assert.equal(serialized.holdings[0].__type, 'Holding');

  // Deserialize → fresh account
  const restored = ScenarioSerializer._makeAccount(serialized);
  assert.equal(restored.holdings.length, 2);
  assert.equal(restored.holdings[0].id, 'hldA');
  assert.equal(restored.holdings[0].allocation, 'EQUITY');
  assert.equal(restored.holdings[0].marketValue, 12_000);
  assert.equal(restored.holdings[0].costBasis,    9_000);
  assert.equal(restored.holdings[0].rateKey,      'EQUITY_US');
  assert.equal(restored.holdings[0].label,        'ITOT');
  assert.equal(restored.holdings[0].purchaseDate.toISOString(), original.holdings[0].purchaseDate.toISOString());
  assert.equal(restored.holdings[0].acquisitionPriceLevel, 1.08);
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
