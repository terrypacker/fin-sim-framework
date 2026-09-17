/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { TaxService }    from '../../finance/tax-service.js';
import { PeriodService } from '../../finance/period/period-service.js';
import { BalanceSnapshotReducer } from '../../simulation-framework/reducers.js';
import { buildAuFiscalYear, applyTo }
  from '../../finance/period/period-builder.js';
import { AuPeriodAdvanceHandler, AuPeriodAdvanceReducer }
  from '../../finance/tax/period-advance-classes.js';
import { AuTaxSettleHandler, AuTaxSettleApplyReducer, AuTaxPaymentDebitReducer }
  from '../../finance/tax/tax-settle-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * AU_TAX toolset — declarative shell around TaxService for AU.
 *
 * Capabilities: taxation
 * Depends on: AU_BANKING
 *
 * State ownership:
 *   Initializes: currentPeriods['AU'] (via TaxService), and all AU YTD counters
 *   that the AU tax modules read without null-safety:
 *   auOrdinaryIncomeYTD, auCapitalGainsYTD, auNonResidentWithholdingYTD,
 *   auSuperTaxYTD, auFrankingCreditYTD, ftcYTD (needed for AU→US FTC flows)
 *   Per-person maps initialized to {} (AU modules use ?? {} guard).
 */
export const AU_TAX = {
  id: 'AU_TAX',
  capabilities: ['taxation'],
  dependencies: ['AU_BANKING'],

  types: {
    handlers: [AuPeriodAdvanceHandler, AuTaxSettleHandler],
    reducers: [AuPeriodAdvanceReducer, AuTaxSettleApplyReducer, AuTaxPaymentDebitReducer, BalanceSnapshotReducer],
    actions: [
      { type: 'AU_PERIOD_ADVANCE',  fields: { period: ValueType.any() } },
      { type: 'AU_TAX_SETTLE_APPLY', family: 'TAX_SETTLE_APPLY', cc: 'AU',
        // `fundTax` (design 77 §5.4) — AUD Div 295 super fund tax for the FY. Must be
        // declared: pickPayload keeps ONLY declared fields, so an undeclared field
        // never reaches the journal or the document modules.
        // `fyStartYear` (design 95 §9.3 phase 7) — the financial year this settlement
        // CLOSES, stamped by the handler because a reducer never sees a date. The
        // unused-concessional-cap roll keys off it, and an undeclared field would be
        // stripped from the journal, leaving the one number that explains which
        // vintage expired invisible in the audit trail.
        fields: { tax: ValueType.number(), taxDetail: ValueType.any(), personTaxDetails: ValueType.any(),
                  fxRate: ValueType.number(), fundTax: ValueType.currency('AUD'),
                  fyStartYear: ValueType.number(),
                  // `limitIndexFactor` (design 95 §10 phase 9) — the contribution-cap
                  // index factor this year was assessed under. Declared so the journal
                  // can explain a cap that differs from the published table.
                  limitIndexFactor: ValueType.number() } },
      // ── design 107 §6–§8 — instalments and the refund they make routine ─────────
      // The instalment is its OWN family, not TAX_PAYMENT_DEBIT: it chains one of those to
      // move the cash, so counting both would double every instalment in "Tax Paid by Year".
      { type: 'AU_TAX_INSTALMENT_DEBIT', family: 'TAX_INSTALMENT', cc: 'AU',
        fields: { amount: ValueType.currency('AUD'), quarter: ValueType.number() } },
      // A refund is a CREDIT and belongs to no debit family — netting it into the paid line
      // would report a year that over-paid as one that paid less tax, which is not what
      // happened: the tax was the same and the timing was wrong.
      { type: 'AU_TAX_REFUND_CREDIT', cc: 'AU',
        fields: { amount: ValueType.currency('AUD') } },
      { type: 'AU_TAX_PAYMENT_DEBIT', family: 'TAX_PAYMENT_DEBIT', cc: 'AU',
        // `escalated` marks the re-issue that pays the part of the SAME bill the
        // first pass could not fund (see TaxPaymentDebitReducerBase). Must be
        // declared: pickPayload keeps ONLY declared fields, and "Tax Paid by Year"
        // filters on it to avoid counting the funded part twice.
        // Design 87 §14.4 item 1 / G12 — the §988 character declaration the currency lot
        // observer reads off this action. Declared for JOURNAL visibility rather than for
        // the mechanism (the observer sees the live action, which pickPayload never
        // filters): undeclared, an AU tax payment out of an AUD pool would dispose
        // correctly and then be invisible in every report that reads the journal.
        fields: { amount: ValueType.currency('AUD'), escalated: ValueType.boolean(),
                  section988: ValueType.any() } },
      { type: 'RECORD_BALANCE',    fields: { fieldPath: ValueType.text(), metricKey: ValueType.text() } },
    ],
  },

  paramSchema(context) {
    return [
      {
        // ── design 107 §6–§8 — paying tax in instalments ─────────────────────────────
        key: 'taxInstalmentsEnabled', label: 'Pay Tax in Instalments',
        type: 'Boolean', group: 'Tax', mc: false, opt: false,
        defaultValue: false,
        description: 'Pay income tax across the year on the statutory dates instead of as one '
          + 'lump at the settle. Off (the default) the whole year\'s liability is a single debit on '
          + '31 December / 30 June, funded by a draw on that same date — so one date\'s market price '
          + 'decides what must be sold to pay a bill computed on the previous twelve months, and a '
          + 'crash landing in December is met by selling at the bottom in every path. On, the US pays '
          + 'four instalments on 15 Apr / 15 Jun / 15 Sep / 15 Jan (IRC §6654(c)(2)) sized from the '
          + 'PRIOR year\'s return — 100% of it, or 110% where that return\'s AGI exceeded \$150,000 '
          + '(§6654(d)(1)(B)(ii), (C)(i)) — and Australia pays four PAYG instalments after each '
          + 'quarter (TAA 1953 Sch 1 s 45-61) at 25/50/75/100% of GDP-adjusted notional tax '
          + '(s 45-400(2)). The settle then moves only the true-up, and refunds an over-payment. '
          + 'Note the two regimes differ in a way that matters: the US basis is last year\'s whole '
          + 'tax including capital gains, so the prior-year safe harbour is complete, while '
          + 's 45-330(1)(a) EXCLUDES net capital gain from the AU base — so an AU retiree funding '
          + 'spending by realising gains still meets a large balancing payment at assessment. That '
          + 'is the law, not a modelling gap.',
      },
      {
        key: 'auGdpUplift', label: 'AU GDP Adjustment',
        type: 'Number', group: 'Tax', mc: false, opt: false,
        min: 0, max: 0.2, step: 0.01,
        defaultValue: 0.05,
        description: 'The GDP adjustment applied to the base year\'s income when the Commissioner '
          + 'works out PAYG instalments (TAA 1953 Sch 1 s 45-405(2)–(3)); a negative figure reads as '
          + '0% under s 45-405(3)(b). The default 0.05 is the ATO\'s published factor for the '
          + '2026–27 income year (4% for 2025–26) — see docs/au-tax/ato-rates/. It moves only the '
          + 'TIMING of cash, never the total tax, because the assessment credits the instalments '
          + 'exactly (s 45-30), so it is not worth sweeping. It does NOT apply to an annual payer or '
          + 'to the instalment-RATE method: the ATO applies it to the notified AMOUNT only.',
        visibleWhen: { param: 'taxInstalmentsEnabled', equals: true },
      },
      {
        key: 'auNotionalTaxRate', label: 'AU Notional Tax Rate',
        type: 'Number', group: 'Tax', mc: false, opt: false,
        min: 0, max: 0.6, step: 0.01,
        defaultValue: 0.25,
        description: 'The flat rate the base year\'s adjusted taxable income is re-taxed at to get '
          + 'notional tax (s 45-325). A simplification, stated rather than hidden: the section wants '
          + 'the base year\'s ADJUSTED TAX on that income, i.e. the progressive scale applied again, '
          + 'and computing it would mean re-entering the AU tax engine on a counterfactual state '
          + 'from inside a handler. The error is absorbed completely by the balancing payment at '
          + 'assessment, so it shifts cash between quarters and nothing else.',
        visibleWhen: { param: 'taxInstalmentsEnabled', equals: true },
      },
      {
        key: 'auDeferredBasPayer', label: 'Deferred BAS Payer',
        type: 'Boolean', group: 'Tax', mc: false, opt: false,
        defaultValue: true,
        description: 'Whether the s 45-61(2) due dates apply — the 28th of the month after each '
          + 'instalment quarter rather than s 45-61(1)\'s 21st, with the December quarter falling on '
          + 'the next 28 February. True (the default) is most individuals lodging through an agent, '
          + 'and gives the 28 Oct / 28 Feb / 28 Apr / 28 Jul calendar people actually experience.',
        visibleWhen: { param: 'taxInstalmentsEnabled', equals: true },
      },
      {
        // Dedicated ATO CPI indexation rate for AU CGT cost-base indexation
        // (design 57 Part 2, Item A). Unset ⇒ the InflationAdjustReducer falls
        // back to the effective AU inflation rate, so indexation is byte-identical
        // to using inflationAccumulator. Set a distinct value to decouple the CGT
        // index from household wage/expense inflation.
        key: 'auCpiRate', label: 'AU CGT Indexation (CPI) Rate',
        type: 'Number', group: 'AU Tax', mc: true, opt: false,
        defaultValue: undefined,
        description: 'Annual ATO CPI rate used to index AU capital-gains cost bases (FY2027+). '
          + 'Leave unset to track the AU inflation rate.',
      },
      {
        // Distinct from auCpiRate above, which indexes CGT COST BASES under the FY2027
        // reform. This one projects the INCOME TAX BRACKETS past FY2027-28, the newest
        // legislated table.
        //
        // Australia does not index its brackets at all — bracket creep is the statutory
        // outcome, periodically undone by an ad-hoc cut like Stage 3. So 0 (track CPI)
        // is this model's assumption that some future government keeps doing that, NOT
        // a transcription. A spread of -(inflation rate) models the law as written.
        // `opt: false` — see usFederalBracketIndexSpread.
        key: 'auBracketIndexSpread', label: 'AU Bracket Indexation Spread',
        type: 'Number', group: 'AU Tax', mc: true, opt: false,
        defaultValue: 0,
        description: 'Annual rate at which AU income tax brackets and the Medicare levy '
          + 'threshold are projected to rise past FY2027-28, expressed as a spread ADDED TO '
          + 'inflation (0 = track CPI, -0.03 against 3% inflation = frozen brackets, which is '
          + 'what AU law actually says). Published years are always used as legislated.',
      },
    ];
  },

  state(context) {
    const capture = _getContributions(context);
    const auCpiRate = context.parameters?.auCpiRate;
    const state = {
      ...capture.statePatches,
      // Dedicated ATO CPI series (design 57 Part 2, Item A). Only seed cpiRates.AU
      // when an explicit rate is given; otherwise leave it absent so the reducer
      // falls back to the effective AU inflation rate (no golden movement).
      cpiRates:                         (auCpiRate != null ? { AU: auCpiRate } : {}),
      cpiAccumulator:                   { AU: 1.0 },
      // The AU bracket-index series — see InflationAdjustReducer. Shallow-merged with
      // US_TAX's US entry and US_STATE_TAX's US_STATE entry by the compiler.
      bracketIndexSpreads:              { AU: context.parameters?.auBracketIndexSpread ?? 0 },
      bracketIndexAccumulator:          { AU: 1.0 },
      // design 107 §8 — read by `AuTaxInstalmentHandler` when it sizes a PAYG instalment.
      // In STATE, not just in `parameters`: the handler sees only live state, and a param the
      // compiler never copies across is the classic silently-inert key this repo has paid for
      // more than once.
      auGdpUplift:                      context.parameters?.auGdpUplift ?? 0.05,
      auNotionalTaxRate:                context.parameters?.auNotionalTaxRate ?? 0.25,
      auOrdinaryIncomeYTD:              0,
      auCapitalGainsYTD:                0,
      auDiscountableGainsYTD:           0,   // CGT 50%-discount-eligible slice (design 62 §4)
      // design 83 G7 step 3 — s115-115 residency apportionment of the discount
      auDiscountApportionedBaseYTD:     0,
      auDiscountAllowanceYTD:           0,
      auRealCapitalGainsYTD:            0,   // FY2027 reform: post-indexation gain (design 57)
      auNonResidentWithholdingYTD:      0,
      // Per-type non-resident final withholding (design 73 Gap 2): interest at the
      // Art 11(2) 10% cap, unfranked dividends at the Art 10(2) 15% cap.
      auNrWithholdingInterestYTD:          0,
      auNrWithholdingUnfrankedDividendYTD: 0,
      auSuperTaxYTD:                    0,
      auFrankingCreditYTD:              0,
      // design 95 §9.1 phase 6b — s290-150 personal deductible super contributions,
      // GROSS of Div 295. Deductible only in the year made (s290-150(3)), so it
      // resets with the FY.
      auDeductibleSuperYTD:             0,
      auPersonOrdinaryIncomeYTD:        {},
      auPersonCapitalGainsYTD:          {},
      auPersonDiscountableGainsYTD:     {},
      auPersonDiscountApportionedBaseYTD: {},
      auPersonDiscountAllowanceYTD:       {},
      auPersonRealCapitalGainsYTD:      {},
      auPersonNonResidentWithholdingYTD:{},
      auPersonNrWithholdingInterestYTD:          {},
      auPersonNrWithholdingUnfrankedDividendYTD: {},
      auPersonSuperTaxYTD:              {},
      auPersonDeductibleSuperYTD:       {},
      // design 95 §9.2-9.5 phase 7 — the contribution caps, one record per person:
      // { concessionalYTD, sgYTD, nonConcessionalYTD, qualifyingEarningsYTD, unusedByFy,
      //   tsbAtFyStart, bringForward }. The last three SURVIVE the financial year;
      // that is why this sits outside PER_PERSON_AU_FIELDS, whose reset loop zeroes
      // a map wholesale.
      auSuperCapsByPerson:              {},
      auPersonFrankingCreditYTD:        {},
      auPersonEarnedIncomeYTD:          {},   // FEIE cap accumulator (design 52 §4.2)
      auPersonUsSourceOrdinaryAudYTD:            {},
      auPersonUsSourceCapGainsAudYTD:            {},
      auPersonUsSourceRealCapGainsAudYTD:        {},
    };

    //Zero out some fields that we will need
    context.people.forEach(p => {
      state.auPersonOrdinaryIncomeYTD[p.id] = 0;
      state.auPersonCapitalGainsYTD[p.id] = 0;
      state.auPersonDiscountableGainsYTD[p.id] = 0;
      state.auPersonDiscountApportionedBaseYTD[p.id] = 0;
      state.auPersonDiscountAllowanceYTD[p.id]       = 0;
      state.auPersonRealCapitalGainsYTD[p.id] = 0;
      state.auPersonNonResidentWithholdingYTD[p.id] = 0;
      state.auPersonNrWithholdingInterestYTD[p.id] = 0;
      state.auPersonNrWithholdingUnfrankedDividendYTD[p.id] = 0;
      state.auPersonUsSourceOrdinaryAudYTD[p.id] = 0;
      state.auPersonUsSourceCapGainsAudYTD[p.id] = 0;
      state.auPersonUsSourceRealCapGainsAudYTD[p.id] = 0;
      state.auPersonSuperTaxYTD[p.id] = 0;
      state.auPersonDeductibleSuperYTD[p.id] = 0;
      state.auSuperCapsByPerson[p.id] = {
        concessionalYTD: 0, sgYTD: 0, nonConcessionalYTD: 0, qualifyingEarningsYTD: 0,
        unusedByFy: {}, tsbAtFyStart: 0, bringForward: null,
      };
      state.auPersonFrankingCreditYTD[p.id] = 0;
      state.auPersonEarnedIncomeYTD[p.id] = 0;
    })

    return state;
  },

  schedules(context) {
    return [..._getContributions(context).events];
  },

  handlers(context) {
    return [..._getContributions(context).handlers];
  },

  reducers(context) {
    return [
      ..._getContributions(context).reducers,
      ..._getBalanceSnapshotReducer(context),
    ];
  },
};

function _getContributions(context) {
  if (context._auTaxCapture) return context._auTaxCapture;
  // AU fiscal year starts Jul 1: include the year before simStart to cover the
  // initial period (e.g. simStart Jan 2026 → need FY2025: Jul 2025–Jun 2026).
  // Use the shared context.periodService when available so AU fiscal years are
  // merged with US calendar years in one service for journal reporting.
  const periodService = context.periodService ?? new PeriodService();
  const startYear = context.startDate.getUTCFullYear();
  const endYear   = context.endDate.getUTCFullYear();
  for (let y = startYear - 1; y <= endYear; y++) applyTo(periodService, buildAuFiscalYear(y));
  context._auTaxCapture = new TaxService().getContributions(
    ['AU'], periodService, context.startDate,
    context.accountService, context.stateRegistry, context.parameters ?? {},
  );
  return context._auTaxCapture;
}

function _getBalanceSnapshotReducer(context) {
  if (context._balanceSnapshotRegistered) return [];
  context._balanceSnapshotRegistered = true;
  const r = new BalanceSnapshotReducer('Balance Snapshot');
  r.reducedActionTypes = ['RECORD_BALANCE'];
  return [r];
}
