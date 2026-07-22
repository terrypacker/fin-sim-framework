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
 * Real-property editor — owner-occupied running cost + stochastic repair fields (design 75).
 *
 * The ten Part-B fields (3 running-cost + 7 repair) are surfaced in the property editor under
 * a "Running Costs & Repairs" section, visually separated from the "Rental Income" opex section
 * above it (the two are economically distinct: rental opex is deductible; owner-occupied holding
 * cost is not). This asserts they render with the right defaults, round-trip through _readForm,
 * and sit in their own labelled section.
 */

import { loadHtml, makeMockContainer } from '../../helpers/viz-utils.js';
import { RealPropertyEditor } from '../../../src/visualization/assets/real-property-editor.js';

const RUNNING = ['annualRunningCost', 'runningCostValuePct', 'runningCostGrowth'];
const REPAIR  = ['repairModel', 'repairProb', 'repairLambda', 'repairMedian', 'repairValuePct', 'repairSigma', 'capitalizeRepairs'];

function render(node) {
  const editor = new RealPropertyEditor({ container: makeMockContainer(), node, people: [], accounts: [] });
  editor.render();
  return editor;
}

describe('real-property editor — running cost & repair fields', () => {
  beforeEach(() => loadHtml('../../index.html'));

  test('all ten fields exist in the template', () => {
    const el = render({ id: 'p1', name: 'US House' })._rootEl;
    for (const id of [...RUNNING, ...REPAIR]) {
      expect(el.querySelector(`[data-id="${id}"]`)).not.toBeNull();
    }
  });

  test('inert defaults on a fresh node (0s, repairModel NONE, σ 0.6)', () => {
    const el = render({ id: 'p1', name: 'US House' })._rootEl;
    expect(el.querySelector('[data-id="annualRunningCost"]').value).toBe('0');
    expect(el.querySelector('[data-id="repairModel"]').value).toBe('NONE');
    expect(el.querySelector('[data-id="repairSigma"]').value).toBe('0.6');
    expect(el.querySelector('[data-id="capitalizeRepairs"]').value).toBe('0');
  });

  test('populates from the node and round-trips through _readForm', () => {
    const node = {
      id: 'p1', name: 'US House',
      annualRunningCost: 18000, runningCostValuePct: 0.005, runningCostGrowth: 0.01,
      repairModel: 'BERNOULLI', repairProb: 0.25, repairLambda: 0, repairMedian: 15000,
      repairValuePct: 0.02, repairSigma: 0.7, capitalizeRepairs: 0.3,
    };
    const editor = render(node);
    // Rendered values reflect the node.
    expect(editor._rootEl.querySelector('[data-id="annualRunningCost"]').value).toBe('18000');
    expect(editor._rootEl.querySelector('[data-id="repairModel"]').value).toBe('BERNOULLI');
    // _readForm reads them back with correct types (numbers vs the enum string).
    const data = editor._readForm(editor._rootEl);
    expect(data.annualRunningCost).toBe(18000);
    expect(data.runningCostValuePct).toBe(0.005);
    expect(data.repairModel).toBe('BERNOULLI');
    expect(data.repairProb).toBe(0.25);
    expect(data.repairMedian).toBe(15000);
    expect(data.repairSigma).toBe(0.7);
    expect(data.capitalizeRepairs).toBe(0.3);
    for (const k of [...RUNNING, ...REPAIR]) expect(k in data).toBe(true);
  });

  test('running-cost/repair fields sit in their own section, after the Rental Income section', () => {
    const el = render({ id: 'p1', name: 'US House' })._rootEl;
    const heads = [...el.querySelectorAll('.node-section-head')].map(h => h.textContent);
    expect(heads.some(t => /Rental Income/i.test(t))).toBe(true);
    expect(heads.some(t => /Running Costs? .* Repairs/i.test(t))).toBe(true);
    // The repair section header precedes the repair inputs, and the rental header precedes it.
    const html = el.innerHTML;
    expect(html.indexOf('Rental Income')).toBeLessThan(html.indexOf('Running Costs'));
    expect(html.indexOf('Running Costs')).toBeLessThan(html.indexOf('data-id="repairModel"'));
  });
});
