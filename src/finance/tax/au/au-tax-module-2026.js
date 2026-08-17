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
import { accumulateByOwnership, resolveAttributionAsset, ownershipFractions } from '../../ownership-utils.js';
import { toUSD, toAUD } from '../tax-fx.js';
import { characterizeCapitalGain, characterizeAuCapitalGain, basketCapGainPatch } from '../capital-gain-character.js';
import { frankingCreditOn } from './franking.js';
import { us121Exclusion, cgtDiscountFraction,
         US_PRIMARY_HOME_EXCLUSION_MFJ, US_PRIMARY_HOME_EXCLUSION_SINGLE } from '../../account-rules/main-residence.js';

const SUPER_TAX_RATE = 0.15;

/**
 * Book AUD-denominated **personal services income** — wages (`AU_WAGES_INCOME_TAX`)
 * and self-employment (`AU_SE_INCOME_TAX`) — against three independent axes.
 *
 * Design 73 §6b. The two classifiers used to be written out separately and each
 * collapsed the axes into a single test, in opposite directions: wages branched on
 * source alone, SE on residency alone. Each was therefore right in exactly the half
 * the other got wrong, and the shared helper exists so that cannot drift apart
 * again — the bookings are identical, and the only thing that ever differed between
 * a wage and a sole trader's fee here was which comment block sat above it. (AU SE
 * income never feeds `usSeEarningsYTD`: SECA does not reach it under the
 * totalization agreement, and that stays true by omission on both paths.)
 *
 * **Axis 1 — AU assessability**, ITAA 1997 s6-5. Subsection (2): an Australian
 * resident is assessed on ordinary income "from all sources, whether in or out of
 * Australia". Subsection (3): a foreign resident is assessed on ordinary income
 * "from all Australian sources". Either limb is sufficient, which is precisely what
 * neither classifier used to say. Source of services income is the place of
 * performance — `workCountry`, not the payment currency, the payer's residence or
 * the account the money lands in (FCT v French (1957) 98 CLR 398 [R7], where an
 * Australian engineer's New Zealand weeks were NZ-source although the salary was
 * paid into his Australian bank account throughout).
 *
 * **Axis 2 — which way treaty relief runs**, and therefore which US accumulator the
 * income belongs in. AU-source ⇒ genuinely foreign income of a US citizen ⇒ the
 * §904 general numerator `foreignGeneralIncomeYTD`. US-source income of an AU
 * resident ⇒ the US taxes as source State and Australia gives the credit (Art 22(2)),
 * so it belongs in the *removal set* (`usSource*UsdYTD` + `usSourceOrdinaryAudYTD`)
 * that sizes the FITO limit — never in both. Getting this backwards is not a
 * rounding error: US-source income in the general numerator inflates the §904
 * limitation and lets unrelated foreign taxes be credited against US tax on US
 * income, while an AU assessment with no removal-set entry is an assessment with no
 * relief attached to it.
 *
 * Treaty authority is Art 15(1) for employment and Art 14 for services performed in
 * an independent capacity: taxable only in the residence State "unless the
 * employment is exercised / such services are performed in the other State". Both
 * articles *add* a source-State right; neither removes the residence State's, which
 * is why axis 1 has two limbs and axis 2 has one. Neither article is touched by the
 * 2001 Protocol.
 *
 * **Axis 3 — the §911 FEIE cap accumulator**, which needs both: foreign *earned*
 * income (AU-sourced) of a US person whose tax home is abroad (AU-resident).
 * `_computeFeie` independently skips anyone whose residency is not 'AU', so writing
 * only on the conjunction keeps that gate a second line of defence rather than the
 * only thing standing between a US resident and an exclusion they cannot claim —
 * and on the source limb it is the *only* guard, since a US-performed AUD job by an
 * AU resident passes the residency test that gate applies.
 *
 * TODO(design 73 §4): Art 27(2) is an anti-double-exemption rule. Where AU-performed
 * services are exempted at source by the Art 15(2) / Art 14 presence tests AND
 * excluded from US tax by the FEIE, Australia may tax after all — "the purpose of the
 * exemption at source is to avoid double taxation, not to provide double exemption".
 * Neither presence test is modelled, so the source limb always assesses and cannot
 * produce the taxed-by-neither outcome; guard it if either test is ever added.
 *
 * @param {object} state   state before the action
 * @param {object} action  `{ amount (AUD), residency, personKey, workCountry }`
 * @returns {object} next state
 */
function bookAuPersonalServicesIncome(state, action) {
  const { amount, residency, personKey } = action;
  // Absent on pre-73 saved actions ⇒ the earner works where they live, which is the
  // pre-73 assumption and keeps every scenario that never sets it byte-identical.
  const workCountry  = action.workCountry ?? residency ?? null;
  const isAuSourced  = workCountry === 'AU';
  const isAuResident = residency === 'AU';
  const usd = toUSD(amount, 'AUD', state);

  // Always on the US worldwide return, whatever the source: the model's earners are
  // US citizens, taxed on worldwide income however it is denominated.
  let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + usd };

  // Axis 2 — direction of relief. Mutually exclusive by construction.
  if (isAuSourced) {
    next = { ...next, foreignGeneralIncomeYTD: (state.foreignGeneralIncomeYTD ?? 0) + usd };
  } else if (isAuResident) {
    next = {
      ...next,
      usSourceOrdinaryUsdYTD: (state.usSourceOrdinaryUsdYTD ?? 0) + usd,
      usSourceGeneralUsdYTD:  (state.usSourceGeneralUsdYTD  ?? 0) + usd,
    };
  }

  // Axis 1 — neither limb of s6-5 reached: a foreign resident's foreign-source
  // income. The AUD still lands in the AU account; this is a tax classification,
  // not a cash-flow change, so the AU return simply shows nothing.
  if (!isAuResident && !isAuSourced) return next;

  // AU-source services income is assessable whoever performs it. For a resident that
  // was already true; for a foreign resident it is assessed at foreign-resident
  // marginal rates on a lodged return (30% from the first dollar, no tax-free
  // threshold, no Medicare levy [R3]), NOT withheld finally at source — services
  // income was never a withholding category; only interest, unfranked dividends and
  // royalties are [R1, R5]. Both limbs feed the accumulator the non-resident bracket
  // path already reads.
  //
  // The AUD twin of the removal set: the US-source slice of AU assessable income,
  // which `_assessResidentPreFito` subtracts to size the s770-75 FITO limit. It is a
  // *subset* of the assessable figure, so it is written alongside, never instead.
  const usSourceAud  = isAuSourced ? 0 : amount;
  const usePerPerson = personKey != null && state.auPersonOrdinaryIncomeYTD != null;

  if (!usePerPerson) {
    return {
      ...next,
      auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount,
      ...(usSourceAud > 0
        ? { usSourceOrdinaryAudYTD: (state.usSourceOrdinaryAudYTD ?? 0) + usSourceAud }
        : {}),
    };
  }
  return {
    ...next,
    // Attributed to the *earner* via personKey, not to the AU account's owner:
    // personal services income belongs to the person who performed the services and
    // is never apportionable (design 76 Gap B/D).
    auPersonOrdinaryIncomeYTD: { ...state.auPersonOrdinaryIncomeYTD, [personKey]: (state.auPersonOrdinaryIncomeYTD[personKey] ?? 0) + amount },
    ...(usSourceAud > 0
      ? { auPersonUsSourceOrdinaryAudYTD: { ...(state.auPersonUsSourceOrdinaryAudYTD ?? {}), [personKey]: ((state.auPersonUsSourceOrdinaryAudYTD?.[personKey]) ?? 0) + usSourceAud } }
      : {}),
    ...(isAuResident && isAuSourced
      ? { auPersonEarnedIncomeYTD: { ...(state.auPersonEarnedIncomeYTD ?? {}), [personKey]: ((state.auPersonEarnedIncomeYTD?.[personKey]) ?? 0) + amount } }
      : {}),
  };
}

/**
 * AuTaxModule2026 — AU tax classification rules for FY starting July 2026.
 *
 * Returns Stage-2 (TAX_CALC priority) reducer functions for all _TAX child
 * actions emitted by the AU account module's Stage-1 reducers.  Also handles
 * US tax effects that originate from AU account events.
 *
 * Covered events:
 *   EVT-16 to 19  AU Savings
 *   EVT-20 to 23  Superannuation
 *   EVT-26 to 32  AU Brokerage
 *   EVT-33        AU House Sale
 *
 * Design 52 — cross-border relief. Each AU-source dollar (taxed by the US on a
 * citizen's worldwide return) is now tagged into a §904 basket numerator, in USD:
 *   General  — AU wages / self-employment (also FEIE-earned; per-person cap)
 *   Passive  — AU rental, interest, dividends, brokerage/property capital gains
 * These numerators feed the per-basket §904 FTC on the US return (design 52 §4.3).
 */
export class AuTaxModule2026 extends BaseTaxModule {
  get countryCode() { return 'AU'; }
  get year()        { return 2026; }

  /**
   * The Australian-assessable slice of an AU house-sale gain — s118-185 applied to the
   * SIGNED gain, design 83 G7 step 2 and design 90 §5.
   *
   * Static and shared because two year-modules need the identical figure and they
   * reached different answers when each computed its own. FY2026 books it into
   * `auCapitalGainsYTD`; the FY2027 reform module books the *assessable* gain into
   * `auRealCapitalGainsYTD`, which is the bucket `AuTaxRates2027` actually taxes. When
   * the reform module used the raw `action.gain` instead, the exemption was computed,
   * printed on the return's "Capital Gains" line, and then thrown away one line later —
   * the return showed an 11.77% main-residence exemption and taxed 100% of the gain.
   *
   * That defect could only surface on a dwelling whose exemption was non-zero, so it sat
   * behind the sale-date day-count bug that was forcing `auTaxableFraction` to 1 on the
   * very scenarios that would have caught it.
   *
   * `gain` is floored at zero while the signed fields are not, so the min() picks the
   * signed figure whenever the disposal was a loss: the main-residence concession
   * disregards a loss on the exempt portion exactly as it disregards a gain, so a partly
   * exempt dwelling surrenders the same share of both.
   *
   * @param {object} action an AU_HOUSE_SALE_TAX payload
   * @returns {number} the assessable gain in the property's own currency (AUD)
   */
  static auAssessableHouseGain(action) {
    const gain              = action?.gain ?? 0;
    const auTaxableFraction = action?.auTaxableFraction ?? 1;   // pre-G7 default: all of it
    const auSignedGain      = (action?.auShortTermGain ?? null) != null || (action?.auLongTermGain ?? null) != null
      ? (action.auShortTermGain ?? 0) + (action.auLongTermGain ?? 0)
      : gain;
    return +(Math.min(gain, auSignedGain) * auTaxableFraction).toFixed(2);
  }

  getReducerFns() {
    return new Map([
      ...this._auSavingsReducerFns(),
      ...this._auFixedIncomeReducerFns(),
      ...this._superReducerFns(),
      ...this._auBrokerageReducerFns(),
      ...this._realPropertyReducerFns(),
      ...this._rentalReducerFns(),
      ...this._investmentInterestReducerFns(),
      ...this._auIncomeReducerFns(),
      ...this._auWagesReducerFns(),
      ...this._inheritanceReducerFns(),
    ]);
  }

  _inheritanceReducerFns() {
    return [
      // Design 63 §6.4: AU superannuation death benefit paid to a non-dependant —
      // a FINAL tax (taxable component × 15%, +2% Medicare when paid direct),
      // already withheld from the net lump sum credited to AU cash by
      // InheritApplyReducer. Recorded here in auSuperDeathTaxYTD (reporting; not a
      // marginal-rate addition to auOrdinaryIncomeYTD).
      ['SUPER_DEATH_BENEFIT_TAX', (state, action) => ({
        ...state,
        auSuperDeathTaxYTD: (state.auSuperDeathTaxYTD ?? 0) + (action.amount ?? 0),
      })],
    ];
  }

  _auWagesReducerFns() {
    return [
      // Design 50: wages paid in AUD. Design 73 Gap 1 made the classifier read
      // `workCountry` (place of performance) rather than the payment currency;
      // design 73 §6b separated that source question from the residency question it
      // had been fused to, and moved the whole booking into
      // `bookAuPersonalServicesIncome` — see there for the three axes, the s6-5
      // limbs and the treaty articles behind each.
      //
      // What §6b changed here: an AU resident performing the work in the US used to
      // fall off this classifier with nothing booked to the AU return at all. Art
      // 15(1) grants the US a source-State right in that case; it does not take away
      // Australia's residence-State right, and s6-5(2) assesses the resident on
      // income "from all sources, whether in or out of Australia". It is now
      // assessed, with the US-source markers that fund the FITO relief against it.
      ['AU_WAGES_INCOME_TAX', (state, action) => bookAuPersonalServicesIncome(state, action)],
    ];
  }

  _rentalReducerFns() {
    return [
      // Design 48: AU rental income — net rental income (may be negative) is
      // AU-sourced; always US ordinary income (worldwide) and always AU ordinary
      // income. FTC never goes negative.
      // Design 52: AU-source → §904 Passive numerator (loss years contribute 0).
      // Design 73 Gap 3 step 1: the Passive numerator is NOT gated on the owner's
      // residency. Source follows the situs of the property (treaty Art 6), so
      // AU-situs rent is foreign-source to the US however the owner is resident;
      // gating it starved the passive limitation for exactly the taxpayer who
      // needs it — a US resident paying AU tax on AU rent. The Math.max(0) floor
      // stays on the basket numerator only: a rental loss contributes zero
      // limitation room, but must remain signed wherever it is assessed.
      //
      // Design 73 Gap 3 step 2: net rent from AU real property is assessable in
      // Australia whoever owns it. There was no non-resident branch at all — the
      // income reached usOrdinaryIncomeYTD and stopped, so a US-resident landlord
      // with an Australian property got a tax-free rent stream. Rental income is
      // sourced where the property is, always: treaty Art 6 is a sourcing provision
      // that, unlike the dividend/interest/royalty articles, imposes NO rate cap on
      // the source state, and the ATO is explicit that a foreign resident earning
      // Australian rent should lodge annually and declare NET rental income [R12].
      // It is not withholding income and there is no exemption.
      //
      // The amount stays SIGNED — in every accumulator, including the §904 passive
      // basket. A loss month contributes zero *limitation room*, but the floor
      // belongs on the YEAR's net rental income, not on each month: this action
      // fires monthly, so flooring per event summed the positive months and threw
      // the negative ones away, leaving foreignPassiveIncomeYTD larger than the
      // rent that actually reached usOrdinaryIncomeYTD. The baskets then no longer
      // partitioned gross income and the §904 fractions could sum past 1 — caught
      // by _assertFtcInvariants once design 83 G1 landed. computeTax applies the
      // single annual Math.max(0, …) when it forms the basket numerator.
      //
      // Step 3: attributed by ownership rather than written to the household
      // scalar. perPersonShare splits a household scalar evenly across residents,
      // so a property owned outright by one spouse was taxed half to each.
      ['AU_RENTAL_INCOME_TAX', (state, action) => {
        const { amount, ownershipType, ownerId, owners } = action;
        // Net rental income is net investment income for a US person on their
        // worldwide return (IRC §1411(c)(1)(A)(i)) → NIIT base, mirroring
        // US_RENTAL_INCOME_TAX. The amount stays SIGNED into the NII pool so a
        // rental loss reduces aggregate NII before it is floored at 0 in computeTax.
        // The FTC cannot offset NIIT, so AU-taxed rent still bears the 3.8% surtax.
        const usd = toUSD(amount, 'AUD', state);
        let next = {
          ...state,
          usOrdinaryIncomeYTD:      state.usOrdinaryIncomeYTD + usd,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + usd,
          foreignPassiveIncomeYTD:  (state.foreignPassiveIncomeYTD ?? 0) + usd,
          // §469 (design 86 G5): rental activity is passive PER SE. Tracked signed,
          // and ALSO in the foreign companion — an AU property is foreign-source, so a
          // suspended loss must leave the passive §904 basket as well, or the basket
          // accumulators stop partitioning gross income and the limitation assertion
          // fires (G5b).
          usPassiveActivityIncomeYTD:        (state.usPassiveActivityIncomeYTD ?? 0) + usd,
          usForeignPassiveActivityIncomeYTD: (state.usForeignPassiveActivityIncomeYTD ?? 0) + usd,
        };
        // Resident or not, AU-situs rent is AU assessable income on the marginal
        // bracket path — the resident schedule for a resident, the foreign-resident
        // schedule (30% from the first dollar, no Medicare levy) for a non-resident.
        const perPerson = state.people != null && state.auPersonOrdinaryIncomeYTD != null;
        // Pre-73 actions carry no ownership; fall back to the household scalar,
        // which is the old behaviour rather than a silent mis-attribution.
        const asset = ownershipType != null || ownerId != null || owners != null
          ? { ownershipType, ownerId, owners }
          : null;
        return perPerson && asset
          ? { ...next, auPersonOrdinaryIncomeYTD: accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, asset, amount, state.people) }
          : { ...next, auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount };
      }],
    ];
  }

  _investmentInterestReducerFns() {
    return [
      // Design 86 G3 error 1 — interest on a STANDALONE AU loan put to an
      // income-producing use. The mirror of the US module's classifier; see there for
      // why this cannot reuse the rental action (§469 would suspend it) and why the
      // US side accumulates positive rather than netting into usOrdinaryIncomeYTD
      // (G5b: it would break the §904 partition).
      //
      // AU: s8-1 allows the interest against assessable income generally, with no
      // quarantining — that is what negative gearing IS, and it is the substantive
      // difference from the US treatment of the very same loan. Booked as a NEGATIVE
      // amount by ownership, so a jointly-held loan splits like a jointly-held asset.
      // If it drives the year negative, G1's Div 36 pool carries the loss forward;
      // nothing extra is needed here, which is the whole reason the AU half of this
      // gap is ten lines and the US half is a limitation.
      //
      // A foreign resident is assessed only on AU-source income, and the borrowing
      // funded a portfolio that is not it — no AU booking. The US booking is
      // unconditional: a US citizen is taxed on worldwide income wherever resident.
      ['AU_INVESTMENT_INTEREST_DEDUCTION', (state, action) => {
        const { amount: raw, ownershipType, ownerId, owners, residency } = action;
        const amount = Math.max(0, raw ?? 0);
        if (amount === 0) return state;
        const next = {
          ...state,
          usInvestmentInterestYTD: (state.usInvestmentInterestYTD ?? 0) + toUSD(amount, 'AUD', state),
        };
        if (residency !== 'AU') return next;

        const perPerson = state.people != null && state.auPersonOrdinaryIncomeYTD != null;
        const asset = ownershipType != null || ownerId != null || owners != null
          ? { ownershipType, ownerId, owners }
          : null;
        return perPerson && asset
          ? { ...next, auPersonOrdinaryIncomeYTD: accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, asset, -amount, state.people) }
          : { ...next, auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD - amount };
      }],
    ];
  }

  _auSavingsReducerFns() {
    return [
      // EVT-18/19: AU savings earnings — always US ordinary income;
      //   AU ordinary income for residents, AU NR withholding for non-residents.
      // Design 52: AU-source interest → §904 Passive numerator.
      // Design 73 Gap 2: interest withholding is final at the Art 11(2) treaty cap
      // of 10%, not the 15% dividend rate the pooled bucket applied.
      ['AU_SAVINGS_EARNINGS_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        // Design 76 Gap C: attribute to the account that earned the interest. This
        // action is emitted from five sites (AU savings, and the cash-sleeve /
        // bond-sleeve / bond-accretion reducers on their 'au' taxMode), each of
        // which stamps the account it credited.
        const account = resolveAttributionAsset(state, action, 'auSavingsAccount');
        const perPerson = state.people != null && account != null;
        // AU-source interest is net investment income for a US person
        // (IRC §1411(c)(1)(A)(i)) → NIIT base, mirroring FIXED_INCOME_EARNINGS_TAX.
        // The FTC cannot offset NIIT, so AU-taxed interest still bears the 3.8% surtax.
        const usd = toUSD(amount, 'AUD', state);
        let next = {
          ...state,
          usOrdinaryIncomeYTD:      state.usOrdinaryIncomeYTD + usd,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + usd,
          foreignPassiveIncomeYTD:  (state.foreignPassiveIncomeYTD ?? 0) + usd,
        };
        if (isAuResident) {
          next = {
            ...next,
            ...(perPerson
              ? { auPersonOrdinaryIncomeYTD: accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, account, amount, state.people) }
              : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount }),
          };
        } else {
          next = {
            ...next,
            ...(perPerson
              ? { auPersonNrWithholdingInterestYTD: accumulateByOwnership(state.auPersonNrWithholdingInterestYTD ?? {}, account, amount, state.people) }
              : { auNrWithholdingInterestYTD: (state.auNrWithholdingInterestYTD ?? 0) + amount }),
          };
        }
        return next;
      }],
    ];
  }

  _auFixedIncomeReducerFns() {
    return [
      // AU fixed income interest — always US ordinary income;
      //   AU ordinary income for residents, AU NR withholding for non-residents.
      // Design 52: AU-source interest → §904 Passive numerator.
      // Design 73 Gap 2: final at the Art 11(2) 10% interest cap, as above.
      ['AU_FIXED_INCOME_EARNINGS_TAX', (state, action) => {
        const { amount, residency } = action;
        const isAuResident = residency === 'AU';
        // Design 76 Gap C — attribute to the account that earned the interest.
        const account = resolveAttributionAsset(state, action, 'auFixedIncomeAccount');
        const perPerson = state.people != null && account != null;
        // AU-source interest is net investment income for a US person
        // (IRC §1411(c)(1)(A)(i)) → NIIT base, as with AU_SAVINGS_EARNINGS_TAX.
        const usd = toUSD(amount, 'AUD', state);
        let next = {
          ...state,
          usOrdinaryIncomeYTD:      state.usOrdinaryIncomeYTD + usd,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + usd,
          foreignPassiveIncomeYTD:  (state.foreignPassiveIncomeYTD ?? 0) + usd,
        };
        if (isAuResident) {
          next = {
            ...next,
            ...(perPerson
              ? { auPersonOrdinaryIncomeYTD: accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, account, amount, state.people) }
              : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount }),
          };
        } else {
          next = {
            ...next,
            ...(perPerson
              ? { auPersonNrWithholdingInterestYTD: accumulateByOwnership(state.auPersonNrWithholdingInterestYTD ?? {}, account, amount, state.people) }
              : { auNrWithholdingInterestYTD: (state.auNrWithholdingInterestYTD ?? 0) + amount }),
          };
        }
        return next;
      }],
    ];
  }

  _superReducerFns() {
    return [
      // EVT-20: super contribution — AU super tax at 15%, no US tax
      ['SUPER_CONTRIBUTION_TAX', (state, action) => {
        const superTax = action.amount * SUPER_TAX_RATE;
        // Design 76 Gap C — contributions tax belongs to the MEMBER whose account
        // received the contribution, never to the household. Matches the stateKey
        // resolution SUPER_EARNINGS_TAX already does below.
        const account = resolveAttributionAsset(state, action, 'superAccount');
        const perPerson = state.people != null && account != null;
        return {
          ...state,
          ...(perPerson
            ? { auPersonSuperTaxYTD: accumulateByOwnership(state.auPersonSuperTaxYTD ?? {}, account, superTax, state.people) }
            : { auSuperTaxYTD: state.auSuperTaxYTD + superTax }),
        };
      }],

      // EVT-22: super withdrawal of earnings — US ordinary income, no AU tax
      // (tax-free after 60), and — design 83 G6 — §904 GENERAL basket income.
      //
      // Foreign source. Pub 514's sourcing table puts "investment earnings on pension
      // contributions" at the *location of the pension trust*, and the trust is
      // Australian, so this is foreign-source income that was never US-source and
      // needs no re-sourcing. General category because a pension distribution is
      // absent from Pub 514's passive list (dividends, interest, rents, royalties,
      // annuities, net gain on investment property) and general is the residual;
      // treaty Art. 18(5) confirms super is not an "annuity" for treaty purposes,
      // since annuities require consideration *other than* services rendered.
      //
      // Before this, the classifier touched usOrdinaryIncomeYTD and nothing else,
      // which is worse than a missing numerator: the withdrawal RAISED the §904
      // denominator, diluting every other basket, while adding nothing to any
      // numerator. US tax went up and the capacity to relieve it went down, from the
      // same dollar. Australian super is tax-free after 60, so there is no AU tax on
      // the super itself to credit — but the distribution still generates general-
      // basket limitation room that AU tax from other sources can fill, which is why
      // this was inert until G3 moved that tax into the general pool.
      ['SUPER_WITHDRAWAL_EARNINGS_TAX', (state, action) => {
        const usd = toUSD(action.amount, 'AUD', state);
        return {
          ...state,
          usOrdinaryIncomeYTD:     state.usOrdinaryIncomeYTD + usd,
          foreignGeneralIncomeYTD: (state.foreignGeneralIncomeYTD ?? 0) + usd,
        };
      }],

      // EVT-23: super earnings — AU super tax at 15% in accumulation phase;
      //   0% in pension/retirement phase (member ≥ 60), signalled by action.taxRate.
      ['SUPER_EARNINGS_TAX', (state, action) => {
        const superTax = action.amount * (action.taxRate ?? SUPER_TAX_RATE);
        const accountKey = action.stateKey ?? 'superAccount';
        const account = state[accountKey];
        const perPerson = state.people != null && account != null;
        return {
          ...state,
          ...(perPerson
            ? { auPersonSuperTaxYTD: accumulateByOwnership(state.auPersonSuperTaxYTD ?? {}, account, superTax, state.people) }
            : { auSuperTaxYTD: state.auSuperTaxYTD + superTax }),
        };
      }],
    ];
  }

  _auBrokerageReducerFns() {
    return [
      // EVT-26: franked dividend (resident) — US ordinary income, AU franking credit, FTC.
      // Design 52: AU-source dividend → §904 Passive numerator.
      ['AU_DIVIDEND_FRANKED_RESIDENT_TAX', (state, action) => {
        // Design 76 Gap C — attribute to the AU brokerage account that paid it.
        const account = resolveAttributionAsset(state, action, 'auStockAccount');
        const perPerson = state.people != null && account != null;
        // Dividends are net investment income for a US person (IRC §1411(c)(1)(A)(i))
        // → NIIT base, mirroring STOCK_DIVIDEND_TAX. The NII slice is the cash
        // dividend the US recognises (the AU franking gross-up is not US income), so
        // it matches `usd`. The FTC cannot offset NIIT.
        const usd = toUSD(action.amount, 'AUD', state);

        // Design 90 §8 / design 76 §8.2 — gaps 1 and 2, fixed TOGETHER because either
        // alone points the wrong way. s207-20(1) includes the franking credit in
        // assessable income *in addition to* the cash dividend, and s207-20(2) gives an
        // offset equal to that credit; s202-60(2) sizes the credit at `cash × r/(1−r)`,
        // not at 100% of the cash.
        //
        // Before this the model booked NO AU assessable income and a credit equal to the
        // whole dividend — a franked dividend was a pure tax SHIELD that sheltered other
        // income, roughly 2.33× overstated. Shrinking the credit without adding the
        // income would have made franked dividends look worse than reality: a wrong
        // answer reached by a correct edit, which is why design 76 §8.7 sequences them
        // as one change.
        const credit = frankingCreditOn(action.amount, {
          corporateTaxRate: action.corporateTaxRate,
          frankedPercent:   action.frankedPercent,
        });
        // Assessable = cash + gross-up. The OFFSET is booked separately below and is
        // what makes this roughly neutral at a 30% marginal rate rather than taxed twice.
        const assessable = +(action.amount + credit).toFixed(2);
        // The US side is unchanged and must be: the gross-up is an Australian construct
        // with no US analogue, so `usd` stays the cash dividend. Grossing up the US
        // figure would invent income the IRS never sees.
        return {
          ...state,
          usOrdinaryIncomeYTD:      state.usOrdinaryIncomeYTD + usd,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + usd,
          foreignPassiveIncomeYTD:  (state.foreignPassiveIncomeYTD ?? 0) + usd,
          ...(perPerson
            ? {
                auPersonOrdinaryIncomeYTD: accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, account, assessable, state.people),
                auPersonFrankingCreditYTD: accumulateByOwnership(state.auPersonFrankingCreditYTD ?? {}, account, credit, state.people),
              }
            : {
                // `?? 0` because this branch is reachable from synthetic states that
                // carry only the accumulators they care about; `undefined + x` is NaN,
                // and a NaN in assessable income poisons the whole return silently.
                auOrdinaryIncomeYTD:  (state.auOrdinaryIncomeYTD ?? 0) + assessable,
                auFrankingCreditYTD:  (state.auFrankingCreditYTD ?? 0) + credit,
              }),
        };
      }],

      // EVT-27: franked dividend (NON-resident) — US ordinary income, no AU tax, no FTC.
      //
      // Australia taxes nothing here and that is correct: ITAA 1936 s128B(3)(ga)(i)
      // excludes the franked part of a dividend from withholding tax for a foreign
      // resident, s128D keeps it out of assessable income, and ss207-20 / 207-70 deny
      // the franking offset to non-residents. So no auOrdinaryIncomeYTD, no
      // withholding bucket, and no franking credit — unlike all three sibling
      // dividend events.
      //
      // But the Australian exemption says nothing about the United States. A US
      // citizen is taxed on worldwide income wherever resident (IRC §61, §1), so the
      // dividend is US ordinary income exactly as it is on the other three branches.
      // This leg was specified in docs/requirements.md (EVT-27: US "Ordinary Income")
      // but never implemented — the reducer chained no tax action at all, so a
      // US-resident citizen holding ASX shares paid tax on franked dividends in
      // NEITHER country. The old "Ordinary Income??" note in the requirements CSV was
      // uncertainty about the US side; the AU side was never in doubt.
      //
      // NIIT: dividends are net investment income (IRC §1411(c)(1)(A)(i)), and since
      // no Australian tax is paid there is no FTC to reduce it — this is the one
      // dividend branch where the 3.8% surtax lands wholly unrelieved.
      //
      // §904: the dividend is AU-source (sourced to the paying company's residence),
      // so it belongs in the passive basket numerator. No foreign tax accompanies it,
      // but the numerator sizes the LIMITATION, not the credit — genuinely
      // foreign-source income raising the passive limit is §904 working as intended.
      // Contrast design 73's warning, which was about US-source income being fed
      // into a basket numerator; that is a different and improper thing.
      ['AU_DIVIDEND_FRANKED_NONRESIDENT_TAX', (state, action) => {
        const usd = toUSD(action.amount, 'AUD', state);
        return {
          ...state,
          usOrdinaryIncomeYTD:      state.usOrdinaryIncomeYTD + usd,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + usd,
          foreignPassiveIncomeYTD:  (state.foreignPassiveIncomeYTD ?? 0) + usd,
        };
      }],

      // EVT-28: unfranked dividend (resident) — US ordinary income, AU ordinary income, FTC.
      // Design 52: AU-source dividend → §904 Passive numerator.
      ['AU_DIVIDEND_UNFRANKED_RESIDENT_TAX', (state, action) => {
        // Design 76 Gap C — attribute to the AU brokerage account that paid it.
        const account = resolveAttributionAsset(state, action, 'auStockAccount');
        const perPerson = state.people != null && account != null;
        // Dividends are net investment income for a US person (IRC §1411(c)(1)(A)(i))
        // → NIIT base, mirroring STOCK_DIVIDEND_TAX.
        const usd = toUSD(action.amount, 'AUD', state);
        return {
          ...state,
          usOrdinaryIncomeYTD:      state.usOrdinaryIncomeYTD + usd,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + usd,
          foreignPassiveIncomeYTD:  (state.foreignPassiveIncomeYTD ?? 0) + usd,
          ...(perPerson
            ? { auPersonOrdinaryIncomeYTD: accumulateByOwnership(state.auPersonOrdinaryIncomeYTD ?? {}, account, action.amount, state.people) }
            : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + action.amount }),
        };
      }],

      // EVT-29: unfranked dividend (non-resident) — US ordinary income, AU NR withholding, FTC.
      // Design 52: AU-source dividend → §904 Passive numerator.
      // Design 73 Gap 2: 15% (Art 10(2)) — the one feeder the old pooled constant
      // actually fitted, and almost certainly where the 0.15 came from. The
      // Protocol's 5%/0% tiers both require a *corporate* beneficial owner, so an
      // individual always falls to 15% and there is no tiering to model.
      ['AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX', (state, action) => {
        // Design 76 Gap C — attribute to the AU brokerage account that paid it.
        const account = resolveAttributionAsset(state, action, 'auStockAccount');
        const perPerson = state.people != null && account != null;
        // Dividends are net investment income for a US person (IRC §1411(c)(1)(A)(i))
        // → NIIT base, mirroring STOCK_DIVIDEND_TAX.
        const usd = toUSD(action.amount, 'AUD', state);
        return {
          ...state,
          usOrdinaryIncomeYTD:      state.usOrdinaryIncomeYTD + usd,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + usd,
          foreignPassiveIncomeYTD:  (state.foreignPassiveIncomeYTD ?? 0) + usd,
          ...(perPerson
            ? { auPersonNrWithholdingUnfrankedDividendYTD: accumulateByOwnership(state.auPersonNrWithholdingUnfrankedDividendYTD ?? {}, account, action.amount, state.people) }
            : { auNrWithholdingUnfrankedDividendYTD: (state.auNrWithholdingUnfrankedDividendYTD ?? 0) + action.amount }),
        };
      }],

      // EVT-31/32: AU stock withdrawal — always US capital gain;
      //   AU capital gain + FTC for residents only. AU measures the gain from its
      //   stepped-up (s855-45) cost base, so auGain ≤ gain (design 36 §12.2); the
      //   pre-move appreciation is US-only and earns no FTC (only auGain feeds the
      //   §904 Passive numerator).
      // Design 52: AU-source capital gain → §904 Passive numerator (auGain, USD).
      ['AU_STOCK_WITHDRAWAL_TAX', (state, action) => {
        const { gain, residency } = action;
        const auGain = action.auGain ?? gain;
        // CGT 50%-discount-eligible slice (design 62 §4): the portion of auGain from
        // lots held ≥12 months from the AU deemed-acquisition date. Defaults to the
        // full auGain when absent (old actions ⇒ current full-discount behavior).
        const auDiscountableGain = action.auDiscountableGain ?? auGain;
        // Design 90 §5 — signed AU split, in AUD (this account's currency).
        const auChar = characterizeAuCapitalGain(action, auGain);
        const isAuResident = residency === 'AU';
        // Design 76 Gap C — attribute to the AU brokerage account that paid it.
        const account = resolveAttributionAsset(state, action, 'auStockAccount');
        const perPerson = state.people != null && account != null;
        // Design 90 §4 — the SIGNED §1222 split. `gain` is in AUD here (the account's
        // currency), so the split is converted the same way the floored figure was.
        const char = characterizeCapitalGain(action, gain);
        let next = {
          ...state,
          usCapitalGainsYTD: state.usCapitalGainsYTD + toUSD(char.long, 'AUD', state),
          // Written only when non-zero, following the usUnrecaptured1250GainYTD precedent:
          // creating this key at 0 puts a state diff on every gainless disposal, and a
          // buy-and-hold plan makes short-term character rare (12 rows in 5,646 measured).
          ...(char.short !== 0
            ? { usShortTermCapitalGainsYTD: (state.usShortTermCapitalGainsYTD ?? 0) + toUSD(char.short, 'AUD', state) }
            : {}),
        };
        if (isAuResident) {
          next = {
            ...next,
            // Design 90 §5 — SIGNED, so an AU capital LOSS survives to be netted under
            // s102-5 Step 1. `auChar.long` is the Div 115 discount-eligible slice and
            // `.short` the rest; their sum is the gross gain these lines used to book.
            ...(perPerson
              ? {
                  auPersonCapitalGainsYTD:      accumulateByOwnership(state.auPersonCapitalGainsYTD ?? {}, account, auChar.short + auChar.long, state.people),
                  auPersonDiscountableGainsYTD: accumulateByOwnership(state.auPersonDiscountableGainsYTD ?? {}, account, auChar.long, state.people),
                }
              : {
                  auCapitalGainsYTD:      state.auCapitalGainsYTD + auChar.short + auChar.long,
                  auDiscountableGainsYTD: (state.auDiscountableGainsYTD ?? 0) + auChar.long,
                }),
            // Design 90 §4.5 — SIGNED, and the capital slice recorded beside it. `auGain`
            // is floored, so an AU capital LOSS added nothing to the basket while the
            // signed split above subtracted from `usCapitalGainsYTD`: the basket then
            // carried gain the §904 denominator did not. The basket keeps taking the
            // AU-measured figure, as it always has — that asymmetry with the US-measured
            // `char` is design 62's s855-45 step-up and is not this design's to change.
            foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + toUSD(auChar.short + auChar.long, 'AUD', state),
            ...basketCapGainPatch(state, 'foreignPassiveCapGainsYTD', toUSD(auChar.short + auChar.long, 'AUD', state)),
          };
        }
        return next;
      }],
    ];
  }

  _realPropertyReducerFns() {
    return [
      // EVT-33: AU house sale — always US capital gain;
      //   resident: AU capital gain + FTC; non-resident: AU capital gain assessed
      //   at foreign-resident marginal rates, no discount.
      // Design 52: AU-source capital gain → §904 Passive numerator.
      //
      // Design 73 Gap 2 step 3: a foreign resident's gain on Taxable Australian
      // Property is *assessable* income (ITAA 1997 s855-10 restricts the foreign
      // resident's CGT net to TAP, and real property is squarely inside it),
      // reported on an Australian return at foreign-resident marginal rates — 30%
      // from the first dollar, no tax-free threshold, no Medicare levy [R3, R5].
      // It is not withholding income. Routing it through the flat 15% final-tax
      // pool roughly halved it.
      //
      // Where the 15% came from: Foreign Resident Capital Gains Withholding is
      // genuinely 15% (since 1 Jan 2025, with the $750k property threshold
      // removed), but it is a *collection* mechanism — the vendor claims it as a
      // credit on assessment and is refunded any excess [R10]. A payment on
      // account, not a final liability. This models the liability; the prepayment
      // is a cash-flow timing question, not a tax one.
      //
      // No discountable slice is fed. The CGT discount is not flatly denied to
      // foreign residents — since 8 May 2012 the *percentage* is apportioned by
      // days of Australian residence over the ownership period (s115-105/110/115),
      // so a straddling holding keeps a pro-rated discount. Feeding zero is exact
      // for an asset acquired after 8 May 2012 and held wholly while a foreign
      // resident, and conservative (over-taxes) for the straddling case.
      // TODO(design/62): that day-count belongs with the residency-aware cost-base
      // handling design 62 already owns; do not reach for the resident branch's
      // unconditional discount wiring as a stand-in.
      ['AU_HOUSE_SALE_TAX', (state, action) => {
        const { gain, residency, ownershipType, ownerId, owners } = action;
        const isAuResident = residency === 'AU';
        const perPerson = state.people != null;

        // ── Design 83 G7: one disposal, three differently-taxed slices ──────────
        //
        // The AU main-residence exemption (s118-185, already gated by s118-110(3) in
        // the sale reducer) is an AUSTRALIAN concession and must not touch the US
        // figure — the United States relieves an Australian dwelling only through its
        // own §121, on its own test, over its own period. Applying the AU fraction to
        // both would double-relieve, which is why the fraction arrives here rather
        // than having been netted into `gain` upstream.
        const auAssessableGain  = AuTaxModule2026.auAssessableHouseGain(action);

        // The depreciation slice. Australia needs no special handling — s110-45(2)
        // already enlarged the gain by taking Div 43 out of the cost base, and that
        // enlargement rides the exemption and the discount like any other gain. The
        // United States must split it out: unrecaptured §1250 gain is capped at 25%
        // rather than taxed at the LTCG rates, and §121 can never exclude it.
        const depGain      = Math.max(0, Math.min(action.depreciationGain ?? 0, gain));
        const excludable   = Math.max(0, gain - depGain);
        // Every figure in this payload is AUD (the AU sale reducer stamps the property's
        // own currency), so the §121 ceiling has to cross the FX line before it can be
        // compared against them. Passing the bare statutory constant tested a
        // US$500,000 cap against an A$ gain and silently denied exclusion between
        // A$500,000 and the true A$775,000-equivalent.
        const s121Cap      = toAUD(
          state.usFilingSingle === true ? US_PRIMARY_HOME_EXCLUSION_SINGLE : US_PRIMARY_HOME_EXCLUSION_MFJ,
          'USD', state);
        const s121         = us121Exclusion(
          { mainResidenceFrom:  action.mainResidenceFrom,
            mainResidenceUntil: action.mainResidenceUntil,
            isPrimaryResidence: action.isPrimaryResidence },
          { gain, depreciationGain: depGain,
            acquisitionMs: action.acquisitionMs, saleMs: action.saleMs,
            filingSingle:  state.usFilingSingle === true,
            cap:           s121Cap });
        const usTaxableGain = +Math.max(0, excludable - s121.excluded).toFixed(2);

        const usdGain     = toUSD(usTaxableGain, 'AUD', state);
        const usdDepGain  = toUSD(depGain,       'AUD', state);
        // Design 90 §4 — signed. `usTaxableGain` is already net of §121, so the helper
        // preserves it on the gain side and falls through to the signed loss only when
        // there is no gain for §121 to exclude.
        //
        // Characterized in AUD and converted after, NOT the reverse: the action's signed
        // fields are stamped in the property's own currency (AUD) by the AU sale reducer,
        // while `usdGain` has already crossed the FX line. Handing the helper a USD
        // taxable gain and AUD signed fields would compare two different currencies and
        // silently mis-split any disposal whose FX rate is not 1.
        const houseChar = characterizeCapitalGain(action, usTaxableGain);
        let next = {
          ...state,
          usCapitalGainsYTD: state.usCapitalGainsYTD + toUSD(houseChar.long, 'AUD', state),
          // Written only when non-zero, following the usUnrecaptured1250GainYTD precedent:
          // creating this key at 0 puts a state diff on every gainless disposal, and a
          // buy-and-hold plan makes short-term character rare (12 rows in 5,646 measured).
          ...(houseChar.short !== 0
            ? { usShortTermCapitalGainsYTD: (state.usShortTermCapitalGainsYTD ?? 0) + toUSD(houseChar.short, 'AUD', state) }
            : {}),
          // §1250 gain is US-taxable income in its own rate bucket (G7 step 3b).
          // Written only when there IS one: a never-rented dwelling has no §1250 slice,
          // and materialising the key at 0 would put a state diff on every gainless
          // sale in every plan that has nothing to do with depreciation.
          ...(usdDepGain !== 0
            ? { usUnrecaptured1250GainYTD: (state.usUnrecaptured1250GainYTD ?? 0) + usdDepGain }
            : {}),
          // The §904 passive numerator takes exactly what reached the US totals —
          // taxable gain plus the §1250 slice, and NOT the §121-excluded part. A
          // basket numerator carrying income the denominator does not is the G5b
          // partition failure, and excluded gain is precisely such income.
          //
          // Design 90 §4.5 — and "exactly what reached the US totals" now includes the
          // SIGN. `usdGain` derives from `usTaxableGain`, which is floored at zero, so a
          // dwelling sold at a loss added only the §1250 slice here while the signed
          // `houseChar` reduced `usCapitalGainsYTD` above.
          foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0)
                                   + toUSD(houseChar.short + houseChar.long, 'AUD', state) + usdDepGain,
          ...basketCapGainPatch(state, 'foreignPassiveCapGainsYTD',
            toUSD(houseChar.short + houseChar.long, 'AUD', state) + usdDepGain),
        };
        if (perPerson) {
          const asset = { ownershipType, ownerId, owners };
          if (isAuResident) {
            // Design 83 G7 step 3 — s115-115. Australian real property is TAP, so
            // s855-45 gives it NO deemed re-acquisition at the move: it keeps its
            // original acquisition date, and its discount testing period therefore
            // straddles the years spent abroad. This is the case the flat 50% was
            // wrong for, and the only asset class in the model that reaches it.
            //
            // The fraction is per PERSON — each owner's residency history is their own
            // — so it is computed inside the ownership loop rather than once for the
            // household. A couple who moved at different times get different discounts
            // on the same house, which is correct and which a single household rate
            // could not express.
            let baseMap  = state.auPersonDiscountApportionedBaseYTD ?? {};
            let reliefMap = state.auPersonDiscountAllowanceYTD ?? {};
            for (const { personKey, fraction } of ownershipFractions(asset, state.people)) {
              const share = auAssessableGain * fraction;
              if (!(share > 0)) continue;
              const d = cgtDiscountFraction({
                acquisitionMs:    action.acquisitionMs,
                saleMs:           action.saleMs,
                residencySinceMs: state.people?.[personKey]?.residencySinceMs ?? null,
                residencyAtSale:  state.people?.[personKey]?.residency ?? residency,
              });
              baseMap   = { ...baseMap,   [personKey]: (baseMap[personKey]   ?? 0) + share };
              reliefMap = { ...reliefMap, [personKey]: (reliefMap[personKey] ?? 0) + share * d.fraction };
            }
            next = {
              ...next,
              auPersonCapitalGainsYTD: accumulateByOwnership(state.auPersonCapitalGainsYTD ?? {}, asset, auAssessableGain, state.people),
              // TAP real property: no per-lot 12-month tracking here, so the whole
              // gain stays discount-eligible (design 62 §4 — property holding-period
              // gating is out of Gap 1's scope; the residency gate targets brokerage).
              auPersonDiscountableGainsYTD: accumulateByOwnership(state.auPersonDiscountableGainsYTD ?? {}, asset, auAssessableGain, state.people),
              auPersonDiscountApportionedBaseYTD: baseMap,
              auPersonDiscountAllowanceYTD:       reliefMap,
            };
          } else {
            next = {
              ...next,
              // Assessable at NR marginal rates, with no discountable slice.
              auPersonCapitalGainsYTD: accumulateByOwnership(state.auPersonCapitalGainsYTD ?? {}, asset, auAssessableGain, state.people),
            };
          }
        } else {
          next = {
            ...next,
            ...(isAuResident
              ? { auCapitalGainsYTD:      state.auCapitalGainsYTD + auAssessableGain,
                  auDiscountableGainsYTD: (state.auDiscountableGainsYTD ?? 0) + auAssessableGain,
                  // Household-scalar branch (no per-person maps): same apportionment,
                  // measured off the first person's residency, which is the same
                  // approximation every other household-scalar path here makes.
                  auDiscountApportionedBaseYTD: (state.auDiscountApportionedBaseYTD ?? 0) + auAssessableGain,
                  auDiscountAllowanceYTD: (state.auDiscountAllowanceYTD ?? 0) + auAssessableGain * cgtDiscountFraction({
                    acquisitionMs: action.acquisitionMs, saleMs: action.saleMs,
                    residencySinceMs: state.people?.[Object.keys(state.people ?? {})[0]]?.residencySinceMs ?? null,
                    residencyAtSale: residency,
                  }).fraction }
              : { auCapitalGainsYTD:      state.auCapitalGainsYTD + auAssessableGain }),
          };
        }
        return next;
      }],
    ];
  }

  _auIncomeReducerFns() {
    return [
      // EVT-49: AU self-employment income. Books identically to AUD wages — see
      // `bookAuPersonalServicesIncome` for the axes; s6-5 draws no line between
      // employment and independent services income, and neither does the model.
      //
      // Design 73 §6b — this classifier used to branch on residency alone, so a
      // foreign resident's Australian-performed fees were assessed nowhere: not the
      // "no foreign tax to credit" case its comment claimed, but the same gap §1
      // had already fixed for wages, one classifier over. s6-5(3) assesses a foreign
      // resident on ordinary income from all Australian sources, and Art 14 gives
      // Australia the taxing right over independent services performed there where
      // the individual is present more than 183 days or has a fixed base — a
      // year-long `workCountry` satisfies the first, and Art 14 is untouched by the
      // 2001 Protocol. Its twin defect, an AU resident's US-performed fees feeding
      // the §904 general numerator and the FEIE cap, is closed by the same helper.
      ['AU_SE_INCOME_TAX', (state, action) => bookAuPersonalServicesIncome(state, action)],
    ];
  }
}
