/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { projectHoldingsToState } from '../../finance/holdings/holding-utils.js';
import { loanRateTerms }          from '../../finance/account-rules/loan-classes.js';

/**
 * The runtime STATE entry for one authored account — the config→run boundary every
 * handler and reducer reads through. A field left out here is a field the simulation
 * cannot see, however it looks in the editor.
 *
 * ONE function, shared by the US and AU retirement toolsets. Both seed a state entry for
 * every account and whichever runs first wins (`patches[stateKey] === undefined`), so
 * while each toolset kept its own copy, a field added to only one was present or absent
 * depending on toolset order. That happened: the AU copy never projected
 * `postIoPrincipal`, and a standalone interest-only loan in an AU-only plan silently lost
 * its post-IO payment anchor (design 113 §10). Add new fields here, once.
 */
export function accountToStatePlain(account) {
  const plain = {
    balance:               account.balance,
    stateKey:              account.stateKey,
    type:                  account.type                  ?? null,
    country:               account.country               ?? null,
    currency:              account.currency              ?? null,
    role:                  account.role                  ?? null,
    ownerId:               account.ownerId               ?? null,
    // Design 76 Gap A: ownershipType MUST be projected alongside ownerId.
    // `ownershipFractions` resolves owners[] → sole+ownerId → even split, so a
    // missing ownershipType silently disqualifies the `sole` branch and sends
    // every per-person attribution to the even split — which is what made all
    // the accumulateByOwnership wiring from designs 52/55/73 inert.
    ownershipType:         account.ownershipType         ?? 'sole',
    minimumBalance:        account.minimumBalance        ?? 0,
    drawdownPriority:      account.drawdownPriority      ?? null,
    allowsEarlyWithdrawal: account.allowsEarlyWithdrawal ?? false,
    // Holdings — plain-data array (no methods), structuredClone-safe. This is also the
    // config→run boundary where a scalar individual bond is PROMOTED to the unitised
    // representation (design 93 §5b); the account record on disk is never rewritten.
    holdings:              projectHoldingsToState(account.holdings),
  };
  // OffsetAccount link (design 53 §3 / 54 P3): carry the property key into runtime
  // state so offsetBalanceForLoan() can find it — otherwise the offset is invisible.
  if (account.offsetsPropertyKey !== undefined) {
    plain.offsetsPropertyKey = account.offsetsPropertyKey ?? null;
  }
  // §988 currency basis + income-producing share (design 87). Same reason as the
  // offset link: the reducers read the runtime STATE entry, not the record, so a
  // field left out here makes an authored basis rate invisible and the pool gets
  // stamped at its first disposition instead. Projected only when set, so legacy
  // accounts are byte-identical.
  if (account.fxBasisRate != null) plain.fxBasisRate = account.fxBasisRate;
  // Dividend-reinvestment election (design 106 §4) — same rule as the two above, and it
  // is the rule that decides WHERE this field is read. The handler is constructed once,
  // at build time; a scenario loaded from a save restores its handlers from JSON rather
  // than re-running this toolset, so an election read at construction would be stale on
  // every loaded plan until the next Rebuild (the design-58 lever trap). Read from the
  // runtime STATE entry instead and the account record stays authoritative. Projected
  // only when the household has an opinion, so an unelected account is byte-identical
  // and the handler's own default (the toolset param) still applies.
  if (account.reinvestDividends != null) plain.reinvestDividends = account.reinvestDividends;
  // …and its per-security overrides (design 106 §5). Same rule, same reason: the handler
  // reads the election from the runtime STATE entry, so a field left out here is an
  // authored election the simulation cannot see.
  if (account.reinvestDividendsBySecurity != null
      && Object.keys(account.reinvestDividendsBySecurity).length > 0) {
    plain.reinvestDividendsBySecurity = { ...account.reinvestDividendsBySecurity };
  }
  if (account.type !== 'loan' && account.deductibleFraction != null) {
    plain.deductibleFraction = account.deductibleFraction;
  }
  // LoanAccount terms (design 54 §2 + design 86). Same reason as the offset link
  // above: LoanPaymentHandler reads the runtime STATE entry, not the record, so a
  // field left out here makes an authored loan a balance with no rate and no
  // payment — it sits in net worth and is never serviced.
  if (account.type === 'loan') {
    plain.interestRate          = account.interestRate          ?? 0;
    plain.primeSpread           = account.primeSpread           ?? null;
    plain.monthlyPayment        = account.monthlyPayment        ?? 0;
    plain.linkedPropertyKey     = account.linkedPropertyKey     ?? null;
    plain.paymentSourceKey      = account.paymentSourceKey      ?? null;
    plain.interestOnly          = account.interestOnly          ?? false;
    plain.deductibleFraction    = account.deductibleFraction    ?? null;
    plain.interestOnlyUntilYear = account.interestOnlyUntilYear ?? null;
    plain.maturityYear          = account.maturityYear          ?? null;
    plain.bookingFxRate         = account.bookingFxRate         ?? null;
    // Anchor for the post-IO payment (see scheduledLoanPayment). Same reason as every
    // other field here: the handler reads the runtime STATE entry, so leaving it out
    // silently drops the loan back onto the legacy self-damping schedule. (Before this
    // function was shared, the AU copy omitted it — see the module comment.)
    plain.postIoPrincipal       = account.postIoPrincipal       ?? null;
    // Design 113 — only the terms that are set, so a loan authored before them projects
    // the byte-identical state entry.
    Object.assign(plain, loanRateTerms(account));
  }
  if (account.contributionBasis !== undefined) {
    plain.contributionBasis        = account.contributionBasis;
    plain.earningsBasis            = account.earningsBasis ?? 0;
    plain.derivedIncomeBasis       = account.derivedIncomeBasis ?? 0;
    plain.loanBalance              = account.loanBalance   ?? 0;
    plain.minimumAge               = account.minimumAge    ?? null;
    plain.balanceAtResidencyChange = account.balanceAtResidencyChange ?? null;
    // Per-country residency cost-base step-up (design 36 §12.2); null until a move.
    plain.costBaseStepUpByCountry  = account.costBaseStepUpByCountry ?? null;
    if (account.rolloverContribBasis  !== undefined) plain.rolloverContribBasis  = account.rolloverContribBasis;
    if (account.rolloverEarningsBasis !== undefined) plain.rolloverEarningsBasis = account.rolloverEarningsBasis;
    // Dated conversion lots backing the §408A(d)(3)(F) 5-year recapture (EVT-43).
    if (account.rolloverContribBasis  !== undefined) plain.rolloverConversions   = (account.rolloverConversions ?? []).map(l => ({ ...l }));
  }
  return plain;
}
