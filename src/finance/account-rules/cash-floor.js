/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_TYPE } from '../assets/account.js';

/**
 * The cash floor — the ONE authority for an account's `minimumBalance`.
 *
 * `minimumBalance` is a buffer on a CASH account: checking, savings and offset. Two rules
 * follow from it, and every reader goes through this module so they cannot drift apart:
 *
 *   1. **A source keeps its floor.** A draw that raises cash for SOME OTHER account takes
 *      only what is above the floor (`drawableBalance` in penalty-free-availability.js).
 *   2. **A payer restores its floor first.** An account paying its OWN bill — spending, a
 *      tax bill, a contribution, a transfer out — is topped up from the drawdown chain far
 *      enough that the payment leaves it AT the floor (`floorTopUp`). The floor is soft
 *      here: when the chain is exhausted the payment still goes out of the buffer rather
 *      than failing, which is the rule the monthly expense debit has always followed.
 *
 * Before this module the second rule lived in the expense, mortgage and property handlers
 * only; the tax, cross-border and FX debits sized their top-up against the WHOLE balance,
 * so a tax bill spent the buffer and left the account under its floor until the next
 * month's expenses noticed.
 *
 * On an investment or retirement account the field is IGNORED. There `balance` is the sum
 * of the holdings, so a "floor" protected total value rather than cash, and the rebalancer
 * could still sell the account's cash sleeve to zero under it — a setting that looked like
 * a cash buffer and was not one. Loans never had a floor (design 54 §8). An untyped
 * account keeps the field, so a bare `new Account(…, { minimumBalance })` still works.
 */
const NON_CASH_TYPES = new Set([
  ACCOUNT_TYPE.BROKERAGE, ACCOUNT_TYPE.FOUR_OH_ONE_K, ACCOUNT_TYPE.ROTH,
  ACCOUNT_TYPE.TRADITIONAL_IRA, ACCOUNT_TYPE.SUPER, ACCOUNT_TYPE.LOAN,
]);

/**
 * Whether `minimumBalance` means anything on an account of this type.
 *
 * @param {string|null|undefined} type - an ACCOUNT_TYPE value
 * @returns {boolean}
 */
export function hasCashFloor(type) {
  return !NON_CASH_TYPES.has(type);
}

/**
 * The floor in force on `account`, in its own currency: its `minimumBalance` on a cash
 * account, 0 on anything else.
 *
 * @param {object} account
 * @returns {number}
 */
export function cashFloorOf(account) {
  if (!account || !hasCashFloor(account.type)) return 0;
  return Math.max(0, account.minimumBalance ?? 0);
}

/**
 * What must be raised INTO `account` before a debit of `amount` so the payment leaves it
 * at or above its floor. 0 when the balance above the floor already covers it.
 *
 * @param {object} account
 * @param {number} amount - the debit, in the account's own currency
 * @returns {number}
 */
export function floorTopUp(account, amount) {
  return Math.max(0, amount - ((account?.balance ?? 0) - cashFloorOf(account)));
}

/**
 * The `REPLENISH_SAVINGS` follow-up for a debit that has ALREADY been made from `account`:
 * `[]` when it is still at or above its floor, else one action that restores it.
 *
 * For a reducer that pays out of cash (a contribution, a tax bill with no top-up path of
 * its own). A handler sizes the same action BEFORE its debit — the expense and mortgage
 * handlers do — and a reducer cannot, because the actions it emits run after it. Restoring
 * afterwards, in the same event, lands on the same balance; the replenish reducer then
 * owns the draw, its taxes and its cross-border escalation, exactly as it does for
 * spending.
 *
 * @param {object} account   - the paying account, post-debit
 * @param {string} targetKey - its state key
 * @returns {object[]}
 */
export function restoreFloorActions(account, targetKey) {
  const deficit = cashFloorOf(account) - (account?.balance ?? 0);
  return deficit > 0.005 ? [{ type: 'REPLENISH_SAVINGS', deficit, targetKey }] : [];
}
