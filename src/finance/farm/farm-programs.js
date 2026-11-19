/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  INSURANCE_PLANS, INSURANCE_UNITS, priceOn, realizedYield,
} from './farm-records.js';

/**
 * Farm programs (design 134 phase 3, §15): crop insurance settlement. Pure functions of a
 * normalized farm, so a test can settle a season by hand and the postings compile from it.
 *
 * Sources, all on disk in `docs/us-farm-programs/` (part 457 left the CFR on 1 May 2026,
 * 91 FR 16151; the policy text is now RMA's):
 * - Basic Provisions 27.1-BR §1: the production guarantee is the approved yield × the
 *   coverage level; the revenue protection guarantee is that × the higher of the projected
 *   and harvest prices, or × the projected price alone under the harvest price exclusion.
 * - Coarse Grains Crop Provisions §12(b) (7 CFR §457.113, annual edition 2026): the
 *   indemnity is the unit's guarantee less its production to count × the harvest price (RP)
 *   or the projected price (YP), times the share.
 * - CEPP Section II, corn and soybeans: the projected and harvest prices are the averages of
 *   the harvest-year futures contract over February and October (Nebraska).
 */

/**
 * The season's harvest price for `crop`: the projected price moved by the season's price path
 * between the plan and the end of harvest price discovery.
 *
 * The model's price path is the LOCAL CASH price, not the futures contract. It moves the
 * projected price by the path's realized ÷ expected ratio on the row in force at
 * `calendar.harvestPriceDate`: the stochastic part of the path only, since a futures price's
 * expected change is zero. That holds the basis constant in ratio between February and
 * October. A deterministic season's harvest price is therefore its projected price.
 *
 * @param {object} farm normalized farm
 * @param {string} crop
 * @returns {number|null} null when the season has no projected price for the crop
 */
export function harvestPrice(farm, crop) {
  const projected = farm.season.projectedPrice?.[crop];
  if (!(projected > 0)) return null;
  const date = farm.season.calendar.harvestPriceDate;
  const expected = priceOn(farm.prices, crop, date, 'price');
  const realized = priceOn(farm.prices, crop, date, 'realized');
  return expected > 0 ? projected * (realized / expected) : projected;
}

/** The key of the insurance unit a field belongs to under a policy. */
function _unitKey(policy, field) {
  if (policy.unit === INSURANCE_UNITS.FIELD) return `field:${field.id}`;
  if (policy.unit === INSURANCE_UNITS.ENTERPRISE_BY_PRACTICE) return field.irrigated ? 'irrigated' : 'dry';
  return 'enterprise';
}

/**
 * Settle every insurance policy of the season (Coarse Grains §12(b)).
 *
 * Per field: the guarantee is acres × approved yield × coverage level × the guarantee price,
 * and the value to count is the field's harvested bushels × the value price:
 *
 * | plan     | guarantee price             | value price     |
 * |----------|-----------------------------|-----------------|
 * | `RP`     | max(projected, harvest)     | harvest         |
 * | `RP_HPE` | projected                   | harvest         |
 * | `YP`     | projected                   | projected       |
 *
 * A unit's indemnity is max(0, Σ guarantee − Σ value to count) over its fields. The share is
 * 1: the operators own or cash-rent every field (design 134 Q7). The indemnity is charged to
 * the unit's crop plans in proportion to each field's own shortfall (guarantee − value, where
 * positive), so it lands on the fields that lost; that is a costing choice, the policy pays the
 * unit.
 *
 * Production to count is the harvested bushels. Appraisals, quality and moisture adjustments
 * (§12(c), (d)) are not modelled.
 *
 * @param {object} farm normalized farm
 * @returns {Array<{ insuranceId: string, operatorId: string, crop: string, plan: string,
 *   unit: string, projectedPrice: number, harvestPrice: number, guarantee: number,
 *   valueToCount: number, indemnity: number, byPlan: Array<{ planId: string, amount: number }> }>}
 *   one entry per (policy, unit)
 */
export function settleInsurance(farm) {
  const out = [];
  const fieldById = new Map(farm.fields.map(f => [f.id, f]));
  for (const policy of farm.insurance) {
    const projected = farm.season.projectedPrice[policy.crop];
    const harvest = harvestPrice(farm, policy.crop);
    const guaranteePrice = policy.plan === INSURANCE_PLANS.RP ? Math.max(projected, harvest) : projected;
    const valuePrice = policy.plan === INSURANCE_PLANS.YP ? projected : harvest;
    const units = new Map();
    for (const plan of farm.cropPlans) {
      const f = fieldById.get(plan.fieldId);
      if (!f || f.operatorId !== policy.operatorId || plan.crop !== policy.crop) continue;
      const guarantee = f.plantedAcres * plan.aphYield * policy.coverageLevel * guaranteePrice;
      const value = f.plantedAcres * realizedYield(farm, plan, f) * valuePrice;
      const key = _unitKey(policy, f);
      if (!units.has(key)) units.set(key, []);
      units.get(key).push({ planId: plan.id, guarantee, value });
    }
    for (const [unit, rows] of units) {
      const guarantee = rows.reduce((s, r) => s + r.guarantee, 0);
      const valueToCount = rows.reduce((s, r) => s + r.value, 0);
      const indemnity = Math.max(0, guarantee - valueToCount);
      const short = rows.map(r => Math.max(0, r.guarantee - r.value));
      const totalShort = short.reduce((s, x) => s + x, 0);
      const byPlan = indemnity > 0
        ? rows.map((r, i) => ({ planId: r.planId, amount: indemnity * short[i] / totalShort })).filter(x => x.amount > 0)
        : [];
      out.push({
        insuranceId: policy.id, operatorId: policy.operatorId, crop: policy.crop, plan: policy.plan,
        unit, projectedPrice: projected, harvestPrice: harvest, guarantee, valueToCount, indemnity, byPlan,
      });
    }
  }
  return out;
}
