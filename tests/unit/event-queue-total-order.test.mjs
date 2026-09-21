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
 * event-queue-total-order.test.mjs
 *
 * DESIGN 39 §14.10 — the event queue is a TOTAL order: `(date, order, instanceId)`.
 *
 * Before, two events on the same `(date, order)` ran in whatever order the heap's layout
 * produced, so adding or removing any event re-resolved ties elsewhere. Measured on a real plan:
 * deleting thirty conversion events that converted nothing moved terminal wealth by several
 * percent. `instanceId` (unique, increasing, assigned in `schedule()`) breaks the tie FIFO.
 *
 * EQO-1  same (date, order): first scheduled runs first, however the heap is laid out
 * EQO-2  removing an event changes nobody else's relative order
 * EQO-3  `restoreData` heapifies: a non-heap array still pops in order
 * EQO-4  a period advance opens its instant: it precedes every order-0 event on its date
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Simulation } from '../../src/simulation-framework/simulation.js';
import { PERIOD_ADVANCE_ORDER } from '../../src/finance/tax-service.js';

const DAY = new Date(Date.UTC(2030, 5, 30));

function simWith(types) {
  const sim = new Simulation(new Date(Date.UTC(2030, 0, 1)));
  for (const type of types) sim.schedule({ type, date: DAY });
  return sim;
}

const drain = (sim) => { const out = []; while (sim.queue.size()) out.push(sim.queue.pop().type); return out; };
const TYPES = Array.from({ length: 23 }, (_, i) => `E${String(i).padStart(2, '0')}`);

test('EQO-1: same (date, order) pops in scheduling order, whatever the heap layout', () => {
  assert.deepEqual(drain(simWith(TYPES)), TYPES);
  // Scheduled in a scrambled order: the pops follow the SCHEDULE, not the names.
  const scrambled = [...TYPES].sort((a, b) => (a.charCodeAt(2) * 7 % 11) - (b.charCodeAt(2) * 7 % 11));
  assert.deepEqual(drain(simWith(scrambled)), scrambled);
});

test('EQO-2: removing an event changes nobody else\'s relative order', () => {
  const sim = simWith(TYPES);
  for (const t of ['E03', 'E11', 'E17']) {
    const key = sim.queue.data.find(e => e.type === t).instanceId;
    sim.queue.removeByKey(key);
  }
  assert.deepEqual(drain(sim), TYPES.filter(t => !['E03', 'E11', 'E17'].includes(t)));
});

test('EQO-3: restoreData heapifies an array that is not a heap', () => {
  const sim = simWith(TYPES);
  const reversed = [...sim.queue.data].sort((a, b) => b.instanceId - a.instanceId);
  sim.queue.restoreData(reversed);
  assert.deepEqual(drain(sim), TYPES);
});

test('EQO-4: a period advance opens its instant, ahead of order-0 events scheduled before it', () => {
  // The move-date case: `CHANGE_RESIDENCY` is scheduled at compile (a LOW instanceId) and the
  // advance is re-scheduled mid-run (a HIGH one), so FIFO alone would run the residency change
  // first. The explicit band is what makes the year open first.
  assert.ok(PERIOD_ADVANCE_ORDER < 0);
  const sim = new Simulation(new Date(Date.UTC(2030, 0, 1)));
  sim.schedule({ type: 'CHANGE_RESIDENCY', date: DAY });
  sim.schedule({ type: 'PAYCHECK_AU', date: DAY, order: 1 });
  sim.schedule({ type: 'PERIOD_ADVANCE_AU', date: DAY, order: PERIOD_ADVANCE_ORDER });
  assert.deepEqual(drain(sim), ['PERIOD_ADVANCE_AU', 'CHANGE_RESIDENCY', 'PAYCHECK_AU']);
});
