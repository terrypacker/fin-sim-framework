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

// ─── HoldingsPlugin account-picker refresh (design 63 §14 regression) ───────────
//
// The holdings account <select> is filtered on "holds lots now, OR has held them at
// some point in this run". That set is not static — an inherited (bequest-promoted)
// account seeds at 0 with no holdings and only gains them when the INHERIT event funds
// it mid-run. The picker used to be rebuilt only at bind/mount time, so it froze at its
// bind-time membership and a mid-sim-funded inherited account never appeared. The fix
// rebuilds the picker whenever the holding-account membership changes on a render.
//
// The `everHeld` half of the gate is what keeps the two empty-holdings cases apart: an
// inherited account BEFORE funding is not yet anything to look at, while a fully
// drawn-down account is exactly the one whose Activity ledger is worth reading (that
// ledger comes from the journal, so it outlives the last lot). Gating on current length
// alone dropped the drawn-down account out of the picker entirely.

const RUNTIME = { bus: { subscribe: () => () => {} } };

function makeAccount(stateKey, name, extra = {}) {
  return { stateKey, name, country: 'US', currency: { code: 'USD' }, ...extra };
}

function mountPlugin(accounts, state) {
  const plugin = new HoldingsPlugin(RUNTIME);
  plugin.setServices({ accountService: { getAll: () => accounts } });
  // Pre-set the sim so onMount doesn't try to bind via the (absent) sim registry.
  plugin._sim = { state, currentDate: new Date('2050-06-01'), journal: { journal: [] } };
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return { plugin, container };
}

const pickerKeys = (plugin) =>
  [...plugin.el.querySelectorAll('select.hld-account option')].map(o => o.value);

test('HoldingsPlugin picker: an account funded mid-run appears on the next render', () => {
  const ordinary  = makeAccount('usStockAccount', 'US Brokerage');
  const inherited  = makeAccount('beq1_a1Account', 'Mo Brokerage', { inherited: true });

  // Pre-inheritance: the heir's own account holds; the inherited one is seeded empty.
  const state = {
    usStockAccount:  { balance: 1000, holdings: [{ marketValue: 1000, costBasis: 800 }] },
    beq1_a1Account:  { balance: 0,    holdings: [] },
  };

  const { plugin } = mountPlugin([ordinary, inherited], state);

  // At bind time the inherited account is (correctly) absent — it has no holdings yet.
  assert.deepEqual(pickerKeys(plugin), ['usStockAccount'],
    'inherited account must be excluded before it is funded');

  // The INHERIT event fires mid-run: the inherited account gains its holdings.
  state.beq1_a1Account.balance  = 1_000_000;
  state.beq1_a1Account.holdings = [{ marketValue: 1_000_000, costBasis: 1_000_000 }];

  // A per-step re-render (the path the running sim drives) must pick up the change.
  plugin._render();

  assert.ok(pickerKeys(plugin).includes('beq1_a1Account'),
    'inherited account must appear in the picker once funded');

  plugin.unmount();
});

test('HoldingsPlugin picker: a fully drawn-down account STAYS in the picker', () => {
  const a = makeAccount('usStockAccount',    'US Brokerage');
  const b = makeAccount('sharedBrokerageAccount', 'Shared Brokerage');
  const state = {
    usStockAccount:        { balance: 1000, holdings: [{ marketValue: 1000, costBasis: 800 }] },
    sharedBrokerageAccount:{ balance: 500,  holdings: [{ marketValue: 500,  costBasis: 500 }] },
  };

  const { plugin } = mountPlugin([a, b], state);
  assert.deepEqual(pickerKeys(plugin).sort(), ['sharedBrokerageAccount', 'usStockAccount']);

  // Draw the shared account down to nothing. It has HELD lots in this run, so it remains
  // selectable — its journal-built Activity ledger is the whole reason to open it.
  state.sharedBrokerageAccount.balance  = 0;
  state.sharedBrokerageAccount.holdings = [];
  plugin._render();

  assert.deepEqual(pickerKeys(plugin).sort(), ['sharedBrokerageAccount', 'usStockAccount'],
    'a drawn-down account must stay in the picker');

  plugin.unmount();
});

test('HoldingsPlugin picker: selecting a drawn-down account renders the empty snapshot', () => {
  const a = makeAccount('usStockAccount', 'US Brokerage');
  const state = { usStockAccount: { balance: 1000, holdings: [{ marketValue: 1000, costBasis: 800 }] } };

  const { plugin } = mountPlugin([a], state);

  state.usStockAccount.balance  = 0;
  state.usStockAccount.holdings = [];
  plugin._render();

  // The placeholder must NOT take over — the account is still a valid selection.
  assert.equal(plugin.el.querySelector('[data-hld="placeholder"]').style.display, 'none');
  // The snapshot renders its empty row rather than a stale one, and the chart section
  // (which cannot draw a zero-slice donut) hides itself.
  assert.match(plugin.el.querySelector('[data-hld="snap-body"]').textContent, /No holdings/);
  assert.equal(plugin.el.querySelector('[data-hld="snap-foot"]').innerHTML.trim(), '');
  assert.equal(plugin.el.querySelector('[data-hld="chart-section"]').style.display, 'none');

  plugin.unmount();
});

test('HoldingsPlugin picker: a new sim resets the ever-held set', () => {
  const a = makeAccount('usStockAccount', 'US Brokerage');
  const b = makeAccount('sharedBrokerageAccount', 'Shared Brokerage');
  const state = {
    usStockAccount:        { balance: 1000, holdings: [{ marketValue: 1000, costBasis: 800 }] },
    sharedBrokerageAccount:{ balance: 500,  holdings: [{ marketValue: 500,  costBasis: 500 }] },
  };

  const { plugin } = mountPlugin([a, b], state);
  assert.deepEqual(pickerKeys(plugin).sort(), ['sharedBrokerageAccount', 'usStockAccount']);

  // Rebuild: a fresh sim whose shared account never holds anything. Carrying the previous
  // run's ever-held set over would list it as a permanently empty account.
  plugin._bindSim({
    state: {
      usStockAccount:        { balance: 1000, holdings: [{ marketValue: 1000, costBasis: 800 }] },
      sharedBrokerageAccount:{ balance: 0,    holdings: [] },
    },
    currentDate: new Date('2050-06-01'),
    journal: { journal: [] },
    bus: RUNTIME.bus,
  });

  assert.deepEqual(pickerKeys(plugin), ['usStockAccount'],
    'the ever-held set must not survive a rebuild');

  plugin.unmount();
});

test('HoldingsPlugin picker: an unchanged membership does not rebuild the <select>', () => {
  const a = makeAccount('usStockAccount', 'US Brokerage');
  const state = { usStockAccount: { balance: 1000, holdings: [{ marketValue: 1000, costBasis: 800 }] } };

  const { plugin } = mountPlugin([a], state);
  const selBefore = plugin.el.querySelector('select.hld-account');
  const optBefore = selBefore.firstElementChild;

  // Re-render with the SAME holding-account set (only a value moved).
  state.usStockAccount.holdings[0].marketValue = 1500;
  plugin._render();

  // The picker's option node is untouched when membership is unchanged (no churn /
  // no closing an open dropdown), even though the snapshot re-rendered.
  assert.equal(plugin.el.querySelector('select.hld-account').firstElementChild, optBefore,
    'the picker <option> should not be rebuilt when membership is unchanged');

  plugin.unmount();
});
