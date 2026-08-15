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
 * bond-currency-basis.js — design 87 G9. §988 on a foreign-currency DEBT INSTRUMENT,
 * from the HOLDER's side.
 *
 * §988(c)(1)(B)(i) puts a debt instrument on the closed list of §988 property, and
 * `Reg. §1.988-2(b)(5)` — the exact mirror of the (b)(6) obligor rule the mortgage leg
 * uses — realizes the holder's exchange gain or loss on **principal**:
 *
 * > The holder … shall realize exchange gain or loss with respect to the principal amount
 * > of such instrument on the date principal … is received from the obligor **or the
 * > instrument is disposed of** … For purposes of computing exchange gain or loss, the
 * > principal amount of a debt instrument is the **holder's purchase price** in units of
 * > nonfunctional currency.
 *
 * Two consequences the rest of this file is shaped by:
 *
 *  1. **"or the instrument is disposed of."** Redemption at maturity is only one of the
 *     two triggers. A SALE realizes the accumulated position just as fully, and it runs
 *     through a completely different seam (`consumeHoldings`) from the maturity reducer.
 *     Both call in here, so there is one implementation of the arithmetic rather than two
 *     that drift.
 *  2. **Principal, not market value.** The instrument's own price movement stays capital
 *     under §1001; only the exchange component of the principal is §988. So a partial
 *     sale measures the **par** share consumed, never the proceeds.
 *
 * ─── the sign, and why this file does not take a rate ───────────────────────────────
 *
 * The holder's convention is transposed relative to the obligor's, and the first G9
 * implementation had it backwards while every negative test still passed — design 87 §5's
 * recorded trap. This module therefore never accepts a rate at all: callers hand it
 * `principal` (foreign units) and `usdBasis` (what those units cost in dollars), and the
 * gain is `principal / spot − usdBasis`, which has no direction to get wrong. It also
 * generalises for free to a disposal spanning several lots bought at different rates,
 * which a single-rate signature cannot express.
 *
 * Only BOND is reached. EQUITY and GOLD are on none of §988(c)(1)(B)'s clauses, so their
 * currency movement stays *inside* the §1001 capital gain; booking a separate §988 item
 * on an equity sleeve would double-count the move AND recharacterise capital gain as
 * ordinary. Super is excluded wherever it appears, because a pension interest is its own
 * regime (design 83 Art. 18 / design 84 s99B) and design 87 §5 keeps it out throughout.
 */

import { ALLOCATION } from '../holdings/allocation.js';
import { allocateGain, PERSONAL_CHARACTER } from './currency-lots.js';
import { section988Residence } from './loan-classes.js';

const MS_PER_DAY = 86400000;

/**
 * The §988 principal of one bond holding, in the account's (foreign) currency.
 *
 * A TIPS-style instrument's principal is its accreted value floored at original face —
 * the same Treasury deflation floor `BondMaturityReducer.redeem` applies, so the amount
 * §988 measures and the amount actually received cannot disagree.
 */
export function bondPrincipalUnits(holding) {
  if (!holding || holding.allocation !== ALLOCATION.BOND) return 0;
  const par = holding.inflationLinked
    ? Math.max(holding.marketValue ?? 0, holding.faceValue ?? 0)
    : (holding.faceValue ?? holding.marketValue ?? 0);
  return par > 0 ? par : 0;
}

/**
 * Is this account one whose BOND sleeves are §988 property?
 *
 * Currency alone decides it, exactly as it does for a cash pool: the statute reaches any
 * instrument denominated in nonfunctional currency, regardless of what the account is
 * called. Super is the one carve-out, for the reason in the header.
 */
export function isForeignBondAccount(account) {
  if (!account || account.type === 'super') return false;
  const ccy = account.currency?.code ?? account.currency ?? null;
  return ccy != null && ccy !== 'USD';
}

/**
 * §988 on principal disposed of — the ONE emitter, shared by redemption and by sale.
 *
 * @param {object} state
 * @param {string} accountKey  state key, stamped onto the action for the journal
 * @param {object} account     the holding account's state entry
 * @param {object} tally
 * @param {number} tally.principal     foreign-currency principal disposed of (> 0)
 * @param {number} tally.usdBasis      USD cost of that principal, Σ par_lot / fxBasisRate_lot
 * @param {number|null} [tally.weightedDays]  principal-weighted days held, or null
 * @param {string|null} [tally.holdingId]     for the journal, when one lot is identifiable
 * @returns {object[]} zero or one SECTION_988_GAIN action
 */
export function section988ForBondPrincipal(state, accountKey, account, tally) {
  if (!isForeignBondAccount(account)) return [];
  const principal = tally?.principal ?? 0;
  const usdBasis  = tally?.usdBasis  ?? 0;
  if (!(principal > 0) || !(usdBasis > 0)) return [];

  const spot = state?.effectiveExchangeRates?.USD_AUD ?? 1.55;
  if (!(spot > 0)) return [];

  const gross = principal / spot - usdBasis;

  // A bond in a taxable account is held for the production of income — §212 — so the
  // §988(e)(3) share is 1 unless the account says otherwise. That is the OPPOSITE default
  // from a cash pool, where the balance funds living expenses, and the difference is
  // deliberate (design 87 §5 phase 2b).
  const frac = account.deductibleFraction ?? 1;
  // `applyDeMinimis: false` — §988(e)(2) reaches a case where "nonfunctional currency is
  // disposed of", and neither receiving a bond's principal nor selling the instrument is
  // one. Same reasoning as the mortgage leg (design 87 G4).
  //
  // `CAPITAL` — unlike the mortgage leg, the holder DOES part with property, so once
  // §988(e)(1) takes the personal share outside §988 the §1222 sale-or-exchange test is
  // satisfied and what survives is capital (design 87 §14.4 item 6). Dormant while `frac`
  // is 1, live the moment a scenario authors a `deductibleFraction` below it. And unlike
  // the cash pool this leg CAN date its holding period without FIFO, because the lot
  // itself carries an acquisition date.
  const alloc = allocateGain(gross, frac, tally.weightedDays ?? null,
                             { applyDeMinimis: false, personalCharacter: PERSONAL_CHARACTER.CAPITAL });

  if (Math.abs(alloc.ordinary) <= 1e-9 && alloc.capitalGain <= 1e-9
      && alloc.disallowedPersonalLoss <= 1e-9) return [];

  return [{
    type: 'SECTION_988_GAIN',
    accountKey,
    holdingId: tally.holdingId ?? null,
    currency: account.currency?.code ?? account.currency ?? null,
    amount: alloc.ordinary,
    gross,
    disallowedLoss: alloc.disallowedPersonalLoss,
    deMinimis: alloc.deMinimisExcluded,
    capitalGain: alloc.capitalGain,
    longTerm: alloc.longTerm,
    residency: section988Residence(state, account),
  }];
}

/**
 * §988 on the redemption of one matured foreign-currency bond.
 *
 * The (b)(5) trigger "principal … is received from the obligor". Thin, because the
 * arithmetic lives above; what it adds is the single-lot tally.
 */
export function section988ForRedemption(state, accountKey, account, holding, asOfMs) {
  if (!holding || holding.allocation !== ALLOCATION.BOND) return [];
  if (!(holding.fxBasisRate > 0)) return [];
  const principal = bondPrincipalUnits(holding);
  if (!(principal > 0)) return [];
  return section988ForBondPrincipal(state, accountKey, account, {
    principal,
    usdBasis: principal / holding.fxBasisRate,
    weightedDays: holdingPeriodDays(holding, asOfMs),
    holdingId: holding.id ?? null,
  });
}

/**
 * Days a holding was held, or null when it carries no usable purchase date.
 *
 * Deliberately NOT exported: the name is generic enough to collide in the generated
 * `src/index.js` namespace, and nothing outside this module needs it.
 */
function holdingPeriodDays(holding, asOfMs) {
  const raw = holding?.purchaseDate;
  if (raw == null) return null;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(asOfMs)) return null;
  return Math.max(0, Math.round((asOfMs - t) / MS_PER_DAY));
}
