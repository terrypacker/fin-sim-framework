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
 * rebalance-dust-sweep.test.mjs — design 61 Lever C: liquidation remnants.
 *
 * Selling a sleeve down to a target weight that rounds to a sub-cent used to leave a
 * $0.01 remnant, and that remnant was IMMORTAL — too large for `_reduceProRata`'s
 * 0.001 prune, too small for the leg builder's `|delta| > 0.01` and the apply
 * reducer's `take <= 0.01`. The account then carried a phantom sleeve of an asset
 * class the policy said it must not hold, forever.
 *
 * These pin the sweep that closes it, and — just as importantly — pin that it stays
 * value- and basis-neutral, so no phantom cent of gain is created for a later year
 * to tax.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { RebalanceToTargetReducer }      from '../../src/finance/behavioral/rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer, _sweepDust }
  from '../../src/finance/behavioral/rebalance-to-target-apply-reducer.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }     from '../../src/finance/economic-regimes/rate-keys.js';

const APPLY = new RebalanceToTargetApplyReducer();

const H = (allocation, marketValue, costBasis, rateKey) => ({
  id: `h-${allocation}`, allocation, marketValue, costBasis, rateKey,
  costBaseByCountry: null, purchaseDate: new Date('2020-01-01'), acquisitionDateByCountry: null,
});

const account = (holdings, role = ACCOUNT_ROLES.US_STOCK) => ({
  stateKey: 'acct', role, type: 'brokerage', country: 'US', currency: { code: 'USD' },
  balance: +holdings.reduce((s, h) => s + h.marketValue, 0).toFixed(2), holdings,
});

/** One reducer→apply cycle; reports whether a rebalance actually fired. */
function step(acct, target, bands = {}) {
  const state = {
    activeRegimes: [], regimeActions: {},
    people: { p1: { residency: 'US' } },
    currentPeriods: { US: { startMs: Date.UTC(2030, 0, 1) }, AU: { startMs: Date.UTC(2030, 0, 1) } },
    [acct.stateKey]: acct,
  };
  const reducer = new RebalanceToTargetReducer({
    accounts: [{ stateKey: acct.stateKey, role: acct.role }],
    targetAllocation: target,
    driftBandTaxable: bands.taxable ?? 0.10, driftBandSheltered: bands.sheltered ?? 0.02,
  });
  const actions = reducer.reduce(state, { type: 'US_PERIOD_ADVANCE' }).next ?? [];
  let applied = state;
  for (const a of actions) applied = APPLY.reduce(applied, a);
  return { acct: applied[acct.stateKey], fired: actions.length > 0 };
}

const gross = a => +a.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0).toFixed(2);
const basis = a => +a.holdings.reduce((s, h) => s + (h.costBasis   ?? 0), 0).toFixed(2);
// Distinct asset classes present. A buy establishes its own dated lot (design 62 §9), so
// an account can legitimately hold several lots of one class — what matters here is that
// the liquidated CLASS is gone, not how many lots the survivors are spread over.
const classes = a => [...new Set(a.holdings.map(h => h.allocation))].sort();

// A target whose GOLD weight rounds to a sub-cent of the account: enough to make the
// sell leg stop one cent short, while EQUITY's 20-point drift fires the band.
const SUBCENT_GOLD = { EQUITY: 0.60, BOND: 0.40 - 1e-8, GOLD: 1e-8 };

test('dust sweep: a liquidated sleeve leaves no remnant', () => {
  const before = account([
    H(ALLOCATION.EQUITY, 800_000, 500_000, RATE_KEYS.EQUITY_US),
    H(ALLOCATION.BOND,   195_000, 195_000, RATE_KEYS.FIXED_INCOME_US),
    H(ALLOCATION.GOLD,     5_000,   4_000, RATE_KEYS.GOLD),
  ]);

  const { acct, fired } = step(before, SUBCENT_GOLD);
  assert.ok(fired, 'the 20-point EQUITY drift must breach the 10% taxable band');
  assert.deepEqual(classes(acct), [ALLOCATION.BOND, ALLOCATION.EQUITY],
    'GOLD must be gone entirely, not left at $0.01');
});

test('dust sweep: gross value is conserved through the rebalance', () => {
  const before = account([
    H(ALLOCATION.EQUITY, 800_000, 500_000, RATE_KEYS.EQUITY_US),
    H(ALLOCATION.BOND,   195_000, 195_000, RATE_KEYS.FIXED_INCOME_US),
    H(ALLOCATION.GOLD,     5_000,   4_000, RATE_KEYS.GOLD),
  ]);
  const { acct } = step(before, SUBCENT_GOLD);

  assert.equal(gross(acct), gross(before), 'gross value conserved');
  assert.equal(acct.balance, gross(acct), 'balance re-synced to the swept holdings');
  // NB: account-level cost basis is NOT conserved across a taxable rebalance, and
  // should not be — a FIFO sell re-bases the lots it consumes and a buy establishes
  // fresh basis at cost. The sweep's own basis-neutrality is pinned directly below.
});

// ── the sweep in isolation ──────────────────────────────────────────────────

test('_sweepDust: folds a remnant\'s market value AND basis into the largest survivor', () => {
  // Carrying only the market value would mint a cent of unrealized gain from nothing,
  // which a later year would then tax.
  const swept = _sweepDust([
    H(ALLOCATION.EQUITY, 600_000, 400_000, RATE_KEYS.EQUITY_US),
    H(ALLOCATION.BOND,   399_999.99, 399_999.99, RATE_KEYS.FIXED_INCOME_US),
    H(ALLOCATION.GOLD,        0.01,       0.008, RATE_KEYS.GOLD),
  ]);

  assert.equal(swept.length, 2, 'the dust lot is removed');
  const equity = swept.find(h => h.allocation === ALLOCATION.EQUITY);
  assert.equal(equity.marketValue, 600_000.01, 'market value folded into the largest lot');
  assert.equal(equity.costBasis,   400_000.01, 'basis folded with it (0.008 → 0.01 at 2dp)');
  assert.equal(+swept.reduce((s, h) => s + h.marketValue, 0).toFixed(2), 1_000_000);
});

test('_sweepDust: is a no-op when nothing is dust', () => {
  const holdings = [
    H(ALLOCATION.EQUITY, 600_000, 400_000, RATE_KEYS.EQUITY_US),
    H(ALLOCATION.BOND,   400_000, 400_000, RATE_KEYS.FIXED_INCOME_US),
  ];
  assert.equal(_sweepDust(holdings), holdings, 'same reference — no copy-on-write churn');
});

test('_sweepDust: leaves a wiped-out position (real basis) alone', () => {
  const holdings = [
    H(ALLOCATION.EQUITY, 600_000, 400_000, RATE_KEYS.EQUITY_US),
    H(ALLOCATION.GOLD,        0.01,  9_000, RATE_KEYS.GOLD),
  ];
  assert.equal(_sweepDust(holdings), holdings, 'a total unrealized loss is not dust');
});

test('dust sweep: the swept account is stable — no perpetual re-rebalancing', () => {
  let acct = account([
    H(ALLOCATION.EQUITY, 800_000, 500_000, RATE_KEYS.EQUITY_US),
    H(ALLOCATION.BOND,   195_000, 195_000, RATE_KEYS.FIXED_INCOME_US),
    H(ALLOCATION.GOLD,     5_000,   4_000, RATE_KEYS.GOLD),
  ]);
  ({ acct } = step(acct, SUBCENT_GOLD));
  const settled = gross(acct);

  for (let i = 0; i < 3; i++) {
    const r = step(acct, SUBCENT_GOLD);
    assert.equal(r.fired, false, 'a settled account must not keep rebalancing');
    acct = r.acct;
  }
  assert.equal(gross(acct), settled);
});

test('dust sweep: a sleeve worth a cent but carrying REAL basis is left alone', () => {
  // A holding worth $0.01 against $9,000 of basis is a total unrealized LOSS, not
  // dust. Folding its basis into another sleeve would move the loss onto the wrong
  // lot and mis-state a later disposal, so the sweep must not touch it.
  const before = account([
    H(ALLOCATION.EQUITY, 800_000, 500_000, RATE_KEYS.EQUITY_US),
    H(ALLOCATION.BOND,   199_999.99, 195_000, RATE_KEYS.FIXED_INCOME_US),
    H(ALLOCATION.GOLD,        0.01,   9_000, RATE_KEYS.GOLD),
  ]);
  const { acct } = step(before, SUBCENT_GOLD);

  const gold = acct.holdings.find(h => h.allocation === ALLOCATION.GOLD);
  assert.ok(gold, 'a wiped-out position must survive as its own lot');
  assert.equal(gold.costBasis, 9_000, 'its basis must not be folded elsewhere');
  assert.equal(gross(acct), gross(before), 'gross still conserved');
});

test('dust sweep: an all-dust account is left untouched rather than vanished', () => {
  // Degenerate, but folding with nothing to fold into would destroy the value.
  const before = account([
    H(ALLOCATION.EQUITY, 0.01, 0.01, RATE_KEYS.EQUITY_US),
    H(ALLOCATION.GOLD,   0.01, 0.01, RATE_KEYS.GOLD),
  ]);
  const { acct } = step(before, { EQUITY: 1.0 });
  assert.equal(gross(acct), 0.02, 'no value destroyed');
});

test('dust sweep: a freshly established sleeve is never mistaken for dust', () => {
  // A buy leg only runs above the same 0.01 threshold, so a new sleeve always lands
  // above DUST. Pin it, because lowering that guard would silently delete new sleeves.
  const before = account([
    H(ALLOCATION.EQUITY, 1_000_000, 700_000, RATE_KEYS.EQUITY_US),
  ]);
  const { acct } = step(before, { EQUITY: 0.60, BOND: 0.40 });

  const bond = acct.holdings.find(h => h.allocation === ALLOCATION.BOND);
  assert.ok(bond && bond.marketValue > 0.01, 'the established BOND sleeve survives');
  assert.equal(gross(acct), gross(before));
});
