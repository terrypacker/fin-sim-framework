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

/**
 * Farm records (design 134 §5.1): flat tables joined by id, in `cfg.farm`.
 *
 * ```js
 * cfg.farm = {
 *   seasons:       [{ id, cropYear, calendar? }],            // phase 1: exactly one
 *   operators:     [{ id, name, farmRelated?, prior3PrepaidSupplies?, prior3FarmExpenses? }],
 *   fields:        [{ id, operatorId, name, tenure, rentedAcres, plantedAcres, irrigated,
 *                     rentPerAcre, propertyTax, fsaFarm?, baseAcres?, provenYield? }],
 *   products:      [{ id, name, category, unit, unitPrice, discountPct }],
 *   operations:    [{ id, name, customRatePerAcre }],
 *   cropPlans:     [{ id, fieldId, crop, expectedYield, insurancePremiumPerAcre,
 *                     irrigationElectricity }],
 *   prescriptions: [{ id, planId, productId | operationId, ratePerAcre, passes, share, paidDate? }],
 *   machinery:     [{ id, operatorId, amount, paidDate? }],
 *   overhead:      [{ id, operatorId, name, category, amount, basis, paidDate? }],
 *   prices:        [{ id, crop, date, price }],
 *   contracts:     [{ id, operatorId, crop, cropYear?, bushels, price, deliveryDate,
 *                     paymentDate?, buyoutPerBu? }],
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

/** Overhead allocation bases (design 134 §5.3). Planted acres, or owned planted acres. */
export const OVERHEAD_BASIS = Object.freeze({ ACRES: 'ACRES', OWNED_ACRES: 'OWNED_ACRES' });

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
  const season = season0 ? { ...season0, cropYear: y, calendar } : null;
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
    o.paidDate = day(o.paidDate) ?? calendar.overheadDate;
  }
  for (const p of out.prices) p.date = day(p.date);
  for (const c of out.contracts) {
    c.cropYear  ??= y;
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
    if (!Object.hasOwn(OVERHEAD_BASIS, r.basis)) err(`farm.overhead "${r.id}": basis must be ACRES or OWNED_ACRES`);
    nonNeg('overhead', r, 'amount', { required: true });
    date('overhead', r, 'paidDate');
  }
  for (const r of f.prices) {
    crop('prices', r);
    date('prices', r, 'date');
    nonNeg('prices', r, 'price', { required: true });
  }
  for (const r of f.contracts) {
    need('contracts', r, 'operatorId', 'operators');
    crop('contracts', r);
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

/** The harvest date of `crop` in a resolved season calendar. */
export function harvestDateFor(calendar, crop) {
  return calendar.harvestDates?.[crop] ?? calendar.harvestDate;
}

/**
 * The cash price of `crop` on `date`: the latest `farm.prices` row on or before it, else the
 * earliest. A step function, deliberately: phase 1 is deterministic and a price is a number
 * someone wrote down; phase 2 replaces this with a sampled path through the marketing year
 * (design 134 §6).
 *
 * @param {object[]} prices normalized `farm.prices`
 * @param {string} crop
 * @param {string} date YYYY-MM-DD
 * @returns {number|null}
 */
export function priceOn(prices, crop, date) {
  const rows = prices.filter(p => p.crop === crop).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (rows.length === 0) return null;
  let pick = rows[0];
  for (const r of rows) if (r.date <= date) pick = r;
  return pick.price;
}
