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
 * Roth converted-principal lot consumption — the pure half of EVT-43.
 *
 * Lives on its own, free of reducer/handler imports, because TWO layers need it
 * and they must not disagree (design 84 G9):
 *   - `roth-rollover-classes.js`, the event-driven EVT-43 path;
 *   - `AccountService.reduceLedgerForWithdrawal`, the GENERIC drawdown path that
 *     `replenishSavings` and the scheduled decant run through.
 *
 * Before this split only the event path knew how to consume a conversion lot, so
 * converted principal drawn by the generic path left the wrapper represented
 * nowhere — no basis reduction, no action, no assessment. Keeping the FIFO order,
 * the §408A(d)(3)(F) window test and the s99B split in one function is what makes
 * the two paths provably identical.
 */

/** IRC §72(t) early-distribution additional tax rate and age threshold. */
export const PENALTY_RATE  = 0.10;
export const AGE_THRESHOLD = 59.5;

/**
 * Consume converted-principal lots for a Roth withdrawal, computing both the US
 * recapture penalty and the AU-assessable (s99B) portion.
 *
 * FIFO-consumes `amount` from the Roth's dated conversion lots. For each consumed
 * slice:
 *   - US recapture (IRC §408A(d)(3)(F)): the slice is penalised when the owner is
 *     under 59½ AND the withdrawal falls inside the 5-taxable-year window that
 *     began Jan 1 of that lot's conversion year (a 2026 conversion clears on
 *     1 Jan 2031, so withdrawalYear − conversionYear < 5 is inside the window).
 *     At/after 59½ the §72(t) exception removes the penalty.
 *   - AU s99B: the slice's IRA-earnings-sourced share (its `taxableAmount`,
 *     consumed pro-rata) is assessable income — pre-tax IRA earnings do not
 *     qualify for the corpus exemption. The IRA-contribution-sourced share is
 *     corpus and stays AU-free.
 *
 * Lots with no conversion date and/or no `taxableAmount` (legacy / directly-seeded
 * basis of unknown provenance) are treated as seasoned corpus — no penalty, no AU
 * assessment.
 *
 * Pure: returns the replacement lot array, mutating nothing.
 *
 * @param {object[]} lots      - `account.rolloverConversions`
 * @param {number}   amount    - converted principal being withdrawn (account ccy)
 * @param {Date|number|null} date - withdrawal date; a nullish date suppresses the
 *        window test (no date, no year to compare — never penalise on a guess)
 * @param {object}   opts
 * @param {boolean}  opts.underAge - owner below the 59½ gate at the withdrawal
 * @returns {{ penaltyAmount:number, auAssessableAmount:number, newLots:object[] }}
 */
export function computeConversionRecapture(lots, amount, date, { underAge = false } = {}) {
  const asDate = date == null ? null : (date instanceof Date ? date : new Date(date));
  const withdrawalYear = asDate ? asDate.getUTCFullYear() : null;
  let remaining      = amount;
  let penalisedBase  = 0;
  let auAssessable   = 0;
  const newLots      = [];
  for (const lot of (lots ?? [])) {
    if (remaining <= 1e-9) { newLots.push(lot); continue; }
    const take    = Math.min(lot.amount, remaining);
    const taxable = lot.amount > 0 ? (lot.taxableAmount ?? 0) * (take / lot.amount) : 0;
    remaining    -= take;
    auAssessable += taxable;
    if (underAge && withdrawalYear != null && lot.conversionMs != null) {
      const conversionYear = new Date(lot.conversionMs).getUTCFullYear();
      if (withdrawalYear - conversionYear < 5) penalisedBase += take;
    }
    const left = lot.amount - take;
    if (left > 1e-9) {
      newLots.push({ ...lot, amount: left, taxableAmount: +((lot.taxableAmount ?? 0) - taxable).toFixed(2) });
    }
  }
  return {
    penaltyAmount:      +(penalisedBase * PENALTY_RATE).toFixed(2),
    auAssessableAmount: +auAssessable.toFixed(2),
    newLots,
  };
}
