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
 * Allocation-aware holdings editor (design 53 §5). The holdings table renders an
 * input in a cell only for the fields its row's allocation actually uses:
 *   - EQUITY: Cost Basis, Income Rate → dividendYield, Loss Partner
 *   - BOND:   Income Rate → couponRate, Duration; Cost Basis hidden (defaulted to MV)
 *   - CASH:   none of the above (no CGT, no income knob, no TLH)
 *   - OTHER:  Cost Basis, Loss Partner (no income/duration knob)
 * Changing a row's Allocation re-renders its inputs; the Rate Key dropdown survives.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { AccountEditor } from '../../../src/visualization/accounts/account-editor.js';

function editorForHolding(holding) {
  const node = {
    id: 'b1', name: 'Broker', type: 'brokerage', country: 'US',
    currency: { code: 'USD', symbol: '$' },
    holdings: [{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 1000, ...holding }],
  };
  const editor = new AccountEditor({ container: makeMockContainer(), node, people: [] });
  editor.render();
  return editor;
}

const cell = (root, field) => root.querySelector(`[data-f="${field}"]`);

describe('holdings editor — allocation-aware inputs', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('EQUITY row: Income Rate binds dividendYield; Cost Basis + Loss Partner shown; no Duration/couponRate', () => {
    const root = editorForHolding({ allocation: 'EQUITY', dividendYield: 0.02 })._rootEl;
    expect(cell(root, 'dividendYield')).not.toBeNull();
    expect(cell(root, 'dividendYield').value).toBe('0.02');
    expect(cell(root, 'costBasis')).not.toBeNull();
    expect(cell(root, 'taxLossPartner')).not.toBeNull();
    expect(cell(root, 'couponRate')).toBeNull();
    expect(cell(root, 'duration')).toBeNull();
  });

  test('BOND row: Income Rate binds couponRate + Duration shown; Cost Basis + Loss Partner hidden', () => {
    const root = editorForHolding({ allocation: 'BOND', couponRate: 0.05, duration: 6 })._rootEl;
    expect(cell(root, 'couponRate')).not.toBeNull();
    expect(cell(root, 'couponRate').value).toBe('0.05');
    expect(cell(root, 'duration')).not.toBeNull();
    expect(cell(root, 'duration').value).toBe('6');
    expect(cell(root, 'costBasis')).toBeNull();   // hidden for BOND
    expect(cell(root, 'dividendYield')).toBeNull();
    expect(cell(root, 'taxLossPartner')).toBeNull();
    // design 66 §G4: BOND rows expose maturityDate + faceValue (individual-bond terms).
    expect(cell(root, 'maturityDate')).not.toBeNull();
    expect(cell(root, 'faceValue')).not.toBeNull();
  });

  test('BOND §G4: an existing maturityDate/faceValue populates the inputs; a fund leaves them empty', () => {
    const indiv = editorForHolding({
      allocation: 'BOND', maturityDate: new Date(Date.UTC(2035, 0, 1)), faceValue: 50_000,
    })._rootEl;
    expect(cell(indiv, 'maturityDate').value).toBe('2035-01-01');
    expect(cell(indiv, 'faceValue').value).toBe('50000');

    const fund = editorForHolding({ allocation: 'BOND', couponRate: 0.04 })._rootEl;
    expect(cell(fund, 'maturityDate').value).toBe('');
    expect(cell(fund, 'faceValue').value).toBe('');
  });

  test('BOND §G4: setting a maturity date defaults faceValue to par (market value) and records a Date', () => {
    const editor = editorForHolding({ allocation: 'BOND', marketValue: 40_000 });
    const root   = editor._rootEl;
    const mat    = cell(root, 'maturityDate');
    mat.value = '2040-06-01';
    mat.dispatchEvent(new window.Event('input'));

    expect(editor._holdings[0].maturityDate).toBeInstanceOf(Date);
    expect(editor._holdings[0].maturityDate.getTime()).toBe(Date.UTC(2040, 5, 1));
    expect(editor._holdings[0].faceValue).toBe(40_000);   // defaulted to par
    // The re-rendered face-value input reflects the defaulted par.
    expect(cell(editor._rootEl, 'faceValue').value).toBe('40000');
  });

  test('BOND §G4: clearing the maturity date reverts the sleeve to a perpetual fund', () => {
    const editor = editorForHolding({
      allocation: 'BOND', maturityDate: new Date(Date.UTC(2035, 0, 1)), faceValue: 50_000,
    });
    const mat = cell(editor._rootEl, 'maturityDate');
    mat.value = '';
    mat.dispatchEvent(new window.Event('input'));
    expect(editor._holdings[0].maturityDate).toBeNull();
  });

  test('CASH row: no Cost Basis / Income Rate / Duration / Loss Partner', () => {
    const root = editorForHolding({ allocation: 'CASH' })._rootEl;
    expect(cell(root, 'costBasis')).toBeNull();
    expect(cell(root, 'dividendYield')).toBeNull();
    expect(cell(root, 'couponRate')).toBeNull();
    expect(cell(root, 'duration')).toBeNull();
    expect(cell(root, 'taxLossPartner')).toBeNull();
    // Rate Key + Market Value stay universal.
    expect(cell(root, 'rateKey')).not.toBeNull();
    expect(cell(root, 'marketValue')).not.toBeNull();
  });

  test('OTHER row: Cost Basis + Loss Partner shown; no Income Rate / Duration', () => {
    const root = editorForHolding({ allocation: 'OTHER' })._rootEl;
    expect(cell(root, 'costBasis')).not.toBeNull();
    expect(cell(root, 'taxLossPartner')).not.toBeNull();
    expect(cell(root, 'dividendYield')).toBeNull();
    expect(cell(root, 'couponRate')).toBeNull();
    expect(cell(root, 'duration')).toBeNull();
  });

  test('switching EQUITY → BOND re-renders: coupon + duration appear, cost basis hides, rate key survives', () => {
    const editor = editorForHolding({ allocation: 'EQUITY', dividendYield: 0.02, rateKey: 'FIXED_INCOME_US' });
    const root   = editor._rootEl;
    expect(cell(root, 'costBasis')).not.toBeNull();

    const alloc = cell(root, 'allocation');
    alloc.value = 'BOND';
    alloc.dispatchEvent(new window.Event('change'));

    // Re-query after the re-render.
    expect(cell(root, 'couponRate')).not.toBeNull();
    expect(cell(root, 'duration')).not.toBeNull();
    expect(cell(root, 'costBasis')).toBeNull();
    expect(cell(root, 'dividendYield')).toBeNull();
    // Rate Key select is repainted and still a grouped <select> with the value preserved.
    const rk = cell(root, 'rateKey');
    expect(rk.tagName).toBe('SELECT');
    expect(rk.value).toBe('FIXED_INCOME_US');
  });

  test('switching to BOND snaps Cost Basis to Market Value (§5.3.4)', () => {
    const editor = editorForHolding({ allocation: 'EQUITY', marketValue: 5000, costBasis: 3000 });
    const root   = editor._rootEl;

    const alloc = cell(root, 'allocation');
    alloc.value = 'BOND';
    alloc.dispatchEvent(new window.Event('change'));

    const h = editor._holdings.find(x => x.id === 'h1');
    expect(h.costBasis).toBe(5000);   // snapped to MV, no embedded gain authored
  });

  test('editing Market Value on a BOND keeps Cost Basis synced to MV', () => {
    const editor = editorForHolding({ allocation: 'BOND', marketValue: 1000, couponRate: 0.04 });
    const root   = editor._rootEl;

    const mv = cell(root, 'marketValue');
    mv.value = 2500;
    mv.dispatchEvent(new window.Event('input'));

    const h = editor._holdings.find(x => x.id === 'h1');
    expect(h.marketValue).toBe(2500);
    expect(h.costBasis).toBe(2500);
  });

  test('a blank Income Rate reads back as null, not 0', () => {
    const editor = editorForHolding({ allocation: 'BOND', couponRate: 0.04 });
    const root   = editor._rootEl;

    const coupon = cell(root, 'couponRate');
    coupon.value = '';
    coupon.dispatchEvent(new window.Event('input'));

    const h = editor._holdings.find(x => x.id === 'h1');
    expect(h.couponRate).toBeNull();
  });
});
