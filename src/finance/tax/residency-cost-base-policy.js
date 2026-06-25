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
 * Per-country policy: does becoming a tax resident of this country reset
 * ("step up") the cost base of the new resident's non-TAP CGT assets to market
 * value on the residency date?
 *
 * Australia does (ITAA 1997 s855-45: a person becoming an AU resident is taken
 * to have acquired their non-Taxable-Australian-Property assets at market value
 * on the residency date). The US does not — a US citizen keeps their original
 * basis worldwide. Add an entry here when a new country's tax module lands; the
 * step-up machinery (AccountService.recordResidencyChange, consumeHoldingsFifo)
 * is country-agnostic and reads only this flag. See design 36 §12.2.
 *
 * @type {Readonly<Record<string, boolean>>}  keyed by ISO country code
 */
export const RESIDENCY_COST_BASE_STEP_UP = Object.freeze({
  AU: true,
});

/**
 * @param {string} country - ISO country code (e.g. 'AU')
 * @returns {boolean} true if becoming resident of `country` steps up the AU-style
 *   non-TAP cost base to market value on the residency date.
 */
export function stepsUpCostBaseOnResidency(country) {
  return RESIDENCY_COST_BASE_STEP_UP[country] === true;
}
