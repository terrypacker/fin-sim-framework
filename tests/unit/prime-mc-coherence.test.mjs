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
 * prime-mc-coherence.test.mjs
 *
 * Design 56 Phase 2a — Prime is THE rate sweep; per-account rate levers retire (Decision 6 / §3.1).
 *
 * Once design-55 §8 made interest rates per-account, sweeping a *global* rate silently
 * no-oped on any account with an explicit value — there was no coherent "move all my
 * rates" knob (the rate half of GH #511). Design 56 resolves it: `usPrimeRate`/`auPrimeRate`
 * become the systemic MC/Opt rate targets, and the per-account + global savings interest-rate
 * levers are retired (replaced by Prime, not kept alongside — removing the MC double-move at
 * the source). This suite pins the config surface and the runtime coherence.
 *
 *   MCC-1: usPrimeRate / auPrimeRate are enabled MC targets; savings-rate levers are gone.
 *   MCC-2: usPrimeRate / auPrimeRate are Opt targets.
 *   MCC-3: the retired rate levers are mc:false in the schema (global + generated per-account).
 *   MCC-4: one usPrimeRate move fans out to the WHOLE US cash complex coherently (same +Δ),
 *          leaving the AU complex untouched (independent PRIME_AU).
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { ScenarioParamGenerator } from '../../src/scenarios/params/scenario-param-generator.js';
import { indexParamSchema }       from '../../src/finance/param-schema-utils.js';
import { DEFAULT_MC_VARIABLE_CONFIGS }   from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { DEFAULT_OPTIMIZATION_CONFIGS }  from '../../src/finance/optimization/intl-retirement-opt-config.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2032, 0, 1));

const mcKeys  = new Set(DEFAULT_MC_VARIABLE_CONFIGS.map(v => v.paramKey));
const optKeys = new Set(DEFAULT_OPTIMIZATION_CONFIGS.map(v => v.paramKey));
const mcCfg   = k => DEFAULT_MC_VARIABLE_CONFIGS.find(v => v.paramKey === k);

/** Full eligibility index: static schema + generated per-account params. */
function eligibilityIndex() {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, SS, new Date(Date.UTC(2041, 0, 1)));
  return indexParamSchema([
    ...IntlRetirementScenario.buildFullParamSchema(),
    ...ScenarioParamGenerator.generate(cfg),
  ]);
}

test('MCC-1: Prime is an enabled MC target; the savings-rate MC levers are retired', () => {
  assert.ok(mcKeys.has('usPrimeRate'), 'usPrimeRate must be a curated MC target');
  assert.ok(mcKeys.has('auPrimeRate'), 'auPrimeRate must be a curated MC target');
  assert.strictEqual(mcCfg('usPrimeRate').enabled, true, 'usPrimeRate MC target must be enabled');
  assert.strictEqual(mcCfg('auPrimeRate').enabled, true, 'auPrimeRate MC target must be enabled');

  // The old fragmented savings-rate knobs are gone (replaced by Prime, not kept alongside).
  assert.ok(!mcKeys.has('usSavingsInterestRate'), 'usSavingsInterestRate must NOT be an MC target');
  assert.ok(!mcKeys.has('auSavingsInterestRate'), 'auSavingsInterestRate must NOT be an MC target');

  // Fixed income keeps its own rate knob (bonds are excluded from Prime — Decision 3).
  assert.ok(mcKeys.has('fixedIncomeInterestRate'), 'fixed-income rate stays an MC target (not Prime-linked)');
});

test('MCC-2: usPrimeRate / auPrimeRate are Opt targets', () => {
  assert.ok(optKeys.has('usPrimeRate'), 'usPrimeRate must be a curated Opt target');
  assert.ok(optKeys.has('auPrimeRate'), 'auPrimeRate must be a curated Opt target');
});

test('MCC-3: retired rate levers are mc:false in the schema (global + generated per-account)', () => {
  const byKey = eligibilityIndex();
  // Prime is mc/opt eligible.
  assert.ok(byKey.get('usPrimeRate')?.mc && byKey.get('usPrimeRate')?.opt, 'usPrimeRate schema mc+opt');
  assert.ok(byKey.get('auPrimeRate')?.mc && byKey.get('auPrimeRate')?.opt, 'auPrimeRate schema mc+opt');

  // Global savings rates: retired as rate knobs but still present as seed params.
  assert.strictEqual(byKey.get('usSavingsInterestRate')?.mc, false, 'usSavingsInterestRate schema mc:false');
  assert.strictEqual(byKey.get('auSavingsInterestRate')?.mc, false, 'auSavingsInterestRate schema mc:false');

  // Generated per-account cash interest levers (design 55 §8) are retired too.
  assert.strictEqual(byKey.get('acct.usSavingsAccount.interestRate')?.mc, false,
    'per-account US savings interestRate must be mc:false');
  assert.strictEqual(byKey.get('acct.auSavingsAccount.interestRate')?.mc, false,
    'per-account AU savings interestRate must be mc:false');
});

test('MCC-4: one usPrimeRate move fans out to the whole US cash complex coherently', () => {
  // Link a second US cash sleeve (brokerage CASH) so the "complex" is >1 account, then move
  // Prime once. Every US-linked cash key must rise by the SAME delta; AU stays put. This is
  // the coherent "move all my rates" knob design 55 §13 lacked — restored by Prime.
  const DELTA = 0.02;
  const link = cfg => {
    cfg.accounts.find(a => a.stateKey === 'usStockAccount').primeSpread = -0.01; // add a US cash sleeve
  };
  const run = mutate => {
    ServiceRegistry.resetAll();
    const reg = ServiceRegistry.getInstance();
    const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd: SE });
    sc.buildSim();
    const cfg = ScenarioSerializer.serializeScenario(IntlRetirementScenario.buildDefaultConfig({}, SS, SE));
    cfg.parameters = { ...(cfg.parameters ?? {}) };
    link(cfg);
    mutate(cfg);
    new ScenarioLoader().load(cfg, reg);
    sc.sim.silent = true; sc.sim.journal.enabled = false;
    sc.sim.stepTo(SE);
    return sc.sim.state.effectiveInterestRates ?? {};
  };

  const base = run(() => {});
  const hike = run(cfg => { cfg.parameters.usPrimeRate = (cfg.parameters.usPrimeRate ?? 0.045) + DELTA; });

  // Both US cash keys move by exactly +DELTA (one Prime draw, coherent fan-out).
  for (const key of ['SAVINGS_US::usSavingsAccount', 'SAVINGS_US::usStockAccount']) {
    assert.ok(Math.abs((hike[key] - base[key]) - DELTA) < 1e-9,
      `US cash key ${key} must rise by exactly the Prime move (+${DELTA}); got Δ=${hike[key] - base[key]}`);
  }
  // The AU complex is independent (PRIME_AU untouched).
  assert.ok(Math.abs(hike['SAVINGS_AU::auSavingsAccount'] - base['SAVINGS_AU::auSavingsAccount']) < 1e-12,
    'a Fed (usPrimeRate) move must not touch the AU cash complex');
});
