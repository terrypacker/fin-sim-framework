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
    for (const k of ['moveYear', 'stateMoveYear', 'prop.cabin.plannedSaleDate', 'acct.x.plannedSaleYear',
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
