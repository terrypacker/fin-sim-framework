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
 * paycheque-plugin.test.mjs — design 95 §17 phase 10, G4/G5/G6.
 *
 * What is worth pinning about this panel is not "does it draw":
 *
 * 1. **It follows the cursor** (§17.3 U3) — the payslip shown is the LATEST one in the
 *    journal until the user pins a month, which is the whole reason it is a panel and
 *    not a modal. A pinned selection must survive a step, and the follow button must
 *    put it back.
 * 2. **Employer money is never a deduction.** A match or an SG contribution shown as
 *    reducing take-home would misstate the paycheque in the one direction the whole
 *    `employerFunded` flag exists to prevent.
 * 3. **A clamp says so where the contributions are** (G5/D8), and a carry-forward
 *    reads as RELIEF rather than as a stoppage — the two shared a field once, and 363
 *    actions announced a concession as though something had been stopped.
 * 4. **An absent thing is stated, not blank.** A scenario with no AU super has no cap
 *    table, and that is an ordinary fact about the scenario, not a broken panel.
 */

import assert from 'node:assert/strict';
import { PaychequePlugin } from '../../src/visualization/workbench/plugins/finance/paycheque-plugin.js';

const RUNTIME = { bus: { subscribe: () => () => {} } };

let _seq = 0;
let _inst = 0;

function entry(dateIso, type, data, { dup = false } = {}) {
  if (!dup) _inst++;
  return { seq: ++_seq, date: new Date(dateIso), action: { type, instanceId: `i${_inst}`, data } };
}

const STATE = {
  people: {
    p1: { id: 'p1', name: 'Alice', wageCurrency: 'USD' },
    p2: { id: 'p2', name: 'Bob',   wageCurrency: 'AUD' },
  },
  usSavingsAccount: { stateKey: 'usSavingsAccount', name: 'US Checking' },
  usStockAccount:   { stateKey: 'usStockAccount',   name: 'US Brokerage' },
  k401Account:      { stateKey: 'k401Account',      name: 'Alice 401(k)', ownerId: 'p1' },
  superAccount:     { stateKey: 'superAccount',     name: 'Bob Super',    ownerId: 'p2' },
};

function simOf(entries, { state = STATE } = {}) {
  return { journal: { journal: entries }, state, bus: null };
}

function mountPlugin(sim) {
  const plugin = new PaychequePlugin(RUNTIME);
  plugin.setServices({
    schemaRegistry: {
      formatAmount: (n, code) => `${code === 'AUD' ? 'A$' : '$'}${Math.round(n)}`,
      // Design 70: runtime account state carries no `name`, so the label comes from
      // the registry. Without this the panel would print `usStockAccount` at a user.
      displayNameFor: (sk) => ({ usSavingsAccount: 'US Checking', usStockAccount: 'US Brokerage',
                                 k401Account: 'Alice 401(k)', superAccount: 'Bob Super' }[sk] ?? null),
    },
  });
  plugin._sim = sim;
  const container = document.createElement('div');
  document.body.appendChild(container);
  plugin.mount(container);
  return { plugin, container };
}

const q = (plugin, name) => plugin.el.querySelector(`[data-pay="${name}"]`);
const text = (plugin) => q(plugin, 'content').textContent;

function setView(plugin, view) {
  const sel = q(plugin, 'view');
  sel.value = view;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

// One US month with a deferral, a match and withholding; one AU month beside it.
const US_JAN = [
  entry('2030-01-01', 'WAGES_INCOME_APPLY', {
    amount: 10000, netAmount: 9235, personKey: 'p1', targetKey: 'usSavingsAccount',
    splits: [{ targetKey: 'usStockAccount', amount: 2000 },
             { targetKey: 'usSavingsAccount', amount: 7235 }],
  }),
  entry('2030-01-01', 'WAGES_WITHHELD_APPLY', { amount: 765, personKey: 'p1', alreadyNetted: true }),
  entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', { amount: 1000, stateKey: 'k401Account', personKey: 'p1' }),
  entry('2030-01-01', 'K401_CONTRIBUTION_APPLY', { amount: 400, stateKey: 'k401Account', personKey: 'p1', employerFunded: true }),
];

const US_FEB = [
  entry('2030-02-01', 'WAGES_INCOME_APPLY', { amount: 10000, personKey: 'p1', targetKey: 'usSavingsAccount' }),
  entry('2030-02-01', 'K401_CONTRIBUTION_APPLY', {
    amount: 250, stateKey: 'k401Account', personKey: 'p1',
    clamps: ['§402(g) elective deferral limit'],
  }),
];

// ─── empty states ─────────────────────────────────────────────────────────────

test('with no sim it says THAT, not "step the simulation"', () => {
  const { plugin } = mountPlugin(null);
  assert.match(q(plugin, 'placeholder').textContent, /No simulation is loaded/);
  plugin.unmount();
});

test('with no wages yet it asks for a step rather than showing an empty payslip', () => {
  const { plugin } = mountPlugin(simOf([]));
  assert.equal(q(plugin, 'placeholder').style.display, '');
  assert.match(q(plugin, 'placeholder').textContent, /No wages have been paid/);
  plugin.unmount();
});

test('a scenario with no AU super states the absence rather than showing a blank table', () => {
  const { plugin } = mountPlugin(simOf(US_JAN));
  setView(plugin, 'caps');
  assert.equal(q(plugin, 'placeholder').style.display, '');
  assert.match(q(plugin, 'placeholder').textContent, /no Australian superannuation/);
  plugin.unmount();
});

// ─── the payslip (G4) ─────────────────────────────────────────────────────────

test('the payslip shows the four stages, package first and take-home last', () => {
  const { plugin } = mountPlugin(simOf(US_JAN));
  const t = text(plugin);
  assert.match(t, /Salary package/);
  assert.match(t, /Withheld \(FICA\)/);
  assert.match(t, /Net pay credited/);
  assert.match(t, /Take-home after payroll/);
  // 10,000 gross − 765 withheld − 1,000 deferral = 8,235.
  assert.match(t, /\$8235/);
  plugin.unmount();
});

test('employer money is listed apart and never subtracted from the pay', () => {
  const { plugin } = mountPlugin(simOf(US_JAN));
  const t = text(plugin);
  assert.match(t, /Employer contributions/);
  assert.match(t, /401\(k\) Match/);
  // The match is 400; take-home must still be 8,235, not 7,835.
  assert.match(t, /\$8235/);
  assert.doesNotMatch(t, /less 401\(k\) Match/);
  plugin.unmount();
});

test('the splits say where the net landed, by account name', () => {
  const { plugin } = mountPlugin(simOf(US_JAN));
  const t = text(plugin);
  assert.match(t, /Where the pay landed/);
  assert.match(t, /US Brokerage/);
  assert.match(t, /US Checking/);
  plugin.unmount();
});

test('with no direct deposit it names the transaction account rather than showing nothing', () => {
  const { plugin } = mountPlugin(simOf(US_FEB));
  const t = text(plugin);
  assert.match(t, /Where the pay landed/);
  assert.match(t, /US Checking/);
  plugin.unmount();
});

test('a clamp is named on the line it stopped', () => {
  const { plugin } = mountPlugin(simOf(US_FEB));
  const t = text(plugin);
  assert.match(t, /§402\(g\) elective deferral limit/);
  plugin.unmount();
});

test('a carry-forward reads as relief, not as a clamp', () => {
  const { plugin } = mountPlugin(simOf([
    entry('2030-01-01', 'AU_WAGES_INCOME_APPLY', { amount: 12000, sacrificed: 1000, personKey: 'p2' }),
    entry('2030-01-01', 'SUPER_SACRIFICE_APPLY', {
      amount: 1000, stateKey: 'superAccount', personKey: 'p2', carriedForward: 25000,
    }),
  ]));
  const content = q(plugin, 'content');
  assert.match(content.textContent, /carry-forward/);
  assert.match(content.textContent, /unused concessional cap released/);
  // The badge class is what keeps relief from reading as a stoppage.
  assert.ok(content.querySelector('.pay-badge-relief'));
  assert.equal(content.querySelectorAll('.pay-badge-clamp').length, 0);
  plugin.unmount();
});

test('the salary sacrifice comes off the package, above the assessable wage', () => {
  const { plugin } = mountPlugin(simOf([
    entry('2030-01-01', 'AU_WAGES_INCOME_APPLY', { amount: 11000, sacrificed: 1000, personKey: 'p2' }),
  ]));
  const t = text(plugin);
  assert.match(t, /Salary sacrifice/);
  assert.match(t, /Assessable wage/);
  // Package is 12,000 — `amount` is already net of the sacrifice.
  assert.match(t, /A\$12000/);
  plugin.unmount();
});

// ─── following the cursor (U3) ────────────────────────────────────────────────

test('it follows the run: the latest month is shown, and a step advances it', () => {
  const { plugin } = mountPlugin(simOf(US_JAN));
  assert.match(q(plugin, 'asof').textContent, /Alice · 2030-01/);

  // The run steps: another month lands in the journal.
  plugin._sim.journal.journal.push(...US_FEB);
  plugin._render();
  assert.match(q(plugin, 'asof').textContent, /Alice · 2030-02/);
  plugin.unmount();
});

test('pinning a month stops it following, and the follow button puts it back', () => {
  const { plugin } = mountPlugin(simOf([...US_JAN, ...US_FEB]));
  assert.match(q(plugin, 'asof').textContent, /2030-02/);

  const month = q(plugin, 'month');
  month.value = '2030-01';
  month.dispatchEvent(new Event('change', { bubbles: true }));
  assert.match(q(plugin, 'asof').textContent, /2030-01/);

  // A further step must NOT drag the pinned payslip forward.
  plugin._sim.journal.journal.push(
    entry('2030-03-01', 'WAGES_INCOME_APPLY', { amount: 10000, personKey: 'p1' }));
  plugin._render();
  assert.match(q(plugin, 'asof').textContent, /2030-01/);

  q(plugin, 'follow').dispatchEvent(new Event('click', { bubbles: true }));
  assert.match(q(plugin, 'asof').textContent, /2030-03/);
  plugin.unmount();
});

test('switching earners shows that earner, not the other one\'s payslip', () => {
  const { plugin } = mountPlugin(simOf([
    ...US_JAN,
    entry('2030-01-01', 'AU_WAGES_INCOME_APPLY', { amount: 8000, personKey: 'p2' }),
  ]));
  const person = q(plugin, 'person');
  person.value = 'p2';
  person.dispatchEvent(new Event('change', { bubbles: true }));
  assert.match(q(plugin, 'asof').textContent, /Bob/);
  assert.match(text(plugin), /A\$8000/);
  plugin.unmount();
});

// ─── contributions by year (G5) ───────────────────────────────────────────────

test('the contributions table carries the clamp as a column of its own', () => {
  const { plugin } = mountPlugin(simOf([...US_JAN, ...US_FEB]));
  setView(plugin, 'contributions');
  const content = q(plugin, 'content');
  assert.match(content.textContent, /Clamped by/);
  assert.match(content.textContent, /§402\(g\) elective deferral limit/);
  // Member and employer money are separate rows — they differ in who paid.
  assert.match(content.textContent, /401\(k\) Deferral/);
  assert.match(content.textContent, /401\(k\) Match/);
  plugin.unmount();
});

test('the person and month pickers belong to the payslip only', () => {
  const { plugin } = mountPlugin(simOf(US_JAN));
  assert.equal(q(plugin, 'person').style.display, '');
  setView(plugin, 'contributions');
  assert.equal(q(plugin, 'person').style.display, 'none');
  assert.equal(q(plugin, 'month').style.display, 'none');
  // The CSV is the contribution rollup, so it appears with it.
  assert.equal(q(plugin, 'csv').style.display, '');
  plugin.unmount();
});

test('a run with no contributions at all says how to get some', () => {
  const { plugin } = mountPlugin(simOf([
    entry('2030-01-01', 'WAGES_INCOME_APPLY', { amount: 10000, personKey: 'p1' }),
  ]));
  setView(plugin, 'contributions');
  assert.match(q(plugin, 'placeholder').textContent, /contribution election/);
  plugin.unmount();
});

// ─── the super cap table (G6) ─────────────────────────────────────────────────

test('the cap table shows the ring oldest first, with the TSB that gates it', () => {
  const { plugin } = mountPlugin(simOf(
    [entry('2030-01-01', 'AU_WAGES_INCOME_APPLY', { amount: 12000, personKey: 'p2' })],
    { state: {
        ...STATE,
        auSuperCapsByPerson: {
          p2: {
            concessionalYTD: 12000, sgYTD: 9000, nonConcessionalYTD: 0,
            qualifyingEarningsYTD: 150000, tsbAtFyStart: 480000,
            unusedByFy: { 2028: 5000, 2026: 7000 },
            bringForward: null,
          },
        },
      } },
  ));
  setView(plugin, 'caps');
  const t = q(plugin, 'content').textContent;
  assert.match(t, /Bob/);
  assert.match(t, /Total super balance at FY start/);
  assert.match(t, /A\$480000/);
  assert.match(t, /2026–27/);
  assert.match(t, /2028–29/);
  assert.ok(t.indexOf('2026–27') < t.indexOf('2028–29'), 'the ring reads oldest first');
  plugin.unmount();
});
