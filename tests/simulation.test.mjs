/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * simulation.test.mjs
 * Tests for Simulation Engine
 * Run with: node --test tests/simulation.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';
import { Assert } from './helpers/assert.js';

import { Account, AccountService } from '../assets/js/finance/account.js';
import { Asset } from '../assets/js/finance/asset.js';
import { Simulation } from '../assets/js/simulation-framework/simulation.js';
import { PRIORITY } from '../assets/js/simulation-framework/reducers.js';

test('Simulate annual event for 2 years', () => {
  const startYear = 2025;
  const sim = new Simulation(new Date(startYear, 0, 1));
  sim.scheduleAnnually({
    startDate: new Date(2025, 0, 1),
    type: 'ANNUAL_EVENT',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  sim.stepTo(new Date(startYear + 1, 0, 1));

  assert.ok(sim.bus.getHistory().length == 2, `Expected 2 events on bus, got ${sim.bus.getHistory().length}`);

  const event0 = sim.bus.getHistory()[0];
  assert.strictEqual(event0.sim, sim);
  Assert.datesEqual(event0.date, new Date(2025, 0, 1));
  assert.strictEqual(event0.type, 'ANNUAL_EVENT');
  assert.strictEqual(event0.payload.data.test, 'testing');
  assert.strictEqual(event0.payload.meta.metaFlag, true);

  const event1 = sim.bus.getHistory()[1];
  assert.strictEqual(event1.sim, sim);
  Assert.datesEqual(event1.date, new Date(2026, 0, 1));
  assert.strictEqual(event1.type, 'ANNUAL_EVENT');
  assert.strictEqual(event1.payload.data.test, 'testing');
  assert.strictEqual(event1.payload.meta.metaFlag, true);
});

test('Simulate annual event for 2 years wildcard subscriber', () => {
  const startYear = 2025;
  const sim = new Simulation(new Date(startYear, 0, 1));
  sim.scheduleAnnually({
    startDate: new Date(2025, 0, 1),
    type: 'ANNUAL_EVENT',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  const events = [];
  /* Listen to all messages */
  sim.bus.subscribe('*', (event) => {
    events.push(event);
  });

  sim.stepTo(new Date(startYear + 1, 0, 1));

  assert.ok(events.length === 2, `Expected 2 events in listener, got ${events.length}`);

  const event0 = events[0];
  assert.strictEqual(event0.sim, sim);
  Assert.datesEqual(event0.date, new Date(2025, 0, 1));
  assert.strictEqual(event0.type, 'ANNUAL_EVENT');
  assert.strictEqual(event0.payload.data.test, 'testing');
  assert.strictEqual(event0.payload.meta.metaFlag, true);

  const event1 = events[1];
  assert.strictEqual(event1.sim, sim);
  Assert.datesEqual(event1.date, new Date(2026, 0, 1));
  assert.strictEqual(event1.type, 'ANNUAL_EVENT');
  assert.strictEqual(event1.payload.data.test, 'testing');
  assert.strictEqual(event1.payload.meta.metaFlag, true);
});

test('Simulate annual event for 2 years specific subscriber', () => {
  const startYear = 2025;
  const sim = new Simulation(new Date(startYear, 0, 1));
  sim.scheduleAnnually({
    startDate: new Date(2025, 0, 1),
    type: 'ANNUAL_EVENT',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  sim.scheduleQuarterly({
    startDate: new Date(2025, 0, 1),
    type: 'QUARTERLY_EVENT',
    data: { test: 'data' },
    meta: { metaFlag: false }
  });

  const events = [];
  /* Listen to all messages */
  sim.bus.subscribe('ANNUAL_EVENT', (event) => {
    events.push(event);
  });

  sim.stepTo(new Date(startYear + 1, 0, 1));

  assert.ok(events.length === 2, `Expected 2 events in listener, got ${events.length}`);

  const event0 = events[0];
  assert.strictEqual(event0.sim, sim);
  Assert.datesEqual(event0.date, new Date(2025, 0, 1));
  assert.strictEqual(event0.type, 'ANNUAL_EVENT');
  assert.strictEqual(event0.payload.data.test, 'testing');
  assert.strictEqual(event0.payload.meta.metaFlag, true);

  const event1 = events[1];
  assert.strictEqual(event1.sim, sim);
  Assert.datesEqual(event1.date, new Date(2026, 0, 1));
  assert.strictEqual(event1.type, 'ANNUAL_EVENT');
  assert.strictEqual(event1.payload.data.test, 'testing');
  assert.strictEqual(event1.payload.meta.metaFlag, true);
});

test('Simulate annual event for two years with handler', () => {
  const startYear = 2025;
  const sim = new Simulation(new Date(startYear, 0, 1));
  sim.scheduleAnnually({
    startDate: new Date(2025, 0, 1),
    type: 'ANNUAL_EVENT',
    data: { test: 'testing' },
    meta: { metaFlag: true }
  });

  //Annual Handler just collects contexts
  const handlerEventContexts = [];
  sim.register('ANNUAL_EVENT', (ctx) => {
    handlerEventContexts.push(ctx);
    return [];
  });

  sim.stepTo(new Date(startYear + 1, 0, 1));

  assert.ok(sim.bus.getHistory().length === 2, `Expected 2 events, got ${sim.bus.getHistory().length}`);

  //Ensure the bus events internally are as expected
  const event0 = sim.bus.getHistory()[0];
  assert.strictEqual(event0.sim, sim);
  Assert.datesEqual(event0.date, new Date(2025, 0, 1));
  assert.strictEqual(event0.type, 'ANNUAL_EVENT');
  assert.strictEqual(event0.payload.data.test, 'testing');
  assert.strictEqual(event0.payload.meta.metaFlag, true);

  const event1 = sim.bus.getHistory()[1];
  assert.strictEqual(event1.sim, sim);
  Assert.datesEqual(event1.date, new Date(2026, 0, 1));
  assert.strictEqual(event1.type, 'ANNUAL_EVENT');
  assert.strictEqual(event1.payload.data.test, 'testing');
  assert.strictEqual(event1.payload.meta.metaFlag, true);

  //Ensure the contexts are correct
  const context0 = handlerEventContexts[0];
  //TODO assert me
  const context1 = handlerEventContexts[1];
  assert.strictEqual(context1.sim, sim);
  Assert.datesEqual(context1.date, new Date(2026, 0, 1));
  assert.strictEqual(event1.type, 'ANNUAL_EVENT');
  assert.strictEqual(event1.payload.data.test, 'testing');
  assert.strictEqual(event1.payload.meta.metaFlag, true);

});

