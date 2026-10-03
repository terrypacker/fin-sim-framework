/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { toSaleDate } from '../year-date-migration.js';

/**
 * Whole-number coercion and date-backed lever fields for the param→record cascade.
 *
 * Shared by the two cascade implementations — `ScenarioLoader._applyParamNode`
 * (the load/Rebuild path) and `BaseScenario.applyParams` (the cheap in-place
 * rebuild) — so a field is rounded and converted identically no matter which one runs.
 */

/**
 * Asset-record fields (real property / collectible / company equity) the param
 * cascade should round to a whole number: dollar amounts.
 * Fractional fields (rates, ratios) must NOT be listed — Math.round on a 0.04
 * appreciation rate would zero it, silently killing the asset's growth.
 */
export const WHOLE_NUMBER_RECORD_FIELDS = new Set([
  'value', 'costBasis', 'mortgageBalance', 'monthlyRent',
]);

/**
 * Asset-record DATE fields (design 117): the cascade writes them as 'YYYY-MM-DD', so a
 * swept value that arrives as a Date or a full ISO string lands in the record's own form.
 */
export const DATE_RECORD_FIELDS = new Set(['plannedSaleDate', 'purchaseDate', 'inheritanceDate',
  'k401ToIraConversionDate', 'mainResidenceFrom']);

/**
 * @param {string} field - the record property being written
 * @param {*}      val   - the param value (null/undefined pass through untouched)
 * @returns {*} the value, rounded when `field` is a whole-number field, a 'YYYY-MM-DD'
 *              day when it is a date field
 */
export function roundRecordField(field, val) {
  if (val == null) return val;
  if (DATE_RECORD_FIELDS.has(field)) return toSaleDate(val);
  return WHOLE_NUMBER_RECORD_FIELDS.has(field) ? Math.round(val) : val;
}
