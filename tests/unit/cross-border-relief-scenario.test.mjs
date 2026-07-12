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
 * cross-border-relief-scenario.test.mjs — design 52 behavioral lock-in.
 *
 * The relief flip (real §904 FTC + FITO replacing the ftcYTD over-relief hack)
 * moved lifetime tax and ending wealth for every cross-border scenario, but NO
 * pre-existing golden asserted a post-credit cross-border liability — so the
 * change would otherwise be unguarded. This scenario-level golden pins the
 * default US→AU retiree's headline outcomes so a future regression (or an
 * accidental return of the over-relief) surfaces as a concrete diff.
 *
 * If this test fails after an intentional change, re-run the scenario, confirm
 * the new figures are correct, and update the expected values (a deliberate
 * regold — see design/52 §7).
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { ServiceRegistry }         from '../../src/services/service-registry.js';
import { ScenarioLoader }          from '../../src/scenarios/scenario-loader.js';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';

function runDefaultIntlRetirement() {
  ServiceRegistry.resetAll();
  const registry = ServiceRegistry.getInstance();
  registry.scenarioRegistry.loadPrebuilt([{
    cls: IntlRetirementScenario, order: 1, active: true,
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2050, 0, 1)),
  }]);
  const scenario = registry.scenarioService.createActiveScenario();
  scenario.buildSim();
  const cfg = registry.scenarioService.getActive();
  new ScenarioLoader().load(cfg, registry);

  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(new Date(Date.UTC(2050, 0, 1))); }
  finally { console.log = log; console.warn = warn; }
  return scenario.sim.state;
}

// Post-flip figures (design 52, moveYear 2031 → AU-resident 2031-2050). The
// pre-flip ftcYTD hack produced ~774,882 lifetime tax / ~12,046,007 net worth;
// real relief raises lifetime tax to ~895,088 (+15.5%) and lowers ending wealth
// to ~11,852,976 (-1.6%). A ±1% band absorbs incidental FX/rounding drift while
// still catching a return of the over-relief (which would swing tax ~13% low).
//
// NOTE (design 57): these figures currently reflect the AU CGT reform being
// silently reverted to the base 50% discount for inflation-adjusted years (see
// design/57 §"Post-implementation correction" — two coupled bugs). The correct
// figures are pending that fix; do not treat these as reform-correct.
const EXPECTED_LIFETIME_TAX = 895_088;
const EXPECTED_NET_WORTH     = 11_852_976;
const TOL = 0.01;

test('design 52 lock-in: default US→AU retiree lifetime tax reflects real §904 FTC + FITO', () => {
  const state = runDefaultIntlRetirement();
  const tax = state.cumulativeTaxesPaid ?? 0;
  assert.ok(
    Math.abs(tax - EXPECTED_LIFETIME_TAX) / EXPECTED_LIFETIME_TAX < TOL,
    `lifetime tax ${Math.round(tax)} outside ±${TOL * 100}% of ${EXPECTED_LIFETIME_TAX} `
    + `(a large downward swing would mean the ftcYTD over-relief has returned)`,
  );
});

test('design 52 lock-in: default US→AU retiree ending net worth', () => {
  const state = runDefaultIntlRetirement();
  const nw = state.metrics?.netWorth ?? 0;
  assert.ok(
    Math.abs(nw - EXPECTED_NET_WORTH) / EXPECTED_NET_WORTH < TOL,
    `net worth ${Math.round(nw)} outside ±${TOL * 100}% of ${EXPECTED_NET_WORTH}`,
  );
});
