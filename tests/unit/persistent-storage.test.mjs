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
 * persistent-storage.test.mjs — requestPersistentStorage (src/storage/create-storage.js).
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { requestPersistentStorage } from '../../src/storage/create-storage.js';

const manager = ({ persisted = false, grant = false, throws = false } = {}) => {
  const calls = { persist: 0 };
  return {
    calls,
    persisted: async () => persisted,
    persist:   async () => { calls.persist++; if (throws) throw new Error('blocked'); return grant; },
  };
};

test('already persisted: reports it without asking again', async () => {
  const m = manager({ persisted: true });
  assert.equal(await requestPersistentStorage(m), 'persisted');
  assert.equal(m.calls.persist, 0, 'Firefox would prompt the user on every boot');
});

test('asks once, and reports the browser\'s answer', async () => {
  assert.equal(await requestPersistentStorage(manager({ grant: true })),  'persisted');
  assert.equal(await requestPersistentStorage(manager({ grant: false })), 'best-effort');
});

test('no StorageManager (old browser, node) is unsupported, not an error', async () => {
  assert.equal(await requestPersistentStorage(undefined), 'unsupported');
  assert.equal(await requestPersistentStorage({}),        'unsupported');
});

test('a throwing persist() degrades to best-effort', async () => {
  const { warn } = console; console.warn = () => {};
  try { assert.equal(await requestPersistentStorage(manager({ throws: true })), 'best-effort'); }
  finally { console.warn = warn; }
});
