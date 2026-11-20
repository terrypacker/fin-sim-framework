/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { SCHEDULE_F_LINES, COST_CATEGORIES, isProductCategory } from './schedule-f.js';
import { TENURE, priceOn, harvestDateFor, realizedYield, farmAdvisories } from './farm-records.js';
import { poolKey } from './farm-postings.js';

/**
 * The farm reports (design 134 §5.3–§5.4), computed from the ledger every time and never
 * stored. Both come from one list of postings:
 *
 * - **the job-cost report**: postings of the season's crop year, by job, with operator-level
 *   costs allocated to jobs by their declared basis when the report is built (§5.3);
 * - **the cash report**: cash postings by calendar year and Schedule F line, per operator,
 *   with the §464(d) prepaid-supplies limit applied.
 *
 * A posting's `date` is its cash date. Costing postings (`cash: false`) appear only in the
 * job-cost report.
 */

/** Maps a field the journal dropped as null back to null. */
const orNull = (v) => (v === undefined ? null : v);

/**
 * The farm ledger as rows, from a sim journal. The journal entry's payload is `action.data`.
 *
 * @param {object[]} journal `sim.journal.journal`
 * @returns {object[]} `{ date, operatorId, jobId, cropYear, category, line, kind, cash,
 *   allocation, amount, sourceId, receivableId, bushels, memo }`
 */
export function farmLedger(journal) {
  const rows = [];
  for (const e of journal ?? []) {
    if (e?.action?.type !== 'FARM_LEDGER_POST') continue;
    const d = e.action.data ?? e.action;
    rows.push({
      date:       (e.date instanceof Date ? e.date.toISOString() : String(e.date)).slice(0, 10),
      operatorId: d.operatorId,
      jobId:      d.jobId,
      cropYear:   d.cropYear,
      category:   d.category,
      line:       orNull(d.line),
      kind:       d.kind,
      cash:       d.cash !== false,
      allocation: orNull(d.allocation),
      amount:     d.amount,
      sourceId:   orNull(d.sourceId),
      receivableId: orNull(d.receivableId),
      bushels:    orNull(d.bushels),
      memo:       orNull(d.memo),
    });
  }
  return rows;
}

// ─── job-cost report ──────────────────────────────────────────────────────────────

/**
 * The crop-year job-cost report: one row per crop plan, then totals per operator, per crop
 * and for the whole farm.
 *
 * **Machinery has two bases** (design 134 §5.3). `CUSTOM` charges each plan its custom-hire
 * rate × passes (the costing postings); `ACTUAL` charges each plan its acre share of the
 * operator's real machinery figure. Every row carries both and the **machinery margin**
 * (custom − actual; positive means owning is cheaper than hiring). `machineryBasis` picks
 * which one is in `totalCost` and `net`.
 *
 * Allocation of an operator-level posting to that operator's plans:
 * - `ACRES` by planted acres; `OWNED_ACRES` by planted acres on owned fields; `FIELDS` by
 *   planted acres on the overhead record's own `fieldIds`;
 * - `BUSHELS` (a grain pool's revenue and storage) by the bushels each plan harvested into it
 *   (`realizedYield`; the expected bushels in a deterministic season).
 * A posting with no plan to land on (an `OWNED_ACRES` cost for an operator with no owned field)
 * is reported as `unallocated` on the operator, never dropped. `advisories` lists records that
 * ran but look incomplete (`farmAdvisories`: a crop plan with no seed cost).
 *
 * **Grain still on hand at the end of the run** is valued at the crop's last price and counted
 * as revenue in this view (design 134 §5.3: "the crop-year report values them at their contract
 * or expected price"); the cash report shows nothing for it.
 *
 * @param {object} farm normalized farm
 * @param {object[]} ledger `farmLedger(...)`
 * @param {object} [opts]
 * @param {'CUSTOM'|'ACTUAL'} [opts.machineryBasis='CUSTOM']
 * @param {object} [opts.pools] `state.farm.pools` at the end of the run
 * @param {object} [opts.receivables] `state.farm.receivables` at the end of the run
 */
export function jobCostReport(farm, ledger, { machineryBasis = 'CUSTOM', pools = {}, receivables = {} } = {}) {
  const y = farm.season.cropYear;
  const fieldById = new Map(farm.fields.map(f => [f.id, f]));

  const rows = new Map();
  for (const plan of farm.cropPlans) {
    const f = fieldById.get(plan.fieldId);
    rows.set(plan.id, _emptyRow({
      jobId: plan.id, planId: plan.id, fieldId: f.id, fieldName: f.name ?? f.id,
      operatorId: f.operatorId, crop: plan.crop, irrigated: f.irrigated, tenure: f.tenure,
      acres: f.plantedAcres, expectedYield: plan.expectedYield,
      expectedBushels: f.plantedAcres * plan.expectedYield,
      realizedYield: realizedYield(farm, plan, f),
      harvestedBushels: f.plantedAcres * realizedYield(farm, plan, f),
    }));
  }
  // A field with no crop plan still carries its rent and tax, on a job of its own.
  for (const f of farm.fields) {
    if (farm.cropPlans.some(p => p.fieldId === f.id)) continue;
    rows.set(`field:${f.id}`, _emptyRow({
      jobId: `field:${f.id}`, planId: null, fieldId: f.id, fieldName: f.name ?? f.id,
      operatorId: f.operatorId, crop: null, irrigated: f.irrigated, tenure: f.tenure,
      acres: f.plantedAcres, expectedYield: 0, expectedBushels: 0,
      realizedYield: 0, harvestedBushels: 0,
    }));
  }
  const plansOf = (op) => [...rows.values()].filter(r => r.operatorId === op && r.planId);
  const overheadById = new Map(farm.overhead.map(o => [o.id, o]));
  const unallocated = {};

  const weightsFor = (p) => {
    const op = p.operatorId;
    if (p.allocation === 'BUSHELS') {
      const [, crop] = p.jobId.slice('pool:'.length).split('|');
      // A pool's revenue and storage follow the bushels each plan put into it (§13.3).
      return plansOf(op).filter(r => r.crop === crop).map(r => [r, r.harvestedBushels]);
    }
    if (p.allocation === 'FIELDS') {
      const ids = new Set(overheadById.get(p.sourceId)?.fieldIds ?? []);
      return plansOf(op).filter(r => ids.has(r.fieldId)).map(r => [r, r.acres]);
    }
    if (p.allocation === 'OWNED_ACRES') {
      return plansOf(op).filter(r => r.tenure === TENURE.OWN).map(r => [r, r.acres]);
    }
    return plansOf(op).map(r => [r, r.acres]);
  };

  for (const p of ledger) {
    if (p.cropYear !== y) continue;
    const direct = rows.get(p.jobId);
    const targets = direct ? [[direct, 1]] : weightsFor(p);
    const total = targets.reduce((s, [, w]) => s + w, 0);
    if (!(total > 0)) {
      const u = (unallocated[p.operatorId] ??= { cost: 0, revenue: 0 });
      u[p.kind === 'REVENUE' ? 'revenue' : 'cost'] += p.amount;
      continue;
    }
    for (const [row, w] of targets) _book(row, p, p.amount * (w / total), !direct);
  }

  // Grain not yet paid for at the end of the run: open receivables at their amount, and
  // bushels still in a pool at the crop's last price.
  const lastDate = `${y + 2}-12-31`;
  const extra = [];
  for (const r of Object.values(receivables ?? {})) {
    if (r.cropYear === y) extra.push({ operatorId: r.operatorId, crop: r.crop, amount: r.amount });
  }
  for (const pool of Object.values(pools ?? {})) {
    if (pool.cropYear !== y || !(pool.bushels > 0)) continue;
    // Grain still in the bin is worth what the season's price path ended at.
    const price = priceOn(farm.prices, pool.crop, lastDate, 'realized') ?? 0;
    extra.push({ operatorId: pool.operatorId, crop: pool.crop, amount: pool.bushels * price });
  }
  for (const x of extra) {
    const targets = plansOf(x.operatorId).filter(r => r.crop === x.crop);
    const total = targets.reduce((s, r) => s + r.harvestedBushels, 0);
    if (!(total > 0)) {
      // No plan harvested any of this crop (a failed crop, or carry-in grain only): the value
      // is the operator's, reported unallocated rather than dropped.
      (unallocated[x.operatorId] ??= { cost: 0, revenue: 0 }).revenue += x.amount;
      continue;
    }
    for (const r of targets) {
      const share = x.amount * (r.harvestedBushels / total);
      r.revenue.grainOnHand += share;
      r.revenue.grain += share;
    }
  }

  // Contracted bushels and revenue, by plan, as the pool's share (design 134 §5.4).
  const contracts = new Map();
  for (const c of farm.contracts) {
    if (c.cropYear !== y) continue;
    const k = poolKey(c.operatorId, c.crop, c.cropYear);
    const e = contracts.get(k) ?? { bushels: 0, revenue: 0 };
    e.bushels += c.bushels; e.revenue += c.bushels * c.price;
    contracts.set(k, e);
  }
  const expectedPrice = (op, crop) => _expectedUnpricedPrice(farm, op, crop);

  for (const r of rows.values()) {
    if (r.planId) {
      const k = poolKey(r.operatorId, r.crop, y);
      const poolBu = plansOf(r.operatorId).filter(x => x.crop === r.crop).reduce((s, x) => s + x.expectedBushels, 0);
      const c = contracts.get(k);
      const share = poolBu > 0 ? r.expectedBushels / poolBu : 0;
      r.contractedBushels = (c?.bushels ?? 0) * share;
      r.contractedRevenue = (c?.revenue ?? 0) * share;
      r.expectedPrice = expectedPrice(r.operatorId, r.crop);
    }
    _finish(r, machineryBasis);
  }

  const planRows = [...rows.values()];
  const group = (keyFn, label) => {
    const m = new Map();
    for (const r of planRows) {
      const k = keyFn(r);
      if (k == null) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return [...m.entries()].map(([k, list]) => _sumRows(list, { [label]: k }, machineryBasis));
  };

  return {
    cropYear: y,
    machineryBasis,
    plans: planRows,
    byOperator: group(r => r.operatorId, 'operatorId'),
    byCrop:     group(r => r.crop, 'crop'),
    farm:       _sumRows(planRows, {}, machineryBasis),
    unallocated,
    advisories: farmAdvisories(farm),
  };
}

function _emptyRow(base) {
  return {
    ...base,
    // `otherByCategory` splits `other` by income category (crop insurance, program payments,
    // …), so a field shows each program on its own Schedule F line (design 134 §15.4).
    revenue: { grain: 0, grainOnHand: 0, other: 0, otherByCategory: {}, total: 0 },
    cost: {},            // category → direct cost
    overhead: {},        // category → allocated operator cost (excluding machinery)
    machinery: { custom: 0, actual: 0, margin: 0 },
    storage: 0,
    contractedBushels: 0, contractedRevenue: 0, expectedPrice: null,
  };
}

function _book(row, p, amount, allocated) {
  if (p.kind === 'REVENUE') {
    if (p.category === 'GRAIN_SALES') row.revenue.grain += amount;
    else {
      row.revenue.other += amount;
      row.revenue.otherByCategory[p.category] = (row.revenue.otherByCategory[p.category] ?? 0) + amount;
    }
    return;
  }
  if (p.category === 'CUSTOM_RATE') { row.machinery.custom += amount; return; }
  if (p.category === 'MACHINERY' || COST_CATEGORIES[p.category]?.machineWork) {
    row.machinery.actual += amount;
    return;
  }
  if (p.category === 'STORAGE')     { row.storage += amount; return; }
  const bucket = allocated ? row.overhead : row.cost;
  bucket[p.category] = (bucket[p.category] ?? 0) + amount;
}

const _sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);

function _finish(r, machineryBasis) {
  r.revenue.total = r.revenue.grain + r.revenue.other;
  r.machinery.margin = r.machinery.custom - r.machinery.actual;
  r.directCost = _sum(r.cost) + r.storage;
  r.overheadCost = _sum(r.overhead);
  r.machineryCost = machineryBasis === 'ACTUAL' ? r.machinery.actual : r.machinery.custom;
  r.totalCost = r.directCost + r.overheadCost + r.machineryCost;
  r.net = r.revenue.total - r.totalCost;
  const per = (v) => (r.acres > 0 ? v / r.acres : null);
  r.perAcre = { revenue: per(r.revenue.total), totalCost: per(r.totalCost), net: per(r.net) };
  Object.assign(r, breakevens(r));
}

/**
 * The three breakevens of design 134 §5.4, from a row's totals.
 *
 * - `breakevenPrice` = (total cost − non-grain revenue) ÷ expected bushels;
 * - `breakevenUnpricedPrice` = (total cost − non-grain revenue − contracted revenue) ÷ the
 *   bushels not under contract: the price the rest of the crop must fetch;
 * - `breakevenYield` (per acre): the bushels that cover cost with the contracted ones at their
 *   contract price and the rest at the expected price, ÷ acres.
 *
 * Each is null where its divisor is not positive (a row with no crop, a crop fully contracted).
 *
 * @param {{ totalCost: number, revenue: { other: number }, expectedBushels: number,
 *   contractedBushels: number, contractedRevenue: number, expectedPrice: number|null,
 *   acres: number }} r
 */
export function breakevens(r) {
  const need = r.totalCost - r.revenue.other;
  const unpriced = r.expectedBushels - r.contractedBushels;
  const breakevenPrice = r.expectedBushels > 0 ? need / r.expectedBushels : null;
  const breakevenUnpricedPrice = unpriced > 1e-9 ? (need - r.contractedRevenue) / unpriced : null;
  let breakevenYield = null;
  if (r.acres > 0 && r.expectedPrice > 0) {
    breakevenYield = (r.contractedBushels + (need - r.contractedRevenue) / r.expectedPrice) / r.acres;
  }
  return { breakevenPrice, breakevenUnpricedPrice, breakevenYield };
}

/**
 * Sum job-cost rows into one, as the report's operator, crop and farm rows are: a caller can
 * total any subset of `report.plans` (one operator's corn, say). A group of more than one crop
 * has no price breakevens (null), since a price across crops means nothing.
 *
 * @param {object[]} list rows of `jobCostReport(...).plans`
 * @param {object} [keys] fields copied onto the row (`{ operatorId }`, …)
 * @param {'CUSTOM'|'ACTUAL'} [machineryBasis='CUSTOM']
 */
export function sumPlanRows(list, keys = {}, machineryBasis = 'CUSTOM') {
  return _sumRows(list, keys, machineryBasis);
}

/**
 * The cumulative cash net through the run, month by month, for the farm and each operator:
 * every cash posting, revenue in and cost out, before §464(d) and §451(f), which move income
 * between tax years rather than move cash. Non-cash costing postings (custom rates, Q5a) are
 * not cash and are left out.
 *
 * The months are the whole season window (`seasonWindow`), so every path of a batch has the
 * same grid and its percentiles can be taken month by month.
 *
 * @param {object} farm normalized farm
 * @param {object[]} ledger `farmLedger(...)`
 * @returns {{ months: string[], series: Record<string, number[]> }} `months` are `YYYY-MM`;
 *   each series is the cumulative net at the END of each month, keyed `farm` and
 *   `operator.<id>`
 */
export function farmCashSeries(farm, ledger) {
  const y = farm.season.cropYear;
  const months = [];
  for (let yr = y - 1; yr <= y + 1; yr++) for (let m = 1; m <= 12; m++) months.push(`${yr}-${String(m).padStart(2, '0')}`);
  const index = new Map(months.map((m, i) => [m, i]));
  const scopes = ['farm', ...farm.operators.map(o => `operator.${o.id}`)];
  const flow = Object.fromEntries(scopes.map(k => [k, new Array(months.length).fill(0)]));
  for (const p of ledger) {
    if (!p.cash) continue;
    const i = index.get(p.date.slice(0, 7));
    if (i == null) continue;
    const v = p.kind === 'REVENUE' ? p.amount : -p.amount;
    flow.farm[i] += v;
    const k = `operator.${p.operatorId}`;
    if (flow[k]) flow[k][i] += v;
  }
  const series = {};
  for (const [k, f] of Object.entries(flow)) {
    let run = 0;
    series[k] = f.map(v => (run += v));
  }
  return { months, series };
}

function _sumRows(list, keys, machineryBasis) {
  const r = _emptyRow({
    ...keys, acres: 0, expectedBushels: 0, expectedYield: null, harvestedBushels: 0, realizedYield: null,
  });
  let priceWeight = 0, priceSum = 0;
  for (const x of list) {
    r.acres += x.acres;
    r.expectedBushels += x.expectedBushels;
    r.harvestedBushels += x.harvestedBushels;
    r.revenue.grain += x.revenue.grain;
    r.revenue.grainOnHand += x.revenue.grainOnHand;
    r.revenue.other += x.revenue.other;
    for (const [k, v] of Object.entries(x.revenue.otherByCategory)) {
      r.revenue.otherByCategory[k] = (r.revenue.otherByCategory[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(x.cost)) r.cost[k] = (r.cost[k] ?? 0) + v;
    for (const [k, v] of Object.entries(x.overhead)) r.overhead[k] = (r.overhead[k] ?? 0) + v;
    r.machinery.custom += x.machinery.custom;
    r.machinery.actual += x.machinery.actual;
    r.storage += x.storage;
    r.contractedBushels += x.contractedBushels;
    r.contractedRevenue += x.contractedRevenue;
    if (x.expectedPrice > 0) {
      const w = x.expectedBushels - x.contractedBushels;
      priceWeight += w; priceSum += w * x.expectedPrice;
    }
  }
  // A price across crops is meaningless, so a mixed group's price breakevens stay null.
  const crops = new Set(list.map(x => x.crop).filter(Boolean));
  if (crops.size === 1) {
    r.crop = [...crops][0];
    r.expectedPrice = priceWeight > 0 ? priceSum / priceWeight : null;
  }
  _finish(r, machineryBasis);
  if (crops.size !== 1) {
    r.breakevenPrice = null; r.breakevenUnpricedPrice = null; r.breakevenYield = null;
  }
  return r;
}

/**
 * The price an operator's unpriced bushels of `crop` are expected to fetch: the planned sales'
 * prices weighted by their shares, else the cash price at harvest.
 */
function _expectedUnpricedPrice(farm, op, crop) {
  const y = farm.season.cropYear;
  const sales = farm.sales.filter(s => s.operatorId === op && s.crop === crop && s.cropYear === y);
  let w = 0, sum = 0;
  for (const s of sales) {
    const p = s.price ?? priceOn(farm.prices, crop, s.saleDate);
    if (p == null) continue;
    w += s.share; sum += s.share * p;
  }
  if (w > 0) return sum / w;
  return priceOn(farm.prices, crop, harvestDateFor(farm.season.calendar, crop));
}

// ─── cash report (Schedule F) ─────────────────────────────────────────────────────

/**
 * The calendar-year cash report per operator, in Schedule F's shape (design 134 §7.1, Q14).
 *
 * Only the season's crop year is a **full** year. The year before holds only this season's
 * prepay, and the year after only its deferred sales and payments; a real Schedule F for
 * either also needs the neighbouring seasons (design 134 §5.5). Those years are reported,
 * marked `partial: true`, and §464(d) is not assessed on them: testing a lone prepay against
 * a year with no other expenses would defer nearly all of it, which is an artifact of what was
 * simulated and not a fact about the farm.
 *
 * **§464(d)** (docs/us-tax §464): prepaid farm supplies above 50% of the year's other
 * deductible farming expenses are not deductible until used, unless the operator is a
 * qualified farm-related taxpayer. The test here: a product cost paid in a calendar year
 * before the crop year it is for is a prepaid supply. An operator is exempt only when its
 * record says so: `farmRelated: true` and the three prior years' prepaid supplies below 50% of
 * their other farm expenses (§464(d)(2)(A)(i)). Absent that history the limit is applied,
 * and the row says why.
 *
 * @param {object} farm normalized farm
 * @param {object[]} ledger `farmLedger(...)`
 * @returns {object[]} one row per (operator, calendar year)
 */
export function cashReport(farm, ledger) {
  const y = farm.season.cropYear;
  const byKey = new Map();
  for (const p of ledger) {
    if (!p.cash) continue;
    const year = Number(p.date.slice(0, 4));
    const k = `${p.operatorId}|${year}`;
    if (!byKey.has(k)) {
      byKey.set(k, {
        operatorId: p.operatorId, year, partial: year !== y,
        income: {}, expense: {}, prepaidSupplies: 0,
      });
    }
    const row = byKey.get(k);
    const part = SCHEDULE_F_LINES[p.line]?.part ?? (p.kind === 'REVENUE' ? 'INCOME' : 'EXPENSE');
    const bucket = part === 'INCOME' ? row.income : row.expense;
    const sign = (part === 'INCOME') === (p.kind === 'REVENUE') ? 1 : -1;
    bucket[p.line] = (bucket[p.line] ?? 0) + sign * p.amount;
    if (p.kind === 'COST' && isProductCategory(p.category) && p.cropYear > year) row.prepaidSupplies += p.amount;
  }

  // §451(f) (design 134 §15.4): an electing operator's crop insurance proceeds received in the
  // year of the damage move to the next year's line 6d. The damage year is the crop year.
  const rowFor = (op, year) => {
    const k = `${op}|${year}`;
    if (!byKey.has(k)) byKey.set(k, { operatorId: op, year, partial: year !== y, income: {}, expense: {}, prepaidSupplies: 0 });
    return byKey.get(k);
  };
  const deferredByOp = new Map();
  for (const op of farm.operators) {
    const d = section451f(farm, ledger, op);
    if (d.deferred > 0) deferredByOp.set(op.id, d);
    rowFor(op.id, y).section451f = d;
  }
  for (const [op, d] of deferredByOp) {
    const next = rowFor(op, y + 1);
    next.income['6d'] = (next.income['6d'] ?? 0) + d.deferred;
  }

  const rows = [...byKey.values()].sort((a, b) =>
    a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : a.year - b.year);
  for (const r of rows) {
    if (r.income['4a'] != null) r.income['4b'] = r.income['4a'];
    if (r.income['6a'] != null) {
      const deferred = r.year === y ? (deferredByOp.get(r.operatorId)?.deferred ?? 0) : 0;
      r.income['6b'] = r.income['6a'] - deferred;
    }
    r.section451f ??= null;
    r.grossIncome = _sum(Object.fromEntries(Object.entries(r.income).filter(([l]) => !SCHEDULE_F_LINES[l]?.memo)));
    r.totalExpenses = _sum(r.expense);
    r.netBefore464 = r.grossIncome - r.totalExpenses;
    r.section464 = r.partial ? { assessed: false, reason: 'partial year (design 134 §5.5)' }
      : section464(farm.operators.find(o => o.id === r.operatorId), r.prepaidSupplies, r.totalExpenses - r.prepaidSupplies);
    r.net = r.netBefore464 + (r.section464.deferred ?? 0);
  }
  return rows;
}

/**
 * The §451(f) election for one operator (Reg. §1.451-6, docs/us-tax/): a cash-method farmer
 * may include crop insurance proceeds in the year after the damage, if under the operator's
 * normal business practice the crop's income would have been reported in a later year. One
 * election covers all the proceeds of one trade or business (§1.451-6(a)(2)), here one
 * operator. Proceeds already received in the next year are income then by receipt and need
 * no election.
 *
 * The normal-practice test the model can see: some of the operator's grain from this crop year
 * is paid after 31 December. Elected without it, nothing is deferred and the reason says so.
 *
 * @param {object} farm normalized farm
 * @param {object[]} ledger `farmLedger(...)`
 * @param {object} operator normalized operator
 * @returns {{ elected: boolean, eligible: boolean, deferred: number, received: number, reason: string }}
 */
export function section451f(farm, ledger, operator) {
  const y = farm.season.cropYear;
  const year = (p) => Number(p.date.slice(0, 4));
  const received = ledger
    .filter(p => p.cash && p.operatorId === operator.id && p.category === 'CROP_INSURANCE_PROCEEDS'
      && p.cropYear === y && year(p) === y)
    .reduce((s, p) => s + p.amount, 0);
  const laterSales = ledger.some(p => p.operatorId === operator.id && p.category === 'GRAIN_SALES'
    && p.cropYear === y && year(p) > y);
  const elected = operator.defer451f === true;
  let reason, eligible = laterSales;
  if (!elected) reason = 'not elected';
  else if (!laterSales) reason = `none of the ${y} crop is paid after 31 December, so it is not the normal practice to report the crop the next year`;
  else if (received === 0) reason = `no crop insurance proceeds received in ${y}`;
  else reason = `elected: ${y} proceeds reported in ${y + 1} (line 6d)`;
  const deferred = elected && eligible ? received : 0;
  return { elected, eligible, deferred, received, reason };
}

/**
 * The §464(d) test for one operator-year.
 *
 * @param {object} operator normalized operator record
 * @param {number} prepaid prepaid farm supplies paid in the year
 * @param {number} otherExpenses the year's other deductible farming expenses
 * @returns {{ assessed: true, applies: boolean, reason: string, prepaid: number,
 *   otherExpenses: number, limit: number, excess: number, deferred: number, headroom: number }}
 */
export function section464(operator, prepaid, otherExpenses) {
  const limit = 0.5 * Math.max(0, otherExpenses);
  const excess = Math.max(0, prepaid - limit);
  let applies = true;
  let reason = 'no three-year history on the operator record, so the limit is applied';
  const p3 = operator?.prior3PrepaidSupplies, e3 = operator?.prior3FarmExpenses;
  if (operator?.farmRelated === true && p3 != null && e3 != null) {
    if (p3 < 0.5 * e3) { applies = false; reason = 'qualified farm-related taxpayer, §464(d)(2)(A)(i)'; }
    else reason = 'farm-related, but the three prior years prepaid 50% or more';
  } else if (operator?.farmRelated === false) {
    reason = 'not a farm-related taxpayer';
  }
  return {
    assessed: true, applies, reason, prepaid, otherExpenses, limit, excess,
    deferred: applies ? excess : 0,
    headroom: Math.max(0, limit - prepaid),
  };
}
