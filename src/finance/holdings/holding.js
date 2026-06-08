/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Holding — plain-data record of a single position inside an Account.
 *
 * An Account exposes a denormalized `balance` scalar, but the source of truth
 * is `account.holdings: Holding[]`. The invariant
 *   account.balance === Σ holdings[i].marketValue   (currency-rounded)
 * is maintained by the holdings reducers (see holding-reducers.js#_syncBalance).
 *
 * No methods — safe for structuredClone snapshots. Logic that needs to read
 * derived values (unrealizedGainLoss) lives on AccountService.
 *
 * Round-trips via TypeRegistry: toJSON / static fromJSON.
 */
export class Holding {
  static type = 'Holding';

  /**
   * @param {object}  [opts]
   * @param {string|null} [opts.id=null]            - Assigned by AccountService on registration
   * @param {string}      opts.allocation           - ALLOCATION value (EQUITY | BOND | CASH | OTHER)
   * @param {number}      [opts.marketValue=0]      - Current market value
   * @param {number}      [opts.costBasis=0]        - Tax basis for gain/loss computation
   * @param {Date|null}   [opts.purchaseDate=null]  - Acquisition date; null = "carried in from scenario boot"
   * @param {string|null} [opts.rateKey=null]       - Lookup into state.effectiveGrowthRates; resolved on register if null
   * @param {string}      [opts.label='']           - Optional display label ("ITOT", "BND")
   * @param {number|null} [opts.dividendYield=null] - Per-holding annual dividend yield; null = fall back to the
   *                                                  dividend handler's account-level rate (design 28 §7)
   * @param {Array<{date: Date|string, rate: number}>|null} [opts.appreciationSchedule=null]
   *                                                - Step-wise appreciation schedule; null = use asset scalar rate
   * @param {number|null} [opts.duration=null]      - Modified duration in years (BOND holdings only);
   *                                                  null = fall back to RATE_KEY_META[rateKey].defaultDuration ?? 0
   * @param {string|null} [opts.taxLossPartner=null] - Holding id of the substitute to rebuy after a tax-loss harvest
   *                                                   (design 29 §3.3). Null = fall back to same-rateKey search.
   */
  constructor({
    id                   = null,
    allocation,
    marketValue          = 0,
    costBasis            = 0,
    purchaseDate         = null,
    rateKey              = null,
    label                = '',
    dividendYield        = null,
    appreciationSchedule = null,
    duration             = null,
    taxLossPartner       = null,
  } = {}) {
    this.id                   = id;
    this.allocation           = allocation;
    this.marketValue          = marketValue;
    this.costBasis            = costBasis;
    this.purchaseDate         = purchaseDate;
    this.rateKey              = rateKey;
    this.label                = label;
    this.dividendYield        = dividendYield;
    this.appreciationSchedule = appreciationSchedule;
    this.duration             = duration;
    this.taxLossPartner       = taxLossPartner;
  }

  toJSON() {
    return {
      __type:              this.constructor.type,
      id:                  this.id,
      allocation:          this.allocation,
      marketValue:         this.marketValue,
      costBasis:           this.costBasis,
      purchaseDate:        this.purchaseDate ? this.purchaseDate.toISOString() : null,
      rateKey:             this.rateKey,
      label:               this.label,
      dividendYield:       this.dividendYield,
      appreciationSchedule: this.appreciationSchedule
        ? this.appreciationSchedule.map(e => ({
            date: e.date instanceof Date ? e.date.toISOString() : e.date,
            rate: e.rate,
          }))
        : null,
      duration:            this.duration,
      taxLossPartner:      this.taxLossPartner,
    };
  }

  static fromJSON(d, _ctx) {
    return new Holding({
      id:            d.id ?? null,
      allocation:    d.allocation,
      marketValue:   d.marketValue ?? 0,
      costBasis:     d.costBasis   ?? 0,
      purchaseDate:  d.purchaseDate ? new Date(d.purchaseDate) : null,
      rateKey:       d.rateKey ?? null,
      label:         d.label   ?? '',
      dividendYield: d.dividendYield ?? null,
      appreciationSchedule: d.appreciationSchedule
        ? d.appreciationSchedule.map(e => ({ date: new Date(e.date), rate: e.rate }))
        : null,
      duration:      d.duration ?? null,
      taxLossPartner: d.taxLossPartner ?? null,
    });
  }
}
