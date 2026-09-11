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
 * Account editor — the read-only expected return (design 99 P3, §8 Q2). An account has no
 * growth or dividend rate of its own since design 99 P2; the editor shows what its
 * holdings' markets add up to, and hides the line when there is nothing to derive.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { AccountEditor } from '../../../src/visualization/accounts/account-editor.js';
import { MARKET_GROWTH_PARAMS, marketReturnFor } from '../../../src/finance/economic-regimes/market-returns.js';

const RATES = Object.fromEntries(MARKET_GROWTH_PARAMS.map(m => [m.rateKey, marketReturnFor({}, m.rateKey)]));
const USD = { code: 'USD', symbol: '$' };
const pct = x => `${(x * 100).toFixed(2)}%`;
const US = RATES.EQUITY_US, AU = RATES.EQUITY_AU;

function editorFor(node, marketRates = RATES) {
  const editor = new AccountEditor({ container: makeMockContainer(), node, people: [], marketRates });
  editor.render();
  return editor;
}
const hintOf = editor => editor._rootEl.querySelector('[data-id="expectedReturn"]');

const usLot = (over = {}) => ({ id: 'h1', label: 'US', allocation: 'EQUITY', rateKey: 'EQUITY_US',
  marketValue: 100_000, costBasis: 100_000, ...over });

describe('design 99 P3 — derived expected return', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('taxable brokerage: total = growth + dividends paid out', () => {
    const hint = hintOf(editorFor({ id: 'b1', name: 'Broker', type: 'brokerage', role: 'us-stock',
      country: 'US', currency: USD, holdings: [usLot()] }));
    expect(hint.style.display).not.toBe('none');
    expect(hint.textContent).toBe(`Expected return ${pct(US.total)} a year = ${pct(US.total - US.yield)} growth + ${pct(US.yield)} paid as dividends`);
  });

  test('retirement wrapper: the dividends are a slice of the total', () => {
    const hint = hintOf(editorFor({ id: 'r1', name: 'Roth', type: 'roth', role: 'roth-ira',
      country: 'US', currency: USD, holdings: [usLot()] }));
    expect(hint.textContent).toBe(`Expected return ${pct(US.total)} a year (${pct(US.yield)} of it dividends)`);
  });

  test('refreshes when the holdings change', () => {
    const editor = editorFor({ id: 'r1', name: 'Roth', type: 'roth', role: 'roth-ira',
      country: 'US', currency: USD, holdings: [usLot()] });
    editor._holdings.push(usLot({ id: 'h2', rateKey: 'EQUITY_AU', marketValue: 100_000 }));
    editor._syncBalance(editor._rootEl);
    expect(hintOf(editor).textContent).toBe(`Expected return ${pct((US.total + AU.total) / 2)} a year (${pct((US.yield + AU.yield) / 2)} of it dividends)`);
  });

  test('a lot on an appreciation schedule is named, not blended', () => {
    const hint = hintOf(editorFor({ id: 'r1', name: 'Roth', type: 'roth', role: 'roth-ira',
      country: 'US', currency: USD,
      holdings: [usLot(), usLot({ id: 'h2', appreciationSchedule: [{ year: 2027, rate: 0.2 }] })] }));
    expect(hint.textContent).toMatch(/· 1 lot on an appreciation schedule not included$/);
  });

  test('hidden with no equity lots, and hidden when the host supplies no market rates', () => {
    expect(hintOf(editorFor({ id: 's1', name: 'Savings', type: 'savings', country: 'US', currency: USD }))
      .style.display).toBe('none');
    expect(hintOf(editorFor({ id: 'r1', name: 'Roth', type: 'roth', role: 'roth-ira', country: 'US',
      currency: USD, holdings: [usLot()] }, null)).style.display).toBe('none');
  });
});
