/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY, AccountServiceReducer } from '../../../simulation-framework/reducers.js';
import { HandlerEntry }       from '../../../simulation-framework/handlers.js';
import { RecordBalanceAction } from '../../../simulation-framework/actions.js';
import { findLoanForProperty } from '../loan-classes.js';
import { resolveDestinationCashKey, resolveSaleDestinationKey, creditSaleProceeds } from '../cash-routing.js';
import { us121Exclusion, unrecaptured1250Gain, toMs } from '../main-residence.js';
import { singleAssetTermFields } from '../../holdings/holding-period.js';

// IRC §121 caps and the ownership/use rules now live in ../main-residence.js, shared
// with the AU dwelling path. The note that used to sit here — "the 2-of-5-year
// ownership-and-use test is not modeled; the isPrimaryResidence flag stands in for
// eligibility" — is retired: design 83 G7 step 5 implements the test and the
// §121(b)(5) nonqualified-use proration for both countries' dwellings.

const YEAR_MS       = 365 * 24 * 60 * 60 * 1000;
const SIX_YEARS_MS  = 6 * YEAR_MS;

/**
 * AU main-residence exemption fraction for a FOREIGN dwelling of an AU resident
 * (design 62 §5.3). The person became absent at the deemed-acquisition date (the
 * move), so ITAA97 s118-145 (the absence rule) applies:
 *   - not a main residence (investment property) ⇒ 0 (fully assessable);
 *   - main residence, NOT income-producing ⇒ 1 (indefinite absence exemption);
 *   - main residence, income-producing (rented) ⇒ the 6-year absence limit, applied
 *     proportionally: exempt = min(6y, ownership) / ownership from the move to sale.
 * Simplification: assumes the foreign dwelling retains the exemption (a competing
 * AU main-residence claim would reduce it; not modeled).
 *
 * @returns {number} exempt fraction in [0, 1]
 */
export function auMainResidenceExemptFraction(propState, deemedAcqMs, saleMs) {
  if (!propState?.isPrimaryResidence) return 0;
  if (deemedAcqMs == null || saleMs == null || saleMs <= deemedAcqMs) return 1;
  const incomeProducing = propState.rentalEnabled === true && (propState.monthlyRent ?? 0) > 0;
  if (!incomeProducing) return 1;
  const ownershipMs = saleMs - deemedAcqMs;
  return Math.min(SIX_YEARS_MS, ownershipMs) / ownershipMs;
}

/** Default US cash pool key when no saleDestinationAccount is provided. */
const defaultUsCashKey = (state) =>
  state.usSavingsAccount != null ? 'usSavingsAccount' : 'checkingAccount';

/**
 * Resolve the destination state key, falling back to the default US cash pool.
 * Delegates to the shared resolver so a `saleDestinationAccount` persisted as an
 * account *id* rather than a state key still finds its account (design 72 §2).
 */
const resolveDestinationKey = (state, saleDestinationAccount) =>
  resolveSaleDestinationKey(state, saleDestinationAccount, defaultUsCashKey(state));

// ─── Reducer ──────────────────────────────────────────────────────────────────

/**
 * EVT-34: US house sale — credit destination account with sale proceeds net of
 * mortgage payoff, compute taxable capital gain after the IRC §121 principal-residence
 * exclusion ($250k Single / $500k MFJ, primary residence only; mortgage payoff does not
 * reduce the taxable gain), and chain US_HOUSE_SALE_TAX.
 */
export class UsHouseSaleApplyReducer extends AccountServiceReducer {
  static type        = 'UsHouseSaleApplyReducer';
  static description = 'Credits the destination account with net proceeds (salePrice − mortgage), zeroes mortgageBalance, and chains US_HOUSE_SALE_TAX with the post-exemption taxable gain.';
  static actionType  = 'US_HOUSE_SALE_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('US House Sale Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['US_HOUSE_SALE_APPLY'];
    this.generatedActionTypes = ['US_HOUSE_SALE_TAX', 'INTL_TRANSFER_RECORD'];
  }

  reduce(state, action, date) {
    const { salePrice, costBasis, mortgageBalance, stateKey, destinationKey, residency } = action;
    // Design 83 G7 — every day count below ends at the DISPOSAL, not at the start of
    // the tax period containing it. The period start is a fallback for a replayed
    // action dispatched without a date.
    const eventMs = toMs(date);
    const mortgage    = mortgageBalance ?? 0;
    const netProceeds = Math.max(0, salePrice - mortgage);
    // Depreciation taken during the hold reduces the tax basis, so the gain is
    // larger (design 48 §4.5). accumulatedDepreciation is 0 for non-rental
    // properties, so this is a no-op there.
    const propState = stateKey ? state[stateKey] : null;
    const accumulatedDep = propState?.accumulatedDepreciation ?? 0;
    const adjustedBasis  = Math.max(0, costBasis - accumulatedDep);
    const rawGain     = Math.max(0, salePrice - adjustedBasis);
    // IRC §121 (design 83 G7 step 5), through the shared rules module. Routed through
    // the same helper the AU dwelling uses, because the alternative was a double
    // standard pointing the wrong way: the AU house would face the 2-of-5 use test and
    // the §121(b)(5) nonqualified-use proration while the US house next to it kept a
    // flat "primary residence ⇒ full cap". Nothing about §121 is location-aware.
    //
    // Behaviour-preserving for every pre-G7 property: one with `isPrimaryResidence:
    // true` and no dates is a main residence THROUGHOUT, so its nonqualified fraction
    // is 0 and the exclusion is the whole cap, exactly as before.
    const s1250Gain   = unrecaptured1250Gain(rawGain, accumulatedDep);
    const s121        = us121Exclusion(propState, {
      gain: rawGain, depreciationGain: s1250Gain,
      acquisitionMs: toMs(propState?.acquisitionDate),
      saleMs: eventMs ?? state.currentPeriods?.US?.startMs ?? null,
      filingSingle: state.usFilingSingle === true,
    });
    // Depreciation is never excludable and is taxed in its own §1250 bucket, so it
    // leaves the LTCG figure entirely rather than being netted against the exclusion.
    const taxableGain = Math.max(0, rawGain - s1250Gain - s121.excluded);

    // AU assessment of the foreign (US) house for an AU resident (design 62 §5):
    // an AU resident is taxable on worldwide capital gains. The AU gain is measured
    // from the s855-45 stepped-up basis (market value at the move, stamped on the
    // property state as costBaseByCountry.AU), reduced by the AU main-residence
    // exemption. The US §121 exclusion stays US-side only. When the property was not
    // stepped up (domestic/TAP, or not owned at the move) auBasis is absent ⇒ no AU
    // gain here. Both figures are in the property currency (USD); the AU classifier
    // converts. Indexation is deferred for property (design 57 §6.4), matching AU_HOUSE.
    const auBasis   = propState?.costBaseByCountry?.AU;
    let auGain = 0, auDiscountableGain = 0;
    if (auBasis != null && residency === 'AU') {
      const saleMs      = eventMs ?? state.currentPeriods?.AU?.startMs ?? state.currentPeriods?.US?.startMs ?? null;
      const deemedAcqMs = propState.acquisitionDateByCountry?.AU ?? null;
      const auRawGain   = Math.max(0, salePrice - auBasis);
      const exemptFrac  = auMainResidenceExemptFraction(propState, deemedAcqMs, saleMs);
      auGain = +(auRawGain * (1 - exemptFrac)).toFixed(2);
      // CGT 50%-discount eligibility (design 62 §4): held ≥12 months from the deemed
      // acquisition. The non-exempt slice is discountable only when held long enough.
      const held12mo = deemedAcqMs != null && saleMs != null && (saleMs - deemedAcqMs) >= YEAR_MS;
      auDiscountableGain = held12mo ? auGain : 0;
    }

    // Design 90 §9 step 2 — the signed, §1222-charactered split, and the ONE disposal
    // in the model where the existing `Math.max(0, …)` floor is not a defect.
    //
    // IRC §165(c) limits an individual's loss deduction to (1) a trade or business,
    // (2) a transaction entered into for profit, and (3) casualty or theft. A home sold
    // below basis is none of the three, so the loss is simply **not deductible** — the
    // floor on `rawGain` above is the correct answer for a residence and the wrong one
    // for a rental. `deductibleLoss` is what splits them, and it keys off the same
    // `isPrimaryResidence` flag the §121 exclusion already gates on, so a property
    // cannot claim the exclusion on the way up and the loss on the way down.
    //
    // Depreciation is the tell: a property that has taken depreciation was held for the
    // production of income, which is §165(c)(2) territory whatever the flag says.
    const saleMs = eventMs ?? state.currentPeriods?.US?.startMs ?? null;
    const deductibleLoss = propState?.isPrimaryResidence !== true || accumulatedDep > 0;
    const { usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain } =
      singleAssetTermFields({
        proceeds: salePrice, usBasis: adjustedBasis, auBasis: auBasis ?? adjustedBasis,
        acquisitionMs:   toMs(propState?.acquisitionDate),
        auAcquisitionMs: propState?.acquisitionDateByCountry?.AU ?? toMs(propState?.acquisitionDate),
        saleMs, deductibleLoss,
      });

    const destKey     = resolveDestinationCashKey(this.stateRegistry, 'US', state, destinationKey);
    // Mirror of the AU path: a US property may name an AUD account as its destination,
    // and `transaction` would credit USD proceeds as AUD. See `creditSaleProceeds`.
    const { transfer: fxLeg } = creditSaleProceeds(
      this.accountService, state, destKey, netProceeds,
      propState?.currency?.code ?? 'USD', stateKey, null);
    const updates = {};
    if (stateKey && state[stateKey]) {
      updates[stateKey] = { ...state[stateKey], mortgageBalance: 0, value: 0 };
    }
    // Design 54 P2: the debt lives on the linked Loan — the sale pays it off, so
    // close the loan (balance 0) alongside zeroing the property value.
    const loan = stateKey ? findLoanForProperty(state, stateKey) : null;
    if (loan) {
      updates[loan.stateKey] = { ...loan, balance: 0 };
    }
    return this.newState(
      state,
      updates,
      // Emit the realized gain under the family-standard `gain` field (shared by
      // every CAPITAL_GAINS disposal type) so the Capital Gains by Disposal report
      // aggregates it uniformly. proceeds/costBasis/description give the report a
      // readable, drillable row.
      [...(fxLeg ? [fxLeg] : []), {
        type:        'US_HOUSE_SALE_TAX',
        gain:        taxableGain,
        // Unrecaptured §1250 gain rides alongside rather than inside `gain`: it is
        // taxed at its own ceiling, so folding it into the LTCG figure is exactly the
        // defect G7 step 3b exists to fix.
        depreciationGain: s1250Gain,
        auGain,
        auDiscountableGain,
        // Design 90 §9 step 2. Note these measure from the SAME adjusted basis as
        // `gain`, but before the §121 exclusion and before the §1250 carve-out: those
        // two shrink the taxable gain and neither can create a loss, so applying them
        // here would understate a loss that §165(c) does allow on a rental.
        usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain,
        residency,
        proceeds:    salePrice,
        costBasis:   adjustedBasis,
        description: stateKey || 'usHouse',
        // Design 76 Gap B: attribute the AU gain to the property's owner(s), as
        // AU_HOUSE_SALE_TAX already does. A solely-owned US house sold by an AU
        // resident was otherwise assessed half to each spouse.
        ownershipType: propState?.ownershipType,
        ownerId:       propState?.ownerId,
        owners:        propState?.owners,
      }]
    );
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export class UsHouseSaleHandler extends HandlerEntry {
  static type        = 'UsHouseSaleHandler';
  static description = 'Dispatches US_HOUSE_SALE_APPLY with sale price, cost basis, current mortgage balance, and resolved destination account.';
  static eventType   = 'US_HOUSE_SALE';

  constructor() {
    super(null, 'US House Sale');
    this.generatedActionTypes = ['US_HOUSE_SALE_APPLY', 'RECORD_BALANCE'];
  }

  call({ data, state }) {
    const propState       = data.stateKey ? state[data.stateKey] : null;
    // Design 54 P2: the payoff amount is the linked Loan's balance, not the
    // retired property scalar (now always 0).
    const loan            = data.stateKey ? findLoanForProperty(state, data.stateKey) : null;
    const mortgageBalance = loan?.balance ?? propState?.mortgageBalance ?? 0;
    const destinationKey  = resolveDestinationKey(state, data.saleDestinationAccount);
    const actions = [
      {
        type:            'US_HOUSE_SALE_APPLY',
        salePrice:       data.salePrice ?? propState?.value ?? 0,
        // Add any capitalized repairs accrued during the sim (design 75 §8 Q6). The
        // accumulator is 0 by default ⇒ inert; a positive value lifts basis and cuts CGT.
        costBasis:       data.costBasis + (propState?.capitalizedImprovements ?? 0),
        mortgageBalance,
        residency:       state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
        stateKey:        data.stateKey ?? null,
        destinationKey,
      },
      new RecordBalanceAction(`${destinationKey}.balance`, destinationKey),
    ];
    // Design 54 P2: the sale pays off the linked loan (balance → 0). The loan's
    // metric series is otherwise only recorded by LOAN_PAYMENT, which skips a
    // zero-balance loan, so its chart would freeze at the pre-sale balance.
    // Snapshot the loan here (after US_HOUSE_SALE_APPLY zeroes it) so the payoff
    // shows on the chart.
    if (loan) actions.push(new RecordBalanceAction(`${loan.stateKey}.balance`, loan.stateKey));
    return actions;
  }
}
