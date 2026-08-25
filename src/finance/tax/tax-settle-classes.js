/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }  from '../../simulation-framework/reducers.js';
import { HandlerEntry }        from '../../simulation-framework/handlers.js';
import { TaxSettleService }    from '../tax-settle-service.js';
import { InsufficientFundsError } from '../assets/account.js';
import { ACCOUNT_ROLES } from '../state/account-roles.js';
import { toUSD, toAUD, taxFxRate } from './tax-fx.js';
import { rollUnusedConcessionalCap, concessionalCapWithCarryForward, nonConcessionalCap }
  from './au/au-super-limits.js';
import { ageAt } from '../mpc/harvest.js';
import { auFinancialYearOf } from '../payroll/au-super-caps.js';

/** Sum the numeric values of a { key: number } map (per-person accumulators). */
function _sumMap(map) {
  return map ? Object.values(map).reduce((s, v) => s + (v ?? 0), 0) : 0;
}

// YTD fields reset to zero after each annual settlement, keyed by country code.
//
// Design 52 reset asymmetry (§5): the §904/FITO income numerators and the
// current-year foreign-tax handoff reset at their own settle; the carryforward
// pools (ftcPoolGeneral/ftcPoolPassive) and the single-year usTaxPaidOnUsSourceAud
// handoff are DELIBERATELY excluded — the pools carry forward (drawn down + aged
// >10y at the US settle), and usTaxPaidOnUsSourceAud is overwritten each US settle
// and consumed (excess lost) at the next AU settle.
const YTD_FIELDS = {
  US: ['usOrdinaryIncomeYTD', 'usNegativeIncomeYTD', 'usCapitalGainsYTD', 'usCollectibleGainsYTD',
       // design 90 §4.3 — the year's short-term result. Its POOL
       // (usShortTermCapitalLossCarryforward) and the long-term pool are deliberately
       // NOT here: §1212(b) carries an unused capital loss forward indefinitely, and
       // resetting either would destroy the carryover this design exists to create.
       'usShortTermCapitalGainsYTD', 'usNetInvestmentIncomeYTD', 'usPenaltyYTD',
       // design 83 G7 step 3b — the §1250 depreciation slice; per-year like every gain bucket
       'usUnrecaptured1250GainYTD',
       // design 86 G5 — the SIGNED per-year passive results. The suspended-loss POOL
       // (usPassiveLossCarryforward) is deliberately NOT here: it must survive.
       'usPassiveActivityIncomeYTD', 'usForeignPassiveActivityIncomeYTD',
       // design 86 G3 error 1 — the year's §163(d) investment interest. Its POOL
       // (usInvestmentInterestCarryforward) is deliberately not here either: §163(d)(2)
       // carries the disallowed excess forward indefinitely.
       'usInvestmentInterestYTD',
       // design 69 — self-employment tax (SECA) accumulators
       'usSeEarningsYTD', 'usSsWagesYTD',
       // Design 95 phase 5 — payroll withholding, credited against the liability
       // below and then reset with the rest. It was written by the wages reducer and
       // read by NOTHING before this phase, and was not even in this list, so it
       // accumulated monotonically for the life of the run.
       'usWithheldYTD',
       'foreignGeneralIncomeYTD', 'foreignPassiveIncomeYTD', 'usSourceOrdinaryUsdYTD', 'usSourceCapGainsUsdYTD',
       // design 90 §4.5 — the capital-gain component of each basket. Per-year like the
       // baskets they slice; the §1212(b) POOLS above are the things that survive.
       'foreignGeneralCapGainsYTD', 'foreignPassiveCapGainsYTD',
       'usSourceGeneralCapGainsUsdYTD', 'usSourcePassiveCapGainsUsdYTD',
       // design 83 G3 — re-sourced income, split by §904 category
       'usSourceGeneralUsdYTD', 'usSourcePassiveUsdYTD',
       // design 83 G10 part 2 — treaty-rate-capped subsets of usSourceOrdinaryUsdYTD
       'usSourceDividendsUsdYTD', 'usSourceInterestUsdYTD',
       // design 52 §4.4 — the AU liability staged for THIS US return, unapportioned.
       // Resets with the rest: the US settle consumes it, splits it by full-year basket
       // income, and banks whatever the limitation could not absorb into the vintages.
       'ftcCurrentForeignTax',
       // Pre-split staging fields. Nothing writes them any more; they stay in the reset
       // so a state saved before the split moved is drained rather than double-counted.
       'ftcCurrentGeneral', 'ftcCurrentPassive', 'ftcCurrentResourced',
       // design 63 §6.5 — heir-paid NE inheritance tax (reporting bucket; debited at the inheritance date)
       'neInheritanceTaxYTD',
       // design 86 G7 / P8 — §988 exchange gain/loss on foreign-currency debt. All
       // three are per-year: §988 gain and loss are ordinary and current, with no
       // carryforward of their own (a loss that outruns income becomes an NOL, which
       // this model does not have — stated in design 86 §3 "Out of scope").
       'usSection988GainYTD', 'usSection988LossYTD', 'usSection988DisallowedLossYTD'],
  AU: ['auOrdinaryIncomeYTD', 'auCapitalGainsYTD', 'auDiscountableGainsYTD',
       // design 83 G7 step 3 — s115-115 apportionment
       'auDiscountApportionedBaseYTD', 'auDiscountAllowanceYTD', 'auRealCapitalGainsYTD', 'auNonResidentWithholdingYTD', 'auSuperTaxYTD', 'auFrankingCreditYTD',
       // design 73 Gap 2 — per-type non-resident final withholding
       'auNrWithholdingInterestYTD', 'auNrWithholdingUnfrankedDividendYTD',
       'usSourceOrdinaryAudYTD', 'usSourceCapGainsAudYTD', 'usSourceRealCapGainsAudYTD',
       // design 63 §6.4 — AU super death-benefit tax (reporting bucket; withheld from the net lump sum)
       'auSuperDeathTaxYTD',
       // design 95 §9.1 phase 6b — s290-150 deductible contributions. Deductible ONLY
       // in the income year the contribution was made (s290-150(3)), so this resets
       // with the FY and never carries: an unused deduction is lost, not banked.
       'auDeductibleSuperYTD'],
};

/**
 * Per-person US accumulator maps reset after each US settlement (design 95 §7.3).
 *
 * `k401ContributionsYTD` is `{ personKey: { deferral, additions } }` — §402(g) and
 * §414(v) measure the employee's own deferrals, §415(c) measures all annual
 * additions including the employer's. Both are per TAXABLE YEAR, so both die here.
 *
 * Without this reset the totals accumulate for the life of the run and §415(c)
 * silently strangles every contribution once the balance passes the annual-additions
 * limit — which is exactly what the golden caught on the first run of phase 3.
 */
const PER_PERSON_US_FIELDS = ['k401ContributionsYTD'];

/** Per-person US accumulators that reset to a plain 0 rather than to an object. */
const PER_PERSON_US_SCALAR_FIELDS = ['usSsWagesByPersonYTD'];

// Per-person AU accumulator maps reset to zero after each AU settlement.
const PER_PERSON_AU_FIELDS = [
  'auPersonOrdinaryIncomeYTD',
  'auPersonCapitalGainsYTD',
  'auPersonDiscountableGainsYTD',
  'auPersonDiscountApportionedBaseYTD',
  'auPersonDiscountAllowanceYTD',
  'auPersonRealCapitalGainsYTD',
  'auPersonFrankingCreditYTD',
  'auPersonNonResidentWithholdingYTD',
  'auPersonNrWithholdingInterestYTD',
  'auPersonNrWithholdingUnfrankedDividendYTD',
  'auPersonSuperTaxYTD',
  'auPersonEarnedIncomeYTD',
  'auPersonUsSourceOrdinaryAudYTD',
  'auPersonUsSourceCapGainsAudYTD',
  'auPersonUsSourceRealCapGainsAudYTD',
  'auPersonDeductibleSuperYTD',
];

/**
 * The Art. 22(2) counterfactual: this taxpayer's state with every trace of US-source
 * income removed — design 52 §4.6, corrected by design 83 G8.
 *
 * Exported because more than one caller needs it and they must not drift apart. The
 * FITO handoff builds it, and so does any probe measuring that handoff; when this
 * lived inline in the handler, a probe's copy silently went stale the moment G3 added
 * the per-character accumulators, and the §904 invariants caught it as a partition
 * violation rather than as the duplication it was.
 *
 * Everything the US-source income created has to go with it: the tax buckets, the
 * §904 limitation room it opened (`usSource{General,Passive}UsdYTD`), and the AU tax
 * staged against that room. Leaving any of them behind produces a return that claims
 * relief for income it no longer contains, at a *larger* limitation fraction than the
 * real one — which understates the counterfactual's tax, widens the differential, and
 * over-funds Australia's FITO.
 *
 * @param {object} state
 * @returns {object} a new state; the input is not mutated
 */
export function withoutUsSourceIncome(state, { keepTreatyCapped = false } = {}) {
  // Design 83 G10 part 2 — `keepTreatyCapped` leaves the dividend and interest slices
  // in place, so a second counterfactual can isolate the US tax attributable to the
  // rate-capped items from the tax on everything else. Both are always passive, which
  // is why only the passive basket needs the adjustment.
  const capped = keepTreatyCapped
    ? (state.usSourceDividendsUsdYTD ?? 0) + (state.usSourceInterestUsdYTD ?? 0)
    : 0;
  return {
    ...state,
    usOrdinaryIncomeYTD:     (state.usOrdinaryIncomeYTD ?? 0) - (state.usSourceOrdinaryUsdYTD ?? 0) + capped,
    usCapitalGainsYTD:       (state.usCapitalGainsYTD   ?? 0) - (state.usSourceCapGainsUsdYTD ?? 0),
    usSourceOrdinaryUsdYTD:  capped,
    usSourceCapGainsUsdYTD:  0,
    usSourceGeneralUsdYTD:   0,
    usSourcePassiveUsdYTD:   capped,
    // Design 90 §4.5 — the capital slices go with the buckets they slice. `capped` is
    // dividends and interest, both ordinary, so the capital component of what survives
    // is zero rather than `capped`. Leaving these behind would let the counterfactual
    // compute Pub 514's adjustment against foreign-source capital gain it no longer
    // contains — the same shape of error G8 records for the buckets themselves.
    usSourceGeneralCapGainsUsdYTD: 0,
    usSourcePassiveCapGainsUsdYTD: 0,
    usSourceDividendsUsdYTD: keepTreatyCapped ? (state.usSourceDividendsUsdYTD ?? 0) : 0,
    usSourceInterestUsdYTD:  keepTreatyCapped ? (state.usSourceInterestUsdYTD  ?? 0) : 0,
    // Pre-G3 saved states only; `_computeFtc` folds these into general, so the
    // counterfactual has to drop them for the same reason as the rest.
    ftcCurrentResourced:     0,
    ftcPoolResourced:        {},
  };
}

/**
 * Art. 10(2)(b) — the US may tax dividends paid to an Australian resident at no more
 * than **15 percent of the gross amount**. (The 5% rate in sub-paragraph (a) is for a
 * company holding ≥10% of the voting power, which an individual never is.)
 */
const TREATY_DIVIDEND_CAP = 0.15;

/**
 * Art. 11(2) — the US may tax interest arising in the US at no more than **10 percent
 * of the gross amount**. The paragraph (3) exemptions cover governments, central banks
 * and unrelated financial institutions, none of which is an individual investor.
 */
const TREATY_INTEREST_CAP = 0.10;

// ─── TaxSettleHandler base + per-country subclasses ───────────────────────────

class TaxSettleHandlerBase extends HandlerEntry {
  static cc;
  static settleActionType;

  constructor() {
    super(null, `${new.target.cc} Tax Settle`);
    this._settleService = new TaxSettleService();
    this.generatedActionTypes = [new.target.settleActionType, 'RECORD_BALANCE'];
  }
}

/**
 * Fires at the end of each US tax year (scheduled by TaxService).
 *
 * Computes the US tax liability via TaxSettleService, then emits:
 *   US_TAX_SETTLE_APPLY — resets US YTD fields and chains US_TAX_PAYMENT_DEBIT if tax > 0
 *   RECORD_BALANCE      — captures a post-settlement balance snapshot
 */
export class UsTaxSettleHandler extends TaxSettleHandlerBase {
  static type             = 'UsTaxSettleHandler';
  static category         = 'handler';
  static cc               = 'US';
  static settleActionType = 'US_TAX_SETTLE_APPLY';
  static eventType        = 'TAX_SETTLE_US';
  static description      = 'Computes end-of-year US tax liability and emits US_TAX_SETTLE_APPLY + RECORD_BALANCE.';

  call({ state }) {
    // No US person in this household ⇒ no US return. `usPersonHousehold` is stamped
    // once at compile time from the configured persons (US_TAX.state()), NOT read
    // from live `state.people`, because a year-of-death settle runs after the
    // decedent has been dropped from that map and must still be lodged.
    //
    // The narrow reason this gate exists: every AU classifier books its income into
    // `usOrdinaryIncomeYTD` unconditionally, on the stated assumption that "the
    // model's earners are US citizens" (au-tax-module-2026, bookAuPersonalServicesIncome).
    // That held while every scenario was a US household. It stopped holding with the
    // AU single-homeowner scenario, where it produced a full US return — and an
    // unfundable US tax bill — for an Australian with no US connection at all.
    //
    // LIMITATION, stated because the gate is broader than the defect: a nonresident
    // alien with genuine US-SOURCE income does owe US tax, and this suppresses that
    // too. No scenario reaches it today (US-source income only arises here from US
    // accounts, which only US households hold). Narrowing it means gating each
    // classifier on the earner instead, which is the thirteen-site change this one
    // is standing in for.
    if (state.usPersonHousehold === false) return [];

    const taxDetail = this._settleService.computeUsTax(state);

    // Design 52 §4.6 — fund the AU FITO. Measure the *marginal* US tax caused by
    // US-source income via a second pure pass (disregard the US-source removal
    // set), and hand it to the AU side in AUD for the next AU FY settle. The
    // with/without pass is exact where a proportional split is not: it holds FEIE
    // and the AU-source FTC constant and reflects that US-source income consumes
    // §904 headroom (removing it raises the foreign fraction in the "without" pass).
    //
    // Design 83 G8: the counterfactual is "this taxpayer had no US-source income",
    // so everything that income created has to go with it — the tax buckets, the
    // §904 limitation room, and the AU tax staged against that room. Leaving any of
    // them behind produced a return that claimed relief for income it no longer
    // contained, and because totalTaxable fell while the numerators held, at a
    // *larger* limitation fraction than the real return. The "without" pass then
    // paid LESS tax than it should, which widened the differential, OVER-stated the
    // US tax on US-source income, and over-funded Australia's FITO. Measured on the
    // reference plan: fixing this raises lifetime AU tax ~A$64k and lowers lifetime
    // US tax ~US$43k (the extra AU tax returns as FTC).
    //
    // After G3 the re-sourced income lives in the general/passive baskets, so the
    // per-character accumulators come out too. This is exactly why they are tracked
    // apart from foreign*IncomeYTD: a merged accumulator cannot be un-merged here.
    //
    // Design 83 G5 — the differential is taken on `regularTax`, NOT `netLiability`.
    //
    // Art. 22(2) speaks of United States tax "paid", which reads as post-credit and is
    // what this line used to compute. Art. 22(4) then adds the sentence that exists
    // precisely to stop that reading eroding it: "The credit so allowed against United
    // States tax **shall not reduce that portion of the United States tax that is
    // creditable against Australian tax in accordance with paragraph (2)**." So the
    // 22(2) portion must be measured with the 22(4) credit disregarded, and the 22(4)
    // credit computed against it — a one-directional dependency, which is why the
    // treaty states the paragraphs in that order.
    //
    // §11 offered a narrower option (a): suppress only the re-sourced basket. G3
    // deleted that basket, and §14.5 measured (a) as an exact no-op afterwards. The
    // objection §11 raised to this broader form — "the general/passive credits are not
    // 22(4) relief" — was true only while the third basket existed. Australia is the
    // model's only foreign taxing jurisdiction, so **every** credit in every basket is
    // credit for Australian income tax allowed under Art. 22(1)/(4), and the whole of
    // it is what the non-erosion sentence protects against. That also makes §14.5's
    // "apportion a blended basket credit between its foreign and re-sourced halves"
    // moot: there is nothing to apportion when both halves are 22(4) relief.
    //
    // `regularTax` and not `grossTax`: §26(b)(1) Chapter-1 income tax, so the §72(t)
    // additional tax, NIIT, SECA and the Additional Medicare surtax stay out — the same
    // line design 83 G2 drew for the §904 limitation base, and the same one Art. 2
    // (Taxes Covered) draws for what Australia is being asked to credit.
    const usTaxWithout   = this._settleService.computeUsTax(withoutUsSourceIncome(state)).regularTax;
    const marginalOnAll  = Math.max(0, taxDetail.regularTax - usTaxWithout);

    // Design 83 G10 part 2 — cap the rate-capped slices at what the treaty allows.
    //
    // Art. 22(2) lets Australia credit "United States tax paid … in respect of income
    // derived from sources in the United States", and Art. 10(2)(b)/11(2) cap what the
    // US may charge a resident of Australia on dividends and interest at 15% and 10%
    // of the GROSS amount. The marginal figure above is the *citizen's* rate, which is
    // higher; the excess is US tax imposed by reason of citizenship, and Art. 22(2)
    // expressly excludes that (Art. 27(1)(b) refuses to deem it US-source at all).
    //
    // Decomposed by chaining two counterfactuals rather than apportioning:
    //   marginalOnUncapped = full − (full without the uncapped items)
    //   marginalOnCapped   = marginalOnAll − marginalOnUncapped
    // Marginal attribution is order-dependent, so the order is a choice: uncapped
    // first, then the capped slice on top. That is the conservative reading for the
    // cap — the capped items are measured at the taxpayer's HIGHEST rates, so the
    // ceiling binds where it should rather than being flattered by a low-bracket
    // measurement. The two parts still sum to marginalOnAll exactly.
    //
    // `min` and not a flat substitution: the treaty caps the credit, it does not
    // create one. Where the actual US tax on the slice is below the ceiling — a
    // qualified dividend inside the 0% LTCG bracket, or a year the FTC already wiped
    // the liability — Australia may credit only the tax actually paid.
    const cappedGross = (state.usSourceDividendsUsdYTD ?? 0) + (state.usSourceInterestUsdYTD ?? 0);
    let usTaxOnUsSource = marginalOnAll;
    if (cappedGross > 0) {
      // Design 83 G5 — `regularTax` here too, so both legs of the decomposition are
      // measured on the same pre-credit basis and still sum to marginalOnAll exactly.
      const usTaxWithoutUncapped = this._settleService
        .computeUsTax(withoutUsSourceIncome(state, { keepTreatyCapped: true })).regularTax;
      const marginalOnUncapped = Math.max(0, taxDetail.regularTax - usTaxWithoutUncapped);
      const marginalOnCapped   = Math.max(0, marginalOnAll - marginalOnUncapped);
      const treatyCeiling      = TREATY_DIVIDEND_CAP * (state.usSourceDividendsUsdYTD ?? 0)
                               + TREATY_INTEREST_CAP * (state.usSourceInterestUsdYTD  ?? 0);
      // Stated as "either the ceiling binds or it does not", rather than as
      // `uncapped + min(capped, ceiling)`. The two agree whenever the decomposition
      // is monotone, but the zero clamps above can make the parts sum to slightly
      // more than the whole in a year where removing income RAISES tax (the §904
      // limitation is not monotone in income). Writing it this way means a
      // non-binding ceiling is exactly inert instead of leaving a rounding scar on
      // the handoff — which is what the reference plan showed: the ceiling never
      // binds there, and the naive form still shifted lifetime tax by ~\$2k.
      usTaxOnUsSource = marginalOnCapped > treatyCeiling
        ? marginalOnUncapped + treatyCeiling
        : marginalOnAll;
    }
    const usTaxPaidOnUsSourceAud = toAUD(usTaxOnUsSource, 'USD', state);

    return [
      // fxRate rides on the settlement so the return can state the USD/AUD rate
      // behind its converted figures (see taxFxRate for what it does and does
      // not cover). Declared in the US_TAX toolset's action fields, so it
      // survives into `action.data` for the document modules and the CSV export.
      // `tax` stays the full liability so `cumulativeTaxesPaid` keeps counting the
      // tax the household actually bore. `withheld` is what payroll already took, and
      // only the difference is debited from cash (design 95 §8.2).
      { type: 'US_TAX_SETTLE_APPLY', tax: taxDetail.netLiability,
        withheld: +(state.usWithheldYTD ?? 0).toFixed(2), taxDetail, usTaxPaidOnUsSourceAud,
        fxRate: taxFxRate(state) },
      { type: 'RECORD_BALANCE' },
    ];
  }
}

/**
 * Fires at the end of each AU fiscal year (scheduled by TaxService).
 *
 * Computes the AU tax liability via TaxSettleService.  When per-person data is
 * available, uses per-person breakdown; otherwise falls back to household total.
 * Emits:
 *   AU_TAX_SETTLE_APPLY — resets AU YTD fields and chains AU_TAX_PAYMENT_DEBIT if tax > 0
 *   RECORD_BALANCE      — captures a post-settlement balance snapshot
 */
export class AuTaxSettleHandler extends TaxSettleHandlerBase {
  static type             = 'AuTaxSettleHandler';
  static category         = 'handler';
  static cc               = 'AU';
  static settleActionType = 'AU_TAX_SETTLE_APPLY';
  static eventType        = 'TAX_SETTLE_AU';
  static description      = 'Computes end-of-year AU tax liability and emits AU_TAX_SETTLE_APPLY + RECORD_BALANCE.';

  call({ date, state }) {
    // Same rate on both AU paths as on the US settle — one household, one pair.
    const fxRate = taxFxRate(state);
    // Design 95 §9.3 phase 7 — the financial year this settlement CLOSES. The
    // reducer needs it to roll the unused-concessional-cap ring and cannot derive
    // it: PERIOD_ADVANCE carries no date and a reducer never sees one, so the
    // handler — the only participant holding the event date — stamps it. Absent
    // (a hand-authored settle event), the roll no-ops rather than guessing a year
    // and expiring the wrong vintage.
    const fyStartYear = date != null ? auFinancialYearOf(date) : null;
    // Design 95 §10 phase 9 — the limit index factor the year was ASSESSED under,
    // stamped for the same reason `fyStartYear` is: the reducer rolls the unused-cap
    // ring against a cap, and that cap must be the one payroll actually used all
    // year. Reading the accumulator inside the reducer would take whatever it holds
    // after the period advance, which is a different year's figure.
    const limitIndexFactor = state.limitIndexAccumulator?.AU ?? 1;

    // Design 77 §5.4 — the Div 295 fund tax accrued this FY, in AUD. It is NOT part
    // of `tax` (that is the member's own liability, and the only thing
    // AU_TAX_PAYMENT_DEBIT may draw from their cash) but it IS real tax that left
    // the household's wealth, so it rides alongside for `cumulativeTaxesPaid`.
    // Without this the MIN_LIFETIME_TAXES objective would reward shovelling money
    // into super to make a tax it is still paying disappear from the metric.
    const fundTax = (state.auSuperTaxYTD ?? 0) + _sumMap(state.auPersonSuperTaxYTD);

    if (state.auPersonOrdinaryIncomeYTD && Object.keys(state.auPersonOrdinaryIncomeYTD).length > 0) {
      const personTaxDetails = this._settleService.computeAuTaxPerPerson(state);
      if (personTaxDetails.length > 0) {
        const totalTax = personTaxDetails.reduce((sum, p) => sum + p.taxDetail.netLiability, 0);
        return [
          { type: 'AU_TAX_SETTLE_APPLY', tax: totalTax, taxDetail: null, personTaxDetails, fxRate, fundTax, fyStartYear, limitIndexFactor },
          { type: 'RECORD_BALANCE' },
        ];
      }
    }
    const taxDetail = this._settleService.computeAuTax(state);
    return [
      { type: 'AU_TAX_SETTLE_APPLY', tax: taxDetail.netLiability, taxDetail, fxRate, fundTax, fyStartYear, limitIndexFactor },
      { type: 'RECORD_BALANCE' },
    ];
  }
}

// ─── TaxSettleApplyReducer base + per-country subclasses ─────────────────────

class TaxSettleApplyReducerBase extends Reducer {
  static cc;
  static applyActionType;
  static debitActionType;

  constructor() {
    const cc = new.target.cc;
    super(`${cc} Tax Settle Apply`, PRIORITY.TAX_APPLY);
    this.reducedActionTypes   = [new.target.applyActionType];
    this.generatedActionTypes = [new.target.debitActionType];
  }

  reduce(state, action) {
    const cc = this.constructor.cc;
    const { tax } = action;
    const resets = {};
    for (const field of (YTD_FIELDS[cc] || [])) {
      if (field in state) resets[field] = 0;
    }
    if (cc === 'US') {
      // Reset each person's map to an empty entry rather than deleting the person:
      // the shape stays stable across the year boundary, which keeps the state
      // fixture's key set stable and makes a diff mean a value change.
      for (const field of PER_PERSON_US_FIELDS) {
        if (state[field]) {
          resets[field] = Object.fromEntries(
            Object.keys(state[field]).map(k => [k, { deferral: 0, additions: 0 }]));
        }
      }
      for (const field of PER_PERSON_US_SCALAR_FIELDS) {
        if (state[field]) {
          resets[field] = Object.fromEntries(Object.keys(state[field]).map(k => [k, 0]));
        }
      }
    }
    if (cc === 'AU') {
      // design/68 Gap 5: a deceased person's per-person keys must be *dropped*, not
      // just zeroed. computeAuTaxPerPerson already filed their final-year return
      // (Gap 1) before this reducer runs, so by settle time their liability is
      // banked. Leaving a lingering `{deceasedKey: 0}` entry would let any income
      // later mis-attributed to a dead key resurrect a spurious return for someone
      // gone from state.people (Gap 1 signal 2 refiles on any non-zero balance).
      // A person is deceased when they're in state.deceased and no longer living.
      const people   = state.people ?? {};
      const deadKeys = new Set(Object.keys(state.deceased ?? {}).filter(k => people[k] == null));
      for (const field of PER_PERSON_AU_FIELDS) {
        if (state[field]) {
          resets[field] = Object.fromEntries(
            Object.keys(state[field])
              .filter(k => !deadKeys.has(k))
              .map(k => [k, 0]),
          );
        }
      }
    }
    const extra = this._extraStatePatches(state, action);
    // Design 95 §8.2 — the true-up. Payroll already withheld part (or all) of this
    // liability during the year, so only the BALANCE DUE leaves cash now. Withholding
    // it and then debiting the whole liability again would charge it twice.
    //
    // `balanceDue` cannot go negative under the withholding methods phase 5 ships:
    // FICA is always a component of the liability it is credited against. A method
    // that CAN over-withhold needs a refund path, which the tax payment reducer —
    // it debits and replenishes from investments when short — does not have. Clamped
    // at zero regardless, so a future over-withholding is a visible no-refund rather
    // than a negative debit doing something unpredictable.
    const withheld   = Math.max(0, action.withheld ?? 0);
    // NOT rounded. With nothing withheld this must be `tax` to the last bit, or every
    // scenario that withholds nothing still moves by a fraction of a cent — which is
    // exactly what a whole-state fixture is built to catch, and did.
    const balanceDue = Math.max(0, tax - withheld);
    if (balanceDue > 0) {
      return this.newState({ ...state, ...resets, ...extra }, {}, [{ type: this.constructor.debitActionType, amount: balanceDue }]);
    }
    return this.newState({ ...state, ...resets, ...extra });
  }

  /**
   * Per-country cross-border-relief state written at the settle, *outside* the
   * YTD reset set (design 52). Default: none. US persists the drawn-down FTC
   * pools + the FITO handoff; AU funds the US §904 current-year foreign tax.
   */
  _extraStatePatches(_state, _action) { return {}; }
}

/**
 * Resets US YTD tax accumulators and, when the computed tax is positive,
 * chains a US_TAX_PAYMENT_DEBIT action to debit the US savings account.
 */
export class UsTaxSettleApplyReducer extends TaxSettleApplyReducerBase {
  static type            = 'UsTaxSettleApplyReducer';
  static category        = 'reducer';
  static cc              = 'US';
  static applyActionType = 'US_TAX_SETTLE_APPLY';
  static debitActionType = 'US_TAX_PAYMENT_DEBIT';
  static description     = 'Resets US YTD tax fields after settlement; persists the drawn-down §904 FTC pools + FITO handoff; chains US_TAX_PAYMENT_DEBIT when tax > 0.';

  /**
   * Persist the per-basket FTC carryforward pools (drawn down + aged in
   * computeTax, design 52 §4.3) and the FITO handoff usTaxPaidOnUsSourceAud
   * (§4.6). ftcCurrent* were consumed and reset with the other YTD fields; their
   * unused remainder is already banked into the pool vintages here.
   */
  _extraStatePatches(state, action) {
    const patches = {};
    const ftc = action.taxDetail?.ftc;
    if (ftc) {
      patches.ftcPoolGeneral   = ftc.nextPoolGeneral   ?? {};
      patches.ftcPoolPassive   = ftc.nextPoolPassive   ?? {};
      // Design 83 G4 — the re-sourced basket is gone. `_computeFtc` folded any
      // surviving balance into the general pool, so clearing it here is what makes
      // the heal idempotent: leaving it would fold the same vintages in again at
      // every subsequent settle. `ftcCurrentResourced` needs no line — it is in
      // YTD_FIELDS and resets to 0 with the rest of the US accumulators.
      patches.ftcPoolResourced = {};
    }
    // §469 suspended passive losses (design 86 G5). Same shape as the FTC pools and
    // for the same reason: `computeTax` is PURE and is re-run on counterfactual states
    // (the FITO handoff), so it reports a closing balance rather than drawing the pool
    // down in place. This is the only place the pool is written.
    const pal = action.taxDetail?.passiveLoss;
    if (pal?.closing != null) patches.usPassiveLossCarryforward = +pal.closing.toFixed(2);
    // §163(d) disallowed investment interest (design 86 G3 error 1). Same contract as
    // the §469 pool above, and the same reason it is written here rather than drawn
    // down inside computeTax.
    const invInt = action.taxDetail?.investmentInterest;
    if (invInt?.closing != null) patches.usInvestmentInterestCarryforward = +invInt.closing.toFixed(2);
    // §1211/§1212 capital-loss pools (design 90 §4.3). Same contract as the two above,
    // and the same reason: `computeTax` is PURE and is re-run on the FITO
    // counterfactual, so it reports closing balances rather than drawing the pools down
    // in place. Drawing down inside computeTax would let the counterfactual pass spend
    // the pool and hand the real pass an already-emptied balance.
    const capLoss = action.taxDetail?.capitalLoss;
    if (capLoss?.closingShort != null) patches.usShortTermCapitalLossCarryforward = +capLoss.closingShort.toFixed(2);
    if (capLoss?.closingLong  != null) patches.usLongTermCapitalLossCarryforward  = +capLoss.closingLong.toFixed(2);
    if (action.usTaxPaidOnUsSourceAud != null) {
      patches.usTaxPaidOnUsSourceAud = action.usTaxPaidOnUsSourceAud;
    }
    return patches;
  }
}

/**
 * Resets AU YTD tax accumulators (including per-person maps) and, when the
 * computed tax is positive, chains an AU_TAX_PAYMENT_DEBIT action to debit
 * the AU savings account.
 */
export class AuTaxSettleApplyReducer extends TaxSettleApplyReducerBase {
  static type            = 'AuTaxSettleApplyReducer';
  static category        = 'reducer';
  static cc              = 'AU';
  static applyActionType = 'AU_TAX_SETTLE_APPLY';
  static debitActionType = 'AU_TAX_PAYMENT_DEBIT';
  static description     = 'Resets AU YTD tax fields after settlement; stages the whole AU liability as US §904 current-year foreign tax; chains AU_TAX_PAYMENT_DEBIT when tax > 0.';

  /**
   * Fund the US §904 credit (design 52 §4.4). Convert the AU liability to USD at the
   * settlement rate and stage the WHOLE amount for the next US settle to consume.
   *
   * **The basket split does not happen here, and must not.** It used to: this method
   * apportioned the liability across general/passive by
   * `foreignGeneralIncomeYTD : foreignPassiveIncomeYTD`, defaulting the whole amount to
   * general when both were zero. Those two accumulators are *US*-side YTD buckets,
   * reset by the US settle on 31 December — and this reducer runs on 30 June. So the
   * split was decided on a 1 Jan–30 Jun half-year snapshot of a calendar-year return.
   *
   * Whenever that half contained no foreign-source income — the ordinary case for a
   * portfolio whose realisations fall on a 1 July rebalance and a 31 December
   * distribution — `denom` was zero and the entire year's AU tax went to the general
   * basket. The old comment argued that was harmless ("a pool with no income to sit
   * against is limited to zero credit anyway, so this only decides which pool banks the
   * vintage"). It is not: the vintage keeps its basket for its whole ten-year life, and
   * a general vintage sitting behind a permanently empty general basket has a
   * limitation fraction of zero forever. Measured on a real AU-resident retiree plan,
   * $8.06M of AU tax was banked in a basket holding no income, while the passive basket
   * ran $3.5M of unused §904 room in the same run's last decade.
   *
   * A calendar-year apportionment cannot be computed in June, because the second half
   * of the US year has not happened yet. So the split moved to where the full year is
   * known: `UsTaxRatesBase._computeFtc` divides `ftcCurrentForeignTax` by the same
   * `generalGross`/`passiveGross` it already computes for the limitation itself. This
   * reducer keeps the currency conversion, which does belong here — `toUSD` must read
   * the rate at the AU settlement date, not at the US one.
   *
   * **Design 83 G3 — nothing is removed before staging.** This method
   * used to subtract the AU tax on US-SOURCE income and stage it in a third,
   * "re-sourced by treaty" basket of its own. Both halves of that are now gone:
   *
   *   - **The third basket should never have existed** for this taxpayer.
   *     Reg. §1.904-4(k)(1)(iv)(A) switches off the separate-category treatment of
   *     §904(d)(6) for *"any item of income deemed to be from foreign sources by
   *     reason of the relief from double taxation rules in any U.S. income tax
   *     treaty that is solely applicable to U.S. citizens who are residents of the
   *     other Contracting State"*. Art. 22(4) opens with exactly that clause. The
   *     income is still re-sourced (Art. 27(1)(c)), it just lands in its ordinary
   *     category — the US classifiers now book it into general/passive by character.
   *   - **So the whole AU liability is creditable**, and the basket income shares the
   *     US settle apportions it by already include the re-sourced income, which is what
   *     makes the apportionment land the tax in the same basket as the income that bore
   *     it.
   *
   * Two baskets partitioning one taxpayer's income also means the §904 fractions
   * cannot sum past 1 — the invariant design 83 G1 asserts. Before G3, the third
   * basket's numerator was a subset of the other two's denominator, which is how a
   * limitation fraction of 5.157 became possible.
   *
   * **Super fund tax is not removed here either, and no longer needs to be.**
   * Design 77 took the Div 295 fund tax out of the AU *member's* net liability
   * entirely (it is withheld inside the fund at accrual), so `action.tax` no longer
   * contains it and subtracting it again would understate the creditable base by
   * the whole amount. The conclusion it encoded is unchanged and still correct: AU
   * super fund tax is **not** a creditable foreign income tax of the member, because
   * §901 credits the person on whom foreign law imposes legal liability
   * (Treas. Reg. §1.901-2(f)) and that person is the fund's trustee, not the member.
   * Design 77 §3.1 carries the reasoning.
   */
  _extraStatePatches(state, action) {
    // Design 95 §9.4 phase 8, review Q5 — Div 293 is TABLED as non-creditable and
    // removed from the §904 base here. It is an Australian income tax on an
    // individual, which points toward creditable under Art 22 / §901, but it is
    // imposed on CONTRIBUTIONS rather than on income received, which is at least
    // arguable. An uncredited Div 293 is the conservative reading, and turning the
    // credit on later moves lifetime tax in a known direction. It IS inside
    // `action.tax` — the member genuinely pays it, so it must be debited and must
    // reach `cumulativeTaxesPaid` — which is exactly why it has to come out again
    // here rather than simply never being added.
    const auCreditable = Math.max(0, (action.tax ?? 0) - _auDiv293Total(action));
    // Design 83 G10 — carry this FY's realised AU rate on capital gains forward for
    // the §865(g)(2) test on the next US return. A one-settle lag is not a
    // compromise here, it is the real filing sequence: the AU FY ends 30 June and
    // the US CY on 31 December, so a taxpayer filing a US return always knows the AU
    // tax on the earlier gains and estimates the later ones. Null (no gains this FY)
    // leaves the previous determination standing rather than reading as 0%.
    const cgtRate = _auCgtEffectiveRate(action);
    return {
      ftcCurrentForeignTax: toUSD(auCreditable, 'AUD', state),
      ...(cgtRate != null ? { auCgtEffectiveRate: cgtRate } : {}),
      ..._auLossPoolPatch(state, action),
      ..._auSuperCapsRoll(state, action),
    };
  }
}

/**
 * The household's Division 293 tax for the year, summed across whoever owed it.
 *
 * Read off the same `taxDetail` the return was built from, so it can never disagree
 * with the figure that was debited. Both settle shapes are handled: the per-person
 * path (`personTaxDetails`) and the single-return fallback.
 */
function _auDiv293Total(action) {
  const details = action.personTaxDetails;
  if (details?.length) {
    return details.reduce((sum, p) => sum + Math.max(0, p.taxDetail?.div293Tax ?? 0), 0);
  }
  return Math.max(0, action.taxDetail?.div293Tax ?? 0);
}

/**
 * Roll `auSuperCapsByPerson` across the AU financial-year boundary (design 95 §9.3,
 * phase 7).
 *
 * Four movements, and they have to happen together because each depends on the year
 * that is ending:
 *
 *  1. **Accrue** this year's unused concessional cap (s291-20(6)), measured against
 *     the BASIC cap — never the carried-forward one, or a member who spent old cap
 *     would accrue new cap out of cap they had already used.
 *  2. **Expire** anything now outside the five-year window (s291-20, and the ATO's
 *     "a 2019-20 unused cap amount that isn't used by the end of 2024-25 will
 *     expire").
 *  3. **Snapshot** the total superannuation balance. s291-20(3)(b) and s292-85(2)(b)
 *     both test it "just before the start of the financial year", and 30 June is
 *     exactly that instant for the year about to begin — so the settle is the only
 *     place in the run where the right number is on hand at the right moment.
 *  4. **Reset** the three YTD totals, and advance any bring-forward arrangement.
 *
 * This sits OUTSIDE `PER_PERSON_AU_FIELDS` on purpose. That loop zeroes a map
 * wholesale, and three of the six fields here must survive the boundary — the unused
 * ring is the model's first genuinely multi-year accumulator, and zeroing it every
 * June would quietly delete the entire carry-forward feature while leaving it
 * looking wired.
 *
 * `applied` is not re-derived here: it is read off the same `concessionalCapWithCarryForward`
 * result the year was assessed under, carried on the record by the payroll handler,
 * so the ring decrements by exactly what was spent.
 */
function _auSuperCapsRoll(state, action) {
  const all = state.auSuperCapsByPerson;
  if (all == null) return {};

  // The financial year that just ENDED. Stamped by the settle handler, which is the
  // only participant that sees the event date.
  const fy = action.fyStartYear;
  if (!Number.isFinite(fy)) return {};
  const indexFactor = action.limitIndexFactor ?? 1;

  // design/68 Gap 5, same rule as the per-person reset above: a deceased person's
  // keys are DROPPED, not zeroed. Their caps can never bind again, and a lingering
  // record would let income mis-attributed to a dead key ration a live member's cap.
  const people   = state.people ?? {};
  const deadKeys = new Set(Object.keys(state.deceased ?? {}).filter(k => people[k] == null));

  const next = {};
  for (const [key, rec] of Object.entries(all)) {
    if (deadKeys.has(key)) continue;
    const concessional = Math.max(0, rec.concessionalYTD ?? 0);

    // The member's balance at this instant IS "just before the start" of the year
    // about to begin, which is what s291-20(3)(b) and s292-85(2)(b) both test.
    const superKey = _auSuperKeyFor(state, key, rec);
    const tsb = superKey != null ? Math.max(0, state[superKey]?.balance ?? 0)
                                 : (rec.tsbAtFyStart ?? 0);

    // ── The Div 292 bring-forward arrangement (s292-85(3)-(7)) ───────────────
    //
    // Three financial years from its first, and this is the ONLY place it is ever
    // written. `monthlyAuSuper` reports that a year's contributions would trigger one,
    // but a handler cannot start an arrangement: it runs twelve times a year and has
    // nowhere to persist the decision. Without a writer here `bringForward` stayed
    // null forever, s292-85(6)/(7)'s remainder branch was unreachable, and every year
    // re-evaluated as a NEW first year — so a member contributing over the general cap
    // got a 3x cap EVERY year instead of once per three.
    const nonConcessional = Math.max(0, rec.nonConcessionalYTD ?? 0);
    const bf = rec.bringForward ?? null;
    let bringForward = null;
    if (bf?.firstFy != null && fy < bf.firstFy + 2) {
      // Years two and three: carry it, spending down what this year used.
      bringForward = { ...bf, used: +((bf.used ?? 0) + nonConcessional).toFixed(2) };
    } else if (bf == null) {
      // No arrangement running. Did this year's contributions start one? Re-derived
      // from what the year ACTUALLY contributed, on the same inputs the year was
      // assessed under — `rec.tsbAtFyStart` is still the opening balance here, since
      // the new snapshot is not assigned until below.
      const started = nonConcessionalCap({
        fyStartYear:   fy,
        tsb:           Math.max(0, rec.tsbAtFyStart ?? 0),
        age:           _ageAtFyEnd(state, key, fy),
        contributions: nonConcessional,
        indexFactor,
      });
      if (started.bringForwardTriggered) {
        bringForward = { firstFy: fy, cap: started.bringForwardCap,
                         used: +nonConcessional.toFixed(2) };
      }
    }

    // What the carry-forward actually released this year, RE-DERIVED from the
    // contributions the year really made rather than stored month by month.
    //
    // The ring is written nowhere but here, so `rec.unusedByFy` is still the year's
    // OPENING ring and `rec.tsbAtFyStart` still the opening balance — the two inputs
    // the year was assessed under. Re-deriving against the actual annual total is
    // strictly better than recording the payroll handler's monthly view, which is
    // sized on INTENDED contributions: a member who retires in March intended more
    // than they contributed, and would otherwise have spent carry-forward cap on a
    // contribution that never happened.
    const spent = concessionalCapWithCarryForward({
      fyStartYear:   fy,
      contributions: concessional,
      tsb:           Math.max(0, rec.tsbAtFyStart ?? 0),
      unusedByFy:    rec.unusedByFy ?? {},
      indexFactor,
    });

    next[key] = {
      concessionalYTD:       0,
      sgYTD:                 0,
      nonConcessionalYTD:    0,
      qualifyingEarningsYTD: 0,
      unusedByFy: rollUnusedConcessionalCap({
        fyStartYear:   fy,
        contributions: concessional,
        unusedByFy:    rec.unusedByFy ?? {},
        applied:       spent.applied,
        indexFactor,
      }),
      // The NEW snapshot, deliberately assigned after `spent` has read the old one.
      tsbAtFyStart: +tsb.toFixed(2),
      bringForward,
    };
  }
  return { auSuperCapsByPerson: next };
}

/**
 * The person's age at the END of the financial year — s292-85(3)(c) asks whether they
 * were "under 75 years at any time in the first year", so the year-end age is the
 * conservative reading of it. Null when no birth date is projected, which
 * `nonConcessionalCap` treats as eligible rather than guessing.
 */
function _ageAtFyEnd(state, personKey, fyStartYear) {
  const birth = state.people?.[personKey]?.birthDate;
  if (birth == null) return null;
  return ageAt(birth, new Date(Date.UTC(fyStartYear + 1, 5, 30)));
}

/**
 * The SUPER account stateKey for one person, or null when they have no fund.
 *
 * Prefers the key the payroll handler actually resolved and the caps accumulator
 * recorded — this reducer has no StateRegistry of its own, so that record is the only
 * exact answer available to it. The convention fallbacks below are for a person who
 * has a fund but has never contributed to it (a seeded balance in a run that starts
 * at retirement), and the household `superAccount` is used ONLY in a single-person
 * household: attributing one shared key to each of two people would snapshot the same
 * balance as both of their total superannuation balances and mis-gate both.
 */
function _auSuperKeyFor(state, personKey, rec = null) {
  // 1. The key the payroll handler actually resolved, recorded by the caps
  //    accumulator. Exact, and the only answer that survives a renamed account.
  if (rec?.superKey != null && state[rec.superKey] != null) return rec.superKey;
  // 2. The person-prefixed convention — for someone with a seeded balance who has
  //    never contributed, so step 1 has nothing recorded.
  const direct = `${personKey}SuperAccount`;
  if (state[direct] != null) return direct;
  // 3. The household account, but ONLY when it is theirs. `ownerId` is carried on the
  //    account in state, so ownership is a fact here rather than an inference: in a
  //    two-person household `superAccount` belongs to one of them and
  //    `spouseSuperAccount` to the other, and handing the same key to both would
  //    snapshot one balance as BOTH their total superannuation balances and mis-gate
  //    the carry-forward and the transfer-balance stop for both.
  const shared = state.superAccount;
  if (shared != null) {
    if (shared.ownerId === personKey) return 'superAccount';
    if (shared.ownerId == null && Object.keys(state.people ?? {}).length <= 1) return 'superAccount';
  }
  return null;
}

/**
 * Persist each person's Div 36 carried-forward tax loss pool (design 86 G1).
 *
 * **This is the only place the pool is written.** `_assessResidentPreFito` computes
 * the deduction but never mutates, because it is evaluated more than once per settle
 * — the FITO limit and the §865(g)(2) CGT rate each re-assess a counterfactual state.
 * A pool drawn down inside that function would be spent by whichever pass ran first,
 * and the surviving passes would then assess against a pool that no longer existed.
 *
 * The pool sits outside `PER_PERSON_AU_FIELDS`, so the settle's reset loop leaves it
 * alone — surviving the year boundary is the whole point. That also means it must be
 * written explicitly here rather than accumulated by an action, and that a person with
 * no return this year keeps their pool untouched rather than silently losing it.
 *
 * The map is CREATED when absent rather than skipped. A scenario loaded from a saved
 * export carries whatever `initialState` was serialized before design 86 existed, so
 * the constructor's zeroed map never reaches it — guarding on the map's presence made
 * the whole feature silently inert against exactly the saved plans it was built for.
 */
function _auLossPoolPatch(state, action) {
  const details = action.personTaxDetails;
  if (!details?.length) return {};
  const next = { ...(state.auPersonTaxLossPool ?? {}) };
  // s102-5 net capital losses (design 90 §5). Written HERE, beside the Div 36 pool, for
  // every reason the header above gives — but into its own map. The two pools are
  // maintained side by side and must never be summed: s102-10(2) lets a net capital
  // loss meet future capital gains only, while a Div 36 loss reduces total assessable
  // income including wages.
  const nextCapital = { ...(state.auPersonCapitalLossPool ?? {}) };
  let touched = false;
  let touchedCapital = false;
  for (const { personKey, taxDetail } of details) {
    if (personKey == null) continue;
    if (taxDetail?.closingLossPool != null) {
      next[personKey] = +taxDetail.closingLossPool.toFixed(2);
      touched = true;
    }
    if (taxDetail?.closingCapitalLossPool != null) {
      nextCapital[personKey] = +taxDetail.closingCapitalLossPool.toFixed(2);
      touchedCapital = true;
    }
  }
  return {
    ...(touched        ? { auPersonTaxLossPool: next }            : {}),
    ...(touchedCapital ? { auPersonCapitalLossPool: nextCapital } : {}),
  };
}

/**
 * The household's realised effective AU rate on capital gains this FY — design 83
 * G10, the §865(g)(2) input.
 *
 * Weighted by each person's gross gains rather than averaged, because the test is
 * about the tax borne by *the gain*: one spouse realising a large discounted gain in
 * a low bracket and the other a small one in the top bracket must not average into a
 * rate neither of them paid. Returns null when nobody realised a gain, which the
 * caller treats as "no new information" rather than as 0%.
 *
 * @param {object} action  the AU_TAX_SETTLE_APPLY action
 * @returns {?number} 0..1, or null
 */
function _auCgtEffectiveRate(action) {
  const details = action.personTaxDetails?.length > 0
    ? action.personTaxDetails.map(p => p.taxDetail)
    : (action.taxDetail ? [action.taxDetail] : []);
  let taxed = 0, gains = 0;
  for (const d of details) {
    const g = d?.inputs?.capitalGains ?? 0;
    if (!(g > 0) || d?.auCgtEffectiveRate == null) continue;
    gains += g;
    taxed += g * d.auCgtEffectiveRate;
  }
  return gains > 0 ? taxed / gains : null;
}

// ─── TaxPaymentDebitReducer base + per-country subclasses ────────────────────

/**
 * Tax actions an `AccountService.replenishSavings` draw can emit — the taxable
 * consequence of liquidating assets to raise cash. Declared as generated edges by
 * every reducer that funds itself through a draw, so the action graph shows that
 * paying a bill can itself create taxable income.
 */
export const DRAWDOWN_TAX_ACTION_TYPES = Object.freeze([
  'STOCK_WITHDRAWAL_TAX', 'COLLECTIBLE_SALE_TAX',
  'K401_WITHDRAWAL_TAX', 'IRA_WITHDRAWAL_CONTRIB_TAX', 'IRA_WITHDRAWAL_EARNINGS_TAX',
  'ROTH_WITHDRAWAL_EARNINGS_TAX', 'SUPER_WITHDRAWAL_EARNINGS_TAX',
  // Design 84 G9: a drawdown that reaches a Roth's converted principal reports it
  // on the EVT-43/44 twins — the recapture penalty and the s99B-assessable share
  // that s99B(2)(a) denies the corpus exemption to.
  'ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX', 'ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX',
]);

class TaxPaymentDebitReducerBase extends Reducer {
  static cc;
  static actionType;
  static savingsRole;

  static fromJSON(d, services) {
    const r = new this(services);
    r.id = d.id;
    return r;
  }

  constructor({ accountService, stateRegistry }) {
    const cc = new.target.cc;
    super(`${cc} Tax Payment Debit`, PRIORITY.TAX_APPLY + 1);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes = [new.target.actionType];
    this.generatedActionTypes = ['INTL_TRANSFER_RECORD', 'INTL_TRANSFER_APPLY', 'OUT_OF_FUNDS',
                                 new.target.actionType, ...DRAWDOWN_TAX_ACTION_TYPES];
  }

  reduce(state, action, date) {
    const role       = this.constructor.savingsRole;
    const accountKey = this.stateRegistry.getStateKey(role);
    const cashAccount = state[accountKey];
    const currency    = cashAccount?.currency?.code
                        ?? (this.constructor.cc === 'AU' ? 'AUD' : 'USD');

    // Absent-account: this country's canonical savings account may not be wired
    // (e.g. a US person charged a US tax the FTC cannot fully relieve — NIIT — in
    // a scenario holding no US cash account). There is nowhere to draw from, so
    // the entire liability is unpaid — treat it as an OUT_OF_FUNDS event rather
    // than dereferencing an undefined account or silently absorbing the tax.
    if (!cashAccount) {
      return this.newState(state, {}, this._outOfFundsActions(action.amount, currency, date));
    }

    // `escalated` marks the residual debit re-issued AFTER an INTL_TRANSFER_APPLY
    // top-up (below). The cross-border sweep has already run and already reported
    // any still-uncoverable gap as OUT_OF_FUNDS, so this pass only debits what
    // landed — it neither replenishes again nor re-reports the residual (which
    // would double-count and could re-escalate without bound).
    const escalated = action.escalated === true;

    const shortfall   = action.amount - Math.max(0, cashAccount.balance);

    let crossBorderTransfers = [];
    // Tax the FUNDING of the tax. Selling brokerage lots or distributing from an
    // IRA/401k/super to raise the cash is an ordinary taxable event — the draw
    // returns STOCK_WITHDRAWAL_TAX / *_WITHDRAWAL_TAX / COLLECTIBLE_SALE_TAX for
    // exactly that. Emitting them accrues the income into the YTD buckets the NEXT
    // settle reads: the sibling apply reducer (PRIORITY.TAX_APPLY) has already
    // reset this year's buckets before this debit runs at TAX_APPLY + 1, so the
    // gain lands in the following tax year. That deferral is what keeps the model
    // finite — accruing into the year being settled would be circular (more tax ⇒
    // bigger sale ⇒ more tax). Dropping them, which is what this reducer used to
    // do, made a locally-funded tax bill tax-free while the same bill funded across
    // the border (IntlTransferApplyReducer, which forwards them) was not.
    let pendingTaxActions = [];
    if (shortfall > 0 && !escalated) {
      try {
        // A cross-currency cash sweep here (e.g. AU cash topping up US savings to
        // pay US tax) is journaled via INTL_TRANSFER_RECORD (design 44 Gap A).
        // replenishSavings tops the account up as far as the sources allow before
        // throwing InsufficientFundsError with the uncoverable residual.
        ({ crossBorderTransfers = [], pendingTaxActions = [] } =
          this.accountService.replenishSavings(state, accountKey, shortfall, date));
      } catch (e) {
        if (!(e instanceof InsufficientFundsError)) throw e;
        // The failed draw still emptied every eligible account, realizing gains on
        // the way down. Keep those accruals (e.partial), then proceed to the
        // cross-border escalation below for the uncoverable part.
        ({ crossBorderTransfers = [], pendingTaxActions = [] } = e.partial);
      }
    }

    const debit = Math.min(action.amount, Math.max(0, cashAccount.balance));
    if (debit > 0) {
      this.accountService.transaction(cashAccount, -debit, date);
    }

    // ─── design 87 §14.4 item 1 — G12, the §988(e)(3)(B) carve-out ────────────────
    // Paying a tax bill out of a foreign-currency deposit disposes of nonfunctional
    // currency (§988(c)(1)(C)(i)) and is NOT on the `§1.988-2(a)(1)(iii)`
    // non-recognition list, so it realizes. What makes this the FIRST emitter to wire
    // is the fraction, not the disposal: §988(e)(3) adopts §212 "other than that part
    // of section 212 dealing with expenses incurred in connection with taxes" — the
    // same words in `§1.988-1(a)(9)(i)`. So currency disposed of to pay tax is a
    // PERSONAL transaction even where every other expense of the same account is
    // unambiguously §212, which falls to the capital branch (G10) with the $200
    // exclusion rather than being ordinary §988. `currencyPoolBusinessFraction` reads
    // one scalar off the account and cannot express that; the per-disposition fraction
    // exists precisely for this and is otherwise unexercised.
    //
    // Character is declared here rather than by whoever emitted the action because it
    // is a fact about the action TYPE — a tax payment is carved out however the bill
    // arose — not about the caller's circumstances. Design 87 §6's "realize in the
    // reducer" still governs the AMOUNT, and `units` is why: `replenishSavings` above
    // may have credited this same pool inside this same observer bracket (a
    // same-currency sweep from another AUD account, or a US→AU wire), so the pool's
    // NET movement understates the disposition by the whole top-up.
    //
    // Stamped for both subclasses. The US pool is USD — the taxpayer's functional
    // currency — so `isCurrencyLotPool` never tracks it and the declaration is inert
    // there; declaring it in the shared base rather than in the AU subclass means a
    // scenario that ever wires US_SAVINGS in a foreign currency is right by default.
    if (debit > 0) {
      action.section988 = {
        kind: 'DISPOSE',
        accountKey,
        businessFraction: 0,
        units: debit,
      };
    }

    const unpaid = action.amount - debit;

    // Any liability that same-country cash + the inline cross-border *cash* sweep
    // could not cover would strand here: under LOCAL_FIRST that sweep reaches only
    // idle foreign cash, never foreign investments, so an AU tax bill larger than
    // AU liquidity has nowhere left to go. Mirror the spending path
    // (ReplenishSavingsReducer): escalate to INTL_TRANSFER_APPLY, which liquidates
    // the OTHER country's investments and wires the proceeds straight into this tax
    // account (dstKey), then re-issue the debit (escalated) to pay the tax out of
    // the topped-up balance. The transfer reports any part even that cannot cover
    // as OUT_OF_FUNDS, so a genuine insolvency still surfaces — symmetric with
    // spending — without stranding a solvent household across the currency border.
    let residualActions = [];
    if (unpaid > 0.01 && !escalated) {
      residualActions = [
        { type: 'INTL_TRANSFER_APPLY',
          direction:     this.constructor.cc === 'AU' ? 'US_TO_AU' : 'AU_TO_US',
          targetDeficit: unpaid,
          dstKey:        accountKey },
        { type: this.constructor.actionType, amount: unpaid, escalated: true },
      ];
    }

    return this.newState(state, {
      [accountKey]: { ...cashAccount },   // explicit new reference so balance change is visible in state diffs
    }, [...crossBorderTransfers, ...pendingTaxActions, ...residualActions]);
  }

  /**
   * Build the OUT_OF_FUNDS action for an unpaid tax residual, or [] when the
   * residual is within a cent (float/FX dust). The shared OutOfFundsReducer
   * consumes it (records the deficit metric, accumulates cumulativeDeficit, and
   * stamps outOfFundsDate/scenarioFailed on first occurrence). The 0.01 epsilon
   * matches the spending-side IntlTransferApplyReducer so rounding never trips a
   * spurious insolvency.
   */
  _outOfFundsActions(unpaid, currency, _date) {
    if (!(unpaid > 0.01)) return [];
    return [{ type: 'OUT_OF_FUNDS', deficit: unpaid, currency }];
  }
}

/**
 * Debits the US savings account for the computed tax amount.
 *
 * @param {object} opts
 * @param {import('../services/account-service.js').AccountService} opts.accountService
 * @param {object} opts.stateRegistry
 */
export class UsTaxPaymentDebitReducer extends TaxPaymentDebitReducerBase {
  static type        = 'UsTaxPaymentDebitReducer';
  static category    = 'reducer';
  static cc          = 'US';
  static actionType  = 'US_TAX_PAYMENT_DEBIT';
  static savingsRole = ACCOUNT_ROLES.US_SAVINGS;
  static description = 'Debits the US savings account for the tax amount; replenishes from investment accounts first when the balance is short.';
}

/**
 * Debits the AU savings account for the computed tax amount.
 *
 * @param {object} opts
 * @param {import('../services/account-service.js').AccountService} opts.accountService
 * @param {object} opts.stateRegistry
 */
export class AuTaxPaymentDebitReducer extends TaxPaymentDebitReducerBase {
  static type        = 'AuTaxPaymentDebitReducer';
  static category    = 'reducer';
  static cc          = 'AU';
  static actionType  = 'AU_TAX_PAYMENT_DEBIT';
  static savingsRole = ACCOUNT_ROLES.AU_SAVINGS;
  static description = 'Debits the AU savings account for the tax amount; replenishes from investment accounts first when the balance is short.';
}
