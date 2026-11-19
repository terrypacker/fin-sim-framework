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

/**
 * Farm records (design 134 §5.1): flat tables joined by id, in `cfg.farm`.
 *
 * ```js
 * cfg.farm = {
 *   seasons:       [{ id, cropYear, calendar?, yieldShock?, irrigatedYieldShock?, irrigatedYieldBeta?,
 *                     yieldShockScale?: { [crop]: k }, priceVol?: { [crop]: σ }, priceYieldBeta?: { [crop]: b },
 *                     rentMultiplier?, customRateMultiplier?, machineryMultiplier?,
 *                     irrigationMultiplier?, interestMultiplier?,
 *                     <category>Multiplier? (one per PRODUCT_CATEGORIES, e.g. nitrogenMultiplier) }],
 *   operators:     [{ id, name, farmRelated?, prior3PrepaidSupplies?, prior3FarmExpenses? }],
 *   fields:        [{ id, operatorId, name, tenure, rentedAcres, plantedAcres, irrigated,
 *                     rentPerAcre, propertyTax, fsaFarm?, baseAcres?, provenYield? }],
 *   products:      [{ id, name, category, unit, unitPrice, discountPct }],
 *   operations:    [{ id, name, customRatePerAcre }],
 *   cropPlans:     [{ id, fieldId, crop, expectedYield, yieldShock?, insurancePremiumPerAcre,
 *                     irrigationElectricity }],
 *   prescriptions: [{ id, planId, productId | operationId, ratePerAcre, passes, share, paidDate? }],
 *   machinery:     [{ id, operatorId, amount, paidDate? }],
 *   overhead:      [{ id, operatorId, name, category, amount, basis, fieldIds?, paidDate?, variableRate? }],
 *   prices:        [{ id, crop, date, price, shock? }],
 *   contracts:     [{ id, operatorId, crop, cropYear?, bushels | shareOfExpected, price,
 *                     deliveryDate, paymentDate?, buyoutPerBu? }],
 *   storage:       [{ id, operatorId, crop, costPerBuMonth }],
 *   sales:         [{ id, operatorId, crop, cropYear?, share, saleDate, paymentDate?, price? }],
 *   carryIn:       [{ id, operatorId, crop, bushels, cropYear? }],
 *   otherIncome:   [{ id, operatorId, category, amount, paymentDate, cropYear?, planId? }],
 *   carryOut:      [{ id, operatorId, category, amount, paidDate? }],
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
]);

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
});

/** `NITROGEN` → `nitrogenMultiplier`, `PHOSPHATE_POTASH` → `phosphatePotashMultiplier`. */
export const categoryMultiplierField = (category) =>
  `${category.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())}Multiplier`;

/** Interest categories a `variableRate` overhead row may carry. */
export const INTEREST_CATEGORIES = Object.freeze(['INTEREST_MORTGAGE', 'INTEREST_OTHER']);

/** Commodities. A crop plan names one; grain pools by (operator, crop, crop year). */
export const CROPS = Object.freeze({
  CORN:     { label: 'Corn',     unit: 'bu' },
  SOYBEANS: { label: 'Soybeans', unit: 'bu' },
  WHEAT:    { label: 'Wheat',    unit: 'bu' },
  SORGHUM:  { label: 'Sorghum',  unit: 'bu' },
  ALFALFA:  { label: 'Alfalfa',  unit: 'ton' },
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
    // The shocks' SHAPE defaults to the NASS calibration (design 134 §13.8). Each is a no-op
    // while the shocks are 0, so a deterministic season is unchanged by it. The price vol is
    // not: its mean correction moves a price, so it stays blank here (FarmMcRunner fills it
    // for a crop whose price shocks it samples).
    irrigatedYieldBeta:  season0.irrigatedYieldBeta ?? FARM_CALIBRATION.irrigatedYieldBeta,
    yieldShockScale:     { ...FARM_CALIBRATION.yieldShockScale, ...(season0.yieldShockScale ?? {}) },
    priceVol:            { ...(season0.priceVol ?? {}) },
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
  }
  for (const f of out.fields) {
    f.irrigated   = f.irrigated === true;
    f.rentPerAcre ??= 0;
    f.propertyTax ??= 0;
    f.rentedAcres ??= (f.tenure === TENURE.CASH_RENT ? f.plantedAcres : 0);
  }
  for (const p of out.products) p.discountPct ??= 0;
  for (const p of out.cropPlans) {
    p.yieldShock ??= 0;
    p.insurancePremiumPerAcre ??= 0;
    p.irrigationElectricity   ??= 0;
  }
  for (const rx of out.prescriptions) {
    rx.share ??= 1;
    if (rx.operationId != null) rx.passes ??= 1;
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
    if (r.tenure === TENURE.OWN && r.rentPerAcre > 0) err(`farm.fields "${r.id}": an owned field pays no cash rent`);
  }
  for (const r of f.products) {
    if (!Object.hasOwn(PRODUCT_CATEGORIES, r.category)) err(`farm.products "${r.id}": unknown category "${r.category}"`);
    nonNeg('products', r, 'unitPrice', { required: true });
    share('products', r, 'discountPct');
  }
  for (const r of f.operations) nonNeg('operations', r, 'customRatePerAcre', { required: true });

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
    if (isOperation) { need('prescriptions', r, 'operationId', 'operations'); nonNeg('prescriptions', r, 'passes'); }
    share('prescriptions', r, 'share');
    if (r.paidDate != null) date('prescriptions', r, 'paidDate');
  }
  for (const r of f.machinery) {
    need('machinery', r, 'operatorId', 'operators');
    nonNeg('machinery', r, 'amount', { required: true });
    date('machinery', r, 'paidDate');
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
