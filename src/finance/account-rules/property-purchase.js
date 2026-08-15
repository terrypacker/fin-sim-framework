/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * property-purchase.js — buying a dwelling part-way through a run.
 *
 * Design 83 has no purchase path: every property exists from t0 and can only leave, by
 * sale. That makes the single most common retirement move unmodellable — **sell the
 * family home and buy something smaller** — because the replacement dwelling has nowhere
 * to come from. Every downsizing question (how much is actually released? what does the
 * new house cost to run? what does its own eventual sale look like?) needs it.
 *
 * ─── dormancy is free, which is why this is small ────────────────────────────
 * A property with a future `purchaseYear` sits at `value: 0` until then, and the engine
 * already treats a zero-value property as absent: `HouseRunningCostHandler` skips
 * `value <= 0`, appreciation multiplies 0 by a rate and gets 0, and net worth sums
 * `value`. So no handler needs a "not yet owned" gate — the state IS the gate. At the
 * purchase date the price is debited and becomes both the value and the cost base, and
 * from that instant the dwelling is an ordinary property: it appreciates, it costs money
 * to run, it can carry a design-86 mortgage, and it can be sold under design 83 G7 with
 * its own main-residence history.
 *
 * ─── the price is stated in TODAY's money by default ─────────────────────────
 * A sale price needs no such choice — it is whatever the property has appreciated to.
 * A purchase price does, and holding a stated figure nominal across twenty years would
 * silently shrink the replacement home in real terms until a "downsize" became a move
 * into something a third the size. The stated figure is therefore grown at the
 * property's own `appreciationRate` — not CPI, because houses do not track CPI and the
 * quantity being preserved is the RATIO between the home sold and the home bought.
 * `purchasePriceIsNominal: true` opts out for a contracted price.
 *
 * ─── ordering against the sale ───────────────────────────────────────────────
 * Both events land on 15 January. The event comparator is (date, then `order`), so the
 * purchase carries a higher `order` than the sale and a sell-and-buy in the same year
 * settles in the only sequence that works: proceeds land, then the cheque clears.
 */

import { Reducer, PRIORITY, AccountServiceReducer } from '../../simulation-framework/reducers.js';
import { HandlerEntry }        from '../../simulation-framework/handlers.js';
import { RecordBalanceAction } from '../../simulation-framework/actions.js';
import { resolveDestinationCashKey } from './cash-routing.js';
import { fxRate } from '../fx/fx-conversion.js';
import { propertyExpenseBusinessFraction } from './currency-basis.js';

/**
 * `order` for a purchase event. The sale events are authored at the default 0, so any
 * positive value settles the purchase after them; 50 leaves room either side without
 * colliding with the settle band (100/101).
 */
export const PROPERTY_PURCHASE_ORDER = 50;

/** Currency code of a state entry, tolerant of the descriptor / bare-string shapes. */
function currencyCode(entry) {
  return entry?.currency?.code ?? entry?.currency ?? null;
}

/**
 * The purchase price as at the purchase date, in the property's own currency.
 *
 * Grown from the stated (today's-money) figure at the property's appreciation rate over
 * the years from the simulation start, so that a price stated as "about 60% of what the
 * current house is worth" still buys about 60% of a house in 2040. A property with no
 * appreciation rate, or a nominal price, returns the stated figure unchanged.
 *
 * @param {object} prop      property state entry
 * @param {number} saleYear  the calendar year of the purchase
 * @param {number} startYear the simulation's start year
 */
export function resolvePurchasePrice(prop, purchaseYear, startYear) {
  const stated = prop?.purchasePrice ?? 0;
  if (!(stated > 0)) return 0;
  if (prop?.purchasePriceIsNominal === true) return stated;
  const rate  = prop?.appreciationRate ?? 0;
  const years = Math.max(0, (purchaseYear ?? startYear) - startYear);
  return +(stated * Math.pow(1 + rate, years)).toFixed(2);
}

/**
 * Does this property need a purchase event scheduled? A `purchaseYear` with no price is
 * an authoring slip rather than a free house, so it schedules nothing — the same
 * treatment `plannedSaleYear` gives a property with no value.
 */
export function propertyNeedsPurchase(prop) {
  return prop?.purchaseYear != null && (prop?.purchasePrice ?? 0) > 0;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * Dispatches `*_HOUSE_PURCHASE_APPLY` with the resolved price and funding account.
 * Country-parameterised in the same shape as `LoanPaymentHandler`, so the US and AU
 * real-property toolsets can each schedule their own event without double-buying.
 */
export class PropertyPurchaseHandler extends HandlerEntry {
  static type        = 'PropertyPurchaseHandler';
  static category    = 'handler';
  static description = 'Resolves a property purchase price (grown to the purchase date unless nominal), and dispatches PROPERTY_PURCHASE_APPLY to debit the funding account and bring the dwelling into existence.';
  static eventType   = 'PROPERTY_PURCHASE';

  constructor({ country = null, stateRegistry = null } = {}) {
    super(null, `${country ?? ''} Property Purchase`.trim());
    this.country = country;
    this.stateRegistry = stateRegistry;
    this.generatedActionTypes = ['REPLENISH_SAVINGS', 'PROPERTY_PURCHASE_APPLY', 'RECORD_BALANCE'];
  }

  static fromJSON(d, services) {
    const h = new this({ country: d.country ?? null, stateRegistry: services?.stateRegistry });
    h.id = d.id;
    return h;
  }

  toJSON() { return { ...super.toJSON(), country: this.country }; }

  call({ data, state }) {
    const stateKey = data?.stateKey;
    const prop     = stateKey ? state[stateKey] : null;
    if (!prop) return [];
    // Already bought (or authored as owned from the start): never buy the same dwelling
    // twice. A re-entrant purchase would double-debit the cash and reset the cost base
    // to a later, higher price — quietly erasing the gain.
    if ((prop.value ?? 0) > 0) return [];

    const price = resolvePurchasePrice(prop, data.purchaseYear, data.startYear);
    if (!(price > 0)) return [];

    // Funding: the nominated account, else the country cash pool. Same resolution the
    // sale path uses for its destination, so "where the money came from" and "where the
    // money went" are symmetric and both honour an account id persisted by the editor.
    const cashKey = resolveDestinationCashKey(
      this.stateRegistry, prop.country ?? this.country ?? 'US', state, prop.purchaseFundFrom ?? null);
    const cash    = state[cashKey];

    // The price is in the property's currency; the debit lands in the account's. An
    // A$700k purchase funded from a USD account draws price ÷ (AUD per USD), not 1:1.
    const propCcy = currencyCode(prop);
    const cashCcy = currencyCode(cash);
    const fx      = (propCcy && cashCcy)
      ? fxRate(propCcy, cashCcy, state.effectiveExchangeRates?.USD_AUD ?? 1.55)
      : 1;
    const cashDue = +(price * fx).toFixed(2);

    const actions = [];
    // A house purchase is the largest single outflow in most plans, so it is the most
    // likely to breach a cash floor. Raising the shortfall through the normal drawdown
    // queue — rather than letting the balance go negative — is what makes the purchase
    // interact with the portfolio at all, which is the entire point of modelling it.
    const deficit = (cash?.minimumBalance ?? 0) - ((cash?.balance ?? 0) - cashDue);
    if (deficit > 0) actions.push({ type: 'REPLENISH_SAVINGS', deficit, targetKey: cashKey });

    actions.push({
      type: 'PROPERTY_PURCHASE_APPLY',
      stateKey, cashKey, price, cashDue, fx,
      // Design 87 §14.4 item 3 — buying property with nonfunctional currency disposes of
      // it, priced by `§1.988-2(a)(2)(ii)(B)` as a sale of the units for USD at spot
      // followed by a purchase for those dollars.
      //
      // The fraction is the property's own §212 status, which looks wrong at first
      // glance — a purchase price is CAPITALIZED, not deducted, so there is no §162/§212
      // expense to point at. `§1.988-1(a)(9)(ii)` Example 1 settles it the other way: X
      // buys pounds and immediately acquires a pound-denominated bond, and the reg holds
      // that "the disposition of the pounds and the acquisition of the bond ARE section
      // 988 transactions … because expenses properly allocable to such transactions meet
      // the requirements of section 212". Acquiring an income-producing asset is inside
      // §988; Example 2's holiday spending is outside it. So a rental purchase is
      // ordinary and a home purchase is personal, which is also what keeps this property
      // consistent with its own mortgage and running costs — three dispositions out of
      // one pool that must not disagree about what the property is for.
      //
      // No `units`: nothing credits this pool inside the reducer (the REPLENISH_SAVINGS
      // above is a separate action and a separate bracket), so the observed net delta IS
      // the disposal — including the reducer's cap to the available balance, which is
      // design 87 §6's "realize in the reducer" obtained for free by observing.
      section988: { kind: 'DISPOSE', accountKey: cashKey,
                    businessFraction: propertyExpenseBusinessFraction(prop) },
      // Fallback only — the reducer prefers the event date, which is exact.
      purchaseMs: state.currentPeriods?.[prop.country ?? 'US']?.startMs
               ?? state.currentPeriods?.US?.startMs ?? null,
    });
    actions.push(new RecordBalanceAction(`${cashKey}.balance`, cashKey));
    return actions;
  }
}

/** US-scoped purchase handler — fires on `US_HOUSE_PURCHASE`, buys only US property. */
export class UsPropertyPurchaseHandler extends PropertyPurchaseHandler {
  static type        = 'UsPropertyPurchaseHandler';
  static description = 'Buys a US property on its purchaseYear (design 83 §10 follow-on).';
  static eventType   = 'US_HOUSE_PURCHASE';
  constructor({ stateRegistry = null } = {}) { super({ country: 'US', stateRegistry }); }
}

/** AU-scoped purchase handler — fires on `AU_HOUSE_PURCHASE`, buys only AU property. */
export class AuPropertyPurchaseHandler extends PropertyPurchaseHandler {
  static type        = 'AuPropertyPurchaseHandler';
  static description = 'Buys an AU property on its purchaseYear (design 83 §10 follow-on).';
  static eventType   = 'AU_HOUSE_PURCHASE';
  constructor({ stateRegistry = null } = {}) { super({ country: 'AU', stateRegistry }); }
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

/**
 * Debits the funding account and brings the dwelling into existence: `value` and
 * `costBasis` both become the price, and `acquisitionDate` is stamped.
 *
 * Stamping the acquisition date here rather than leaving it to the author is what makes
 * the new dwelling work under design 83 G7 without any further input: its ownership
 * period, its s118-185 denominator and its §121 nonqualified-use window all start on
 * the day it was actually bought, which the engine knows exactly.
 */
export class PropertyPurchaseApplyReducer extends AccountServiceReducer {
  static type        = 'PropertyPurchaseApplyReducer';
  static category    = 'reducer';
  static description = 'Debits the funding account by the purchase price (FX-converted) and sets the property value, cost basis and acquisition date.';
  static actionType  = 'PROPERTY_PURCHASE_APPLY';

  constructor({ accountService, stateRegistry }) {
    super('Property Purchase Apply', PRIORITY.CASH_FLOW);
    this.accountService = accountService;
    this.stateRegistry  = stateRegistry;
    this.reducedActionTypes   = ['PROPERTY_PURCHASE_APPLY'];
    this.generatedActionTypes = [];
  }

  reduce(state, action, date) {
    const { stateKey, cashKey, price, cashDue } = action;
    // The EVENT date, not `state.currentPeriods[cc].startMs`. The AU period is the
    // financial year, so a January purchase would otherwise be stamped as acquired the
    // previous 1 July — six months of ownership the taxpayer never had, on the very
    // field that forms the s118-185 denominator and the start of §121's window.
    const purchaseMs = date instanceof Date ? date.getTime() : (action.purchaseMs ?? null);
    const prop = state[stateKey];
    if (!prop) return this.newState(state);

    // Debit what is actually there. A purchase the plan cannot afford leaves the cash
    // pool at zero rather than negative — the REPLENISH_SAVINGS the handler already
    // emitted is the mechanism for raising the rest, and if that could not cover it the
    // shortfall shows up as a smaller balance, not as a silently free house.
    const cash      = state[cashKey];
    const available = Math.max(0, cash?.balance ?? 0);
    const debited   = Math.min(available, cashDue);
    if (cash && debited > 0) this.accountService.transaction(cash, -debited, null);

    return this.newState(state, {
      [stateKey]: {
        ...prop,
        value:     price,
        costBasis: price,
        // A newly bought dwelling has taken no depreciation and carries no capitalised
        // improvements, whatever the record was authored with.
        accumulatedDepreciation: 0,
        capitalizedImprovements: 0,
        acquisitionDate: purchaseMs ?? prop.acquisitionDate ?? null,
      },
    });
  }
}
