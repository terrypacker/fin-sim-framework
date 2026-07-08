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
 * evt-wage-currency-routing.test.mjs
 *
 * Wage currency routing (design 50). A person's wage is routed by their
 * `wageCurrency` (the source/denomination), independent of residency:
 * USD → WAGES_INCOME_APPLY → US pool; AUD → AU_WAGES_INCOME_APPLY → AU pool
 * (the earner's own AU account via ownerId).
 *
 * REGRESSION: `wageCurrency` was never carried into the `state.people`
 * projection (built in us/au-retirement + cross-border toolset `state()`), so
 * `person.wageCurrency` read as `undefined` at runtime → every wage routed to
 * USD. An AUD earner (e.g. a spouse) was silently paid into a US account. Fix:
 * project `wageCurrency` in all three people projections.
 *
 *   WCR-1: the compiled scenario carries state.people.<id>.wageCurrency
 *   WCR-2: an AUD-wage spouse is paid into their AU account, not US savings
 *   WCR-3: MonthlyWagesHandler routes by wageCurrency (unit — AUD→AU, USD→US)
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { MonthlyWagesHandler }    from '../../src/finance/handlers/monthly-wages-handler.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2026, 5, 1)); // 5 months — before any move / retirement

/**
 * Build the default config, give the spouse an AUD wage + an AU savings account
 * to receive it, run to SE, return sim.state.
 */
function runAudSpouse() {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd: SE });
  sc.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(IntlRetirementScenario.buildDefaultConfig({}, SS, SE));
  const spouse = cfg.persons.find(p => p.id === 'spouse');
  spouse.wageCurrency = 'AUD';
  spouse.monthlyWage  = 4000;
  cfg.accounts.push({
    __type: 'SavingsAccount', stateKey: 'spouseAuSavingsAccount', name: 'AU Savings (Spouse)',
    ownerId: 'spouse', role: 'au-savings', balance: 0, minimumBalance: 0,
    country: 'AU', currency: { code: 'AUD', symbol: 'A$' }, drawdownPriority: null,
  });
  new ScenarioLoader().load(cfg, reg);
  sc.sim.silent = true; sc.sim.journal.enabled = false;
  sc.sim.stepTo(SE);
  return sc.sim.state;
}

test('WCR-1: the compiled scenario projects wageCurrency onto state.people', () => {
  const state = runAudSpouse();
  assert.equal(state.people?.spouse?.wageCurrency, 'AUD',
    'state.people.spouse.wageCurrency must be carried by the people projection');
});

test('WCR-2: an AUD-wage spouse is paid into their AU account, not US savings', () => {
  const state = runAudSpouse();
  // 5 monthly AUD wages of 4000 accrue in the spouse's own AU account.
  assert.ok((state.spouseAuSavingsAccount?.balance ?? 0) > 15000,
    `the AUD wage must land in the spouse's AU account (got ${Math.round(state.spouseAuSavingsAccount?.balance ?? 0)})`);
});

test('WCR-3: MonthlyWagesHandler routes by wageCurrency (AUD→AU, USD→US)', () => {
  const stateRegistry = {
    resolveTransactionAccountKey: () => null, // nothing flagged → SAVINGS-role fallback
    getStateKey: (role, ownerId) => {
      if (role === 'au-savings') return ownerId === 'spouse' ? 'spouseAuSavingsAccount' : 'auSavingsAccount';
      if (role === 'us-savings') return 'usSavingsAccount';
      return null;
    },
  };
  const state = {
    people: {
      primary: { name: 'P', monthlyWage: 8000, wageCurrency: 'USD' },
      spouse:  { name: 'S', monthlyWage: 4000, wageCurrency: 'AUD' },
    },
  };
  const actions = new MonthlyWagesHandler({ stateRegistry }).call({ date: SS, state });

  const us = actions.find(a => a?.type === 'WAGES_INCOME_APPLY');
  const au = actions.find(a => a?.type === 'AU_WAGES_INCOME_APPLY');
  assert.ok(us && us.personKey === 'primary' && us.targetKey === 'usSavingsAccount',
    'USD wage → WAGES_INCOME_APPLY → US savings');
  assert.ok(au && au.personKey === 'spouse' && au.targetKey === 'spouseAuSavingsAccount',
    "AUD wage → AU_WAGES_INCOME_APPLY → the earner's own AU account");
});
