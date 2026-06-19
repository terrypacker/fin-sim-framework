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

// ── 1. Per-account compounding ────────────────────────────────────────────────

test('per-account: untouched accounts compound at exactly their configured rate', () => {
  const { sim, cfg } = buildPrebuilt();
  const p = cfg.parameters;

  // Annually-compounded equity sleeves. The stock additionally compounds its
  // reinvested dividend (when dividendReinvest is on); the prebuilt has it off,
  // so the dividend leaves as cash and the stock grows at the bare growth rate.
  const expected = {
    rothAccount:       p.rothGrowthRate,
    iraAccount:        p.iraGrowthRate,
    k401Account:       p.k401GrowthRate,
    superAccount:      p.superGrowthRate,
    usStockAccount:    p.brokerageGrowthRate + (p.dividendReinvest ? p.brokerageDividendRate : 0),
  };

  const startYear = new Date(cfg.simStart).getUTCFullYear();
  // Snapshot balances at three consecutive year-ends in early accumulation
  // (well before any retirement drawdown), then assert each YoY ratio.
  const snaps = [];
  for (let i = 1; i <= 3; i++) {
    sim.stepTo(yearEnd(startYear + i));
    snaps.push(Object.fromEntries(Object.keys(expected).map(k => [k, sim.state[k]?.balance ?? 0])));
  }

  for (const [key, rate] of Object.entries(expected)) {
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
