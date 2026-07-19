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
 * display-name-resolver.test.mjs — design 70 P1.
 * StateSchemaRegistry.displayNameFor / accountBalanceKeys: the stateKey → human
 * label layer. The stateKey stays the identity; only the rendered label changes,
 * so the resolver must be derived (never serialized), collision-safe, and must
 * return null — not a guess — for keys that name no record.
 */

import { test }   from 'node:test';
import assert     from 'node:assert/strict';

import { StateSchemaRegistry } from '../../src/finance/services/state-schema-registry.js';
import { CheckingAccount, SavingsAccount } from '../../src/finance/assets/account.js';
import { RealProperty }        from '../../src/finance/assets/real-property.js';
import { Person }              from '../../src/finance/person.js';

const USD = { code: 'USD', symbol: '$' };

function acct(name, opts = {}) {
  return new CheckingAccount(1000, { name, country: 'US', currency: USD, ...opts });
}

// ── Base label ──────────────────────────────────────────────────────────────

test('displayNameFor: country-prefixed record name', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavings2Account', acct('Shared Checking'));
  assert.equal(reg.displayNameFor('usSavings2Account'), 'US Shared Checking');
});

test('displayNameFor: null for an unregistered key so callers fall back to toLabel', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', acct('Savings'));
  assert.equal(reg.displayNameFor('metrics.netWorth'), null);
  assert.equal(reg.displayNameFor('cumulativeTaxesPaid'), null);
  assert.equal(reg.displayNameFor(''), null);
  assert.equal(reg.displayNameFor(undefined), null);
});

test('displayNameFor: nameless record falls back to its own stateKey', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', acct(''));
  assert.equal(reg.displayNameFor('usSavingsAccount'), 'US usSavingsAccount');
});

test('displayNameFor: countryless record renders the bare name', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('someAccount', new CheckingAccount(0, { name: 'Wallet' }));
  assert.equal(reg.displayNameFor('someAccount'), 'Wallet');
});

// ── Inherited (design 63) keys — the acute case from §1 ──────────────────────

test('displayNameFor: inherited key renders its name, not the beautified key', () => {
  const reg = new StateSchemaRegistry();
  // Inline bequest assets are plain descriptors, not model instances.
  reg.registerDisplayRecord('beq1IraAccount', { name: "Mother's IRA", country: 'US' }, 'account');
  assert.equal(reg.displayNameFor('beq1IraAccount'), "US Mother's IRA");
});

test('displayNameFor: a non-…Account inherited key still resolves', () => {
  const reg = new StateSchemaRegistry();
  reg.registerDisplayRecord('beq1_a1', { name: 'Inherited Brokerage', country: 'US' }, 'account');
  assert.equal(reg.displayNameFor('beq1_a1'), 'US Inherited Brokerage');
});

// ── Collision-only disambiguation ────────────────────────────────────────────

test('displayNameFor: unique names are NOT suffixed', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('a1', acct('Savings',   { ownerId: 'p1' }));
  reg.registerAccount('a2', acct('Brokerage', { ownerId: 'p2' }));
  reg.registerPerson(new Person('p1', new Date(Date.UTC(1970, 0, 1)), { name: 'Marge' }));
  reg.registerPerson(new Person('p2', new Date(Date.UTC(1970, 0, 1)), { name: 'Homer' }));
  assert.equal(reg.displayNameFor('a1'), 'US Savings');
  assert.equal(reg.displayNameFor('a2'), 'US Brokerage');
});

test('displayNameFor: colliding names disambiguate by owner', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('a1', acct('Savings', { ownerId: 'p1' }));
  reg.registerAccount('a2', acct('Savings', { ownerId: 'p2' }));
  // Persons register AFTER the accounts (the real loader order) — the labels
  // must be derived lazily enough to see them.
  reg.registerPerson(new Person('p1', new Date(Date.UTC(1970, 0, 1)), { name: 'Marge' }));
  reg.registerPerson(new Person('p2', new Date(Date.UTC(1970, 0, 1)), { name: 'Homer' }));
  assert.equal(reg.displayNameFor('a1'), 'US Savings · Marge');
  assert.equal(reg.displayNameFor('a2'), 'US Savings · Homer');
});

test('displayNameFor: falls back to the stateKey when the owner does not disambiguate', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount',  acct('Savings', { ownerId: 'p1' }));
  reg.registerAccount('usSavings2Account', acct('Savings', { ownerId: 'p1' }));
  reg.registerPerson(new Person('p1', new Date(Date.UTC(1970, 0, 1)), { name: 'Marge' }));
  assert.equal(reg.displayNameFor('usSavingsAccount'),  'US Savings · usSavingsAccount');
  assert.equal(reg.displayNameFor('usSavings2Account'), 'US Savings · usSavings2Account');
});

test('displayNameFor: unowned collisions fall back to the stateKey', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('a1', acct('Savings'));
  reg.registerAccount('a2', acct('Savings'));
  assert.equal(reg.displayNameFor('a1'), 'US Savings · a1');
  assert.equal(reg.displayNameFor('a2'), 'US Savings · a2');
});

test('displayNameFor: same name in different countries is not a collision', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('a1', acct('Savings'));
  reg.registerAccount('a2', new CheckingAccount(0, { name: 'Savings', country: 'AU' }));
  assert.equal(reg.displayNameFor('a1'), 'US Savings');
  assert.equal(reg.displayNameFor('a2'), 'AU Savings');
});

// ── Rename / re-registration ────────────────────────────────────────────────

test('displayNameFor: a re-registered record re-reads its current name (rename never re-keys)', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', acct('Savings'));
  assert.equal(reg.displayNameFor('usSavingsAccount'), 'US Savings');
  reg.registerAccount('usSavingsAccount', acct('Emergency Fund'));
  assert.equal(reg.displayNameFor('usSavingsAccount'), 'US Emergency Fund');
});

// ── Non-account records ─────────────────────────────────────────────────────

test('displayNameFor: real property and persons resolve too', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAsset('usHouseProperty', new RealProperty(500000, { name: 'Family Home', country: 'US' }));
  reg.registerPerson(new Person('p1', new Date(Date.UTC(1970, 0, 1)), { name: 'Marge' }));
  assert.equal(reg.displayNameFor('usHouseProperty'), 'US Family Home');
  assert.equal(reg.displayNameFor('people.p1'), 'Marge');
});

// ── accountBalanceKeys (backs the §14.6 substring retire) ───────────────────

test('accountBalanceKeys: accounts only, as .balance paths', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount',   acct('Savings'));
  reg.registerAccount('usBrokerageAccount', new SavingsAccount(0, { name: 'Brokerage', country: 'US', currency: USD }));
  reg.registerAsset('usHouseProperty', new RealProperty(500000, { name: 'Family Home', country: 'US' }));
  reg.registerPerson(new Person('p1', new Date(Date.UTC(1970, 0, 1)), { name: 'Marge' }));
  assert.deepEqual(reg.accountBalanceKeys().sort(),
    ['usBrokerageAccount.balance', 'usSavingsAccount.balance']);
});

test('accountBalanceKeys: includes a non-…Account inherited key (the §14.6 gap)', () => {
  const reg = new StateSchemaRegistry();
  reg.registerAccount('usSavingsAccount', acct('Savings'));
  reg.registerDisplayRecord('beq1_a1', { name: 'Inherited Brokerage', country: 'US' }, 'account');
  assert.ok(reg.accountBalanceKeys().includes('beq1_a1.balance'));
});

test('accountBalanceKeys: empty on a bare registry', () => {
  assert.deepEqual(new StateSchemaRegistry().accountBalanceKeys(), []);
});
