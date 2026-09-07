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

// ─── the household reserve chip (design 97 §22.3, extended) ──────────────────

/** The same run, plus the household reserve — deliberately DISAGREEING with the pools. */
const RUN_WITH_RESERVE = [
  entry('2030-01-01', [
    { field: 'liquidityPools', before: null,
      after: { offset: CUBE({ balance: 380_000 }), growth: CUBE({ balance: 2_000_000, target: null }) } },
    { field: 'liquidityReserve', before: null,
      after: { accessible: 1_250_000, locked: 90_000, yearsOfCover: 5.2 } },
  ]),
];

const reserveChip = (plugin) =>
  [...q(plugin, 'legend').querySelectorAll('.pool-legend-item')]
    .find(c => /Household reserve/.test(c.textContent));

test('the legend carries the household reserve, and it is not keyed as a pool', () => {
  const { plugin } = mountPlugin(simOf(RUN_WITH_RESERVE));
  const legend = q(plugin, 'legend');
  assert.match(legend.textContent, /Household reserve/);
  assert.match(legend.textContent, /5\.2y/);
  // The locked half is shown beside it: an age-gated bond is not cover, and a reader who
  // cannot see it will read the accessible figure as the whole book.
  assert.match(legend.textContent, /locked/);
  // `data-reserve`, never `data-key`: the pool filter reads `data-key` and puts everything it
  // finds there into `_hidden` as a POOL ID. The chip is clickable without being a pool.
  const chip = reserveChip(plugin);
  assert.ok(chip, 'reserve chip missing');
  assert.equal(chip.dataset.key, undefined);
  assert.equal(chip.dataset.reserve, '1');
  plugin.unmount();
});

test('the reserve chip toggles its line off and on, without entering the pool filter', () => {
  // The workflow this exists for: hiding a large series so the axis rescales and the small
  // pools become readable. That is a chart affordance, not a claim that the reserve is a pool.
  const { plugin } = mountPlugin(simOf(RUN_WITH_RESERVE));
  assert.equal(plugin._reserveHidden, false);

  reserveChip(plugin).click();
  assert.equal(plugin._reserveHidden, true);
  assert.ok(reserveChip(plugin).classList.contains('pool-legend-item--off'),
    'hidden reads as hidden — the chip stays, struck through, so it can be brought back');
  // It must NOT have leaked into the pool filter: everything in `_hidden` is a pool id, and a
  // non-pool member would collide with a pool that happened to be named it.
  assert.equal(plugin._hidden.size, 0);
  assert.deepEqual(plugin._visiblePools(plugin._history()), plugin._history().poolIds);

  reserveChip(plugin).click();
  assert.equal(plugin._reserveHidden, false);
  assert.ok(!reserveChip(plugin).classList.contains('pool-legend-item--off'));
  plugin.unmount();
});

test('the reserve LINE leaves the chart when hidden, and is absent for a run without one', () => {
  const { plugin } = mountPlugin(simOf(RUN_WITH_RESERVE));
  const hist = plugin._history();
  const line = plugin._reserveCoverSeries(hist, '#000');
  assert.ok(line, 'drawn while visible');
  assert.deepEqual(line.data, [5.2]);
  assert.equal(line.lineStyle.type, 'dashed', 'never reads as one more pool');

  reserveChip(plugin).click();
  assert.equal(plugin._reserveCoverSeries(plugin._history(), '#000'), null, 'gone when hidden');
  plugin.unmount();

  // The other reason it can be absent, which must not be conflated with the first.
  const { plugin: p2 } = mountPlugin(simOf(RUN));
  assert.equal(p2._reserveCoverSeries(p2._history(), '#000'), null, 'and when never recorded');
  p2.unmount();
});

test('hiding the reserve hides only the reserve — the pool chips still filter pools', () => {
  const { plugin } = mountPlugin(simOf(RUN_WITH_RESERVE));
  reserveChip(plugin).click();
  const poolChip = [...q(plugin, 'legend').querySelectorAll('[data-key]')][0];
  poolChip.click();
  assert.equal(plugin._hidden.size, 1, 'the pool filter still works while the reserve is off');
  assert.equal(plugin._reserveHidden, true, 'and a pool click does not resurrect the reserve');
  plugin.unmount();
});

test('a run with no reserve recorded draws no reserve chip — silence, not a zero', () => {
  const { plugin } = mountPlugin(simOf(RUN));
  // A "$0 / 0.0y" chip would assert the household has no reserve, which is a claim this run
  // cannot make. Absent is the honest rendering.
  assert.doesNotMatch(q(plugin, 'legend').textContent, /Household reserve/);
  plugin.unmount();
});

test('the reserve reaches the cover chart as its own series, not as a pool', () => {
  const { plugin } = mountPlugin(simOf(RUN_WITH_RESERVE));
  const hist = plugin._history();
  assert.equal(hist.hasReserve, true);
  // It must not be in poolIds: everything keyed there is filterable, totalled and coloured
  // as a pool, and this is measured across accounts no pool claims.
  assert.ok(!hist.poolIds.includes('reserve'));
  assert.equal(hist.periods.at(-1).reserve.yearsOfCover, 5.2);
});

test('the provenance strip counts SOURCE vetoes and EDGE fill-caps APART', () => {
  // One total would hide the scope entirely: an author checking whether their `scope: EDGE`
  // is actually running has nothing else on the panel to look at.
  const { plugin } = mountPlugin(simOf([
    entry('2030-01-01', [
      { field: 'liquidityPools', before: null,
        after: { offset: CUBE(), growth: CUBE({ target: null }) } },
      { field: 'poolRefillPlan', before: null,
        after: { shortfall: {}, vetoed: ['growth'], capped: ['offset'], gated: [] } },
    ]),
  ]));
  const prov = q(plugin, 'provenance').textContent;
  assert.match(prov, /1 rebalance vetoes\s*\(source\)/);
  assert.match(prov, /1 fill caps \(edge\)/);
  plugin.unmount();
});

test('a run with no EDGE-scoped gate says nothing about fill caps', () => {
  // Absent, not "0 fill caps": a zero would read as a policy that ran and never bound.
  const { plugin } = mountPlugin(simOf(RUN));
  assert.doesNotMatch(q(plugin, 'provenance').textContent, /fill caps/);
  plugin.unmount();
});

test('switching views does not re-read the journal', () => {
  const { plugin } = mountPlugin(simOf(RUN));
  const first = plugin._history();
  plugin._view = 'flows';
  plugin._render();
  assert.equal(plugin._history(), first);
  plugin.unmount();
});

// ─── the clamped target (design 97 §23.2) ────────────────────────────────────
//
// A pool asking for more than the room left in the mix is silently given the room and goes
// on reporting the target it wanted, so the dashed target line can sit for decades at a
// level the plan never once held. `targetAfforded` is the level the book could afford; these
// pin that it reaches BOTH readers — the badge someone actually looks at, and the CSV.

/** `growth` asking for 2m against a book that afforded 900k; `offset` fitting comfortably. */
const RUN_CLAMPED = [
  entry('2030-01-01', [
    { field: 'liquidityPools', before: null,
      after: {
        offset: CUBE({ balance: 380_000, targetAfforded: null }),
        growth: CUBE({ balance: 900_000, target: 2_000_000, targetAfforded: 900_000 }),
      } },
  ]),
];

test('a clamped pool wears its shortfall as a share of the ASK, not a second dollar figure', () => {
  const { plugin } = mountPlugin(simOf(RUN_CLAMPED));
  const chips = [...q(plugin, 'legend').querySelectorAll('[data-key]')];
  const growth = chips.find(c => c.dataset.key === 'growth');
  const offset = chips.find(c => c.dataset.key === 'offset');

  // 900k afforded of a 2m ask.
  assert.match(growth.textContent, /45% of ask/,
    `expected the clamp badge on a clamped pool, got: ${growth.textContent}`);
  // A pool whose target FIT must stay clean — a badge on every pool is a badge nobody reads.
  assert.ok(!/of ask/.test(offset.textContent),
    `an unclamped pool wore a clamp badge: ${offset.textContent}`);
  // The tooltip carries the two dollar figures the badge deliberately leaves out, and says
  // what to do about it — the badge is the alarm, the title is the diagnosis.
  const title = growth.querySelector('.pool-clamped')?.getAttribute('title') ?? '';
  assert.match(title, /Reduce this pool's target/);
  plugin.unmount();
});

test('targetAfforded is on the CSV contract, beside the target it must be read against', () => {
  assert.ok(POOL_CSV_COLUMNS.includes('targetAfforded'), 'targetAfforded missing from the CSV');
  assert.equal(POOL_CSV_COLUMNS.indexOf('targetAfforded'), POOL_CSV_COLUMNS.indexOf('target') + 1,
    'targetAfforded must sit beside `target`: it is meaningless read alone');
});

test('an absent targetAfforded draws no line and no badge (old runs stay clean)', () => {
  // Every run saved before §23.2 has no such field. It must read as "the target fit", not as
  // a zero — a pool afforded nothing and a pool that was never clamped are opposite states.
  const { plugin } = mountPlugin(simOf(RUN));
  const legend = q(plugin, 'legend');
  assert.ok(!/of ask/.test(legend.textContent), 'a run with no clamp data showed a clamp badge');
  assert.equal(legend.querySelectorAll('.pool-clamped').length, 0);
  plugin.unmount();
});

// ─── cover: held vs asked, and the series picker (design 97 §23.4 / §23.6) ───

/** `growth` holds 2.0y against a 5.0y ask; `offset` holds 4.8y and was never given one. */
const RUN_COVER = [
  entry('2030-01-01', [
    { field: 'liquidityPools', before: null,
      after: {
        offset: CUBE({ yearsOfCover: 4.8, target: null, yearsOfCoverTarget: null }),
        growth: CUBE({ yearsOfCover: 2.0, target: 1_000_000, yearsOfCoverTarget: 5.0 }),
      } },
  ]),
];

const pickerRows = (plugin) =>
  [...q(plugin, 'picker-menu').querySelectorAll('input[data-series]')].map(i => i.dataset.series);

test('the cover view offers held AND asked, and only where a pool was actually asked', () => {
  const { plugin } = mountPlugin(simOf(RUN_COVER));
  const keys = pickerRows(plugin);
  assert.ok(keys.includes('growth::cover'),      'the held line must be offered');
  assert.ok(keys.includes('growth::coverAsked'), 'the asked line must be offered where a target exists');
  // A targetless pool takes the residual and was never asked for a number — which is not the
  // same as being asked for zero, and a flat zero line would assert that it was.
  assert.ok(keys.includes('offset::cover'));
  assert.ok(!keys.includes('offset::coverAsked'),
    'a pool with no target was offered an "asked" line it has no number for');
  plugin.unmount();
});

test('unticking one series hides that line and leaves its pool\'s others alone', () => {
  const { plugin } = mountPlugin(simOf(RUN_COVER));
  const box = q(plugin, 'picker-menu').querySelector('input[data-series="growth::coverAsked"]');
  box.checked = false;
  box.dispatchEvent(new window.Event('click', { bubbles: true }));

  assert.ok(plugin._hiddenSeries.has('growth::coverAsked'));
  // The whole point of the fine filter: the pool is still drawn, minus one line. A legend
  // chip could only have removed both.
  assert.ok(!plugin._hiddenSeries.has('growth::cover'), 'hiding one line hid its sibling too');
  assert.ok(!plugin._hidden.has('growth'), 'the fine filter must not switch the POOL off');
  plugin.unmount();
});

test('"only <role>" keeps that line on every pool and drops the rest — the axis chips cannot express', () => {
  const { plugin } = mountPlugin(simOf(RUN_COVER));
  const btn = q(plugin, 'picker-menu').querySelector('button[data-series-role="cover"]');
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));

  assert.ok(!plugin._hiddenSeries.has('growth::cover'));
  assert.ok(!plugin._hiddenSeries.has('offset::cover'));
  assert.ok(plugin._hiddenSeries.has('growth::coverAsked'), '"only held" left an asked line on');
  plugin.unmount();
});

test('the picker offers only VISIBLE pools, so the two filters compose one way', () => {
  const { plugin } = mountPlugin(simOf(RUN_COVER));
  plugin._hidden.add('offset');
  plugin._render();
  const keys = pickerRows(plugin);
  assert.ok(keys.every(k => !k.startsWith('offset::')),
    'a pool hidden from the legend still offered checkboxes that control nothing');
  assert.ok(keys.some(k => k.startsWith('growth::')));
  plugin.unmount();
});

test('the picker counts what is drawn, and vanishes on the log view (which draws no series)', () => {
  const { plugin } = mountPlugin(simOf(RUN_COVER));
  assert.match(q(plugin, 'picker-count').textContent, /^3\/3$/);

  plugin._hiddenSeries.add('growth::coverAsked');
  plugin._render();
  assert.match(q(plugin, 'picker-count').textContent, /^2\/3$/);

  plugin._view = 'log';
  plugin._render();
  assert.equal(q(plugin, 'picker').style.display, 'none', 'the picker survived into the log view');
  plugin.unmount();
});

test('yearsOfCoverTarget is on the CSV, beside the cover it must be read against', () => {
  assert.ok(POOL_CSV_COLUMNS.includes('yearsOfCoverTarget'));
  assert.equal(POOL_CSV_COLUMNS.indexOf('yearsOfCoverTarget'),
               POOL_CSV_COLUMNS.indexOf('yearsOfCover') + 1);
});

test('a run that was EVER clamped says so in the provenance strip, not just in the legend', () => {
  // The legend badge reads the LAST period, like the balance and the cover beside it. By the
  // end of a long run the taxable pools have drained and nothing is clamped any more — so a
  // reader arriving at a finished run sees no badge, having just missed a plan that spent
  // decades holding an allocation nobody authored. This is the run-level statement.
  const RUN_ONCE_CLAMPED = [
    entry('2030-01-01', [
      { field: 'liquidityPools', before: null,
        after: { offset: CUBE({ targetAfforded: null }),
                 growth: CUBE({ target: 2_000_000, targetAfforded: 900_000 }) } },
    ]),
    entry('2031-01-01', [
      // Clamp gone: the ask now fits. The badge disappears; the run-level note must not.
      { field: 'liquidityPools.growth.targetAfforded', before: 900_000, after: null },
    ]),
  ];
  const { plugin } = mountPlugin(simOf(RUN_ONCE_CLAMPED));
  const prov = q(plugin, 'provenance');
  // Normalised: the note is a template literal and wraps mid-phrase in the source.
  const text = prov.textContent.replace(/\s+/g, ' ');

  assert.ok(/asked for more than the book could afford/.test(text), `provenance was: ${text}`);
  assert.ok(/1\/2 periods/.test(text), 'the note must say HOW LONG, not just that it happened');
  // It must WRAP: the strip is `nowrap; overflow-x: auto`, so a note appended to a long line
  // is present in the DOM and off the right edge of a 10px scroller — the exact failure the
  // note exists to prevent, one level up.
  assert.ok(prov.classList.contains('pool-provenance--clamped'));
  // And the legend, reading the last period, correctly shows nothing.
  assert.ok(!/of ask/.test(q(plugin, 'legend').textContent));
  plugin.unmount();
});

test('an unclamped run leaves the provenance strip alone', () => {
  const { plugin } = mountPlugin(simOf(RUN));
  const prov = q(plugin, 'provenance');
  assert.ok(!/asked for more than the book/.test(prov.textContent));
  assert.ok(!prov.classList.contains('pool-provenance--clamped'),
    'an unclamped run made the strip wrap for nothing');
  plugin.unmount();
});
