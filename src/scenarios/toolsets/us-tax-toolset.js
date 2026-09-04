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
import { buildUsCalendarYear, applyTo }
  from '../../finance/period/period-builder.js';
import { UsPeriodAdvanceHandler, UsPeriodAdvanceReducer }
  from '../../finance/tax/period-advance-classes.js';
import { UsTaxFileHandler, UsTaxFileApplyReducer } from '../../finance/tax/us/tax-file-classes.js';
import { UsTaxSettleHandler, UsTaxSettleApplyReducer, UsTaxPaymentDebitReducer }
  from '../../finance/tax/tax-settle-classes.js';
import { ValueType } from '../../simulation-framework/type-registry.js';

/**
 * US_TAX toolset — declarative shell around TaxService.
 *
 * Capabilities: taxation
 * Depends on: US_BANKING
 *
 * State ownership:
 *   Initializes: currentPeriods (via TaxService), usOrdinaryIncomeYTD,
 *                usNegativeIncomeYTD, usCapitalGainsYTD, usPenaltyYTD,
 *                usFilingSingle
 *   Reads: (none from other toolsets)
 */
export const US_TAX = {
  id: 'US_TAX',
  capabilities: ['taxation'],
  dependencies: ['US_BANKING'],

  types: {
    handlers: [UsPeriodAdvanceHandler, UsTaxSettleHandler, UsTaxFileHandler],
    reducers: [UsPeriodAdvanceReducer, UsTaxSettleApplyReducer, UsTaxPaymentDebitReducer, BalanceSnapshotReducer, UsTaxFileApplyReducer],
    actions: [
      { type: 'US_PERIOD_ADVANCE',  fields: { period: ValueType.any() } },
      { type: 'US_TAX_SETTLE_APPLY', family: 'TAX_SETTLE_APPLY', cc: 'US',
        // fxRate — USD/AUD in force at the settle, reported on the return
        // (design 71 §5.5). Must be declared: pickPayload keeps ONLY declared
        // fields, so an undeclared field never reaches the document modules.
        // usTaxPaidOnUsSourceAud — the AUD restatement of the US tax attributable to
        // US-source income (design 83 G5), the number AU credits as a FITO. It is a
        // treaty INPUT computed on the US settle and consumed a fiscal year later by
        // the AU settle; undeclared, an FTC/FITO reconciliation could not be drilled
        // from the journal even though the run used it. AUD, deliberately: it is
        // already converted at the settle-date rate, and the declaration keeps
        // report-currency normalisation from re-reading it as USD.
        fields: { withheld: ValueType.currency('USD'), tax: ValueType.number(), taxDetail: ValueType.any(), fxRate: ValueType.number(),
                  usTaxPaidOnUsSourceAud: ValueType.currency('AUD') } },
      // design 94 §8.1l — the April filing of the PRIOR year's return. `delta` is the balance
      // due on the amendment; `disallowed` is the §1091 loss that caused it. Declared because
      // pickPayload keeps only declared fields, and a tax correction nobody can drill from the
      // journal is the shape this repo has been bitten by.
      // `basisAdjustments` — §8.1p's §1091(d) transfers: which lot each disallowed dollar was
      // moved INTO, and the §1223(3) date it was tacked to. Undeclared it was dropped from
      // the journal while still being applied to state, which is the worst of both: the
      // deferral happened and nothing could be drilled to show where it went.
      { type: 'US_TAX_FILE_APPLY', cc: 'US',
        fields: { taxYear: ValueType.number(), delta: ValueType.currency('USD'),
                  disallowed: ValueType.currency('USD'), ledger: ValueType.any(),
                  remaining: ValueType.any(), capitalLoss: ValueType.any(),
                  basisAdjustments: ValueType.any() } },
      { type: 'US_TAX_PAYMENT_DEBIT', family: 'TAX_PAYMENT_DEBIT', cc: 'US',
        // `escalated` — see AU_TAX_PAYMENT_DEBIT: the cross-border re-issue of the
        // unfunded part of this same bill. Declared so "Tax Paid by Year" can
        // exclude it; pickPayload would otherwise drop it and the filter would
        // silently pass everything.
        // `section988` — see AU_TAX_PAYMENT_DEBIT. Inert on this action as long as the US
        // savings pool is USD (the taxpayer's functional currency is never §988 property),
        // and declared anyway so the shared base's stamp stays visible if it is not.
        fields: { amount: ValueType.currency('USD'), escalated: ValueType.boolean(),
                  section988: ValueType.any() } },
      { type: 'RECORD_BALANCE',    fields: { fieldPath: ValueType.text(), metricKey: ValueType.text() } },
    ],
  },

  paramSchema(context) {
    return [
      {
        key: 'usFilingSingle', label: 'Filing Single',
        type: 'Boolean', group: 'US Tax', mc: false, opt: true,
        defaultValue: undefined,
        description: 'Override filing status auto-detection (true = single, false = MFJ)',
      },
      {
        // Past the newest published table this model has to ASSUME how the brackets
        // move. §1(f) does index them (to C-CPI-U), so 0 — plain CPI — is the
        // faithful default here, unlike the AU and state series where indexation is
        // not law at all. The spread exists because C-CPI-U is not household
        // inflation and because a bracket freeze is a live policy scenario: set it
        // to −(inflation rate) to model one.
        //
        // `opt: false` deliberately. This is uncertainty about future POLICY, not a
        // lever the household pulls; an optimizer free to choose it would "solve"
        // any plan by legislating generous brackets.
        key: 'usFederalBracketIndexSpread', label: 'US Federal Bracket Indexation Spread',
        type: 'Number', group: 'US Tax', mc: true, opt: false,
        defaultValue: 0,
        description: 'Annual rate at which US FEDERAL tax brackets, the standard deduction, '
          + 'the FICA wage base and the FEIE cap are projected to rise past the newest '
          + 'published table, expressed as a spread ADDED TO inflation (0 = track CPI, '
          + '-0.03 against 3% inflation = frozen brackets). Published years are always used '
          + 'as legislated. Does NOT move the FICA wage base or the FEIE cap — those have '
          + 'their own spreads.',
      },
      {
        // Its own series because §230 SSA indexes the base to the national AVERAGE
        // WAGE INDEX, not to prices — historically CPI plus roughly the economy's real
        // wage growth. 0 is the conservative default (no invented constant, and every
        // existing run stays byte-identical); a run wanting fidelity sets ~+0.005.
        // This drives BOTH the annual FICA charge and the monthly payroll withholding;
        // see computePayroll, where the two must agree or the gap becomes a phantom
        // balance due. `opt: false` — see usFederalBracketIndexSpread.
        key: 'usFicaWageBaseIndexSpread', label: 'US FICA Wage Base Indexation Spread',
        type: 'Number', group: 'US Tax', mc: true, opt: false,
        defaultValue: 0,
        description: 'Annual rate at which the Social Security contribution and benefit base '
          + '(\u00a73121(a)(1)) is projected to rise past the last SSA announcement, as a spread '
          + 'ADDED TO inflation. The real base tracks the SSA average wage index, which runs '
          + 'above CPI, so a positive spread (~0.005) is more faithful than 0.',
      },
      {
        // Same chained CPI as the brackets in law, but a separate act of Congress:
        // modelling a bracket freeze must not silently freeze the FEIE cap too.
        // `opt: false` — see usFederalBracketIndexSpread.
        key: 'usFeieCapIndexSpread', label: 'US FEIE Cap Indexation Spread',
        type: 'Number', group: 'US Tax', mc: true, opt: false,
        defaultValue: 0,
        description: 'Annual rate at which the \u00a7911 foreign earned income exclusion cap is '
          + 'projected to rise past the newest published table, as a spread ADDED TO inflation '
          + '(0 = track CPI, matching how \u00a7911(b)(2)(D)(ii) indexes it today).',
      },
    ];
  },

  state(context) {
    const capture = _getContributions(context);
    const filingSingle = context.parameters.usFilingSingle !== undefined
      ? Boolean(context.parameters.usFilingSingle)
      : context.people.length <= 1;
    return {
      ...capture.statePatches,
      // Tax-bracket projection series (see InflationAdjustReducer). Seeded here for
      // the federal series and in US_STATE_TAX / AU_TAX for theirs; the compiler
      // shallow-merges all three so each toolset contributes only its own key.
      bracketIndexSpreads: {
        US:       context.parameters.usFederalBracketIndexSpread ?? 0,
        US_FICA:  context.parameters.usFicaWageBaseIndexSpread   ?? 0,
        US_FEIE:  context.parameters.usFeieCapIndexSpread        ?? 0,
      },
      bracketIndexAccumulator: { US: 1.0, US_FICA: 1.0, US_FEIE: 1.0 },
      usOrdinaryIncomeYTD: 0,
      usNegativeIncomeYTD: 0,
      usCapitalGainsYTD:   0,
      usPenaltyYTD:        0,
      // Self-employment tax (SECA) accumulators — design 69. Net SE earnings and
      // SS-covered wages (the latter fills the SS wage base ahead of SE income).
      usSeEarningsYTD:     0,
      usSsWagesYTD:        0,
      usFilingSingle:      filingSingle,
      // Does anyone here file a US return at all? A US citizen (wherever resident)
      // or a US resident does. Stamped once, from the configured persons, so a death
      // mid-run cannot change the answer — see UsTaxSettleHandler for why that matters
      // and for the limitation this gate carries.
      usPersonHousehold:   context.people.some(
        pe => (pe.citizen ?? ['US']).includes('US') || (pe.residency ?? 'US') === 'US'),
      // The CONFIGURED filing status, which nothing but a config edit changes.
      // `usFilingSingle` above is the *effective* status for the current tax year,
      // and UsPeriodAdvanceReducer recomputes it every 1 Jan from the death rule
      // (a survivor files single from the following year). Before this field
      // existed that recomputation had nothing to fall back on, so it re-derived
      // the status as `deceased is non-empty` alone — silently flipping a genuinely
      // single filer to MFJ brackets, standard deduction, NIIT and §121 thresholds
      // from the second tax year of every single-person scenario onward.
      usFilingSingleBase:  filingSingle,
      // Cross-border relief accumulators (design 52) — initialised so the runtime
      // state (and the journal state-diff) always carries them, matching
      // IntlRetirementState. §904 numerators + FITO removal set + carryforward pools.
      foreignGeneralIncomeYTD: 0,
      foreignPassiveIncomeYTD: 0,
      usSourceOrdinaryUsdYTD:  0,
      usSourceCapGainsUsdYTD:  0,
      usSourceOrdinaryAudYTD:  0,
      usSourceCapGainsAudYTD:  0,
      // US-source *real* (indexed) AU cap gain (AUD) — funds the FY2027 FITO
      // "without" pass's CG slice (design 57 Part 2, Item D).
      usSourceRealCapGainsAudYTD: 0,
      // Design 83 G3 — US-source income re-sourced to foreign by Art. 27(1)(c),
      // split by the §904 category it lands in. Kept apart from foreign*IncomeYTD
      // so the FITO counterfactual can remove it from the baskets (design 83 G8).
      auCgtEffectiveRate:      null,
      usSourceDividendsUsdYTD: 0,
      usSourceInterestUsdYTD:  0,
      usSourceGeneralUsdYTD:   0,
      usSourcePassiveUsdYTD:   0,
      // Design 52 §4.4 — the AU liability staged for the next US settle, unapportioned;
      // the US settle splits it across the baskets on full-year basket income.
      ftcCurrentForeignTax:    0,
      // Pre-split per-basket staging. Legacy: nothing writes these now, but a saved
      // state can carry them and `_computeFtc` still reads them.
      ftcCurrentGeneral:       0,
      ftcCurrentPassive:       0,
      // Design 72 §1 — treaty re-sourced basket (Form 1116 category F).
      ftcCurrentResourced:     0,
      ftcPoolGeneral:          {},
      ftcPoolPassive:          {},
      ftcPoolResourced:        {},
      usTaxPaidOnUsSourceAud:  0,
    };
  },

  schedules(context) {
    return _getContributions(context).events;
  },

  handlers(context) {
    return _getContributions(context).handlers;
  },

  reducers(context) {
    return [..._getContributions(context).reducers, ..._getBalanceSnapshotReducer(context)];
  },
};

function _getContributions(context) {
  if (context._usTaxCapture) return context._usTaxCapture;
  // Use the shared context.periodService when available (ScenarioCompiler injects
  // one so US + AU periods end up in a single service for journal reporting).
  const periodService = context.periodService ?? new PeriodService();
  const startYear = context.startDate.getUTCFullYear();
  const endYear   = context.endDate.getUTCFullYear();
  for (let y = startYear; y <= endYear; y++) applyTo(periodService, buildUsCalendarYear(y));
  context._usTaxCapture = new TaxService().getContributions(
    ['US'], periodService, context.startDate,
    context.accountService, context.stateRegistry,
  );
  return context._usTaxCapture;
}

function _getBalanceSnapshotReducer(context) {
  if (context._balanceSnapshotRegistered) return [];
  context._balanceSnapshotRegistered = true;
  const r = new BalanceSnapshotReducer('Balance Snapshot');
  r.reducedActionTypes = ['RECORD_BALANCE'];
  return [r];
}
