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
 * ss-claim-age-liveness.test.mjs — design 118 phase 2.
 *
 * The claim age is a lever only if it reaches the sim on a LOADED plan, through the path
 * the optimizer uses. A field can compile, serialize and appear in the Opt panel while a
 * forwarding step drops it, so each test here drives the reference plan, not a hand-built
 * config.
 *
 *   SSCA-1: the Opt panel offers person.<id>.ssClaimAge for both people, as nine ages
 *   SSCA-2: 62, 67 and 70 through an optimizer rollout produce three different runs
 *   SSCA-3: the legacy primarySsClaimAge key is the same lever
 *   SSCA-4: a loaded plan claiming at 62 stamps the right month and pays 70.4% of the PIA
 *   SSCA-5: the person record round-trips its claim age through the serializer
 *   SSCA-6: phase 3 — a spouse whose PIA is under half the primary's is paid the spousal
 *           top-up on the loaded plan, reduced for its own start month
 *   SSCA-7: phase 4 — when the primary (an early claimant) dies, the spouse is paid the
 *           survivor benefit from the death month, through the real mortality path
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { OptimizationProblem }    from '../../src/finance/optimization/optimization-problem.js';
import { OPT_PARAM_TYPES }        from '../../src/finance/optimization/optimization-objectives.js';
import { buildOptVariables }      from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { BaseScenario }           from '../../src/scenarios/base-scenario.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { scenarioParamValues }    from '../../src/finance/param-schema-utils.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { PersonBuilder }          from '../../src/finance/builders/person-builder.js';

// The primary is born 15 Apr 1978: 62 in 2040, full retirement age (67) in Apr 2045, 70 in
// 2048. The run must reach past 70 for every claim age to have started.
const SIM = {
  simStart: new Date(Date.UTC(2026, 0, 1)),
  simEnd:   new Date(Date.UTC(2050, 0, 1)),
};
const KEY = 'person.primary.ssClaimAge';

/** Build and load the reference plan, as the app does before any panel reads it. */
function loadPlan(overrides = {}, editPeople = () => {}) {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const cfg = IntlRetirementScenario.buildDefaultConfig(overrides, SIM.simStart, SIM.simEnd);
  editPeople(Object.fromEntries(cfg.persons.map(p => [p.id, p])));
  const scenario = new BaseScenario({
    context: services.simulationContext, initialState: cfg.initialState ?? {},
    simStart: SIM.simStart, simEnd: SIM.simEnd,
  });
  scenario.buildSim({ telemetry: 'journal' });
  new ScenarioLoader().load(cfg, services);
  return { cfg, scenario };
}

function rollout(candidate) {
  const variables = Object.keys(candidate).map(paramKey =>
    ({ paramKey, type: OPT_PARAM_TYPES.ENUM, values: [62, 67, 70] }));
  return new OptimizationProblem({ variables, ...SIM }).evaluate(candidate).result;
}

test('SSCA-1: the Opt panel offers each person\'s claim age as the nine whole-year ages', () => {
  // The Opt presenter's base: the loaded cfg's param values, with the cfg for the harvest.
  const { cfg } = loadPlan();
  const rows = buildOptVariables(scenarioParamValues(cfg), null, { cfg })
    .filter(v => /^person\.\w+\.ssClaimAge$/.test(v.paramKey));
  assert.deepEqual(rows.map(r => r.paramKey).sort(), ['person.primary.ssClaimAge', 'person.spouse.ssClaimAge']);
  for (const r of rows) {
    assert.equal(r.type, OPT_PARAM_TYPES.ENUM);
    assert.deepEqual(r.values, [62, 63, 64, 65, 66, 67, 68, 69, 70]);
    assert.equal(r.enabled, false, 'a harvested row ships disabled');
  }
});

test('SSCA-2: claiming at 62, 67 and 70 are three different plans', () => {
  const at62 = rollout({ [KEY]: 62 });
  const at67 = rollout({ [KEY]: 67 });
  const at70 = rollout({ [KEY]: 70 });
  assert.notDeepStrictEqual(at62, at67);
  assert.notDeepStrictEqual(at70, at67);
  assert.notDeepStrictEqual(at62, at70);
});

test('SSCA-3: primarySsClaimAge is an alias of person.primary.ssClaimAge', () => {
  const viaAlias = rollout({ primarySsClaimAge: 62 });
  assert.deepStrictEqual(viaAlias, rollout({ [KEY]: 62 }));
  // and it moves the run: equality above would also hold if both keys were dead
  assert.notDeepStrictEqual(viaAlias, rollout({ [KEY]: 67 }));
});

function quietStepTo(scenario, date) {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(date); }
  finally { console.log = log; console.warn = warn; }
}

test('SSCA-4: a loaded plan claiming at 62 is entitled from May 2040 at 70.4% of the PIA', () => {
  const { scenario } = loadPlan({ primarySsClaimAge: 62 });
  quietStepTo(scenario, new Date(Date.UTC(2040, 4, 31)));

  const primary = scenario.sim.state.people.primary;
  assert.equal(primary.ssClaimAge, 62);
  // Attains 62 on 14 Apr 2040, so 62 throughout from May (20 CFR 404.311(a)(2)).
  assert.equal(primary.ssEntitledMs, Date.UTC(2040, 4, 1));

  const paid = scenario.sim.journal.journal
    .filter(e => e.action?.type === 'SS_INCOME_APPLY' && e.action.data?.personKey === 'primary')
    .map(e => e.action.data.amount);
  assert.ok(paid.length >= 1, 'the first benefit is paid at the end of May 2040');
  // 59 months early: 36 × 5/9% + 23 × 5/12% = 29.583…% (20 CFR 404.410(a)).
  const factor = 1 - (36 * 5 / 9 + 23 * 5 / 12) / 100;
  assert.ok(Math.abs(paid.at(-1) - primary.socialSecurityMonthly * factor) < 1e-6,
    `paid ${paid.at(-1)} vs ${primary.socialSecurityMonthly * factor}`);
});

test('SSCA-5: a person\'s claim age round-trips through the serializer, blank as blank', () => {
  for (const age of [64, null]) {
    const person = PersonBuilder.person().id('p1').birthDate('1970-05-10').ssClaimAge(age).build();
    const saved  = ScenarioSerializer._serializePerson(person);
    assert.equal(saved.ssClaimAge, age);
    assert.equal(ScenarioSerializer._makePerson(JSON.parse(JSON.stringify(saved))).ssClaimAge, age);
  }
  assert.throws(() => PersonBuilder.person().ssClaimAge(61).build(), /ssClaimAge/);
});

test('SSCA-6: a spouse with under half the primary\'s PIA is paid the spousal top-up on the loaded plan', () => {
  // The spouse (born 22 Sep 1983) claims at 62: entitled Oct 2045, after the primary's
  // FRA claim in Apr 2045, so the top-up starts with the spouse's own benefit, 59 months
  // before the spouse's FRA (Sep 2050).
  const { scenario } = loadPlan({}, ({ spouse }) => {
    spouse.socialSecurityMonthly = 400;
    spouse.ssClaimAge = 62;
  });
  quietStepTo(scenario, new Date(Date.UTC(2045, 9, 31)));

  const { primary, spouse } = scenario.sim.state.people;
  assert.equal(spouse.ssEntitledMs, Date.UTC(2045, 9, 1));
  const paid = scenario.sim.journal.journal
    .filter(e => e.action?.type === 'SS_INCOME_APPLY' && e.action.data?.personKey === 'spouse')
    .map(e => e.action.data);
  assert.equal(paid.length, 1, 'one payment, at the end of October 2045');
  const own     = spouse.socialSecurityMonthly * (1 - (36 * 5 / 9 + 23 * 5 / 12) / 100);
  const spousal = (primary.socialSecurityMonthly / 2 - spouse.socialSecurityMonthly)
    * (1 - (36 * 25 / 36 + 23 * 5 / 12) / 100);
  assert.ok(Math.abs(paid[0].own - own) < 1e-6, `own ${paid[0].own} vs ${own}`);
  assert.ok(Math.abs(paid[0].spousal - spousal) < 1e-6, `spousal ${paid[0].spousal} vs ${spousal}`);
  assert.ok(Math.abs(paid[0].amount - own - spousal) < 1e-6);
});

test('SSCA-7: a widow(er) on the loaded plan is paid the survivor benefit from the death month', () => {
  // The primary claims at 62 (May 2040, 70.4%) and dies at 68 on 15 Apr 2046. The spouse
  // (PIA 400) claimed at 62 in Oct 2045, so the survivor benefit starts in April 2046,
  // 53 months before the spouse's survivor FRA (Sep 2050) out of 84 from age 60.
  const { scenario } = loadPlan({ primarySsClaimAge: 62, primaryLifeExpectancy: 68 }, ({ spouse }) => {
    spouse.socialSecurityMonthly = 400;
    spouse.ssClaimAge = 62;
  });
  quietStepTo(scenario, new Date(Date.UTC(2046, 3, 30)));

  const { people } = scenario.sim.state;
  assert.equal(people.primary, undefined, 'the primary has died');
  const died = scenario.sim.journal.journal
    .find(e => e.action?.type === 'SOCIAL_SECURITY_SURVIVOR_APPLY')?.action.data;
  assert.equal(died.deceasedEntitledMs, Date.UTC(2040, 4, 1));
  const s = people.spouse;
  assert.equal(s.ssSurvivorPia, died.deceasedSocialSecurityMonthly);
  assert.equal(s.ssSurvivorRatio, 1);
  assert.equal(s.ssSurvivorRibLimCap, 0.825, '70.4% is under the 82½% floor');
  assert.equal(s.ssSurvivorFromMs, Date.UTC(2046, 3, 1));

  const april = scenario.sim.journal.journal
    .filter(e => e.action?.type === 'SS_INCOME_APPLY' && e.action.data?.personKey === 'spouse')
    .map(e => e.action.data).at(-1);
  const w = s.ssSurvivorPia * Math.min(1 - 0.285 * 53 / 84, 0.825);
  assert.ok(Math.abs(april.amount - w) < 1e-6, `paid ${april.amount} vs ${w}`);
  assert.ok(Math.abs(april.own + april.survivor - w) < 1e-6 && april.spousal === 0);
});
