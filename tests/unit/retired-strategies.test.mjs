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
 * retired-strategies.test.mjs — design 115 §12: STRATEGIC_ASSET_LOCATION is retired.
 *
 * Its "swap" moved money one way between tax-advantaged accounts. A saved plan that still
 * names it must load WITHOUT it and SAY so (an unhandled key would otherwise compile to
 * nothing, silently), and a serialized graph that still carries its reducers must restore.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { retireBehavioralStrategies, RETIRED_REDUCER_TYPES }
  from '../../src/scenarios/retired-strategies.js';
import { BEHAVIORAL_STRATEGY_REGISTRY } from '../../src/finance/behavioral/behavioral-strategy-registry.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { loadScenarioSim }    from '../helpers/scenario-harness.js';

test('RS-1: the strategy is gone from the registry and its reducer classes are named as retired', () => {
  assert.equal('STRATEGIC_ASSET_LOCATION' in BEHAVIORAL_STRATEGY_REGISTRY, false);
  assert.ok(RETIRED_REDUCER_TYPES.has('StrategicAssetLocationReducer'));
  assert.ok(RETIRED_REDUCER_TYPES.has('AssetLocationRebalanceApplyReducer'));
});

test('RS-2: stripped from BOTH param stores, its param dropped, and one warning when it was enabled', () => {
  const cfg = {
    parameters: { behavioralStrategies: ['TARGET_ALLOCATION', 'STRATEGIC_ASSET_LOCATION'],
                  assetLocationPolicy: { BOND: ['ira'] }, other: 1 },
    params: [{ name: 'behavioralStrategies', value: ['STRATEGIC_ASSET_LOCATION', 'TARGET_ALLOCATION'] },
             { name: 'assetLocationPolicy', value: { BOND: ['ira'] } },
             { name: 'other', value: 1 }],
  };
  const warned = [];
  retireBehavioralStrategies(cfg, { warn: m => warned.push(m) });
  assert.deepEqual(cfg.parameters.behavioralStrategies, ['TARGET_ALLOCATION']);
  assert.deepEqual(cfg.params.find(p => p.name === 'behavioralStrategies').value, ['TARGET_ALLOCATION']);
  assert.equal('assetLocationPolicy' in cfg.parameters, false);
  assert.equal(cfg.params.some(p => p.name === 'assetLocationPolicy'), false);
  assert.equal(cfg.parameters.other, 1, 'nothing else touched');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /STRATEGIC_ASSET_LOCATION.*retired.*TARGET_ALLOCATION/s);
});

test('RS-3: a leftover param with the strategy OFF is dropped silently (it was already inert)', () => {
  const cfg = { parameters: { behavioralStrategies: ['PANIC_SELL'], assetLocationPolicy: { BOND: ['ira'] } } };
  const warned = [];
  retireBehavioralStrategies(cfg, { warn: m => warned.push(m) });
  assert.deepEqual(cfg.parameters.behavioralStrategies, ['PANIC_SELL']);
  assert.equal('assetLocationPolicy' in cfg.parameters, false);
  assert.equal(warned.length, 0);
});

test('RS-4: a real load of a plan that names it runs exactly like one that does not, and warns', () => {
  // The defect this retires: with the strategy on, the primary's Roth went $85.6k → $1.0m
  // inside the first year. Loaded now, the plan must match the strategy-free run exactly.
  const warned = [];
  const orig = console.warn; console.warn = (m) => warned.push(String(m));
  try {
    const balances = (strategies) => {
      const { sim } = loadScenarioSim({ params: { behavioralStrategies: strategies },
        stepTo: '2027-02-01', telemetry: 'off' });
      return Object.fromEntries(Object.entries(sim.state)
        .filter(([, v]) => v?.role && Array.isArray(v.holdings))
        .map(([k, v]) => [k, v.holdings.reduce((s, h) => s + h.marketValue, 0)]));
    };
    const named = balances(['STRATEGIC_ASSET_LOCATION']);
    assert.ok(warned.some(w => /STRATEGIC_ASSET_LOCATION.*retired/.test(w)), 'the author is told');
    assert.deepEqual(named, balances([]));
  } finally { console.warn = orig; }
});

test('RS-5: a serialized graph still carrying the retired reducers restores instead of throwing', () => {
  ServiceRegistry.resetAll();
  const services = ServiceRegistry.getInstance();
  const orig = console.warn; console.warn = () => {};
  try {
    assert.doesNotThrow(() => ScenarioSerializer.deserializeGraph({ reducers: [
      { __type: 'StrategicAssetLocationReducer', id: 'r-sal' },
      { __type: 'AssetLocationRebalanceApplyReducer', id: 'r-alra' },
    ] }, services));
  } finally { console.warn = orig; }
  const types = (services.reducerService.getAll?.() ?? []).map(r => r.constructor?.name);
  assert.equal(types.some(t => RETIRED_REDUCER_TYPES.has(t)), false);
});
