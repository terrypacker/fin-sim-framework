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
 * evt-transaction-account.test.mjs
 *
 * Transaction-account flag (design 55 §7 / Phase 3).
 *
 * `isTransactionAccount` marks the cash hub for a country of residence.
 * MonthlyExpensesHandler (debits/replenish) and PayrollHandler (deposits)
 * both resolve the target via StateRegistry.resolveTransactionAccountKey,
 * preferring the flagged account and falling back to the SAVINGS role when none
 * is flagged — so pre-flag scenarios are unchanged (design 55 §7, Phase 3 + 6a).
 *
 *   EVT-TXN-1: flagging a US CHECKING account routes wages + expenses through it
 *   EVT-TXN-2: with checking flagged, US savings is bypassed as the cash hub
 *   EVT-TXN-3: an unflagged checking account falls back to SAVINGS (savings unchanged)
 *   EVT-TXN-4: the flag round-trips via the generated per-account Boolean param
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioSerializer }     from '../../src/scenarios/scenario-serializer.js';
import { ScenarioLoader }         from '../../src/scenarios/scenario-loader.js';
import { ServiceRegistry }        from '../../src/services/service-registry.js';

const SS = new Date(Date.UTC(2026, 0, 1));
const SE = new Date(Date.UTC(2032, 0, 1));

/** Build the default config, apply `mutate(cfg)`, run to SE, return sim.state. */
function run(mutate) {
  ServiceRegistry.resetAll();
  const reg = ServiceRegistry.getInstance();
  const sc  = new IntlRetirementScenario({ context: reg.simulationContext, simStart: SS, simEnd: SE });
  sc.buildSim();
  const cfg = ScenarioSerializer.serializeScenario(IntlRetirementScenario.buildDefaultConfig({}, SS, SE));
  cfg.parameters = { ...(cfg.parameters ?? {}) };
  mutate(cfg);
  new ScenarioLoader().load(cfg, reg);
  sc.sim.silent = true; sc.sim.journal.enabled = false;
  sc.sim.stepTo(SE);
  return sc.sim.state;
}

/**
 * Add a US Checking account with a large balance so it never needs replenishment
 * over the run. Excluded from drawdown (drawdownPriority null) so it stays inert
 * unless it is the transaction (debit) target. Returns nothing; mutates cfg.
 */
function addUsChecking(cfg, { flag }) {
  const primaryId = cfg.accounts.find(a => a.stateKey === 'usSavingsAccount')?.ownerId ?? 'primary';
  cfg.accounts.push({
    __type: 'CheckingAccount', stateKey: 'usCheckingAccount',
    name: 'US Checking', ownerId: primaryId,
    balance: 1_000_000, minimumBalance: 0, country: 'US', currency: { code: 'USD', symbol: '$' },
    drawdownPriority: null,
    isTransactionAccount: flag,
  });
}

const bal = (state, key) => Math.round(state[key]?.balance ?? -1);

test('EVT-TXN-1: flagging a US checking account routes wages + expenses through it', () => {
  const flagged   = run(cfg => addUsChecking(cfg, { flag: true }));
  const unflagged = run(cfg => addUsChecking(cfg, { flag: false }));

  // Flagged, the checking account is the transaction hub — wages land in it and
  // expenses debit it — so it diverges from its $1M seed. Unflagged it is never a
  // target (and is excluded from drawdown), so it stays exactly at $1M.
  assert.strictEqual(bal(unflagged, 'usCheckingAccount'), 1_000_000,
    'an unflagged, non-drawdown checking account stays inert at its seed balance');
  assert.notStrictEqual(bal(flagged, 'usCheckingAccount'), 1_000_000,
    'a flagged checking account becomes the wages/expenses hub and moves off its seed');
});

test('EVT-TXN-2: with checking flagged, US savings is bypassed as the cash hub', () => {
  const flagged   = run(cfg => addUsChecking(cfg, { flag: true }));
  const unflagged = run(cfg => addUsChecking(cfg, { flag: false }));

  // Flagging moves BOTH wage inflow and expense outflow onto checking, so savings
  // no longer receives net wages — it ends lower than when it is itself the hub.
  assert.ok(bal(flagged, 'usSavingsAccount') < bal(unflagged, 'usSavingsAccount'),
    `savings is bypassed when checking is the transaction account ` +
    `(flagged ${bal(flagged, 'usSavingsAccount')} vs unflagged ${bal(unflagged, 'usSavingsAccount')})`);
});

test('EVT-TXN-3: an unflagged checking account falls back to SAVINGS (unchanged)', () => {
  const baseline  = run(() => {});                               // no checking at all
  const unflagged = run(cfg => addUsChecking(cfg, { flag: false })); // inert checking

  // With nothing flagged the resolver returns null → SAVINGS-role fallback, so the
  // savings trajectory is byte-for-byte identical to the no-checking baseline.
  assert.strictEqual(bal(unflagged, 'usSavingsAccount'), bal(baseline, 'usSavingsAccount'),
    'adding an unflagged checking account must not change the savings debit trajectory');
});

test('EVT-TXN-4: the flag round-trips via the generated per-account Boolean param', () => {
  // Setting the record flag directly and setting it via the generated param must
  // produce the same result (params drive records — design 55 §6).
  const viaRecord = run(cfg => addUsChecking(cfg, { flag: true }));
  const viaParam  = run(cfg => {
    addUsChecking(cfg, { flag: false });
    cfg.parameters['acct.usCheckingAccount.isTransactionAccount'] = true;
  });

  assert.strictEqual(bal(viaParam, 'usCheckingAccount'), bal(viaRecord, 'usCheckingAccount'),
    'the generated Boolean param must cascade onto the record identically to a direct edit');
});
