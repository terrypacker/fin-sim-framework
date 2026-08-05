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
import { accumulateByOwnership, resolveAttributionAsset } from '../../ownership-utils.js';
import { toUSD } from '../tax-fx.js';

const SUPER_TAX_RATE = 0.15;

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

  getReducerFns() {
    return new Map([
      ...this._auSavingsReducerFns(),
      ...this._auFixedIncomeReducerFns(),
      ...this._superReducerFns(),
      ...this._auBrokerageReducerFns(),
      ...this._realPropertyReducerFns(),
      ...this._rentalReducerFns(),
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
      // Design 50: wages paid in AUD — always US ordinary income (worldwide, on a
      // citizen's return). Attributed to the *earner* via personKey (like
      // AU_SE_INCOME_TAX), not to the AU account's owner — the wage belongs to the
      // person who earned it.
      //
      // Design 73 Gap 1 — branch on SOURCE first, then residency. Source of
      // employment income is the place the services are performed, not the payment
      // currency, the payer's residence, or the account the money lands in. FCT v
      // French (1957) 98 CLR 398 is this case in mirror image: an Australian
      // engineer working a few weeks a year in New Zealand, *with his salary paid
      // into his Australian bank account throughout*, was held to have NZ-source
      // wages for those weeks. Payment location lost to place of performance.
      //
      // Treaty side, Art 15(1): remuneration "may be taxed only in the State of
      // residence unless the employment is exercised ... in the other State".
      // Residence-only taxation is the default; the source State's right is the
      // exception, unlocked by the employment being EXERCISED there. Art 27(1)'s
      // deeming rule ("income Australia may tax under the Convention is deemed
      // Australian-source") therefore never fires for work performed in the US —
      // which is why the §904 general basket must not be fed on that branch either.
      //
      // Design 52: AU-source earned income → §904 General numerator; the resident
      // earner's slice also feeds the per-person FEIE cap accumulator.
      ['AU_WAGES_INCOME_TAX', (state, action) => {
        const { amount, residency, personKey } = action;
        // Absent on pre-73 saved actions ⇒ the earner works where they live.
        const workCountry  = action.workCountry ?? residency ?? null;
        const isAuSourced  = workCountry === 'AU';
        const isAuResident = residency === 'AU';
        const usd = toUSD(amount, 'AUD', state);

        // Always on the US worldwide return, whatever the source.
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + usd };

        if (!isAuSourced) {
          // Work performed outside Australia. Australia has no claim under Art 15
          // however the wage is denominated or wherever it is banked, so the AU
          // return shows nothing — no assessable income, no withholding. And with
          // no Australian taxing right there is no Australian source for treaty
          // purposes, so this must NOT enter foreignGeneralIncomeYTD: US-source
          // income in the §904 general basket numerator would inflate the
          // limitation and let unrelated foreign taxes be credited against US tax
          // on US income. The AUD still lands in the AU account — this is a tax
          // classification, not a cash-flow change.
          return next;
        }

        // AU-source from here: the employment is exercised in Australia.
        next = { ...next, foreignGeneralIncomeYTD: (state.foreignGeneralIncomeYTD ?? 0) + usd };

        // AU-source wages are ASSESSABLE income whoever earns them. For a resident
        // that was already true; for a foreign resident it is the fix — such a wage
        // is assessed at foreign-resident marginal rates on a lodged return (30%
        // from the first dollar, no tax-free threshold, no Medicare levy [R3]), NOT
        // withheld finally at source. Wages were never a withholding category; only
        // interest, unfranked dividends and royalties are [R1, R5]. Both branches
        // therefore feed the same accumulator — the one the non-resident bracket
        // path already reads and that no feeder had ever written while non-resident,
        // which is why line 5 of the AU return read 0.00 in every non-resident year.
        //
        // TODO(design 73 §4): Art 27(2) is an anti-double-exemption rule. Where an
        // AU-performed wage is exempted at source by the Art 15(2) 183-day test AND
        // excluded from US tax by the §911 FEIE, Australia may tax it after all —
        // "the purpose of the exemption at source is to avoid double taxation, not
        // to provide double exemption". The Art 15(2) test is not modelled, so this
        // branch always assesses and cannot produce the taxed-by-neither outcome;
        // guard it if that test is ever added.
        const usePerPerson = personKey != null && state.auPersonOrdinaryIncomeYTD != null;
        if (!usePerPerson) {
          return { ...next, auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount };
        }
        return {
          ...next,
          auPersonOrdinaryIncomeYTD: { ...state.auPersonOrdinaryIncomeYTD, [personKey]: (state.auPersonOrdinaryIncomeYTD[personKey] ?? 0) + amount },
          // The FEIE cap accumulator is *foreign earned income* of a US person whose
          // tax home is abroad, so only the AU-resident earner's slice belongs in it.
          // `_computeFeie` independently skips anyone whose residency is not 'AU';
          // not writing it here means that gate is a second line of defence rather
          // than the only thing preventing a US resident from excluding AU wages.
          ...(isAuResident
            ? { auPersonEarnedIncomeYTD: { ...(state.auPersonEarnedIncomeYTD ?? {}), [personKey]: ((state.auPersonEarnedIncomeYTD?.[personKey]) ?? 0) + amount } }
            : {}),
        };
      }],
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
        return {
          ...state,
          usOrdinaryIncomeYTD:      state.usOrdinaryIncomeYTD + usd,
          usNetInvestmentIncomeYTD: (state.usNetInvestmentIncomeYTD ?? 0) + usd,
          foreignPassiveIncomeYTD:  (state.foreignPassiveIncomeYTD ?? 0) + usd,
          ...(perPerson
            ? { auPersonFrankingCreditYTD: accumulateByOwnership(state.auPersonFrankingCreditYTD ?? {}, account, action.amount, state.people) }
            : { auFrankingCreditYTD: state.auFrankingCreditYTD + action.amount }),
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
        const isAuResident = residency === 'AU';
        // Design 76 Gap C — attribute to the AU brokerage account that paid it.
        const account = resolveAttributionAsset(state, action, 'auStockAccount');
        const perPerson = state.people != null && account != null;
        let next = { ...state, usCapitalGainsYTD: state.usCapitalGainsYTD + toUSD(gain, 'AUD', state) };
        if (isAuResident) {
          next = {
            ...next,
            ...(perPerson
              ? {
                  auPersonCapitalGainsYTD:      accumulateByOwnership(state.auPersonCapitalGainsYTD ?? {}, account, auGain, state.people),
                  auPersonDiscountableGainsYTD: accumulateByOwnership(state.auPersonDiscountableGainsYTD ?? {}, account, auDiscountableGain, state.people),
                }
              : {
                  auCapitalGainsYTD:      state.auCapitalGainsYTD + auGain,
                  auDiscountableGainsYTD: (state.auDiscountableGainsYTD ?? 0) + auDiscountableGain,
                }),
            foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + toUSD(auGain, 'AUD', state),
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
        const usdGain = toUSD(gain, 'AUD', state);
        let next = {
          ...state,
          usCapitalGainsYTD:       state.usCapitalGainsYTD + usdGain,
          foreignPassiveIncomeYTD: (state.foreignPassiveIncomeYTD ?? 0) + usdGain,
        };
        if (perPerson) {
          const asset = { ownershipType, ownerId, owners };
          if (isAuResident) {
            next = {
              ...next,
              auPersonCapitalGainsYTD: accumulateByOwnership(state.auPersonCapitalGainsYTD ?? {}, asset, gain, state.people),
              // TAP real property: no per-lot 12-month tracking here, so the whole
              // gain stays discount-eligible (design 62 §4 — property holding-period
              // gating is out of Gap 1's scope; the residency gate targets brokerage).
              auPersonDiscountableGainsYTD: accumulateByOwnership(state.auPersonDiscountableGainsYTD ?? {}, asset, gain, state.people),
            };
          } else {
            next = {
              ...next,
              // Assessable at NR marginal rates, with no discountable slice.
              auPersonCapitalGainsYTD: accumulateByOwnership(state.auPersonCapitalGainsYTD ?? {}, asset, gain, state.people),
            };
          }
        } else {
          next = {
            ...next,
            ...(isAuResident
              ? { auCapitalGainsYTD: state.auCapitalGainsYTD + gain, auDiscountableGainsYTD: (state.auDiscountableGainsYTD ?? 0) + gain }
              : { auCapitalGainsYTD: state.auCapitalGainsYTD + gain }),
          };
        }
        return next;
      }],
    ];
  }

  _auIncomeReducerFns() {
    return [
      // EVT-49: AU self-employment income — always US ordinary income; AU ordinary income if resident.
      // Design 52: AU-source earned income → §904 General numerator + per-person FEIE cap.
      ['AU_SE_INCOME_TAX', (state, action) => {
        const { amount, residency, personKey } = action;
        const isAuResident = residency === 'AU';
        const usd = toUSD(amount, 'AUD', state);
        let next = { ...state, usOrdinaryIncomeYTD: state.usOrdinaryIncomeYTD + usd };
        if (isAuResident) {
          // §904 General numerator only when AU taxes it (resident) — a
          // non-resident's AU-source SE income is not AU-assessed in this model,
          // so there is no foreign tax to credit (matches the pre-52 ftcYTD gate).
          const usePerPerson = personKey != null && state.auPersonOrdinaryIncomeYTD != null;
          next = {
            ...next,
            foreignGeneralIncomeYTD: (state.foreignGeneralIncomeYTD ?? 0) + usd,
            ...(usePerPerson
              ? {
                  auPersonOrdinaryIncomeYTD: { ...state.auPersonOrdinaryIncomeYTD, [personKey]: (state.auPersonOrdinaryIncomeYTD[personKey] ?? 0) + amount },
                  auPersonEarnedIncomeYTD:   { ...(state.auPersonEarnedIncomeYTD ?? {}), [personKey]: ((state.auPersonEarnedIncomeYTD?.[personKey]) ?? 0) + amount },
                }
              : { auOrdinaryIncomeYTD: state.auOrdinaryIncomeYTD + amount }),
          };
        }
        return next;
      }],
    ];
  }
}
