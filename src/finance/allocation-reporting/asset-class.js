/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ALLOCATION } from '../holdings/allocation.js';
import { RATE_KEYS }  from '../economic-regimes/rate-keys.js';

/**
 * ASSET_CLASS — the REPORTING taxonomy for "what kind of thing is this".
 *
 * This is deliberately a **superset of, and separate from, `ALLOCATION`**, and the
 * separation is the central design decision of the allocation report.
 *
 * `ALLOCATION` is a CLOSED four-value enum precisely because it is load-bearing:
 * every value must be handled by the rebalancer, the drawdown sleeve order, shock
 * revaluation and rateKey resolution, and a value none of them recognise is
 * silently excluded from all four rather than modelled (see allocation.js). Adding
 * `REAL_ESTATE` to it would oblige us to answer "does the rebalancer sell my
 * house?" — a question the report has no business forcing.
 *
 * But a report that shows only account holdings is answering a narrower question
 * than the one being asked. A plan whose net worth is 60% a single house is not a
 * 60/40 portfolio, and a chart that says it is, is lying by omission.
 *
 * So: ALLOCATION stays closed and authoritative inside the simulation; ASSET_CLASS
 * is a wider, purely descriptive vocabulary that exists only in reporting, maps
 * 1:1 from ALLOCATION for holdings, and extends it for the state entries that have
 * no allocation at all. Nothing in the sim reads this file.
 */
export const ASSET_CLASS = Object.freeze({
  // ── mapped 1:1 from ALLOCATION (account holdings) ──
  EQUITY:         'EQUITY',
  BOND:           'BOND',
  CASH:           'CASH',
  GOLD:           'GOLD',
  // ── report-only extensions (non-holding state entries) ──
  REAL_ESTATE:    'REAL_ESTATE',     // kind: 'real-property'
  PRIVATE_EQUITY: 'PRIVATE_EQUITY',  // kind: 'company' — an illiquid, undiversified stake
  COLLECTIBLE:    'COLLECTIBLE',     // kind: 'collectible' — art and the like, NOT bullion (that is GOLD)
  LIABILITY:      'LIABILITY',       // type: 'loan' — carried NEGATIVE, see allocation-cube.js
  UNKNOWN:        'UNKNOWN',         // could not be classified; surfaced, never dropped
});

/** Tuple of every ASSET_CLASS value, in a stable order fit for a chart legend. */
export const ASSET_CLASS_VALUES = Object.freeze(Object.values(ASSET_CLASS));

/**
 * Classes that represent a liability rather than an asset. A view computing a
 * *mix* must exclude these (an allocation is conventionally of gross assets, and a
 * negative slice renders as nonsense in a stacked area); a view computing a NET
 * line includes them and the signs take care of themselves.
 */
export const LIABILITY_CLASSES = Object.freeze(new Set([ASSET_CLASS.LIABILITY]));

/** ALLOCATION → ASSET_CLASS. Total over the closed enum, so a miss is a real bug. */
const CLASS_BY_ALLOCATION = Object.freeze({
  [ALLOCATION.EQUITY]: ASSET_CLASS.EQUITY,
  [ALLOCATION.BOND]:   ASSET_CLASS.BOND,
  [ALLOCATION.CASH]:   ASSET_CLASS.CASH,
  [ALLOCATION.GOLD]:   ASSET_CLASS.GOLD,
});

/**
 * Map a holding's ALLOCATION onto its reporting class.
 * Returns UNKNOWN rather than throwing: see the reporting-vs-simulation note in
 * allocation-cube.js — inside the sim an unrecognised allocation is a load-time
 * error, but a report's job is to make the anomaly visible, not to refuse to draw.
 */
export function assetClassForAllocation(allocation) {
  return CLASS_BY_ALLOCATION[allocation] ?? ASSET_CLASS.UNKNOWN;
}

/**
 * rateKey → the country whose market that return series tracks.
 *
 * This is what makes "allocation per country" a genuinely ambiguous request, and
 * why the cube emits TWO country columns. `account.country` is where the wrapper is
 * domiciled — the tax/jurisdiction view. The rateKey's country is what market the
 * money is actually exposed to. They can disagree: `rateKey` is authored per
 * holding, so a US brokerage may legitimately hold an `EQUITY_AU` sleeve, and the
 * two charts then tell different (both true) stories.
 *
 * GOLD and COLLECTIBLE are country-agnostic series (design 56 §7) and map to null,
 * which the cube reads as "no exposure country" rather than "unknown".
 */
const EXPOSURE_COUNTRY_BY_RATE_KEY = Object.freeze({
  [RATE_KEYS.EQUITY_US]:           'US',
  [RATE_KEYS.FIXED_INCOME_US]:     'US',
  [RATE_KEYS.SAVINGS_US]:          'US',
  [RATE_KEYS.PRIME_US]:            'US',
  [RATE_KEYS.REAL_ESTATE_US]:      'US',
  [RATE_KEYS.EQUITY_AU]:           'AU',
  [RATE_KEYS.FIXED_INCOME_AU]:     'AU',
  [RATE_KEYS.SAVINGS_AU]:          'AU',
  [RATE_KEYS.PRIME_AU]:            'AU',
  [RATE_KEYS.REAL_ESTATE_AU]:      'AU',
  // Design 90 §7.2 — the international sleeves are multi-country BY CONSTRUCTION, so
  // null is the honest answer rather than a missing entry: an ex-US basket has no single
  // exposure country, and forcing one would put Japan and Germany under a flag. The cube
  // reads null as "no exposure country", the same treatment gold already gets.
  //
  // This is the point at which the exposure-country axis stops being able to express
  // what the market axis knows. When the cube needs to say "40% international" it should
  // read the rate key directly rather than have a country invented for it here.
  [RATE_KEYS.EQUITY_INTL_EX_US]:   null,
  [RATE_KEYS.EQUITY_INTL_EX_AU]:   null,
  [RATE_KEYS.GOLD]:                null,
  [RATE_KEYS.COLLECTIBLE]:         null,
});

/**
 * The market-exposure country a rateKey implies, or `undefined` when the key is
 * unrecognised (distinct from the deliberate `null` of a country-agnostic series).
 *
 * Holdings can only ever carry a canonical bare key — `Holding`'s constructor
 * rejects anything outside RATE_KEYS — so the per-account `<memberKey>::<stateKey>`
 * extension of design 55 §8 can never reach this map from a holding. The `::` split
 * is defensive only, for callers passing a state-side effective-rate key.
 */
export function exposureCountryForRateKey(rateKey) {
  if (rateKey == null) return undefined;
  const bare = String(rateKey).split('::')[0];
  return Object.hasOwn(EXPOSURE_COUNTRY_BY_RATE_KEY, bare)
    ? EXPOSURE_COUNTRY_BY_RATE_KEY[bare]
    : undefined;
}
