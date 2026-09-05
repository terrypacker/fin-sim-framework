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
 * StorageAdapter backends: the synchronous-read / asynchronous-write contract.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { StorageAdapter }    from '../../src/storage/storage-adapter.js';
import { InMemoryStorage }   from '../../src/storage/in-memory-storage.js';
import { IndexedDbStorage }  from '../../src/storage/indexed-db-storage.js';
import { ScenarioStorage }   from '../../src/scenarios/scenario-storage.js';
import { ALL_STORAGE_KEYS, STORAGE_KEYS } from '../../src/storage/storage-keys.js';

// ── A minimal in-process IndexedDB double ─────────────────────────────────────
//
// Enough of the IDBFactory surface for IndexedDbStorage: open with an upgrade,
// readonly getAll/getAllKeys, readwrite put/delete, and transactions that
// complete on a later microtask so the async seam is genuinely exercised.

function makeFakeIndexedDb(seed = new Map()) {
  const data = new Map(seed);
  let failNextWrite = false;

  function makeTransaction(mode) {
    const ops = [];
    const tx = {
      oncomplete: null, onerror: null, onabort: null, error: null,
      objectStore: () => (mode === 'readonly' ? readRequests(tx) : {
        put:    (v, k) => ops.push(() => data.set(k, v)),
        delete: k      => ops.push(() => data.delete(k)),
      }),
    };
    if (mode !== 'readonly') {
      queueMicrotask(() => {
        if (failNextWrite) {
          failNextWrite = false;
          tx.error = new Error('simulated write failure');
          tx.onerror?.();
          return;
        }
        ops.forEach(op => op());
        tx.oncomplete?.();
      });
    }
    return tx;
  }

  function readRequests() {
    const fire = result => {
      const req = { result, onsuccess: null, onerror: null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    };
    return {
      getAllKeys: () => fire([...data.keys()]),
      getAll:     () => fire([...data.values()]),
    };
  }

  const factory = {
    open: () => {
      const req = {
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => {},
          transaction: (_name, mode = 'readonly') => makeTransaction(mode),
        },
        onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };

  return { factory, data, failWrite: () => { failNextWrite = true; } };
}

/** An adapter over a fake IDB, already hydrated. */
async function makeIdb(seed, flushDelayMs = 0) {
  const fake    = makeFakeIndexedDb(seed);
  const storage = new IndexedDbStorage({ indexedDB: fake.factory, flushDelayMs });
  await storage.hydrate();
  return { storage, fake };
}

// ── The contract, applied to every synchronous backend ────────────────────────

for (const [name, make] of [['InMemoryStorage', () => new InMemoryStorage()]]) {
  test(`${name}: get/set/remove/keys round-trip`, () => {
    const s = make();
    assert.equal(s.getItem('a') ?? null, null);
    s.setItem('a', '1');
    s.setItem('b', '2');
    assert.equal(s.getItem('a'), '1');
    assert.deepEqual(s.keys().sort(), ['a', 'b']);
    s.removeItem('a');
    assert.equal(s.getItem('a') ?? null, null);
    assert.deepEqual(s.keys(), ['b']);
  });
}

test('StorageAdapter base class throws for unimplemented members', () => {
  const s = new StorageAdapter();
  assert.throws(() => s.getItem('a'), /not implemented/);
  assert.throws(() => s.setItem('a', '1'), /not implemented/);
  assert.throws(() => s.removeItem('a'), /not implemented/);
  assert.throws(() => s.keys(), /not implemented/);
});

// ── IndexedDbStorage: the synchronous mirror ──────────────────────────────────

test('IndexedDbStorage: hydrate fills the mirror from the database', async () => {
  const { storage } = await makeIdb(new Map([['k', 'v']]));
  assert.equal(storage.getItem('k'), 'v');
  assert.deepEqual(storage.keys(), ['k']);
});

test('IndexedDbStorage: reads are synchronous immediately after a write', async () => {
  const { storage } = await makeIdb();
  storage.setItem('k', 'v');
  // No await: the mirror, not the database, answers reads.
  assert.equal(storage.getItem('k'), 'v');
});

test('IndexedDbStorage: an un-hydrated adapter reads empty and never throws', () => {
  const { factory } = makeFakeIndexedDb(new Map([['k', 'v']]));
  const storage = new IndexedDbStorage({ indexedDB: factory });
  assert.equal(storage.getItem('k'), null);
  assert.deepEqual(storage.keys(), []);
});

test('IndexedDbStorage: hydrate is idempotent and concurrency-safe', async () => {
  const { factory } = makeFakeIndexedDb(new Map([['k', 'v']]));
  const storage = new IndexedDbStorage({ indexedDB: factory });
  await Promise.all([storage.hydrate(), storage.hydrate(), storage.hydrate()]);
  await storage.hydrate();
  assert.deepEqual(storage.keys(), ['k']);
});

test('IndexedDbStorage: hydrate rejects when there is no IndexedDB', async () => {
  const storage = new IndexedDbStorage({ indexedDB: null });
  await assert.rejects(() => storage.hydrate(), /not available/);
});

// ── IndexedDbStorage: write-behind ────────────────────────────────────────────

test('IndexedDbStorage: flush persists writes to the database', async () => {
  const { storage, fake } = await makeIdb();
  storage.setItem('k', 'v');
  await storage.flush();
  assert.equal(fake.data.get('k'), 'v');
});

test('IndexedDbStorage: flush persists a removal as a delete', async () => {
  const { storage, fake } = await makeIdb(new Map([['k', 'v']]));
  storage.removeItem('k');
  await storage.flush();
  assert.ok(!fake.data.has('k'), 'removed key must be deleted from the database');
});

test('IndexedDbStorage: a burst of writes coalesces into one committed value', async () => {
  const { storage, fake } = await makeIdb();
  for (let i = 0; i < 20; i++) storage.setItem('k', String(i));
  await storage.flush();
  assert.equal(fake.data.get('k'), '19', 'the last write wins');
});

test('IndexedDbStorage: the debounced flush commits without an explicit flush', async () => {
  const { storage, fake } = await makeIdb(new Map(), 1);
  storage.setItem('k', 'v');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(fake.data.get('k'), 'v');
});

test('IndexedDbStorage: flush with nothing dirty is a no-op', async () => {
  const { storage } = await makeIdb();
  await storage.flush();   // must not throw
});

test('IndexedDbStorage: a failed flush keeps the keys dirty and the mirror intact', async () => {
  const { storage, fake } = await makeIdb();
  storage.setItem('k', 'v');
  fake.failWrite();
  await storage.flush();

  // The write did not land, but the session's view of it is unchanged...
  assert.ok(!fake.data.has('k'), 'the simulated failure must not have written');
  assert.equal(storage.getItem('k'), 'v', 'mirror must survive a failed flush');

  // ...and the next flush retries it rather than dropping it.
  await storage.flush();
  assert.equal(fake.data.get('k'), 'v', 'a failed key must be retried, not lost');
});

test('IndexedDbStorage: a key dirtied during a flush is not lost', async () => {
  const { storage, fake } = await makeIdb();
  storage.setItem('a', '1');
  const inFlight = storage.flush();
  storage.setItem('b', '2');       // dirtied while the first batch is committing
  await inFlight;
  await storage.flush();
  assert.equal(fake.data.get('a'), '1');
  assert.equal(fake.data.get('b'), '2');
});

// ── Migration ─────────────────────────────────────────────────────────────────

test('adoptFrom copies keys the database has never seen', async () => {
  const { storage, fake } = await makeIdb();
  const legacy = new InMemoryStorage();
  legacy.setItem(STORAGE_KEYS.SCENARIOS, '{"scenarios":[]}');
  legacy.setItem(STORAGE_KEYS.DG_RESULTS, '{}');

  const adopted = storage.adoptFrom(legacy, ALL_STORAGE_KEYS);
  await storage.flush();

  assert.deepEqual(adopted.sort(), [STORAGE_KEYS.DG_RESULTS, STORAGE_KEYS.SCENARIOS].sort());
  assert.equal(fake.data.get(STORAGE_KEYS.SCENARIOS), '{"scenarios":[]}');
});

test('adoptFrom never overwrites a key the database already holds', async () => {
  const { storage } = await makeIdb(new Map([[STORAGE_KEYS.SCENARIOS, 'MINE']]));
  const legacy = new InMemoryStorage();
  legacy.setItem(STORAGE_KEYS.SCENARIOS, 'LEGACY');

  const adopted = storage.adoptFrom(legacy, ALL_STORAGE_KEYS);

  assert.deepEqual(adopted, [], 'nothing should be adopted');
  assert.equal(storage.getItem(STORAGE_KEYS.SCENARIOS), 'MINE');
});

test('adoptFrom is safe to re-run', async () => {
  const { storage } = await makeIdb();
  const legacy = new InMemoryStorage();
  legacy.setItem(STORAGE_KEYS.SCENARIOS, 'V1');

  assert.equal(storage.adoptFrom(legacy, ALL_STORAGE_KEYS).length, 1);
  legacy.setItem(STORAGE_KEYS.SCENARIOS, 'V2');
  assert.equal(storage.adoptFrom(legacy, ALL_STORAGE_KEYS).length, 0,
    're-running must not clobber the live value with the stale legacy one');
  assert.equal(storage.getItem(STORAGE_KEYS.SCENARIOS), 'V1');
});

// ── The stores work over any backend ──────────────────────────────────────────

test('ScenarioStorage round-trips over an injected IndexedDB backend', async () => {
  const { storage, fake } = await makeIdb();
  const store = new ScenarioStorage(storage);

  store.save({ scenarios: [{ id: 'u:0', name: 'Mine' }], lastUsed: 'u:0' });
  // Readable synchronously, before anything has reached the database.
  assert.equal(store.load().scenarios[0].name, 'Mine');
  assert.ok(!fake.data.has(STORAGE_KEYS.SCENARIOS), 'write-behind: not yet committed');

  await storage.flush();
  assert.equal(JSON.parse(fake.data.get(STORAGE_KEYS.SCENARIOS)).lastUsed, 'u:0');
});

test('ScenarioStorage survives a reload: a new store over a re-hydrated backend', async () => {
  const { storage, fake } = await makeIdb();
  new ScenarioStorage(storage).save({ scenarios: [{ id: 'u:0', name: 'Mine' }] });
  await storage.flush();

  // A fresh adapter over the same database — what a page reload looks like.
  const reloaded = new IndexedDbStorage({ indexedDB: makeFakeIndexedDb(fake.data).factory });
  await reloaded.hydrate();
  assert.equal(new ScenarioStorage(reloaded).load().scenarios[0].name, 'Mine');
});

test('ScenarioStorage returns an empty profile when the backend is empty', async () => {
  const { storage } = await makeIdb();
  assert.deepEqual(new ScenarioStorage(storage).load(), { scenarios: [] });
});

test('ScenarioStorage load survives a corrupt stored value', () => {
  const backing = new InMemoryStorage();
  backing.setItem(STORAGE_KEYS.SCENARIOS, '{not json');
  assert.deepEqual(new ScenarioStorage(backing).load(), { scenarios: [] });
});

test('every persisted store key is registered for migration', async () => {
  const { ScenarioStorage: SS }   = await import('../../src/scenarios/scenario-storage.js');
  const { DecisionGraphStorage }  = await import('../../src/finance/decision-graph/decision-graph-storage.js');
  const { DecisionGraphResultStorage } = await import('../../src/finance/decision-graph/decision-graph-result-storage.js');
  const { DecisionRecordStorage } = await import('../../src/finance/mpc/decision-record-storage.js');

  // A store whose key is missing here would silently fail to migrate.
  for (const cls of [SS, DecisionGraphStorage, DecisionGraphResultStorage, DecisionRecordStorage]) {
    assert.ok(ALL_STORAGE_KEYS.includes(cls.STORAGE_KEY),
      `${cls.name}.STORAGE_KEY ('${cls.STORAGE_KEY}') is not in ALL_STORAGE_KEYS`);
  }
  assert.equal(new Set(ALL_STORAGE_KEYS).size, ALL_STORAGE_KEYS.length, 'keys must be unique');
});
