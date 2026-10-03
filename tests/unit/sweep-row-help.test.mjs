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
 * sweep-row-help.test.mjs — every Monte Carlo and Optimize variable row has somewhere for
 * its `?` to go, and that somewhere exists.
 *
 * A row is keyed by the param it sweeps, but a third of them are not schema params: legacy
 * aliases, generated per-record keys, graph axes, array paths. `sweepRowHelp` routes each
 * to words already in the index. This is the gate that a lever added to either panel
 * cannot ship with a `?` that opens "No parameter …" — or with none at all.
 *
 * Against the REAL index and the REAL reference plan, loaded as the app loads it, so the
 * harvested per-record rows (prop.*, acct.*, person.*) are in the list.
 */

import { test, before } from 'node:test';
import assert           from 'node:assert/strict';

import { sweepRowHelp }            from '../../src/visualization/help/sweep-row-help.js';
import { buildHelpIndex }          from '../../scripts/lib/help-index.mjs';
import { IntlRetirementMcConfig }  from '../../src/finance/monte-carlo/intl-retirement-mc-config.js';
import { buildOptVariables }       from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';
import { ServiceRegistry }         from '../../src/services/service-registry.js';
import { ScenarioLoader }          from '../../src/scenarios/scenario-loader.js';
import { paramSchemaDefaults, scenarioParamValues } from '../../src/finance/param-schema-utils.js';
import { buildGoldenCfg }          from '../helpers/golden-harness.js';

let INDEX;
const ALIASES = ScenarioLoader.paramAliasesFor(null);

before(async () => { INDEX = await buildHelpIndex(); });

/** Does the index hold what `ref` points at? The same lookups the Help panel paints from. */
function landsOnSomething(ref) {
  if (ref.param) return INDEX.params.some(p => p.key === ref.param);
  if (ref.topic) return INDEX.topics.some(t => t.id === ref.topic);
  const node = INDEX.nodes.find(n => n.kind === ref.node);
  if (!node) return false;
  return ref.field == null || node.fields.some(f => f.field === ref.field);
}

/** The reference plan's MC and Opt rows, from the base the presenters build. */
function referenceRows() {
  const spec = { name: 'sweep-row-help', simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd: new Date(Date.UTC(2034, 0, 1)) };
  const registry = new ServiceRegistry();
  new IntlRetirementScenario({ context: registry.simulationContext, params: {},
    simStart: spec.simStart, simEnd: spec.simEnd }).buildSim();
  const cfg = buildGoldenCfg(spec);
  new ScenarioLoader().load(cfg, registry);
  // A shock and both lifespans, so the array-path and `people.` rows are offered too.
  const base = { ...paramSchemaDefaults(IntlRetirementScenario.buildFullParamSchema()),
    ...scenarioParamValues(cfg),
    shocks: [{ severity: 0.3, startDate: '2030-01-01' }],
    people: { primary: { lifeExpectancy: 90 }, spouse: { lifeExpectancy: 92 } } };
  return {
    mc:  new IntlRetirementMcConfig().buildVariables(base, { cfg }),
    opt: buildOptVariables(base, cfg.accounts ?? null, { cfg }),
  };
}

test('SRH-1: every MC and Opt row on the reference plan resolves to help that exists', () => {
  const { mc, opt } = referenceRows();
  assert.ok(mc.length > 30 && opt.length > 15, 'the reference plan should offer both lists');
  assert.ok(mc.some(v => v.harvested), 'generated per-record rows must be in the list tested');

  for (const [panel, rows] of [['MC', mc], ['Opt', opt]]) {
    const homeless = rows
      .filter(v => { const h = sweepRowHelp(v.paramKey, INDEX, ALIASES); return !h || !landsOnSomething(h.ref); })
      .map(v => v.paramKey);
    assert.deepEqual(homeless, [],
      `${panel} rows with no help to open — route them in sweep-row-help.js`);
  }
});

test('SRH-2: each key shape routes where its words are', () => {
  const at = key => sweepRowHelp(key, INDEX, ALIASES)?.ref;

  assert.deepEqual(at('inflationRate'), { param: 'inflationRate' }, 'a schema param');
  // A legacy alias follows its successor, and `balanceTarget` is the Balance box.
  assert.deepEqual(at('rothBalance'),         { node: 'account', field: 'balance' });
  assert.deepEqual(at('primaryMonthlyWage'),  { node: 'person', field: 'monthlyWage' });
  // (The sale YEAR aliases were retired by design 117: no row is keyed on them.)
  assert.deepEqual(at('prop.anyHouse.plannedSaleDate'), { node: 'real-property', field: 'plannedSaleDate' });
  // Generated keys, whatever the record's id.
  assert.deepEqual(at('acct.anyAccount.minimumBalance'), { node: 'account', field: 'minimumBalance' });
  assert.deepEqual(at('prop.anyHouse.appreciationRate'), { node: 'real-property', field: 'appreciationRate' });
  assert.deepEqual(at('people.spouse.lifeExpectancy'),   { node: 'person', field: 'lifeExpectancy' });
  // Axes with no record → their concept topic.
  for (const key of ['pool.p1.targetScale', 'shape.s1.yearShift', 'gate.g1.threshold']) {
    assert.deepEqual(at(key), { topic: 'searching-pool-levers' }, key);
  }
  assert.deepEqual(at('shocks[0].severity'), { topic: 'economic-shocks' });

  for (const key of ['rothBalance', 'pool.p1.targetScale', 'shocks[0].startDate']) {
    assert.ok(landsOnSomething(at(key)), `${key} must land on something the index holds`);
  }
});

test('SRH-3: the hover carries the full description a param or field already has', () => {
  const p = INDEX.params.find(x => x.key === 'inflationRate');
  assert.equal(sweepRowHelp('inflationRate', INDEX, ALIASES).description, p.description);
  const f = INDEX.nodes.find(n => n.kind === 'account').fields.find(x => x.field === 'minimumBalance');
  assert.equal(sweepRowHelp('acct.x.minimumBalance', INDEX, ALIASES).description, f.description);
});

test('SRH-4: an unknown key and a missing index resolve to nothing, not to a dead `?`', () => {
  assert.equal(sweepRowHelp('noSuchLever', INDEX, ALIASES), null);
  assert.equal(sweepRowHelp('nope.x.y', INDEX, ALIASES), null);
  assert.equal(sweepRowHelp('inflationRate', null, ALIASES), null);
});
