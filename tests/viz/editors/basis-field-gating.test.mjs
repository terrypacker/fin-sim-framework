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
 * Contribution/earnings basis fields are gated to retirement account types
 * (design 53 §2). Brokerage is holdings-only: it must hide the basis fields and
 * must NOT emit them from _readForm (so a save can't re-add the ledger), while
 * still showing the holdings editor. Retirement accounts show + persist them.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { AccountEditor } from '../../../src/visualization/accounts/account-editor.js';

function editorFor(node) {
  const editor = new AccountEditor({ container: makeMockContainer(), node, people: [] });
  editor.render();
  return editor;
}

describe('design 53 §2 — basis fields gated to retirement accounts', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('brokerage: hides basis fields, still shows holdings, omits basis from _readForm', () => {
    const editor = editorFor({ id: 'b1', name: 'Broker', type: 'brokerage', country: 'US',
                               currency: { code: 'USD', symbol: '$' } });
    const root = editor._rootEl;
    expect(root.querySelector('[data-id="investmentFields"]').style.display).toBe('none');
    expect(root.querySelector('[data-id="holdingsSection"]').style.display).not.toBe('none');

    const data = editor._readForm(root);
    expect('contributionBasis' in data).toBe(false);
    expect('earningsBasis' in data).toBe(false);
  });

  test('401k: shows basis fields and emits contributionBasis (earningsBasis derived, omitted)', () => {
    const editor = editorFor({ id: 'k1', name: '401k', type: '401k',
                               contributionBasis: 40000, earningsBasis: 10000 });
    const root = editor._rootEl;
    expect(root.querySelector('[data-id="investmentFields"]').style.display).not.toBe('none');

    const data = editor._readForm(root);
    expect('contributionBasis' in data).toBe(true);
    // earningsBasis is DERIVED (design 53 §8) — never an input, never in the payload.
    expect('earningsBasis' in data).toBe(false);
  });
});

describe('design 53 §8 — earningsBasis is derived, read-only', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('401k: earnings input is disabled and computed = balance − contributions', () => {
    const editor = editorFor({ id: 'k1', name: '401k', type: '401k',
                               balance: 50000, contributionBasis: 40000, earningsBasis: 999 });
    const root = editor._rootEl;
    const earn = root.querySelector('[data-id="earningsBasis"]');
    expect(earn.disabled).toBe(true);
    // Derived from balance − contributions, ignoring the stored/entered earnings.
    expect(Number(earn.value)).toBe(10000);
  });

  test('editing contributions live-recomputes earnings', () => {
    const editor = editorFor({ id: 'k1', name: '401k', type: '401k',
                               balance: 50000, contributionBasis: 40000 });
    const root = editor._rootEl;
    const contrib = root.querySelector('[data-id="contributionBasis"]');
    contrib.value = 30000;
    contrib.dispatchEvent(new root.ownerDocument.defaultView.Event('input'));
    expect(Number(root.querySelector('[data-id="earningsBasis"]').value)).toBe(20000);
  });

  test('contributions > balance clamps earnings at 0', () => {
    const editor = editorFor({ id: 'k1', name: '401k', type: '401k',
                               balance: 30000, contributionBasis: 40000 });
    const root = editor._rootEl;
    expect(Number(root.querySelector('[data-id="earningsBasis"]').value)).toBe(0);
  });

  test('new retirement account: blank contributions → earnings 0 (all principal)', () => {
    const editor = editorFor({ name: 'New IRA', type: 'ira' });
    const root = editor._rootEl;
    // Blank contributions field; a typed balance implies contributions = balance.
    expect(root.querySelector('[data-id="contributionBasis"]').value).toBe('');
    const bal = root.querySelector('[data-id="balance"]');
    bal.value = 25000;
    bal.dispatchEvent(new root.ownerDocument.defaultView.Event('input'));
    expect(Number(root.querySelector('[data-id="earningsBasis"]').value)).toBe(0);
  });
});
