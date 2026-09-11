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
 * retired-rate-params.test.mjs — design 99 P2 §4: dropping the equity rates an account
 * used to carry.
 *
 * The rule under test is design 99 D-2: a retired value that the market now reproduces is
 * dropped SILENTLY (every library default is one, which is why the cut-over moves no
 * golden); a value that differs is dropped with a WARNING, because it was someone's
 * statement about their plan. Nothing is converted.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { retireRateParams, RETIRED_RATE_PARAMS } from '../../src/scenarios/retired-rate-params.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { marketReturnFor } from '../../src/finance/economic-regimes/market-returns.js';

const US = marketReturnFor({}, 'EQUITY_US'), AU = marketReturnFor({}, 'EQUITY_AU');
const collect = () => { const msgs = []; return { msgs, warn: m => msgs.push(m) }; };

test('RRP-1: a retired param equal to what the market gives is dropped silently', () => {
  // Values the current market defaults reproduce exactly (docs/market-returns/SOURCES.md).
  const cfg = { parameters: {
    rothGrowthRate: US.total, iraGrowthRate: US.total, k401GrowthRate: US.total, superGrowthRate: AU.total,
    brokerageGrowthRate: US.total - US.yield, brokerageDividendRate: US.yield,
    auStockGrowthRate:   AU.total - AU.yield, auStockDividendRate:   AU.yield,
    usStockGrowthRate:   US.total - US.yield, stockDividendRate:     US.yield,   // the intl-retirement aliases
  } };
  const { msgs, warn } = collect();
  retireRateParams(cfg, { warn });
  assert.deepEqual(msgs, []);
  for (const key of Object.keys(RETIRED_RATE_PARAMS)) {
    assert.equal(key in cfg.parameters, false, `${key} dropped`);
  }
});

test('RRP-2: a retired param that differs is dropped WITH a warning naming the equivalent', () => {
  const cfg = {
    parameters: { brokerageGrowthRate: 0.06 },
    params:     [{ name: 'brokerageGrowthRate', value: 0.06 }, { name: 'monthlyExpenses', value: 5000 }],
  };
  const { msgs, warn } = collect();
  retireRateParams(cfg, { warn });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /brokerageGrowthRate/);
  assert.match(msgs[0], /6%/);
  assert.match(msgs[0], /5\.9%/, 'names the equivalent (the US total − its yield)');
  assert.equal('brokerageGrowthRate' in cfg.parameters, false);
  assert.deepEqual(cfg.params.map(p => p.name), ['monthlyExpenses'], 'typed entry removed, others kept');
});

test('RRP-3: the equivalent follows the plan\'s OWN market rates, not the defaults', () => {
  // With a 9% US total and 3% yield, a brokerage price rate of 6% changes nothing.
  const cfg = { parameters: {
    usEquityGrowthRate: 0.09, usEquityDividendYield: 0.03,
    brokerageGrowthRate: 0.06, rothGrowthRate: 0.09, brokerageDividendRate: 0.03,
  } };
  const { msgs, warn } = collect();
  retireRateParams(cfg, { warn });
  assert.deepEqual(msgs, []);
  assert.equal(cfg.parameters.usEquityGrowthRate, 0.09, 'market params are kept');
});

test('RRP-4: an equity account\'s own rate fields are dropped, warned only when they differ', () => {
  const cfg = {
    parameters: {},
    accounts: [
      { stateKey: 'usStockAccount', role: ACCOUNT_ROLES.US_STOCK, growthRate: US.total - US.yield, dividendRate: US.yield },
      { stateKey: 'rothAccount',    role: ACCOUNT_ROLES.ROTH,     growthRate: 0.10, dividendYield: US.yield },
      { stateKey: 'superAccount',   role: ACCOUNT_ROLES.SUPER,    growthRate: null },
    ],
  };
  const { msgs, warn } = collect();
  retireRateParams(cfg, { warn });
  assert.equal(msgs.length, 1, 'only the Roth\'s 10% differs');
  assert.match(msgs[0], /rothAccount/);
  for (const a of cfg.accounts) {
    for (const f of ['growthRate', 'dividendRate', 'dividendYield']) {
      assert.equal(f in a, false, `${a.stateKey}.${f} removed`);
    }
  }
});

test('RRP-5: a bank account keeps its own interestRate — a contract with one bank (D-5)', () => {
  const acct = { stateKey: 'usSavingsAccount', role: ACCOUNT_ROLES.US_SAVINGS, interestRate: 0.05 };
  retireRateParams({ parameters: {}, accounts: [acct] }, { warn: () => assert.fail('no warning') });
  assert.equal(acct.interestRate, 0.05);
});

test('RRP-7: a fixed-income account\'s interestRate is retired (design 99 P3b)', () => {
  const same = { stateKey: 'fixedIncomeAccount', role: ACCOUNT_ROLES.FIXED_INCOME, interestRate: 0.04 };
  const diff = { stateKey: 'auFixedIncomeAccount', role: ACCOUNT_ROLES.AU_FIXED_INCOME, interestRate: 0.055 };
  const { msgs, warn } = collect();
  retireRateParams({ parameters: {}, accounts: [same, diff] }, { warn });
  assert.equal(msgs.length, 1, 'the 4% one equals the US default and is dropped silently');
  assert.match(msgs[0], /auFixedIncomeAccount/);
  assert.equal('interestRate' in same, false);
  assert.equal('interestRate' in diff, false);
});

test('RRP-7b: a wrapper\'s interestRate fed TWO rates — silent only when it equals both', () => {
  const roth = () => ({ stateKey: 'rothAccount', role: ACCOUNT_ROLES.ROTH, interestRate: 0.04 });
  const { msgs, warn } = collect();
  // Defaults: US savings 3%, fixed income 4% — 4% matches the bond coupon, not the cash.
  retireRateParams({ parameters: {}, accounts: [roth()] }, { warn });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /usSavingsInterestRate 3%/);
  // A plan whose savings and fixed-income rates are both 4% changes nothing.
  retireRateParams({ parameters: { usSavingsInterestRate: 0.04 }, accounts: [roth()] },
    { warn: () => assert.fail('no warning') });
});

test('RRP-8: the mirrored interest defaults match the toolset schemas', async () => {
  const { INTEREST_DEFAULTS } = await import('../../src/scenarios/retired-rate-params.js');
  const { IntlRetirementScenario } = await import('../../src/scenarios/intl-retirement-scenario.js');
  const schema = new Map(IntlRetirementScenario.buildFullParamSchema().map(e => [e.key, e.defaultValue]));
  for (const [k, v] of Object.entries(INTEREST_DEFAULTS)) {
    assert.equal(schema.get(k), v, `${k} default`);
  }
});

test('RRP-6: idempotent — a second pass finds nothing', () => {
  const cfg = { parameters: { superGrowthRate: 0.2 } };
  const first = retireRateParams(cfg, { warn: () => {} });
  const again = retireRateParams(cfg, { warn: () => {} });
  assert.equal(first.length, 1);
  assert.deepEqual(again, []);
});
