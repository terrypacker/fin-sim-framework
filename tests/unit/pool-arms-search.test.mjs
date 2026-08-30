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
 * pool-arms-search.test.mjs — design 97 §18.3, step 3.
 *
 * `scripts/lib/pool-arms.mjs` turns the shape × size × refill space into Monte Carlo arms.
 * The tests that matter are not "does it enumerate" — they are the four ways a pool search
 * produces a confident non-finding:
 *
 *   · PA-4  the refill pair differs ONLY by the flag, so "does refilling help" is one
 *           question and not two (design 97 §16.3).
 *   · PA-6  the hygiene sits in the spec's `base`, so it reaches the CONTROL too. An arm and
 *           a control that differ in two ways measure neither.
 *   · PA-7  an inert axis THROWS. §7.2 lost two sessions to a graph that never reached
 *           state, and the grid it produced looked exactly like a null result.
 *   · PA-9  the whole path end to end, on a real sim: levers → variant → load → state.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { poolArmGrid, poolArmLevers, poolArmBase, poolArmSpec, assertPoolArmLanded,
         assertArmsWealthMatched, REFILL_MODE, matchedControlArms, mixGap }
  from '../../scripts/lib/pool-arms.mjs';
import { buildVariant } from '../../scripts/lib/variant.mjs';
import { mergeArmLevers } from '../../scripts/lib/mc.mjs';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader } from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { BaseScenario } from '../../src/scenarios/base-scenario.js';
import { computeNetWorth } from '../../src/finance/derived-metrics/net-worth.js';

const ACCOUNTS = [
  { stateKey: 'usSavings',   type: 'checking' },
  { stateKey: 'usBrokerage', type: 'brokerage' },
  { stateKey: 'auOffset',    type: 'offset', offsetsPropertyKey: 'auHouse' },
];
const CFG = { accounts: ACCOUNTS };

test('PA-1: the pool-less control is emitted ONCE, whatever the size and refill axes do', () => {
  const arms = poolArmGrid({
    shapes: ['POOL_LESS', 'CASH_BOND'],
    cashYears: [1, 2], bondYears: [0, 4],
    refills: [REFILL_MODE.OFF, REFILL_MODE.HARVEST],
  });
  // A "pool-less, 4 bond years" arm is the control run again under a name that claims it
  // measured something — which is how a grid reports a size effect on a plan with no pools.
  assert.equal(arms.filter(a => a.shape === 'POOL_LESS').length, 1);
  assert.equal(arms.length, 1 + (2 * 2 * 2));
});

test('PA-2: a shape with no bond pool does not sweep bond years', () => {
  const arms = poolArmGrid({ shapes: ['CASH_ONLY'], cashYears: [1], bondYears: [0, 2, 4, 6] });
  assert.equal(arms.length, 1, 'four identical runs under four names would read as a flat size response');
  assert.equal(arms[0].bondYears, null);
});

test('PA-3: arm keys are unique and safe as filenames', () => {
  const arms = poolArmGrid({
    shapes: ['POOL_LESS', 'CASH_BOND', 'OFFSET_AFTER_BONDS', 'OFFSET_BEFORE_BONDS', 'DRY_POWDER'],
    cashYears: [0.5, 1, 2], bondYears: [0, 2, 4, 6],
    refills: Object.values(REFILL_MODE),
  });
  const keys = arms.map(a => a.key);
  assert.equal(new Set(keys).size, keys.length, 'two arms writing one filename overwrite each other');
  for (const k of keys) assert.match(k, /^[a-z0-9-]+$/, `unsafe arm key '${k}'`);
});

test('PA-4: refill OFF and ON differ ONLY by the flag — same pools, same sizes, same order', () => {
  const [armOff] = poolArmGrid({ shapes: ['CASH_BOND'], bondYears: [4], refills: [REFILL_MODE.OFF] });
  const [armOn]  = poolArmGrid({ shapes: ['CASH_BOND'], bondYears: [4], refills: [REFILL_MODE.ON] });
  const off = poolArmLevers(CFG, armOff).params;
  const on  = poolArmLevers(CFG, armOn).params;

  // Design 97 §16.3: the arm-vs-control for the refill rule is a FLAG. Deleting the flows
  // instead would change the pool topology as well, and the two arms would differ twice.
  assert.deepEqual(off.liquidityGraph, on.liquidityGraph);
  assert.equal(off.poolFlowsEnabled, false);
  assert.equal(on.poolFlowsEnabled, true);
});

test('PA-5: HARVEST differs from ON only by the market-state gate', () => {
  const [armOn]   = poolArmGrid({ shapes: ['CASH_BOND'], bondYears: [4], refills: [REFILL_MODE.ON] });
  const [armHarv] = poolArmGrid({ shapes: ['CASH_BOND'], bondYears: [4], refills: [REFILL_MODE.HARVEST] });
  const on   = poolArmLevers(CFG, armOn).params.liquidityGraph;
  const harv = poolArmLevers(CFG, armHarv).params.liquidityGraph;

  assert.deepEqual(on.pools, harv.pools);
  const edge = (g) => g.flows.find(f => f.id === 'growth-to-buffer');
  assert.equal(edge(on).gate, undefined);
  // §16.1b — the RETURN gate, never the trailing-high one, which latches shut forever in a
  // decumulation plan.
  assert.deepEqual(edge(harv).gate, { sourceReturnOver: 0 });
  assert.equal(on.flows.length, harv.flows.length);
});

test('PA-6: the hygiene is in the spec BASE, so the control gets it too', () => {
  const arms = poolArmGrid({ shapes: ['POOL_LESS', 'CASH_BOND'], bondYears: [4] });
  const spec = poolArmSpec(CFG, arms);

  // Each of these is a setting the pooled arms need. Applied to the pooled arms ALONE, the
  // control would run a different allocation policy and a different crash — and the grid
  // would report the difference as the pool shape.
  assert.equal(spec.base.params.allocationSchedule, 'STATIC');
  assert.equal(spec.base.params.poolCashYears, null);
  assert.equal(spec.base.params.poolBondYears, null);
  assert.equal(spec.base.params.drawdownSequence, null);
  assert.deepEqual(spec.base.params.shocks, []);

  // …and the control itself carries no graph.
  assert.equal(spec.arms.none.params.liquidityGraph, null);
  assert.ok(spec.arms['cb-c1-b4-harv'].params.liquidityGraph);

  // A caller's extra base levers merge without dropping the hygiene.
  assert.equal(poolArmBase({ params: { monthlyExpenses: 9000 } }).params.allocationSchedule, 'STATIC');
  assert.equal(poolArmBase({ params: { monthlyExpenses: 9000 } }).params.monthlyExpenses, 9000);
});

test('PA-17: extra base levers passed to poolArmSpec actually REACH the spec', () => {
  // They did not. The third argument was destructured as `{ base = {} }` while every caller
  // passed the bare lever set, so a study's extra params were silently dropped — and it was
  // found only because a driver asserted its own treatment had landed.
  const arms = poolArmGrid({ shapes: ['CASH_BOND'], bondYears: [4] });
  const spec = poolArmSpec(CFG, arms, {
    params: { shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2032-01-01' }] },
  });

  assert.equal(spec.base.params.shocks.length, 1, 'the extra param never reached the spec');
  assert.equal(spec.base.params.allocationSchedule, 'STATIC', 'and the hygiene survived it');

  // The old wrapper shape is now a loud error rather than a silent drop.
  assert.throws(() => poolArmSpec(CFG, arms, { base: { params: { shocks: [] } } }),
    /pass the lever set directly/);
});

describe('the landing gate', () => {
  const [control] = poolArmGrid({ shapes: ['POOL_LESS'] });
  const [pooled]  = poolArmGrid({ shapes: ['CASH_BOND'], bondYears: [4] });

  test('PA-7a: a graph that never reached state throws, and says the axis is inert', () => {
    assert.throws(() => assertPoolArmLanded({}, pooled), /INERT/);
  });

  test('PA-7b: a graph that compiled to no spend order throws', () => {
    assert.throws(
      () => assertPoolArmLanded({ liquidityGraph: { pools: [{ id: 'cash' }] } }, pooled),
      /compiled to no `drawdownSequence`/,
    );
  });

  test('PA-7c: a CONTROL carrying a graph throws — it would be a fifth arm', () => {
    assert.throws(
      () => assertPoolArmLanded({ liquidityGraph: { pools: [{ id: 'cash' }] }, drawdownSequence: [{}] }, control),
      /is the CONTROL but carries a compiled pool sequence/,
    );
    assert.doesNotThrow(() => assertPoolArmLanded({}, control));
  });

  test('PA-7d: the wrong number of pools throws — a shape that silently lost one', () => {
    assert.throws(() => assertPoolArmLanded({
      liquidityGraph: { pools: [{ id: 'cash' }, { id: 'growth' }] },
      drawdownSequence: [{ key: 'a' }],
    }, pooled), /expected 3 pools/);
  });
});

test('PA-10: the runner\'s merge keeps the base hygiene under an arm that carries params', () => {
  // The bug this pins: a plain spread replaces `base.params` wholesale as soon as an arm has
  // its own, so every pooled arm would quietly keep the glidepath and the dated shock that
  // the spec's base removed — and the control, which also carries params, would too. Every
  // arm then runs a different baseline than the one the spec states.
  const arms = poolArmGrid({ shapes: ['POOL_LESS', 'CASH_BOND'], bondYears: [4] });
  const spec = poolArmSpec(CFG, arms);

  for (const key of Object.keys(spec.arms)) {
    const merged = mergeArmLevers(spec.base, spec.arms[key]);
    assert.equal(merged.params.allocationSchedule, 'STATIC', `${key} lost the hygiene`);
    assert.deepEqual(merged.params.shocks, [], `${key} kept a dated shock`);
    // …while the arm's own params still win where they overlap.
    assert.equal('liquidityGraph' in merged.params, true);
  }
  assert.equal(mergeArmLevers(spec.base, spec.arms.none).params.liquidityGraph, null);
});

describe('the allocation-matched control', () => {
  // A years-of-spend pool target sizes the MIX with equity taking the residual (§9.2), so the
  // size axis is also an equity-share axis and a pool-less control on its own authored weights
  // differs from every pooled arm by a portfolio as well as a draw order.
  const MEASURED = [
    // As measured on a real plan: the four sleeve classes sum to ~0.80 because the allocation
    // cube spans the whole balance sheet — property and company equity are in the other 20%.
    { key: 'oab-c1-b0-harv', mix: { EQUITY: 0.784, BOND: 0.001, CASH: 0.010, GOLD: 0.010 } },
    { key: 'obb-c1-b0-harv', mix: { EQUITY: 0.781, BOND: 0.002, CASH: 0.010, GOLD: 0.010 } },
    { key: 'oab-c1-b6-harv', mix: { EQUITY: 0.590, BOND: 0.140, CASH: 0.030, GOLD: 0.010 } },
  ];

  test('PA-11: controls dedupe by MIX, not by arm — shape and refill barely move it', () => {
    const { arms, controlFor } = matchedControlArms(MEASURED);
    assert.equal(arms.length, 2, 'the two 0-year arms round to one mix and share a control');
    assert.equal(controlFor.get('oab-c1-b0-harv'), controlFor.get('obb-c1-b0-harv'));
    assert.notEqual(controlFor.get('oab-c1-b0-harv'), controlFor.get('oab-c1-b6-harv'));
    assert.deepEqual(arms.find(a => a.key === controlFor.get('oab-c1-b0-harv')).matchedTo,
      ['oab-c1-b0-harv', 'obb-c1-b0-harv']);
  });

  test('PA-12: the measured mix is RENORMALISED, or the residual class absorbs the house', () => {
    // The bug this pins: fed unnormalised, the 20% of the balance sheet that is NOT
    // rebalanceable lands on the stick-breaking residual — so a plan measured at 78% equity
    // and 1% gold would be authored with 21% GOLD, and the "matched" control would be a
    // completely different portfolio in a second way.
    const [ctl] = matchedControlArms([MEASURED[0]]).arms;
    assert.ok(Math.abs(ctl.matchMix.EQUITY - 0.97) < 0.02, `equity ${ctl.matchMix.EQUITY}`);
    assert.ok(ctl.matchMix.GOLD < 0.05, `gold ${ctl.matchMix.GOLD} — the residual absorbed the rest`);
    assert.ok(Math.abs(Object.values(ctl.matchMix).reduce((a, b) => a + b, 0) - 1) < 1e-6);
  });

  test('PA-13: a mix holding none of the four classes throws rather than authoring nothing', () => {
    assert.throws(() => matchedControlArms([{ key: 'x', mix: { PROPERTY: 1 } }]),
      /nothing to match/);
  });

  test('PA-14: a matched control is pool-less AND pinned, through the scenario\'s own inverse', () => {
    const [ctl] = matchedControlArms([MEASURED[2]]).arms;
    const params = poolArmLevers(CFG, ctl).params;

    assert.equal(params.liquidityGraph, null, 'it is a CONTROL — no pools');
    assert.ok(params['allocWeight::EQUITY'] > 0.7, 'and it is pinned to the measured mix');
    assert.ok(params['allocWeight::BOND'] > 0);
    // …and the landing gate still treats it as a control, so a leaked graph would be caught.
    assert.doesNotThrow(() => assertPoolArmLanded({}, ctl));
  });

  test('PA-15: mixGap measures the residual a match leaves, in allocation points', () => {
    assert.equal(mixGap({ EQUITY: 0.6, BOND: 0.4 }, { EQUITY: 0.6, BOND: 0.4 }), 0);
    assert.equal(+mixGap({ EQUITY: 0.60, BOND: 0.40 }, { EQUITY: 0.58, BOND: 0.42 }).toFixed(6), 4);
  });
});

test('PA-16: an explicit `order` on a descriptor beats its named shape', () => {
  // Found by a preflight: a placement sweep whose points all carried the same `shape` compiled
  // to ONE graph, five times. An axis whose points coincide is not an axis, and it reads as
  // "the lever does not matter".
  const [arm] = poolArmGrid({ shapes: ['CASH_BOND'], bondYears: [4] });
  const moved = { ...arm, order: ['cash', 'wrappers', 'buffer', 'growth'] };
  const cfgW = { accounts: [...ACCOUNTS, { stateKey: 'ira', type: 'ira' }] };

  const before = poolArmLevers(cfgW, arm).params.liquidityGraph.pools.map(p => p.id);
  const after  = poolArmLevers(cfgW, moved).params.liquidityGraph.pools.map(p => p.id);
  assert.deepEqual(before, ['cash', 'buffer', 'growth']);
  assert.deepEqual(after,  ['cash', 'wrappers', 'buffer', 'growth']);
});

test('PA-8: wealth-matching is asserted, not assumed', () => {
  assert.doesNotThrow(() => assertArmsWealthMatched([
    { key: 'none', netWorth: 1_000_000 }, { key: 'cb', netWorth: 1_000_000.4 },
  ]));
  assert.throws(() => assertArmsWealthMatched([
    { key: 'none', netWorth: 1_000_000 }, { key: 'cb', netWorth: 1_300_000 },
  ]), /NOT wealth-matched/);
});

test('PA-9: end to end — levers survive buildVariant, the loader, and land in sim.state', () => {
  // The whole point of the landing gate is that this path has broken silently before:
  // `cfg.params` rows key on `name`, and a lever written the other way reads back fine in the
  // driver and is dropped on the way to the compiler.
  const simStart = new Date(Date.UTC(2026, 0, 1));
  const simEnd   = new Date(Date.UTC(2030, 0, 1));

  const build = (arm) => {
    ServiceRegistry.resetAll();
    const services = ServiceRegistry.getInstance();
    const base = IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE' }, simStart, simEnd);
    // Through the SAME merge `mc-run.mjs` uses. Re-implementing it here would test a
    // combination the runner never produces — and the runner's own merge is where the
    // hygiene was silently dropped before it was fixed (see PA-10).
    const spec = poolArmSpec(base, [arm]);
    const cfg  = buildVariant(base, mergeArmLevers(spec.base, spec.arms[arm.key]));
    const scenario = new BaseScenario({
      context: services.simulationContext, initialState: cfg.initialState ?? {},
      simStart, simEnd,
    });
    scenario.buildSim({ telemetry: 'off' });
    new ScenarioLoader().load(cfg, services);
    return scenario.sim;
  };

  // The synthetic base has no offset, so the shape under test is the one it can express.
  const [pooled]  = poolArmGrid({ shapes: ['CASH_BOND'], cashYears: [1], bondYears: [4] });
  const [control] = poolArmGrid({ shapes: ['POOL_LESS'] });

  const pooledSim  = build(pooled);
  const pooledNw   = computeNetWorth(pooledSim.state, 'USD');
  assert.doesNotThrow(() => assertPoolArmLanded(pooledSim.state, pooled));
  assert.ok(pooledSim.state.drawdownSequence.length > 0);

  const controlSim = build(control);
  const controlNw  = computeNetWorth(controlSim.state, 'USD');
  assert.doesNotThrow(() => assertPoolArmLanded(controlSim.state, control));

  assert.doesNotThrow(() => assertArmsWealthMatched([
    { key: control.key, netWorth: controlNw }, { key: pooled.key, netWorth: pooledNw },
  ]));
});
