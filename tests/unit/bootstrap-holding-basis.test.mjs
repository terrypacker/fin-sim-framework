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
 * bootstrap-holding-basis.test.mjs — a bootstrapped lot keeps the plan's stated basis.
 *
 * `_bootstrapDefaultHolding` opened every default lot at `costBasis = balance`. On a
 * taxable account the basis lives only on its lots, so the authored `contributionBasis`
 * was dropped and the embedded gain it described was never taxed. Found when AU Single
 * Homeowner's brokerage got explicit lots and its golden fell 147k: the gain had been
 * missing all along.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AccountService }   from '../../src/finance/services/account-service.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { EventBus }         from '../../src/simulation-framework/event-bus.js';
import { Graph }            from '../../src/graph/graph.js';
import { GraphQueryApi }    from '../../src/graph/graph-query-api.js';
import { specByName }       from '../helpers/golden-specs.js';
import { runGolden }        from '../helpers/golden-harness.js';

const service = () => new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
/** Build a record the way the loader does, then register it (which bootstraps its lots). */
const load = (record) => {
  const acct = ScenarioSerializer._makeAccount({ country: 'AU', currency: 'AUD', ...record });
  service().register(acct);
  return acct;
};
const sum = (hs, f) => +hs.reduce((t, h) => t + h[f], 0).toFixed(2);

test('BOOT-BASIS-1: a taxable account\'s lot opens at its authored contributionBasis', () => {
  const acct = load({ __type: 'BrokerageAccount', role: 'au-stock', balance: 150_000, contributionBasis: 110_000 });
  assert.equal(acct.holdings.length, 1);
  assert.equal(acct.holdings[0].marketValue, 150_000);
  assert.equal(acct.holdings[0].costBasis, 110_000);
  assert.ok(!('_openingCostBasis' in acct), 'the hand-off is consumed, so it never reaches state');
});

test('BOOT-BASIS-2: with no authored basis the lot opens at the balance, as before', () => {
  const acct = load({ __type: 'BrokerageAccount', role: 'au-stock', balance: 150_000 });
  assert.equal(acct.holdings[0].costBasis, 150_000);
});

test('BOOT-BASIS-3: a multi-market split divides the basis in the value ratio, exactly', () => {
  const acct = ScenarioSerializer._makeAccount({ __type: 'BrokerageAccount', role: 'au-stock', country: 'AU',
    currency: 'AUD', balance: 150_000, contributionBasis: 110_000 });
  acct.equityMarketMix = { EQUITY_AU: 0.6, EQUITY_INTL_EX_AU: 0.4 };
  service().register(acct);
  assert.equal(acct.holdings.length, 2);
  assert.equal(sum(acct.holdings, 'marketValue'), 150_000);
  assert.equal(sum(acct.holdings, 'costBasis'), 110_000);
  const au = acct.holdings.find(h => h.rateKey === 'EQUITY_AU');
  assert.equal(au.costBasis, 66_000);
});

test('BOOT-BASIS-4: a retirement wrapper keeps costBasis = value (its contributionBasis is a ledger)', () => {
  const acct = load({ __type: 'SuperannuationAccount', role: 'super', balance: 320_000, contributionBasis: 100_000 });
  assert.equal(sum(acct.holdings, 'costBasis'), 320_000);
});

test('BOOT-BASIS-5: through the loader, an un-lotted AU brokerage carries its stated basis', () => {
  const base = specByName('au-single-homeowner');
  const { state } = runGolden({ ...base, simEnd: new Date(Date.UTC(2026, 0, 2)), mutateCfg: (c) => {
    delete c.accounts.find(a => a.stateKey === 'auStockAccount').holdings;
  } });
  const hs = state.auStockAccount.holdings;
  assert.equal(sum(hs, 'marketValue'), 150_000);
  assert.equal(sum(hs, 'costBasis'), 110_000, 'the 40k embedded gain survives the bootstrap');
});
