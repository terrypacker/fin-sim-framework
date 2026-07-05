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
import { CheckingAccount, USD, AUD } from '../../src/finance/assets/account.js';
import { BrokerageAccount }     from '../../src/finance/assets/investment-account.js';
import { EventBus }       from '../../src/simulation-framework/event-bus.js';
import { Graph }          from '../../src/graph/graph.js';
import { GraphQueryApi }  from '../../src/graph/graph-query-api.js';

// ─── Schema / defaults ────────────────────────────────────────────────────────

test('EVT-DRAWDOWN: DRAWDOWN_STRATEGIES exposes the ordered strategies + CUSTOM', () => {
  assert.deepStrictEqual(
    Object.keys(DRAWDOWN_STRATEGIES).sort(),
    ['CUSTOM', 'PROPORTIONAL', 'ROTH_FIRST', 'TAXABLE_FIRST', 'TAX_DEFERRED_FIRST', 'TAX_EFFICIENT'].sort(),
  );
  // CUSTOM is a no-op sentinel (no priority map).
  assert.strictEqual(DRAWDOWN_STRATEGIES.CUSTOM, null);
  // TAXABLE_FIRST draws cash first, then taxable, then tax-deferred, Roth last.
  const t = DRAWDOWN_STRATEGIES.TAXABLE_FIRST;
  assert.ok(t[ACCOUNT_ROLES.US_SAVINGS]   < t[ACCOUNT_ROLES.FIXED_INCOME]); // cash band first
  assert.ok(t[ACCOUNT_ROLES.AU_SAVINGS]   < t[ACCOUNT_ROLES.FIXED_INCOME]);
  assert.ok(t[ACCOUNT_ROLES.FIXED_INCOME] < t[ACCOUNT_ROLES.IRA]);
  assert.ok(t[ACCOUNT_ROLES.IRA]          < t[ACCOUNT_ROLES.ROTH]);
  // Every built-in strategy ranks both cash roles ahead of all investments.
  for (const name of ['TAXABLE_FIRST', 'TAX_DEFERRED_FIRST', 'ROTH_FIRST', 'PROPORTIONAL', 'TAX_EFFICIENT']) {
    const m = DRAWDOWN_STRATEGIES[name];
    const invMin = Math.min(...Object.entries(m)
      .filter(([r]) => r !== ACCOUNT_ROLES.US_SAVINGS && r !== ACCOUNT_ROLES.AU_SAVINGS)
      .map(([, v]) => v));
    assert.ok(m[ACCOUNT_ROLES.US_SAVINGS] < invMin, `${name}: cash before investments`);
    assert.ok(m[ACCOUNT_ROLES.AU_SAVINGS] < invMin, `${name}: cash before investments`);
  }
  // TAX_EFFICIENT is a single GLOBAL order: every *investment* role gets a distinct
  // rank (the two cash roles share the cash band), taxable → tax-deferred → tax-free.
  const e = DRAWDOWN_STRATEGIES.TAX_EFFICIENT;
  const invRanks = Object.entries(e)
    .filter(([r]) => r !== ACCOUNT_ROLES.US_SAVINGS && r !== ACCOUNT_ROLES.AU_SAVINGS)
    .map(([, v]) => v);
  assert.strictEqual(new Set(invRanks).size, invRanks.length, 'investment ranks must be globally distinct');
  assert.ok(e[ACCOUNT_ROLES.US_STOCK]        < e[ACCOUNT_ROLES.IRA]);   // taxable before tax-deferred
  assert.ok(e[ACCOUNT_ROLES.AU_STOCK]        < e[ACCOUNT_ROLES.IRA]);   // AU taxable before US tax-deferred
  assert.ok(e[ACCOUNT_ROLES.K401]            < e[ACCOUNT_ROLES.SUPER]); // tax-deferred before tax-free
  assert.ok(e[ACCOUNT_ROLES.SUPER]           < e[ACCOUNT_ROLES.ROTH]);  // Roth drawn dead last
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
  // Savings now ranks in the cash band (0) — drawn first; the active target
  // account is excluded as a source at runtime, not by a null priority here.
  assert.strictEqual(by.usSavingsAccount, DRAWDOWN_STRATEGIES.TAXABLE_FIRST[ACCOUNT_ROLES.US_SAVINGS]); // 0
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

// ─── replenishSavings: cross-border (crossBorderDrawdown=GLOBAL) ───────────────

test('EVT-DRAWDOWN: LOCAL_FIRST (default) ignores other-country accounts', () => {
  const svc     = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const auSav   = new CheckingAccount(0, { country: 'AU', currency: AUD });
  const usBroker = new BrokerageAccount(10_000, { country: 'US', currency: USD, drawdownPriority: 1 });
  const state = {
    auSavingsAccount: auSav, usStock: usBroker,
    personBirthDate: new Date(1970, 0, 1),
    effectiveExchangeRates: { USD_AUD: 1.5 },
    // crossBorderDrawdown unset → LOCAL_FIRST: AU target can't reach the US account.
  };
  assert.throws(
    () => svc.replenishSavings(state, 'auSavingsAccount', 3000, new Date(2026, 0, 1)),
    /Insufficient/i,
  );
  assert.strictEqual(usBroker.balance, 10_000); // untouched across the border
});

test('EVT-DRAWDOWN: GLOBAL draws a US account to fund an AU target with FX + fee', () => {
  const svc     = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const auSav   = new CheckingAccount(0, { country: 'AU', currency: AUD });
  const usBroker = new BrokerageAccount(10_000, { country: 'US', currency: USD, drawdownPriority: 1 });
  const state = {
    auSavingsAccount: auSav, usStock: usBroker,
    personBirthDate: new Date(1970, 0, 1),
    effectiveExchangeRates: { USD_AUD: 1.5 }, // 1 USD = 1.5 AUD
    effectiveFxFees:        { USD_AUD: 10 },  // US$10 flat per cross-border transfer
    crossBorderDrawdown: 'GLOBAL',
  };
  // Need A$3000 net at the AU savings. The US$10 fee is A$15 at 1.5, so the
  // transfer must deliver A$3015 ⇒ draw US$2010; AU savings nets exactly A$3000.
  const { drawnKeys } = svc.replenishSavings(state, 'auSavingsAccount', 3000, new Date(2026, 0, 1));
  assert.deepStrictEqual(drawnKeys, ['usStock']);
  assert.ok(Math.abs(auSav.balance - 3000) < 1e-6, `AU savings ${auSav.balance}`);     // target nets the deficit
  assert.ok(Math.abs(usBroker.balance - 7990) < 1e-6, `US broker ${usBroker.balance}`); // US$2010 drawn (incl. fee)
});

test('EVT-DRAWDOWN: GLOBAL same-currency draw pays no FX fee', () => {
  const svc     = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const usSav   = new CheckingAccount(0, { country: 'US', currency: USD });
  const usBroker = new BrokerageAccount(10_000, { country: 'US', currency: USD, drawdownPriority: 1 });
  const state = {
    usSavingsAccount: usSav, usStock: usBroker,
    personBirthDate: new Date(1970, 0, 1),
    effectiveExchangeRates: { USD_AUD: 1.5 },
    effectiveFxFees:        { USD_AUD: 10 },
    crossBorderDrawdown: 'GLOBAL',
  };
  svc.replenishSavings(state, 'usSavingsAccount', 3000, new Date(2026, 0, 1));
  assert.ok(Math.abs(usSav.balance - 3000) < 1e-6, `US savings ${usSav.balance}`);
  assert.ok(Math.abs(usBroker.balance - 7000) < 1e-6, `US broker ${usBroker.balance}`); // exactly $3000, no fee
});

// ─── cash band: spend cash first, down to minimumBalance ──────────────────────

test('EVT-DRAWDOWN: idle cash is drawn before investments and only to its minimum', () => {
  const svc      = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const usSav    = new CheckingAccount(0, { country: 'US', currency: USD }); // target
  const cash     = new CheckingAccount(5000, { country: 'US', currency: USD, role: ACCOUNT_ROLES.US_SAVINGS, minimumBalance: 3000, drawdownPriority: 0 });
  const usBroker = new BrokerageAccount(10_000, { country: 'US', currency: USD, drawdownPriority: 1 });
  const state = {
    usSavingsAccount: usSav, extraCash: cash, usStock: usBroker,
    personBirthDate: new Date(1970, 0, 1),
  };
  const { drawnKeys } = svc.replenishSavings(state, 'usSavingsAccount', 4000, new Date(2026, 0, 1));
  // Cash band (priority 0) drains first but stops at its $3000 floor (→ $2000 drawn),
  // then the investment covers the remaining $2000.
  assert.deepStrictEqual(drawnKeys, ['extraCash', 'usStock']);
  assert.strictEqual(cash.balance, 3000);     // floored at minimumBalance
  assert.strictEqual(usBroker.balance, 8000); // remaining $2000 from investment
  assert.strictEqual(usSav.balance, 4000);
});

test('EVT-DRAWDOWN: non-residence cash is repatriated even under LOCAL_FIRST', () => {
  const svc    = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const usSav  = new CheckingAccount(0, { country: 'US', currency: USD }); // residence target
  const auCash = new CheckingAccount(5000, { country: 'AU', currency: AUD, role: ACCOUNT_ROLES.AU_SAVINGS, minimumBalance: 0, drawdownPriority: 0 });
  const state = {
    usSavingsAccount: usSav, auSavingsAccount: auCash,
    personBirthDate: new Date(1970, 0, 1),
    effectiveExchangeRates: { USD_AUD: 1.5 }, // 1 USD = 1.5 AUD
    effectiveFxFees:        { USD_AUD: 0 },
    // crossBorderDrawdown unset → LOCAL_FIRST. Cash still crosses the border
    // (the stranding fix); a US-resident spends idle AU cash before investments.
  };
  const { drawnKeys } = svc.replenishSavings(state, 'usSavingsAccount', 2000, new Date(2026, 0, 1));
  assert.deepStrictEqual(drawnKeys, ['auSavingsAccount']);
  assert.ok(Math.abs(auCash.balance - 2000) < 1e-6, `AU cash ${auCash.balance}`); // A$3000 drawn (= US$2000)
  assert.ok(Math.abs(usSav.balance - 2000) < 1e-6, `US savings ${usSav.balance}`);
});
