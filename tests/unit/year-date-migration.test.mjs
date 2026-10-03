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
 * Design 117 phase 2 — the sale and purchase YEARS became dates. Every road a saved plan,
 * param bag or sweep config can take in must convert it to exactly the date the code
 * built from the year before (15 Jan), and none may leave a dead year field behind.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { migrateYearFieldsToDates, migrateParamBag, migratedParamKey, toSaleDate, saleDateToUtc,
  yearOfDate, migrateMcVariableConfig, migrateOptVariableConfig }
  from '../../src/scenarios/year-date-migration.js';
import { RealProperty } from '../../src/finance/assets/real-property.js';
import { Collectible } from '../../src/finance/assets/collectible.js';
import { CompanyEquity } from '../../src/finance/assets/company-equity.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';
import { IntlRetirementScenario } from '../../src/scenarios/intl-retirement-scenario.js';

describe('value conversion', () => {
  test('a year is 15 Jan of that year; a date passes through as its day', () => {
    assert.equal(toSaleDate(2031), '2031-01-15');
    assert.equal(toSaleDate(2031.4), '2031-01-15', 'a sampled fractional year rounds, as the old patch did');
    assert.equal(toSaleDate('2031'), '2031-01-15');
    assert.equal(toSaleDate('2031-07-01'), '2031-07-01');
    assert.equal(toSaleDate('2031-07-01T00:00:00.000Z'), '2031-07-01');
    assert.equal(toSaleDate(new Date(Date.UTC(2031, 6, 1))), '2031-07-01');
    assert.equal(toSaleDate(null), null);
    assert.equal(toSaleDate(''), null);
  });

  test('the event instant of a migrated year is exactly the old Date.UTC(Y, 0, 15)', () => {
    assert.equal(saleDateToUtc(toSaleDate(2030)).getTime(), Date.UTC(2030, 0, 15));
    assert.equal(saleDateToUtc('2030-07-01').getTime(), Date.UTC(2030, 6, 1));
    assert.equal(saleDateToUtc(null), null);
  });

  test('yearOfDate reads the year of a date or a legacy year', () => {
    assert.equal(yearOfDate('2030-07-01'), 2030);
    assert.equal(yearOfDate(2030), 2030);
    assert.equal(yearOfDate(null), null);
  });
});

describe('param keys', () => {
  test('generated sale/purchase year keys rename; the retired flat keys find their record', () => {
    assert.equal(migratedParamKey('prop.cabin.plannedSaleYear'), 'prop.cabin.plannedSaleDate');
    assert.equal(migratedParamKey('coll.art.plannedSaleYear'), 'coll.art.plannedSaleDate');
    assert.equal(migratedParamKey('equity.rsu.plannedSaleYear'), 'equity.rsu.plannedSaleDate');
    assert.equal(migratedParamKey('usHouseSaleYear'), 'prop.usHouseProperty.plannedSaleDate');
    assert.equal(migratedParamKey('auHouseSaleYear'), 'prop.auHouseProperty.plannedSaleDate');
    assert.equal(migratedParamKey('companySaleYear'), 'equity.companyEquityAccount.plannedSaleDate');
    assert.equal(migratedParamKey('companySaleYear', { type: 'companyEquity', stateKey: 'rsu2' }),
      'equity.rsu2.plannedSaleDate', 'a saved entry\'s own node names its record');
  });

  test('every other key is left alone', () => {
    for (const k of ['prop.cabin.plannedSaleDate', 'acct.x.plannedSaleYear', 'moveDate',
      'prop.cabin.mainResidenceFromYear', 'rothConversionStartYear', null, 42]) {
      assert.equal(migratedParamKey(k), null, String(k));
    }
  });

  test('a bag converts, returns a copy, and never mutates the caller\'s bag', () => {
    const bag = { usHouseSaleYear: 2034, inflationRate: 0.03 };
    const out = migrateParamBag(bag);
    assert.deepEqual(out, { 'prop.usHouseProperty.plannedSaleDate': '2034-01-15', inflationRate: 0.03 });
    assert.deepEqual(bag, { usHouseSaleYear: 2034, inflationRate: 0.03 });
    const clean = { inflationRate: 0.03 };
    assert.strictEqual(migrateParamBag(clean), clean, 'nothing to change → the same object');
  });

  test('two names of one sale: the one that moved off the plan wins', () => {
    const K = 'prop.usHouseProperty.plannedSaleDate';
    const planOf = () => '2030-01-15';
    assert.equal(migrateParamBag({ usHouseSaleYear: 2034, 'prop.usHouseProperty.plannedSaleYear': 2030 }, { planOf })[K],
      '2034-01-15');
    assert.equal(migrateParamBag({ usHouseSaleYear: 2030, 'prop.usHouseProperty.plannedSaleYear': 2034 }, { planOf })[K],
      '2034-01-15');
    assert.equal(migrateParamBag({ [K]: '2032-03-01', usHouseSaleYear: 2030 }, { planOf })[K], '2032-03-01');
    // With no plan to compare, the new key wins, then the old generated key, then the flat key.
    assert.equal(migrateParamBag({ usHouseSaleYear: 2034, 'prop.usHouseProperty.plannedSaleYear': 2030 })[K],
      '2030-01-15');
  });
});

describe('a scenario cfg', () => {
  const legacyCfg = () => ({
    realProperties: [
      { stateKey: 'house', plannedSaleYear: 2031, purchaseYear: 2027 },
      { stateKey: 'blank', plannedSaleYear: null },
    ],
    collectibles:    [{ stateKey: 'art', plannedSaleYear: 2033 }],
    companyEquities: [{ stateKey: 'rsu', plannedSaleYear: 2030 }],
    bequests: [{ stateKey: 'estate', assets: [{ __type: 'RealProperty', stateKey: 'inh', plannedSaleYear: 2036 }] }],
    params: [
      { name: 'companySaleYear', type: 'Number', value: 2030, defaultValue: 2033,
        node: { type: 'companyEquity', stateKey: 'rsu', field: 'plannedSaleYear' } },
      { name: 'prop.house.plannedSaleYear', type: 'Number', value: 2031,
        node: { type: 'realProperty', stateKey: 'house', field: 'plannedSaleYear' } },
      { name: 'inflationRate', type: 'Number', value: 0.03 },
    ],
    parameters: { companySaleYear: 2030, 'prop.house.plannedSaleYear': 2031, inflationRate: 0.03 },
    initialState: {
      house: { kind: 'real-property', plannedSaleYear: 2031, purchaseYear: 2027 },
      brokerage: { kind: 'brokerage', holdings: { h1: { purchaseDate: 1_700_000_000_000 } } },
      odd: { kind: 'brokerage', purchaseDate: 1_700_000_000_000 },
    },
  });

  test('records, bequest assets and both param stores carry dates; no year field survives', () => {
    const cfg = migrateYearFieldsToDates(legacyCfg());
    assert.deepEqual(cfg.realProperties, [
      { stateKey: 'house', plannedSaleDate: '2031-01-15', purchaseDate: '2027-01-15' },
      { stateKey: 'blank', plannedSaleDate: null },
    ]);
    assert.deepEqual(cfg.collectibles, [{ stateKey: 'art', plannedSaleDate: '2033-01-15' }]);
    assert.deepEqual(cfg.companyEquities, [{ stateKey: 'rsu', plannedSaleDate: '2030-01-15' }]);
    assert.equal(cfg.bequests[0].assets[0].plannedSaleDate, '2036-01-15');
    assert.deepEqual(cfg.params.map(p => [p.name, p.type, p.value, p.node?.field ?? null]), [
      ['equity.rsu.plannedSaleDate', 'Date', '2030-01-15', 'plannedSaleDate'],
      ['prop.house.plannedSaleDate', 'Date', '2031-01-15', 'plannedSaleDate'],
      ['inflationRate', 'Number', 0.03, null],
    ]);
    assert.equal(cfg.params[0].defaultValue, '2033-01-15');
    assert.deepEqual(cfg.parameters, {
      'equity.rsu.plannedSaleDate': '2030-01-15', 'prop.house.plannedSaleDate': '2031-01-15', inflationRate: 0.03 });
    assert.ok(!JSON.stringify(cfg).match(/plannedSaleYear|purchaseYear|companySaleYear/));
  });

  test('saved state renames only on asset entries — a holding\'s epoch-ms purchaseDate is untouched', () => {
    const cfg = migrateYearFieldsToDates(legacyCfg());
    assert.deepEqual(cfg.initialState.house, { kind: 'real-property', plannedSaleDate: '2031-01-15', purchaseDate: '2027-01-15' });
    assert.equal(cfg.initialState.brokerage.holdings.h1.purchaseDate, 1_700_000_000_000);
    assert.equal(cfg.initialState.odd.purchaseDate, 1_700_000_000_000, 'never read as a year');
  });

  test('migration is idempotent', () => {
    const once  = migrateYearFieldsToDates(legacyCfg());
    const twice = migrateYearFieldsToDates(structuredClone(once));
    assert.deepEqual(twice, once);
  });

  test('a legacy key beside its successor in the typed list: the already-new entry stays', () => {
    const cfg = migrateYearFieldsToDates({ params: [
      { name: 'usHouseSaleYear', type: 'Number', value: 2030,
        node: { type: 'realProperty', stateKey: 'usHouseProperty', field: 'plannedSaleYear' } },
      { name: 'x', value: 1 },
      { name: 'prop.usHouseProperty.plannedSaleDate', type: 'Date', value: '2032-06-30',
        node: { type: 'realProperty', stateKey: 'usHouseProperty', field: 'plannedSaleDate' } },
    ] });
    assert.deepEqual(cfg.params.map(p => [p.name, p.value]),
      [['prop.usHouseProperty.plannedSaleDate', '2032-06-30'], ['x', 1]]);
  });

  test('a full ISO or Date on a record is cut to its day', () => {
    const cfg = migrateYearFieldsToDates({ realProperties: [
      { stateKey: 'a', plannedSaleDate: '2031-07-01T00:00:00.000Z' },
      { stateKey: 'b', purchaseDate: new Date(Date.UTC(2030, 2, 5)) },
    ] });
    assert.equal(cfg.realProperties[0].plannedSaleDate, '2031-07-01');
    assert.equal(cfg.realProperties[1].purchaseDate, '2030-03-05');
  });
});

describe('saved sweep configs', () => {
  test('a NORMAL sale-year MC row becomes a NORMAL_DATE of the same shape', () => {
    assert.deepEqual(migrateMcVariableConfig(
      { paramKey: 'usHouseSaleYear', type: 'normal', mean: 2036, stdDev: 1.5, integer: true, enabled: true }),
      { paramKey: 'prop.usHouseProperty.plannedSaleDate', type: 'normalDate', mean: '2036-01-15', stdDev: 548, enabled: true });
    assert.deepEqual(migrateMcVariableConfig({ paramKey: 'coll.art.plannedSaleYear', type: 'uniform', min: 2030, max: 2034 }),
      { paramKey: 'coll.art.plannedSaleDate', type: 'uniformDate', min: '2030-01-15', max: '2034-01-15' });
    const other = { paramKey: 'inflationRate', type: 'normal', mean: 0.03 };
    assert.strictEqual(migrateMcVariableConfig(other), other);
  });

  test('an INTEGER sale-year Opt row becomes a DATE range on 15 Jan, its step in months', () => {
    assert.deepEqual(migrateOptVariableConfig(
      { paramKey: 'prop.cabin.plannedSaleYear', type: 'integer', min: 2028, max: 2034, step: 2, enabled: true }),
      { paramKey: 'prop.cabin.plannedSaleDate', type: 'date', min: '2028-01-15', max: '2034-01-15', step: 24, enabled: true });
  });
});

describe('every other road', () => {
  test('an asset constructed with a retired year field throws, naming its successor', () => {
    assert.throws(() => new RealProperty(1, { name: 'H', plannedSaleYear: 2030 }), /plannedSaleYear.*plannedSaleDate/);
    assert.throws(() => new RealProperty(1, { name: 'H', purchaseYear: 2030 }), /purchaseYear.*purchaseDate/);
    assert.throws(() => new Collectible(1, { name: 'C', plannedSaleYear: null }), /retired/);
    assert.throws(() => new CompanyEquity(1, { name: 'E', plannedSaleYear: 2030 }), /retired/);
    assert.equal(new RealProperty(1, { name: 'H', plannedSaleDate: '2030-07-01' }).plannedSaleDate, '2030-07-01');
  });

  test('the serializer writes only dates, and still reads a saved year', () => {
    const cfg = IntlRetirementScenario.buildDefaultConfig({ 'prop.usHouseProperty.plannedSaleDate': '2031-07-01' });
    const out = ScenarioSerializer.serializeScenario(cfg);
    assert.equal(out.realProperties.find(p => p.stateKey === 'usHouseProperty').plannedSaleDate, '2031-07-01');
    assert.ok(!JSON.stringify(out.realProperties).match(/plannedSaleYear|purchaseYear/));
  });

  test('buildDefaultConfig takes a legacy sale-year override as its date', () => {
    const cfg = IntlRetirementScenario.buildDefaultConfig({ usHouseSaleYear: 2035, companySaleYear: 2030 });
    assert.equal(cfg.realProperties.find(p => p.stateKey === 'usHouseProperty').plannedSaleDate, '2035-01-15');
    assert.equal(cfg.companyEquities[0].plannedSaleDate, '2030-01-15');
    const dflt = IntlRetirementScenario.buildDefaultConfig({});
    assert.equal(dflt.companyEquities[0].plannedSaleDate, '2033-01-15', 'the default sale: 15 Jan 2033, as before');
  });
});

// ─── Phase 3: the inheritance date and the per-person 401(k) rollover ─────────

describe('phase 3 — inheritance date', () => {
  test('a bequest\'s year, hidden month (0-based) and day become one date', () => {
    const cfg = migrateYearFieldsToDates({ bequests: [
      { stateKey: 'a', inheritanceYear: 2030, inheritanceMonth: 5, inheritanceDay: 3 },
      { stateKey: 'b', inheritanceYear: 2031 },
      { stateKey: 'c', inheritanceYear: null, inheritanceMonth: 0, inheritanceDay: 15 },
    ] });
    assert.deepEqual(cfg.bequests, [
      { stateKey: 'a', inheritanceDate: '2030-06-03' },
      { stateKey: 'b', inheritanceDate: '2031-01-15' },
      { stateKey: 'c', inheritanceDate: null },
    ]);
  });

  test('the bequest\'s generated year param keeps that bequest\'s own month and day', () => {
    const cfg = migrateYearFieldsToDates({
      bequests: [{ stateKey: 'estate', inheritanceYear: 2030, inheritanceMonth: 5, inheritanceDay: 3 }],
      params: [{ name: 'bequest.estate.inheritanceYear', type: 'Number', value: 2032,
        node: { type: 'bequest', stateKey: 'estate', field: 'inheritanceYear' } }],
      parameters: { 'bequest.estate.inheritanceYear': 2032 },
    });
    assert.deepEqual([cfg.params[0].name, cfg.params[0].value, cfg.params[0].node.field],
      ['bequest.estate.inheritanceDate', '2032-06-03', 'inheritanceDate']);
    assert.deepEqual(cfg.parameters, { 'bequest.estate.inheritanceDate': '2032-06-03' });
  });

  test('a Bequest built with a retired field throws; the serializer reads a saved one', async () => {
    const { Bequest } = await import('../../src/finance/assets/bequest.js');
    assert.throws(() => new Bequest({ name: 'E', inheritanceYear: 2030 }), /inheritanceYear.*inheritanceDate/);
    assert.throws(() => new Bequest({ name: 'E', inheritanceMonth: 2 }), /retired/);
    const back = ScenarioSerializer._makeBequest(
      { __type: 'Bequest', name: 'E', inheritanceYear: 2030, inheritanceMonth: 5, inheritanceDay: 3, assets: [] });
    assert.equal(back.inheritanceDate, '2030-06-03');
  });
});

describe('phase 3 — the 401(k) rollover becomes each person\'s date (D9)', () => {
  const persons = () => [
    { id: 'primary', retirementDate: '2040-01-01T00:00:00.000Z' },
    { id: 'spouse',  retirementDate: '2042-07-15T00:00:00.000Z' },
    { id: 'kid' },                                            // no retirement date
  ];

  test('a year-only setting meant a different day per owner — and still does', () => {
    const cfg = migrateYearFieldsToDates({ persons: persons(),
      params: [{ name: 'k401ToIraConversionYear', value: 2043 }, { name: 'x', value: 1 }],
      parameters: { k401ToIraConversionYear: 2043, x: 1 } });
    assert.deepEqual(cfg.persons.map(p => p.k401ToIraConversionDate ?? null),
      ['2043-01-01', '2043-07-15', null], 'each blank part from THAT person\'s retirement date');
    assert.deepEqual(cfg.params, [{ name: 'x', value: 1 }], 'the three params are retired');
    assert.deepEqual(cfg.parameters, { x: 1 });
  });

  test('all three parts set: one date for every owner; none set: blank (at separation)', () => {
    const full = migrateYearFieldsToDates({ persons: persons(),
      parameters: { k401ToIraConversionYear: 2044, k401ToIraConversionMonth: 3, k401ToIraConversionDay: 10 } });
    assert.deepEqual(full.persons.slice(0, 2).map(p => p.k401ToIraConversionDate), ['2044-03-10', '2044-03-10']);
    const none = migrateYearFieldsToDates({ persons: persons(),
      parameters: { k401ToIraConversionYear: null, k401ToIraConversionMonth: null } });
    assert.ok(none.persons.every(p => p.k401ToIraConversionDate == null));
    assert.deepEqual(none.parameters, {});
  });

  test('a person\'s own date is never overwritten, and migration is idempotent', () => {
    const ps = persons(); ps[0].k401ToIraConversionDate = '2041-02-02';
    const cfg = migrateYearFieldsToDates({ persons: ps, parameters: { k401ToIraConversionMonth: 12 } });
    assert.deepEqual(cfg.persons.slice(0, 2).map(p => p.k401ToIraConversionDate), ['2041-02-02', '2042-12-15']);
    assert.deepEqual(migrateYearFieldsToDates(structuredClone(cfg)), cfg);
  });

  test('a bag converts per person when the cfg\'s people are known', () => {
    const out = migrateParamBag({ k401ToIraConversionYear: 2043, y: 2 }, { persons: persons() });
    assert.deepEqual(out, { y: 2, 'person.primary.k401ToIraConversionDate': '2043-01-01',
      'person.spouse.k401ToIraConversionDate': '2043-07-15' });
  });
});

describe('phase 3 — liveness on a loaded plan', () => {
  test('person.primary.k401ToIraConversionDate, applied as a lever, moves the rollover', async () => {
    const { loadScenarioSim } = await import('../helpers/scenario-harness.js');
    const { applyParamBagToConfig } = await import('../../src/scenarios/scenario-param-apply.js');
    const run = (date) => loadScenarioSim({
      simEnd: new Date(Date.UTC(2041, 0, 1)), telemetry: 'off',
      mutateCfg: (cfg) => { if (date) applyParamBagToConfig(cfg, { 'person.primary.k401ToIraConversionDate': date }); },
      stepTo: new Date(Date.UTC(2040, 5, 1)),
    }).sim.state.k401Account.balance;
    // The reference plan retires the primary on 1 Jan 2040: by June the 401(k) has rolled over…
    assert.equal(run(null), 0);
    // …unless the rollover is dated September, which the lever must reach.
    assert.ok(run('2040-09-01') > 0, 'the per-person date reached the sim');
  });
});

// ─── Phase 4: the moves, pinned to a tax-year boundary (D5, D8) ───────────────

describe('phase 4 — the moves', () => {
  test('a move YEAR is that year\'s anchor day: 1 Jul for the AU move, 1 Jan for a state move', () => {
    assert.deepEqual(migrateParamBag({ moveYear: 2031, stateMoveYear: 2030, moveYearX: 1 }),
      { moveDate: '2031-07-01', stateMoveDate: '2030-01-01', moveYearX: 1 });
    const cfg = migrateYearFieldsToDates({ params: [{ name: 'moveYear', type: 'Number', value: 2032 }] });
    assert.deepEqual([cfg.params[0].name, cfg.params[0].type, cfg.params[0].value], ['moveDate', 'Date', '2032-07-01']);
  });

  test('saved sweep rows keep their shape and land on the anchor', () => {
    assert.deepEqual(migrateMcVariableConfig({ paramKey: 'moveYear', type: 'normal', mean: 2031, stdDev: 1.5, integer: true }),
      { paramKey: 'moveDate', type: 'normalDate', mean: '2031-07-01', stdDev: 548, anchor: '07-01' });
    assert.deepEqual(migrateOptVariableConfig({ paramKey: 'stateMoveYear', type: 'integer', min: 2026, max: 2035, step: 1 }),
      { paramKey: 'stateMoveDate', type: 'date', min: '2026-01-01', max: '2035-01-01', step: 1, anchor: '01-01' });
  });

  test('assertOnAnchor passes the anchor day and a blank, and refuses any other day', async () => {
    const { assertOnAnchor, dateFromYearFor } = await import('../../src/scenarios/year-date-migration.js');
    assert.equal(assertOnAnchor('moveDate', '2031-07-01'), '2031-07-01');
    assert.equal(assertOnAnchor('moveDate', 2031), '2031-07-01', 'a bare year means its anchor day');
    assert.equal(assertOnAnchor('moveDate', null), null);
    assert.throws(() => assertOnAnchor('moveDate', '2031-03-15'), /must fall on 07-01/);
    assert.throws(() => assertOnAnchor('stateMoveDate', '2031-07-01'), /must fall on 01-01/);
    assert.throws(() => assertOnAnchor('moveDate', 'soon'), /not a date/);
    assert.equal(dateFromYearFor('moveDate', 2030), '2030-07-01');
    assert.equal(dateFromYearFor('prop.x.plannedSaleDate', 2030), '2030-01-15');
  });

  test('a legacy moveYear override on buildDefaultConfig still moves on 1 Jul', () => {
    const cfg = IntlRetirementScenario.buildDefaultConfig({ moveYear: 2033 });
    assert.equal(cfg.parameters.moveDate, '2033-07-01');
    assert.equal(cfg.parameters.moveYear, undefined);
  });
});

// ─── Phase 5: loan terms, by the loan's country (D6) ─────────────────────────

describe('phase 5 — loan terms', () => {
  test('a term year becomes the day the engine ended it: 1 Jan for US, 1 Jul for AU', () => {
    const cfg = migrateYearFieldsToDates({
      accounts: [
        { type: 'loan', country: 'US', fixedRateUntilYear: 2030, interestOnlyUntilYear: 2031, maturityYear: 2050 },
        { type: 'loan', country: 'AU', fixedRateUntilYear: 2030, interestOnlyUntilYear: null, maturityYear: 2050 },
      ],
      realProperties: [{ country: 'AU', mortgageFixedRateUntilYear: 2029, mortgageMaturityYear: 2046 }],
    });
    assert.deepEqual(cfg.accounts, [
      { type: 'loan', country: 'US', fixedRateUntil: '2030-01-01', interestOnlyUntil: '2031-01-01', maturityDate: '2050-01-01' },
      { type: 'loan', country: 'AU', fixedRateUntil: '2030-07-01', interestOnlyUntil: null, maturityDate: '2050-07-01' },
    ]);
    assert.deepEqual(cfg.realProperties, [{ country: 'AU', mortgageFixedRateUntil: '2029-07-01', mortgageMaturityDate: '2046-07-01' }]);
  });

  for (const name of ['us-single-homeowner', 'au-single-homeowner']) {
    test(`${name}: the plan saved with a maturity YEAR runs to the identical end state`, async () => {
      const { GOLDEN_SPECS } = await import('../helpers/golden-specs.js');
      const { runGolden } = await import('../helpers/golden-harness.js');
      const spec = GOLDEN_SPECS.find(s => s.name === name);
      const legacy = {
        ...spec,
        mutateCfg: (cfg) => {
          spec.mutateCfg?.(cfg);
          // Back to the pre-117 shape: the 2046 term as a YEAR on the property.
          for (const p of cfg.realProperties ?? []) {
            if (p.mortgageMaturityDate == null) continue;
            p.mortgageMaturityYear = Number(p.mortgageMaturityDate.slice(0, 4));
            delete p.mortgageMaturityDate;
          }
        },
      };
      assert.deepStrictEqual(runGolden(legacy).snapshot, runGolden(spec).snapshot);
    });
  }
});

