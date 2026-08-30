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
 * scripts-cli.test.mjs
 *
 * `scripts/lib/cli.mjs` exists for one behaviour: **an unknown flag is an error.**
 * Seventeen study scripts had their own `flag()` helper, and every one of them
 * returned the default for a flag it did not recognise — so a mistyped `--shock`
 * ran a no-crash column and reported it as a crash, silently. These tests are
 * mostly about that, and about `setParam` writing BOTH param stores.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseFlagsOrThrow as parse, setParam, getParam } from '../../scripts/lib/cli.mjs';

const SPEC = {
  usage: 'test',
  scenario:  { type: 'string', default: 'plan.json' },
  n:         { type: 'number', default: 300 },
  only:      { type: 'list',   default: [] },
  paths:     { type: 'flag' },
  shockYear: { type: 'number', default: 2033 },
  sweep:     { type: 'string', default: 'both', choices: ['return', 'spend', 'both'] },
};

describe('cli — an unknown flag is an error', () => {
  test('a typo does NOT silently select the default', () => {
    // The whole point of the module. Every helper it replaces returned 2033 here.
    assert.throws(() => parse(['--shock-yr', '2040'], SPEC), /unknown flag "--shock-yr"/);
  });

  test('and the message names the near miss', () => {
    assert.throws(() => parse(['--shock-yea', '2040'], SPEC), /Did you mean --shock-year/);
  });

  test('a flag given no value is an error, not an undefined', () => {
    assert.throws(() => parse(['--scenario'], SPEC), /needs a value/);
    // `--scenario --paths` would otherwise read "--paths" as the filename.
    assert.throws(() => parse(['--scenario', '--paths'], SPEC), /needs a value/);
  });

  test('a stray positional is an error', () => {
    assert.throws(() => parse(['mc-out'], SPEC), /unexpected argument "mc-out"/);
  });

  test('a value outside `choices` is refused', () => {
    assert.throws(() => parse(['--sweep', 'sideways'], SPEC), /must be one of return, spend, both/);
    assert.equal(parse(['--sweep', 'spend'], SPEC).sweep, 'spend');
  });

  test('a non-numeric value for a number flag is refused', () => {
    assert.throws(() => parse(['--n', 'lots'], SPEC), /expects a number/);
  });
});

describe('cli — parsing', () => {
  test('defaults come back when nothing is passed', () => {
    assert.deepEqual(parse([], SPEC), {
      scenario: 'plan.json', n: 300, only: [], paths: false, shockYear: 2033, sweep: 'both',
    });
  });

  test('kebab flags read back camelCase', () => {
    assert.equal(parse(['--shock-year', '2027'], SPEC).shockYear, 2027);
  });

  test('numbers are numbers and lists are arrays', () => {
    const o = parse(['--n', '50', '--only', 'none,dotcom27'], SPEC);
    assert.strictEqual(o.n, 50);
    assert.deepEqual(o.only, ['none', 'dotcom27']);
  });

  test('an empty list value yields an empty array, not [""]', () => {
    assert.deepEqual(parse(['--only', ''], SPEC).only, []);
  });

  test('a bare flag is false unless present', () => {
    assert.equal(parse([], SPEC).paths, false);
    assert.equal(parse(['--paths'], SPEC).paths, true);
  });
});

describe('cli — setParam writes both stores', () => {
  test('an existing row is matched by `name`, and `parameters` follows', () => {
    const cfg = { params: [{ name: 'monthlyExpenses', key: 'monthlyExpenses', value: 1 }],
                  parameters: { monthlyExpenses: 1 } };
    setParam(cfg, 'monthlyExpenses', 10_000);
    assert.equal(cfg.params[0].value, 10_000);
    assert.equal(cfg.parameters.monthlyExpenses, 10_000);
  });

  test('a row carrying only `key` is still found', () => {
    // Saved scenarios hold both spellings; matching on `name` alone would append a
    // DUPLICATE row and leave the original in place to win or lose at random.
    const cfg = { params: [{ key: 'shocks', value: [] }] };
    setParam(cfg, 'shocks', [{ preset: 'X' }]);
    assert.equal(cfg.params.length, 1);
    assert.deepEqual(cfg.params[0].value, [{ preset: 'X' }]);
  });

  test('a param the plan never authored is ADDED, with `name` set', () => {
    // The inline version threw here (`.value` of undefined), so a lever absent from the
    // plan could not be set at all. `name` is the identity field ScenarioLoader syncs on:
    // a row written with only `key` reads back fine and is dropped on the way to the
    // compiler, which is how two grids came back byte-identical.
    const cfg = { params: [] };
    setParam(cfg, 'poolBondYears', 6);
    assert.deepEqual(cfg.params, [{ name: 'poolBondYears', key: 'poolBondYears', value: 6 }]);
  });

  test('getParam reads either store', () => {
    assert.equal(getParam({ params: [{ name: 'a', value: 1 }] }, 'a'), 1);
    assert.equal(getParam({ parameters: { b: 2 } }, 'b'), 2);
    assert.equal(getParam({ params: [] }, 'missing'), undefined);
  });
});
