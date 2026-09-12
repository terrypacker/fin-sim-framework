/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

// field-row.test.mjs — design 101 R2: the shared row builders and sparkline.

import assert from 'node:assert/strict';
import { buildFieldRow, buildStaticRow, renderSparkline } from '../../src/visualization/state/field-row.js';

test('buildFieldRow: [toggle][label][sparkline][value], path on the label hover', () => {
  const toggle = document.createElement('input');
  let clicked = 0;
  const row = buildFieldRow({ path: 'acct.balance', label: 'Balance', valueText: '$5.00',
    history: [1, 2, 3], toggle, onClick: () => clicked++ });
  assert.strictEqual(row.className, 'lsp-metric-row lsp-clickable-row');
  assert.strictEqual(row.children[0], toggle);
  assert.strictEqual(row.querySelector('.lsp-metric-label').title, 'acct.balance');
  assert.ok(row.querySelector('.lsp-metric-spark svg'), 'sparkline drawn');
  assert.strictEqual(row.querySelector('.lsp-metric-value').textContent, '$5.00');
  row.click();
  assert.strictEqual(clicked, 1);
});

test('buildFieldRow: an untyped value is marked and carries its hover', () => {
  const row = buildFieldRow({ path: 'x', label: 'X', valueText: '1.00', untyped: true, valueTitle: 'No schema entry' });
  const val = row.querySelector('.lsp-metric-value');
  assert.ok(val.classList.contains('is-untyped'));
  assert.strictEqual(val.title, 'No schema entry');
  assert.strictEqual(row.querySelector('.lsp-metric-spark svg'), null, 'no history, no sparkline');
});

test('buildStaticRow: no toggle, no sparkline, path on hover', () => {
  const row = buildStaticRow({ label: 'Residency', valueText: 'AU', path: 'people.p1.residency' });
  assert.ok(row.classList.contains('lsp-static-row'));
  assert.strictEqual(row.querySelector('input'), null);
  assert.strictEqual(row.querySelector('.lsp-metric-label').title, 'people.p1.residency');
  assert.strictEqual(row.querySelector('.lsp-metric-value').textContent, 'AU');
});

test('renderSparkline: null below two finite values; colour follows the trend', () => {
  assert.strictEqual(renderSparkline([5]), null);
  assert.strictEqual(renderSparkline([5, NaN]), null);
  assert.strictEqual(renderSparkline([1, 2]).querySelector('polyline').getAttribute('stroke'), '#34d399');
  assert.strictEqual(renderSparkline([2, 1]).querySelector('polyline').getAttribute('stroke'), '#f87171');
});

test('renderSparkline: a long buffer is sampled down, keeping the last point', () => {
  const values = Array.from({ length: 5000 }, (_, i) => i);
  const svg = renderSparkline(values);
  const pts = svg.querySelector('polyline').getAttribute('points').split(' ');
  assert.strictEqual(pts.length, 64);
  const last = pts.at(-1).split(',');
  const dot  = svg.querySelector('circle');
  assert.deepStrictEqual([dot.getAttribute('cx'), dot.getAttribute('cy')], last, 'the dot marks the true last value');
});
