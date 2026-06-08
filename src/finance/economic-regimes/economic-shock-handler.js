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
 *   Maps each RATE_KEY to the state keys of accounts it governs.
 *   Built by the ECONOMIC_REGIMES toolset from context.accounts.
 */
export class EconomicShockHandler extends HandlerEntry {
  static type      = 'EconomicShockHandler';
  static eventType = 'ECONOMIC_SHOCK';
  static description = 'Applies an instantaneous equity-revaluation level effect and pushes an EconomicRegime onto the active stack.';

  constructor(opts = {}) {
    super(null, 'Economic Shock');
    const { rateKeyToStateKeys = {} } = opts ?? {};
    this.rateKeyToStateKeys = rateKeyToStateKeys;
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
      dividendAdjustment:     shock.regime?.dividendAdjustment     ?? null,
    };

    const actions = [{ type: 'ADD_REGIME_APPLY', regime }];

    const levelEffects = shock.levelEffects ?? {};

    if (levelEffects.equityRevaluation) {
      const { rateKeys, multiplier } = levelEffects.equityRevaluation;
      for (const rk of (rateKeys ?? [])) {
        const targetStateKeys = this.rateKeyToStateKeys[rk] ?? [];
        if (targetStateKeys.length > 0) {
          actions.push({ type: 'REVALUE_ASSET_APPLY', rateKey: rk, multiplier, targetStateKeys });
        }
      }
    }

    if (levelEffects.realEstateRevaluation) {
      const { rateKeys, multiplier } = levelEffects.realEstateRevaluation;
      for (const rk of (rateKeys ?? [])) {
        const targetStateKeys = this.rateKeyToStateKeys[rk] ?? [];
        if (targetStateKeys.length > 0) {
          actions.push({ type: 'REVALUE_ASSET_APPLY', rateKey: rk, multiplier, targetStateKeys });
        }
      }
    }

    actions.push({ type: 'RECOMPUTE_REGIMES' });
    return actions;
  }
}
