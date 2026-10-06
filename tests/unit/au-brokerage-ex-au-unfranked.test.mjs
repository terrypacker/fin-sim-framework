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
 * au-brokerage-ex-au-unfranked.test.mjs — only an EQUITY_AU dividend is franked.
 *
 * The AU brokerage dividend handler used to route a resident's WHOLE payment through the
 * franked branch, so an ex-AU lot (VGS, MSCI World ex Australia) earned a 30/70 franking
 * credit on foreign income. Super never had this: `computeFundIncome` credits EQUITY_AU
 * lots only. These pin the brokerage to the same rule.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlAuStockDividendHandler } from '../../src/finance/handlers/earnings-handlers.js';
import {
  AuDividendUnfrankedResidentCashApplyReducer,
} from '../../src/finance/account-rules/au/au-brokerage-classes.js';
import { AuSingleHomeownerScenario } from '../../src/scenarios/au-single-homeowner-scenario.js';

const lots = () => [
  { id: 'h-vas', securityId: 'sec-vas', allocation: 'EQUITY', marketValue: 10_000, costBasis: 10_000,
    rateKey: 'EQUITY_AU', dividendYield: 0.04 },
  { id: 'h-vgs', securityId: 'sec-vgs', allocation: 'EQUITY', marketValue: 10_000, costBasis: 10_000,
    rateKey: 'EQUITY_INTL_EX_AU', dividendYield: 0.02 },
];

const stateWith = ({ residency = 'AU', holdings = lots(), reinvest = true } = {}) => ({
  auStockAccount: { stateKey: 'auStockAccount', balance: 20_000, holdings, reinvestDividends: reinvest },
  people: { primary: { residency } },
  securities: null,
});

const handler = () => new IntlAuStockDividendHandler({
  stateRegistry: null, role: 'AU_STOCK', ownerId: 'primary', stateKey: 'auStockAccount',
});

const applies = (out) => out.filter(a => a.type?.startsWith('AU_DIVIDEND_'))
  .map(a => ({ type: a.type, amount: a.amount }));

test('EXAU-1: a resident\'s ex-AU dividend is paid unfranked, the AU one franked', () => {
  const out = handler().call({ data: {}, state: stateWith() });
  assert.deepEqual(applies(out), [
    { type: 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY',   amount: 400 },
    { type: 'AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY', amount: 200 },
  ]);
  const unfranked = out.find(a => a.type === 'AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY');
  assert.deepEqual(unfranked._bySecurity, [{ securityId: 'sec-vgs', amount: 200 }],
    'the reinvestment still buys the security that paid');
});

test('EXAU-2: the cash branch splits the same way', () => {
  const out = handler().call({ data: {}, state: stateWith({ reinvest: false }) });
  assert.deepEqual(applies(out), [
    { type: 'AU_DIVIDEND_FRANKED_RESIDENT_CASH_APPLY',   amount: 400 },
    { type: 'AU_DIVIDEND_UNFRANKED_RESIDENT_CASH_APPLY', amount: 200 },
  ]);
});

test('EXAU-3: an all-AU account emits exactly one franked action, as before', () => {
  const out = handler().call({ data: {}, state: stateWith({ holdings: [lots()[0]] }) });
  assert.deepEqual(applies(out), [{ type: 'AU_DIVIDEND_FRANKED_RESIDENT_APPLY', amount: 400 }]);
});

test('EXAU-4: a non-resident is not split — that branch books no AU tax or credit', () => {
  const out = handler().call({ data: {}, state: stateWith({ residency: 'US' }) });
  assert.deepEqual(applies(out), [{ type: 'AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY', amount: 600 }]);
});

test('EXAU-5: the unfranked cash reducer pays the transaction account and taxes the payer', () => {
  let credited = null;
  const reducer = new AuDividendUnfrankedResidentCashApplyReducer({
    accountService: { transaction: (acct, amt) => { credited = { acct, amt }; } },
    stateRegistry:  { getStateKey: () => 'auSavings' },
  });
  const state = { ...stateWith(), auSavings: { stateKey: 'auSavings', balance: 0, isTransactionAccount: true, country: 'AU' } };
  const next = reducer.reduce(state, { type: 'AU_DIVIDEND_UNFRANKED_RESIDENT_CASH_APPLY', amount: 200, stateKey: 'auStockAccount' }, new Date());
  assert.equal(credited.amt, 200);
  const tax = next.next.find(a => a.type === 'AU_DIVIDEND_UNFRANKED_RESIDENT_TAX');
  assert.ok(tax, 'chains the unfranked tax action');
  assert.equal(tax.stateKey, 'auStockAccount');
  assert.equal(tax.frankedPercent, undefined, 'and no franking fields');
});

test('EXAU-6: AU Single Homeowner holds VAS and VGS in its brokerage, summing to the balance', () => {
  const cfg = AuSingleHomeownerScenario.buildDefaultConfig({});
  const brk = cfg.accounts.find(a => a.stateKey === 'auStockAccount');
  const bySec = Object.fromEntries(brk.holdings.map(h => [h.securityId, h]));
  assert.deepEqual(Object.keys(bySec).sort(), ['sec-vas', 'sec-vgs']);
  assert.equal(bySec['sec-vas'].rateKey, 'EQUITY_AU');
  assert.equal(bySec['sec-vgs'].rateKey, 'EQUITY_INTL_EX_AU');
  const sum = brk.holdings.reduce((t, h) => t + h.marketValue, 0);
  assert.equal(+sum.toFixed(2), brk.balance);
  const basis = brk.holdings.reduce((t, h) => t + h.costBasis, 0);
  assert.equal(+basis.toFixed(2), brk.contributionBasis);
  const ids = cfg.securities.map(s => s.id);
  assert.ok(ids.includes('sec-vas') && ids.includes('sec-vgs'));
});

test('EXAU-7: an elected-cash VGS dividend reaches the transaction account in a real run', async () => {
  const { specByName } = await import('../helpers/golden-specs.js');
  const { runGolden }  = await import('../helpers/golden-harness.js');
  const base = specByName('au-single-homeowner');
  const { sim } = runGolden({ ...base, simEnd: new Date(Date.UTC(2028, 0, 1)), mutateCfg: (cfg) => {
    cfg.accounts.find(a => a.stateKey === 'auStockAccount').reinvestDividends = false;
  } });
  const seen = new Set();
  const types = sim.journal.journal.map(e => e.action).filter(a => a && !seen.has(a) && seen.add(a)).map(a => a.type);
  assert.ok(types.includes('AU_DIVIDEND_UNFRANKED_RESIDENT_CASH_APPLY'), 'the cash branch fires');
  assert.ok(types.includes('AU_DIVIDEND_UNFRANKED_RESIDENT_TAX'), 'and the reducer chains its tax');
});
