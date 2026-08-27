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
 * security-registry.test.mjs — design 94 step 2: the `Security` entity and its registry.
 *
 * Three things are being pinned, and only the first is about the entity:
 *
 *   1. **Absent is not null.** `instrumentOf` merges `{ ...holding, ...security }`, so a key
 *      PRESENT on a security wins. A security therefore declares only what it knows, and
 *      silence leaves a migrated lot's inline value alone. Get this wrong and every equity
 *      security quietly declares that its lots pay no coupon.
 *   2. **The registry is shared by reference and frozen** (design 94 §6.4). Sharing is what
 *      recovers the ~7% a state-resident registry costs a workbench run; freezing is what
 *      makes sharing safe. An in-place write would not corrupt one state — it would rewrite
 *      every snapshot in the run, which is the journal live-alias defect with a wider blast
 *      radius.
 *   3. **Copy-on-write still works.** A snapshot taken before a security is added must keep
 *      seeing the old map. That is not a limitation; it is what a snapshot MEANS.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeSecurity, buildSecurityRegistry, assertAllocationMatch, SECURITY_FIELDS }
  from '../../src/finance/holdings/security.js';
import { instrumentOf } from '../../src/finance/holdings/holding-utils.js';
import { cloneState } from '../../src/simulation-framework/state-utils.js';
import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { ScenarioSerializer } from '../../src/scenarios/scenario-serializer.js';

const VTI = { id: 'sec-vti', symbol: 'VTI', name: 'Total US Market', rateKey: 'EQUITY_US' };

describe('design 94 §4 — the Security entity', () => {

  test('carries only the fields it was given — absent is silence, not null', () => {
    const s = makeSecurity(VTI);
    assert.deepEqual(Object.keys(s).sort(), ['id', 'name', 'rateKey', 'symbol']);
    for (const f of ['couponRate', 'maturityDate', 'dividendYield', 'taxExemption']) {
      assert.ok(!(f in s),
        `'${f}' must be ABSENT, not null — a defaulted null would override a lot's inline value`);
    }
  });

  test('an explicit null IS a declaration and is kept', () => {
    const s = makeSecurity({ ...VTI, dividendYield: null });
    assert.ok('dividendYield' in s, 'the key survives…');
    assert.equal(s.dividendYield, null, '…carrying the null the author meant');
  });

  test('it is frozen, and so is the registry', () => {
    const s = makeSecurity(VTI);
    assert.ok(Object.isFrozen(s));
    assert.throws(() => { s.symbol = 'VOO'; }, TypeError,
      'a strict-mode TypeError is the whole point: an in-place write would rewrite history');
    const reg = buildSecurityRegistry([VTI]);
    assert.ok(Object.isFrozen(reg));
    assert.throws(() => { reg['sec-x'] = {}; }, TypeError);
  });

  test('`id` is required, and duplicate ids are refused', () => {
    assert.throws(() => makeSecurity({ symbol: 'VTI' }), /`id` is required/);
    assert.throws(() => buildSecurityRegistry([VTI, { ...VTI, symbol: 'DUP' }]), /duplicate id/);
  });

  test('SECURITY_FIELDS does not contain a price — design 94 D4', () => {
    for (const banned of ['pricePerUnit', 'price', 'marketValue', 'units', 'costBasis']) {
      assert.ok(!SECURITY_FIELDS.includes(banned),
        `'${banned}' is a POSITION field; a shared price would delete design 55 §8's per-account rates`);
    }
  });

  test('a security may not name a rateKey outside its holding`s allocation class — D5', () => {
    assert.throws(
      () => assertAllocationMatch('BOND', makeSecurity({ id: 'x', rateKey: 'EQUITY_US' })),
      /not inside ALLOCATION.BOND/);
    assert.doesNotThrow(
      () => assertAllocationMatch('EQUITY', makeSecurity({ id: 'x', rateKey: 'EQUITY_US' })));
    assert.doesNotThrow(
      () => assertAllocationMatch('EQUITY', makeSecurity({ id: 'x' })),
      'a security may decline to name a market at all');
  });
});

describe('design 94 §5.3a — instrumentOf resolves through the registry', () => {

  const lot = { id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 900,
                securityId: 'sec-vti', rateKey: 'EQUITY_AU', dividendYield: 0.02 };

  test('with no registry it is the identity — Option A, unchanged', () => {
    assert.equal(instrumentOf(lot), lot, 'the same object, not a copy');
    assert.equal(instrumentOf(lot).rateKey, 'EQUITY_AU');
  });

  test('the security wins over a migrated lot`s stale inline field', () => {
    const reg = buildSecurityRegistry([VTI]);
    assert.equal(instrumentOf(lot, reg).rateKey, 'EQUITY_US');
  });

  test('the lot fills the gaps the security is silent about', () => {
    const reg = buildSecurityRegistry([VTI]);           // declares no dividendYield
    assert.equal(instrumentOf(lot, reg).dividendYield, 0.02,
      'design 94 D11 — security → holding → account, in that order');
  });

  test('an explicit null on the security DOES override — the trap, pinned', () => {
    const reg = buildSecurityRegistry([{ ...VTI, dividendYield: null }]);
    assert.equal(instrumentOf(lot, reg).dividendYield, null,
      '`??` does not save you here: the key is present, so the spread takes it');
  });

  test('position fields are never touched by the merge', () => {
    const reg = buildSecurityRegistry([VTI]);
    const inst = instrumentOf(lot, reg);
    assert.equal(inst.marketValue, 1000);
    assert.equal(inst.costBasis, 900);
    assert.equal(lot.rateKey, 'EQUITY_AU', 'and the holding itself is not mutated');
  });

  test('an unknown securityId falls back to the lot rather than throwing', () => {
    const reg = buildSecurityRegistry([VTI]);
    const orphan = { ...lot, securityId: 'sec-gone' };
    assert.equal(instrumentOf(orphan, reg), orphan);
  });
});

describe('design 94 §6.4 — cloneState shares the registry, copies everything else', () => {

  const state = () => ({
    securities: buildSecurityRegistry([VTI]),
    usStockAccount: { balance: 100, holdings: [{ id: 'h1', marketValue: 100 }] },
    cumulativeTaxesPaid: 5,
  });

  test('the registry is the SAME object; the accounts are not', () => {
    const s = state();
    const c = cloneState(s);
    assert.equal(c.securities, s.securities, 'shared by reference — this is the ~7% recovery');
    assert.notEqual(c.usStockAccount, s.usStockAccount);
    assert.notEqual(c.usStockAccount.holdings[0], s.usStockAccount.holdings[0]);
    assert.deepEqual(c.usStockAccount, s.usStockAccount, 'copied, not aliased');
  });

  test('copy-on-write: a snapshot taken before a security is added keeps the old map', () => {
    const s = state();
    const snapshot = cloneState(s);
    // A reducer adds a security the way a reducer must — by replacing the map.
    s.securities = buildSecurityRegistry([VTI, { id: 'sec-spun', symbol: 'SPIN' }]);
    assert.ok(!('sec-spun' in snapshot.securities),
      'the snapshot was taken before the spin-off, and must still say so');
    assert.ok('sec-spun' in s.securities);
  });

  test('cloneState is otherwise a deep clone — nested values are copied', () => {
    const s = { a: { b: { c: [1, 2, 3] } } };
    const c = cloneState(s);
    c.a.b.c.push(4);
    assert.deepEqual(s.a.b.c, [1, 2, 3]);
  });
});

describe('design 94 §4 — securities survive serialization', () => {

  test('a scenario round-trips its securities, declared fields only', () => {
    const round = ScenarioSerializer.serializeScenario({
      id: 's1', name: 'x', securities: [makeSecurity({ ...VTI, dividendYield: null })],
    });
    assert.equal(round.securities.length, 1);
    assert.equal(round.securities[0].id, 'sec-vti');
    assert.equal(round.securities[0].__type, 'Security');
    assert.ok('dividendYield' in round.securities[0], 'an explicit null survives…');
    assert.ok(!('couponRate' in round.securities[0]), '…and silence stays silence');
    // …and the round-trip reconstructs the same registry.
    const reg = buildSecurityRegistry(round.securities);
    assert.equal(reg['sec-vti'].dividendYield, null);
    assert.ok(!('couponRate' in reg['sec-vti']));
  });

  test('a scenario with no securities emits NO key — every old fixture is untouched', () => {
    const round = ScenarioSerializer.serializeScenario({ id: 's1', name: 'x' });
    assert.ok(!('securities' in round));
  });
});

describe('design 94 §4 — cfg.securities reaches state on the real load path', () => {

  test('the loader projects them, frozen, onto sim.state', () => {
    const { sim } = loadScenarioSim({
      mutateCfg: (cfg) => { cfg.securities = [VTI, { id: 'sec-bond', rateKey: 'FIXED_INCOME_US', couponRate: 0.04 }]; },
    });
    assert.ok(sim.state.securities, 'projected at load — buildSim runs too early to see cfg');
    assert.equal(sim.state.securities['sec-vti'].symbol, 'VTI');
    assert.equal(sim.state.securities['sec-bond'].couponRate, 0.04);
    assert.ok(Object.isFrozen(sim.state.securities));
  });

  test('a scenario with no authored securities still gets the four synthetic markets', () => {
    // Design 94 step 3 REVERSED step 2's "absent means absent" for this key, deliberately:
    // once every equity lot is a position in a security there is no such thing as a run
    // with no registry. Step 2's version of this test asserted the opposite, and it was
    // right for step 2 — an empty `{}` said nothing and would have landed in every
    // whole-state fixture for nothing. Four synthetic market securities say something.
    const { sim } = loadScenarioSim({});
    const ids = Object.keys(sim.state.securities ?? {}).sort();
    assert.deepEqual(ids, ['sec-auto-EQUITY_AU', 'sec-auto-EQUITY_INTL_EX_AU',
                           'sec-auto-EQUITY_INTL_EX_US', 'sec-auto-EQUITY_US']);
  });

  test('a synthetic security is the IDENTITY — beta 1, no idiosyncratic vol', () => {
    // §9.1. The first pass wrote `beta: DEFAULT_EQUITY_BETA[rateKey]` and that would
    // double-count: the market beta is already inside the sleeve deviation, and §6.2's
    // per-security overlay is defined RELATIVE to the sleeve. (β − 1) = 0 is what makes a
    // migrated lot behave exactly as it did before it named anything.
    const { sim } = loadScenarioSim({});
    const us = sim.state.securities['sec-auto-EQUITY_US'];
    assert.equal(us.beta, 1.0);
    assert.equal(us.idioVol, 0);
    assert.equal(us.rateKey, 'EQUITY_US');
    assert.ok(Object.isFrozen(us));
  });

  test('the `sec-auto-` prefix is reserved — an authored collision throws', () => {
    // Not a nicety: an authored record shadowing a synthetic would silently change what
    // every un-securitised lot in that market resolves to, across every account at once.
    assert.throws(
      () => loadScenarioSim({
        mutateCfg: (cfg) => { cfg.securities = [{ id: 'sec-auto-EQUITY_US', symbol: 'X' }]; },
      }),
      /duplicate id/);
  });

  test('and the registry survives a run — nothing writes to it in place', () => {
    const { sim } = loadScenarioSim({
      mutateCfg: (cfg) => { cfg.securities = [VTI]; },
      stepTo: '2030-01-01',
    });
    assert.equal(sim.state.securities['sec-vti'].symbol, 'VTI');
    assert.ok(Object.isFrozen(sim.state.securities['sec-vti']));
  });
});
