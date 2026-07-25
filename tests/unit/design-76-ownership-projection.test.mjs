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
 * design-76-ownership-projection.test.mjs
 *
 * Design 76 Phase 2 (Gap A): ownership metadata must survive the projection from
 * the `Asset` instance into runtime simulation state.
 *
 * `_accountToStatePlain` carried `ownerId` but dropped `ownershipType`. Since
 * `ownershipFractions` resolves owners[] → (`sole` AND ownerId) → even split, a
 * missing `ownershipType` silently disqualifies the `sole` branch and sends EVERY
 * per-person attribution to the even split. That is what made all the
 * `accumulateByOwnership` wiring from designs 52/55/73 inert for its whole life.
 *
 * THESE TESTS MUST READ OUT OF `sim.state`, NEVER OFF THE `Asset` INSTANCE.
 * The `Asset` always had `ownershipType` — asserting against it is exactly the
 * blind spot that let this bug live. Every assertion below resolves the account
 * from loaded runtime state.
 *
 * Run with: node --test tests/unit/design-76-ownership-projection.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { ownershipFractions } from '../../src/finance/ownership-utils.js';

/** Ownership fractions for a state key, resolved from RUNTIME STATE. */
function fractionsFromState(sim, stateKey) {
  const account = sim.state[stateKey];
  assert.ok(account, `${stateKey} missing from runtime state`);
  return ownershipFractions(account, sim.state.people);
}

describe('design 76 P2 — ownershipType survives into runtime state', () => {
  test('a sole-owned account resolves 100% to its owner, read out of state', () => {
    const { sim } = loadScenarioSim({});
    // The regression guard named in §6 of the design doc.
    assert.deepEqual(fractionsFromState(sim, 'spouseSuperAccount'),
      [{ personKey: 'spouse', fraction: 1.0 }]);
    assert.deepEqual(fractionsFromState(sim, 'superAccount'),
      [{ personKey: 'primary', fraction: 1.0 }]);
  });

  test('ownershipType is actually present on the projected account', () => {
    // Asserting the fractions alone is not enough: an even split across a
    // one-person household would also read as 100%. Pin the field itself.
    const { sim } = loadScenarioSim({});
    assert.equal(sim.state.spouseSuperAccount.ownershipType, 'sole');
    assert.equal(sim.state.spouseSuperAccount.ownerId, 'spouse');
  });

  test('a joint account still splits evenly across both people', () => {
    const { sim } = loadScenarioSim({});
    // usSavingsAccount is joint in the default config — joint tenants take equal
    // shares, so the even split is the CORRECT answer here, not the fallback.
    const fractions = fractionsFromState(sim, 'usSavingsAccount');
    assert.equal(fractions.length, 2);
    for (const { fraction } of fractions) assert.equal(fraction, 0.5);
  });

  test('re-titling an account to the spouse moves 100% of it, end to end', () => {
    // Proves the projection reads the CONFIG rather than a hardcoded default:
    // flip a primary-owned account to the spouse and watch attribution follow.
    const { sim } = loadScenarioSim({
      mutateCfg: cfg => {
        const acct = cfg.accounts.find(a => a.stateKey === 'k401Account');
        acct.ownershipType = 'sole';
        acct.ownerId       = 'spouse';
      },
    });
    assert.deepEqual(fractionsFromState(sim, 'k401Account'),
      [{ personKey: 'spouse', fraction: 1.0 }]);
  });

  test('an unresolvable ownerId falls back to the even split, not a crash', () => {
    const { sim } = loadScenarioSim({
      mutateCfg: cfg => {
        const acct = cfg.accounts.find(a => a.stateKey === 'k401Account');
        acct.ownershipType = 'sole';
        acct.ownerId       = 'nobody';   // no such person
      },
    });
    const fractions = fractionsFromState(sim, 'k401Account');
    assert.equal(fractions.length, 2, 'unresolved sole owner ⇒ even split across people');
    assert.equal(fractions.reduce((s, f) => s + f.fraction, 0), 1.0);
  });
});

describe('design 76 P2 — super tax follows the member end to end', () => {
  test('unequal super balances produce unequal super tax', () => {
    // The reported symptom, at full-scenario level. Before P2 these were identical
    // however far apart the balances were.
    const { sim } = loadScenarioSim({
      params: { superBalance: 50000, spouseSuperBalance: 350000, startingResidency: 'AU' },
      stepTo: new Date(Date.UTC(2028, 5, 29)),
    });
    const superTax = sim.state.auPersonSuperTaxYTD ?? {};
    const primary = superTax.primary ?? 0;
    const spouse  = superTax.spouse  ?? 0;

    assert.ok(primary > 0 && spouse > 0, `both members should accrue super tax, got ${primary}/${spouse}`);
    // 50k vs 350k ⇒ the spouse should bear several times the tax, not an equal half.
    assert.ok(spouse > primary * 3,
      `spouse super tax (${spouse}) should dwarf primary's (${primary}) at 50k vs 350k balances`);
  });
});

describe('design 76 P2 — assets carry owners[] into state', () => {
  test('real property projects an explicit owners[] breakdown', () => {
    // owners[] is the FIRST branch of ownershipFractions and outranks sole/joint.
    // It was serialized and read by design 73's rental attribution but never
    // projected, so the precise split could never take effect.
    const { sim } = loadScenarioSim({
      mutateCfg: cfg => {
        const prop = cfg.realProperties?.[0];
        prop.owners = [
          { personId: 'primary', ownershipPct: 70 },
          { personId: 'spouse',  ownershipPct: 30 },
        ];
      },
    });
    const propState = sim.state[cfg0StateKey(sim)];
    assert.ok(Array.isArray(propState.owners) && propState.owners.length === 2,
      'owners[] must survive the projection');
    assert.deepEqual(ownershipFractions(propState, sim.state.people), [
      { personKey: 'primary', fraction: 0.7 },
      { personKey: 'spouse',  fraction: 0.3 },
    ]);
  });
});

/** State key of the first real property in the loaded sim. */
function cfg0StateKey(sim) {
  const key = Object.keys(sim.state).find(k => sim.state[k]?.kind === 'real-property');
  assert.ok(key, 'no real property found in runtime state');
  return key;
}
