#!/usr/bin/env node
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
 * probe-tax-payment-tax-leak.mjs
 *
 * Quantifies the SECOND-ORDER TAX generated when a tax bill is paid by
 * liquidating assets — the tax on the sale that funds the tax.
 *
 * The mechanism. On the settle date the debit reducers
 * (`TaxPaymentDebitReducerBase` / `StateTaxPaymentDebitReducer`) size the cash
 * gap and call `AccountService.replenishSavings(shortfall)`. That draw sells
 * brokerage lots / distributes from an IRA-401k-super, and hands back the
 * resulting `pendingTaxActions` — `STOCK_WITHDRAWAL_TAX`, `K401_WITHDRAWAL_TAX`,
 * `IRA_WITHDRAWAL_*`, `SUPER_WITHDRAWAL_EARNINGS_TAX`, `COLLECTIBLE_SALE_TAX`.
 * Those actions are what feed the YTD accumulators the next settle reads.
 *
 * The bug this probe was written for: both debit reducers destructured only
 * `crossBorderTransfers` off that return, so every one of those tax actions was
 * dropped. Funding a tax bill from LOCAL assets was tax-free; funding the same
 * bill by escalating across the border (`IntlTransferApplyReducer`, which does
 * forward them) was not. Same economic event, two answers.
 *
 * Note what is NOT claimed here: there is no gross-up, before or after the fix.
 * `replenishSavings` draws exactly the cash gap (grossed up only for the FX fee
 * and the early-withdrawal penalty — both real cash costs). The gain it realizes
 * is booked to the FOLLOWING tax year, because `*TaxSettleApplyReducer`
 * (PRIORITY.TAX_APPLY) resets the YTD buckets before the debit runs at
 * TAX_APPLY + 1. That one-year deferral is the whole point: a same-year accrual
 * would be circular (more tax ⇒ bigger sale ⇒ more tax).
 *
 * Two parts:
 *
 *   PART 1 — unit. Drives the real `UsTaxPaymentDebitReducer.reduce()` on a
 *   hand-built state: $10k cash, a $200k tax bill, a brokerage holding a 60%
 *   embedded gain. Asserts the emitted action list contains the sale's tax.
 *   Deterministic, no scenario dependency.
 *
 *   PART 2 — full sim. Runs the real International Retirement scenario, wrapping
 *   the debit reducers to (a) record every tax action born inside a tax-payment
 *   draw and (b) optionally STRIP them, reproducing pre-fix behavior exactly.
 *   Reports unreported income/gain per year, then A/Bs lifetime tax + terminal
 *   net worth between the two modes.
 *
 * Usage:
 *   node scripts/probes/probe-tax-payment-tax-leak.mjs
 *   node scripts/probes/probe-tax-payment-tax-leak.mjs --scenario my-plan.json
 *   node scripts/probes/probe-tax-payment-tax-leak.mjs --stress   (part 2 on a
 *       cash-thin variant of the default cfg, so the path is guaranteed to fire)
 */

import { AccountService }  from '../../src/finance/services/account-service.js';
import { SavingsAccount, USD } from '../../src/finance/assets/account.js';
import { BrokerageAccount } from '../../src/finance/assets/investment-account.js';
import { ACCOUNT_ROLES }   from '../../src/finance/state/account-roles.js';
import { EventBus }        from '../../src/simulation-framework/event-bus.js';
import { Graph }           from '../../src/graph/graph.js';
import { GraphQueryApi }   from '../../src/graph/graph-query-api.js';
import {
  UsTaxPaymentDebitReducer,
  AuTaxPaymentDebitReducer,
} from '../../src/finance/tax/tax-settle-classes.js';
import { StateTaxPaymentDebitReducer } from '../../src/finance/tax/state/state-tax-settle-classes.js';
import { loadBaseConfig, parseSourceArgs } from '../lib/scenario-source.mjs';
import { openSim, quiet }  from '../lib/run.mjs';

const usd = n => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString();
const pct = n => (n * 100).toFixed(2) + '%';

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/** Taxable amount carried by a drawdown tax action, whatever its shape. */
const taxableOf = (a) => a.gain ?? a.amount ?? 0;

/** Action types a replenish draw can emit. Anything else is not a tax accrual. */
const DRAW_TAX_TYPES = new Set([
  'STOCK_WITHDRAWAL_TAX', 'COLLECTIBLE_SALE_TAX',
  'K401_WITHDRAWAL_TAX', 'IRA_WITHDRAWAL_CONTRIB_TAX', 'IRA_WITHDRAWAL_EARNINGS_TAX',
  'ROTH_WITHDRAWAL_EARNINGS_TAX', 'SUPER_WITHDRAWAL_EARNINGS_TAX',
]);

// ─── PART 1 — unit: one debit reducer, one liquidation ────────────────────────

function partOne() {
  console.log('\nPART 1 — UsTaxPaymentDebitReducer funding a bill from brokerage\n');

  const graph = new Graph();
  const accountService = new AccountService(graph, new GraphQueryApi(graph), new EventBus());
  const stateRegistry  = {
    getStateKey: (role) => (role === ACCOUNT_ROLES.US_SAVINGS ? 'usSavingsAccount' : null),
  };

  const CASH = 10_000, BILL = 200_000, MV = 500_000, BASIS = 200_000;

  const usSavingsAccount = new SavingsAccount(CASH, {
    country: 'US', currency: USD, ownerId: 'primary',
    role: ACCOUNT_ROLES.US_SAVINGS, stateKey: 'usSavingsAccount',
    minimumBalance: 0, drawdownPriority: 0,
  });
  const usStockAccount = new BrokerageAccount(MV, {
    country: 'US', currency: USD, ownerId: 'primary',
    role: ACCOUNT_ROLES.US_STOCK, stateKey: 'usStockAccount', drawdownPriority: 1,
    holdings: [{ id: 'h1', marketValue: MV, costBasis: BASIS, purchaseDate: Date.UTC(2010, 0, 1) }],
  });
  const state = {
    usSavingsAccount, usStockAccount,
    people: { primary: { birthDate: new Date(1956, 0, 1), residency: 'US' } },
  };

  const reducer = new UsTaxPaymentDebitReducer({ accountService, stateRegistry });
  const next = reducer.reduce(state, { type: 'US_TAX_PAYMENT_DEBIT', amount: BILL }, new Date(2030, 11, 31));
  const emitted = next.next ?? [];

  const sold        = MV - usStockAccount.balance;
  const gainRatio   = (MV - BASIS) / MV;
  const expectedGain = sold * gainRatio;
  const saleTax     = emitted.filter(a => DRAW_TAX_TYPES.has(a.type));
  const bookedGain  = saleTax.reduce((s, a) => s + taxableOf(a), 0);

  console.log(`  bill ${usd(BILL)} · cash on hand ${usd(CASH)} · shortfall ${usd(BILL - CASH)}`);
  console.log(`  brokerage sold ${usd(sold)} (embedded gain ${pct(gainRatio)}) ⇒ realized gain ${usd(expectedGain)}`);
  console.log(`  actions emitted: ${emitted.length ? emitted.map(a => a.type).join(', ') : '(none)'}`);
  console.log();

  check('the bill was paid in full',
    Math.abs(usSavingsAccount.balance) < 1,
    `cash left ${usd(usSavingsAccount.balance)}`);
  check('the funding sale realized a gain',
    expectedGain > 1, usd(expectedGain));
  check('that gain is reported to the tax engine',
    Math.abs(bookedGain - expectedGain) < 1,
    `booked ${usd(bookedGain)} of ${usd(expectedGain)} — LEAK ${usd(expectedGain - bookedGain)}`);
}

// ─── PART 2 — full sim: instrument the tax-payment draws ──────────────────────

/**
 * Wrap the three debit reducers so every `replenishSavings` they perform is
 * observed. `strip: true` empties `pendingTaxActions` on the way back out, which
 * is byte-equivalent to the pre-fix reducers (they destructured only
 * `crossBorderTransfers`, discarding the rest).
 *
 * Returns an uninstall fn; the recorder array is filled as the sim runs.
 */
function instrumentDebitReducers({ strip }) {
  const seen = [];
  let depth = 0;
  let currentDate = null;

  const origReplenish = AccountService.prototype.replenishSavings;
  AccountService.prototype.replenishSavings = function (state, targetKey, deficit, date, opts) {
    const result = origReplenish.call(this, state, targetKey, deficit, date, opts);
    if (depth > 0) {
      const taxActions = (result.pendingTaxActions ?? []).filter(a => DRAW_TAX_TYPES.has(a.type));
      if (taxActions.length) {
        seen.push({
          year: new Date(currentDate ?? date).getUTCFullYear(),
          targetKey, deficit,
          actions: taxActions.map(a => ({ type: a.type, taxable: taxableOf(a) })),
        });
      }
      if (strip) return { ...result, pendingTaxActions: [] };
    }
    return result;
  };

  // NB: `reduce` lives on TaxPaymentDebitReducerBase (not exported). Assigning to
  // each subclass prototype creates an own property that shadows the inherited
  // one — the base method still runs, just wrapped.
  const targets = [UsTaxPaymentDebitReducer, AuTaxPaymentDebitReducer, StateTaxPaymentDebitReducer];
  const originals = targets.map((C) => {
    const orig = Object.getPrototypeOf(C.prototype).reduce ?? C.prototype.reduce;
    C.prototype.reduce = function (state, action, date) {
      depth++; currentDate = date;
      try { return orig.call(this, state, action, date); }
      finally { depth--; }
    };
    return orig;
  });

  return {
    seen,
    uninstall() {
      AccountService.prototype.replenishSavings = origReplenish;
      targets.forEach((C) => { delete C.prototype.reduce; });
      void originals;
    },
  };
}

/** Run one full sim under instrumentation and reduce it to a comparable row. */
function runInstrumented(cfg, { strip }) {
  const inst = instrumentDebitReducers({ strip });
  try {
    const sim = openSim(structuredClone(cfg), { telemetry: 'off' });
    quiet(() => sim.stepTo(new Date(cfg.simEnd)));
    const s = sim.state;
    return {
      seen:      inst.seen,
      taxesPaid: s.cumulativeTaxesPaid ?? 0,
      netWorth:  s.metrics?.netWorth ?? 0,
      failed:    s.scenarioFailed ?? false,
      oofDate:   s.outOfFundsDate ? new Date(s.outOfFundsDate).toISOString().slice(0, 10) : null,
    };
  } finally {
    inst.uninstall();
  }
}

/**
 * Params that make the tax-payment draw fire, rather than waiting for a scenario
 * that happens to. A ROTH CONVERSION is the canonical case and not a contrivance:
 * it manufactures ordinary income with no cash attached, so the resulting bill
 * MUST be paid by liquidating something else — precisely the path under test.
 * Raised spending keeps the cash account near its floor on the settle date so the
 * bill can't be absorbed silently.
 */
const STRESS_PARAMS = {
  rothConversionEnabled:   true,
  rothConversionStartYear: 2027,
  rothConversionEndYear:   2035,
  monthlyExpenses:         12_000,
};

/** Drain the cash buffers of a file-sourced cfg (params there are already tuned). */
function thinCash(cfg) {
  const out = structuredClone(cfg);
  for (const acct of out.accounts ?? []) {
    if (acct?.role === ACCOUNT_ROLES.US_SAVINGS || acct?.role === ACCOUNT_ROLES.AU_SAVINGS) {
      acct.balance        = 1_000;
      acct.minimumBalance = 0;
    }
  }
  return out;
}

function partTwo(argv) {
  const { file, index } = parseSourceArgs(argv);
  const stress = argv.includes('--stress');
  let { cfg, source } = loadBaseConfig({ file, index, params: stress ? STRESS_PARAMS : {} });
  if (stress) { cfg = thinCash(cfg); source += ' [Roth-conversion + cash-thin stress]'; }

  console.log(`\nPART 2 — full sim  (${source})`);
  console.log(`  ${new Date(cfg.simStart).getUTCFullYear()}–${new Date(cfg.simEnd).getUTCFullYear()}\n`);

  const fixed  = runInstrumented(cfg, { strip: false });
  const preFix = runInstrumented(cfg, { strip: true  });

  if (!fixed.seen.length) {
    console.log('  No tax-payment draw fired in this scenario — the settle-date cash');
    console.log('  balance always covered the bill. Re-run with --stress to force it.\n');
    return;
  }

  // Per-year roll-up of taxable income/gain born inside a tax-payment draw.
  const byYear = new Map();
  const byType = new Map();
  for (const rec of fixed.seen) {
    for (const a of rec.actions) {
      byYear.set(rec.year, (byYear.get(rec.year) ?? 0) + a.taxable);
      byType.set(a.type,   (byType.get(a.type)   ?? 0) + a.taxable);
    }
  }
  const total = [...byYear.values()].reduce((s, v) => s + v, 0);

  console.log('  Taxable income/gain realized to PAY a tax bill, by year');
  console.log('  ' + '-'.repeat(38));
  for (const [year, amt] of [...byYear].sort((a, b) => a[0] - b[0])) {
    console.log(`   ${year}   ${usd(amt).padStart(14)}`);
  }
  console.log('  ' + '-'.repeat(38));
  console.log(`   TOTAL ${usd(total).padStart(14)}   (${fixed.seen.length} draws)\n`);

  console.log('  By action type');
  for (const [type, amt] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${type.padEnd(30)} ${usd(amt).padStart(14)}`);
  }

  const dTax = fixed.taxesPaid - preFix.taxesPaid;
  const dNw  = fixed.netWorth  - preFix.netWorth;
  console.log('\n  End-to-end A/B  (pre-fix = tax actions dropped, as shipped)');
  console.log('  ' + '-'.repeat(66));
  console.log(`   ${''.padEnd(22)} ${'pre-fix'.padStart(16)} ${'fixed'.padStart(16)}`);
  console.log(`   ${'lifetime tax (USD)'.padEnd(22)} ${usd(preFix.taxesPaid).padStart(16)} ${usd(fixed.taxesPaid).padStart(16)}`);
  console.log(`   ${'terminal net worth'.padEnd(22)} ${usd(preFix.netWorth).padStart(16)} ${usd(fixed.netWorth).padStart(16)}`);
  console.log(`   ${'out of funds'.padEnd(22)} ${String(preFix.oofDate ?? 'no').padStart(16)} ${String(fixed.oofDate ?? 'no').padStart(16)}`);
  console.log('  ' + '-'.repeat(66));
  console.log(`   lifetime tax under-stated by ${usd(dTax)}` +
              (preFix.taxesPaid > 0 ? `  (${pct(dTax / preFix.taxesPaid)})` : ''));
  console.log(`   terminal net worth over-stated by ${usd(-dNw)}` +
              (preFix.netWorth > 0 ? `  (${pct(-dNw / preFix.netWorth)})` : ''));
  console.log();
}

// ─── main ─────────────────────────────────────────────────────────────────────

console.log('probe-tax-payment-tax-leak — tax generated by paying tax');
partOne();
partTwo(process.argv.slice(2));

if (failures) {
  console.log(`\n${failures} check(s) failed — the funding sale's tax is not reaching the tax engine.\n`);
  process.exit(1);
}
console.log('\nAll part-1 checks passed.\n');
