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

    this.inflationRates       = inflationRates ?? { US: 0.03, AU: 0.03 };
    this.inflationAccumulator = { US: 1.0, AU: 1.0 };
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

    // YTD tax accumulators
    this.usOrdinaryIncomeYTD = 0;
    this.usNegativeIncomeYTD = 0;
    this.usCapitalGainsYTD = 0;
    this.usPenaltyYTD = 0;
    this.auOrdinaryIncomeYTD = 0;  // shared/passive income (dividends, savings interest, etc.)
    this.auCapitalGainsYTD = 0;
    this.auNonResidentWithholdingYTD = 0;
    this.auSuperTaxYTD = 0;
    this.auFrankingCreditYTD = 0;
    this.ftcYTD = 0;

    // Per-person AU YTD accumulators.  Keys mirror state.people.
    // At AU tax settlement each person's share = perPersonMap[key] + sharedPool / numResidents.
    // As each income type is migrated to ownership-aware attribution, its shared pool drains to 0.
    const _personKeys = Object.entries(this.people)
      .filter(([, p]) => p != null)
      .map(([k]) => k);
    const _zeroes = () => Object.fromEntries(_personKeys.map(k => [k, 0]));
    this.auPersonOrdinaryIncomeYTD          = _zeroes();
    this.auPersonCapitalGainsYTD            = _zeroes();
    this.auPersonFrankingCreditYTD          = _zeroes();
    this.auPersonNonResidentWithholdingYTD  = _zeroes();
    this.auPersonSuperTaxYTD                = _zeroes();

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

