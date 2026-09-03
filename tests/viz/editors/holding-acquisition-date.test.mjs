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
 * Account editor — the per-lot acquisition date.
 *
 * `Holding.purchaseDate` shipped as a fully-plumbed model field with no authoring
 * surface: it drives FIFO/HIFO order (`holdings-selection`), the per-country long/short
 * split and the AU Division 115 12-month gate (`holdings-fifo`, `holding-period`), the
 * §1091 61-day window (`wash-sale.js`) and the design 57 §6.3 CPI back-cast — and until
 * now only the bond-ladder builder could write one. Every authored lot booted null,
 * which `_purchaseTs` reads as epoch 0.
 *
 * The three things that are easy to get wrong here:
 *
 *   · it is a POSITION field, so it must stay editable when the lot names a security.
 *     Design 94 §5.1 keeps acquisition on the position and `SECURITY_FIELDS` has no
 *     such key — two lots of one instrument bought years apart are two tax lots, which
 *     is the entire reason a lot exists;
 *   · empty must round-trip as `null`, never as a materialised epoch-0 Date. The
 *     back-cast is gated on that null (see holdings-cost-basis-fifo.test.mjs), so a
 *     1970 date would index a cost base over inflation it never lived through;
 *   · it belongs on GOLD as much as on EQUITY. The US collectibles rules a gold ETF
 *     turns on are themselves a long/short test (§1(h)(4)'s 28% rate reaches LONG-term
 *     collectible gain), and they read this same date when they land.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { AccountEditor } from '../../../src/visualization/accounts/account-editor.js';
import { scenarioSecurityRegistry } from '../../../src/finance/holdings/security.js';

// A registry that is deliberately CHATTY: this security declares a market and a yield,
// so the fields beside the date really are rendered inherited. If acquisition were ever
// added to SECURITY_FIELDS, this is the fixture that would catch it.
const REGISTRY = scenarioSecurityRegistry({
  securities: [
    { id: 'sec-emp', symbol: 'EMP', name: 'Employer stock',
      rateKey: 'EQUITY_US', dividendYield: 0.006 },
  ],
});

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

describe('holdings editor — acquisition date', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('every detail-bearing allocation exposes it, as a date input', () => {
    for (const allocation of ['EQUITY', 'GOLD', 'BOND']) {
      const input = cell(editorForHolding({ allocation })._rootEl, 'purchaseDate');
      expect(input).not.toBeNull();
      expect(input.type).toBe('date');
      expect(input.disabled).toBe(false);
    }
  });

  test('CASH has no detail row at all, so no date — a currency lot has no capital gain', () => {
    expect(cell(editorForHolding({ allocation: 'CASH' })._rootEl, 'purchaseDate')).toBeNull();
  });

  test('an authored date is reflected, from a Date and from an ISO string alike', () => {
    // A holding arrives as a Date on the live path and as an ISO string after a
    // save/load round-trip; both must render the same yyyy-mm-dd.
    const fromDate = editorForHolding({ purchaseDate: new Date(Date.UTC(2019, 2, 14)) })._rootEl;
    expect(cell(fromDate, 'purchaseDate').value).toBe('2019-03-14');

    const fromIso = editorForHolding({ purchaseDate: '2019-03-14T00:00:00.000Z' })._rootEl;
    expect(cell(fromIso, 'purchaseDate').value).toBe('2019-03-14');
  });

  test('an unauthored lot renders empty, not epoch 0', () => {
    expect(cell(editorForHolding({ purchaseDate: null })._rootEl, 'purchaseDate').value).toBe('');
    expect(cell(editorForHolding({})._rootEl, 'purchaseDate').value).toBe('');
  });

  test('editing writes a Date; clearing writes null, and both survive _readForm', () => {
    const editor = editorForHolding({});
    const input  = cell(editor._rootEl, 'purchaseDate');

    input.value = '2021-06-30';
    input.dispatchEvent(new window.Event('input'));
    expect(editor._holdings[0].purchaseDate instanceof Date).toBe(true);
    expect(editor._holdings[0].purchaseDate.toISOString().slice(0, 10)).toBe('2021-06-30');
    expect(editor._readForm(editor._rootEl).holdings[0].purchaseDate.toISOString().slice(0, 10))
      .toBe('2021-06-30');

    input.value = '';
    input.dispatchEvent(new window.Event('input'));
    expect(editor._holdings[0].purchaseDate).toBeNull();
    expect(editor._readForm(editor._rootEl).holdings[0].purchaseDate).toBeNull();
  });

  test('a lot naming a security keeps the date EDITABLE — acquisition is not an instrument field', () => {
    const node = {
      id: 'b1', name: 'Broker', type: 'brokerage', country: 'US',
      currency: { code: 'USD', symbol: '$' },
      holdings: [{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 1000,
                   securityId: 'sec-emp', purchaseDate: new Date(Date.UTC(2018, 0, 2)) }],
    };
    const editor = new AccountEditor({
      container: makeMockContainer(), node, people: [], securities: REGISTRY,
    });
    editor.render();

    // Control: the security IS taking fields over on this very row, so a passing
    // assertion below cannot be an artefact of an empty registry.
    expect(cell(editor._rootEl, 'dividendYield')).toBeNull();   // inherited, not editable

    const input = cell(editor._rootEl, 'purchaseDate');
    expect(input).not.toBeNull();
    expect(input.disabled).toBe(false);           // NOT rendered through instrumentField
    expect(input.value).toBe('2018-01-02');

    input.value = '2022-11-01';
    input.dispatchEvent(new window.Event('input'));
    expect(editor._holdings[0].purchaseDate.toISOString().slice(0, 10)).toBe('2022-11-01');
  });
});
