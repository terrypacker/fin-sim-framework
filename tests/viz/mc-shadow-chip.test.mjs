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
 * mc-shadow-chip.test.mjs — design 98 W5: the MC panel warns beside a role-level row
 * that per-account rates override, and says "no effect" when they override all of it.
 *
 * Run with: npm run test:viz
 */

import { McConfigPanel }      from '../../src/visualization/monte-carlo/mc-config-panel.js';
import { DISTRIBUTION_TYPES } from '../../src/simulation-framework/distributions.js';

const N = DISTRIBUTION_TYPES.NORMAL;

function chips(vars) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new McConfigPanel(container);
  panel.setVariables(vars);
  const out = Object.fromEntries([...container.querySelectorAll('.mc-var-row')].map((r, i) =>
    [vars[i].paramKey, r.querySelector('.mc-var-shadow')]));
  return { out, panel };
}

describe('McConfigPanel — shadowed role rows (design 98 W5)', () => {
  test('dead, partly shadowed and clean rows each render their own chip state', () => {
    const { out, panel } = chips([
      { paramKey: 'brokerageGrowthRate', label: 'Brokerage', group: 'G', type: N, mean: 0.05, stdDev: 0.03,
        enabled: true, shadowedBy: ['usStockAccount'], shadowedAll: true },
      { paramKey: 'rothGrowthRate', label: 'Roth', group: 'G', type: N, mean: 0.07, stdDev: 0.03,
        enabled: true, shadowedBy: ['rothAccount'], shadowedAll: false },
      { paramKey: 'superGrowthRate', label: 'Super', group: 'G', type: N, mean: 0.07, stdDev: 0.03,
        enabled: true },
    ]);
    expect(out.brokerageGrowthRate.hidden).toBe(false);
    expect(out.brokerageGrowthRate.textContent).toMatch(/no effect/);
    expect(out.brokerageGrowthRate.classList.contains('mc-var-shadow--dead')).toBe(true);
    expect(out.brokerageGrowthRate.title).toMatch(/usStockAccount/);
    expect(out.rothGrowthRate.textContent).toMatch(/1 pinned/);
    expect(out.rothGrowthRate.classList.contains('mc-var-shadow--dead')).toBe(false);
    expect(out.superGrowthRate.hidden).toBe(true);
    panel.destroy();
  });
});
