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
 * Wage currency routing (design 50) and wage SOURCE (design 73 Gap 1).
 *
 * A person's wage is routed by their `wageCurrency` — purely the denomination —
 * independent of residency: USD → WAGES_INCOME_APPLY → US pool;
 * AUD → AU_WAGES_INCOME_APPLY → AU pool (the earner's own AU account via ownerId).
 *
 * Currency is NOT the source. Source of employment income is where the services are
 * performed, carried by `workCountry`; WCR-4..7 cover that split.
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
 *   WCR-4: a US-resident's AUD wage for US-performed work is not AU income at all
 *   WCR-5: ...and stays out of the §904 general basket numerator
 *   WCR-6: the same earner working IN Australia IS assessed there, at NR rates
 *   WCR-7: workCountry changes the tax classification, not the cash flow
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
function runAudSpouse({ workCountry, selfEmployed } = {}) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd: SE });
  sc.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(IntlRetirementScenario.buildDefaultConfig({}, SS, SE));
  const spouse = cfg.persons.find(p => p.id === 'spouse');
  spouse.wageCurrency = 'AUD';
  spouse.monthlyWage  = 4000;
  if (workCountry !== undefined) spouse.workCountry = workCountry;
  if (selfEmployed !== undefined) spouse.selfEmployed = selfEmployed;
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

// ══════════════════════════════════════════════════════════════════════════════
// WCR-4..7 — wage SOURCE is where the work is done, not the payment currency
// (design 73 Gap 1)
//
// The spouse here is exactly the case the defect was found on: a US resident
// performing the work in the US, paid 4,000 AUD/month into an Australian account.
// The 2026 sim years precede the 2031 move, so `residency` is 'US' throughout.
// ══════════════════════════════════════════════════════════════════════════════

const sumMap = m => Object.values(m ?? {}).reduce((s, v) => s + (v ?? 0), 0);

test('WCR-4: a US-resident earner paid in AUD for US-performed work owes Australia nothing', () => {
  // workCountry unset ⇒ follows residency ⇒ 'US' ⇒ US-source. Currency is a
  // denomination, not a source: FCT v French held that wages earned abroad are
  // foreign-sourced even with the salary paid into the home-country bank account
  // throughout. Under Art 15(1) Australia may tax employment income only where the
  // employment is exercised there, so the AU return must show ZERO income.
  const state = runAudSpouse();

  assert.strictEqual(sumMap(state.auPersonNonResidentWithholdingYTD), 0,
    'a US-performed wage is not AU withholding income');
  assert.strictEqual(sumMap(state.auPersonOrdinaryIncomeYTD), 0,
    'nor is it AU assessable income');
  assert.strictEqual(state.auOrdinaryIncomeYTD ?? 0, 0);
  assert.strictEqual(state.auNonResidentWithholdingYTD ?? 0, 0);

  // The US side is unchanged: it was always right.
  assert.ok(state.usOrdinaryIncomeYTD > 0,
    'the wage is still US worldwide ordinary income');
});

test('WCR-5: US-source wages stay OUT of the §904 general basket numerator', () => {
  // The larger consequence. foreignGeneralIncomeYTD is the general-basket
  // numerator; US-source income in it inflates the §904 limitation and lets
  // foreign taxes be credited against US tax on US-source income. On the
  // reference run this one mis-attribution WAS the entire 2026 general basket.
  const state = runAudSpouse();
  assert.strictEqual(state.foreignGeneralIncomeYTD ?? 0, 0,
    'US-source income must not create §904 general-basket limitation room');
});

test('WCR-6: the same earner working IN Australia IS assessed there, at NR marginal rates', () => {
  // The case option A (just make the non-resident branch a no-op) would have made
  // unrepresentable: a genuine cross-border commuter. That income really is
  // AU-source and really is assessable — and at foreign-resident marginal rates,
  // not final withholding, since wages were never a withholding category.
  const state = runAudSpouse({ workCountry: 'AU' });

  assert.ok(sumMap(state.auPersonOrdinaryIncomeYTD) > 0,
    'AU-performed work is AU assessable income on the bracket path');
  assert.strictEqual(sumMap(state.auPersonNonResidentWithholdingYTD), 0,
    'and is NOT routed through the flat-rate final withholding bucket');
  assert.ok((state.foreignGeneralIncomeYTD ?? 0) > 0,
    'genuinely foreign-source ⇒ the general basket IS fed here');
});

test('WCR-8: the same is true of self-employment income (design 73 §6b)', () => {
  // The SE twin of WCR-6, end to end. `AU_SE_INCOME_TAX` used to branch on residency
  // alone, so this earner — a foreign resident performing the services IN Australia —
  // was assessed nowhere; and separately, `AuSeIncomeApplyReducer` dropped
  // `workCountry` when it rebuilt the tax action, so the attribute never reached the
  // classifier to be branched on. This exercises both halves through the real chain:
  // MonthlyWagesHandler → SE_INCOME_AU_APPLY → AU_SE_INCOME_TAX. The unit matrix in
  // personal-services-income-source.test.mjs covers the other three cells.
  const state = runAudSpouse({ workCountry: 'AU', selfEmployed: true });

  assert.ok(sumMap(state.auPersonOrdinaryIncomeYTD) > 0,
    's6-5(3): a foreign resident is assessed on ordinary income from Australian sources');
  assert.strictEqual(sumMap(state.auPersonNonResidentWithholdingYTD), 0,
    'services income was never a withholding category');
  assert.ok((state.foreignGeneralIncomeYTD ?? 0) > 0,
    'genuinely AU-source ⇒ the §904 general basket IS fed');
  assert.strictEqual(state.usSeEarningsYTD ?? 0, 0,
    'and SECA still does not reach it (totalization)');
});

test('WCR-7: workCountry changes the tax classification, not the cash flow', () => {
  // The AUD still lands in the AU account either way — an employer paying AUD into
  // an Australian account is a banking fact that says nothing about which country
  // may tax the wage. If these diverge, the source fix has leaked into the ledger.
  const usSourced = runAudSpouse();
  const auSourced = runAudSpouse({ workCountry: 'AU' });

  assert.ok((usSourced.spouseAuSavingsAccount?.balance ?? 0) > 15000);
  assert.strictEqual(
    Math.round(usSourced.spouseAuSavingsAccount?.balance ?? 0),
    Math.round(auSourced.spouseAuSavingsAccount?.balance ?? 0),
    'the deposited wage must be identical regardless of where the work is performed',
  );
});
