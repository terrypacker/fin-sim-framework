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
 * evt-drawdown-strategy.test.mjs
 *
 * EVT-DRAWDOWN: the `drawdownStrategy` parameter and its plumbing.
 *
 *   - DRAWDOWN_STRATEGIES table + schema/default wiring
 *   - ScenarioLoader `accountPriority` node cascade (strategy → drawdownPriority,
 *     with per-owner spouse offset; CUSTOM = no-op)
 *   - AccountService.replenishSavings ordered vs PROPORTIONAL drawdown modes
 *
 * Run with: node --test tests/unit/evt-drawdown-strategy.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  DRAWDOWN_STRATEGIES,
  INTL_RETIREMENT_DEFAULTS,
  INTL_RETIREMENT_PARAM_SCHEMA,
  IntlRetirementScenario,
} from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader } from '../../src/scenarios/scenario-loader.js';
import { ACCOUNT_ROLES }  from '../../src/finance/state/account-roles.js';
import { AccountService } from '../../src/finance/services/account-service.js';
import { CheckingAccount, USD } from '../../src/finance/assets/account.js';
import { BrokerageAccount }     from '../../src/finance/assets/investment-account.js';
import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';

// ─── Schema / defaults ────────────────────────────────────────────────────────

test('EVT-DRAWDOWN: DRAWDOWN_STRATEGIES exposes the four ordered strategies + CUSTOM', () => {
  assert.deepStrictEqual(
    Object.keys(DRAWDOWN_STRATEGIES).sort(),
    ['CUSTOM', 'PROPORTIONAL', 'ROTH_FIRST', 'TAXABLE_FIRST', 'TAX_DEFERRED_FIRST'].sort(),
  );
  // CUSTOM is a no-op sentinel (no priority map).
  assert.strictEqual(DRAWDOWN_STRATEGIES.CUSTOM, null);
  // TAXABLE_FIRST draws taxable buckets before tax-deferred before Roth.
  const t = DRAWDOWN_STRATEGIES.TAXABLE_FIRST;
  assert.ok(t[ACCOUNT_ROLES.FIXED_INCOME] < t[ACCOUNT_ROLES.IRA]);
  assert.ok(t[ACCOUNT_ROLES.IRA]          < t[ACCOUNT_ROLES.ROTH]);
});

test('EVT-DRAWDOWN: schema entry + default are wired (Enum, mc:false, opt:true)', () => {
  assert.strictEqual(INTL_RETIREMENT_DEFAULTS.drawdownStrategy, 'TAXABLE_FIRST');
  const entry = INTL_RETIREMENT_PARAM_SCHEMA.find(s => s.key === 'drawdownStrategy');
  assert.ok(entry, 'drawdownStrategy must be in the param schema');
  assert.strictEqual(entry.type, 'Enum');
  assert.strictEqual(entry.mc, false);
  assert.strictEqual(entry.opt, true);
  assert.deepStrictEqual(entry.options, Object.keys(DRAWDOWN_STRATEGIES));
  assert.strictEqual(entry.node.type, 'accountPriority');
});

// ─── accountPriority cascade ──────────────────────────────────────────────────

function cascadeFixture(strategyValue) {
  const cfg = {
    params: [{
      name: 'drawdownStrategy', value: strategyValue, type: 'Enum',
      node: { type: 'accountPriority', strategies: DRAWDOWN_STRATEGIES,
              ownerOrder: ['primary', 'spouse'], ownerStride: 100 },
    }],
    accounts: [
      { stateKey: 'usSavingsAccount', role: ACCOUNT_ROLES.US_SAVINGS, ownerId: 'primary' }, // target, untouched
      { stateKey: 'iraAccount',       role: ACCOUNT_ROLES.IRA,        ownerId: 'primary', drawdownPriority: 99 },
      { stateKey: 'rothAccount',      role: ACCOUNT_ROLES.ROTH,       ownerId: 'primary', drawdownPriority: 99 },
      { stateKey: 'spouseIraAccount', role: ACCOUNT_ROLES.IRA,        ownerId: 'spouse',  drawdownPriority: 99 },
    ],
  };
  new ScenarioLoader()._normalizeParams(cfg);
  const by = Object.fromEntries(cfg.accounts.map(a => [a.stateKey, a.drawdownPriority]));
  return by;
}

test('EVT-DRAWDOWN: TAXABLE_FIRST cascade assigns role priorities + spouse offset', () => {
  const by = cascadeFixture('TAXABLE_FIRST');
  assert.strictEqual(by.iraAccount,       DRAWDOWN_STRATEGIES.TAXABLE_FIRST[ACCOUNT_ROLES.IRA]);  // 3
  assert.strictEqual(by.rothAccount,      DRAWDOWN_STRATEGIES.TAXABLE_FIRST[ACCOUNT_ROLES.ROTH]); // 5
  // Spouse same-role bucket sits a full stride (100) above the primary's.
  assert.strictEqual(by.spouseIraAccount, by.iraAccount + 100);
  // Savings (target) account keeps a null priority.
  assert.strictEqual(by.usSavingsAccount, undefined);
});

test('EVT-DRAWDOWN: TAX_DEFERRED_FIRST reorders IRA ahead of taxable', () => {
  const by = cascadeFixture('TAX_DEFERRED_FIRST');
  assert.strictEqual(by.iraAccount,  DRAWDOWN_STRATEGIES.TAX_DEFERRED_FIRST[ACCOUNT_ROLES.IRA]);  // 1
  assert.strictEqual(by.rothAccount, DRAWDOWN_STRATEGIES.TAX_DEFERRED_FIRST[ACCOUNT_ROLES.ROTH]); // 5
  assert.ok(by.iraAccount < by.rothAccount);
});

test('EVT-DRAWDOWN: CUSTOM strategy is a no-op (per-account priorities untouched)', () => {
  const by = cascadeFixture('CUSTOM');
  assert.strictEqual(by.iraAccount,       99);
  assert.strictEqual(by.spouseIraAccount, 99);
});

test('EVT-DRAWDOWN: strategy cascades from flat cfg.parameters even without a typed params array', () => {
  // Templates from buildDefaultConfig() (optimizer cfgTemplate fallback / library
  // consumers) carry only the flat parameters map, no typed cfg.params array. The
  // schema-driven second pass in _normalizeParams must still apply the node.
  const cfg = {
    scenarioClass: IntlRetirementScenario,
    parameters: { drawdownStrategy: 'TAX_DEFERRED_FIRST' },
    // no cfg.params array
    accounts: [
      { stateKey: 'iraAccount',  role: ACCOUNT_ROLES.IRA,  ownerId: 'primary', drawdownPriority: 99 },
      { stateKey: 'rothAccount', role: ACCOUNT_ROLES.ROTH, ownerId: 'primary', drawdownPriority: 99 },
    ],
  };
  new ScenarioLoader()._normalizeParams(cfg);
  const by = Object.fromEntries(cfg.accounts.map(a => [a.stateKey, a.drawdownPriority]));
  assert.strictEqual(by.iraAccount,  DRAWDOWN_STRATEGIES.TAX_DEFERRED_FIRST[ACCOUNT_ROLES.IRA]);  // 1
  assert.strictEqual(by.rothAccount, DRAWDOWN_STRATEGIES.TAX_DEFERRED_FIRST[ACCOUNT_ROLES.ROTH]); // 5
});

// ─── replenishSavings: ordered vs proportional ────────────────────────────────

function drawdownFixture(drawdownMode) {
  const svc     = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  // Two equal, age-eligible taxable accounts.
  const a = new BrokerageAccount(10_000, { country: 'US', currency: USD, drawdownPriority: 1 });
  const b = new BrokerageAccount(10_000, { country: 'US', currency: USD, drawdownPriority: 2 });
  const state = {
    savingsAccount: savings, accountA: a, accountB: b,
    personBirthDate: new Date(1970, 0, 1),  // age ~56: eligible for taxable brokerage
    ...(drawdownMode ? { drawdownMode } : {}),
  };
  return { svc, savings, a, b, state };
}

test('EVT-DRAWDOWN: ORDERED draws by priority (drains first account before second)', () => {
  const { svc, savings, a, b, state } = drawdownFixture('ORDERED');
  const { drawnKeys } = svc.replenishSavings(state, 'savingsAccount', 4000, new Date(2026, 0, 1));
  assert.deepStrictEqual(drawnKeys, ['accountA']);
  assert.strictEqual(a.balance, 6000);
  assert.strictEqual(b.balance, 10_000);  // untouched
});

test('EVT-DRAWDOWN: absent drawdownMode behaves identically to ORDERED', () => {
  const { svc, a, b, state } = drawdownFixture(null);
  svc.replenishSavings(state, 'savingsAccount', 4000, new Date(2026, 0, 1));
  assert.strictEqual(a.balance, 6000);
  assert.strictEqual(b.balance, 10_000);
});

test('EVT-DRAWDOWN: PROPORTIONAL splits the deficit pro-rata across equal buckets', () => {
  const { svc, savings, a, b, state } = drawdownFixture('PROPORTIONAL');
  svc.replenishSavings(state, 'savingsAccount', 4000, new Date(2026, 0, 1));
  assert.strictEqual(savings.balance, 4000);
  // Equal balances → ~half from each.
  assert.ok(Math.abs(a.balance - 8000) < 1e-6, `accountA balance ${a.balance}`);
  assert.ok(Math.abs(b.balance - 8000) < 1e-6, `accountB balance ${b.balance}`);
});
