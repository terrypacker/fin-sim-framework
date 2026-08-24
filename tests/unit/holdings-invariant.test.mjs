/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test, describe } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { scaleHoldings, rescaleHoldingsToBalance } from '../../src/finance/holdings/holding-utils.js';
import { AccountService } from '../../src/finance/services/account-service.js';

/**
 * Walk every Account-shaped state entry and verify that
 *   account.balance === Σ holdings[i].marketValue   (rounded to cents)
 * holds. Tolerance is 1 cent to absorb floating-point rounding.
 */
function assertHoldingsInvariant(state, label) {
  for (const [k, v] of Object.entries(state)) {
    if (!v || typeof v !== 'object') continue;
    if (typeof v.balance !== 'number') continue;
    if (!Array.isArray(v.holdings)) continue;
    const sumMv = v.holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0);
    assert.ok(
      Math.abs(sumMv - v.balance) <= 1.0,
      `[${label}] ${k}: balance=${v.balance.toFixed(2)} but Σholdings=${sumMv.toFixed(2)} ` +
      `(diff=${(sumMv - v.balance).toFixed(2)})`
    );
  }
}

function setupScenario(simStart, simEnd) {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  const scenario = new IntlRetirementScenario({
    context:  registry.simulationContext,
    simStart, simEnd,
  });
  scenario.buildSim();
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, simStart, simEnd);
  new ScenarioLoader().load(cfg, registry);
  return scenario.sim;
}

// ─── §4.4 invariant — boot ────────────────────────────────────────────────────

test('Holdings invariant: holds at scenario boot for every account', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2030, 0, 1)));
  assertHoldingsInvariant(sim.state, 'boot');
});

// ─── §4.4 invariant — after simulation runs ──────────────────────────────────

test('Holdings invariant: holds after 5 years of IntlRetirementScenario', () => {
  const simStart = new Date(Date.UTC(2025, 0, 1));
  const simEnd   = new Date(Date.UTC(2030, 0, 1));
  const sim      = setupScenario(simStart, simEnd);
  sim.stepTo(simEnd);
  assertHoldingsInvariant(sim.state, '5yr');
});

test('Holdings invariant: holds after 10 years of IntlRetirementScenario', () => {
  const simStart = new Date(Date.UTC(2025, 0, 1));
  const simEnd   = new Date(Date.UTC(2035, 0, 1));
  const sim      = setupScenario(simStart, simEnd);
  sim.stepTo(simEnd);
  assertHoldingsInvariant(sim.state, '10yr');
});

// ─── Default holdings bootstrap ──────────────────────────────────────────────

test('Holdings bootstrap: every registered account satisfies §4.4 (balance = Σ holdings.marketValue) at boot', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  let accountCount = 0;
  for (const [k, v] of Object.entries(sim.state)) {
    if (!v || typeof v !== 'object') continue;
    if (typeof v.balance !== 'number') continue;
    if (!Array.isArray(v.holdings)) continue;
    accountCount++;
    assert.ok(v.holdings.length >= 1, `${k} should have at least one holding after bootstrap`);
    const sum = +v.holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0).toFixed(2);
    assert.ok(Math.abs(sum - v.balance) < 0.01, `${k} §4.4: balance (${v.balance}) must equal Σ holdings.marketValue (${sum})`);
    for (const h of v.holdings) {
      assert.ok(h.allocation, `${k} every holding must carry an ALLOCATION`);
      assert.ok(h.rateKey,    `${k} every holding must carry a rateKey`);
    }
  }
  assert.ok(accountCount >= 10, `expected ≥10 production accounts, got ${accountCount}`);
});

test('Holdings bootstrap: usStockAccount seeds a 60/40 equity/bond book (design 66 §G3)', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  const acct = sim.state.usStockAccount;
  assert.ok(acct, 'usStockAccount must exist');
  // 2 equity (domestic + international) + 3 bond (Treasury / corporate / muni).
  assert.equal(acct.holdings.length, 5, 'usStockAccount should have 5 holdings');
  const labels = acct.holdings.map(h => h.label);
  assert.ok(labels.some(l => l.includes('Domestic')),      'one holding should be domestic');
  assert.ok(labels.some(l => l.includes('International')), 'one holding should be international');
  // Domestic holding should be a loss position (basis > marketValue) for TLH testing.
  const domestic = acct.holdings.find(h => h.label.includes('Domestic'));
  assert.ok(domestic.costBasis > domestic.marketValue, 'domestic holding should start above basis (loss position for TLH)');
  // Bond leg (design 66 §G3): ~40% of the book, exercising all three tax treatments.
  const bonds = acct.holdings.filter(h => h.allocation === 'BOND');
  assert.equal(bonds.length, 3, 'Treasury + corporate + municipal bond sleeves');
  const exemptions = bonds.map(h => h.taxExemption).sort();
  assert.deepEqual(exemptions, ['federal', 'none', 'state'], 'one of each tax treatment');
  const bondMv = bonds.reduce((s, h) => s + h.marketValue, 0);
  const totMv  = acct.holdings.reduce((s, h) => s + h.marketValue, 0);
  assert.ok(Math.abs(bondMv / totMv - 0.40) < 0.001, 'bond leg is ~40% of the book');
});

// ─── Allocation & rateKey resolution per role ────────────────────────────────

test('Holdings bootstrap: FIXED_INCOME role → BOND allocation + FIXED_INCOME_US rateKey', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  const fi = sim.state.fixedIncomeAccount;
  assert.ok(fi);
  assert.equal(fi.holdings[0].allocation, 'BOND');
  assert.equal(fi.holdings[0].rateKey, 'FIXED_INCOME_US');
});

test('Holdings bootstrap: AU_FIXED_INCOME role → BOND + FIXED_INCOME_AU', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  const fi = sim.state.auFixedIncomeAccount;
  assert.ok(fi);
  assert.equal(fi.holdings[0].allocation, 'BOND');
  assert.equal(fi.holdings[0].rateKey, 'FIXED_INCOME_AU');
});

test('Holdings bootstrap: SUPER role → EQUITY + EQUITY_AU', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  const su = sim.state.superAccount;
  assert.ok(su);
  assert.equal(su.holdings[0].allocation, 'EQUITY');
  assert.equal(su.holdings[0].rateKey, 'EQUITY_AU');
});

test('Holdings bootstrap: US_SAVINGS role → CASH + SAVINGS_US', () => {
  const sim = setupScenario(new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2026, 0, 1)));
  const sv = sim.state.usSavingsAccount;
  assert.ok(sv);
  assert.equal(sv.holdings[0].allocation, 'CASH');
  assert.equal(sv.holdings[0].rateKey, 'SAVINGS_US');
});

// ─── Par scales with the position (design 66 §G4 x the value-move paths) ───────

describe('scaleHoldings / rescaleHoldingsToBalance — faceValue scales with the position', () => {
  // `faceValue` is authoritative TWICE: BondPriceAdjustReducer pulls a bond's price to
  // it every period, and BondMaturityReducer redeems at it. So a value move that scales
  // marketValue and leaves par behind does not merely mis-label the position — it hands
  // pull-to-par a target no purchase ever set, and the position then bleeds toward it
  // (or is inflated toward it) for the rest of the run. Measured before the fix: a Roth
  // conversion doubled an account to $241,812 against an unchanged $127,058 of par, and
  // the next mark destroyed $18,936.
  const bond = (mv, face) => ({
    id: 'rung', allocation: 'BOND', marketValue: mv, costBasis: mv, faceValue: face,
    maturityDate: new Date(Date.UTC(2035, 0, 1)),
  });

  test('scaleHoldings scales faceValue by the same factor as marketValue', () => {
    const [h] = scaleHoldings([bond(100_000, 100_000)], 100_000, 250_000);
    assert.equal(h.marketValue, 250_000);
    assert.equal(h.faceValue,   250_000, 'par scales with the position');
    assert.equal(h.costBasis,   250_000);
  });

  test('a position trading away from par keeps its price-to-par RATIO', () => {
    // 90c on the dollar before; still 90c after. The ratio is the thing pull-to-par
    // reads, so it is the thing a value move must not touch.
    const [h] = scaleHoldings([bond(90_000, 100_000)], 90_000, 180_000);
    assert.equal(h.marketValue, 180_000);
    assert.equal(h.faceValue,   200_000);
    assert.equal(+(h.marketValue / h.faceValue).toFixed(4), 0.9);
  });

  test('scaling DOWN (a withdrawal or rollover out) scales par down too', () => {
    const [h] = scaleHoldings([bond(100_000, 100_000)], 100_000, 40_000);
    assert.equal(h.faceValue, 40_000, 'par cannot survive the units that left');
  });

  test('a holding with no faceValue (a bond FUND, or equity) is untouched by the rule', () => {
    const [h] = scaleHoldings([{ id: 'f', allocation: 'BOND', marketValue: 100, costBasis: 100 }], 100, 200);
    assert.equal(h.marketValue, 200);
    assert.equal(h.faceValue, undefined, 'no par to scale — a fund has none');
  });

  test('rescaleHoldingsToBalance carries the same rule', () => {
    const [h] = rescaleHoldingsToBalance([bond(100_000, 100_000)], 150_000);
    assert.equal(h.marketValue, 150_000);
    assert.equal(h.faceValue,   150_000);
  });

  test('the zero-balance bootstrap branch sets par alongside market value', () => {
    const [h] = scaleHoldings([bond(0, 0)], 0, 50_000);
    assert.equal(h.marketValue, 50_000);
    assert.equal(h.faceValue,   50_000, 'not left at a stale 0, which would redeem the rung for nothing');
  });
});

describe('AccountService pro-rate debit/credit — par travels with the units', () => {
  // The third and last place `faceValue` was a parallel field nobody maintained. A
  // cross-border transfer or tax payment drains an account through this path; leaving
  // par behind let pull-to-par drag price back toward a par no longer behind it, which
  // is why an all-bond ladder appeared to retain 3.7x what the same book in bond funds
  // retained. Measured on the way in: -$236,054 of market value moved with par frozen.
  const svc = () => new AccountService();
  const bondAcct = (mv, face) => ({
    stateKey: 'a', balance: mv,
    holdings: [{ id: 'rung', allocation: 'BOND', marketValue: mv, costBasis: mv, faceValue: face,
                 maturityDate: new Date(Date.UTC(2035, 0, 1)) }],
  });

  test('a debit removes par in proportion to the units removed', () => {
    const a = bondAcct(100_000, 100_000);
    svc().transaction(a, -40_000);
    const h = a.holdings[0];
    assert.equal(h.marketValue, 60_000);
    assert.equal(h.faceValue,   60_000, 'par cannot outlive the units it priced');
  });

  test('a debit preserves a lot trading away from par', () => {
    const a = bondAcct(90_000, 100_000);   // 90c on the dollar
    svc().transaction(a, -45_000);
    const h = a.holdings[0];
    assert.equal(h.marketValue, 45_000);
    assert.equal(h.faceValue,   50_000);
    assert.equal(+(h.marketValue / h.faceValue).toFixed(4), 0.9, 'ratio untouched by a unit change');
  });

  test('a credit scales par up with the position', () => {
    const a = bondAcct(100_000, 100_000);
    svc().transaction(a, 50_000);
    const h = a.holdings[0];
    assert.equal(h.marketValue, 150_000);
    assert.equal(h.faceValue,   150_000);
  });

  test('a holding with no par (a bond fund, or equity) is unaffected', () => {
    const a = { stateKey: 'a', balance: 100, holdings: [{ id: 'f', allocation: 'BOND', marketValue: 100, costBasis: 100 }] };
    svc().transaction(a, -50);
    assert.equal(a.holdings[0].marketValue, 50);
    assert.equal(a.holdings[0].faceValue, undefined);
  });
});
