/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';

/**
 * The AUD price of a US dollar implied by the realised AU/US price ratio since sim start
 * (design 122 §3). Both accumulators are 1.0 at sim start, so the ratio IS the relative
 * price level. Null when either is missing (a single-country plan), which means "no PPP".
 *
 * @param {object} state
 * @returns {?number}
 */
export function pppIndexUsdAud(state) {
  const au = state?.inflationAccumulator?.AU;
  const us = state?.inflationAccumulator?.US;
  return au > 0 && us > 0 ? au / us : null;
}

/**
 * Which period advance to sample the index on (design 122 §3.1). Each accumulator steps once
 * per period START strictly after sim start: US on 1 Jan, AU on 1 Jul. Sampled right after
 * the advance that makes the two step counts equal, they hold the same number of annual
 * steps — after the AU advance when the plan starts in July–December, after the US advance
 * when it starts in January–June. At equal inflation the two products are then the same float
 * sequence and the index is exactly 1. Sampled on the other advance it would be one step
 * apart: a (1 + r) sawtooth at equal rates.
 *
 * @param {?Date} simStart
 * @returns {'AU_PERIOD_ADVANCE'|'US_PERIOD_ADVANCE'}
 */
export function pppSampleAdvance(simStart) {
  const month = simStart instanceof Date ? simStart.getUTCMonth() : 6;
  return month >= 6 ? 'AU_PERIOD_ADVANCE' : 'US_PERIOD_ADVANCE';
}

/**
 * FxPppReducer — moves the USD_AUD anchor with the AU/US inflation gap (design 122).
 *
 *     anchor = (authored rate + regime fxAdjustment) × fxPppIndex
 *
 * Sampled ONCE a year, on the advance {@link pppSampleAdvance} picks, at PRE_PROCESS + 3:
 * after InflationAdjustReducer (+2) has stepped that country's accumulator. At equal inflation
 * the index is exactly 1 — this reducer then writes nothing, and the run is byte-identical to
 * a run without it.
 *
 * It stores the index and nothing else. FxProcessReducer, the one place the rate is
 * composed, applies it to the next FRESH anchor: the other country's period advance (about six
 * months later) or the next regime recompute. Rescaling the rate here as well would be a second
 * formula for the same number, and the two round differently (an ulp is enough to break the
 * byte-identity the design depends on).
 */
export class FxPppReducer extends Reducer {
  static description = 'Samples the AU/US price ratio once a year (after the period advance that equalises the two step counts) into fxPppIndex; FxProcessReducer scales the next fresh USD_AUD anchor by it (relative PPP, design 122).';
  static type        = 'FxPppReducer';

  constructor({ sampleOn = 'AU_PERIOD_ADVANCE' } = {}) {
    super('FX PPP', PRIORITY.PRE_PROCESS + 3);
    this.sampleOn             = sampleOn;
    this.reducedActionTypes   = [sampleOn];
    this.generatedActionTypes = [];
  }

  static fromJSON(d) {
    const r = new this({ sampleOn: d.sampleOn });
    r.id = d.id;
    return r;
  }

  toJSON() {
    return { ...super.toJSON(), sampleOn: this.sampleOn };
  }

  reduce(state) {
    const next = pppIndexUsdAud(state);
    const prev = state.fxPppIndex?.USD_AUD ?? 1;
    if (next == null || next === prev) return this.newState(state);
    return this.newState(state, { fxPppIndex: { ...(state.fxPppIndex ?? {}), USD_AUD: next } });
  }
}
