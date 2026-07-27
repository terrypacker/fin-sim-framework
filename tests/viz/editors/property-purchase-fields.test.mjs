/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Real-property editor — the purchase path and the main-residence history.
 *
 * Both engines shipped without an authoring surface: `purchaseYear` and the design 83
 * G7 date fields were reachable only from a spec file, which is the same state the
 * design-86 loan terms were in before their UI landed — and that phase found three
 * silent defects that only an authoring surface could reach.
 *
 * The blank-means-null contract is the load-bearing one here, and it is *sharper* than
 * it was for the loan terms because the two blanks mean opposite things:
 *
 *   · a blank `acquisitionDate` DENIES the day-count concessions, because filling it in
 *     from the simulation start would treat a twenty-year hold as a three-year one and
 *     inflate every fraction in the taxpayer's favour;
 *   · a blank `mainResidenceFrom` DEFERS to `isPrimaryResidence`, which the history
 *     dropdown now owns — and that fallback is what keeps every saved scenario
 *     answering exactly as it did.
 *
 * Storing either as 0 or '' would collapse that distinction into one wrong answer.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { RealPropertyEditor } from '../../../src/visualization/assets/real-property-editor.js';

const PURCHASE_FIELDS = ['purchaseYear', 'purchasePrice', 'purchasePriceIsNominal', 'purchaseFundFrom'];
const HISTORY_FIELDS  = ['acquisitionDate', 'mainResidenceMode', 'mainResidenceFrom',
                         'mainResidenceUntil', 'claimDownsizerContribution'];

const ACCOUNTS = [
  { id: 'a1', name: 'AU Savings', stateKey: 'auSavingsAccount' },
  { id: 'a2', name: 'US Savings', stateKey: 'usSavingsAccount' },
];

function render(node) {
  const editor = new RealPropertyEditor({
    container: makeMockContainer(), node, people: [], accounts: ACCOUNTS,
  });
  editor.render();
  return editor;
}

describe('real-property editor — purchase + main-residence history', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('every field exists, under its own section head', () => {
    const el = render({ id: 'p1', name: 'AU House' })._rootEl;
    for (const id of [...PURCHASE_FIELDS, ...HISTORY_FIELDS]) {
      expect(el.querySelector(`[data-id="${id}"]`)).not.toBeNull();
    }
    const heads = [...el.querySelectorAll('.node-section-head')].map(h => h.textContent);
    expect(heads.some(t => /^Purchase/.test(t))).toBe(true);
    expect(heads.some(t => /^Main Residence History/.test(t))).toBe(true);
  });

  test('a fresh property is inert: no purchase, no stated history', () => {
    const el = render({ id: 'p1', name: 'AU House' })._rootEl;
    expect(el.querySelector('[data-id="purchaseYear"]').value).toBe('');
    expect(el.querySelector('[data-id="purchasePrice"]').value).toBe('');
    expect(el.querySelector('[data-id="purchasePriceIsNominal"]').checked).toBe(false);
    expect(el.querySelector('[data-id="acquisitionDate"]').value).toBe('');
    expect(el.querySelector('[data-id="mainResidenceMode"]').value).toBe('never');
    expect(el.querySelector('[data-id="claimDownsizerContribution"]').checked).toBe(false);
  });

  test('a blank purchase year and price round-trip as null, never 0', () => {
    // `purchaseYear: 0` is a real (if absurd) year and `purchasePrice: 0` is a free
    // house; both differ from "no purchase", which is what blank has to mean.
    const data = render({ id: 'p1', name: 'AU House' })._readForm(
      render({ id: 'p1', name: 'AU House' })._rootEl);
    expect(data.purchaseYear).toBeNull();
    expect(data.purchasePrice).toBeNull();
    expect(data.purchaseFundFrom).toBeNull();
    expect(data.acquisitionDate).toBeNull();
    expect(data.mainResidenceFrom).toBeNull();
    expect(data.mainResidenceUntil).toBeNull();
  });

  test('authored values round-trip through render → read', () => {
    const editor = render({
      id: 'p1', name: 'Downsize', country: 'AU',
      purchaseYear: 2036, purchasePrice: 600_000, purchasePriceIsNominal: true,
      purchaseFundFrom: 'auSavingsAccount',
      acquisitionDate: Date.UTC(2006, 0, 1),
      mainResidenceFrom: '2032-01-01',
      claimDownsizerContribution: true,
    });
    const el = editor._rootEl;
    expect(el.querySelector('[data-id="purchaseYear"]').value).toBe('2036');
    expect(el.querySelector('[data-id="purchasePriceIsNominal"]').checked).toBe(true);
    expect(el.querySelector('[data-id="claimDownsizerContribution"]').checked).toBe(true);

    // Dates render as yyyy-mm-dd whatever shape they were stored in — the model accepts
    // epoch ms, ISO strings and Dates interchangeably, and <input type="date"> accepts
    // only the last form. A date silently rendered blank would read back as "never a
    // main residence", which looks exactly like a deliberate answer.
    expect(el.querySelector('[data-id="acquisitionDate"]').value).toBe('2006-01-01');
    expect(el.querySelector('[data-id="mainResidenceFrom"]').value).toBe('2032-01-01');

    const data = editor._readForm(el);
    expect(data.purchaseYear).toBe(2036);
    expect(data.purchasePrice).toBe(600_000);
    expect(data.purchaseFundFrom).toBe('auSavingsAccount');
    expect(data.acquisitionDate).toBe('2006-01-01');
    expect(data.claimDownsizerContribution).toBe(true);
  });

  test('the funding select offers stateKeys, and defaults to the country cash pool', () => {
    // Same rule as the sale destination (design 72 §2): runtime account state carries
    // `stateKey` and not `id`, so persisting an id resolves to nothing at purchase time
    // and the debit silently falls back to the cash pool — a different plan, quietly.
    const el = render({ id: 'p1', name: 'AU House' })._rootEl;
    const sel = el.querySelector('[data-id="purchaseFundFrom"]');
    const values = [...sel.options].map(o => o.value);
    expect(values[0]).toBe('');                       // the country cash pool
    expect(values).toContain('auSavingsAccount');
    expect(values).not.toContain('a1');               // never the id
  });

  test('a legacy funding value stored as a bare id still selects, so re-saving migrates it', () => {
    const el = render({ id: 'p1', name: 'AU House', purchaseFundFrom: 'a2' })._rootEl;
    const sel = el.querySelector('[data-id="purchaseFundFrom"]');
    expect(sel.value).toBe('usSavingsAccount');
  });
});

/**
 * The history dropdown (design 83 §7b.2c).
 *
 * Its purpose is not convenience — it is that "moved out before you moved in", and
 * "not a primary residence" ticked against "main residence throughout", become
 * UNREACHABLE rather than merely invalid. Free-form dates plus a boolean can express
 * several combinations the rules have no answer for, and the model would resolve each
 * of them silently to something plausible-looking.
 */
describe('main-residence history dropdown', () => {
  beforeEach(() => loadHtml('../../index.html'));

  const readMode = (node) => {
    const editor = render(node);
    return { editor, el: editor._rootEl };
  };
  const setMode = (el, mode) => {
    const sel = el.querySelector('[data-id="mainResidenceMode"]');
    sel.value = mode;
    sel.dispatchEvent(new window.Event('change'));
  };

  test('the mode is DERIVED from the stored fields, so spec-file scenarios show right', () => {
    // No fifth field is stored. A property authored from a spec file, or saved before
    // this dropdown existed, must land on the correct option with no migration — and a
    // stored mode could drift out of sync with the three fields the engine reads.
    expect(readMode({ isPrimaryResidence: false }).el
      .querySelector('[data-id="mainResidenceMode"]').value).toBe('never');
    expect(readMode({ isPrimaryResidence: true }).el
      .querySelector('[data-id="mainResidenceMode"]').value).toBe('throughout');
    expect(readMode({ isPrimaryResidence: true, mainResidenceUntil: '2030-01-01' }).el
      .querySelector('[data-id="mainResidenceMode"]').value).toBe('moved-out');
    expect(readMode({ mainResidenceFrom: '2032-01-01' }).el
      .querySelector('[data-id="mainResidenceMode"]').value).toBe('moved-in');
  });

  test('each mode shows exactly the one date it needs', () => {
    const { el } = readMode({ id: 'p1' });
    const shown = (id) => el.querySelector(`[data-id="${id}"]`).style.display !== 'none';

    setMode(el, 'never');
    expect(shown('mainResidenceMovedInRow')).toBe(false);
    expect(shown('mainResidenceMovedOutRow')).toBe(false);

    setMode(el, 'throughout');
    expect(shown('mainResidenceMovedInRow')).toBe(false);
    expect(shown('mainResidenceMovedOutRow')).toBe(false);

    setMode(el, 'moved-in');
    expect(shown('mainResidenceMovedInRow')).toBe(true);
    expect(shown('mainResidenceMovedOutRow')).toBe(false);

    setMode(el, 'moved-out');
    expect(shown('mainResidenceMovedInRow')).toBe(false);
    expect(shown('mainResidenceMovedOutRow')).toBe(true);
  });

  test('switching mode CLEARS the date the old mode owned', () => {
    // The contradiction this prevents: pick "became one later", set a move-in date,
    // change your mind to "never" — and a stale 2032 would otherwise still be stored,
    // silently granting a partial exemption to a property the author just said was
    // never a home.
    const { editor, el } = readMode({ id: 'p1', mainResidenceFrom: '2032-01-01' });
    expect(editor._readForm(el).mainResidenceFrom).toBe('2032-01-01');

    setMode(el, 'never');
    const data = editor._readForm(el);
    expect(data.mainResidenceFrom).toBeNull();
    expect(data.mainResidenceUntil).toBeNull();
    expect(data.isPrimaryResidence).toBe(false);
  });

  test('the dropdown OWNS isPrimaryResidence — there is no checkbox to contradict it', () => {
    // The flag has no field of its own any more. A checkbox alongside the dropdown
    // could be set to disagree with it about the same property, which is precisely the
    // state §7b.2c warns against.
    const { editor, el } = readMode({ id: 'p1' });
    expect(el.querySelector('[data-id="isPrimaryResidence"]')).toBeNull();

    setMode(el, 'throughout');
    expect(editor._readForm(el).isPrimaryResidence).toBe(true);
    setMode(el, 'moved-in');
    expect(editor._readForm(el).isPrimaryResidence).toBe(false);
  });

  test('"from the start, then moved out" stores NO start date, by design', () => {
    // The start is the acquisition, and the engine's mainResidenceWindow reads that
    // combination directly. Writing a sentinel to mean "from the beginning" would put a
    // magic constant into every saved scenario.
    const { editor, el } = readMode({ id: 'p1' });
    setMode(el, 'moved-out');
    el.querySelector('[data-id="mainResidenceUntil"]').value = '2030-06-01';
    const data = editor._readForm(el);
    expect(data.isPrimaryResidence).toBe(true);
    expect(data.mainResidenceFrom).toBeNull();
    expect(data.mainResidenceUntil).toBe('2030-06-01');
  });
});
