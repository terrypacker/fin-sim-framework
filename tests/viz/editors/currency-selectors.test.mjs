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
 * Per-input native-currency selectors (design 10 §Phase 5).
 *
 * jsdom smoke tests over the real index.html templates: each editor must
 * populate its currency <select> from the domain object (defaulting by
 * jurisdiction) and read the chosen code back out of _readForm().
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { PersonEditor }       from '../../../src/visualization/people/person-editor.js';
import { AccountEditor }      from '../../../src/visualization/accounts/account-editor.js';
import { RealPropertyEditor } from '../../../src/visualization/assets/real-property-editor.js';
import { CollectibleEditor }  from '../../../src/visualization/assets/collectible-editor.js';

describe('Phase 5 currency selectors', () => {
  beforeEach(() => loadHtml('../../index.html'));

  // ── Person: per-field wage / SS currency ──────────────────────────────────
  test('PersonEditor populates and reads wage/SS currency', () => {
    const editor = new PersonEditor({
      container: makeMockContainer(),
      node: { id: 'p1', name: 'Alice', citizen: ['US'], wageCurrency: 'AUD', ssCurrency: 'USD' },
    });
    editor.render();
    const root = editor._rootEl;
    expect(root.querySelector('[data-id="wageCurrency"]').value).toBe('AUD');
    expect(root.querySelector('[data-id="ssCurrency"]').value).toBe('USD');

    const data = editor._readForm(root);
    expect(data.wageCurrency).toBe('AUD');
    expect(data.ssCurrency).toBe('USD');
  });

  test('PersonEditor defaults currency from residency when absent', () => {
    const editor = new PersonEditor({
      container: makeMockContainer(),
      node: { id: 'p2', name: 'Bob', citizen: ['US'], residency: 'AUS' },
    });
    editor.render();
    expect(editor._rootEl.querySelector('[data-id="wageCurrency"]').value).toBe('AUD');
  });

  // ── Account: explicit currency override ───────────────────────────────────
  test('AccountEditor shows the account currency and reads its code', () => {
    const editor = new AccountEditor({
      container: makeMockContainer(),
      node: { id: 'a1', name: 'AU Savings', type: 'savings', country: 'AU',
              currency: { code: 'AUD', symbol: 'A$' } },
      people: [],
    });
    editor.render();
    expect(editor._rootEl.querySelector('[data-id="currency"]').value).toBe('AUD');
    expect(editor._readForm(editor._rootEl).currency).toBe('AUD');
  });

  test('AccountEditor defaults a new US account to USD', () => {
    const editor = new AccountEditor({
      container: makeMockContainer(),
      node: null,
      people: [],
    });
    editor.render();
    expect(editor._rootEl.querySelector('[data-id="currency"]').value).toBe('USD');
  });

  // ── Assets: default by country, overridable ───────────────────────────────
  test('RealPropertyEditor defaults currency by country and reads the code', () => {
    const editor = new RealPropertyEditor({
      container: makeMockContainer(),
      node: { id: 'r1', name: 'AU House', country: 'AU' },
      people: [], accounts: [],
    });
    editor.render();
    expect(editor._rootEl.querySelector('[data-id="currency"]').value).toBe('AUD');
    expect(editor._readForm(editor._rootEl).currency).toBe('AUD');
  });

  test('CollectibleEditor honors an explicit currency override', () => {
    const editor = new CollectibleEditor({
      container: makeMockContainer(),
      node: { id: 'c1', name: 'Bullion', country: 'US', currency: { code: 'AUD', symbol: 'A$' } },
      people: [], accounts: [],
    });
    editor.render();
    expect(editor._rootEl.querySelector('[data-id="currency"]').value).toBe('AUD');
    expect(editor._readForm(editor._rootEl).currency).toBe('AUD');
  });
});
