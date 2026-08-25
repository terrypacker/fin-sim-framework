/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { HoldingsPlugin } from '../../src/visualization/workbench/plugins/finance/holdings-plugin.js';

// ─── HoldingsPlugin mix charts ────────────────────────────────────────────────
//
// A donut of market value beside diverging bars of unrealized G/L, both over the same
// allocation-class rollup. The pair only works if the two agree: same classes, same
// order, same hue. These tests pin that agreement — and the fact that the panel still
// renders its tables in an environment (jsdom) with no 2D canvas for ECharts to use.

const RUNTIME = { bus: { subscribe: () => () => {} } };

function makeAccount(stateKey, name, extra = {}) {
  return { stateKey, name, country: 'US', currency: { code: 'USD' }, ...extra };
}

function mountPlugin(accounts, state, services = {}) {
  const plugin = new HoldingsPlugin(RUNTIME);
  plugin.setServices({ accountService: { getAll: () => accounts }, ...services });
  plugin._sim = { state, currentDate: new Date('2050-06-01'), journal: { journal: [] } };
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return { plugin, container };
}

const holding = (allocation, marketValue, costBasis) => ({ allocation, marketValue, costBasis });

const MIXED = {
  usStockAccount: {
    balance: 1000,
    holdings: [
      holding('EQUITY', 600, 400),   // up   200
      holding('BOND',   300, 350),   // down  50
      holding('CASH',   100, 100),   // flat
    ],
  },
};

test('charts: the section appears once an account with holdings is picked', () => {
  const { plugin } = mountPlugin([makeAccount('usStockAccount', 'US Brokerage')], MIXED);

  const section = plugin.el.querySelector('[data-hld="chart-section"]');
  assert.ok(section, 'the chart section must exist in the panel markup');
  assert.notEqual(section.style.display, 'none', 'shown when the picked account holds');

  // Drain the account: the picker drops it, the panel goes empty, the charts go with it.
  MIXED.usStockAccount.holdings = [];
  plugin._render();
  assert.equal(section.style.display, 'none', 'hidden when there is nothing to chart');

  plugin.unmount();
});

test('charts: no 2D canvas (jsdom) degrades to tables, it does not throw', () => {
  // ECharts fails inside setOption rather than at init, so an unguarded chart would
  // take every DOM test of this panel down with it.
  const { plugin } = mountPlugin([makeAccount('usStockAccount', 'US Brokerage')], {
    usStockAccount: { balance: 1000, holdings: [holding('EQUITY', 600, 400)] },
  });

  assert.equal(plugin._canvasAvailable(), false, 'jsdom has no 2D canvas');
  assert.equal(plugin._chartFor('mix-chart'), null, 'no chart instance without a canvas');
  // The table below the charts still rendered.
  assert.ok(plugin.el.querySelector('[data-hld="snap-body"]').textContent.includes('EQUITY') ||
            plugin.el.querySelectorAll('[data-hld="snap-body"] tr').length > 0,
            'the snapshot table renders regardless');

  plugin.unmount();
});

test('charts: donut and bars agree on class, order and colour', () => {
  const { plugin } = mountPlugin([makeAccount('usStockAccount', 'US Brokerage')], {
    usStockAccount: {
      balance: 1000,
      holdings: [holding('EQUITY', 600, 400), holding('BOND', 300, 350), holding('CASH', 100, 100)],
    },
  });

  const rows   = [
    { allocation: 'EQUITY', marketValue: 600, costBasis: 400, unrealized:  200 },
    { allocation: 'BOND',   marketValue: 300, costBasis: 350, unrealized:  -50 },
    { allocation: 'CASH',   marketValue: 100, costBasis: 100, unrealized:    0 },
  ];
  const groups = [{ allocation: 'EQUITY', marketValue: 600, costBasis: 400, unrealized: 200, count: 1 },
                  { allocation: 'BOND',   marketValue: 300, costBasis: 350, unrealized: -50, count: 1 },
                  { allocation: 'CASH',   marketValue: 100, costBasis: 100, unrealized:   0, count: 1 }];
  const colors = new Map([['EQUITY', '#60a5fa'], ['BOND', '#34d399'], ['CASH', '#94a3b8']]);

  const mix = plugin._mixOption(groups, colors, true);
  const gl  = plugin._glOption(groups, colors, true);

  assert.deepEqual(mix.series[0].data.map(d => d.name), ['EQUITY', 'BOND', 'CASH'],
    'the donut follows the enum order');

  // ECharts draws a category axis bottom-up, so the bar chart's data is reversed to put
  // the donut's first wedge at the TOP of the bars. Reading it back must restore order.
  assert.deepEqual([...gl.yAxis.data].reverse(), ['EQUITY', 'BOND', 'CASH'],
    'the bars carry the same classes in the same visual order');

  for (const cls of ['EQUITY', 'BOND', 'CASH']) {
    const wedge = mix.series[0].data.find(d => d.name === cls);
    const bar   = gl.series[0].data[gl.yAxis.data.indexOf(cls)];
    assert.equal(wedge.itemStyle.color, bar.itemStyle.color,
      `${cls} must be the same hue in both charts — colour is how the two are linked`);
  }

  // Sign is carried by direction, not colour: a loss keeps the class hue and flips its
  // label to the left of zero.
  const bondBar = gl.series[0].data[gl.yAxis.data.indexOf('BOND')];
  assert.equal(bondBar.value, -50);
  assert.equal(bondBar.label.position, 'left', 'a negative bar labels on its outer (left) end');
  assert.equal(gl.series[0].data[gl.yAxis.data.indexOf('EQUITY')].label.position, 'right');

  // And the zero line is drawn, or a diverging chart has no axis of symmetry.
  assert.deepEqual(gl.series[0].markLine.data, [{ xAxis: 0 }]);

  void rows;
  plugin.unmount();
});

test('charts: the donut hole carries the account total in the display currency', () => {
  // The charts sit above a table whose footer states the same total. Formatting them
  // through different currency paths is a contradiction the reader cannot see.
  const converted = [];
  const { plugin } = mountPlugin(
    [makeAccount('auSuperAccount', 'AU Super', { country: 'AU', currency: { code: 'AUD' } })],
    { auSuperAccount: { balance: 0, holdings: [holding('EQUITY', 1_500_000, 1_000_000)] } },
    { schemaRegistry: {
        convertForDisplay: (v, code) => { converted.push(code); return { value: v * 2, symbol: 'A$' }; },
      } },
  );

  const groups = [{ allocation: 'EQUITY', marketValue: 1_500_000, costBasis: 1_000_000, unrealized: 500_000, count: 1 }];
  const mix = plugin._mixOption(groups, new Map([['EQUITY', '#60a5fa']]), true);

  assert.equal(mix.graphic.style.text, 'A$3.0M', 'the hole shows the converted total, compactly');
  assert.ok(converted.includes('AUD'), 'converted FROM the account currency, not a hardcoded USD');

  plugin.unmount();
});

test('charts: instances are disposed on unmount, not leaked per remount', () => {
  const { plugin, container } = mountPlugin([makeAccount('usStockAccount', 'US Brokerage')], {
    usStockAccount: { balance: 1000, holdings: [holding('EQUITY', 600, 400)] },
  });

  // Stand in for the canvas ECharts would hold in a real browser.
  const disposed = [];
  plugin._charts = new Map([['mix-chart', { dispose: () => disposed.push('mix'), resize: () => {} }],
                            ['gl-chart',  { dispose: () => disposed.push('gl'),  resize: () => {} }]]);
  const observed = { count: 0 };
  plugin._ros = [{ disconnect: () => { observed.count += 1; } }];

  plugin.unmount();

  assert.deepEqual(disposed.sort(), ['gl', 'mix'], 'both charts disposed');
  assert.equal(observed.count, 1, 'the ResizeObserver is disconnected too');
  assert.equal(plugin._charts, null);

  container.remove();
});
