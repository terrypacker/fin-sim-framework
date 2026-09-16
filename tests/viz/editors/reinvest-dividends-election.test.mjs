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
 * Account editor — the dividend-reinvestment election (design 106 phase 1).
 *
 * A DRIP election is made per broker, so the control belongs on the account. Three
 * things are easy to get wrong here and all three are pinned below:
 *
 *   · the gate is ROLE, not type. Every brokerage is the same TYPE, but only a
 *     us-stock account today has a dividend separated from its price return and a cash
 *     branch to route it to. A control that routes nothing is worse than no control;
 *   · the field is TRI-STATE. "Default" (null) is the account following the plan-wide
 *     parameter and is NOT the same as electing cash — collapsing '' to false would
 *     pin the account to today's default and silently unsubscribe it from the lever;
 *   · a `false` election must survive `_readForm`, for the same reason.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { AccountEditor } from '../../../src/visualization/accounts/account-editor.js';

const PRIME = { US: 0.045, AU: 0.0435 };

function render(node) {
  const editor = new AccountEditor({
    container: makeMockContainer(), node, people: [],
    realProperties: [], accounts: [], primeRates: PRIME,
  });
  editor.render();
  return editor;
}

const brokerage = (over = {}) => ({
  id: 'ac1', name: 'US Brokerage', type: 'brokerage', role: 'us-stock',
  country: 'US', currency: { code: 'USD' }, balance: 150_000, ...over,
});

const shown  = (el) => el.querySelector('[data-id="reinvestDividendsRow"]').style.display !== 'none';
const select = (el) => el.querySelector('[data-id="reinvestDividends"]');

describe('account editor — dividend reinvestment election (design 106)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('shown for both broker roles — us-stock (phase 1) and au-stock (phase 1b)', () => {
    expect(shown(render(brokerage())._rootEl)).toBe(true);
    expect(shown(render(brokerage({ role: 'au-stock', country: 'AU' }))._rootEl)).toBe(true);
  });

  test('hidden where the election would route nothing', () => {
    // fixed-income holds bonds and has no dividend stream at all; a wrapper never
    // separates the dividend from its price return (design 99 P2), and super cannot
    // pay income out (design 105).
    for (const role of ['fixed-income', 'ira', 'roth-ira', 'k401', 'super']) {
      const type = ['ira', 'roth-ira', 'k401', 'super'].includes(role)
        ? { 'ira': 'ira', 'roth-ira': 'roth', 'k401': '401k', 'super': 'super' }[role]
        : 'brokerage';
      expect(shown(render(brokerage({ role, type }))._rootEl)).toBe(false);
    }
  });

  test('an unelected account reads back null — "follow the plan-wide default"', () => {
    const editor = render(brokerage());
    expect(select(editor._rootEl).value).toBe('');
    expect(editor._readForm(editor._rootEl).reinvestDividends).toBeNull();
  });

  test('both elections populate and round-trip, including false', () => {
    for (const [elected, value] of [[true, 'true'], [false, 'false']]) {
      const editor = render(brokerage({ reinvestDividends: elected }));
      expect(select(editor._rootEl).value).toBe(value);
      expect(editor._readForm(editor._rootEl).reinvestDividends).toBe(elected);
    }
  });

  test('choosing "Pay cash" is an election, not a clear', () => {
    const editor = render(brokerage({ reinvestDividends: true }));
    const el = editor._rootEl;
    select(el).value = 'false';
    expect(editor._readForm(el).reinvestDividends).toBe(false);
    select(el).value = '';
    expect(editor._readForm(el).reinvestDividends).toBeNull();
  });

  test('reachable on the CREATE form, where the role does not exist yet', () => {
    // The controller derives the role from type + country on save. Without the same
    // prediction here the election would be unreachable until the account had been
    // created and reopened.
    const editor = render(null);
    const el = editor._rootEl;
    el.querySelector('[data-id="type"]').value = 'brokerage';
    el.querySelector('[data-id="type"]').dispatchEvent(new window.Event('change'));
    expect(shown(el)).toBe(true);

    // AU is a broker role too since phase 1b, so the row stays — but a type that is
    // not a brokerage at all takes it away.
    el.querySelector('[data-id="country"]').value = 'AU';
    el.querySelector('[data-id="country"]').dispatchEvent(new window.Event('change'));
    expect(shown(el)).toBe(true);

    el.querySelector('[data-id="type"]').value = 'savings';
    el.querySelector('[data-id="type"]').dispatchEvent(new window.Event('change'));
    expect(shown(el)).toBe(false);
  });

  test('an account that cannot act on the election never sends the field', () => {
    const editor = render(brokerage({ role: 'fixed-income' }));
    expect('reinvestDividends' in editor._readForm(editor._rootEl)).toBe(false);
  });
});
