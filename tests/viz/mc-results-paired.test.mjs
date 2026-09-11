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
 * mc-results-paired.test.mjs — design 100 §5.
 *
 * The paired A/B section of the MC results panel: a batch shown against a kept baseline.
 * These pin the header button's states, the rescue counts (reverse rescues first), the
 * paired money delta, and the guard — a mismatch shows a banner and NO paired numbers.
 *
 * Run with: npm run test:viz
 */

import { McResultsPanel } from '../../src/visualization/monte-carlo/mc-results-panel.js';

global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

function makePanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, panel: new McResultsPanel(container) };
}

const pairing = (over = {}) => ({
  n: 4, seeds: [1, 2, 3, 4], mcSequenceRisk: true, sampled: [{ key: 'usEquityGrowthRate', draws: 2 }], ...over,
});
const run = (seed, failed, afterTax) => ({
  seed, scenarioFailed: failed, finalNetWorthUsd: afterTax, afterTaxNetWorthUsd: afterTax, timeSeries: [],
});
const batch = (runs, pairingOver) => ({
  runs,
  summary: { successRate: runs.filter(r => !r.scenarioFailed).length / runs.length,
    p10: 1e5, p50: 5e5, p90: 1e6, pairing: pairing(pairingOver) },
});

// Baseline: seeds 1 and 2 fail. Treatment rescues 1, keeps 2 failed, and reverse-rescues 3.
const BASE  = batch([run(1, true, 0), run(2, true, 0), run(3, false, 400), run(4, false, 500)]);
const TREAT = batch([run(1, false, 100), run(2, true, 0), run(3, true, 300), run(4, false, 700)]);
const keep  = (result) => ({ result, keptAt: new Date(Date.UTC(2026, 8, 11, 14, 2)) });

const cards = (root) => Object.fromEntries([...root.querySelectorAll('.mc-badge-card')]
  .map(c => [c.querySelector('.mc-badge-label').textContent, c.querySelector('.mc-badge-value').textContent]));

describe('McResultsPanel — baseline button', () => {
  test('offers "Keep as baseline" with no baseline, and fires the callback', () => {
    const { panel, container } = makePanel();
    let kept = 0;
    panel.onKeepBaseline = () => { kept++; };
    panel.showResults(BASE.summary, BASE.runs);
    const btn = container.querySelector('.mc-baseline-btn');
    expect(btn.textContent).toBe('Keep as baseline');
    btn.click();
    expect(kept).toBe(1);
    expect(container.querySelector('.mc-ab-section')).toBeNull();
    panel.destroy();
  });

  test('the baseline batch itself shows a pressed button and no comparison', () => {
    const { panel, container } = makePanel();
    let cleared = 0;
    panel.onClearBaseline = () => { cleared++; };
    panel.showResults(BASE.summary, BASE.runs, { baseline: keep(BASE) });
    const btn = container.querySelector('.mc-baseline-btn');
    expect(btn.textContent).toBe('Baseline ✕');
    expect(btn.classList.contains('mc-metric-btn--active')).toBe(true);
    btn.click();
    expect(cleared).toBe(1);
    expect(container.querySelector('.mc-ab-section')).toBeNull();
    panel.destroy();
  });
});

describe('McResultsPanel — paired comparison', () => {
  test('rescues lead with reverse rescues, then the paired after-tax delta', () => {
    const { panel, container } = makePanel();
    panel.showResults(TREAT.summary, TREAT.runs, { baseline: keep(BASE) });
    const section = container.querySelector('.mc-ab-section');
    expect(section).not.toBeNull();
    expect(section.querySelector('.mc-ab-banner')).toBeNull();
    expect(container.querySelector('.mc-baseline-btn').textContent).toBe('Replace baseline');

    const rescueLabels = [...section.querySelectorAll('.mc-ab-rescues .mc-badge-label')].map(l => l.textContent);
    expect(rescueLabels[0]).toBe('Reverse Rescues');
    const c = cards(section);
    expect(c['Reverse Rescues']).toBe('1');
    expect(c['Rescues']).toBe('1');
    expect(c['Fail in Both']).toBe('1');
    expect(c['Survive in Both']).toBe('1');
    expect(section.textContent).toContain('state-dependent harm');

    // Deltas: +100, 0, −100, +200 → 2 ahead, 1 behind, 1 tie.
    expect(c['Ahead (after-tax NW)']).toBe('2');
    expect(c['Behind (after-tax NW)']).toBe('1');
    panel.destroy();
  });

  test('side-by-side marks a lower failure rate as better', () => {
    const { panel, container } = makePanel();
    const better = batch([run(1, false, 1), run(2, false, 1), run(3, false, 1), run(4, true, 0)]);
    panel.showResults(better.summary, better.runs, { baseline: keep(BASE) });
    const row = [...container.querySelectorAll('.mc-ab-table tbody tr')]
      .find(tr => tr.children[0].textContent === 'Failure rate');
    expect([...row.children].map(td => td.textContent)).toEqual(['Failure rate', '50.0%', '25.0%', '−25.0 pp']);
    expect(row.children[3].className).toBe('mc-ab-change--better');
    panel.destroy();
  });

  test('a guard mismatch shows a banner naming it and no paired numbers', () => {
    const { panel, container } = makePanel();
    const drifted = batch(TREAT.runs, { sampled: [{ key: 'usEquityGrowthRate', draws: 0 }] });
    panel.showResults(drifted.summary, drifted.runs, { baseline: keep(BASE) });
    const section = container.querySelector('.mc-ab-section');
    expect(section.querySelector('.mc-ab-banner').textContent).toContain('usEquityGrowthRate takes 2');
    expect(section.querySelector('.mc-ab-rescues')).toBeNull();
    expect(section.querySelector('.mc-ab-delta')).toBeNull();
    // The unpaired side-by-side still renders.
    expect(section.querySelector('.mc-ab-table')).not.toBeNull();
    panel.destroy();
  });

  test('a baseline from before pairing was recorded is not assumed paired', () => {
    const { panel, container } = makePanel();
    const old = { runs: BASE.runs, summary: { ...BASE.summary, pairing: undefined } };
    panel.showResults(TREAT.summary, TREAT.runs, { baseline: keep(old) });
    expect(container.querySelector('.mc-ab-banner').textContent).toContain('no pairing record');
    panel.destroy();
  });
});
