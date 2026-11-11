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
 * retired-roth-conversion-date.test.mjs — the Roth conversion's month/day inputs are dropped on
 * load (Roth study F6): from both param stores, with a warning only when a converting plan
 * had a date other than 31 Dec.
 */
import { test } from 'node:test';
import assert   from 'node:assert/strict';
import { retireRothConversionDate } from '../../src/scenarios/retired-roth-conversion-date.js';
import { ScenarioLoader }  from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry } from '../../src/services/service-registry.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { applyParamBagToConfig } from '../../src/scenarios/scenario-param-apply.js';

const cfgWith = (enabled, month, day) => ({
  parameters: { rothConversionEnabled: enabled, rothConversionMonth: month, rothConversionDay: day, other: 1 },
  params: [
    { name: 'rothConversionEnabled', value: enabled },
    { name: 'rothConversionMonth', value: month },
    { name: 'rothConversionDay', value: day },
    { name: 'other', value: 1 },
  ],
});

test('RCD-1: both stores lose the inputs; everything else is kept', () => {
  const cfg = cfgWith(true, 12, 1);
  retireRothConversionDate(cfg, { warn: () => {} });
  assert.deepEqual(Object.keys(cfg.parameters).sort(), ['other', 'rothConversionEnabled']);
  assert.deepEqual(cfg.params.map(p => p.name), ['rothConversionEnabled', 'other']);
});

test('RCD-2: a converting plan on another date is told its conversions moved', () => {
  const notes = retireRothConversionDate(cfgWith(true, 12, 1), { warn: () => {} });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /31 Dec/);
  assert.match(notes[0], /1 Dec/);
});

test('RCD-3: silent when nothing changes — not converting, or already 31 Dec', () => {
  assert.deepEqual(retireRothConversionDate(cfgWith(false, 6, 15), { warn: () => {} }), []);
  assert.deepEqual(retireRothConversionDate(cfgWith(true, 12, 31), { warn: () => {} }), []);
  assert.deepEqual(retireRothConversionDate({ parameters: {}, params: [] }, { warn: () => {} }), []);
});

test('RCD-4: safe to call twice', () => {
  const cfg = cfgWith(true, 12, 1);
  retireRothConversionDate(cfg, { warn: () => {} });
  assert.deepEqual(retireRothConversionDate(cfg, { warn: () => {} }), []);
});

test('RCD-5: the loader drops a saved 1 Dec, warns, and the plan converts on 31 Dec', () => {
  const start = new Date(Date.UTC(2026, 0, 1)), end = new Date(Date.UTC(2030, 0, 1));
  const params = { rothConversionEnabled: true, rothConversionStartYear: 2027, rothConversionEndYear: 2028,
    rothConversionOwner: 'both', rothConversionMonth: 12, rothConversionDay: 1 };
  const warn = console.warn, log = console.log; const seen = [];
  console.warn = (m) => seen.push(String(m)); console.log = () => {};
  let sim, cfg;
  try {
    const registry = new ServiceRegistry();
    const scenario = new IntlRetirementScenario({ context: registry.simulationContext, params, simStart: start, simEnd: end });
    scenario.buildSim({ telemetry: 'off' });
    cfg = ScenarioSerializer.serializeScenario(IntlRetirementScenario.buildDefaultConfig({}, start, end));
    cfg.params = [{ name: 'rothConversionMonth', value: 12 }, { name: 'rothConversionDay', value: 1 }];
    applyParamBagToConfig(cfg, params);
    new ScenarioLoader().load(cfg, registry);
    sim = scenario.sim;
  } finally { console.warn = warn; console.log = log; }
  assert.ok(!('rothConversionDay' in (cfg.parameters ?? {})) && !cfg.params.some(p => p?.name === 'rothConversionDay'));
  assert.ok(seen.some(m => /Roth conversions now always run on 31 Dec/.test(m)), seen.join('\n'));
  const dates = sim.cloneQueue().filter(e => e.type === 'ROTH_CONVERSION_POLICY_EVALUATE')
    .map(e => new Date(e.date).toISOString().slice(5, 10));
  assert.ok(dates.length > 0 && dates.every(d => d === '12-31'), dates.join(','));
});
