/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }      from '../../simulation-framework/handlers.js';
import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { ValueType }         from '../../simulation-framework/type-registry.js';
import { categoryLine }      from './schedule-f.js';
import { FARM_EVENT, poolKey } from './farm-postings.js';

/**
 * Handlers and the reducer for the farm ledger (design 134 §5.3).
 *
 * **The journal is the ledger.** Every cost and revenue line is one `FARM_LEDGER_POST` action
 * carrying its operator, job, crop year, category and Schedule F line; its journal entry's
 * date is the cash date. The job-cost P&L groups those entries by crop year and the cash P&L
 * by calendar year, so both reports read one ledger (`farm-reports.js`). State holds only
 * what a later event must read: the grain pools, the open receivables, and a running cash
 * net per operator.
 *
 * `state.farm`:
 * ```js
 * {
 *   cropYear,
 *   pools:       { [poolKey]: { operatorId, crop, cropYear, bushels, harvested, enteredMs } },
 *   contracted:  { [poolKey]: bushels },     // compile-time, read by planned sales
 *   receivables: { [id]: { operatorId, crop, cropYear, amount, bushels, paymentDate, kind } },
 *   cash:        { [operatorId]: net cash so far },
 * }
 * ```
 */

/** The job a grain pool's revenue and storage are charged to, split to plans by bushels. */
export const poolJob = (key) => `pool:${key}`;

const MS_PER_MONTH = (365.25 / 12) * 86_400_000;

/** The action manifests (design 91). An undeclared field never reaches the journal. */
export const FARM_ACTION_TYPES = [
  { type: 'FARM_LEDGER_POST',
    fields: {
      operatorId:   ValueType.text(),
      jobId:        ValueType.text(),
      cropYear:     ValueType.number(),
      category:     ValueType.text(),
      line:         ValueType.text(),
      kind:         ValueType.enum(['COST', 'REVENUE']),
      cash:         ValueType.boolean(),
      allocation:   ValueType.text(),
      amount:       ValueType.currency('USD'),
      sourceId:     ValueType.text(),
      receivableId: ValueType.text(),
      bushels:      ValueType.number(),
      memo:         ValueType.text(),
    } },
  { type: 'FARM_GRAIN_MOVE',
    fields: {
      kind:       ValueType.enum(['HARVEST', 'CARRY_IN', 'DELIVER', 'SELL']),
      operatorId: ValueType.text(),
      crop:       ValueType.text(),
      cropYear:   ValueType.number(),
      pool:       ValueType.text(),
      planId:     ValueType.text(),
      bushels:    ValueType.number(),
      shortBushels: ValueType.number(),
      sourceId:   ValueType.text(),
    } },
  { type: 'FARM_RECEIVABLE_OPEN',
    fields: {
      receivableId: ValueType.text(),
      sourceId:     ValueType.text(),
      kind:         ValueType.enum(['CONTRACT', 'SALE']),
      operatorId:   ValueType.text(),
      crop:         ValueType.text(),
      cropYear:     ValueType.number(),
      pool:         ValueType.text(),
      bushels:      ValueType.number(),
      amount:       ValueType.currency('USD'),
      paymentDate:  ValueType.text(),
    } },
];

/** A fixed posting, amount known at compile (`farm-postings.js`). */
export class FarmPostHandler extends HandlerEntry {
  static type        = 'FarmPostHandler';
  static category    = 'handler';
  static eventType   = FARM_EVENT.POST;
  static description = 'Posts one farm cost or revenue line to the job-cost ledger (design 134 §5.3).';

  constructor() {
    super(null, 'Farm Post');
    this.generatedActionTypes = ['FARM_LEDGER_POST'];
  }

  call({ data }) {
    const p = data?.posting;
    if (!p) return [];
    return [{ type: 'FARM_LEDGER_POST', ...p, receivableId: null, bushels: null }];
  }
}

/** Harvest, or the carry-in on 1 January: bushels into a pool. */
export class FarmGrainInHandler extends HandlerEntry {
  static type        = 'FarmGrainInHandler';
  static category    = 'handler';
  static eventType   = FARM_EVENT.GRAIN_IN;
  static description = 'Puts harvested or carried-in bushels into their grain pool (design 134 §5.3, §5.5).';

  constructor() {
    super(null, 'Farm Grain In');
    this.generatedActionTypes = ['FARM_GRAIN_MOVE'];
  }

  call({ data }) {
    if (!(data?.bushels > 0)) return [];
    return [{
      type: 'FARM_GRAIN_MOVE', kind: data.kind, operatorId: data.operatorId, crop: data.crop,
      cropYear: data.cropYear, pool: poolKey(data.operatorId, data.crop, data.cropYear),
      planId: data.planId ?? null, bushels: data.bushels, shortBushels: 0, sourceId: data.sourceId,
    }];
  }
}

/**
 * A contract delivery or a planned sale: bushels leave a pool, and a receivable opens for the
 * payment date.
 *
 * **Contract shortfall** (design 134 §6): the operator delivers what the pool holds and settles
 * the rest at the cash price on the delivery date, `(contract − market)` per bushel short, less
 * any buyout fee. So a short crop in a high-price year costs money on the contracted bushels.
 *
 * **Planned sale**: a share of the pool's UNPRICED bushels, harvested less contracted, capped at
 * what the pool still holds.
 *
 * **Storage** is charged on the bushels that leave, for the months they were held since they
 * entered the pool, at the operator's rate for the crop (design 134 Q8a). It posts as a cash
 * cost on the day the grain leaves.
 */
export class FarmGrainOutHandler extends HandlerEntry {
  static type        = 'FarmGrainOutHandler';
  static category    = 'handler';
  static eventType   = FARM_EVENT.GRAIN_OUT;
  static description = 'Delivers a forward contract or makes a planned sale out of a grain pool, opens its receivable and charges storage (design 134 §5.1, §6).';

  constructor() {
    super(null, 'Farm Grain Out');
    this.generatedActionTypes = ['FARM_GRAIN_MOVE', 'FARM_RECEIVABLE_OPEN', 'FARM_LEDGER_POST'];
  }

  call({ data, state, date }) {
    if (!data) return [];
    const key  = poolKey(data.operatorId, data.crop, data.cropYear);
    const pool = state?.farm?.pools?.[key] ?? null;
    const held = pool?.bushels ?? 0;

    let bushels, short = 0, amount;
    if (data.kind === 'CONTRACT') {
      bushels = Math.min(data.bushels, held);
      short   = data.bushels - bushels;
      amount  = bushels * data.price
        + short * ((data.price - (data.marketPrice ?? data.price)) - data.buyoutPerBu);
    } else {
      const harvested  = pool?.harvested ?? 0;
      const contracted = state?.farm?.contracted?.[key] ?? 0;
      bushels = Math.min(data.share * Math.max(0, harvested - contracted), held);
      amount  = bushels * data.price;
    }
    if (bushels <= 0 && short <= 0) return [];

    const actions = [];
    if (bushels > 0) {
      actions.push({
        type: 'FARM_GRAIN_MOVE', kind: data.kind === 'CONTRACT' ? 'DELIVER' : 'SELL',
        operatorId: data.operatorId, crop: data.crop, cropYear: data.cropYear, pool: key,
        planId: null, bushels: -bushels, shortBushels: short, sourceId: data.sourceId,
      });
    }
    actions.push({
      type: 'FARM_RECEIVABLE_OPEN', receivableId: data.receivableId, sourceId: data.sourceId, kind: data.kind,
      operatorId: data.operatorId, crop: data.crop, cropYear: data.cropYear, pool: key,
      bushels, amount, paymentDate: data.paymentDate,
    });

    const nowMs  = date instanceof Date ? date.getTime() : new Date(date).getTime();
    const months = pool ? Math.max(0, (nowMs - pool.enteredMs) / MS_PER_MONTH) : 0;
    const storage = bushels * (data.storagePerBuMonth ?? 0) * months;
    if (storage > 0) {
      actions.push({
        type: 'FARM_LEDGER_POST', operatorId: data.operatorId, jobId: poolJob(key),
        cropYear: data.cropYear, category: 'STORAGE', line: categoryLine('STORAGE'),
        kind: 'COST', cash: true, allocation: 'BUSHELS', amount: storage,
        sourceId: data.sourceId, receivableId: null, bushels, memo: `${months.toFixed(2)} months held`,
      });
    }
    return actions;
  }
}

/** A receivable is paid: the grain revenue posts on its cash date. */
export class FarmPaymentHandler extends HandlerEntry {
  static type        = 'FarmPaymentHandler';
  static category    = 'handler';
  static eventType   = FARM_EVENT.PAYMENT;
  static description = 'Posts grain revenue when a contract or sale is paid (design 134 §5.3; cash method, Reg. §1.61-4).';

  constructor() {
    super(null, 'Farm Payment');
    this.generatedActionTypes = ['FARM_LEDGER_POST'];
  }

  call({ data, state }) {
    const r = state?.farm?.receivables?.[data?.receivableId];
    if (!r) return [];
    return [{
      type: 'FARM_LEDGER_POST', operatorId: r.operatorId, jobId: poolJob(r.pool),
      cropYear: r.cropYear, category: 'GRAIN_SALES', line: categoryLine('GRAIN_SALES'),
      kind: 'REVENUE', cash: true, allocation: 'BUSHELS', amount: r.amount,
      sourceId: r.sourceId, receivableId: data.receivableId, bushels: r.bushels, memo: r.kind,
    }];
  }
}

/** Applies all three farm actions to `state.farm`, copy-on-write. */
export class FarmLedgerReducer extends Reducer {
  static type        = 'FarmLedgerReducer';
  static category    = 'reducer';
  static description = 'Keeps the farm grain pools, open receivables and per-operator cash net in state (design 134 §5.3).';

  constructor() {
    super('Farm Ledger', PRIORITY.CASH_FLOW);
    this.reducedActionTypes = ['FARM_LEDGER_POST', 'FARM_GRAIN_MOVE', 'FARM_RECEIVABLE_OPEN'];
  }

  reduce(state, action, date) {
    const farm = state.farm ?? {};
    if (action.type === 'FARM_LEDGER_POST') {
      let next = farm;
      if (action.cash) {
        const sign = action.kind === 'REVENUE' ? 1 : -1;
        next = { ...next, cash: { ...next.cash, [action.operatorId]: (next.cash?.[action.operatorId] ?? 0) + sign * action.amount } };
      }
      if (action.receivableId) {
        const { [action.receivableId]: _paid, ...rest } = next.receivables ?? {};
        next = { ...next, receivables: rest };
      }
      return this.newState({ ...state, farm: next });
    }
    if (action.type === 'FARM_GRAIN_MOVE') {
      const prev = farm.pools?.[action.pool] ?? {
        operatorId: action.operatorId, crop: action.crop, cropYear: action.cropYear,
        bushels: 0, harvested: 0, enteredMs: null,
      };
      const nowMs = date instanceof Date ? date.getTime() : new Date(date).getTime();
      let pool;
      if (action.bushels > 0) {
        // Bushel-weighted entry date, so storage months are right when fields of one crop
        // are harvested on different days.
        const total = prev.bushels + action.bushels;
        const entered = prev.enteredMs == null || prev.bushels <= 0 ? nowMs
          : (prev.enteredMs * prev.bushels + nowMs * action.bushels) / total;
        pool = { ...prev, bushels: total, harvested: prev.harvested + action.bushels, enteredMs: entered };
      } else {
        pool = { ...prev, bushels: Math.max(0, prev.bushels + action.bushels) };
      }
      return this.newState({ ...state, farm: { ...farm, pools: { ...farm.pools, [action.pool]: pool } } });
    }
    if (action.type === 'FARM_RECEIVABLE_OPEN') {
      const r = {
        sourceId: action.sourceId, kind: action.kind, operatorId: action.operatorId, crop: action.crop, cropYear: action.cropYear,
        pool: action.pool, bushels: action.bushels, amount: action.amount, paymentDate: action.paymentDate,
      };
      return this.newState({ ...state, farm: { ...farm, receivables: { ...farm.receivables, [action.receivableId]: r } } });
    }
    return this.newState(state);
  }
}
