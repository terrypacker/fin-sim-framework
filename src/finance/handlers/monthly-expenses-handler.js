/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { RecordBalanceAction, RecordMetricAction } from '../../simulation-framework/actions.js';
import { convertExpenseToAccount } from '../fx/expense-fx.js';
import { residencePriceLevel } from '../spending/expense-price-level.js';
import { SPEND_CATEGORY } from '../spending/spend-category.js';

/**
 * Re-base an amount between USD and AUD at the scenario's ANCHOR rate.
 *
 * `state.baseExchangeRates.USD_AUD` is AUD per USD, written once from the authored
 * `exchangeRateUsdToAud` and never mutated — so this conversion is deterministic and
 * identical in every Monte Carlo path. That is the whole point: it re-denominates a
 * standard of living without importing exchange-rate risk into the LEVEL of it.
 *
 * Falls back to the amount unchanged when the pair is absent (a single-currency
 * scenario has no anchor and needs no re-basing) rather than guessing a rate.
 */
function rebaseAtAnchor(amount, fromCode, toCode, state) {
  if (amount == null || fromCode === toCode) return amount;
  const audPerUsd = state?.baseExchangeRates?.USD_AUD;
  if (!Number.isFinite(audPerUsd) || audPerUsd <= 0) return amount;
  if (fromCode === 'USD' && toCode === 'AUD') return amount * audPerUsd;
  if (fromCode === 'AUD' && toCode === 'USD') return amount / audPerUsd;
  return amount;
}

/**
 * Handles the MONTHLY_EXPENSES event.
 *
 * Reads primaryPersonKey's residency to determine whether expenses
 * come from the US savings account (USD, 'US' residency) or AU savings account
 * (AUD, 'AU' residency).
 *
 * ─── how the expense figure is denominated ──────────────────────────────────
 *
 * `expensesCurrency` is one of:
 *
 *   'RESIDENCE'  (default) — the household's cost of living is a price in the
 *                country they LIVE in. The authored figure is read as
 *                `baseCurrency` (USD) and re-based ONCE into the residence
 *                currency at the scenario's **anchor** rate
 *                (`baseExchangeRates`, i.e. the authored `exchangeRateUsdToAud`),
 *                never at spot. Post-move the AUD cost is then FIXED and indexed
 *                to AU CPI; what floats with the exchange rate is the USD cost of
 *                funding it, which `replenishSavings` converts as needed.
 *
 *   'USD'/'AUD'  — legacy fixed denomination. The figure is that currency and is
 *                converted into the target account's currency at SPOT each month.
 *
 * **Why RESIDENCE is the default.** The fixed-currency modes are internally
 * inconsistent for anyone who moves. `InflationAdjustReducer` already indexes
 * `state.monthlyExpenses` at the RESIDENCE country's rate — so after a US→AU move
 * the figure grows at Australian CPI, asserting the basket is Australian — while
 * the fixed-USD denomination simultaneously holds its USD cost constant and lets
 * the AUD spend float with FX. Those two statements describe no real household,
 * and the combination silently reports ~zero FX risk for someone living in
 * Australia off a USD portfolio. Measured on a real 44-year cross-border plan, the
 * same scenario shows 1.5% FX spending dispersion under fixed-USD and 36% under a
 * residence-denominated target. See `scenarios/fx-study/fx-study.md` §1.
 *
 * **Why the ANCHOR rate and not spot at the move.** Australian prices do not
 * depend on the exchange rate on your moving day. Converting at spot would let one
 * month's FX draw set the household's permanent standard of living — a ~30% swing
 * across seeds — which is an artifact, not a risk. The anchor keeps the re-basing
 * deterministic and puts the FX risk where it belongs: on funding.
 *
 * The RECORD_METRIC 'monthly_expenses' value stays in the BASE currency so the
 * expense-level series reads consistently across the move rather than changing
 * units halfway through.
 *
 * If the target savings account would fall below its minimumBalance after the
 * (converted) debit, a REPLENISH_SAVINGS action is prepended to trigger the
 * drawdown cascade before the debit fires.
 *
 * data.amount overrides the configured monthlyExpenses for one-off adjustments;
 * it is treated as already being in `expensesCurrency`.
 *
 * @param {object} opts
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {number} [opts.monthlyExpenses=6000]
 * @param {string} [opts.expensesCurrency='RESIDENCE'] - 'RESIDENCE' | 'USD' | 'AUD'
 * @param {string} [opts.baseCurrency='USD'] - Currency the authored figure is stated in,
 *        used only by 'RESIDENCE' mode as the thing being re-based
 * @param {string} opts.usRole           - ACCOUNT_ROLES value for the USD cash pool
 * @param {string} [opts.usOwnerId]      - Person id for US savings (null = any owner)
 * @param {string} opts.auRole           - ACCOUNT_ROLES value for the AUD cash pool
 * @param {string} [opts.auOwnerId]      - Person id for AU savings (null = any owner)
 * @param {string} [opts.primaryPersonKey] - Person key to read residency from; defaults to first person
 */
export class MonthlyExpensesHandler extends HandlerEntry {
  static description = 'Residence-aware monthly expense handler: debits US savings (pre-move) or AU savings (post-move) based on primaryPersonKey residency, prepending REPLENISH_SAVINGS if needed.';
  static type        = 'MonthlyExpensesHandler';
  static eventType   = 'MONTHLY_EXPENSES';

  constructor({
    stateRegistry,
    monthlyExpenses = 6000,
    expensesCurrency = 'RESIDENCE',
    baseCurrency = 'USD',
    usRole, usOwnerId = null,
    auRole, auOwnerId = null,
    primaryPersonKey = null,
  } = {}) {
    super(null, 'Monthly Expenses');
    this.stateRegistry      = stateRegistry;
    this.monthlyExpenses    = monthlyExpenses;
    this.expensesCurrency   = expensesCurrency;
    this.baseCurrency       = baseCurrency;
    this.usRole             = usRole;
    this.usOwnerId          = usOwnerId;
    this.auRole             = auRole;
    this.auOwnerId          = auOwnerId;
    this.primaryPersonKey   = primaryPersonKey;
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'EXPENSE_DEBIT', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({
      stateRegistry,
      monthlyExpenses:  d.monthlyExpenses  ?? 6000,
      expensesCurrency: d.expensesCurrency ?? 'RESIDENCE',
      baseCurrency:     d.baseCurrency     ?? 'USD',
      usRole:           d.usRole           ?? null,
      usOwnerId:        d.usOwnerId        ?? null,
      auRole:           d.auRole           ?? null,
      auOwnerId:        d.auOwnerId        ?? null,
      primaryPersonKey: d.primaryPersonKey ?? null,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      monthlyExpenses:  this.monthlyExpenses,
      expensesCurrency: this.expensesCurrency,
      baseCurrency:     this.baseCurrency,
      usRole:           this.usRole,
      usOwnerId:        this.usOwnerId,
      auRole:           this.auRole,
      auOwnerId:        this.auOwnerId,
      primaryPersonKey: this.primaryPersonKey,
    };
  }

  call({ data, state }) {
    // Native expense figure (in expensesCurrency); the metric records this.
    const nativeAmount = data?.amount ?? state.monthlyExpenses ?? this.monthlyExpenses;
    const personKey   = this.primaryPersonKey ?? Object.keys(state.people ?? {})[0];
    const residency   = state.people?.[personKey]?.residency ?? null;
    const isAu        = residency === 'AU';
    const country     = isAu ? 'AU' : 'US';
    const role        = isAu ? this.auRole    : this.usRole;
    const ownerId     = isAu ? this.auOwnerId : this.usOwnerId;
    // Design 55 §7: prefer the account flagged as the country's transaction
    // account; fall back to the SAVINGS-role lookup when none is flagged so
    // pre-flag scenarios are unchanged.
    const targetKey   = this.stateRegistry.resolveTransactionAccountKey?.(country, ownerId)
      ?? this.stateRegistry.getStateKey(role, ownerId);
    const account   = state[targetKey];

    // RESIDENCE: the figure is a price in the country lived in. Re-base the authored
    // base-currency amount at the ANCHOR rate (never spot), then let the normal
    // account conversion below no-op because the two currencies now agree.
    //
    // `baseExchangeRates` is the pristine authored anchor — it is written once in
    // FxService.getContributions and nothing mutates it. Deliberately NOT
    // `fxAnchorRates` (which absorbs regime FX drift) and NOT
    // `effectiveExchangeRates` (spot): either would make the household's standard of
    // living wander with the exchange rate, which is the artifact this avoids.
    const residenceCurrency = isAu ? 'AUD' : 'USD';
    const expenseCurrency   = this.expensesCurrency === 'RESIDENCE'
      ? residenceCurrency
      : this.expensesCurrency;
    const expenseAmount = this.expensesCurrency === 'RESIDENCE'
      ? rebaseAtAnchor(nativeAmount, this.baseCurrency, residenceCurrency, state)
      : nativeAmount;

    // Convert into the target account's currency so the actual withdrawal is
    // the real-terms cost. Under RESIDENCE this is normally a no-op (the expense is
    // already in the residence currency and the transaction account is too); it still
    // runs so a scenario whose residence transaction account is in a third currency
    // is handled rather than silently mis-debited.
    const debitAmount = convertExpenseToAccount(expenseAmount, expenseCurrency, account, state);

    const actions = [];

    const postDebitBal = account.balance - debitAmount;
    const deficit      = (account.minimumBalance ?? 0) - postDebitBal;
    if (deficit > 0) {
      actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey });
    }

    actions.push(
      // Design 87 §14.4 item 2 — spending foreign currency on goods and services is a
      // disposition, priced by `§1.988-2(a)(2)(ii)(B)` as a sale of the units for USD at
      // spot followed by a purchase for those dollars. Household living expenses have no
      // expenses properly allocable to a trade or business, so §988(e)(3) makes the whole
      // thing PERSONAL: `§1.988-1(a)(9)`'s Example 2 (a taxpayer's holiday hotels, food
      // and sundries) is this line. Character falls to §1001/§1221 — capital — with the
      // §988(e)(2) \$200 per-transaction exclusion, and any LOSS disallowed under §165(c).
      // Design 89 §5.6 — the price index this money was incurred at. RESIDENCE, not
      // the account's currency: InflationAdjustReducer inflates state.monthlyExpenses
      // at the residence country's rate, so that is the index the consumption
      // accumulators must divide by to get base-year real dollars.
      // Design 89 §6.1(A) — what the household bought. Nothing else on this payload
      // distinguishes a month's groceries from a home's rates: both resolve the same
      // residence-appropriate pool and both are `businessFraction: 0`.
      // `capitalFraction` is structurally 0 here — living costs lift no cost basis —
      // and stamped anyway so every EXPENSE_DEBIT carries the pair (§8.1).
      { type: 'EXPENSE_DEBIT', amount: debitAmount, targetKey,
        priceLevel: residencePriceLevel(state, this.primaryPersonKey),
        spendCategory: SPEND_CATEGORY.LIVING, capitalFraction: 0,
        section988: { kind: 'DISPOSE', businessFraction: 0 } },
      new RecordMetricAction('monthly_expenses', nativeAmount),
      new RecordBalanceAction(`${targetKey}.balance`, targetKey),
    );
    return actions;
  }
}
