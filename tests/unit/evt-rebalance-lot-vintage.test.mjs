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
 * evt-rebalance-lot-vintage.test.mjs — design 62 §9: a rebalance BUY is a purchase
 * made TODAY.
 *
 * The buy leg used to spread its dollars pro-rata across the sleeve's existing lots:
 * `marketValue` and `costBasis` moved, `purchaseDate` did not. Freshly bought units
 * inherited the sleeve's original acquisition date, so every holding-period rule —
 * the AU Division 115 12-month discount gate, the post-2027 indexation clock, the
 * residency deemed-acquisition clock — read them as seasoned the instant they were
 * bought. On a semiannual cadence, money bought at one rebalance and sold at the next
 * was six months old and got the 50% discount anyway.
 *
 * These pin the three things the fix has to be true for at once:
 *   1. the six-month lot is NOT discount-eligible (and the seasoned one still is);
 *   2. a buy inherits the sleeve's TRAITS but none of its dates or bases;
 *   3. the lot count stays bounded over a 44-year run.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { RebalanceToTargetReducer }      from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer, _compactSeasonedLots }
  from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }     from '../../src/finance/economic-regimes/rate-keys.js';

const APPLY = new RebalanceToTargetApplyReducer();

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** One reducer→apply cycle at `atMs`; returns the post-apply account + emitted taxes. */
function rebalance(acct, target, { atMs, residency = 'US', bands = {} } = {}) {
  const state = {
    activeRegimes: [], regimeActions: {},
    people: { p1: { residency } },
    currentPeriods: { US: { startMs: atMs }, AU: { startMs: atMs } },
    [acct.stateKey]: acct,
  };
  const reducer = new RebalanceToTargetReducer({
    accounts: [{ stateKey: acct.stateKey, role: acct.role }],
    targetAllocation: target,
    driftBandTaxable: bands.taxable ?? 0.10, driftBandSheltered: bands.sheltered ?? 0.02,
  });
  const actions = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' }).next ?? [];
  let applied = state;
  let taxes   = [];
  for (const a of actions) {
    applied = APPLY.reduce(applied, a);
    taxes   = [...taxes, ...(applied.next ?? [])];
  }
  return { acct: applied[acct.stateKey], taxes, fired: actions.length > 0 };
}

const account = (holdings, role = ACCOUNT_ROLES.US_STOCK, stateKey = 'acct') => ({
  stateKey, role, type: 'brokerage', country: role === ACCOUNT_ROLES.AU_STOCK ? 'AU' : 'US',
  currency: { code: 'USD' },
  balance: +holdings.reduce((s, h) => s + h.marketValue, 0).toFixed(2), holdings,
});

const lotsOf = (a, cls) => a.holdings.filter(h => h.allocation === cls);
const mvOf   = (a, cls) => +lotsOf(a, cls).reduce((s, h) => s + (h.marketValue ?? 0), 0).toFixed(2);
const gross  = a => +a.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0).toFixed(2);

/** Apply a market move to one class: marketValue scales, costBasis does not. */
function grow(acct, cls, factor) {
  const holdings = acct.holdings.map(h => h.allocation !== cls ? h
    : { ...h, marketValue: +(h.marketValue * factor).toFixed(2) });
  return { ...acct, holdings, balance: +holdings.reduce((s, h) => s + h.marketValue, 0).toFixed(2) };
}

// ── 1. The six-month lot is not discount-eligible ────────────────────────────────

test('RLV-1: money bought at one rebalance and sold at the next is NOT AU-discount eligible', () => {
  // An AU-resident taxable account holding a small, long-seasoned BOND sleeve. The first
  // rebalance buys $40k MORE bond — which used to land inside the 2015 lot and inherit
  // its date. Six months later the whole sleeve is sold.
  const start = account([
    { id: 'h-EQUITY', allocation: ALLOCATION.EQUITY, marketValue: 90_000, costBasis: 90_000,
      rateKey: RATE_KEYS.EQUITY_AU, purchaseDate: new Date(Date.UTC(2015, 0, 1)),
      costBaseByCountry: null, acquisitionDateByCountry: null },
    { id: 'h-BOND',   allocation: ALLOCATION.BOND,   marketValue: 10_000, costBasis: 10_000,
      rateKey: RATE_KEYS.FIXED_INCOME_AU, purchaseDate: new Date(Date.UTC(2015, 0, 1)),
      costBaseByCountry: null, acquisitionDateByCountry: null },
  ], ACCOUNT_ROLES.AU_STOCK);

  const bought = rebalance(start, { EQUITY: 0.5, BOND: 0.5 },
    { atMs: Date.UTC(2030, 0, 1), residency: 'AU' });
  assert.ok(bought.fired, 'the 40-point drift breaches the taxable band');
  const bondLots = lotsOf(bought.acct, ALLOCATION.BOND);
  assert.equal(bondLots.length, 2, 'the buy is its own lot, not folded into the 2015 lot');
  assert.equal(mvOf(bought.acct, ALLOCATION.BOND), 50_000);

  // The bond sleeve gains 20% over the next six months, then the whole of it is sold.
  const grown = grow(bought.acct, ALLOCATION.BOND, 1.2);   // 12,000 + 48,000
  const sold  = rebalance(grown, { EQUITY: 1.0 },
    { atMs: Date.UTC(2030, 6, 1), residency: 'AU' });

  const tax = sold.taxes.find(t => t.type === 'AU_STOCK_WITHDRAWAL_TAX'
                                && t.description === 'rebalance' && t.proceeds >= 59_000);
  assert.ok(tax, 'the bond liquidation emits an AU CGT action');
  assert.equal(tax.auGain, 10_000, 'total AU gain: 2,000 seasoned + 8,000 six-month-old');
  // The whole point: only the 2015 lot's gain is discountable. Before the fix this read
  // 10,000 — the $40k bought in January carried a 2015 purchase date.
  assert.equal(tax.auDiscountableGain, 2_000,
    'only the seasoned lot\'s gain qualifies for the Division 115 discount');
});

test('RLV-2: the same lot IS discount-eligible once it has been held twelve months', () => {
  // The control for RLV-1 — same shapes, sold 18 months after the buy instead of 6.
  const start = account([
    { id: 'h-EQUITY', allocation: ALLOCATION.EQUITY, marketValue: 90_000, costBasis: 90_000,
      rateKey: RATE_KEYS.EQUITY_AU, purchaseDate: new Date(Date.UTC(2015, 0, 1)),
      costBaseByCountry: null, acquisitionDateByCountry: null },
    { id: 'h-BOND',   allocation: ALLOCATION.BOND,   marketValue: 10_000, costBasis: 10_000,
      rateKey: RATE_KEYS.FIXED_INCOME_AU, purchaseDate: new Date(Date.UTC(2015, 0, 1)),
      costBaseByCountry: null, acquisitionDateByCountry: null },
  ], ACCOUNT_ROLES.AU_STOCK);

  const bought = rebalance(start, { EQUITY: 0.5, BOND: 0.5 },
    { atMs: Date.UTC(2030, 0, 1), residency: 'AU' });
  const grown  = grow(bought.acct, ALLOCATION.BOND, 1.2);
  const sold   = rebalance(grown, { EQUITY: 1.0 },
    { atMs: Date.UTC(2031, 6, 1), residency: 'AU' });

  const tax = sold.taxes.find(t => t.type === 'AU_STOCK_WITHDRAWAL_TAX' && t.proceeds >= 59_000);
  assert.ok(tax);
  assert.equal(tax.auGain, 10_000);
  assert.equal(tax.auDiscountableGain, 10_000, 'both lots are now past the 12-month mark');
});

// ── 2. A buy inherits traits, never dates or bases ───────────────────────────────

test('RLV-3: a buy leaves the existing lot\'s purchaseDate and basis untouched', () => {
  const start = account([
    { id: 'h-EQUITY', allocation: ALLOCATION.EQUITY, marketValue: 100_000, costBasis: 60_000,
      rateKey: RATE_KEYS.EQUITY_US, purchaseDate: new Date(Date.UTC(2018, 3, 9)) },
    { id: 'h-BOND',   allocation: ALLOCATION.BOND,   marketValue: 100_000, costBasis: 100_000,
      rateKey: RATE_KEYS.FIXED_INCOME_US, purchaseDate: new Date(Date.UTC(2018, 3, 9)) },
  ], ACCOUNT_ROLES.IRA);   // sheltered ⇒ the sell realizes nothing, keeping the test to the buy

  const { acct } = rebalance(start, { EQUITY: 0.8, BOND: 0.2 }, { atMs: Date.UTC(2030, 0, 1) });

  const old   = acct.holdings.find(h => h.id === 'h-EQUITY');
  const fresh = lotsOf(acct, ALLOCATION.EQUITY).find(h => h.id !== 'h-EQUITY');
  assert.equal(old.marketValue, 100_000, 'the pre-existing lot is not topped up');
  assert.equal(old.costBasis,    60_000, 'nor is its basis');
  assert.equal(old.purchaseDate.getTime(), Date.UTC(2018, 3, 9), 'nor is its date rewritten');
  assert.ok(fresh, 'the buy landed in a new lot');
  assert.equal(fresh.purchaseDate.getTime(), Date.UTC(2030, 0, 1), 'stamped with today');
  assert.equal(fresh.costBasis, fresh.marketValue, 'fresh basis = cost');
  assert.equal(gross(acct), gross(start), 'gross value conserved');
});

test('RLV-4: a buy inherits the sleeve\'s unanimous traits, but not a mixed one', () => {
  // A treasury BOND sleeve: buying more of it must stay state-tax exempt on the same
  // rate series, or design 59's per-holding treasury flag silently dilutes.
  const treasury = account([
    { id: 'h-EQUITY', allocation: ALLOCATION.EQUITY, marketValue: 150_000, costBasis: 150_000,
      rateKey: RATE_KEYS.EQUITY_US, dividendYield: 0.017, purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
    { id: 'h-BOND',   allocation: ALLOCATION.BOND,   marketValue: 50_000, costBasis: 50_000,
      rateKey: RATE_KEYS.FIXED_INCOME_US, taxExemption: 'state', issuingState: null,
      duration: 1, purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
  ], ACCOUNT_ROLES.US_STOCK);

  const { acct } = rebalance(treasury, { EQUITY: 0.4, BOND: 0.6 }, { atMs: Date.UTC(2030, 0, 1) });
  const fresh = lotsOf(acct, ALLOCATION.BOND).find(h => h.id !== 'h-BOND');
  assert.ok(fresh, 'the bond buy is its own lot');
  assert.equal(fresh.taxExemption, 'state', 'the state-tax exemption follows the sleeve');
  assert.equal(fresh.rateKey,  RATE_KEYS.FIXED_INCOME_US);
  assert.equal(fresh.duration, 1, 'the instrument\'s duration follows the sleeve');

  // A sleeve that DISAGREES gets the plain defaults instead of an arbitrary lot's traits.
  const mixed = account([
    { id: 'h-EQUITY', allocation: ALLOCATION.EQUITY, marketValue: 150_000, costBasis: 150_000,
      rateKey: RATE_KEYS.EQUITY_US, purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
    { id: 'h-BOND-a', allocation: ALLOCATION.BOND, marketValue: 25_000, costBasis: 25_000,
      rateKey: RATE_KEYS.FIXED_INCOME_US, taxExemption: 'state', purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
    { id: 'h-BOND-b', allocation: ALLOCATION.BOND, marketValue: 25_000, costBasis: 25_000,
      rateKey: RATE_KEYS.FIXED_INCOME_US, taxExemption: 'none',  purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
  ], ACCOUNT_ROLES.US_STOCK);

  const mixedOut = rebalance(mixed, { EQUITY: 0.4, BOND: 0.6 }, { atMs: Date.UTC(2030, 0, 1) }).acct;
  const mixedFresh = lotsOf(mixedOut, ALLOCATION.BOND).find(h => !h.id.startsWith('h-'));
  assert.equal(mixedFresh.taxExemption, 'none', 'a mixed sleeve falls back to the generic default');
});

test('RLV-5: a buy does not inherit a residency step-up basis (the AU-gain overstatement)', () => {
  // The pro-rata add raised `costBasis` but left `costBaseByCountry` alone, so every
  // dollar bought into a stepped-up lot showed up later as pure AU gain.
  const start = account([
    { id: 'h-EQUITY', allocation: ALLOCATION.EQUITY, marketValue: 100_000, costBasis: 40_000,
      rateKey: RATE_KEYS.EQUITY_US, purchaseDate: new Date(Date.UTC(2015, 0, 1)),
      costBaseByCountry: { AU: 90_000 },
      acquisitionDateByCountry: { AU: Date.UTC(2028, 6, 1) } },
    { id: 'h-BOND', allocation: ALLOCATION.BOND, marketValue: 100_000, costBasis: 100_000,
      rateKey: RATE_KEYS.FIXED_INCOME_US, purchaseDate: new Date(Date.UTC(2015, 0, 1)),
      costBaseByCountry: null, acquisitionDateByCountry: null },
  ], ACCOUNT_ROLES.IRA);

  const { acct } = rebalance(start, { EQUITY: 0.8, BOND: 0.2 }, { atMs: Date.UTC(2030, 0, 1) });
  const fresh = lotsOf(acct, ALLOCATION.EQUITY).find(h => h.id !== 'h-EQUITY');
  assert.equal(fresh.costBaseByCountry, null,
    'newly bought units have no per-country step-up history — their AU base is their cost');
  assert.equal(fresh.acquisitionDateByCountry, null,
    'nor a deemed-acquisition date they were never present for');
  const old = acct.holdings.find(h => h.id === 'h-EQUITY');
  assert.deepEqual(old.costBaseByCountry, { AU: 90_000 }, 'the stepped-up lot is left alone');
});

test('RLV-6: a CASH buy still merges — a currency unit has no holding period', () => {
  const start = account([
    { id: 'h-EQUITY', allocation: ALLOCATION.EQUITY, marketValue: 180_000, costBasis: 100_000,
      rateKey: RATE_KEYS.EQUITY_US, purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
    { id: 'h-CASH', allocation: ALLOCATION.CASH, marketValue: 20_000, costBasis: 20_000,
      rateKey: RATE_KEYS.SAVINGS_US, purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
  ], ACCOUNT_ROLES.IRA);

  const { acct } = rebalance(start, { EQUITY: 0.7, CASH: 0.3 }, { atMs: Date.UTC(2030, 0, 1) });
  const cash = lotsOf(acct, ALLOCATION.CASH);
  assert.equal(cash.length, 1, 'the cash sleeve stays one lot');
  assert.equal(cash[0].id, 'h-CASH');
  assert.equal(cash[0].marketValue, 60_000);
});

// ── 3. Bounded growth ────────────────────────────────────────────────────────────

test('RLV-7: _compactSeasonedLots merges only its own seasoned, identical lots', () => {
  const now = Date.UTC(2035, 0, 1);
  const lots = [
    // authored — never merged into, even though it matches on every other field
    { id: 'h-EQUITY', allocation: ALLOCATION.EQUITY, marketValue: 100, costBasis: 80,
      rateKey: RATE_KEYS.EQUITY_US, purchaseDate: new Date(Date.UTC(2020, 0, 1)) },
    // ours, seasoned ×2 ⇒ merge
    { id: 'reb-EQUITY-a', allocation: ALLOCATION.EQUITY, marketValue: 200, costBasis: 150,
      rateKey: RATE_KEYS.EQUITY_US, purchaseDate: new Date(Date.UTC(2030, 0, 1)) },
    { id: 'reb-EQUITY-b', allocation: ALLOCATION.EQUITY, marketValue: 300, costBasis: 275,
      rateKey: RATE_KEYS.EQUITY_US, purchaseDate: new Date(Date.UTC(2032, 0, 1)) },
    // ours, but bought six months ago ⇒ still distinguishable, left alone
    { id: 'reb-EQUITY-c', allocation: ALLOCATION.EQUITY, marketValue: 400, costBasis: 400,
      rateKey: RATE_KEYS.EQUITY_US, purchaseDate: new Date(Date.UTC(2034, 6, 1)) },
    // ours and seasoned, but a different rate series ⇒ not fungible
    { id: 'reb-EQUITY-d', allocation: ALLOCATION.EQUITY, marketValue: 500, costBasis: 500,
      rateKey: RATE_KEYS.EQUITY_AU, purchaseDate: new Date(Date.UTC(2031, 0, 1)) },
  ];

  const out = _compactSeasonedLots(lots, now);
  assert.equal(out.length, 4, 'exactly the two seasoned, identical lots collapse');
  const merged = out.find(h => h.id === 'reb-EQUITY-a');
  assert.ok(merged, 'the survivor is the EARLIER lot, so FIFO order is preserved');
  assert.equal(merged.marketValue, 500);
  assert.equal(merged.costBasis,   425, 'basis is summed, not averaged away');
  assert.equal(merged.purchaseDate.getTime(), Date.UTC(2030, 0, 1));
  assert.equal(+out.reduce((s, h) => s + h.marketValue, 0).toFixed(2), 1500, 'value conserved');
  assert.equal(+out.reduce((s, h) => s + h.costBasis,   0).toFixed(2), 1405, 'basis conserved');
});

test('RLV-8: a merge blends couponRate and duration by market value', () => {
  const now = Date.UTC(2040, 0, 1);
  const out = _compactSeasonedLots([
    { id: 'reb-BOND-1', allocation: ALLOCATION.BOND, marketValue: 1_000, costBasis: 1_000,
      rateKey: RATE_KEYS.FIXED_INCOME_US, couponRate: 0.03, duration: 5,
      purchaseDate: new Date(Date.UTC(2030, 0, 1)) },
    { id: 'reb-BOND-2', allocation: ALLOCATION.BOND, marketValue: 3_000, costBasis: 3_000,
      rateKey: RATE_KEYS.FIXED_INCOME_US, couponRate: 0.07, duration: 5,
      purchaseDate: new Date(Date.UTC(2032, 0, 1)) },
  ], now);
  assert.equal(out.length, 1);
  assert.equal(out[0].couponRate, 0.06, 'mv-weighted: (1000×3% + 3000×7%) / 4000');
  assert.equal(out[0].duration,   5);
  // A floating-coupon lot is not fungible with one that locked a rate.
  const mixedNull = _compactSeasonedLots([
    { id: 'reb-BOND-1', allocation: ALLOCATION.BOND, marketValue: 1_000, costBasis: 1_000,
      couponRate: null, purchaseDate: new Date(Date.UTC(2030, 0, 1)) },
    { id: 'reb-BOND-2', allocation: ALLOCATION.BOND, marketValue: 1_000, costBasis: 1_000,
      couponRate: 0.05, purchaseDate: new Date(Date.UTC(2030, 0, 1)) },
  ], now);
  assert.equal(mixedNull.length, 2, 'a floating coupon never merges into a locked one');
});

test('RLV-9: the holdings array stays bounded over a 44-year semiannual cadence', () => {
  // The cost of splitting a lot per buy is unbounded growth, and every lot costs a
  // per-holding growth/dividend/coupon action every period. 88 firings, drifting hard
  // enough to trade at every one of them.
  let acct = account([
    { id: 'h-EQUITY', allocation: ALLOCATION.EQUITY, marketValue: 600_000, costBasis: 400_000,
      rateKey: RATE_KEYS.EQUITY_US, purchaseDate: new Date(Date.UTC(2025, 0, 1)) },
    { id: 'h-BOND',   allocation: ALLOCATION.BOND,   marketValue: 400_000, costBasis: 400_000,
      rateKey: RATE_KEYS.FIXED_INCOME_US, purchaseDate: new Date(Date.UTC(2025, 0, 1)) },
  ], ACCOUNT_ROLES.IRA);

  const target = { EQUITY: 0.6, BOND: 0.4 };
  let peak = acct.holdings.length;
  let fired = 0;
  for (let i = 0; i < 88; i++) {
    const atMs = Date.UTC(2026, 0, 1) + Math.round(i * YEAR_MS / 2);
    // Equity runs ahead of bonds every period against a deliberately tight band, so a
    // trade fires at essentially every firing — the worst case for lot growth.
    acct = grow(grow(acct, ALLOCATION.EQUITY, 1.05), ALLOCATION.BOND, 1.01);
    const r = rebalance(acct, target, { atMs, bands: { sheltered: 0.005 } });
    if (r.fired) fired++;
    acct = r.acct;
    peak = Math.max(peak, acct.holdings.length);
  }

  assert.ok(fired > 80, `the cadence must actually trade (fired ${fired}/88)`);
  // Steady state: the authored lot + one compacted seasoned lot + the trailing 12
  // months' buys, per class. Anything beyond that means compaction stopped working.
  assert.ok(peak <= 8, `holdings peaked at ${peak} lots over 88 rebalances (expected ≤ 8)`);
  assert.equal(acct.balance, gross(acct), 'balance still tracks Σ marketValue');
});
