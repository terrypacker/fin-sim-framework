/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/** A Roth ranked ahead of taxed money in the drawdownPriority walk is surfaced, nothing else is. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rothAheadOfTaxed, drawdownOrderAdvisory, drawTaxClassOf, DRAW_TAX_CLASS }
  from '../../src/finance/services/drawdown-order-advisory.js';

const acct = (stateKey, type, drawdownPriority) => ({ stateKey, name: stateKey, type, drawdownPriority });

test('DOA-1: a Roth ahead of a brokerage and an IRA is reported, with both named in walk order', () => {
  const roth = acct('roth', 'roth', 3);
  const accts = [acct('savings', 'savings', 1), roth, acct('ira', 'ira', 5), acct('broker', 'brokerage', 4)];
  const hits = rothAheadOfTaxed(accts);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].before.map(b => b.account.stateKey), ['broker', 'ira']);
  assert.match(drawdownOrderAdvisory(roth, accts), /^Spent before broker \(4\), ira \(5\)\./);
  // …and from the taxed side.
  assert.match(drawdownOrderAdvisory(accts[3], accts), /^roth \(3\) is spent before this account/);
});

test('DOA-2: the usual order, ties, unranked accounts and deferred-before-taxable say nothing', () => {
  const usual = [acct('broker', 'brokerage', 4), acct('ira', 'ira', 5), acct('roth', 'roth', 6)];
  assert.deepEqual(rothAheadOfTaxed(usual), []);
  assert.deepEqual(rothAheadOfTaxed([acct('roth', 'roth', 4), acct('broker', 'brokerage', 4)]), [], 'a tie is not "ahead"');
  assert.deepEqual(rothAheadOfTaxed([acct('roth', 'roth', 1), acct('broker', 'brokerage', null)]), [], 'excluded from the walk');
  assert.deepEqual(rothAheadOfTaxed([acct('ira', 'ira', 1), acct('broker', 'brokerage', 2)]), [], 'bracket-filling is a choice');
  assert.deepEqual(rothAheadOfTaxed([acct('roth', 'roth', 1), acct('super', 'super', 2)]), [], 'super is not ranked');
  assert.equal(drawdownOrderAdvisory(usual[2], usual), null);
});

test('DOA-3: the tax classes', () => {
  assert.equal(drawTaxClassOf({ type: 'roth' }), DRAW_TAX_CLASS.TAX_FREE);
  assert.equal(drawTaxClassOf({ type: '401k' }), DRAW_TAX_CLASS.TAX_DEFERRED);
  assert.equal(drawTaxClassOf({ type: 'brokerage' }), DRAW_TAX_CLASS.TAXABLE);
  assert.equal(drawTaxClassOf({ type: 'savings' }), null);
  assert.equal(drawTaxClassOf({ type: 'super' }), null);
});
