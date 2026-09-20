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
 * mpc-run-lab.test.mjs
 *
 * DESIGN 81 phase 6 — the shared half of the run lab. The six tools are thin; this is where
 * the parts that can be wrong live.
 *
 * MRL6-1  `pickRun` — the named one, else the scenario's SELECTION, else the only one, else refuse
 * MRL6-2  `withActiveRun` / `withoutRun` — the arm and its control differ in ONE param
 * MRL6-3  `inForceAt` reads exactly as the engine does — latest row per key at or before
 * MRL6-4  `branchAt` SUPERSEDES; it does not rewrite the past
 * MRL6-5  `withoutLever` removes rows and leaves the base scenario governing that lever
 * MRL6-6  `parseSet` — explicit lever, inferred lever, and a named ambiguity
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  runBagOf, listRuns, pickRun, withActiveRun, withoutRun,
  decisionsOf, inForceAt, leversOf, withoutLever, branchAt, parseSet,
} from '../../scripts/lib/run-lab.mjs';

const D = (y) => new Date(Date.UTC(y, 0, 1)).toISOString();

const ENTRY = () => ({
  source: { recordedAt: D(2026), levers: ['SPENDING', 'BOND_LADDER'], epochs: 3, solver: 'CEM/128' },
  decisions: [
    { date: D(2030), lever: 'SPENDING',    key: 'band@60',         value: 4000 },
    { date: D(2032), lever: 'SPENDING',    key: 'band@60',         value: 9000 },
    { date: D(2032), lever: 'BOND_LADDER', key: 'bondLadderRungs', value: 7 },
  ],
});

const CFG = (over = {}) => ({
  name: 'test-plan', simStart: D(2026), simEnd: D(2040),
  params: [
    { name: 'mpcRuns',       type: 'MpcRuns',       value: { 'run:a': ENTRY() } },
    { name: 'mpcActiveRun',  type: 'MpcRunSelect',  value: null },
    { name: 'mpcRunEnabled', type: 'Boolean',       value: true },
    { name: 'inflationRate', type: 'Number',        value: 0.03 },
  ].map(p => ({ ...p, ...(over[p.name] !== undefined ? { value: over[p.name] } : {}) })),
});

// ─── MRL6-1 ──────────────────────────────────────────────────────────────────

test('MRL6-1: `pickRun` takes the SELECTION over "the first", so a tool reports the plan the file runs', () => {
  const cfg = CFG();
  cfg.params.find(p => p.name === 'mpcRuns').value['run:b'] = ENTRY();
  cfg.params.find(p => p.name === 'mpcActiveRun').value = 'run:b';
  assert.equal(pickRun(cfg).runId, 'run:b');
  assert.equal(pickRun(cfg, 'run:a').runId, 'run:a');
});

test('MRL6-1: one run and no selection is unambiguous; several and none REFUSES', () => {
  assert.equal(pickRun(CFG()).runId, 'run:a');
  const many = CFG();
  many.params.find(p => p.name === 'mpcRuns').value['run:b'] = ENTRY();
  // Guessing here is how a session ends up comparing two things it thinks are one.
  assert.throws(() => pickRun(many), /selects none/);
  assert.throws(() => pickRun(CFG(), 'run:gone'), /no recorded run 'run:gone'[\s\S]*Available/);
  assert.throws(() => pickRun({ params: [] }), /no recorded MPC runs/);
});

test('MRL6-1: `listRuns` labels each entry the way the app’s picker does', () => {
  const [only] = listRuns(CFG());
  assert.equal(only.runId, 'run:a');
  assert.equal(only.rows, 3);
  assert.match(only.label, /2 levers · CEM\/128/);
});

// ─── MRL6-2 ──────────────────────────────────────────────────────────────────

test('MRL6-2: the arm and its control differ in exactly ONE param', () => {
  const cfg = CFG();
  const arm  = withActiveRun(cfg, 'run:a');
  const ctrl = withoutRun(cfg);
  const val = (c, k) => c.params.find(p => (p.key ?? p.name) === k)?.value;

  assert.equal(val(arm, 'mpcActiveRun'), 'run:a');
  assert.equal(val(arm, 'mpcRunEnabled'), true);
  // The control keeps the SELECTION and flips the switch: clearing `mpcActiveRun` instead
  // would differ in two params, which is the confound design 110 §6.5 keeps finding.
  assert.equal(val(ctrl, 'mpcRunEnabled'), false);
  assert.equal(val(ctrl, 'mpcActiveRun'), val(cfg, 'mpcActiveRun'));
  // Neither touches the caller's cfg.
  assert.equal(val(cfg, 'mpcRunEnabled'), true);
});

test('MRL6-2: passing an entry REPLACES the bag entry, so an experiment inherits nothing', () => {
  const cfg = CFG();
  const trimmed = withoutLever(ENTRY(), 'SPENDING');
  const arm = withActiveRun(cfg, 'run:a', trimmed);
  assert.equal(runBagOf(arm)['run:a'].decisions.length, 1);
  assert.equal(runBagOf(cfg)['run:a'].decisions.length, 3, 'the file is untouched');
});

// ─── MRL6-3 ──────────────────────────────────────────────────────────────────

test('MRL6-3: `inForceAt` is the latest row per key AT OR BEFORE — rows scattered across years', () => {
  const at = inForceAt(ENTRY(), D(2035));
  assert.deepEqual(at.rows.map(r => [r.lever, r.key, r.value]),
    [['BOND_LADDER', 'bondLadderRungs', 7], ['SPENDING', 'band@60', 9000]]);
  assert.equal(new Date(at.throughMs).toISOString(), D(2032));

  // Before every row: the run plays the base plan up to here.
  assert.deepEqual(inForceAt(ENTRY(), D(2028)).rows, []);
  // Between: the 2030 spending row is live, the 2032 ladder row is not.
  assert.deepEqual(inForceAt(ENTRY(), D(2031)).rows.map(r => r.value), [4000]);
});

test('MRL6-3: `decisionsOf` / `leversOf` normalize exactly as the engine does', () => {
  assert.deepEqual(decisionsOf(ENTRY()).map(d => d.value), [4000, 7, 9000]);   // date, lever, key
  assert.deepEqual(leversOf(ENTRY()), ['BOND_LADDER', 'SPENDING']);
});

// ─── MRL6-4 / MRL6-5 ─────────────────────────────────────────────────────────

test('MRL6-4: `branchAt` SUPERSEDES from the date and leaves the past intact', () => {
  const branched = branchAt(ENTRY(), D(2035), [{ lever: 'SPENDING', key: 'band@60', value: 11000 }]);
  // Before the branch, the run is unchanged — which is the point: the realized past is what
  // produced the state the branch starts from.
  assert.deepEqual(inForceAt(branched, D(2034)).rows.map(r => r.value), [7, 9000]);
  assert.deepEqual(inForceAt(branched, D(2036)).rows.map(r => r.value), [7, 11000]);
  assert.equal(ENTRY().decisions.length, 3);
});

test('MRL6-5: `withoutLever` removes only that lever’s rows', () => {
  const trimmed = withoutLever(ENTRY(), 'SPENDING');
  assert.deepEqual(leversOf(trimmed), ['BOND_LADDER']);
  // The base scenario's own value then governs SPENDING — the only counterfactual that is
  // both well-defined and authored by somebody.
  assert.deepEqual(inForceAt(trimmed, D(2035)).rows.map(r => r.lever), ['BOND_LADDER']);
});

// ─── MRL6-6 ──────────────────────────────────────────────────────────────────

test('MRL6-6: `parseSet` takes an explicit lever, infers an unambiguous one, and names a clash', () => {
  const e = ENTRY();
  assert.deepEqual(parseSet('SPENDING:band@60=11000', e),
    { lever: 'SPENDING', key: 'band@60', value: 11000 });
  // The usual case: exactly one lever in this run decides that key.
  assert.deepEqual(parseSet('bondLadderRungs=9', e),
    { lever: 'BOND_LADDER', key: 'bondLadderRungs', value: 9 });
  // A non-numeric value stays a string — the categorical levers need it.
  assert.deepEqual(parseSet('DRAWDOWN_XBORDER:crossBorderDrawdown=GLOBAL', e),
    { lever: 'DRAWDOWN_XBORDER', key: 'crossBorderDrawdown', value: 'GLOBAL' });

  assert.throws(() => parseSet('band@60', e), /expected LEVER:key=value/);
  assert.throws(() => parseSet('nothing=1', e), /no lever in this run decides/);

  // Two levers deciding one key is reported with BOTH candidates rather than resolved by a
  // rule the user would have to know.
  const clash = { decisions: [...e.decisions,
    { date: D(2033), lever: 'BOND_LADDER', key: 'band@60', value: 1 }] };
  assert.throws(() => parseSet('band@60=1', clash), /decided by BOND_LADDER and SPENDING/);
});
