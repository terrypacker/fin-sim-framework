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
  DRAWDOWN_WEIGHT_ROLES,
  DRAWDOWN_WEIGHT_MODE,
  DRAWDOWN_WEIGHT_PREFIX,
  DRAWDOWN_WEIGHT_SEP,
  drawdownWeightKey,
  DEFAULT_DRAWDOWN_WEIGHTS,
  drawdownWeightsFromStrategy,
  buildDrawdownWeightSchema,
  INTL_RETIREMENT_DEFAULTS,
  INTL_RETIREMENT_PARAM_SCHEMA,
  IntlRetirementScenario,
} from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioLoader } from '../../src/scenarios/scenario-loader.js';
import { US_RETIREMENT }  from '../../src/scenarios/toolsets/us-retirement-toolset.js';
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
    ['CUSTOM', 'PROPORTIONAL', 'ROTH_FIRST', 'TAXABLE_FIRST', 'TAX_DEFERRED_FIRST', 'TAX_EFFICIENT', 'WEIGHTED'].sort(),
  );
  // CUSTOM is a no-op sentinel (no priority map); WEIGHTED (Lever B) is a
  // synthesize-from-weights sentinel — also null here (the map is computed at
  // cascade time from the drawdownWeight.<role> params, not stored).
  assert.strictEqual(DRAWDOWN_STRATEGIES.CUSTOM, null);
  assert.strictEqual(DRAWDOWN_STRATEGIES.WEIGHTED, null);
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

// ─── Cross-border drawdown mode (design 58 Lever A) ───────────────────────────

test('EVT-DRAWDOWN: crossBorderDrawdown schema entry + default (Enum AUTO, opt:true)', () => {
  assert.strictEqual(INTL_RETIREMENT_DEFAULTS.crossBorderDrawdown, 'AUTO');
  const entry = INTL_RETIREMENT_PARAM_SCHEMA.find(s => s.key === 'crossBorderDrawdown');
  assert.ok(entry, 'crossBorderDrawdown must be in the param schema');
  assert.strictEqual(entry.type, 'Enum');
  assert.deepStrictEqual(entry.options, ['AUTO', 'LOCAL_FIRST', 'GLOBAL']);
  assert.strictEqual(entry.opt, true);
});

/** Resolve state.crossBorderDrawdown via the real US_RETIREMENT toolset state(). */
function resolveMode(parameters) {
  return US_RETIREMENT.state({ parameters, people: [], accounts: [] }).crossBorderDrawdown;
}

test('EVT-DRAWDOWN: AUTO preserves the legacy strategy coupling', () => {
  // AUTO (and unset / unknown) ⇒ TAX_EFFICIENT is GLOBAL, everything else LOCAL_FIRST.
  assert.strictEqual(resolveMode({ crossBorderDrawdown: 'AUTO', drawdownStrategy: 'TAX_EFFICIENT' }), 'GLOBAL');
  assert.strictEqual(resolveMode({ crossBorderDrawdown: 'AUTO', drawdownStrategy: 'TAXABLE_FIRST' }), 'LOCAL_FIRST');
  assert.strictEqual(resolveMode({ crossBorderDrawdown: 'AUTO', drawdownStrategy: 'CUSTOM' }), 'LOCAL_FIRST');
  // Unset key ⇒ same as AUTO (byte-identical back-compat).
  assert.strictEqual(resolveMode({ drawdownStrategy: 'TAX_EFFICIENT' }), 'GLOBAL');
  assert.strictEqual(resolveMode({ drawdownStrategy: 'TAXABLE_FIRST' }), 'LOCAL_FIRST');
  // Unknown string falls through to the coupling too.
  assert.strictEqual(resolveMode({ crossBorderDrawdown: 'bogus', drawdownStrategy: 'CUSTOM' }), 'LOCAL_FIRST');
});

test('EVT-DRAWDOWN: an explicit LOCAL_FIRST/GLOBAL overrides the strategy', () => {
  // GLOBAL wins even for a non-TAX_EFFICIENT strategy — the immediate ask: CUSTOM
  // can now honor the authored order across the border.
  assert.strictEqual(resolveMode({ crossBorderDrawdown: 'GLOBAL', drawdownStrategy: 'CUSTOM' }), 'GLOBAL');
  assert.strictEqual(resolveMode({ crossBorderDrawdown: 'GLOBAL', drawdownStrategy: 'TAXABLE_FIRST' }), 'GLOBAL');
  // LOCAL_FIRST wins even for TAX_EFFICIENT (opt out of the coupling).
  assert.strictEqual(resolveMode({ crossBorderDrawdown: 'LOCAL_FIRST', drawdownStrategy: 'TAX_EFFICIENT' }), 'LOCAL_FIRST');
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

// ─── Lever B — optimizable role-weight order (design 58 §4-B) ──────────────────

test('EVT-DRAWDOWN: Lever B weight helpers + schema wiring', () => {
  // 8 investment roles weighted; cash roles excluded (they always drain first).
  assert.strictEqual(DRAWDOWN_WEIGHT_ROLES.length, 8);
  assert.ok(!DRAWDOWN_WEIGHT_ROLES.includes(ACCOUNT_ROLES.US_SAVINGS));
  assert.ok(!DRAWDOWN_WEIGHT_ROLES.includes(ACCOUNT_ROLES.AU_SAVINGS));

  // A named strategy → weight vector whose ascending sort reproduces its order.
  const w = drawdownWeightsFromStrategy('TAX_EFFICIENT');
  const order = Object.keys(w).sort((a, b) => w[a] - w[b]);
  const te = DRAWDOWN_STRATEGIES.TAX_EFFICIENT;
  const strategyOrder = [...DRAWDOWN_WEIGHT_ROLES].sort((a, b) => te[a] - te[b]);
  assert.deepStrictEqual(order, strategyOrder, 'weights reproduce TAX_EFFICIENT order');
  // Weights live strictly inside (0,1).
  for (const v of Object.values(w)) { assert.ok(v > 0 && v < 1); }
  // CUSTOM/WEIGHTED have no role map → null.
  assert.strictEqual(drawdownWeightsFromStrategy('CUSTOM'), null);
  assert.strictEqual(drawdownWeightsFromStrategy('WEIGHTED'), null);

  // Defaults are seeded from TAX_EFFICIENT.
  assert.deepStrictEqual(DEFAULT_DRAWDOWN_WEIGHTS, drawdownWeightsFromStrategy('TAX_EFFICIENT'));

  // Schema entries: one per role, Number, opt, gated on WEIGHTED.
  const entries = buildDrawdownWeightSchema();
  assert.strictEqual(entries.length, DRAWDOWN_WEIGHT_ROLES.length);
  // Keys use the `::` separator (not a dot) so the MC/Opt/MPC set() path writes them
  // flat — a dotted key would be silently dropped by set() (see drawdownWeightKey).
  assert.strictEqual(drawdownWeightKey('roth-ira'), `${DRAWDOWN_WEIGHT_PREFIX}${DRAWDOWN_WEIGHT_SEP}roth-ira`);
  assert.ok(!drawdownWeightKey('roth-ira').includes('.'), 'weight key has no dot');
  for (const e of entries) {
    assert.ok(e.key.startsWith(`${DRAWDOWN_WEIGHT_PREFIX}${DRAWDOWN_WEIGHT_SEP}`));
    assert.strictEqual(e.type, 'Number');
    assert.strictEqual(e.opt, true);
    assert.strictEqual(e.mc, false);
    assert.strictEqual(e.min, 0);
    assert.strictEqual(e.max, 1);
    assert.deepStrictEqual(e.visibleWhen, { param: 'drawdownStrategy', equals: DRAWDOWN_WEIGHT_MODE });
    // Every generated key is present in the real scenario param schema.
    assert.ok(INTL_RETIREMENT_PARAM_SCHEMA.some(s => s.key === e.key), `${e.key} in schema`);
  }
  // WEIGHTED is a selectable strategy option.
  const stratEntry = INTL_RETIREMENT_PARAM_SCHEMA.find(s => s.key === 'drawdownStrategy');
  assert.ok(stratEntry.options.includes(DRAWDOWN_WEIGHT_MODE));
});

/** Cascade a WEIGHTED-mode config through the real scenario-class schema node. */
function weightCascade(weightOverrides = {}, ownerOrdering) {
  const cfg = {
    scenarioClass: IntlRetirementScenario,
    parameters: {
      drawdownStrategy: DRAWDOWN_WEIGHT_MODE,
      ...(ownerOrdering ? { drawdownOwnerOrdering: ownerOrdering } : {}),
      ...weightOverrides,
    },
    accounts: [
      { stateKey: 'fixedIncome', role: ACCOUNT_ROLES.FIXED_INCOME, ownerId: 'primary', drawdownPriority: 99 },
      { stateKey: 'usStock',     role: ACCOUNT_ROLES.US_STOCK,      ownerId: 'primary', drawdownPriority: 99 },
      { stateKey: 'ira',         role: ACCOUNT_ROLES.IRA,           ownerId: 'primary', drawdownPriority: 99 },
      { stateKey: 'roth',        role: ACCOUNT_ROLES.ROTH,          ownerId: 'primary', drawdownPriority: 99 },
      { stateKey: 'spouseRoth',  role: ACCOUNT_ROLES.ROTH,          ownerId: 'spouse',  drawdownPriority: 99 },
      { stateKey: 'usSavings',   role: ACCOUNT_ROLES.US_SAVINGS,    ownerId: 'primary', drawdownPriority: 0  },
    ],
  };
  new ScenarioLoader()._normalizeParams(cfg);
  return Object.fromEntries(cfg.accounts.map(a => [a.stateKey, a.drawdownPriority]));
}

test('EVT-DRAWDOWN: Lever B default weights reproduce a global taxable→tax-free order', () => {
  const by = weightCascade();
  // Cash first (0), then taxable (fixed-income, us-stock), tax-deferred (ira), Roth last.
  assert.strictEqual(by.usSavings, 0);
  assert.ok(by.fixedIncome < by.usStock);
  assert.ok(by.usStock     < by.ira);
  assert.ok(by.ira         < by.roth);
  // Spouse's same-role Roth sits a stride (100) above the primary's under PRIMARY_FIRST.
  assert.strictEqual(by.spouseRoth, by.roth + 100);
});

test('EVT-DRAWDOWN: Lever B swapping a role weight reorders the draw', () => {
  // Draw Roth FIRST and fixed-income LAST by swapping their weights.
  const by = weightCascade({
    [drawdownWeightKey('roth-ira')]:      0.0,
    [drawdownWeightKey('fixed-income')]:  0.99,
  });
  assert.strictEqual(by.roth, 1);          // lowest weight → drawn first among investments
  assert.ok(by.fixedIncome > by.ira);      // pushed behind tax-deferred
  assert.ok(by.roth < by.usStock);         // Roth now ahead of taxable stock
});

test('EVT-DRAWDOWN: Lever B same-role siblings share a tier under POOLED', () => {
  const by = weightCascade({}, 'POOLED');
  // Both Roths get the same synthesized rank (stride 0) → one tier for Lever C.
  assert.strictEqual(by.roth, by.spouseRoth);
});

test('EVT-DRAWDOWN: Lever B falls back to defaults for a missing/NaN weight', () => {
  // Omit every weight but one bogus value; the rest resolve from weightDefaults so
  // the order is still fully defined (no null priorities on eligible accounts).
  const by = weightCascade({ [drawdownWeightKey('ira')]: 'not-a-number' });
  for (const k of ['fixedIncome', 'usStock', 'ira', 'roth', 'spouseRoth']) {
    assert.ok(Number.isFinite(by[k]), `${k} has a numeric priority`);
  }
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

// ─── Lever C — within-tier draw policy (design 58 §4-C) ───────────────────────

/** Two same-tier (equal drawdownPriority) taxable accounts + a within-tier policy. */
function tierFixture(withinTierDraw, { balA = 10_000, balB = 10_000, minA = 0, minB = 0 } = {}) {
  const svc     = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const savings = new CheckingAccount(0, { country: 'US', currency: USD });
  const a = new BrokerageAccount(balA, { country: 'US', currency: USD, drawdownPriority: 1, minimumBalance: minA });
  const b = new BrokerageAccount(balB, { country: 'US', currency: USD, drawdownPriority: 1, minimumBalance: minB });
  const state = {
    savingsAccount: savings, accountA: a, accountB: b,
    personBirthDate: new Date(1970, 0, 1),   // age ~56: eligible for taxable brokerage
    ...(withinTierDraw ? { withinTierDraw } : {}),
  };
  return { svc, savings, a, b, state };
}

test('EVT-DRAWDOWN: Lever C SEQUENTIAL (default) drains one tier member fully first', () => {
  const { svc, a, b, state } = tierFixture('SEQUENTIAL');
  const { drawnKeys } = svc.replenishSavings(state, 'savingsAccount', 4000, new Date(2026, 0, 1));
  assert.deepStrictEqual(drawnKeys, ['accountA']);   // byte-identical to legacy
  assert.strictEqual(a.balance, 6000);
  assert.strictEqual(b.balance, 10_000);
});

test('EVT-DRAWDOWN: Lever C EQUAL splits a tier 50/50', () => {
  const { svc, savings, a, b, state } = tierFixture('EQUAL');
  svc.replenishSavings(state, 'savingsAccount', 4000, new Date(2026, 0, 1));
  assert.strictEqual(savings.balance, 4000);
  assert.ok(Math.abs(a.balance - 8000) < 1e-6, `accountA ${a.balance}`);   // 2000 each
  assert.ok(Math.abs(b.balance - 8000) < 1e-6, `accountB ${b.balance}`);
});

test('EVT-DRAWDOWN: Lever C EQUAL redistributes residual when one member is capped', () => {
  // accountA can only give up 1000 (min 9000); EQUAL wants 2000 from each → the
  // 1000 residual redistributes to accountB, which covers it.
  const { svc, savings, a, b, state } = tierFixture('EQUAL', { minA: 9000 });
  svc.replenishSavings(state, 'savingsAccount', 4000, new Date(2026, 0, 1));
  assert.strictEqual(savings.balance, 4000);
  assert.ok(Math.abs(a.balance - 9000) < 1e-6, `accountA ${a.balance}`);   // capped at min
  assert.ok(Math.abs(b.balance - 7000) < 1e-6, `accountB ${b.balance}`);   // covered 3000
});

test('EVT-DRAWDOWN: Lever C PROPORTIONAL splits a tier by available balance', () => {
  // Balances 15k / 5k → 3:1 → 3000 / 1000 of a 4000 draw.
  const { svc, savings, a, b, state } = tierFixture('PROPORTIONAL', { balA: 15_000, balB: 5_000 });
  svc.replenishSavings(state, 'savingsAccount', 4000, new Date(2026, 0, 1));
  assert.strictEqual(savings.balance, 4000);
  assert.ok(Math.abs(a.balance - 12_000) < 1e-6, `accountA ${a.balance}`); // gave 3000
  assert.ok(Math.abs(b.balance - 4000)  < 1e-6, `accountB ${b.balance}`);  // gave 1000
});

test('EVT-DRAWDOWN: Lever C only reshuffles WITHIN a tier, never across tiers', () => {
  // accountA priority 1, accountB priority 2 → different tiers. Even under EQUAL,
  // the higher tier (A) drains first; B is untouched until A can't cover.
  const { svc, a, b } = drawdownFixture(null);
  const state = { savingsAccount: new CheckingAccount(0, { country: 'US', currency: USD }),
    accountA: a, accountB: b, personBirthDate: new Date(1970, 0, 1), withinTierDraw: 'EQUAL' };
  svc.replenishSavings(state, 'savingsAccount', 4000, new Date(2026, 0, 1));
  assert.strictEqual(a.balance, 6000);      // tier-1 drained
  assert.strictEqual(b.balance, 10_000);    // tier-2 untouched
});

test('EVT-DRAWDOWN: Lever C EQUAL respects per-account minimumBalance floors', () => {
  const { svc, a, b, state } = tierFixture('EQUAL', { minA: 500, minB: 500 });
  svc.replenishSavings(state, 'savingsAccount', 4000, new Date(2026, 0, 1));
  assert.ok(a.balance >= 500 && b.balance >= 500, 'floors respected');
  assert.ok(Math.abs((a.balance + b.balance) - 16_000) < 1e-6, 'exactly 4000 total drawn');
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

// ─── cross-border transfer record (design 44 Gap A / A2) ──────────────────────

test('EVT-DRAWDOWN: a cross-currency sweep returns an INTL_TRANSFER_RECORD', () => {
  const svc    = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const auSav  = new CheckingAccount(0, { country: 'AU', currency: AUD }); // AU target
  const usCash = new CheckingAccount(5000, { country: 'US', currency: USD, role: ACCOUNT_ROLES.US_SAVINGS, minimumBalance: 0, drawdownPriority: 0 });
  const state  = {
    auSavingsAccount: auSav, usSavingsAccount: usCash,
    personBirthDate: new Date(1970, 0, 1),
    effectiveExchangeRates: { USD_AUD: 1.5 },
    effectiveFxFees:        { USD_AUD: 0 },
  };
  const { crossBorderTransfers } = svc.replenishSavings(state, 'auSavingsAccount', 3000, new Date(2026, 0, 1));
  assert.strictEqual(crossBorderTransfers.length, 1);
  const t = crossBorderTransfers[0];
  assert.strictEqual(t.type, 'INTL_TRANSFER_RECORD');
  assert.strictEqual(t.direction, 'US_TO_AU');
  assert.strictEqual(t.from, 'USD');
  assert.strictEqual(t.to, 'AUD');
  assert.strictEqual(t.srcKey, 'usSavingsAccount');
  assert.strictEqual(t.dstKey, 'auSavingsAccount');
  assert.ok(Math.abs(t.toAmount   - 3000) < 0.01, `toAmount ${t.toAmount}`);   // A$3000 net
  assert.ok(Math.abs(t.fromAmount - 2000) < 0.01, `fromAmount ${t.fromAmount}`); // US$2000 drawn
});

test('EVT-DRAWDOWN: a same-currency draw produces no transfer record', () => {
  const svc    = new AccountService(new Graph(), new GraphQueryApi(new Graph()), new EventBus());
  const usSav  = new CheckingAccount(0, { country: 'US', currency: USD });
  const usCash = new CheckingAccount(5000, { country: 'US', currency: USD, role: ACCOUNT_ROLES.US_SAVINGS, minimumBalance: 0, drawdownPriority: 0 });
  const state  = { usSavingsAccount: usSav, extraCash: usCash, personBirthDate: new Date(1970, 0, 1) };
  const { crossBorderTransfers } = svc.replenishSavings(state, 'usSavingsAccount', 2000, new Date(2026, 0, 1));
  assert.strictEqual(crossBorderTransfers.length, 0);
});
