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
 * Real-property editor — mortgage terms and deductibility (design 86 G2/G3/G6/G7).
 *
 * The engine half of design 86 shipped without an authoring surface, so an
 * interest-only period, a loan term, a stated deductible fraction and a §988 booking
 * rate were reachable only from a spec file. These pin the five fields, and in
 * particular that a BLANK one round-trips as `null` rather than 0: `mortgageMaturityYear
 * = 0` is a loan due in year zero, and `mortgageDeductibleFraction = 0` states that
 * nothing is deductible — both very different from "unset", which keeps the pre-86
 * behaviour.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { RealPropertyEditor } from '../../../src/visualization/assets/real-property-editor.js';

const TERM_FIELDS = [
  'mortgageInterestOnly',
  'mortgageInterestOnlyUntilYear',
  'mortgageMaturityYear',
  'mortgageDeductibleFraction',
  'mortgageBookingFxRate',
];

function render(node) {
  const editor = new RealPropertyEditor({ container: makeMockContainer(), node, people: [], accounts: [] });
  editor.render();
  return editor;
}

describe('real-property editor — mortgage term fields (design 86)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('all five fields exist, in a Mortgage section alongside balance/payment/rate', () => {
    const el = render({ id: 'p1', name: 'AU House' })._rootEl;
    for (const id of TERM_FIELDS) expect(el.querySelector(`[data-id="${id}"]`)).not.toBeNull();

    const heads = [...el.querySelectorAll('.node-section-head')].map(h => h.textContent);
    expect(heads.some(t => /^Mortgage/.test(t))).toBe(true);
    // The pre-existing mortgage inputs moved into the section rather than staying
    // scattered between the header block and the rental block.
    const html = el.innerHTML;
    expect(html.indexOf('Mortgage (design')).toBeLessThan(html.indexOf('data-id="mortgageBalance"'));
    expect(html.indexOf('data-id="mortgageInterestRate"')).toBeLessThan(html.indexOf('Rental Income (design 48)'));
  });

  test('a fresh property is pre-86 inert: IO off, every term blank', () => {
    const editor = render({ id: 'p1', name: 'AU House' });
    const el = editor._rootEl;
    expect(el.querySelector('[data-id="mortgageInterestOnly"]').checked).toBe(false);
    for (const id of TERM_FIELDS.slice(1)) expect(el.querySelector(`[data-id="${id}"]`).value).toBe('');

    const data = editor._readForm(el);
    expect(data.mortgageInterestOnly).toBe(false);
    expect(data.mortgageInterestOnlyUntilYear).toBeNull();
    expect(data.mortgageMaturityYear).toBeNull();
    expect(data.mortgageDeductibleFraction).toBeNull();
    expect(data.mortgageBookingFxRate).toBeNull();
  });

  test('populates from the node and round-trips through _readForm', () => {
    const editor = render({
      id: 'p1', name: 'AU House', country: 'AU',
      mortgageBalance: 500_000, monthlyMortgage: 0,
      mortgageInterestOnly: true,
      mortgageInterestOnlyUntilYear: 2031,
      mortgageMaturityYear: 2051,
      mortgageDeductibleFraction: 0.6,
      mortgageBookingFxRate: 1.42,
    });
    const el = editor._rootEl;
    expect(el.querySelector('[data-id="mortgageInterestOnly"]').checked).toBe(true);
    expect(el.querySelector('[data-id="mortgageInterestOnlyUntilYear"]').value).toBe('2031');

    const data = editor._readForm(el);
    expect(data.mortgageInterestOnly).toBe(true);
    expect(data.mortgageInterestOnlyUntilYear).toBe(2031);
    expect(data.mortgageMaturityYear).toBe(2051);
    expect(data.mortgageDeductibleFraction).toBe(0.6);
    expect(data.mortgageBookingFxRate).toBe(1.42);
  });

  test('a stated 0 deductible fraction survives — it is not the same as blank', () => {
    const editor = render({ id: 'p1', name: 'AU House', mortgageDeductibleFraction: 0 });
    const data = editor._readForm(editor._rootEl);
    expect(data.mortgageDeductibleFraction).toBe(0);
  });

  test('a percent typed instead of a fraction is clamped to 1, not multiplied by 50', () => {
    const editor = render({ id: 'p1', name: 'AU House' });
    editor._rootEl.querySelector('[data-id="mortgageDeductibleFraction"]').value = '50';
    expect(editor._readForm(editor._rootEl).mortgageDeductibleFraction).toBe(1);
  });

  test('the term hint names the reversion, and flags an IO expiry with no maturity year', () => {
    const editor = render({ id: 'p1', name: 'AU House' });
    const el   = editor._rootEl;
    const hint = () => el.querySelector('[data-id="mortgageTermHint"]').textContent;

    expect(hint()).toBe('');

    el.querySelector('[data-id="mortgageInterestOnly"]').checked = true;
    editor._updateMortgageTermHint(el);
    expect(hint()).toMatch(/interest-only for life/i);

    el.querySelector('[data-id="mortgageInterestOnlyUntilYear"]').value = '2031';
    editor._updateMortgageTermHint(el);
    // No maturity year ⇒ scheduledLoanPayment falls back to the fixed payment.
    expect(hint()).toMatch(/set a Maturity Year/i);

    el.querySelector('[data-id="mortgageMaturityYear"]').value = '2051';
    editor._updateMortgageTermHint(el);
    expect(hint()).toMatch(/2031.*re-amortised.*2051/i);
  });
});
