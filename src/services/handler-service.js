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
import { IntlTransferToUsHandler, IntlTransferToAuHandler } from '../finance/handlers/intl-transfer-handlers.js';
import { AuSavingsInterestHandler, FixedIncomeInterestHandler, SuperEarningsHandler } from '../finance/handlers/earnings-handlers.js';
import { DividendScheduledHandler } from '../finance/handlers/dividend-scheduled-handler.js';
import { ChangeResidencyHandler } from '../finance/handlers/change-residency-handler.js';
import { OutOfFundsHandler } from '../finance/handlers/out-of-funds-handler.js';

/**
 * Service for managing HandlerEntry instances throughout their lifecycle.
 *
 * Owns an internal Map<id, item> as the source of truth.  Wiring handlers
 * into a simulation's HandlerRegistry is the caller's responsibility.
 */
export class HandlerService extends BaseService {
  constructor(bus) { super(bus, 'h'); }

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
    this._publish('CREATE', item.constructor.name, item);
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
    Object.assign(handler, changes);
    this._publish('UPDATE', handler.constructor.name, handler, originalItem);
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

    const fresh = Object.create(Cls.prototype);
    fresh.id                       = old.id;
    fresh.name                     = old.name;
    fresh.fn                       = old.fn;
    fresh.handledEvents             = old.handledEvents;
    fresh.generatedActionTypes      = old.generatedActionTypes;
    fresh.generatedActionDefinitions = old.generatedActionDefinitions;
    Object.assign(fresh, extraProps);

    this._items.set(fresh.id, fresh);
    this._publish('UPDATE', newClass, fresh, old);
    return fresh;
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  // ── Finance domain handlers ────────────────────────────────────────────────

  /**
   * Create and register a UsSavingsInterestMonthlyHandler.
   * Wire the handler to an event by adding the EventSeries to handler.handledEvents
   * before calling this, or call updateHandler(id, { handledEvents: [...] }) after.
   *
   * @param {object} [opts]
   * @param {string} [opts.accountKey='usSavingsAccount']
   * @param {number} [opts.interestRate=0.03]
   * @param {string} [opts.name='Monthly US Savings Interest']
   */
  createUsSavingsInterestHandler({ accountKey = 'usSavingsAccount', interestRate = 0.03, name = 'Monthly US Savings Interest' } = {}) {
    const item = new UsSavingsInterestMonthlyHandler({ accountKey, interestRate });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  /**
   * Create and register a MonthlyExpensesHandler.
   * @param {object} [opts]
   * @param {number} [opts.monthlyExpenses=6000]
   * @param {string} [opts.usAccountKey='usSavingsAccount']
   * @param {string} [opts.auAccountKey='auSavingsAccount']
   * @param {string} [opts.name='Monthly Expenses']
   */
  createMonthlyExpensesHandler({ monthlyExpenses = 6000, usAccountKey = 'usSavingsAccount', auAccountKey = 'auSavingsAccount', name = 'Monthly Expenses' } = {}) {
    const item = new MonthlyExpensesHandler({ monthlyExpenses, usAccountKey, auAccountKey });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  /**
   * Create and register an IntlTransferToUsHandler (AUD → USD, user-triggered).
   * @param {object} [opts]
   * @param {string} [opts.auAccountKey='auSavingsAccount']
   * @param {string} [opts.usAccountKey='usSavingsAccount']
   * @param {string} [opts.name='International Transfer to US']
   */
  createIntlTransferToUsHandler({ auAccountKey = 'auSavingsAccount', usAccountKey = 'usSavingsAccount', name = 'International Transfer to US' } = {}) {
    const item = new IntlTransferToUsHandler({ auAccountKey, usAccountKey });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  /**
   * Create and register an IntlTransferToAuHandler (USD → AUD, user-triggered).
   * @param {object} [opts]
   * @param {string} [opts.usAccountKey='usSavingsAccount']
   * @param {string} [opts.auAccountKey='auSavingsAccount']
   * @param {string} [opts.name='International Transfer to AU']
   */
  createIntlTransferToAuHandler({ usAccountKey = 'usSavingsAccount', auAccountKey = 'auSavingsAccount', name = 'International Transfer to AU' } = {}) {
    const item = new IntlTransferToAuHandler({ usAccountKey, auAccountKey });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  /**
   * Create and register an AuSavingsInterestHandler.
   * @param {object} [opts]
   * @param {string} [opts.accountKey='auSavingsAccount']
   * @param {number} [opts.interestRate=0.045]
   * @param {string} [opts.name='AU Savings Interest']
   */
  createAuSavingsInterestHandler({ accountKey = 'auSavingsAccount', interestRate = 0.045, name = 'AU Savings Interest' } = {}) {
    const item = new AuSavingsInterestHandler({ accountKey, interestRate });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  /**
   * Create and register a FixedIncomeInterestHandler.
   * @param {object} [opts]
   * @param {string} [opts.accountKey='fixedIncomeAccount']
   * @param {number} [opts.interestRate=0.04]
   * @param {string} [opts.name='Fixed Income Interest']
   */
  createFixedIncomeInterestHandler({ accountKey = 'fixedIncomeAccount', interestRate = 0.04, name = 'Fixed Income Interest' } = {}) {
    const item = new FixedIncomeInterestHandler({ accountKey, interestRate });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  /**
   * Create and register a SuperEarningsHandler.
   * @param {object} [opts]
   * @param {string} [opts.accountKey='superAccount']
   * @param {number} [opts.defaultRate=0.07]
   * @param {string} [opts.name='Super Earnings']
   */
  createSuperEarningsHandler({ accountKey = 'superAccount', defaultRate = 0.07, name = 'Super Earnings' } = {}) {
    const item = new SuperEarningsHandler({ accountKey, defaultRate });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
    return item;
  }

  /**
   * Create and register a DividendScheduledHandler.
   * @param {object} [opts]
   * @param {string}  [opts.accountKey='stockAccount']
   * @param {number}  [opts.dividendRate=0.02]
   * @param {boolean} [opts.reinvest=false]
   * @param {string}  [opts.name='Dividend Scheduled']
   */
  createDividendScheduledHandler({ accountKey = 'stockAccount', dividendRate = 0.02, reinvest = false, name = 'Dividend Scheduled' } = {}) {
    const item = new DividendScheduledHandler({ accountKey, dividendRate, reinvest });
    item.name = name;
    item.id   = this._generateId('h');
    this._register(item);
    this._publish('CREATE', item.constructor.name, item);
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
    this._publish('CREATE', item.constructor.name, item);
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
    this._publish('CREATE', item.constructor.name, item);
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
    this._publish('DELETE', handler.constructor.name, handler, handler);
    return handler;
  }
}
