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
 * Account editor — an equity lot's share count, price per share and cost per share.
 *
 * The importer writes the broker's count (`units`) and price (`pricePerUnit`) on every
 * equity lot, and the run derives the lot's value from the two. Before these fields the
 * only place a share count showed was the label, which is how a split Quicken applied to
 * some lots and not to others went unseen (study macro-regimes-2026 flag 23): cost per
 * share is the number that gives it away.
 *
 * What is easy to get wrong:
 *
 *   · Market Value must lock while both are set — `syncHolding` would overwrite a typed
 *     value at boot;
 *   · typing the first of the pair must not move the money;
 *   · a count without a price must never be saved, because it boots at $0.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { AccountEditor } from '../../../src/visualization/accounts/account-editor.js';

function editorFor(holding) {
  const node = {
    id: 'b1', name: 'Broker', type: 'brokerage', country: 'US',
    currency: { code: 'USD', symbol: '$' },
    holdings: [{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 800, ...holding }],
  };
  const editor = new AccountEditor({ container: makeMockContainer(), node, people: [] });
  editor.render();
  return editor;
}

const cell = (root, sel) => root.querySelector(sel);
const set  = (input, value) => { input.value = value; input.dispatchEvent(new Event('change')); };
const saved = (editor) => editor._readForm(editor._rootEl).holdings[0];

describe('holdings editor — shares', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('an imported lot shows its shares, price and cost per share, and its value is locked', () => {
    const root = editorFor({ units: 12.13, pricePerUnit: 18.68, marketValue: 226.59, costBasis: 1200 })._rootEl;
    expect(cell(root, '[data-f="units"]').value).toBe('12.13');
    expect(cell(root, '[data-f="pricePerUnit"]').value).toBe('18.68');
    expect(cell(root, '[data-out="costPerShare"]').value).toBe('98.9283');
    expect(cell(root, '[data-f="marketValue"]').disabled).toBe(true);
  });

  test('a dollar position shows blank shares and an editable value', () => {
    const root = editorFor({})._rootEl;
    expect(cell(root, '[data-f="units"]').value).toBe('');
    expect(cell(root, '[data-out="costPerShare"]').value).toBe('');
    expect(cell(root, '[data-f="marketValue"]').disabled).toBe(false);
  });

  test('typing a share count derives the price from the value, so the money does not move', () => {
    const editor = editorFor({});
    set(cell(editor._rootEl, '[data-f="units"]'), '40');
    const h = saved(editor);
    expect(h.units).toBe(40);
    expect(h.pricePerUnit).toBe(25);
    expect(h.marketValue).toBe(1000);
    expect(cell(editor._rootEl, '[data-f="marketValue"]').disabled).toBe(true);
    expect(cell(editor._rootEl, '[data-out="costPerShare"]').value).toBe('20.0000');
  });

  test('once both are set, a new count re-derives the value at the same price', () => {
    const editor = editorFor({ units: 40, pricePerUnit: 25 });
    set(cell(editor._rootEl, '[data-f="units"]'), '280');
    expect(saved(editor).marketValue).toBe(7000);
    expect(cell(editor._rootEl, '[data-f="marketValue"]').value).toBe('7000');
  });

  test('clearing shares makes it a dollar position again, at the value it stands at', () => {
    const editor = editorFor({ units: 40, pricePerUnit: 25 });
    set(cell(editor._rootEl, '[data-f="units"]'), '');
    const h = saved(editor);
    expect(h.units).toBeUndefined();
    expect(h.pricePerUnit).toBeUndefined();
    expect(h.marketValue).toBe(1000);
    expect(cell(editor._rootEl, '[data-f="marketValue"]').disabled).toBe(false);
  });

  test('a count with no price is never saved — it would boot at $0', () => {
    const editor = editorFor({ marketValue: 0, costBasis: 0 });
    set(cell(editor._rootEl, '[data-f="units"]'), '10');
    expect(saved(editor).units).toBeUndefined();
  });

  test('gold and bond lots have no share fields', () => {
    for (const allocation of ['GOLD', 'BOND']) {
      expect(cell(editorFor({ allocation })._rootEl, '[data-f="units"]')).toBeNull();
    }
  });
});
