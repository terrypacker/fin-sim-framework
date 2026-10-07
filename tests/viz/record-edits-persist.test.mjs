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
 * record-edits-persist.test.mjs
 *
 * A config-node Save (Person, Account, …) persists the RECORD slice of the scenario and
 * nothing else, so a reload keeps it without Save to Browser — while in-flight
 * Scenario-panel params stay out of storage and the recovery overlay's "discard the
 * unsaved changes" exit still reaches a stored copy that loads.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { jest }             from '@jest/globals';
import { ScenarioRegistry } from '../../src/scenarios/scenario-registry.js';
import { ScenarioStorage }  from '../../src/scenarios/scenario-storage.js';
import { Graph }            from '../../src/graph/graph.js';
import { mergeRecordEdits, isRecordParamKey } from '../../src/scenarios/record-edits.js';
import { showScenarioLoadError, storedCopyProblems }
  from '../../src/visualization/scenario/scenario-load-error-overlay.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ACCOUNTS = [{ stateKey: 'auOffsetAccount', name: 'Offset', type: 'offset',
                    offsetsPropertyKey: 'auHouse', balance: 1000 }];

const graphParam = (percent) => ({ name: 'liquidityGraph', type: 'LiquidityGraph', value: {
  pools: [{ id: 'offset', spendOrder: 2, target: { mode: 'PERCENT', value: percent },
            capacity: { mode: 'OFFSET_CAP' }, claims: [{ key: 'auOffsetAccount' }] }],
} });

/** A clean user scenario as it sits in storage. */
function storedScenario() {
  return {
    id: 'u:0', name: 'Saved', prebuilt: false, simStart: '2026-01-01', simEnd: '2041-01-01',
    accounts: ACCOUNTS,
    params: [
      graphParam(0.05),
      { name: 'acct.auOffsetAccount.balance', type: 'Number', value: 1000 },
      { name: 'pool.offset.targetScale',      type: 'Number', value: 1 },
    ],
  };
}

const stored = () => JSON.parse(localStorage.getItem(ScenarioStorage.STORAGE_KEY));

function makeRegistry() {
  localStorage.setItem(ScenarioStorage.STORAGE_KEY,
    JSON.stringify({ lastUsed: 'u:0', scenarios: [storedScenario()] }));
  const registry = new ScenarioRegistry(new ScenarioStorage(), new Graph());
  registry.loadPrebuilt([]);
  return registry;
}

const param = (record, name) => record.params.find(p => p.name === name)?.value;
const accept = (next) => storedCopyProblems(next).length === 0;

beforeEach(() => { localStorage.clear(); document.body.innerHTML = ''; });

// ═════════════════════════════════════════════════════════════════════════════
// mergeRecordEdits
// ═════════════════════════════════════════════════════════════════════════════

test('record params are the record namespaces — not the liquidity-graph ones', () => {
  for (const k of ['acct.x.balance', 'person.p.wage', 'prop.h.value', 'job.j1.monthlyWage',
                   'bequest.b.year', 'raAsset.r.mode', 'equity.e.value', 'coll.c.value']) {
    assert.ok(isRecordParamKey(k), k);
  }
  for (const k of ['pool.offset.targetScale', 'gate.g.threshold', 'shape.s.yearShift', 'inflation']) {
    assert.ok(!isRecordParamKey(k), k);
  }
});

test('merge: records and record params from live; every other param as stored', () => {
  const s = storedScenario();
  const live = storedScenario();
  live.name = 'Renamed in flight';
  live.accounts = [{ ...ACCOUNTS[0], balance: 2500 }];
  live.persons = [{ id: 'p1', name: 'Pat' }];
  live.params[0] = graphParam(100);                                 // in-flight, broken
  live.params[1].value = 2500;
  live.params[2].value = 3;                                         // pool. — not a record
  live.params.push({ name: 'person.p1.wage', type: 'Number', value: 9 });

  const next = mergeRecordEdits(s, live);

  assert.strictEqual(next.accounts[0].balance, 2500);
  assert.strictEqual(next.persons[0].name, 'Pat');
  assert.strictEqual(param(next, 'acct.auOffsetAccount.balance'), 2500);
  assert.strictEqual(param(next, 'person.p1.wage'), 9, 'a new record param is added');
  assert.strictEqual(param(next, 'liquidityGraph').pools[0].target.value, 0.05, 'in-flight param stays stored');
  assert.strictEqual(param(next, 'pool.offset.targetScale'), 1, 'pool axis stays stored');
  assert.strictEqual(next.name, 'Saved', 'non-record fields stay stored');
  assert.deepStrictEqual(s, storedScenario(), 'the stored input is not mutated');
  next.accounts[0].balance = 0;
  assert.strictEqual(live.accounts[0].balance, 2500, 'the result does not alias live');
});

test('merge: a field or record param the live record dropped is dropped from storage', () => {
  const s = { ...storedScenario(), jobs: [{ id: 'j1', personId: 'p1' }],
              parameters: { 'job.j1.monthlyWage': 5, inflation: 0.03 } };
  s.params.push({ name: 'job.j1.monthlyWage', value: 5 });
  const live = storedScenario();                                    // no jobs, no job params

  const next = mergeRecordEdits(s, live);

  assert.strictEqual(next.jobs, undefined);
  assert.strictEqual(param(next, 'job.j1.monthlyWage'), undefined);
  assert.deepStrictEqual(next.parameters, { inflation: 0.03 }, 'bag keeps its non-record keys');
});

// ═════════════════════════════════════════════════════════════════════════════
// ScenarioRegistry.persistRecordEdits
// ═════════════════════════════════════════════════════════════════════════════

test('persists the record slice of the live node and keeps lastUsed', () => {
  const r = makeRegistry();
  const live = r.get('u:0');
  live.accounts = [{ ...ACCOUNTS[0], balance: 2500 }];
  live.params.find(p => p.name === 'acct.auOffsetAccount.balance').value = 2500;

  assert.strictEqual(r.persistRecordEdits(live, accept), true);
  assert.strictEqual(r.getStored('u:0').accounts[0].balance, 2500);
  assert.strictEqual(param(r.getStored('u:0'), 'acct.auOffsetAccount.balance'), 2500);
  assert.strictEqual(stored().lastUsed, 'u:0');

  // What a reload would load.
  const reloaded = new ScenarioRegistry(new ScenarioStorage(), new Graph());
  reloaded.loadPrebuilt([]);
  assert.strictEqual(reloaded.get('u:0').accounts[0].balance, 2500);
});

test('a prebuilt, or a scenario storage has never seen, is not written', () => {
  const r = makeRegistry();
  const before = localStorage.getItem(ScenarioStorage.STORAGE_KEY);
  assert.strictEqual(r.persistRecordEdits({ id: 'p:alpha', prebuilt: true, accounts: [] }), false);
  assert.strictEqual(r.persistRecordEdits({ id: 'u:9', prebuilt: false, accounts: [] }), false);
  assert.strictEqual(localStorage.getItem(ScenarioStorage.STORAGE_KEY), before);
});

test('a patched copy the load check refuses is not written', () => {
  const r = makeRegistry();
  const before = localStorage.getItem(ScenarioStorage.STORAGE_KEY);
  const live = r.get('u:0');
  live.accounts = [];
  const veto = jest.fn(() => false);                // the caller's load check says no

  assert.strictEqual(r.persistRecordEdits(live, veto), false);
  assert.strictEqual(veto.mock.calls[0][0].accounts.length, 0, 'the veto sees the patched copy');
  assert.strictEqual(localStorage.getItem(ScenarioStorage.STORAGE_KEY), before);
});

// ═════════════════════════════════════════════════════════════════════════════
// The recovery overlay still has its exit
// ═════════════════════════════════════════════════════════════════════════════

test('after a node Save, a broken in-flight param still offers "discard and reload"', () => {
  const r = makeRegistry();
  const live = r.get('u:0');
  // An in-flight Scenario-panel edit that will not compile (a PERCENT authored as 100) …
  live.params[0] = graphParam(100);
  // … then an Account node is edited and Saved.
  live.accounts = [{ ...ACCOUNTS[0], balance: 2500 }];
  assert.strictEqual(r.persistRecordEdits(live, accept), true);

  // The Rebuild fails and the overlay opens on the live record.
  showScenarioLoadError({ error: new Error('pool target'), config: live,
                          scenarioRegistry: r, onReload: jest.fn() });

  const discard = [...document.querySelectorAll('.scenario-load-error button')]
    .find(b => b.textContent.includes('Discard changes'));
  assert.ok(discard, 'the stored copy is still a way out');
  assert.strictEqual(param(r.getStored('u:0'), 'liquidityGraph').pools[0].target.value, 0.05);
  assert.strictEqual(r.getStored('u:0').accounts[0].balance, 2500, 'and it keeps the node Save');
});
