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
 * accounting-integrity.test.mjs — end-to-end accuracy guards for the prebuilt
 * IntlRetirement scenario (deterministic, so exact assertions hold).
 *
 *   1. Per-account compounding — an untouched account grows by EXACTLY its
 *      configured rate each year. This is the check that would have caught the
 *      vanishing-dividend bug (the stock grew at < its rate when dividends were
 *      lost) and confirms the dividend-reinvest fix (stock = growth + dividend).
 *
 *   2. Holdings integrity sweep — across the whole simulation, every
 *      holdings-bearing account satisfies the §4.4 invariant
 *      (balance === Σ holdings.marketValue) and never carries a negative market
 *      value or cost basis. A leak (money created/destroyed) or the
 *      stranded-basis / negative-value drawdown bugs surface here. This is the
 *      FX-immune, exact form of a money-conservation check (a single-currency
 *      ΔNetWorth reconciliation is confounded by cross-border FX translation).
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { ServiceRegistry }          from '../../src/services/service-registry.js';
import { BaseScenario }             from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario }   from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }           from '../../src/scenarios/scenario-loader.js';
import { SUPER_TAX_RATE }          from '../../src/finance/tax/au/super-tax-rate.js';

function buildPrebuilt() {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);
  const scenario = new BaseScenario({
    context:      services.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return { sim: scenario.sim, cfg };
}

const yearEnd = (y) => new Date(Date.UTC(y, 11, 31));
const sumMv   = (h) => (h ?? []).reduce((s, x) => s + (x?.marketValue ?? 0), 0);

/**
 * Prebuilt scenario, but the AU house carries an owner-occupied mortgage so there
 * is real interest to offset, and (when `offset`) a config-declared OffsetAccount
 * linked to it. A config account carries an explicit `stateKey`, so this is
 * independent of the editor-created-account stateKey gap (design 55 §3.1).
 */
function buildPrebuiltAuLoan({ offset = false } = {}) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, undefined, undefined);

  // Owner-occupied AU mortgage → a synthesized `auHousePropertyLoan` (design 54 P2).
  const auHouse = cfg.realProperties.find(r => r.stateKey === 'auHouseProperty');
  auHouse.mortgageBalance      = 400_000;
  auHouse.monthlyMortgage      = 3_000;
  auHouse.mortgageInterestRate = 0.05;

  if (offset) {
    cfg.accounts.push({
      __type: 'OffsetAccount', stateKey: 'auOffsetAccount', type: 'offset',
      name: 'AU Offset', role: 'au-offset',
      balance: 200_000, ownershipType: 'sole', ownerId: 'primary',
      minimumBalance: 0, country: 'AU', currency: { code: 'AUD', symbol: 'A$' },
      offsetsPropertyKey: 'auHouseProperty',
      drawdownPriority: null, // liquid but not a drawdown source → stays put, keeps the offset stable
    });
  }

  const scenario = new BaseScenario({
    context:      services.simulationContext,
    initialState: cfg.initialState ?? {},
    simStart:     new Date(cfg.simStart),
    simEnd:       new Date(cfg.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return { sim: scenario.sim, cfg };
}

// ── 1. Per-account compounding ────────────────────────────────────────────────

test('per-account: untouched accounts compound at exactly their configured rate', () => {
  const { sim, cfg } = buildPrebuilt();
  const p = cfg.parameters;

  // Pure-equity accounts compound at their configured growth rate (dividend leaves
  // as cash in the prebuilt, reinvest off). usStockAccount + k401Account are now
  // 60/40 equity/bond books (design 66 §G3), so their WHOLE balance no longer grows
  // at one clean rate — the bond sleeves earn a coupon (reinvested only in the
  // deferred 401k) and mark to market via duration. So they are checked at the
  // EQUITY-SLEEVE level below instead of on the whole balance.
  const expectedWhole = {
    rothAccount:  p.rothGrowthRate,
    iraAccount:   p.iraGrowthRate,
    // Design 77 §5.1 — an accumulation-phase super account compounds NET of the 15%
    // Div 295 fund earnings tax, because the fund pays that tax out of the member's
    // own assets. This is the one account whose credited return is below its
    // configured rate, and it is the point of the design: pre-77 the balance
    // compounded gross and the tax was separately taken from the member's AU cash.
    // The prebuilt's members are in accumulation for these three early years; once
    // they pass 60 the rate reverts to the full `superGrowthRate` (see evt-super).
    superAccount: p.superGrowthRate * (1 - SUPER_TAX_RATE),
  };
  // Equity sleeves of the mixed books still grow at exactly the equity rate.
  const expectedEquitySleeve = {
    usStockAccount: p.brokerageGrowthRate + (p.dividendReinvest ? p.brokerageDividendRate : 0),
    k401Account:    p.k401GrowthRate,
  };
  const equityMv = (acct) => (acct?.holdings ?? [])
    .filter(h => h.allocation === 'EQUITY')
    .reduce((s, h) => s + (h.marketValue ?? 0), 0);

  const startYear = new Date(cfg.simStart).getUTCFullYear();
  // Snapshot at three consecutive year-ends in early accumulation (well before any
  // retirement drawdown): whole balance for pure-equity accounts, equity-sleeve
  // marketValue for the mixed books.
  const snaps = [];
  for (let i = 1; i <= 3; i++) {
    sim.stepTo(yearEnd(startYear + i));
    const snap = {};
    for (const k of Object.keys(expectedWhole))        snap[k] = sim.state[k]?.balance ?? 0;
    for (const k of Object.keys(expectedEquitySleeve)) snap[k] = equityMv(sim.state[k]);
    snaps.push(snap);
  }

  for (const [key, rate] of Object.entries({ ...expectedWhole, ...expectedEquitySleeve })) {
    for (let i = 1; i < snaps.length; i++) {
      const ratio = snaps[i][key] / snaps[i - 1][key];
      assert.ok(
        Math.abs(ratio - (1 + rate)) < 1e-4,
        `${key}: expected ×${(1 + rate).toFixed(4)} per year, got ×${ratio.toFixed(4)}`,
      );
    }
  }
});

// ── 2. Holdings integrity sweep ───────────────────────────────────────────────

test('integrity: §4.4 invariant holds and no negative value/basis across the whole sim', () => {
  const { sim, cfg } = buildPrebuilt();
  const endMs   = new Date(cfg.simEnd).getTime();
  const endYear = new Date(cfg.simEnd).getUTCFullYear();
  const violations = [];

  for (let year = new Date(cfg.simStart).getUTCFullYear(); year <= endYear; year++) {
    if (sim.currentDate.getTime() >= endMs) break;
    sim.stepTo(yearEnd(year));

    for (const [key, acct] of Object.entries(sim.state)) {
      const holdings = acct?.holdings;
      if (!Array.isArray(holdings) || holdings.length === 0) continue;

      // §4.4: balance must equal Σ marketValue (currency-rounded tolerance).
      const gap = Math.abs((acct.balance ?? 0) - sumMv(holdings));
      if (gap > 0.05) violations.push(`${year} ${key}: balance ${acct.balance} ≠ Σmv ${sumMv(holdings).toFixed(2)} (gap ${gap.toFixed(2)})`);

      // No position or its basis may be negative.
      for (const h of holdings) {
        if ((h.marketValue ?? 0) < -0.01) violations.push(`${year} ${key}/${h.id}: negative marketValue ${h.marketValue}`);
        if ((h.costBasis   ?? 0) < -0.01) violations.push(`${year} ${key}/${h.id}: negative costBasis ${h.costBasis}`);
      }
    }
  }

  assert.deepEqual(violations, [], `holdings integrity violations:\n  ${violations.join('\n  ')}`);
});

// ── 3. Offset account, end-to-end in the full prebuilt sim ─────────────────────

test('offset (integration): AU offset lands in state, speeds owner-occupied payoff, and preserves §4.4 integrity across the full run', () => {
  const LOAN_KEY = 'auHousePropertyLoan'; // loanKeyForProperty('auHouseProperty')

  const base = buildPrebuiltAuLoan({ offset: false });
  const off  = buildPrebuiltAuLoan({ offset: true });

  // The offset must reach runtime state end-to-end (the _accountToStatePlain
  // projection carries offsetsPropertyKey — design 53 §3 / 54 P3) and the AU loan
  // must have synthesized from the injected mortgage.
  const offAcct = off.sim.state.auOffsetAccount;
  assert.ok(offAcct, 'offset account is present in sim.state');
  assert.strictEqual(offAcct.type, 'offset');
  assert.strictEqual(offAcct.offsetsPropertyKey, 'auHouseProperty');
  assert.ok(off.sim.state[LOAN_KEY]?.balance > 0, 'AU loan synthesized with a positive balance');

  // Step both to a fixed early year-end (accumulation phase, loan still active in
  // both). The offset suppresses interest, so more of each payment hits principal
  // → the offset run's loan balance is strictly lower.
  const compareYear = new Date(base.cfg.simStart).getUTCFullYear() + 5;
  base.sim.stepTo(yearEnd(compareYear));
  off.sim.stepTo(yearEnd(compareYear));

  const baseLoan = base.sim.state[LOAN_KEY]?.balance ?? 0;
  const offLoan  = off.sim.state[LOAN_KEY]?.balance ?? 0;
  assert.ok(baseLoan > 0, `baseline AU loan still active at ${compareYear} (${baseLoan})`);
  assert.ok(offLoan < baseLoan, `offset speeds payoff: offset loan ${offLoan.toFixed(0)} < baseline ${baseLoan.toFixed(0)}`);
  // Design 54 P4: the linked offset is now the loan's payment source, so each monthly
  // P&I debits it — over 5 years of A$3,000 payments it drains well below its 200k start
  // (while never going negative).
  const offCash = off.sim.state.auOffsetAccount.balance;
  assert.ok(offCash < 200_000, `offset debited as the loan payment source (${offCash.toFixed(0)})`);
  assert.ok(offCash >= -0.01,  `offset never goes negative (${offCash.toFixed(0)})`);

  // Continue the offset run to the end, sweeping the §4.4 invariant every year —
  // an offset must not corrupt accounting anywhere in the full simulation.
  const endMs   = new Date(off.cfg.simEnd).getTime();
  const endYear = new Date(off.cfg.simEnd).getUTCFullYear();
  const violations = [];
  for (let year = compareYear + 1; year <= endYear; year++) {
    if (off.sim.currentDate.getTime() >= endMs) break;
    off.sim.stepTo(yearEnd(year));
    for (const [key, acct] of Object.entries(off.sim.state)) {
      const holdings = acct?.holdings;
      if (!Array.isArray(holdings) || holdings.length === 0) continue;
      const gap = Math.abs((acct.balance ?? 0) - sumMv(holdings));
      if (gap > 0.05) violations.push(`${year} ${key}: balance ${acct.balance} ≠ Σmv ${sumMv(holdings).toFixed(2)} (gap ${gap.toFixed(2)})`);
      for (const h of holdings) {
        if ((h.marketValue ?? 0) < -0.01) violations.push(`${year} ${key}/${h.id}: negative marketValue ${h.marketValue}`);
        if ((h.costBasis   ?? 0) < -0.01) violations.push(`${year} ${key}/${h.id}: negative costBasis ${h.costBasis}`);
      }
    }
  }
  assert.deepEqual(violations, [], `offset-run integrity violations:\n  ${violations.join('\n  ')}`);
});
