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
  PRODUCT_CATEGORIES, COST_CATEGORIES, INCOME_CATEGORIES,
} from './schedule-f.js';
import { FARM_CALIBRATION } from './farm-calibration.js';
// farm-programs imports this module too; the cycle is safe because each side reads the other's
// exports only inside functions, never at module evaluation.
import { settleArc, ARC_PLC_PAYMENT_LIMIT } from './farm-programs.js';

/**
 * Farm records (design 134 §5.1): flat tables joined by id, in `cfg.farm`.
 *
 * ```js
 * cfg.farm = {
 *   seasons:       [{ id, cropYear, calendar?, yieldShock?, irrigatedYieldShock?, irrigatedYieldBeta?,
 *                     yieldShockScale?: { [crop]: k }, priceVol?: { [crop]: σ }, priceYieldBeta?: { [crop]: b },
 *                     laborPerHour?, rentMultiplier?, customRateMultiplier?, machineryMultiplier?,
 *                     irrigationMultiplier?, interestMultiplier?, projectedPrice?: { [crop]: $ },
 *                     nationalPrice?: { [crop]: $ },
 *                     <category>Multiplier? (one per PRODUCT_CATEGORIES, e.g. nitrogenMultiplier) }],
 *   operators:     [{ id, name, farmRelated?, prior3PrepaidSupplies?, prior3FarmExpenses?, defer451f? }],
 *   fields:        [{ id, operatorId, name, tenure, rentedAcres, plantedAcres, irrigated,
 *                     rentPerAcre, propertyTax, communityCollegeTax?, fsaFarm?, provenYield? }],
 *   products:      [{ id, name, category, unit, unitPrice, discountPct }],
 *   operations:    [{ id, name, customRatePerAcre, fuelPerAcre?, acresPerHour?, crew? }],
 *   cropPlans:     [{ id, fieldId, crop, expectedYield, yieldShock?, insurancePremiumPerAcre,
 *                     irrigationElectricity, aphYield? }],
 *   prescriptions: [{ id, planId, productId | operationId, ratePerAcre, passes, applications?,
 *                     share, paidDate? }],
 *   machinery:     [{ id, operatorId, amount, paidDate?, name?, costingOnly? }],
 *   overhead:      [{ id, operatorId, name, category, amount, basis, fieldIds?, paidDate?, variableRate? }],
 *   prices:        [{ id, crop, date, price, shock? }],
 *   contracts:     [{ id, operatorId, crop, cropYear?, bushels | shareOfExpected, price,
 *                     deliveryDate, paymentDate?, buyoutPerBu? }],
 *   storage:       [{ id, operatorId, crop, costPerBuMonth }],
 *   trucking:      [{ id, operatorId, crop, leg: 'FIELD' | 'STORAGE_TO_SALE', perBu }],
 *   sales:         [{ id, operatorId, crop, cropYear?, share, saleDate, paymentDate?, price? }],
 *   carryIn:       [{ id, operatorId, crop, bushels, cropYear? }],
 *   otherIncome:   [{ id, operatorId, category, amount, paymentDate, cropYear?, planId? }],
 *   carryOut:      [{ id, operatorId, category, amount, paidDate? }],
 *   insurance:     [{ id, operatorId, crop, plan?, coverageLevel, unit?, paymentDate? }],
 *   arcBase:       [{ id, operatorId, fsaFarm, crop, baseAcres, county, irrigatedPct?, paymentDate? }],
 *   arcCounties:   [{ id, county, crop, practice, benchmarkYield, benchmarkPrice, expectedYield? }],
 * }
 * ```
 *
 * Every row but an operator carries a `seasonId`. With one season it may be left out and is
 * filled in: design 134 §5.5 has the scenario hold a LIST of seasons from the start, so that a
 * later roll-forward (copying a season's rows into the next crop year) is configuration rather
 * than a migration. Phase 1 runs exactly one season and refuses more.
 *
 * Money is USD; a rate is per planted acre unless its name says otherwise. Dates are
 * `YYYY-MM-DD`. A row's `cropYear` (contracts, sales, carry-in, other income) names WHICH crop
 * the grain or the payment belongs to. It defaults to the season's, and the carry-in's to the
 * year before (design 134 §5.5).
 *
 * `normalizeFarm` returns a NEW object with every default filled; it never mutates `cfg.farm`,
 * so a saved scenario keeps exactly what its author wrote.
 */

export const FARM_TABLES = Object.freeze([
  'operators', 'fields', 'products', 'operations', 'cropPlans', 'prescriptions', 'machinery',
  'overhead', 'prices', 'contracts', 'storage', 'sales', 'carryIn', 'otherIncome', 'carryOut',
  'insurance', 'arcBase', 'arcCounties', 'trucking',
]);

/**
 * Trucking legs (design 134 §17.8): every harvested bushel is hauled out of the field, and a
 * bushel that is stored is hauled again from storage to the buyer.
 */
export const TRUCKING_LEGS = Object.freeze({ FIELD: 'FIELD', STORAGE_TO_SALE: 'STORAGE_TO_SALE' });

/** The tables whose rows belong to a season (all but `operators`). */
export const SEASON_TABLES = Object.freeze(FARM_TABLES.filter(t => t !== 'operators'));

export const TENURE = Object.freeze({ OWN: 'OWN', CASH_RENT: 'CASH_RENT' });

/**
 * Overhead allocation bases (design 134 §5.3), each by planted acres: across all the
 * operator's fields, across its owned fields, or across a named set of its fields
 * (`fieldIds`) — a loan secured by particular parcels, for example.
 */
export const OVERHEAD_BASIS = Object.freeze({ ACRES: 'ACRES', OWNED_ACRES: 'OWNED_ACRES', FIELDS: 'FIELDS' });

/**
 * The season's cost multipliers (design 134 §6, §13.6): one lever moves every record it
 * covers, so "what if fertilizer goes up 30%" is one axis. Each is a season field, 1 when
 * blank. Product categories get one each, named by `categoryMultiplierField`.
 */
export const SEASON_MULTIPLIERS = Object.freeze({
  rentMultiplier:       'cash rent on every rented field',
  customRateMultiplier: 'every field operation\'s custom-hire rate',
  machineryMultiplier:  'every operator\'s real machinery figure',
  irrigationMultiplier: 'every crop plan\'s irrigation electricity',
  interestMultiplier:   'interest on overhead rows marked variableRate',
  fuelMultiplier:       'the computed fuel of every operation done with the operator\'s own machines',
});

/** `NITROGEN` → `nitrogenMultiplier`, `PHOSPHATE_POTASH` → `phosphatePotashMultiplier`. */
export const categoryMultiplierField = (category) =>
  `${category.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())}Multiplier`;

/** Interest categories a `variableRate` overhead row may carry. */
export const INTEREST_CATEGORIES = Object.freeze(['INTEREST_MORTGAGE', 'INTEREST_OTHER']);

/**
 * Crop insurance plans (design 134 §15.2; the Basic Provisions 27.1-BR §1 and the Coarse
 * Grains Crop Provisions §12(b), on disk in docs/us-farm-programs/):
 * - `RP`: revenue protection. The guarantee is valued at the higher of the projected and the
 *   harvest price, the production at the harvest price.
 * - `RP_HPE`: revenue protection with the harvest price exclusion. The guarantee is valued at
 *   the projected price only, the production still at the harvest price.
 * - `YP`: yield protection. Both at the projected price.
 */
export const INSURANCE_PLANS = Object.freeze({ RP: 'RP', RP_HPE: 'RP_HPE', YP: 'YP' });

/**
 * Insurance units: the acreage a loss is settled over. A shortfall on one field is offset by
 * a surplus on another field in the same unit.
 * - `ENTERPRISE`: all of the operator's acres of the crop.
 * - `ENTERPRISE_BY_PRACTICE`: one unit for irrigated acres and one for dry.
 * - `FIELD`: each field is its own unit (optional units, at their finest).
 * One county is assumed. A farm in two counties would need a unit per county.
 */
export const INSURANCE_UNITS = Object.freeze({
  ENTERPRISE: 'ENTERPRISE', ENTERPRISE_BY_PRACTICE: 'ENTERPRISE_BY_PRACTICE', FIELD: 'FIELD',
});

/**
 * ARC-County practice designations, as FSA's county file names them: separate irrigated and
 * non-irrigated figures where FSA sets them, one combined figure (`ALL`) elsewhere.
 */
export const ARC_PRACTICES = Object.freeze({ IRRIGATED: 'IRRIGATED', NONIRRIGATED: 'NONIRRIGATED', ALL: 'ALL' });

/** Covered commodities the model's ARC terms carry (design 134 §15.3). */
export const ARC_CROPS = Object.freeze(['WHEAT', 'CORN', 'SORGHUM', 'SOYBEANS']);

/** Crops the Coarse Grains Crop Provisions insure (7 CFR §457.113 §1, annual edition 2026). */
export const INSURABLE_CROPS = Object.freeze(['CORN', 'SORGHUM', 'SOYBEANS']);

/** Commodities. A crop plan names one; grain pools by (operator, crop, crop year). */
export const CROPS = Object.freeze({
  CORN:     { label: 'Corn',     unit: 'bu' },
  SOYBEANS: { label: 'Soybeans', unit: 'bu' },
  WHEAT:    { label: 'Wheat',    unit: 'bu' },
  SORGHUM:  { label: 'Sorghum',  unit: 'bu' },
  ALFALFA:  { label: 'Alfalfa',  unit: 'ton', perennial: true },
});

/**
 * Product categories paid on the prepay date by default. The owners prepay seed and
 * fertilizer in November or December of the year before (design 134 Q11); chemicals are
 * bought in season. A prescription's own `paidDate` overrides either.
 */
export const DEFAULT_PREPAY_CATEGORIES = Object.freeze([
  'SEED', 'NITROGEN', 'PHOSPHATE_POTASH', 'LIME', 'OTHER_FERTILIZER',
]);

/**
 * The season calendar's defaults, as dates in or around crop year `y`. Each can be authored
 * on `season.calendar`; an authored key replaces only itself.
 *
 * The defaults are placeholders with a reason, not facts about any farm: rent split half in
 * spring and half in fall (design 134 §5.2), property tax in two halves, the premium billed
 * after the acreage report, and harvest in October.
 *
 * @param {number} y crop year
 */
export function defaultCalendar(y) {
  return {
    prepayDate:            `${y - 1}-12-15`,
    inputDate:             `${y}-04-15`,
    rentSpringDate:        `${y}-03-01`,
    rentFallDate:          `${y}-11-01`,
    rentSpringShare:       0.5,
    propertyTaxFirstDate:  `${y}-04-30`,
    propertyTaxSecondDate: `${y}-08-31`,
    insurancePremiumDate:  `${y}-08-15`,
    // The CEPP's harvest price discovery period for Nebraska corn and soybeans ends 31 Oct
    // (docs/us-farm-programs/RMA-24-CEPP-0041/0081); the claim is paid after it.
    harvestPriceDate:      `${y}-10-31`,
    insurancePaymentDate:  `${y}-12-15`,
    // ARC is paid from 1 October after the marketing year ends (7 U.S.C. §9017(f)).
    arcPaymentDate:        `${y + 1}-10-01`,
    irrigationDate:        `${y}-09-30`,
    machineryDate:         `${y}-07-01`,
    overheadDate:          `${y}-07-01`,
    carryInDate:           `${y}-01-01`,
    carryOutDate:          `${y}-12-15`,
    harvestDates:          { CORN: `${y}-10-20`, SOYBEANS: `${y}-10-01` },
    harvestDate:           `${y}-10-15`,
    prepayCategories:      [...DEFAULT_PREPAY_CATEGORIES],
  };
}

/**
 * The run window a season needs: its inputs are prepaid in `y − 1`, and its deferred sales
 * and program payment land in `y + 1` (design 134 §5.2), so three calendar years.
 *
 * @param {number} y crop year
 * @returns {{ simStart: string, simEnd: string }}
 */
export function seasonWindow(y) {
  return { simStart: `${y - 1}-01-01`, simEnd: `${y + 2}-01-01` };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isNum   = v => typeof v === 'number' && Number.isFinite(v);
const day     = v => (v == null || v === '') ? null
  : String(v instanceof Date ? v.toISOString() : v).slice(0, 10);

/**
 * Fill every default and attach the season. Pure: returns a new object.
 *
 * @param {object} farm `cfg.farm`
 * @returns {object} the normalized farm, with `season` (the one season, calendar resolved)
 */
export function normalizeFarm(farm) {
  const src = farm ?? {};
  const seasons = Array.isArray(src.seasons) ? src.seasons : [];
  const season0 = seasons[0] ?? null;
  const y = Number(season0?.cropYear);
  const calendar = { ...defaultCalendar(y), ...(season0?.calendar ?? {}) };
  calendar.harvestDates = { ...defaultCalendar(y).harvestDates, ...(season0?.calendar?.harvestDates ?? {}) };
  const season = season0 ? {
    ...season0, cropYear: y, calendar,
    yieldShock:          season0.yieldShock ?? 0,
    irrigatedYieldShock: season0.irrigatedYieldShock ?? 0,
    // The wage of the person running the operator's own machines (design 134 §17.8). With an
    // operation's acres per hour it prices the hours; 0 (blank) computes no machine labor.
    laborPerHour:        season0.laborPerHour ?? 0,
    // The shocks' SHAPE defaults to the NASS calibration (design 134 §13.8). Each is a no-op
    // while the shocks are 0, so a deterministic season is unchanged by it. The price vol is
    // not: its mean correction moves a price, so it stays blank here (FarmMcRunner fills it
    // for a crop whose price shocks it samples).
    irrigatedYieldBeta:  season0.irrigatedYieldBeta ?? FARM_CALIBRATION.irrigatedYieldBeta,
    yieldShockScale:     { ...FARM_CALIBRATION.yieldShockScale, ...(season0.yieldShockScale ?? {}) },
    priceVol:            { ...(season0.priceVol ?? {}) },
    projectedPrice:      { ...(season0.projectedPrice ?? {}) },
    nationalPrice:       { ...(season0.nationalPrice ?? {}) },
    priceYieldBeta:      { ...FARM_CALIBRATION.priceYieldBeta, ...(season0.priceYieldBeta ?? {}) },
    ...Object.fromEntries([...Object.keys(SEASON_MULTIPLIERS),
      ...Object.keys(PRODUCT_CATEGORIES).map(categoryMultiplierField)].map(k => [k, season0[k] ?? 1])),
  } : null;
  const sid = season?.id ?? null;

  const rows = (t) => (Array.isArray(src[t]) ? src[t] : []).map(r => ({ ...r }));
  const out = { seasons: seasons.map(s => ({ ...s })), season };
  for (const t of FARM_TABLES) out[t] = rows(t);
  for (const t of SEASON_TABLES) for (const r of out[t]) r.seasonId ??= sid;

  for (const o of out.operators) {
    o.farmRelated ??= null;
    o.prior3PrepaidSupplies ??= null;
    o.prior3FarmExpenses ??= null;
    o.defer451f = o.defer451f === true;
  }
  for (const f of out.fields) {
    f.irrigated   = f.irrigated === true;
    f.rentPerAcre ??= 0;
    f.propertyTax ??= 0;
    // The community-college share of the property tax bill (design 134 Q29, 77-6702(1)): a
    // part of `propertyTax`, not on top of it. It is credited on the operator's Nebraska return.
    f.communityCollegeTax ??= 0;
    f.rentedAcres ??= (f.tenure === TENURE.CASH_RENT ? f.plantedAcres : 0);
  }
  for (const p of out.products) p.discountPct ??= 0;
  for (const o of out.operations) { o.fuelPerAcre ??= 0; o.acresPerHour ??= null; o.crew ??= 1; }
  for (const p of out.cropPlans) {
    p.yieldShock ??= 0;
    p.insurancePremiumPerAcre ??= 0;
    p.irrigationElectricity   ??= 0;
    // The approved (APH) yield an insurance guarantee is built on. Blank is the plan's expected
    // yield, which the advisories flag on an insured plan: the APH is the insurer's number.
    p.aphDefaulted = p.aphYield == null;
    p.aphYield ??= p.expectedYield;
  }
  for (const c of out.arcCounties) c.expectedYield ??= c.benchmarkYield;
  for (const b of out.arcBase) {
    b.paymentDate = day(b.paymentDate) ?? calendar.arcPaymentDate;
    // FSA's historical irrigated percentage (2019–2023 plantings, 7 CFR §1412.3). Blank is the
    // share of this season's planted acres of the crop on the FSA farm that are irrigated, which
    // the advisories flag: the historical figure is FSA's.
    b.irrigatedPctDefaulted = b.irrigatedPct == null;
    if (b.irrigatedPct == null) {
      let irr = 0, all = 0;
      for (const plan of out.cropPlans) {
        const fld = out.fields.find(x => x.id === plan.fieldId);
        if (!fld || fld.operatorId !== b.operatorId || fld.fsaFarm !== b.fsaFarm || plan.crop !== b.crop) continue;
        all += fld.plantedAcres ?? 0;
        if (fld.irrigated) irr += fld.plantedAcres ?? 0;
      }
      b.irrigatedPct = all > 0 ? irr / all : 0;
    }
  }
  for (const r of out.insurance) {
    r.plan ??= INSURANCE_PLANS.RP;
    r.unit ??= INSURANCE_UNITS.ENTERPRISE;
    r.paymentDate = day(r.paymentDate) ?? calendar.insurancePaymentDate;
  }
  for (const rx of out.prescriptions) {
    rx.share ??= 1;
    if (rx.operationId != null) {
      rx.passes ??= 1;
      // The trips the operator's own machines make. A custom rate may be charged per season
      // (one pass) while the sprayer goes over the field three or four times (rev 24).
      rx.applications ??= rx.passes;
    }
    rx.paidDate = day(rx.paidDate);
  }
  for (const m of out.machinery) m.paidDate = day(m.paidDate) ?? calendar.machineryDate;
  for (const o of out.overhead) {
    o.basis  ??= OVERHEAD_BASIS.ACRES;
    o.fieldIds = Array.isArray(o.fieldIds) ? [...o.fieldIds] : null;
    o.paidDate = day(o.paidDate) ?? calendar.overheadDate;
    o.variableRate = o.variableRate === true;
  }
  for (const p of out.prices) { p.date = day(p.date); p.shock ??= 0; }
  if (season) applyPricePath(out);
  // Expected bushels per (operator, crop) of this season, for a contract sized as a share.
  const expected = new Map();
  for (const p of out.cropPlans) {
    const fld = out.fields.find(x => x.id === p.fieldId);
    if (!fld) continue;
    const k = `${fld.operatorId}|${p.crop}`;
    expected.set(k, (expected.get(k) ?? 0) + (fld.plantedAcres ?? 0) * (p.expectedYield ?? 0));
  }
  for (const c of out.contracts) {
    c.cropYear  ??= y;
    c.shareOfExpected ??= null;
    // Q18: a contract can be sized as a share of the operator's EXPECTED crop, the lever the
    // owners sweep. It fixes the bushels at plan time; a short crop is then a shortfall.
    if (c.shareOfExpected != null && c.cropYear === y) {
      c.bushels = c.shareOfExpected * (expected.get(`${c.operatorId}|${c.crop}`) ?? 0);
    }
    c.deliveryDate = day(c.deliveryDate);
    c.paymentDate  = day(c.paymentDate) ?? c.deliveryDate;
    c.buyoutPerBu ??= 0;
  }
  for (const s of out.sales) {
    s.cropYear  ??= y;
    s.saleDate    = day(s.saleDate);
    s.paymentDate = day(s.paymentDate) ?? s.saleDate;
    s.price     ??= null;
  }
  for (const c of out.carryIn) c.cropYear ??= y - 1;
  for (const i of out.otherIncome) {
    i.cropYear  ??= y;
    i.paymentDate = day(i.paymentDate);
    i.planId    ??= null;
  }
  for (const c of out.carryOut) c.paidDate = day(c.paidDate) ?? calendar.carryOutDate;
  return out;
}

/**
 * Every reason a farm cannot run, as messages. Empty means valid. The loader throws on any,
 * as it does for jobs (design 116 §4.6): a dangling join or an unknown category would
 * otherwise be a cost silently missing from a field's P&L, which is the defect the source
 * workbook's stale pivot table already showed (design 134 §2).
 *
 * @param {object} farm `cfg.farm` (raw or normalized)
 * @returns {string[]}
 */
export function validateFarm(farm) {
  if (farm == null) return [];
  const f = normalizeFarm(farm);
  const errs = [];
  const err = (m) => errs.push(m);

  if (f.seasons.length !== 1) {
    err(`farm.seasons must hold exactly one season in phase 1 (found ${f.seasons.length})`);
    return errs;
  }
  if (!f.season.id) err('farm.seasons[0] needs an id');
  if (!Number.isInteger(f.season.cropYear)) err('farm.seasons[0].cropYear must be a whole year');
  if (!isNum(f.season.yieldShock)) err('farm.seasons[0].yieldShock must be a number');
  if (!isNum(f.season.irrigatedYieldShock)) err('farm.seasons[0].irrigatedYieldShock must be a number');
  if (!isNum(f.season.irrigatedYieldBeta) || f.season.irrigatedYieldBeta < 0) {
    err('farm.seasons[0].irrigatedYieldBeta must be a number ≥ 0');
  }

  const ids = new Map();
  for (const t of FARM_TABLES) {
    const seen = new Set();
    for (const [i, r] of f[t].entries()) {
      if (r.id == null || r.id === '') { err(`farm.${t}[${i}] has no id`); continue; }
      if (String(r.id).includes('.')) err(`farm.${t} id "${r.id}" may not contain a dot`);
      if (seen.has(r.id)) err(`farm.${t} has a duplicate id "${r.id}"`);
      seen.add(r.id);
      if (SEASON_TABLES.includes(t) && r.seasonId !== f.season.id) {
        err(`farm.${t} "${r.id}" names season "${r.seasonId}", which does not exist`);
      }
    }
    ids.set(t, seen);
  }
  const has = (t, id) => ids.get(t).has(id);
  const need = (t, r, field, table) => {
    if (!has(table, r[field])) err(`farm.${t} "${r.id}": ${field} "${r[field]}" is not in farm.${table}`);
  };
  const nonNeg = (t, r, field, { required = false } = {}) => {
    if (r[field] == null) { if (required) err(`farm.${t} "${r.id}": ${field} is required`); return; }
    if (!isNum(r[field]) || r[field] < 0) err(`farm.${t} "${r.id}": ${field} must be a number ≥ 0`);
  };
  const share = (t, r, field) => {
    if (!isNum(r[field]) || r[field] < 0 || r[field] > 1) err(`farm.${t} "${r.id}": ${field} must be between 0 and 1`);
  };
  const date = (t, r, field) => {
    if (!ISO_DAY.test(r[field] ?? '')) err(`farm.${t} "${r.id}": ${field} must be a YYYY-MM-DD date`);
  };
  const crop = (t, r) => {
    if (!Object.hasOwn(CROPS, r.crop)) err(`farm.${t} "${r.id}": unknown crop "${r.crop}"`);
  };

  for (const r of f.fields) {
    need('fields', r, 'operatorId', 'operators');
    if (!Object.hasOwn(TENURE, r.tenure)) err(`farm.fields "${r.id}": tenure must be OWN or CASH_RENT`);
    nonNeg('fields', r, 'plantedAcres', { required: true });
    nonNeg('fields', r, 'rentedAcres');
    nonNeg('fields', r, 'rentPerAcre');
    nonNeg('fields', r, 'propertyTax');
    nonNeg('fields', r, 'communityCollegeTax');
    if ((r.communityCollegeTax ?? 0) > (r.propertyTax ?? 0)) {
      err(`farm.fields "${r.id}": communityCollegeTax is part of the property tax bill, so it can not exceed propertyTax`);
    }
    if (r.tenure === TENURE.OWN && r.rentPerAcre > 0) err(`farm.fields "${r.id}": an owned field pays no cash rent`);
  }
  for (const r of f.products) {
    if (!Object.hasOwn(PRODUCT_CATEGORIES, r.category)) err(`farm.products "${r.id}": unknown category "${r.category}"`);
    nonNeg('products', r, 'unitPrice', { required: true });
    share('products', r, 'discountPct');
  }
  for (const r of f.operations) {
    nonNeg('operations', r, 'customRatePerAcre', { required: true });
    nonNeg('operations', r, 'fuelPerAcre');
    if (r.acresPerHour != null && !(isNum(r.acresPerHour) && r.acresPerHour > 0)) {
      err(`farm.operations "${r.id}": acresPerHour must be a number > 0`);
    }
    // A crew of 0: the operation's labor is counted in another's crew (a grain cart's, in harvest).
    if (r.crew != null && !(isNum(r.crew) && r.crew >= 0)) {
      err(`farm.operations "${r.id}": crew must be a number ≥ 0`);
    }
  }
  if (!isNum(f.season.laborPerHour) || f.season.laborPerHour < 0) err('farm.seasons[0].laborPerHour must be a number ≥ 0');
  const truckKeys = new Set();
  for (const r of f.trucking) {
    need('trucking', r, 'operatorId', 'operators');
    crop('trucking', r);
    if (!Object.hasOwn(TRUCKING_LEGS, r.leg)) err(`farm.trucking "${r.id}": leg must be FIELD or STORAGE_TO_SALE`);
    nonNeg('trucking', r, 'perBu', { required: true });
    const k = `${r.operatorId}|${r.crop}|${r.leg}`;
    if (truckKeys.has(k)) err(`farm.trucking "${r.id}": a second ${r.leg} rate for ${r.operatorId} ${r.crop}`);
    truckKeys.add(k);
  }

  const plansByField = new Map();
  for (const r of f.cropPlans) {
    need('cropPlans', r, 'fieldId', 'fields');
    crop('cropPlans', r);
    nonNeg('cropPlans', r, 'expectedYield', { required: true });
    if (!isNum(r.yieldShock)) err(`farm.cropPlans "${r.id}": yieldShock must be a number`);
    nonNeg('cropPlans', r, 'insurancePremiumPerAcre');
    nonNeg('cropPlans', r, 'irrigationElectricity');
    const field = f.fields.find(x => x.id === r.fieldId);
    if (field && !field.irrigated && r.irrigationElectricity > 0) {
      err(`farm.cropPlans "${r.id}": irrigation electricity on dry field "${field.id}"`);
    }
    if (plansByField.has(r.fieldId)) err(`farm.cropPlans: field "${r.fieldId}" has two crop plans in one season`);
    plansByField.set(r.fieldId, r.id);
  }
  for (const r of f.prescriptions) {
    need('prescriptions', r, 'planId', 'cropPlans');
    const isProduct = r.productId != null;
    const isOperation = r.operationId != null;
    if (isProduct === isOperation) {
      err(`farm.prescriptions "${r.id}": name exactly one of productId or operationId`);
      continue;
    }
    if (isProduct) { need('prescriptions', r, 'productId', 'products'); nonNeg('prescriptions', r, 'ratePerAcre', { required: true }); }
    if (isOperation) {
      need('prescriptions', r, 'operationId', 'operations');
      nonNeg('prescriptions', r, 'passes');
      nonNeg('prescriptions', r, 'applications');
    }
    share('prescriptions', r, 'share');
    if (r.paidDate != null) date('prescriptions', r, 'paidDate');
  }
  for (const r of f.machinery) {
    need('machinery', r, 'operatorId', 'operators');
    nonNeg('machinery', r, 'amount', { required: true });
    date('machinery', r, 'paidDate');
    if (r.costingOnly != null && typeof r.costingOnly !== 'boolean') err(`farm.machinery "${r.id}": costingOnly must be true or false`);
  }
  for (const r of f.overhead) {
    need('overhead', r, 'operatorId', 'operators');
    if (!COST_CATEGORIES[r.category]?.overhead) err(`farm.overhead "${r.id}": "${r.category}" is not an overhead category`);
    if (!Object.hasOwn(OVERHEAD_BASIS, r.basis)) err(`farm.overhead "${r.id}": basis must be ACRES, OWNED_ACRES or FIELDS`);
    if ((r.basis === OVERHEAD_BASIS.FIELDS) !== (r.fieldIds != null)) {
      err(`farm.overhead "${r.id}": fieldIds goes with basis FIELDS, and only with it`);
    }
    for (const fid of r.fieldIds ?? []) {
      const fld = f.fields.find(x => x.id === fid);
      if (!fld) err(`farm.overhead "${r.id}": fieldIds names "${fid}", which is not in farm.fields`);
      else if (fld.operatorId !== r.operatorId) {
        err(`farm.overhead "${r.id}": field "${fid}" belongs to another operator (overhead is never shared, Q10)`);
      }
    }
    nonNeg('overhead', r, 'amount', { required: true });
    date('overhead', r, 'paidDate');
  }
  for (const r of f.prices) {
    crop('prices', r);
    date('prices', r, 'date');
    nonNeg('prices', r, 'price', { required: true });
    if (!isNum(r.shock)) err(`farm.prices "${r.id}": shock must be a number`);
  }
  for (const k of [...Object.keys(SEASON_MULTIPLIERS), ...Object.keys(PRODUCT_CATEGORIES).map(categoryMultiplierField)]) {
    if (!isNum(f.season[k]) || f.season[k] < 0) err(`farm.seasons[0].${k} must be a number ≥ 0`);
  }
  for (const r of f.overhead) {
    if (r.variableRate && !INTEREST_CATEGORIES.includes(r.category)) {
      err(`farm.overhead "${r.id}": variableRate goes on an interest row (${INTEREST_CATEGORIES.join(', ')})`);
    }
  }
  for (const [field, min] of [['priceVol', 0], ['priceYieldBeta', -Infinity], ['yieldShockScale', 0]]) {
    for (const [c, v] of Object.entries(f.season[field])) {
      if (!Object.hasOwn(CROPS, c)) err(`farm.seasons[0].${field}: unknown crop "${c}"`);
      if (!isNum(v) || v < min) err(`farm.seasons[0].${field}.${c} must be a number${min === 0 ? ' ≥ 0' : ''}`);
    }
  }
  for (const [c, v] of Object.entries(f.season.projectedPrice)) {
    if (!Object.hasOwn(CROPS, c)) err(`farm.seasons[0].projectedPrice: unknown crop "${c}"`);
    if (!isNum(v) || v <= 0) err(`farm.seasons[0].projectedPrice.${c} must be a number > 0`);
  }
  for (const p of f.cropPlans) {
    if (!isNum(p.aphYield) || p.aphYield < 0) err(`farm.cropPlans "${p.id}": aphYield must be a number ≥ 0`);
  }
  const insured = new Set();
  for (const r of f.insurance) {
    need('insurance', r, 'operatorId', 'operators');
    crop('insurance', r);
    if (!INSURABLE_CROPS.includes(r.crop)) {
      err(`farm.insurance "${r.id}": ${r.crop} is not under the Coarse Grains provisions (${INSURABLE_CROPS.join(', ')})`);
    }
    if (!Object.hasOwn(INSURANCE_PLANS, r.plan)) err(`farm.insurance "${r.id}": plan must be RP, RP_HPE or YP`);
    if (!Object.hasOwn(INSURANCE_UNITS, r.unit)) {
      err(`farm.insurance "${r.id}": unit must be ENTERPRISE, ENTERPRISE_BY_PRACTICE or FIELD`);
    }
    // Basic Provisions: additional coverage is 50% to 85% of the approved yield.
    if (!isNum(r.coverageLevel) || r.coverageLevel < 0.5 || r.coverageLevel > 0.85) {
      err(`farm.insurance "${r.id}": coverageLevel must be between 0.5 and 0.85`);
    }
    date('insurance', r, 'paymentDate');
    if (!(f.season.projectedPrice[r.crop] > 0)) {
      err(`farm.insurance "${r.id}": no projected price for ${r.crop} (farm.seasons[0].projectedPrice)`);
    }
    if (!f.prices.some(p => p.crop === r.crop)) {
      err(`farm.insurance "${r.id}": no ${r.crop} price path to move the harvest price (farm.prices)`);
    }
    const k = `${r.operatorId}|${r.crop}`;
    if (insured.has(k)) err(`farm.insurance "${r.id}": a second policy for ${r.operatorId} ${r.crop}`);
    insured.add(k);
  }
  for (const [c, v] of Object.entries(f.season.nationalPrice)) {
    if (!Object.hasOwn(CROPS, c)) err(`farm.seasons[0].nationalPrice: unknown crop "${c}"`);
    if (!isNum(v) || v <= 0) err(`farm.seasons[0].nationalPrice.${c} must be a number > 0`);
  }
  const countyKeys = new Set();
  for (const r of f.arcCounties) {
    if (!r.county) err(`farm.arcCounties "${r.id}" needs a county`);
    if (!ARC_CROPS.includes(r.crop)) err(`farm.arcCounties "${r.id}": crop must be one of ${ARC_CROPS.join(', ')}`);
    if (!Object.hasOwn(ARC_PRACTICES, r.practice)) err(`farm.arcCounties "${r.id}": practice must be IRRIGATED, NONIRRIGATED or ALL`);
    nonNeg('arcCounties', r, 'benchmarkYield', { required: true });
    nonNeg('arcCounties', r, 'benchmarkPrice', { required: true });
    nonNeg('arcCounties', r, 'expectedYield');
    const k = `${r.county}|${r.crop}|${r.practice}`;
    if (countyKeys.has(k)) err(`farm.arcCounties "${r.id}": a second ${r.practice} row for ${r.county} ${r.crop}`);
    countyKeys.add(k);
  }
  const baseKeys = new Set();
  if (f.arcBase.length && (f.season.cropYear < 2019 || f.season.cropYear > 2031)) {
    err(`farm.arcBase: ARC-CO terms are modelled for crop years 2019–2031, not ${f.season.cropYear}`);
  }
  for (const b of f.arcBase) {
    need('arcBase', b, 'operatorId', 'operators');
    if (!b.fsaFarm) err(`farm.arcBase "${b.id}" needs an fsaFarm`);
    if (!ARC_CROPS.includes(b.crop)) err(`farm.arcBase "${b.id}": crop must be one of ${ARC_CROPS.join(', ')}`);
    nonNeg('arcBase', b, 'baseAcres', { required: true });
    share('arcBase', b, 'irrigatedPct');
    date('arcBase', b, 'paymentDate');
    const has = (pr) => countyKeys.has(`${b.county}|${b.crop}|${pr}`);
    if (!has('ALL') && !(has('IRRIGATED') && has('NONIRRIGATED'))) {
      err(`farm.arcBase "${b.id}": farm.arcCounties needs ${b.county} ${b.crop} as ALL, or as both IRRIGATED and NONIRRIGATED`);
    }
    if (!(f.season.nationalPrice[b.crop] > 0)) {
      err(`farm.arcBase "${b.id}": no expected national price for ${b.crop} (farm.seasons[0].nationalPrice)`);
    }
    const k = `${b.fsaFarm}|${b.crop}`;
    if (baseKeys.has(k)) err(`farm.arcBase "${b.id}": a second ${b.crop} enrollment on FSA farm ${b.fsaFarm}`);
    baseKeys.add(k);
  }
  for (const r of f.contracts) {
    need('contracts', r, 'operatorId', 'operators');
    crop('contracts', r);
    if (r.shareOfExpected != null) {
      share('contracts', r, 'shareOfExpected');
      if (r.cropYear !== f.season.cropYear) err(`farm.contracts "${r.id}": shareOfExpected sizes this season's crop only`);
    }
    nonNeg('contracts', r, 'bushels', { required: true });
    nonNeg('contracts', r, 'price', { required: true });
    nonNeg('contracts', r, 'buyoutPerBu');
    date('contracts', r, 'deliveryDate');
    date('contracts', r, 'paymentDate');
    if (r.paymentDate < r.deliveryDate) err(`farm.contracts "${r.id}": paid before it is delivered`);
    if (!f.prices.some(p => p.crop === r.crop)) {
      err(`farm.contracts "${r.id}": no ${r.crop} price to settle a shortfall at (farm.prices)`);
    }
  }
  for (const r of f.storage) {
    need('storage', r, 'operatorId', 'operators');
    crop('storage', r);
    nonNeg('storage', r, 'costPerBuMonth', { required: true });
  }
  const saleShares = new Map();
  for (const r of f.sales) {
    need('sales', r, 'operatorId', 'operators');
    crop('sales', r);
    share('sales', r, 'share');
    date('sales', r, 'saleDate');
    date('sales', r, 'paymentDate');
    if (r.paymentDate < r.saleDate) err(`farm.sales "${r.id}": paid before it is sold`);
    if (r.price == null && !f.prices.some(p => p.crop === r.crop)) {
      err(`farm.sales "${r.id}": no price, and no ${r.crop} price in farm.prices`);
    }
    if (r.price != null) nonNeg('sales', r, 'price');
    const k = `${r.operatorId}|${r.crop}|${r.cropYear}`;
    saleShares.set(k, (saleShares.get(k) ?? 0) + (isNum(r.share) ? r.share : 0));
  }
  for (const [k, total] of saleShares) {
    if (total > 1 + 1e-9) err(`farm.sales for ${k.replaceAll('|', ' ')} sell ${total} of the unpriced crop (more than all of it)`);
  }
  // A sale or delivery of THIS season's crop before its harvest would find an empty bin and
  // sell nothing, silently. Selling grain not yet harvested is a forward contract, and a
  // forward contract is a `contracts` row delivered after harvest.
  const y = f.season.cropYear;
  for (const [t, dateField] of [['sales', 'saleDate'], ['contracts', 'deliveryDate']]) {
    for (const r of f[t]) {
      if (r.cropYear !== y || !ISO_DAY.test(r[dateField] ?? '')) continue;
      const h = harvestDateFor(f.season.calendar, r.crop);
      if (r[dateField] < h) err(`farm.${t} "${r.id}": ${dateField} ${r[dateField]} is before the ${r.crop} harvest (${h})`);
    }
  }
  for (const r of f.carryIn) {
    need('carryIn', r, 'operatorId', 'operators');
    crop('carryIn', r);
    nonNeg('carryIn', r, 'bushels', { required: true });
    if (r.cropYear >= f.season.cropYear) err(`farm.carryIn "${r.id}": carry-in grain is from an earlier crop year`);
  }
  for (const r of f.otherIncome) {
    need('otherIncome', r, 'operatorId', 'operators');
    if (!Object.hasOwn(INCOME_CATEGORIES, r.category) || r.category === 'GRAIN_SALES') {
      err(`farm.otherIncome "${r.id}": "${r.category}" is not an other-income category`);
    }
    if (!isNum(r.amount)) err(`farm.otherIncome "${r.id}": amount must be a number`);
    date('otherIncome', r, 'paymentDate');
    if (r.planId != null) {
      need('otherIncome', r, 'planId', 'cropPlans');
      const plan = f.cropPlans.find(p => p.id === r.planId);
      const field = plan && f.fields.find(x => x.id === plan.fieldId);
      if (field && field.operatorId !== r.operatorId) err(`farm.otherIncome "${r.id}": its crop plan belongs to another operator`);
    }
  }
  for (const r of f.carryOut) {
    need('carryOut', r, 'operatorId', 'operators');
    if (!Object.hasOwn(PRODUCT_CATEGORIES, r.category)) err(`farm.carryOut "${r.id}": "${r.category}" is not a product category`);
    nonNeg('carryOut', r, 'amount', { required: true });
    date('carryOut', r, 'paidDate');
  }
  return errs;
}

/**
 * The yield a crop plan actually harvests, per planted acre (design 134 §6, §13.3):
 *
 *     dryland:    expectedYield × max(0, 1 + k·Y + plan.yieldShock)
 *     irrigated:  expectedYield × max(0, 1 + k·(β·Y + I) + plan.yieldShock)
 *
 * Y is `season.yieldShock`, the farm-wide dryland factor (weather). I is
 * `season.irrigatedYieldShock`, the factor irrigated fields share and dry ones do not: NASS
 * county history shows irrigated yields move mostly on their own, taking only β (≈0.05) of
 * the dryland shock (§13.8). k is `season.yieldShockScale[crop]`, the crop's share of both (a
 * soybean year swings less than a corn one). The plan shock is the field's own.
 *
 * `expectedYield` stays the PLAN: the breakevens and the contracted share are measured against
 * it, and only the harvest uses this. Both shocks are 0 unless a run sets them, so a
 * deterministic season harvests exactly what it planned.
 *
 * @param {object} farm normalized farm
 * @param {object} plan normalized crop plan
 * @param {object} [field] the plan's field (looked up when omitted)
 * @returns {number}
 */
export function realizedYield(farm, plan, field = farm.fields.find(x => x.id === plan.fieldId)) {
  const s = farm.season;
  const k = s.yieldShockScale?.[plan.crop] ?? 1;
  const common = field?.irrigated ? s.irrigatedYieldBeta * s.yieldShock + s.irrigatedYieldShock : s.yieldShock;
  return plan.expectedYield * Math.max(0, 1 + k * common + plan.yieldShock);
}

/**
 * Advisories on records that load and run but are probably incomplete (design 134 §14.1).
 * Never errors: the season still costs, but the named numbers are understated.
 *
 * - `ARC_IRRIGATED_PCT_DEFAULTED`: an ARC enrollment in a county with separate irrigated figures
 *   and no historical irrigated percentage, so this season's planting stands in for FSA's.
 * - `ARC_2025_HIGHER_OF`: a 2025 season with ARC, where the law pays the higher of PLC and ARC.
 * - `ARC_OVER_LIMIT`: an operator's ARC payment above the per-person limit, which is not applied.
 * - `APH_DEFAULTED`: an insured crop plan with no approved (APH) yield, so its guarantee is
 *   built on the expected yield (design 134 §15.2).
 * - `LABOR_NO_THROUGHPUT`: a season with a machine-labor wage and an operation in use with no
 *   acres per hour, so that operation's labor is not computed (design 134 §17.8). An operation
 *   with a crew of 0 has its labor in another's crew, and is not reported (§17.9).
 * - `NO_SEED`: a crop plan for an annual crop with no seed cost. Every annual crop is planted
 *   from seed bought for it, so a plan without one is a missing entry (the acceptance
 *   workbook had one, owner-confirmed, Q25), and its breakevens are too low by the seed cost.
 *   A perennial crop (alfalfa) is exempt: an established stand is not reseeded each year.
 *
 * @param {object} farm normalized farm
 * @returns {{ kind: string, planId: string, fieldId: string, message: string }[]}
 */
export function farmAdvisories(farm) {
  const out = [];
  const productById = new Map(farm.products.map(p => [p.id, p]));
  const fieldById = new Map(farm.fields.map(f => [f.id, f]));
  for (const plan of farm.cropPlans) {
    if (CROPS[plan.crop]?.perennial) continue;
    const seedCost = farm.prescriptions
      .filter(r => r.planId === plan.id && productById.get(r.productId)?.category === 'SEED')
      .reduce((s, r) => s + productById.get(r.productId).unitPrice * r.ratePerAcre * r.share, 0);
    if (seedCost > 0) continue;
    const f = fieldById.get(plan.fieldId);
    out.push({
      kind: 'NO_SEED', planId: plan.id, fieldId: plan.fieldId,
      message: `${f?.name ?? plan.fieldId} (${CROPS[plan.crop]?.label ?? plan.crop}) has no seed cost: `
        + 'probably a missing entry, so its costs and breakevens are understated.',
    });
  }
  if (farm.season?.laborPerHour > 0) {
    const used = new Set(farm.prescriptions.filter(r => r.operationId != null).map(r => r.operationId));
    for (const o of farm.operations) {
      if (!used.has(o.id) || o.acresPerHour != null || o.crew === 0) continue;
      out.push({
        kind: 'LABOR_NO_THROUGHPUT', operationId: o.id,
        message: `${o.name ?? o.id} has no acres per hour, so its machine labor is not computed.`,
      });
    }
  }
  for (const b of farm.arcBase) {
    if (!b.irrigatedPctDefaulted) continue;
    const split = farm.arcCounties.some(r => r.county === b.county && r.crop === b.crop && r.practice === 'IRRIGATED');
    if (!split) continue;
    out.push({
      kind: 'ARC_IRRIGATED_PCT_DEFAULTED', arcBaseId: b.id,
      message: `FSA farm ${b.fsaFarm} (${CROPS[b.crop]?.label ?? b.crop}) has no historical irrigated percentage: `
        + `this season's ${Math.round(b.irrigatedPct * 100)}% stands in for FSA's, which weights the ARC payment.`,
    });
  }
  if (farm.arcBase.length && farm.season.cropYear === 2025) {
    out.push({
      kind: 'ARC_2025_HIGHER_OF', message: 'For crop year 2025 the law pays the higher of PLC and ARC-County '
        + '(P.L. 119-21 §10303). The model has no PLC, so program payments may be understated.',
    });
  }
  const arcByOperator = new Map();
  for (const a of settleArc(farm)) arcByOperator.set(a.operatorId, (arcByOperator.get(a.operatorId) ?? 0) + a.payment);
  for (const [op, total] of arcByOperator) {
    if (total <= ARC_PLC_PAYMENT_LIMIT) continue;
    out.push({
      kind: 'ARC_OVER_LIMIT', operatorId: op,
      message: `${op}'s ARC payment of $${Math.round(total).toLocaleString('en-US')} is above the `
        + `$${ARC_PLC_PAYMENT_LIMIT.toLocaleString('en-US')} limit per person (before CPI indexing). `
        + 'The limit is not applied: it depends on how many people the operation counts.',
    });
  }
  for (const plan of farm.cropPlans) {
    const f = fieldById.get(plan.fieldId);
    if (!plan.aphDefaulted || !f) continue;
    if (!farm.insurance.some(r => r.operatorId === f.operatorId && r.crop === plan.crop)) continue;
    out.push({
      kind: 'APH_DEFAULTED', planId: plan.id, fieldId: plan.fieldId,
      message: `${f.name ?? f.id} (${CROPS[plan.crop]?.label ?? plan.crop}) is insured on its expected yield: `
        + 'no approved (APH) yield is entered, so its insurance guarantee is a guess.',
    });
  }
  return out;
}

/** The harvest date of `crop` in a resolved season calendar. */
export function harvestDateFor(calendar, crop) {
  return calendar.harvestDates?.[crop] ?? calendar.harvestDate;
}

/**
 * The cash price of `crop` on `date`: the latest `farm.prices` row on or before it, else the
 * earliest. A step function: a price row holds until the next one.
 *
 * `field` picks which price: `price` is the table as written, the season's EXPECTED path, which
 * the breakevens are planned against; `realized` is the path the season actually ran
 * (`applyPricePath`), which the sales are paid at. The two are equal unless a run draws shocks.
 *
 * @param {object[]} prices normalized `farm.prices`
 * @param {string} crop
 * @param {string} date YYYY-MM-DD
 * @param {'price'|'realized'} [field='price']
 * @returns {number|null}
 */
export function priceOn(prices, crop, date, field = 'price') {
  const rows = prices.filter(p => p.crop === crop).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (rows.length === 0) return null;
  let pick = rows[0];
  for (const r of rows) if (r.date <= date) pick = r;
  return pick[field] ?? pick.price;
}

const DAY_MS = 86_400_000;
const yearsBetween = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (365.25 * DAY_MS);

/**
 * The season's price path (design 134 §6, §13.5): set `realized` on every price row. Mutates
 * the normalized farm it is given.
 *
 * Each crop's table is the expected path. A run moves it by a log random walk through the
 * table's dates, from the season's plan date (1 January of the crop year, when the carry-in is
 * counted and the plan is made):
 *
 *     L_i = L_(i−1) + σ·√Δt_i·z_i − ½σ²·Δt_i − b·Δy_i
 *     realized_i = price_i · exp(L_i)
 *
 * - `σ` is the crop's annual price volatility (`season.priceVol[crop]`), `Δt_i` the years since
 *   the previous row (or the plan date), and `z_i` the row's standard-normal `shock`. The −½σ²Δt
 *   term keeps each realized price's mean at the table's price.
 * - `b` is the crop's **yield–price link** (`season.priceYieldBeta[crop]`): the log price move
 *   per unit of farm-wide yield shock, taken once, on the row IN FORCE on the crop's harvest
 *   date (the latest one on or before it; the first after it when none is), when the size of the
 *   crop is known. `Δy` is the season yield shock there and 0 elsewhere, and later rows carry
 *   it. A positive `b` makes a short crop dearer.
 * - A row dated on or before the plan date is already known: it never moves.
 *
 * With σ and b at 0 (the defaults) every realized price is the table's, exactly.
 *
 * @param {object} farm normalized farm (its `season` and `prices`)
 */
export function applyPricePath(farm) {
  const s = farm.season;
  const t0 = `${s.cropYear}-01-01`;
  const crops = new Set(farm.prices.map(p => p.crop));
  for (const crop of crops) {
    const vol = s.priceVol[crop] ?? 0;
    // The link reads the crop's own dryland shock, k·Y: what the calibration regressed on.
    const beta = (s.priceYieldBeta[crop] ?? 0) * (s.yieldShockScale?.[crop] ?? 1);
    const harvest = harvestDateFor(s.calendar, crop);
    const rows = farm.prices.filter(p => p.crop === crop)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const moving = rows.filter(r => r.date != null && r.date > t0);
    const linkRow = moving.filter(r => r.date <= harvest).at(-1) ?? moving.find(r => r.date > harvest) ?? null;
    let L = 0, prev = t0;
    for (const r of rows) {
      if (r.date == null || r.date <= t0 || (vol === 0 && beta === 0)) { r.realized = r.price; continue; }
      const dt = Math.max(0, yearsBetween(prev, r.date));
      L += vol * Math.sqrt(dt) * r.shock - 0.5 * vol * vol * dt;
      if (r === linkRow) L -= beta * s.yieldShock;
      r.realized = r.price * Math.exp(L);
      prev = r.date;
    }
  }
}
