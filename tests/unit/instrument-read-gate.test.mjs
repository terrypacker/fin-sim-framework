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
 * instrument-read-gate.test.mjs — design 94 §5.2's static gate (step 1).
 *
 * Some fields on a holding describe the POSITION and some describe the INSTRUMENT the
 * position is held in (design 94 §5.1). Under Option A the instrument fields sit inline on
 * the holding; under Option C they move to a shared `Security` and the holding names it via
 * `securityId`. `instrumentOf(h, securities)` is the seam between those two worlds.
 *
 * Design 93 §5a shipped that seam DARK — nothing called it — precisely so that Option C
 * would change one function instead of every consumer. The consumers were never converted,
 * so the audit it was meant to avoid was still owed; design 94 step 1 paid it, and this is
 * what stops it coming back. Without a gate, the next author writes `h.couponRate` because
 * every line around it used to, and Option C silently acquires a consumer that reads past
 * the security.
 *
 * ─── what it can and cannot see ─────────────────────────────────────────────────────
 *
 * Whether an arbitrary expression is a *holding* is undecidable, so this matches on the
 * RECEIVER NAME (`h.couponRate`, `holding.maturityDate`, …). That makes it a ratchet, not a
 * proof — the same bargain `holding-value-write-gate` strikes by matching one literal
 * object shape. A holding in a variable named something else slips through; the answer to
 * that is to name holdings the way the codebase already does, which the gate enforces by
 * accident and which is worth having on its own.
 *
 * WRITES are invisible to it by construction: building a lot is `{ couponRate: x }`, not
 * `something.couponRate`, and a lot legitimately carries inline instrument fields under
 * Option A. Only reads have to go through the seam.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import fs                 from 'node:fs';
import path               from 'node:path';
import { fileURLToPath }  from 'node:url';
import { parse }          from '@babel/parser';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** The INSTRUMENT side of design 94 §5.1's partition, as it stands under Option A. */
const INSTRUMENT_FIELDS = new Set([
  'parPerUnit', 'couponRate', 'couponFrequency', 'maturityDate', 'duration',
  'taxExemption', 'issuingState', 'zeroCoupon', 'inflationLinked', 'rateKey',
  'dividendYield',
]);

/**
 * Receiver names that mean "a holding" in this codebase. Derived by reading every site,
 * not guessed: these are the names the existing code actually uses for a lot.
 */
const HOLDING_NAMES = new Set([
  'h', 'holding', 'lot', 'target', 'cur', 'soldHolding', 'sourceHolding', 'partial',
]);

/**
 * Files that legitimately read instrument fields off a holding directly.
 *
 * Kept SHORT and each entry justified, because an allowlist is where a gate goes to die.
 */
const ALLOWLIST = new Map([
  ['finance/holdings/holding.js',
    'the Holding class itself — it DEFINES the inline fields; reading them here is the definition'],
  ['finance/holdings/holding-utils.js',
    'the value primitives (design 93 §4). They are where the position/instrument split has to '
    + 'be RESOLVED rather than consumed: `syncHolding` derives par from `parPerUnit`, `split` '
    + 'divides it, `promoteToUnitised` decides whether a lot is a dated bond at all. Threading '
    + 'a registry through the four most-called functions in the substrate is design 94 step '
    + '2/3\'s decision once the entity exists, and §9.5c already owns the promotion half of it'],
  ['finance/holdings/holding-actions.js',
    'action payload construction and the type manifest — writes, and field NAMES, not reads'],
]);

/** Every .js under src/, excluding the generated index and the UI. */
function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'visualization') sourceFiles(p, out);
    } else if (e.name.endsWith('.js') && e.name !== 'index.js') {
      out.push(p);
    }
  }
  return out;
}

/**
 * Direct reads of an instrument field off a holding-named receiver.
 * Returns `[{ file, line, text }]`.
 */
function directInstrumentReads({ includeAllowlisted = false } = {}) {
  const hits = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (!includeAllowlisted && ALLOWLIST.has(rel)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    let ast;
    try { ast = parse(src, { sourceType: 'module', plugins: ['classProperties'] }); }
    catch (err) { assert.fail(`could not parse ${file}: ${err.message}`); }

    // Assignment targets are WRITES — `holding.rateKey = x` backfills an inline field on a
    // lot being built, which is exactly what Option A lots are allowed to carry. Collected
    // first so the walker can skip them by identity.
    const writeTargets = new Set();
    (function collectWrites(node) {
      if (!node || typeof node !== 'object') return;
      if ((node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression')) {
        writeTargets.add(node.left);
      }
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (Array.isArray(v)) v.forEach(collectWrites);
        else if (v && typeof v === 'object' && v.type) collectWrites(v);
      }
    })(ast);

    (function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (!writeTargets.has(node) && node.type === 'MemberExpression'
          && !node.computed
          && node.property?.type === 'Identifier'
          && INSTRUMENT_FIELDS.has(node.property.name)
          && node.object?.type === 'Identifier'
          && HOLDING_NAMES.has(node.object.name)) {
        const line = node.loc.start.line;
        hits.push({ file: rel, line, text: (lines[line - 1] ?? '').trim() });
      }
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object' && v.type) visit(v);
      }
    })(ast);
  }
  return hits;
}

describe('instrument-read gate (design 94 §5.2)', () => {

  test('no direct read of an instrument-level field outside `instrumentOf`', () => {
    const hits = directInstrumentReads();
    const shown = hits.map(h => `${h.file}:${h.line}  ${h.text}`);
    assert.deepEqual(shown, [],
      'instrument-level fields must be read through `instrumentOf(h, securities)`, so that\n'
      + 'design 94 Option C changes one function instead of every consumer:\n\n'
      + `  ${shown.join('\n  ')}\n\n`
      + 'If the site genuinely cannot reach a registry, it still reads through `instrumentOf(h)` —\n'
      + 'the one-argument form is the identity under Option A — and goes on step 2\'s punch list.');
  });

  test('the gate is not vacuous — it can see the reads it allows', () => {
    const all = directInstrumentReads({ includeAllowlisted: true });
    const allowed = all.filter(h => ALLOWLIST.has(h.file));
    assert.ok(allowed.length > 0,
      'the allowlisted files should still contain direct reads; if they do not, the detector '
      + 'has stopped matching and this gate is passing for the wrong reason');
  });

  test('every allowlist entry names a real file and carries a reason', () => {
    for (const [rel, why] of ALLOWLIST) {
      assert.ok(fs.existsSync(path.join(SRC, rel)), `allowlisted file no longer exists: ${rel}`);
      assert.ok(why && why.length > 40, `allowlist entry '${rel}' needs a reason, not a note`);
    }
  });
});
