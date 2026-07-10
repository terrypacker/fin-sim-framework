/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { HandlerEntry }      from '../../../simulation-framework/handlers.js';
import { ACCOUNT_ROLES }     from '../../state/account-roles.js';

/**
 * AU CGT reform — 1 July 2027 deemed cost base reset (design 57 §6.4, Method 1).
 *
 * On 1 July 2027 the CGT reform makes each pre-existing asset's market value the
 * deemed cost base going forward, so only post-2027 gains are assessable (pre-2027
 * gains remain exempt). We model this by restamping each AU-taxable holdings-based
 * lot (role AU_STOCK):
 *
 *   - costBaseByCountry.AU  ← lot.marketValue  (deemed cost base at the reset date)
 *   - acquisitionPriceLevel ← inflationAccumulator.AU  (indexation base = July 2027)
 *
 * purchaseDate is intentionally NOT changed: the reform's 12-month indexation
 * eligibility test runs from *original* acquisition, while indexation itself runs
 * from the deemed cost base / July-2027 price level. Together this makes the AU
 * gain on a later sale measure only the post-2027 (indexed) appreciation.
 *
 * The US cost base (`costBasis`) is untouched — the US does not reset, so the
 * dual-cost-base (design 36 §12.2) US/AU split is preserved.
 *
 * Property (real estate) reset is deferred (design 57 §6.4) along with property
 * indexation, so only AU_STOCK holdings are reset here.
 */
export class AuCgtBasisResetHandler extends HandlerEntry {
  static type        = 'AuCgtBasisResetHandler';
  static description  = 'On AU_CGT_BASIS_RESET (1 Jul 2027), dispatches AU_CGT_BASIS_RESET_APPLY.';
  static eventType    = 'AU_CGT_BASIS_RESET';

  constructor() {
    super(null, 'AU CGT Basis Reset');
    // handledEvents stays empty; the runtime binds this handler to its event via
    // the static eventType (direct-wired style, like the *PeriodAdvance handlers).
    this.generatedActionTypes = ['AU_CGT_BASIS_RESET_APPLY'];
  }

  call() {
    return [{ type: 'AU_CGT_BASIS_RESET_APPLY' }];
  }
}

export class AuCgtBasisResetReducer extends Reducer {
  static type        = 'AuCgtBasisResetReducer';
  static description  = 'Resets AU_STOCK lots\' AU cost base to market value and stamps the July-2027 indexation base level (design 57 §6.4).';
  static actionType  = 'AU_CGT_BASIS_RESET_APPLY';

  constructor({ accountService } = {}) {
    super('AU CGT Basis Reset Apply', PRIORITY.PRE_PROCESS);
    this.accountService     = accountService;
    this.reducedActionTypes = ['AU_CGT_BASIS_RESET_APPLY'];
  }

  static fromJSON(d, { accountService }) {
    const r = new this({ accountService });
    r.id = d.id;
    return r;
  }

  reduce(state) {
    const auLevel = state.inflationAccumulator?.AU ?? 1;
    const patches = {};
    for (const account of this.accountService?.getAll?.() ?? []) {
      if (account.role !== ACCOUNT_ROLES.AU_STOCK) continue;
      const slice = state[account.stateKey];
      if (!slice || !Array.isArray(slice.holdings)) continue;
      patches[account.stateKey] = {
        ...slice,
        holdings: slice.holdings.map(h => h ? {
          ...h,
          costBaseByCountry:     { ...(h.costBaseByCountry ?? {}), AU: h.marketValue ?? 0 },
          acquisitionPriceLevel: auLevel,
        } : h),
      };
    }
    return this.newState({ ...state, ...patches });
  }
}
