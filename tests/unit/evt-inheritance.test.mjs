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
      { __type: 'Bequest', id: 'beq1', name: "Mother's Estate", decedentName: 'Jane Doe',
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
  assert.strictEqual(s.inheritBrokerage.bequestId, 'beq1');

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
  assert.strictEqual(bq.assets[0].stateKey, `${bq.id}_a0`);
  assert.strictEqual(bq.assets[1].stateKey, 'keepMe');

  const { seeds, inheritanceDateMs } = services.bequestService.expand(bq);
  assert.ok(seeds[`${bq.id}_a0`], 'auto-keyed asset should seed');
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

const AFTER_INHERIT = new Date(Date.UTC(2030, 11, 31)); // past 2030-06-15

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
  const { sim } = loadToolsetScenario(inheritanceConfig());
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
