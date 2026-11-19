/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer,
  SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer,
  SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler,
  SeIncomeUsHandler, BonusHandler, CompanySaleHandler,
  BusinessIncomeApplyReducer, BusinessIncomeHandler,
} from '../../finance/account-rules/us/us-income-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';
import { OneOffEvent } from '../../simulation-framework/events/one-off-event.js';
import { keyedRng } from '../../simulation-framework/simulation.js';
import { bonusJobProblem } from '../../finance/payroll/employment.js';
import { businessIncomeDates } from '../../finance/payroll/business-income.js';
import { TaxSettleService } from '../../finance/tax-settle-service.js';

/**
 * US_INCOME toolset — US income event mechanics (SS, wages, SE, bonus, company sale).
 *
 * Capabilities: us-income
 * Depends on: US_TAX
 *
 * No guard: income reducers/handlers are always registered; they process events
 * that only fire when income is actually dispatched.
 */
export const US_INCOME = {
  id: 'US_INCOME',
  capabilities: ['us-income'],
  dependencies: ['US_TAX'],

  types: {
    handlers: [SsIncomeHandler, WagesIncomeHandler, WagesWithheldHandler, SeIncomeUsHandler, BonusHandler, CompanySaleHandler, BusinessIncomeHandler],
    reducers: [SsIncomeApplyReducer, WagesIncomeApplyReducer, WagesWithheldApplyReducer, SeIncomeUsApplyReducer, BonusApplyReducer, CompanySaleApplyReducer, BusinessIncomeApplyReducer],
    actions: [
      // own/spousal/survivor (design 118 §5.4): what the payment is made of, so the
      // journal can show a top-up apart from the person's own benefit.
      { type: 'SS_INCOME_APPLY',     fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , personKey: ValueType.text(),
        own: ValueType.currency('USD'), spousal: ValueType.currency('USD'), survivor: ValueType.currency('USD') } },
      { type: 'SS_INCOME_TAX',       fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , personKey: ValueType.text()} },
      // workCountry — where the employment is EXERCISED (design 73 Gap 1), stamped by
      // PayrollHandler on every wage/SE apply. It decides source, and source
      // decides FEIE/§904 basketing, so a "wages by source country" drill that cannot
      // see it silently reports every wage as domestic. Neither drift pass caught this
      // one: the handler picks the action type through a variable (invisible to the
      // static scan) and the field is null whenever workCountry falls back to an unset
      // residency (invisible to the dynamic pass, which skips null values).
      { type: 'WAGES_INCOME_APPLY',  fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text(), targetKey: ValueType.text(), workCountry: ValueType.text() , netAmount: ValueType.currency('USD'), splits: ValueType.any()} },
      { type: 'WAGES_INCOME_TAX',    fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text() } },
      // `alreadyNetted` (design 95 phase 5) records that the wage was credited NET,
      // so this action accumulates usWithheldYTD WITHOUT debiting cash. Undeclared it
      // is stripped from the journal payload, which leaves the audit trail unable to
      // explain why a withholding moved no money.
      // `family: 'TAX_WITHHELD'` (design 95 phase 6) is what puts withheld tax into
      // "Tax Paid by Year". The report used to read the TAX_PAYMENT_DEBIT family alone,
      // and withholding never becomes a debit — the settle debits only the balance due —
      // so the report understated US federal tax by the whole year's withholding. A
      // family of its own rather than TAX_PAYMENT_DEBIT: this action deliberately does
      // NOT debit cash when `alreadyNetted`, and it is the one place P7 can hang AU PAYG.
      { type: 'WAGES_WITHHELD_APPLY', family: 'TAX_WITHHELD', cc: 'US',
        fields: { amount: ValueType.currency('USD'),
        personKey: ValueType.text(), alreadyNetted: ValueType.boolean() } },
      { type: 'SE_INCOME_US_APPLY',  fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text(), targetKey: ValueType.text(), workCountry: ValueType.text() , netAmount: ValueType.currency('USD'), splits: ValueType.any()} },
      { type: 'SE_INCOME_US_TAX',    fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text() } },
      // Design 134 step 4b: a year of a `cfg.businessIncome` row. `indexBase` is the US CPI
      // accumulator the row's figures are in the money of (its first payment's).
      { type: 'BUSINESS_INCOME_APPLY', fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text(),
        businessIncomeId: ValueType.text(), indexBase: ValueType.number(), farmPathSeed: ValueType.number(),
        qbiW2Wages: ValueType.currency('USD'), qbiUbia: ValueType.currency('USD'),
        communityCollegeTax: ValueType.currency('USD') } },
      // Design 134 step 4f: community-college property tax inside a year of business income
      // (77-6706). US_STATE_TAX routes it to the state credit bucket.
      { type: 'STATE_COMMUNITY_COLLEGE_TAX_PAID', cc: 'US',
        fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text() } },
      // Design 134 step 4e: a year of business income's §199A inputs.
      { type: 'QBI_US_TAX', fields: { qbi: ValueType.currency('USD'), w2Wages: ValueType.currency('USD'),
        ubia: ValueType.currency('USD'), personKey: ValueType.text() } },
      { type: 'BONUS_APPLY',         fields: { amount: ValueType.currency('USD'), residency: ValueType.text(), personKey: ValueType.text() } },
      { type: 'BONUS_TAX',           fields: { amount: ValueType.currency('USD'), residency: ValueType.text() , personKey: ValueType.text()} },
      { type: 'COMPANY_SALE_APPLY',  fields: { salePrice: ValueType.currency('USD'), costBasis: ValueType.currency('USD'), residency: ValueType.text(), stateKey: ValueType.text(), destinationKey: ValueType.text() } },
      // proceeds/costBasis/description are what put the disposal on Schedule D and
      // Form 8949 — every other CAPITAL_GAINS type already declares them. Without
      // them the sale reached Form 1040 line 6 (which reads the YTD accumulator) but
      // was invisible on the schedules, since pickPayload keeps ONLY declared fields.
      { type: 'COMPANY_SALE_TAX', family: 'CAPITAL_GAINS', cc: 'US',
        fields: { auDeferredGain: ValueType.currency('USD'), auDeferredDiscountableGain: ValueType.currency('USD'), gain: ValueType.currency('USD'), auGain: ValueType.currency('USD'), auIndexedGain: ValueType.currency('USD'), usShortTermGain: ValueType.currency('USD'), usLongTermGain: ValueType.currency('USD'), auShortTermGain: ValueType.currency('USD'), auLongTermGain: ValueType.currency('USD'), residency: ValueType.text() , ownershipType: ValueType.text(), ownerId: ValueType.text(), owners: ValueType.any(),
                  proceeds: ValueType.currency('USD'), costBasis: ValueType.currency('USD'), description: ValueType.text() } },
    ],
  },

  paramSchema(context) {
    return [
      {
        // Design 134 step 4d. The single-run switch; Monte Carlo turns it on in every path
        // (`mcFarmPaths`), as it does the stochastic inflation path.
        key:          'businessIncomeFarmPaths',
        label:        'Business Income: Draw Farm Paths',
        type:         'Boolean',
        group:        'Business Income',
        mc:           false,
        opt:          false,
        defaultValue: false,
        description:  'When on, each year of an imported farm\'s business income is one Monte Carlo path of the farm, drawn at random for that year, instead of the farm\'s deterministic run. Seasons are then independent of one another, and of the household\'s market draws. The draw follows the run\'s seed, so a run replays. Needs a farm export imported with its paths; a row without them always pays its deterministic figures.',
      },
      {
        key:          'mcFarmPaths',
        label:        'Monte Carlo: Farm Paths',
        type:         'Boolean',
        group:        'Business Income',
        mc:           false,
        opt:          false,
        defaultValue: true,
        description:  'When on (default), every household Monte Carlo path draws its business income from the imported farm paths, a different farm season each year. Turn off to pay the farm\'s deterministic figures in every path, which shows the household\'s risk without the farm\'s.',
      },
      {
        // Design 134 step 4g-3. The law's default is the carryback; off is the
        // §172(b)(1)(B)(iv) election to waive it.
        key:          'usFarmingLossCarryback',
        label:        'Farming Loss Carryback',
        type:         'Boolean',
        group:        'Business Income',
        mc:           false,
        opt:          false,
        defaultValue: true,
        description:  'When on (default, as the law has it), a farm loss larger than the rest of the year\'s return is carried back to the two years before it, and the tax those years paid on it comes back as a refund at the loss year\'s settle. Whatever those years cannot absorb carries forward. Turn off to make the election to carry it forward only. Years before the plan count only if their taxable income is entered (usPriorReturns).',
      },
      {
        // Design 134 step 4g-3, Q11b: an option, off by default.
        key:          'usFarmIncomeAveraging',
        label:        'Farm Income Averaging (Schedule J)',
        type:         'Boolean',
        group:        'Business Income',
        mc:           false,
        opt:          false,
        defaultValue: false,
        description:  'When on, each year\'s return elects farm income averaging: whatever part of the farm\'s taxable income gives the least tax is taxed one third at each of the three prior years\' rates instead of this year\'s. It helps most in a good year after low ones. It needs three years of returns, from the run or from usPriorReturns, so a plan without prior years entered starts averaging in its fourth year.',
      },
    ];
  },
  /**
   * Design 134 step 4g-3. A plan with business income keeps a short history of its returns,
   * for the farming-loss carryback and Schedule J, seeded with the years before the run that
   * `cfg.usPriorReturns` gives (Q31). Those years' brackets are their published ones. The
   * elections are stamped beside it. A plan with no business income gains none of these keys.
   */
  state(context) {
    if (!(context?.businessIncome?.length > 0)) return {};
    const p = context.parameters ?? {};
    const single = p.usFilingSingle !== undefined ? Boolean(p.usFilingSingle) : (context.people?.length ?? 1) <= 1;
    const rates = new TaxSettleService();
    const prior = (context.usPriorReturns ?? []).map(r => {
      const m = rates.ratesForYear('US', r.year);
      const ti = Number(r.taxableIncome);
      return {
        year: r.year, ordinary: ti, gain: 0, jBase: ti, nolBase: Math.max(0, ti), nolUsed: 0,
        brackets: (single ? m._brackets_single : m._brackets_mfj).map(([lo, x]) => [lo, x]),
        ltcgBrackets: (single ? m._ltcg_single : m._ltcg_mfj).map(([lo, x]) => [lo, x]),
      };
    }).sort((a, b) => a.year - b.year).slice(-3);
    return {
      usReturnHistory: prior,
      usFarmingLossCarryback: p.usFarmingLossCarryback !== false,
      usFarmIncomeAveraging: p.usFarmIncomeAveraging === true,
    };
  },
  /**
   * One BONUS event per authored `cfg.bonuses` row inside the run. A row dated before
   * the run's start is history (the money is already in the accounts) and one after its
   * end can never fire, so neither is scheduled. Nor is one no USD job pays on its date —
   * a swept job or retire date can move the job's end past it (the loader warns). The
   * amount is in today's money: BonusHandler scales it by US CPI on the date, as a job's
   * wage is.
   */
  schedules(context) {
    return [...this._bonusEvents(context), ...this._businessIncomeEvents(context)];
  },

  _bonusEvents(context) {
    const start  = context?.startDate?.getTime?.() ?? -Infinity;
    const end    = context?.endDate?.getTime?.()   ??  Infinity;
    const person = id => (context?.people ?? []).find(p => p?.id === id);
    return (context?.bonuses ?? [])
      .filter(b => { const t = Date.parse(b.date); return t >= start && t <= end; })
      .filter(b => person(b.personId) != null
        && bonusJobProblem(b, person(b.personId), context?.spellsByPerson?.[b.personId] ?? null) == null)
      .map(b => new OneOffEvent({
        name:    `Bonus — ${person(b.personId).name ?? b.personId}`,
        type:    'BONUS',
        date:    new Date(b.date),
        data:    { amount: Number(b.amount), personId: b.personId, todaysMoney: true, bonusId: b.id },
        enabled: true,
        color:   '#2E7D32',
      }));
  },

  /**
   * One BUSINESS_INCOME event per year of each `cfg.businessIncome` row inside the run
   * (design 134 step 4b): the same year's figures every year, indexed by the handler.
   */
  _businessIncomeEvents(context) {
    const start = context?.startDate, end = context?.endDate;
    if (!start || !end) return [];
    const person = id => (context?.people ?? []).find(p => p?.id === id);
    // Design 134 step 4d (§16.1): with farm paths on, each year draws one path of the farm on
    // its own keyed stream, so a year's draw does not move when another row or process is
    // added. Seasons are independent, and independent of the market draws (Q15).
    const draw = context?.parameters?.businessIncomeFarmPaths === true;
    const pathsById = new Map();
    for (const p of context?.businessIncomePaths ?? []) {
      if (!pathsById.has(p.businessIncomeId)) pathsById.set(p.businessIncomeId, []);
      pathsById.get(p.businessIncomeId).push(p);
    }
    const out = [];
    for (const r of context?.businessIncome ?? []) {
      const p = person(r.personId);
      if (!p) continue;
      const paths = draw ? (pathsById.get(r.id) ?? []) : [];
      for (const { year, date } of businessIncomeDates(r, start, end)) {
        const picked = paths.length
          ? paths[Math.floor(keyedRng(context?.rngSeed ?? 1, `business-income:${r.id}`, year)() * paths.length)]
          : null;
        out.push(new OneOffEvent({
          name:    `${r.name ?? 'Business income'} ${year} — ${p.name ?? r.personId}`,
          type:    'BUSINESS_INCOME',
          date,
          data:    { businessIncomeId: r.id, personId: r.personId, year,
                     net: Number((picked ?? r).net),
                     neCommunityCollegeTax: Number((picked ?? r).neCommunityCollegeTax ?? 0),
                     farmPathSeed: picked?.seed ?? null,
                     qbiW2Wages: Number(r.qbiW2Wages ?? 0), qbiUbia: Number(r.qbiUbia ?? 0) },
          enabled: true,
          color:   '#6D4C41',
        }));
      }
    }
    return out;
  },

  handlers(context) {
    return [
      new SsIncomeHandler(),
      new WagesIncomeHandler(),
      new WagesWithheldHandler(),
      new SeIncomeUsHandler(),
      new BonusHandler(),
      new CompanySaleHandler(),
      new BusinessIncomeHandler(),
    ];
  },

  reducers(context) {
    const accountService = context.accountService;
    const stateRegistry  = context.stateRegistry;
    return [
      new SsIncomeApplyReducer({ accountService, stateRegistry }),
      new WagesIncomeApplyReducer({ accountService, stateRegistry }),
      new WagesWithheldApplyReducer({ accountService, stateRegistry }),
      new SeIncomeUsApplyReducer({ accountService, stateRegistry }),
      new BonusApplyReducer({ accountService, stateRegistry }),
      new CompanySaleApplyReducer({ accountService, stateRegistry }),
      new BusinessIncomeApplyReducer({ accountService, stateRegistry }),
    ];
  },
};
