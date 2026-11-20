/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { BaseScenario }    from './base-scenario.js';
import { ServiceRegistry } from '../services/service-registry.js';
import { seasonWindow }    from '../finance/farm/farm-records.js';
import { FARM_PRICE_HISTORY } from '../finance/farm/farm-price-history-data.js';

/**
 * FarmScenario — a row-crop farm as job costing (design 134).
 *
 * Not a household: no persons, no accounts, one toolset. The farm is one scenario for all of
 * its operators (design 134 §5.1); each operator's results reach their own household plan
 * through an export (§8), never by putting the households in here.
 *
 * The default farm below is a DEMO. Every number is an illustrative round figure chosen to
 * exercise a mechanic (an owned and a rented field, irrigated and dry, a prepay, a deferred
 * sale, a carry-in), not anyone's books. A real farm is authored as `cfg.farm` and stays
 * under `scenarios/`, which is private (design 134 §2).
 */
export class FarmScenario extends BaseScenario {
  /** The demo farm's crop year, and so its default season window. */
  static DEFAULT_CROP_YEAR = 2027;

  static scenarioId()   { return 'us-farm'; }
  static scenarioName() { return 'US Farm (job costing)'; }

  static instantiate(params, simStart, simEnd) {
    return new FarmScenario({
      context: ServiceRegistry.getInstance().simulationContext,
      params,
      simStart,
      simEnd,
    });
  }

  /**
   * The demo's crop year (design 134 §17.5). Only the DEMO moves with it: its illustrative
   * costs stay as they are, so a past year shows the charts against that year's real prices,
   * not that year's farm. A farm from a file (`cfg.farm` with no `farmDemo` mark) ignores it.
   * The earliest year is the first with a published year before it (the demo carries grain
   * in from the year before).
   */
  static getParamSchema() {
    return [{
      key: 'farmDemoCropYear', label: 'Demo crop year', type: 'Number', group: 'Farm',
      min: FarmScenario.MIN_DEMO_CROP_YEAR, max: FarmScenario.DEFAULT_CROP_YEAR, step: 1,
      mc: false, opt: false,
      defaultValue: FarmScenario.DEFAULT_CROP_YEAR,
      description: 'Crop year of the US Farm demo. The demo farm, its season window and its '
        + 'dated records move to this year, so the Field P&L charts read that year\'s published '
        + 'prices; the demo\'s illustrative costs do not change. Ignored by a farm loaded from a file.',
    }];
  }

  static MIN_DEMO_CROP_YEAR = FARM_PRICE_HISTORY.from + 1;

  /**
   * Whether an uploaded scenario record with no `scenarioId` is a farm: it has `cfg.farm`.
   * The upload uses this so a farm file opens as a farm, not as the first prebuilt.
   */
  static claimsConfig(cfg) { return cfg?.farm != null && typeof cfg.farm === 'object'; }

  /**
   * Bring a demo record to its `farmDemoCropYear` param before the sim is built: a new demo
   * farm and season window for that year. Runs from ScenarioService.createActiveScenario,
   * because the window must be set before buildSim. No-op for a farm from a file, or a year
   * outside [MIN_DEMO_CROP_YEAR, DEFAULT_CROP_YEAR] (the editor's min/max).
   *
   * @param {object} rec    the scenario record (mutated)
   * @param {object} params name → value
   * @returns {boolean} whether the record changed
   */
  static prepareRecord(rec, params = {}) {
    if (!rec?.farmDemo) return false;
    const y = Number(params.farmDemoCropYear);
    if (!Number.isInteger(y) || y < FarmScenario.MIN_DEMO_CROP_YEAR || y > FarmScenario.DEFAULT_CROP_YEAR) return false;
    if (rec.farm?.seasons?.[0]?.cropYear === y) return false;
    const w = seasonWindow(y);
    rec.farm = demoFarm(y);
    rec.simStart = w.simStart;
    rec.simEnd = w.simEnd;
    // A saved compiled graph belongs to the old year.
    rec.events = []; rec.handlers = []; rec.actions = []; rec.reducers = []; rec.initialState = {};
    return true;
  }
  static getToolsets()    { return ['US_FARM_OPERATIONS']; }

  /**
   * @param {object} [params]   `{ farmDemoCropYear, cropYear, farm }`: a whole `farm` replaces the
   *   demo; otherwise the demo is built for `farmDemoCropYear` (or `cropYear`), and the record is
   *   marked `farmDemo` so a later change of that param moves it (`prepareRecord`).
   * @param {Date|string} [simStart] defaults to 1 January of the year before the crop year
   * @param {Date|string} [simEnd]   defaults to 1 January two years after it (design 134 §5.2)
   */
  static buildDefaultConfig(params = {}, simStart, simEnd) {
    const isDemo = !params.farm;
    const farm = isDemo
      ? demoFarm(params.farmDemoCropYear ?? params.cropYear ?? FarmScenario.DEFAULT_CROP_YEAR)
      : structuredClone(params.farm);
    const y = farm.seasons[0].cropYear;
    const w = seasonWindow(y);
    const iso = (d, fallback) => (d == null ? fallback
      : (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10));
    return {
      toolsets:       FarmScenario.getToolsets(),
      simStart:       iso(simStart, w.simStart),
      simEnd:         iso(simEnd, w.simEnd),
      parameters:     {},
      persons:        [],
      accounts:       [],
      realProperties: [],
      collectibles:   [],
      farm,
      ...(isDemo ? { farmDemo: true } : {}),
    };
  }
}

/**
 * The demo farm: two operators, four fields, corn and soybeans.
 *
 * @param {number} y crop year
 */
export function demoFarm(y) {
  const d = (yy, md) => `${yy}-${md}`;
  return {
    // Projected prices are the insurance's February futures averages (CEPP); a placeholder
    // pair here, above the local cash table by a typical basis.
    // The national marketing-year price ARC-County is paid on: placeholders near today's.
    seasons: [{ id: `s${y}`, cropYear: y, projectedPrice: { CORN: 4.40, SOYBEANS: 10.50 },
      nationalPrice: { CORN: 4.20, SOYBEANS: 10.40 } }],
    operators: [
      { id: 'opA', name: 'Operator A' },
      { id: 'opB', name: 'Operator B' },
    ],
    fields: [
      { id: 'a-home-irr', operatorId: 'opA', name: 'Home quarter (irrigated)', tenure: 'OWN',
        plantedAcres: 125, irrigated: true, propertyTax: 9_000, communityCollegeTax: 600, fsaFarm: '1001' },
      { id: 'a-home-dry', operatorId: 'opA', name: 'Home quarter (dry corners)', tenure: 'OWN',
        plantedAcres: 30, irrigated: false, propertyTax: 1_200, communityCollegeTax: 80, fsaFarm: '1001' },
      { id: 'a-west', operatorId: 'opA', name: 'West rented', tenure: 'CASH_RENT',
        rentedAcres: 80, plantedAcres: 78, irrigated: false, rentPerAcre: 190, fsaFarm: '1002' },
      { id: 'b-river', operatorId: 'opB', name: 'River rented (irrigated)', tenure: 'CASH_RENT',
        rentedAcres: 150, plantedAcres: 146, irrigated: true, rentPerAcre: 300, fsaFarm: '1003' },
    ],
    products: [
      { id: 'seed-corn',  name: 'Corn seed',      category: 'SEED',      unit: 'unit (80k kernels)', unitPrice: 300, discountPct: 0.08 },
      { id: 'seed-soy',   name: 'Soybean seed',   category: 'SEED',      unit: 'unit (140k seeds)',  unitPrice: 60,  discountPct: 0.05 },
      { id: 'anhydrous',  name: 'Anhydrous ammonia', category: 'NITROGEN', unit: 'lb N', unitPrice: 0.55 },
      { id: 'map',        name: 'MAP 11-52-0',    category: 'PHOSPHATE_POTASH', unit: 'lb', unitPrice: 0.40 },
      { id: 'herb-pre',   name: 'Pre-emerge herbicide', category: 'HERBICIDE', unit: 'acre', unitPrice: 28 },
      { id: 'herb-post',  name: 'Post herbicide', category: 'HERBICIDE', unit: 'acre', unitPrice: 22 },
      { id: 'fungicide',  name: 'Fungicide',      category: 'FUNGICIDE', unit: 'acre', unitPrice: 25 },
    ],
    operations: [
      { id: 'plant',   name: 'Plant',   customRatePerAcre: 25 },
      { id: 'spray',   name: 'Spray',   customRatePerAcre: 9 },
      { id: 'harvest', name: 'Combine', customRatePerAcre: 40 },
    ],
    cropPlans: [
      { id: 'p-a-home-irr', fieldId: 'a-home-irr', crop: 'CORN',     expectedYield: 230, aphYield: 221,
        insurancePremiumPerAcre: 22, irrigationElectricity: 6_500 },
      { id: 'p-a-home-dry', fieldId: 'a-home-dry', crop: 'SOYBEANS', expectedYield: 50, aphYield: 47,
        insurancePremiumPerAcre: 14 },
      { id: 'p-a-west',     fieldId: 'a-west',     crop: 'SOYBEANS', expectedYield: 52, aphYield: 48,
        insurancePremiumPerAcre: 14 },
      { id: 'p-b-river',    fieldId: 'b-river',    crop: 'CORN',     expectedYield: 225, aphYield: 218,
        insurancePremiumPerAcre: 24, irrigationElectricity: 8_000 },
    ],
    prescriptions: [
      // Corn: seed, N, P, two herbicide passes, fungicide on part, three custom operations.
      ...['p-a-home-irr', 'p-b-river'].flatMap(planId => [
        { id: `${planId}-seed`,  planId, productId: 'seed-corn', ratePerAcre: 0.425 },
        { id: `${planId}-n`,     planId, productId: 'anhydrous', ratePerAcre: 200 },
        { id: `${planId}-p`,     planId, productId: 'map',       ratePerAcre: 100 },
        { id: `${planId}-pre`,   planId, productId: 'herb-pre',  ratePerAcre: 1 },
        { id: `${planId}-post`,  planId, productId: 'herb-post', ratePerAcre: 1 },
        { id: `${planId}-fung`,  planId, productId: 'fungicide', ratePerAcre: 1, share: 0.6 },
        { id: `${planId}-plant`, planId, operationId: 'plant' },
        { id: `${planId}-spray`, planId, operationId: 'spray', passes: 3 },
        { id: `${planId}-comb`,  planId, operationId: 'harvest' },
      ]),
      ...['p-a-home-dry', 'p-a-west'].flatMap(planId => [
        { id: `${planId}-seed`,  planId, productId: 'seed-soy',  ratePerAcre: 1 },
        { id: `${planId}-pre`,   planId, productId: 'herb-pre',  ratePerAcre: 1 },
        { id: `${planId}-post`,  planId, productId: 'herb-post', ratePerAcre: 1 },
        { id: `${planId}-plant`, planId, operationId: 'plant' },
        { id: `${planId}-spray`, planId, operationId: 'spray', passes: 2 },
        { id: `${planId}-comb`,  planId, operationId: 'harvest' },
      ]),
    ],
    machinery: [
      { id: 'mach-a', operatorId: 'opA', amount: 26_000 },
      { id: 'mach-b', operatorId: 'opB', amount: 15_000 },
    ],
    overhead: [
      { id: 'oh-a-int',  operatorId: 'opA', name: 'Land debt interest', category: 'INTEREST_MORTGAGE',
        amount: 14_000, basis: 'OWNED_ACRES', paidDate: d(y, '12-01') },
      { id: 'oh-a-ins',  operatorId: 'opA', name: 'Farm liability insurance', category: 'INSURANCE', amount: 3_200 },
      { id: 'oh-a-util', operatorId: 'opA', name: 'Shop utilities', category: 'UTILITIES', amount: 2_400 },
      { id: 'oh-b-ins',  operatorId: 'opB', name: 'Farm liability insurance', category: 'INSURANCE', amount: 2_100 },
      { id: 'oh-b-labor', operatorId: 'opB', name: 'Harvest help', category: 'LABOR', amount: 6_000,
        paidDate: d(y, '11-15') },
    ],
    prices: [
      { id: 'pc-harvest', crop: 'CORN',     date: d(y, '10-01'), price: 4.10 },
      { id: 'pc-winter',  crop: 'CORN',     date: d(y + 1, '01-15'), price: 4.35 },
      { id: 'pc-spring',  crop: 'CORN',     date: d(y + 1, '03-15'), price: 4.45 },
      { id: 'ps-harvest', crop: 'SOYBEANS', date: d(y, '10-01'), price: 10.20 },
      { id: 'ps-winter',  crop: 'SOYBEANS', date: d(y + 1, '01-15'), price: 10.60 },
      { id: 'pc-carry',   crop: 'CORN',     date: d(y, '01-01'), price: 4.30 },
    ],
    contracts: [
      { id: 'k-a-corn',  operatorId: 'opA', crop: 'CORN',     bushels: 10_000, price: 4.40,
        deliveryDate: d(y, '10-25'), paymentDate: d(y, '11-05') },
      { id: 'k-a-soy',   operatorId: 'opA', crop: 'SOYBEANS', bushels: 2_500,  price: 10.75,
        deliveryDate: d(y, '10-10') },
      { id: 'k-b-corn',  operatorId: 'opB', crop: 'CORN',     bushels: 12_000, price: 4.35,
        deliveryDate: d(y, '10-25'), paymentDate: d(y + 1, '01-10') },
      // Carry-in corn, contracted last year for spring delivery.
      { id: 'k-a-old',   operatorId: 'opA', crop: 'CORN', cropYear: y - 1, bushels: 6_000, price: 4.55,
        deliveryDate: d(y, '03-01') },
    ],
    storage: [
      { id: 'st-a-corn', operatorId: 'opA', crop: 'CORN',     costPerBuMonth: 0.04 },
      { id: 'st-a-soy',  operatorId: 'opA', crop: 'SOYBEANS', costPerBuMonth: 0.05 },
      { id: 'st-b-corn', operatorId: 'opB', crop: 'CORN',     costPerBuMonth: 0.04 },
    ],
    sales: [
      { id: 's-a-corn-h', operatorId: 'opA', crop: 'CORN',     share: 0.4, saleDate: d(y, '10-28') },
      { id: 's-a-corn-w', operatorId: 'opA', crop: 'CORN',     share: 0.6, saleDate: d(y + 1, '03-20') },
      { id: 's-a-soy-h',  operatorId: 'opA', crop: 'SOYBEANS', share: 0.5, saleDate: d(y, '10-15') },
      // Sold in December, paid in January: income deferred into the next tax year (Q11).
      { id: 's-a-soy-d',  operatorId: 'opA', crop: 'SOYBEANS', share: 0.5, saleDate: d(y, '12-15'),
        paymentDate: d(y + 1, '01-05') },
      { id: 's-b-corn-h', operatorId: 'opB', crop: 'CORN',     share: 0.5, saleDate: d(y, '11-01') },
      { id: 's-b-corn-w', operatorId: 'opB', crop: 'CORN',     share: 0.5, saleDate: d(y + 1, '01-20') },
      { id: 's-a-old',    operatorId: 'opA', crop: 'CORN', cropYear: y - 1, share: 1, saleDate: d(y, '02-01') },
    ],
    carryIn: [
      { id: 'ci-a-corn', operatorId: 'opA', crop: 'CORN', bushels: 9_000 },
    ],
    otherIncome: [
      // Last crop's ARC-County payment, paid from 1 October after its marketing year
      // (7 U.S.C. §9017(f)): a carry-in amount (design 134 §5.5).
      { id: 'arc-a-prev', operatorId: 'opA', category: 'PROGRAM_PAYMENT', amount: 4_800,
        paymentDate: d(y, '10-15'), cropYear: y - 1 },
      { id: 'arc-b-prev', operatorId: 'opB', category: 'PROGRAM_PAYMENT', amount: 2_900,
        paymentDate: d(y, '10-15'), cropYear: y - 1 },
    ],
    // Revenue protection on every crop (design 134 §15.2). A deterministic season pays
    // nothing: the harvest is the plan, above every guarantee.
    insurance: [
      { id: 'ins-a-corn', operatorId: 'opA', crop: 'CORN',     plan: 'RP', coverageLevel: 0.80, unit: 'ENTERPRISE' },
      { id: 'ins-a-soy',  operatorId: 'opA', crop: 'SOYBEANS', plan: 'RP', coverageLevel: 0.75, unit: 'ENTERPRISE' },
      { id: 'ins-b-corn', operatorId: 'opB', crop: 'CORN',     plan: 'RP', coverageLevel: 0.85, unit: 'ENTERPRISE' },
    ],
    // ARC-County on every FSA farm (Q13), paid on base acres from 1 October next year. The
    // county figures are placeholders shaped like FSA's file (`npm run farm:arc`).
    arcCounties: [
      { id: 'cty-corn-irr', county: 'Demo', crop: 'CORN',     practice: 'IRRIGATED',    benchmarkYield: 222, benchmarkPrice: 5.03 },
      { id: 'cty-corn-dry', county: 'Demo', crop: 'CORN',     practice: 'NONIRRIGATED', benchmarkYield: 140, benchmarkPrice: 5.03 },
      { id: 'cty-soy',      county: 'Demo', crop: 'SOYBEANS', practice: 'ALL',          benchmarkYield: 56,  benchmarkPrice: 12.17 },
    ],
    arcBase: [
      { id: 'arc-1001-corn', operatorId: 'opA', fsaFarm: '1001', crop: 'CORN',     baseAcres: 110, county: 'Demo', irrigatedPct: 0.8 },
      { id: 'arc-1001-soy',  operatorId: 'opA', fsaFarm: '1001', crop: 'SOYBEANS', baseAcres: 40,  county: 'Demo' },
      { id: 'arc-1002-soy',  operatorId: 'opA', fsaFarm: '1002', crop: 'SOYBEANS', baseAcres: 70,  county: 'Demo' },
      { id: 'arc-1003-corn', operatorId: 'opB', fsaFarm: '1003', crop: 'CORN',     baseAcres: 135, county: 'Demo', irrigatedPct: 1 },
    ],
    carryOut: [
      // Next crop's seed and fertilizer, prepaid in December (Q11; capped by §464(d)).
      { id: 'co-a-seed', operatorId: 'opA', category: 'SEED',     amount: 38_000 },
      { id: 'co-a-n',    operatorId: 'opA', category: 'NITROGEN', amount: 24_000 },
      { id: 'co-b-seed', operatorId: 'opB', category: 'SEED',     amount: 20_000 },
    ],
  };
}
