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
 * security-rollup.test.mjs — design 94 step 10, the third of §10.2e's loose ends.
 *
 * "Units are never totalled across instruments" was recorded as a limitation, and the
 * refusal was right: adding a share of Acme to a share of SpinCo produces a number that
 * looks like a quantity and is not one. But it left a real question unanswerable — how
 * many shares of ONE thing do I own, when it sits in three accounts?
 *
 * The rollup answers it by changing the grouping, not the rule. So what this file pins is
 * the boundary of the sum: legitimate WITHIN a security, absent ACROSS securities, and
 * withheld entirely the moment any contributing bucket is scalar.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { rollupBySecurity, totalSecurityRollup } from '../../src/finance/allocation-reporting/security-rollup.js';
import { buildAllocationCube } from '../../src/finance/allocation-reporting/allocation-cube.js';

const row = (o) => ({
  stateKey: 'brokerage', name: 'Broker', allocation: 'EQUITY', rateKey: 'EQUITY_US',
  securityId: null, security: null, units: null, holdingCount: 1,
  marketValue: 0, costBasis: 0, ...o,
});

describe('rollupBySecurity — units total within an instrument, across accounts', () => {
  test('one security in two accounts: the counts add', () => {
    const out = rollupBySecurity([
      row({ stateKey: 'brokerage', name: 'Broker', securityId: 'sec-emp', security: 'EMP',
            units: 300, marketValue: 30000, costBasis: 12000 }),
      row({ stateKey: 'k401', name: '401(k)', securityId: 'sec-emp', security: 'EMP',
            units: 200, marketValue: 20000, costBasis: 15000 }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].units, 500);
    assert.equal(out[0].marketValue, 50000);
    assert.equal(out[0].costBasis, 27000);
    assert.equal(out[0].unrealized, 23000);
    // The blended base-currency value per unit — not a quoted price. Design 94 §4 put the
    // price on the POSITION, so across two accounts there is no single one.
    assert.equal(out[0].avgPrice, 100);
    assert.deepEqual(out[0].accounts.map(a => [a.stateKey, a.units]), [['brokerage', 300], ['k401', 200]]);
  });

  test('two securities do NOT share a count, and the total carries none', () => {
    const out = rollupBySecurity([
      row({ securityId: 'sec-a', security: 'A', units: 10, marketValue: 100, costBasis: 90 }),
      row({ securityId: 'sec-b', security: 'B', units: 40, marketValue: 400, costBasis: 380 }),
    ]);
    assert.equal(out.length, 2);
    const total = totalSecurityRollup(out);
    assert.equal(total.marketValue, 500);
    // The rule, asserted rather than described: money totals, quantities do not.
    assert.equal('units' in total, false);
  });

  test('one scalar bucket withholds the whole count — a partial sum is an undercount', () => {
    const out = rollupBySecurity([
      row({ securityId: 'sec-a', security: 'A', units: 10, marketValue: 100, costBasis: 90 }),
      row({ stateKey: 'k401', securityId: 'sec-a', security: 'A', units: null, marketValue: 400, costBasis: 380 }),
    ]);
    assert.equal(out[0].units, null, 'not 10 — that would be an undercount presented as a count');
    assert.equal(out[0].avgPrice, null);
    assert.equal(out[0].marketValue, 500, 'money still adds; only the quantity is withheld');
    assert.equal(out[0].accounts.find(a => a.stateKey === 'brokerage').units, 10,
      'the account that IS unitised still reports its own count');
  });

  test('rows naming no instrument are excluded', () => {
    // A house, a company stake, a loan and a cash sleeve name none. A `(none)` bucket
    // would be the plan's largest row and would bury the answer.
    const out = rollupBySecurity([
      row({ securityId: null, marketValue: 900000 }),
      row({ securityId: 'sec-a', security: 'A', units: 1, marketValue: 100, costBasis: 100 }),
    ]);
    assert.deepEqual(out.map(r => r.securityId), ['sec-a']);
  });

  test('largest first, and share sums to 1', () => {
    const out = rollupBySecurity([
      row({ securityId: 'sec-small', security: 'S', units: 1, marketValue: 100, costBasis: 100 }),
      row({ securityId: 'sec-big',   security: 'B', units: 1, marketValue: 900, costBasis: 100 }),
    ]);
    assert.deepEqual(out.map(r => r.securityId), ['sec-big', 'sec-small']);
    assert.equal(out.reduce((n, r) => n + r.share, 0), 1);
  });

  test('buckets that disagree report null rather than the first one read', () => {
    const out = rollupBySecurity([
      row({ securityId: 'sec-a', security: 'A', allocation: 'EQUITY', units: 1, marketValue: 10, costBasis: 10 }),
      row({ securityId: 'sec-a', security: 'A', allocation: 'GOLD',   units: 1, marketValue: 10, costBasis: 10 }),
    ]);
    assert.equal(out[0].allocation, null);
    assert.equal(out[0].units, 2, 'the count is still a count of one instrument');
  });

  test('a zero count with residual value prints no price rather than Infinity', () => {
    const out = rollupBySecurity([row({ securityId: 'sec-a', security: 'A', units: 0, marketValue: 5, costBasis: 5 })]);
    assert.equal(out[0].units, 0);
    assert.equal(out[0].avgPrice, null);
  });

  test('the synthetics are included by default — most plans author no instruments', () => {
    const rows = [row({ securityId: 'sec-auto-EQUITY_US', security: 'US market index', units: 5, marketValue: 50, costBasis: 40 })];
    assert.equal(rollupBySecurity(rows).length, 1);
    assert.equal(rollupBySecurity(rows, { includeSynthetic: false }).length, 0);
  });
});

describe('rollupBySecurity — against the real cube', () => {
  test('a security held in two accounts of DIFFERENT currencies adds in base currency', () => {
    // The cube converts `marketValueLocal` at the run's own rate, so this is where the
    // money half of the sum becomes legitimate. Units need no conversion — which is why
    // a unit count is the one figure that crosses currencies untouched.
    const state = {
      fxRate: 0.5,   // AUD per... whatever the run's own convention is; the cube owns it
      securities: { 'sec-emp': { id: 'sec-emp', symbol: 'EMP', rateKey: 'EQUITY_US' } },
      usBrokerage: {
        balance: 1000, country: 'US', currency: 'USD',
        holdings: [{ id: 'h1', allocation: 'EQUITY', securityId: 'sec-emp', rateKey: 'EQUITY_US',
                     units: 10, pricePerUnit: 100, marketValue: 1000, costBasis: 600 }],
      },
      auBrokerage: {
        balance: 2000, country: 'AU', currency: 'AUD',
        holdings: [{ id: 'h2', allocation: 'EQUITY', securityId: 'sec-emp', rateKey: 'EQUITY_US',
                     units: 20, pricePerUnit: 100, marketValue: 2000, costBasis: 1200 }],
      },
    };
    const out = rollupBySecurity(buildAllocationCube(state, { baseCurrency: 'USD' }));
    const emp = out.find(r => r.securityId === 'sec-emp');
    assert.ok(emp, 'the cube must carry the securityId through');
    assert.equal(emp.units, 30, 'units cross currencies untouched');
    assert.equal(emp.accounts.length, 2);
    // Money is converted, so the AU leg is not simply 2000 added on.
    assert.ok(emp.marketValue > 1000, 'both legs are counted');
    assert.equal(emp.marketValue, emp.accounts.reduce((n, a) => n + a.marketValue, 0));
  });
});
