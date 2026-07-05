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
 * Per-account equity growth under ECONOMIC_REGIMES.
 *
 * Each equity account TYPE carries its own base growth rate (a member of the
 * EQUITY_US / EQUITY_AU asset class), so rothGrowthRate / iraGrowthRate /
 * k401GrowthRate / brokerageGrowthRate are independent levers — while a
 * class-level regime shock still fans out to every member account.
 *
 *   EVT-PAG-1: each US-equity growth param moves only its own account
 *   EVT-PAG-2: a class shock fans out to every US-equity member account
 *   EVT-PAG-3: base rates seed per-account member keys (no EQUITY_US collapse)
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

test('EVT-PAG-1: each US-equity growth param moves only its own account', () => {
  const lo = runScenario({ rothGrowthRate: 0.01, iraGrowthRate: 0.01, k401GrowthRate: 0.01, brokerageGrowthRate: 0.01 });
  const rothHi = runScenario({ rothGrowthRate: 0.30, iraGrowthRate: 0.01, k401GrowthRate: 0.01, brokerageGrowthRate: 0.01 });

  // Raising rothGrowthRate grows the Roth...
  assert.ok(bal(rothHi, 'rothAccount') > bal(lo, 'rothAccount'),
    'rothGrowthRate should grow the Roth account');
  // ...but leaves IRA / 401k / brokerage untouched (independent levers).
  assert.strictEqual(bal(rothHi, 'iraAccount'),     bal(lo, 'iraAccount'),     'IRA unaffected by rothGrowthRate');
  assert.strictEqual(bal(rothHi, 'k401Account'),    bal(lo, 'k401Account'),    '401k unaffected by rothGrowthRate');
  assert.strictEqual(bal(rothHi, 'usStockAccount'), bal(lo, 'usStockAccount'), 'brokerage unaffected by rothGrowthRate');
});

test('EVT-PAG-2: a class-level shock fans out to every US-equity member account', () => {
  const base  = runScenario({});
  const shock = runScenario({ shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2028-01-01' }] });

  for (const key of ['rothAccount', 'iraAccount', 'k401Account', 'usStockAccount']) {
    assert.ok(bal(shock, key) < bal(base, key),
      `${key} should be depressed by the US-equity class shock (fan-out)`);
  }
});

test('EVT-PAG-3: base rates seed per-account member keys, not the collapsed class key', () => {
  const state = runScenario({ rothGrowthRate: 0.07, iraGrowthRate: 0.08, k401GrowthRate: 0.09, brokerageGrowthRate: 0.05 });
  const eff = state.effectiveGrowthRates ?? {};

  assert.ok(Math.abs((eff[RATE_KEYS.EQUITY_US_ROTH] ?? NaN) - 0.07) < 1e-9, 'EQUITY_US_ROTH = rothGrowthRate');
  assert.ok(Math.abs((eff[RATE_KEYS.EQUITY_US_IRA]  ?? NaN) - 0.08) < 1e-9, 'EQUITY_US_IRA = iraGrowthRate');
  assert.ok(Math.abs((eff[RATE_KEYS.EQUITY_US_K401] ?? NaN) - 0.09) < 1e-9, 'EQUITY_US_K401 = k401GrowthRate');
  assert.ok(Math.abs((eff[RATE_KEYS.EQUITY_US_BROKERAGE] ?? NaN) - 0.05) < 1e-9, 'EQUITY_US_BROKERAGE = brokerageGrowthRate');
  // The collapsed class key is no longer a growth rate in state.
  assert.strictEqual(eff[RATE_KEYS.EQUITY_US], undefined, 'no collapsed EQUITY_US growth rate');
});
