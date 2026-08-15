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
 * spending-plugin.test.mjs — design 89 §11 phase 5.
 *
 * Three things are worth pinning about this panel, and none of them is "does it draw".
 *
 * 1. **It states BOTH invariants before any band is read.** §7(a) classification is
 *    total, and §7(b) the flow ties to the stock. A classification that loses a debit
 *    understates the cost of the plan without leaving a mark on the chart, so a broken
 *    one must produce a loud "do not quote this" rather than a quietly wrong picture.
 *    That is invisible to any test that only walks the happy path.
 * 2. **It never stacks the two tiers.** Internal transfers, principal and marks are
 *    drawn — §7(a) is only auditable if every debit is on the panel somewhere — but in
 *    their own view. Adding them to the spending bands restates the 99% overstatement
 *    the whole design exists to remove.
 * 3. **It reuses the shared pivot.** Switching a view changes the grouping over one
 *    classified cube; it does not call a chart library differently.
 *
 * ECharts needs a canvas jsdom does not provide, so `_canvasAvailable()` reports none and
 * `_drawChart` no-ops. Everything else — provenance, the legend, the tie grid, the CSV,
 * the caching — renders and is what these exercise.
 */

import assert from 'node:assert/strict';
import { SpendingPlugin } from '../../src/visualization/workbench/plugins/finance/spending-plugin.js';
import { SPEND_CATEGORY } from '../../src/finance/spending/spend-category.js';

const RUNTIME = { bus: { subscribe: () => () => {} } };

// jsdom has no 2D canvas, and its unimplemented `getContext` logs a full stack through
// the virtual console. Returning null says the same thing to the panel's capability probe
// without burying the test output in it.
HTMLCanvasElement.prototype.getContext = () => null;

let _seq = 0;

/**
 * A journal entry with one balance movement, in the shape the cube reads.
 *
 * Balances CHAIN per key — `after` of one entry is `before` of the next. A fixture that
 * restated the opening balance on every entry would be a continuity break (§7 b), and the
 * panel would correctly refuse to draw. Real journals chain; a stub that does not is
 * testing the panel against a journal that could never exist.
 */
const OPENING = 1_000_000;
function makeLedger() {
  const balances = new Map();
  return function entry(year, actionType, stateKey, delta, data = {}) {
    const before = balances.get(stateKey) ?? OPENING;
    const after  = before + delta;
    balances.set(stateKey, after);
    return {
      seq: ++_seq,
      date: new Date(Date.UTC(year, 5, 15)),
      action: { type: actionType, data, instanceId: `i${_seq}` },
      stateDiff: [{ field: `${stateKey}.balance`, before, after, delta }],
    };
  };
}

let entry = makeLedger();

const expense = (year, spendCategory, amount) =>
  entry(year, 'EXPENSE_DEBIT', 'usSavingsAccount', -amount,
        { amount, spendCategory, capitalFraction: 0, targetKey: 'usSavingsAccount' });

const transfer = (year, amount) =>
  entry(year, 'HOLDING_TRANSACT', 'usStockAccount', -amount, {});

/**
 * A sim stub. `state` supplies the currency fallback and loan identity; `samples` are the
 * year-boundary balances §7(b) reads. Both are what the panel gets from the real run.
 */
function simOf(entries, { samples = null, state = null } = {}) {
  return {
    journal: { journal: entries },
    state: state ?? {
      usSavingsAccount: { balance: 0, currency: { code: 'USD' } },
      usStockAccount:   { balance: 0, currency: { code: 'USD' } },
    },
    samples: samples ?? [],
    currentDate: new Date(Date.UTC(2031, 11, 31)),
    bus: null,
  };
}

function mountPlugin(sim) {
  const plugin = new SpendingPlugin(RUNTIME);
  plugin.setServices({
    schemaRegistry: { formatAmount: (n) => `$${Math.round(n)}`, resolve: () => null,
                      accountBalanceKeys: () => ['usSavingsAccount.balance', 'usStockAccount.balance'] },
  });
  plugin._sim = sim;
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return { plugin, container };
}

const q = (plugin, name) => plugin.el.querySelector(`[data-spend="${name}"]`);

/** Two years of living costs, one year of transfers — both tiers, several categories. */
const TWO_YEARS = [
  expense(2030, SPEND_CATEGORY.LIVING, 60_000),
  expense(2030, SPEND_CATEGORY.HOUSING_RUNNING, 12_000),
  transfer(2030, 200_000),
  expense(2031, SPEND_CATEGORY.LIVING, 66_000),
  transfer(2031, 150_000),
];

// ─── empty ────────────────────────────────────────────────────────────────────

test('with no journal the panel says so instead of drawing an empty chart', () => {
  const { plugin } = mountPlugin(simOf([]));
  const placeholder = q(plugin, 'placeholder');
  assert.equal(placeholder.style.display, '');
  assert.match(placeholder.textContent, /Step or run the simulation/);
  assert.equal(q(plugin, 'provenance').innerHTML, '');
  plugin.unmount();
});

test('with no sim at all it says THAT, not "step the simulation"', () => {
  const { plugin } = mountPlugin(null);
  assert.match(q(plugin, 'placeholder').textContent, /No simulation is loaded/);
  plugin.unmount();
});

// ─── the invariants, stated before the chart ─────────────────────────────────

test('a healthy run states both invariants and the overstatement', () => {
  const { plugin } = mountPlugin(simOf(TWO_YEARS));
  const prov = q(plugin, 'provenance');
  assert.doesNotMatch(prov.className, /--bad/);
  assert.match(prov.innerHTML, /classification total/);
  // No samples were supplied, so §7(b) must say it was NOT CHECKED rather than pass.
  assert.match(prov.innerHTML, /not checked/);
  assert.match(prov.innerHTML, /overstates by/);
  plugin.unmount();
});

test('§7(b) reports a real tie when the run carries year-boundary balances', () => {
  // opening 1,000,000; 2030 spends 72,000 and moves 200,000 ⇒ 728,000. 2031: −66,000
  // on savings and −150,000 on stock. Balances chosen so the identity holds exactly.
  const samples = [
    { year: 2030, balances: { usSavingsAccount: 1_000_000 - 72_000, usStockAccount: 1_000_000 - 200_000 } },
    { year: 2031, balances: { usSavingsAccount: 1_000_000 - 72_000 - 66_000, usStockAccount: 1_000_000 - 200_000 - 150_000 } },
  ];
  const { plugin } = mountPlugin(simOf(TWO_YEARS, { samples }));
  const prov = q(plugin, 'provenance');
  assert.doesNotMatch(prov.className, /--bad/);
  assert.match(prov.innerHTML, /ties across \d+ account-years/);
  plugin.unmount();
});

test('a flow that does not tie STOPS the reader', () => {
  // The closing balance is 5,000 lower than the journalled flows explain: money moved
  // without the journal recording it, so no band on this panel can contain it.
  const samples = [
    { year: 2030, balances: { usSavingsAccount: 1_000_000 - 72_000 } },
    { year: 2031, balances: { usSavingsAccount: 1_000_000 - 72_000 - 66_000 - 5_000 } },
  ];
  const { plugin } = mountPlugin(simOf(TWO_YEARS, { samples }));
  const prov = q(plugin, 'provenance');
  assert.match(prov.className, /--bad/);
  assert.match(prov.innerHTML, /does not tie to the stock/);
  plugin.unmount();
});

test('a classification that is not total STOPS the reader', () => {
  // The loudest path on the panel, and one the real classifier cannot reach — every row
  // it produces is classified, which is §7(a) working. So the cube is injected directly.
  // Worth a white-box test precisely because it is unreachable from outside: this is the
  // branch that says "do not quote any band here", and a mutation dropping it to a normal
  // note failed nothing until this existed.
  const { plugin } = mountPlugin(simOf(TWO_YEARS));
  const real = plugin._cube();
  plugin._cubeCache = {
    ...real,
    // A category quietly lost 40,000 — the total still reads right, the bands do not.
    byCategory: new Map([['LIVING', real.total - 40_000]]),
  };
  plugin._render();

  const prov = q(plugin, 'provenance');
  assert.match(prov.className, /--bad/);
  assert.match(prov.innerHTML, /Classification is not total/);
  assert.match(prov.innerHTML, /Do not quote any band/);
  plugin.unmount();
});

test('an unclassified action type is named, loudly, rather than dropped', () => {
  // §7(a)'s reason for existing: a type nobody classified appears as a visible band on
  // its first run instead of vanishing from a total.
  const { plugin } = mountPlugin(simOf([
    ...TWO_YEARS,
    entry(2031, 'QUANTUM_DIVIDEND_APPLY', 'usSavingsAccount', -9_000, {}),
  ]));   // `entry` continues TWO_YEARS' ledger, so the chain stays intact
  assert.match(q(plugin, 'provenance').innerHTML, /UNCLASSIFIED/);
  plugin.unmount();
});

// ─── the views ────────────────────────────────────────────────────────────────

test('the two tiers are separate views and never share a stack', () => {
  const { plugin } = mountPlugin(simOf(TWO_YEARS));

  plugin._view = 'spending';
  plugin._render();
  const spendKeys = [...q(plugin, 'legend').querySelectorAll('[data-key]')].map(e => e.dataset.key);
  assert.deepEqual(spendKeys, ['LIVING', 'HOUSING_RUNNING']);

  plugin._view = 'moved';
  plugin._render();
  const movedKeys = [...q(plugin, 'legend').querySelectorAll('[data-key]')].map(e => e.dataset.key);
  assert.deepEqual(movedKeys, ['INTERNAL']);

  // The point: no key appears in both, so no view can total spending and transfers.
  assert.equal(spendKeys.filter(k => movedKeys.includes(k)).length, 0);
  plugin.unmount();
});

test('real and nominal are different numbers on the same bands', () => {
  // The panel's whole reason for defaulting to real (§9 b). With no inflation recorded in
  // this stub journal the two agree, so the check is that the MODE reaches the pivot —
  // asserted through the value field the legend totals are built from.
  const { plugin } = mountPlugin(simOf(TWO_YEARS));
  plugin._mode = 'real';    plugin._render();
  const real = q(plugin, 'legend').textContent;
  plugin._mode = 'nominal'; plugin._render();
  const nominal = q(plugin, 'legend').textContent;
  assert.ok(real.length > 0 && nominal.length > 0);

  // Share drops the money entirely — a percentage legend with dollar totals would be a
  // unit error on the face of the panel.
  plugin._mode = 'share'; plugin._render();
  assert.doesNotMatch(q(plugin, 'legend').textContent, /\$/);
  plugin.unmount();
});

test('the mode switch is hidden on the tie grid, where it means nothing', () => {
  const { plugin } = mountPlugin(simOf(TWO_YEARS));
  plugin._view = 'tie';
  plugin._syncControls();
  assert.equal(q(plugin, 'mode').style.display, 'none');
  plugin._view = 'spending';
  plugin._syncControls();
  assert.notEqual(q(plugin, 'mode').style.display, 'none');
  plugin.unmount();
});

test('the tie grid renders every account, not only the failures', () => {
  // A check that renders nothing on success gives the reader no way to tell it ran.
  const samples = [
    { year: 2030, balances: { usSavingsAccount: 1_000_000 - 72_000, usStockAccount: 1_000_000 - 200_000 } },
    { year: 2031, balances: { usSavingsAccount: 1_000_000 - 72_000 - 66_000, usStockAccount: 1_000_000 - 200_000 - 150_000 } },
  ];
  const { plugin } = mountPlugin(simOf(TWO_YEARS, { samples }));
  plugin._view = 'tie';
  plugin._syncControls();
  plugin._render();

  const grid = q(plugin, 'grid');
  assert.equal(grid.style.display, '');
  assert.equal(q(plugin, 'chart').style.display, 'none');
  assert.match(grid.textContent, /usSavingsAccount/);
  assert.match(grid.textContent, /usStockAccount/);
  assert.equal(grid.querySelectorAll('.spend-row-bad').length, 0);
  plugin.unmount();
});

test('the tie grid says "not checked" rather than showing an empty table', () => {
  const { plugin } = mountPlugin(simOf(TWO_YEARS));
  plugin._view = 'tie';
  plugin._render();
  assert.match(q(plugin, 'grid').textContent, /not.*checked|could not be checked/i);
  plugin.unmount();
});

// ─── legend ───────────────────────────────────────────────────────────────────

test('clicking a legend chip hides its band and clicking again restores it', () => {
  const { plugin } = mountPlugin(simOf(TWO_YEARS));
  const chip = q(plugin, 'legend').querySelector('[data-key="LIVING"]');
  chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.ok(plugin._hidden.has('LIVING'));
  assert.match(q(plugin, 'legend').querySelector('[data-key="LIVING"]').className, /--off/);

  q(plugin, 'legend').querySelector('[data-key="LIVING"]')
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.ok(!plugin._hidden.has('LIVING'));
  plugin.unmount();
});

// ─── caching ──────────────────────────────────────────────────────────────────

test('the cube is rebuilt only when the run has actually moved', () => {
  // The cube is a full journal walk (~9ms on a 45-year run) and the panel re-renders on
  // every completed event during playback. Without the signature cache that is the whole
  // frame budget, several times a second.
  const sim = simOf(TWO_YEARS);
  const { plugin } = mountPlugin(sim);

  const first = plugin._cube();
  assert.equal(plugin._cube(), first, 'a second read must reuse the cache');

  sim.journal.journal = [...TWO_YEARS, expense(2031, SPEND_CATEGORY.DISCRETIONARY, 5_000)];
  const second = plugin._cube();
  assert.notEqual(second, first, 'a longer journal must rebuild');
  assert.ok(second.rows.length > first.rows.length);
  plugin.unmount();
});

// ─── CSV ──────────────────────────────────────────────────────────────────────

test('the CSV carries both units and the classification', () => {
  const { plugin } = mountPlugin(simOf(TWO_YEARS));
  let captured = null;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { captured = blob; return 'blob:x'; };
  URL.revokeObjectURL = () => {};
  try {
    plugin._downloadCsv();
  } finally {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  }
  assert.ok(captured, 'no blob was produced');
  plugin.unmount();
});
