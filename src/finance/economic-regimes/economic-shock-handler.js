/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }        from '../../simulation-framework/handlers.js';
import { DateUtils }           from '../../simulation-framework/date-utils.js';

/**
 * EconomicShockHandler — handles ECONOMIC_SHOCK one-off events.
 *
 * For each shock it:
 *  1. Builds an EconomicRegime from shock.regime and emits ADD_REGIME_APPLY.
 *  2. For each levelEffect key, emits REVALUE_ASSET_APPLY to apply the
 *     instantaneous balance revaluation.
 *  3. Emits RECOMPUTE_REGIMES so effective rates pick up the new regime on
 *     the same simulation tick.
 *
 * @param {object} opts
 * @param {Object<string, string[]>} opts.rateKeyToStateKeys
 *   Maps each RATE_KEY to the SCALAR assets (RealProperty / Collectible) it governs.
 *   Built by the ECONOMIC_REGIMES toolset; accounts are not in this map.
 * @param {string[]} opts.allAccountStateKeys
 *   Every account, regardless of role. RevalueAssetReducer scans these holding-by-
 *   holding and revalues only the sleeves whose own allocation matches the shocked
 *   rate key, so an account's role never decides what a shock touches.
 */
export class EconomicShockHandler extends HandlerEntry {
  static type      = 'EconomicShockHandler';
  static eventType = 'ECONOMIC_SHOCK';
  static description = 'Applies an instantaneous equity-revaluation level effect and pushes an EconomicRegime onto the active stack.';

  constructor(opts = {}) {
    super(null, 'Economic Shock');
    const { rateKeyToStateKeys = {}, allAccountStateKeys = [] } = opts ?? {};
    this.rateKeyToStateKeys  = rateKeyToStateKeys;
    this.allAccountStateKeys = allAccountStateKeys;
    this.generatedActionTypes = ['ADD_REGIME_APPLY', 'REVALUE_ASSET_APPLY', 'RECOMPUTE_REGIMES'];
  }

  call({ data }) {
    const shock = data?.shock;
    if (!shock) return [];

    const startDate = shock.startDate instanceof Date ? shock.startDate : new Date(shock.startDate);
    const durationMonths = shock.recovery?.durationMonths ?? 12;
    const endDate = DateUtils.addMonths(startDate, durationMonths);

    const regime = {
      id:               `regime-${shock.shockId}`,
      shockId:          shock.shockId,
      startDate,
      endDate,
      recoveryProfile:  shock.recovery?.profile ?? 'V',
      durationMonths,
      currentFactor:    1.0,
      returnAdjustment:       shock.regime?.returnAdjustment       ?? null,
      interestRateAdjustment: shock.regime?.interestRateAdjustment ?? null,
      inflationAdjustment:    shock.regime?.inflationAdjustment    ?? null,
      appreciationAdjustment: shock.regime?.appreciationAdjustment ?? null,
      fxAdjustment:           shock.regime?.fxAdjustment           ?? null,
      fxVolAdjustment:        shock.regime?.fxVolAdjustment        ?? null,
      dividendAdjustment:     shock.regime?.dividendAdjustment     ?? null,
      // Yield-curve shape twist (design 67 §6): a per-country { US:[{tenor,spread}], AU:… }
      // additive shape delta the YieldCurveReducer composes onto baseYieldCurve, scaled
      // by this regime's recovery factor. Null for non-curve shocks (a no-op there).
      yieldCurveTwist:        shock.regime?.yieldCurveTwist        ?? null,
      tags:                   shock.tags ?? [],
    };

    const actions = [{ type: 'ADD_REGIME_APPLY', regime }];

    const levelEffects = shock.levelEffects ?? {};

    // Both level effects emit the same action shape. Accounts always go in scope
    // (the reducer filters them per holding); scalar assets are still rate-key
    // matched, since a RealProperty has no sleeves to inspect.
    const pushRevaluation = (effect) => {
      if (!effect) return;
      const { rateKeys, multiplier } = effect;
      for (const rk of (rateKeys ?? [])) {
        const targetStateKeys   = this.rateKeyToStateKeys[rk] ?? [];
        const holdingsStateKeys = this.allAccountStateKeys;
        if (targetStateKeys.length === 0 && holdingsStateKeys.length === 0) continue;
        actions.push({
          type: 'REVALUE_ASSET_APPLY', rateKey: rk, multiplier, targetStateKeys, holdingsStateKeys,
        });
      }
    };

    pushRevaluation(levelEffects.equityRevaluation);
    pushRevaluation(levelEffects.realEstateRevaluation);

    actions.push({ type: 'RECOMPUTE_REGIMES' });
    return actions;
  }
}
