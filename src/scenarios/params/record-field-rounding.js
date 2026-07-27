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
 * Whole-number coercion for the param→record cascade.
 *
 * Shared by the two cascade implementations — `ScenarioLoader._applyParamNode`
 * (the load/Rebuild path) and `BaseScenario.applyParams` (the cheap in-place
 * rebuild) — so a field is rounded identically no matter which one runs.
 */

/**
 * Asset-record fields (real property / collectible / company equity) the param
 * cascade should round to a whole number: dollar amounts and calendar years.
 * Fractional fields (rates, ratios) must NOT be listed — Math.round on a 0.04
 * appreciation rate would zero it, silently killing the asset's growth.
 */
export const WHOLE_NUMBER_RECORD_FIELDS = new Set([
  'value', 'plannedSaleYear', 'costBasis', 'mortgageBalance',
]);

/**
 * @param {string} field - the record property being written
 * @param {*}      val   - the param value (null/undefined pass through untouched)
 * @returns {*} the value, rounded when `field` is a whole-number field
 */
export function roundRecordField(field, val) {
  if (val == null) return val;
  return WHOLE_NUMBER_RECORD_FIELDS.has(field) ? Math.round(val) : val;
}
