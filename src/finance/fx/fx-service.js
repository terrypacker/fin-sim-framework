/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { FxEngine }              from './fx-engine.js';
import { UsdAudPair }            from './usd-aud-pair.js';
import { FxTransferToHandler }    from './fx-transfer-handler.js';
import { FxTransferApplyReducer } from './fx-transfer-apply-reducer.js';
import { FxRefreshReducer }       from './fx-refresh-reducer.js';

/**
 * FxService — coordinator for currency-pair registration, rate/fee state
 * initialisation, settlement-account registry, and declarative contributions.
 *
 * Modelled on TaxService (src/finance/tax-service.js).  One instance per
 * scenario compilation context; see _getFxService() in us-au-cross-border-toolset.js.
 *
 * Usage in toolset:
 *   const fx = _getFxService(context);
 *   fx.registerSettlement('USD', stateRegistry.getStateKey(ACCOUNT_ROLES.US_SAVINGS, primaryId));
 *   fx.registerSettlement('AUD', stateRegistry.getStateKey(ACCOUNT_ROLES.AU_SAVINGS, primaryId));
 *   const { statePatches, handlers, reducers } = fx.getContributions(['USD', 'AUD'], ...);
 */
export class FxService {
  constructor() {
    this._fxEngine    = new FxEngine();
    this._settlements = {};

    this._fxEngine.registerPair(new UsdAudPair());
  }

  /**
   * Register the settlement account state-key for a currency.
   *
   * @param {string} currency  — ISO currency code, e.g. 'USD'
   * @param {string} stateKey  — state object key for the settlement account
   */
  registerSettlement(currency, stateKey) {
    this._settlements[currency] = stateKey;
  }

  /**
   * Resolve the settlement state-key for a currency.
   *
   * @param {string} currency
   * @returns {string}
   */
  settlement(currency) {
    const key = this._settlements[currency];
    if (!key) {
      throw new Error(`FxService: no settlement account registered for currency '${currency}'`);
    }
    return key;
  }

  /** @returns {FxEngine} */
  get fxEngine() { return this._fxEngine; }

  /**
   * Declarative contributions for the given currency set.
   *
   * Returns plain data — no side effects.  Matches the TaxService
   * getContributions() shape so toolsets can integrate it uniformly.
   *
   * Settlement accounts must be registered via registerSettlement() before
   * calling handlers() on the returned contributions.
   *
   * @param {string[]} currencies         — e.g. ['USD', 'AUD']
   * @param {object}   accountService
   * @param {object}   _stateRegistry     — reserved for future use
   * @param {object}   parameters         — scenario parameters (exchangeRateUsdToAud, intlTransferFeeUsd)
   * @returns {{ statePatches: object, events: [], handlers: object[], reducers: object[] }}
   */
  getContributions(currencies, accountService, _stateRegistry, parameters) {
    const pairs = this._collectPairs(currencies);

    const baseRates = {};
    const baseFees  = {};

    for (const pair of pairs) {
      const pairId = pair.constructor.id;
      if (pairId === 'USD_AUD') {
        baseRates[pairId] = parameters?.exchangeRateUsdToAud ?? 1.55;
        baseFees[pairId]  = parameters?.intlTransferFeeUsd   ?? 15;
      }
    }

    const statePatches = {
      baseExchangeRates:      baseRates,
      baseFxFees:             baseFees,
      effectiveExchangeRates: { ...baseRates },
      effectiveFxFees:        { ...baseFees },
    };

    const handlers = [
      new FxTransferToHandler({ fxService: this, accountService }),
    ];

    const reducers = [
      new FxRefreshReducer(),
      new FxTransferApplyReducer({ accountService }),
    ];

    return { statePatches, events: [], handlers, reducers };
  }

  /**
   * Collect pairs that cover at least one of the given currencies.
   * @param {string[]} currencies
   * @returns {import('./fx-engine.js').CurrencyPair[]}
   */
  _collectPairs(currencies) {
    const result = new Set();
    for (const pair of this._fxEngine.pairs()) {
      const { fromCurrency, toCurrency } = pair.constructor;
      if (currencies.includes(fromCurrency) || currencies.includes(toCurrency)) {
        result.add(pair);
      }
    }
    return [...result];
  }
}
