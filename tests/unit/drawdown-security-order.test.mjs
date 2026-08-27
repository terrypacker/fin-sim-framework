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
 * drawdown-security-order.test.mjs — design 94 step 6, §10 item 3 / §8.3.
 *
 * Design 65 gave the liquidation primitive two axes: which ALLOCATION class to sell (Lever
 * A) and which LOT within it (Lever B). Step 6 adds the third, and it is the one Option C
 * makes expressible at all:
 *
 *     "raise cash out of the employer stock before touching the index fund"
 *
 * That is neither a class question — both are EQUITY — nor a lot question; it is a question
 * about which INSTRUMENT to sell. Under Option A every equity lot was the same
 * undifferentiated thing and the only way to say it was to arrange the account by hand.
 *
 * ── the shape of the lever, and why ──────────────────────────────────────────
 *
 * An ORDER, not a filter. A filter would fail a draw the named securities cannot cover; an
 * order exhausts them and carries on, which is the bargain `sleeveOrder` already strikes
 * for classes. It sits BELOW the class rank and ABOVE the lot strategy: the class says
 * which sleeve, the security says which instrument in it, the lot strategy says which units
 * of that instrument.
 *
 * ── why this file drives a whole scenario ────────────────────────────────────
 *
 * A comparator test would pass against a lever that never reaches the comparator. This repo
 * has shipped several of those (an unwired payload manifest gate, a state field nothing
 * read), so the last two tests here run a real plan, spend it into its brokerage, and read
 * which lot actually shrank.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { buildHoldingsComparator, resolveDrawdownSelection } from '../../src/finance/holdings/holdings-selection.js';
import { consumeHoldings } from '../../src/finance/holdings/holdings-fifo.js';
import { loadScenarioSim } from '../helpers/scenario-harness.js';
import { RATE_KEYS }       from '../../src/finance/economic-regimes/rate-keys.js';

const lot = (id, securityId, mv, extra = {}) => ({
  id, securityId, allocation: 'EQUITY', marketValue: mv, costBasis: mv * 0.5,
  units: mv / 100, pricePerUnit: 100, purchaseDate: new Date(Date.UTC(2020, 0, 1)),
  rateKey: RATE_KEYS.EQUITY_US, ...extra,
});

describe('the security tier — the comparator', () => {
  const sorted = (holdings, selection) =>
    [...holdings].sort(buildHoldingsComparator(selection)).map(h => h.id);

  const book = [
    lot('index-old', 'sec-vti', 10_000, { purchaseDate: new Date(Date.UTC(2015, 0, 1)) }),
    lot('emp',       'sec-emp', 10_000),
    lot('index-new', 'sec-vti', 10_000, { purchaseDate: new Date(Date.UTC(2022, 0, 1)) }),
  ];

  test('a named security sorts ahead of an unnamed one', () => {
    const sel = resolveDrawdownSelection({ securityOrder: ['sec-emp'] });
    assert.deepEqual(sorted(book, sel), ['emp', 'index-old', 'index-new']);
  });

  test('the ORDER is the order — two named securities sort by their position in it', () => {
    const sel = resolveDrawdownSelection({ securityOrder: ['sec-vti', 'sec-emp'] });
    assert.deepEqual(sorted(book, sel).slice(-1), ['emp']);
  });

  test('within one security the LOT strategy still decides', () => {
    // The tier is above the lot comparator, not instead of it: once both remaining lots are
    // `sec-vti`, FIFO picks the older. If the security rank replaced the lot rank rather
    // than preceding it, this order would be insertion order.
    const sel = resolveDrawdownSelection({ securityOrder: ['sec-vti'] });
    assert.deepEqual(sorted(book, sel), ['index-old', 'index-new', 'emp']);
  });

  test('an id naming nothing ranks with the unlisted rather than throwing', () => {
    // Ids are scenario data and the registry is projected later at load, so nothing can
    // validate them at the point they are set. Same degradation an absent class gets.
    const sel = resolveDrawdownSelection({ securityOrder: ['sec-does-not-exist'] });
    assert.deepEqual(sorted(book, sel), ['index-old', 'emp', 'index-new']);
  });

  test('an EMPTY order does not on its own make the policy non-null', () => {
    // The byte-identical guarantee: a scenario that names no security must resolve to the
    // historic `null` selection, not to a live policy that happens to sort the same way.
    assert.equal(resolveDrawdownSelection({ securityOrder: [] }), null);
    assert.equal(resolveDrawdownSelection({}), null);
    assert.ok(resolveDrawdownSelection({ securityOrder: ['sec-emp'] }) !== null);
  });

  test('the primitive consumes in that order', () => {
    // The comparator is only a sort; this is the seam it is a sort FOR.
    const sel = resolveDrawdownSelection({ securityOrder: ['sec-emp'] });
    const r    = consumeHoldings(book, 10_000, { selection: sel });
    const left = new Map(r.newHoldings.map(h => [h.id, h.marketValue]));
    assert.ok(!left.has('emp'), 'the named security should be the one fully consumed');
    assert.equal(left.get('index-old'), 10_000);
    assert.equal(left.get('index-new'), 10_000);
  });
});

/**
 * The half a comparator test cannot see: does the scenario param reach the primitive?
 *
 * Three arms of one plan, spending into the taxable brokerage until the equity sleeve is
 * partly consumed. The plan, the seed and the securities are identical; only the param
 * moves. Wiring this up is what exposed the gap recorded in design 94 §10.1 — the whole
 * design-65 drawdown family was unreachable from `buildDefaultConfig`, so a headless caller
 * asking for HIFO got FIFO and no warning.
 */
describe('the security tier — end to end', () => {
  const END = Date.UTC(2034, 0, 1);

  const run = (securityOrder) => {
    const { sim } = loadScenarioSim({
      // Enough spending that cash and savings run out and the brokerage is sold into, but
      // not so much that the sleeve is emptied — a fully-drained account would compare two
      // zeroes and pass whatever the lever did.
      params: {
        monthlyExpenses: 13_000,
        ...(securityOrder ? { drawdownSecurityOrder: securityOrder } : {}),
      },
      simEnd: END,
      mutateCfg: (cfg) => {
        cfg.securities = [
          { id: 'sec-emp',  symbol: 'EMP',  rateKey: RATE_KEYS.EQUITY_US },
          { id: 'sec-exus', symbol: 'EXUS', rateKey: RATE_KEYS.EQUITY_INTL_EX_US },
        ];
        const acct = cfg.accounts.find(a => a.stateKey === 'usStockAccount');
        acct.holdings.find(h => h.id === 'h-us-equity').securityId   = 'sec-emp';
        acct.holdings.find(h => h.id === 'h-intl-equity').securityId = 'sec-exus';
      },
    });
    const { log, warn } = console;
    console.log = () => {}; console.warn = () => {};
    try { sim.stepTo(new Date(END)); } finally { console.log = log; console.warn = warn; }
    const held = (id) => sim.state.usStockAccount.holdings.find(h => h.id === id)?.marketValue ?? 0;
    return { emp: held('h-us-equity'), exus: held('h-intl-equity') };
  };

  const control = run(null);
  const exusFirst = run(['sec-exus']);
  const empFirst  = run(['sec-emp']);

  test('the plan really does sell equity, and does not empty the sleeve', () => {
    // The control that stops every assertion below being satisfied by two untouched books
    // or by two empty ones.
    assert.ok(control.emp > 0 && control.emp < 50_000,
      `the employer lot is \$${control.emp} — the sleeve was untouched or fully drained`);
    assert.ok(control.exus > 0);
  });

  test('naming the OTHER security reverses which lot is drawn down', () => {
    // The default order happens to reach `sec-emp` first, so the visible move is made by
    // naming `sec-exus`: it is consumed entirely, and the employer position is spared.
    assert.equal(exusFirst.exus, 0, 'the named security should be consumed first');
    assert.ok(exusFirst.emp > control.emp,
      `the unnamed lot should survive longer (\$${exusFirst.emp} vs \$${control.emp})`);
  });

  test('naming the security the default ALREADY sells first changes nothing', () => {
    // The control that makes the test above about the ORDER rather than about the mere
    // presence of a non-null selection policy. Switching from `null` to a live policy must
    // not perturb a run whose order it does not change — otherwise the lever would be
    // indistinguishable from noise.
    assert.deepEqual(empFirst, control);
  });
});
