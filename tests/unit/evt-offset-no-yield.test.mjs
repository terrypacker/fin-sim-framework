/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * evt-offset-no-yield.test.mjs — design 86 §6: **an offset earns no yield.**
 *
 * This is the one behaviour in the offset machinery that stands entirely on the
 * *absence* of a wiring, and absences are not self-documenting. An offset account
 * is bootstrapped with a `CASH` holding, and that holding is stamped with a real,
 * live rate key (`SAVINGS_AU` / `SAVINGS_US`) by the same
 * `resolveRateKey(country, allocation, role)` call every other cash sleeve uses.
 * `state.effectiveInterestRates` carries a non-zero rate under that key. The only
 * reason the offset does not compound is that **no handler is registered against
 * the offset roles** — not the country savings-interest stream (role-filtered to
 * `au-savings` / `us-savings`), and not design 60's `CASH_SLEEVE_INTEREST` stream
 * (wired per account to the equity-served roles only).
 *
 * That is correct: an offset's return IS the suppressed loan interest
 * (`effectivePrincipal = max(0, loanBalance − offsetBalance)`, design 53 §3 / 54 P3).
 * Crediting it a savings rate as well would pay the same dollar twice — once as
 * interest not accrued on the loan, once as interest earned in the account — and
 * would silently invert §8's whole AUD-liquidity option argument, which prices the
 * offset dollar at the loan rate precisely *because* it earns nothing else.
 *
 * The failure mode this pins is a plausible, well-intentioned "fix": someone reads
 * `rateKey: 'SAVINGS_AU'` on an offset's CASH holding, concludes the sleeve was
 * missed when design 60 wired the cash streams, and adds the offset roles to the
 * list. Nothing else in the suite would go red.
 *
 *   OFFYIELD-1: the sleeve really is stamped with a live rate key (the loaded gun).
 *   OFFYIELD-2: the rate under that key is non-zero in a real run — the absence of
 *               yield is a wiring decision, not a 0% rate.
 *   OFFYIELD-3: no handler in a loaded sim targets an offset stateKey or role,
 *               while the matched savings account IS targeted (the detector works).
 *   OFFYIELD-4: end-to-end — over a year the offset does not move by a cent, while
 *               a same-country savings account beside it compounds.
 *
 * Run with: node --test tests/unit/evt-offset-no-yield.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { AccountService }  from '../../src/finance/services/account-service.js';
import { OffsetAccount, AUD, USD } from '../../src/finance/assets/account.js';
import { ACCOUNT_ROLES }   from '../../src/finance/state/account-roles.js';
import { RATE_KEYS }       from '../../src/finance/economic-regimes/rate-keys.js';
import { computeHoldingsCashInterest } from '../../src/finance/holdings/holdings-earnings.js';
import { Graph }    from '../../src/graph/graph.js';
import { EventBus } from '../../src/simulation-framework/event-bus.js';

const OFFSET_KEY = 'auOffsetAccount';

/** Push an unlinked AU offset into an otherwise default scenario config. */
function addOffset(cfg) {
  cfg.accounts.push({
    __type: 'OffsetAccount', id: 'acOff', name: 'AU Offset',
    stateKey: OFFSET_KEY, role: ACCOUNT_ROLES.AU_OFFSET,
    country: 'AU', currency: { code: 'AUD', symbol: 'A$' },
    balance: 250_000,
    // Deliberately unlinked: with no loan to service, the ONLY thing that could
    // move this balance is an earnings stream.
    offsetsPropertyKey: null,
  });
}

/** Every handler entry in a loaded sim that targets `stateKey` or `role`. */
function handlersTargeting(sim, { stateKey = null, role = null }) {
  const hits = [];
  for (const [eventType, entries] of sim.handlers.map) {
    for (const h of entries) {
      const key = h._stateKeyFixed ?? h.stateKey ?? null;
      if ((stateKey != null && key === stateKey) || (role != null && h.role === role)) {
        hits.push(`${eventType}/${h.constructor.name}`);
      }
    }
  }
  return hits;
}

describe('an offset earns no yield (design 86 §6)', () => {
  test('OFFYIELD-1: the bootstrapped CASH sleeve carries a live savings rate key', () => {
    // The stamp is not offset-specific — `_bootstrapDefaultHolding` runs
    // resolveRateKey(country, CASH, role) for every account without holdings — which
    // is exactly why the key on an offset looks like an oversight rather than a
    // deliberate dead end.
    const svc = new AccountService(new Graph(), null, new EventBus());

    const au = svc.createAccount(new OffsetAccount(250_000, {
      name: 'AU Offset', country: 'AU', currency: AUD, role: ACCOUNT_ROLES.AU_OFFSET,
    }));
    assert.equal(au.holdings.length, 1);
    assert.equal(au.holdings[0].allocation, 'CASH');
    assert.equal(au.holdings[0].rateKey, RATE_KEYS.SAVINGS_AU,
      'an AU offset sleeve resolves the AU savings key — the same key AuSavingsInterestHandler reads');

    const us = svc.createAccount(new OffsetAccount(100_000, {
      name: 'US Offset', country: 'US', currency: USD, role: ACCOUNT_ROLES.US_OFFSET,
    }));
    assert.equal(us.holdings[0].rateKey, RATE_KEYS.SAVINGS_US);
  });

  test('OFFYIELD-2: the rate under that key is live — nothing is zeroed', () => {
    const { sim } = loadScenarioSim({
      simStart: '2026-01-01', simEnd: '2028-01-01', mutateCfg: addOffset, telemetry: 'off',
    });

    const rates  = sim.state.effectiveInterestRates ?? {};
    const sleeve = sim.state[OFFSET_KEY].holdings[0];
    assert.equal(sleeve.rateKey, RATE_KEYS.SAVINGS_AU, 'the stamp survives into runtime state');
    assert.ok(rates[RATE_KEYS.SAVINGS_AU] > 0,
      `SAVINGS_AU must be a real rate, got ${rates[RATE_KEYS.SAVINGS_AU]}`);

    // The arithmetic is fully loaded: design 60's compute helper, pointed at the
    // offset, would pay it. Only the absence of a handler stops that call happening.
    const would = computeHoldingsCashInterest({
      state: sim.state, stateKey: OFFSET_KEY, rateKey: RATE_KEYS.SAVINGS_AU, fallbackRate: 0,
    });
    assert.ok(would.amount > 0,
      'the offset sleeve is payable arithmetic — the behaviour rests on wiring, not on a 0% rate');
  });

  test('OFFYIELD-3: no handler is registered against an offset stateKey or role', () => {
    const { sim } = loadScenarioSim({
      simStart: '2026-01-01', simEnd: '2028-01-01', mutateCfg: addOffset, telemetry: 'off',
    });

    // Control first: the same scan finds the AU savings account's interest handler.
    // Without this, an assertion of absence would also pass on a broken detector.
    const savings = handlersTargeting(sim, { stateKey: 'auSavingsAccount', role: ACCOUNT_ROLES.AU_SAVINGS });
    assert.ok(savings.length > 0, 'control failed: the scan cannot see the savings-interest wiring');

    for (const role of [ACCOUNT_ROLES.AU_OFFSET, ACCOUNT_ROLES.US_OFFSET]) {
      assert.deepEqual(handlersTargeting(sim, { role }), [],
        `${role} must have no earnings handler — its return is the loan interest it suppresses`);
    }
    assert.deepEqual(handlersTargeting(sim, { stateKey: OFFSET_KEY }), [],
      'no handler may be pinned to the offset by stateKey either');
  });

  test('OFFYIELD-4: over a full year the offset does not move, while savings compounds', () => {
    const { sim } = loadScenarioSim({
      simStart: '2026-01-01', simEnd: '2029-01-01', mutateCfg: addOffset, telemetry: 'off',
    });

    const savingsBefore = sim.state.auSavingsAccount.balance;
    sim.stepTo(new Date('2027-01-01'));

    const offset = sim.state[OFFSET_KEY];
    assert.equal(offset.balance, 250_000, 'the offset balance must be untouched to the cent');
    assert.equal(offset.holdings[0].marketValue, 250_000, 'and so must its CASH sleeve');
    assert.equal(offset.holdings[0].costBasis, 250_000,
      'no reinvestment, so no basis movement either');

    // The run was live and the AU cash streams were firing — the offset's flatness is
    // specific to the offset, not a sim that never advanced.
    assert.ok(sim.state.auSavingsAccount.balance > savingsBefore,
      'control failed: the AU savings account did not earn, so this run proves nothing');
  });
});
