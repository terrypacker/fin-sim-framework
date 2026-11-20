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
import {
  TENURE, TRUCKING_LEGS, harvestDateFor, priceOn, realizedYield, categoryMultiplierField,
} from './farm-records.js';
import { settleInsurance, settleArc } from './farm-programs.js';

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
      const date = rx.paidDate ?? cal.inputDate;
      post(date, `${opn.name ?? opn.id} (custom rate) — ${plan.id}`, {
        operatorId: f.operatorId, jobId: plan.id, category: 'CUSTOM_RATE', cash: false,
        amount: acres * rx.passes * opn.customRatePerAcre * m.customRateMultiplier, sourceId: rx.id,
      });
      // The same work with the operator's own machines (design 134 §17.8): fuel per acre per
      // application, and the hours (acres ÷ acres per hour) × the crew at the season's wage.
      // Cash, and on the ACTUAL machinery side of the job cost.
      const trips = acres * rx.applications;
      post(date, `${opn.name ?? opn.id} fuel — ${plan.id}`, {
        operatorId: f.operatorId, jobId: plan.id, category: 'MACHINE_FUEL',
        amount: trips * opn.fuelPerAcre * m.fuelMultiplier, sourceId: rx.id,
      });
      if (opn.acresPerHour > 0) {
        post(date, `${opn.name ?? opn.id} labor — ${plan.id}`, {
          operatorId: f.operatorId, jobId: plan.id, category: 'MACHINE_LABOR',
          amount: trips / opn.acresPerHour * opn.crew * season.laborPerHour, sourceId: rx.id,
        });
      }
    }
  }

  // ── crop insurance indemnities (design 134 §15.2) ──────────────────────────────────
  // Settled at compile time like the harvest: the realized yields and the price path are
  // known once the season's draws are. Paid to the unit, charged to its plans by shortfall.
  const policyById = new Map(farm.insurance.map(r => [r.id, r]));
  for (const u of settleInsurance(farm)) {
    const policy = policyById.get(u.insuranceId);
    for (const { planId, amount } of u.byPlan) {
      post(policy.paymentDate, `Crop insurance indemnity — ${planId}`, {
        operatorId: u.operatorId, jobId: planId, category: 'CROP_INSURANCE_PROCEEDS', kind: 'REVENUE',
        amount, sourceId: u.insuranceId, memo: `${u.plan} ${u.unit} unit`,
      });
    }
  }

  // ── ARC-County (design 134 §15.3) ──────────────────────────────────────────────────
  // Paid on the FSA farm's BASE acres, not on what is planted, so it is split by planted
  // acres over the operator's plans of THAT crop on the farm's fields, as the source workbook
  // spreads a farm number's payment. Keeping the crop keeps a corn payment out of a soybean
  // field's P&L. With none of that crop planted there, over all the farm's plans; with no
  // field on the farm at all, over the operator's acres.
  for (const a of settleArc(farm)) {
    if (!(a.payment > 0)) continue;
    const base = farm.arcBase.find(b => b.id === a.arcBaseId);
    const onFarm = farm.cropPlans
      .map(p => [p, fieldById.get(p.fieldId)])
      .filter(([, f]) => f && f.operatorId === a.operatorId && f.fsaFarm === a.fsaFarm);
    const sameCrop = onFarm.filter(([p]) => p.crop === a.crop);
    const plans = sameCrop.length ? sameCrop : onFarm;
    const acres = plans.reduce((s, [, f]) => s + f.plantedAcres, 0);
    const memo = `ARC-CO ${a.crop}, FSA farm ${a.fsaFarm}`;
    if (acres > 0) {
      for (const [plan, f] of plans) {
        post(base.paymentDate, `ARC-County — ${plan.id}`, {
          operatorId: a.operatorId, jobId: plan.id, category: 'PROGRAM_PAYMENT', kind: 'REVENUE',
          amount: a.payment * f.plantedAcres / acres, sourceId: a.arcBaseId, memo,
        });
      }
    } else {
      post(base.paymentDate, `ARC-County — ${a.operatorId}`, {
        operatorId: a.operatorId, jobId: operatorJob(a.operatorId), category: 'PROGRAM_PAYMENT',
        kind: 'REVENUE', allocation: 'ACRES', amount: a.payment, sourceId: a.arcBaseId, memo,
      });
    }
  }

  // ── operator costs: machinery, overhead, the carry-out prepay ──────────────────────
  for (const mach of farm.machinery) {
    // `costingOnly`: an ownership charge at per-acre rates (§17.9), not the cash figure.
    post(mach.paidDate, `${mach.costingOnly ? (mach.name ?? 'Machinery ownership') : 'Machinery'} — ${mach.operatorId}`, {
      operatorId: mach.operatorId, jobId: operatorJob(mach.operatorId),
      category: mach.costingOnly ? 'MACHINERY_OWNERSHIP' : 'MACHINERY', ...(mach.costingOnly ? { cash: false } : {}),
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

  for (const t of truckingPostings(farm)) post(t.date, t.name, t);

  // Events that tie on (date, order) keep this array's order: the toolset registers them in
  // it, and the queue breaks remaining ties by insertion (design 134; queue total order).
  return out;
}

/**
 * Trucking (design 134 §17.8), per bushel: every harvested bushel out of the field on the
 * harvest date, and every bushel that leaves storage AFTER harvest again, on the day it goes.
 *
 * Settled at compile time like the harvest, from the realized yields. Each of this season's
 * pools is walked in date order: a contract moves its bushels, a planned sale its share of
 * the unpriced bushels (harvested less contracted), each capped by what is still in the bin.
 * Grain delivered on the harvest date goes straight from the field and is hauled once. A
 * storage-leg charge is split over the pool's plans by their harvested bushels.
 *
 * @param {object} farm normalized farm
 * @returns {object[]} postings for `post`, each with its `date` and `name`
 */
function truckingPostings(farm) {
  if (!farm.trucking.length) return [];
  const y = farm.season.cropYear;
  const cal = farm.season.calendar;
  const rate = (op, crop, leg) =>
    farm.trucking.find(t => t.operatorId === op && t.crop === crop && t.leg === leg)?.perBu ?? 0;
  const out = [];
  const pools = new Map();
  for (const plan of farm.cropPlans) {
    const f = farm.fields.find(x => x.id === plan.fieldId);
    const bu = f.plantedAcres * realizedYield(farm, plan, f);
    const k = `${f.operatorId}|${plan.crop}`;
    if (!pools.has(k)) pools.set(k, { op: f.operatorId, crop: plan.crop, plans: [], bu: 0 });
    const pool = pools.get(k);
    pool.plans.push([plan, bu]);
    pool.bu += bu;
    const field = rate(f.operatorId, plan.crop, TRUCKING_LEGS.FIELD);
    out.push({
      date: harvestDateFor(cal, plan.crop), name: `Trucking out of the field — ${plan.id}`,
      operatorId: f.operatorId, jobId: plan.id, category: 'TRUCKING', amount: bu * field, sourceId: plan.id,
    });
  }
  for (const pool of pools.values()) {
    const perBu = rate(pool.op, pool.crop, TRUCKING_LEGS.STORAGE_TO_SALE);
    if (!(perBu > 0) || !(pool.bu > 0)) continue;
    const harvest = harvestDateFor(cal, pool.crop);
    const mine = (r) => r.operatorId === pool.op && r.crop === pool.crop && r.cropYear === y;
    const contracts = farm.contracts.filter(mine);
    const unpriced = Math.max(0, pool.bu - contracts.reduce((s, c) => s + c.bushels, 0));
    const moves = [
      ...contracts.map(c => ({ date: c.deliveryDate, order: 1, want: c.bushels, id: c.id })),
      ...farm.sales.filter(mine).map(s => ({ date: s.saleDate, order: 2, want: s.share * unpriced, id: s.id })),
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
    let left = pool.bu;
    for (const mv of moves) {
      const bu = Math.min(mv.want, left);
      left -= bu;
      if (mv.date <= harvest || !(bu > 0)) continue;
      for (const [plan, planBu] of pool.plans) {
        out.push({
          date: mv.date, name: `Trucking from storage — ${plan.id}`, operatorId: pool.op, jobId: plan.id,
          category: 'TRUCKING', amount: bu * perBu * planBu / pool.bu, sourceId: mv.id,
        });
      }
    }
  }
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
