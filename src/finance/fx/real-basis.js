/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { countryForCurrency } from '../country-codes.js';

/**
 * The rates a USD figure needs to be shown in real base-year money of ANY display
 * currency, captured at the instant the figure was measured — design 79 §9.
 *
 * Monte Carlo and optimizer results have no journal to recover a price level from and
 * no single state to read one off: each path is its own world, with its own inflation
 * and (under stochastic FX) its own exchange rate. So the rates travel WITH the figure.
 * Both countries' levels are kept because which one applies is a DISPLAY decision —
 * the country of the currency on screen (§7) — made long after the run.
 *
 * @param {object} state
 * @returns {{ priceLevels: { US?: number, AU?: number }, usdAud: number|null }}
 */
export function realRatesOf(state) {
  const acc = state?.inflationAccumulator ?? {};
  const priceLevels = {};
  for (const cc of ['US', 'AU']) if (typeof acc[cc] === 'number') priceLevels[cc] = acc[cc];
  return { priceLevels, usdAud: state?.effectiveExchangeRates?.USD_AUD ?? null };
}

/**
 * A USD figure, restated in real base-year money of `displayCurrency` using the rates
 * captured WITH it: converted at that instant's rate, divided by that instant's price
 * level for the display currency's country (design 79 §7).
 *
 * Null when the rates cannot say — no capture (a result from before design 79), no
 * level for that country, no rate for a cross-currency view. Never an assumed 1.0: a
 * caller that gets null shows the nominal figure and says so.
 *
 * @param {number} amountUsd
 * @param {{ priceLevels?: object, usdAud?: number|null }|null|undefined} rates
 * @param {string} displayCurrency
 * @returns {number|null}
 */
export function realFromUsd(amountUsd, rates, displayCurrency) {
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || !rates) return null;
  const level = rates.priceLevels?.[countryForCurrency(displayCurrency)];
  if (!(level > 0)) return null;
  const fx = displayCurrency === 'USD' ? 1
           : displayCurrency === 'AUD' ? rates.usdAud
           : null;
  if (!(fx > 0)) return null;
  return amountUsd * fx / level;
}
