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
 * The 1 July 2027 deemed sale for real property (design 132 §7; ITAA 1997 s112-155).
 *
 * A dwelling differs from a lot in three ways, and each one is a function here:
 *
 *   1. s112-155(1)(d). An AU dwelling is taxable Australian property, so the s855-45
 *      residency step-up never restarts its clock. An owner who was a foreign resident at
 *      any time after 8 May 2012 while holding it makes s115-105 apply, and the dwelling
 *      is NOT deemed sold. The realisation event is part of that test, so the sale has to
 *      run it again (`deemedSaleHolds`).
 *   2. The main-residence exemption is a day count. The deemed sale ends one ownership
 *      period on 30 June 2027 and the reacquisition starts another (s112-155(2), Note 1),
 *      so each gain takes the exempt fraction of its own days (`windowTaxableFractions`).
 *   3. Depreciation and improvements accrue across the date, so the stamp records where
 *      both stood.
 *
 * The stamp is a record on the property (`auDeemedSale2027`), not a rebase, because the
 * sale may still have to ignore it. Leaf module: it imports only other leaves.
 */

import { AU_DEEMED_SALE_MS } from './au-cgt-2027-constants.js';
import { ownershipFractions } from '../../ownership-utils.js';
import { primaryPersonKey }   from '../../residency-utils.js';
import { isMainResidenceThroughout, mainResidenceWindow, toMs } from '../../account-rules/main-residence.js';

/** s115-105(2)(d)–(e): only foreign residence AFTER 8 May 2012 counts. */
export const S115_105_EPOCH_MS = Date.UTC(2012, 4, 9);

const SIX_YEARS_MS = 6 * 365 * 24 * 60 * 60 * 1000;

/** The dwelling's AU acquisition instant: the s855-45 deemed date when stamped, else its purchase. */
export function propertyAuAcquisitionMs(prop) {
  return toMs(prop?.acquisitionDateByCountry?.AU) ?? toMs(prop?.acquisitionDate);
}

/**
 * s112-155(1)(d) for one owner: s115-105 would NOT apply, i.e. the owner was an AU
 * resident for every day of the holding after 8 May 2012. The model has one residency
 * interval per person (`residencySinceMs` to now), so this is a comparison of its start.
 * An unknown acquisition passes only when the owner has always been resident.
 */
export function ownerPassesS112_155d(person, acquisitionMs) {
  if (person?.residency !== 'AU') return false;
  const since = toMs(person.residencySinceMs);
  if (since == null) return true;
  if (acquisitionMs == null) return since <= S115_105_EPOCH_MS;
  return since <= Math.max(acquisitionMs, S115_105_EPOCH_MS);
}

/** The dwelling's owners with a positive share, falling back to the primary person. */
function _ownerKeys(state, prop) {
  const people = state.people ?? {};
  const keys = ownershipFractions(prop, people).filter(o => o.fraction > 0).map(o => o.personKey);
  if (keys.length > 0) return keys;
  const primary = primaryPersonKey(state);
  return primary != null ? [primary] : [];
}

/**
 * Whether the stamp reaches this property at all: a dwelling with a value, acquired (for
 * AU purposes) before the date or undated. A US dwelling has an AU cost base only once the
 * s855-45 step-up stamped one; without it Australia never measures its gain.
 */
export function isDeemedSaleProperty(a) {
  if (a?.kind !== 'real-property' || a.auDeemedSale2027 != null) return false;
  if (!((a.value ?? 0) > 0)) return false;
  if (a.country === 'US' && a.costBaseByCountry?.AU == null) return false;
  const acq = propertyAuAcquisitionMs(a);
  return acq == null || acq < AU_DEEMED_SALE_MS;
}

/**
 * Why the deemed sale does not reach this dwelling, or null when it does (design 132 §7.2).
 * Every owner must pass, because one cost base cannot carry a deferral for half the owners.
 */
export function deemedSaleExclusion(state, prop) {
  const acq = propertyAuAcquisitionMs(prop);
  const people = state.people ?? {};
  const owners = _ownerKeys(state, prop);
  if (owners.length === 0) return 'not-au-resident';
  const resident = owners.map(k => people[k]?.residency === 'AU');
  if (resident.every(r => !r)) return 'not-au-resident';
  const passes = owners.map(k => ownerPassesS112_155d(people[k], acq));
  if (passes.every(Boolean)) return null;
  if (passes.some(Boolean)) return 'mixed-owner-residency';
  return resident.every(Boolean) ? 's115-105-applies' : 'mixed-owner-residency';
}

/** The record the 1 July 2027 advance writes on a dwelling (design 132 §7.2). */
export function stampDeemedSaleProperty(state, prop, auLevel) {
  const exclusion = deemedSaleExclusion(state, prop);
  return {
    ...prop,
    auDeemedSale2027: {
      applied:                 exclusion == null,
      ...(exclusion != null ? { reason: exclusion } : {}),
      value:                   +(+prop.value).toFixed(2),
      priceLevel:              auLevel,
      accumulatedDepreciation: prop.accumulatedDepreciation ?? 0,
      capitalizedImprovements: prop.capitalizedImprovements ?? 0,
    },
  };
}

/**
 * The stamp as the sale sees it: the record when the deemed sale still holds, else null.
 * s112-155(1)(d) is tested at the realisation event, so an owner who left Australia after
 * 2027 (or whose residency restarted) undoes it.
 */
export function deemedSaleHolds(state, prop) {
  const rec = prop?.auDeemedSale2027;
  if (rec?.applied !== true) return null;
  const acq = propertyAuAcquisitionMs(prop);
  const people = state.people ?? {};
  const owners = _ownerKeys(state, prop);
  return owners.length > 0 && owners.every(k => ownerPassesS112_155d(people[k], acq)) ? rec : null;
}

/**
 * True when s960-275(1B) leaves the pre-2027 cost base unindexed: a dwelling the stamp
 * examined whose deemed sale does not hold (design 132 §7.4). A dwelling never examined —
 * a scenario that starts after the date — keeps the back-cast, because nothing is known.
 */
export function pre2027BaseUnindexed(state, prop, saleMs) {
  if (prop?.auDeemedSale2027 == null || saleMs == null || saleMs < AU_DEEMED_SALE_MS) return false;
  return deemedSaleHolds(state, prop) == null;
}

function _overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Taxable fraction of one window, given the exempt interval (null = none). */
function _taxable(exempt, from, until) {
  const len = until - from;
  if (!(len > 0)) return 1;
  const ex = exempt ? _overlap(exempt.fromMs, exempt.untilMs, from, until) : 0;
  return 1 - Math.min(1, Math.max(0, ex / len));
}

/**
 * s118-185 split at the deemed sale (design 132 §7.3): the AU dwelling's taxable fraction
 * of the days before 1 July 2027 and of the days from it. The exempt interval is the one
 * `auMainResidenceExemption` uses over the whole ownership, so the total exempt days are
 * unchanged. A main residence throughout is exempt in both; an unknown ownership period
 * denies both, as the undivided rule does.
 *
 * @returns {{pre: number, post: number}}
 */
export function auDwellingTaxableFractions(prop, { acquisitionMs, saleMs }) {
  if (isMainResidenceThroughout(prop)) return { pre: 0, post: 0 };
  if (acquisitionMs == null || saleMs == null || saleMs <= acquisitionMs) return { pre: 1, post: 1 };
  const exempt = mainResidenceWindow(prop, acquisitionMs, saleMs);
  return {
    pre:  _taxable(exempt, acquisitionMs, AU_DEEMED_SALE_MS),
    post: _taxable(exempt, AU_DEEMED_SALE_MS, saleMs),
  };
}

/**
 * The US dwelling's AU exemption split at the deemed sale. `auMainResidenceExemptFraction`
 * exempts a rented main residence for its first six years (the s118-145 absence rule) and
 * an occupied one throughout; the split keeps that interval and day-counts it, so the
 * reacquisition never grants a second six years.
 *
 * @returns {{pre: number, post: number}} taxable fractions (1 − exempt)
 */
export function usDwellingAuTaxableFractions(prop, { acquisitionMs, saleMs }) {
  if (!prop?.isPrimaryResidence) return { pre: 1, post: 1 };
  if (acquisitionMs == null || saleMs == null || saleMs <= acquisitionMs) return { pre: 0, post: 0 };
  const incomeProducing = prop.rentalEnabled === true && (prop.monthlyRent ?? 0) > 0;
  if (!incomeProducing) return { pre: 0, post: 0 };
  const exempt = { fromMs: acquisitionMs, untilMs: acquisitionMs + SIX_YEARS_MS };
  return {
    pre:  _taxable(exempt, acquisitionMs, AU_DEEMED_SALE_MS),
    post: _taxable(exempt, AU_DEEMED_SALE_MS, saleMs),
  };
}
