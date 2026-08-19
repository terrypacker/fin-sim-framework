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
import { USD }                 from '../finance/assets/account.js';
import { ACCOUNT_ROLES }       from '../finance/state/account-roles.js';
import { US_STATE_CODES }      from '../finance/tax/state/us-states.js';

/**
 * UsSingleHomeownerScenario — one person, one country, a mortgage and a job.
 *
 * The counterpart to `IntlRetirementScenario`, and deliberately its opposite in
 * almost every dimension: single rather than married, US-only rather than
 * cross-border, accumulating rather than decumulating, and starting twenty years
 * before retirement rather than at it.
 *
 * ─── why this scenario exists ────────────────────────────────────────────────
 *
 * Most of what this model can do had never been run end to end. The golden
 * coverage manifest (`tests/helpers/golden-coverage-manifest.js`) named the
 * missing runs itself: "a plan holding a mortgaged property", "a pre-retirement
 * golden with wages", US state income tax, `NE_INHERITANCE_TAX`, the retirement
 * contribution family, RMDs. Every one of those is ordinary — a working
 * homeowner's plan — and none of them were reachable from the one prebuilt
 * scenario, whose subject is a retired couple emigrating to Australia.
 *
 * So this is both a first-run default that looks like a normal person's finances
 * and the fixture behind `golden-us-single-homeowner`.
 *
 * ─── the numbers are assumptions, not authority ──────────────────────────────
 *
 * Balances, the mortgage rate and payment, the contribution rates and their caps
 * are all stated below with the reasoning for each. They are a plausible
 * 45-year-old, not a transcription of anything: in particular `k401AnnualCap` is a
 * scenario assumption and NOT the indexed §402(g) elective deferral limit, which
 * this model does not carry a schedule for.
 *
 * ─── what it does NOT model ──────────────────────────────────────────────────
 *
 * No spouse, so no survivor mechanics; no residency change; and the AU toolsets
 * ride along inert because `INHERITANCE` declares `AU_TAX` as a dependency. With
 * no AU person, account or income they contribute empty accumulators and an AU
 * return that assesses nothing.
 */

/**
 * The whole scenario in one object, so a reader can see every assumption together
 * rather than hunting them through the config builder below.
 */
export const US_SINGLE_HOMEOWNER_DEFAULTS = {
  // ── The person ─────────────────────────────────────────────────────────────
  // Age 45 at the 2026 start, retiring the month he turns 65.
  primaryBirthDate:      new Date(Date.UTC(1981, 6, 1)),
  primaryRetirementDate: new Date(Date.UTC(2046, 6, 1)),
  // $120,000/yr. Paid in USD for work performed in the US, which is what makes the
  // whole US-source path (design 73) the simple case here.
  primaryMonthlyWage:    10_000,
  // Nebraska: chosen over a no-income-tax state on purpose. NE has BOTH a state
  // income tax and an inheritance tax, so one residency choice reaches two
  // otherwise-unexercised modules — and the bequest below lands in the second.
  residencyState:        'NE',
  // Claimed at Full Retirement Age. A single earner's benefit on this salary.
  socialSecurityMonthly: 2_800,

  // ── Cash ───────────────────────────────────────────────────────────────────
  // Two pools, which is the point: CHECKING is the flagged transaction account, so
  // wages land there and expenses debit it, while SAVINGS is the interest-bearing
  // reserve. One flag is the whole difference — there is no separate "checking"
  // role, and adding one would fork every cash-routing decision in the model.
  checkingBalance:        15_000,
  checkingMinBalance:      5_000,
  savingsBalance:         45_000,
  savingsMinBalance:      10_000,
  usSavingsInterestRate:   0.035,
  usPrimeRate:             0.045,

  // ── Investments ────────────────────────────────────────────────────────────
  // A twenty-year saver's balance sheet: most of the money in the 401(k), a
  // taxable brokerage beside it, and a Roth that started later than the IRA.
  brokerageBalance:      150_000,
  brokerageBasis:        110_000,
  k401Balance:           320_000,
  k401Basis:             320_000,   // all pre-tax dollars; no after-tax basis
  iraBalance:             85_000,
  iraBasis:               85_000,
  rothBalance:            60_000,
  rothBasis:              45_000,   // contributions; the rest is growth

  // ── Payroll contributions (design: retirement-contribution-handler.js) ──────
  // 10% deferred with a 4% match is an unremarkable private-sector plan. The cap
  // binds on neither at this salary — it is set so the LEVER is exercised and so a
  // user who raises the salary does not silently contribute an impossible amount.
  k401DeferralPct:         0.10,
  k401EmployerMatchPct:    0.04,
  k401AnnualCap:          24_000,
  // A deductible IRA and a Roth funded alongside the plan.
  iraAnnualContribution:   4_000,
  rothAnnualContribution:  4_000,

  // ── The house ──────────────────────────────────────────────────────────────
  // A $500k home with 20 years left to run on a fixed-rate mortgage. The payment
  // is the exact P&I instalment that amortises the balance over that term at the
  // stated rate, so the loan retires in its maturity year rather than drifting.
  houseValue:            500_000,
  houseCostBasis:        380_000,
  houseAppreciationRate:   0.035,
  mortgageBalance:       320_000,
  mortgageInterestRate:    0.065,
  monthlyMortgage:        2_385.66,
  mortgageMaturityYear:    2046,

  // ── Collectible ────────────────────────────────────────────────────────────
  // Art, explicitly NOT gold: `isGold` is what separates investment bullion (an
  // ordinary AU CGT asset, cost-base indexed) from a true collectible taxed at the
  // US 28% rate. Art is the second branch, and nothing else in the suite runs it.
  artValue:              150_000,
  artCostBasis:           90_000,
  artAppreciationRate:     0.03,

  // ── Inheritance (design 63) ────────────────────────────────────────────────
  // At 55. A property and a taxable brokerage from a parent — so the run reaches
  // the US step-up in basis AND the Nebraska inheritance tax on a close relative's
  // bequest, which no other scenario touches.
  inheritanceYear:        2036,
  inheritedPropertyValue: 250_000,
  inheritedPropertyBasis:  90_000,
  inheritedBrokerageValue: 150_000,
  inheritedBrokerageBasis:  70_000,

  // ── Spending and rates ─────────────────────────────────────────────────────
  // $7,000/month of living costs, SEPARATE from the mortgage: `monthlyExpenses`
  // never includes loan payments, which are debited by the loan schedule.
  monthlyExpenses:         7_000,
  usInflationRate:         0.03,
  brokerageGrowthRate:     0.06,
  brokerageDividendRate:   0.02,
  k401GrowthRate:          0.07,
  iraGrowthRate:           0.07,
  rothGrowthRate:          0.07,
};

/**
 * Scenario-level params: the ones that are NOT generated per-record.
 *
 * Balances, property values, the mortgage fields, the collectible and the bequest
 * year all become params automatically — `ScenarioParamGenerator` derives them
 * from the records in the config (design 55). Listing them here as well would
 * create two params for one field, which is exactly the edit-duality trap design
 * 32 closed. What remains is identity (who, when), the payroll contribution rates
 * (which belong to no single record), and the state of residence.
 */
export const US_SINGLE_HOMEOWNER_PARAM_SCHEMA = [
  {
    key: 'residencyState', label: 'US Residency State',
    type: 'Enum', options: ['', ...US_STATE_CODES], group: 'US Tax', mc: true, opt: true,
    defaultValue: US_SINGLE_HOMEOWNER_DEFAULTS.residencyState,
    description: `US state of residency for state income tax (${US_STATE_CODES.join(', ')}). Blank = none.`,
    node: { type: 'person', id: 'primary', field: 'residencyState' },
  },
  {
    key: 'primaryMonthlyWage', label: 'Monthly Salary',
    type: 'Number', group: 'Income', mc: true, opt: true,
    defaultValue: US_SINGLE_HOMEOWNER_DEFAULTS.primaryMonthlyWage,
    description: 'Gross monthly salary, paid in USD for work performed in the US. Every payroll contribution below is a fraction of this.',
    node: { type: 'person', id: 'primary', field: 'monthlyWage' },
  },
  {
    key: 'primaryRetirementDate', label: 'Retirement Date',
    type: 'Date', group: 'Income', mc: false, opt: true,
    defaultValue: US_SINGLE_HOMEOWNER_DEFAULTS.primaryRetirementDate,
    description: 'Wages and every payroll contribution stop on this date.',
    node: { type: 'person', id: 'primary', field: 'retirementDate' },
  },
  {
    key: 'socialSecurityMonthly', label: 'Social Security (monthly)',
    type: 'Number', group: 'Income', mc: false, opt: true,
    defaultValue: US_SINGLE_HOMEOWNER_DEFAULTS.socialSecurityMonthly,
    description: 'Monthly Social Security benefit, paid from the retirement date.',
    node: { type: 'person', id: 'primary', field: 'socialSecurityMonthly' },
  },
];

export class UsSingleHomeownerScenario extends BaseScenario {
  static scenarioId()   { return 'us-single-homeowner'; }
  static scenarioName() { return 'US Single Homeowner'; }

  static instantiate(params, simStart, simEnd) {
    return new UsSingleHomeownerScenario({
      context: ServiceRegistry.getInstance().simulationContext,
      params,
      simStart,
      simEnd,
    });
  }

  static getParamSchema() { return US_SINGLE_HOMEOWNER_PARAM_SCHEMA; }

  /**
   * US_STATE_TAX for Nebraska, US_COLLECTIBLES for the art, INHERITANCE for the
   * bequest, ECONOMIC_REGIMES so the Prime-linked cash rate and the shock/regime
   * levers are available. US_ROTH_CONVERSION and US_EARLY_WITHDRAWAL are here
   * because both are off by default and are exactly the levers someone would reach
   * for in the low-income window between retiring at 65 and RMDs at 73.
   *
   * INHERITANCE pulls AU_TAX (and AU_BANKING behind it) in through its dependency
   * list. Harmless with no AU person or account, but it is why an AU return appears
   * in the journal of a scenario with nothing Australian in it.
   */
  static getToolsets() {
    return [
      'US_BANKING', 'US_TAX', 'US_STATE_TAX', 'US_BROKERAGE', 'US_INCOME', 'US_RETIREMENT',
      'US_REAL_PROPERTY', 'US_COLLECTIBLES',
      'US_ROTH_CONVERSION', 'US_EARLY_WITHDRAWAL',
      'INHERITANCE', 'ECONOMIC_REGIMES',
    ];
  }

  static buildDefaultConfig(params = {}, simStart, simEnd) {
    const p = { ...US_SINGLE_HOMEOWNER_DEFAULTS, ...params };
    const toDate = v => (v instanceof Date ? v : new Date(v));
    const isoDate = d => ScenarioSerializer.toDateStr(toDate(d));

    const parameters = {
      // US_STATE_TAX — cascades onto the person's residencyState
      residencyState:          p.residencyState || null,
      // US_BANKING / ECONOMIC_REGIMES
      usSavingsInterestRate:   p.usSavingsInterestRate,
      usPrimeRate:             p.usPrimeRate,
      // US_TAX. One person, so the toolset would auto-detect single anyway; stating
      // it makes the filing status a visible property of the scenario rather than a
      // side effect of the household's size.
      usFilingSingle:          true,
      // US_RETIREMENT
      inflationRate:           p.usInflationRate,
      inflationAdjust:         true,
      monthlyExpenses:         p.monthlyExpenses,
      brokerageGrowthRate:     p.brokerageGrowthRate,
      brokerageDividendRate:   p.brokerageDividendRate,
      k401GrowthRate:          p.k401GrowthRate,
      iraGrowthRate:           p.iraGrowthRate,
      rothGrowthRate:          p.rothGrowthRate,
      // Payroll contributions
      k401DeferralPct:         p.k401DeferralPct,
      k401EmployerMatchPct:    p.k401EmployerMatchPct,
      k401AnnualCap:           p.k401AnnualCap,
      iraAnnualContribution:   p.iraAnnualContribution,
      rothAnnualContribution:  p.rothAnnualContribution,
      // Mortality seed for MC actuarial draws (design 27). Mirrors the person record.
      people: {
        primary: {
          name: 'Primary', residency: 'US', sex: 'M',
          residencyState: p.residencyState || null,
          lifeExpectancy: 90,
        },
      },
    };

    return {
      toolsets: UsSingleHomeownerScenario.getToolsets(),
      simStart: ScenarioSerializer.toDateStr(simStart ?? new Date(Date.UTC(2026, 0, 1))),
      simEnd:   ScenarioSerializer.toDateStr(simEnd   ?? new Date(Date.UTC(2066, 0, 1))),
      parameters,

      persons: [
        {
          __type: 'Person', id: 'primary', name: 'Primary',
          birthDate:      isoDate(p.primaryBirthDate),
          citizen:        ['US'],
          residency:      'US',
          residencyState: p.residencyState || null,
          monthlyWage:    p.primaryMonthlyWage,
          wageCurrency:   'USD',
          // Design 73: source of employment income is where the work is performed.
          // Stated rather than inferred, so the US-source path is explicit.
          workCountry:    'US',
          retirementDate: isoDate(p.primaryRetirementDate),
          lifeExpectancy: 90,
          socialSecurityMonthly: p.socialSecurityMonthly,
        },
      ],

      accounts: [
        {
          __type: 'SavingsAccount',        stateKey: 'checkingAccount',
          name: 'Checking',                role: ACCOUNT_ROLES.US_SAVINGS,
          balance: p.checkingBalance,      ownershipType: 'sole', ownerId: 'primary',
          minimumBalance: p.checkingMinBalance,
          country: 'US', currency: USD,
          // THE flag: wages land here and expenses debit here (design 55 §7).
          isTransactionAccount: true,
          // A transaction account pays little or nothing; the spread is against Prime
          // so a Prime sweep still moves it.
          primeSpread: -p.usPrimeRate,
          drawdownPriority: 0,
        },
        {
          __type: 'SavingsAccount',        stateKey: 'usSavingsAccount',
          name: 'Savings',                 role: ACCOUNT_ROLES.US_SAVINGS,
          balance: p.savingsBalance,       ownershipType: 'sole', ownerId: 'primary',
          minimumBalance: p.savingsMinBalance,
          country: 'US', currency: USD,
          // Prime-linked with a value-preserving spread: the effective rate is
          // usSavingsInterestRate today, and a Prime sweep moves it (design 56 §11).
          primeSpread: p.usSavingsInterestRate - p.usPrimeRate,
          drawdownPriority: 0,
        },
        {
          __type: 'BrokerageAccount',      stateKey: 'usStockAccount',
          name: 'Brokerage',               role: ACCOUNT_ROLES.US_STOCK,
          balance: p.brokerageBalance,     contributionBasis: p.brokerageBasis,
          ownerId: 'primary',              drawdownPriority: 1,
          country: 'US', currency: USD,
        },
        {
          __type: 'FourOhOneKAccount',     stateKey: 'k401Account',
          name: '401(k)',                  role: ACCOUNT_ROLES.K401,
          balance: p.k401Balance,          contributionBasis: p.k401Basis,
          ownerId: 'primary',              drawdownPriority: 3,
          country: 'US', currency: USD,
        },
        {
          __type: 'TraditionalIRAAccount', stateKey: 'iraAccount',
          name: 'Traditional IRA',         role: ACCOUNT_ROLES.IRA,
          balance: p.iraBalance,           contributionBasis: p.iraBasis,
          ownerId: 'primary',              drawdownPriority: 2,
          country: 'US', currency: USD,
        },
        {
          __type: 'RothAccount',           stateKey: 'rothAccount',
          name: 'Roth IRA',                role: ACCOUNT_ROLES.ROTH,
          balance: p.rothBalance,          contributionBasis: p.rothBasis,
          ownerId: 'primary',              drawdownPriority: 4,
          country: 'US', currency: USD,
        },
      ],

      realProperties: [
        {
          __type: 'RealProperty', name: 'Home', stateKey: 'usHouseProperty',
          value: p.houseValue, costBasis: p.houseCostBasis,
          appreciationRate: p.houseAppreciationRate,
          isPrimaryResidence: true, ownershipType: 'sole', ownerId: 'primary',
          country: 'US',
          // The mortgage is not a field on the property — it is synthesized into a
          // linked Loan liability account (design 54 P2), which is what carries the
          // balance, amortises, and shows as negative net worth.
          mortgageBalance:      p.mortgageBalance,
          mortgageInterestRate: p.mortgageInterestRate,
          monthlyMortgage:      p.monthlyMortgage,
          mortgageMaturityYear: p.mortgageMaturityYear,
        },
      ],

      collectibles: [
        {
          __type: 'Collectible', name: 'Art', stateKey: 'artCollectible',
          value: p.artValue, costBasis: p.artCostBasis,
          appreciationRate: p.artAppreciationRate,
          ownershipType: 'sole', ownerId: 'primary', country: 'US',
          // Not bullion: a true collectible, taxed at the US 28% rate on disposal.
          isGold: false,
        },
      ],

      bequests: [
        {
          __type: 'Bequest', name: "Parent's Estate", stateKey: 'estateBequest',
          decedentName: 'Parent', relationship: 'immediate',
          // The decedent's state is what the inheritance tax is levied by, and
          // Nebraska is the one this model implements. Same state as the heir here,
          // which is the ordinary case.
          decedentState: 'NE',
          heirId: 'primary', paidViaEstate: false,
          inheritanceYear: p.inheritanceYear,
          assets: [
            { __type: 'RealProperty',     name: 'Inherited Home',      country: 'US',
              stateKey: 'inheritedHomeProperty',
              inheritedValue: p.inheritedPropertyValue,
              deceasedCostBase: p.inheritedPropertyBasis },
            { __type: 'BrokerageAccount', name: 'Inherited Brokerage', country: 'US',
              stateKey: 'inheritedBrokerageAccount',
              inheritedValue: p.inheritedBrokerageValue,
              deceasedCostBase: p.inheritedBrokerageBasis },
          ],
        },
      ],
    };
  }
}
