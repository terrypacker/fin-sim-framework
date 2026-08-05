/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseTaxModule } from '../base-tax-module.js';
import { resolveAttributionFractions } from '../../ownership-utils.js';
import { toAUD } from '../tax-fx.js';

/**
 * Per-person AU accumulator for each household scalar this module books while the
 * taxpayer is an AU resident (design 76 Gap B). Every entry pairs the AU-return
 * field with the per-person map that supersedes it.
 */
const AU_PERSON_FIELD = {
  auOrdinaryIncomeYTD:        'auPersonOrdinaryIncomeYTD',
  auCapitalGainsYTD:          'auPersonCapitalGainsYTD',
  auDiscountableGainsYTD:     'auPersonDiscountableGainsYTD',
  usSourceOrdinaryAudYTD:     'auPersonUsSourceOrdinaryAudYTD',
  usSourceCapGainsAudYTD:     'auPersonUsSourceCapGainsAudYTD',
  usSourceRealCapGainsAudYTD: 'auPersonUsSourceRealCapGainsAudYTD',
};

/**
 * Book AU-assessable amounts for an AU resident, attributed to the person who owns
 * the income rather than split evenly across the household at settle time.
 *
 * Australia has no joint assessment (design 76 §1), so every dollar here belongs to
 * exactly one taxpayer — or to each owner of a jointly held asset in proportion to
 * their interest. `resolveAttributionFractions` reads whichever identifier the
 * action carries (personKey / stateKey / inline ownership).
 *
 * When nothing resolves we fall back to the household scalar. That is deliberately
 * NOT an even split: the scalar is still divided by headcount at settle, but it stays
 * visible as unattributed income that P5's assertion can catch, whereas an even split
 * applied here would silently look like a real answer.
 *
 * @param {object} state         - state before this action
 * @param {object} next          - state accumulated so far by the caller
 * @param {object} action        - the tax action (source of the attribution identifier)
 * @param {string} canonicalKey  - fallback state key for the account-derived case
 * @param {Record<string, number>} amounts - AU field → amount (AUD)
 * @returns {object} next, with either per-person maps or household scalars advanced
 */
function bookAuResident(state, next, action, canonicalKey, amounts) {
  const fractions = resolveAttributionFractions(state, action, canonicalKey);
  const patch = {};

  if (fractions == null) {
    for (const [field, value] of Object.entries(amounts)) {
      patch[field] = (next[field] ?? state[field] ?? 0) + value;
    }
    return { ...next, ...patch };
  }

  for (const [field, value] of Object.entries(amounts)) {
    const personField = AU_PERSON_FIELD[field];
    if (personField == null) {          // no per-person twin ⇒ genuinely household
      patch[field] = (next[field] ?? state[field] ?? 0) + value;
      continue;
    }
    const map = { ...(next[personField] ?? state[personField] ?? {}) };
    for (const { personKey, fraction } of fractions) {
      map[personKey] = (map[personKey] ?? 0) + value * fraction;
    }
    patch[personField] = map;
  }
  return { ...next, ...patch };
}

/**
 * UsTaxModule2026 — US tax classification rules for 2026.
 *
 * Returns Stage-2 (TAX_CALC priority) reducer functions for all _TAX child
 * actions emitted by the US account module's Stage-1 reducers.  Handles
 * cross-border effects for US accounts when the person is also an AU resident.
 *
 * Covered events:
 *   EVT-1 to 4   Roth IRA
 *   EVT-5 to 8   Traditional IRA
 *   EVT-9 to 15  US Brokerage (fixed income + stocks)
 *   EVT-24/25    401k
 *   EVT-34       US House Sale
 *   EVT-52       Roth Conversion
 *
 * Design 52 — cross-border relief. US-source income booked while AU-resident is
 * relieved on the *AU* return via FITO (not by a US FTC — that was the old
 * `ftcYTD` over-relief hack). Each such dollar is now recorded into the FITO
 * "without" removal set, in both currencies:
 *   usSourceOrdinaryUsdYTD / usSourceCapGainsUsdYTD  (USD, §4.6 US marginal pass)
 *   usSourceOrdinaryAudYTD / usSourceCapGainsAudYTD  (AUD, §4.5 AU limit)
 */
/**
 * §865(g)(2) threshold — foreign tax of at least this share of the gain must be
 * *actually paid* before a US citizen counts as a "nonresident" for personal-property
 * sourcing. Statutory, not indexed.
 */
const SEC865_FOREIGN_TAX_THRESHOLD = 0.10;

/**
 * Art. 18(1) pensions — design 83 G10 part 3. Books a **periodic** retirement or
 * death benefit for an AU-resident US citizen, where Australia's taxing right is
 * exclusive and the US charge survives only through the saving clause.
 *
 * Art. 18(1): *"pensions and other similar remuneration paid to an individual who is
 * a resident of one of the Contracting States in consideration of past employment
 * shall be taxable **only in that State**."* The residence State is Australia.
 *
 * The US taxes it anyway, and legitimately: Art. 1(3) lets a State tax its citizens
 * "as if this Convention had not entered into force", and Art. 1(4)(a) lists the
 * paragraphs that survive the saving clause — *"paragraph (2) or (6) of Article 18"*.
 * **18(1) is not among them.** That single omission is the whole difference between
 * this rule and G11 (Social Security, Art. 18(2)), where the carve-out applies and
 * Australia may not tax at all.
 *
 * So the US charge is tax imposed *solely by reason of citizenship*, and that is the
 * exact quantity Art. 22(2) excludes from Australia's credit — Art. 27(1)(b) refuses
 * even to deem it US-source for 22(2) purposes. Relief runs the other way instead,
 * under Art. 22(4): the US credits the Australian tax, and Art. 27(1)(c) resources
 * the income to Australia "to the extent necessary" to make §904 room for it.
 *
 * Hence the booking:
 *   · AU assessable income — kept. Australia is the State with the taxing right.
 *   · the Art. 22(2) removal set (`usSource*UsdYTD` / `usSourceOrdinaryAudYTD`) —
 *     dropped. There is no creditable US source tax, so there is no FITO to fund.
 *   · `foreignGeneralIncomeYTD` — added, NOT `usSourceGeneralUsdYTD`. Both feed the
 *     same §904 general numerator, but the latter exists so the FITO counterfactual
 *     can strip it back out (§14.1). Income that never enters the 22(2) base must
 *     stay in the counterfactual, so it belongs in the genuinely-foreign accumulator.
 *   · General category, per Pub 514: a pension is absent from the passive list, and
 *     general is the residual — the same reasoning as super in G6.
 *
 * **Scope is periodicity, and it is deliberate.** Art. 18(4) defines the term as
 * *"**periodic** payments made by reason of retirement or death, in consideration for
 * services rendered"*, and Art. 18(5) requires periodicity of annuities too. A
 * discretionary lump-sum drawdown is neither, so it falls out of Art. 18 entirely and
 * into Art. 21(3), where the US **may** tax as source State and Australia **must**
 * credit — i.e. the removal-set treatment those classifiers already have. This is why
 * `IRA_RMD_TAX` and `K401_RMD_TAX` route here while `IRA_WITHDRAWAL_EARNINGS_TAX` and
 * `IRA_ROLLOVER_WITHDRAWAL_TAX` do not.
 *
 * @param {object} state          state before this action
 * @param {object} next           state accumulated so far by the caller
 * @param {object} action         the tax action
 * @param {string} canonicalKey   fallback state key for per-person attribution
 * @param {number} amount         USD distribution amount
 */
function bookArt18Pension(state, next, action, canonicalKey, amount) {
  const patched = {
    ...next,
    foreignGeneralIncomeYTD: (state.foreignGeneralIncomeYTD ?? 0) + amount,
  };
  return bookAuResident(state, patched, action, canonicalKey, {
    auOrdinaryIncomeYTD: toAUD(amount, 'USD', state),
  });
}

/**
 * Is a gain on PERSONAL property foreign-source for this taxpayer? — design 83 G10.
 *
 * §865(a) sources gain on the sale of personal property by the **residence of the
 * seller**, not by where the asset or the account sits. §865(g)(1)(A)(i)(I) defines a
 * "United States resident" as a citizen who does **not** have a tax home in a foreign
 * country — so a US citizen resident in Australia is a *nonresident* here, and
 * §865(a)(2) sources the gain outside the United States. The treaty agrees from the
 * other side: portfolio share gains appear nowhere in Art. 13 (even as amended by
 * Art. 9 of the 2001 Protocol), so Art. 21 (Other Income) governs, and its
 * source-State permission reaches only income *"from sources in the other Contracting
 * State"*. (Art. 11 of the 2001 Protocol replaced Art. 21 outright; the operative
 * paragraph is now **21(3)**, not the 1982 original's 21(2).)
 *
 * §865(g)(2) attaches a condition, and it is a real test rather than a formality:
 *
 *   > a United States citizen … shall not be treated as a nonresident with respect
 *   > to any sale of personal property **unless an income tax equal to at least 10
 *   > percent of the gain** derived from such sale **is actually paid** to a foreign
 *   > country with respect to that gain.
 *
 * Australia normally clears it comfortably — a discounted gain at the top marginal
 * rate is ~22.5% — but not always: the 50% CGT discount against the lowest bracket
 * is ~8%, and carried-forward capital losses can drive the realised rate to zero. So
 * the model measures rather than assumes, using the effective rate Australia actually
 * charged, carried forward from the last AU settle that had gains.
 *
 * **On the one-settle lag.** The AU FY ends 30 June and the US CY on 31 December, so
 * a real filer always knows the AU tax on the earlier gains of a US tax year and
 * estimates the later ones. Using the prior settle's realised rate is that same
 * position, not an approximation the model invented.
 *
 * Before any AU settle has measured a rate there is nothing to test against, and the
 * answer defaults to foreign source. That is the right default rather than a
 * convenient one: §865(g)(2) exists to catch gains the residence country does not
 * tax, and Australia assesses residents on worldwide gains as a matter of course.
 *
 * @param {object} state
 * @returns {boolean} true ⇒ foreign source (no re-sourcing needed, not US-source
 *                    income for the Art. 22(2) handoff)
 */
function isPersonalPropertyGainForeignSource(state) {
  const rate = state.auCgtEffectiveRate;
  return rate == null || rate >= SEC865_FOREIGN_TAX_THRESHOLD;
}

export class UsTaxModule2026 extends BaseTaxModule {
  get countryCode() { return 'US'; }
  get year()        { return 2026; }

  getReducerFns() {
    return new Map([
      ...this._rothReducerFns(),
      ...this._iraReducerFns(),
      ...this._k401ReducerFns(),
      ...this._usBrokerageReducerFns(),
      ...this._realPropertyReducerFns(),
      ...this._rentalReducerFns(),
      ...this._incomeReducerFns(),
      ...this._collectibleReducerFns(),
      ...this._iraRolloverReducerFns(),
      ...this._rothRolloverReducerFns(),
      ...this._rothConversionReducerFns(),
      ...this._inheritanceReducerFns(),
    ]);
  }

  _rothReducerFns() {
    return [
      // EVT-3: Roth withdrawal of earnings.
      //   US:  A qualified Roth distribution is excluded from gross income —
      //        IRC §408A(d)(1). Earnings are never US ordinary income here; the
      //        only US-side charge is the IRC §72(t) 10% additional tax when the
      //        distribution is non-qualified (age < 59.5), computed upstream.
      //   AU:  The ATO treats a US Roth IRA as a foreign trust and does not
      //        recognise its US tax-free status. For an AU resident the earnings
      //        (i.e. trust income, not corpus) are assessable as ordinary income
      //        on distribution under s99B ITAA 1936.
      //   Relief: None. The US imposes no income tax on the earnings, so there is
      //        no US tax for AU to relieve via FITO. This is the well-documented
      //        Roth "double-tax with no relief" outcome for Australian residents.
      ['ROTH_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const { amount, penaltyAmount, residency, auAssessableAmount } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usPenaltyYTD: state.usPenaltyYTD + penaltyAmount };
        if (isAuResident) {
          // Design 84 G2 — s99B reaches "amounts derived by the trust estate", so the
          // assessable base is the DERIVED slice of the earnings drawn, not all of
          // them: unrealised appreciation is derived by nobody. `auAssessableAmount` is
          // stamped by the apply reducer from the wrapper's own composition. Null
          // (no ledger / pre-G2 saved action) ⇒ assess everything, as before.
          //
          // The §72(t) penalty above is untouched — it is a US rule about earnings,
          // and it does not care how Australia characterises them.
          const assessable = Number.isFinite(auAssessableAmount) ? auAssessableAmount : amount;
          // Design 76 Gap B — attributed to the Roth's owner. No US-source removal
          // set is fed here on purpose: the US levies no income tax on these
          // earnings, so there is no US tax for the FITO limit to relieve.
          next = bookAuResident(state, next, action, 'rothAccount', {
            auOrdinaryIncomeYTD: toAUD(assessable, 'USD', state),
          });
        }
        return next;
      }],
    ];
  }

  _iraReducerFns() {
    return [
      // EVT-5: IRA contribution — US negative income (pre-tax deduction)
      ['IRA_CONTRIBUTION_TAX', (state, action) => ({
        ...state,
        usNegativeIncomeYTD: state.usNegativeIncomeYTD + action.amount,
      })],

      // EVT-6: IRA withdrawal of contributions — US ordinary income + optional penalty, no AU tax
      ['IRA_WITHDRAWAL_CONTRIB_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
        usPenaltyYTD:        state.usPenaltyYTD        + action.penaltyAmount,
      })],

      // EVT-7: IRA withdrawal of earnings — US-source ordinary income + optional
      //        penalty; AU ordinary income (worldwide) if resident, relieved by FITO.
      //
      //        Design 83 G10 part 3 — this stays on the Art. 21(3) removal-set path
      //        and does NOT become an Art. 18(1) pension. A drawdown sized by this
      //        year's cash need is not one of Art. 18(4)'s "periodic payments", so
      //        Art. 18 does not reach it; Art. 21(3) (as replaced by Protocol Art. 11)
      //        lets the US tax it as source State and Australia must credit that tax.
      ['IRA_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const { amount, penaltyAmount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
          usPenaltyYTD:        state.usPenaltyYTD        + penaltyAmount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceGeneralUsdYTD: (state.usSourceGeneralUsdYTD ?? 0) + amount,
          };
          // Design 76 Gap B — attributed to the IRA it was drawn from, rather than
          // halved across the household by computeAuTaxPerPerson at settle.
          next = bookAuResident(state, next, action, 'iraAccount', {
            auOrdinaryIncomeYTD:    aud,
            usSourceOrdinaryAudYTD: aud,
          });
        }
        return next;
      }],
    ];
  }

  _k401ReducerFns() {
    return [
      // EVT-24: 401k contribution — US negative income (pre-tax deduction)
      ['K401_CONTRIBUTION_TAX', (state, action) => ({
        ...state,
        usNegativeIncomeYTD: state.usNegativeIncomeYTD + action.amount,
      })],

      // EVT-25 (withdrawal): US ordinary income + optional early withdrawal penalty
      ['K401_WITHDRAWAL_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
        usPenaltyYTD:        state.usPenaltyYTD        + action.penaltyAmount,
      })],

      // EVT-40 (401k RMD): US ordinary income, no penalty. For an AU resident this
      //        is an Art. 18(1) pension — a periodic payment by reason of retirement
      //        in consideration for services rendered, and an employer plan at that,
      //        so 18(4) is met on every limb. Design 83 G10 part 3: Australia has the
      //        taxing right, the US charge is citizenship-only and therefore outside
      //        Art. 22(2), and relief comes from Art. 22(4) via the general basket.
      //        See `bookArt18Pension`.
      ['K401_RMD_TAX', (state, action) => {
        const { amount, residency } = action;
        const next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (residency !== 'AU') return next;
        // Design 76 Gap B — attributed to the 401k the RMD came from, rather than
        // halved across the household by computeAuTaxPerPerson at settle.
        return bookArt18Pension(state, next, action, 'k401Account', amount);
      }],
    ];
  }

  _usBrokerageReducerFns() {
    return [
      // EVT-11: fixed income earnings — US-source ordinary income; AU ordinary
      //         income if resident, relieved by FITO.
      ['FIXED_INCOME_EARNINGS_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        // Interest is net investment income (IRC §1411(c)(1)(A)(i)) → NIIT base.
        let next = {
          ...state,
          usOrdinaryIncomeYTD:       state.usOrdinaryIncomeYTD + amount,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourcePassiveUsdYTD: (state.usSourcePassiveUsdYTD ?? 0) + amount,
            // Design 83 G10 part 2 — subset tag on the US-source removal set.
            // Art. 11(2) caps the US tax Australia may credit under
            // Art. 22(2) at 10% of the GROSS amount, so the settle needs this slice
            // identifiable inside usSourceOrdinaryUsdYTD, not just its total.
            usSourceInterestUsdYTD: (state.usSourceInterestUsdYTD ?? 0) + amount,
          };
          // Design 76 Gap B — attributed to the account that earned it, rather than
          // halved across the household by computeAuTaxPerPerson at settle.
          next = bookAuResident(state, next, action, 'fixedIncomeAccount', {
            auOrdinaryIncomeYTD:    aud,
            usSourceOrdinaryAudYTD: aud,
          });
        }
        return next;
      }],

      // EVT-13: stock dividend — US-source ordinary income; AU ordinary income if
      //         resident, relieved by FITO.
      ['STOCK_DIVIDEND_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        // Dividends are net investment income (IRC §1411(c)(1)(A)(i)) → NIIT base.
        let next = {
          ...state,
          usOrdinaryIncomeYTD:       state.usOrdinaryIncomeYTD + amount,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourcePassiveUsdYTD: (state.usSourcePassiveUsdYTD ?? 0) + amount,
            // Design 83 G10 part 2 — subset tag on the US-source removal set.
            // Art. 10(2) caps the US tax Australia may credit under
            // Art. 22(2) at 15% of the GROSS amount, so the settle needs this slice
            // identifiable inside usSourceOrdinaryUsdYTD, not just its total.
            usSourceDividendsUsdYTD: (state.usSourceDividendsUsdYTD ?? 0) + amount,
          };
          // Design 76 Gap B — attributed to the account that received it, rather than
          // halved across the household by computeAuTaxPerPerson at settle.
          next = bookAuResident(state, next, action, 'usStockAccount', {
            auOrdinaryIncomeYTD:    aud,
            usSourceOrdinaryAudYTD: aud,
          });
        }
        return next;
      }],

      // Bond coupon interest (design 59, 66 §G2) — US-source ordinary income; AU
      // ordinary income if resident, relieved by FITO. Two carve-outs:
      //   - Treasury holdings: the FULL coupon is federally taxable — the Treasury
      //     exemption is state-only (31 U.S.C. § 3124); it lives in state classification.
      //   - Municipal holdings: the coupon is federally EXEMPT. `federalTaxableAmount`
      //     is the coupon excluding munis; it (not the full `amount`) drives the federal
      //     ordinary-income + NIIT base and the FITO relievable slice. Muni interest is
      //     NIIT-exempt, which follows automatically from taxing federalTaxableAmount.
      // For an AU resident the FULL coupon (including muni) is AU-assessable foreign
      // income; only the US-taxed slice is FITO-relievable, so the FITO removal set
      // records `federalTaxableAmount`, not the full coupon.
      ['BOND_COUPON_TAX', (state, action) => {
        const { amount, residency } = action;
        const fedAmount = action.federalTaxableAmount ?? amount;   // full coupon when unsplit (legacy)
        const isAuResident = residency === 'AU';
        let next = {
          ...state,
          usOrdinaryIncomeYTD:       state.usOrdinaryIncomeYTD + fedAmount,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + fedAmount,
        };
        if (isAuResident) {
          const audFull = toAUD(amount, 'USD', state);
          const audFed  = toAUD(fedAmount, 'USD', state);
          next = {
            ...next,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + fedAmount,
            usSourcePassiveUsdYTD: (state.usSourcePassiveUsdYTD ?? 0) + fedAmount,
            // Design 83 G10 part 2 — subset tag on the US-source removal set.
            // Art. 11(2) caps the US tax Australia may credit under
            // Art. 22(2) at 10% of the GROSS amount, so the settle needs this slice
            // identifiable inside usSourceOrdinaryUsdYTD, not just its total.
            usSourceInterestUsdYTD: (state.usSourceInterestUsdYTD ?? 0) + fedAmount,
          };
          // Design 76 Gap B — attributed to the account holding the bond. Note the
          // two amounts differ: AU assesses the FULL coupon (it grants no US-Treasury
          // exemption), while the US-source removal set tracks only the federally
          // taxable slice, so they must be booked as separate amounts.
          next = bookAuResident(state, next, action, 'usStockAccount', {
            auOrdinaryIncomeYTD:    audFull,
            usSourceOrdinaryAudYTD: audFed,
          });
        }
        return next;
      }],

      // EVT-15: stock withdrawal (sale) — US-source capital gain; AU capital gain
      // if resident (relieved by FITO). AU measures the gain from its stepped-up
      // (s855-45) cost base, so auGain ≤ gain (design 36 §12.2). The pre-move
      // appreciation (gain − auGain) is US-only. The FITO removal set records the
      // full US gain (USD) and the AU-taxed slice (AUD).
      ['STOCK_WITHDRAWAL_TAX', (state, action) => {
        const { gain, residency } = action;
        const auGain = action.auGain ?? gain;
        // CGT 50%-discount-eligible slice (design 62 §4): lots held ≥12 months from
        // the AU deemed-acquisition date. Defaults to the full auGain when absent.
        const auDiscountableGain = action.auDiscountableGain ?? auGain;
        const isAuResident = residency === 'AU';
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + gain };
        if (isAuResident) {
          const audGain = toAUD(auGain, 'USD', state);
          const audDiscountableGain = toAUD(auDiscountableGain, 'USD', state);
          // Design 83 G10 — §865(a) sources personal-property gain by the SELLER's
          // residence, so for an AU-resident US citizen this gain is FOREIGN source,
          // not US-source, whatever the account's domicile. It therefore books as
          // genuine foreign passive income and stays OUT of the Art. 22(2) removal
          // set: Australia is not crediting US tax on it, because the US taxes it
          // only by reason of citizenship (Art. 27(1)(b) refuses to deem that
          // US-source). When the §865(g)(2) 10% test fails, the gain reverts to
          // US-source and is re-sourced by Art. 27(1)(c) like any other item.
          const foreignSource = isPersonalPropertyGainForeignSource(state);
          next = foreignSource
            ? { ...next, foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + gain }
            : { ...next,
                usSourceCapGainsUsdYTD: (state.usSourceCapGainsUsdYTD ?? 0) + gain,
                usSourcePassiveUsdYTD:  (state.usSourcePassiveUsdYTD  ?? 0) + gain };
          // Design 76 Gap B — the gain belongs to the owner(s) of the account that
          // held the lots; the discountable slice must follow the same split so the
          // CGT discount is applied against the right person's gain.
          next = bookAuResident(state, next, action, 'usStockAccount', {
            auCapitalGainsYTD:      audGain,
            auDiscountableGainsYTD: audDiscountableGain,
            ...(foreignSource ? {} : { usSourceCapGainsAudYTD: audGain }),
          });
        }
        return next;
      }],
    ];
  }

  _realPropertyReducerFns() {
    return [
      // EVT-34: US house sale — US capital gain after $500K exemption. US-source.
      // For an AU resident the foreign house is also AU-assessable (design 62 §5):
      // the AU gain (from the s855-45 stepped-up basis, net of the AU main-residence
      // exemption) is added in AUD and recorded in the FITO removal set (US tax on
      // this US-source gain is relievable). Mirrors STOCK_WITHDRAWAL_TAX; no foreign-
      // passive basket entry (US-source income is not foreign for the US return).
      ['US_HOUSE_SALE_TAX', (state, action) => {
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + action.gain };
        if (action.residency === 'AU' && (action.auGain ?? 0) > 0) {
          const audGain         = toAUD(action.auGain, 'USD', state);
          const audDiscountable = toAUD(action.auDiscountableGain ?? action.auGain, 'USD', state);
          next = {
            ...next,
            usSourceCapGainsUsdYTD: (state.usSourceCapGainsUsdYTD ?? 0) + action.auGain,
            usSourcePassiveUsdYTD: (state.usSourcePassiveUsdYTD ?? 0) + action.gain,
          };
          // Design 76 Gap B — attributed to the property's owner(s), stamped inline
          // by the sale reducer (mirrors AU_HOUSE_SALE_TAX, which already did this).
          next = bookAuResident(state, next, action, null, {
            auCapitalGainsYTD:      audGain,
            auDiscountableGainsYTD: audDiscountable,
            usSourceCapGainsAudYTD: audGain,
          });
        }
        return next;
      }],
    ];
  }

  _rentalReducerFns() {
    return [
      // Design 48: US rental income — net rental income (may be negative) is
      // US-source ordinary income. For an AU resident it is also AU ordinary
      // income (worldwide), relieved by FITO. The FITO removal set records the
      // actual (possibly negative) income so the with/without marginal pass is exact.
      ['US_RENTAL_INCOME_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        // Net rental income is net investment income (IRC §1411(c)(1)(A)(i)) →
        // NIIT base. `amount` may be negative (a rental loss), which correctly
        // reduces the aggregate NII pool before it is floored at 0 in computeTax.
        let next = {
          ...state,
          usOrdinaryIncomeYTD:       state.usOrdinaryIncomeYTD + amount,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourcePassiveUsdYTD: (state.usSourcePassiveUsdYTD ?? 0) + amount,
          };
          // Design 76 Gap B — attributed to the property's owners (stamped inline), rather than
          // halved across the household by computeAuTaxPerPerson at settle.
          next = bookAuResident(state, next, action, null, {
            auOrdinaryIncomeYTD:    aud,
            usSourceOrdinaryAudYTD: aud,
          });
        }
        return next;
      }],
    ];
  }

  _incomeReducerFns() {
    return [
      // EVT-37: SS income — 85% taxable as US ordinary income (§86), and taxable
      // in the United States ONLY, whatever the recipient's residency.
      //
      // Design 83 G11 — Art. 18(2) of the 1982 Convention:
      //   "Social Security payments and other public pensions paid by one of the
      //    Contracting States to an individual who is a resident of the other
      //    Contracting State or a citizen of the United States shall be taxable
      //    only in the first-mentioned State."
      //
      // The paying State is the US, so US Social Security is taxable only in the
      // US — for an AU-resident US citizen on either limb of that sentence. The
      // Art. 1(3) saving clause does NOT let Australia reach it back: Art. 1(4)(a)
      // exempts "paragraph (2) or (6) of Article 18" from the saving clause by
      // name, and the 2001 Protocol amended neither Art. 1(4) nor Art. 18.
      //
      // So there is no AU booking, and therefore nothing to relieve: with no AU
      // tax on the payment there is no Art. 22(2) credit for Australia to give, and
      // no Art. 27(1)(c) re-sourcing — that provision resources income only "to the
      // extent necessary" to give effect to Art. 22(4) relief, and none is due.
      // The benefit therefore stays plain US-source income in no foreign §904
      // basket, exactly as it would for a US resident.
      ['SS_INCOME_TAX', (state, action) => {
        const taxable = action.amount * 0.85;
        return { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + taxable };
      }],

      // EVT-38: US wages — US-source ordinary income; AU per-person income if
      //         resident + personKey, else AU shared income. Relieved by FITO.
      ['WAGES_INCOME_TAX', (state, action) => {
        const { amount, residency, personKey } = action;
        const isAuResident = residency === 'AU';
        // Design 69: US wages are Social-Security-covered wages that fill the SS
        // wage base ahead of any self-employment income (SECA coordination).
        let next = {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
          usSsWagesYTD:        (state.usSsWagesYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const audAmount = toAUD(amount, 'USD', state);
          next = {
            ...next,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceGeneralUsdYTD: (state.usSourceGeneralUsdYTD ?? 0) + amount,
          };
          // Design 76 Gap B/D — attributed to the earner via personKey; personal
          // services income is never apportionable. Replaces a hand-rolled per-person
          // block that booked the income per person but left its AUD removal set on
          // the household scalar, so the FITO limit was sized off a mismatched base.
          next = bookAuResident(state, next, action, null, {
            auOrdinaryIncomeYTD:    audAmount,
            usSourceOrdinaryAudYTD: audAmount,
          });
        }
        return next;
      }],

      // EVT-48 / design 69: US self-employment income — US-source ordinary income
      //         AND US self-employment tax base (SECA); AU ordinary income if
      //         resident, relieved by FITO. usSeEarningsYTD is the net SE earnings
      //         accumulator consumed by computeTax()'s SECA computation. AU per-
      //         person attribution mirrors WAGES_INCOME_TAX.
      ['SE_INCOME_US_TAX', (state, action) => {
        const { amount, residency, personKey } = action;
        const isAuResident = residency === 'AU';
        let next = {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
          usSeEarningsYTD:     (state.usSeEarningsYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceGeneralUsdYTD: (state.usSourceGeneralUsdYTD ?? 0) + amount,
          };
          // Design 76 Gap B/D — attributed to the earner via personKey; personal
          // services income is never apportionable. Replaces a hand-rolled per-person
          // block that booked the income per person but left its AUD removal set on
          // the household scalar, so the FITO limit was sized off a mismatched base.
          next = bookAuResident(state, next, action, null, {
            auOrdinaryIncomeYTD:    aud,
            usSourceOrdinaryAudYTD: aud,
          });
        }
        return next;
      }],

      // EVT-50: bonus — US-source ordinary income; AU ordinary income if resident,
      //         relieved by FITO.
      ['BONUS_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        // Design 69: a bonus is W-2 wages — Social-Security-covered, fills the base.
        let next = {
          ...state,
          usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount,
          usSsWagesYTD:        (state.usSsWagesYTD ?? 0) + amount,
        };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceGeneralUsdYTD: (state.usSourceGeneralUsdYTD ?? 0) + amount,
          };
          // Design 76 Gap B — attributed to the earner (personKey) — W-2 wages are never apportionable, rather than
          // halved across the household by computeAuTaxPerPerson at settle.
          next = bookAuResident(state, next, action, null, {
            auOrdinaryIncomeYTD:    aud,
            usSourceOrdinaryAudYTD: aud,
          });
        }
        return next;
      }],

      // EVT-51: company sale — US-source capital gain; AU capital gain if resident,
      //         relieved by FITO.
      ['COMPANY_SALE_TAX', (state, action) => {
        const { gain, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + gain };
        if (isAuResident) {
          // AU assesses from the s855-45 stepped-up basis (design 72 §3) — only
          // post-arrival appreciation — while the US taxes the full gain from the
          // original basis. Falls back to `gain` when no step-up was stamped.
          const auGainUsd = action.auGain ?? gain;
          const audGain = toAUD(auGainUsd, 'USD', state);
          // Design 83 G10 — §865(a) sources personal-property gain by the SELLER's
          // residence, so for an AU-resident US citizen this gain is FOREIGN source,
          // not US-source, whatever the account's domicile. It therefore books as
          // genuine foreign passive income and stays OUT of the Art. 22(2) removal
          // set: Australia is not crediting US tax on it, because the US taxes it
          // only by reason of citizenship (Art. 27(1)(b) refuses to deem that
          // US-source). When the §865(g)(2) 10% test fails, the gain reverts to
          // US-source and is re-sourced by Art. 27(1)(c) like any other item.
          const foreignSource = isPersonalPropertyGainForeignSource(state);
          next = foreignSource
            ? { ...next, foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + gain }
            : { ...next,
                usSourceCapGainsUsdYTD: (state.usSourceCapGainsUsdYTD ?? 0) + gain,
                usSourcePassiveUsdYTD:  (state.usSourcePassiveUsdYTD  ?? 0) + gain };
          // Design 76 Gap B — attributed to the equity holder, stamped inline by the
          // sale reducer (company equity has no account state key).
          next = bookAuResident(state, next, action, null, {
            auCapitalGainsYTD:      audGain,
            // Company shares carry no per-lot 12-month tracking here, so the whole
            // gain stays discount-eligible (design 62 §4 — the residency holding-
            // period gate targets brokerage lots; company/collectible/property
            // holding-period gating is out of Gap 1's scope).
            auDiscountableGainsYTD: audGain,
            ...(foreignSource ? {} : { usSourceCapGainsAudYTD: audGain }),
          });
        }
        return next;
      }],
    ];
  }

  _collectibleReducerFns() {
    return [
      // EVT-36/46: collectible sale — US-source collectible gain (28% rate); AU
      // capital gain if resident, relieved by FITO. The US collectible bucket is
      // separate from usCapitalGainsYTD, but the design's FITO removal set carries
      // only ordinary/capGains pairs; the collectible slice is folded into the
      // capGains removal set (the AU-side FITO limit is exact — AU taxes it as a
      // capital gain; the US §4.6 marginal pass is a conservative approximation for
      // this rare AU-resident-collectible-sale case).
      ['COLLECTIBLE_SALE_TAX', (state, action) => {
        const { gain, residency } = action;
        const isAuResident = residency === 'AU';
        let next = {
          ...state,
          usCollectibleGainsYTD: (state.usCollectibleGainsYTD ?? 0) + gain,
        };
        if (isAuResident) {
          const audGain = toAUD(gain, 'USD', state);
          // Design 83 G10 — §865(a) sources personal-property gain by the SELLER's
          // residence, so for an AU-resident US citizen this gain is FOREIGN source,
          // not US-source, whatever the account's domicile. It therefore books as
          // genuine foreign passive income and stays OUT of the Art. 22(2) removal
          // set: Australia is not crediting US tax on it, because the US taxes it
          // only by reason of citizenship (Art. 27(1)(b) refuses to deem that
          // US-source). When the §865(g)(2) 10% test fails, the gain reverts to
          // US-source and is re-sourced by Art. 27(1)(c) like any other item.
          const foreignSource = isPersonalPropertyGainForeignSource(state);
          next = foreignSource
            ? { ...next, foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + gain }
            : { ...next,
                usSourceCapGainsUsdYTD: (state.usSourceCapGainsUsdYTD ?? 0) + gain,
                usSourcePassiveUsdYTD:  (state.usSourcePassiveUsdYTD  ?? 0) + gain };
          // Design 76 Gap B — attributed to the collectible's owner(s), stamped
          // inline by the sale reducer (a collectible has no account state key).
          next = bookAuResident(state, next, action, null, {
            auCapitalGainsYTD:      audGain,
            // Collectibles carry no per-lot 12-month tracking here (design 62 §4).
            auDiscountableGainsYTD: audGain,
            ...(foreignSource ? {} : { usSourceCapGainsAudYTD: audGain }),
          });
        }
        return next;
      }],
    ];
  }

  _iraRolloverReducerFns() {
    return [
      // EVT-35: IRA rollover withdrawal — US-source ordinary income (no penalty);
      //         AU ordinary income if resident, relieved by FITO. Design 83 G10
      //         part 3: a discretionary drawdown, so Art. 21(3) and not Art. 18(1) —
      //         same reasoning as IRA_WITHDRAWAL_EARNINGS_TAX above.
      ['IRA_ROLLOVER_WITHDRAWAL_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (isAuResident) {
          const aud = toAUD(amount, 'USD', state);
          next = {
            ...next,
            usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + amount,
            usSourceGeneralUsdYTD: (state.usSourceGeneralUsdYTD ?? 0) + amount,
          };
          // Design 76 Gap B — attributed to the rollover IRA, rather than
          // halved across the household by computeAuTaxPerPerson at settle.
          next = bookAuResident(state, next, action, 'iraAccount', {
            auOrdinaryIncomeYTD:    aud,
            usSourceOrdinaryAudYTD: aud,
          });
        }
        return next;
      }],

      // EVT-40: IRA RMD — US ordinary income (no penalty). For an AU resident this is
      //         an Art. 18(1) pension: a §401(a)(9) required minimum distribution is
      //         periodic and is made by reason of retirement, so Art. 18(4) is met.
      //         Design 83 G10 part 3 — see `bookArt18Pension`.
      //
      //         The residual doubt is 18(4)'s "in consideration for services
      //         rendered", which fits a 401(k) rollover squarely and a purely
      //         contributory IRA badly; the model carries no field separating the two
      //         inside an IRA, and the reference plan's IRA is rollover-funded
      //         (K401_TO_IRA_CONVERSION). Recorded in design 83 §17, not papered over.
      ['IRA_RMD_TAX', (state, action) => {
        const { amount, residency } = action;
        const next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (residency !== 'AU') return next;
        // Design 76 Gap B — attributed to the IRA the RMD came from, rather than
        // halved across the household by computeAuTaxPerPerson at settle.
        return bookArt18Pension(state, next, action, 'iraAccount', amount);
      }],
    ];
  }

  _rothRolloverReducerFns() {
    return [
      // EVT-43: Roth rollover (converted) principal withdrawal.
      //   US:  No income tax — the US taxed the conversion at EVT-52. The only
      //        US charge is the IRC §408A(d)(3)(F) 5-year recapture: a
      //        distribution of converted dollars within the 5-taxable-year window
      //        (from Jan 1 of the conversion year) incurs the IRC §72(t) 10%
      //        additional tax when the owner is under 59½.
      //   AU:  The IRA-contribution-sourced portion is corpus (s99B-exempt), but
      //        the IRA-earnings-sourced portion (auAssessableAmount) is pre-tax
      //        money that would have been assessable if derived directly, so it
      //        does NOT qualify for the corpus exemption and is assessable as
      //        ordinary income under s99B ITAA 1936 when an AU resident draws it.
      //        This defers — rather than eliminates — AU tax on converted IRA
      //        earnings. The per-lot window test, penalty base, and AU-assessable
      //        share are computed upstream (roth-rollover-classes.js).
      //   Relief: None — no US income tax is levied on this distribution.
      ['ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX', (state, action) => {
        const { penaltyAmount = 0, auAssessableAmount = 0, residency } = action;
        let next = { ...state, usPenaltyYTD: state.usPenaltyYTD + penaltyAmount };
        if (residency === 'AU' && auAssessableAmount > 0) {
          // Design 76 Gap B — attributed to the rollover Roth's owner. As with EVT-3,
          // no US-source removal set: the US taxes none of this, so FITO has nothing
          // to relieve.
          next = bookAuResident(state, next, action, 'rothAccount', {
            auOrdinaryIncomeYTD: toAUD(auAssessableAmount, 'USD', state),
          });
        }
        return next;
      }],

      // EVT-44: Roth rollover earnings withdrawal — earnings that accrued inside
      //         the Roth on rolled-over (converted) principal.
      //   US:  Tax-free as a qualified Roth distribution (IRC §408A(d)(1)); the
      //        only US charge is the IRC §72(t) 10% additional tax on a
      //        non-qualified (age < 59½) distribution of earnings, computed
      //        upstream. The converted principal is corpus (EVT-43); only
      //        post-conversion growth is earnings.
      //   AU:  Assessable to an AU resident as ordinary income under s99B
      //        ITAA 1936 (foreign-trust earnings; corpus excluded).
      //   Relief: None — the US levies no income tax on the earnings, so there is
      //        no US tax to relieve via FITO. Matches the EVT-44 spec row.
      ['ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const { amount, penaltyAmount = 0, residency } = action;
        let next = { ...state, usPenaltyYTD: state.usPenaltyYTD + penaltyAmount };
        if (residency === 'AU') {
          // Design 76 Gap B — attributed to the rollover Roth's owner (see EVT-3).
          next = bookAuResident(state, next, action, 'rothAccount', {
            auOrdinaryIncomeYTD: toAUD(amount, 'USD', state),
          });
        }
        return next;
      }],
    ];
  }

  _rothConversionReducerFns() {
    return [
      // EVT-52: IRA→Roth conversion.
      //   US:  Ordinary income at conversion — the converted pre-tax amount is
      //        included in gross income (IRC §408A(d)(3)(A); §408(d)(1)). This is
      //        a US event for the account owner regardless of AU residency.
      //   AU:  No tax at conversion. s99B ITAA 1936 assesses only amounts "paid
      //        to, or applied for the benefit of" an Australian-resident
      //        beneficiary — i.e. an actual distribution received by the person.
      //        A conversion merely moves funds within the US retirement system
      //        (IRA trust → Roth trust); nothing is paid to or made available to
      //        the individual, so there is no s99B receipt and no assessable
      //        amount. AU tax arises only on later distribution from the Roth
      //        (corpus EVT-43 = not assessable; earnings EVT-44 = s99B income).
      //   Relief: None — no AU tax is levied at conversion; the US tax on the
      //        conversion is not US-source-vs-AU double taxation to relieve.
      ['ROTH_CONVERSION_TAX', (state, action) => ({
        ...state,
        usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + action.amount,
      })],
    ];
  }

  _inheritanceReducerFns() {
    return [
      // Design 63 §6.5: Nebraska inheritance tax — heir-paid STATE liability keyed
      // to the decedent's NE situs (the handler computed the class-based amount).
      // Recorded in neInheritanceTaxYTD; the cash is debited immediately by
      // InheritanceNeTaxApplyReducer. Not federal, not marginal.
      ['NE_INHERITANCE_TAX', (state, action) => ({
        ...state,
        neInheritanceTaxYTD: (state.neInheritanceTaxYTD ?? 0) + (action.amount ?? 0),
      })],

      // Design 63 §6.2: SECURE 10-year inherited traditional IRA/401(k)
      // distribution — IRD, taxed as US ordinary income to the heir (no basis,
      // no penalty). Inherited Roth emits no tax action (tax-free), so it never
      // reaches this classifier.
      //
      // Design 83 G10 part 3: for an AU-resident heir this is an Art. 18(1) pension,
      // and it is the cleanest case in the family — Art. 18(4) reaches periodic
      // payments made "by reason of retirement **or death**" in terms, and a SECURE
      // 10-year drawdown is a defined series rather than a discretionary one. Mirrors
      // the RMD classifiers; see `bookArt18Pension`.
      ['INHERITED_RA_DISTRIBUTION_TAX', (state, action) => {
        const { amount, residency } = action;
        const next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + amount };
        if (residency !== 'AU') return next;
        // Design 76 Gap B — attributed to the inherited account's beneficiary, rather
        // than halved across the household by computeAuTaxPerPerson at settle.
        return bookArt18Pension(state, next, action, null, amount);
      }],
    ];
  }
}
