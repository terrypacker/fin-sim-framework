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
 * bond-rollup.test.mjs — design 130 §3, §5.
 *
 * What is worth pinning:
 *
 *  1. the TYPE is the coupon's tax treatment, read by the tax code's own functions, first
 *     match wins — so a label can never contradict the tax;
 *  2. principal is what the lot REDEEMS for (the maturity reducer's own function), and a
 *     fund has none without nulling its group;
 *  3. the rollup walks lots the cube folds away, so it is held to the cube by a test: per
 *     account, Σ market value equals the cube's BOND holding rows, on real laddered runs.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { rollupBonds, bondTypeOf, buildMaturityLadder, BOND_TYPE }
  from '../../src/finance/allocation-reporting/bond-rollup.js';
import { buildAllocationCube, CUBE_SOURCE } from '../../src/finance/allocation-reporting/allocation-cube.js';
import { loadScenarioSim } from '../helpers/scenario-harness.js';

const ms   = (y, m = 0, d = 1) => Date.UTC(y, m, d);
const AS_OF = new Date(ms(2030));

const bond = (o) => ({
  allocation: 'BOND', rateKey: 'FIXED_INCOME_US', taxExemption: 'none', marketValue: 0, costBasis: 0, ...o,
});

const acct = (holdings, o = {}) => ({ balance: holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0),
  country: 'US', currency: { code: 'USD' }, holdings, ...o });

const withPeople = (state, residencyState = 'CA') => ({ people: { p1: { residencyState } }, ...state });

describe('bondTypeOf — first match wins, and it is the tax code\'s answer', () => {
  test('a TIPS that is also state-exempt is TIPS', () => {
    assert.equal(bondTypeOf({ inflationLinked: true, taxExemption: 'state' }, 'US', 'CA'), BOND_TYPE.TIPS);
  });

  test('a federal muni is state-exempt only in its issuing state', () => {
    const muni = { taxExemption: 'federal', issuingState: 'CA' };
    assert.equal(bondTypeOf(muni, 'US', 'CA'), BOND_TYPE.MUNI_STATE_EXEMPT);
    assert.equal(bondTypeOf(muni, 'US', 'NY'), BOND_TYPE.MUNI_STATE_TAXABLE);
    assert.equal(bondTypeOf({ taxExemption: 'federal' }, 'US', 'CA'), BOND_TYPE.MUNI_STATE_TAXABLE,
      'no issuing state ⇒ out-of-state, as the coupon tax treats it');
  });

  test('\'both\' is state-exempt whatever the issuer', () => {
    assert.equal(bondTypeOf({ taxExemption: 'both', issuingState: 'TX' }, 'US', 'CA'), BOND_TYPE.MUNI_STATE_EXEMPT);
  });

  test('with no US state residence a muni is just a muni (§8 Q2)', () => {
    assert.equal(bondTypeOf({ taxExemption: 'federal', issuingState: 'CA' }, 'US', null), BOND_TYPE.MUNI);
    assert.equal(bondTypeOf({ taxExemption: 'both' }, 'US', null), BOND_TYPE.MUNI);
  });

  test('Treasury and taxable', () => {
    assert.equal(bondTypeOf({ taxExemption: 'state' }, 'US', 'CA'), BOND_TYPE.TREASURY);
    assert.equal(bondTypeOf({ taxExemption: 'none' }, 'US', 'CA'), BOND_TYPE.TAXABLE);
    assert.equal(bondTypeOf({}, 'US', 'CA'), BOND_TYPE.TAXABLE);
  });

  test('an AU-market lot never reads a US exemption', () => {
    assert.equal(bondTypeOf({ taxExemption: 'federal' }, 'AU', 'CA'), BOND_TYPE.AU_NOMINAL);
    assert.equal(bondTypeOf({ inflationLinked: true }, 'AU', 'CA'), BOND_TYPE.AU_INFLATION_LINKED);
  });
});

describe('rollupBonds — type ▸ account ▸ lot', () => {
  const STATE = withPeople({
    brokerage: acct([
      bond({ id: 'muni', label: 'CA muni fund', taxExemption: 'federal', issuingState: 'CA',
             marketValue: 2000, costBasis: 1800, couponRate: 0.03, duration: 6 }),
      bond({ id: 't1', label: 'UST 2032', taxExemption: 'state', marketValue: 980, costBasis: 1000,
             faceValue: 1000, maturityDate: new Date(ms(2032, 5, 30)), couponRate: 0.04, duration: 5 }),
    ]),
    ira: acct([
      bond({ id: 't2', label: 'UST 2031', taxExemption: 'state', marketValue: 1010, costBasis: 1000,
             faceValue: 1000, maturityDate: new Date(ms(2031, 5, 30)), couponRate: 0.02, duration: 5,
             rollAtMaturity: true, rollTermYears: 3 }),
      { id: 'eq', allocation: 'EQUITY', rateKey: 'EQUITY_US', marketValue: 5000, costBasis: 1 },
    ]),
    mortgage: { type: 'loan', balance: 100000, holdings: [bond({ id: 'nope', marketValue: 9 })] },
  });

  test('groups in type order, accounts by size, lots by maturity', () => {
    const r = rollupBonds(STATE, { date: AS_OF });
    assert.deepEqual(r.types.map(t => t.type), [BOND_TYPE.TREASURY, BOND_TYPE.MUNI_STATE_EXEMPT]);
    const ust = r.types[0];
    assert.deepEqual(ust.accounts.map(a => a.stateKey), ['ira', 'brokerage']);
    assert.equal(ust.marketValue, 1990);
    assert.equal(ust.principal, 2000);
    assert.equal(ust.nextMaturityMs, ms(2031, 5, 30));
    assert.equal(r.lots.length, 3, 'equity and the loan are not bonds');
  });

  test('a fund carries no principal and does not null its group', () => {
    const r = rollupBonds(STATE, { date: AS_OF });
    const muni = r.types.find(t => t.type === BOND_TYPE.MUNI_STATE_EXEMPT);
    assert.equal(muni.principal, null, 'a fund-only group has no principal to show');
    assert.equal(r.total.principal, 2000, 'the total is the dated lots…');
    assert.equal(r.total.principalCoversAll, false, '…and says so');
    assert.equal(r.total.marketValue, 3990);
  });

  test('coupon weighted by principal; duration decays to years-to-maturity', () => {
    const r = rollupBonds(STATE, { date: AS_OF });
    const ust = r.types[0];
    assert.equal(ust.couponRate, 0.03, '(1000×0.04 + 1000×0.02) / 2000');
    const t2 = ust.accounts[0].lots[0];
    assert.ok(t2.duration < 1.5 && t2.duration > 1.4, `min(5, ~1.5y to maturity), got ${t2.duration}`);
    assert.equal(t2.rolls, true);
    assert.equal(t2.rollTermYears, 3);
  });

  test('unrealized needs every basis', () => {
    const s = withPeople({ b: acct([bond({ id: 'x', marketValue: 100, costBasis: undefined })]) });
    const r = rollupBonds(s, { date: AS_OF });
    assert.equal(r.types[0].costBasis, null);
    assert.equal(r.types[0].unrealized, null);
  });

  test('principal is the redemption value: indexed + floored TIPS, zero at face', () => {
    const s = withPeople({ b: acct([
      bond({ id: 'tips', inflationLinked: true, taxExemption: 'state', units: 10, parPerUnit: 100,
             cpiIndexRatio: 1.1, pricePerUnit: 105, marketValue: 1050, maturityDate: new Date(ms(2035)) }),
      bond({ id: 'tips-d', inflationLinked: true, taxExemption: 'state', units: 10, parPerUnit: 100,
             cpiIndexRatio: 0.95, pricePerUnit: 97, marketValue: 970, maturityDate: new Date(ms(2036)) }),
      bond({ id: 'zero', zeroCoupon: true, faceValue: 1000, marketValue: 800, couponRate: 0.05,
             maturityDate: new Date(ms(2037)) }),
    ]) });
    const lots = Object.fromEntries(rollupBonds(s, { date: AS_OF }).lots.map(l => [l.id, l]));
    assert.equal(lots.tips.principal, 1100, 'units × par × index ratio');
    assert.equal(lots['tips-d'].principal, 1000, 'the deflation floor');
    assert.equal(lots.zero.principal, 1000);
    assert.equal(lots.zero.couponRate, 0, 'a zero pays no coupon, whatever the field says');
    assert.equal(lots.tips.type, BOND_TYPE.TIPS);
  });

  test('drained lots are skipped', () => {
    const s = withPeople({ b: acct([bond({ id: 'd', marketValue: 0.004, faceValue: 1000,
      maturityDate: new Date(ms(2031)) })]) });
    assert.equal(rollupBonds(s, { date: AS_OF }).lots.length, 0);
  });

  test('a US exemption on an AU-market lot is reported (§8 Q1)', () => {
    const s = withPeople({
      super: acct([bond({ id: 'au', rateKey: 'FIXED_INCOME_AU', taxExemption: 'state', marketValue: 500 })],
        { country: 'AU', currency: { code: 'AUD' } }),
    });
    const r = rollupBonds(s, { date: AS_OF, displayNameFor: () => 'Super' });
    assert.equal(r.types[0].type, BOND_TYPE.AU_NOMINAL);
    assert.equal(r.warnings.length, 1);
    assert.deepEqual({ ...r.warnings[0] }, { kind: 'AU_LOT_US_EXEMPTION', stateKey: 'super', name: 'Super',
      lotId: 'au', label: null, taxExemption: 'state' });
  });

  test('money converts to the base currency at the run\'s rate', () => {
    const s = withPeople({
      effectiveExchangeRates: { USD_AUD: 1.5 },
      super: acct([bond({ id: 'au', rateKey: 'FIXED_INCOME_AU', marketValue: 1500, costBasis: 1500,
        faceValue: 1500, maturityDate: new Date(ms(2033)) })], { country: 'AU', currency: { code: 'AUD' } }),
    });
    const lot = rollupBonds(s, { date: AS_OF }).lots[0];
    assert.equal(lot.marketValue, 1000);
    assert.equal(lot.principal, 1000);
  });
});

describe('buildMaturityLadder — a column for every year, rolling apart from spend-down', () => {
  const lots = [
    { id: 'a', stateKey: 'ira', name: 'IRA', type: 'TREASURY', maturityMs: ms(2031, 5), principal: 100, marketValue: 99, rolls: true },
    { id: 'b', stateKey: 'ira', name: 'IRA', type: 'TREASURY', maturityMs: ms(2033, 5), principal: 200, marketValue: 199, rolls: false },
    { id: 'c', stateKey: 'brk', name: 'Brokerage', type: 'TIPS', maturityMs: ms(2033, 1), principal: 50, marketValue: 49, rolls: false },
    { id: 'f', stateKey: 'brk', name: 'Brokerage', type: 'TAXABLE', maturityMs: null, principal: null, marketValue: 70, rolls: false },
  ];

  test('years run from the as-of year to the last maturity, gaps included', () => {
    const l = buildMaturityLadder(lots, { date: AS_OF });
    assert.deepEqual(l.years, [2030, 2031, 2032, 2033]);
    assert.equal(l.undated, 70, 'funds are a caption, not a bar');
    assert.equal(l.dated, 350);
  });

  test('by account: rolling and spend-down are separate series under one key', () => {
    const l = buildMaturityLadder(lots, { date: AS_OF });
    const ira = l.series.filter(s => s.key === 'ira');
    assert.equal(ira.length, 2);
    assert.deepEqual(ira.find(s => s.rolls).values,  [0, 100, 0, 0]);
    assert.deepEqual(ira.find(s => !s.rolls).values, [0, 0, 0, 200]);
  });

  test('by type stacks in type order', () => {
    const l = buildMaturityLadder(lots, { by: 'type', date: AS_OF });
    assert.deepEqual(l.series.map(s => s.key), ['TIPS', 'TREASURY', 'TREASURY']);
    assert.equal(l.series[0].label, 'TIPS');
  });

  test('a lot past its date but not yet redeemed sits in the first column', () => {
    const l = buildMaturityLadder([{ ...lots[0], maturityMs: ms(2029, 11) }], { date: AS_OF });
    assert.deepEqual(l.years, [2030]);
    assert.deepEqual(l.series[0].values, [100]);
  });

  test('nothing dated ⇒ no axis', () => {
    assert.deepEqual(buildMaturityLadder([lots[3]], { date: AS_OF }),
      { years: [], series: [], undated: 70, dated: 0 });
  });
});

describe('the tie to the cube (design 130 §3.2)', () => {
  /** Per account: the rollup's bond market value vs the cube's BOND holding rows. */
  function assertTies(sim) {
    const state = sim.state;
    const date  = sim.currentDate;
    const r     = rollupBonds(state, { date });
    assert.ok(r.lots.length > 0, 'the scenario must hold bonds for this to test anything');
    const cube  = buildAllocationCube(state, { date, includeNonHoldingAssets: false,
      includeLiabilities: false, reconcileToBalance: false });
    const cubeBy = new Map();
    for (const row of cube) {
      if (row.source !== CUBE_SOURCE.HOLDING || row.allocation !== 'BOND') continue;
      cubeBy.set(row.stateKey, (cubeBy.get(row.stateKey) ?? 0) + row.marketValue);
    }
    const ours = new Map();
    for (const l of r.lots) ours.set(l.stateKey, (ours.get(l.stateKey) ?? 0) + l.marketValue);
    for (const k of new Set([...cubeBy.keys(), ...ours.keys()])) {
      // Per-row cent rounding on both sides, plus drained lots (≤ half a cent each).
      const lotCount = r.lots.filter(l => l.stateKey === k).length;
      assert.ok(Math.abs((cubeBy.get(k) ?? 0) - (ours.get(k) ?? 0)) <= 0.01 * (lotCount + 2),
        `${k}: cube ${cubeBy.get(k)} vs rollup ${ours.get(k)}`);
    }
  }

  test('the default scenario: Treasury, muni and taxable sleeves', () => {
    const { sim } = loadScenarioSim({ telemetry: 'off', stepTo: new Date(ms(2027, 6, 2)) });
    assertTies(sim);
    const types = rollupBonds(sim.state, { date: sim.currentDate }).types.map(t => t.type);
    assert.ok(types.includes(BOND_TYPE.TREASURY));
    assert.ok(types.some(t => t.startsWith('MUNI')));
    assert.ok(types.includes(BOND_TYPE.TAXABLE));
  });

  test('a TIPS ladder, after rungs have matured and rolled', () => {
    const { sim } = loadScenarioSim({ telemetry: 'off', stepTo: new Date(ms(2031, 6, 2)), params: {
      behavioralStrategies: ['BOND_LADDER'], bondLadderInflationLinked: true, bondLadderRungs: 5,
    } });
    assertTies(sim);
    const r = rollupBonds(sim.state, { date: sim.currentDate });
    const tips = r.types.find(t => t.type === BOND_TYPE.TIPS);
    assert.ok(tips && tips.lotCount >= 2, 'the ladder shows as TIPS rungs');
    assert.ok(tips.couponReal);
    assert.ok(buildMaturityLadder(r.lots, { date: sim.currentDate }).series.some(s => s.rolls));
  });
});
