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
 * accounts-controller-create.test.mjs
 *
 * A UI-created account must be wired into the engine: every toolset selects
 * accounts by `role` and stores balances at `sim.state[stateKey]`, so a created
 * account with neither is invisible (no growth, drawdown, or net-worth entry).
 * These tests pin that AccountsController.create() stamps a role (derived from
 * type + country) and a scenario-unique camelCase stateKey.
 *
 * Run with: node --test tests/unit/accounts-controller-create.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { AccountsController } from '../../src/visualization/accounts/accounts-controller.js';

/** Minimal AccountService stub: records registrations, no graph/bus. */
function makeService() {
  const accounts = [];
  return {
    accounts,
    getAll: () => accounts,
    createAccount: (a) => { a.id = `ac${accounts.length + 1}`; accounts.push(a); return a; },
  };
}

function createCtl(seedStateKeys = []) {
  const svc = makeService();
  for (const k of seedStateKeys) svc.accounts.push({ stateKey: k });
  return { ctl: new AccountsController({ accountService: svc }), svc };
}

test('create: US savings account gets the us-savings role and usSavingsAccount stateKey', () => {
  const { ctl } = createCtl();
  const a = ctl.create({ type: 'savings', name: 'My Savings', balance: 1000, country: 'US', ownerId: 'primary' });
  assert.strictEqual(a.role, 'us-savings');
  assert.strictEqual(a.stateKey, 'usSavingsAccount');
});

test('create: AU savings account gets the au-savings role', () => {
  const { ctl } = createCtl();
  const a = ctl.create({ type: 'savings', name: 'AU Cash', balance: 500, country: 'AU', ownerId: 'primary' });
  assert.strictEqual(a.role, 'au-savings');
  assert.strictEqual(a.stateKey, 'auSavingsAccount');
});

test('create: brokerage maps to the stock role by country', () => {
  const { ctl } = createCtl();
  const us = ctl.create({ type: 'brokerage', name: 'US Broker', balance: 100, country: 'US', ownerId: 'primary' });
  const au = ctl.create({ type: 'brokerage', name: 'AU Broker', balance: 100, country: 'AU', ownerId: 'primary' });
  assert.strictEqual(us.role, 'us-stock');
  assert.strictEqual(au.role, 'au-stock');
});

test('create: retirement types map to fixed roles regardless of country', () => {
  const { ctl } = createCtl();
  assert.strictEqual(ctl.create({ type: '401k',  name: 'k',  balance: 0, ownerId: 'primary' }).role, 'k401');
  assert.strictEqual(ctl.create({ type: 'roth',  name: 'r',  balance: 0, ownerId: 'primary' }).role, 'roth-ira');
  assert.strictEqual(ctl.create({ type: 'ira',   name: 'i',  balance: 0, ownerId: 'primary' }).role, 'ira');
  assert.strictEqual(ctl.create({ type: 'super', name: 's',  balance: 0, ownerId: 'primary' }).role, 'super');
});

test('create: offset account gets the country offset role', () => {
  const { ctl } = createCtl();
  const a = ctl.create({ type: 'offset', name: 'Offset', balance: 0, country: 'AU', ownerId: 'primary' });
  assert.strictEqual(a.role, 'au-offset');
  assert.strictEqual(a.stateKey, 'auOffsetAccount');
});

test('create: stateKey is disambiguated against existing keys (incl. prebuilt defaults)', () => {
  // usStockAccount is a prebuilt default — a second US brokerage must not collide.
  const { ctl } = createCtl(['usStockAccount']);
  const a = ctl.create({ type: 'brokerage', name: 'Shared Brokerage', balance: 100, country: 'US', ownerId: 'primary' });
  assert.strictEqual(a.stateKey, 'usStock2Account');
});

test('create: two created accounts of the same role/owner get distinct stateKeys', () => {
  const { ctl } = createCtl();
  const a = ctl.create({ type: 'brokerage', name: 'B1', balance: 1, country: 'US', ownerId: 'primary' });
  const b = ctl.create({ type: 'brokerage', name: 'B2', balance: 1, country: 'US', ownerId: 'primary' });
  assert.strictEqual(a.stateKey, 'usStockAccount');
  assert.strictEqual(b.stateKey, 'usStock2Account');
  assert.notStrictEqual(a.stateKey, b.stateKey);
});

test('create: a non-primary owner is reflected in the stateKey', () => {
  const { ctl } = createCtl();
  const a = ctl.create({ type: '401k', name: 'Spouse 401k', balance: 0, ownerId: 'spouse' });
  assert.strictEqual(a.stateKey, 'k401SpouseAccount');
});

test('create: isTransactionAccount flag rides the create payload (design 55 §7)', () => {
  const { ctl } = createCtl();
  const flagged = ctl.create({ type: 'checking', name: 'Shared Checking', balance: 5000,
    country: 'US', ownerId: 'primary', isTransactionAccount: true });
  assert.strictEqual(flagged.isTransactionAccount, true);
  // Absent flag defaults to false (Account ctor default), never undefined.
  const plain = ctl.create({ type: 'savings', name: 'Plain', balance: 100, country: 'US', ownerId: 'primary' });
  assert.strictEqual(plain.isTransactionAccount, false);
});

test('update: isTransactionAccount is coerced to a boolean', () => {
  const svc = makeService();
  const acct = { id: 'ac1', stateKey: 'usChecking', isTransactionAccount: false };
  svc.accounts.push(acct);
  svc.updateAccount = (id, changes) => { Object.assign(acct, changes); return acct; };
  const ctl = new AccountsController({ accountService: svc });
  const out = ctl.update('ac1', { isTransactionAccount: 'on' });
  assert.strictEqual(out.isTransactionAccount, true);
});
