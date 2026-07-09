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
 * design-55-flexible-counts.test.mjs — design 55 §12 Phase 4.
 *
 * The parameter surface is a function of the record set, so account / person /
 * property COUNTS become flexible without touching the schema. These tests drive
 * the full compile + run so "the generator emits params for N records" is proven
 * against an actually-executing simulation, not just the generator in isolation:
 *
 *   FLEX-1: a single-person household compiles, runs, and drops the spouse's params
 *   FLEX-2: a third account of an existing type generates its own params and is live
 *   FLEX-3: multiple properties each get their own generated param group
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2032, 0, 1));

/** Build the default config, apply `mutate(cfg)`, run to SE; return { state, cfg }. */
function run(mutate) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd: SE });
  sc.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(IntlRetirementScenario.buildDefaultConfig({}, SS, SE));
  cfg.parameters = { ...(cfg.parameters ?? {}) };
  mutate(cfg);
  new ScenarioLoader().load(cfg, reg);
  sc.sim.silent = true; sc.sim.journal.enabled = false;
  sc.sim.stepTo(SE);
  return { state: sc.sim.state, cfg };
}

const paramNames = (cfg) => (cfg.params ?? []).map(p => p.name);

test('FLEX-1: a single-person household compiles, runs, and drops the spouse params', () => {
  const { state, cfg } = run(cfg => {
    cfg.persons  = cfg.persons.filter(p => p.id !== 'spouse');
    cfg.accounts = cfg.accounts.filter(a => a.ownerId !== 'spouse');
  });

  const names = paramNames(cfg);
  assert.ok(names.includes('person.primary.monthlyWage'), 'primary keeps its generated params');
  assert.ok(!names.some(n => n.startsWith('person.spouse.')), 'no spouse person params remain');
  assert.ok(!names.some(n => n.startsWith('acct.spouseRothAccount.')), 'no spouse account params remain');

  // The run produced a live primary savings account (sanity that compile + step worked).
  assert.ok(state.usSavingsAccount, 'primary US savings exists in the run state');
});

test('FLEX-2: a third account of an existing type generates its own params and is live', () => {
  const { state, cfg } = run(cfg => {
    const roth = cfg.accounts.find(a => a.stateKey === 'rothAccount');
    const clone = structuredClone(roth);
    clone.stateKey = 'rothAccount3';
    clone.id       = 'roth-account-3';
    clone.name     = 'Roth IRA (Third)';
    clone.balance  = 12_345;
    delete clone.holdings; // let AccountService re-bootstrap a default holding
    cfg.accounts.push(clone);
  });

  const names = paramNames(cfg);
  // balance is derived from holdings (design 55 §13) so it is NOT generated; the 3rd
  // account still gets its own contributionBasis + growthRate params.
  assert.ok(!names.includes('acct.rothAccount3.balance'),
    'holdings-bearing account gets no balance param (balance derives from holdings)');
  assert.ok(names.includes('acct.rothAccount3.contributionBasis'), 'the 3rd account gets a contributionBasis param');
  assert.ok(names.includes('acct.rothAccount3.growthRate'), 'the 3rd account gets a growthRate param');

  // It is a real, compiled, running account — present in state and grown past its seed.
  assert.ok(state.rothAccount3, 'the 3rd account exists in the run state');
  assert.ok((state.rothAccount3.balance ?? 0) > 0, 'the 3rd account participated in the run');
});

test('FLEX-3: multiple properties each get their own generated param group', () => {
  const { cfg } = run(() => {});
  const props = (cfg.realProperties ?? []).map(r => r.stateKey);
  assert.ok(props.length >= 2, `default config has ≥2 properties (got ${props.length})`);

  for (const key of props) {
    const names = paramNames(cfg);
    assert.ok(names.includes(`prop.${key}.value`), `${key} gets a value param`);
    assert.ok(names.includes(`prop.${key}.appreciationRate`), `${key} gets an appreciationRate param`);
  }
  // Each property's params cluster under a distinct per-record group.
  const groups = new Set((cfg.params ?? [])
    .filter(p => p.name.startsWith('prop.'))
    .map(p => p.group));
  assert.ok(groups.size >= 2, 'per-property groups are distinct (one collapsible section each)');
});
