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
      { type: 'INTL_TRANSFER_APPLY', fields: { targetDeficit: ValueType.number() } },
      // §988 on foreign-currency CASH (design 87 phases 1–2). Declared here as well as
      // in the two real-property toolsets — registerActionType is idempotent, and both
      // conversion paths (this toolset's IntlTransferApplyReducer and the inline sweep
      // in AccountService.replenishSavings) emit it, so a scenario with cross-border
      // banking but no real property must still have the type registered or every
      // currency disposition is dropped on the floor.
      { type: 'SECTION_988_GAIN', cc: null,
        fields: { loanKey: ValueType.text(), accountKey: ValueType.text(),
                  currency: ValueType.text(), amount: ValueType.number(),
                  gross: ValueType.number(), disallowedLoss: ValueType.number(),
                  deMinimis: ValueType.number(), residency: ValueType.text() } },
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
        key: 'fxVolatility', label: 'FX Volatility (annualized)',
        type: 'Number', group: 'FX', mc: true, opt: false,
        defaultValue: 0.06,
        description: 'Annualized log-volatility of the FX rate when a process model is active.',
      },
      {
        key: 'fxReversionSpeed', label: 'FX Reversion Speed (per year)',
        type: 'Number', group: 'FX', mc: true, opt: false,
        defaultValue: 0.5,
        description: 'Mean-reversion speed toward the anchor for the MEAN_REVERTING model.',
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
