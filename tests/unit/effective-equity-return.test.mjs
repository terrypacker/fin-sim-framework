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
 * effective-equity-return.test.mjs — design 99 P3: an account's expected equity return,
 * derived from its holdings by the engine's own resolution (market from the instrument
 * or the role default, yield from the instrument or the market), blended by value.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { effectiveEquityReturn } from '../../src/finance/holdings/effective-return.js';
import { MARKET_GROWTH_PARAMS, marketReturnFor } from '../../src/finance/economic-regimes/market-returns.js';
import { RATE_KEYS }     from '../../src/finance/economic-regimes/rate-keys.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';

const ratesFrom = (p = {}) => Object.fromEntries(MARKET_GROWTH_PARAMS.map(m => [m.rateKey, marketReturnFor(p, m.rateKey)]));
const DEFAULTS = ratesFrom();
const US = DEFAULTS[RATE_KEYS.EQUITY_US], AU = DEFAULTS[RATE_KEYS.EQUITY_AU];
const near = (a, b) => Math.abs(a - b) < 1e-12;

const lot = (over = {}) => ({ id: 'h', allocation: 'EQUITY', rateKey: RATE_KEYS.EQUITY_US, marketValue: 100_000, ...over });

test('ER-1: a US brokerage lot — the US total, split into price and a paid-out yield (taxable)', () => {
  const r = effectiveEquityReturn({ holdings: [lot()], country: 'US', role: ACCOUNT_ROLES.US_STOCK, marketRates: DEFAULTS });
  assert.ok(near(r.total, US.total) && near(r.yield, US.yield) && near(r.price, US.total - US.yield));
  assert.equal(r.taxable, true);
});

test('ER-2: a Roth is a wrapper — the yield is a slice of the total, not paid out', () => {
  const r = effectiveEquityReturn({ holdings: [lot()], country: 'US', role: ACCOUNT_ROLES.ROTH, marketRates: DEFAULTS });
  assert.equal(r.taxable, false);
  assert.ok(near(r.total, US.total));
});

test('ER-3: two markets blend by market value, at the plan\'s own market rates', () => {
  const rates = ratesFrom({ usEquityGrowthRate: 0.08, intlExUsEquityGrowthRate: 0.06 });
  const r = effectiveEquityReturn({
    holdings: [lot({ marketValue: 60_000 }), lot({ id: 'x', rateKey: RATE_KEYS.EQUITY_INTL_EX_US, marketValue: 40_000 })],
    country: 'US', role: ACCOUNT_ROLES.ROTH, marketRates: rates,
  });
  assert.ok(near(r.total, 0.6 * 0.08 + 0.4 * 0.06));
  assert.equal(r.lots, 2);
});

test('ER-4: the yield chain is security → lot → market, and a security names the market', () => {
  const securities = { emp: { id: 'emp', rateKey: RATE_KEYS.EQUITY_AU, dividendYield: 0.006 } };
  const viaSecurity = effectiveEquityReturn({
    holdings: [lot({ securityId: 'emp', dividendYield: 0.03 })],
    country: 'US', role: ACCOUNT_ROLES.US_STOCK, securities, marketRates: DEFAULTS,
  });
  assert.ok(near(viaSecurity.yield, 0.006), 'the security\'s yield wins over the lot\'s');
  assert.ok(near(viaSecurity.total, AU.total), 'and its AU market supplies the total');

  const viaLot = effectiveEquityReturn({ holdings: [lot({ dividendYield: 0.03 })], country: 'US',
    role: ACCOUNT_ROLES.US_STOCK, marketRates: DEFAULTS });
  assert.ok(near(viaLot.yield, 0.03) && near(viaLot.price, US.total - 0.03));
});

test('ER-5: a lot with no Rate Key resolves by role and country — super → AU', () => {
  const r = effectiveEquityReturn({ holdings: [lot({ rateKey: '' })], country: 'AU', role: ACCOUNT_ROLES.SUPER,
    marketRates: ratesFrom({ auEquityGrowthRate: 0.065 }) });
  assert.ok(near(r.total, 0.065) && near(r.yield, AU.yield));
});

test('ER-6: scheduled lots are counted, not blended; non-equity lots are ignored', () => {
  const r = effectiveEquityReturn({
    holdings: [
      lot(),
      lot({ id: 's', appreciationSchedule: [{ year: 2027, rate: 0.2 }] }),
      { id: 'b', allocation: 'BOND', rateKey: RATE_KEYS.FIXED_INCOME_US, marketValue: 500_000 },
    ],
    country: 'US', role: ACCOUNT_ROLES.IRA, marketRates: DEFAULTS,
  });
  assert.equal(r.lots, 1);
  assert.equal(r.scheduled, 1);
  assert.ok(near(r.total, US.total), 'the $500k bond does not dilute the equity return');
});

test('ER-7: unvalued new lots weigh equally; no equity lot ⇒ null', () => {
  const r = effectiveEquityReturn({
    holdings: [lot({ marketValue: 0 }), lot({ id: 'x', rateKey: RATE_KEYS.EQUITY_AU, marketValue: 0 })],
    country: 'US', role: ACCOUNT_ROLES.ROTH, marketRates: DEFAULTS,
  });
  assert.ok(near(r.yield, (US.yield + AU.yield) / 2));
  assert.equal(effectiveEquityReturn({ holdings: [], country: 'US', marketRates: DEFAULTS }), null);
});
