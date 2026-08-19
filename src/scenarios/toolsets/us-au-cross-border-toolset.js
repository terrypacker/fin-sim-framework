/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_ROLES }              from '../../finance/state/account-roles.js';
import { OneOffEvent }                from '../../simulation-framework/events/one-off-event.js';
import { ChangeResidencyHandler }     from '../../finance/handlers/change-residency-handler.js';
import { ChangeResidencyApplyReducer }
  from '../../finance/reducers/change-residency-apply-reducer.js';
import { IntlTransferApplyReducer, IntlTransferRecordReducer }   from '../../finance/reducers/intl-transfer-apply-reducer.js';
import { ValueType }                  from '../../simulation-framework/type-registry.js';
import { FxService }                  from '../../finance/fx/fx-service.js';
import { FxTransferToHandler }        from '../../finance/fx/fx-transfer-handler.js';
import { FxTransferApplyReducer }     from '../../finance/fx/fx-transfer-apply-reducer.js';
import { FxRefreshReducer }           from '../../finance/fx/fx-refresh-reducer.js';
import { FxTickHandler }              from '../../finance/fx/fx-tick-handler.js';
import { FxStepApplyReducer }         from '../../finance/fx/fx-step-apply-reducer.js';
import { FxProcessReducer }           from '../../finance/fx/fx-process-reducer.js';
import { FX_PROCESS_MODEL_IDS }       from '../../finance/fx/fx-process-models.js';

/**
 * Per-context FxService singleton (reused across state/handlers/reducers calls).
 * @param {object} context
 * @returns {FxService}
 */
function _getFxService(context) {
  if (!context._fxService) context._fxService = new FxService();
  return context._fxService;
}

/**
 * US_AU_CROSS_BORDER toolset — residency transition and bilateral transfer wiring.
 *
 * Capabilities: cross-border
 * Depends on: US_TAX, AU_TAX
 *
 * State ownership:
 *   Initializes: people[*].residency (overrides per-person default to startingResidency),
 *                ftcYTD (reset to 0), combined inflationRates and inflationAccumulator
 *                for both countries
 *   Reads: us* keys from US_TAX; au* keys from AU_TAX
 *
 * Typical usage: toolsets: ["US_RETIREMENT", "AU_RETIREMENT", "US_AU_CROSS_BORDER"]
 * For AU→US migrants, set startingResidency: 'AU' in parameters.
 */
export const US_AU_CROSS_BORDER = {
  id: 'US_AU_CROSS_BORDER',
  capabilities: ['cross-border'],
  dependencies: ['US_TAX', 'AU_TAX'],

  types: {
    handlers: [ChangeResidencyHandler, FxTransferToHandler, FxTickHandler],
    reducers: [ChangeResidencyApplyReducer, IntlTransferApplyReducer, IntlTransferRecordReducer, FxTransferApplyReducer, FxRefreshReducer, FxProcessReducer, FxStepApplyReducer],
    actions: [
      { type: 'CHANGE_RESIDENCY_APPLY' },
      // INTL_TRANSFER_APPLY is kept for ReplenishSavingsReducer cross-border escalation.
      // `direction` ('US_TO_AU' / 'AU_TO_US') is the whole meaning of a cross-border
      // sweep; targetDeficit alone does not say which way the money went. Declared on
      // INTL_TRANSFER_RECORD already — this is the action twin of that marker.
      { type: 'INTL_TRANSFER_APPLY', fields: { targetDeficit: ValueType.number(), direction: ValueType.text(),
        // Declared for JOURNAL visibility; the observer reads the live action, which
        // pickPayload never filters. Undeclared, a §988 conversion computes correctly and
        // is then invisible in every report that reads the journal.
        section988: ValueType.any() } },
      // §988 on foreign-currency CASH (design 87 phases 1–2). Declared here as well as
      // in the two real-property toolsets — registerActionType is idempotent, and both
      // conversion paths (this toolset's IntlTransferApplyReducer and the inline sweep
      // in AccountService.replenishSavings) emit it, so a scenario with cross-border
      // banking but no real property must still have the type registered or every
      // currency disposition is dropped on the floor.
      // Third declaration of this shared type (the two real-property toolsets carry the
      // others); registerActionType is last-writer-wins over the WHOLE entry, so all
      // three must list the same fields or a gain's visibility depends on registration
      // order. holdingId identifies the position the gain came off — see the AU
      // real-property toolset for why accountKey is not enough.
      { type: 'SECTION_988_GAIN', cc: null,
        fields: { loanKey: ValueType.text(), accountKey: ValueType.text(), holdingId: ValueType.text(),
                  currency: ValueType.text(), amount: ValueType.number(),
                  gross: ValueType.number(), disallowedLoss: ValueType.number(),
                  deMinimis: ValueType.number(), capitalGain: ValueType.number(),
                  longTerm: ValueType.any(), residency: ValueType.text() } },
      // INTL_TRANSFER_RECORD: journal-only marker for inline cross-border cash
      // sweeps in replenishSavings (design 44 Gap A / A2).
      {
        type: 'INTL_TRANSFER_RECORD',
        fields: {
          direction:  ValueType.text(),
          srcKey:     ValueType.text(),
          dstKey:     ValueType.text(),
          from:       ValueType.text(),
          to:         ValueType.text(),
          fromAmount: ValueType.number(),
          toAmount:   ValueType.number(),
          fee:        ValueType.number(),
        },
      },
      {
        type: 'FX_TRANSFER_APPLY',
        fields: {
          from:       ValueType.text(),
          to:         ValueType.text(),
          fromAmount: ValueType.number(),
          toAmount:   ValueType.number(),
          rate:       ValueType.number(),
          fee:        ValueType.currency('USD'),
          // Design 87 phase 3 — the §988 character declaration the currency lot observer
          // reads. Declared for JOURNAL visibility rather than for the mechanism: the
          // observer runs inside the reducer bracket and sees the live action, which
          // `pickPayload` never touches (it filters only the journal `data:` payload at
          // simulation.js). Undeclared, a §988 conversion would compute correctly and then
          // be invisible in every report that reads the journal.
          section988: ValueType.any(),
        },
      },
      // Time-varying FX walk step (design 47). pair id + new log-deviation.
      {
        type: 'FX_STEP_APPLY',
        fields: {
          pair:      ValueType.text(),
          deviation: ValueType.number(),
        },
      },
    ],
  },

  paramSchema(context) {
    return [
      {
        key: 'moveYear', label: 'US→AU Move Year',
        type: 'Number', group: 'Cross Border', mc: false, opt: true,
        defaultValue: undefined,
        description: 'Calendar year of US→AU migration (Jul 1). Leave unset for no move.',
      },
      {
        key: 'startingResidency', label: 'Starting Residency',
        type: 'Enum', group: 'Cross Border', mc: false, opt: true,
        options: ['US', 'AU'],
        defaultValue: null,
        description: 'Starting country of tax residency for all persons (e.g. "US", "AU"). Defaults to "US" when unset.',
      },
      {
        key: 'usFeieElected', label: 'US FEIE Elected (Form 2555)',
        type: 'Boolean', group: 'Cross Border', mc: false, opt: true,
        defaultValue: false,
        description: 'Elect the US Foreign Earned Income Exclusion on AU-source '
          + 'earned income (design 52 §4.2). Off by default; a future lever bound '
          + 'by the 5-year revocation lock.',
      },
      {
        key: 'auInflationRate', label: 'AU Inflation Rate (cross-border)',
        type: 'Number', group: 'Cross Border', mc: true, opt: true,
        defaultValue: 0.03,
        description: 'AU inflation rate when running combined US+AU scenario',
      },
      {
        key: 'exchangeRateUsdToAud', label: 'Exchange Rate USD→AUD',
        type: 'Number', group: 'Cross Border', mc: true, opt: false,
        defaultValue: 1.55,
        description: 'USD to AUD exchange rate applied on international transfers',
      },
      {
        key: 'intlTransferFeeUsd', label: 'International Transfer Fee (USD)',
        type: 'Number', group: 'Cross Border', mc: true, opt: false,
        defaultValue: 15,
        description: 'Fixed fee per international wire transfer in USD',
      },
      {
        key: 'fxProcessModel', label: 'FX Rate Process',
        type: 'Enum', group: 'FX', mc: false, opt: false,
        options: FX_PROCESS_MODEL_IDS,
        defaultValue: 'NONE',
        description: 'Time-varying FX model (design 47). NONE = flat (today). '
          + 'MEAN_REVERTING/RANDOM_WALK/WHITE_NOISE vary the rate over time via the seeded RNG.',
      },
      {
        key: 'fxBasisMethod', label: '§988 Lot Consumption Method',
        type: 'Enum', group: 'FX', mc: false, opt: false,
        options: ['pro-rata', 'fifo'],
        defaultValue: 'pro-rata',
        description: 'Reg. §1.988-2(a)(2)(iii)(B)(1) lets a taxpayer use "any reasonable method '
          + 'consistently applied … to all accounts" and names FIFO, LIFO and pro rata. Pro-rata '
          + 'is the default because it is exactly what a single fxBasisRate scalar implements. '
          + 'FIFO additionally supplies a HOLDING PERIOD, which the personal capital branch needs '
          + 'and pro-rata cannot supply — at the cost of publishing a lot array on every pool. '
          + 'The choice is locked at adoption and binds all future years (design 87 G6).',
      },
      {
        key: 'fxVolatility', label: 'FX Volatility (annualized)',
        type: 'Number', group: 'FX', mc: true, opt: false,
        defaultValue: 0.1142,
        description: 'Annualized log-volatility of the FX rate when a process model is active. '
          + 'Default is calibrated from the published USD/AUD series over the post-float window '
          + '1984-01 onward (design 92 §8.1), not assumed — reproduce it with '
          + 'scripts/lab/calibrate-fx.mjs. The whole series and the post-2000 era give 0.111 and '
          + '0.120, so this is not sensitive to the window; the original 0.06 default was.',
      },
      {
        key: 'fxReversionSpeed', label: 'FX Reversion Speed (per year)',
        type: 'Number', group: 'FX', mc: true, opt: false,
        defaultValue: 0.114,
        description: 'Mean-reversion speed toward the anchor for the MEAN_REVERTING model — '
          + 'a half-life of about 6.1 years. Fitted to the observed TERM STRUCTURE of FX '
          + 'dispersion over the post-float window, not to the lag-1 autocorrelation: the lag-1 '
          + 'AR(1) estimate on the same data is 0.296, which reproduces 1-year moves and then '
          + 'flattens, understating 10-year dispersion by a third. Still the more '
          + 'window-sensitive of the two knobs (whole series 0.072, post-2000 0.104), so it is '
          + 'worth running as a sensitivity axis rather than trusted as a constant.',
      },
    ];
  },

  state(context) {
    const p = context.parameters;
    const startingResidency = p.startingResidency ?? 'US';

    // Build a full people map from PersonService so we can override residency.
    // context.state does not exist in the compiler — context.people is the source of truth.
    // Because _mergeStatePatches does a shallow (key-level) merge for 'people', we must
    // emit the complete person entries here; a partial { residency } object would discard
    // fields set by US_RETIREMENT / AU_RETIREMENT.
    const people = {};
    for (const person of context.people) {
      people[person.id] = {
        id:                    person.id,
        name:                  person.name,
        birthDate:             person.birthDate,
        monthlyWage:           person.monthlyWage           ?? 0,
        // Self-employment flag (design 69) — routes monthlyWage through the SE path.
        selfEmployed:          person.selfEmployed          ?? false,
        // Native currency of the wage (design 50) — drives MonthlyWagesHandler's
        // US vs AU routing. MUST be projected here or every wage reads as USD.
        wageCurrency:          person.wageCurrency          ?? 'USD',
        // Where the employment is exercised (design 73 Gap 1) — the attribute that
        // actually determines the source of employment income. null ⇒ the earner
        // works where they live, resolved per accrual so it tracks a mid-sim move.
        workCountry:           person.workCountry           ?? null,
        retirementDate:        person.retirementDate        ?? null,
        socialSecurityMonthly: person.socialSecurityMonthly ?? 0,
        lifeExpectancy:        person.lifeExpectancy        ?? 90,
        citizen:               person.citizen               ?? ['US'],
        residency:             startingResidency,
        residencyState:        person.residencyState         ?? null,  // US state of residency (design 34)
        incomeSupportRecipient: person.incomeSupportRecipient ?? false, // AU CGT 30% min-tax exemption (design 57 §6.6)
      };
    }

    // FX state patches: initialise base and effective rate/fee maps plus legacy flat fields.
    const fxPatches = _getFxService(context)
      .getContributions(['USD', 'AUD'], context.accountService, context.stateRegistry, p)
      .statePatches;

    const patches = {
      usFeieElected:        p.usFeieElected ?? false,
      inflationRates:       {
        US: p.inflationRate    ?? 0.03,
        AU: p.auInflationRate  ?? 0.03,
      },
      inflationAccumulator: { US: 1.0, AU: 1.0 },
      // Design 87 G6 — which of `§1.988-2(a)(2)(iii)(B)(1)`'s named methods the currency
      // lot ledger consumes by. Projected into STATE rather than read from the parameter
      // bag at the observer, because `base-scenario` builds the observer from the resolved
      // initial state and never sees the params; and because a saved scenario must carry
      // the choice with it — the regulation locks the method at adoption and binds every
      // later year, so a run that silently reverted to the default would be filing a
      // different method than the taxpayer elected.
      fxBasisMethod:        p.fxBasisMethod ?? 'pro-rata',
      ...fxPatches,
    };

    if (Object.keys(people).length > 0) patches.people = people;
    return patches;
  },

  schedules(context) {
    const events = [];

    // FX tick series (design 47) — present only when a stochastic FX model is
    // selected. getContributions returns the pre-built EventSeries.
    events.push(...(
      _getFxService(context)
        .getContributions(['USD', 'AUD'], context.accountService, context.stateRegistry, context.parameters)
        .events
    ));

    const moveYear = context.parameters.moveYear;
    if (moveYear) {
      // CHANGE_RESIDENCY fires on Jul 1 of moveYear (matches IntlRetirementScenario)
      const moveDate = new Date(Date.UTC(moveYear, 6, 1));
      events.push(new OneOffEvent({
        name:    'Change Residency',
        type:    'CHANGE_RESIDENCY',
        date:    moveDate,
        data:    {},
        enabled: true,
        color:   '#FF5722',
      }));
    }

    return events;
  },

  handlers(context) {
    const p        = context.parameters;
    const accounts = context.accounts;
    const people   = context.people;
    const sr       = context.stateRegistry;

    const usSavAccts = accounts.filter(a => a.role === ACCOUNT_ROLES.US_SAVINGS);
    const auSavAccts = accounts.filter(a => a.role === ACCOUNT_ROLES.AU_SAVINGS);
    const primaryId  = usSavAccts[0]?.ownerId ?? auSavAccts[0]?.ownerId
                     ?? (people[0]?.id ?? null);
    const handlers = [];

    if (usSavAccts.length > 0 && auSavAccts.length > 0) {
      // Register settlement accounts on the FxService so FxTransferToHandler
      // can resolve source/destination keys from the currency code alone.
      const fx = _getFxService(context);
      fx.registerSettlement('USD', sr.getStateKey(ACCOUNT_ROLES.US_SAVINGS, primaryId));
      fx.registerSettlement('AUD', sr.getStateKey(ACCOUNT_ROLES.AU_SAVINGS, primaryId));

      // Direction-agnostic FX_TRANSFER handler.
      const fxHandlers = fx.getContributions(
        ['USD', 'AUD'], context.accountService, sr, p,
      ).handlers;
      handlers.push(...fxHandlers);
    }

    // Residency change handler
    if (p.moveYear) {
      const changeResEvent = context.schedulesById['CHANGE_RESIDENCY'];
      const changeResHandler = new ChangeResidencyHandler();
      if (changeResEvent) changeResHandler.handledEvents.push(changeResEvent);
      handlers.push(changeResHandler);
    }

    return handlers;
  },

  reducers(context) {
    const accountSvc = context.accountService;
    const sr         = context.stateRegistry;

    // FX reducers from FxService (FxRefreshReducer + FxTransferApplyReducer).
    const fxReducers = _getFxService(context)
      .getContributions(['USD', 'AUD'], accountSvc, sr, context.parameters)
      .reducers;

    return [
      new ChangeResidencyApplyReducer({ accountService: accountSvc, stateRegistry: sr, collectibleService: context.collectibleService, realPropertyService: context.realPropertyService, companyEquityService: context.companyEquityService }),
      new IntlTransferApplyReducer({ accountService: accountSvc, stateRegistry: sr }),
      new IntlTransferRecordReducer(),
      ...fxReducers,
    ];
  },
};
