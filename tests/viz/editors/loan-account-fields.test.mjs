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
 * Account editor — the LOAN (liability) type (design 54 §2 + design 86 terms).
 *
 * `LoanAccount` has existed since design 54 but was unreachable from the UI: the type
 * select offered no "loan", so every loan in the model was one synthesized from a
 * property's mortgage. These pin the authoring surface, and the three things about it
 * that are easy to get wrong:
 *
 *   · a liability shows no drawdown priority and no minimum balance — the ctor forces
 *     `drawdownPriority` null and nothing reads a loan's minimum;
 *   · the rate input is the ABSOLUTE the lender quotes but is STORED Prime-relative,
 *     exactly like the cash rate and the property's mortgage rate (design 56);
 *   · a blank term field is `null`, not 0.
 *
 * The property picker offers every property: a loan linked to a mortgaged house is the
 * other part of a split (design 113 §8). The rate-type controls (design 113) are pinned
 * at the bottom.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { AccountEditor } from '../../../src/visualization/accounts/account-editor.js';

const PRIME = { US: 0.045, AU: 0.0435 };

const PROPERTIES = [
  { id: 'p1', name: 'AU House',     stateKey: 'auHouseProperty', mortgageBalance: 500_000 },
  { id: 'p2', name: 'Beach Shack',  stateKey: 'shackProperty',   mortgageBalance: 0 },
  { id: 'p3', name: 'Unwired',      mortgageBalance: 0 },  // no stateKey → not offerable
];

const ACCOUNTS = [
  { id: 'ac1', name: 'AU Offset',   stateKey: 'auOffsetAccount', type: 'offset' },
  { id: 'ac2', name: 'US Checking', stateKey: 'usSavingsAccount', type: 'checking' },
  { id: 'ac3', name: 'Other Loan',  stateKey: 'otherLoanAccount', type: 'loan' },
];

function render(node, { realProperties = PROPERTIES, accounts = ACCOUNTS } = {}) {
  const editor = new AccountEditor({
    container: makeMockContainer(), node, people: [],
    realProperties, accounts, primeRates: PRIME,
  });
  editor.render();
  return editor;
}

const loanNode = (over = {}) => ({
  id: 'ac9', name: 'AU Mortgage', type: 'loan', country: 'AU',
  currency: { code: 'AUD' }, balance: 500_000, ...over,
});

describe('account editor — loan (liability) type', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('the type select offers loan', () => {
    const el = render(null)._rootEl;
    const opts = [...el.querySelectorAll('[data-id="type"] option')].map(o => o.value);
    expect(opts).toContain('loan');
  });

  test('loan fields show only for a loan, and the liability rows are hidden', () => {
    const loanEl = render(loanNode())._rootEl;
    expect(loanEl.querySelector('[data-id="loanFields"]').style.display).toBe('');
    expect(loanEl.querySelector('[data-id="drawdownRow"]').style.display).toBe('none');
    expect(loanEl.querySelector('[data-id="minimumBalanceRow"]').style.display).toBe('none');
    // `balance` is debt owed on a liability; label it so it can't read as an asset.
    expect(loanEl.querySelector('[data-id="balance"]').closest('.node-field')
      .querySelector('label').textContent).toBe('Principal Owed');

    const cashEl = render({ id: 'ac1', name: 'Cash', type: 'savings', country: 'US' })._rootEl;
    expect(cashEl.querySelector('[data-id="loanFields"]').style.display).toBe('none');
    expect(cashEl.querySelector('[data-id="drawdownRow"]').style.display).toBe('');
  });

  test('a fresh loan is pre-86 inert: IO off, every term blank, no links', () => {
    const editor = render(loanNode());
    const el = editor._rootEl;
    expect(el.querySelector('[data-id="interestOnly"]').checked).toBe(false);
    for (const id of ['interestOnlyUntil', 'maturityDate', 'deductibleFraction', 'bookingFxRate']) {
      expect(el.querySelector(`[data-id="${id}"]`).value).toBe('');
    }
    const data = editor._readForm(el);
    expect(data.interestOnly).toBe(false);
    expect(data.interestOnlyUntil).toBeNull();
    expect(data.maturityDate).toBeNull();
    expect(data.deductibleFraction).toBeNull();
    expect(data.bookingFxRate).toBeNull();
    expect(data.linkedPropertyKey).toBeNull();
    expect(data.paymentSourceKey).toBeNull();
    expect(data.drawdownPriority).toBeNull();
  });

  test('populates from the node and round-trips through _readForm', () => {
    const editor = render(loanNode({
      monthlyPayment: 3_400, interestOnly: true,
      interestOnlyUntil: '2031-07-01', maturityDate: '2051-07-01',
      deductibleFraction: 0.6, bookingFxRate: 1.42,
      linkedPropertyKey: 'shackProperty', paymentSourceKey: 'auOffsetAccount',
    }));
    const el = editor._rootEl;
    expect(el.querySelector('[data-id="monthlyPayment"]').value).toBe('3400');
    expect(el.querySelector('[data-id="interestOnly"]').checked).toBe(true);
    expect(el.querySelector('[data-id="linkedPropertyKey"]').value).toBe('shackProperty');
    expect(el.querySelector('[data-id="paymentSourceKey"]').value).toBe('auOffsetAccount');

    const data = editor._readForm(el);
    expect(data.monthlyPayment).toBe(3400);
    expect(data.interestOnly).toBe(true);
    expect(data.interestOnlyUntil).toBe('2031-07-01');
    expect(data.maturityDate).toBe('2051-07-01');
    expect(data.deductibleFraction).toBe(0.6);
    expect(data.bookingFxRate).toBe(1.42);
    expect(data.linkedPropertyKey).toBe('shackProperty');
    expect(data.paymentSourceKey).toBe('auOffsetAccount');
  });

  test('the rate edits an absolute and stores a Prime spread (design 56)', () => {
    // spread +0.02 on PRIME_AU 4.35% ⇒ the lender quotes 6.35%.
    const editor = render(loanNode({ primeSpread: 0.02 }));
    const el = editor._rootEl;
    expect(Number(el.querySelector('[data-id="loanRate"]').value)).toBeCloseTo(0.0635, 9);
    expect(el.querySelector('[data-id="loanRateHint"]').textContent).toBe('= Prime (4.35%) + 2.00%');

    el.querySelector('[data-id="loanRate"]').value = 0.07;
    const data = editor._readForm(el);
    expect(data.primeSpread).toBeCloseTo(0.07 - 0.0435, 9);
    expect(data.interestRate).toBe(0);   // the spread wins in resolveLoanRate
  });

  test('no Prime configured → the entered rate is stored as a fixed absolute', () => {
    const editor = new AccountEditor({
      container: makeMockContainer(), node: loanNode({ interestRate: 0.06 }),
      people: [], realProperties: PROPERTIES, accounts: ACCOUNTS, primeRates: {},
    });
    editor.render();
    const el = editor._rootEl;
    expect(Number(el.querySelector('[data-id="loanRate"]').value)).toBeCloseTo(0.06, 9);
    const data = editor._readForm(el);
    expect(data.interestRate).toBeCloseTo(0.06, 9);
    expect(data.primeSpread).toBeNull();
  });

  test('the property picker offers a mortgaged property too — linking to it makes a split', () => {
    // Design 113 §8: every property path now reads every loan on the property, so a
    // second loan on a mortgaged house is the other half of a split, not a double-count.
    const el = render(loanNode())._rootEl;
    const values = [...el.querySelectorAll('[data-id="linkedPropertyKey"] option')].map(o => o.value);
    expect(values).toContain('shackProperty');
    expect(values).toContain('auHouseProperty');
    expect(values.filter(Boolean)).toHaveLength(2);  // the stateKey-less property is inert
  });

  test('…but a loan already linked to a mortgaged property keeps its own option', () => {
    // Otherwise re-saving an existing loan would silently unlink it.
    const el = render(loanNode({ linkedPropertyKey: 'auHouseProperty' }))._rootEl;
    expect(el.querySelector('[data-id="linkedPropertyKey"]').value).toBe('auHouseProperty');
  });

  test('the payment-source picker offers stateKeys, and never another loan', () => {
    const el = render(loanNode())._rootEl;
    const values = [...el.querySelectorAll('[data-id="paymentSourceKey"] option')].map(o => o.value);
    expect(values).toEqual(['', 'auOffsetAccount', 'usSavingsAccount']);
  });

  test('a payment source naming a deleted account is preserved, not silently re-defaulted', () => {
    const el = render(loanNode({ paymentSourceKey: 'goneAccount' }))._rootEl;
    expect(el.querySelector('[data-id="paymentSourceKey"]').value).toBe('goneAccount');
  });

  test('a percent typed into the deductible fraction is clamped to 1', () => {
    const editor = render(loanNode());
    editor._rootEl.querySelector('[data-id="deductibleFraction"]').value = '50';
    expect(editor._readForm(editor._rootEl).deductibleFraction).toBe(1);
  });

  test('the term hint flags an IO expiry with no maturity year', () => {
    const editor = render(loanNode({ interestOnly: true, interestOnlyUntil: '2031-07-01' }));
    expect(editor._rootEl.querySelector('[data-id="loanTermHint"]').textContent)
      .toMatch(/set a Maturity Date/i);
  });

  test('a non-loan account emits no loan fields in its payload', () => {
    const editor = render({ id: 'ac1', name: 'Cash', type: 'savings', country: 'US', stateKey: 'usSavingsAccount' });
    const data = editor._readForm(editor._rootEl);
    for (const f of ['monthlyPayment', 'interestOnly', 'maturityDate', 'linkedPropertyKey', 'bookingFxRate']) {
      expect(f in data).toBe(false);
    }
  });
});

describe('account editor — loan rate type (design 113)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  const q = (el, id) => el.querySelector(`[data-id="${id}"]`);

  test('a loan with a Prime spread shows as variable and saves as one', () => {
    const editor = render(loanNode({ primeSpread: 0.02 }));
    expect(q(editor._rootEl, 'rateType').value).toBe('VARIABLE');
    const data = editor._readForm(editor._rootEl);
    expect(data.rateType).toBe('VARIABLE');
    expect(data.primeSpread).toBeCloseTo(0.02, 9);
  });

  test('a fixed loan keeps its absolute rate and never becomes a Prime spread', () => {
    const editor = render(loanNode({ country: 'US', rateType: 'FIXED', interestRate: 0.065 }));
    const el = editor._rootEl;
    expect(Number(q(el, 'loanRate').value)).toBeCloseTo(0.065, 9);
    const data = editor._readForm(el);
    expect(data.primeSpread).toBeNull();
    expect(data.interestRate).toBeCloseTo(0.065, 9);
    expect(q(el, 'loanRateHint').textContent).toMatch(/Fixed for the life of the loan/);
  });

  test('a legacy spread-less loan shows as fixed with its offset preserved', () => {
    const el = render(loanNode({ interestRate: 0.06 }))._rootEl;
    expect(q(el, 'rateType').value).toBe('FIXED');
    expect(q(el, 'offsetWhileFixed').checked).toBe(true);
    expect(q(el, 'breakCostOnPayoff').checked).toBe(false);
  });

  test('fixed period: the fixed rate is absolute, the revert rate is stored against Prime', () => {
    const editor = render(loanNode());
    const el = editor._rootEl;
    q(el, 'rateType').value = 'FIXED_PERIOD';
    q(el, 'loanRate').value = '0.059';
    q(el, 'fixedRateUntil').value = '2029-07-01';
    q(el, 'revertRate').value = '0.0735';
    q(el, 'fixedExtraRepaymentCap').value = '';
    const data = editor._readForm(el);
    expect(data.rateType).toBe('FIXED_PERIOD');
    expect(data.interestRate).toBeCloseTo(0.059, 9);
    expect(data.fixedRateUntil).toBe('2029-07-01');
    expect(data.primeSpread).toBeCloseTo(0.0735 - PRIME.AU, 9);
    expect(data.fixedExtraRepaymentCap).toBeNull();
  });

  test('fixed-only rows show only for a fixed rate type', () => {
    const editor = render(loanNode({ primeSpread: 0.02 }));
    const el = editor._rootEl;
    const row = q(el, 'offsetWhileFixed').closest('.node-field');
    const periodRow = q(el, 'revertRate').closest('.node-field');
    expect(row.style.display).toBe('none');
    q(el, 'rateType').value = 'FIXED_PERIOD';
    editor._loanRateTerms.refresh();
    expect(row.style.display).toBe('');
    expect(periodRow.style.display).toBe('');
    q(el, 'rateType').value = 'FIXED';
    editor._loanRateTerms.refresh();
    expect(periodRow.style.display).toBe('none');
  });

  test('a new loan defaults to the market norm: fixed in the US, variable in AU', () => {
    const el = render(null)._rootEl;
    q(el, 'country').value = 'US';
    q(el, 'country').dispatchEvent(new Event('change'));
    expect(q(el, 'rateType').value).toBe('FIXED');
    expect(q(el, 'breakCostOnPayoff').checked).toBe(false);
    q(el, 'country').value = 'AU';
    q(el, 'country').dispatchEvent(new Event('change'));
    expect(q(el, 'rateType').value).toBe('VARIABLE');
    expect(q(el, 'breakCostOnPayoff').checked).toBe(true);
  });
});
