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
 * mpc-run-editors.test.mjs
 *
 * DESIGN 81 phase 5 — the picker and the run editor. The tests worth having are not "a row
 * renders"; they are the properties §8 and §15 ask for and that a JSON textarea could not give:
 *
 *   - a dangling selection stays VISIBLE ("not found") instead of silently re-pointing at the
 *     first run in the bag, which would be a different plan the user never chose;
 *   - an emptied bag normalises to `null`, the shape every consumer reads as "no runs";
 *   - the decision table stays sorted by date, because that is the order the run PLAYS.
 *
 * Run with: npm run test:viz
 */

import assert from 'node:assert/strict';
import { buildMpcRunSelect, buildMpcRunsEditor }
  from '../../src/visualization/scenario/structured-param-editors.js';

function mount(editor) {
  document.body.innerHTML = '<div id="host"></div>';
  document.getElementById('host').appendChild(editor);
  return document.getElementById('host');
}
const cell   = (host, id) => host.querySelector(`[data-id="${id}"]`);
const cells  = (host, id) => [...host.querySelectorAll(`[data-id="${id}"]`)];
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text));
const type   = (input, value, ev = 'change') => { input.value = value; input.dispatchEvent(new Event(ev)); };

const BAG = () => ({
  'run:2026-09-18': {
    source: { recordedAt: '2026-09-18T00:00:00.000Z', levers: ['SPENDING', 'ALLOCATION_MIX'],
              epochs: 44, solver: 'CEM/128', first: '2026-01-01', last: '2069-01-01' },
    decisions: [
      { date: '2033-01-01', lever: 'SPENDING', key: 'band@60', value: 9000 },
      { date: '2030-01-01', lever: 'SPENDING', key: 'band@55', value: 4000 },
    ],
  },
  'run:2026-09-19': { source: { recordedAt: '2026-09-19T00:00:00.000Z', levers: ['SPENDING'], epochs: 3 },
                      decisions: [] },
});

// ═════════════════════════════════════════════════════════════════════════════
// mpcActiveRun — the picker (5a)
// ═════════════════════════════════════════════════════════════════════════════

test('MpcRunSelect: options are LABELLED from source — a raw run id is not a choice', () => {
  const param = { name: 'mpcActiveRun', value: null };
  const host  = mount(buildMpcRunSelect(param, BAG));
  const texts = [...cell(host, 'mpcActiveRun').options].map(o => o.textContent);
  assert.strictEqual(texts[0], '— none —');
  assert.match(texts[1], /2 levers · CEM\/128 · 2026-09-18 · 44 epochs/);
});

test('MpcRunSelect: a DANGLING selection stays visible and says the base plan runs (§15)', () => {
  // The sharp edge. A select that silently re-pointed at the first run in the bag would
  // re-save as that — a different plan the user never chose.
  const param = { name: 'mpcActiveRun', value: 'run:deleted' };
  const host  = mount(buildMpcRunSelect(param, BAG));
  const sel = cell(host, 'mpcActiveRun');
  assert.strictEqual(sel.value, 'run:deleted');
  assert.match([...sel.options].map(o => o.textContent).join('|'), /run:deleted \(not found\)/);
  assert.match(cell(host, 'mpcActiveRunNote').textContent, /BASE plan runs/);
  assert.strictEqual(param.value, 'run:deleted', 'rendering must not rewrite the selection');
});

test('MpcRunSelect: choosing "— none —" writes null, not the empty string', () => {
  // The declared default is null, so a scenario that round-trips through the editor must come
  // back byte-identical to one that was never opened.
  const param = { name: 'mpcActiveRun', value: 'run:2026-09-18' };
  const host  = mount(buildMpcRunSelect(param, BAG));
  type(cell(host, 'mpcActiveRun'), '');
  assert.strictEqual(param.value, null);
});

test('MpcRunSelect: an empty bag says where a run comes from', () => {
  const host = mount(buildMpcRunSelect({ name: 'mpcActiveRun', value: null }, () => null));
  assert.match(cell(host, 'mpcActiveRunNote').textContent, /Save run to plan/);
});

test('MpcRunSelect: a live selection states the lag a decision takes to bite (D6)', () => {
  const param = { name: 'mpcActiveRun', value: 'run:2026-09-18' };
  const host  = mount(buildMpcRunSelect(param, BAG));
  assert.match(cell(host, 'mpcActiveRunNote').textContent, /2 recorded decision\(s\)/);
  assert.match(cell(host, 'mpcActiveRunNote').textContent, /first period advance on or after/);
});

// ═════════════════════════════════════════════════════════════════════════════
// mpcRuns — the run picker (5b)
// ═════════════════════════════════════════════════════════════════════════════

test('MpcRuns: each block shows its provenance line and its decision table', () => {
  const param = { name: 'mpcRuns', value: BAG() };
  const host  = mount(buildMpcRunsEditor(param));
  assert.strictEqual(cells(host, 'mpc-run-0').length, 1);
  assert.match(cell(host, 'mpc-run-source-0').textContent, /2 levers · CEM\/128/);
  // §4.4 — four scalar columns, not a JSON blob in a cell.
  assert.match(host.textContent, /Date[\s\S]*Lever[\s\S]*Key[\s\S]*Value/);
});

test('MpcRuns: the decision table is sorted by DATE — the order the run plays', () => {
  const param = { name: 'mpcRuns', value: BAG() };
  mount(buildMpcRunsEditor(param));
  assert.deepStrictEqual(param.value['run:2026-09-18'].decisions.map(d => d.key),
    ['band@55', 'band@60'],
    'unsorted, the table reads in a different order from the one the run plays');
});

test('MpcRuns: `derivedFrom` renders as lineage — a parent pointer, not a graph edge (§4.3)', () => {
  const value = BAG();
  value['run:2026-09-18'].source.derivedFrom = 'run:2026-09-01';
  const host = mount(buildMpcRunsEditor({ name: 'mpcRuns', value }));
  assert.match(cell(host, 'mpc-run-derived-0').textContent, /re-solved from run:2026-09-01/);
});

test('MpcRuns: deleting the last run normalises to null, not {}', () => {
  const param = { name: 'mpcRuns', value: BAG() };
  const host  = mount(buildMpcRunsEditor(param));
  for (const btn of [...host.querySelectorAll('[data-id="removeRow"]')]) {
    if (btn.title === 'Delete run') btn.click();
  }
  // Re-query: the editor re-renders after each delete.
  for (const btn of [...host.querySelectorAll('[data-id="removeRow"]')]) {
    if (btn.title === 'Delete run') btn.click();
  }
  assert.strictEqual(param.value, null,
    'an empty object would make a scenario that once held a run differ from one that never did');
});

test('MpcRuns: renaming a run tells the SELECT to re-read, so it can say "(not found)"', () => {
  const param = { name: 'mpcRuns', value: BAG() };
  let refreshed = 0;
  const host = mount(buildMpcRunsEditor(param, () => { refreshed++; }));
  type(cell(host, 'run-id'), 'run:renamed');
  assert.ok(param.value['run:renamed'], 'the bag key moved');
  assert.ok(refreshed > 0, 'a rename orphans mpcActiveRun — the select must be told');
});

test('MpcRuns: "+ Add Run" seeds a dated, empty entry rather than a blob', () => {
  const param = { name: 'mpcRuns', value: null };
  const host  = mount(buildMpcRunsEditor(param));
  assert.match(host.textContent, /No recorded runs/);
  button(host, 'Add Run').click();
  // The id starts blank and `sync` drops keyless entries, so nothing is authored until named.
  assert.strictEqual(param.value, null, 'an unnamed run is not a run');
});
