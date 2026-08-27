/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { HandlerEntry }      from '../../../simulation-framework/handlers.js';
import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { TaxSettleService }  from '../../tax-settle-service.js';
import { PENDING_RETURN_KEY } from '../tax-settle-classes.js';
import { resolveWashSales }  from './wash-sale.js';

/**
 * FILING the return, as an event distinct from the tax year ENDING (design 94 §8.1l).
 *
 * ── the conflation this exists to undo ───────────────────────────────────────
 *
 * `TAX_SETTLE_US` fires on 31 December and does two jobs at once: it closes the tax year AND
 * it lodges the return. For almost everything that is harmless, because the two answers are
 * the same. For §1091 it is not: the harvester sells on 31 December, its wash-sale window runs
 * to 30 January, and a return computed on the day of sale **cannot see whether the sale was a
 * wash**. Design 94 §8.1i worked around that by clawing the disallowance out of a later year's
 * carryforward and, where the pool was empty (93% of the time, measured), adding it back as
 * gain on the following return — an amended return approximated twice over, which shipped with
 * a §1222 character bug of its own (§8.1k).
 *
 * Separating the events removes the workaround rather than improving it. A real taxpayer files
 * in April, when the window has closed; so does this.
 *
 * ── why this is not "move the settle to April" ───────────────────────────────
 *
 * The settle stays exactly where it is and keeps doing what it does — computing and paying the
 * year's tax. Nothing about an existing scenario changes: no fixture re-golds, and the
 * cross-border FTC/FITO handoff the settle feeds (design 83 G5's `usTaxPaidOnUsSourceAud`,
 * consumed a fiscal year later by the AU settle) is untouched. Moving the settle would have
 * disturbed all of it, which is why §8.1h rejected that option and why this one is strictly
 * better than either it offered.
 *
 * ── inert unless there is something to correct ───────────────────────────────
 *
 * The settle leaves `usPendingReturn` ONLY when a wash-sale entry is pending (§8.1l), so a run
 * that never harvests never writes the key, this handler returns nothing, and the event leaves
 * no trace in the journal at all.
 */
export class UsTaxFileHandler extends HandlerEntry {
  static type        = 'UsTaxFileHandler';
  static category    = 'handler';
  static eventType   = 'TAX_FILE_US';
  static description = 'Files the prior US tax year in April: resolves the §1091 windows the 31-December settle could not see, recomputes the return, and emits US_TAX_FILE_APPLY with the balance due (design 94 §8.1l).';

  constructor() {
    super(null, 'US Tax File');
    this._settleService = new TaxSettleService();
    this.generatedActionTypes = ['US_TAX_FILE_APPLY'];
  }

  call({ state }) {
    const snapshot = state?.[PENDING_RETURN_KEY];
    if (!snapshot) return [];

    // The year being filed, read off the snapshot rather than off `date` minus one: the
    // snapshot carries the period the return was computed FOR, which is the only thing that
    // is true even if the run's period bookkeeping has moved since.
    const startMs = snapshot.currentPeriods?.US?.startMs;
    if (startMs == null) return [];
    const fromMs = startMs;
    const toMs   = Date.UTC(new Date(startMs).getUTCFullYear() + 1, 0, 1) - 1;

    const wash = resolveWashSales(state, fromMs, toMs);
    const disallowed = +(wash.disallowedShort + wash.disallowedLong).toFixed(2);

    // Nothing to correct: still FILE (the snapshot has to be retired, or next April would
    // re-file the same year), but with a zero delta and no payment.
    if (disallowed <= 0) {
      return [{ type: 'US_TAX_FILE_APPLY', taxYear: new Date(startMs).getUTCFullYear(),
                delta: 0, disallowed: 0, ledger: [], remaining: wash.remaining }];
    }

    // ── the delta, as a differential over ONE reconstruction ──────────────────
    //
    // `filed` is the state the return saw: current state, overwritten by the snapshot for
    // every field the settle disturbed. It is not a perfect reconstruction — `people`,
    // filing status and residency are read as they are TODAY and may have moved since
    // December — which is exactly why the answer is taken as a DIFFERENCE of two passes over
    // the same object. Every imperfection is present in both passes and cancels. A single
    // pass against the stored liability would bake the drift into the bill.
    // (Design 52 §4.6's with/without measurement, reused for the same reason.)
    const filed     = { ...state, ...snapshot };
    const corrected = {
      ...filed,
      // §1091 on the return it belongs to: the loss never existed. Added back BY CHARACTER,
      // before `_computeCapitalLossLimitation` nets anything — `usCapitalGainsYTD` is the
      // long-term bucket and `usShortTermCapitalGainsYTD` the short one.
      usCapitalGainsYTD:          +((filed.usCapitalGainsYTD ?? 0) + wash.disallowedLong).toFixed(2),
      usShortTermCapitalGainsYTD: +((filed.usShortTermCapitalGainsYTD ?? 0) + wash.disallowedShort).toFixed(2),
    };

    const asFiled   = this._settleService.computeUsTax(filed);
    const asAmended = this._settleService.computeUsTax(corrected);
    // Non-negative by construction — removing a loss cannot lower a liability — and clamped
    // anyway, because a negative delta would need a refund path the payment reducer does not
    // have. If a future correction type CAN produce one, it needs a credit action, not this.
    const delta = Math.max(0, +(asAmended.netLiability - asFiled.netLiability).toFixed(2));

    return [{
      type:      'US_TAX_FILE_APPLY',
      taxYear:   new Date(startMs).getUTCFullYear(),
      delta,
      disallowed,
      ledger:    wash.ledger,
      remaining: wash.remaining,
      // The corrected §1212(b) pools replace what the settle wrote. Safe because nothing
      // between 31 December and 15 April touches them: they move only at a US settle.
      capitalLoss: asAmended.capitalLoss ?? null,
    }];
  }
}

/**
 * Applies the filing: the corrected carryforwards, the audit ledger, the retired snapshot, and
 * the balance due.
 *
 * Priority TAX_APPLY, matching the settle's own apply reducer — this IS a settle, of a
 * different return.
 */
export class UsTaxFileApplyReducer extends Reducer {
  static type        = 'UsTaxFileApplyReducer';
  static category    = 'reducer';
  static description = 'Applies the April filing of the prior US return: corrected §1212(b) carryforwards, the §1091 audit ledger, and the balance due (design 94 §8.1l).';

  constructor() {
    super('US Tax File Apply', PRIORITY.TAX_APPLY);
    this.reducedActionTypes   = ['US_TAX_FILE_APPLY'];
    this.generatedActionTypes = ['US_TAX_PAYMENT_DEBIT'];
  }

  reduce(state, action) {
    const patch = {};
    // The snapshot is retired on EVERY filing, including a zero one. Leaving it would make
    // next April re-file the same year against a state that has moved a year on.
    if (PENDING_RETURN_KEY in state) patch[PENDING_RETURN_KEY] = undefined;
    // Entries whose sale falls in a LATER year are carried, not dropped — they belong to a
    // return that has not been filed yet.
    if (Array.isArray(action.remaining)) {
      patch.washPendingLosses = action.remaining.length ? action.remaining : undefined;
    }
    if (action.ledger?.length) {
      patch.washSaleLedger = [
        ...(state.washSaleLedger ?? []),
        ...action.ledger.map(e => ({ ...e, filedYear: action.taxYear })),
      ];
    }
    const cl = action.capitalLoss;
    if (cl?.closingShort != null) patch.usShortTermCapitalLossCarryforward = +cl.closingShort.toFixed(2);
    if (cl?.closingLong  != null) patch.usLongTermCapitalLossCarryforward  = +cl.closingLong.toFixed(2);

    const next = { ...state };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k]; else next[k] = v;
    }
    // The balance due on the amended return. An ordinary payment: it is US tax, and it is
    // genuinely paid in the filing year, which is where a cash-flow report should show it.
    return action.delta > 0
      ? this.newState(next, {}, [{ type: 'US_TAX_PAYMENT_DEBIT', amount: action.delta }])
      : this.newState(next);
  }
}
