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
 * pool-shape-expansion-hygiene.test.mjs — design 114 §5.1's static gate.
 *
 * A shape may be a DELTA (`extends` + its own rows). A reader that looks at `liquidityShapes`
 * raw sees none of the pools and flows the shape inherits, and it fails QUIETLY: an axis finds
 * no pool to scale, a gate override finds no flow, a hygiene row calls an inherited pool absent.
 * Every content read therefore goes through `pool-shape-expansion.js`, and this gate is what
 * stops the next reader from going around it.
 *
 * A read is ALLOWED when it is:
 *   · inside `pool-shape-expansion.js` (the one module that knows what a delta is);
 *   · a PASS-THROUGH — the value of an object property itself named `liquidityShapes`, i.e. a
 *     bag being built for a helper that expands it (`{ liquidityShapes: authored.liquidityShapes }`);
 *   · on a line marked `shapes: raw-ok (<reason>)` — ids only, a delta's own cells, the editor's
 *     authored value. The reason is required.
 *
 * Detected: `x.liquidityShapes`, `x['liquidityShapes']`, `authoredParamValue(cfg,
 * 'liquidityShapes')`, and `… === 'liquidityShapes'` (a `params.find` by name).
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import fs                 from 'node:fs';
import path               from 'node:path';
import { fileURLToPath }  from 'node:url';
import { parse }          from '@babel/parser';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const KEY = 'liquidityShapes';
const HOME = 'finance/pools/pool-shape-expansion.js';
const MARKER = /shapes: raw-ok \([^)]{3,}\)/;

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith('.js') && p !== path.join(SRC, 'index.js')) out.push(p);
  }
  return out;
}

const isKeyLiteral = (n) => n?.type === 'StringLiteral' && n.value === KEY;

/** Is `node` a READ of the param? */
function isRead(node) {
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    return node.computed ? isKeyLiteral(node.property)
      : node.property?.type === 'Identifier' && node.property.name === KEY;
  }
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    const callee = node.callee;
    const name = callee?.type === 'Identifier' ? callee.name : callee?.property?.name;
    return name === 'authoredParamValue' && node.arguments.some(isKeyLiteral);
  }
  if (node.type === 'BinaryExpression' && (node.operator === '===' || node.operator === '==')) {
    return isKeyLiteral(node.left) || isKeyLiteral(node.right);
  }
  return false;
}

/** A pass-through: the read IS the value of a `liquidityShapes:` property. */
function isPassThrough(node, parent) {
  if (parent?.type !== 'ObjectProperty' || parent.value !== node) return false;
  const k = parent.key;
  return (k?.type === 'Identifier' && k.name === KEY) || isKeyLiteral(k);
}

function rawReads({ includeHome = false } = {}) {
  const hits = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel === HOME && !includeHome) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes(KEY)) continue;
    const lines = src.split('\n');
    let ast;
    try { ast = parse(src, { sourceType: 'module', plugins: ['classProperties'] }); }
    catch (err) { assert.fail(`could not parse ${file}: ${err.message}`); }

    (function visit(node, parent) {
      if (!node || typeof node !== 'object') return;
      if (node.type && isRead(node) && !isPassThrough(node, parent)) {
        const line = node.loc.start.line;
        const text = lines[line - 1] ?? '';
        if (!MARKER.test(text)) hits.push({ file: rel, line, text: text.trim() });
      }
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
        const v = node[key];
        if (Array.isArray(v)) v.forEach(c => visit(c, node));
        else if (v && typeof v === 'object' && v.type) visit(v, node);
      }
    })(ast, null);
  }
  return hits;
}

describe('pool shape expansion gate (design 114 §5.1)', () => {

  test('no raw read of `liquidityShapes` outside the expansion module', () => {
    const shown = rawReads().map(h => `${h.file}:${h.line}  ${h.text}`);
    assert.deepEqual(shown, [],
      'a shape may be a delta (design 114), so its CONTENTS must be read through\n'
      + '`pool-shape-expansion.js` (poolGraphEntries / poolGraphFor / expandedShapesOf), or the\n'
      + 'reader silently misses every inherited pool and flow:\n\n'
      + `  ${shown.join('\n  ')}\n\n`
      + 'If the line only needs shape IDS, or is the authored value an editor writes, mark it\n'
      + '`// shapes: raw-ok (<reason>)`.');
  });

  test('the gate is not vacuous — it sees the expansion module\'s own reads', () => {
    const home = rawReads({ includeHome: true }).filter(h => h.file === HOME);
    assert.ok(home.length > 0,
      'the expansion module reads the param itself; if the detector no longer sees that, the gate '
      + 'is passing for the wrong reason');
  });
});
