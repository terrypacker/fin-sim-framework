/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseService } from './base-service.js';
import { HandlerEntry, HANDLER_CLASSES } from '../simulation-framework/handlers.js';
import { UsSavingsInterestMonthlyHandler } from '../finance/handlers/us-savings-interest-handler.js';
import { MonthlyExpensesHandler } from '../finance/handlers/monthly-expenses-handler.js';
import { FxTransferToHandler } from '../finance/fx/fx-transfer-handler.js';
import { AuSavingsInterestHandler, AuFixedIncomeInterestMonthlyHandler, FixedIncomeInterestHandler, SuperEarningsHandler } from '../finance/handlers/earnings-handlers.js';
import { DividendScheduledHandler } from '../finance/handlers/dividend-scheduled-handler.js';
import { ChangeResidencyHandler } from '../finance/handlers/change-residency-handler.js';
import { OutOfFundsHandler } from '../finance/handlers/out-of-funds-handler.js';
import { UsMortgagePaymentHandler, AuMortgagePaymentHandler } from '../finance/account-rules/mortgage-payment-classes.js';
import { LoanPaymentHandler, UsLoanPaymentHandler, AuLoanPaymentHandler } from '../finance/account-rules/loan-classes.js';
import { UsRentalIncomeHandler, AuRentalIncomeHandler } from '../finance/account-rules/rental-income-classes.js';
import { AssetAppreciationHandler } from '../finance/handlers/asset-appreciation-handler.js';
import {Edge, EDGE_TYPES} from "../graph/edge.js";

// Augment the HANDLER_CLASSES registry with all domain-specific handler subclasses.
// HANDLER_CLASSES is declared in handlers.js with only HandlerEntry; we extend it here
// because the domain handlers import HandlerEntry from handlers.js (which would create
// circular imports if we tried to register them there directly).
Object.assign(HANDLER_CLASSES, {
  UsSavingsInterestMonthlyHandler,
  MonthlyExpensesHandler,
  FxTransferToHandler,
  AuSavingsInterestHandler,
  AuFixedIncomeInterestMonthlyHandler,
  FixedIncomeInterestHandler,
  SuperEarningsHandler,
  DividendScheduledHandler,
  ChangeResidencyHandler,
  OutOfFundsHandler,
  UsMortgagePaymentHandler,
  AuMortgagePaymentHandler,
  LoanPaymentHandler,
  UsLoanPaymentHandler,
  AuLoanPaymentHandler,
  UsRentalIncomeHandler,
  AuRentalIncomeHandler,
  AssetAppreciationHandler,
});

/**
 * Service for managing HandlerEntry instances throughout their lifecycle.
 *
 * Owns an internal Map<id, item> as the source of truth.  Wiring handlers
 * into a simulation's HandlerRegistry is the caller's responsibility.
 */
export class HandlerService extends BaseService {
  constructor(graph, query, bus) {
    super(graph, query, bus, 'handler');
  }

  // ─── Edges ───────────────────────────────────────────────────────────────
  _wireNodeEdges(item) {
    (item.handledEvents ?? []).forEach(e => {
      this.linkEventToHandler(e.id, item.id);
    });

    (item.generatedActionTypes ?? []).forEach(a => {
      const action = this._query.getOneByKind('action', 'type', a);
      if(action == null) {
        throw Error(`Action for type ${a} missing.`)
      }
      this.linkHandlerToAction(item.id, action.id);
    });
  }

  linkEventToHandler(eventId, handlerId) {
    this._addEdge(eventId, handlerId, EDGE_TYPES.HANDLED_BY);
  }

  unlinkEventFromHandler(eventId, handlerId) {
    this._removeEdge(eventId, handlerId, EDGE_TYPES.HANDLED_BY);
  }

  linkHandlerToAction(handlerId, actionId) {
    this._addEdge(handlerId, actionId, EDGE_TYPES.GENERATES_ACTION);
  }

  unlinkHandlerFromAction(handlerId, actionId) {
    this._removeEdge(handlerId, actionId, EDGE_TYPES.GENERATES_ACTION);
  }

  // ─── Create ───────────────────────────────────────────────────────────────
  /**
   * Create a new HandlerEntry and publish a CREATE event.
   *
   * @param {Function|null} fn   - Handler function receiving ({data, date, state, sim})
   * @param {string}        name - Display name for the handler
   * @returns {HandlerEntry}
   */
  createHandler(fn = null, name = 'New Handler') {
    const item = new HandlerEntry(fn, name);
    item.id = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  /**
   * Apply `changes` to an existing handler and publish an UPDATE event.
   *
   * Accepts either the item's string ID or the handler object.  The item is
   * resolved from the internal map so the originalItem snapshot is taken
   * before the mutation is applied.
   *
   * @param {string|HandlerEntry} idOrHandler
   * @param {object} changes
   * @returns {HandlerEntry}
   */
  updateHandler(idOrHandler, changes = {}) {
    const handler = this._resolve(idOrHandler);
    const originalItem = Object.assign(Object.create(Object.getPrototypeOf(handler)), handler);
    this.mergeChanges(handler, changes);
    this._publish('UPDATE', handler, originalItem);
    this._rewireEdges(handler);
    return handler;
  }

  /**
   * Replace an existing handler with a new instance of the given class,
   * preserving id, name, fn, handledEvents, generatedActionTypes, and generatedActionDefinitions.
   *
   * HandlerEntry subclasses may have different constructor signatures, so we
   * bypass the constructor via Object.create and restore all relevant properties
   * explicitly. This keeps constructor.name and getDescription() in sync with
   * the stored handlerClass string.
   *
   * @param {string|HandlerEntry} idOrHandler
   * @param {string}              newClass    - key in HANDLER_CLASSES
   * @param {object}              [extraProps]
   * @returns {HandlerEntry}
   */
  replaceHandler(idOrHandler, newClass, extraProps = {}) {
    const old = this._resolve(idOrHandler);
    const Cls = HANDLER_CLASSES[newClass];
    if (!Cls) throw new Error(`HandlerService: unknown handler class "${newClass}"`);

    const fresh = new Cls(old.fn, old.name);
    fresh.id                        = old.id;
    fresh.name                      = old.name;
    fresh.fn                        = old.fn;
    fresh.handledEvents              = old.handledEvents;
    fresh.generatedActionTypes       = old.generatedActionTypes;
    fresh.generatedActionDefinitions = old.generatedActionDefinitions;
    Object.assign(fresh, extraProps);

    this._graph.updateNode(fresh.id, fresh);
    this._publish('UPDATE', fresh, old);
    return fresh;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  // ── Finance domain handlers ────────────────────────────────────────────────

  /**
   * Create and register a UsSavingsInterestMonthlyHandler.
   *
   * @param {object} opts
   * @param {import('../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
   * @param {string} opts.role       - ACCOUNT_ROLES value for the savings account
   * @param {string} [opts.ownerId]  - Person id (null = any owner)
   * @param {number} [opts.interestRate=0.03]
   * @param {string} [opts.name='Monthly US Savings Interest']
   */
  createUsSavingsInterestHandler({ stateRegistry, role, ownerId = null, interestRate = 0.03, name = 'Monthly US Savings Interest' } = {}) {
    const item = new UsSavingsInterestMonthlyHandler({ stateRegistry, role, ownerId, interestRate });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  /**
   * Create and register a MonthlyExpensesHandler.
   *
   * @param {object} opts
   * @param {import('../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
   * @param {number} [opts.monthlyExpenses=6000]
   * @param {string} opts.usRole      - ACCOUNT_ROLES value for the USD cash pool
   * @param {string} [opts.usOwnerId]
   * @param {string} opts.auRole      - ACCOUNT_ROLES value for the AUD cash pool
   * @param {string} [opts.auOwnerId]
   * @param {string} [opts.name='Monthly Expenses']
   */
  createMonthlyExpensesHandler({ stateRegistry, monthlyExpenses = 6000, usRole, usOwnerId = null, auRole, auOwnerId = null, name = 'Monthly Expenses' } = {}) {
    const item = new MonthlyExpensesHandler({ stateRegistry, monthlyExpenses, usRole, usOwnerId, auRole, auOwnerId });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  /**
   * Create and register an AuSavingsInterestHandler.
   *
   * @param {object} opts
   * @param {import('../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
   * @param {string} opts.role
   * @param {string} [opts.ownerId]
   * @param {number} [opts.interestRate=0.045]
   * @param {string} [opts.name='AU Savings Interest']
   */
  createAuSavingsInterestHandler({ stateRegistry, role, ownerId = null, interestRate = 0.045, name = 'AU Savings Interest' } = {}) {
    const item = new AuSavingsInterestHandler({ stateRegistry, role, ownerId, interestRate });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  /**
   * Create and register a FixedIncomeInterestHandler.
   *
   * @param {object} opts
   * @param {import('../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
   * @param {string} opts.role
   * @param {string} [opts.ownerId]
   * @param {number} [opts.interestRate=0.04]
   * @param {string} [opts.name='Fixed Income Interest']
   */
  createFixedIncomeInterestHandler({ stateRegistry, role, ownerId = null, interestRate = 0.04, name = 'Fixed Income Interest' } = {}) {
    const item = new FixedIncomeInterestHandler({ stateRegistry, role, ownerId, interestRate });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  /**
   * Create and register a SuperEarningsHandler.
   *
   * @param {object} opts
   * @param {import('../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
   * @param {string} opts.role
   * @param {string} [opts.ownerId]
   * @param {number} [opts.defaultRate=0.07]
   * @param {string} [opts.name='Super Earnings']
   */
  createSuperEarningsHandler({ stateRegistry, role, ownerId = null, defaultRate = 0.07, name = 'Super Earnings' } = {}) {
    const item = new SuperEarningsHandler({ stateRegistry, role, ownerId, defaultRate });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  /**
   * Create and register a DividendScheduledHandler.
   *
   * @param {object} opts
   * @param {import('../finance/services/state-registry.js').StateRegistry} opts.stateRegistry
   * @param {string} opts.role
   * @param {string} [opts.ownerId]
   * @param {number}  [opts.dividendRate=0.02]
   * @param {boolean} [opts.reinvest=false]
   * @param {string}  [opts.name='Dividend Scheduled']
   */
  createDividendScheduledHandler({ stateRegistry, role, ownerId = null, dividendRate = 0.02, reinvest = false, name = 'Dividend Scheduled' } = {}) {
    const item = new DividendScheduledHandler({ stateRegistry, role, ownerId, dividendRate, reinvest });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  /**
   * Create and register a ChangeResidencyHandler.
   * No params — TaxSettleService is created internally.
   * @param {object} [opts]
   * @param {string} [opts.name='Change Residency']
   */
  createChangeResidencyHandler({ name = 'Change Residency' } = {}) {
    const item = new ChangeResidencyHandler();
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  /**
   * Create and register an OutOfFundsHandler.
   * @param {object} [opts]
   * @param {string} [opts.name='Out of Funds']
   */
  createOutOfFundsHandler({ name = 'Out of Funds' } = {}) {
    const item = new OutOfFundsHandler();
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item);
    this._wireNodeEdges(item);
    return item;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  /**
   * Remove the handler from the service map and publish a DELETE event.
   * The caller is responsible for unregistering it from the HandlerRegistry.
   *
   * @param {string|HandlerEntry} idOrHandler
   * @returns {HandlerEntry}
   */
  deleteHandler(idOrHandler) {
    const handler = this._resolve(idOrHandler);
    this._unregister(handler.id);
    this._publish('DELETE', handler, handler);
    return handler;
  }
}
