/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseScenario }        from './base-scenario.js';
import { ScenarioSerializer }  from './scenario-serializer.js';
import { ServiceRegistry }     from '../services/service-registry.js';
import { AUD }                 from '../finance/assets/account.js';
import { ACCOUNT_ROLES }       from '../finance/state/account-roles.js';

/**
 * AuSingleHomeownerScenario — the Australian sibling of UsSingleHomeownerScenario.
 *
 * Same person, same age, same salary, same house, same twenty working years — on
 * the other side of the world. Holding the shape fixed is the point: it makes the
 * two scenarios a comparison of the two tax systems rather than of two different
 * people, and it is why the numbers below mirror the US ones asset for asset.
 *
 * ─── every figure here is AUD ────────────────────────────────────────────────
 *
 * The salary, the house, the balances and the expenses are all Australian dollars,
 * not the US scenario's numbers converted. A \$120,000 Australian salary is a
 * different (lower) real income than a \$120,000 American one, which is the honest
 * reading of "an Australian earning 120k".
 *
 * ─── what it reaches that the US scenario cannot ─────────────────────────────
 *
 * The Superannuation Guarantee and the fund's Div 295 contributions tax; a
 * VARIABLE-rate mortgage tracking the RBA cash rate rather than a fixed coupon;
 * AU resident dividends and the AU CGT discount; and — the reason the car sells —
 * an AU-resident disposal of a true (non-gold) collectible, which is the branch
 * design 57 Part 2 Q3 describes and nothing else in the suite runs.
 *
 * ─── the Age Pension is NOT modelled ─────────────────────────────────────────
 *
 * `socialSecurityMonthly` is 0 deliberately. The handler behind it credits a US
 * Social Security benefit; the Age Pension is means-tested against both income and
 * assets and is a different instrument entirely. Modelling it as an unconditional
 * monthly credit would overstate this household's retirement income, so the
 * scenario states zero and leaves the gap visible rather than filling it wrongly.
 */

export const AU_SINGLE_HOMEOWNER_DEFAULTS = {
  // ── The person ─────────────────────────────────────────────────────────────
  primaryBirthDate:      new Date(Date.UTC(1981, 6, 1)),
  primaryRetirementDate: new Date(Date.UTC(2046, 6, 1)),
  // AUD 120,000/yr, earned in Australia. `workCountry` states the source rather
  // than letting it be inferred from residency (design 73 Gap 1).
  primaryMonthlyWage:    10_000,

  // ── Cash ───────────────────────────────────────────────────────────────────
  // Checking is the flagged transaction account, savings the interest-bearing
  // reserve — the same two-pool arrangement as the US scenario.
  checkingBalance:        15_000,
  checkingMinBalance:      5_000,
  savingsBalance:         45_000,
  savingsMinBalance:      10_000,
  auSavingsInterestRate:   0.045,
  // The RBA cash rate the variable mortgage and the savings account both track.
  auPrimeRate:             0.0435,

  // ── Investments ────────────────────────────────────────────────────────────
  // One super fund instead of the US scenario's three wrappers, which is the whole
  // structural difference between the two retirement systems in this model.
  brokerageBalance:      150_000,
  brokerageBasis:        110_000,
  superBalance:          320_000,
  superBasis:            320_000,

  // ── Superannuation Guarantee ───────────────────────────────────────────────
  // Employer-paid, on top of the quoted salary. A scenario assumption, NOT a
  // transcription of the legislated SG schedule — this model carries no rate table
  // and the percentage steps by financial year in real life.
  superGuaranteePct:       0.12,
  superGuaranteeAnnualCap: 30_000,

  // ── The house ──────────────────────────────────────────────────────────────
  // VARIABLE rate, which is the Australian norm and the difference the user asked
  // for: `mortgagePrimeSpread` makes the loan track RBA cash + spread, so a Prime
  // sweep or an economic-regime shock moves the repayment. The starting effective
  // rate is auPrimeRate + spread = 6.35%.
  houseValue:            500_000,
  houseCostBasis:        380_000,
  houseAppreciationRate:   0.035,
  mortgageBalance:       320_000,
  mortgagePrimeSpread:     0.0200,
  monthlyMortgage:        2_360.44,
  mortgageMaturityYear:    2046,

  // ── Collectible ────────────────────────────────────────────────────────────
  // A classic car, and it SELLS inside the run — the disposal is the point. Not
  // gold, so no cost-base indexation on the AU side (design 57 Part 2, Q3).
  carValue:               75_000,
  carCostBasis:           45_000,
  carAppreciationRate:      0.04,
  carSaleYear:              2040,

  // ── Inheritance ────────────────────────────────────────────────────────────
  inheritanceYear:        2036,
  inheritedPropertyValue: 250_000,
  inheritedPropertyBasis:  90_000,
  inheritedBrokerageValue: 150_000,
  inheritedBrokerageBasis:  70_000,

  // ── Spending and rates ─────────────────────────────────────────────────────
  // AUD 7,000/month of living costs, separate from the mortgage.
  monthlyExpenses:         7_000,
  auInflationRate:         0.03,
  superGrowthRate:         0.07,
  auStockGrowthRate:       0.06,
  auStockDividendRate:     0.04,
};

/**
 * Scenario-level params — identity and the rates no single record owns. Balances,
 * the house, the car and the bequest are generated per-record by
 * `ScenarioParamGenerator` (design 55); listing them again here would create the
 * edit duality design 32 closed.
 */
export const AU_SINGLE_HOMEOWNER_PARAM_SCHEMA = [
  {
    key: 'primaryMonthlyWage', label: 'Monthly Salary (AUD)',
    type: 'Number', group: 'Income', mc: true, opt: true,
    defaultValue: AU_SINGLE_HOMEOWNER_DEFAULTS.primaryMonthlyWage,
    description: 'Gross monthly salary in AUD, for work performed in Australia. The Super Guarantee is a fraction of this, paid by the employer on top of it.',
    node: { type: 'person', id: 'primary', field: 'monthlyWage' },
  },
  {
    key: 'primaryRetirementDate', label: 'Retirement Date',
    type: 'Date', group: 'Income', mc: false, opt: true,
    defaultValue: AU_SINGLE_HOMEOWNER_DEFAULTS.primaryRetirementDate,
    description: 'Wages and the Super Guarantee both stop on this date.',
    node: { type: 'person', id: 'primary', field: 'retirementDate' },
  },
];

export class AuSingleHomeownerScenario extends BaseScenario {
  static scenarioId()   { return 'au-single-homeowner'; }
  static scenarioName() { return 'AU Single Homeowner'; }

  static instantiate(params, simStart, simEnd) {
    return new AuSingleHomeownerScenario({
      context: ServiceRegistry.getInstance().simulationContext,
      params,
      simStart,
      simEnd,
    });
  }

  static getParamSchema() { return AU_SINGLE_HOMEOWNER_PARAM_SCHEMA; }

  /**
   * There is no AU_COLLECTIBLES toolset — `US_COLLECTIBLES` owns the Collectible
   * asset type for both countries, and it declares `US_TAX` as a dependency.
   * `INHERITANCE` pulls `US_TAX` and `US_INCOME` in as well. So a scenario with
   * nothing American in it still compiles the US tax machinery, which is why US
   * period advances appear in its journal.
   *
   * It does NOT lodge a US return: `US_TAX.state()` stamps `usPersonHousehold`
   * false here (no US citizen, no US resident) and `UsTaxSettleHandler` skips the
   * settle. That gate was added FOR this scenario — without it the US module taxed
   * this Australian's Australian salary, because every AU income classifier books
   * into `usOrdinaryIncomeYTD` on the assumption that the model's earners are US
   * citizens. The result was an unfundable US tax bill and OUT_OF_FUNDS from the
   * first year, in a plan that ends with \$8M.
   */
  static getToolsets() {
    return [
      'AU_BANKING', 'AU_TAX', 'AU_BROKERAGE', 'AU_INCOME', 'AU_RETIREMENT',
      'AU_REAL_PROPERTY', 'US_COLLECTIBLES',
      // US_BROKERAGE is here for its ACTION MANIFEST alone, and is otherwise inert:
      // with no US_STOCK or FIXED_INCOME account it contributes no state, no
      // schedules, no handlers. It is needed because the shared drawdown path in
      // AccountService emits `STOCK_WITHDRAWAL_TAX` for an AU-domiciled brokerage
      // too — the US-named action is what the AU tax module registers a consumer
      // for — and that type's payload fields are declared in this toolset. Without
      // it every one of this scenario's brokerage disposals reaches the journal
      // through the fallback extractor, which is a reporting hole, not a tax error.
      'US_BROKERAGE',
      'INHERITANCE', 'ECONOMIC_REGIMES',
    ];
  }

  static buildDefaultConfig(params = {}, simStart, simEnd) {
    const p = { ...AU_SINGLE_HOMEOWNER_DEFAULTS, ...params };
    const toDate = v => (v instanceof Date ? v : new Date(v));
    const isoDate = d => ScenarioSerializer.toDateStr(toDate(d));

    const parameters = {
      // AU_BANKING / ECONOMIC_REGIMES
      auSavingsInterestRate:   p.auSavingsInterestRate,
      auPrimeRate:             p.auPrimeRate,
      // AU_RETIREMENT. `inflationRate` is the AU toolset's own key for AU CPI —
      // it is not the US one; the two toolsets each name their own country's rate
      // `inflationRate` and never both appear without the cross-border toolset.
      inflationRate:           p.auInflationRate,
      auInflationRate:         p.auInflationRate,
      inflationAdjust:         true,
      monthlyExpenses:         p.monthlyExpenses,
      superGrowthRate:         p.superGrowthRate,
      auStockGrowthRate:       p.auStockGrowthRate,
      auStockDividendRate:     p.auStockDividendRate,
      // Superannuation Guarantee
      superGuaranteePct:       p.superGuaranteePct,
      superGuaranteeAnnualCap: p.superGuaranteeAnnualCap,
      // Everyone here is Australian; nothing starts on the US side.
      startingResidency:       'AU',
      people: {
        primary: {
          name: 'Primary', residency: 'AU', sex: 'M',
          lifeExpectancy: 90,
        },
      },
    };

    return {
      toolsets: AuSingleHomeownerScenario.getToolsets(),
      simStart: ScenarioSerializer.toDateStr(simStart ?? new Date(Date.UTC(2026, 0, 1))),
      simEnd:   ScenarioSerializer.toDateStr(simEnd   ?? new Date(Date.UTC(2066, 0, 1))),
      parameters,

      persons: [
        {
          __type: 'Person', id: 'primary', name: 'Primary',
          birthDate:      isoDate(p.primaryBirthDate),
          citizen:        ['AU'],
          residency:      'AU',
          monthlyWage:    p.primaryMonthlyWage,
          wageCurrency:   'AUD',
          workCountry:    'AU',
          retirementDate: isoDate(p.primaryRetirementDate),
          lifeExpectancy: 90,
          // See the class comment: the Age Pension is means-tested and unmodelled.
          socialSecurityMonthly: 0,
        },
      ],

      accounts: [
        {
          __type: 'SavingsAccount',        stateKey: 'checkingAccount',
          name: 'Checking',                role: ACCOUNT_ROLES.AU_SAVINGS,
          balance: p.checkingBalance,      ownershipType: 'sole', ownerId: 'primary',
          minimumBalance: p.checkingMinBalance,
          country: 'AU', currency: AUD,
          isTransactionAccount: true,
          primeSpread: -p.auPrimeRate,     // a transaction account pays nothing
          drawdownPriority: 0,
        },
        {
          __type: 'SavingsAccount',        stateKey: 'auSavingsAccount',
          name: 'Savings',                 role: ACCOUNT_ROLES.AU_SAVINGS,
          balance: p.savingsBalance,       ownershipType: 'sole', ownerId: 'primary',
          minimumBalance: p.savingsMinBalance,
          country: 'AU', currency: AUD,
          primeSpread: p.auSavingsInterestRate - p.auPrimeRate,
          drawdownPriority: 0,
        },
        {
          __type: 'BrokerageAccount',      stateKey: 'auStockAccount',
          name: 'Brokerage',               role: ACCOUNT_ROLES.AU_STOCK,
          balance: p.brokerageBalance,     contributionBasis: p.brokerageBasis,
          ownerId: 'primary',              drawdownPriority: 1,
          country: 'AU', currency: AUD,
        },
        {
          __type: 'SuperannuationAccount', stateKey: 'superAccount',
          name: 'Superannuation',          role: ACCOUNT_ROLES.SUPER,
          balance: p.superBalance,         contributionBasis: p.superBasis,
          ownerId: 'primary',              drawdownPriority: 2,
          // Preservation age: super cannot be drawn before 60.
          minimumAge: 60,
          country: 'AU', currency: AUD,
        },
      ],

      realProperties: [
        {
          __type: 'RealProperty', name: 'Home', stateKey: 'auHouseProperty',
          value: p.houseValue, costBasis: p.houseCostBasis,
          appreciationRate: p.houseAppreciationRate,
          isPrimaryResidence: true, ownershipType: 'sole', ownerId: 'primary',
          country: 'AU',
          mortgageBalance:      p.mortgageBalance,
          // Variable rate: no absolute `mortgageInterestRate`, so `resolveLoanRate`
          // reads RBA cash + spread every payment (design 56 Phase 3).
          mortgagePrimeSpread:  p.mortgagePrimeSpread,
          monthlyMortgage:      p.monthlyMortgage,
          mortgageMaturityYear: p.mortgageMaturityYear,
        },
      ],

      collectibles: [
        {
          __type: 'Collectible', name: 'Classic Car', stateKey: 'carCollectible',
          value: p.carValue, costBasis: p.carCostBasis,
          appreciationRate: p.carAppreciationRate,
          ownershipType: 'sole', ownerId: 'primary',
          // AU-domiciled and AUD-denominated: the proceeds land in the AU cash pool
          // and the AU return assesses them without an FX leg.
          country: 'AU', currency: AUD,
          isGold: false,
          plannedSaleYear: p.carSaleYear,
        },
      ],

      bequests: [
        {
          __type: 'Bequest', name: "Parent's Estate", stateKey: 'estateBequest',
          decedentName: 'Parent', relationship: 'immediate',
          // Australia levies no inheritance or estate duty, so there is no
          // decedent state to name — the US scenario's Nebraska tax has no
          // counterpart here. What the heir takes on instead is the decedent's
          // cost base (no step-up), which is the AU side of design 63.
          decedentState: null,
          heirId: 'primary', paidViaEstate: false,
          inheritanceYear: p.inheritanceYear,
          assets: [
            { __type: 'RealProperty',     name: 'Inherited Home',      country: 'AU',
              stateKey: 'inheritedHomeProperty',
              inheritedValue: p.inheritedPropertyValue,
              deceasedCostBase: p.inheritedPropertyBasis },
            { __type: 'BrokerageAccount', name: 'Inherited Brokerage', country: 'AU',
              stateKey: 'inheritedBrokerageAccount',
              inheritedValue: p.inheritedBrokerageValue,
              deceasedCostBase: p.inheritedBrokerageBasis },
          ],
        },
      ],
    };
  }
}
