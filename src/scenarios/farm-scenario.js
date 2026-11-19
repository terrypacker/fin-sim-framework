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

  static getParamSchema() { return []; }
  static getToolsets()    { return ['US_FARM_OPERATIONS']; }

  /**
   * @param {object} [params]   `{ cropYear, farm }`: a whole `farm` replaces the demo.
   * @param {Date|string} [simStart] defaults to 1 January of the year before the crop year
   * @param {Date|string} [simEnd]   defaults to 1 January two years after it (design 134 §5.2)
   */
  static buildDefaultConfig(params = {}, simStart, simEnd) {
    const farm = params.farm ? structuredClone(params.farm) : demoFarm(params.cropYear ?? 2027);
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
    seasons: [{ id: `s${y}`, cropYear: y }],
    operators: [
      { id: 'opA', name: 'Operator A' },
      { id: 'opB', name: 'Operator B' },
    ],
    fields: [
      { id: 'a-home-irr', operatorId: 'opA', name: 'Home quarter (irrigated)', tenure: 'OWN',
        plantedAcres: 125, irrigated: true, propertyTax: 9_000 },
      { id: 'a-home-dry', operatorId: 'opA', name: 'Home quarter (dry corners)', tenure: 'OWN',
        plantedAcres: 30, irrigated: false, propertyTax: 1_200 },
      { id: 'a-west', operatorId: 'opA', name: 'West rented', tenure: 'CASH_RENT',
        rentedAcres: 80, plantedAcres: 78, irrigated: false, rentPerAcre: 190 },
      { id: 'b-river', operatorId: 'opB', name: 'River rented (irrigated)', tenure: 'CASH_RENT',
        rentedAcres: 150, plantedAcres: 146, irrigated: true, rentPerAcre: 300 },
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
      { id: 'p-a-home-irr', fieldId: 'a-home-irr', crop: 'CORN',     expectedYield: 230,
        insurancePremiumPerAcre: 22, irrigationElectricity: 6_500 },
      { id: 'p-a-home-dry', fieldId: 'a-home-dry', crop: 'SOYBEANS', expectedYield: 50,
        insurancePremiumPerAcre: 14 },
      { id: 'p-a-west',     fieldId: 'a-west',     crop: 'SOYBEANS', expectedYield: 52,
        insurancePremiumPerAcre: 14 },
      { id: 'p-b-river',    fieldId: 'b-river',    crop: 'CORN',     expectedYield: 225,
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
    carryOut: [
      // Next crop's seed and fertilizer, prepaid in December (Q11; capped by §464(d)).
      { id: 'co-a-seed', operatorId: 'opA', category: 'SEED',     amount: 38_000 },
      { id: 'co-a-n',    operatorId: 'opA', category: 'NITROGEN', amount: 24_000 },
      { id: 'co-b-seed', operatorId: 'opB', category: 'SEED',     amount: 20_000 },
    ],
  };
}
