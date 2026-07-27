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
    // design 66 §G5/§G6: BOND rows expose the zero-coupon + TIPS accretion toggles.
    expect(cell(root, 'zeroCoupon')).not.toBeNull();
    expect(cell(root, 'inflationLinked')).not.toBeNull();
    // design 66 §G10a: BOND rows expose the coupon-frequency selector.
    expect(cell(root, 'couponFrequency')).not.toBeNull();
  });

  test('BOND §G10a: the coupon-frequency selector reflects the holding and edits write a Number', () => {
    const editor = editorForHolding({ allocation: 'BOND', couponRate: 0.04, couponFrequency: 4 });
    const root   = editor._rootEl;
    const freq   = cell(root, 'couponFrequency');
    expect(freq).not.toBeNull();
    expect(freq.value).toBe('4');           // quarterly reflected

    // Changing to annual writes 1 (as a Number, not the string '1') to the holding.
    freq.value = '1';
    freq.dispatchEvent(new window.Event('change'));
    expect(editor._holdings[0].couponFrequency).toBe(1);

    // A holding authored without couponFrequency shows the semi-annual default (2).
    const dflt = editorForHolding({ allocation: 'BOND', couponRate: 0.04 })._rootEl;
    expect(cell(dflt, 'couponFrequency').value).toBe('2');

    // An EQUITY row exposes no frequency selector.
    const eq = editorForHolding({ allocation: 'EQUITY' })._rootEl;
    expect(cell(eq, 'couponFrequency')).toBeNull();
  });

  test('BOND §G5/§G6: the Zero + TIPS checkboxes reflect and edit the accretion flags', () => {
    const editor = editorForHolding({ allocation: 'BOND', zeroCoupon: true, inflationLinked: false });
    const root   = editor._rootEl;
    const zero   = cell(root, 'zeroCoupon');
    const tips   = cell(root, 'inflationLinked');
    expect(zero.checked).toBe(true);
    expect(tips.checked).toBe(false);

    // Toggling TIPS on writes the flag back to the working holding.
    tips.checked = true;
    tips.dispatchEvent(new window.Event('change'));
    expect(editor._holdings[0].inflationLinked).toBe(true);

    // An EQUITY row exposes neither toggle.
    const eq = editorForHolding({ allocation: 'EQUITY' })._rootEl;
    expect(cell(eq, 'zeroCoupon')).toBeNull();
    expect(cell(eq, 'inflationLinked')).toBeNull();
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

/**
 * Bond-ladder builder (design 66 §G8). "+ Bond ladder" reveals an inline form that
 * expands (total, rungs, spacing, first term, tax, coupon, roll, zero/TIPS) into N
 * staggered individual BOND rungs appended to the holdings table.
 */
describe('holdings editor — bond-ladder builder (§G8)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  const lf = (root, name) => root.querySelector(`[data-lf="${name}"]`);

  test('"+ Bond ladder" toggles the builder form visible', () => {
    const root    = editorForHolding({ allocation: 'EQUITY' })._rootEl;
    const builder = root.querySelector('[data-id="ladderBuilder"]');
    expect(builder.style.display).toBe('none');
    root.querySelector('[data-id="ladderBtn"]').dispatchEvent(new window.Event('click'));
    expect(builder.style.display).toBe('');
  });

  test('Build expands into N staggered rolling BOND rungs (roll-to-tail term = ladder length)', () => {
    const editor = editorForHolding({ allocation: 'EQUITY' });
    const root   = editor._rootEl;
    const before = editor._holdings.length;

    lf(root, 'total').value     = '100000';
    lf(root, 'rungs').value     = '5';
    lf(root, 'spacing').value   = '1';
    lf(root, 'firstTerm').value = '1';
    lf(root, 'taxExemption').value = 'state';
    lf(root, 'couponFrequency').value = '4';   // design 66 §G10a: quarterly rungs
    root.querySelector('[data-id="ladderBuildBtn"]').dispatchEvent(new window.Event('click'));

    const rungs = editor._holdings.filter(h => h.allocation === 'BOND');
    expect(editor._holdings.length).toBe(before + 5);
    expect(rungs.length).toBe(5);
    // Even face split.
    expect(rungs.every(h => h.faceValue === 20000 && h.marketValue === 20000 && h.costBasis === 20000)).toBe(true);
    // design 66 §G10a: the selected coupon frequency is stamped on every rung (as a Number).
    expect(rungs.every(h => h.couponFrequency === 4)).toBe(true);
    // Every rung rolls to the SAME ladder-length term: first + (rungs-1)*spacing = 5y.
    expect(rungs.every(h => h.rollAtMaturity === true && h.rollTermYears === 5)).toBe(true);
    // Tax treatment + individual-bond identity carried onto each rung.
    expect(rungs.every(h => h.taxExemption === 'state' && h.maturityDate instanceof Date)).toBe(true);
    // Staggered maturities (5 distinct years).
    const years = new Set(rungs.map(h => h.maturityDate.getUTCFullYear()));
    expect(years.size).toBe(5);
    // Builder hides after Build.
    expect(root.querySelector('[data-id="ladderBuilder"]').style.display).toBe('none');
  });

  test('roll OFF ⇒ spend-down rungs (no rollAtMaturity, rollTermYears null)', () => {
    const editor = editorForHolding({ allocation: 'EQUITY' });
    const root   = editor._rootEl;
    lf(root, 'total').value = '30000';
    lf(root, 'rungs').value = '3';
    lf(root, 'roll').checked = false;
    root.querySelector('[data-id="ladderBuildBtn"]').dispatchEvent(new window.Event('click'));

    const rungs = editor._holdings.filter(h => h.allocation === 'BOND');
    expect(rungs.length).toBe(3);
    expect(rungs.every(h => h.rollAtMaturity === false && h.rollTermYears === null)).toBe(true);
  });

  test('a zero-amount ladder builds nothing', () => {
    const editor = editorForHolding({ allocation: 'EQUITY' });
    const root   = editor._rootEl;
    const before = editor._holdings.length;
    lf(root, 'total').value = '0';
    root.querySelector('[data-id="ladderBuildBtn"]').dispatchEvent(new window.Event('click'));
    expect(editor._holdings.length).toBe(before);
  });
});
