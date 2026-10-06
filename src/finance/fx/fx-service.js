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
import { FxTickHandler }          from './fx-tick-handler.js';
import { FxStepApplyReducer }     from './fx-step-apply-reducer.js';
import { FxProcessReducer }       from './fx-process-reducer.js';
import { EventSeries }            from '../../simulation-framework/events/event-series.js';

/**
 * Default per-step FX volatility (annualized log-vol) when a process model is active.
 *
 * Calibrated, not guessed (design 92 §8.1): fitted to the observed TERM STRUCTURE of
 * USD/AUD dispersion over the post-float window 1984-01 → 2026-07. Reproduce with
 * `node scripts/lab/calibrate-fx.mjs --compare`. The original 0.06 was a placeholder and
 * ran the currency at roughly half its observed volatility.
 */
const DEFAULT_FX_VOLATILITY = 0.1142;
/**
 * Default mean-reversion speed (per year) for the MEAN_REVERTING model — a half-life of
 * about 6.1 years.
 *
 * Fitted to the term structure, NOT to the lag-1 autocorrelation. The lag-1 AR(1)
 * estimator design 92 §8.1 originally specified returns 0.296 (half-life 2.3y) on this
 * same window, which over-reverts: it reproduces the observed 1-year dispersion and then
 * flattens, understating 10-year dispersion by a third and 44-year dispersion by ~40%.
 * The variance ratio makes the same point — at 10 years the history gives 0.650, this
 * value gives 0.634, and the AR(1) value gives 0.370. See `fitFxTermStructure`.
 */
const DEFAULT_FX_REVERSION  = 0.114;
/**
 * Default ANNUAL correlation of the USD/AUD move with the equity market shock (design 120
 * §3.6, Q7): the 2004–2023 measurement on the model's own pair and horizon, −0.54. It
 * agrees with J.P. Morgan's implied −0.635 and puts the minimum-variance hedge ratio
 * (≈0.19) where Australian super funds hold theirs. Reproduce with
 * `npm run fx:equity-correlation`.
 */
export const DEFAULT_FX_EQUITY_CORRELATION = -0.54;
/** Default FX tick interval in years (monthly). */
const FX_TICK_DT            = 1 / 12;

/**
 * Whether ECONOMIC_REGIMES contributes the FX process layer (design 120 §5.3).
 *
 * The rate and its walk used to live in US_AU_CROSS_BORDER, so an AU-only plan could not
 * switch them on. ECONOMIC_REGIMES now owns them, but contributes them only when something
 * reads them: a stochastic process model is selected, or the cross-border toolset is loaded
 * (its transfers convert at the rate). An AU-only plan with the model at NONE gets no FX state
 * at all, exactly as before.
 *
 * @param {object} context — compile context (`parameters`, `toolsetIds`)
 * @returns {boolean}
 */
export function regimesContributesFxProcess(context) {
  return (context.parameters?.fxProcessModel ?? 'NONE') !== 'NONE'
    || (context.toolsetIds ?? []).includes('US_AU_CROSS_BORDER');
}

/**
 * Whether US_AU_CROSS_BORDER still contributes the FX process layer itself: only when
 * ECONOMIC_REGIMES is not in the compile, so a cross-border plan without the regime layer
 * keeps its rate.
 *
 * @param {object} context
 * @returns {boolean}
 */
export function crossBorderContributesFxProcess(context) {
  return !(context.toolsetIds ?? []).includes('ECONOMIC_REGIMES');
}

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
   * @param {object}   [layers]           — which of the two layers to contribute (design 120 §5.3):
   *   `process` is the rate and its stochastic walk (anchors, volatility, deviation, the FX tick
   *   and the reducers that compose the rate), which ECONOMIC_REGIMES owns so an AU-only plan
   *   can run it; `transfers` is the transfer fee, the FX_TRANSFER handler and its reducer,
   *   which US_AU_CROSS_BORDER keeps. Both by default.
   * @returns {{ statePatches: object, events: [], handlers: object[], reducers: object[] }}
   */
  getContributions(currencies, accountService, _stateRegistry, parameters,
                   { process = true, transfers = true } = {}) {
    const pairs = this._collectPairs(currencies);

    const model      = parameters?.fxProcessModel ?? 'NONE';
    const fxActive   = model !== 'NONE';
    const volatility = parameters?.fxVolatility     ?? DEFAULT_FX_VOLATILITY;
    const reversion  = parameters?.fxReversionSpeed ?? DEFAULT_FX_REVERSION;
    const correlation = parameters?.fxEquityCorrelation ?? DEFAULT_FX_EQUITY_CORRELATION;
    if (!(correlation >= -1 && correlation <= 1)) {
      throw new Error(`fxEquityCorrelation must be between -1 and 1, got ${correlation}.`);
    }

    const baseRates  = {};
    const baseFees   = {};
    const baseVol    = {};
    const deviation  = {};
    const pairIds    = [];

    for (const pair of pairs) {
      const pairId = pair.constructor.id;
      pairIds.push(pairId);
      if (pairId === 'USD_AUD') {
        baseRates[pairId] = parameters?.exchangeRateUsdToAud ?? 1.55;
        baseFees[pairId]  = parameters?.intlTransferFeeUsd   ?? 15;
      }
      // Volatility only seeds when a stochastic model is active; otherwise 0
      // so FxProcessReducer's exp(0) leaves the rate exactly at its anchor.
      baseVol[pairId]   = fxActive ? volatility : 0;
      deviation[pairId] = 0;
    }

    const statePatches = {};
    if (process) {
      Object.assign(statePatches, {
        baseExchangeRates:      baseRates,
        effectiveExchangeRates: { ...baseRates },
        // Time-varying FX layer (design 47).
        baseFxVol:      baseVol,
        effectiveFxVol: { ...baseVol },
        fxDeviation:    deviation,
        fxAnchorRates:  { ...baseRates },
      });
    }
    if (transfers) {
      Object.assign(statePatches, {
        baseFxFees:      baseFees,
        effectiveFxFees: { ...baseFees },
      });
    }

    const handlers = transfers
      ? [new FxTransferToHandler({ fxService: this, accountService })]
      : [];

    const reducers = [
      ...(process   ? [new FxRefreshReducer()] : []),
      ...(transfers ? [new FxTransferApplyReducer({ accountService })] : []),
      // Always registered with the process layer — no-ops when fxDeviation stays 0 (NONE model).
      ...(process   ? [new FxProcessReducer(), new FxStepApplyReducer()] : []),
    ];

    const events = [];
    if (process && fxActive) {
      // The FX tick is the only in-loop RNG consumer; scheduled only when a
      // stochastic model is active so default scenarios draw no randomness.
      handlers.push(new FxTickHandler({
        model, reversionSpeed: reversion, dt: FX_TICK_DT, pairs: pairIds,
        equityCorrelation: correlation,
      }));
      events.push(this._buildFxTickSeries());
    }

    return { statePatches, events, handlers, reducers };
  }

  /**
   * Monthly FX_TICK EventSeries, anchored at simulation start over the full
   * horizon. Ordered low so it fires before the period advance that recomposes
   * the rate. Same declarative pre-scheduling pattern as ECONOMIC_RECOVERY_TICK.
   * @returns {EventSeries}
   */
  _buildFxTickSeries() {
    return new EventSeries({
      name:        'FX Tick',
      type:        'FX_TICK',
      interval:    'monthly',
      startOffset: 0,
      order:       1,
      enabled:     true,
      color:       '#7E57C2',
    });
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
