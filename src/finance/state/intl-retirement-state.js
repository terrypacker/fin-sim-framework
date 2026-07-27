/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {SimulationState} from '../../simulation-framework/simulation-state.js';

export class InternationalRetirementFinancialState extends SimulationState {
  constructor({
      //People
    primary, spouse,
      //Accounts
    usSavingsAccount, fixedIncomeAccount, usStockAccount,
    iraAccount, k401Account, rothAccount,
    auSavingsAccount, auStockAccount, superAccount,
      // Spouse retirement accounts
    spouseRothAccount, spouseIraAccount, spouseK401Account, spouseSuperAccount,
      // Real property
    usHouseProperty, auHouseProperty,
      // Collectibles
    collectibleAccount,
    inflationRates,
    monthlyExpenses,
    discretionarySharePct,
    ...rest
  } = {}) {
    super(rest);
    this.people = {primary, spouse};

    //US Accounts
    this._assignAccount('usSavingsAccount', usSavingsAccount);
    this._assignAccount('fixedIncomeAccount', fixedIncomeAccount);
    this._assignAccount('usStockAccount', usStockAccount);
    this._assignAccount('iraAccount', iraAccount);
    this._assignAccount('k401Account', k401Account);
    this._assignAccount('rothAccount', rothAccount);

    //AU Accounts
    this._assignAccount('auSavingsAccount', auSavingsAccount);
    this._assignAccount('auStockAccount', auStockAccount);
    this._assignAccount('superAccount', superAccount);

    // Spouse retirement accounts
    this._assignAccount('spouseRothAccount', spouseRothAccount);
    this._assignAccount('spouseIraAccount', spouseIraAccount);
    this._assignAccount('spouseK401Account', spouseK401Account);
    this._assignAccount('spouseSuperAccount', spouseSuperAccount);

    // Real property and collectibles
    this._assignAsset('usHouseProperty', usHouseProperty ?? null);
    this._assignAsset('auHouseProperty', auHouseProperty ?? null);
    this._assignAsset('collectibleAccount', collectibleAccount ?? null);

    // FX state — base values set at scenario boot via toolset patches (US_AU_CROSS_BORDER).
    // Effective fields are regime-adjusted when the regime toolset is loaded; otherwise
    // FxRefreshReducer mirrors base → effective on each period advance.
    // Default values here ensure the state is valid even without the cross-border toolset.
    this.baseExchangeRates      = { USD_AUD: 1.55 };
    this.baseFxFees             = { USD_AUD: 15   };
    this.effectiveExchangeRates = { ...this.baseExchangeRates };
    this.effectiveFxFees        = { ...this.baseFxFees };

    // Time-varying FX stochastic layer (design 47). All O(1) scalar maps —
    // no path array. fxDeviation is a mean-0 log-space walk stepped by
    // FxTickHandler; effectiveExchangeRates = fxAnchorRates × exp(fxDeviation),
    // composed by FxProcessReducer. baseFxVol seeds the process volatility,
    // effectiveFxVol is regime-modulated. When fxProcessModel is NONE these
    // stay 0 and the rate is left at its anchor (bit-for-bit today).
    this.fxDeviation            = {};
    this.baseFxVol              = {};
    this.effectiveFxVol         = { ...this.baseFxVol };
    this.fxAnchorRates          = { ...this.baseExchangeRates };

    // Regime substrate (ECONOMIC_REGIMES toolset, design/21).
    // baseGrowthRates / base*Rates are seeded by the toolset's state() method
    // at compile time. effectiveGrowthRates / effective*Rates are written by
    // RegimeApplyReducer on every period boundary and regime mutation.
    // When ECONOMIC_REGIMES is not loaded, all effective*Rates fields are
    // absent from state and handlers fall back to their own default rates.
    this.activeRegimes          = [];
    this.baseGrowthRates        = {};
    this.baseInterestRates      = {};
    this.baseAppreciationRates  = {};
    this.effectiveGrowthRates       = {};
    this.effectiveInterestRates     = {};
    this.effectiveInflationRates    = {};
    this.effectiveAppreciationRates = {};
    this.priorMarkRates         = {};

    this.inflationRates       = inflationRates ?? { US: 0.03, AU: 0.03 };
    this.inflationAccumulator = { US: 1.0, AU: 1.0 };
    // Dedicated ATO CPI indexation series (design 57 Part 2, Item A). cpiRates
    // decouples the CGT cost-base index from wage/expense inflation; when a
    // country's rate is unset the InflationAdjustReducer falls back to the
    // effective inflation rate, so cpiAccumulator tracks inflationAccumulator
    // byte-for-byte until a distinct CPI is chosen.
    this.cpiRates             = {};
    this.cpiAccumulator       = { US: 1.0, AU: 1.0 };
    this.monthlyExpenses      = monthlyExpenses ?? 6_000;

    // Spending strategy substrate (design/26).
    // state.expenses is the source of truth; state.monthlyExpenses is kept in
    // sync as the sum so existing consumers continue to work unchanged.
    this.discretionarySharePct = discretionarySharePct ?? 0.30;
    this.expenses = {
      essential:     this.monthlyExpenses * (1 - this.discretionarySharePct),
      discretionary: this.monthlyExpenses * this.discretionarySharePct,
    };

    // General regime-effect tracking map shared by all regime-driven strategies.
    // Each strategy lazily initializes its own key; see design/26 §6 + §13.
    this.regimeActions = {};

    // Behavioral layer substrate (design/29 §6).
    // Set true by ContributionSuspensionToggleReducer while ECONOMIC_STRESS is active.
    this.contributionsSuspended = false;

    // YTD tax accumulators
    this.usOrdinaryIncomeYTD = 0;
    this.usNegativeIncomeYTD = 0;
    this.usCapitalGainsYTD = 0;
    // Net investment income slice of usOrdinaryIncomeYTD — the interest,
    // dividend, bond-coupon and net-rental dollars that are subject to the 3.8%
    // Net Investment Income Tax (IRC §1411). Tracked in parallel because
    // usOrdinaryIncomeYTD also holds non-investment income (wages, SS, retirement
    // distributions) which NIIT excludes. Capital/collectible gains are already
    // isolated and added to NII at computeTax time, not here.
    this.usNetInvestmentIncomeYTD = 0;
    // §469 passive activity accounting (design 86 G5), USD. The two YTD figures are
    // SIGNED net rental results — all activity, and the foreign-source subset that has
    // to leave the passive §904 basket with it. Both reset at the US settle.
    this.usPassiveActivityIncomeYTD        = 0;
    this.usForeignPassiveActivityIncomeYTD = 0;
    // Suspended passive losses carried forward under §469(b). NOT a YTD field:
    // deliberately outside the settle reset, because surviving the year boundary is
    // the point. Released against later passive income.
    this.usPassiveLossCarryforward         = 0;
    this.usPenaltyYTD = 0;
    this.auOrdinaryIncomeYTD = 0;  // shared/passive income (dividends, savings interest, etc.)
    this.auCapitalGainsYTD = 0;
    this.auDiscountableGainsYTD = 0;  // CGT 50%-discount-eligible slice (design 62 §4)
    this.auRealCapitalGainsYTD = 0;  // FY2027 CGT reform: post-indexation gain (design 57)
    this.auNonResidentWithholdingYTD = 0;
    this.auSuperTaxYTD = 0;
    this.auFrankingCreditYTD = 0;

    // Cross-border relief — design 52. Replaces the single ftcYTD line.
    // US side (USD): §904 foreign-source numerators (post-FEIE) per basket, the
    // current-year AU foreign tax available to credit, and the 10-year
    // carryforward pools ({ [vintageCY]: remainingUSD }).
    this.foreignGeneralIncomeYTD = 0;
    this.foreignPassiveIncomeYTD = 0;
    this.ftcCurrentGeneral = 0;
    this.ftcCurrentPassive = 0;
    // Design 72 §1 — treaty re-sourced basket (Form 1116 category F).
    this.ftcCurrentResourced = 0;
    this.ftcPoolGeneral = {};
    this.ftcPoolPassive = {};
    this.ftcPoolResourced = {};
    // US-source income booked while AU-resident (the FITO "without" removal set).
    this.usSourceOrdinaryUsdYTD = 0;   // USD, funds the §4.6 with/without US pass
    this.usSourceCapGainsUsdYTD = 0;
    // Design 83 G3 — US-source income re-sourced to foreign by Art. 27(1)(c),
    // split by the §904 category it lands in. Kept apart from foreign*IncomeYTD
    // so the FITO counterfactual can remove it from the baskets (design 83 G8).
    // Design 83 G10 — the realised AU effective rate on capital gains, carried from the
    // last AU settle that had gains. Feeds the IRC §865(g)(2) 10% test that decides
    // whether a personal-property gain is foreign source. Persists across settles by
    // design: it is a determination about the PRIOR year, not a YTD accumulator.
    this.auCgtEffectiveRate = null;
    // Design 83 G10 part 2 — subset tags on the US-source removal set, so the Art. 22(2)
    // figure can apply the Art. 10(2)(b) 15% dividend and Art. 11(2) 10% interest ceilings.
    // Both are SUBSETS of usSourceOrdinaryUsdYTD, never additional income.
    this.usSourceDividendsUsdYTD = 0;
    this.usSourceInterestUsdYTD = 0;
    this.usSourceGeneralUsdYTD = 0;
    this.usSourcePassiveUsdYTD = 0;
    this.usSourceOrdinaryAudYTD = 0;   // AUD, funds the §4.5 FITO limit
    this.usSourceCapGainsAudYTD = 0;
    // US-source *real* (indexed) AU cap gain (AUD) — funds the FY2027 FITO
    // "without" pass's CG slice (design 57 Part 2, Item D).
    this.usSourceRealCapGainsAudYTD = 0;
    // US tax paid on US-source income (AUD) — the FITO input; single-year handoff.
    this.usTaxPaidOnUsSourceAud = 0;

    // Per-person AU YTD accumulators.  Keys mirror state.people.
    // At AU tax settlement each person's share = perPersonMap[key] + sharedPool / numResidents.
    // As each income type is migrated to ownership-aware attribution, its shared pool drains to 0.
    const _personKeys = Object.entries(this.people)
      .filter(([, p]) => p != null)
      .map(([k]) => k);
    const _zeroes = () => Object.fromEntries(_personKeys.map(k => [k, 0]));
    this.auPersonOrdinaryIncomeYTD          = _zeroes();
    this.auPersonCapitalGainsYTD            = _zeroes();
    this.auPersonDiscountableGainsYTD       = _zeroes();
    this.auPersonRealCapitalGainsYTD        = _zeroes();
    this.auPersonFrankingCreditYTD          = _zeroes();
    this.auPersonNonResidentWithholdingYTD  = _zeroes();
    // Non-resident final withholding, split by income type — each type has its own
    // treaty rate (design 73 Gap 2): interest 10%, unfranked dividends 15%. The
    // undifferentiated map above kept its remaining feeders at the pooled 15%.
    this.auPersonNrWithholdingInterestYTD          = _zeroes();
    this.auPersonNrWithholdingUnfrankedDividendYTD = _zeroes();
    this.auPersonSuperTaxYTD                = _zeroes();
    // Div 36 carried-forward tax losses, AUD (design 86 G1). NOT a YTD accumulator:
    // deliberately absent from the settle reset lists, because surviving the year
    // boundary is the entire point. Per-person because Australia has no joint
    // assessment — one spouse's loss cannot shelter the other's income, and design 76
    // exists precisely because splitting a household scalar by headcount mis-attributes.
    this.auPersonTaxLossPool                = _zeroes();
    // AU-source *earned* income (wages/SE) per person — backs the per-person
    // FEIE cap (design 52 §4.2); disjoint from auPersonOrdinaryIncomeYTD.
    this.auPersonEarnedIncomeYTD            = _zeroes();
    // US-source slices of this person's AU-assessable income (design 76 Gap D), AUD.
    // These are the FITO "removal set": computeAuTaxPerPerson gives each person their
    // own share, and _assessResidentPreFito re-runs the without-US-source pass by
    // subtracting them. They MUST be attributed exactly like the income they are a
    // subset of — a mismatched removal set computes the FITO limit off the wrong base.
    this.auPersonUsSourceOrdinaryAudYTD         = _zeroes();
    this.auPersonUsSourceCapGainsAudYTD         = _zeroes();
    this.auPersonUsSourceRealCapGainsAudYTD     = _zeroes();

    // Guardrail strategy substrate (design/26 Increment 2).
    // initialWithdrawalRate is null until RETIREMENT_DATE_REACHED fires (or pre-populated
    // by the toolset when sim opens post-retirement).
    this.guardrail = {
      initialWithdrawalRate:        null,
      portfolioValue:               null,
      annualSpending:               null,
      baselineDate:                 null,
      lastAdjustmentDate:           null,
      lastAdjustmentCause:          null,
      currentAdjustmentMultiplier:  1.0,
    };

    // Healthcare tracking substrate (design/26 Increment 2).
    this.healthcareEventsScheduled = [];
    this.healthcareSpendingYTD     = 0;
    this.healthcareSpendingTotal   = 0;

    // Age-banded spending substrate (design/33). appliedFactor is the real
    // age multiplier currently folded into the expense slice; the reducer
    // reconciles against it each year so the factor never compounds.
    this.ageBandSpending = { appliedFactor: 1.0, currentBandStartAge: null };

    this.superWithdrawalBlocked = false;
    this.outOfFundsDate = null;
    this.scenarioFailed = false;
    this.cumulativeDeficit = 0;
    this.deficitMonths = 0;

    // Mortality substrate (design/27).
    // deceased: { [personId]: { date, taxJurisdiction } } — populated by PersonDiedApplyReducer.
    // scenarioComplete: true when no survivors remain — causes the run loop to halt.
    this.deceased         = {};
    this.scenarioComplete = false;
    this.lateLifeCare     = {};
  }
}

