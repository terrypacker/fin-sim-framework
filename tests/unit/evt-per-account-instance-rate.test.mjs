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
 * evt-per-account-instance-rate.test.mjs
 *
 * Per-account-INSTANCE rates (design 55 §8 / Phase 2): an account's own rate, seeded
 * into the effective rate map under `<memberKey>::<stateKey>`.
 *
 * Design 99 P2 retired the GROWTH half (EVT-PAIR-1…4: two same-type accounts with
 * different `growthRate`s): an equity account now earns what its holdings' markets earn,
 * and two accounts that should differ hold different securities. The INTEREST half is
 * still live — a cash account's rate is a contract with one bank (design 99 D-5) — and
 * is what this file still guards.
 *
 *   EVT-PAIR-5: per-account interestRate drives US savings interest (no dead wire)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2032, 0, 1));

/** Build the default config, apply `mutate(cfg)`, run to SE, return the sim (journal kept). */
function run(mutate) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd: SE });
  sc.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(IntlRetirementScenario.buildDefaultConfig({}, SS, SE));
  cfg.parameters = { ...(cfg.parameters ?? {}) };
  mutate(cfg);
  new ScenarioLoader().load(cfg, reg);
  sc.sim.silent = true;
  sc.sim.stepTo(SE);
  return sc.sim;
}

test('EVT-PAIR-5: per-account interestRate drives US savings interest (no dead wire)', () => {
  // UsSavingsInterestMonthlyHandler computes interest inline (not via
  // computeHoldingsGrowth), so it must consult the per-account key itself. The
  // savings balance is a transaction account (swamped by cash flows), so sum the
  // interest it was credited, from the journal: a clean per-account signal. (This read
  // the last `metrics.us_savings_interest` until design 101 §7.1 retired it.)
  const interestCredited = (rate) => {
    const sim = run(cfg => {
      const acct = cfg.accounts.find(a => a.stateKey === 'usSavingsAccount');
      // Design 56: the prebuilt US savings is Prime-linked (primeSpread), which
      // shadows the absolute interestRate. Un-link it to exercise the legacy
      // per-account interestRate wire this test guards.
      acct.primeSpread  = null;
      acct.interestRate = rate;
    });
    // Per-account key must be seeded distinctly from the shared class key.
    assert.ok(Math.abs((sim.state.effectiveInterestRates?.['SAVINGS_US::usSavingsAccount'] ?? NaN) - rate) < 1e-9,
      'SAVINGS_US::usSavingsAccount must carry the per-account rate');
    // A journal entry is one (action, reducer) pair, so count each action once.
    const credits = new Map();
    for (const { action: a } of sim.journal.journal) {
      if (a?.type === 'US_SAVINGS_INTEREST_CREDIT' && a.data?.stateKey === 'usSavingsAccount') credits.set(a.instanceId, a.data.amount);
    }
    assert.ok(credits.size > 0, 'the run must credit US savings interest');
    return [...credits.values()].reduce((sum, amount) => sum + amount, 0);
  };
  assert.ok(interestCredited(0.50) > interestCredited(0.001),
    'a higher per-account interestRate must credit more US savings interest');
});
