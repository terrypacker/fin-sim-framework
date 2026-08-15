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
 * What a debit MEANS — design 89 §8 (the taxonomy) and §7(a) (the invariant).
 *
 * The spending report answers "what does this plan actually cost?", and the naive
 * answer — sum every negative balance delta — overstates it by 96% on the reference
 * plan (§3, measured in converted dollars). Roughly half of all money leaving an
 * account is not spending: it is moving between the household's own pockets, marking
 * an asset to market, or repaying a principal balance that the loan account's own leg
 * already counted once.
 *
 * This module is the allowlist that separates those. It is deliberately an ALLOWLIST
 * and not a denylist: an action type nobody classified lands in `UNCLASSIFIED` and is
 * **drawn** (§7 a). Refusing to render leaves the operator with nothing, while an
 * honest band leaves them looking straight at the anomaly — so a new action type from
 * a future design appears as a visible stripe on its first run instead of vanishing
 * from a total. §8.0 is the evidence that they keep appearing.
 *
 * ─── the two rules that are not a lookup ─────────────────────────────────────
 *
 * **A debit can split.** Two of them do, and both splits are the whole point of a
 * category the design argues for:
 *
 *   · `LOAN_PAYMENT_APPLY`'s cash leg is interest (a real cost) plus principal (a
 *     balance-sheet transfer). §4 — a chart that counts the whole payment as spending
 *     contradicts design 86's finding that the loan is a cheap option, and on the
 *     reference plan the offset drives the interest share to ~7% of the cash leg.
 *   · `EXPENSE_DEBIT`'s `capitalFraction` is the part that lifted a cost basis rather
 *     than being consumed (§8.1, design 75 §5.2).
 *
 * So `classifyDebit` returns an ARRAY of shares that sum to 1, never a single label.
 * A caller that takes `[0]` and ignores the rest breaks §7(a), which is what the
 * totality test exists to catch.
 *
 * **`DEBT_PRINCIPAL` is asserted, never inherited from scope.** §3.1 found that the
 * shipped reports scope to `accountBalanceKeys()`, the loan accounts are not in it,
 * and so they already drop the mortgage double-count *by accident*. Registering them
 * for any unrelated reason would silently bring it back. The rules below therefore
 * name the loan legs explicitly and would keep classifying them correctly even if the
 * scope that currently hides them disappeared tomorrow.
 */

import { SPEND_CATEGORY } from '../spending/spend-category.js';

/**
 * Tier 1 is drawn as spending; tier 2 is drawn in a separate strip (design 89 OQ3 —
 * below-axis reads as negative spending, and a toggle hides the audit that is the
 * point). Both are drawn: §7(a) does not hold if a tier is omitted.
 */
export const SPEND_TIER = Object.freeze({
  SPENDING:     'SPENDING',
  NOT_SPENDING: 'NOT_SPENDING',
});

/** The full vocabulary — design 89 §8, both tiers. */
export const REPORT_CATEGORY = Object.freeze({
  // ── Tier 1 · spending ──────────────────────────────────────────────────────
  LIVING:            'LIVING',
  HOUSING_RUNNING:   'HOUSING_RUNNING',
  HOUSING_REPAIR:    'HOUSING_REPAIR',
  DISCRETIONARY:     'DISCRETIONARY',
  TAX_US_FEDERAL:    'TAX_US_FEDERAL',
  TAX_US_STATE:      'TAX_US_STATE',
  TAX_AU:            'TAX_AU',
  INTEREST:          'INTEREST',

  // ── Tier 2 · not spending, but drawn ───────────────────────────────────────
  INTERNAL:          'INTERNAL',
  DEBT_PRINCIPAL:    'DEBT_PRINCIPAL',
  REVALUATION:       'REVALUATION',
  ASSET_PURCHASE:    'ASSET_PURCHASE',
  ASSET_IMPROVEMENT: 'ASSET_IMPROVEMENT',
  UNCLASSIFIED:      'UNCLASSIFIED',
});

/**
 * @type {Readonly<Record<string, string>>}
 *
 * `ASSET_IMPROVEMENT` is one category more than §8 proposed, and the reason is worth
 * stating: §8.1 rules that a capitalized repair belongs "in `DEBT_PRINCIPAL`'s spirit
 * — wealth moved, not consumed", which puts it in tier 2, but folding it into
 * `ASSET_PURCHASE` would say a re-roofing and buying a second house are the same
 * event. An operator asking what the house cost needs those apart. Merging two
 * categories later is a one-line change in the consumer; splitting one that was never
 * recorded separately means re-running.
 */
export const CATEGORY_TIER = Object.freeze({
  [REPORT_CATEGORY.LIVING]:            SPEND_TIER.SPENDING,
  [REPORT_CATEGORY.HOUSING_RUNNING]:   SPEND_TIER.SPENDING,
  [REPORT_CATEGORY.HOUSING_REPAIR]:    SPEND_TIER.SPENDING,
  [REPORT_CATEGORY.DISCRETIONARY]:     SPEND_TIER.SPENDING,
  [REPORT_CATEGORY.TAX_US_FEDERAL]:    SPEND_TIER.SPENDING,
  [REPORT_CATEGORY.TAX_US_STATE]:      SPEND_TIER.SPENDING,
  [REPORT_CATEGORY.TAX_AU]:            SPEND_TIER.SPENDING,
  [REPORT_CATEGORY.INTEREST]:          SPEND_TIER.SPENDING,

  [REPORT_CATEGORY.INTERNAL]:          SPEND_TIER.NOT_SPENDING,
  [REPORT_CATEGORY.DEBT_PRINCIPAL]:    SPEND_TIER.NOT_SPENDING,
  [REPORT_CATEGORY.REVALUATION]:       SPEND_TIER.NOT_SPENDING,
  [REPORT_CATEGORY.ASSET_PURCHASE]:    SPEND_TIER.NOT_SPENDING,
  [REPORT_CATEGORY.ASSET_IMPROVEMENT]: SPEND_TIER.NOT_SPENDING,
  [REPORT_CATEGORY.UNCLASSIFIED]:      SPEND_TIER.NOT_SPENDING,
});

/**
 * `EXPENSE_DEBIT`'s emitted `spendCategory` → the report category. A 1:1 map today,
 * and kept as a map rather than a pass-through because the two vocabularies belong to
 * different layers: the emitter's is a closed set of things a handler can know, the
 * report's is the full §8 taxonomy including categories no emitter stamps.
 */
const EXPENSE_CATEGORY = Object.freeze({
  [SPEND_CATEGORY.LIVING]:          REPORT_CATEGORY.LIVING,
  [SPEND_CATEGORY.HOUSING_RUNNING]: REPORT_CATEGORY.HOUSING_RUNNING,
  [SPEND_CATEGORY.HOUSING_REPAIR]:  REPORT_CATEGORY.HOUSING_REPAIR,
  [SPEND_CATEGORY.DISCRETIONARY]:   REPORT_CATEGORY.DISCRETIONARY,
});

/**
 * The allowlist proper: action type → category, for the types whose whole debit is
 * one thing.
 *
 * Every type in §3's measured table is here, plus §8.0's four that the reference plan
 * never fires — the list §8.0 exists to make sure is written from the codebase rather
 * than from one run's journal.
 */
const BY_ACTION_TYPE = Object.freeze({
  // ── taxes actually paid out of an account ──────────────────────────────────
  US_TAX_PAYMENT_DEBIT:              REPORT_CATEGORY.TAX_US_FEDERAL,
  STATE_TAX_PAYMENT_DEBIT:           REPORT_CATEGORY.TAX_US_STATE,
  AU_TAX_PAYMENT_DEBIT:              REPORT_CATEGORY.TAX_AU,

  // ── the household's own pockets ────────────────────────────────────────────
  // 34% of debits on the draft's measure and ~45% on the converted one. Its absence
  // from the chart would be the first thing an operator asked about (§8 tier 2).
  HOLDING_TRANSACT:                  REPORT_CATEGORY.INTERNAL,
  REPLENISH_SAVINGS:                 REPORT_CATEGORY.INTERNAL,
  REBALANCE_TO_TARGET_APPLY:         REPORT_CATEGORY.INTERNAL,
  IRA_RMD_APPLY:                     REPORT_CATEGORY.INTERNAL,
  ROTH_CONVERSION_APPLY:             REPORT_CATEGORY.INTERNAL,
  K401_TO_IRA_CONVERSION_APPLY:      REPORT_CATEGORY.INTERNAL,
  SCHEDULED_EARLY_WITHDRAWAL_APPLY:  REPORT_CATEGORY.INTERNAL,
  INTL_TRANSFER_APPLY:               REPORT_CATEGORY.INTERNAL,
  FX_TRANSFER_APPLY:                 REPORT_CATEGORY.INTERNAL,
  COLLECTIBLE_SALE_APPLY:            REPORT_CATEGORY.INTERNAL,

  // ── marks, not cash flows ──────────────────────────────────────────────────
  // §2's failure mode in one line: a revaluation in a spending band would report a
  // market decline as an outlay.
  REVALUE_ASSET_APPLY:               REPORT_CATEGORY.REVALUATION,
  COLLECTIBLE_VALUE_CHANGE_APPLY:    REPORT_CATEGORY.REVALUATION,
  ASSET_APPRECIATE_APPLY:            REPORT_CATEGORY.REVALUATION,

  // The growth family. Every one of these CREDITS an account in a good year and
  // **debits it in a bad one**, which is the only reason they are here at all: a
  // negative-return year makes a mark look exactly like an outlay.
  //
  // Found by the phase 6 MC sweep, not by reading the codebase — `STOCK_EARNINGS_APPLY`,
  // `AU_STOCK_EARNINGS_APPLY`, `SUPER_EARNINGS_APPLY` and `ROTH_EARNINGS_APPLY` all
  // reached `UNCLASSIFIED` across 40 perturbed paths while the 45-year reference plan
  // showed zero, because its sampled returns never go negative. §8.0 said types that
  // exist but never fire would keep appearing; this is the mechanism that finds them.
  //
  // The siblings are listed with them: classifying only the four observed would leave
  // the identical bug for whichever wrapper happens to have the bad year next time.
  // Deliberately NOT a name pattern — a regex would classify a future type without
  // anyone deciding it should be, which is the opposite of what an allowlist is for.
  STOCK_EARNINGS_APPLY:              REPORT_CATEGORY.REVALUATION,
  AU_STOCK_EARNINGS_APPLY:           REPORT_CATEGORY.REVALUATION,
  IRA_EARNINGS_APPLY:                REPORT_CATEGORY.REVALUATION,
  ROTH_EARNINGS_APPLY:               REPORT_CATEGORY.REVALUATION,
  SUPER_EARNINGS_APPLY:              REPORT_CATEGORY.REVALUATION,
  FIXED_INCOME_EARNINGS_APPLY:       REPORT_CATEGORY.REVALUATION,
  AU_FIXED_INCOME_EARNINGS_APPLY:    REPORT_CATEGORY.REVALUATION,
  AU_SAVINGS_EARNINGS_APPLY:         REPORT_CATEGORY.REVALUATION,
  // Premium amortisation runs the other way from accretion, so this one can debit even
  // in a good year (design 66 G9).
  BOND_ACCRETION_APPLY:              REPORT_CATEGORY.REVALUATION,

  // The WITHDRAWAL and ROLLOVER earnings legs are a different thing wearing a similar
  // name: they move money out of a wrapper rather than mark it, so they are transfers.
  // Neither surfaced in the sweep or on the reference plan — listed because the naming
  // similarity makes them the most likely thing to be mis-added to the block above.
  IRA_WITHDRAWAL_EARNINGS_APPLY:            REPORT_CATEGORY.INTERNAL,
  ROTH_WITHDRAWAL_EARNINGS_APPLY:           REPORT_CATEGORY.INTERNAL,
  ROTH_ROLLOVER_EARNINGS_APPLY:             REPORT_CATEGORY.INTERNAL,
  ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY:  REPORT_CATEGORY.INTERNAL,
  SUPER_WITHDRAWAL_EARNINGS_APPLY:          REPORT_CATEGORY.INTERNAL,

  // ── a spend by the netting test, an investment by intent (§8.1) ────────────
  PROPERTY_PURCHASE_APPLY:           REPORT_CATEGORY.ASSET_PURCHASE,
});

/**
 * Action types whose debit against a LOAN account is a principal repayment. Anything
 * else they debit is classified by the normal rules.
 *
 * The house sales are here because a sale pays the mortgage off — §4's other half.
 * `FX_COST` from §8 has no entry anywhere in this module on purpose: no action
 * currently carries a separable fee field, and inventing the split by differencing
 * two converted amounts would be exactly the inference §6 forbids.
 */
const PAYS_OFF_DEBT = new Set([
  'LOAN_PAYMENT_APPLY',
  'US_HOUSE_SALE_APPLY',
  'AU_HOUSE_SALE_APPLY',
]);

/** One share of a debit. `fraction` values across a classification sum to 1. */
/**
 * @typedef {{category: string, tier: string, fraction: number}} DebitShare
 */

const whole = (category) => [{ category, tier: CATEGORY_TIER[category], fraction: 1 }];

/**
 * Classify one negative balance delta.
 *
 * @param {object}   debit
 * @param {string}   debit.actionType  the emitting action's type
 * @param {string}   debit.stateKey    the dotted path that moved, e.g. `usSavings2Account.balance`
 * @param {object}   [debit.data]      the action's JOURNALED payload (declared fields only —
 *                                     `pickPayload` drops the rest, so an undeclared field
 *                                     is absent here even though the reducer received it)
 * @param {Set<string>} [debit.loanKeys] `<key>.balance` paths of accounts whose balance is a
 *                                     LIABILITY. Absent ⇒ a sale payoff cannot be identified
 *                                     and lands in `UNCLASSIFIED`, which is the honest answer:
 *                                     visibly unclassified beats silently counted as spending.
 * @returns {DebitShare[]} shares summing to 1
 */
export function classifyDebit({ actionType, stateKey, data = null, loanKeys = null } = {}) {
  if (!actionType) return whole(REPORT_CATEGORY.UNCLASSIFIED);

  // ── the loan legs, asserted rather than scoped away (§3.1) ─────────────────
  if (PAYS_OFF_DEBT.has(actionType)) {
    const isLoanLeg = actionType === 'LOAN_PAYMENT_APPLY'
      ? stateKey === `${data?.loanKey}.balance`
      : !!loanKeys?.has(stateKey);
    if (isLoanLeg) return whole(REPORT_CATEGORY.DEBT_PRINCIPAL);
  }

  if (actionType === 'LOAN_PAYMENT_APPLY') {
    // The cash leg. Split by the interest RATIO, never by the interest amount: both
    // `payment` and `interest` are in the LOAN's currency while the delta is in the
    // cash pool's, and on a cross-currency facility subtracting one from the other
    // would be off by the exchange rate (design 86 §8.6's arrangement exactly).
    const payment  = data?.payment  ?? 0;
    const interest = data?.interest ?? 0;
    if (!(payment > 0)) return whole(REPORT_CATEGORY.DEBT_PRINCIPAL);
    const share = Math.min(1, Math.max(0, interest / payment));
    return _split(REPORT_CATEGORY.INTEREST, share, REPORT_CATEGORY.DEBT_PRINCIPAL);
  }

  if (actionType === 'EXPENSE_DEBIT') {
    const category = EXPENSE_CATEGORY[data?.spendCategory];
    // An unstamped or unknown category is NOT quietly folded into LIVING. That guess
    // would be indistinguishable from the pre-phase-1 state the field exists to end,
    // and it would be wrong precisely for the emitter someone forgot.
    if (!category) return whole(REPORT_CATEGORY.UNCLASSIFIED);
    const capital = Math.min(1, Math.max(0, data?.capitalFraction ?? 0));
    return _split(REPORT_CATEGORY.ASSET_IMPROVEMENT, capital, category);
  }

  const flat = BY_ACTION_TYPE[actionType];
  return whole(flat ?? REPORT_CATEGORY.UNCLASSIFIED);
}

/**
 * `first` takes `fraction` and `rest` takes the remainder, dropping either end when it
 * rounds to nothing so a wholly-one-thing debit yields one share rather than a zero row.
 */
function _split(first, fraction, rest) {
  if (!(fraction > 0))  return whole(rest);
  if (fraction >= 1)    return whole(first);
  return [
    { category: first, tier: CATEGORY_TIER[first], fraction },
    { category: rest,  tier: CATEGORY_TIER[rest],  fraction: 1 - fraction },
  ];
}

/**
 * Every action type this module classifies without falling through to `UNCLASSIFIED`.
 * Exported so a test can assert the allowlist still covers everything a real run
 * fires — the check that turns "a future design added a type" from a silent stripe
 * into a decision someone makes on purpose.
 *
 * @returns {string[]}
 */
export function classifiedActionTypes() {
  return [...new Set([...Object.keys(BY_ACTION_TYPE), ...PAYS_OFF_DEBT, 'EXPENSE_DEBIT'])].sort();
}
