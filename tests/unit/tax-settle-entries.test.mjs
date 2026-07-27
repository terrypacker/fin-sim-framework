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
 * tax-settle-entries.test.mjs — design 71 §11.2.
 *
 * Collapsing the action×reducer fan-out to one entry per tax settlement. Every settle
 * runs through two reducers (the country's settle-apply and `Accumulate Taxes Paid`),
 * so the journal holds two entries per tax year carrying identical payloads. Both the
 * worksheet export and the timeline's "Tax Doc ↗" button must pick exactly one — and
 * specifically the FIRST, which is the one whose drill-down periods resolve against
 * the prior tax year rather than against its own twin.
 *
 * Run with: node --test tests/unit/tax-settle-entries.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  TAX_SETTLE_ACTION_TYPES,
  settleActionTypeFor,
  isTaxSettleEntry,
  primaryTaxSettleEntries,
} from '../../src/finance/tax/tax-settle-entries.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

/** A settle entry pair as the engine journals it: one action, two reducers. */
function settlePair(type, instanceId, reducers = ['Settle Apply', 'Accumulate Taxes Paid']) {
  return reducers.map((name, i) => ({
    id: `${instanceId}-${i}`,
    reducer: { name },
    action: { type, instanceId, data: { cc: 'US', taxDetail: { taxYear: 2030 } } },
  }));
}

test('TSE-1: every settle action type is covered', () => {
  assert.deepEqual([...TAX_SETTLE_ACTION_TYPES],
    ['US_TAX_SETTLE_APPLY', 'AU_TAX_SETTLE_APPLY', 'STATE_TAX_SETTLE_APPLY']);
  assert.equal(settleActionTypeFor('US'),    'US_TAX_SETTLE_APPLY');
  assert.equal(settleActionTypeFor('au'),    'AU_TAX_SETTLE_APPLY');
  assert.equal(settleActionTypeFor('STATE'), 'STATE_TAX_SETTLE_APPLY');
});

test('TSE-2: a settle with no payload carries no document', () => {
  assert.ok(!isTaxSettleEntry({ action: { type: 'US_TAX_SETTLE_APPLY', data: {} } }));
  assert.ok(!isTaxSettleEntry({ action: { type: 'MONTHLY_WAGES', data: { taxDetail: {} } } }));
  assert.ok(!isTaxSettleEntry(null));
  assert.ok(isTaxSettleEntry({ action: { type: 'US_TAX_SETTLE_APPLY', data: { taxDetail: {} } } }));
  // AU per-person filings carry personTaxDetails instead of a single taxDetail.
  assert.ok(isTaxSettleEntry({
    action: { type: 'AU_TAX_SETTLE_APPLY', data: { personTaxDetails: [{ personKey: 'p1' }] } },
  }));
});

test('TSE-3: the FIRST entry of a fan-out pair is the primary one', () => {
  const pair    = settlePair('US_TAX_SETTLE_APPLY', 'i1');
  const primary = primaryTaxSettleEntries(pair);

  assert.equal(primary.size, 1, 'one link per settlement, not per reducer');
  assert.ok(primary.has(pair[0]), 'the settle-apply entry is chosen');
  assert.ok(!primary.has(pair[1]), 'the Accumulate Taxes Paid twin is not');
});

test('TSE-4: distinct settlements and countries each keep one entry', () => {
  const journal = [
    ...settlePair('US_TAX_SETTLE_APPLY', 'us-2030'),
    ...settlePair('AU_TAX_SETTLE_APPLY', 'au-2030'),
    ...settlePair('US_TAX_SETTLE_APPLY', 'us-2031'),
    { id: 'x', action: { type: 'MONTHLY_WAGES', data: {} } },
  ];
  assert.equal(primaryTaxSettleEntries(journal).size, 3);

  const usOnly = primaryTaxSettleEntries(journal, { types: ['US_TAX_SETTLE_APPLY'] });
  assert.equal(usOnly.size, 2, 'the types filter scopes to one country');
});

test('TSE-5: entries without ids do not collapse into one another', () => {
  // Keying on entry.id would make every id-less entry share the `undefined` key.
  // Hand-built journals in tests look exactly like this.
  const journal = [
    { action: { type: 'US_TAX_SETTLE_APPLY', data: { taxDetail: {} } } },
    { action: { type: 'US_TAX_SETTLE_APPLY', data: { taxDetail: {} } } },
  ];
  assert.equal(primaryTaxSettleEntries(journal).size, 2,
    'no instanceId means no fan-out to collapse — both entries stand alone');
});

test('TSE-6: an empty or absent journal yields an empty set', () => {
  assert.equal(primaryTaxSettleEntries([]).size, 0);
  assert.equal(primaryTaxSettleEntries(undefined).size, 0);
});

test('TSE-7: against a real run, every settlement halves to exactly one entry', () => {
  ServiceRegistry.resetAll();
  const scenario = IntlRetirementScenario.buildAndCompile({});
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  try { scenario.sim.stepTo(new Date(Date.UTC(2031, 11, 31))); }
  finally { console.log = log; console.warn = warn; }

  const journal = scenario.sim.journal.journal;
  const settles = journal.filter(e => TAX_SETTLE_ACTION_TYPES.includes(e.action?.type));
  const primary = primaryTaxSettleEntries(journal);
  const actions = new Set(settles.map(e => e.action.instanceId));

  assert.ok(settles.length > 0);
  assert.equal(primary.size, actions.size, 'exactly one entry survives per settle action');
  assert.equal(settles.length, actions.size * 2, 'the engine really does journal each settle twice');

  // And each survivor is the earlier of its pair.
  for (const entry of primary) {
    const twins = settles.filter(e => e.action.instanceId === entry.action.instanceId);
    assert.equal(entry.seq, Math.min(...twins.map(t => t.seq)));
  }
});
