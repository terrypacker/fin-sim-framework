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
 * liquidity-pools-plugin.test.mjs — design 97 §20.11.
 *
 * Four things are worth pinning about this panel, and none of them is "does it draw".
 *
 * 1. **The non-event is on the panel.** A refill that did not fire is the interesting event
 *    and the only one nothing else in the run records. It must reach the log with the gate's
 *    own reason beside it, and it must never be drawn as if money moved.
 * 2. **It distinguishes "no graph" from "flows off" from "nothing triggered".** All three are
 *    an empty flow log, and only one of them is a working plan. `poolFlowsEnabled: false` is
 *    the study control switch (§16.3), so it is stated rather than inferred.
 * 3. **It states its tie before it draws.** Every series is a journal RECONSTRUCTION; a
 *    drifted one draws a believable picture of a run that did not happen.
 * 4. **It reads the live reducer, not config.** A graph in the config that never reached a
 *    reducer is exactly the failure this panel exists to make visible.
 *
 * ECharts needs a canvas jsdom does not provide, so `_canvasAvailable()` reports none and
 * `_drawChart` no-ops. Everything else — provenance, legend, log, CSV columns — renders.
 */

import assert from 'node:assert/strict';
import { LiquidityPoolsPlugin, POOL_CSV_COLUMNS }
  from '../../src/visualization/workbench/plugins/finance/liquidity-pools-plugin.js';

const RUNTIME = { bus: { subscribe: () => () => {} } };

HTMLCanvasElement.prototype.getContext = () => null;

let _seq = 0;
const entry = (dateISO, stateDiff, action = { type: 'US_PERIOD_ADVANCE' }) =>
  ({ seq: _seq++, date: new Date(dateISO), action, stateDiff });

const CUBE = (over = {}) => ({
  balance: 400_000, capacity: 400_000, utilised: 400_000, target: 400_000, yearsOfCover: 5.5,
  high: 400_000, marketReturn: 0.05, marketReturnYear: 2030, priorYearReturn: 0.04,
  inflow: 0, outflow: 0, gatedFlows: [], lastFired: {}, ...over,
});

const GRAPH = {
  pools: [{ id: 'offset', label: 'The backstop' }, { id: 'growth', label: 'Bucket 3 — growth' }],
  flows: [{ id: 'g2o', from: 'growth', to: 'offset' }],
};

/** A reducer stub in the pipeline shape the panel walks. */
function pipelineWith(graph, flowsEnabled = true) {
  const reducer = { graph, flowsEnabled };
  Object.defineProperty(reducer, 'constructor', { value: { type: 'PoolFlowReducer' } });
  return { map: new Map([['US_PERIOD_ADVANCE', [{ reducer }]]]) };
}

function simOf(entries, { state = null, graph = GRAPH, flowsEnabled = true } = {}) {
  return {
    journal:  { journal: entries },
    state:    state ?? {},
    reducers: graph ? pipelineWith(graph, flowsEnabled) : { map: new Map() },
    bus: null,
  };
}

function mountPlugin(sim) {
  const plugin = new LiquidityPoolsPlugin(RUNTIME);
  plugin.setServices({ schemaRegistry: { formatAmount: (n) => `$${Math.round(n)}` } });
  plugin._sim = sim;
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return { plugin, container };
}

const q = (plugin, name) => plugin.el.querySelector(`[data-pool="${name}"]`);

const GATED = { id: 'g2o', from: 'growth', to: 'offset', reason: 'source growth is returning -48.5%', wanted: 30_696 };

/** Two good years, then two in which the gate shuts and the rebalancer is vetoed. */
const FIRED = { id: 'g2o', from: 'growth', to: 'offset', amount: 20_000, executor: 'TRANSFER' };
const RUN = [
  entry('2030-01-01', [
    { field: 'liquidityPools', before: null,
      after: { offset: CUBE({ balance: 380_000, inflow: 20_000, firedFlows: [FIRED] }),
               growth: CUBE({ balance: 2_000_000, target: null, outflow: 20_000, firedFlows: [FIRED] }) } },
  ]),
  entry('2030-01-01', [], { type: 'POOL_FLOW_APPLY',
    data: { flowId: 'g2o', from: 'growth', to: 'offset', amountBase: 20_000 } }),
  entry('2033-01-01', [
    { field: 'liquidityPools.offset.firedFlows', before: [FIRED], after: [] },
    { field: 'liquidityPools.growth.firedFlows', before: [FIRED], after: [] },
    { field: 'liquidityPools.offset.gatedFlows', before: [], after: [GATED] },
    { field: 'liquidityPools.growth.gatedFlows', before: [], after: [GATED] },
    { field: 'liquidityPools.offset.balance',    before: 380_000, after: 350_000, delta: -30_000 },
    { field: 'poolRefillPlan', before: null, after: { shortfall: {}, vetoed: ['growth'], gated: [GATED] } },
  ]),
];

// ─── empty states, which are three different states ──────────────────────────

test('with no sim at all it says THAT, not "step the simulation"', () => {
  const { plugin } = mountPlugin(null);
  assert.match(q(plugin, 'placeholder').textContent, /No simulation is loaded/);
  plugin.unmount();
});

test('no graph and a wired-but-unstepped graph are DIFFERENT empty states', () => {
  const noGraph = mountPlugin(simOf([], { graph: null }));
  assert.match(q(noGraph.plugin, 'placeholder').textContent, /authors no liquidity graph/);
  noGraph.plugin.unmount();

  const wired = mountPlugin(simOf([]));
  assert.match(q(wired.plugin, 'placeholder').textContent, /wired but has stamped no pool/);
  wired.plugin.unmount();
});

// ─── the non-event ───────────────────────────────────────────────────────────

test('a gated flow reaches the log with the gate\'s own reason, and moved nothing', () => {
  const { plugin } = mountPlugin(simOf(RUN));
  plugin._view = 'log';
  plugin._render();

  const grid = q(plugin, 'grid').textContent;
  assert.match(grid, /gated/);
  assert.match(grid, /source growth is returning -48\.5%/);
  // The amount column is a dash for a gated row: `wanted` is not `moved`, and a panel that
  // showed the two in one column would report money that never left.
  const gatedRow = [...q(plugin, 'grid').querySelectorAll('tr')]
    .find(tr => /gated/.test(tr.textContent));
  assert.equal(gatedRow.querySelectorAll('td')[4].textContent, '—');
  assert.match(gatedRow.querySelectorAll('td')[5].textContent, /30696/);
  plugin.unmount();
});

test('the rebalance veto is its own row — a gate that stops only the refill has changed nothing', () => {
  const { plugin } = mountPlugin(simOf(RUN));
  plugin._view = 'log';
  plugin._render();
  assert.match(q(plugin, 'grid').textContent, /rebalance sale of growth vetoed/);
  plugin.unmount();
});

test('the log can be narrowed to only what did not fire', () => {
  const { plugin } = mountPlugin(simOf(RUN));
  plugin._view = 'log';
  plugin._logFilter = 'gated';
  plugin._render();
  const rows = [...q(plugin, 'grid').querySelectorAll('tbody tr')];
  assert.ok(rows.length > 0);
  assert.ok(rows.every(tr => !/fired/.test(tr.textContent)));
  plugin.unmount();
});

test('a gated flow recorded on both endpoints is ONE row, not two', () => {
  const { plugin } = mountPlugin(simOf(RUN));
  plugin._view = 'log';
  plugin._render();
  const gated = [...q(plugin, 'grid').querySelectorAll('tbody tr')]
    .filter(tr => /source growth is returning/.test(tr.textContent));
  assert.equal(gated.length, 1);
  plugin.unmount();
});

// ─── provenance ──────────────────────────────────────────────────────────────

test('the strip counts what fired against what did not', () => {
  const { plugin } = mountPlugin(simOf(RUN));
  const prov = q(plugin, 'provenance');
  assert.doesNotMatch(prov.className, /--bad/);
  assert.match(prov.innerHTML, /1 fired/);
  assert.match(prov.innerHTML, /1 cross-account/);
  assert.match(prov.innerHTML, /1 gated/);
  assert.match(prov.innerHTML, /1 rebalance vetoes/);
  plugin.unmount();
});

test('flows switched OFF is stated, not left to be inferred from an empty log', () => {
  // §16.3's control arm looks exactly like a graph whose triggers never tripped.
  const { plugin } = mountPlugin(simOf(RUN, { flowsEnabled: false }));
  assert.match(q(plugin, 'provenance').innerHTML, /flows are OFF/);
  plugin.unmount();
});

test('an in-portfolio firing is on the log, marked as one the journal does not carry', () => {
  // §12.4: the rebalancer moves the value and emits no per-edge action, so before the cube
  // recorded it, a REBALANCE edge that fired every year it was allowed to read as "never
  // fired". It is a row now, and the row says which executor moved it.
  const f = { id: 'g2b', from: 'growth', to: 'offset', amount: 317_203, executor: 'REBALANCE' };
  const run = [entry('2039-01-01', [
    { field: 'liquidityPools', before: null,
      after: { growth: CUBE({ firedFlows: [f] }), offset: CUBE({ firedFlows: [f] }) } },
  ])];
  const { plugin } = mountPlugin(simOf(run));
  assert.match(q(plugin, 'provenance').innerHTML, /1 fired/);
  assert.match(q(plugin, 'provenance').innerHTML, /1 in-portfolio/);

  plugin._view = 'log';
  plugin._render();
  const row = [...q(plugin, 'grid').querySelectorAll('tbody tr')].find(tr => /fired/.test(tr.textContent));
  assert.match(row.textContent, /in-portfolio/);
  assert.match(row.textContent, /317203/);
  plugin.unmount();
});

test('a run predating the firing record says so instead of reporting a zero', () => {
  // The fallback path: FIRED rows come from POOL_FLOW_APPLY, which covers cross-account edges
  // only. A zero for an in-portfolio edge there is "not recorded", not "never fired".
  const old = [entry('2030-01-01', [
    { field: 'liquidityPools', before: null, after: { growth: CUBE(), offset: CUBE() } },
  ])];
  const graph = { pools: GRAPH.pools,
                  flows: [{ id: 'g2b', from: 'growth', to: 'offset', executor: 'REBALANCE' }] };
  const { plugin } = mountPlugin(simOf(old, { graph }));
  assert.match(q(plugin, 'provenance').innerHTML, /predates per-edge firing records/);
  plugin._view = 'log';
  plugin._render();
  assert.match(q(plugin, 'grid').textContent, /cannot appear here at all/);
  plugin.unmount();
});

test('a graph that never fired or gated anything is called out', () => {
  const quiet = [entry('2030-01-01', [
    { field: 'liquidityPools', before: null, after: { offset: CUBE(), growth: CUBE() } },
  ])];
  const { plugin } = mountPlugin(simOf(quiet));
  assert.match(q(plugin, 'provenance').innerHTML, /no edge ever fired or was gated/);
  plugin.unmount();
});

test('a replay that does not tie to live state STOPS the reader', () => {
  const state = { liquidityPools: { offset: CUBE({ balance: 999 }), growth: CUBE() } };
  const { plugin } = mountPlugin(simOf(RUN, { state }));
  const prov = q(plugin, 'provenance');
  assert.match(prov.className, /--bad/);
  assert.match(prov.innerHTML, /does not tie to the run/);
  assert.match(prov.innerHTML, /none of it is quotable/);
  plugin.unmount();
});

test('a replay that DOES tie says so, with the count it checked', () => {
  const state = { liquidityPools: {
    offset: CUBE({ balance: 350_000, inflow: 20_000, gatedFlows: [GATED] }),
    growth: CUBE({ balance: 2_000_000, target: null, outflow: 20_000, gatedFlows: [GATED] }),
  } };
  const { plugin } = mountPlugin(simOf(RUN, { state }));
  const prov = q(plugin, 'provenance');
  assert.doesNotMatch(prov.className, /--bad/);
  assert.match(prov.innerHTML, /replay ties across \d+ fields/);
  plugin.unmount();
});

// ─── legend as the pool filter ───────────────────────────────────────────────

test('the legend names pools by their authored label and doubles as the filter', () => {
  const { plugin } = mountPlugin(simOf(RUN));
  const legend = q(plugin, 'legend');
  assert.match(legend.textContent, /The backstop/);
  assert.match(legend.textContent, /Bucket 3 — growth/);

  legend.querySelector('[data-key="growth"]').click();
  assert.ok(plugin._hidden.has('growth'));
  assert.match(q(plugin, 'legend').querySelector('[data-key="growth"]').className, /--off/);
  plugin.unmount();
});

test('the pool order is the graph\'s, so the legend reads down the cascade', () => {
  const { plugin } = mountPlugin(simOf(RUN));
  const keys = [...q(plugin, 'legend').querySelectorAll('[data-key]')].map(e => e.dataset.key);
  assert.deepEqual(keys, ['offset', 'growth']);
  plugin.unmount();
});

// ─── the cube's contract ─────────────────────────────────────────────────────

test('the CSV columns are the fact table, headroom and the gate included', () => {
  // A column on the row and not here is a number nobody can trace back to its period.
  for (const c of ['date', 'pool', 'balance', 'capacity', 'utilised', 'target',
                   'yearsOfCover', 'headroom', 'shortfall', 'drawdown', 'gated', 'vetoed']) {
    assert.ok(POOL_CSV_COLUMNS.includes(c), `${c} missing from the CSV contract`);
  }
});

test('switching views does not re-read the journal', () => {
  const { plugin } = mountPlugin(simOf(RUN));
  const first = plugin._history();
  plugin._view = 'flows';
  plugin._render();
  assert.equal(plugin._history(), first);
  plugin.unmount();
});
