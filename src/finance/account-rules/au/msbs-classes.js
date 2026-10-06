/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * msbs-classes.js — the preserved MSBS employer benefit through the run, before the
 * election (design 119 §6.4, phase 4). The rules are in `msbs.js`.
 *
 *   - `MsbsFundedEarningsHandler` + `MsbsFundedEarningsApplyReducer`: the funded part earns
 *     the Balanced option's return once a year, on the same year-end event as the member's
 *     fund, so the two sleeves move on the same dates.
 *   - `MsbsUnfundedIndexReducer`: on the AU period advance (1 July, r 61D(b)), the unfunded
 *     part rises by CPI on the never-falls rule (r 61A). It runs after the inflation
 *     reducer, so it reads the year's new CPI level.
 *
 * Both stop at the election: from then the benefit is paid, which is phase 5's.
 */

import { HandlerEntry } from '../../../simulation-framework/handlers.js';
import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { isMsbs, msbsElectionMs, fundedSleeveReturn, indexUnfundedBenefit,
  MSBS_DEFAULT_FUNDED_ALLOCATION } from './msbs.js';
import { superMemberKey } from './super-release.js';

/** Is the benefit still preserved on `date` (no election yet)? */
function preservedOn(state, account, date) {
  const key = superMemberKey(state, account?.ownerId ?? null);
  const election = msbsElectionMs(account, key != null ? state.people[key]?.birthDate : null);
  return election == null || +date < election;
}

export class MsbsFundedEarningsHandler extends HandlerEntry {
  static type        = 'MsbsFundedEarningsHandler';
  static description = 'Grows a preserved MSBS funded employer benefit by a year of the Balanced option\'s return, net of the fund\'s 15% on income, and emits MSBS_FUNDED_EARNINGS_APPLY.';
  static eventType   = 'INTL_SUPER_EARNINGS';

  constructor({ stateKey = null } = {}) {
    super(null, 'MSBS Funded Earnings');
    this.stateKey = stateKey;
    this.generatedActionTypes = ['MSBS_FUNDED_EARNINGS_APPLY'];
  }

  static fromJSON(d) {
    const h = new this({ stateKey: d.stateKey ?? null });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return { ...super.toJSON(), stateKey: this.stateKey };
  }

  call({ state, date }) {
    const a  = state?.[this.stateKey];
    const eb = a?.employerBenefit;
    if (!isMsbs(a) || !eb || !(eb.funded > 0) || !preservedOn(state, a, date)) return [];
    const rate   = fundedSleeveReturn(state, eb.fundedAllocation ?? MSBS_DEFAULT_FUNDED_ALLOCATION);
    const amount = +(eb.funded * rate).toFixed(2);
    return amount === 0 ? [] : [{ type: 'MSBS_FUNDED_EARNINGS_APPLY', stateKey: this.stateKey, amount, rate }];
  }
}

export class MsbsFundedEarningsApplyReducer extends Reducer {
  static type        = 'MsbsFundedEarningsApplyReducer';
  static description = 'Credits a year\'s net return to a preserved MSBS funded employer benefit (never below zero).';
  static actionType  = 'MSBS_FUNDED_EARNINGS_APPLY';

  constructor() {
    super('MSBS Funded Earnings Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['MSBS_FUNDED_EARNINGS_APPLY'];
  }

  reduce(state, action) {
    const a = state[action.stateKey];
    if (!a?.employerBenefit) return this.newState(state);
    const funded = Math.max(0, +(a.employerBenefit.funded + action.amount).toFixed(2));
    return this.newState(state, {
      [action.stateKey]: { ...a, employerBenefit: { ...a.employerBenefit, funded } },
    });
  }
}

export class MsbsUnfundedIndexReducer extends Reducer {
  static type        = 'MsbsUnfundedIndexReducer';
  static description = 'On each AU period advance (1 July), raises every preserved MSBS unfunded employer benefit by the rise in AU CPI over its highest earlier level, rounded to 0.1% (MSBS Rules r 61A, 61E(3)).';
  static actionType  = null;

  constructor() {
    // After InflationAdjustReducer (PRE_PROCESS + 2), which advances `cpiAccumulator`.
    super('MSBS Unfunded Index', PRIORITY.PRE_PROCESS + 3);
    this.reducedActionTypes = ['AU_PERIOD_ADVANCE'];
  }

  reduce(state, action, date) {
    const cpiNow = state.cpiAccumulator?.AU;
    if (!(cpiNow > 0)) return this.newState(state);
    const patch = {};
    for (const [key, a] of Object.entries(state)) {
      const eb = a?.employerBenefit;
      if (!isMsbs(a) || !eb || !preservedOn(state, a, date)) continue;
      const next = indexUnfundedBenefit(eb.unfunded ?? 0, cpiNow, eb.cpiPeak ?? 1);
      if (next.cpiPeak === eb.cpiPeak && next.unfunded === eb.unfunded) continue;
      patch[key] = { ...a, employerBenefit: { ...eb, unfunded: next.unfunded, cpiPeak: next.cpiPeak } };
    }
    return this.newState(state, patch);
  }
}
