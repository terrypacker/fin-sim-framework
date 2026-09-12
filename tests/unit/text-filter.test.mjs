/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// text-filter.test.mjs — the filter shared by the State and Parameters panels.

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { normalizeFilter, matchesFilter, FilteredFoldState }
  from '../../src/visualization/components/text-filter.js';

test('normalizeFilter: trimmed and lower-cased; nothing typed is no filter', () => {
  assert.equal(normalizeFilter('  Terry '), 'terry');
  assert.equal(normalizeFilter(null), '');
  assert.equal(normalizeFilter('   '), '');
});

test('matchesFilter: every word must appear, in any of the parts, in any order', () => {
  const parts = ['usBrokerageTerry.balance', 'US Brokerage (Terry) · Balance'];
  assert.ok(matchesFilter('terry', ...parts), 'found by the display name');
  assert.ok(matchesFilter('balance terry', ...parts), 'words in any order');
  assert.ok(!matchesFilter('terry income', ...parts), 'every word must match');
  assert.ok(matchesFilter('', ...parts), 'no filter passes everything');
  assert.ok(matchesFilter('cpi', null, '', 'CPI-linked'), 'null and empty parts are skipped');
  assert.ok(!matchesFilter('ab', 'a', 'b'), 'parts are not glued into a false match');
});

test('FilteredFoldState: collapsed by default; a filter opens its matches; a fold under it holds', () => {
  const f = new FilteredFoldState();
  assert.equal(f.isExpanded('acct', ''), false, 'collapsed by default');
  assert.equal(f.isExpanded('acct', 'bal'), true, 'a filter opens matches');
  f.toggle('acct', 'bal');
  assert.equal(f.isExpanded('acct', 'bal'), false, 'the user folded it under this filter');
  assert.equal(f.isExpanded('acct', 'bala'), true, 'a new filter opens it again');
  assert.equal(f.isExpanded('acct', ''), false, 'folds under a filter never touch the unfiltered state');
  f.toggle('acct', '');
  assert.equal(f.isExpanded('acct', ''), true);
  assert.ok(f.expanded.has('acct'));
});
