/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */



import { ActionDefinition }     from '../simulation-framework/actions.js';
import { ACCOUNT_ROLES }        from '../finance/state/account-roles.js';
import { Person }               from '../finance/person.js';
import { Account, CheckingAccount, SavingsAccount } from '../finance/assets/account.js';
import {
  InvestmentAccount, BrokerageAccount, FourOhOneKAccount,
  RothAccount, TraditionalIRAAccount, SuperannuationAccount,
} from '../finance/assets/investment-account.js';
import { RealProperty }  from '../finance/assets/real-property.js';
import { Collectible }   from '../finance/assets/collectible.js';

// ─── Lookup sets for fast-path constructor dispatch ───────────────────────────

/**
 * Account-module reducers all take a single `{ accountService }` argument.
 * Registering a new reducer class only requires adding its name here.
 */
const _ACCOUNT_SERVICE_REDUCERS = new Set([
  // US — Roth IRA
  'RothContributionApplyReducer', 'RothWithdrawalContribApplyReducer',
  'RothWithdrawalEarningsApplyReducer', 'RothEarningsApplyReducer',
  // US — Traditional IRA
  'IraContributionApplyReducer', 'IraWithdrawalContribApplyReducer',
  'IraWithdrawalEarningsApplyReducer', 'IraEarningsApplyReducer',
  // US — 401k
  'K401ContributionApplyReducer', 'K401EarningsApplyReducer', 'K401WithdrawalApplyReducer',
  // US — Brokerage (Fixed Income + Stock)
  'FixedIncomeContributionApplyReducer', 'FixedIncomeWithdrawalApplyReducer',
  'FixedIncomeEarningsApplyReducer',
  'StockContributionApplyReducer', 'StockDividendApplyReducer',
  'StockEarningsApplyReducer', 'StockWithdrawalApplyReducer',
  // US — Real Property
  'UsHouseSaleApplyReducer',
  // US — Income
  'SsIncomeApplyReducer', 'WagesIncomeApplyReducer', 'WagesWithheldApplyReducer',
  'SeIncomeUsApplyReducer', 'BonusApplyReducer', 'CompanySaleApplyReducer',
  // US — Collectibles
  'CollectibleSaleApplyReducer', 'CollectibleValueChangeApplyReducer',
  // US — IRA Rollover + RMD
  'IraRolloverWithdrawalApplyReducer', 'IraRmdApplyReducer',
  // US — Roth Rollover
  'RothRolloverContributionApplyReducer', 'RothRolloverEarningsApplyReducer',
  'RothRolloverWithdrawalContribApplyReducer', 'RothRolloverWithdrawalEarningsApplyReducer',
  // US — Roth Conversion
  'RothConversionApplyReducer',
  // AU — Savings
  'AuSavingsContributionApplyReducer', 'AuSavingsWithdrawalApplyReducer',
  'AuSavingsEarningsApplyReducer',
  // AU — Superannuation
  'SuperContributionApplyReducer', 'SuperWithdrawalContribApplyReducer',
  'SuperWithdrawalEarningsApplyReducer', 'SuperEarningsApplyReducer',
  // AU — Brokerage
  'AuDividendFrankedResidentApplyReducer', 'AuDividendFrankedNonResidentApplyReducer',
  'AuDividendUnfrankedResidentApplyReducer', 'AuDividendUnfrankedNonResidentApplyReducer',
  'AuStockEarningsApplyReducer', 'AuStockWithdrawalApplyReducer',
  // AU — Real Property
  'AuHouseSaleApplyReducer',
  // AU — Income
  'AuSeIncomeApplyReducer',
]);

/**
 * Account-module and tax-infrastructure handlers that take no constructor arguments.
 * Registering a new handler class only requires adding its name here.
 */
const _NO_ARG_HANDLERS = new Set([
  // Tax infrastructure
  'PeriodAdvanceHandler', 'TaxSettleHandler',
  // US — Roth IRA
  'RothContributionHandler', 'RothWithdrawalContributionsHandler',
  'RothWithdrawalEarningsHandler', 'RothEarningsHandler',
  // US — Traditional IRA
  'IraContributionHandler', 'IraWithdrawalContributionsHandler',
  'IraWithdrawalEarningsHandler', 'IraEarningsHandler',
  // US — 401k
  'K401ContributionHandler', 'K401EarningsHandler', 'K401WithdrawalHandler',
  // US — Brokerage
  'FixedIncomeContributionHandler', 'FixedIncomeWithdrawalHandler', 'FixedIncomeEarningsHandler',
  'StockContributionHandler', 'StockDividendHandler', 'StockEarningsHandler', 'StockWithdrawalHandler',
  // US — Real Property
  'UsHouseSaleHandler',
  // US — Income
  'SsIncomeHandler', 'WagesIncomeHandler', 'WagesWithheldHandler',
  'SeIncomeUsHandler', 'BonusHandler', 'CompanySaleHandler',
  // US — Collectibles
  'CollectibleSaleHandler', 'CollectibleValueChangeHandler',
  // US — IRA Rollover + RMD
  'IraRolloverWithdrawalHandler', 'IraRmdHandler',
  // US — Roth Rollover
  'RothRolloverContributionHandler', 'RothRolloverEarningsHandler',
  'RothRolloverWithdrawalContributionsHandler', 'RothRolloverWithdrawalEarningsHandler',
  // US — Roth Conversion
  'RothConversionHandler', 'RothConversionPolicyHandler',
  // AU — Savings
  'AuSavingsContributionHandler', 'AuSavingsWithdrawalHandler', 'AuSavingsEarningsHandler',
  // AU — Superannuation
  'SuperContributionHandler', 'SuperWithdrawalContributionsHandler',
  'SuperWithdrawalEarningsHandler', 'SuperEarningsDirectHandler',
  // AU — Brokerage
  'AuDividendFrankedResidentHandler', 'AuDividendFrankedNonResidentHandler',
  'AuDividendUnfrankedResidentHandler', 'AuDividendUnfrankedNonResidentHandler',
  'AuStockEarningsHandler', 'AuStockWithdrawalHandler',
  // AU — Real Property
  'AuHouseSaleHandler',
  // AU — Income
  'AuSeIncomeHandler',
]);

export class ScenarioSerializer {

  /**
   * Serialize the current scenario state into a config object.
   *
   * Reads directly from the service maps so that in-flight UI edits (name,
   * type, field values) are captured without relying on the ConfigGraph's
   * internal node structure.
   *
   * @param {{ eventService, handlerService, actionService, reducerService, personService }} services
   *   The ServiceRegistry instance (or any object exposing the service properties).
   *   Pass `ServiceRegistry.getInstance()` from the save handler.
   * @param {string} id
   * @param {string} name
   * @param {number} order
   * @param {boolean} active
   * @param {string|Date} simStart
   * @param {string|Date} simEnd
   * @param {object} initialState
   * @param {Array}  params
   * @returns {object} serialized scenario config
   */
  static serialize(services, id, name, order, active, simStart, simEnd, initialState, params) {
    const { eventService, handlerService, actionService, reducerService, personService, accountService } = services;

    const toDateStr = (d) => {
      if (!d) return null;
      if (d instanceof Date) return d.toISOString().slice(0, 10);
      return String(d).slice(0, 10);
    };

    const { realPropertyService, collectibleService } = services;
    return {
      id,
      name,
      order,
      active: active,
      prebuilt: false,
      simStart: toDateStr(simStart),
      simEnd:   toDateStr(simEnd),
      persons:        (personService?.getAll()          ?? []).map(n => ScenarioSerializer._serializePerson(n)),
      accounts:       (accountService?.getAll()         ?? []).map(n => ScenarioSerializer._serializeAccount(n)),
      realProperties: (realPropertyService?.getAll()    ?? []).map(n => ScenarioSerializer._serializeRealProperty(n)),
      collectibles:   (collectibleService?.getAll()     ?? []).map(n => ScenarioSerializer._serializeCollectible(n)),
      events:   eventService.getAll().map(n => ScenarioSerializer._serializeEvent(n)),
      handlers: handlerService.getAll().map(n => ScenarioSerializer._serializeHandler(n)),
      actions:  actionService.getAll().map(n => ScenarioSerializer._serializeAction(n)),
      reducers: reducerService.getAll().map(n => ScenarioSerializer._serializeReducer(n)),
      initialState: initialState ? structuredClone(initialState) : {},
      params:   params ?? [],
    };
  }

  /**
   * Reconstruct scenario nodes from a saved config and register them with the
   * services.  Call this after scenario.buildSim() so the simulation exists.
   *
   * Each service.register() call publishes a CREATE event on the shared bus,
   * which is picked up by:
   *   - BaseScenario's subscriber → wires the item into the simulation
   *   - ConfigBuilder's subscriber → adds the node to the graph
   *
   * Items are registered in dependency order so that references are already
   * in the service maps when CREATE fires:
   *   persons → actions → events → handlers → reducers
   *
   * @param {object} config - serialized scenario config
   * @param {{ eventService, handlerService, actionService, reducerService, personService }} services
   *   Pass ServiceRegistry.getInstance() or any object exposing the service properties.
   */

  /**
   * Load only the persons and accounts from a config into the services.
   * Used by the toolset path in BaseApp when a custom JSON has persons/accounts
   * but no serialized events/handlers/actions/reducers.
   *
   * @param {object} config   - serialized scenario config (only persons/accounts are read)
   * @param {object} services - ServiceRegistry instance
   */
  static deserializePersonsAccounts(config, services) {
    const { personService, accountService, realPropertyService, collectibleService } = services;
    if (personService) {
      for (const d of (config.persons ?? [])) {
        const person = ScenarioSerializer._makePerson(d);
        personService.register(person);
      }
    }
    if (accountService) {
      for (const d of (config.accounts ?? [])) {
        const account = ScenarioSerializer._makeAccount(d);
        accountService.register(account);
      }
    }
    if (realPropertyService) {
      for (const d of (config.realProperties ?? [])) {
        const prop = ScenarioSerializer._makeRealProperty(d);
        realPropertyService.createProperty(prop);
      }
    }
    if (collectibleService) {
      for (const d of (config.collectibles ?? [])) {
        const col = ScenarioSerializer._makeCollectible(d);
        collectibleService.createCollectible(col);
      }
    }
  }

  static deserialize(config, services) {
    const { eventService, handlerService, actionService, reducerService } = services;

    // 0. Persons + accounts — delegate to the dedicated helper.
    ScenarioSerializer.deserializePersonsAccounts(config, services);

    // 1. Actions first — handlers and reducers hold references to them.
    const actionMap = new Map();
    for (const d of (config.actions ?? [])) {
      const action = ScenarioSerializer._makeAction(d);
      actionService.register(action);   // publishes CREATE → graph node added
      actionMap.set(d.id, action);
    }

    // 2. Events
    const eventMap = new Map();
    for (const d of (config.events ?? [])) {
      const event = ScenarioSerializer._makeEvent(d);
      eventService.register(event);     // publishes CREATE → sim schedules (if enabled) + graph node added
      eventMap.set(d.id, event);
    }

    // 3. Handlers — resolve references before registering so the CREATE
    //    subscriber sees the fully-wired handler.
    for (const d of (config.handlers ?? [])) {
      const handler = ScenarioSerializer._makeHandler(d, services);
      for (const eid of (d.handledEventIds ?? [])) {
        const ev = eventMap.get(eid);
        if (ev) handler.handledEvents.push(ev);
      }
      handler.generatedActionTypes = [...(d.generatedActionTypes ?? [])];
      for (const defData of (d.generatedActionDefinitions ?? [])) {
        handler.generatedActionDefinitions.push(new ActionDefinition(defData));
      }
      handlerService.register(handler); // publishes CREATE → sim registers handlers + graph node added
    }

    // 4. Reducers — resolve references before registering.
    for (const d of (config.reducers ?? [])) {
      const reducer = ScenarioSerializer._makeReducer(d, services);
      reducer.id = d.id;
      reducer.reducedActionTypes   = [...(d.reducedActionTypes ?? [])];
      reducer.generatedActionTypes = [...(d.generatedActionTypes ?? [])];
      for (const defData of (d.generatedActionDefinitions ?? [])) {
        reducer.generatedActionDefinitions.push(new ActionDefinition(defData));
      }
      reducerService.register(reducer); // publishes CREATE → sim wires reducers + graph node added
    }
  }

  // ─── Serializers ──────────────────────────────────────────────────────────────

  static _serializeAccount(account) {
    // Determine __type from type discriminator or class name
    const typeToClass = {
      'checking': 'CheckingAccount',
      'savings':  'SavingsAccount',
      'brokerage':'BrokerageAccount',
      '401k':     'FourOhOneKAccount',
      'roth':     'RothAccount',
      'ira':      'TraditionalIRAAccount',
      'super':    'SuperannuationAccount',
    };
    const __type = typeToClass[account.type] ?? account.constructor?.name ?? 'Account';
    const d = {
      __type,
      id:               account.id,
      name:             account.name             ?? '',
      type:             account.type             ?? null,
      role:             account.role             ?? null,
      stateKey:         account.stateKey         ?? null,
      initialValue:     account.balance,
      ownershipType:    account.ownershipType    ?? 'sole',
      ownerId:          account.ownerId          ?? null,
      minimumBalance:   account.minimumBalance   ?? 0,
      drawdownPriority: account.drawdownPriority ?? null,
      country:          account.country          ?? null,
      currency:         account.currency         ?? null,
    };
    // InvestmentAccount-specific fields
    if ('contributionBasis' in account) {
      d.contributionBasis        = account.contributionBasis;
      d.earningsBasis            = account.earningsBasis            ?? 0;
      d.loanBalance              = account.loanBalance              ?? 0;
      d.minimumAge               = account.minimumAge               ?? null;
      d.balanceAtResidencyChange = account.balanceAtResidencyChange ?? null;
    }
    return d;
  }

  static _serializeRealProperty(p) {
    return {
      __type:               'RealProperty',
      id:                   p.id,
      name:                 p.name                 ?? '',
      value:                p.value                ?? 0,
      costBasis:            p.costBasis            ?? 0,
      mortgageBalance:      p.mortgageBalance      ?? 0,
      monthlyMortgage:      p.monthlyMortgage      ?? 0,
      appreciationRate:     p.appreciationRate     ?? 0.035,
      isPrimaryResidence:   p.isPrimaryResidence   ?? false,
      plannedSaleYear:      p.plannedSaleYear      ?? null,
      saleDestinationAccount: p.saleDestinationAccount ?? null,
      ownershipType:        p.ownershipType        ?? 'sole',
      ownerId:              p.ownerId              ?? null,
      drawdownPriority:     p.drawdownPriority     ?? null,
      owners:               p.owners               ?? [],
      country:              p.country              ?? 'US',
      stateKey:             p.stateKey             ?? null,
    };
  }

  static _makeRealProperty(d) {
    const prop = new RealProperty(d.value ?? 0, {
      id:                  d.id,
      name:                d.name                ?? '',
      costBasis:           d.costBasis           ?? 0,
      mortgageBalance:     d.mortgageBalance     ?? 0,
      monthlyMortgage:     d.monthlyMortgage     ?? 0,
      appreciationRate:    d.appreciationRate    ?? 0.035,
      isPrimaryResidence:  d.isPrimaryResidence  ?? false,
      plannedSaleYear:     d.plannedSaleYear     ?? null,
      saleDestinationAccount: d.saleDestinationAccount ?? null,
      ownershipType:       d.ownershipType       ?? 'sole',
      ownerId:             d.ownerId             ?? null,
      drawdownPriority:    d.drawdownPriority    ?? null,
      owners:              d.owners              ?? [],
      country:             d.country             ?? 'US',
    });
    if (d.stateKey) prop.stateKey = d.stateKey;
    return prop;
  }

  static _serializeCollectible(c) {
    return {
      __type:               'Collectible',
      id:                   c.id,
      name:                 c.name                 ?? '',
      value:                c.value                ?? 0,
      costBasis:            c.costBasis            ?? 0,
      appreciationRate:     c.appreciationRate     ?? 0.035,
      plannedSaleYear:      c.plannedSaleYear      ?? null,
      saleDestinationAccount: c.saleDestinationAccount ?? null,
      ownershipType:        c.ownershipType        ?? 'sole',
      ownerId:              c.ownerId              ?? null,
      drawdownPriority:     c.drawdownPriority     ?? null,
      owners:               c.owners               ?? [],
      country:              c.country              ?? 'US',
      stateKey:             c.stateKey             ?? null,
    };
  }

  static _makeCollectible(d) {
    const col = new Collectible(d.value ?? 0, {
      id:                  d.id,
      name:                d.name                ?? '',
      costBasis:           d.costBasis           ?? 0,
      appreciationRate:    d.appreciationRate    ?? 0.035,
      plannedSaleYear:     d.plannedSaleYear     ?? null,
      saleDestinationAccount: d.saleDestinationAccount ?? null,
      ownershipType:       d.ownershipType       ?? 'sole',
      ownerId:             d.ownerId             ?? null,
      drawdownPriority:    d.drawdownPriority    ?? null,
      owners:              d.owners              ?? [],
      country:             d.country             ?? 'US',
    });
    if (d.stateKey) col.stateKey = d.stateKey;
    return col;
  }

  static _serializePerson(person) {
    return {
      __type:                'Person',
      id:                    person.id,
      name:                  person.name,
      birthDate:             person.birthDate instanceof Date
                               ? person.birthDate.toISOString().slice(0, 10)
                               : person.birthDate,
      citizen:               person.citizen ?? ['US'],
      lifeExpectancy:        person.lifeExpectancy ?? 90,
      socialSecurityMonthly: person.socialSecurityMonthly ?? 2800,
      monthlyWage:           person.monthlyWage ?? 0,
      retirementDate:        person.retirementDate instanceof Date
                               ? person.retirementDate.toISOString().slice(0, 10)
                               : (person.retirementDate ?? '2040-01-01'),
    };
  }

  static _serializeEvent(node) {
    const d = {
      __type:   node.eventType === 'OneOffEvent' ? 'OneOffEvent' : 'EventSeries',
      id:       node.id,
      name:     node.name,
      type:     node.type,
      enabled:  node.enabled ?? false,
      color:    node.color ?? '#888888',
    };
    if (node.eventType === 'OneOffEvent') {
      d.date = node.date instanceof Date ? node.date.toISOString() : node.date;
      if (node.data && Object.keys(node.data).length > 0) {
        d.data = node.data;
      }
    } else {
      d.interval    = node.interval;
      d.startOffset = node.startOffset ?? 0;
      if (node.month != null) d.month = node.month;
      if (node.day   != null) d.day   = node.day;
      if (node.data && Object.keys(node.data).length > 0) {
        d.data = node.data;
      }
    }
    return d;
  }

  static _serializeHandler(node) {
    const d = {
      __type:                    node.handlerClass ?? 'HandlerEntry',
      id:                        node.id,
      name:                      node.name,
      handledEventIds:           (node.handledEvents ?? []).map(e => e.id),
      generatedActionTypes:      [...(node.generatedActionTypes ?? [])],
      generatedActionDefinitions: (node.generatedActionDefinitions ?? []).map(
        def => ({ type: def.type, config: def.config })
      ),
    };
    // Subclass-specific params
    switch (d.__type) {
      case 'UsSavingsInterestMonthlyHandler':
        d.role         = node.role;
        d.ownerId      = node.ownerId;
        d.interestRate = node.interestRate;
        break;
      case 'MonthlyExpensesHandler':
        d.monthlyExpenses = node.monthlyExpenses;
        d.usRole          = node.usRole;
        d.usOwnerId       = node.usOwnerId;
        d.auRole          = node.auRole;
        d.auOwnerId       = node.auOwnerId;
        break;
      case 'IntlTransferToUsHandler':
        d.auRole    = node.auRole;
        d.auOwnerId = node.auOwnerId;
        d.usRole    = node.usRole;
        d.usOwnerId = node.usOwnerId;
        break;
      case 'IntlTransferToAuHandler':
        d.usRole    = node.usRole;
        d.usOwnerId = node.usOwnerId;
        d.auRole    = node.auRole;
        d.auOwnerId = node.auOwnerId;
        break;
      case 'AuSavingsInterestHandler':
        d.role         = node.role;
        d.ownerId      = node.ownerId;
        d.interestRate = node.interestRate;
        break;
      case 'FixedIncomeInterestHandler':
        d.role         = node.role;
        d.ownerId      = node.ownerId;
        d.interestRate = node.interestRate;
        break;
      case 'SuperEarningsHandler':
        d.role        = node.role;
        d.ownerId     = node.ownerId;
        d.defaultRate = node.defaultRate;
        break;
      case 'DividendScheduledHandler':
        d.role         = node.role;
        d.ownerId      = node.ownerId;
        d.dividendRate = node.dividendRate;
        d.reinvest     = node.reinvest;
        break;
      case 'IntlRothEarningsHandler':
        d.role      = node.role;
        d.ownerId   = node.ownerId;
        d.growthRate = node.growthRate;
        break;
      case 'IntlIraEarningsHandler':
        d.role      = node.role;
        d.ownerId   = node.ownerId;
        d.growthRate = node.growthRate;
        break;
      case 'IntlK401EarningsHandler':
        d.role      = node.role;
        d.ownerId   = node.ownerId;
        d.growthRate = node.growthRate;
        break;
      case 'IntlUsStockEarningsHandler':
        d.role      = node.role;
        d.ownerId   = node.ownerId;
        d.growthRate = node.growthRate;
        break;
      case 'IntlAuStockEarningsHandler':
        d.role      = node.role;
        d.ownerId   = node.ownerId;
        d.growthRate = node.growthRate;
        break;
      case 'IntlAuStockDividendHandler':
        d.role         = node.role;
        d.ownerId      = node.ownerId;
        d.dividendRate = node.dividendRate;
        break;
      // ChangeResidencyHandler, MonthlyWagesHandler, OutOfFundsHandler have no serializable config params
    }
    return d;
  }

  static _serializeAction(node) {
    const C = FinSimLib.Engine;
    let typeName;
    // Check subclasses before superclasses (order matters for instanceof).
    // AmountAction must be checked before FieldValueAction since it extends it.
    if (node instanceof C.AmountAction)           typeName = 'AmountAction';
    else if (node instanceof C.ScriptedAction)    typeName = 'ScriptedAction';
    else if (node instanceof C.FieldValueAction)  typeName = 'FieldValueAction';
    else if (node instanceof C.FieldAction)       typeName = 'FieldAction';
    else if (node instanceof C.Action)            typeName = 'Action';
    else throw new Error(`Unsupported action type ${node}`);

    return {
      __type:    typeName,
      id:        node.id,    // unique service-assigned id (separate from type)
      name:      node.name,
      type:      node.type,  // category discriminator for ReducerPipeline lookup
      value:     node.value,
      fieldName: node.fieldName,
      script:    node.script,  // ScriptedAction only; undefined for all other types
    };
  }

  static _serializeReducer(node) {
    const d = {
      __type:             node.reducerType ?? 'FieldReducer',
      id:                 node.id,
      name:               node.name,
      priority:           node.priority,
      fieldName:          node.fieldName,
      value:              node.value ?? null,  // FieldValueReducer subclasses only; null for others
      script:             node.script,  // ScriptedReducer only; undefined for all other types
      reducedActionTypes:         [...(node.reducedActionTypes ?? [])],
      generatedActionTypes:       [...(node.generatedActionTypes ?? [])],
      generatedActionDefinitions: (node.generatedActionDefinitions ?? []).map(
        def => ({ type: def.type, config: def.config })
      ),
    };
    // Subclass-specific params
    switch (d.__type) {
      case 'UsSavingsInterestCreditReducer':
        d.role    = node.role;
        d.ownerId = node.ownerId;
        break;
      case 'ExpenseDebitReducer':
        d.usAccountKey = node.usAccountKey;
        d.auAccountKey = node.auAccountKey;
        break;
      // ReplenishSavingsReducer has no serializable params beyond name/priority
      case 'IntlTransferApplyReducer':
        d.usSavingsKey = node.usSavingsKey;
        d.auSavingsKey = node.auSavingsKey;
        break;
      case 'StockDividendCashApplyReducer':
        d.role    = node.role;
        d.ownerId = node.ownerId;
        break;
      // ChangeResidencyApplyReducer has no extra serializable config params
      case 'ChangeResidencyApplyReducer':
        break;
      // SetOutOfFundsDateReducer has no serializable config params
      case 'DynamicTaxReducer':
        d.cc = node.cc;
        break;
      // All other TaxService / account-module reducers have no extra serializable params
    }
    return d;
  }

  // ─── Constructors ─────────────────────────────────────────────────────────────

  /**
   * Reconstruct a HandlerEntry or subclass from its serialized descriptor.
   * Subclass-specific params (role, ownerId, rates) are restored from the
   * descriptor; stateRegistry is injected from services.
   *
   * @param {object} d        - serialized handler descriptor
   * @param {object} services - ServiceRegistry instance (provides stateRegistry)
   */
  static _makeHandler(d, services) {
    const stateRegistry = services?.stateRegistry;

    // ── No-arg account-module and tax-infrastructure handlers ─────────────────
    if (_NO_ARG_HANDLERS.has(d.__type)) {
      const handler = new FinSimLib.Finance[d.__type]();
      handler.id = d.id;
      return handler;
    }

    let handler;
    switch (d.__type) {
      case 'UsSavingsInterestMonthlyHandler':
        handler = new FinSimLib.Finance.UsSavingsInterestMonthlyHandler({
          stateRegistry,
          role:         d.role    ?? ACCOUNT_ROLES.US_SAVINGS,
          ownerId:      d.ownerId ?? null,
          interestRate: d.interestRate ?? 0.03,
        });
        break;
      case 'MonthlyExpensesHandler':
        handler = new FinSimLib.Finance.MonthlyExpensesHandler({
          stateRegistry,
          monthlyExpenses: d.monthlyExpenses ?? 6000,
          usRole:    d.usRole    ?? ACCOUNT_ROLES.US_SAVINGS,
          usOwnerId: d.usOwnerId ?? null,
          auRole:    d.auRole    ?? ACCOUNT_ROLES.AU_SAVINGS,
          auOwnerId: d.auOwnerId ?? null,
        });
        break;
      case 'MonthlyWagesHandler':
        handler = new FinSimLib.Finance.MonthlyWagesHandler({ stateRegistry });
        break;
      case 'IntlTransferToUsHandler':
        handler = new FinSimLib.Finance.IntlTransferToUsHandler({
          stateRegistry,
          auRole:    d.auRole    ?? ACCOUNT_ROLES.AU_SAVINGS,
          auOwnerId: d.auOwnerId ?? null,
          usRole:    d.usRole    ?? ACCOUNT_ROLES.US_SAVINGS,
          usOwnerId: d.usOwnerId ?? null,
        });
        break;
      case 'IntlTransferToAuHandler':
        handler = new FinSimLib.Finance.IntlTransferToAuHandler({
          stateRegistry,
          usRole:    d.usRole    ?? ACCOUNT_ROLES.US_SAVINGS,
          usOwnerId: d.usOwnerId ?? null,
          auRole:    d.auRole    ?? ACCOUNT_ROLES.AU_SAVINGS,
          auOwnerId: d.auOwnerId ?? null,
        });
        break;
      case 'AuSavingsInterestHandler':
        handler = new FinSimLib.Finance.AuSavingsInterestHandler({
          stateRegistry,
          role:         d.role    ?? ACCOUNT_ROLES.AU_SAVINGS,
          ownerId:      d.ownerId ?? null,
          interestRate: d.interestRate ?? 0.045,
        });
        break;
      case 'FixedIncomeInterestHandler':
        handler = new FinSimLib.Finance.FixedIncomeInterestHandler({
          stateRegistry,
          role:         d.role    ?? ACCOUNT_ROLES.FIXED_INCOME,
          ownerId:      d.ownerId ?? null,
          interestRate: d.interestRate ?? 0.04,
        });
        break;
      case 'SuperEarningsHandler':
        handler = new FinSimLib.Finance.SuperEarningsHandler({
          stateRegistry,
          role:        d.role    ?? ACCOUNT_ROLES.SUPER,
          ownerId:     d.ownerId ?? null,
          defaultRate: d.defaultRate ?? 0.07,
        });
        break;
      case 'DividendScheduledHandler':
        handler = new FinSimLib.Finance.DividendScheduledHandler({
          stateRegistry,
          role:         d.role    ?? ACCOUNT_ROLES.US_STOCK,
          ownerId:      d.ownerId ?? null,
          dividendRate: d.dividendRate ?? 0.02,
          reinvest:     d.reinvest     ?? false,
        });
        break;
      case 'IntlRothEarningsHandler':
        handler = new FinSimLib.Finance.IntlRothEarningsHandler({
          stateRegistry,
          role:       d.role    ?? ACCOUNT_ROLES.ROTH,
          ownerId:    d.ownerId ?? null,
          growthRate: d.growthRate ?? 0.07,
        });
        break;
      case 'IntlIraEarningsHandler':
        handler = new FinSimLib.Finance.IntlIraEarningsHandler({
          stateRegistry,
          role:       d.role    ?? ACCOUNT_ROLES.IRA,
          ownerId:    d.ownerId ?? null,
          growthRate: d.growthRate ?? 0.07,
        });
        break;
      case 'IntlK401EarningsHandler':
        handler = new FinSimLib.Finance.IntlK401EarningsHandler({
          stateRegistry,
          role:       d.role    ?? ACCOUNT_ROLES.K401,
          ownerId:    d.ownerId ?? null,
          growthRate: d.growthRate ?? 0.07,
        });
        break;
      case 'IntlUsStockEarningsHandler':
        handler = new FinSimLib.Finance.IntlUsStockEarningsHandler({
          stateRegistry,
          role:       d.role    ?? ACCOUNT_ROLES.US_STOCK,
          ownerId:    d.ownerId ?? null,
          growthRate: d.growthRate ?? 0.05,
        });
        break;
      case 'IntlAuStockEarningsHandler':
        handler = new FinSimLib.Finance.IntlAuStockEarningsHandler({
          stateRegistry,
          role:       d.role    ?? ACCOUNT_ROLES.AU_STOCK,
          ownerId:    d.ownerId ?? null,
          growthRate: d.growthRate ?? 0.06,
        });
        break;
      case 'IntlAuStockDividendHandler':
        handler = new FinSimLib.Finance.IntlAuStockDividendHandler({
          stateRegistry,
          role:         d.role    ?? ACCOUNT_ROLES.AU_STOCK,
          ownerId:      d.ownerId ?? null,
          dividendRate: d.dividendRate ?? 0.04,
        });
        break;
      case 'ChangeResidencyHandler':
        handler = new FinSimLib.Finance.ChangeResidencyHandler();
        break;
      case 'OutOfFundsHandler':
        handler = new FinSimLib.Finance.OutOfFundsHandler();
        break;
      default:
        handler = new FinSimLib.Engine.HandlerEntry(null, d.name);
        break;
    }
    handler.id = d.id;
    return handler;
  }

  static _makeAccount(d) {
    const opts = {
      id:               d.id,
      name:             d.name             ?? '',
      role:             d.role             ?? null,
      ownershipType:    d.ownershipType    ?? 'sole',
      ownerId:          d.ownerId          ?? null,
      minimumBalance:   d.minimumBalance   ?? 0,
      drawdownPriority: d.drawdownPriority ?? null,
      country:          d.country          ?? null,
      currency:         d.currency         ?? null,
    };
    // Investment-specific opts
    if (d.contributionBasis !== undefined) {
      opts.contributionBasis = d.contributionBasis;
      opts.earningsBasis     = d.earningsBasis ?? 0;
      opts.loanBalance       = d.loanBalance   ?? 0;
      // Only set minimumAge when the serialized value is non-null; otherwise let
      // the subclass constructor apply its own default (59.5, 60, etc.).
      if (d.minimumAge != null) opts.minimumAge = d.minimumAge;
    }
    let account;
    switch (d.__type) {
      case 'CheckingAccount':       account = new CheckingAccount       (d.initialValue ?? 0, opts); break;
      case 'SavingsAccount':        account = new SavingsAccount        (d.initialValue ?? 0, opts); break;
      case 'BrokerageAccount':      account = new BrokerageAccount      (d.initialValue ?? 0, opts); break;
      case 'FourOhOneKAccount':     account = new FourOhOneKAccount     (d.initialValue ?? 0, opts); break;
      case 'RothAccount':           account = new RothAccount           (d.initialValue ?? 0, opts); break;
      case 'TraditionalIRAAccount': account = new TraditionalIRAAccount (d.initialValue ?? 0, opts); break;
      case 'SuperannuationAccount': account = new SuperannuationAccount (d.initialValue ?? 0, opts); break;
      default:
        account = new Account(d.initialValue ?? 0, opts);
    }
    if (d.stateKey) account.stateKey = d.stateKey;
    return account;
  }

  static _makePerson(d) {
    const person = new Person(d.id, new Date(d.birthDate), {
      name:                  d.name ?? '',
      citizen:               d.citizen ?? ['US'],
      lifeExpectancy:        d.lifeExpectancy ?? 90,
      socialSecurityMonthly: d.socialSecurityMonthly ?? 2800,
      monthlyWage:           d.monthlyWage ?? 0,
      retirementDate:        d.retirementDate ? new Date(d.retirementDate) : new Date(Date.UTC(2040, 0, 1)),
    });
    return person;
  }

  static _makeEvent(d) {
    if (d.__type === 'OneOffEvent') {
      return new FinSimLib.Engine.OneOffEvent({
        id:      d.id,
        name:    d.name,
        type:    d.type,
        date:    d.date ? new Date(d.date) : new Date(),
        enabled: d.enabled ?? false,
        color:   d.color ?? '#888888',
        data:    d.data ?? {},
      });
    }else if(d.__type == 'EventSeries') {
      return new FinSimLib.Engine.EventSeries({
        id:          d.id,
        name:        d.name,
        type:        d.type,
        interval:    d.interval ?? 'month-end',
        startOffset: d.startOffset ?? 0,
        month:       d.month,
        day:         d.day,
        enabled:     d.enabled ?? false,
        color:       d.color ?? '#888888',
        data:        d.data ?? {},
      });
    }else {
      throw new Error(`Add support for deserialization of event type ${d.__type}.`);
    }
  }

  static _makeAction(d) {
    const C = FinSimLib.Engine;
    let action;
    switch (d.__type) {
      case 'Action':
        action = new C.Action(d.type, d.name)
      case 'FieldAction':
        action = new C.FieldAction(d.type, d.name, d.fieldName);
        break;
      case 'FieldValueAction':
        action = new C.FieldValueAction(d.type, d.name, d.fieldName, d.value);
        break;
      case 'AmountAction':
        action = new C.AmountAction(d.type, d.name, d.value ?? 0);
        break;
      case 'ScriptedAction':
        action = new C.ScriptedAction(d.type, d.name, d.fieldName ?? '', d.script ?? '');
        break;
      default:
        throw new Error(`Add support for deserialization of action type ${d.__type}.`);
    }
    action.id = d.id;  // restore the saved id (separate from type since action id != type)
    return action;
  }

  static _makeReducer(d, services) {
    const C = FinSimLib.Engine;
    const F = FinSimLib.Finance;

    // ── Account-module reducers — all constructed with { accountService } ──────
    // Adding a new account-module reducer class only requires adding it here.
    if (_ACCOUNT_SERVICE_REDUCERS.has(d.__type)) {
      return new F[d.__type]({ accountService: services?.accountService });
    }

    // ── Tax-infrastructure reducers ────────────────────────────────────────────
    switch (d.__type) {
      case 'PeriodAdvanceReducer':
        return new F.PeriodAdvanceReducer();
      case 'TaxSettleApplyReducer':
        return new F.TaxSettleApplyReducer();
      case 'TaxPaymentDebitReducer':
        return new F.TaxPaymentDebitReducer({ accountService: services?.accountService, stateRegistry: services?.stateRegistry });
      case 'DynamicTaxReducer': {
        // TaxEngine is reconstructed from a fresh TaxService — all year modules are pre-registered.
        const taxEngine  = new F.TaxService().taxEngine;
        const cc         = d.cc ?? d.name.split(':')[1];
        const actionType = (d.reducedActionTypes ?? [])[0];
        return new F.DynamicTaxReducer(taxEngine, cc, actionType);
      }
    }

    const fieldName = d.fieldName ?? '';
    switch (d.__type) {
      case 'MetricReducer':
        // Preserve null — MetricReducer(null) delegates write path to action.fieldName at runtime.
        // Using fieldName (which coerces null→'') would write to metrics.'' (broken path).
        return C.ReducerBuilder.metric(d.fieldName).name(d.name).priority(d.priority).build();
      case 'ArrayReducer':
        return C.ReducerBuilder.array(fieldName).name(d.name).priority(d.priority).value(d.value ?? null).build();
      case 'NumericSumReducer':
        return C.ReducerBuilder.numericSum(fieldName).name(d.name).priority(d.priority).value(d.value ?? null).build();
      case 'MultiplicativeReducer':
        return C.ReducerBuilder.multiplicative(fieldName).name(d.name).priority(d.priority).value(d.value ?? null).build();
      case 'NoOpReducer':
        return C.ReducerBuilder.noOp().name(d.name).priority(d.priority).build();
      case 'BalanceSnapshotReducer':
        return C.ReducerBuilder.balanceSnapshot().name(d.name).priority(d.priority).build();
      case 'ScriptedReducer':
        return new C.ScriptedReducer(d.name, d.priority, d.fieldName ?? '', d.script ?? '');
      case 'FieldReducer':
        return C.ReducerBuilder.field(fieldName).name(d.name).priority(d.priority).build();
      // ── Finance domain reducers ───────────────────────────────────────────
      case 'UsSavingsInterestCreditReducer':
        return new FinSimLib.Finance.UsSavingsInterestCreditReducer({
          accountService: services?.accountService,
          stateRegistry:  services?.stateRegistry,
          role:           d.role    ?? ACCOUNT_ROLES.US_SAVINGS,
          ownerId:        d.ownerId ?? null,
        });
      case 'ExpenseDebitReducer':
        return new FinSimLib.Finance.ExpenseDebitReducer({
          accountService: services?.accountService,
          usAccountKey:   d.usAccountKey ?? 'usSavingsAccount',
          auAccountKey:   d.auAccountKey ?? 'auSavingsAccount',
        });
      case 'ReplenishSavingsReducer':
        return new FinSimLib.Finance.ReplenishSavingsReducer({
          accountService: services?.accountService,
        });
      case 'IntlTransferApplyReducer':
        return new FinSimLib.Finance.IntlTransferApplyReducer({
          accountService: services?.accountService,
          usSavingsKey:   d.usSavingsKey ?? 'usSavingsAccount',
          auSavingsKey:   d.auSavingsKey ?? 'auSavingsAccount',
        });
      case 'StockDividendCashApplyReducer':
        return new FinSimLib.Finance.StockDividendCashApplyReducer({
          accountService: services?.accountService,
          stateRegistry:  services?.stateRegistry,
          role:           d.role    ?? ACCOUNT_ROLES.US_SAVINGS,
          ownerId:        d.ownerId ?? null,
        });
      case 'ChangeResidencyApplyReducer':
        return new FinSimLib.Finance.ChangeResidencyApplyReducer({
          accountService: services?.accountService,
          stateRegistry:  services?.stateRegistry,
        });
      case 'SetOutOfFundsDateReducer':
        return new FinSimLib.Finance.SetOutOfFundsDateReducer();
      case 'AccumulateDeficitReducer':
        return new FinSimLib.Finance.AccumulateDeficitReducer();
      case 'OutOfFundsReducer':
        return new FinSimLib.Finance.OutOfFundsReducer();
      case 'InflationAdjustReducer':
        return new FinSimLib.Finance.InflationAdjustReducer();
      default:
        throw new Error(`Add support for deserialization of reducer type ${d.__type}.`);
    }
  }
}
