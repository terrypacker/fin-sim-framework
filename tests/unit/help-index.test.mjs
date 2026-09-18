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
 * help-index.test.mjs
 * Tier-1 help index (design 108 §4, phase 1).
 *
 * What these tests are FOR: the index exists because three hand-maintained doc indexes in
 * this repo drifted (design 108 §2.1), and the fix is that nothing here is hand-maintained.
 * So the assertions are all of the same shape — the collector reports what the registry
 * actually holds, with no second list to fall out of step. A test that hard-coded "221
 * params" would BE the second list, so none of them do.
 *
 * Run with: node --test tests/unit/help-index.test.mjs
 */

import { test }  from 'node:test';
import assert    from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join }                      from 'node:path';

import {
  collectParams, collectPanels, collectActions, collectTools, collectState,
  purposeFromDocblock, flagsFromSource, specFromSource, isEntryPoint, buildHelpIndex,
  collectTopics, collectDesign, ROOT,
} from '../../scripts/lib/help-index.mjs';
import { readTopics, BUDGETS }     from '../../scripts/lib/help-topics.mjs';
import { renderReferenceMarkdown } from '../../scripts/lib/help-render.mjs';
import { IntlRetirementScenario }  from '../../src/scenarios/intl-retirement-scenario.js';
import { FINANCE_PLUGINS }         from '../../src/visualization/workbench/plugins/finance/finance-plugin-package.js';

/* ───────────────────────────────── params ───────────────────────────────── */

test('HELP-1: every param in the live schema appears in the index, exactly once', async () => {
  const schema = IntlRetirementScenario.buildFullParamSchema();
  const index  = await collectParams();

  assert.equal(index.length, schema.length,
    'the index must neither drop nor invent a param');
  assert.deepEqual(index.map(p => p.key), schema.map(p => p.key),
    'and must preserve the schema order the UI groups by');
  assert.equal(new Set(index.map(p => p.key)).size, index.length, 'keys are unique');
});

test('HELP-2: every param carries its description verbatim — the index never paraphrases', async () => {
  const byKey = new Map(IntlRetirementScenario.buildFullParamSchema().map(p => [p.key, p]));
  for (const p of await collectParams()) {
    assert.equal(p.description, byKey.get(p.key).description ?? '',
      `${p.key}: description must be the schema's, character for character`);
  }
});

test('HELP-3: contributedBy reproduces the first-toolset-wins merge rule', async () => {
  const params = await collectParams();
  const byKey  = new Map(params.map(p => [p.key, p]));

  // Scenario-level keys are attributed to the scenario, not to a toolset that also names them.
  for (const entry of IntlRetirementScenario.getParamSchema()) {
    assert.equal(byKey.get(entry.key)?.contributedBy, 'SCENARIO',
      `${entry.key} is declared by the scenario itself`);
  }

  // The interesting case: a key MORE THAN ONE toolset contributes. US_RETIREMENT and
  // AU_RETIREMENT both carry the spending/mortality family, and `buildFullParamSchema`
  // keeps the first in `_paramToolsets()` order — so the index must say the same, or it
  // points at a file where editing the description would have no effect.
  const toolsets = IntlRetirementScenario._paramToolsets();
  const seenIn   = new Map();
  for (const t of toolsets) {
    for (const e of t.paramSchema?.({}) ?? []) {
      if (!e?.key) continue;
      if (!seenIn.has(e.key)) seenIn.set(e.key, []);
      seenIn.get(e.key).push(t.id);
    }
  }
  const shared = [...seenIn].filter(([k, ids]) => ids.length > 1 && byKey.has(k));
  assert.ok(shared.length > 0, 'this test is vacuous unless some key really is shared');
  for (const [key, ids] of shared) {
    if (byKey.get(key).contributedBy === 'SCENARIO') continue;   // scenario wins over both
    assert.equal(byKey.get(key).contributedBy, ids[0],
      `${key} is contributed by ${ids.join(' and ')}; the first wins`);
  }
});

/* ───────────────────────────────── panels ───────────────────────────────── */

test('HELP-4: every registered workbench panel appears, with its real source file', async () => {
  const panels = await collectPanels();

  assert.deepEqual(panels.map(p => p.id), FINANCE_PLUGINS.map(p => p.id),
    'the panel list is FINANCE_PLUGINS, not a copy of it');
  for (const p of panels) {
    assert.ok(p.source?.endsWith('.js'),
      `${p.id}: source file must be resolved from the package's own imports, got ${p.source}`);
  }
  // Six panels come from the `hostPanePlugin()` factory and all report the class name
  // `HostPanePlugin`, so resolving the file by class name silently collapses them onto one
  // (or onto none). Each must still point at its own file.
  const factoryPanels = panels.filter(p => ['mc-config', 'opt-config', 'mc-results'].includes(p.id));
  assert.equal(new Set(factoryPanels.map(p => p.source)).size, factoryPanels.length,
    'factory-built panels must not share a source file');
});

/* ───────────────────────────────── actions ──────────────────────────────── */

test('HELP-5: an action type declared by two toolsets is one entry naming both', async () => {
  const actions = await collectActions();
  assert.equal(new Set(actions.map(a => a.type)).size, actions.length,
    'one row per type — the toolsets compose into a single journal');

  const shared = actions.filter(a => a.declaredBy.length > 1);
  assert.ok(shared.length > 0, 'US/AU retirement share action types; this should not be empty');
  for (const a of shared) {
    assert.equal(a.sources.length, a.declaredBy.length,
      `${a.type}: every declaring toolset contributes its file`);
  }
});

test('HELP-6: action payload fields are rendered from their ValueType, currency included', async () => {
  const actions = await collectActions();
  const withCurrency = actions.filter(a => Object.values(a.fields).some(k => /^currency\(/.test(k)));
  assert.ok(withCurrency.length > 0,
    'currency-typed payload fields must keep their code — amount: currency(USD), not amount: currency');
  for (const a of actions) {
    for (const [name, kind] of Object.entries(a.fields)) {
      assert.notEqual(kind, 'unknown', `${a.type}.${name} has no readable value type`);
    }
  }
});

/* ────────────────────────────────── tools ───────────────────────────────── */

test('HELP-7: a script purpose is harvested from its docblock, in either convention', () => {
  // `name.mjs — purpose.` on one line.
  assert.equal(
    purposeFromDocblock('/**\n * frontier.mjs — find the edge of solvency. More prose.\n */', 'frontier.mjs'),
    'find the edge of solvency');

  // `name.mjs`, blank line, then the prose.
  assert.equal(
    purposeFromDocblock('/**\n * run-scenario.mjs\n *\n * Headless scenario runner. Loads files.\n */', 'run-scenario.mjs'),
    'Headless scenario runner');

  // Named without its extension.
  assert.equal(
    purposeFromDocblock('/**\n * shock-path-engine — the emergent path. Etc.\n */', 'shock-path-engine.mjs'),
    'the emergent path');

  // A python module docstring carries no name line at all.
  assert.equal(
    purposeFromDocblock('#!/usr/bin/env python3\n"""\nConvert X to Y format.\n\nMore.\n"""', 'convert.py'),
    'Convert X to Y format');

  // No docblock names the file: say so rather than harvesting an unrelated one.
  assert.equal(
    purposeFromDocblock('/**\n * Some helper constant.\n */\nconst X = 1;', 'build-index.js'),
    null);
});

test('HELP-8: the parseFlags spec is read from source, with help text and defaults', () => {
  const src = `
    import { parseFlags } from '../lib/cli.mjs';
    const opts = parseFlags(process.argv.slice(2), {
      usage: 'node x.mjs',
      scenario: { type: 'string', default: 'plan.json', help: 'base export' },
      n:        { type: 'number', default: 300 },
      shockYear:{ type: 'number', help: 'year the shock lands' },
      paths:    { type: 'flag',   help: 'stochastic returns' },
    });`;
  const flags = flagsFromSource(src);

  assert.deepEqual(flags.map(f => f.name), ['scenario', 'n', 'shock-year', 'paths'],
    'camelCase declarations are kebab-case on the command line');
  assert.equal(flags[0].help, 'base export');
  assert.equal(flags[1].default, 300);
  assert.equal(flags[3].type, 'flag');
  assert.equal(flagsFromSource('const x = 1;'), null, 'a script with no spec reports none');
});

test('HELP-8b: a declared positional is read as one, not as a flag named "positional"', () => {
  // It is spelled bare on the command line, so listing it as `--positional` would print a
  // flag that does not exist — the exact class of wrongness this generator exists to avoid.
  const src = `
    const opts = parseFlags(process.argv.slice(2), {
      usage: 'npm run scenario -- <file.json> [more…]',
      positional: { name: 'files', type: 'list', variadic: true, help: 'scenario export(s)' },
      to: { type: 'string', default: null },
    });`;
  const { flags, positional } = specFromSource(src);

  assert.deepEqual(flags.map(f => f.name), ['to']);
  assert.equal(positional.name, 'files');
  assert.equal(positional.variadic, true);
  assert.equal(positional.required, false);
  assert.equal(positional.help, 'scenario export(s)');
  assert.equal(specFromSource('const x = 1;').positional, null);
});

test('HELP-8c: a module under scripts/ is not counted as an entry point', () => {
  // D6 targets files that parse a command line. Counting a shared definition module would
  // put "every entry point on the spec" permanently out of reach and make the gate a liar.
  assert.equal(isEntryPoint('export const ARMS = [1, 2];'), false);
  assert.equal(isEntryPoint('const argv = process.argv.slice(2);'), true);

  const tools = collectTools({});
  const arms  = tools.find(t => t.path.endsWith('sequence-risk/arms.mjs'));
  assert.ok(arms, 'the module is still listed in the reference');
  assert.equal(arms.entryPoint, false, 'but it is not part of the D6 count');
});

test('HELP-9: every headless entry point is listed, and an undocumented one is not hidden', () => {
  const tools = collectTools({});
  assert.ok(tools.length > 50, `expected the whole scripts/ tree, got ${tools.length}`);
  assert.ok(tools.every(t => t.path.startsWith('scripts/')));
  assert.ok(tools.some(t => t.flags?.length), 'the parseFlags scripts must show their flags');

  // A script with no self-naming docblock reports `purpose: null` rather than borrowing
  // someone else's sentence. That null is what the gate counts in phase 3.
  assert.ok(tools.some(t => t.purpose === null),
    'undocumented scripts exist today and must be reported as such');
});

/* ────────────────────────────────── state ───────────────────────────────── */

test('HELP-10: state types are the framework globs only — no per-account paths', async () => {
  const state = await collectState();
  assert.ok(state.some(s => s.path === '*.balance'), 'the registry constructor globs are present');
  // `unknown` is a REGISTERED kind, not a collector failure: `*.holdings.*.appreciationSchedule`
  // is a schedule object rather than a scalar and is deliberately typed that way.
  assert.ok(state.every(s => s.kind), 'every path carries the value type the registry gave it');
  // registerAccount() stamps paths for a LOADED plan; a static reference must not carry them.
  assert.ok(!state.some(s => /usSavingsAccount|auSavingsAccount/.test(s.path)),
    'per-account paths belong to a plan, not to the framework reference');
});

/* ───────────────────────────────── render ───────────────────────────────── */

test('HELP-11: the reference is deterministic — same tree in, byte-identical file out', async () => {
  const [a, b] = [await buildHelpIndex(), await buildHelpIndex()];
  assert.equal(renderReferenceMarkdown(a), renderReferenceMarkdown(b),
    'a timestamp or an unstable sort would make every run a diff, destroying the review signal');
});

test('HELP-12: rendered descriptions cannot break the markdown that carries them', async () => {
  const md = renderReferenceMarkdown(await buildHelpIndex());

  // A bare pair of dollar signs on one line renders as LaTeX math in most viewers and eats
  // the sentence. Three descriptions contain one.
  for (const line of md.split('\n')) {
    const bare = [...line.matchAll(/(?<!\\)\$/g)].length;
    assert.equal(bare, 0, `unescaped dollar sign would render as math: ${line.slice(0, 100)}`);
  }
  // Table rows must have the column count their header promises.
  const rows = md.split('\n').filter(l => l.startsWith('| `'));
  assert.ok(rows.length > 100, 'the panel/action/state tables should be substantial');
});

test('HELP-13: the index counts agree with the collectors they summarise', async () => {
  const index = await buildHelpIndex();
  assert.equal(index.counts.params,  index.params.length);
  assert.equal(index.counts.panels,  index.panels.length);
  assert.equal(index.counts.actions, index.actions.length);
  assert.equal(index.counts.tools,   index.tools.length);
  assert.equal(index.counts.state,   index.state.length);
});

/* ───────────────────────────────── topics ───────────────────────────────── */

test('HELP-14: topics[] is the topic tree the GATE reads, with its markdown pre-rendered', async () => {
  const [topics, onDisk] = [await collectTopics(), readTopics()];

  // One source of truth for what a topic IS. If the panel resolved topics differently from
  // the gate, a topic the gate rejects could still ship, which is the drift this design is
  // about, one level down.
  assert.deepEqual(topics.map(t => t.id).sort(),
    onDisk.filter(t => !t.error && t.id).map(t => t.id).sort());

  for (const t of topics) {
    assert.ok(t.html.trim().startsWith('<'), `${t.id}: html must be RENDERED, not markdown`);
    assert.ok(!/^\s*#{1,6}\s/m.test(t.html), `${t.id}: a raw heading means the render was skipped`);
    assert.ok(BUDGETS[t.kind], `${t.id}: kind must be one the budgets know`);
  }
});

test('HELP-15: a topic is never a restatement — the index carries the citation, not a copy', async () => {
  const index = await buildHelpIndex();
  assert.equal(index.counts.topics, index.topics.length);

  // Every id the panel can be asked for resolves, and every panel has one — the promise
  // the gate makes, asserted against the shipped index rather than against the tree.
  const ids = new Set(index.topics.map(t => t.id));
  assert.equal(ids.size, index.topics.length, 'ids are unique');
  for (const p of index.panels) {
    assert.ok(index.topics.some(t => t.kind === 'panel' && t.panels.includes(p.id)),
      `panel "${p.id}" has no topic, so the Help panel would show a fallback`);
  }
  // And every param a topic cites is a real param, so a `?` can always be answered.
  const paramKeys = new Set(index.params.map(p => p.key));
  for (const t of index.topics) {
    for (const k of t.params) assert.ok(paramKeys.has(k), `${t.id} cites dead param ${k}`);
  }
});

/* ───────────────────────────────── design ───────────────────────────────── */

test('HELP-16: every design doc is listed, with its OWN title and no summary', () => {
  const onDisk = readdirSync(join(ROOT, 'design'))
    .filter(f => f.endsWith('.md') && f !== 'README.md').sort();
  const listed = collectDesign();

  assert.deepEqual([...listed.map(d => d.path)].sort(), onDisk,
    'the index must neither drop nor invent a design doc');
  for (const d of listed) {
    assert.ok(d.title, `${d.path}: no H1 to take a title from`);
    // A title is read; a summary would be written, and a written summary of an argument
    // is the second copy that rotted the two lists this collector replaced (§2.1).
    const h1 = readFileSync(join(ROOT, 'design', d.path), 'utf8').match(/^#\s+(.+)$/m)[1].trim();
    assert.equal(d.title, h1, `${d.path}: the title must be the file's own H1, verbatim`);
  }
});

test('HELP-17: the design list is in SERIES order, not alphabetical', () => {
  const nums = collectDesign().map(d => d.number).filter(n => n !== null);
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b),
    'lexicographic order puts 100 between 10 and 11 and makes 116 rows unreadable');
  // The unnumbered files sort last, so the series is never interrupted.
  const kinds = collectDesign().map(d => d.number === null);
  assert.deepEqual(kinds, [...kinds].sort((a, b) => a - b));
});

test('HELP-18: the README points at the generated index instead of copying it', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  // The two tables design 108 §2.1 measured, and the exact shape they had. A row per
  // plugin id, or a bullet per design filename, means the copy is back.
  assert.ok(!/^\|\s*`?scenario`?\s*\|/m.test(readme),
    'the plugin table is back — point at help/REFERENCE.md instead of re-listing panels');
  assert.ok(!/^-\s+`\d+-[a-z-]+\.md`/m.test(readme),
    'the design-doc list is back — it covered 19 of 116 last time and would again');
  assert.ok(readme.includes('help/REFERENCE.md'), 'and it must say where the real list is');
});
