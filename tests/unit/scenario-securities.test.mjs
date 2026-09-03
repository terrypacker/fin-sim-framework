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
 * scenario-securities.test.mjs — design 94 step 10, the write half of §10.2e.
 *
 * `cfg.securities` is authored data on the scenario record, not a service record (design
 * 94 §4: the run's registry is frozen and shared BY REFERENCE across every snapshot, which
 * is what makes it free). So there is no service to enforce the rules, and the rules that
 * matter are the COLLECTIVE ones — uniqueness and the reserved synthetic prefix — which
 * the registry enforces at LOAD, i.e. on a scenario that no longer opens.
 *
 * What this file pins is that the authoring path refuses those edits up front, and the
 * two round-trip properties a store of authored data has to have: what is written is what
 * the run's own registry builder would accept, and the record's array is REPLACED rather
 * than mutated in place.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import {
  listScenarioSecurities, upsertScenarioSecurity, deleteScenarioSecurity, scenarioSecurityUsage,
} from '../../src/scenarios/scenario-securities.js';
import { scenarioSecurityRegistry, SYNTHETIC_SECURITY_PREFIX } from '../../src/finance/holdings/security.js';

describe('authoring cfg.securities (design 94 step 10)', () => {
  test('insert, then replace by id', () => {
    const cfg = {};
    upsertScenarioSecurity(cfg, { id: 'sec-emp', symbol: 'EMP', rateKey: 'EQUITY_US' });
    assert.equal(listScenarioSecurities(cfg).length, 1);

    upsertScenarioSecurity(cfg, { id: 'sec-emp', symbol: 'EMP', rateKey: 'EQUITY_US', idioVol: 0.3 });
    assert.equal(listScenarioSecurities(cfg).length, 1, 'a second save of the same id replaces, not appends');
    assert.equal(listScenarioSecurities(cfg)[0].idioVol, 0.3);
  });

  test('the array is REPLACED, never mutated in place', () => {
    // A scenario record can be sitting in a history snapshot or a journal entry. An
    // in-place push would rewrite what those recorded — the live-alias defect this repo
    // has already debugged once, pre-empted here.
    const cfg  = { securities: [{ id: 'sec-a' }] };
    const before = cfg.securities;
    upsertScenarioSecurity(cfg, { id: 'sec-b' });
    assert.notEqual(cfg.securities, before);
    assert.deepEqual(before, [{ id: 'sec-a' }], 'the old array is untouched');
  });

  test('refuses the reserved synthetic prefix — validated the way the RUN builds it', () => {
    // `buildSecurityRegistry` alone sees no collision here: the synthetics are not in the
    // authored list. Only `scenarioSecurityRegistry`, which composes them first, does —
    // and that composition is what makes the prefix reserved at all. Validating the
    // narrower object would accept an id that bricks the scenario at load.
    const cfg = {};
    assert.throws(() => upsertScenarioSecurity(cfg, { id: `${SYNTHETIC_SECURITY_PREFIX}EQUITY_US` }), /duplicate id/);
    assert.equal(listScenarioSecurities(cfg).length, 0, 'nothing is committed when validation fails');
  });

  test('refuses a missing id, and commits nothing on a bad edit', () => {
    const cfg = { securities: [{ id: 'sec-a' }] };
    assert.throws(() => upsertScenarioSecurity(cfg, { symbol: 'X' }), /`id` is required/);
    assert.deepEqual(cfg.securities, [{ id: 'sec-a' }]);
  });

  test('what it writes is what the run resolves', () => {
    const cfg = {};
    upsertScenarioSecurity(cfg, { id: 'sec-emp', symbol: 'EMP', rateKey: 'EQUITY_US', dividendYield: null });
    const registry = scenarioSecurityRegistry(cfg);
    assert.ok(registry['sec-emp']);
    // Absent is not null (design 94 §4 rule 2): an explicit null must survive the trip
    // through the record and the registry as a DECLARATION, not be normalised away.
    assert.ok('dividendYield' in registry['sec-emp']);
    assert.equal(registry['sec-emp'].dividendYield, null);
    // …and the four synthetics are still there, so no migrated lot loses its instrument.
    assert.ok(registry[`${SYNTHETIC_SECURITY_PREFIX}EQUITY_US`]);
  });

  test('delete removes the record and leaves the positions naming it alone', () => {
    const cfg = {
      securities: [{ id: 'sec-emp' }],
      accounts: [{ stateKey: 'brokerage', name: 'Broker', holdings: [
        { id: 'h1', securityId: 'sec-emp' }, { id: 'h2', securityId: 'sec-auto-EQUITY_US' }] }],
    };
    assert.deepEqual(scenarioSecurityUsage(cfg, 'sec-emp'), [{ stateKey: 'brokerage', name: 'Broker', lots: 1 }]);

    deleteScenarioSecurity(cfg, 'sec-emp');
    assert.equal(listScenarioSecurities(cfg).length, 0);
    // Deliberately not rewritten: a position is a position IN something, and changing
    // that in place is what design 94 §11's fourth walk forbids a reducer from doing.
    // The lot falls back to its own inline fields, and the account editor preserves the
    // unresolved value as its own option so the author can see and re-point it.
    assert.equal(cfg.accounts[0].holdings[0].securityId, 'sec-emp');
  });

  test('reads a scenario that has never authored one', () => {
    assert.deepEqual(listScenarioSecurities(null), []);
    assert.deepEqual(listScenarioSecurities({}), []);
    assert.deepEqual(scenarioSecurityUsage({}, 'sec-x'), []);
  });
});
