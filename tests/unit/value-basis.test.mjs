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
 * value-basis.test.mjs — design 79 P1: the opt-in real-basis hop.
 *
 * The property everything else rests on is that deflation is OPT-IN: a caller that
 * names no instant gets nominal under either basis, so MC aggregates, journal rows and
 * tax documents cannot be deflated by the live state by accident (design 79 R2).
 */

import { test }   from 'node:test';
import assert      from 'node:assert/strict';

import { ServiceRegistry }     from '../../src/services/service-registry.js';
import { StateSchemaRegistry, ParameterValueType } from '../../src/finance/services/state-schema-registry.js';
import { CurrencyConverter }   from '../../src/finance/fx/currency-converter.js';
import { countryForCurrency }  from '../../src/finance/country-codes.js';
import { liveJournalPriceLevels } from '../../src/finance/journal-reporting/journal-price-levels.js';
import { FieldFormatter }      from '../../src/visualization/state/field-format.js';
import { fmtWhole }            from '../../src/visualization/money-format.js';

const LIVE = { effectiveExchangeRates: { USD_AUD: 1.5 }, inflationAccumulator: { US: 2, AU: 4 } };

function makeReg({ display = 'USD', basis = 'real', state = LIVE } = {}) {
  const reg = new StateSchemaRegistry();
  reg.currencyConverter = new CurrencyConverter();
  reg.displaySettings   = { displayCurrency: display, valueBasis: basis };
  reg.rateStateProvider = () => state;
  return reg;
}

// ── the country rule ────────────────────────────────────────────────────────

test('countryForCurrency: inverse of currencyForCountry; unknown → null', () => {
  assert.equal(countryForCurrency('USD'), 'US');
  assert.equal(countryForCurrency('AUD'), 'AU');
  assert.equal(countryForCurrency('EUR'), null);
  assert.equal(countryForCurrency(undefined), null);
});

// ── opt-in ──────────────────────────────────────────────────────────────────

test('presentForDisplay: nominal basis never deflates, even with an instant named', () => {
  const reg = makeReg({ basis: 'nominal' });
  assert.deepEqual(reg.presentForDisplay(1000, 'USD', { at: 'live' }),
    { value: 1000, code: 'USD', symbol: '$', basis: 'nominal' });
});

test('presentForDisplay: real basis with NO instant stays nominal (the R2 guard)', () => {
  const reg = makeReg();
  assert.deepEqual(reg.presentForDisplay(1000, 'USD'),
    { value: 1000, code: 'USD', symbol: '$', basis: 'nominal' });
  assert.equal(reg.formatAmount(1000, 'USD'), '$1,000.00');
});

test('presentForDisplay: "live" deflates by the rate state\'s level for the SHOWN currency', () => {
  // USD display: US level.
  assert.equal(makeReg().presentForDisplay(1000, 'USD', { at: 'live' }).value, 500);
  // AUD display: convert first (×1.5), then the AU level (÷4) — not US, not native.
  const aud = makeReg({ display: 'AUD' }).presentForDisplay(1000, 'USD', { at: 'live' });
  assert.deepEqual(aud, { value: 375, code: 'AUD', symbol: 'A$', basis: 'real' });
});

test('presentForDisplay: a value left native (no FX rate) deflates by its native country', () => {
  const state = { inflationAccumulator: { US: 2, AU: 4 } };   // no exchange rate recorded
  const reg   = makeReg({ display: 'USD', state });
  assert.deepEqual(reg.presentForDisplay(1000, 'AUD', { at: 'live' }),
    { value: 250, code: 'AUD', symbol: 'A$', basis: 'real' });
});

test('presentForDisplay: an explicit priceLevel map beats the rate state', () => {
  const reg = makeReg();
  assert.equal(reg.presentForDisplay(1000, 'USD', { priceLevel: { US: 1.25 } }).value, 800);
});

test('presentForDisplay: a timestamp reads the injected price-level source', () => {
  const reg = makeReg();
  const asked = [];
  reg.priceLevelSource = { levelAt: (ts, cc) => { asked.push([ts, cc]); return 1.6; } };
  assert.equal(reg.presentForDisplay(800, 'USD', { at: new Date(Date.UTC(2040, 0, 1)) }).value, 500);
  assert.deepEqual(asked, [[Date.UTC(2040, 0, 1), 'US']]);
});

test('presentForDisplay: no recorded level ⇒ nominal and SAYS so, never ÷ an assumed 1', () => {
  const reg = makeReg({ state: { inflationAccumulator: {} } });
  assert.equal(reg.presentForDisplay(1000, 'USD', { at: 'live' }).basis, 'nominal');
  assert.equal(reg.presentForDisplay(1000, 'USD', { at: Date.now() }).basis, 'nominal'); // no source
  assert.equal(reg.presentForDisplay(1000, 'USD', { priceLevel: { US: 0 } }).basis, 'nominal');
});

// ── the path-typed hop ──────────────────────────────────────────────────────

test('format: deflates a value ALREADY in the display currency (not only converted ones)', () => {
  const reg = makeReg();
  reg.register('x.balance', ParameterValueType.currency('USD'));
  assert.equal(reg.format('x.balance', 1000), reg.format('x.balance', 1000, {}));      // nominal, no instant
  assert.notEqual(reg.format('x.balance', 1000, { at: 'live' }), reg.format('x.balance', 1000));
  assert.equal(reg.format('x.balance', 1000, { at: 'live' }), reg.format('x.balance', 500));
});

test('FieldFormatter: forwards the instant, and valueTitle names the level divided by', () => {
  const reg = makeReg();
  reg.register('x.balance', ParameterValueType.currency('USD'));
  const f = new FieldFormatter({ registry: reg });
  assert.equal(f.format('x.balance', 1000, { priceLevel: { US: 2 } }), reg.format('x.balance', 500));
  assert.equal(f.format('x.balance', 1000), reg.format('x.balance', 1000));
  assert.match(f.valueTitle('x.balance', 1000, { priceLevel: { US: 2 } }), /nominal ÷ 2\.0000 price level/);
  assert.equal(f.valueTitle('x.balance', 1000), null);
});

test('fmtWhole: forwards opts; without them an MC-style aggregate stays nominal', () => {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance().schemaRegistry;
  reg.displaySettings   = { displayCurrency: 'USD', valueBasis: 'real' };
  reg.rateStateProvider = () => LIVE;
  assert.match(fmtWhole(1_000_000), /\$1,000,000/);
  assert.match(fmtWhole(1_000_000, 'USD', { at: 'live' }), /\$500,000/);
  ServiceRegistry.resetAll();
});

// ── the dated source over a growing journal ─────────────────────────────────

test('liveJournalPriceLevels: rebuilds when the journal grows, not on every read', () => {
  const entry = (y, before, after) => ({
    date: new Date(Date.UTC(y, 0, 1)),
    stateDiff: [{ field: 'inflationAccumulator.US', before, after }],
  });
  const journal = { journal: [entry(2027, 1, 1.03)] };
  const src = liveJournalPriceLevels(() => journal);
  const ts2029 = Date.UTC(2029, 5, 1);
  assert.equal(src.levelAt(ts2029, 'US'), 1.03);

  journal.journal.push(entry(2028, 1.03, 1.0609));
  assert.equal(src.levelAt(ts2029, 'US'), 1.0609);
  assert.equal(src.levelAt(Date.UTC(2026, 5, 1), 'US'), 1);   // before the first diff: its `before`
});
