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
 * evt-state-tax.test.mjs — end-to-end US state income tax through the prebuilt
 * IntlRetirement scenario (design 34 Phase 1): classification accrues into the
 * state YTD buckets, the Dec-31 state settle pays from US savings and resets,
 * and the no-state / South-Dakota cases pay zero.
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';

import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';

function run(params) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = IntlRetirementScenario.buildDefaultConfig(params, undefined, undefined);
  const scenario = new BaseScenario({
    context: services.simulationContext, initialState: cfg.initialState ?? {},
    simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(cfg, services);
  return scenario.sim;
}

const stateYtdSum = (s) =>
  (s.stateOrdinaryIncomeYTD ?? 0) + (s.statePensionIncomeYTD ?? 0) +
  (s.stateSsIncomeYTD ?? 0) + (s.stateCapitalGainsYTD ?? 0);

const paidState = (sim) => sim.journal.journal.some(e => e.action?.type === 'STATE_TAX_PAYMENT_DEBIT');

test('EVT-STATE-1: NE resident accrues state income and settles state tax from US savings at year-end', () => {
  const sim = run({ residencyState: 'NE' });

  // Just before the Dec-31 settle: income classified into the state buckets.
  sim.stepTo(new Date(Date.UTC(2026, 11, 30)));
  const beforeSettle = stateYtdSum(sim.state);
  assert.ok(beforeSettle > 0, 'NE resident should accrue state income during the year');

  // Through the Dec-31 settle into the next year. The accumulators reset; a small
  // residual can re-accrue from late-December income posted after the settle (the
  // same "Dec interest re-adds" quirk the federal settle has), so assert a reset
  // drop rather than exact zero.
  sim.stepTo(new Date(Date.UTC(2027, 0, 2)));
  assert.ok(stateYtdSum(sim.state) < beforeSettle * 0.5, 'state YTD must reset at settlement');
  assert.ok(paidState(sim), 'STATE_TAX_PAYMENT_DEBIT should fire for a NE resident');
});

test('EVT-STATE-2: no residency state ⇒ no accrual and no state tax', () => {
  const sim = run({ residencyState: '' });
  sim.stepTo(new Date(Date.UTC(2027, 0, 2)));
  assert.equal(stateYtdSum(sim.state), 0, 'no state ⇒ nothing classified');
  assert.equal(paidState(sim), false, 'no state ⇒ no STATE_TAX_PAYMENT_DEBIT');
});

test('EVT-STATE-4: state ordinary base reconciles with the federal ordinary base (no coverage gaps)', () => {
  // A US-state resident is taxed on the same income that feeds federal AGI. The
  // state splits it across buckets (ordinary / pension / gross SS), so for a US
  // resident: usOrdinaryIncomeYTD === stateOrdinaryIncomeYTD + statePensionIncomeYTD
  // + 0.85·stateSsIncomeYTD. A missing income source (this caught US/AU savings
  // interest) breaks it. Checked EARLY in year 1 — before the first (Jun-30) bond
  // coupon (design 66 §G10a) whose Treasury slice is federal-taxable but state-EXEMPT
  // (a legitimate federal-only source that would break the mirror), and before the
  // Dec-31 year-end-dividend straddle (design 34 §13) / tax settle can muddy it.
  const sim = run({ residencyState: 'HI' });
  sim.stepTo(new Date(Date.UTC(2026, 4, 30)));   // May 30 — pre-coupon
  const s = sim.state;
  assert.equal(s.people.primary.residency, 'US');
  const federalBase = s.usOrdinaryIncomeYTD ?? 0;
  const stateBase   = (s.stateOrdinaryIncomeYTD ?? 0) + (s.statePensionIncomeYTD ?? 0) + 0.85 * (s.stateSsIncomeYTD ?? 0);
  assert.ok(federalBase > 0, 'should have accrued ordinary income by mid-year');
  assert.ok(Math.abs(federalBase - stateBase) < 1,
    `state ordinary base must mirror federal: federal=${federalBase.toFixed(2)} state=${stateBase.toFixed(2)}`);
});

test('EVT-STATE-3: SD resident accrues income but pays zero state tax', () => {
  const sim = run({ residencyState: 'SD' });
  sim.stepTo(new Date(Date.UTC(2026, 10, 30)));
  assert.ok(stateYtdSum(sim.state) > 0, 'SD still classifies income (no-tax handled at settle)');
  sim.stepTo(new Date(Date.UTC(2027, 0, 2)));
  assert.equal(paidState(sim), false, 'SD has no income tax ⇒ no payment');
});

const residencyStateOf = (sim) => sim.state.people.primary.residencyState ?? null;

test('EVT-STATE-MOVE-1: no state, then a Jan-1 move to NE begins accrual + settle (design 34 §9)', () => {
  const sim = run({ residencyState: '', stateMoveYear: 2028, stateMoveDestination: 'NE' });

  // Before the move: no state configured ⇒ no accrual, no state set.
  sim.stepTo(new Date(Date.UTC(2027, 11, 30)));
  assert.equal(stateYtdSum(sim.state), 0, 'no accrual before the move');
  assert.equal(residencyStateOf(sim), null, 'no residency state before the move');
  assert.equal(paidState(sim), false, 'no state tax paid before the move');

  // Cross the Jan-1-2028 move: every person flips to NE and accrual begins.
  sim.stepTo(new Date(Date.UTC(2028, 5, 30)));
  assert.equal(residencyStateOf(sim), 'NE', 'move flips the primary to NE');
  assert.equal(sim.state.people.spouse.residencyState, 'NE', 'move flips the spouse too (design 34 §9)');
  assert.ok(stateYtdSum(sim.state) > 0, 'NE accrual begins after the move');

  // The 2028 year-end settle pays NE state tax.
  sim.stepTo(new Date(Date.UTC(2029, 0, 2)));
  assert.ok(paidState(sim), 'NE state tax settles for the move year');
});

test('EVT-STATE-MOVE-2: SD→HI move on Jan 1 activates taxation (zero before, paid after)', () => {
  const sim = run({ residencyState: 'SD', stateMoveYear: 2029, stateMoveDestination: 'HI' });

  // SD years: income classifies but settle pays zero.
  sim.stepTo(new Date(Date.UTC(2028, 11, 30)));
  assert.equal(residencyStateOf(sim), 'SD', 'starts in SD');
  sim.stepTo(new Date(Date.UTC(2029, 0, 1, 12)));
  assert.equal(paidState(sim), false, 'no state tax paid while SD-resident');

  // After the Jan-1-2029 move to HI, the HI year-end settle pays state tax.
  sim.stepTo(new Date(Date.UTC(2029, 5, 30)));
  assert.equal(residencyStateOf(sim), 'HI', 'move flips SD → HI');
  sim.stepTo(new Date(Date.UTC(2030, 0, 2)));
  assert.ok(paidState(sim), 'HI state tax settles after the move');
});
