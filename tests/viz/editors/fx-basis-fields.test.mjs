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
 * Account editor — the §988 currency-basis fields (design 87 phases 1–2).
 *
 * `fxBasisRate` shipped as a model field with no authoring surface, which is the exact
 * shape design 86 P6 warned about: a feature only reachable by hand-editing JSON is a
 * feature whose defects are unreachable. These pin the three things that are easy to
 * get wrong here:
 *
 *   · the gate is CURRENCY, not account type. §988(c)(1)(C)(ii) reaches any bank
 *     deposit denominated in nonfunctional currency, so savings/checking/offset all
 *     qualify and USD never does (§985(b)(1) makes it the functional currency);
 *   · flipping an account to USD must both hide AND clear the fields, or an invisible
 *     basis rate keeps driving a §988 computation nobody can see;
 *   · a blank rate is `null` ("stamp at the first disposition"), never 0 — 0 is an
 *     infinite basis, and the null default deliberately UNDERSTATES §988 rather than
 *     inventing a number.
 *
 * A brokerage is deliberately excluded even though it holds a CASH sleeve: that
 * sleeve's basis belongs on the holding (design 87 G9), and an account-level rate there
 * would silently claim the equity sleeves too — which are not §988 property at all.
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

const audPool = (over = {}) => ({
  id: 'ac1', name: 'AU Offset', type: 'offset', country: 'AU',
  currency: { code: 'AUD' }, balance: 364_000, ...over,
});

const shown = (el) => el.querySelector('[data-id="fxBasisFields"]').style.display !== 'none';

describe('account editor — §988 currency basis (design 87)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('shown for a NON-USD cash pool, on every cash-like type', () => {
    for (const type of ['offset', 'savings', 'checking']) {
      expect(shown(render(audPool({ type }))._rootEl)).toBe(true);
    }
  });

  test('hidden for USD — the functional currency is not a §988 pool', () => {
    const el = render({ id: 'ac2', name: 'US Savings', type: 'savings',
                        country: 'US', currency: { code: 'USD' } })._rootEl;
    expect(shown(el)).toBe(false);
  });

  test('hidden for types that are not currency pools', () => {
    // A loan is the OTHER leg and has its own bookingFxRate; super is a pension
    // interest, not a deposit; a brokerage's cash sleeve is design 87 G9's problem.
    for (const type of ['loan', 'super', 'brokerage']) {
      expect(shown(render(audPool({ type }))._rootEl)).toBe(false);
    }
  });

  test('the gate follows the CURRENCY select, not just the type', () => {
    const editor = render(audPool());
    const el = editor._rootEl;
    expect(shown(el)).toBe(true);

    el.querySelector('[data-id="currency"]').value = 'USD';
    el.querySelector('[data-id="currency"]').dispatchEvent(new window.Event('change'));
    expect(shown(el)).toBe(false);
  });

  test('an unset pool reads back null, not 0', () => {
    const editor = render(audPool());
    const el = editor._rootEl;
    expect(el.querySelector('[data-id="fxBasisRate"]').value).toBe('');
    const data = editor._readForm(el);
    expect(data.fxBasisRate).toBeNull();
    expect(data.deductibleFraction).toBeNull();
  });

  test('populates from the node and round-trips through _readForm', () => {
    const editor = render(audPool({ fxBasisRate: 1.35, deductibleFraction: 1 }));
    const el = editor._rootEl;
    expect(el.querySelector('[data-id="fxBasisRate"]').value).toBe('1.35');
    expect(el.querySelector('[data-id="cashDeductibleFraction"]').value).toBe('1');

    const data = editor._readForm(el);
    expect(data.fxBasisRate).toBe(1.35);
    expect(data.deductibleFraction).toBe(1);
  });

  test('a zero or negative rate is rejected to null — 0 is an infinite basis', () => {
    const editor = render(audPool());
    const el = editor._rootEl;
    for (const bad of ['0', '-1.4']) {
      el.querySelector('[data-id="fxBasisRate"]').value = bad;
      expect(editor._readForm(el).fxBasisRate).toBeNull();
    }
  });

  test('the income-producing share is clamped to 0..1', () => {
    // Typing 50 for "50%" would otherwise multiply the §988(e) split by fifty, the
    // same trap design 86 clamped on the loan's deductibleFraction.
    const editor = render(audPool());
    const el = editor._rootEl;
    el.querySelector('[data-id="cashDeductibleFraction"]').value = '50';
    expect(editor._readForm(el).deductibleFraction).toBe(1);
    el.querySelector('[data-id="cashDeductibleFraction"]').value = '-2';
    expect(editor._readForm(el).deductibleFraction).toBe(0);
  });

  test('flipping to USD CLEARS the fields, not just hides them', () => {
    const editor = render(audPool({ fxBasisRate: 1.35, deductibleFraction: 1 }));
    const el = editor._rootEl;
    el.querySelector('[data-id="currency"]').value = 'USD';
    el.querySelector('[data-id="currency"]').dispatchEvent(new window.Event('change'));

    const data = editor._readForm(el);
    expect(data.fxBasisRate).toBeNull();
    expect(data.deductibleFraction).toBeNull();
  });

  test('the hint states the understatement default, then the basis it implies', () => {
    const editor = render(audPool());
    const el = editor._rootEl;
    const hint = el.querySelector('[data-id="fxBasisHint"]');
    expect(hint.textContent).toMatch(/understated/i);

    const input = el.querySelector('[data-id="fxBasisRate"]');
    input.value = '1.25';
    input.dispatchEvent(new window.Event('input'));
    expect(hint.textContent).toContain('1.25 AUD/USD');
    expect(hint.textContent).toContain('0.8000');   // 1 / 1.25
  });
});
