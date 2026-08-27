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
 * holding-value-write-gate.test.mjs — design 93 §4. The static gate that makes the
 * unit-vs-price distinction impossible to leave implicit.
 *
 * ── what it forbids, and why that exact shape ────────────────────────────────
 *
 * `{ ...h, marketValue: <n> }` — spreading an existing holding and overriding its market
 * value. That is the mutation form, and it is the form all eight par defects took
 * (design 66 §10.6b). It is deliberately NOT "any `marketValue:` write": constructing a
 * fresh holding with a market value is ordinary and safe, because a new lot has no par to
 * fall out of step with. Only the spread-plus-override shape can silently desynchronise a
 * field it did not mention.
 *
 * ── why a per-site annotation and not a file allow-list ──────────────────────
 *
 * A file allow-list would have to name `holdings-fifo`, `bond-maturity-reducer`,
 * `bond-ladder-reducer`, `rebalance-to-target-apply-reducer`, `account-service` and
 * `holdings-earnings` — which is most of the code that matters, and would exempt exactly
 * the files where the defects lived. An annotation is per-site, so a new raw write in an
 * already-listed file still fails, and every surviving one carries a stated reason a
 * reviewer can disagree with.
 *
 * To satisfy the gate, either:
 *
 *   1. use a primitive — `resize()` (units changed), `addValue()` (new money) or
 *      `reprice()` (price changed); see holding-utils.js; or
 *   2. annotate the site `par-reviewed: <why this cannot desynchronise par>` on the same
 *      line or within the twelve lines above it.
 *
 * The count is asserted as well as the annotations, so removing an annotation to make the
 * gate pass shows up as a drop in the expected total rather than as silence.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import fs                 from 'node:fs';
import path               from 'node:path';
import { fileURLToPath }  from 'node:url';
import { parse }          from '@babel/parser';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** Every .js under src/. */
function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Object literals that BOTH spread something and set `marketValue` — the mutation shape.
 * Returns `[{ file, line, annotated }]`.
 */
function valueWriteSites() {
  const sites = [];
  for (const file of sourceFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('marketValue')) continue;
    const lines = src.split('\n');
    let ast;
    try { ast = parse(src, { sourceType: 'module', plugins: ['classProperties'] }); }
    catch (err) { assert.fail(`could not parse ${file}: ${err.message}`); }

    (function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ObjectExpression'
          && node.properties.some(p => p.type === 'SpreadElement')
          && node.properties.some(p => p.type === 'ObjectProperty' && p.key?.name === 'marketValue')) {
        const line = node.loc.start.line;
        // The annotation may sit on the opening line or in the twelve lines above it.
        // Twelve because the reasons worth writing are several sentences long — the point
        // of the annotation is the reasoning, so the window has to fit it.
        const window = lines.slice(Math.max(0, line - 13), line + 1).join('\n');
        sites.push({
          file: path.relative(SRC, file), line,
          annotated: /par-reviewed:/.test(window),
        });
      }
      for (const key of Object.keys(node)) {
        const v = node[key];
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object' && v.type) visit(v);
      }
    })(ast);
  }
  return sites;
}

/**
 * Sites that legitimately cannot use a primitive, each annotated in source. Pinned as a
 * NUMBER so that converting one to a primitive (good) or adding a new raw write (needs a
 * decision) both show up here rather than passing quietly.
 */
const EXPECTED_ANNOTATED = 26;
// 23 → 21 at design 93 §5b. Four of §4's annotated exceptions were the SAME statement
// written four times — "there are no units to scale, so the money becomes the position" —
// and they collapsed into the `establish()` primitive. `absorbIntoRungs`' hand-written
// par rule went with the blend it existed to serve. Two new ones came back: the ladder's
// two lot CONSTRUCTIONS, which the walker now sees as spreads because they spread
// `unitiseBond`'s derived fields — and, at §5.3, HoldingTransactReducer's PATCH object,
// which gained a conditional `cpiIndexRatio` spread and so now reads as the shape too.
// 22 → 21 at §5.5: the rebalancer's and the ladder's merge sites collapsed into the one
// in `lot-compaction.js`, which is where the rule now lives for all three families.
// 21 → 22 at design 94 step 1: HoldingSplitReducer's child CONSTRUCTION gained a
// conditional `...securityId` spread (a split child is a piece of the same instrument), so
// the walker now reads it as the shape. Nothing about its par behaviour changed — it never
// carried `faceValue` — which is exactly what an annotation is for: the shape is a
// heuristic, and this is the case where the heuristic is wrong and has to be told so.
// 22 → 24 at design 94 step 3, and both for the same reason as the one above: the
// rebalancer's `_newSleeve` and `distributeHoldingsCredit`'s vintage lot are lot
// CONSTRUCTIONS that gained a conditional `...securityId` spread, so the walker now reads
// them as the shape. Neither carries a par — an equity sleeve has none and a bond FUND lot
// sets `faceValue: null` in the same literal — so there is nothing for either to desync.
// 24 → 26 at design 94 step 8, and these two are the FIRST that are not lot constructions
// wearing a spread. `corporate-action.js` builds a spun-off lot and a merged lot by writing
// `marketValue` next to `units` and `pricePerUnit` and handing the whole thing to
// `syncHolding`, which re-derives value AND par from the count in the same statement. The
// raw write is the SCALAR branch's answer; on a unitised position it is overwritten before
// the object escapes. Converting them to a primitive is not available — `reprice` and
// `resize` each move one of the two things a corporate action moves, and a spin-off moves
// both at once — which is what an annotated exception is for.

describe('holding value-write gate (design 93 §4)', () => {
  test('no unannotated `{ ...holding, marketValue }` outside the primitives', () => {
    const bad = valueWriteSites().filter(s => !s.annotated);
    assert.deepEqual(
      bad.map(s => `${s.file}:${s.line}`), [],
      'raw holding value write(s) — spreading a holding and overriding marketValue:\n'
      + bad.map(s => `    ${s.file}:${s.line}`).join('\n')
      + '\n\n  This is the shape every one of the eight par defects took (design 93 §2).\n'
      + '  Use resize() / addValue() / reprice() from holding-utils.js, or annotate the\n'
      + '  site `par-reviewed: <why this cannot desynchronise par>`.\n');
  });

  test('the annotated-exception count has not drifted', () => {
    const annotated = valueWriteSites().filter(s => s.annotated);
    assert.equal(
      annotated.length, EXPECTED_ANNOTATED,
      `${annotated.length} annotated raw writes, expected ${EXPECTED_ANNOTATED}.\n`
      + '  DOWN is good — a site was converted to a primitive; lower EXPECTED_ANNOTATED.\n'
      + '  UP means a new raw write was annotated rather than converted. That is allowed,\n'
      + '  but it is a decision, so raise the number deliberately and say why in review.\n'
      + annotated.map(s => `    ${s.file}:${s.line}`).join('\n'));
  });

  test('the gate is not vacuous — it can see the primitives themselves', () => {
    // holding-utils.js defines resize/addValue/reprice, each of which IS a spread with a
    // marketValue override. If the walker stopped finding them, it has broken and the
    // first test would pass over everything.
    const inUtils = valueWriteSites().filter(s => s.file.endsWith('holding-utils.js'));
    assert.ok(inUtils.length >= 3,
      `walker found only ${inUtils.length} write sites in holding-utils.js — it defines at `
      + 'least three (resize, addValue, reprice), so the AST walk is not working');
  });
});
