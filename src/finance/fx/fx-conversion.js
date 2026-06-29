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
 * Shared cross-currency (USD↔AUD) cash-conversion math, so the inline cash sweep
 * in `AccountService.replenishSavings` and the `IntlTransferApplyReducer` apply
 * IDENTICAL rate + fee arithmetic and cannot drift (design 44 §5a).
 *
 * Conventions (both read from sim state):
 *   rate   = USD_AUD — 1 USD = `rate` AUD          (state.effectiveExchangeRates.USD_AUD)
 *   feeUsd = flat per-transfer fee in USD          (state.effectiveFxFees.USD_AUD)
 *
 * A same-currency move (fromCcy === toCcy) converts 1:1 and pays no fee. Any
 * currency other than 'AUD' is treated as USD-denominated (1:1 with USD), matching
 * the historical behaviour of both call sites.
 */

/** Units of `toCcy` obtained per 1 unit of `fromCcy` (1 when same currency). */
export function fxRate(fromCcy, toCcy, rate) {
  if (fromCcy === toCcy) return 1;
  const usdPerUnit  = (c) => (c === 'AUD' ? 1 / rate : 1); // value of 1 unit in USD
  const unitsPerUsd = (c) => (c === 'AUD' ? rate : 1);     // units of c per 1 USD
  return usdPerUnit(fromCcy) * unitsPerUsd(toCcy);
}

/** The flat per-transfer fee expressed in `toCcy` (0 for a same-currency move). */
export function fxFeeIn(toCcy, fromCcy, rate, feeUsd) {
  if (fromCcy === toCcy) return 0;
  return toCcy === 'AUD' ? feeUsd * rate : feeUsd;
}

/**
 * Net `toCcy` received for a known `sourceAmount` of `fromCcy`, after the fee:
 *   credited = sourceAmount · fx − feeInTarget
 */
export function convertNetOfFee(sourceAmount, fromCcy, toCcy, rate, feeUsd) {
  return sourceAmount * fxRate(fromCcy, toCcy, rate) - fxFeeIn(toCcy, fromCcy, rate, feeUsd);
}

/**
 * `fromCcy` amount that must be drawn to net `targetAmount` of `toCcy` after the
 * fee (the gross-up):
 *   sourceNeeded = (targetAmount + feeInTarget) / fx
 */
export function grossUpForTarget(targetAmount, fromCcy, toCcy, rate, feeUsd) {
  return (targetAmount + fxFeeIn(toCcy, fromCcy, rate, feeUsd)) / fxRate(fromCcy, toCcy, rate);
}
