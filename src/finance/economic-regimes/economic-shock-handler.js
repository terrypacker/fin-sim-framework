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

    // A shock is one event but not necessarily one REGIME. Design 21 §7 gives a regime a
    // single recovery curve, which forces every part of a shock to decay at the same speed —
    // and real episodes do not. In the dot-com bust equity took a permanent level cut and
    // ground down for ~30 months while the monetary easing that came with it ran for years:
    // the Fed was at 1% into 2004 and the 10-year had still not recovered by 2006. Sharing
    // one 36-month curve made the bond rally ROUND-TRIP by construction, handing back exactly
    // the protection the episode is famous for.
    //
    // So a shock may declare `legs` — each with its own `regime` and its own `recovery` — and
    // each becomes a regime of its own. Nothing new is needed downstream: `state.activeRegimes`
    // is already a STACK whose per-rate-key adjustments SUM (§4.3), so two legs at different
    // recovery factors compose exactly as two unrelated shocks would. This is the framework's
    // own composition mechanism, not a second one bolted beside it.
    //
    // Absent `legs`, the shock is its own single leg and the behaviour is byte-identical.
    const legs = Array.isArray(shock.legs) && shock.legs.length
      ? shock.legs
      : [{ id: null, regime: shock.regime, recovery: shock.recovery }];

    const actions = [];
    for (const leg of legs) {
      const durationMonths = leg.recovery?.durationMonths ?? 12;
      actions.push({
        type: 'ADD_REGIME_APPLY',
        regime: {
          // A leg's id must be distinct: RegimeApplyReducer keys the live stack by it, so two
          // legs sharing an id would be one regime with whichever adjustments landed last.
          id:               leg.id ? `regime-${shock.shockId}-${leg.id}` : `regime-${shock.shockId}`,
          shockId:          shock.shockId,
          startDate,
          endDate:          DateUtils.addMonths(startDate, durationMonths),
          recoveryProfile:  leg.recovery?.profile ?? 'V',
          durationMonths,
          currentFactor:    1.0,
          returnAdjustment:       leg.regime?.returnAdjustment       ?? null,
          interestRateAdjustment: leg.regime?.interestRateAdjustment ?? null,
          inflationAdjustment:    leg.regime?.inflationAdjustment    ?? null,
          appreciationAdjustment: leg.regime?.appreciationAdjustment ?? null,
          fxAdjustment:           leg.regime?.fxAdjustment           ?? null,
          fxVolAdjustment:        leg.regime?.fxVolAdjustment        ?? null,
          dividendAdjustment:     leg.regime?.dividendAdjustment     ?? null,
          // Yield-curve shape twist (design 67 §6): a per-country { US:[{tenor,spread}], AU:… }
          // additive shape delta the YieldCurveReducer composes onto baseYieldCurve, scaled
          // by this regime's recovery factor. Null for non-curve shocks (a no-op there).
          yieldCurveTwist:        leg.regime?.yieldCurveTwist        ?? null,
          tags:                   shock.tags ?? [],
        },
      });
    }

    const levelEffects = shock.levelEffects ?? {};

    // Both level effects emit the same action shape. Accounts always go in scope
    // (the reducer filters them per holding); scalar assets are still rate-key
    // matched, since a RealProperty has no sleeves to inspect.
    // A level effect is either ONE { rateKeys, multiplier } or an ARRAY of them. The
    // array form exists because a real crash is not one number: the dot-com bust took
    // the S&P down ~49% and the ASX ~22%, and a single multiplier across every equity
    // rate key can only say "one crash, everywhere". Each entry is emitted as its own
    // REVALUE_ASSET_APPLY, so the reducer path is unchanged.
    const pushRevaluation = (effect) => {
      if (!effect) return;
      if (Array.isArray(effect)) { effect.forEach(pushOneRevaluation); return; }
      pushOneRevaluation(effect);
    };

    const pushOneRevaluation = (effect) => {
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
