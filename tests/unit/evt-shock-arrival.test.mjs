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
 * evt-shock-arrival.test.mjs — random shock arrival (design 126 §3, G1 WINDOW).
 *
 * ARR-1  FIXED, or no `arrival`, schedules exactly as before and stamps no state
 * ARR-2  WINDOW with probability 1 always arrives, on the first of a month inside the window
 * ARR-3  probability 0 never fires and leaves no event; the stamp says null
 * ARR-4  changing only the probability keeps the month on every seed that arrives in both
 * ARR-5  keys: reordering two presets keeps each one's date; two of one preset draw apart; `id` wins
 * ARR-6  a month on or after the run's end does not arrive
 * ARR-7  in a loaded sim the stamp is the scheduled date, and an authored `randomSeed` moves it
 * ARR-8  an explicit buildSim seed beats `randomSeed`; `rngStreams` and other params do not move it
 * ARR-9  bad specs throw naming the shock
 * ARR-10 no handler or reducer reads `shocks` from the params, or looks ahead for a shock event
 * ARR-11 the shared cursor is untouched: a run's other draws are identical with and without it
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ServiceRegistry }  from '../../src/services/service-registry.js';
import { ECONOMIC_REGIMES } from '../../src/scenarios/toolsets/economic-regimes-toolset.js';
import { drawWindowArrival, drawShockArrivals, shockArrivalKeys } from '../../src/finance/economic-shocks/shock-arrival.js';
import { loadScenarioSim } from '../helpers/scenario-harness.js';

beforeEach(() => ServiceRegistry.resetAll());

const quiet = (fn) => {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.log = l; console.warn = w; }
};

const START = new Date('2026-01-01T00:00:00Z');
const END   = new Date('2066-01-01T00:00:00Z');
const day   = (d) => d.toISOString().slice(0, 10);
const window_ = (over = {}) => ({ mode: 'WINDOW', fromYears: 2, toYears: 12, probability: 1, ...over });

/** Compile the toolset's schedule and state from a shock list, at a seed. */
function compile(shocks, seed = 7, endDate = END) {
  const context = { parameters: { shocks }, accounts: [], startDate: START, endDate, rngSeed: seed };
  const events = ECONOMIC_REGIMES.schedules(context).filter(e => e.type === 'ECONOMIC_SHOCK');
  return { events, arrivals: context._shockArrivals };
}

test('ARR-1: FIXED (or no arrival) schedules exactly as before and draws nothing', () => {
  const plain = compile([{ preset: 'DOTCOM_2000_LITE', startDate: '2030-01-01' }]);
  const fixed = compile([{ preset: 'DOTCOM_2000_LITE', startDate: '2030-01-01', arrival: { mode: 'FIXED' } }]);
  assert.deepEqual(fixed.events.map(e => day(e.date)), plain.events.map(e => day(e.date)));
  assert.deepEqual(plain.events.map(e => day(e.date)), ['2030-01-01']);
  assert.equal(plain.arrivals, null);
  assert.equal(fixed.arrivals, null, 'no random entry ⇒ no stamp, so state stays byte-identical');
});

test('ARR-2: WINDOW with probability 1 always arrives on the first of a month inside the window', () => {
  const lo = new Date('2028-01-01T00:00:00Z'), hi = new Date('2038-01-01T00:00:00Z');
  const seen = new Set();
  for (let seed = 1; seed <= 300; seed++) {
    const d = drawWindowArrival(window_(), { seed, key: 'k', startDate: START, endDate: END });
    assert.ok(d, `seed ${seed} arrived`);
    assert.equal(d.getUTCDate(), 1);
    assert.ok(d >= lo && d < hi, `seed ${seed}: ${day(d)} inside [2028, 2038)`);
    seen.add(day(d));
  }
  assert.ok(seen.size > 60, `months spread across the window (${seen.size} distinct)`);

  // A start that is not the first of a month: the first candidate is the NEXT month's first.
  const mid = new Date('2026-03-15T00:00:00Z');
  for (let seed = 1; seed <= 50; seed++) {
    const d = drawWindowArrival({ mode: 'WINDOW', fromYears: 0, toYears: 1 / 12 }, { seed, key: 'k', startDate: mid });
    assert.equal(day(d), '2026-04-01', 'a one-month window has one first-of-month in it');
  }
});

test('ARR-3: probability 0 never fires, leaves no event, and stamps null', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { events, arrivals } = compile([{ preset: 'DOTCOM_2000_LITE', arrival: window_({ probability: 0 }) }], seed);
    assert.equal(events.length, 0);
    assert.deepEqual(arrivals, { 'DOTCOM_2000_LITE#0': null });
  }
});

test('ARR-4: changing only the probability keeps the month wherever both arrive', () => {
  let both = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const a = drawWindowArrival(window_({ probability: 0.5 }), { seed, key: 'k', startDate: START });
    const b = drawWindowArrival(window_({ probability: 0.9 }), { seed, key: 'k', startDate: START });
    if (a) { assert.ok(b, 'a higher probability arrives wherever a lower one did'); assert.equal(day(a), day(b)); both++; }
  }
  assert.ok(both > 50);
});

test('ARR-5: keys survive reordering, separate same-preset entries, and honour an id', () => {
  const dot = { preset: 'DOTCOM_2000_LITE', arrival: window_() };
  const gfc = { preset: 'MARKET_CRASH_2008_LITE', arrival: window_() };
  const ab = drawShockArrivals([dot, gfc], { seed: 11, startDate: START, endDate: END });
  const ba = drawShockArrivals([gfc, dot], { seed: 11, startDate: START, endDate: END });
  assert.deepEqual(ab, ba, 'each shock keeps its own date when the list is reordered');

  assert.deepEqual(shockArrivalKeys([dot, dot, { ...dot, id: 'mine' }, gfc]),
    ['DOTCOM_2000_LITE#0', 'DOTCOM_2000_LITE#1', 'mine', 'MARKET_CRASH_2008_LITE#0']);
  let differ = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const two = drawShockArrivals([dot, dot], { seed, startDate: START, endDate: END });
    if (two['DOTCOM_2000_LITE#0'] !== two['DOTCOM_2000_LITE#1']) differ++;
  }
  assert.ok(differ >= 18, 'two entries of one preset draw independently');
});

test('ARR-6: a month on or after the run end does not arrive', () => {
  const end = new Date('2031-01-01T00:00:00Z');
  let none = 0, some = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const d = drawWindowArrival(window_({ fromYears: 0, toYears: 10 }), { seed, key: 'k', startDate: START, endDate: end });
    if (d) { assert.ok(d < end); some++; } else none++;
  }
  // Half the window lies past the end, so about half the paths see no shock.
  assert.ok(none > 60 && some > 60, `clipped share is lost (${none} none / ${some} arrived)`);
});

test('ARR-7: in a loaded sim the stamp is the scheduled date, and randomSeed moves it', () => {
  const shocks = [{ preset: 'DOTCOM_2000_LITE', arrival: window_({ fromYears: 0, toYears: 10 }) }];
  const at = (randomSeed) => quiet(() => {
    const { sim } = loadScenarioSim({ params: { randomSeed, shocks } });
    const scheduled = sim.queue.data.filter(e => e.type === 'ECONOMIC_SHOCK').map(e => day(e.date));
    return { stamp: sim.state.shockArrivals['DOTCOM_2000_LITE#0'], scheduled };
  });
  const dates = new Set();
  for (const seed of [1, 2, 3, 4]) {
    const { stamp, scheduled } = at(seed);
    assert.deepEqual(scheduled, stamp ? [stamp] : [], `seed ${seed}: the stamped date is the scheduled one`);
    dates.add(stamp);
    assert.deepEqual(at(seed).stamp, stamp, 'and it is reproducible');
  }
  assert.ok(dates.size >= 3, 'the authored randomSeed reaches the draw (compile runs before the loader reseeds)');
});

test('ARR-8: an explicit seed wins over randomSeed; rngStreams and other params leave the draw alone', async () => {
  const { BaseScenario }          = await import('../../src/scenarios/base-scenario.js');
  const { IntlRetirementScenario } = await import('../../src/scenarios/intl-retirement-scenario.js');
  const { ScenarioLoader }        = await import('../../src/scenarios/scenario-loader.js');
  const shocks = [{ preset: 'DOTCOM_2000_LITE', arrival: window_({ fromYears: 0, toYears: 30 }) }];
  const stampAt = (seed, params) => quiet(() => {
    ServiceRegistry.resetAll();
    const services = ServiceRegistry.getInstance();
    const cfg = IntlRetirementScenario.buildDefaultConfig({ fxProcessModel: 'NONE', shocks, ...params });
    const scenario = new BaseScenario({ context: services.simulationContext, initialState: cfg.initialState ?? {},
      simStart: new Date(cfg.simStart), simEnd: new Date(cfg.simEnd) });
    scenario.buildSim({ seed });
    new ScenarioLoader().load(cfg, services);
    return scenario.sim.state.shockArrivals['DOTCOM_2000_LITE#0'];
  });
  const base = stampAt(42, {});
  assert.equal(stampAt(42, { randomSeed: 9 }), base, 'Monte Carlo\'s explicit seed is never overridden');
  assert.equal(stampAt(42, { rngStreams: true }), base);
  assert.equal(stampAt(42, { inflationRate: 0.05 }), base, 'a sampled variable elsewhere does not shift it');
});

test('ARR-9: bad specs throw naming the shock', () => {
  const bad = (arrival) => () => compile([{ preset: 'DOTCOM_2000_LITE', arrival }]);
  assert.throws(bad({ mode: 'RATE', perYear: 0.1 }), /DOTCOM_2000_LITE.*RATE is not built yet/);
  assert.throws(bad({ mode: 'SOMETIME' }), /mode must be one of/);
  assert.throws(bad(window_({ fromYears: 5, toYears: 5 })), /at least one month/);
  assert.throws(bad(window_({ fromYears: -1 })), /fromYears/);
  assert.throws(bad(window_({ probability: 1.5 })), /probability/);
});

/** Every .js file under a directory. */
function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? jsFiles(p) : (p.endsWith('.js') ? [p] : []);
  });
}

test('ARR-10: no run-time code reads a shock\'s date before it is active', () => {
  // The compile-time readers are the regimes toolset (src/scenarios) and the two sweep-config
  // builders, which read severity. Everything that runs during a simulation lives under
  // src/finance and must react to `activeRegimes`, never to the authored list or the queue.
  const ALLOWED = new Set([
    'src/finance/monte-carlo/intl-retirement-mc-config.js',
    'src/finance/optimization/intl-retirement-opt-config.js',
    'src/finance/economic-shocks/shock-arrival.js',
  ]);
  const offenders = [];
  for (const file of jsFiles('src/finance')) {
    if (ALLOWED.has(file)) continue;
    const src = readFileSync(file, 'utf8').split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    if (/\b(parameters|params|p)\??\.shocks\b/.test(src)) offenders.push(`${file}: reads params.shocks`);
    if (/'ECONOMIC_SHOCK'/.test(src) && !file.endsWith('economic-shock-handler.js')) {
      offenders.push(`${file}: names the ECONOMIC_SHOCK event`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('ARR-11: the draw never touches the shared cursor', () => {
  // An arrival that lands after the run ends changes nothing else, so the whole end state —
  // every stochastic draw the plan makes — must match the plan with no shock at all.
  const run = (shocks) => quiet(() => {
    const { sim } = loadScenarioSim({ params: { randomSeed: 3, shocks, fxProcessModel: 'MEAN_REVERTING' },
      stepTo: '2031-01-01' });
    return { rng: sim.rngState, nw: sim.state.metrics?.netWorth };
  });
  const none   = run([]);
  const random = run([{ preset: 'DOTCOM_2000_LITE', arrival: window_({ fromYears: 20, toYears: 30 }) }]);
  assert.deepEqual(random, none);
});
