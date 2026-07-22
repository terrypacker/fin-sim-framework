/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }                    from '../../simulation-framework/handlers.js';
import { RecordBalanceAction, RecordMetricAction } from '../../simulation-framework/actions.js';
import { convertExpenseToAccount }         from '../fx/expense-fx.js';
import { gaussianFrom }                    from '../fx/fx-process-models.js';

/**
 * Lognormal severity with a given median: median · exp(σ·z), z ~ N(0,1). One normal draw.
 */
function drawSeverity(median, sigma, rng) {
  return median * Math.exp(sigma * gaussianFrom(rng));
}

/** Knuth's Poisson sampler — draws a variable number of uniforms; deterministic given the rng. */
function poissonSample(rng, lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

/**
 * RealPropertyRepairTickHandler — the STOCHASTIC, lumpy cost of owning a home (design 75 §5.2,
 * Phase 3): a leaking roof, a dead water heater, a failed AC compressor. Most years ≈ $0, then
 * one year a five-figure hit — the liquidity-timing danger a smooth "maintenance %" hides. It
 * is another seeded, snapshot-safe `sim.rng` consumer (after FX/47, yield curve/67, equity/74,
 * property-return/75 P1), fired annually and scheduled ONLY when some property has a repair
 * model, so default scenarios draw no randomness and stay byte-identical.
 *
 * A compound process per property (frequency × severity), one of three models:
 *   - BERNOULLI (default): with prob `repairProb` a single big repair occurs; size ~ Lognormal.
 *   - POISSON:  number of repairs ~ Poisson(`repairLambda`); each ~ Lognormal.
 *   - CONTINUOUS: one Lognormal draw every year around the median (smooth — no lump).
 * Severity median is `repairValuePct · value` when set, else the fixed `repairMedian`; σ is
 * `repairSigma` (lognormal shape). All amounts are in the property's currency.
 *
 * Debit shape mirrors HouseRunningCostHandler / HealthcareEventHandler exactly: the summed,
 * FX-converted repair is an essential outflow from the residence cash pool, prepending
 * REPLENISH_SAVINGS so it joins the same drawdown + cross-border escalation path (design 75
 * §5.3). A per-property HOUSE_REPAIR_APPLY carries the native amount for tracking and the
 * `capitalizeRepairs` fraction so HouseRepairApplyReducer can lift the property's capitalized
 * basis (design 75 §8 Q6). A `house_repair_expenses` metric records the total (essential for
 * seeing the lumps in MC output).
 *
 * ⚠️ RNG-cursor discipline (design 74 §4). Properties are iterated in stable sorted stateKey
 * order, and a property that can incur no cost — `repairModel: NONE`, zero frequency, or zero
 * median — draws **no** uniforms, so it never perturbs another property's draw sequence and an
 * all-off scenario is byte-identical. A SOLD property (value 0) is skipped (design 75 §5.3).
 */
export class RealPropertyRepairTickHandler extends HandlerEntry {
  static description = 'Draws a compound repair process (frequency × lognormal severity) per property from the seeded sim.rng and debits the summed, FX-converted cost from the residence cash pool, emitting HOUSE_REPAIR_APPLY for tracking + basis capitalization (design 75 §5.2).';
  static type        = 'RealPropertyRepairTickHandler';
  static eventType   = 'HOUSE_REPAIR';

  constructor({
    stateRegistry,
    propertyKeys = [],
    usRole, usOwnerId = null,
    auRole, auOwnerId = null,
    primaryPersonKey = null,
  } = {}) {
    super(null, 'House Repair');
    this.stateRegistry    = stateRegistry;
    // Stable sorted order so the RNG cursor is deterministic (design 74 §4 ⚠️).
    this.propertyKeys     = [...propertyKeys].sort();
    this.usRole           = usRole;
    this.usOwnerId        = usOwnerId;
    this.auRole           = auRole;
    this.auOwnerId        = auOwnerId;
    this.primaryPersonKey = primaryPersonKey;
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'EXPENSE_DEBIT', 'HOUSE_REPAIR_APPLY', 'RECORD_METRIC', 'RECORD_BALANCE'];
  }

  static fromJSON(d, { stateRegistry }) {
    const h = new this({
      stateRegistry,
      propertyKeys:     d.propertyKeys     ?? [],
      usRole:           d.usRole           ?? null,
      usOwnerId:        d.usOwnerId        ?? null,
      auRole:           d.auRole           ?? null,
      auOwnerId:        d.auOwnerId        ?? null,
      primaryPersonKey: d.primaryPersonKey ?? null,
    });
    h.id = d.id;
    return h;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      propertyKeys:     this.propertyKeys,
      usRole:           this.usRole,
      usOwnerId:        this.usOwnerId,
      auRole:           this.auRole,
      auOwnerId:        this.auOwnerId,
      primaryPersonKey: this.primaryPersonKey,
    };
  }

  /** Draw this year's repair cost (property currency); returns 0 without drawing when impossible. */
  _drawRepair(prop, rng) {
    const model = prop.repairModel ?? 'NONE';
    if (model === 'NONE') return 0;
    const sigma    = prop.repairSigma    ?? 0.6;
    const valuePct = prop.repairValuePct ?? 0;
    const median   = valuePct > 0 ? valuePct * (prop.value ?? 0) : (prop.repairMedian ?? 0);
    if (median <= 0) return 0;   // no cost possible ⇒ no draw (cursor discipline)

    if (model === 'BERNOULLI') {
      const prob = prop.repairProb ?? 0;
      if (prob <= 0) return 0;                 // no draw
      return rng() < prob ? drawSeverity(median, sigma, rng) : 0;
    }
    if (model === 'POISSON') {
      const lambda = prop.repairLambda ?? 0;
      if (lambda <= 0) return 0;               // no draw
      const k = poissonSample(rng, lambda);
      let total = 0;
      for (let i = 0; i < k; i++) total += drawSeverity(median, sigma, rng);
      return total;
    }
    if (model === 'CONTINUOUS') {
      return drawSeverity(median, sigma, rng);  // a lognormal cost every year
    }
    return 0;
  }

  call({ sim, state }) {
    const rng = sim.rng;
    // Residence-appropriate target account — the SAME for every property this tick.
    const personKey = this.primaryPersonKey ?? Object.keys(state.people ?? {})[0];
    const isAu      = (state.people?.[personKey]?.residency ?? null) === 'AU';
    const country   = isAu ? 'AU' : 'US';
    const role      = isAu ? this.auRole    : this.usRole;
    const ownerId   = isAu ? this.auOwnerId : this.usOwnerId;
    const targetKey = this.stateRegistry.resolveTransactionAccountKey?.(country, ownerId)
      ?? this.stateRegistry.getStateKey(role, ownerId);
    const account   = state[targetKey];
    if (!account) return [];

    let totalDebit = 0;                 // in the target account currency
    const applyActions = [];
    for (const key of this.propertyKeys) {
      const prop = state[key];
      if (!prop || (prop.value ?? 0) <= 0) continue;   // missing or sold ⇒ skip (no draw)
      const native = this._drawRepair(prop, rng);
      if (native <= 0) continue;
      const cc           = prop.country ?? 'US';
      const propCurrency = (typeof prop.currency === 'string' ? prop.currency : prop.currency?.code)
        ?? (cc === 'AU' ? 'AUD' : 'USD');
      totalDebit += convertExpenseToAccount(native, propCurrency, account, state);
      applyActions.push({ type: 'HOUSE_REPAIR_APPLY', stateKey: key, amount: native, capitalize: prop.capitalizeRepairs ?? 0 });
    }

    const actions = [];
    if (totalDebit > 0) {
      const deficit = (account.minimumBalance ?? 0) - (account.balance - totalDebit);
      if (deficit > 0) actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey });
      actions.push(
        { type: 'EXPENSE_DEBIT', amount: totalDebit, targetKey },
        new RecordMetricAction('house_repair_expenses', totalDebit),
        new RecordBalanceAction(`${targetKey}.balance`, targetKey),
      );
    }
    // HOUSE_REPAIR_APPLY carries the native amount for tracking + basis capitalization.
    actions.push(...applyActions);
    return actions;
  }
}
