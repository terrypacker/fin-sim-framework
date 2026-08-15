/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }                            from '../../../simulation-framework/handlers.js';
import { RecordBalanceAction, RecordMetricAction } from '../../../simulation-framework/actions.js';
import { OneOffEvent }                             from '../../../simulation-framework/events/one-off-event.js';
import { convertExpenseToAccount }                 from '../../fx/expense-fx.js';
import { propertyExpenseBusinessFraction }         from '../../account-rules/currency-basis.js';
import { residencePriceLevel }                    from '../expense-price-level.js';
import { SPEND_CATEGORY, blendCapitalFraction }   from '../spend-category.js';

const EPSILON = 1e-9;

/**
 * Build the scheduled `OneOffEvent` for one authored expense-event entry.
 *
 * Lives beside the handler rather than in a toolset because the US and AU retirement
 * toolsets BOTH schedule these, and a field added on one side only would silently
 * change behaviour depending on which toolset happened to own the scenario. Callers
 * must still apply the `_auSharedDelegated` guard — this helper builds an event, it
 * does not decide whether one is wanted.
 *
 * @param {object} evt authored entry: { date, amount, currency?, category?, personId?,
 *                                       fundFrom?, propertyKey?, capitalize?, label? }
 * @returns {OneOffEvent}
 */
export function buildExpenseEventSchedule(evt) {
  const category = evt.category ?? 'other';
  const label    = evt.label || category;
  return new OneOffEvent({
    name:    `Expense${label ? ` — ${label}` : ''}`,
    type:    'EXPENSE_EVENT',
    date:    new Date(evt.date),
    data:    {
      amount:      evt.amount,
      currency:    evt.currency    ?? null,
      category,
      personId:    evt.personId    ?? null,
      fundFrom:    evt.fundFrom    ?? null,
      propertyKey: evt.propertyKey ?? null,
      capitalize:  evt.capitalize  ?? 0,
    },
    enabled: true,
    color:   '#E91E63',
  });
}

/**
 * ExpenseEventHandler — handles EXPENSE_EVENT one-off events (design 86 G8/G9,
 * generalized from the design/26 HEALTHCARE strategy).
 *
 * A one-off expense is *a stated amount, in a stated currency, on a stated date,
 * funded from a stated account*. The healthcare events this replaces could express
 * only the first and third of those, which is why a domestic-currency capital
 * expense — the event design 86 §8 is entirely about — was previously unauthorable.
 *
 * Three things it does, in order:
 *
 *   1. **Resolves the event's own currency** — explicit `currency`, else the linked
 *      property's currency, else the household `expensesCurrency`. This is the field
 *      that makes an FX question askable at all: a domestic-currency cost has a
 *      foreign-currency cost that moves with the rate, and the old behaviour (always
 *      `expensesCurrency`) silently denominated everything in one currency.
 *   2. **Funds it**, nominated account first (G9), remainder from the residency
 *      default. See the funding contract below — it is the load-bearing part.
 *   3. **Emits EXPENSE_EVENT_APPLY** for tracking and for the capitalization leg.
 *
 * ─── the funding contract (design 86 G9) ────────────────────────────────────
 *
 * `fundFrom` names a state key debited **directly**, taking only what sits above
 * that account's `minimumBalance`; any remainder falls through to the residency
 * default, which may `REPLENISH_SAVINGS` against the drawdown queue as before.
 *
 * The direct debit is the whole point and it must NOT be expressed by giving the
 * nominated account a `drawdownPriority`. That was measured, and it does not model
 * "draw it when needed" — it models "spend it first", because a priority applies to
 * *all* spending, so the account empties years early and any study arm resting on it
 * stops testing its own strategy. An offset in particular is deliberately outside the
 * drawdown queue (`drawdownPriority: null`) and must stay there.
 *
 * A nominated account that cannot cover the whole amount therefore degrades
 * gracefully rather than failing or silently under-spending: it contributes what it
 * has and the default path finds the rest.
 *
 * Event data: { amount, currency?, category?, personId?, fundFrom?, propertyKey?,
 *               capitalize? }
 *
 * @param {object} opts
 * @param {import('../../../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} [opts.expensesCurrency='USD'] Household currency; the last-resort
 *                                               denomination when an event names none
 * @param {string} opts.usRole       ACCOUNT_ROLES value for the USD cash pool
 * @param {string} [opts.usOwnerId]  Person id for US savings (null = any owner)
 * @param {string} opts.auRole       ACCOUNT_ROLES value for the AUD cash pool
 * @param {string} [opts.auOwnerId]  Person id for AU savings (null = any owner)
 */
export class ExpenseEventHandler extends HandlerEntry {
  static description = 'Handles EXPENSE_EVENT one-off events: resolves the event currency, debits a nominated account directly (falling back to the residence-appropriate savings account for any remainder) and emits EXPENSE_EVENT_APPLY for tracking and capitalization.';
  static type        = 'ExpenseEventHandler';
  static eventType   = 'EXPENSE_EVENT';

  constructor({
    stateRegistry,
    expensesCurrency = 'USD',
    usRole, usOwnerId = null,
    auRole, auOwnerId = null,
  } = {}) {
    super(null, 'Expense Event');
    this.stateRegistry        = stateRegistry;
    this.expensesCurrency     = expensesCurrency;
    this.usRole               = usRole;
    this.usOwnerId            = usOwnerId;
    this.auRole               = auRole;
    this.auOwnerId            = auOwnerId;
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'EXPENSE_DEBIT', 'EXPENSE_EVENT_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  call({ state, data }) {
    const amount = data?.amount ?? 0;
    if (!amount) return [];

    const category    = data?.category    ?? 'other';
    const personId    = data?.personId    ?? null;
    const propertyKey = data?.propertyKey ?? null;
    const property    = propertyKey ? state?.[propertyKey] : null;

    // (1) The event's own denomination. An explicit currency wins; a property-linked
    // event inherits the property's; otherwise the household expense currency, which
    // is what every event did unconditionally before design 86 G8.
    const currency = data?.currency
      ?? _currencyCode(property)
      ?? this.expensesCurrency;

    const defaultKey = _residencyTargetKey(this, state, personId);
    const actions    = [];

    // Design 87 §14.4 item 2 — the §988 character of the currency this event spends.
    // A property-linked event inherits the property's §212 status, exactly as it already
    // inherits the property's currency above (design 86 G8); everything else is a
    // household outlay and therefore personal. Declared once and shared by BOTH debit
    // legs below: an event part-funded from a nominated account and part from savings is
    // ONE transaction under §988(e)(2)'s per-transaction floor, and the two legs must not
    // disagree about what the money bought.
    const section988 = { kind: 'DISPOSE',
                         businessFraction: property ? propertyExpenseBusinessFraction(property) : 0 };

    // Design 89 §5.6 — the price index this outlay is deflated by, resolved on the
    // SAME precedence the currency and the §212 status above already use: a
    // property-linked event is spent in the property's economy, everything else in
    // the household's. Event amounts are authored nominal and never indexed, so this
    // converts them to base-year real rather than undoing an indexation.
    const priceLevel = property
      ? (state?.inflationAccumulator?.[property.country ?? 'US'] ?? 1)
      : residencePriceLevel(state, this.primaryPersonKey);

    // Design 89 §6.1(A) + §8.1 — what this event bought, and how much of it was
    // capitalized rather than consumed. A capital improvement debits cash like any other
    // event but lifts `capitalizedImprovements` (design 86 G8), so drawing it whole in a
    // discretionary-spending band counts an investment as a cost. The gate is the same
    // one `capitalizeAmount` uses below — an unlinked event capitalizes nothing, however
    // it was authored — and it is hoisted here so both debit legs read one value.
    //
    // Note the deliberate name: `spendCategory`, because `EXPENSE_EVENT_APPLY` below
    // already carries a `category` and it is the author's free text, not this vocabulary.
    const capitalizeFrac  = data?.capitalize ?? 0;
    const capitalFraction = (capitalizeFrac > 0 && property)
      ? blendCapitalFraction(capitalizeFrac, 1)
      : 0;

    // (2) Funding. `remaining` is always carried in the EVENT's currency; each
    // account converts at its own edge, so a part-funded event that spans two
    // currencies still totals the event amount.
    let remaining = amount;

    const fundKey  = data?.fundFrom ?? null;
    const fundAcct = fundKey ? state?.[fundKey] : null;
    if (fundAcct) {
      const want      = convertExpenseToAccount(remaining, currency, fundAcct, state);
      const available = Math.max(0, (fundAcct.balance ?? 0) - (fundAcct.minimumBalance ?? 0));
      const take      = Math.min(want, available);
      if (take > EPSILON) {
        // Spread, never shared: `ExpenseDebitReducer` stamps `accountKey` onto the
        // declaration it is given, so one object across two actions would have the second
        // leg silently rewrite the first leg's pool.
        actions.push({ type: 'EXPENSE_DEBIT', amount: take, targetKey: fundKey,
                       priceLevel, spendCategory: SPEND_CATEGORY.DISCRETIONARY, capitalFraction,
                       section988: { ...section988 } });
        actions.push(new RecordBalanceAction(`${fundKey}.balance`, fundKey));
        // Back into event currency by the same ratio, so no rounding leaks either way.
        remaining -= want > EPSILON ? remaining * (take / want) : remaining;
      }
    }

    const defaultAcct = remaining > EPSILON ? state?.[defaultKey] : null;
    if (defaultAcct) {
      const debitAmount  = convertExpenseToAccount(remaining, currency, defaultAcct, state);
      const postDebitBal = defaultAcct.balance - debitAmount;
      const deficit      = (defaultAcct.minimumBalance ?? 0) - postDebitBal;
      // Prepended before its own debit, same contract as MonthlyExpensesHandler.
      if (deficit > 0) actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey: defaultKey });
      actions.push({ type: 'EXPENSE_DEBIT', amount: debitAmount, targetKey: defaultKey,
                     priceLevel, spendCategory: SPEND_CATEGORY.DISCRETIONARY, capitalFraction,
                     section988: { ...section988 } });
      actions.push(new RecordBalanceAction(`${defaultKey}.balance`, defaultKey));
    }

    // (3) Tracking, plus the capitalization leg. `capitalizeAmount` is converted HERE
    // rather than in the reducer because `capitalizedImprovements` is denominated in
    // the property's currency and the event need not be — an AUD improvement authored
    // in USD would otherwise inflate the eventual cost base by the exchange rate.
    const capitalizeAmount = (capitalizeFrac > 0 && property)
      ? capitalizeFrac * convertExpenseToAccount(amount, currency, property, state)
      : 0;

    actions.push({
      type: 'EXPENSE_EVENT_APPLY',
      amount, category, personId, currency, propertyKey, capitalizeAmount,
    });
    actions.push(new RecordMetricAction('expense_events', amount));

    return actions;
  }
}

/** Currency code off an account or property record; tolerates a bare string. */
function _currencyCode(rec) {
  return rec?.currency?.code ?? (typeof rec?.currency === 'string' ? rec.currency : null);
}

/** The savings pool a person's residency implies — the pre-G9 default target. */
function _residencyTargetKey(handler, state, personId) {
  const personKey = personId ?? Object.keys(state?.people ?? {})[0];
  const residency = state?.people?.[personKey]?.residency ?? null;
  return residency === 'AU'
    ? handler.stateRegistry.getStateKey(handler.auRole, handler.auOwnerId)
    : handler.stateRegistry.getStateKey(handler.usRole, handler.usOwnerId);
}
