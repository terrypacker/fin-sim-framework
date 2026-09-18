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
 * cli-migration.test.mjs — design 108 D6, held in place.
 *
 * D6 put all 64 entry points under `scripts/` on the declarative `parseFlags` spec, which
 * bought two things: `help/REFERENCE.md` can list every flag of every tool, and a mistyped
 * flag is an error rather than a silent default. Both are a property of the whole tree, so
 * both are checked over the whole tree — a new script that rolls its own argv parser fails
 * here, which is the only mechanism that has ever kept a second copy honest in this repo
 * (design 108 §2.1).
 *
 * `--help` is run in a CHILD PROCESS rather than by importing: every one of these files
 * does its work at module scope, so importing one runs a simulation.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import { execFileSync }   from 'node:child_process';
import { readFileSync }   from 'node:fs';
import { join }           from 'node:path';

import { collectTools, ROOT } from '../../scripts/lib/help-index.mjs';

const pkg   = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const tools = collectTools(pkg.scripts);
const entry = tools.filter(t => t.entryPoint);

/** Run a script and return `{ status, stdout, stderr }` without throwing on a non-zero exit. */
function run(relPath, args) {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, relPath), ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    if (e.killed) throw new Error(`${relPath} did not exit within 60s of ${args.join(' ')}`);
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('design 108 D6 — every entry point is on the parseFlags spec', () => {
  test('the tree is fully migrated', () => {
    const missing = entry.filter(t => !t.flags && !t.positional).map(t => t.path);
    assert.deepEqual(missing, [],
      'these entry points parse argv but declare no flags; put them on parseFlags (design 108 D6)');
    assert.ok(entry.length >= 60, `expected the whole scripts/ tree, got ${entry.length}`);
  });

  // Not merely cosmetic: the usage text is generated FROM the spec, so a script that
  // cannot print it is a script whose spec the reference is reporting wrongly.
  for (const t of entry) {
    test(`${t.path} — --help prints its usage and exits 0`, () => {
      const { status, stdout } = run(t.path, ['--help']);
      assert.equal(status, 0, `--help must exit 0, got ${status}`);
      assert.match(stdout, /\n\s+(--|<)/, '--help must list at least one argument');
    });
  }
});

describe('design 108 D6 — a mistyped flag is an error, not a default', () => {
  // The failure the whole migration is about: `--shock-yr` for `--shock-year` used to run
  // the default and say nothing, which is how `offset-bond-pool` produced a complete,
  // plausible, meaningless grid. One representative per directory keeps this fast; the
  // behaviour itself is parseFlags', and scripts-cli.test.mjs covers it directly.
  const SAMPLE = [
    'scripts/scenario/run-scenario.mjs',
    'scripts/tax/export-tax-csv.mjs',
    'scripts/lab/variant-grid.mjs',
    'scripts/probes/probe-return-autocorrelation.mjs',
    'scripts/montecarlo/mc-report.mjs',
    'scripts/dev/build-help-index.mjs',
  ];

  for (const path of SAMPLE) {
    test(`${path} — an unknown flag exits 2`, () => {
      assert.ok(entry.some(t => t.path === path), `${path} is no longer an entry point`);
      const { status, stderr } = run(path, ['--definitely-not-a-flag', '1']);
      assert.equal(status, 2, 'an unknown flag must exit 2, not run the default');
      assert.match(stderr, /unknown flag "--definitely-not-a-flag"/);
    });
  }
});
