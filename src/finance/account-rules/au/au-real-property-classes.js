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
import { singleAssetTermFields } from '../../holdings/holding-period.js';
import { resolveDestinationCashKey, resolveSaleDestinationKey } from '../cash-routing.js';
import { auMainResidenceExemption, unrecaptured1250Gain, toMs } from '../main-residence.js';
import { downsizerContributions } from './downsizer-contribution.js';
import { ownershipFractions } from '../../ownership-utils.js';

/** Default AU cash pool key when no saleDestinationAccount is provided. */
const defaultAuCashKey = (state) =>
  state.auSavingsAccount != null ? 'auSavingsAccount' : 'checkingAccount';

/**
 * Resolve the destination state key, falling back to the default AU cash pool.
 * Delegates to the shared resolver so a `saleDestinationAccount` persisted as an
 * account *id* rather than a state key still finds its account (design 72 §2).
 */
const resolveDestinationKey = (state, saleDestinationAccount) =>
  resolveSaleDestinationKey(state, saleDestinationAccount, defaultAuCashKey(state));

// ─── Reducer ──────────────────────────────────────────────────────────────────

/**
 * EVT-33: AU house sale — credit destination account with sale proceeds net of
 * mortgage payoff, compute capital gain (unaffected by mortgage), and chain
 * AU_HOUSE_SALE_TAX.
 */
export class AuHouseSaleApplyReducer extends AccountServiceReducer {
  static type        = 'AuHouseSaleApplyReducer';
  static description = 'Credits the destination account with net proceeds (salePrice − mortgage), zeroes mortgageBalance, and chains AU_HOUSE_SALE_TAX with the capital gain.';
  static actionType  = 'AU_HOUSE_SALE_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('AU House Sale Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['AU_HOUSE_SALE_APPLY'];
    this.generatedActionTypes = ['AU_HOUSE_SALE_TAX', 'SUPER_DOWNSIZER_CONTRIBUTION_APPLY'];
  }

  reduce(state, action) {
    const { salePrice, costBasis, mortgageBalance, residency, ownershipType, ownerId, owners, stateKey, destinationKey } = action;
    const mortgage    = mortgageBalance ?? 0;
    const netProceeds = Math.max(0, salePrice - mortgage);
    // Div 43 capital-works deductions taken during the hold reduce the CGT cost
    // base, so the gain is larger (design 48 §4.5). accumulatedDepreciation is 0
    // for non-rental properties, so this is a no-op there.
    const propState      = stateKey ? state[stateKey] : null;
    const accumulatedDep = propState?.accumulatedDepreciation ?? 0;
    const adjustedBasis  = Math.max(0, costBasis - accumulatedDep);
    const gain        = Math.max(0, salePrice - adjustedBasis);

    // Design 83 G7 steps 1–2 + 3b. Three figures leave here instead of one, because
    // the two countries tax three different slices of the same disposal:
    //
    //   · `auTaxableFraction` — s118-185 after the s118-110(3) foreign-resident gate.
    //     AU-side only: the US grants no relief for an Australian main residence beyond
    //     its own §121, so this must NOT reduce the US gain.
    //   · `depreciationGain` — the Div 43 / §168 slice. Australia already handles it
    //     correctly by the basis reduction above (s110-45(2)), and it rides the
    //     exemption and the discount like any other gain. The United States taxes it as
    //     unrecaptured §1250 gain at a 25% ceiling and §121 can never exclude it, so it
    //     has to travel separately.
    //   · `gain` — the whole thing, which is what the US starts from.
    const saleMs = state.currentPeriods?.AU?.startMs ?? state.currentPeriods?.US?.startMs ?? null;
    const auExemption = auMainResidenceExemption(propState, {
      acquisitionMs:   toMs(propState?.acquisitionDate),
      saleMs,
      residencyAtSale: residency,
    });
    // ITAA97 s292-102 — the downsizer super contribution. Emitted from the sale rather
    // than scheduled separately because every one of its gates is a fact about THIS
    // disposal: the exemption fraction just computed, the ownership period, the sale
    // proceeds, and who owned it. The 90-day window the statute allows is collapsed to
    // the sale date, which is the right simplification here — nothing in the model can
    // use the float, and modelling it would only add a lag with no decision attached.
    const owners_ = ownershipFractions({ ownershipType, ownerId, owners }, state.people ?? {})
      .map(({ personKey, fraction }) => ({
        personKey, fraction,
        birthDate: state.people?.[personKey]?.birthDate ?? null,
      }));
    const downsizer = downsizerContributions({
      prop: propState, proceeds: salePrice, exemptFraction: auExemption.exemptFraction,
      acquisitionMs: toMs(propState?.acquisitionDate), saleMs, owners: owners_,
    });
    const downsizerActions = downsizer.contributions.map(c => ({
      type: 'SUPER_DOWNSIZER_CONTRIBUTION_APPLY',
      personKey: c.personKey, amount: c.amount, reason: downsizer.reason,
    }));

    // Design 90 §9 step 2 — the signed, §1222-charactered split. Same §165(c) gate as
    // the US dwelling: a loss on a personal residence is not deductible, and a
    // depreciation history is the tell that the property was held to produce income.
    // The AU side has no equivalent bar — s102-10 lets a capital loss offset capital
    // gains whatever the asset — but the main-residence EXEMPTION does the analogous
    // job, and a wholly-exempt dwelling's loss is disregarded with its gain.
    const deductibleLoss = propState?.isPrimaryResidence !== true || accumulatedDep > 0;
    const { usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain } =
      singleAssetTermFields({
        proceeds: salePrice, usBasis: adjustedBasis,
        auBasis: propState?.costBaseByCountry?.AU ?? adjustedBasis,
        acquisitionMs:   toMs(propState?.acquisitionDate),
        auAcquisitionMs: propState?.acquisitionDateByCountry?.AU ?? toMs(propState?.acquisitionDate),
        saleMs, deductibleLoss,
      });

    const destKey     = resolveDestinationCashKey(this.stateRegistry, 'AU', state, destinationKey);
    this.accountService.transaction(state[destKey], netProceeds, null);
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
    const description = stateKey && state[stateKey]?.name
      ? state[stateKey].name
      : (stateKey ?? 'AU Real Property');
    return this.newState(
      state,
      updates,
      [...downsizerActions,
       { type: 'AU_HOUSE_SALE_TAX', gain, residency, ownershipType, ownerId, owners,
         usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain,
         proceeds: salePrice, costBasis: adjustedBasis, description,
         // G7: the AU-assessable slice after s118-185, and the §1250 slice the US
         // taxes at its own rate. Both default to the pre-G7 answer — taxableFraction
         // 1 and a 0 depreciation slice — for any property that states no history.
         auTaxableFraction: auExemption.taxableFraction,
         auExemptionReason: auExemption.reason,
         depreciationGain:  unrecaptured1250Gain(gain, accumulatedDep),
         acquisitionMs:     toMs(propState?.acquisitionDate),
         saleMs,
         mainResidenceFrom:  propState?.mainResidenceFrom  ?? null,
         mainResidenceUntil: propState?.mainResidenceUntil ?? null,
         isPrimaryResidence: propState?.isPrimaryResidence ?? false }]
    );
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export class AuHouseSaleHandler extends HandlerEntry {
  static type        = 'AuHouseSaleHandler';
  static description = 'Dispatches AU_HOUSE_SALE_APPLY with sale price, cost basis, current mortgage balance, and resolved destination account.';
  static eventType   = 'AU_HOUSE_SALE';

  constructor() {
    super(null, 'AU House Sale');
    this.generatedActionTypes = ['AU_HOUSE_SALE_APPLY', 'RECORD_BALANCE'];
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
        type:            'AU_HOUSE_SALE_APPLY',
        salePrice:       data.salePrice ?? propState?.value ?? 0,
        // Capitalized repairs accrued during the sim (design 75 §8 Q6); 0 by default ⇒ inert.
        costBasis:       data.costBasis + (propState?.capitalizedImprovements ?? 0),
        mortgageBalance,
        residency:       state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null,
        ownershipType:   data.ownershipType,
        ownerId:         data.ownerId,
        owners:          data.owners,
        stateKey:        data.stateKey ?? null,
        destinationKey,
      },
      new RecordBalanceAction(`${destinationKey}.balance`, destinationKey),
    ];
    // Design 54 P2: the sale pays off the linked loan (balance → 0). The loan's
    // metric series is otherwise only recorded by LOAN_PAYMENT, which skips a
    // zero-balance loan, so its chart would freeze at the pre-sale balance.
    // Snapshot the loan here (after AU_HOUSE_SALE_APPLY zeroes it) so the payoff
    // shows on the chart.
    if (loan) actions.push(new RecordBalanceAction(`${loan.stateKey}.balance`, loan.stateKey));
    return actions;
  }
}
