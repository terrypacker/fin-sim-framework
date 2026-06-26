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
 * Reducer coverage gate (design 37 §8.5).
 *
 * Enumerates every reducer class declared under `src/` and asserts it is in 1:1
 * correspondence with the coverage manifest (tests/helpers/reducer-coverage-manifest.js,
 * the machine-checkable mirror of the §6 table). Adding / renaming / removing a
 * reducer fails this test until the manifest is updated — so reducer coverage
 * can never silently regress.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ABSTRACT, COVERED, INDIRECT, ALL_MANIFEST_REDUCERS } from '../helpers/reducer-coverage-manifest.js';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** Matches `class XxxReducer extends Yyy`, capturing names that end in "Reducer". */
const REDUCER_DECL = /\bclass\s+(\w*Reducer)\s+extends\s+\w+/g;

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkJs(p, out);
    else if (entry.endsWith('.js')) out.push(p);
  }
  return out;
}

/** All reducer class names declared under src/ (deduped, sorted). */
function discoverReducerClasses() {
  const names = new Set();
  for (const file of walkJs(SRC_DIR)) {
    const txt = readFileSync(file, 'utf8');
    let m;
    while ((m = REDUCER_DECL.exec(txt))) names.add(m[1]);
  }
  return [...names].sort();
}

const srcReducers = discoverReducerClasses();
const manifestSet = new Set(ALL_MANIFEST_REDUCERS);
const srcSet = new Set(srcReducers);

test('coverage gate: every src reducer is accounted for in the manifest', () => {
  const untracked = srcReducers.filter(n => !manifestSet.has(n));
  assert.deepEqual(
    untracked, [],
    `New reducer(s) not in the coverage manifest:\n  ${untracked.join('\n  ')}\n\n` +
    `Add each to tests/helpers/reducer-coverage-manifest.js (COVERED with a new ` +
    `postcondition test, or INDIRECT if deferred) and a row to design 37 §6.`,
  );
});

test('coverage gate: no stale manifest entries (every manifest reducer exists in src)', () => {
  const stale = ALL_MANIFEST_REDUCERS.filter(n => !srcSet.has(n));
  assert.deepEqual(
    stale, [],
    `Manifest lists reducer(s) that no longer exist under src/:\n  ${stale.join('\n  ')}\n\n` +
    `Remove them from tests/helpers/reducer-coverage-manifest.js (renamed? update both sides).`,
  );
});

test('coverage gate: manifest buckets are disjoint', () => {
  const seen = new Set();
  const dupes = [];
  for (const n of ALL_MANIFEST_REDUCERS) {
    if (seen.has(n)) dupes.push(n);
    seen.add(n);
  }
  assert.deepEqual(dupes, [], `Reducer(s) listed in more than one manifest bucket:\n  ${dupes.join('\n  ')}`);
  // Sanity: the manifest is non-trivial and the buckets actually partition it.
  assert.equal(ABSTRACT.length + COVERED.length + INDIRECT.length, ALL_MANIFEST_REDUCERS.length);
  assert.ok(srcReducers.length >= 100, `expected to discover the full reducer set, found ${srcReducers.length}`);
});
