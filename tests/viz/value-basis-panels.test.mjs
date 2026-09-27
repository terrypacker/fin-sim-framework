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
 * value-basis-panels.test.mjs — design 79 P3: the dated panels restate each value at
 * ITS OWN date, all or nothing, and the statutory tables stay nominal.
 */

import assert from 'node:assert/strict';
import { StateSchemaRegistry, ParameterValueType } from '../../src/finance/services/state-schema-registry.js';
import { CurrencyConverter }      from '../../src/finance/fx/currency-converter.js';
import { AllocationPlugin }       from '../../src/visualization/workbench/plugins/finance/allocation-plugin.js';
import { LiquidityPoolsPlugin }   from '../../src/visualization/workbench/plugins/finance/liquidity-pools-plugin.js';
import { SpendingPlugin }         from '../../src/visualization/workbench/plugins/finance/spending-plugin.js';
import { PaychequePlugin }        from '../../src/visualization/workbench/plugins/finance/paycheque-plugin.js';
import { JournalReportPlugin }    from '../../src/visualization/workbench/plugins/finance/journal-report-plugin.js';
import { StatePanelView }         from '../../src/visualization/simulation/state-panel-view.js';
import { realFieldName }          from '../../src/finance/journal-reporting/report-currency.js';

const RUNTIME = { bus: { subscribe: () => () => {} } };
HTMLCanvasElement.prototype.getContext = () => null;

const Y = (y) => new Date(Date.UTC(y, 0, 1));

/**
 * A registry wired as the app wires it, with a dated source: US level 1 until 2030,
 * then 2; AU level 1 until 2030, then 4; USD→AUD 1.5 until 2030, then 1.2.
 */
function registry({ display = 'USD', basis = 'real', levels = true } = {}) {
  const reg = new StateSchemaRegistry();
  reg.currencyConverter = new CurrencyConverter();
  reg.displaySettings   = { displayCurrency: display, valueBasis: basis };
  reg.rateStateProvider = () => ({ effectiveExchangeRates: { USD_AUD: 9 }, inflationAccumulator: { US: 9, AU: 9 } });
  const late = (ts) => ts >= Y(2030).getTime();
  reg.priceLevelSource = {
    levelAt: (ts, cc) => (!levels ? null : late(ts) ? { US: 2, AU: 4 }[cc] : 1),
    stateAt: (ts) => ({ effectiveExchangeRates: { USD_AUD: late(ts) ? 1.2 : 1.5 } }),
  };
  return reg;
}

// ─── the registry's dated series ─────────────────────────────────────────────

test('restateSeries: each point at its own date — FX(t) and level(t), never the live 9', () => {
  const r = registry({ display: 'AUD' }).restateSeries([100, 100], [Y(2026), Y(2031)], 'USD');
  assert.equal(r.basis, 'real');
  assert.equal(r.code, 'AUD');
  assert.deepEqual(r.values, [150, 100 * 1.2 / 4]);
});

test('restateSeries: one point with no level ⇒ the whole series nominal', () => {
  const r = registry({ levels: false }).restateSeries([100, 200], [Y(2026), Y(2031)], 'USD');
  assert.deepEqual(r, { values: [100, 200], code: 'USD', basis: 'nominal' });
});

// ─── allocation ──────────────────────────────────────────────────────────────

function allocation(reg, mode = 'abs') {
  const plugin = new AllocationPlugin(RUNTIME);
  plugin.setServices({ schemaRegistry: reg });
  plugin._mode = mode;
  return plugin;
}

const BUILT = { dates: [Y(2026), Y(2031)], keys: ['EQ', 'BOND'],
                series: { EQ: [100, 400], BOND: [50, 200] }, totals: [150, 600] };

test('allocation $: every band and total restated at its sample date', () => {
  const { built, basis, money } = allocation(registry())._forDisplay(BUILT);
  assert.equal(basis, 'real');
  assert.deepEqual(built.series.EQ, [100, 200]);
  assert.deepEqual(built.totals, [150, 300]);
  assert.match(money(200), /^\$200\.00 real$/);
});

test('allocation share: the shares are left alone, only the money totals restate', () => {
  const shares = { ...BUILT, series: { EQ: [0.6, 0.6], BOND: [0.4, 0.4] } };
  const { built } = allocation(registry(), 'pct')._forDisplay(shares);
  assert.deepEqual(built.series.EQ, [0.6, 0.6]);
  assert.deepEqual(built.totals, [150, 300]);
});

test('allocation: nominal basis, or a series that cannot restate, draws exactly as built', () => {
  assert.equal(allocation(registry({ basis: 'nominal' }))._forDisplay(BUILT).built, BUILT);
  assert.equal(allocation(registry({ levels: false }))._forDisplay(BUILT).basis, 'nominal');
});

// ─── liquidity pools ─────────────────────────────────────────────────────────

test('pools: money fields restate per period; cover and returns do not', () => {
  const plugin = new LiquidityPoolsPlugin(RUNTIME);
  plugin.setServices({ schemaRegistry: registry() });
  const hist = {
    poolIds: ['cash'], labels: {},
    periods: [
      { at: Y(2026), pools: { cash: { balance: 100, yearsOfCover: 3, marketReturn: 0.05 } }, reserve: { accessible: 40, yearsOfCover: 2 } },
      { at: Y(2031), pools: { cash: { balance: 100, yearsOfCover: 3, marketReturn: 0.05 } }, reserve: { accessible: 40, yearsOfCover: 2 } },
    ],
    events: [{ at: Y(2031), amount: 10, wanted: null }],
  };
  plugin._history = () => hist;
  const shown = plugin._shownHistory();
  assert.deepEqual(shown.periods.map(p => p.pools.cash.balance), [100, 50]);
  assert.equal(shown.periods[1].pools.cash.yearsOfCover, 3);
  assert.equal(shown.periods[1].pools.cash.marketReturn, 0.05);
  assert.equal(shown.periods[1].reserve.accessible, 20);
  assert.equal(shown.events[0].amount, 5);
  assert.match(plugin._money(50), /real$/);
  assert.equal(hist.periods[1].pools.cash.balance, 100, 'the nominal history (the CSV\'s) is untouched');
});

// ─── spending (Q-B) ──────────────────────────────────────────────────────────

test('spending: a CHANGE of the app basis moves the panel; share is left alone', () => {
  let basis = 'real';
  const plugin = new SpendingPlugin(RUNTIME);
  plugin.setServices({ schemaRegistry: { valueBasis: () => basis } });
  plugin._lastBasis = 'real';

  plugin._followValueBasis();                      // no change → stays
  assert.equal(plugin._mode, 'real');
  basis = 'nominal'; plugin._followValueBasis();
  assert.equal(plugin._mode, 'nominal');
  plugin._mode = 'real';                           // the panel's own override…
  plugin._followValueBasis();                      // …survives until the next change
  assert.equal(plugin._mode, 'real');
  plugin._mode = 'share';
  basis = 'real'; plugin._followValueBasis();
  assert.equal(plugin._mode, 'share');
});

test('spending: a real AUD view folds its own AUD cube; everything else keeps USD', () => {
  const plugin = new SpendingPlugin(RUNTIME);
  let display = 'AUD';
  plugin.setServices({ schemaRegistry: { displayCurrencyCode: () => display } });
  plugin._mode = 'real';    assert.equal(plugin._cubeCurrency(), 'AUD');
  plugin._mode = 'nominal'; assert.equal(plugin._cubeCurrency(), 'USD');
  display = 'USD'; plugin._mode = 'real'; assert.equal(plugin._cubeCurrency(), 'USD');
});

// ─── paycheque ───────────────────────────────────────────────────────────────

test('paycheque: statutory tables say nominal only while the app is real', () => {
  const plugin = new PaychequePlugin(RUNTIME);
  plugin.setServices({ schemaRegistry: registry() });
  assert.match(plugin._nominalTag(), /nominal/);
  plugin.setServices({ schemaRegistry: registry({ basis: 'nominal' }) });
  assert.equal(plugin._nominalTag(), '');
});

// ─── journal report ──────────────────────────────────────────────────────────

test('journal report: a real fold asks for the display currency; drill rows read its real twin', () => {
  const plugin = new JournalReportPlugin(RUNTIME);
  plugin.setServices({ schemaRegistry: registry({ display: 'AUD' }) });
  plugin._facetValues = { cc: 'US' };
  assert.deepEqual(plugin._realFold(), { currency: 'AUD', defaultCurrency: 'USD' });

  plugin._basis = 'real'; plugin._currency = 'AUD';
  assert.equal(plugin._itemAmount({ amount: 100, [realFieldName('amount', 'AUD')]: 37.5 }), 37.5);
  plugin._basis = 'nominal';
  assert.equal(plugin._itemAmount({ amount: 100, [realFieldName('amount', 'AUD')]: 37.5 }), 100);
  plugin.setServices({ schemaRegistry: registry({ basis: 'nominal' }) });
  assert.equal(plugin._realFold(), null);
});

// ─── state panel ─────────────────────────────────────────────────────────────

test('state panel: history stats are taken over RESTATED points', () => {
  const panel = new StatePanelView();
  const reg = registry();
  reg.register('acct.balance', ParameterValueType.currency('USD'));
  panel.schemaRegistry = reg;
  // Nominal 100 → 150 reads as a +50 rise; real it is 100 → 75, a fall.
  const { values, fmt } = panel._restated('acct.balance', [100, 150], [Y(2026), Y(2031)]);
  assert.deepEqual(values, [100, 75]);
  assert.equal(fmt(-25), '-$25.00');
});
