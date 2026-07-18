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
 * evt-inheritance.test.mjs — design 63 (Inheritance) tests.
 *
 * EVT-63  Inheritance — a scheduled bequest of external-decedent assets.
 *
 * Phase 1 (this file, so far): the Bequest config container + BequestService
 * expansion + serializer round-trip + seed-at-zero injection. Inherited assets
 * seed at value/balance 0 (invisible to net worth / drawdown) until the INHERIT
 * event funds them (Phase 2).
 */

import { test, beforeEach } from 'node:test';
import assert   from 'node:assert/strict';

import { ServiceRegistry }    from '../../src/services/service-registry.js';
import { ScenarioLoader }     from '../../src/scenarios/scenario-loader.js';
import { BaseScenario }       from '../../src/index.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { Bequest }            from '../../src/finance/assets/bequest.js';
import { computeNetWorth }    from '../../src/finance/derived-metrics/net-worth.js';
import { consumeHoldingsFifo } from '../../src/finance/holdings/holdings-fifo.js';
import { INHERITED_RA_DISTRIBUTION_STRATEGY, INHERITED_RA_WINDOW } from '../../src/finance/account-rules/inherited-ra-distribution-strategy.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';
import { ScenarioParamGenerator } from '../../src/scenarios/params/scenario-param-generator.js';
import { buildOptVariables }      from '../../src/finance/optimization/intl-retirement-opt-config.js';
import { InheritApplyReducer, InheritanceNeTaxApplyReducer, InheritedRaDistributionApplyReducer }
  from '../../src/finance/account-rules/inheritance-classes.js';

beforeEach(() => ServiceRegistry.resetAll());

// ─── Config helpers ─────────────────────────────────────────────────────────

function baseBequestAssets() {
  return [
    { __type: 'BrokerageAccount',      name: 'Inherited Brokerage', country: 'US',
      inheritedValue: 400_000, stateKey: 'inheritBrokerage' },
    { __type: 'TraditionalIRAAccount', name: 'Inherited IRA',       country: 'US',
      inheritedValue: 300_000, stateKey: 'inheritIra' },
    { __type: 'RealProperty',          name: 'Inherited Home',      country: 'US',
      inheritedValue: 600_000, deceasedCostBase: 200_000, stateKey: 'inheritHome' },
    { __type: 'Collectible',           name: 'Inherited Art',       country: 'US',
      inheritedValue: 80_000, stateKey: 'inheritArt' },
  ];
}

function inheritanceConfig(bequestOverrides = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'INHERITANCE'],
    simStart: '2026-01-01',
    simEnd:   '2041-01-01',
    parameters: {},
    persons: [
      { __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1975-04-15',
        citizen: ['US'], lifeExpectancy: 90, monthlyWage: 0,
        retirementDate: '2025-01-01', socialSecurityMonthly: 0 },
    ],
    accounts: [
      { __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings', type: 'savings',
        role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: 5000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
        country: 'US', currency: { code: 'USD', symbol: '$' } },
      { __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings', type: 'savings',
        role: 'au-savings', stateKey: 'auSavingsAccount', initialValue: 5000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
        country: 'AU', currency: { code: 'AUD', symbol: 'A$' } },
    ],
    bequests: [
      { __type: 'Bequest', id: 'beq1', stateKey: 'estateBequest', name: "Mother's Estate", decedentName: 'Jane Doe',
        relationship: 'immediate', decedentState: 'NE', heirId: 'primary',
        inheritanceYear: 2030, inheritanceMonth: 5, inheritanceDay: 15,
        assets: baseBequestAssets(),
        ...bequestOverrides },
    ],
  };
}

function loadToolsetScenario(config) {
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context:  services.simulationContext,
    simStart: new Date(config.simStart),
    simEnd:   new Date(config.simEnd),
  });
  scenario.buildSim();
  new ScenarioLoader().load(structuredClone(config), services);
  return { scenario, sim: scenario.sim, services };
}

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63: seed-at-zero injection
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-63: inherited assets seed onto the balance sheet at value/balance 0', () => {
  const { sim } = loadToolsetScenario(inheritanceConfig());
  const s = sim.state;

  assert.ok(s.inheritBrokerage, 'inherited brokerage should be seeded');
  assert.strictEqual(s.inheritBrokerage.balance, 0);
  assert.strictEqual(s.inheritBrokerage.type, 'brokerage');
  assert.strictEqual(s.inheritBrokerage.inherited, true);
  assert.strictEqual(s.inheritBrokerage.bequestId, 'estateBequest'); // linked on bequest stateKey (§14)

  assert.strictEqual(s.inheritIra.balance, 0);
  assert.strictEqual(s.inheritIra.type, 'ira');
  assert.strictEqual(s.inheritIra.contributionBasis, 0);

  assert.strictEqual(s.inheritHome.kind, 'real-property');
  assert.strictEqual(s.inheritHome.value, 0);

  assert.strictEqual(s.inheritArt.kind, 'collectible');
  assert.strictEqual(s.inheritArt.value, 0);
});

test('EVT-63: seeded inheritance contributes 0 to net worth before the inheritance date', () => {
  const { sim } = loadToolsetScenario(inheritanceConfig());
  const nw = computeNetWorth(sim.state, 'USD');
  // Only the two $5k savings accounts (AUD converted ~1:1 default rate) count.
  assert.ok(Math.abs(nw - 10_000) < 1e-6, `expected ~10000 net worth, got ${nw}`);
});

test('EVT-63: currency derives from asset country (USD vs AUD)', () => {
  const cfg = inheritanceConfig({
    assets: [
      { __type: 'SuperannuationAccount', name: 'Inherited Super', country: 'AU',
        inheritedValue: 500_000, stateKey: 'inheritSuper' },
    ],
  });
  const { sim } = loadToolsetScenario(cfg);
  assert.strictEqual(sim.state.inheritSuper.currency.code, 'AUD');
  assert.strictEqual(sim.state.inheritSuper.balance, 0);
  assert.strictEqual(sim.state.inheritSuper.type, 'super');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63: BequestService expansion + stateKey assignment
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-63: BequestService assigns stable stateKeys to assets that lack one', () => {
  const services = ServiceRegistry.getInstance();
  const bq = services.bequestService.createBequest(new Bequest({
    name: 'Estate', inheritanceYear: 2030,
    assets: [
      { __type: 'BrokerageAccount', inheritedValue: 100_000 },      // no stateKey
      { __type: 'Collectible', inheritedValue: 50_000, stateKey: 'keepMe' },
    ],
  }));
  // Design 63 §14.6: account-category auto-keys get an `…Account` suffix so their
  // `.balance` journal rows match the per-account reports' convention. (Promotion to
  // real records is a loader cfg-transform, so createBequest keeps the assets inline.)
  assert.strictEqual(bq.assets[0].stateKey, `${bq.id}_a0Account`);
  assert.strictEqual(bq.assets[1].stateKey, 'keepMe');

  const { seeds, inheritanceDateMs } = services.bequestService.expand(bq);
  assert.ok(seeds[`${bq.id}_a0Account`], 'auto-keyed asset should seed');
  assert.ok(seeds['keepMe'], 'explicit-keyed asset should seed');
  assert.strictEqual(inheritanceDateMs, Date.UTC(2030, 0, 15));
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63: serializer round-trip
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-63: Bequest survives serialize/deserialize round-trip', () => {
  const original = new Bequest({
    id: 'beq7', name: "Father's Estate", decedentName: 'John Doe',
    relationship: 'remote', decedentState: 'HI', heirId: 'primary',
    inheritanceYear: 2032, inheritanceMonth: 3, inheritanceDay: 1,
    paidViaEstate: true,
    assets: baseBequestAssets(),
  });
  const dto  = ScenarioSerializer._serializeBequest(original);
  assert.strictEqual(dto.__type, 'Bequest');
  const back = ScenarioSerializer._makeBequest(dto);

  assert.strictEqual(back.name, "Father's Estate");
  assert.strictEqual(back.relationship, 'remote');
  assert.strictEqual(back.decedentState, 'HI');
  assert.strictEqual(back.paidViaEstate, true);
  assert.strictEqual(back.inheritanceMonth, 3);
  assert.strictEqual(back.assets.length, 4);
  assert.strictEqual(back.assets[2].deceasedCostBase, 200_000);
  assert.strictEqual(back.assets[0].stateKey, 'inheritBrokerage');
});

test('EVT-63: bequests round-trip through the full scenario serializer path', () => {
  const services = ServiceRegistry.getInstance();
  services.bequestService.createBequest(new Bequest({
    name: 'Estate', decedentName: 'Jane', relationship: 'immediate',
    inheritanceYear: 2030, assets: baseBequestAssets(),
  }));
  const snap = ScenarioSerializer.snapshotServices(services);
  assert.strictEqual(snap.bequests.length, 1);
  assert.strictEqual(snap.bequests[0].assets.length, 4);
  assert.strictEqual(snap.bequests[0].name, 'Estate');
});

// Design 63 §14: the promotion to first-class records is a LOADER cfg-transform (so
// per-record params cascade — §14.4 load-order invariant). Going through the loader,
// an active bequest's brokerage / home / art become real service records, the bequest
// keeps only the retirement IRA inline, and each asset serializes in exactly one place
// (no double-serialize — the invariant the whole design preserves).
test('EVT-63 §14: loader promotes inherited assets to real records + serializes them once', () => {
  const { services } = loadToolsetScenario(inheritanceConfig({ decedentState: 'SD' }));
  const acct = services.accountService.getAll().find(a => a.inherited && a.stateKey === 'inheritBrokerage');
  assert.ok(acct, 'inherited brokerage is a real account record');
  assert.strictEqual(acct.bequestId, 'estateBequest', 'linked on the bequest stateKey (durable identity)');
  assert.strictEqual(acct.inheritedValue, 400_000);
  assert.ok(services.realPropertyService.getAll().some(p => p.inherited && p.stateKey === 'inheritHome'),
    'inherited home is a real real-property record');
  assert.ok(services.collectibleService.getAll().some(c => c.inherited && c.stateKey === 'inheritArt'),
    'inherited art is a real collectible record');
  // The bequest keeps only the retirement IRA inline; the promoted assets are gone.
  const bq = services.bequestService.getAll()[0];
  assert.deepStrictEqual(bq.assets.map(a => a.__type), ['TraditionalIRAAccount']);

  // No double-serialize: each promoted asset appears in exactly one serialized list.
  const snap = ScenarioSerializer.snapshotServices(services);
  assert.strictEqual(snap.bequests[0].assets.length, 1, 'only the IRA stays inline');
  assert.strictEqual(snap.accounts.filter(a => a.stateKey === 'inheritBrokerage').length, 1);
  assert.strictEqual(snap.realProperties.filter(p => p.stateKey === 'inheritHome').length, 1);
});

// Design 63 §14 P3: because the promoted assets are ordinary cfg records, they gain
// per-record generated params (rate overrides, sale year) that flow into OPT/MC/MPC +
// behavior/spending — no reroute, no cascade wrinkle. Prove they land in cfg.params
// through the REAL loader path (which runs the hoist BEFORE param generation, §14.4).
test('EVT-63 §14: promoted inherited assets gain per-record OPT/MC params through the loader', () => {
  const services = ServiceRegistry.getInstance();
  const scenario = new BaseScenario({
    context: services.simulationContext,
    simStart: new Date('2026-01-01'), simEnd: new Date('2041-01-01'),
  });
  scenario.buildSim();
  const cfg = inheritanceConfig({ decedentState: 'SD' });
  new ScenarioLoader().load(cfg, services);   // mutates cfg in place (populates cfg.params)
  const keys = new Set((cfg.params ?? []).map(p => p.name));
  assert.ok(keys.has('acct.inheritBrokerage.growthRate'),  'inherited brokerage growth-rate override');
  assert.ok(keys.has('acct.inheritBrokerage.dividendRate'), 'inherited brokerage dividend-rate override');
  assert.ok(keys.has('prop.inheritHome.plannedSaleYear'),  'inherited home sale-year param');
  assert.ok(keys.has('coll.inheritArt.plannedSaleYear'),   'inherited art sale-year param');
  // The retirement IRA keeps its inline SECURE-drawdown knobs (raAsset.), not acct.*
  assert.ok(keys.has('raAsset.inheritIra.distributionMode'), 'inherited IRA distribution strategy');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63: regression guard — no bequests ⇒ no inheritance state
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-63: no bequests configured ⇒ INHERITANCE toolset contributes no state', () => {
  const cfg = inheritanceConfig();
  cfg.bequests = [];
  const { sim } = loadToolsetScenario(cfg);
  const inheritedKeys = Object.keys(sim.state).filter(k => k.startsWith('inherit'));
  assert.strictEqual(inheritedKeys.length, 0, 'no inherited state keys should exist');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63: P2 — INHERIT funding + basis stamping
// ══════════════════════════════════════════════════════════════════════════════

// Just after the 2030-06-15 inheritance but before the first month-end expense
// draw — so P2 funding assertions see the full funded balance on the now-live
// (drawdownable) accounts, before any expense drawdown or year-end distribution.
const AFTER_INHERIT = new Date(Date.UTC(2030, 5, 20));

test('EVT-63: INHERIT event funds inherited records at the inheritance date', () => {
  const { sim } = loadToolsetScenario(inheritanceConfig());
  assert.strictEqual(sim.state.inheritBrokerage.balance, 0, 'zero before the date');

  sim.stepTo(AFTER_INHERIT);
  const s = sim.state;
  assert.strictEqual(s.inheritBrokerage.balance, 400_000);
  assert.strictEqual(s.inheritIra.balance, 300_000);
  assert.strictEqual(s.inheritHome.value, 600_000);
  assert.strictEqual(s.inheritArt.value, 80_000);
});

test('EVT-63: funded inheritance jumps net worth at the date (US step-up basis)', () => {
  // SD situs ⇒ no heir-paid inheritance tax, so the jump isolates the funding.
  const { sim } = loadToolsetScenario(inheritanceConfig({ decedentState: 'SD' }));
  // Step to the day before vs. the day after the 2030-06-15 inheritance so the
  // delta isolates the funding (no month-end expense/interest tick in between).
  sim.stepTo(new Date(Date.UTC(2030, 5, 14)));
  const before = computeNetWorth(sim.state, 'USD');
  sim.stepTo(new Date(Date.UTC(2030, 5, 16)));
  const after = computeNetWorth(sim.state, 'USD');
  // +400k brokerage +300k IRA +600k home +80k art = +1.38M
  assert.ok(Math.abs((after - before) - 1_380_000) < 100, `expected +1.38M net worth jump, got ${after - before}`);
});

test('EVT-63: US step-up — inherited brokerage seeds a single lot at FMV cost basis (≈0 next-day gain)', () => {
  const { sim } = loadToolsetScenario(inheritanceConfig()); // US heir (citizen US, residency US)
  sim.stepTo(AFTER_INHERIT);
  const holdings = sim.state.inheritBrokerage.holdings;
  assert.strictEqual(holdings.length, 1);
  assert.strictEqual(holdings[0].marketValue, 400_000);
  assert.strictEqual(holdings[0].costBasis, 400_000, 'US step-up ⇒ basis = FMV');

  // The exact function the sale path uses: selling the whole lot realizes ~0 gain.
  const r = consumeHoldingsFifo(holdings, 400_000, { level: 1, asOfMs: Date.now(), country: 'AU' });
  assert.ok(Math.abs(400_000 - r.realizedBasis) < 1, `US gain should be ~0, basis=${r.realizedBasis}`);
});

test('EVT-63: US step-up — inherited home/collectible stamp costBasis = FMV', () => {
  const { sim } = loadToolsetScenario(inheritanceConfig());
  sim.stepTo(AFTER_INHERIT);
  assert.strictEqual(sim.state.inheritHome.costBasis, 600_000);
  assert.strictEqual(sim.state.inheritArt.costBasis, 80_000);
});

test('EVT-63: AU inherited base — AU-resident heir keeps the deceased cost base (no step-up)', () => {
  const cfg = inheritanceConfig();
  // AU-resident, AU-only citizen heir. Residency is runtime-projected from
  // citizen[0] (the framework's static-residency path when no cross-border move).
  cfg.persons[0].citizen  = ['AU'];
  const deceasedAcq = Date.UTC(2005, 0, 1);
  cfg.bequests[0].assets = [
    { __type: 'BrokerageAccount', name: 'AU Brokerage', country: 'AU',
      inheritedValue: 400_000, deceasedCostBase: 150_000,
      deceasedAcquisitionDate: deceasedAcq, stateKey: 'inheritAuBrokerage' },
    { __type: 'RealProperty', name: 'AU Home', country: 'AU',
      inheritedValue: 600_000, deceasedCostBase: 200_000,
      deceasedAcquisitionDate: deceasedAcq, stateKey: 'inheritAuHome' },
  ];
  const { sim } = loadToolsetScenario(cfg);
  sim.stepTo(AFTER_INHERIT);

  // Universal costBasis = deceased base (no US step-up for the AU-only heir).
  assert.strictEqual(sim.state.inheritAuHome.costBasis, 200_000);
  assert.strictEqual(sim.state.inheritAuHome.costBaseByCountry.AU, 200_000);
  assert.strictEqual(sim.state.inheritAuHome.acquisitionDateByCountry.AU, deceasedAcq);

  const lot = sim.state.inheritAuBrokerage.holdings[0];
  assert.strictEqual(lot.costBasis, 150_000, 'no US step-up ⇒ lot basis = deceased base');
  assert.strictEqual(lot.costBaseByCountry.AU, 150_000);
  // AU sale realizes the larger gain off the deceased's low base.
  const r = consumeHoldingsFifo([lot], 400_000, { level: 1, asOfMs: Date.now(), country: 'AU' });
  assert.ok(Math.abs(r.realizedBasisByCountry.AU - 150_000) < 1, `AU basis should be deceased 150k, got ${r.realizedBasisByCountry.AU}`);
});

test('EVT-63: cross-border dual basis — US-citizen AU-resident heir gets US step-up AND AU inherited base', () => {
  const cfg = inheritanceConfig();
  // US-citizen AU-resident: dual citizen with AU residency (citizen[0]='AU'
  // drives the projected residency; includes('US') marks the US citizenship).
  cfg.persons[0].citizen = ['AU', 'US'];
  const deceasedAcq = Date.UTC(2005, 0, 1);
  cfg.bequests[0].assets = [
    { __type: 'BrokerageAccount', name: 'Brokerage', country: 'US',
      inheritedValue: 400_000, deceasedCostBase: 100_000,
      deceasedAcquisitionDate: deceasedAcq, stateKey: 'inheritXbroker' },
  ];
  const { sim } = loadToolsetScenario(cfg);
  sim.stepTo(AFTER_INHERIT);

  const lot = sim.state.inheritXbroker.holdings[0];
  assert.strictEqual(lot.costBasis, 400_000, 'US step-up ⇒ universal basis = FMV');
  assert.strictEqual(lot.costBaseByCountry.AU, 100_000, 'AU inherited base = deceased 100k');

  const r = consumeHoldingsFifo([lot], 400_000, { level: 1, asOfMs: Date.now(), country: 'AU' });
  const usGain = 400_000 - r.realizedBasis;                     // ~0 (stepped up)
  const auGain = 400_000 - (r.realizedBasisByCountry.AU ?? 0);  // ~300k (deceased base)
  assert.ok(Math.abs(usGain) < 1, `US gain ~0, got ${usGain}`);
  assert.ok(Math.abs(auGain - 300_000) < 1, `AU gain ~300k, got ${auGain}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63: P3 — SECURE 10-year inherited-RA drawdown strategies (unit)
// ══════════════════════════════════════════════════════════════════════════════

// Iterate a strategy across the 10-year window, draining `balance` each year.
function simulateWindow(strategyId, initialBalance, { params = {}, otherIncome = 0 } = {}) {
  const strat = INHERITED_RA_DISTRIBUTION_STRATEGY[strategyId];
  let balance = initialBalance;
  const dist = [];
  for (let yi = 0; yi < INHERITED_RA_WINDOW; yi++) {
    const ctx = {
      otherOrdinaryIncome: otherIncome,
      fillCeilingReal:     params.fillCeilingReal ?? 0,
      cpiIndexUS:          1,
      lumpYear:            params.lumpYear ?? 0,
      weights:             params.weights ?? [],
      WINDOW:              INHERITED_RA_WINDOW,
    };
    let amt = Math.min(balance, Math.max(0, strat.plan(balance, yi, ctx)));
    dist.push(amt);
    balance -= amt;
  }
  return { dist, total: dist.reduce((s, x) => s + x, 0), finalBalance: balance };
}

test('EVT-63: equal strategy — ~equal tenths, fully distributed by year 9', () => {
  const { dist, total, finalBalance } = simulateWindow('equal', 300_000);
  assert.ok(dist.every(d => Math.abs(d - 30_000) < 1), `expected ~30k each, got ${dist}`);
  assert.ok(Math.abs(total - 300_000) < 1);
  assert.ok(Math.abs(finalBalance) < 1);
});

test('EVT-63: lump strategy — all in the chosen year', () => {
  const y0 = simulateWindow('lump', 300_000, { params: { lumpYear: 0 } });
  assert.strictEqual(y0.dist[0], 300_000);
  assert.strictEqual(y0.dist.slice(1).reduce((s, x) => s + x, 0), 0);

  const y5 = simulateWindow('lump', 300_000, { params: { lumpYear: 5 } });
  assert.strictEqual(y5.dist[5], 300_000);
  assert.ok(Math.abs(y5.total - 300_000) < 1);
});

test('EVT-63: maxDefer strategy — nothing until year 9, then the full balance', () => {
  const { dist } = simulateWindow('maxDefer', 300_000);
  assert.strictEqual(dist.slice(0, 9).reduce((s, x) => s + x, 0), 0);
  assert.strictEqual(dist[9], 300_000);
});

test('EVT-63: bracketFill — fills ordinary income to the ceiling, spills to year 9', () => {
  // $100k ceiling, $60k other income ⇒ ~$40k/yr fill, remainder dumped in year 9.
  const { dist, total } = simulateWindow('bracketFill', 500_000, {
    params: { fillCeilingReal: 100_000 }, otherIncome: 60_000,
  });
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(dist[i] - 40_000) < 1, `year ${i} should fill 40k, got ${dist[i]}`);
  assert.ok(dist[9] > 100_000, `year-9 catch-up should dump the remainder, got ${dist[9]}`);
  assert.ok(Math.abs(total - 500_000) < 1, 'full distribution');
});

test('EVT-63: bracketFill — already over the ceiling ⇒ defer to the year-9 catch-up', () => {
  const { dist, total } = simulateWindow('bracketFill', 300_000, {
    params: { fillCeilingReal: 100_000 }, otherIncome: 120_000,
  });
  assert.strictEqual(dist.slice(0, 9).reduce((s, x) => s + x, 0), 0);
  assert.ok(Math.abs(dist[9] - 300_000) < 1);
  assert.ok(Math.abs(total - 300_000) < 1);
});

test('EVT-63: weights strategy — proportional, catch-up-clamped to full distribution', () => {
  const weights = [0.4, 0.1, 0.1, 0.1, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
  const { dist, total, finalBalance } = simulateWindow('weights', 400_000, { params: { weights } });
  assert.ok(Math.abs(dist[0] - 160_000) < 1, `year-0 = 40% of 400k, got ${dist[0]}`);
  assert.ok(Math.abs(total - 400_000) < 1);
  assert.ok(Math.abs(finalBalance) < 1);
});

test('EVT-63: every strategy fully distributes by year 9 (terminal catch-up)', () => {
  for (const id of ['equal', 'lump', 'maxDefer', 'bracketFill', 'weights']) {
    const { total, finalBalance } = simulateWindow(id, 250_000, {
      params: { fillCeilingReal: 40_000, lumpYear: 2, weights: Array(10).fill(0.1) },
      otherIncome: 30_000,
    });
    assert.ok(Math.abs(total - 250_000) < 1, `${id}: total ${total} != 250k`);
    assert.ok(Math.abs(finalBalance) < 1, `${id}: leftover ${finalBalance}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63: P3 — inherited-RA distribution integration (compiled sim)
// ══════════════════════════════════════════════════════════════════════════════

function raConfig(assetOverride = {}, params = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'INHERITANCE'],
    simStart: '2026-01-01',
    simEnd:   '2042-01-01',
    parameters: { ...params },
    persons: [
      { __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1980-04-15',
        citizen: ['US'], lifeExpectancy: 95, monthlyWage: 0,
        retirementDate: '2025-01-01', socialSecurityMonthly: 0 },
    ],
    accounts: [
      { __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings', type: 'savings',
        role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: 5000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
        country: 'US', currency: { code: 'USD', symbol: '$' } },
    ],
    bequests: [
      { __type: 'Bequest', id: 'beq1', stateKey: 'estateBequest', name: 'Estate', decedentName: 'Parent',
        relationship: 'immediate', heirId: 'primary',
        inheritanceYear: 2030, inheritanceMonth: 5, inheritanceDay: 15,
        // Strategy is now per-asset (distributionMode); default 'equal' for the tests.
        assets: [ { __type: 'TraditionalIRAAccount', name: 'Inherited IRA', country: 'US',
                    inheritedValue: 300_000, stateKey: 'inheritIra', distributionMode: 'equal', ...assetOverride } ] },
    ],
  };
}

test('EVT-63: inherited traditional IRA drains to 0 over the 10-year window (equal)', () => {
  const { sim } = loadToolsetScenario(raConfig());
  sim.stepTo(new Date(Date.UTC(2030, 8, 30)));
  assert.strictEqual(sim.state.inheritIra.balance, 300_000, 'funded, pre-first-distribution');

  sim.stepTo(new Date(Date.UTC(2031, 0, 31)));
  assert.ok(Math.abs(sim.state.inheritIra.balance - 270_000) < 1, `year-0 ~30k out, got ${sim.state.inheritIra.balance}`);

  sim.stepTo(new Date(Date.UTC(2040, 0, 31))); // past 2039 year-end = window year 9
  assert.ok(Math.abs(sim.state.inheritIra.balance) < 1, `drained by year 9, got ${sim.state.inheritIra.balance}`);

  const apply = sim.journal.getActions('INHERITED_RA_DISTRIBUTION_APPLY');
  const total = apply.reduce((s, e) => s + (e.action.data?.amount ?? 0), 0);
  assert.ok(Math.abs(total - 300_000) < 1, `total distributed ${total}`);
});

test('EVT-63: traditional distributions are ordinary income and penalty-exempt', () => {
  const { sim } = loadToolsetScenario(raConfig()); // heir age 50 at inheritance — under 59½
  sim.stepTo(new Date(Date.UTC(2033, 0, 31)));

  const tax = sim.journal.getActions('INHERITED_RA_DISTRIBUTION_TAX');
  assert.ok(tax.length >= 1, 'traditional distributions emit ordinary-income tax actions');
  assert.ok(tax.every(e => e.action.data?.penaltyAmount == null), 'no penalty on inherited distributions');
  // No early-withdrawal penalty action ever fires for the inherited stream.
  assert.strictEqual(sim.journal.getActions('EARLY_WITHDRAWAL').length, 0);
});

test('EVT-63: inherited Roth distributions are tax-free (no ordinary-income tax action)', () => {
  const cfg = raConfig({ __type: 'RothAccount', name: 'Inherited Roth', stateKey: 'inheritRoth' });
  cfg.bequests[0].assets[0].stateKey = 'inheritRoth';
  const { sim } = loadToolsetScenario(cfg);
  sim.stepTo(new Date(Date.UTC(2033, 0, 31)));

  assert.ok(sim.journal.getActions('INHERITED_RA_DISTRIBUTION_APPLY').length >= 1, 'Roth still distributes');
  assert.strictEqual(sim.journal.getActions('INHERITED_RA_DISTRIBUTION_TAX').length, 0, 'Roth is tax-free');
});

test('EVT-63: per-asset weights strategy reaches the reducer (heavy year-0 weight)', () => {
  // The strategy + weights vector now ride on the inherited-RA asset descriptor
  // (design 63 §12.3), not global params. A heavy year-0 weight proves the
  // per-account tuning is consumed by the handler.
  const cfg = raConfig({
    distributionMode: 'weights',
    weights: [0.5, 0.1, 0.1, 0.1, 0.02, 0.02, 0.02, 0.02, 0.05, 0.07],
  });
  const { sim } = loadToolsetScenario(cfg);
  sim.stepTo(new Date(Date.UTC(2031, 0, 31))); // through 2030 year-end (window year 0)

  const y0 = sim.journal.getActions('INHERITED_RA_DISTRIBUTION_APPLY')[0];
  assert.ok(y0, 'a year-0 distribution occurred');
  // weight[0]=0.5 of the summed weights (1.0) ⇒ ~50% of the 300k funded balance.
  assert.ok(Math.abs(y0.action.data.amount - 150_000) < 1, `year-0 = 50% weight, got ${y0.action.data.amount}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63: P4 — AU super death benefit (§6.4) + NE inheritance tax (§6.5)
// ══════════════════════════════════════════════════════════════════════════════

function superConfig(assetOverride = {}, bequestOverride = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'INHERITANCE'],
    simStart: '2026-01-01', simEnd: '2041-01-01',
    parameters: {},
    persons: [
      { __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1975-04-15',
        citizen: ['AU'], lifeExpectancy: 90, monthlyWage: 0,
        retirementDate: '2025-01-01', socialSecurityMonthly: 0 },
    ],
    accounts: [
      { __type: 'SavingsAccount', id: 'au-savings', name: 'AU Savings', type: 'savings',
        role: 'au-savings', stateKey: 'auSavingsAccount', initialValue: 20000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
        country: 'AU', currency: { code: 'AUD', symbol: 'A$' } },
      { __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings', type: 'savings',
        role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: 20000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
        country: 'US', currency: { code: 'USD', symbol: '$' } },
    ],
    bequests: [
      { __type: 'Bequest', id: 'beq1', stateKey: 'estateBequest', name: 'Estate', decedentName: 'Parent',
        relationship: 'immediate', decedentState: null, heirId: 'primary',
        inheritanceYear: 2030, inheritanceMonth: 5, inheritanceDay: 15,
        assets: [ { __type: 'SuperannuationAccount', name: 'Inherited Super', country: 'AU',
                    inheritedValue: 500_000, stateKey: 'inheritSuper', ...assetOverride } ],
        ...bequestOverride },
    ],
  };
}

// Just after 2030-06-15, before the AU fiscal settle (June 30) resets auSuperDeathTaxYTD.
const AFTER_SUPER = new Date(Date.UTC(2030, 5, 20));

test('EVT-63: AU super to a non-dependant paid direct — taxable × 17%, net to AU cash', () => {
  const { sim } = loadToolsetScenario(superConfig()); // paidViaEstate=false ⇒ +2% Medicare
  const before = sim.state.auSavingsAccount.balance;
  sim.stepTo(new Date(Date.UTC(2030, 5, 14)));
  const preBal = sim.state.auSavingsAccount.balance;
  sim.stepTo(AFTER_SUPER);

  // Super is NOT funded as an ongoing account.
  assert.strictEqual(sim.state.inheritSuper.balance, 0);

  const tax = sim.journal.getActions('SUPER_DEATH_BENEFIT_TAX')[0];
  assert.ok(tax, 'a super death-benefit tax action fired');
  assert.ok(Math.abs(tax.action.data.amount - 85_000) < 1, `500k × 17% = 85k, got ${tax.action.data.amount}`);

  // Net lump sum (500k − 85k = 415k) credited to AU cash.
  const delta = sim.state.auSavingsAccount.balance - preBal;
  assert.ok(Math.abs(delta - 415_000) < 5, `net 415k to AU cash, got ${delta}`);
  assert.ok(Math.abs(sim.state.auSuperDeathTaxYTD - 85_000) < 1, `bucket ${sim.state.auSuperDeathTaxYTD}`);
  void before;
});

test('EVT-63: AU super paid via estate — taxable × 15% (no Medicare)', () => {
  const { sim } = loadToolsetScenario(superConfig({}, { paidViaEstate: true }));
  sim.stepTo(AFTER_SUPER);
  const tax = sim.journal.getActions('SUPER_DEATH_BENEFIT_TAX')[0];
  assert.ok(Math.abs(tax.action.data.amount - 75_000) < 1, `500k × 15% = 75k, got ${tax.action.data.amount}`);
});

test('EVT-63: AU super tax-free component is untaxed', () => {
  // taxable 300k of 500k ⇒ tax = 300k × 17% = 51k; 200k tax-free passes through.
  const { sim } = loadToolsetScenario(superConfig({ taxableComponent: 300_000, taxFreeComponent: 200_000 }));
  sim.stepTo(AFTER_SUPER);
  const tax = sim.journal.getActions('SUPER_DEATH_BENEFIT_TAX')[0];
  assert.ok(Math.abs(tax.action.data.amount - 51_000) < 1, `only taxable 300k taxed, got ${tax.action.data.amount}`);
});

// ─── NE inheritance tax ─────────────────────────────────────────────────────

function neConfig(relationship, decedentState) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'INHERITANCE'],
    simStart: '2026-01-01', simEnd: '2041-01-01',
    parameters: {},
    persons: [
      { __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1975-04-15',
        citizen: ['US'], lifeExpectancy: 90, monthlyWage: 0,
        retirementDate: '2025-01-01', socialSecurityMonthly: 0 },
    ],
    accounts: [
      { __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings', type: 'savings',
        role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: 200_000,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
        country: 'US', currency: { code: 'USD', symbol: '$' } },
    ],
    bequests: [
      { __type: 'Bequest', id: 'beq1', stateKey: 'estateBequest', name: 'Estate', decedentName: 'Parent',
        relationship, decedentState, heirId: 'primary',
        inheritanceYear: 2030, inheritanceMonth: 5, inheritanceDay: 15,
        assets: [ { __type: 'BrokerageAccount', name: 'Inherited Brokerage', country: 'US',
                    inheritedValue: 500_000, stateKey: 'inheritBrokerage' } ] },
    ],
  };
}

// Just after 2030-06-15, before the US calendar settle (Dec 31) resets neInheritanceTaxYTD.
const AFTER_NE = new Date(Date.UTC(2030, 8, 30));

test('EVT-63: NE inheritance tax — Class 1 (immediate) $100k exempt + 1%', () => {
  const { sim } = loadToolsetScenario(neConfig('immediate', 'NE'));
  const preCash = 200_000;
  sim.stepTo(AFTER_NE);
  const ne = sim.journal.getActions('NE_INHERITANCE_TAX')[0];
  assert.ok(ne, 'NE tax fired');
  assert.ok(Math.abs(ne.action.data.amount - 4_000) < 1, `(500k−100k)×1% = 4000, got ${ne.action.data.amount}`);
  assert.ok(Math.abs(sim.state.neInheritanceTaxYTD - 4_000) < 1);
  // Heir pays it from US cash.
  assert.ok(sim.state.usSavingsAccount.balance <= preCash - 4_000 + 1, 'US cash debited for NE tax');
});

test('EVT-63: NE inheritance tax — Class 2 (remote) $40k exempt + 11%', () => {
  const { sim } = loadToolsetScenario(neConfig('remote', 'NE'));
  sim.stepTo(AFTER_NE);
  const ne = sim.journal.getActions('NE_INHERITANCE_TAX')[0];
  assert.ok(Math.abs(ne.action.data.amount - 50_600) < 1, `(500k−40k)×11% = 50600, got ${ne.action.data.amount}`);
});

test('EVT-63: NE inheritance tax — Class 3 (unrelated) $25k exempt + 15%', () => {
  const { sim } = loadToolsetScenario(neConfig('unrelated', 'NE'));
  sim.stepTo(AFTER_NE);
  const ne = sim.journal.getActions('NE_INHERITANCE_TAX')[0];
  assert.ok(Math.abs(ne.action.data.amount - 71_250) < 1, `(500k−25k)×15% = 71250, got ${ne.action.data.amount}`);
});

test('EVT-63: no heir tax for a non-NE decedent situs (SD / HI)', () => {
  for (const situs of ['SD', 'HI']) {
    const { sim } = loadToolsetScenario(neConfig('immediate', situs));
    sim.stepTo(AFTER_NE);
    assert.strictEqual(sim.journal.getActions('NE_INHERITANCE_TAX').length, 0, `${situs} ⇒ no NE tax`);
    assert.strictEqual(sim.state.neInheritanceTaxYTD ?? 0, 0);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63: P5 — default-scenario example bequest (inert by default, activatable)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-63: default scenario ships an inert example bequest (no state until a year is set)', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({}, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2041, 0, 1)));
  assert.ok((cfg.bequests ?? []).length === 1, 'one example bequest is present in the default config');
  assert.strictEqual(cfg.bequests[0].inheritanceYear ?? null, null, 'inert by default');

  const { sim } = loadToolsetScenario(cfg);
  assert.ok(sim.state.inheritedBrokerageAccount == null, 'inert ⇒ no inherited state seeded');
  assert.ok(sim.state.inheritedIraAccount == null);
});

test('EVT-63: setting inheritanceYear activates the default example bequest', () => {
  const cfg = IntlRetirementScenario.buildDefaultConfig({ inheritanceYear: 2035 },
    new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2046, 0, 1)));
  assert.strictEqual(cfg.bequests[0].inheritanceYear, 2035, 'param baked onto the bequest');

  const { sim } = loadToolsetScenario(cfg);
  assert.strictEqual(sim.state.inheritedBrokerageAccount.balance, 0, 'seeded at 0 pre-date');

  sim.stepTo(new Date(Date.UTC(2035, 8, 30))); // past 2035-01-15 inheritance, before year-end
  assert.strictEqual(sim.state.inheritedBrokerageAccount.balance, 400_000, 'funded at the date');
  assert.strictEqual(sim.state.inheritedHomeProperty.value, 600_000);
  assert.strictEqual(sim.state.inheritedIraAccount.balance, 300_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63: §12.3 — inheritance params are DERIVED from Bequest records (design 55)
// ══════════════════════════════════════════════════════════════════════════════

test('EVT-63: no Bequest record ⇒ no inheritance params are generated', () => {
  const gen = ScenarioParamGenerator.generate({ accounts: [], persons: [], bequests: [] });
  assert.ok(!gen.some(e => e.key.startsWith('bequest.') || e.key.startsWith('raAsset.')),
    'no bequest/raAsset params without a Bequest record');
});

test('EVT-63: a Bequest generates a per-record inheritanceYear param (linked via node)', () => {
  const cfg = {
    bequests: [{
      __type: 'Bequest', stateKey: 'estateBequest', name: "Parent's Estate",
      assets: [{ __type: 'BrokerageAccount', stateKey: 'inhBrok', inheritedValue: 100_000 }],
    }],
  };
  const gen = ScenarioParamGenerator.generate(cfg);
  const yearParam = gen.find(e => e.key === 'bequest.estateBequest.inheritanceYear');
  assert.ok(yearParam, 'inheritanceYear param generated per Bequest');
  assert.deepStrictEqual(yearParam.node, { type: 'bequest', stateKey: 'estateBequest', field: 'inheritanceYear' });
  // A brokerage (non-retirement) asset grows NO drawdown params.
  assert.ok(!gen.some(e => e.key.startsWith('raAsset.')), 'brokerage asset ⇒ no RA drawdown params');
});

test('EVT-63: each inherited RA asset generates per-account drawdown knobs (strategy/ceiling/lumpYear)', () => {
  const cfg = {
    bequests: [{
      __type: 'Bequest', stateKey: 'estateBequest',
      assets: [
        { __type: 'TraditionalIRAAccount', stateKey: 'inhIra', inheritedValue: 300_000, distributionMode: 'bracketFill' },
        { __type: 'RothAccount',           stateKey: 'inhRoth', inheritedValue: 200_000 },
        { __type: 'SuperannuationAccount',  stateKey: 'inhSuper', inheritedValue: 500_000 }, // no drawdown params
      ],
    }],
  };
  const gen = ScenarioParamGenerator.generate(cfg);
  const keys = new Set(gen.map(e => e.key));
  for (const sk of ['inhIra', 'inhRoth']) {
    assert.ok(keys.has(`raAsset.${sk}.distributionMode`), `${sk} strategy param`);
    assert.ok(keys.has(`raAsset.${sk}.fillCeiling`),      `${sk} ceiling param`);
    assert.ok(keys.has(`raAsset.${sk}.lumpYear`),         `${sk} lumpYear param`);
  }
  // Super is a forced lump-sum — no ongoing distribution knobs.
  assert.ok(![...keys].some(k => k.startsWith('raAsset.inhSuper.')), 'super ⇒ no drawdown params');
  // The IRA strategy param seeds from the record's distributionMode.
  assert.strictEqual(gen.find(e => e.key === 'raAsset.inhIra.distributionMode').defaultValue, 'bracketFill');
});

test('EVT-63: inherited-RA fillCeiling/lumpYear become optimizer variables (per asset)', () => {
  // Full chain: generator emits raAsset.<sk>.distributionMode → params map → the
  // opt dynamic builder discovers the RA and emits its fillCeiling + lumpYear axes.
  const cfg = {
    bequests: [{
      __type: 'Bequest', stateKey: 'estateBequest',
      assets: [
        { __type: 'TraditionalIRAAccount', stateKey: 'inhIra', inheritedValue: 300_000, distributionMode: 'bracketFill' },
        { __type: 'BrokerageAccount',      stateKey: 'inhBrok', inheritedValue: 100_000 }, // no opt axes
      ],
    }],
  };
  const params = {};
  for (const p of ScenarioParamGenerator.generate(cfg)) params[p.key] = p.defaultValue;

  const keys = new Set(buildOptVariables(params).map(v => v.paramKey));
  assert.ok(keys.has('raAsset.inhIra.fillCeiling'), 'IRA fill-ceiling is an opt variable');
  assert.ok(keys.has('raAsset.inhIra.lumpYear'),    'IRA lump-year is an opt variable');
  assert.ok(!keys.has('raAsset.inhBrok.fillCeiling'), 'brokerage grows no RA opt variable');
});

test('EVT-63: no inherited RA ⇒ no inherited-RA optimizer variables', () => {
  const keys = new Set(buildOptVariables({}).map(v => v.paramKey));
  assert.ok(![...keys].some(k => k.startsWith('raAsset.')), 'no raAsset axes without an inherited RA');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63: §13 — post-inheritance asset promotion (usable, not inert)
// ══════════════════════════════════════════════════════════════════════════════

import { computeNetLiquidity } from '../../src/finance/derived-metrics/net-liquidity.js';

// Full US machinery so promoted assets grow / draw / sell. Big cash buffer so the
// promoted brokerage isn't spent unless a test intends it.
function promotionConfig(assets, { usSavings = 2_000_000, monthlyWage = 0 } = {}) {
  return {
    toolsets: ['US_RETIREMENT', 'AU_RETIREMENT', 'US_REAL_PROPERTY', 'US_COLLECTIBLES', 'INHERITANCE'],
    simStart: '2026-01-01', simEnd: '2046-01-01',
    parameters: {},
    persons: [
      { __type: 'Person', id: 'primary', name: 'Primary', birthDate: '1965-04-15',
        citizen: ['US'], lifeExpectancy: 95, monthlyWage,
        retirementDate: '2025-01-01', socialSecurityMonthly: 0 },
    ],
    accounts: [
      { __type: 'SavingsAccount', id: 'us-savings', name: 'US Savings', type: 'savings',
        role: 'us-savings', stateKey: 'usSavingsAccount', initialValue: usSavings,
        ownershipType: 'sole', ownerId: 'primary', minimumBalance: 0,
        country: 'US', currency: { code: 'USD', symbol: '$' } },
    ],
    bequests: [
      { __type: 'Bequest', id: 'beq1', stateKey: 'estateBequest', name: 'Estate', decedentName: 'Parent',
        relationship: 'immediate', heirId: 'primary',
        inheritanceYear: 2030, inheritanceMonth: 5, inheritanceDay: 15, assets },
    ],
  };
}

test('EVT-63 §13: inherited brokerage counts toward net liquidity once funded', () => {
  const { sim } = loadToolsetScenario(promotionConfig([
    { __type: 'BrokerageAccount', name: 'Inherited Brokerage', country: 'US',
      inheritedValue: 400_000, stateKey: 'inheritBrokerage' },
  ]));
  const liq0 = computeNetLiquidity(sim.state, new Date(Date.UTC(2027, 0, 1)), 'USD');
  sim.stepTo(new Date(Date.UTC(2030, 5, 20)));
  const liq1 = computeNetLiquidity(sim.state, new Date(Date.UTC(2030, 5, 20)), 'USD');
  assert.ok(liq1 - liq0 >= 400_000 - 1, `inherited brokerage should add ~400k to net liquidity, got +${liq1 - liq0}`);
});

test('EVT-63 §13: inherited brokerage is drawn to cover expenses (drawdownable)', () => {
  // Little cash + a wage-free retiree ⇒ expenses fall through to the inherited brokerage.
  const { sim } = loadToolsetScenario(promotionConfig([
    { __type: 'BrokerageAccount', name: 'Inherited Brokerage', country: 'US',
      inheritedValue: 400_000, stateKey: 'inheritBrokerage' },
  ], { usSavings: 3_000 }));
  sim.stepTo(new Date(Date.UTC(2032, 0, 31))); // ~1.5y of expenses past the inheritance
  assert.ok(sim.state.inheritBrokerage.balance < 400_000,
    `inherited brokerage should be drawn for expenses, still ${sim.state.inheritBrokerage.balance}`);
});

test('EVT-63 §13: inherited brokerage grows after inheritance', () => {
  const { sim } = loadToolsetScenario(promotionConfig([
    { __type: 'BrokerageAccount', name: 'Inherited Brokerage', country: 'US',
      inheritedValue: 400_000, stateKey: 'inheritBrokerage' },
  ]));
  sim.stepTo(new Date(Date.UTC(2030, 5, 20)));
  const funded = sim.state.inheritBrokerage.balance;
  sim.stepTo(new Date(Date.UTC(2033, 0, 31))); // a few year-ends of equity growth
  assert.ok(sim.state.inheritBrokerage.balance > funded,
    `inherited brokerage should grow post-inheritance: ${funded} → ${sim.state.inheritBrokerage.balance}`);
});

test('EVT-63 §13: inherited real property appreciates and is sellable at a set sale year', () => {
  const { sim } = loadToolsetScenario(promotionConfig([
    { __type: 'RealProperty', name: 'Inherited Home', country: 'US',
      inheritedValue: 600_000, deceasedCostBase: 200_000, appreciationRate: 0.04,
      plannedSaleYear: 2035, stateKey: 'inheritHome' },
  ]));
  sim.stepTo(new Date(Date.UTC(2033, 0, 31)));
  assert.ok(sim.state.inheritHome.value > 600_000, `home should appreciate, got ${sim.state.inheritHome.value}`);

  const cashBefore = sim.state.usSavingsAccount.balance;
  sim.stepTo(new Date(Date.UTC(2035, 6, 1))); // past the 2035 planned sale
  assert.ok((sim.state.inheritHome.value ?? 0) < 1, `home should be sold (value→0), got ${sim.state.inheritHome.value}`);
  assert.ok(sim.state.usSavingsAccount.balance > cashBefore, 'sale proceeds credited to cash');
});

test('EVT-63 §13: inherited collectible is sellable at a set sale year', () => {
  const { sim } = loadToolsetScenario(promotionConfig([
    { __type: 'Collectible', name: 'Inherited Gold', country: 'US', isGold: true,
      inheritedValue: 100_000, appreciationRate: 0.03, plannedSaleYear: 2034, stateKey: 'inheritGold' },
  ]));
  sim.stepTo(new Date(Date.UTC(2033, 0, 31)));
  assert.ok(sim.state.inheritGold.value >= 100_000, `gold should appreciate, got ${sim.state.inheritGold.value}`);
  sim.stepTo(new Date(Date.UTC(2034, 6, 1)));
  assert.ok((sim.state.inheritGold.value ?? 0) < 1, `gold should be sold, got ${sim.state.inheritGold.value}`);
});

test('EVT-63 §13: promoted inherited property/collectible generate the standard sale-year param', () => {
  // Design 63 §14: promoted inherited property/collectible are real records, so they
  // generate the standard prop./coll. plannedSaleYear param (keyed by the real record,
  // node type realProperty/collectible) — the bequest-specific saleAsset. is retired.
  const cfg = {
    realProperties: [{ __type: 'RealProperty', stateKey: 'inhHome', name: 'Inherited Home',
      country: 'US', value: 0, inherited: true, bequestId: 'beq1', plannedSaleYear: null }],
    collectibles:   [{ __type: 'Collectible', stateKey: 'inhArt', name: 'Inherited Art',
      country: 'US', value: 0, inherited: true, bequestId: 'beq1', plannedSaleYear: null }],
    accounts:       [{ __type: 'BrokerageAccount', stateKey: 'inhBrokAccount', name: 'Inherited Brokerage',
      type: 'brokerage', role: 'us-stock', country: 'US', inherited: true, bequestId: 'beq1' }],
  };
  const gen  = ScenarioParamGenerator.generate(cfg);
  const keys = new Set(gen.map(e => e.key));
  assert.ok(keys.has('prop.inhHome.plannedSaleYear'), 'property sale-year param');
  assert.ok(keys.has('coll.inhArt.plannedSaleYear'),  'collectible sale-year param');
  // The promoted brokerage is discovered too (its own acct. params), but accounts have
  // no plannedSaleYear field.
  assert.ok([...keys].some(k => k.startsWith('acct.inhBrokAccount.')), 'brokerage generates acct. params');
  assert.ok(![...keys].some(k => k.endsWith('.plannedSaleYear') && k.startsWith('acct.')), 'brokerage grows no sale-year param');
  assert.deepStrictEqual(
    gen.find(e => e.key === 'prop.inhHome.plannedSaleYear').node,
    { type: 'realProperty', stateKey: 'inhHome', field: 'plannedSaleYear' });
});

test('EVT-63 §13: the sale-year PARAM cascades onto the asset and liquidates it', () => {
  const cfg = promotionConfig([
    { __type: 'RealProperty', name: 'Inherited Home', country: 'US',
      inheritedValue: 600_000, deceasedCostBase: 200_000, appreciationRate: 0.04, stateKey: 'inheritHome' },
  ]);
  // Sale year supplied ONLY via the generated per-record param (no plannedSaleYear
  // on the asset descriptor) — proves the param → cascade → promoted-record → sale
  // chain. The promoted home is a real realProperty record, so the standard
  // prop.<sk>.plannedSaleYear param cascades onto it (design 63 §14).
  cfg.parameters = { 'prop.inheritHome.plannedSaleYear': 2035 };
  const { sim } = loadToolsetScenario(cfg);

  const cashBefore = sim.state.usSavingsAccount.balance;
  sim.stepTo(new Date(Date.UTC(2035, 6, 1)));
  assert.ok((sim.state.inheritHome.value ?? 0) < 1, `param-driven sale should liquidate the home, got ${sim.state.inheritHome.value}`);
  assert.ok(sim.state.usSavingsAccount.balance > cashBefore, 'proceeds credited to cash');
});

// ══════════════════════════════════════════════════════════════════════════════
// EVT-63 §14: cross-border cash escalation — an inherited-asset cash movement in a
// country the heir does not bank in (design 63 §7). Formerly `resolveCashKey`
// returned an absent legacy key here; the RA-distribution site dereferenced it and
// CRASHED (`transaction(undefined)`), the super/NE sites silently dropped the money.
// resolvePresentCash now lands/sources cross-border (currency-converted) instead.
// stateRegistry stub resolves no role account, so resolveCashKey falls to the legacy
// literal — present only when the state carries usSavingsAccount / auSavingsAccount.
// ══════════════════════════════════════════════════════════════════════════════

const noRoleRegistry = () => ({ getStateKey: () => null });

test('EVT-63 §14: inherited-RA distribution for a heir with no US cash lands cross-border in AU cash (regression: no crash)', () => {
  const accountService = ServiceRegistry.getInstance().accountService;
  const reducer = new InheritedRaDistributionApplyReducer({ accountService, stateRegistry: noRoleRegistry() });
  const state = {
    inheritIra:       { balance: 300_000, holdings: [], type: 'ira' },
    auSavingsAccount: { balance: 5_000, holdings: [], currency: { code: 'AUD' }, country: 'AU' },
  };
  const next = reducer.reduce(state, { type: 'INHERITED_RA_DISTRIBUTION_APPLY', amount: 30_000, stateKey: 'inheritIra', isRoth: false, residency: 'AU' });
  assert.strictEqual(next.inheritIra.balance, 270_000, 'IRA drawn down');
  // No FX rate in this bare state ⇒ native amount lands (documented fallback); the
  // point is it lands SOMEWHERE rather than crashing on an absent US cash pool.
  assert.strictEqual(state.auSavingsAccount.balance, 35_000, 'proceeds credited cross-border to AU cash');
});

test('EVT-63 §14: inherited-RA distribution is byte-identical when US cash exists (no cross-border)', () => {
  const accountService = ServiceRegistry.getInstance().accountService;
  const reducer = new InheritedRaDistributionApplyReducer({ accountService, stateRegistry: noRoleRegistry() });
  const state = {
    inheritIra:       { balance: 300_000, holdings: [], type: 'ira' },
    usSavingsAccount: { balance: 5_000, holdings: [], currency: { code: 'USD' }, country: 'US' },
    auSavingsAccount: { balance: 5_000, holdings: [], currency: { code: 'AUD' }, country: 'AU' },
  };
  reducer.reduce(state, { type: 'INHERITED_RA_DISTRIBUTION_APPLY', amount: 30_000, stateKey: 'inheritIra', isRoth: false, residency: 'US' });
  assert.strictEqual(state.usSavingsAccount.balance, 35_000, 'credited to US cash as before');
  assert.strictEqual(state.auSavingsAccount.balance, 5_000, 'AU cash untouched');
});

test('EVT-63 §14: no cash account anywhere ⇒ RA distribution no-ops instead of crashing', () => {
  const accountService = ServiceRegistry.getInstance().accountService;
  const reducer = new InheritedRaDistributionApplyReducer({ accountService, stateRegistry: noRoleRegistry() });
  const state = { inheritIra: { balance: 300_000, holdings: [], type: 'ira' } };
  const next = reducer.reduce(state, { type: 'INHERITED_RA_DISTRIBUTION_APPLY', amount: 30_000, stateKey: 'inheritIra', isRoth: false, residency: 'AU' });
  assert.strictEqual(next.inheritIra.balance, 270_000, 'IRA drawn down; proceeds simply have nowhere to land');
});

test('EVT-63 §14: NE inheritance tax sources cross-border from AU cash when the heir has no US cash', () => {
  const accountService = ServiceRegistry.getInstance().accountService;
  const reducer = new InheritanceNeTaxApplyReducer({ accountService, stateRegistry: noRoleRegistry() });
  const state = { auSavingsAccount: { balance: 5_000, holdings: [], currency: { code: 'AUD' }, country: 'AU' } };
  reducer.reduce(state, { type: 'NE_INHERITANCE_TAX', amount: 1_000 });
  assert.strictEqual(state.auSavingsAccount.balance, 4_000, 'NE tax debited cross-border from AU cash');
});

test('EVT-63 §14: AU super lump-sum lands cross-border in US cash for a US-only heir', () => {
  const accountService = ServiceRegistry.getInstance().accountService;
  const reducer = new InheritApplyReducer({ accountService, stateRegistry: noRoleRegistry() });
  const state = {
    inheritSuper:     { balance: 0, holdings: [], type: 'super', currency: { code: 'AUD' } },
    usSavingsAccount: { balance: 10_000, holdings: [], currency: { code: 'USD' }, country: 'US' },
  };
  // taxable 500k, paid direct ⇒ tax = 500k × 0.17 = 85k; net = 415k credited to cash.
  reducer.reduce(state, { type: 'INHERIT_APPLY', stateKey: 'inheritSuper', isSuper: true, category: 'account', inheritedValue: 500_000, taxableComponent: 500_000, paidViaEstate: false });
  assert.strictEqual(state.usSavingsAccount.balance, 10_000 + 415_000, 'net super lump sum lands cross-border in US cash');
});
