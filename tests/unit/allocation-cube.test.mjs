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
 * allocation-cube.test.mjs — covers the pure state → fact-rows reduction backing
 * the allocation-over-time report.
 *
 * The cases that matter are the ones where a naive "sum the holdings" cube would be
 * silently WRONG rather than absent: an account with no holdings, holdings that do
 * not tie to the denormalized balance, a loan, and a foreign-currency account.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { buildAllocationCube, CUBE_SOURCE } from '../../src/finance/allocation-reporting/allocation-cube.js';
import { ASSET_CLASS, exposureCountryForRateKey, assetClassForAllocation }
  from '../../src/finance/allocation-reporting/asset-class.js';
import { ALLOCATION }      from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }       from '../../src/finance/economic-regimes/rate-keys.js';
import { computeNetWorth } from '../../src/finance/derived-metrics/net-worth.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const H = (allocation, marketValue, costBasis = marketValue, rateKey = null) =>
  ({ allocation, marketValue, costBasis, rateKey });

/** A minimal account state entry; `balance` defaults to the holdings sum (in sync). */
function acct(opts = {}) {
  const holdings = opts.holdings ?? [];
  return {
    stateKey: opts.stateKey ?? 'anAccount',
    balance:  opts.balance ?? holdings.reduce((s, h) => s + h.marketValue, 0),
    type:     opts.type     ?? 'brokerage',
    role:     opts.role     ?? 'us-stock',
    country:  opts.country  ?? 'US',
    currency: opts.currency ?? { code: 'USD' },
    holdings,
  };
}

const byClass = (rows, assetClass) => rows.filter(r => r.assetClass === assetClass);
const total   = rows => +rows.reduce((s, r) => s + r.marketValue, 0).toFixed(2);

// ── Shape ────────────────────────────────────────────────────────────────────

test('buildAllocationCube: tolerates a null / non-object state', () => {
  assert.deepEqual(buildAllocationCube(null), []);
  assert.deepEqual(buildAllocationCube(undefined), []);
  assert.deepEqual(buildAllocationCube({}), []);
});

test('buildAllocationCube: emits one row per (allocation, rateKey) bucket', () => {
  const rows = buildAllocationCube({
    brokerage: acct({
      stateKey: 'brokerage',
      holdings: [
        H(ALLOCATION.EQUITY, 600, 400, RATE_KEYS.EQUITY_US),
        H(ALLOCATION.BOND,   300, 300, RATE_KEYS.FIXED_INCOME_US),
        H(ALLOCATION.CASH,   100, 100, RATE_KEYS.SAVINGS_US),
      ],
    }),
  });

  assert.equal(rows.length, 3);
  assert.equal(total(rows), 1000);
  const equity = byClass(rows, ASSET_CLASS.EQUITY)[0];
  assert.equal(equity.marketValue, 600);
  assert.equal(equity.costBasis,   400);
  assert.equal(equity.source,      CUBE_SOURCE.HOLDING);
  assert.equal(equity.holdingCount, 1);
  assert.equal(equity.inferred,    false);
});

test('buildAllocationCube: folds a bond ladder into ONE row carrying the rung count', () => {
  // The reason buckets are the grain: 10 rungs must not become 10 legend entries.
  const rungs = Array.from({ length: 10 },
    () => H(ALLOCATION.BOND, 100, 100, RATE_KEYS.FIXED_INCOME_US));
  const rows = buildAllocationCube({ ira: acct({ stateKey: 'ira', holdings: rungs }) });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].holdingCount, 10);
  assert.equal(rows[0].marketValue, 1000);
});

test('buildAllocationCube: same allocation on DIFFERENT rate keys stays split', () => {
  // Splitting on rateKey is what preserves the exposure-country view; folding
  // purely on allocation would erase an AU sleeve held inside a US wrapper.
  const rows = buildAllocationCube({
    brokerage: acct({
      stateKey: 'brokerage',
      holdings: [
        H(ALLOCATION.EQUITY, 700, 700, RATE_KEYS.EQUITY_US),
        H(ALLOCATION.EQUITY, 300, 300, RATE_KEYS.EQUITY_AU),
      ],
    }),
  });

  assert.equal(rows.length, 2);
  assert.equal(total(rows), 1000);
});

// ── The two country columns ─────────────────────────────────────────────────

test('buildAllocationCube: a foreign sleeve in a domestic wrapper splits the country columns', () => {
  const rows = buildAllocationCube({
    brokerage: acct({
      stateKey: 'brokerage',
      country:  'US',
      holdings: [H(ALLOCATION.EQUITY, 1000, 1000, RATE_KEYS.EQUITY_AU)],
    }),
  });

  // Domicile says US (the wrapper is a US brokerage — the tax view); exposure says
  // AU (the money tracks the AU market — the risk view). Both are true, which is
  // exactly why one "country" column would have been a lie.
  assert.equal(rows[0].domicileCountry, 'US');
  assert.equal(rows[0].exposureCountry, 'AU');
});

test('buildAllocationCube: a country-agnostic series keeps a null exposure country', () => {
  const rows = buildAllocationCube({
    vault: acct({
      stateKey: 'vault',
      country:  'US',
      holdings: [H(ALLOCATION.GOLD, 500, 500, RATE_KEYS.GOLD)],
    }),
  });

  assert.equal(rows[0].assetClass,      ASSET_CLASS.GOLD);
  assert.equal(rows[0].domicileCountry, 'US');
  assert.equal(rows[0].exposureCountry, null);
});

test('buildAllocationCube: an unrecognised rateKey falls back to the domicile', () => {
  const rows = buildAllocationCube({
    brokerage: acct({
      stateKey: 'brokerage',
      country:  'AU',
      holdings: [H(ALLOCATION.EQUITY, 100, 100, 'NOT_A_REAL_KEY')],
    }),
  });

  // undefined (unknown) must behave differently from null (deliberately agnostic).
  assert.equal(exposureCountryForRateKey('NOT_A_REAL_KEY'), undefined);
  assert.equal(rows[0].exposureCountry, 'AU');
});

test('exposureCountryForRateKey: strips a per-account `::` extension', () => {
  assert.equal(exposureCountryForRateKey(`${RATE_KEYS.SAVINGS_AU}::auSavingsAccount`), 'AU');
  assert.equal(exposureCountryForRateKey(null), undefined);
});

// ── The silently-wrong cases ────────────────────────────────────────────────

test('buildAllocationCube: an account with NO holdings is synthesized, not dropped', () => {
  // A tier-2 legacy account. Dropping it would leave every share on the chart
  // wrong with nothing on screen to explain why.
  const rows = buildAllocationCube({
    oldSavings: {
      stateKey: 'oldSavings', balance: 25_000,
      type: 'savings', role: 'us-savings', country: 'US', currency: { code: 'USD' },
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].source,      CUBE_SOURCE.ACCOUNT_BALANCE);
  assert.equal(rows[0].assetClass,  ASSET_CLASS.CASH);
  assert.equal(rows[0].marketValue, 25_000);
  assert.equal(rows[0].holdingCount, 0);
  assert.equal(rows[0].inferred,    true, 'the mix is assumed, and must say so');
});

test('buildAllocationCube: an unclassifiable account surfaces as UNKNOWN, never throws', () => {
  // resolveDefaultAllocation throws for a role-less, type-less account. Inside the
  // sim that is correct; in a report it must degrade to a visible band.
  const rows = buildAllocationCube({
    mystery: { stateKey: 'mystery', balance: 1234, type: null, role: null },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].assetClass, ASSET_CLASS.UNKNOWN);
  assert.equal(rows[0].marketValue, 1234);
});

test('buildAllocationCube: a zero-balance holdings-less account emits nothing', () => {
  const rows = buildAllocationCube({
    empty: { stateKey: 'empty', balance: 0, type: 'savings', role: 'us-savings' },
  });
  assert.deepEqual(rows, []);
});

test('buildAllocationCube: holdings/balance drift is emitted as a reconciliation row', () => {
  // The known desync: a balance edit does not rescale holdings. The cube must still
  // tie to the balance, with the gap labelled rather than absorbed.
  const rows = buildAllocationCube({
    brokerage: acct({
      stateKey: 'brokerage',
      balance:  1000,
      holdings: [H(ALLOCATION.EQUITY, 600, 600, RATE_KEYS.EQUITY_US)],
    }),
  });

  assert.equal(rows.length, 2);
  const recon = rows.find(r => r.source === CUBE_SOURCE.RECONCILIATION);
  assert.ok(recon, 'the residual must be visible');
  assert.equal(recon.marketValue, 400);
  assert.equal(recon.assetClass,  ASSET_CLASS.UNKNOWN);
  assert.equal(recon.inferred,    true);
  assert.equal(total(rows), 1000, 'the cube must tie to account.balance');
});

test('buildAllocationCube: sub-tolerance drift is treated as rounding', () => {
  const rows = buildAllocationCube({
    brokerage: acct({
      stateKey: 'brokerage',
      balance:  1000.4,
      holdings: [H(ALLOCATION.EQUITY, 1000, 1000, RATE_KEYS.EQUITY_US)],
    }),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows.filter(r => r.source === CUBE_SOURCE.RECONCILIATION).length, 0);
});

test('buildAllocationCube: reconcileToBalance:false leaves the residual out', () => {
  const rows = buildAllocationCube({
    brokerage: acct({
      stateKey: 'brokerage', balance: 1000,
      holdings: [H(ALLOCATION.EQUITY, 600, 600, RATE_KEYS.EQUITY_US)],
    }),
  }, { reconcileToBalance: false });

  assert.equal(rows.length, 1);
  assert.equal(total(rows), 600);
});

// ── FX ──────────────────────────────────────────────────────────────────────

test('buildAllocationCube: converts to base currency on the net-worth convention', () => {
  const rows = buildAllocationCube({
    effectiveExchangeRates: { USD_AUD: 1.5 },
    super_: acct({
      stateKey: 'super_', country: 'AU', currency: { code: 'AUD' },
      holdings: [H(ALLOCATION.EQUITY, 150_000, 150_000, RATE_KEYS.EQUITY_AU)],
    }),
  }, { baseCurrency: 'USD' });

  const row = rows[0];
  assert.equal(row.currency,         'AUD');
  assert.equal(row.marketValueLocal, 150_000, 'local stays in the account currency');
  assert.equal(row.marketValue,      100_000, 'base divides by the USD_AUD pair');
  assert.equal(row.costBasis,        100_000);
});

test('buildAllocationCube: a missing FX rate degrades to 1:1 rather than NaN', () => {
  const rows = buildAllocationCube({
    super_: acct({
      stateKey: 'super_', country: 'AU', currency: { code: 'AUD' },
      holdings: [H(ALLOCATION.EQUITY, 1000, 1000, RATE_KEYS.EQUITY_AU)],
    }),
  });
  assert.equal(rows[0].marketValue, 1000);
});

// ── Liabilities and non-holding assets ──────────────────────────────────────

test('buildAllocationCube: a loan is a NEGATIVE liability row, so a sum nets', () => {
  const rows = buildAllocationCube({
    house:     { kind: 'real-property', value: 900_000, costBasis: 500_000, country: 'US', currency: { code: 'USD' } },
    houseLoan: { stateKey: 'houseLoan', balance: 400_000, type: 'loan', role: 'us-loan', country: 'US', currency: { code: 'USD' } },
  });

  const loan = rows.find(r => r.assetClass === ASSET_CLASS.LIABILITY);
  assert.equal(loan.marketValue, -400_000);
  assert.equal(loan.source,      CUBE_SOURCE.LIABILITY);

  // Sum everything → net equity. Filter the liability out → the gross-asset
  // denominator a mix needs. One table, both questions.
  assert.equal(total(rows), 500_000);
  assert.equal(total(rows.filter(r => r.assetClass !== ASSET_CLASS.LIABILITY)), 900_000);
});

test('buildAllocationCube: includeLiabilities:false drops loans entirely', () => {
  const rows = buildAllocationCube({
    houseLoan: { stateKey: 'houseLoan', balance: 400_000, type: 'loan' },
  }, { includeLiabilities: false });
  assert.deepEqual(rows, []);
});

test('buildAllocationCube: non-holding assets get report-only classes', () => {
  const rows = buildAllocationCube({
    house:      { kind: 'real-property', value: 900_000, country: 'US', currency: { code: 'USD' } },
    startup:    { kind: 'company',       value: 250_000, country: 'US', currency: { code: 'USD' } },
    paintings:  { kind: 'collectible',   value:  40_000, country: 'US', currency: { code: 'USD' } },
  });

  assert.equal(byClass(rows, ASSET_CLASS.REAL_ESTATE)[0].marketValue,    900_000);
  assert.equal(byClass(rows, ASSET_CLASS.PRIVATE_EQUITY)[0].marketValue, 250_000);
  assert.equal(byClass(rows, ASSET_CLASS.COLLECTIBLE)[0].marketValue,     40_000);
  for (const row of rows) {
    assert.equal(row.source,     CUBE_SOURCE.ASSET);
    assert.equal(row.allocation, null, 'non-holding assets have no ALLOCATION at all');
    assert.equal(row.rateKey,    null);
  }
});

test('buildAllocationCube: includeNonHoldingAssets:false gives the investable-only view', () => {
  const state = {
    house:     { kind: 'real-property', value: 900_000, country: 'US', currency: { code: 'USD' } },
    brokerage: acct({ stateKey: 'brokerage', holdings: [H(ALLOCATION.EQUITY, 100_000, 100_000, RATE_KEYS.EQUITY_US)] }),
  };

  assert.equal(total(buildAllocationCube(state)), 1_000_000);
  assert.equal(total(buildAllocationCube(state, { includeNonHoldingAssets: false })), 100_000);
});

test('buildAllocationCube: real property nets a legacy mortgageBalance scalar', () => {
  // Current scenarios keep the mortgage on a LoanAccount and leave this field at 0
  // by design; mirroring computeNetWorth keeps a legacy state consistent too.
  const rows = buildAllocationCube({
    house: { kind: 'real-property', value: 900_000, mortgageBalance: 300_000, country: 'US', currency: { code: 'USD' } },
  });
  assert.equal(rows[0].marketValue, 600_000);
});

// ── Plumbing ────────────────────────────────────────────────────────────────

test('buildAllocationCube: stamps the sample date and resolves display names', () => {
  const date = new Date('2030-12-31T00:00:00Z');
  const rows = buildAllocationCube(
    { brokerage: acct({ stateKey: 'brokerage', holdings: [H(ALLOCATION.EQUITY, 10, 10)] }) },
    { date, displayNameFor: k => (k === 'brokerage' ? 'Joint Brokerage' : null) },
  );

  assert.equal(rows[0].name, 'Joint Brokerage');
  assert.equal(rows[0].date.getTime(), date.getTime());
  assert.notEqual(rows[0].date, date, 'the stamp must be a copy, not a live alias');
});

test('buildAllocationCube: falls back to the stateKey when a name resolver throws', () => {
  const rows = buildAllocationCube(
    { brokerage: acct({ stateKey: 'brokerage', holdings: [H(ALLOCATION.EQUITY, 10, 10)] }) },
    { displayNameFor: () => { throw new Error('registry not booted'); } },
  );
  assert.equal(rows[0].name, 'brokerage');
});

// ── THE INVARIANT ───────────────────────────────────────────────────────────

test('buildAllocationCube: the cube total equals computeNetWorth', () => {
  // The property that makes every share on the chart trustworthy: a denominator
  // that omits an asset misstates EVERY slice, not just the missing one. Built to
  // exercise each branch at once — accounts, a foreign wrapper, a loan, and all
  // three non-holding asset kinds.
  const state = {
    effectiveExchangeRates: { USD_AUD: 1.4 },
    brokerage: acct({
      stateKey: 'brokerage',
      holdings: [
        H(ALLOCATION.EQUITY, 400_000, 250_000, RATE_KEYS.EQUITY_US),
        H(ALLOCATION.BOND,   100_000, 100_000, RATE_KEYS.FIXED_INCOME_US),
      ],
    }),
    superFund: acct({
      stateKey: 'superFund', country: 'AU', currency: { code: 'AUD' }, role: 'super', type: 'super',
      holdings: [H(ALLOCATION.EQUITY, 700_000, 500_000, RATE_KEYS.EQUITY_AU)],
    }),
    legacySavings: { stateKey: 'legacySavings', balance: 30_000, type: 'savings', role: 'us-savings', country: 'US', currency: { code: 'USD' } },
    usHouseProperty:     { kind: 'real-property', value: 900_000, country: 'US', currency: { code: 'USD' } },
    usHousePropertyLoan: { stateKey: 'usHousePropertyLoan', balance: 525_000, type: 'loan', role: 'us-loan', country: 'US', currency: { code: 'USD' } },
    startup:   { kind: 'company',     value: 250_000, country: 'US', currency: { code: 'USD' } },
    paintings: { kind: 'collectible', value:  40_000, country: 'US', currency: { code: 'USD' } },
  };

  const rows = buildAllocationCube(state, { baseCurrency: 'USD' });
  assert.equal(total(rows), +computeNetWorth(state, 'USD').toFixed(2));
});

test('buildAllocationCube: a loan is counted even when it is not a registered account', () => {
  // The regression that only a real plan exposed. Loan accounts do not register
  // under the `account` display kind, so any inclusion rule narrower than net
  // worth's own drops them — and the cube then runs high by the outstanding
  // principal, decaying to zero as the mortgage amortizes. `type: 'loan'` is
  // therefore tested first and on its own.
  const state = {
    usHouseProperty:     { kind: 'real-property', value: 900_000, country: 'US', currency: { code: 'USD' } },
    usHousePropertyLoan: { stateKey: 'usHousePropertyLoan', balance: 525_000, type: 'loan', country: 'US', currency: { code: 'USD' } },
  };

  const rows = buildAllocationCube(state);
  assert.equal(byClass(rows, ASSET_CLASS.LIABILITY).length, 1, 'the loan must appear');
  assert.equal(total(rows), +computeNetWorth(state, 'USD').toFixed(2));
});

test('buildAllocationCube: row order is stable regardless of state key order', () => {
  const holdings = [
    H(ALLOCATION.BOND,   1, 1, RATE_KEYS.FIXED_INCOME_US),
    H(ALLOCATION.EQUITY, 1, 1, RATE_KEYS.EQUITY_US),
  ];
  const a = buildAllocationCube({ zed: acct({ stateKey: 'zed', holdings }), abe: acct({ stateKey: 'abe', holdings }) });
  const b = buildAllocationCube({ abe: acct({ stateKey: 'abe', holdings }), zed: acct({ stateKey: 'zed', holdings }) });
  assert.deepEqual(a.map(r => `${r.stateKey}/${r.assetClass}`), b.map(r => `${r.stateKey}/${r.assetClass}`));
});

test('assetClassForAllocation: total over the closed ALLOCATION enum', () => {
  for (const allocation of Object.values(ALLOCATION)) {
    assert.notEqual(assetClassForAllocation(allocation), ASSET_CLASS.UNKNOWN,
      `${allocation} must have a reporting class`);
  }
  assert.equal(assetClassForAllocation('SOMETHING_NEW'), ASSET_CLASS.UNKNOWN);
});

// ── The security column (design 94 §3 item 6 / step 9) ───────────────────────

/**
 * `rateKey` names the MARKET a bucket tracks, and until Option C that was the finest
 * thing the cube could say. It is not the same question as "what do I own": a plan with
 * 40% in one employer's stock and a plan with 40% in a total-market fund produce the
 * identical `rateKey` row, and concentration — the risk an allocation view exists to
 * show — was invisible in it.
 *
 * The tests below pin the two halves of that: the column SPLITS where two instruments
 * share a sleeve, and it splits NOWHERE ELSE — because every migrated equity lot names
 * the synthetic security for its own market, so the new key adds no cardinality to any
 * scenario in the repo.
 */

const SECURITIES = {
  'sec-emp':  { id: 'sec-emp',  symbol: 'EMP', name: 'Employer stock', rateKey: RATE_KEYS.EQUITY_US },
  'sec-idx':  { id: 'sec-idx',  name: 'Index fund (no ticker)',        rateKey: RATE_KEYS.EQUITY_US },
  'sec-auto-EQUITY_US': { id: 'sec-auto-EQUITY_US', symbol: '', name: 'US market', rateKey: RATE_KEYS.EQUITY_US },
};

const SH = (securityId, marketValue, costBasis, over = {}) =>
  ({ allocation: ALLOCATION.EQUITY, rateKey: RATE_KEYS.EQUITY_US, securityId, marketValue, costBasis, ...over });

test('cube: two securities in ONE sleeve are two rows — the case rateKey alone cannot show', () => {
  const rows = buildAllocationCube({
    securities: SECURITIES,
    brokerage: acct({ stateKey: 'brokerage',
      holdings: [SH('sec-emp', 400, 100), SH('sec-idx', 600, 500)] }),
  });
  const equity = byClass(rows, ASSET_CLASS.EQUITY);
  assert.equal(equity.length, 2);
  assert.deepEqual(equity.map(r => r.security).sort(), ['EMP', 'Index fund (no ticker)']);
  // Symbol, then name, then the id — an authored security without a ticker still gets a
  // legend entry a reader can identify rather than an opaque key.
  assert.equal(equity.find(r => r.securityId === 'sec-emp').security, 'EMP');
  // …and the money is unchanged: this splits a row, it does not move a dollar.
  assert.equal(total(equity), 1000);
});

test('cube: the security key adds NO cardinality to a migrated book', () => {
  // Every lot names the synthetic for its market (design 94 §9.1), so
  // `(EQUITY, EQUITY_US, sec-auto-EQUITY_US)` is the same partition as `(EQUITY, EQUITY_US)`.
  // If this ever produced more rows than the pre-step-9 cube, every existing chart would
  // have gained bands for a change that was supposed to be additive.
  const holdings = [
    SH('sec-auto-EQUITY_US', 300, 200),
    SH('sec-auto-EQUITY_US', 200, 150),
    H(ALLOCATION.BOND, 500, 500, RATE_KEYS.FIXED_INCOME_US),
  ];
  const rows = buildAllocationCube({ securities: SECURITIES, brokerage: acct({ stateKey: 'brokerage', holdings }) });
  assert.equal(rows.length, 2);
  const equity = byClass(rows, ASSET_CLASS.EQUITY)[0];
  assert.equal(equity.holdingCount, 2);
  assert.equal(equity.marketValue, 500);
});

test('cube: an un-securitised lot carries a null security rather than a made-up one', () => {
  const rows = buildAllocationCube({
    brokerage: acct({ stateKey: 'brokerage', holdings: [H(ALLOCATION.EQUITY, 100, 80, RATE_KEYS.EQUITY_US)] }),
  });
  assert.equal(rows[0].securityId, null);
  assert.equal(rows[0].security, null);
});

test('cube: units are summed only when EVERY lot in the bucket has them', () => {
  // A partial sum is worse than no number: it is an undercount presented as a count,
  // which is the shape design 93 §5 spent eight defects on.
  const mixed = buildAllocationCube({
    securities: SECURITIES,
    brokerage: acct({ stateKey: 'brokerage', holdings: [
      SH('sec-emp', 400, 100, { units: 40, pricePerUnit: 10 }),
      SH('sec-emp', 600, 500),                                    // scalar
    ] }),
  });
  assert.equal(byClass(mixed, ASSET_CLASS.EQUITY)[0].units, null);

  const allUnitised = buildAllocationCube({
    securities: SECURITIES,
    brokerage: acct({ stateKey: 'brokerage', holdings: [
      SH('sec-emp', 400, 100, { units: 40, pricePerUnit: 10 }),
      SH('sec-emp', 600, 500, { units: 60, pricePerUnit: 10 }),
    ] }),
  });
  assert.equal(byClass(allUnitised, ASSET_CLASS.EQUITY)[0].units, 100);
});

test('cube: THE INVARIANT still holds once the security splits a bucket', () => {
  // Σ rows === computeNetWorth is what makes every share on the chart trustworthy, and a
  // change to the BUCKET KEY is exactly the kind that could double-count silently.
  const state = {
    securities: SECURITIES,
    brokerage: acct({ stateKey: 'brokerage',
      holdings: [SH('sec-emp', 400, 100), SH('sec-idx', 600, 500)] }),
    savings: acct({ stateKey: 'savings', type: 'savings', role: 'us-savings',
      holdings: [H(ALLOCATION.CASH, 250, 250, RATE_KEYS.SAVINGS_US)] }),
  };
  const rows = buildAllocationCube(state);
  assert.equal(total(rows), +computeNetWorth(state).toFixed(2));
});

test('cube: row order is stable when two securities tie on every other key', () => {
  // Without `securityId` in the sort these two rows tie on (stateKey, assetClass,
  // rateKey) and fall back to insertion order — which is `Object.entries` order, the
  // very thing the sort exists to remove.
  const build = (first, second) => buildAllocationCube({
    securities: SECURITIES,
    brokerage: acct({ stateKey: 'brokerage', holdings: [SH(first, 100, 50), SH(second, 200, 150)] }),
  }).map(r => r.securityId);
  assert.deepEqual(build('sec-emp', 'sec-idx'), build('sec-idx', 'sec-emp'));
});
