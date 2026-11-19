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
 * Schedule F lines and the farm categories that post to them (design 134 §7.1).
 *
 * Transcribed from `docs/us-tax/IRS-Schedule-F-Form-2025.txt`, Part I (cash-method income,
 * lines 1–9) and Part II (expenses, lines 10–32). **Every category declares its line here,
 * once**: the cash report groups ledger postings by `line` and has no second mapping, so a
 * category that is not in this file cannot be posted at all (`categoryLine` throws).
 *
 * The one entry that is not a printed line is `MIXED_MACHINERY`. Phase 1 carries an
 * operator's machinery cost as one annual figure (design 134 Q17), and in reality that figure
 * spans lines 14 (depreciation and §179), 19 (fuel), 21 (interest) and 25 (repairs). Its
 * total is exact for the net and for SE tax, which is all the household side reads; the split
 * is needed only for §179's income limit (design 134 §7.1, phase 4). It is labelled as mixed
 * rather than filed silently under one of the four.
 */

/** @typedef {{ label: string, part: 'INCOME'|'EXPENSE' }} ScheduleFLine */

/** @type {Readonly<Record<string, ScheduleFLine>>} */
export const SCHEDULE_F_LINES = Object.freeze({
  '2':   { part: 'INCOME',  label: 'Sales of livestock, produce, grains, and other products you raised' },
  '4a':  { part: 'INCOME',  label: 'Agricultural program payments' },
  '6a':  { part: 'INCOME',  label: 'Crop insurance proceeds and federal crop disaster payments' },
  '7':   { part: 'INCOME',  label: 'Custom hire (machine work) income' },
  '8':   { part: 'INCOME',  label: 'Other income' },
  '10':  { part: 'EXPENSE', label: 'Car and truck expenses' },
  '11':  { part: 'EXPENSE', label: 'Chemicals' },
  '12':  { part: 'EXPENSE', label: 'Conservation expenses' },
  '13':  { part: 'EXPENSE', label: 'Custom hire (machine work)' },
  '14':  { part: 'EXPENSE', label: 'Depreciation and section 179 expense' },
  '17':  { part: 'EXPENSE', label: 'Fertilizers and lime' },
  '18':  { part: 'EXPENSE', label: 'Freight and trucking' },
  '19':  { part: 'EXPENSE', label: 'Gasoline, fuel, and oil' },
  '20':  { part: 'EXPENSE', label: 'Insurance (other than health)' },
  '21a': { part: 'EXPENSE', label: 'Interest: mortgage (paid to banks, etc.)' },
  '21b': { part: 'EXPENSE', label: 'Interest: other' },
  '22':  { part: 'EXPENSE', label: 'Labor hired (less employment credits)' },
  '24a': { part: 'EXPENSE', label: 'Rent or lease: vehicles, machinery, equipment' },
  '24b': { part: 'EXPENSE', label: 'Rent or lease: other (land, animals, etc.)' },
  '25':  { part: 'EXPENSE', label: 'Repairs and maintenance' },
  '26':  { part: 'EXPENSE', label: 'Seeds and plants' },
  '27':  { part: 'EXPENSE', label: 'Storage and warehousing' },
  '28':  { part: 'EXPENSE', label: 'Supplies' },
  '29':  { part: 'EXPENSE', label: 'Taxes' },
  '30':  { part: 'EXPENSE', label: 'Utilities' },
  '32':  { part: 'EXPENSE', label: 'Other expenses' },
  MIXED_MACHINERY: {
    part: 'EXPENSE',
    label: 'Machinery: one annual figure spanning lines 14, 19, 21 and 25 (design 134 Q17)',
  },
});

/**
 * The lines in the form's own order. An explicit list because an object's integer-like keys
 * (`'2'`, `'10'`) enumerate before its other keys (`'4a'`), which would print line 4a after 32.
 */
export const SCHEDULE_F_LINE_ORDER = Object.freeze([
  '2', '4a', '6a', '7', '8',
  '10', '11', '12', '13', '14', '17', '18', '19', '20', '21a', '21b', '22', '24a', '24b',
  '25', '26', '27', '28', '29', '30', '32', 'MIXED_MACHINERY',
]);

/**
 * Product categories (the input catalog). A product's category decides its Schedule F line
 * and, in phase 2, which category multiplier lever moves its price.
 *
 * Every product is a farm supply for §464(d): Pub 225 reads the limit as "feed, seed,
 * fertilizer, or other similar farm supplies", and the products here are all applied directly
 * in production. So a product line paid in a calendar year before its crop year is a prepaid
 * farm supply, whichever category it is.
 */
export const PRODUCT_CATEGORIES = Object.freeze({
  SEED:             { line: '26', label: 'Seed' },
  NITROGEN:         { line: '17', label: 'Nitrogen' },
  PHOSPHATE_POTASH: { line: '17', label: 'Phosphate and potash' },
  LIME:             { line: '17', label: 'Lime' },
  OTHER_FERTILIZER: { line: '17', label: 'Other fertilizer' },
  HERBICIDE:        { line: '11', label: 'Herbicide' },
  FUNGICIDE:        { line: '11', label: 'Fungicide' },
  INSECTICIDE:      { line: '11', label: 'Insecticide' },
  OTHER_CHEMICAL:   { line: '11', label: 'Other chemical' },
  SUPPLIES:         { line: '28', label: 'Supplies' },
});

/**
 * Cost categories the model posts itself, plus the ones an overhead record may name.
 * `overhead: true` marks a category an authored overhead pool may use.
 */
export const COST_CATEGORIES = Object.freeze({
  LAND_RENT:              { line: '24b', label: 'Cash rent' },
  PROPERTY_TAX:           { line: '29',  label: 'Property tax' },
  CROP_INSURANCE:         { line: '20',  label: 'Crop insurance premium' },
  IRRIGATION_ELECTRICITY: { line: '30',  label: 'Irrigation electricity' },
  MACHINERY:              { line: 'MIXED_MACHINERY', label: 'Machinery (own)' },
  STORAGE:                { line: '27',  label: 'Grain storage' },
  // Overhead categories — an operator's pooled costs (design 134 Q10).
  INTEREST_MORTGAGE:      { line: '21a', label: 'Land debt interest', overhead: true },
  INTEREST_OTHER:         { line: '21b', label: 'Other interest',     overhead: true },
  INSURANCE:              { line: '20',  label: 'Insurance',          overhead: true },
  TAXES:                  { line: '29',  label: 'Taxes',              overhead: true },
  UTILITIES:              { line: '30',  label: 'Utilities',          overhead: true },
  REPAIRS:                { line: '25',  label: 'Repairs',            overhead: true },
  LABOR:                  { line: '22',  label: 'Labor hired',        overhead: true },
  FUEL:                   { line: '19',  label: 'Fuel',               overhead: true },
  FREIGHT:                { line: '18',  label: 'Freight and trucking', overhead: true },
  CAR_TRUCK:              { line: '10',  label: 'Car and truck',      overhead: true },
  CUSTOM_HIRE:            { line: '13',  label: 'Custom hire paid',   overhead: true },
  MACHINERY_RENT:         { line: '24a', label: 'Machinery rent',     overhead: true },
  CONSERVATION:           { line: '12',  label: 'Conservation',       overhead: true },
  SUPPLIES_OVERHEAD:      { line: '28',  label: 'Supplies',           overhead: true },
  OTHER:                  { line: '32',  label: 'Other expenses',     overhead: true },
});

/** Income categories. Grain is the model's own; the rest are operator-level income rows. */
export const INCOME_CATEGORIES = Object.freeze({
  GRAIN_SALES:     { line: '2',  label: 'Grain sales' },
  PROGRAM_PAYMENT: { line: '4a', label: 'Agricultural program payment' },
  CROP_INSURANCE_PROCEEDS: { line: '6a', label: 'Crop insurance and disaster payments' },
  CUSTOM_HIRE_INCOME:      { line: '7',  label: 'Custom hire income' },
  OTHER_INCOME:    { line: '8',  label: 'Other income' },
});

/**
 * Costing-only categories: charged to a job in the crop-year view and never paid, so they
 * have no line (`line: null`). The custom-hire rate is a costing rate for the operator's own
 * machines (design 134 Q5a): no one is paid it, and the cash view carries the operator's real
 * machinery figure instead.
 */
export const COSTING_CATEGORIES = Object.freeze({
  CUSTOM_RATE: { line: null, label: 'Machine work at custom-hire rates (costing only)' },
});

/**
 * The Schedule F line a category posts to, or `null` for a costing-only category. Throws on an
 * unknown category: a posting with no line would fall out of the cash report while staying in
 * the job-cost one, and the two reports disagreeing silently is the failure the single ledger
 * exists to prevent.
 *
 * @param {string} category
 * @returns {string|null}
 */
export function categoryLine(category) {
  const entry = PRODUCT_CATEGORIES[category] ?? COST_CATEGORIES[category]
    ?? INCOME_CATEGORIES[category] ?? COSTING_CATEGORIES[category];
  if (!entry) throw new Error(`Unknown farm category "${category}"`);
  return entry.line;
}

/** The display label of any farm category. */
export function categoryLabel(category) {
  return (PRODUCT_CATEGORIES[category] ?? COST_CATEGORIES[category]
    ?? INCOME_CATEGORIES[category] ?? COSTING_CATEGORIES[category])?.label ?? category;
}

/** True when `category` is an input-catalog (product) category. */
export function isProductCategory(category) {
  return Object.hasOwn(PRODUCT_CATEGORIES, category);
}
