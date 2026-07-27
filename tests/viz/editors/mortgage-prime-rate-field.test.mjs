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
 * Prime-relative mortgage rate field (design 56 §10 / Phase 3). The property editor's
 * "Mtg. Int. Rate" input is the ABSOLUTE rate the bank quotes; on save it is stored as
 * `mortgagePrimeSpread = absolute − Prime(country)` (clearing the absolute), with a
 * read-only "= Prime + spread" hint. A non-Prime scenario falls back to a fixed absolute.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { RealPropertyEditor } from '../../../src/visualization/assets/real-property-editor.js';

const PRIME = { US: 0.045, AU: 0.0435 };

function editorFor(node, primeRates = PRIME) {
  const editor = new RealPropertyEditor({ container: makeMockContainer(), node, people: [], accounts: [], primeRates });
  editor.render();
  return editor;
}

describe('design 56 §10 — Prime-relative mortgage rate field', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('shows the absolute (Prime + spread) and the "= Prime + spread" hint', () => {
    // spread +0.015 ⇒ absolute 0.045 + 0.015 = 0.06
    const editor = editorFor({ id: 'p1', name: 'US House', country: 'US', mortgagePrimeSpread: 0.015 });
    const root = editor._rootEl;
    expect(Number(root.querySelector('[data-id="mortgageInterestRate"]').value)).toBeCloseTo(0.06, 9);
    expect(root.querySelector('[data-id="mortgageRateHint"]').textContent)
      .toBe('= Prime (4.50%) + 1.50%');
  });

  test('_readForm stores mortgagePrimeSpread = absolute − Prime and clears the absolute', () => {
    const editor = editorFor({ id: 'p1', name: 'US House', country: 'US', mortgagePrimeSpread: 0.015 });
    const root = editor._rootEl;
    // User re-quotes the mortgage at 7%.
    root.querySelector('[data-id="mortgageInterestRate"]').value = 0.07;
    const data = editor._readForm(root);
    expect(data.mortgagePrimeSpread).toBeCloseTo(0.07 - 0.045, 9); // +0.025
    expect(data.mortgageInterestRate).toBe(0);                     // absolute cleared (spread wins)
  });

  test('AU property uses the independent PRIME_AU baseline', () => {
    const editor = editorFor({ id: 'p2', name: 'AU House', country: 'AU', mortgagePrimeSpread: 0.02 });
    const root = editor._rootEl;
    expect(Number(root.querySelector('[data-id="mortgageInterestRate"]').value)).toBeCloseTo(0.0635, 9); // 0.0435 + 0.02
    expect(root.querySelector('[data-id="mortgageRateHint"]').textContent)
      .toBe('= Prime (4.35%) + 2.00%');
  });

  test('a fixed (spread-less) mortgage shows its absolute rate', () => {
    const editor = editorFor({ id: 'p3', name: 'Fixed House', country: 'US', mortgageInterestRate: 0.055 });
    const root = editor._rootEl;
    expect(Number(root.querySelector('[data-id="mortgageInterestRate"]').value)).toBeCloseTo(0.055, 9);
    // Entered absolute converts to a spread on save (opt-in on re-edit).
    const data = editor._readForm(root);
    expect(data.mortgagePrimeSpread).toBeCloseTo(0.055 - 0.045, 9);
  });

  test('no Prime configured → stores the entered value as a fixed absolute', () => {
    const editor = editorFor({ id: 'p1', name: 'US House', country: 'US', mortgageInterestRate: 0.06 }, {});
    const root = editor._rootEl;
    expect(Number(root.querySelector('[data-id="mortgageInterestRate"]').value)).toBeCloseTo(0.06, 9);
    root.querySelector('[data-id="mortgageInterestRate"]').value = 0.05;
    const data = editor._readForm(root);
    expect(data.mortgageInterestRate).toBeCloseTo(0.05, 9);
    expect(data.mortgagePrimeSpread).toBeNull();
    expect(root.querySelector('[data-id="mortgageRateHint"]').textContent)
      .toBe('Prime not configured — stored as an absolute rate');
  });
});
