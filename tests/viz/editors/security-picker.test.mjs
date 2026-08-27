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
 * security-picker.test.mjs — design 94 §10 item 6 / step 9.
 *
 * The holdings editor is where design 94 §5.1's position/instrument partition either
 * becomes visible or becomes a trap. A lot names a SECURITY; the security's fields win
 * (`instrumentOf` merges `{ ...holding, ...security }`), so an editable box for a field
 * the security declares is a control that looks live, accepts input, and moves nothing —
 * the same defect §9.5b measured in the engine, transplanted into the UI.
 *
 * So what is worth pinning here is not "a select renders". It is:
 *
 *  1. the picker offers exactly the registry the RUN will use, synthetics included;
 *  2. a field the security DECLARES becomes read-only, showing the instrument's value;
 *  3. a field the security is SILENT about stays the lot's to set;
 *  4. an explicit `null` on the security counts as declaring — `in`, not `??`. That is
 *     design 94 §4 rule 2, and it is the case a `?? fallback` gets wrong every time.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { AccountEditor } from '../../../src/visualization/accounts/account-editor.js';
import { scenarioSecurityRegistry } from '../../../src/finance/holdings/security.js';

const REGISTRY = scenarioSecurityRegistry({
  securities: [
    { id: 'sec-emp',  symbol: 'EMP', name: 'Employer stock', rateKey: 'EQUITY_US', dividendYield: 0.006 },
    // Declares NO dividend yield and NO market — the "silent" instrument.
    { id: 'sec-quiet', symbol: 'QUI', name: 'Quiet instrument' },
    // Declares an explicit null: "this instrument pays nothing", which must OVERRIDE a
    // migrated lot's stale inline value rather than falling through to it.
    { id: 'sec-nil',  symbol: 'NIL', name: 'Pays nothing', rateKey: 'EQUITY_US', dividendYield: null },
  ],
});

function editorForHolding(holding, { securities = REGISTRY } = {}) {
  const node = {
    id: 'b1', name: 'Broker', type: 'brokerage', country: 'US',
    currency: { code: 'USD', symbol: '$' },
    holdings: [{ id: 'h1', allocation: 'EQUITY', marketValue: 1000, costBasis: 1000, ...holding }],
  };
  const editor = new AccountEditor({ container: makeMockContainer(), node, people: [], securities });
  editor.render();
  // The detail sub-row is collapsed until opened; the markup exists either way, which is
  // what these read.
  return editor;
}

const picker    = (root) => root.querySelector('[data-f="securityId"]');
const rateCell  = (root) => root.querySelector('[data-f="rateKey"]');
const yieldCell = (root) => root.querySelector('[data-f="dividendYield"]');
const labels    = (root) => [...root.querySelectorAll('.h-df-label')].map(e => e.textContent.trim());

describe('holdings editor — the security picker (design 94 step 9)', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('offers the scenario registry, with the synthetics grouped apart', () => {
    const root = editorForHolding({ securityId: null })._rootEl;
    const sel  = picker(root);
    expect(sel.tagName).toBe('SELECT');

    const groups = [...sel.querySelectorAll('optgroup')].map(g => g.label);
    expect(groups).toEqual(['Scenario securities', 'Market (auto)']);

    const values = [...sel.querySelectorAll('option')].map(o => o.value);
    // The plan's own instruments…
    expect(values).toContain('sec-emp');
    // …and the four synthetics every migrated equity lot names (design 94 §9.1). Without
    // them the picker would show a book of index sleeves as entirely unassigned.
    expect(values).toContain('sec-auto-EQUITY_US');
    expect(values).toContain('sec-auto-EQUITY_INTL_EX_US');
    // Blank first: a lot may legitimately name no instrument (Option A).
    expect(sel.querySelector('option').value).toBe('');
  });

  test('preselects the lot’s current security, labelled by symbol', () => {
    const root = editorForHolding({ securityId: 'sec-emp' })._rootEl;
    expect(picker(root).value).toBe('sec-emp');
    const chosen = [...picker(root).querySelectorAll('option')].find(o => o.value === 'sec-emp');
    expect(chosen.textContent).toBe('EMP');
  });

  test('an id the registry does not have is PRESERVED, not silently cleared', () => {
    // Editing against a stale registry must not delete a lot's instrument — the value
    // would be gone from the saved scenario with nothing to show it ever existed.
    const root = editorForHolding({ securityId: 'sec-from-another-scenario' })._rootEl;
    expect(picker(root).value).toBe('sec-from-another-scenario');
    const groups = [...picker(root).querySelectorAll('optgroup')].map(g => g.label);
    expect(groups).toContain('Not in this scenario');
  });

  test('a field the security DECLARES is read-only and shows the instrument’s value', () => {
    const root = editorForHolding({ securityId: 'sec-emp', rateKey: 'EQUITY_AU', dividendYield: 0.03 })._rootEl;

    // rateKey lives on the instrument, so the lot's own EQUITY_AU is dead: `instrumentOf`
    // merges EQUITY_US over it and nothing reads the lot's value again.
    const rk = rateCell(root);
    expect(rk).toBeNull();                       // no editable control by that name at all
    const inherited = root.querySelector('.h-input--inherited');
    expect(inherited.disabled).toBe(true);
    expect(inherited.value).toBe('EQUITY_US');

    // …and the same for the yield, in the detail row.
    expect(yieldCell(root)).toBeNull();
    expect(labels(root).some(t => t.startsWith('Dividend yield'))).toBe(true);
    const shown = [...root.querySelectorAll('.h-df--inherited input')].map(i => i.value);
    expect(shown).toContain('0.006');
  });

  test('a field the security is SILENT about stays the lot’s to set', () => {
    const root = editorForHolding({ securityId: 'sec-quiet', rateKey: 'EQUITY_AU', dividendYield: 0.03 })._rootEl;
    expect(rateCell(root).tagName).toBe('SELECT');
    expect(rateCell(root).value).toBe('EQUITY_AU');
    expect(yieldCell(root).disabled).toBeFalsy();
    expect(yieldCell(root).value).toBe('0.03');
  });

  test('an EXPLICIT null on the security declares — it does not fall through', () => {
    // design 94 §4 rule 2. `instrumentOf` spreads the security over the holding, so a key
    // present-and-null WINS; a `??` here would show the lot's stale 0.03 as live and
    // editable while the engine read null. This is the destinationKey trap, in a form.
    const root = editorForHolding({ securityId: 'sec-nil', dividendYield: 0.03 })._rootEl;
    expect(yieldCell(root)).toBeNull();
    const shown = [...root.querySelectorAll('.h-df--inherited input')].map(i => i.value);
    expect(shown).toContain('—');
  });

  test('with no registry supplied the picker still preserves the lot’s value', () => {
    // A host that predates step 9 passes nothing. Rendering an empty list would clear
    // every lot's instrument on the first save.
    const root = editorForHolding({ securityId: 'sec-emp' }, { securities: null })._rootEl;
    expect(picker(root).value).toBe('sec-emp');
  });

  test('choosing a security rewrites the working copy', () => {
    const editor = editorForHolding({ securityId: null });
    const sel = picker(editor._rootEl);
    sel.value = 'sec-emp';
    sel.dispatchEvent(new Event('change'));
    expect(editor._holdings[0].securityId).toBe('sec-emp');
    // …and clearing it goes back to null, not to the empty string, because `securityId`
    // is nullable and `''` is not a valid id.
    const sel2 = picker(editor._rootEl);
    sel2.value = '';
    sel2.dispatchEvent(new Event('change'));
    expect(editor._holdings[0].securityId).toBeNull();
  });
});
