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
 * disposal-tax-payload-parity.test.mjs — one field contract for every emitter of
 * a capital-gains disposal action (design/inconsistencies.md §4.11).
 *
 * `action-payload-schema.test.mjs` catches the OPPOSITE drift: a field an emitter
 * carries that its toolset never declared, so the journal silently drops it. This
 * file catches a field an emitter never sets at all.
 *
 * That distinction matters because of how the tax modules read these payloads:
 *
 *     auIndexedGain ?? auGain ?? gain          (au-tax-module-2027)
 *     action.auDiscountableGain ?? auGain      (us-tax-module-2026, au-tax-module-2026)
 *     action.isGold ? indexed : un-indexed     (au-tax-module-2027)
 *
 * Every one of those is a `??` fallback, so an ABSENT field does not read as
 * "unknown, be careful" — it reads as a specific, wrong, silent answer:
 *
 *   - no `auGain`          ⇒ assess the AU gain on the US cost base, ignoring the
 *                            s855-45 residency step-up (design 36 §12.2).
 *   - no `auDiscountableGain` ⇒ 100% of the gain qualifies for the CGT 50% discount,
 *                            with no ≥12-month holding test (design 62 §4).
 *   - no `isGold`          ⇒ bullion is assessed as a true collectible and loses the
 *                            indexation the FY2027 reform grants it (design 57 §6.4).
 *
 * Five independent code paths construct these same two action types — the service
 * drawdown, the event-driven reducers (US and AU), the rebalancer and the tax
 * harvester. They are not layered; each builds the payload from scratch. Measured
 * on the reference plan before this test existed, 98% of STOCK_WITHDRAWAL_TAX rows
 * and 93% of COLLECTIBLE_SALE_TAX rows came from the emitter with the THINNEST
 * payload, while the rebalancer taxed the same lots in the same accounts correctly.
 *
 * The scan is static (Babel AST over `src/`) rather than run-based, for the reason
 * the sibling file's static pass exists: a disposal only happens when a scenario
 * happens to sell something, so a dynamic pass passes vacuously on the paths that
 * are not exercised — which is precisely where the drift accumulates.
 *
 * Run with: node --test tests/unit/disposal-tax-payload-parity.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';
import fs       from 'node:fs';
import path     from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_DIR = path.join(ROOT, 'src');

/**
 * Fields every emitter of these action types must set explicitly, because the
 * consumer's `??` fallback for a missing one is a wrong answer rather than a safe
 * one. `gain` and `residency` are included as the floor: `residency` gates the
 * whole AU branch, so an emitter that forgets it books no AU tax at all.
 */
const REQUIRED = {
  STOCK_WITHDRAWAL_TAX:    ['gain', 'auGain', 'auDiscountableGain', 'residency'],
  AU_STOCK_WITHDRAWAL_TAX: ['gain', 'auGain', 'auDiscountableGain', 'residency'],
  COLLECTIBLE_SALE_TAX:    ['gain', 'auGain', 'isGold', 'residency'],
};

/**
 * `auIndexedGain` is tracked separately because omitting it is CONSERVATIVE, not
 * wrong: the consumer falls back to the un-indexed `auGain`, which overstates the
 * real gain and so overstates the tax. Required of every emitter that consumes
 * holdings through `consumeHoldings` (which returns the indexed per-country basis
 * for free), and exempted only where the emitter structurally cannot compute it.
 */
const INDEXATION_EXEMPT = {
  // The harvester targets one named holding rather than FIFO-consuming the account,
  // so it never calls consumeHoldings and has no per-lot acquisitionPriceLevel to
  // index against. It stamps auGain + auDiscountableGain and lets auIndexedGain fall
  // back to the un-indexed auGain. Give it indexation only by routing it through
  // consumeHoldings, not by inventing a factor here.
  'src/finance/behavioral/stock-harvest-apply-reducer.js': ['STOCK_WITHDRAWAL_TAX'],
};

// ─── AST scan ────────────────────────────────────────────────────────────────

function jsFilesUnder(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory())             jsFilesUnder(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function walkAst(node, cb) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walkAst(n, cb); return; }
  if (typeof node.type === 'string') cb(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const v = node[key];
    if (v && typeof v === 'object') walkAst(v, cb);
  }
}

/**
 * Every object literal under `src/` whose `type:` is a string literal naming one of
 * the disposal-tax types. Manifest entries (the toolsets' `types.actions` blocks)
 * are excluded by their own `fields:` key, which no emitted action carries.
 *
 * @returns {{ type: string, file: string, line: number, keys: Set<string> }[]}
 */
function scanDisposalEmitters() {
  const out = [];
  for (const file of jsFilesUnder(SRC_DIR)) {
    const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['classProperties'] });
    walkAst(ast.program, (node) => {
      if (node.type !== 'ObjectExpression') return;
      const props  = node.properties.filter(p => p.type === 'ObjectProperty' && !p.computed);
      const keyOf  = (p) => p.key?.name ?? p.key?.value;
      const tProp  = props.find(p => keyOf(p) === 'type' && p.value?.type === 'StringLiteral');
      if (!tProp) return;
      const type = tProp.value.value;
      if (!(type in REQUIRED)) return;
      if (props.some(p => keyOf(p) === 'fields')) return;   // manifest declaration

      out.push({
        type,
        file: path.relative(ROOT, file),
        line: tProp.loc.start.line,
        keys: new Set(props.map(keyOf).filter(k => k != null)),
      });
    });
  }
  return out;
}

const EMITTERS = scanDisposalEmitters();

// ─── Tests ───────────────────────────────────────────────────────────────────

test('4.11: the disposal-tax emitters are actually found (guard against a vacuous pass)', () => {
  // If a refactor moves these payloads behind a spread or a builder function, the
  // AST scan goes blind and every test below passes for the wrong reason. Pin the
  // count's floor so that failure is loud.
  const byType = {};
  for (const e of EMITTERS) byType[e.type] = (byType[e.type] ?? 0) + 1;

  assert.ok(EMITTERS.length >= 6,
    `expected ≥6 disposal-tax emitter literals under src/, found ${EMITTERS.length}: ` +
    `${JSON.stringify(byType)}. If a payload moved behind a spread or a shared builder, ` +
    `this scan can no longer see it — teach the scan about the new shape rather than ` +
    `lowering the floor.`);

  for (const type of Object.keys(REQUIRED)) {
    assert.ok((byType[type] ?? 0) >= 1, `no emitter literal found for ${type}`);
  }
});

test('4.11: every disposal-tax emitter stamps the fields whose absence means a WRONG answer', () => {
  const failures = [];
  for (const e of EMITTERS) {
    const missing = REQUIRED[e.type].filter(f => !e.keys.has(f));
    if (missing.length) {
      failures.push(`${e.file}:${e.line}  ${e.type}  missing: ${missing.join(', ')}`);
    }
  }
  assert.deepEqual(failures, [],
    'These emitters omit a field the tax modules read through a `??` fallback, so the\n' +
    'omission silently selects a wrong treatment rather than an unknown one:\n  ' +
    failures.join('\n  ') +
    '\n\nSee design/inconsistencies.md §4.11 for what each missing field costs.');
});

test('4.11: every FIFO-based disposal emitter also stamps auIndexedGain', () => {
  const failures = [];
  for (const e of EMITTERS) {
    if ((INDEXATION_EXEMPT[e.file] ?? []).includes(e.type)) continue;
    if (!e.keys.has('auIndexedGain')) {
      failures.push(`${e.file}:${e.line}  ${e.type}`);
    }
  }
  assert.deepEqual(failures, [],
    'These emitters drop the design-57 CPI-indexed AU gain, so the FY2027 AU module\n' +
    'falls back to the un-indexed auGain and overstates the real gain:\n  ' +
    failures.join('\n  ') +
    '\n\nIf the emitter genuinely cannot index (no consumeHoldings call, no per-lot\n' +
    'acquisitionPriceLevel), add it to INDEXATION_EXEMPT with the reason.');
});

test('4.11: INDEXATION_EXEMPT has not gone stale', () => {
  // An exemption that no longer applies is worse than no exemption: it silently
  // grants a pass to whatever moves into that file next.
  for (const [file, types] of Object.entries(INDEXATION_EXEMPT)) {
    for (const type of types) {
      const hit = EMITTERS.find(e => e.file === file && e.type === type);
      assert.ok(hit, `INDEXATION_EXEMPT lists ${file} → ${type}, but no such emitter exists`);
      assert.ok(!hit.keys.has('auIndexedGain'),
        `${file} now stamps auIndexedGain on ${type} — drop its INDEXATION_EXEMPT entry.`);
    }
  }
});
