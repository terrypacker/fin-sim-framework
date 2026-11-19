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

// ─── ARC-County (design 134 §15.3, step 3c) ─────────────────────────────────────────
//
// Sources, on disk in docs/us-farm-programs/: 7 U.S.C. §9017 (2024 edition) as P.L. 119-21
// §10305 amends it; §9011(8), (19) with §10301; §9014 (payment acres); §9032 with §10309
// (loan rates); 7 CFR §1412.53 (the irrigated weighting). FSA's county files (FSA-arcco-*.xlsx
// and their Nebraska CSVs) are the published results the formulas are tested against.

/** Covered commodities the model can enroll, with their P.L. 119-21 reference prices (§10301). */
export const REFERENCE_PRICES = Object.freeze({ WHEAT: 6.35, CORN: 4.10, SORGHUM: 4.40, SOYBEANS: 10.00 });

/**
 * Marketing loan rates (§9032(b) for 2019–2025, the period P.L. 119-21 §10309(b)(1) extends
 * from 2023; §9032(c) as §10309 adds it for 2026–2031). ARC's actual revenue is valued at the
 * higher of the national price and this (§9017(b)(1)(B)).
 */
export const LOAN_RATES = Object.freeze([
  { from: 2019, to: 2025, rates: { WHEAT: 3.38, CORN: 2.20, SORGHUM: 2.20, SOYBEANS: 6.20 } },
  { from: 2026, to: 2031, rates: { WHEAT: 3.72, CORN: 2.42, SORGHUM: 2.42, SOYBEANS: 6.82 } },
]);

/** The crop years the ARC terms below cover: P.L. 119-21 runs the program through 2031. */
export const ARC_YEARS = Object.freeze({ from: 2019, to: 2031 });

/** Payment acres are 85% of base acres under county coverage (§9014(a)). */
export const ARC_PAYMENT_ACRES_SHARE = 0.85;

/** The $155,000 payment limit per person on ARC and PLC together (P.L. 119-21 §10307), before CPI indexing. */
export const ARC_PLC_PAYMENT_LIMIT = 155_000;

/**
 * ARC's terms for a crop year (§9017(c)(1), (d)(1) as amended by §10305): the guarantee as a
 * share of benchmark revenue, the payment cap as a share of it, and the effective reference
 * price factor (§9011(8)(B)(ii) as amended by §10301).
 *
 * @param {number} year
 * @returns {{ guarantee: number, cap: number, erpFactor: number }}
 */
export function arcTerms(year) {
  return year >= 2025
    ? { guarantee: 0.90, cap: 0.12, erpFactor: 0.88 }
    : { guarantee: 0.86, cap: 0.10, erpFactor: 0.85 };
}

/** The loan rate for `crop` in `year`, or null outside 2019–2031. */
export function loanRate(crop, year) {
  return LOAN_RATES.find(r => year >= r.from && year <= r.to)?.rates[crop] ?? null;
}

/** Round to the cent, half up (FSA's published figures; the epsilon absorbs binary drift). */
const _cents = (x) => Math.round(x * 100 + 1e-9) / 100;

/** The mean of five values without the highest and the lowest (the statute's "Olympic" average). */
export function olympicAverage(values) {
  if (values.length !== 5 || values.some(v => !Number.isFinite(v))) {
    throw new Error(`an Olympic average needs 5 numbers (got ${values.join(', ')})`);
  }
  const s = [...values].sort((a, b) => a - b);
  return (s[1] + s[2] + s[3]) / 3;
}

/**
 * The benchmark price FSA publishes for an ARC-CO program year: the Olympic average of the
 * national marketing-year average (MYA) prices of the five crop years ending two years before
 * it, each floored at the year's effective reference price (§9017(c)(2)(B), (c)(6)). The
 * effective reference price is the lesser of 115% of the reference price and the greater of
 * the reference price and the ERP factor × the Olympic average of the same five MYAs
 * (§9011(8)). Rounded to the cent, as FSA publishes it; the test checks it against FSA's 2025
 * and 2026 Nebraska figures.
 *
 * @param {Record<number, number>} myaByYear national MYA price by crop year
 * @param {string} crop
 * @param {number} programYear
 * @returns {{ benchmarkPrice: number, effectiveReferencePrice: number, years: number[] }}
 */
export function arcBenchmarkPrice(myaByYear, crop, programYear) {
  const ref = REFERENCE_PRICES[crop];
  if (ref == null) throw new Error(`no reference price for ${crop}`);
  const years = [1, 2, 3, 4, 5].map(i => programYear - 1 - i).reverse();
  const myas = years.map(y => myaByYear[y]);
  if (myas.some(v => !Number.isFinite(v))) throw new Error(`MYA prices missing for ${crop} ${years.join('–')}`);
  const erp = Math.min(1.15 * ref, Math.max(ref, arcTerms(programYear).erpFactor * olympicAverage(myas)));
  const benchmarkPrice = Math.round(olympicAverage(myas.map(p => Math.max(p, erp))) * 100) / 100;
  return { benchmarkPrice, effectiveReferencePrice: erp, years };
}

/**
 * One county practice's ARC-CO figures for a crop year, per base acre before the 85%
 * (§9017(b)–(d)): benchmark revenue = benchmark yield × benchmark price; the guarantee is its
 * share of that; actual revenue = actual county yield × the higher of the national price and
 * the loan rate; the formula rate = guarantee − actual (≥ 0); the rate is that, capped.
 *
 * **Each stage is rounded to the cent**, as FSA computes it: with that, every Nebraska corn
 * and soybean row of FSA's 2025 county file (339 of them) reproduces exactly. Unrounded, they
 * differ by up to 1.2 cents.
 *
 * @param {{ benchmarkYield: number, benchmarkPrice: number, actualYield: number,
 *   nationalPrice: number, crop: string, year: number }} p
 * @returns {{ benchmarkRevenue: number, guarantee: number, maxRate: number,
 *   actualRevenue: number, formulaRate: number, rate: number }}
 */
export function arcCountyRate({ benchmarkYield, benchmarkPrice, actualYield, nationalPrice, crop, year }) {
  const t = arcTerms(year);
  const benchmarkRevenue = _cents(benchmarkYield * benchmarkPrice);
  const guarantee = _cents(t.guarantee * benchmarkRevenue);
  const maxRate = _cents(t.cap * benchmarkRevenue);
  const actualRevenue = _cents(actualYield * Math.max(nationalPrice, loanRate(crop, year) ?? 0));
  const formulaRate = Math.max(0, _cents(guarantee - actualRevenue));
  return { benchmarkRevenue, guarantee, maxRate, actualRevenue, formulaRate, rate: Math.min(formulaRate, maxRate) };
}

/**
 * The season's national marketing-year average price for `crop`: the expected MYA
 * (`season.nationalPrice`) moved by the season's price path, as the mean of the path's realized
 * ÷ expected ratio on the 15th of each month of the marketing year (September of the crop year
 * through August of the next, the corn and soybean marketing year). The local path stands in
 * for the national price's movement, as it does for the futures in `harvestPrice`. A
 * deterministic season's MYA is its expected MYA.
 *
 * @param {object} farm normalized farm
 * @param {string} crop
 * @returns {number|null}
 */
export function nationalPrice(farm, crop) {
  const expectedMya = farm.season.nationalPrice?.[crop];
  if (!(expectedMya > 0)) return null;
  const y = farm.season.cropYear;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const m = 9 + i;
    const date = `${m > 12 ? y + 1 : y}-${String(((m - 1) % 12) + 1).padStart(2, '0')}-15`;
    const exp = priceOn(farm.prices, crop, date, 'price');
    const real = priceOn(farm.prices, crop, date, 'realized');
    sum += exp > 0 ? real / exp : 1;
  }
  return expectedMya * (sum / 12);
}

/**
 * The county's actual yield for a practice this season: its expected county yield moved by the
 * season's COMMON yield shocks, which are county-level by construction (they are calibrated on
 * NASS county trend deviations, §13.8). A field's own shock never reaches it. Dryland
 * (`NONIRRIGATED`) takes k·Y, irrigated k·(β·Y + I); a county with one combined (`ALL`)
 * practice takes the two blended by the farm's irrigated percentage.
 */
function _countyYield(farm, row, irrigatedPct) {
  const s = farm.season;
  const k = s.yieldShockScale?.[row.crop] ?? 1;
  const dry = s.yieldShock;
  const irr = s.irrigatedYieldBeta * s.yieldShock + s.irrigatedYieldShock;
  const dev = row.practice === 'IRRIGATED' ? irr
    : row.practice === 'NONIRRIGATED' ? dry
      : irrigatedPct * irr + (1 - irrigatedPct) * dry;
  return row.expectedYield * Math.max(0, 1 + k * dev);
}

/**
 * Settle every ARC-CO enrollment (`farm.arcBase`, one per FSA farm and crop) for the season.
 *
 * Where the county has separate irrigated and non-irrigated figures, FSA weights the farm's
 * benchmark revenue, guarantee and actual revenue by the farm's historical irrigated percentage
 * and takes the rate from the weighted figures (7 CFR §1412.53(a)(3), (c)). Payment = rate ×
 * 85% × base acres (§9014(a)). Sequestration and the payment limit are not applied (the limit
 * is per person, and an operator may be two; `farmAdvisories` reports a payment above it).
 *
 * @param {object} farm normalized farm
 * @returns {Array<{ arcBaseId: string, operatorId: string, fsaFarm: string, crop: string,
 *   county: string, irrigatedPct: number, nationalPrice: number, countyYield: Record<string, number>,
 *   benchmarkRevenue: number, guarantee: number, actualRevenue: number, rate: number,
 *   paymentAcres: number, payment: number }>}
 */
export function settleArc(farm) {
  const y = farm.season.cropYear;
  const out = [];
  for (const b of farm.arcBase) {
    const rows = farm.arcCounties.filter(r => r.county === b.county && r.crop === b.crop);
    const all = rows.find(r => r.practice === 'ALL');
    const p = b.irrigatedPct;
    const weighted = all ? [[all, 1]] : [
      [rows.find(r => r.practice === 'IRRIGATED'), p],
      [rows.find(r => r.practice === 'NONIRRIGATED'), 1 - p],
    ];
    const mya = nationalPrice(farm, b.crop);
    const t = arcTerms(y);
    let B = 0, G = 0, A = 0;
    const countyYield = {};
    for (const [row, w] of weighted) {
      if (!row || w === 0) continue;
      const actualYield = _countyYield(farm, row, p);
      countyYield[row.practice] = actualYield;
      const r = arcCountyRate({ benchmarkYield: row.benchmarkYield, benchmarkPrice: row.benchmarkPrice,
        actualYield, nationalPrice: mya, crop: b.crop, year: y });
      B += w * r.benchmarkRevenue;
      G += w * r.guarantee;
      A += w * r.actualRevenue;
    }
    const rate = Math.max(0, Math.min(G - A, t.cap * B));
    const paymentAcres = ARC_PAYMENT_ACRES_SHARE * b.baseAcres;
    out.push({
      arcBaseId: b.id, operatorId: b.operatorId, fsaFarm: b.fsaFarm, crop: b.crop, county: b.county,
      irrigatedPct: p, nationalPrice: mya, countyYield, benchmarkRevenue: B, guarantee: G,
      actualRevenue: A, rate, paymentAcres, payment: rate * paymentAcres,
    });
  }
  return out;
}
