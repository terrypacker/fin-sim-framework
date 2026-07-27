/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Inheritance metadata shared by promoted inherited records (design 63 §14).
 *
 * When an inherited brokerage / real-property / collectible asset is promoted to
 * a first-class service record (design 63 §14 "promote-to-real-records"), it is a
 * normal Account / RealProperty / Collectible tagged with these fields. They mark
 * the record as inherited (so the INHERITANCE toolset can find it by `bequestId`
 * and fund it at the inheritance date) and carry the basis anchors the INHERIT
 * reducer stamps (§6.1/§6.3/§7). The record seeds at value/balance 0; the FMV
 * rides in `inheritedValue` and is applied by the `INHERIT` event at the date.
 *
 *   inherited                  — true ⇒ this is a promoted inherited record.
 *   bequestId                  — id of the owning Bequest (the decedent/date/tax descriptor).
 *   inheritedValue             — FMV at death, funded into balance/value on INHERIT.
 *   deceasedCostBase           — AU inherited cost base (no step-up); null ⇒ US step-up only.
 *   deceasedAcquisitionDate    — deceased's acquisition date (ms) for the AU discount/indexation clock.
 *   inheritedFromMainResidence — AU deceased main-residence 2-year CGT exemption (property).
 *
 * A promoted inherited RETIREMENT account (design 63 §15) additionally carries its
 * SECURE 10-year drawdown knobs here — they are inheritance-specific (an owned
 * account never has them) and must travel onto the domain object so the INHERITANCE
 * toolset's `_inheritedRaAccounts` can read them off `accountService.getAll()`:
 *   distributionMode — SECURE strategy id (equal/lump/maxDefer/bracketFill/weights).
 *   fillCeiling      — bracketFill ordinary-income ceiling (real base-year USD).
 *   lumpYear         — lump strategy: the window year 0–9 to distribute the whole balance.
 *   weights          — weights strategy: a 10-element distribution vector.
 */
export const INHERITANCE_META_FIELDS = Object.freeze([
  'inherited',
  'bequestId',
  'inheritedValue',
  'deceasedCostBase',
  'deceasedAcquisitionDate',
  'inheritedFromMainResidence',
  'distributionMode',
  'fillCeiling',
  'lumpYear',
  'weights',
]);

/**
 * Apply the inheritance metadata from `opts` onto a domain record instance, with
 * back-compat defaults so a non-inherited record is byte-for-byte unchanged.
 * @param {object} target - the domain instance (Account / RealProperty / Collectible)
 * @param {object} [opts]
 * @returns {object} target
 */
export function applyInheritanceMeta(target, opts = {}) {
  target.inherited                  = opts.inherited                  ?? false;
  target.bequestId                  = opts.bequestId                  ?? null;
  target.inheritedValue             = opts.inheritedValue             ?? null;
  target.deceasedCostBase           = opts.deceasedCostBase           ?? null;
  target.deceasedAcquisitionDate    = opts.deceasedAcquisitionDate    ?? null;
  target.inheritedFromMainResidence = opts.inheritedFromMainResidence ?? false;
  // Promoted inherited-RA SECURE-drawdown knobs (design 63 §15); null on every other
  // inherited/owned record.
  target.distributionMode           = opts.distributionMode           ?? null;
  target.fillCeiling                = opts.fillCeiling                 ?? null;
  target.lumpYear                   = opts.lumpYear                    ?? null;
  target.weights                    = opts.weights                    ?? null;
  return target;
}

/**
 * Serialize the inheritance metadata for a record, or `null` when the record is
 * not inherited (so ALL existing records round-trip byte-for-byte — the serializer
 * emits nothing). Optional fields are emitted only when set.
 * @param {object} record
 * @returns {object|null} a partial serialized object to merge, or null
 */
export function serializeInheritanceMeta(record) {
  if (!record?.inherited) return null;
  const d = { inherited: true, bequestId: record.bequestId ?? null };
  if (record.inheritedValue          != null) d.inheritedValue          = record.inheritedValue;
  if (record.deceasedCostBase        != null) d.deceasedCostBase        = record.deceasedCostBase;
  if (record.deceasedAcquisitionDate != null) d.deceasedAcquisitionDate = record.deceasedAcquisitionDate;
  if (record.inheritedFromMainResidence)      d.inheritedFromMainResidence = true;
  // Promoted inherited-RA SECURE-drawdown knobs (design 63 §15) — emitted only when set.
  if (record.distributionMode        != null) d.distributionMode        = record.distributionMode;
  if (record.fillCeiling             != null) d.fillCeiling             = record.fillCeiling;
  if (record.lumpYear                != null) d.lumpYear                = record.lumpYear;
  if (record.weights                 != null) d.weights                 = record.weights;
  return d;
}
