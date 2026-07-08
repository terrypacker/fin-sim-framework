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
 * The holdings-editor Rate Key field is a grouped <select> (not free text). A
 * holding's rateKey selects which market-return series drives its growth, so the
 * valid set is the RATE_KEYS enum. The dropdown: renders as a select with
 * <optgroup>s, preselects the holding's current key, offers a blank "— none —",
 * and preserves an out-of-enum (custom/legacy) value instead of dropping it.
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

const rateKeyCell = (root) => root.querySelector('[data-f="rateKey"]');

describe('holdings editor — Rate Key dropdown', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('renders as a grouped <select>, not a text input', () => {
    const root = editorForHolding({ rateKey: 'EQUITY_US' })._rootEl;
    const cell = rateKeyCell(root);
    expect(cell.tagName).toBe('SELECT');
    expect(cell.querySelectorAll('optgroup').length).toBeGreaterThan(0);
    // Blank "— none —" option is present and first.
    expect(cell.querySelector('option').value).toBe('');
  });

  test('preselects the holding’s current known rate key', () => {
    const root = editorForHolding({ rateKey: 'FIXED_INCOME_AU' })._rootEl;
    expect(rateKeyCell(root).value).toBe('FIXED_INCOME_AU');
  });

  test('a blank rate key selects the "— none —" option', () => {
    const root = editorForHolding({ rateKey: '' })._rootEl;
    expect(rateKeyCell(root).value).toBe('');
  });

  test('per-account-type member keys are offered (full set, not just class keys)', () => {
    const root = editorForHolding({ rateKey: '' })._rootEl;
    const values = [...rateKeyCell(root).querySelectorAll('option')].map(o => o.value);
    expect(values).toContain('EQUITY_US_ROTH');
    expect(values).toContain('EQUITY_AU_SUPER');
    expect(values).toContain('COLLECTIBLE');
  });

  test('an out-of-enum custom value is preserved and selected (never silently dropped)', () => {
    const editor = editorForHolding({ rateKey: 'LEGACY_CUSTOM_KEY' });
    const root   = editor._rootEl;
    expect(rateKeyCell(root).value).toBe('LEGACY_CUSTOM_KEY');
    // Survives a read-back through _readForm too.
    const data = editor._readForm(root);
    expect(data.holdings.find(h => h.id === 'h1').rateKey).toBe('LEGACY_CUSTOM_KEY');
  });
});
