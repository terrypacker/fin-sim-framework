/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry } from '../../simulation-framework/handlers.js';
import { RecordBalanceAction, RecordMetricAction } from '../../simulation-framework/actions.js';
import { convertExpenseToAccount } from '../fx/expense-fx.js';
import { blendExpensePriceLevel } from '../spending/expense-price-level.js';
import { SPEND_CATEGORY } from '../spending/spend-category.js';
import { propertyExpenseBusinessFraction, blendExpenseBusinessFraction }
  from '../account-rules/currency-basis.js';

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * HouseRunningCostHandler — the deterministic, inflating REGULAR cost of owning a home
 * (design 75 §5.1, Phase 2). The mortgage (design 54) is the only recurring house outflow the
 * engine modelled; this adds the rest — council rates, insurance, utilities, body corporate,
 * routine servicing — the costs a paid-off house still incurs every year.
 *
 * Reuses the residence-aware debit shape of MonthlyExpensesHandler exactly: the target is the
 * residence-appropriate cash pool (US pre-move / AU post-move, resolved via the transaction-
 * account flag with a SAVINGS-role fallback), a REPLENISH_SAVINGS is prepended if the debit
 * would break the floor (so it joins the same drawdown + cross-border escalation path as other
 * essential expenses, design 75 §5.3), and the per-property base cost is converted FROM the
 * property's own currency INTO the account currency (an AUD house's rates leave the converted
 * AUD magnitude after the move).
 *
 * Nominal annual cost per property (billed monthly, ÷12):
 *
 *   annual = annualRunningCost · inflationAccumulator[cc] · (1 + runningCostGrowth)^yearsElapsed
 *          + runningCostValuePct · value
 *
 * The first term is the owner's "increases with inflation" piece (the `inflationAccumulator`
 * price level is the same seam EXPLICIT_BANDS spending uses); the second rides the current
 * value so a pricier house costs proportionally more to run. `runningCostGrowth` (default 0)
 * adds real growth on top of inflation. All properties this tick debit the SAME residence
 * account, so their converted costs are summed into one debit.
 *
 * Fully deterministic — draws no RNG. It has no master flag: it is active whenever a property
 * carries a positive `annualRunningCost` / `runningCostValuePct`, exactly like a monthlyExpenses
 * band. A property with zero cost (or one that has been sold — `value` drops to 0 at sale) is
 * skipped, so an all-zero scenario is byte-identical to before (design 75 §6.2 exit criteria).
 */
export class HouseRunningCostHandler extends HandlerEntry {
  static description = 'Residence-aware monthly handler for the regular (inflating) cost of owning a home — rates, insurance, utilities, servicing — summed across properties and debited from the residence cash pool (design 75 §5.1).';
  static type        = 'HouseRunningCostHandler';
  static eventType   = 'HOUSE_RUNNING_COST';

  constructor({
    stateRegistry,
    propertyKeys = [],
    usRole, usOwnerId = null,
    auRole, auOwnerId = null,
    primaryPersonKey = null,
    startDate = null,
  } = {}) {
    super(null, 'House Running Cost');
    this.stateRegistry    = stateRegistry;
    this.propertyKeys     = propertyKeys;
    this.usRole           = usRole;
    this.usOwnerId        = usOwnerId;
    this.auRole           = auRole;
    this.auOwnerId        = auOwnerId;
    this.primaryPersonKey = primaryPersonKey;
    this.startMs          = startDate != null ? new Date(startDate).getTime() : null;
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'EXPENSE_DEBIT', 'RECORD_METRIC', 'RECORD_BALANCE'];
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
    h.id     = d.id;
    h.startMs = d.startMs ?? null;   // preserve the raw epoch ms across round-trip
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
      startMs:          this.startMs,
    };
  }

  call({ state, date }) {
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

    const nowMs        = date != null ? new Date(date).getTime() : null;
    const yearsElapsed = (this.startMs != null && nowMs != null)
      ? Math.max(0, (nowMs - this.startMs) / MS_PER_YEAR)
      : 0;

    let totalDebit = 0;   // accumulated in the target account's currency
    // Design 87 §14.4 item 2 / G12 — the §212 share of the SAME debit. One tick can pay
    // the running costs of a home and a rental out of one account, so the fraction has to
    // be accumulated alongside the money rather than read off either property.
    let businessDebit = 0;
    // Design 89 §5.6 — Σ(debit/priceLevel), accumulated alongside the money for the
    // same reason businessDebit is: each property is indexed at ITS OWN country's
    // accumulator, and they are summed into one debit that can carry only one level.
    let deflatedDebit = 0;
    for (const key of this.propertyKeys) {
      const prop = state[key];
      // Skip a missing or SOLD property — value drops to 0 at sale (design 75 §5.3).
      if (!prop || (prop.value ?? 0) <= 0) continue;
      const base     = prop.annualRunningCost   ?? 0;
      const valuePct = prop.runningCostValuePct ?? 0;
      const growth   = prop.runningCostGrowth   ?? 0;
      if (base <= 0 && valuePct <= 0) continue;

      const cc         = prop.country ?? 'US';
      const priceLevel = state.inflationAccumulator?.[cc] ?? 1;
      const annualNative = base * priceLevel * Math.pow(1 + growth, yearsElapsed)
                         + valuePct * (prop.value ?? 0);
      const monthlyNative = annualNative / 12;
      if (monthlyNative <= 0) continue;

      const propCurrency = (typeof prop.currency === 'string' ? prop.currency : prop.currency?.code)
        ?? (cc === 'AU' ? 'AUD' : 'USD');
      const debit = convertExpenseToAccount(monthlyNative, propCurrency, account, state);
      totalDebit    += debit;
      businessDebit += debit * propertyExpenseBusinessFraction(prop);
      deflatedDebit += debit / (priceLevel || 1);
    }

    if (totalDebit <= 0) return [];

    const actions      = [];
    const postDebitBal = account.balance - totalDebit;
    const deficit      = (account.minimumBalance ?? 0) - postDebitBal;
    if (deficit > 0) {
      actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey });
    }
    actions.push(
      // Design 87 §14.4 item 2 — running costs of an income-producing property are §212
      // expenses, so the currency spent on them is an ORDINARY §988 disposition; the same
      // costs on a home are personal and fall to the capital branch. Read per tick, so a
      // property that stops renting flips its subsequent debits (design 87 §4's trap).
      { type: 'EXPENSE_DEBIT', amount: totalDebit, targetKey,
        // Design 89 §5.6 — property costs are indexed at prop.country, not at the
        // household's residence and not at the paying account's currency.
        priceLevel: blendExpensePriceLevel(deflatedDebit, totalDebit),
        // Design 89 §6.1(A). `capitalFraction` is 0 by nature, not by omission: rates,
        // insurance and utilities are consumed in the period and lift no cost basis.
        // Repairs are the ones that split (§8.1) — see RealPropertyRepairTickHandler.
        spendCategory: SPEND_CATEGORY.HOUSING_RUNNING, capitalFraction: 0,
        section988: { kind: 'DISPOSE',
                      businessFraction: blendExpenseBusinessFraction(businessDebit, totalDebit) } },
      new RecordMetricAction('house_running_cost', totalDebit),
      new RecordBalanceAction(`${targetKey}.balance`, targetKey),
    );
    return actions;
  }
}
