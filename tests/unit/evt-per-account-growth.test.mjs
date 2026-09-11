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
 * evt-per-account-growth.test.mjs
 *
 * Equity growth under ECONOMIC_REGIMES since design 99 P2: an account has no growth rate
 * of its own. Every equity holding earns its MARKET's total return, so one market param
 * moves every account that holds that market — and a class-level regime shock still fans
 * out to every one of them.
 *
 * (Before P2 this file pinned the opposite: `rothGrowthRate` / `iraGrowthRate` /
 * `k401GrowthRate` / `brokerageGrowthRate` as independent per-wrapper levers, seeded onto
 * `EQUITY_US::<stateKey>` keys. Those params and keys are retired.)
 *
 *   EVT-PAG-1: one market's total moves every account holding that market
 *   EVT-PAG-2: a class shock fans out to every US-equity account
 *   EVT-PAG-3: no per-account equity key is seeded — the bare market key is the rate
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { RATE_KEYS }              from '../../src/finance/economic-regimes/rate-keys.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2032, 0, 1));

function runScenario(extra = {}) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd: SE });
  sc.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(IntlRetirementScenario.buildDefaultConfig({}, SS, SE));
  cfg.parameters = { ...(cfg.parameters ?? {}), ...extra };
  new ScenarioLoader().load(cfg, reg);
  sc.sim.silent = true; sc.sim.journal.enabled = false;
  sc.sim.stepTo(SE);
  return sc.sim.state;
}

const bal = (state, key) => Math.round(state[key]?.balance ?? -1);

const US_ACCOUNTS = ['rothAccount', 'iraAccount', 'k401Account', 'usStockAccount'];

test('EVT-PAG-1: one market\'s total moves every account holding that market', () => {
  // The US brokerage also holds an ex-US sleeve, so move both US-side markets together.
  const lo = runScenario({ usEquityGrowthRate: 0.01, intlExUsEquityGrowthRate: 0.01 });
  const hi = runScenario({ usEquityGrowthRate: 0.10, intlExUsEquityGrowthRate: 0.10 });
  for (const key of US_ACCOUNTS) {
    assert.ok(bal(hi, key) > bal(lo, key), `${key} should grow faster when its markets do`);
  }
});

test('EVT-PAG-2: a class-level shock fans out to every US-equity account', () => {
  const base  = runScenario({});
  const shock = runScenario({ shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2028-01-01' }] });

  for (const key of US_ACCOUNTS) {
    assert.ok(bal(shock, key) < bal(base, key),
      `${key} should be depressed by the US-equity class shock (fan-out)`);
  }
});

test('EVT-PAG-3: no per-account equity key is seeded — the bare market key is the rate', () => {
  const state = runScenario({ usEquityGrowthRate: 0.08 });
  const eff = state.effectiveGrowthRates ?? {};

  const perAccount = Object.keys(eff).filter(k => /^EQUITY_[A-Z_]+::/.test(k));
  assert.deepEqual(perAccount, [], 'design 99 P2 seeds no `<market>::<stateKey>` equity key');
  assert.ok(Math.abs((eff[RATE_KEYS.EQUITY_US] ?? NaN) - 0.08) < 1e-9,
    'EQUITY_US carries usEquityGrowthRate itself');
});
