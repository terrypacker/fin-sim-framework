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
 * Lightweight fixtures for isolated reducer postcondition tests.
 *
 * These intentionally avoid standing up a ScenarioCompiler / ServiceRegistry per
 * row — they build the minimal plain-data state an account-module reducer reads.
 * Modeled on the inline helpers in holdings-actions.test.mjs.
 * See design/37-reducer-test-framework.md.
 */

import { Holding } from '../../src/finance/holdings/holding.js';
import { AccountService } from '../../src/finance/services/account-service.js';

const CURRENCY = {
  USD: { code: 'USD', symbol: '$' },
  AUD: { code: 'AUD', symbol: 'A$' },
};

let _holdingSeq = 0;

/**
 * Build a single account state node (plain data) with synced balance.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.stateKey='testAccount']
 * @param {string}  [opts.id='acc1']
 * @param {string}  [opts.country='US']
 * @param {string}  [opts.currency='USD']      - 'USD' | 'AUD'
 * @param {string|null} [opts.role=null]
 * @param {Array}   [opts.holdings]            - Holding instances or plain opts;
 *                                               defaults to one holding sized to `balance`.
 * @param {number}  [opts.balance=1000]        - used to size the default holding
 * @returns {object} an account node (NOT wrapped in a state tree)
 */
export function makeAccount(opts = {}) {
  const {
    stateKey = 'testAccount',
    id = 'acc1',
    country = 'US',
    currency = 'USD',
    role = null,
    balance = 1000,
  } = opts;

  const holdings = (opts.holdings ?? [{ marketValue: balance, costBasis: balance }]).map(h =>
    h instanceof Holding ? h : new Holding({ id: `h${++_holdingSeq}`, ...h }),
  );

  return {
    id,
    stateKey,
    balance: +holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0).toFixed(2),
    country,
    currency: CURRENCY[currency] ?? CURRENCY.USD,
    role,
    holdings,
  };
}

/**
 * Build a state tree from one or more account specs. Accepts a single spec, an
 * array of specs, or pre-built account nodes; keys each by its `stateKey`.
 *
 * @example makeAccountState({ role: ACCOUNT_ROLES.ROTH, balance: 5000 })
 * @example makeAccountState([{ stateKey: 'src', balance: 1000 }, { stateKey: 'dst', balance: 0 }])
 */
export function makeAccountState(specs = {}) {
  const list = Array.isArray(specs) ? specs : [specs];
  const state = {};
  for (const spec of list) {
    const account = isAccountNode(spec) ? spec : makeAccount(spec);
    state[account.stateKey] = account;
  }
  return state;
}

// A *pre-built* account node (vs a spec) has a synced numeric balance. Requiring
// it here keeps a raw spec like { stateKey, holdings:[…] } (no balance) flowing
// through makeAccount so its balance gets computed.
function isAccountNode(node) {
  return node && typeof node === 'object'
    && Array.isArray(node.holdings) && node.stateKey
    && typeof node.balance === 'number';
}

/**
 * Build a plain-data action. Most reducers read action fields directly, so a
 * plain object with `{ type, ...props }` is sufficient for postcondition tests.
 */
export function makeAction(type, props = {}) {
  return { type, ...props };
}

/** A Holding factory with a stable auto-id (handy for multi-holding specs). */
export function makeHolding(opts = {}) {
  return new Holding({ id: `h${++_holdingSeq}`, ...opts });
}

/**
 * Services bundle for service-backed reducers. Uses the *real* AccountService so
 * `transaction()` faithfully syncs holdings (the §4.4 sync these reducers rely on
 * is in transaction(), not the reducer) — a naive stub would test the stub, not
 * the reducer. `stateRegistry.getStateKey` is overridable per test.
 *
 * NOTE: AccountService.transaction() mutates the account in place, so reducers
 * built on it are NOT I1-pure — pass `checkNoMutation: false` to runReducer and
 * snapshot the pre-state with structuredClone for conservation checks.
 */
export function makeServices({ stateKeyByRole = {} } = {}) {
  return {
    accountService: new AccountService(),
    stateRegistry: {
      getStateKey: (role) => stateKeyByRole[role] ?? role,
    },
  };
}

/** A minimal state.people projection (for residency-gated reducers). */
export function makePeople(spec = { residency: 'US', residencyState: 'NE' }) {
  return { p1: { ...spec } };
}
