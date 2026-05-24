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
 * state-registry.test.mjs
 *
 * Unit tests for StateRegistry — role + ownerId based account lookup facade.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { StateRegistry }  from '../../src/finance/services/state-registry.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { Account, USD }   from '../../src/finance/assets/account.js';
import { RothAccount, TraditionalIRAAccount } from '../../src/finance/assets/investment-account.js';
import { ACCOUNT_ROLES }  from '../../src/finance/state/account-roles.js';
import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAccountService() {
  const graph = new Graph();
  return new AccountService(graph, new GraphQueryApi(graph), new EventBus());
}

/**
 * Build a StateRegistry with the given accounts pre-registered.
 * Simulates SimulationState._assignAccount by setting account.stateKey directly.
 */
function makeRegistry(accounts) {
  const svc = makeAccountService();
  const state = {};
  for (const [key, account] of Object.entries(accounts)) {
    account.stateKey = key;
    svc.createAccount(account);
    state[key] = account;
  }
  return { registry: new StateRegistry({ accountService: svc }), state };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('StateRegistry.getAccount: returns account matching role + ownerId', () => {
  const primaryRoth = new RothAccount(80_000, {
    role:    ACCOUNT_ROLES.ROTH,
    ownerId: 'primary',
    country: 'US',
    currency: USD,
  });
  const spouseRoth = new RothAccount(40_000, {
    role:    ACCOUNT_ROLES.ROTH,
    ownerId: 'spouse',
    country: 'US',
    currency: USD,
  });
  const { registry, state } = makeRegistry({
    rothAccount:       primaryRoth,
    spouseRothAccount: spouseRoth,
  });

  const found = registry.getAccount(state, ACCOUNT_ROLES.ROTH, 'primary');
  assert.ok(found, 'should find primary roth account');
  assert.strictEqual(found.balance, 80_000);
});

test('StateRegistry.getAccount: returns spouse account when ownerId=spouse', () => {
  const primaryRoth = new RothAccount(80_000, {
    role: ACCOUNT_ROLES.ROTH, ownerId: 'primary', country: 'US', currency: USD,
  });
  const spouseRoth = new RothAccount(40_000, {
    role: ACCOUNT_ROLES.ROTH, ownerId: 'spouse', country: 'US', currency: USD,
  });
  const { registry, state } = makeRegistry({
    rothAccount: primaryRoth, spouseRothAccount: spouseRoth,
  });

  const found = registry.getAccount(state, ACCOUNT_ROLES.ROTH, 'spouse');
  assert.ok(found, 'should find spouse roth account');
  assert.strictEqual(found.balance, 40_000);
});

test('StateRegistry.getAccount: ownerId=null matches first registered account', () => {
  const acc = new Account(5_000, { role: ACCOUNT_ROLES.US_SAVINGS, country: 'US', currency: USD });
  const { registry, state } = makeRegistry({ usSavingsAccount: acc });

  const found = registry.getAccount(state, ACCOUNT_ROLES.US_SAVINGS, null);
  assert.ok(found);
  assert.strictEqual(found.balance, 5_000);
});

test('StateRegistry.getAccount: returns null for unknown role', () => {
  const { registry, state } = makeRegistry({});
  const found = registry.getAccount(state, 'nonexistent-role', null);
  assert.strictEqual(found, null);
});

test('StateRegistry.getStateKey: returns stateKey matching role + ownerId', () => {
  const primaryIra = new TraditionalIRAAccount(200_000, {
    role: ACCOUNT_ROLES.IRA, ownerId: 'primary', country: 'US', currency: USD,
  });
  const spouseIra = new TraditionalIRAAccount(100_000, {
    role: ACCOUNT_ROLES.IRA, ownerId: 'spouse', country: 'US', currency: USD,
  });
  const { registry } = makeRegistry({
    iraAccount: primaryIra, spouseIraAccount: spouseIra,
  });

  assert.strictEqual(registry.getStateKey(ACCOUNT_ROLES.IRA, 'primary'), 'iraAccount');
  assert.strictEqual(registry.getStateKey(ACCOUNT_ROLES.IRA, 'spouse'),  'spouseIraAccount');
});

test('StateRegistry.getStateKey: returns null for unknown role', () => {
  const { registry } = makeRegistry({});
  assert.strictEqual(registry.getStateKey('no-such-role', null), null);
});

test('StateRegistry.getAccounts: filters by country', () => {
  const usAcc = new Account(10_000, { role: ACCOUNT_ROLES.US_SAVINGS, country: 'US', currency: USD });
  const auAcc = new Account(20_000, { role: ACCOUNT_ROLES.AU_SAVINGS, country: 'AU', currency: 'AUD' });
  const { registry, state } = makeRegistry({
    usSavingsAccount: usAcc, auSavingsAccount: auAcc,
  });

  const usAccounts = registry.getAccounts(state, { country: 'US' });
  assert.strictEqual(usAccounts.length, 1);
  assert.strictEqual(usAccounts[0].balance, 10_000);

  const auAccounts = registry.getAccounts(state, { country: 'AU' });
  assert.strictEqual(auAccounts.length, 1);
  assert.strictEqual(auAccounts[0].balance, 20_000);
});

test('StateRegistry.getAccounts: filters by role returning multiple owners', () => {
  const primaryRoth = new RothAccount(80_000, {
    role: ACCOUNT_ROLES.ROTH, ownerId: 'primary', country: 'US', currency: USD,
  });
  const spouseRoth = new RothAccount(40_000, {
    role: ACCOUNT_ROLES.ROTH, ownerId: 'spouse', country: 'US', currency: USD,
  });
  const { registry, state } = makeRegistry({
    rothAccount: primaryRoth, spouseRothAccount: spouseRoth,
  });

  const roths = registry.getAccounts(state, { role: ACCOUNT_ROLES.ROTH });
  assert.strictEqual(roths.length, 2);
  const balances = roths.map(a => a.balance).sort((a, b) => a - b);
  assert.deepStrictEqual(balances, [40_000, 80_000]);
});

test('StateRegistry.getAccounts: filters by ownerId', () => {
  const primaryRoth = new RothAccount(80_000, {
    role: ACCOUNT_ROLES.ROTH, ownerId: 'primary', country: 'US', currency: USD,
  });
  const spouseRoth = new RothAccount(40_000, {
    role: ACCOUNT_ROLES.ROTH, ownerId: 'spouse', country: 'US', currency: USD,
  });
  const primaryIra = new TraditionalIRAAccount(200_000, {
    role: ACCOUNT_ROLES.IRA, ownerId: 'primary', country: 'US', currency: USD,
  });
  const { registry, state } = makeRegistry({
    rothAccount: primaryRoth, spouseRothAccount: spouseRoth, iraAccount: primaryIra,
  });

  const spouseAccounts = registry.getAccounts(state, { ownerId: 'spouse' });
  assert.strictEqual(spouseAccounts.length, 1);
  assert.strictEqual(spouseAccounts[0].balance, 40_000);

  const primaryAccounts = registry.getAccounts(state, { ownerId: 'primary' });
  assert.strictEqual(primaryAccounts.length, 2);
});

test('StateRegistry.getAccounts: no filters returns all registered accounts present in state', () => {
  const acc1 = new Account(1_000, { role: ACCOUNT_ROLES.US_SAVINGS, country: 'US', currency: USD });
  const acc2 = new Account(2_000, { role: ACCOUNT_ROLES.AU_SAVINGS, country: 'AU', currency: 'AUD' });
  const { registry, state } = makeRegistry({
    usSavingsAccount: acc1, auSavingsAccount: acc2,
  });

  const all = registry.getAccounts(state);
  assert.strictEqual(all.length, 2);
});
