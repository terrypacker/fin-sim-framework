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
 * equity-market-sub-axis.test.mjs — design 90 §7.3.
 *
 * The equity MARKET is a sub-axis *under* `ALLOCATION.EQUITY`, not a new member of it.
 * That choice is what keeps the rebalancer, the glidepath, drawdown selection and the
 * reporting cube untouched: they all assume a closed four-value allocation enum, and the
 * market split lives one level down.
 *
 * Three properties this file pins:
 *
 *   1. **Inert by default.** No authored mix and no international share ⇒ one domestic
 *      sleeve, exactly as before the axis existed. This is what let step 6 land with a
 *      golden diff containing no balance, no tax and no net-worth change.
 *   2. **Value-exact when it does split.** `balance === Σ marketValue` is the §4.4
 *      invariant and a mix must not break it at any weight.
 *   3. **ALLOCATION is untouched.** A mixed account still reads as 100% EQUITY to
 *      everything above the sub-axis.
 *
 * Run with: node --test tests/unit/equity-market-sub-axis.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AccountService }   from '../../src/finance/services/account-service.js';
import { ACCOUNT_TYPE }     from '../../src/finance/assets/account.js';
import { ACCOUNT_ROLES }    from '../../src/finance/state/account-roles.js';
import { ALLOCATION }       from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }        from '../../src/finance/economic-regimes/rate-keys.js';
import { resolveEquityMarketMix, EQUITY_MARKETS_BY_COUNTRY }
  from '../../src/finance/holdings/default-allocations.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2032, 0, 1));

/** Bootstrap an account's default holdings through the real service path. */
function bootstrap(account) {
  const svc = new AccountService();
  svc._bootstrapDefaultHolding(account);
  return account.holdings;
}

const acct = (o = {}) => ({
  type: ACCOUNT_TYPE.ROTH, role: ACCOUNT_ROLES.ROTH, country: 'US',
  balance: 100_000, holdings: [], ...o,
});

// ─── 1. Inert by default ────────────────────────────────────────────────────

test('§7.3: no authored mix ⇒ ONE domestic sleeve, exactly as before the axis', () => {
  const h = bootstrap(acct());
  assert.equal(h.length, 1);
  assert.equal(h[0].rateKey, RATE_KEYS.EQUITY_US);
  assert.equal(h[0].marketValue, 100_000);
});

test('§7.3: resolveEquityMarketMix defaults to the account\'s domestic market alone', () => {
  assert.deepEqual(resolveEquityMarketMix(acct()),                  { [RATE_KEYS.EQUITY_US]: 1 });
  assert.deepEqual(resolveEquityMarketMix(acct({ country: 'AU' })), { [RATE_KEYS.EQUITY_AU]: 1 });
});

test('§7.3: a 0 international share stamps NO mix — the axis stays dormant', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig(
    { usEquityIntlShare: 0, auEquityIntlShare: 0 }, SS, SE);
  assert.equal((cfg.accounts ?? []).filter(a => a.equityMarketMix).length, 0);
});

// ─── 2. Value-exact when it splits ──────────────────────────────────────────

test('§7.3: an authored mix splits the bootstrap across markets', () => {
  const h = bootstrap(acct({
    equityMarketMix: { [RATE_KEYS.EQUITY_US]: 0.6, [RATE_KEYS.EQUITY_INTL_EX_US]: 0.4 },
  }));
  assert.equal(h.length, 2);
  assert.equal(h.find(x => x.rateKey === RATE_KEYS.EQUITY_US).marketValue,          60_000);
  assert.equal(h.find(x => x.rateKey === RATE_KEYS.EQUITY_INTL_EX_US).marketValue,  40_000);
});

test('§4.4 invariant: balance === Σ marketValue at every weight, including awkward ones', () => {
  // A third/two-thirds split on a balance that does not divide evenly is where a
  // naive per-sleeve round loses a cent. The last sleeve absorbs the remainder.
  for (const [w, bal] of [[1/3, 100_000], [0.07, 33_333.33], [0.5, 0.01], [0.999, 12_345.67]]) {
    const a = acct({ balance: bal, equityMarketMix: {
      [RATE_KEYS.EQUITY_US]: 1 - w, [RATE_KEYS.EQUITY_INTL_EX_US]: w } });
    const h = bootstrap(a);
    const sum = +h.reduce((s, x) => s + x.marketValue, 0).toFixed(2);
    assert.equal(sum, bal, `Σ marketValue must equal balance at weight ${w}`);
    // Basis follows value on a fresh bootstrap — a new sleeve has no unrealized gain.
    assert.equal(+h.reduce((s, x) => s + x.costBasis, 0).toFixed(2), bal);
  }
});

test('§7.3: an un-normalised mix is read as PROPORTIONS, not totals', () => {
  // Authoring {3, 1} should mean 75/25, not "4x the balance" and not a throw.
  const h = bootstrap(acct({
    equityMarketMix: { [RATE_KEYS.EQUITY_US]: 3, [RATE_KEYS.EQUITY_INTL_EX_US]: 1 },
  }));
  assert.equal(+h.reduce((s, x) => s + x.marketValue, 0).toFixed(2), 100_000);
  assert.equal(h.find(x => x.rateKey === RATE_KEYS.EQUITY_US).marketValue, 75_000);
});

test('§7.3: keys outside the EQUITY class are rejected from a mix', () => {
  // A BOND or SAVINGS key in an equity mix would resolve an interest series for money
  // the growth path is about to appreciate. `resolveRateKey`'s containment rule exists
  // for exactly this and the mix must not be a way around it.
  const mix = resolveEquityMarketMix(acct({
    equityMarketMix: { [RATE_KEYS.EQUITY_US]: 0.5, [RATE_KEYS.FIXED_INCOME_US]: 0.5 },
  }));
  assert.deepEqual(Object.keys(mix), [RATE_KEYS.EQUITY_US]);
  assert.equal(mix[RATE_KEYS.EQUITY_US], 1, 'the surviving key is renormalised to the whole');
});

// ─── 3. ALLOCATION is untouched ─────────────────────────────────────────────

test('§7.3: a mixed account is still 100% EQUITY to everything above the sub-axis', () => {
  const h = bootstrap(acct({
    equityMarketMix: { [RATE_KEYS.EQUITY_US]: 0.6, [RATE_KEYS.EQUITY_INTL_EX_US]: 0.4 },
  }));
  assert.ok(h.every(x => x.allocation === ALLOCATION.EQUITY),
    'the market axis must not leak into ALLOCATION — the rebalancer reads that enum');
});

test('§7.3: non-equity allocations have no market axis at all', () => {
  for (const alloc of [ALLOCATION.BOND, ALLOCATION.CASH, ALLOCATION.GOLD]) {
    assert.equal(resolveEquityMarketMix(acct(), alloc), null);
  }
  // And a cash account bootstraps its single cash sleeve regardless of a stray mix.
  const h = bootstrap(acct({
    type: ACCOUNT_TYPE.SAVINGS, role: ACCOUNT_ROLES.US_SAVINGS,
    equityMarketMix: { [RATE_KEYS.EQUITY_US]: 0.5, [RATE_KEYS.EQUITY_INTL_EX_US]: 0.5 },
  }));
  assert.equal(h.length, 1);
  assert.equal(h[0].allocation, ALLOCATION.CASH);
});

// ─── The lever, end to end ──────────────────────────────────────────────────

test('§7.3: the international-share param stamps every equity account of that domicile', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({ usEquityIntlShare: 0.4 }, SS, SE);
  const mixed = (cfg.accounts ?? []).filter(a => a.equityMarketMix);

  assert.ok(mixed.length > 0, 'US equity accounts are stamped');
  for (const a of mixed) {
    assert.equal(a.country, 'US', 'auEquityIntlShare defaulted to 0, so AU is untouched');
    assert.equal(a.equityMarketMix[RATE_KEYS.EQUITY_INTL_EX_US], 0.4);
    assert.equal(a.equityMarketMix[RATE_KEYS.EQUITY_US], 0.6);
  }
  // Cash / fixed-income / loan accounts must never receive a mix: an equity market key
  // on a savings sleeve would resolve a growth series for money that earns interest.
  const nonEquity = (cfg.accounts ?? []).filter(a =>
    a.equityMarketMix && EQUITY_MARKETS_BY_COUNTRY[a.country] &&
    ![ACCOUNT_ROLES.ROTH, ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.K401,
      ACCOUNT_ROLES.US_STOCK, ACCOUNT_ROLES.AU_STOCK, ACCOUNT_ROLES.SUPER].includes(a.role));
  assert.deepEqual(nonEquity, []);
});

test('§7.3: the reference brokerage\'s "International" sleeve tracks the ex-US market', () => {
  // This sleeve has been LABELLED international since it was authored and tracked
  // EQUITY_US the whole time, because there was no other key to give it. Repointing it
  // is the one number step 6 changes, and it is the defect §7.1 describes sitting in
  // the reference scenario with a label that said so.
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, SS, SE);
  const brokerage = (cfg.accounts ?? []).find(a => a.stateKey === 'usStockAccount');
  const intl = (brokerage?.holdings ?? []).find(h => h.id === 'h-intl-equity');

  assert.ok(intl, 'the international sleeve exists');
  assert.equal(intl.rateKey, RATE_KEYS.EQUITY_INTL_EX_US);
  assert.notEqual(intl.rateKey, RATE_KEYS.EQUITY_US);
});
