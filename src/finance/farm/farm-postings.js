/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { categoryLine } from './schedule-f.js';
import { TENURE, harvestDateFor, priceOn, realizedYield, categoryMultiplierField } from './farm-records.js';

/**
 * The farm calendar (design 134 §5.2) compiled from normalized records into dated events.
 * Pure, and independent of the simulation, so a test can read the whole season as a list.
 *
 * Four event kinds, each a `{ type, date, order, data }` spec the toolset wraps in a
 * `OneOffEvent`:
 *
 * | type             | data                     | what it does                                    |
 * |------------------|--------------------------|-------------------------------------------------|
 * | `FARM_POST`      | a posting                | one cost or revenue line, amount known now      |
 * | `FARM_GRAIN_IN`  | a pool and bushels       | harvest, or the carry-in on 1 January (§5.5)    |
 * | `FARM_GRAIN_OUT` | a contract or a sale     | bushels leave a pool; opens a receivable        |
 * | `FARM_PAYMENT`   | a receivable id          | the receivable is paid: grain revenue posts     |
 *
 * **Grain revenue is a two-step flow on purpose.** On the cash method a sale is income when it
 * is paid (Reg. §1.61-4), and a payment date after 31 December is how the owners defer sales
 * (design 134 Q11). The sale date moves bushels and fixes the amount; the payment date is when
 * the ledger posts it. Between the two it is a receivable in state, which is also exactly what
 * the crop-year report needs to value at 31 December.
 *
 * `order` breaks ties on one date: grain in (0) before grain out (contracts 1, then sales 2),
 * then payments (3), then fixed postings (4). Deliveries before sales matters only for a short
 * crop, where `FARM_GRAIN_OUT` caps each draw at what the pool still holds.
 */

export const FARM_EVENT = Object.freeze({
  POST:      'FARM_POST',
  GRAIN_IN:  'FARM_GRAIN_IN',
  GRAIN_OUT: 'FARM_GRAIN_OUT',
  PAYMENT:   'FARM_PAYMENT',
});

/** Job ids. A crop plan is the job (design 134 §5.1); an operator also has its own job. */
export const operatorJob = (operatorId) => `operator:${operatorId}`;
export const fieldJob    = (fieldId) => `field:${fieldId}`;

/** A grain pool: one operator's bushels of one crop from one crop year. */
export const poolKey = (operatorId, crop, cropYear) => `${operatorId}|${crop}|${cropYear}`;

/**
 * Compile a normalized farm (`normalizeFarm`) into its season's event specs.
 *
 * @param {object} farm normalized farm
 * @returns {Array<{ type: string, date: string, order: number, name: string, data: object }>}
 */
export function compileFarmEvents(farm) {
  const season = farm.season;
  const y = season.cropYear;
  const cal = season.calendar;
  const out = [];

  const fieldById = new Map(farm.fields.map(f => [f.id, f]));
  const planByField = new Map(farm.cropPlans.map(p => [p.fieldId, p]));
  const productById = new Map(farm.products.map(p => [p.id, p]));
  const operationById = new Map(farm.operations.map(o => [o.id, o]));
  const planById = new Map(farm.cropPlans.map(p => [p.id, p]));
  const jobOfField = (f) => planByField.get(f.id)?.id ?? fieldJob(f.id);
  // The season's multipliers (design 134 §13.6), each 1 unless a run sets it.
  const m = season;

  /** A fixed posting. `cash: false` is a costing charge (design 134 Q5a), never paid. */
  const post = (date, name, p) => {
    if (!(p.amount > 0) && !p.allowZero) return;
    out.push({
      type: FARM_EVENT.POST, date, order: 4, name,
      data: {
        posting: {
          operatorId: p.operatorId,
          jobId:      p.jobId,
          cropYear:   p.cropYear ?? y,
          category:   p.category,
          line:       categoryLine(p.category),
          kind:       p.kind ?? 'COST',
          cash:       p.cash ?? true,
          allocation: p.allocation ?? null,
          amount:     p.amount,
          sourceId:   p.sourceId,
          memo:       p.memo ?? null,
        },
      },
    });
  };

  // ── field costs: rent, property tax ────────────────────────────────────────────────
  for (const f of farm.fields) {
    const job = jobOfField(f);
    if (f.tenure === TENURE.CASH_RENT && f.rentPerAcre > 0) {
      const rent = f.rentedAcres * f.rentPerAcre * m.rentMultiplier;
      const spring = rent * cal.rentSpringShare;
      post(cal.rentSpringDate, `Rent (spring) — ${f.name ?? f.id}`,
        { operatorId: f.operatorId, jobId: job, category: 'LAND_RENT', amount: spring, sourceId: f.id });
      post(cal.rentFallDate, `Rent (fall) — ${f.name ?? f.id}`,
        { operatorId: f.operatorId, jobId: job, category: 'LAND_RENT', amount: rent - spring, sourceId: f.id });
    }
    if (f.propertyTax > 0) {
      const half = f.propertyTax / 2;
      post(cal.propertyTaxFirstDate, `Property tax (1st half) — ${f.name ?? f.id}`,
        { operatorId: f.operatorId, jobId: job, category: 'PROPERTY_TAX', amount: half, sourceId: f.id });
      post(cal.propertyTaxSecondDate, `Property tax (2nd half) — ${f.name ?? f.id}`,
        { operatorId: f.operatorId, jobId: job, category: 'PROPERTY_TAX', amount: f.propertyTax - half, sourceId: f.id });
    }
  }

  // ── crop plans: insurance, irrigation, prescriptions, harvest ──────────────────────
  for (const plan of farm.cropPlans) {
    const f = fieldById.get(plan.fieldId);
    const acres = f.plantedAcres;
    const op = f.operatorId;
    post(cal.insurancePremiumDate, `Crop insurance — ${plan.id}`, {
      operatorId: op, jobId: plan.id, category: 'CROP_INSURANCE',
      amount: acres * plan.insurancePremiumPerAcre, sourceId: plan.id,
    });
    post(cal.irrigationDate, `Irrigation electricity — ${plan.id}`, {
      operatorId: op, jobId: plan.id, category: 'IRRIGATION_ELECTRICITY',
      amount: plan.irrigationElectricity * m.irrigationMultiplier, sourceId: plan.id,
    });
    out.push({
      type: FARM_EVENT.GRAIN_IN, date: harvestDateFor(cal, plan.crop), order: 0,
      name: `Harvest — ${plan.id}`,
      data: {
        kind: 'HARVEST', operatorId: op, crop: plan.crop, cropYear: y, planId: plan.id,
        bushels: acres * realizedYield(farm, plan, f), sourceId: plan.id,
      },
    });
  }
  for (const rx of farm.prescriptions) {
    const plan = planById.get(rx.planId);
    const f = fieldById.get(plan.fieldId);
    const acres = f.plantedAcres * rx.share;
    if (rx.productId != null) {
      const prod = productById.get(rx.productId);
      const prepaid = cal.prepayCategories.includes(prod.category);
      post(rx.paidDate ?? (prepaid ? cal.prepayDate : cal.inputDate), `${prod.name ?? prod.id} — ${plan.id}`, {
        operatorId: f.operatorId, jobId: plan.id, category: prod.category,
        amount: acres * rx.ratePerAcre * prod.unitPrice * (1 - prod.discountPct)
          * m[categoryMultiplierField(prod.category)], sourceId: rx.id,
      });
    } else {
      const opn = operationById.get(rx.operationId);
      post(rx.paidDate ?? cal.inputDate, `${opn.name ?? opn.id} (custom rate) — ${plan.id}`, {
        operatorId: f.operatorId, jobId: plan.id, category: 'CUSTOM_RATE', cash: false,
        amount: acres * rx.passes * opn.customRatePerAcre * m.customRateMultiplier, sourceId: rx.id,
      });
    }
  }

  // ── operator costs: machinery, overhead, the carry-out prepay ──────────────────────
  for (const mach of farm.machinery) {
    post(mach.paidDate, `Machinery — ${mach.operatorId}`, {
      operatorId: mach.operatorId, jobId: operatorJob(mach.operatorId), category: 'MACHINERY',
      allocation: 'ACRES', amount: mach.amount * m.machineryMultiplier, sourceId: mach.id,
    });
  }
  for (const o of farm.overhead) {
    post(o.paidDate, `${o.name ?? o.category} — ${o.operatorId}`, {
      operatorId: o.operatorId, jobId: operatorJob(o.operatorId), category: o.category,
      allocation: o.basis, amount: o.amount * (o.variableRate ? m.interestMultiplier : 1), sourceId: o.id,
    });
  }
  for (const c of farm.carryOut) {
    post(c.paidDate, `Prepay for ${y + 1} (${c.category}) — ${c.operatorId}`, {
      operatorId: c.operatorId, jobId: operatorJob(c.operatorId), category: c.category,
      cropYear: y + 1, amount: c.amount, sourceId: c.id, memo: 'carry-out',
    });
  }
  for (const i of farm.otherIncome) {
    out.push({
      type: FARM_EVENT.POST, date: i.paymentDate, order: 4, name: `${i.category} — ${i.operatorId}`,
      data: {
        posting: {
          operatorId: i.operatorId, jobId: i.planId ?? operatorJob(i.operatorId),
          cropYear: i.cropYear, category: i.category, line: categoryLine(i.category),
          kind: 'REVENUE', cash: true, allocation: i.planId ? null : 'ACRES',
          amount: i.amount, sourceId: i.id, memo: null,
        },
      },
    });
  }

  // ── grain: carry-in, contracts, planned sales ──────────────────────────────────────
  for (const c of farm.carryIn) {
    out.push({
      type: FARM_EVENT.GRAIN_IN, date: cal.carryInDate, order: 0, name: `Carry-in — ${c.id}`,
      data: {
        kind: 'CARRY_IN', operatorId: c.operatorId, crop: c.crop, cropYear: c.cropYear,
        planId: null, bushels: c.bushels, sourceId: c.id,
      },
    });
  }
  const storageRate = (op, crop) =>
    farm.storage.find(s => s.operatorId === op && s.crop === crop)?.costPerBuMonth ?? 0;
  for (const c of farm.contracts) {
    out.push({
      type: FARM_EVENT.GRAIN_OUT, date: c.deliveryDate, order: 1, name: `Contract delivery — ${c.id}`,
      data: {
        kind: 'CONTRACT', operatorId: c.operatorId, crop: c.crop, cropYear: c.cropYear,
        sourceId: c.id, receivableId: `contract:${c.id}`, bushels: c.bushels, price: c.price,
        marketPrice: priceOn(farm.prices, c.crop, c.deliveryDate, 'realized'),
        buyoutPerBu: c.buyoutPerBu, paymentDate: c.paymentDate,
        storagePerBuMonth: storageRate(c.operatorId, c.crop),
      },
    });
    out.push(paymentSpec(`contract:${c.id}`, c.paymentDate, `Contract payment — ${c.id}`));
  }
  for (const s of farm.sales) {
    out.push({
      type: FARM_EVENT.GRAIN_OUT, date: s.saleDate, order: 2, name: `Planned sale — ${s.id}`,
      data: {
        kind: 'SALE', operatorId: s.operatorId, crop: s.crop, cropYear: s.cropYear,
        sourceId: s.id, receivableId: `sale:${s.id}`, share: s.share, price: s.price ?? priceOn(farm.prices, s.crop, s.saleDate, 'realized'),
        paymentDate: s.paymentDate, storagePerBuMonth: storageRate(s.operatorId, s.crop),
      },
    });
    out.push(paymentSpec(`sale:${s.id}`, s.paymentDate, `Sale payment — ${s.id}`));
  }

  // Events that tie on (date, order) keep this array's order: the toolset registers them in
  // it, and the queue breaks remaining ties by insertion (design 134; queue total order).
  return out;
}

function paymentSpec(receivableId, date, name) {
  return { type: FARM_EVENT.PAYMENT, date, order: 3, name, data: { receivableId } };
}

/**
 * The bushels each pool is contracted for, by `poolKey`. A planned sale sells a share of a
 * pool's UNPRICED bushels (design 134 §5.1): what was harvested less what is under contract.
 *
 * @param {object} farm normalized farm
 * @returns {Record<string, number>}
 */
export function contractedByPool(farm) {
  const out = {};
  for (const c of farm.contracts) {
    const k = poolKey(c.operatorId, c.crop, c.cropYear);
    out[k] = (out[k] ?? 0) + c.bushels;
  }
  return out;
}
