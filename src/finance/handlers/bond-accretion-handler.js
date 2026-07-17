/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { RecordBalanceAction, RecordMetricAction } from '../../simulation-framework/actions.js';
import { RATE_KEYS } from '../economic-regimes/rate-keys.js';
import { computeHoldingsAccretion } from '../holdings/holdings-earnings.js';

/**
 * Handles BOND_ACCRETION events — the imputed, non-cash principal growth of a
 * zero-coupon/OID bond or a TIPS held in ANY account (brokerage / 401k / IRA /
 * Roth / super / au-stock). Design 66 §G5 (TIPS) + §G6 (zero-coupon/OID).
 *
 * Sibling of {@link BondSleeveCouponHandler}: a zero pays no cash coupon and a TIPS
 * pays its cash coupon separately (via the coupon streams, on the grown principal),
 * so this stream carries only the *accretion* — the annual OID / inflation
 * adjustment — which is currently-taxable ordinary income despite no cash being
 * received ("phantom income"). It reinvests the accretion into the sleeve, stepping
 * up BOTH marketValue and costBasis (computeHoldingsAccretion), and dispatches
 * BOND_ACCRETION_APPLY carrying the account's `taxMode`:
 *   - 'us'       → US ordinary income (federal + NIIT + state, Treasury/muni split),
 *                  AU-FITO aware when AU-resident — via the shared BOND_COUPON_TAX chain;
 *   - 'au'       → AU ordinary income (chains AU_SAVINGS_EARNINGS_TAX);
 *   - 'deferred' → tax-deferred/free wrapper (401k/IRA/Roth/super): balance only,
 *                  taxed (or not, for Roth) on the eventual withdrawal.
 *
 * The TIPS indexation rate is the advancing country's period CPI rate; `country`
 * selects US vs AU (state.cpiRates → effectiveInflationRates → inflationRates). The
 * zero-coupon OID needs the as-of date, read from state.currentPeriods[country].
 *
 * @param {object} opts
 * @param {import('../services/state-registry.js').StateRegistry} opts.stateRegistry
 * @param {string} opts.role          - ACCOUNT_ROLES value for the account
 * @param {string} [opts.ownerId]     - Person id (null = any owner)
 * @param {string} [opts.stateKey]    - Specific account this handler accrues to
 * @param {'US'|'AU'} [opts.country='US'] - CPI/as-of country for the accretion
 * @param {'us'|'au'|'deferred'} [opts.taxMode='deferred'] - Tax treatment of the accretion
 */
export class BondAccretionHandler extends HandlerEntry {
  static description = 'Computes non-cash bond accretion (zero-coupon OID + TIPS inflation indexation) on an account\'s BOND holdings, reinvests it (stepping up marketValue AND costBasis), and dispatches BOND_ACCRETION_APPLY with the account\'s taxMode (us / au / deferred).';
  static type        = 'BondAccretionHandler';
  static eventType   = 'BOND_ACCRETION';
  // Carried for serialization symmetry only — accretion is derived from the holding's
  // own fields (OID from basis/face/maturity; TIPS from the period CPI rate).
  static rateKey     = RATE_KEYS.FIXED_INCOME_US;

  constructor({ stateRegistry, role, ownerId = null, stateKey = null, country = 'US', taxMode = 'deferred', rateKey = null } = {}) {
    super(null, 'Bond Accretion');
    this.stateRegistry  = stateRegistry;
    this.role           = role;
    this.ownerId        = ownerId;
    this._stateKeyFixed = stateKey;
    this.country        = country;
    this.taxMode        = taxMode;
    this.rateKey        = rateKey ?? new.target.rateKey;
    this.generatedActionTypes = ['BOND_ACCRETION_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({
      stateRegistry, role: d.role, ownerId: d.ownerId ?? null, stateKey: d.stateKey ?? null,
      country: d.country ?? 'US', taxMode: d.taxMode ?? 'deferred', rateKey: d.rateKey ?? null,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(), role: this.role, ownerId: this.ownerId, stateKey: this._stateKeyFixed,
      country: this.country, taxMode: this.taxMode, rateKey: this.rateKey,
    };
  }

  call({ state }) {
    const stateKey = this._stateKeyFixed ?? this.stateRegistry.getStateKey(this.role, this.ownerId);
    const cc       = this.country;
    const cpiRate  = state.cpiRates?.[cc]
      ?? state.effectiveInflationRates?.[cc]
      ?? state.inflationRates?.[cc] ?? 0;
    const asOfMs   = state.currentPeriods?.[cc]?.startMs ?? null;

    const { amount, federalTaxableAmount, stateTaxableAmount, holdingActions } = computeHoldingsAccretion({
      state, stateKey, cpiRate, currentDate: asOfMs,
    });
    // Accretion can be zero (no accreting bonds) or negative (TIPS deflation).
    if (amount === 0) return [new RecordBalanceAction(`${stateKey}.balance`, stateKey)];

    const account   = state[stateKey];
    const residency = account?.ownerId
      ? (state.people?.[account.ownerId]?.residency ?? null)
      : (state.people?.[Object.keys(state.people ?? {})[0]]?.residency ?? null);

    return [
      { type: 'BOND_ACCRETION_APPLY', amount, federalTaxableAmount, stateTaxableAmount, stateKey, taxMode: this.taxMode, residency },
      ...holdingActions,
      new RecordMetricAction('bond_accretion', amount),
      new RecordBalanceAction(`${stateKey}.balance`, stateKey),
    ];
  }
}
