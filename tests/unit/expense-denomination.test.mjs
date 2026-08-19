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
 * expense-denomination.test.mjs — `monthlyExpensesCurrency` RESIDENCE mode.
 *
 * The household's cost of living is a price in the country it LIVES in. RESIDENCE mode
 * re-bases the authored figure into the residence currency ONCE at the scenario anchor
 * rate, so the AUD cost is fixed and the exchange rate moves the USD cost of FUNDING it.
 * The legacy USD/AUD modes pin the figure to one currency and convert at spot.
 *
 * EXD-1  Pre-move (US resident) RESIDENCE is a no-op — same debit as legacy USD.
 * EXD-2  At the anchor rate the two modes are IDENTICAL. This is the identity that
 *        explains why every golden fixture was unmoved by the default change: they all
 *        run FX-pinned, where spot == anchor.
 * EXD-3  Off the anchor they DIVERGE, and in the right direction: RESIDENCE holds the
 *        AUD debit fixed while legacy USD lets it float with spot. Without this, EXD-2
 *        passes for a mode that does nothing at all.
 * EXD-4  RESIDENCE's AUD debit is invariant across spot rates — the property the whole
 *        change exists to create.
 * EXD-5  Absent an FX anchor (single-currency scenario) RESIDENCE leaves the amount
 *        alone rather than guessing a rate.
 * EXD-6  Serialization round-trips both new fields; a restored handler must not silently
 *        revert to a different denomination.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { MonthlyExpensesHandler } from '../../src/finance/handlers/monthly-expenses-handler.js';

const ANCHOR = 1.55;

/** Minimal registry: both roles resolve to the one account key per country. */
const registry = {
  getStateKey: (role) => (role === 'AU_SAVINGS' ? 'auSav' : 'usSav'),
  resolveTransactionAccountKey: (cc) => (cc === 'AU' ? 'auSav' : 'usSav'),
};

function makeState({ residency, spot = ANCHOR, anchor = ANCHOR, monthlyExpenses = 9000 }) {
  return {
    monthlyExpenses,
    people: { p1: { residency } },
    usSav: { balance: 1e9, minimumBalance: 0, currency: { code: 'USD' } },
    auSav: { balance: 1e9, minimumBalance: 0, currency: { code: 'AUD' } },
    baseExchangeRates:      anchor == null ? undefined : { USD_AUD: anchor },
    effectiveExchangeRates: { USD_AUD: spot },
    inflationAccumulator:   { US: 1, AU: 1 },
  };
}

function debitFor(expensesCurrency, stateOpts) {
  const h = new MonthlyExpensesHandler({
    stateRegistry: registry,
    expensesCurrency,
    usRole: 'US_SAVINGS', auRole: 'AU_SAVINGS',
    primaryPersonKey: 'p1',
  });
  const actions = h.call({ data: null, state: makeState(stateOpts) });
  return actions.find((a) => a.type === 'EXPENSE_DEBIT').amount;
}

test('EXD-1 pre-move (US resident) RESIDENCE matches legacy USD', () => {
  const opts = { residency: 'US', spot: 1.90 };
  assert.equal(debitFor('RESIDENCE', opts), 9000);
  assert.equal(debitFor('USD', opts), 9000);
});

test('EXD-2 at the anchor rate RESIDENCE and legacy USD are identical', () => {
  const opts = { residency: 'AU', spot: ANCHOR, anchor: ANCHOR };
  const residence = debitFor('RESIDENCE', opts);
  const legacy    = debitFor('USD', opts);
  assert.equal(residence, 9000 * ANCHOR);
  assert.equal(residence, legacy);
});

test('EXD-3 off the anchor the two modes diverge, in the right direction', () => {
  // Spot well above the anchor: the AUD has weakened.
  const opts = { residency: 'AU', spot: 1.90, anchor: ANCHOR };
  const residence = debitFor('RESIDENCE', opts);
  const legacy    = debitFor('USD', opts);

  // RESIDENCE: the Australian basket still costs what it cost — anchor-based.
  assert.equal(residence, 9000 * ANCHOR);
  // Legacy USD: the same USD converted at spot, so the AUD spend jumps with the rate.
  assert.equal(legacy, 9000 * 1.90);
  assert.ok(legacy > residence, 'legacy USD must float with spot while RESIDENCE does not');
});

test('EXD-4 RESIDENCE holds the AUD cost fixed across spot rates', () => {
  const debits = [1.10, 1.55, 2.40].map(
    (spot) => debitFor('RESIDENCE', { residency: 'AU', spot, anchor: ANCHOR }),
  );
  assert.deepEqual(debits, [9000 * ANCHOR, 9000 * ANCHOR, 9000 * ANCHOR]);

  // Working detector: the same sweep under legacy USD must NOT be flat, or EXD-4 is
  // measuring a handler that ignores the rate entirely.
  const legacy = [1.10, 1.55, 2.40].map(
    (spot) => debitFor('USD', { residency: 'AU', spot, anchor: ANCHOR }),
  );
  assert.equal(new Set(legacy).size, 3, 'legacy USD should vary with spot');
});

test('EXD-5 with no FX anchor RESIDENCE leaves the amount alone', () => {
  // A single-currency scenario has no `baseExchangeRates`; re-basing must not invent one.
  const amount = debitFor('RESIDENCE', { residency: 'AU', spot: 1.90, anchor: null });
  assert.equal(amount, 9000);
});

test('EXD-6 denomination survives a serialization round trip', () => {
  const h = new MonthlyExpensesHandler({
    stateRegistry: registry, expensesCurrency: 'AUD', baseCurrency: 'AUD',
    usRole: 'US_SAVINGS', auRole: 'AU_SAVINGS',
  });
  const back = MonthlyExpensesHandler.fromJSON(h.toJSON(), { stateRegistry: registry });
  assert.equal(back.expensesCurrency, 'AUD');
  assert.equal(back.baseCurrency, 'AUD');

  // And the default a legacy snapshot (written before these fields existed) restores to.
  const legacy = MonthlyExpensesHandler.fromJSON({ monthlyExpenses: 1 }, { stateRegistry: registry });
  assert.equal(legacy.expensesCurrency, 'RESIDENCE');
  assert.equal(legacy.baseCurrency, 'USD');
});
