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
 * Real-property editor — mortgage payment source (design 54 P4).
 *
 * `mortgagePaymentSourceKey` had a complete data path and no control: RealProperty
 * stored it, the serializer allowlisted it both ways, and `synthesizeLoanForProperty`
 * copied it onto the loan's `paymentSourceKey` — which `resolveLoanCashKey` reads
 * FIRST, ahead of the linked-offset default. Only a standalone loan ACCOUNT had a
 * picker, and a property mortgage never has one, so the field was unreachable in the UI
 * for exactly the case it was added for: an offset mortgage, where the choice decides
 * whether the offset drains and so whether the interest-bearing principal rises.
 *
 * Same shape as the mortgageBookingFxRate gap these editor tests already document.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { RealPropertyEditor } from '../../../src/visualization/assets/real-property-editor.js';

const ACCOUNTS = [
  { id: 'a1', stateKey: 'usSavingsAccount', name: 'US Savings',  type: 'savings' },
  { id: 'a2', stateKey: 'usOffsetAccount',  name: 'Offset',      type: 'offset'  },
  { id: 'a3', stateKey: 'usStockAccount',   name: 'US Stock',    type: 'brokerage' },
  // Never offerable: a liability is not a source of cash (design 54 §8).
  { id: 'a4', stateKey: 'usHousePropertyLoan', name: 'US House Loan', type: 'loan' },
  // No stateKey ⇒ nothing to debit at runtime (design 72 §2).
  { id: 'a5', stateKey: null, name: 'Unsaved Account', type: 'savings' },
];

function render(node, accounts = ACCOUNTS) {
  const editor = new RealPropertyEditor({ container: makeMockContainer(), node, people: [], accounts });
  editor.render();
  return editor;
}

const optionValues = (el) =>
  [...el.querySelectorAll('[data-id="mortgagePaymentSourceKey"] option')].map(o => o.value);

describe('real-property editor — mortgage payment source (design 54 P4)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('the control exists, inside the Mortgage section', () => {
    const el = render({ id: 'p1', name: 'US House', stateKey: 'usHouseProperty' })._rootEl;
    expect(el.querySelector('[data-id="mortgagePaymentSourceKey"]')).not.toBeNull();

    const html = el.innerHTML;
    expect(html.indexOf('Mortgage (design')).toBeLessThan(html.indexOf('data-id="mortgagePaymentSourceKey"'));
    expect(html.indexOf('data-id="mortgagePaymentSourceKey"')).toBeLessThan(html.indexOf('Rental Income (design 48)'));
  });

  test('blank is the default and round-trips as null, not an empty string', () => {
    const editor = render({ id: 'p1', name: 'US House', stateKey: 'usHouseProperty' });
    const el = editor._rootEl;
    expect(el.querySelector('[data-id="mortgagePaymentSourceKey"]').value).toBe('');
    // Null is what lets `resolveLoanCashKey` fall through to the linked-offset default;
    // an empty string is truthy enough to be mistaken for an authored key downstream.
    expect(editor._readForm(el).mortgagePaymentSourceKey).toBeNull();
  });

  test('offers cash-capable accounts only — no loans, no keyless accounts, not its own loan', () => {
    const el = render({ id: 'p1', name: 'US House', stateKey: 'usHouseProperty' })._rootEl;
    expect(optionValues(el)).toEqual(['', 'usSavingsAccount', 'usOffsetAccount', 'usStockAccount']);
  });

  test('populates from the node and round-trips the chosen key', () => {
    const editor = render({
      id: 'p1', name: 'US House', stateKey: 'usHouseProperty',
      mortgagePaymentSourceKey: 'usOffsetAccount',
    });
    const el = editor._rootEl;
    expect(el.querySelector('[data-id="mortgagePaymentSourceKey"]').value).toBe('usOffsetAccount');
    expect(editor._readForm(el).mortgagePaymentSourceKey).toBe('usOffsetAccount');
  });

  test('a stored key naming no live account is preserved, not silently re-defaulted', () => {
    const editor = render({
      id: 'p1', name: 'US House', stateKey: 'usHouseProperty',
      mortgagePaymentSourceKey: 'deletedAccount',
    });
    const el = editor._rootEl;
    expect(optionValues(el)).toContain('deletedAccount');
    expect(el.querySelector('[data-id="mortgagePaymentSourceKey"]').value).toBe('deletedAccount');
    // Re-saving an untouched form must not quietly move the mortgage onto another pool.
    expect(editor._readForm(el).mortgagePaymentSourceKey).toBe('deletedAccount');
  });
});
