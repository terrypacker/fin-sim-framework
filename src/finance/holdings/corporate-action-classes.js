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
import { ALLOCATION }        from './allocation.js';
import { TAX_ADVANTAGED_ROLES } from '../behavioral/rebalance-to-target-reducer.js';
import { addValue }          from './holding-utils.js';
import { buildSecurityRegistry } from './security.js';
import { auCpiLevel, auCpiRate } from './holding-period.js';
import { toMs }              from '../account-rules/main-residence.js';
import {
  CORPORATE_ACTION_KIND, applyCorporateAction, registryPatchFor,
} from './corporate-action.js';

/**
 * The engine half of design 94 §7 / step 8 — one dated event, one handler, one reducer.
 *
 * ─── why a handler at all, when the reducer could scan state itself ─────────────────
 *
 * Because `RevalueAssetReducer` already settled this question the other way and was right:
 * the handler resolves WHICH accounts are affected and hands the reducer a list, so the
 * reducer's own contract stays "apply this, here" rather than "go and find where this
 * applies". It also means the journal's action payload names the accounts a corporate
 * action touched, which is what makes one auditable after the fact — the alternative is an
 * action that says `SPIN_OFF sec-parent` and a diff you have to reverse-engineer.
 *
 * ─── the one thing that is genuinely new here ───────────────────────────────────────
 *
 * A spin-off ADDS A SECURITY MID-RUN. Nothing else in the engine does. `cloneState` shares
 * `state.securities` by reference across every snapshot in the run (design 94 §6.4) on the
 * strength of the registry being run-immutable, and this is the path that tests whether
 * "immutable" was the right word. It is: the registry is replaced, not written to, so the
 * snapshots taken before the spin-off keep pointing at the map that did not contain the new
 * instrument — which is correct, because at that moment it did not exist. `registryPatchFor`
 * plus `buildSecurityRegistry` is the copy-on-write; the freeze is what turns a mistake here
 * into a `TypeError` instead of a rewrite of history.
 */
export class CorporateActionHandler extends HandlerEntry {
  static type        = 'CorporateActionHandler';
  static category    = 'handler';
  static eventType   = 'CORPORATE_ACTION';
  static description = 'Resolves which accounts hold the security a dated corporate action names, and emits CORPORATE_ACTION_APPLY with that list (design 94 §7).';

  constructor() {
    super(null, 'Corporate Action');
    this.generatedActionTypes = ['CORPORATE_ACTION_APPLY'];
  }

  call({ data, state }) {
    const spec = data?.action ?? data;
    if (!spec?.kind || !spec.securityId) return [];

    // A RENAME touches the registry and no position, so it fires whether or not the plan
    // holds the instrument — the security still exists and its symbol still changed.
    const isRename = spec.kind === CORPORATE_ACTION_KIND.RENAME;

    const stateKeys = [];
    for (const [key, entry] of Object.entries(state ?? {})) {
      if (!entry || !Array.isArray(entry.holdings) || entry.holdings.length === 0) continue;
      if (entry.holdings.some(h => h?.securityId === spec.securityId)) stateKeys.push(key);
    }
    if (stateKeys.length === 0 && !isRename) return [];

    return [{
      type:      'CORPORATE_ACTION_APPLY',
      kind:      spec.kind,
      securityId: spec.securityId,
      stateKeys,
      spec,
      // Every disposal action in this repo carries the residency that gates its AU branch;
      // an emitter that forgets it books no AU tax at all (design/inconsistencies §4.11).
      residency: state?.people?.[Object.keys(state?.people ?? {})[0]]?.residency ?? null,
    }];
  }
}

/**
 * Applies a corporate action to every affected position, and to the registry when the
 * action creates or renames an instrument.
 *
 * Priority POSITION_UPDATE, alongside `RevalueAssetReducer` and the HOLDING family: this is
 * a change to what the plan HOLDS, and it must land after any cash flow dated the same day
 * rather than racing it.
 */
export class CorporateActionApplyReducer extends Reducer {
  static type        = 'CorporateActionApplyReducer';
  static category    = 'reducer';
  static description = 'Applies a split / rename / spin-off / merger / return of capital to every position in the named security, credits any cash into the account\'s own CASH sleeve, and chains STOCK_WITHDRAWAL_TAX for the part either country recognizes (design 94 §7).';

  constructor() {
    super('Corporate Action Apply', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes   = ['CORPORATE_ACTION_APPLY'];
    this.generatedActionTypes = ['STOCK_WITHDRAWAL_TAX'];
  }

  reduce(state, action, date) {
    const spec = action?.spec;
    if (!spec?.kind) return this.newState(state);

    const ctx = {
      dateMs:       toMs(date) ?? state.currentPeriods?.US?.startMs ?? 0,
      auPriceLevel: auCpiLevel(state),
      auCpiRate:    auCpiRate(state),
      // The registry AS IT WAS. A new lot's market key resolves through `instrumentOf`
      // against the parent's instrument, and the parent's instrument is the one that
      // existed before this action — the map below is replaced, not amended.
      securities:   state.securities ?? null,
    };

    const patch = {};
    const chained = [];

    // ── the registry, first ────────────────────────────────────────────────────────
    // Before the positions, so a lot minted below can name an instrument that is already
    // in the map it will be read through. Copy-on-write — see the class header.
    const specs = registryPatchFor(state.securities ?? null, spec);
    if (specs) patch.securities = buildSecurityRegistry(specs);

    for (const stateKey of action.stateKeys ?? []) {
      const account = state[stateKey];
      if (!account || !Array.isArray(account.holdings)) continue;

      // A distribution inside a sheltered wrapper is not assessed when it happens. A
      // return of capital in excess of basis, and a merger's boot, are both realised
      // events — but inside a 401(k)/IRA/Roth/super they are realised BY THE WRAPPER, and
      // the holder is taxed on distribution instead. Chaining a disposal here would tax
      // an IRA's corporate action as though it had happened in a brokerage, which is the
      // same mistake the rebalancer's `taxable` gate exists to avoid (design 61 §0).
      //
      // KNOWN GAP, and named rather than buried: for an AU resident this gain is an
      // amount DERIVED by the trust estate and so assessable under s99B on eventual
      // distribution (design 84 G2). The rebalancer accumulates that; this does not.
      // Both would want the same accumulator, which is why it is not re-inlined here.
      const sheltered = TAX_ADVANTAGED_ROLES.has(account.role);
      let cash = 0;
      let touched = false;
      const next = [];
      for (const h of account.holdings) {
        if (!h || h.securityId !== spec.securityId) { next.push(h); continue; }
        const r = applyCorporateAction(h, spec, ctx);
        touched = true;
        if (r.position) next.push(r.position);
        if (r.spun)     next.push(r.spun);
        cash += r.cash ?? 0;

        if (r.tax && !sheltered) {
          const t = r.tax;
          // ONE object literal, spelled out. `disposal-tax-payload-parity.test.mjs` scans
          // `src/` statically for exactly this shape: a payload assembled behind a spread or
          // a builder is invisible to it, and the field it cannot see is the field the tax
          // modules read through a `??` fallback — an absent one is a wrong answer, not an
          // unknown one. So the helper returns DATA and the keys are written here.
          chained.push({
            type:               'STOCK_WITHDRAWAL_TAX',
            gain:               t.gain,
            auGain:             t.auGain,
            auIndexedGain:      t.auIndexedGain,
            auDiscountableGain: t.auDiscountableGain,
            usShortTermGain:    t.usShortTermGain,
            usLongTermGain:     t.usLongTermGain,
            auShortTermGain:    t.auShortTermGain,
            auLongTermGain:     t.auLongTermGain,
            proceeds:           t.proceeds,
            costBasis:          t.costBasis,
            residency:          action.residency ?? null,
            description:        t.description,
            stateKey,
            // The account's own denomination. Every money field above is measured in it —
            // the `au*` ones included, which mean "on the AU cost base", not "in AUD"
            // (design 91 §8). Consumers convert; the emitter does not.
            currency:           account.currency?.code ?? account.currency ?? 'USD',
          });
        }
      }
      if (!touched) continue;

      // Cash from a merger or a return of capital lands in the account it came out of.
      // That is what actually happens — a distribution on a share held in a brokerage is
      // paid into that brokerage — and it keeps this reducer out of the destination-
      // resolution business, where a null `saleDestinationAccount` has bitten before.
      let holdings = next.filter(Boolean);
      if (cash > 0.005) {
        const cashIdx = holdings.findIndex(h => h?.allocation === ALLOCATION.CASH);
        if (cashIdx >= 0) {
          holdings = holdings.map((h, i) => (i === cashIdx ? addValue(h, cash) : h));
        } else {
          // par-reviewed: CREATES a lot. A cash sleeve has no par and, by the design 87 §11
          // invariant, basis equal to value.
          holdings = [...holdings, {
            id:          `${stateKey}-ca-cash-${ctx.dateMs}`,
            allocation:  ALLOCATION.CASH,
            marketValue: +cash.toFixed(2),
            costBasis:   +cash.toFixed(2),
            rateKey:     null,
            label:       'Cash (corporate action)',
          }];
        }
      }

      patch[stateKey] = {
        ...account,
        holdings,
        balance: +holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2),
      };
    }

    if (Object.keys(patch).length === 0) return this.newState(state);
    return this.newState(state, patch, chained);
  }
}
