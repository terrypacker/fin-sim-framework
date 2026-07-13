/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { primaryResidencyState, primaryPersonKey, getResidency } from '../../residency-utils.js';
import { toCcy } from '../tax-fx.js';

/**
 * State income classification (design 34 §5).
 *
 * Unlike the federal classification (which varies year over year and so needs a
 * per-year BaseTaxModule), US state taxable income conforms to the same federal
 * income events — only the *rates/treatment* differ by state and year, and those
 * live in StateTaxSettleService. So classification is a single, shared routing
 * table that folds each federal income `*_TAX` action into one of four
 * household state accumulators; each state's rates module then decides what is
 * actually taxable (SS exclusion, pension exclusion, CG treatment).
 *
 * Gating: a row contributes only when (a) a state is configured on the primary
 * person (`primaryResidencyState`) and (b) the income is US-resident income —
 * `action.residency` when present (precise for a part-year move), else the
 * primary person's residency country.
 *
 * Deliberately NOT classified: Roth qualified distributions / rollovers
 * (federally tax-free; states conform) and pre-tax IRA/401k contributions
 * (a state subtraction; deferred — see design 34 §12).
 */
export const STATE_INCOME_ROUTING = Object.freeze({
  // ── Ordinary income (action.amount) ──
  WAGES_INCOME_TAX:            { bucket: 'stateOrdinaryIncomeYTD', field: 'amount' },
  SE_INCOME_US_TAX:            { bucket: 'stateOrdinaryIncomeYTD', field: 'amount' },
  BONUS_TAX:                   { bucket: 'stateOrdinaryIncomeYTD', field: 'amount' },
  STOCK_DIVIDEND_TAX:          { bucket: 'stateOrdinaryIncomeYTD', field: 'amount' },
  FIXED_INCOME_EARNINGS_TAX:   { bucket: 'stateOrdinaryIncomeYTD', field: 'amount' },
  // Interest income. A state resident is taxed on worldwide income, so AU
  // savings/fixed-income interest (which also feeds federal usOrdinaryIncomeYTD
  // for a US resident) belongs in the state base too. US_SAVINGS_INTEREST_CREDIT
  // is not a `*_TAX` action — it bumps usOrdinaryIncomeYTD directly in its
  // reducer — but is state-taxable all the same. The reconciliation guard in
  // state-tax-rates / accounting tests keeps this list complete vs. the federal base.
  US_SAVINGS_INTEREST_CREDIT:  { bucket: 'stateOrdinaryIncomeYTD', field: 'amount' },
  // Bond coupon interest (design 59). Routes on `stateTaxableAmount` — the coupon
  // EXCLUDING direct U.S. Treasury holdings, which are state-exempt (31 U.S.C.
  // § 3124) — with `amount` as the fallback for any coupon action stamped without
  // the split. Federally the full `amount` is taxed (see the US tax module).
  BOND_COUPON_TAX:             { bucket: 'stateOrdinaryIncomeYTD', field: 'stateTaxableAmount', fallbackField: 'amount' },
  // AU-source interest is AUD; the state accumulator is USD-canonical (design 51),
  // so these rows carry `ccy: 'AUD'` to convert the amount before folding it in.
  AU_SAVINGS_EARNINGS_TAX:     { bucket: 'stateOrdinaryIncomeYTD', field: 'amount', ccy: 'AUD' },
  AU_FIXED_INCOME_EARNINGS_TAX:{ bucket: 'stateOrdinaryIncomeYTD', field: 'amount', ccy: 'AUD' },

  // ── Pension / retirement distributions (action.amount), segregated for exclusions ──
  IRA_WITHDRAWAL_CONTRIB_TAX:  { bucket: 'statePensionIncomeYTD', field: 'amount' },
  IRA_WITHDRAWAL_EARNINGS_TAX: { bucket: 'statePensionIncomeYTD', field: 'amount' },
  K401_WITHDRAWAL_TAX:         { bucket: 'statePensionIncomeYTD', field: 'amount' },
  K401_RMD_TAX:                { bucket: 'statePensionIncomeYTD', field: 'amount' },
  IRA_RMD_TAX:                 { bucket: 'statePensionIncomeYTD', field: 'amount' },
  IRA_ROLLOVER_WITHDRAWAL_TAX: { bucket: 'statePensionIncomeYTD', field: 'amount' },
  ROTH_CONVERSION_TAX:         { bucket: 'statePensionIncomeYTD', field: 'amount' },

  // ── Social Security (gross action.amount; states decide taxability) ──
  SS_INCOME_TAX:               { bucket: 'stateSsIncomeYTD', field: 'amount' },

  // ── Capital gains (action.gain) ──
  STOCK_WITHDRAWAL_TAX:        { bucket: 'stateCapitalGainsYTD', field: 'gain' },
  US_HOUSE_SALE_TAX:           { bucket: 'stateCapitalGainsYTD', field: 'gain' },
  COMPANY_SALE_TAX:            { bucket: 'stateCapitalGainsYTD', field: 'gain' },
  COLLECTIBLE_SALE_TAX:        { bucket: 'stateCapitalGainsYTD', field: 'gain' },
});

/** The four household accumulators populated by classification (reset at settle). */
export const STATE_YTD_FIELDS = Object.freeze([
  'stateOrdinaryIncomeYTD',
  'statePensionIncomeYTD',
  'stateSsIncomeYTD',
  'stateCapitalGainsYTD',
]);

/**
 * One reducer per classified action type, at PRIORITY.TAX_CALC (alongside the
 * federal dynamic reducers). Folds the action's amount/gain into its state
 * accumulator when the household is US-resident in a configured state.
 */
export class StateIncomeClassificationReducer extends Reducer {
  static type        = 'StateIncomeClassificationReducer';
  static category    = 'reducer';
  static description = 'Folds a federal income *_TAX action into a US state income accumulator when the primary is a US resident in a configured state (design 34).';

  constructor(actionType) {
    super(`state:classify:${actionType}`, PRIORITY.TAX_CALC);
    const route = STATE_INCOME_ROUTING[actionType];
    if (!route) throw new Error(`StateIncomeClassificationReducer: no routing for '${actionType}'`);
    this.reducedActionTypes = [actionType];
    this._bucket = route.bucket;
    this._field  = route.field;
    this._fallbackField = route.fallbackField ?? null;  // used when the primary field is absent (design 59)
    this._ccy    = route.ccy ?? 'USD';   // native currency of the routed amount (design 51)
  }

  static fromJSON(d) {
    const actionType = (d.reducedActionTypes ?? [])[0];
    const r = new this(actionType);
    r.id = d.id;
    return r;
  }

  reduce(state, action) {
    if (!primaryResidencyState(state)) return state;                 // no state configured
    const residency = action.residency ?? getResidency(state, primaryPersonKey(state));
    if (residency !== 'US') return state;                            // not US-resident income
    // Prefer the primary field; fall back only when it's genuinely absent (not when
    // it's a legitimate 0 — a fully-Treasury coupon is state-exempt, i.e. 0). (design 59)
    let raw = action[this._field];
    if (raw == null && this._fallbackField) raw = action[this._fallbackField];
    raw = raw ?? 0;
    if (!raw) return state;
    // State buckets are USD-canonical; convert an AU-source amount at the event rate.
    const v = toCcy(raw, this._ccy, 'USD', state);
    return { ...state, [this._bucket]: (state[this._bucket] ?? 0) + v };
  }
}

/** Build the full set of state-classification reducers (one per routed action type). */
export function buildStateClassificationReducers() {
  return Object.keys(STATE_INCOME_ROUTING).map(t => new StateIncomeClassificationReducer(t));
}
