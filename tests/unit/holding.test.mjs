/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { Holding }       from '../../src/finance/holdings/holding.js';
import { ALLOCATION }    from '../../src/finance/holdings/allocation.js';
import {
  DEFAULT_ALLOCATION_BY_ROLE,
  DEFAULT_ALLOCATION_BY_TYPE,
  resolveDefaultAllocation,
  resolveRateKey,
} from '../../src/finance/holdings/default-allocations.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { RATE_KEYS }     from '../../src/finance/economic-regimes/rate-keys.js';

// ─── Holding constructor ───────────────────────────────────────────────────────

test('Holding: constructor defaults', () => {
  const h = new Holding({ allocation: ALLOCATION.EQUITY });
  assert.equal(h.id, null);
  assert.equal(h.allocation, 'EQUITY');
  assert.equal(h.marketValue, 0);
  assert.equal(h.costBasis, 0);
  assert.equal(h.purchaseDate, null);
  assert.equal(h.rateKey, null);
  assert.equal(h.label, '');
});

test('Holding: constructor accepts all fields', () => {
  const date = new Date(Date.UTC(2025, 5, 15));
  const h = new Holding({
    id:           'hld42',
    allocation:   ALLOCATION.BOND,
    marketValue:  10000,
    costBasis:    9500,
    purchaseDate: date,
    rateKey:      'FIXED_INCOME_US',
    label:        'BND',
  });
  assert.equal(h.id, 'hld42');
  assert.equal(h.allocation, 'BOND');
  assert.equal(h.marketValue, 10000);
  assert.equal(h.costBasis, 9500);
  assert.deepEqual(h.purchaseDate, date);
  assert.equal(h.rateKey, 'FIXED_INCOME_US');
  assert.equal(h.label, 'BND');
});

// ─── toJSON / fromJSON round-trip ─────────────────────────────────────────────

test('Holding: toJSON includes __type and serializes date', () => {
  const date = new Date(Date.UTC(2025, 5, 15));
  const h = new Holding({
    id: 'hld1', allocation: ALLOCATION.EQUITY,
    marketValue: 100, costBasis: 90, purchaseDate: date,
    rateKey: 'EQUITY_US', label: 'ITOT',
  });
  const json = h.toJSON();
  assert.equal(json.__type, 'Holding');
  assert.equal(json.purchaseDate, date.toISOString());
});

test('Holding: round-trip preserves all fields', () => {
  const date = new Date(Date.UTC(2025, 5, 15));
  const original = new Holding({
    id: 'hld1', allocation: ALLOCATION.BOND,
    marketValue: 1234.56, costBasis: 1200,
    purchaseDate: date, rateKey: 'FIXED_INCOME_US', label: 'BND',
  });
  const restored = Holding.fromJSON(original.toJSON());
  assert.equal(restored.id, original.id);
  assert.equal(restored.allocation, original.allocation);
  assert.equal(restored.marketValue, original.marketValue);
  assert.equal(restored.costBasis, original.costBasis);
  assert.equal(restored.purchaseDate.toISOString(), date.toISOString());
  assert.equal(restored.rateKey, original.rateKey);
  assert.equal(restored.label, original.label);
});

test('Holding: round-trip handles null purchaseDate', () => {
  const h = new Holding({ allocation: ALLOCATION.CASH, marketValue: 50 });
  const restored = Holding.fromJSON(h.toJSON());
  assert.equal(restored.purchaseDate, null);
});

// ─── ALLOCATION enum ──────────────────────────────────────────────────────────

test('ALLOCATION: frozen enum with 4 values', () => {
  assert.equal(Object.keys(ALLOCATION).length, 4);
  assert.equal(ALLOCATION.EQUITY, 'EQUITY');
  assert.equal(ALLOCATION.BOND,   'BOND');
  assert.equal(ALLOCATION.CASH,   'CASH');
  assert.equal(ALLOCATION.OTHER,  'OTHER');
  assert.throws(() => { ALLOCATION.NEW = 'NEW'; }, /Cannot|read only/);
});

// ─── Default allocation resolution ────────────────────────────────────────────

test('resolveDefaultAllocation: ROTH role → EQUITY', () => {
  assert.equal(resolveDefaultAllocation({ role: ACCOUNT_ROLES.ROTH }), 'EQUITY');
});

test('resolveDefaultAllocation: FIXED_INCOME role → BOND (role wins over type)', () => {
  // FIXED_INCOME accounts are backed by BrokerageAccount in the codebase;
  // type=brokerage would map to EQUITY but role=fixed-income wins.
  assert.equal(
    resolveDefaultAllocation({ role: ACCOUNT_ROLES.FIXED_INCOME, type: 'brokerage' }),
    'BOND'
  );
});

test('resolveDefaultAllocation: AU_FIXED_INCOME role → BOND', () => {
  assert.equal(resolveDefaultAllocation({ role: ACCOUNT_ROLES.AU_FIXED_INCOME }), 'BOND');
});

test('resolveDefaultAllocation: SAVINGS account → CASH', () => {
  assert.equal(resolveDefaultAllocation({ type: 'savings' }), 'CASH');
});

test('resolveDefaultAllocation: no role/type → OTHER', () => {
  assert.equal(resolveDefaultAllocation({}), 'OTHER');
  assert.equal(resolveDefaultAllocation(null), 'OTHER');
});

test('resolveDefaultAllocation: role wins over type', () => {
  // Hypothetical: ROTH role on a savings-type account → EQUITY (role wins)
  assert.equal(
    resolveDefaultAllocation({ role: ACCOUNT_ROLES.ROTH, type: 'savings' }),
    'EQUITY'
  );
});

// ─── rateKey resolution ───────────────────────────────────────────────────────

test('resolveRateKey: role-keyed lookup wins', () => {
  assert.equal(resolveRateKey('US', 'EQUITY', ACCOUNT_ROLES.ROTH), RATE_KEYS.EQUITY_US);
  assert.equal(resolveRateKey('AU', 'EQUITY', ACCOUNT_ROLES.SUPER), RATE_KEYS.EQUITY_AU);
  assert.equal(resolveRateKey('US', 'BOND', ACCOUNT_ROLES.FIXED_INCOME), RATE_KEYS.FIXED_INCOME_US);
});

test('resolveRateKey: country × allocation fallback', () => {
  assert.equal(resolveRateKey('US', 'EQUITY'), RATE_KEYS.EQUITY_US);
  assert.equal(resolveRateKey('US', 'BOND'),   RATE_KEYS.FIXED_INCOME_US);
  assert.equal(resolveRateKey('US', 'CASH'),   RATE_KEYS.SAVINGS_US);
  assert.equal(resolveRateKey('AU', 'EQUITY'), RATE_KEYS.EQUITY_AU);
  assert.equal(resolveRateKey('AU', 'BOND'),   RATE_KEYS.FIXED_INCOME_AU);
  assert.equal(resolveRateKey('AU', 'CASH'),   RATE_KEYS.SAVINGS_AU);
});

test('resolveRateKey: OTHER allocation → null (caller supplies)', () => {
  assert.equal(resolveRateKey('US', 'OTHER'), null);
});

test('resolveRateKey: unknown country → null', () => {
  assert.equal(resolveRateKey('XX', 'EQUITY'), null);
});

// ─── Map coverage ─────────────────────────────────────────────────────────────

test('DEFAULT_ALLOCATION_BY_ROLE: covers every holdings-bearing ACCOUNT_ROLE', () => {
  // Loan (liability) roles hold no asset allocation — they carry no holdings
  // (design 54); the bootstrap skips them, so no default allocation is needed.
  const LIABILITY_ROLES = new Set([ACCOUNT_ROLES.US_LOAN, ACCOUNT_ROLES.AU_LOAN]);
  for (const role of Object.values(ACCOUNT_ROLES)) {
    if (LIABILITY_ROLES.has(role)) continue;
    assert.ok(DEFAULT_ALLOCATION_BY_ROLE[role], `missing default allocation for role: ${role}`);
  }
});

test('DEFAULT_ALLOCATION_BY_TYPE: covers every ACCOUNT_TYPE', () => {
  // Imported here to keep the test self-contained.
  const types = ['checking', 'savings', 'brokerage', '401k', 'roth', 'ira', 'super'];
  for (const t of types) {
    assert.ok(DEFAULT_ALLOCATION_BY_TYPE[t], `missing default allocation for type: ${t}`);
  }
});
