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
 * evt-rebalance-hold-only.test.mjs — the account-level `rebalanceExcluded` flag.
 *
 * House-sale study, flag A (Nov 2026): the target-allocation rebalancer sold both
 * TreasuryDirect I bonds to cash seven months after purchase, when an I bond cannot be
 * cashed in its first year. A hold-only account is left out of the rebalanced book.
 *
 * HOLD-1 is the serializer's deviation-only rule. HOLD-2 is the effect through the full
 * load path, because a record field nobody projects into state is silently inert.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { BrokerageAccount }   from '../../src/finance/assets/investment-account.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { ACCOUNT_ROLES }      from '../../src/finance/state/account-roles.js';
import { loadScenarioSim }    from '../helpers/scenario-harness.js';

test('HOLD-1: hold-only round-trips, and an ordinary account writes no key', () => {
  const plain = ScenarioSerializer._serializeAccount(new BrokerageAccount(1000, {}));
  assert.ok(!('rebalanceExcluded' in plain), 'unset ⇒ absent, so saved scenarios are unchanged');
  assert.ok(!('rebalanceExcluded' in new BrokerageAccount(1000, {})), 'and the record carries no field');

  const d = ScenarioSerializer._serializeAccount(new BrokerageAccount(1000, { rebalanceExcluded: true }));
  assert.equal(d.rebalanceExcluded, true);
  const back = ScenarioSerializer._makeAccount({ ...d, __type: 'BrokerageAccount' });
  assert.equal(back.rebalanceExcluded, true, 'survives the round trip');
});

const RUN = { simStart: '2026-01-01', simEnd: '2029-01-01', stepTo: '2029-01-01' };
const PARAMS = {
  behavioralStrategies: ['TARGET_ALLOCATION'],
  rebalanceTargetAllocation: { EQUITY: 0.5, BOND: 0.5, CASH: 0, GOLD: 0 },
  rebalanceDriftBandTaxable: 0.02, rebalanceDriftBandSheltered: 0.02,
};
const legsFor = (sim, key) => (sim.journal.getActions('REBALANCE_TO_TARGET_APPLY') ?? [])
  .filter(e => e.action?.data?.stateKey === key);

test('HOLD-2: a hold-only account is never rebalanced, through the full load path', () => {
  let key = null;
  const base = loadScenarioSim({ ...RUN, params: PARAMS, mutateCfg: (cfg) => {
    key = (cfg.accounts ?? []).find(a => a.role === ACCOUNT_ROLES.US_STOCK)?.stateKey;
  } }).sim;
  assert.ok(key, 'the reference plan has a us-stock account');
  assert.ok(legsFor(base, key).length > 0, 'control: a 50/50 target rebalances it');

  const held = loadScenarioSim({ ...RUN, params: PARAMS, mutateCfg: (cfg) => {
    cfg.accounts.find(a => a.stateKey === key).rebalanceExcluded = true;
  } }).sim;
  assert.equal(held.state[key].rebalanceExcluded, true, 'the flag reaches the state entry');
  assert.equal(legsFor(held, key).length, 0, 'and the rebalancer never trades it');
});
