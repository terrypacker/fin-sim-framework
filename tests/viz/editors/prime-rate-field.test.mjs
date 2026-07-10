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
 * Prime-relative cash rate field (design 56 §10). The cash "Interest Rate" input is
 * the ABSOLUTE rate the bank quotes; on save it is stored as
 * `primeSpread = absolute − Prime(country)`, with a read-only "= Prime + spread" hint.
 * Shown for cash types only; non-Prime scenarios fall back to a legacy absolute.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { AccountEditor } from '../../../src/visualization/accounts/account-editor.js';

const PRIME = { US: 0.045, AU: 0.0435 };

function editorFor(node, primeRates = PRIME) {
  const editor = new AccountEditor({ container: makeMockContainer(), node, people: [], primeRates });
  editor.render();
  return editor;
}

describe('design 56 §10 — Prime-relative cash rate field', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('savings: shows the absolute (Prime + spread) and the "= Prime + spread" hint', () => {
    // spread -0.015 ⇒ absolute 0.045 - 0.015 = 0.03
    const editor = editorFor({ id: 's1', name: 'US Savings', type: 'savings', country: 'US',
                               currency: { code: 'USD', symbol: '$' }, primeSpread: -0.015 });
    const root = editor._rootEl;
    expect(root.querySelector('[data-id="cashRateRow"]').style.display).not.toBe('none');
    expect(Number(root.querySelector('[data-id="cashRate"]').value)).toBeCloseTo(0.03, 9);
    expect(root.querySelector('[data-id="cashRateHint"]').textContent)
      .toBe('= Prime (4.50%) − 1.50%');
  });

  test('savings: _readForm stores primeSpread = absolute − Prime and clears interestRate', () => {
    const editor = editorFor({ id: 's1', name: 'US Savings', type: 'savings', country: 'US',
                               currency: { code: 'USD', symbol: '$' }, primeSpread: -0.015 });
    const root = editor._rootEl;
    // User re-quotes the absolute rate as 6%.
    root.querySelector('[data-id="cashRate"]').value = 0.06;
    const data = editor._readForm(root);
    expect(data.primeSpread).toBeCloseTo(0.06 - 0.045, 9); // +0.015
    expect(data.interestRate).toBeNull();
  });

  test('brokerage: shows the cash-sleeve rate field (labelled "Cash Rate") and stores primeSpread', () => {
    // design 56 §6 — a brokerage's CASH sleeve earns the account-level cash rate.
    const editor = editorFor({ id: 'b1', name: 'Broker', type: 'brokerage', country: 'US',
                               currency: { code: 'USD', symbol: '$' }, primeSpread: -0.01 });
    const root = editor._rootEl;
    const row  = root.querySelector('[data-id="cashRateRow"]');
    expect(row.style.display).not.toBe('none');
    expect(row.querySelector('label').textContent).toBe('Cash Rate');
    expect(Number(root.querySelector('[data-id="cashRate"]').value)).toBeCloseTo(0.035, 9); // 0.045 - 0.01

    root.querySelector('[data-id="cashRate"]').value = 0.02;
    const data = editor._readForm(root);
    expect(data.primeSpread).toBeCloseTo(0.02 - 0.045, 9); // -0.025
    // A brokerage is never a transaction account — the flag must not ride the payload.
    expect('isTransactionAccount' in data).toBe(false);
  });

  test('401k: the cash rate row is hidden (no cash-sleeve rate on retirement accounts)', () => {
    const editor = editorFor({ id: 'k1', name: '401k', type: '401k' });
    expect(editor._rootEl.querySelector('[data-id="cashRateRow"]').style.display).toBe('none');
  });

  test('blank rate → unset (primeSpread and interestRate null = global default)', () => {
    const editor = editorFor({ id: 's1', name: 'US Savings', type: 'savings', country: 'US',
                               currency: { code: 'USD', symbol: '$' }, primeSpread: -0.015 });
    const root = editor._rootEl;
    root.querySelector('[data-id="cashRate"]').value = '';
    const data = editor._readForm(root);
    expect(data.primeSpread).toBeNull();
    expect(data.interestRate).toBeNull();
  });

  test('no Prime configured → stores the entered value as a legacy absolute', () => {
    const editor = editorFor({ id: 's1', name: 'US Savings', type: 'savings', country: 'US',
                               currency: { code: 'USD', symbol: '$' }, interestRate: 0.03 }, {});
    const root = editor._rootEl;
    expect(Number(root.querySelector('[data-id="cashRate"]').value)).toBeCloseTo(0.03, 9);
    root.querySelector('[data-id="cashRate"]').value = 0.05;
    const data = editor._readForm(root);
    expect(data.interestRate).toBeCloseTo(0.05, 9);
    expect(data.primeSpread).toBeNull();
    expect(root.querySelector('[data-id="cashRateHint"]').textContent)
      .toBe('Prime not configured — stored as an absolute rate');
  });
});
