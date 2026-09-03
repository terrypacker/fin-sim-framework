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
import { resize }            from '../../holdings/holding-utils.js';

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
      // §1091(d) — where the disallowed loss GOES when the replacement was taxable
      // (design 94 §8.1p). Empty for a purely sheltered wash, which destroys it instead.
      basisAdjustments: wash.basisAdjustments ?? [],
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
    // §1091(d) + §1223(3) — the deferral half (design 94 §8.1p).
    const deferral = _applyBasisTransfers(state, action.basisAdjustments);
    Object.assign(patch, deferral.patch);
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

/**
 * §1091(d) and §1223(3): move each disallowed loss into the taxable replacement it was
 * matched against (design 94 §8.1p).
 *
 * ── why this happens HERE and not at the sale ────────────────────────────────
 *
 * The harvester's own wash is settled on the spot (§8.1j) because it sells and rebuys in one
 * action, in one account, on one day — both lots in hand. Every other wash in this engine is
 * cross-account: the rebalancer sells in the taxable book and a different action, on a
 * different account, buys the replacement, with no ordering guarantee between them. So the
 * pairing is only knowable once the window has closed, which is what the April filing IS.
 *
 * ── the cost of resolving late, stated rather than discovered ────────────────
 *
 * Four months pass between the sale and the filing, and the replacement lot may have been
 * sold, swept or compacted in the meantime. A basis increase with nowhere to land is a
 * deferral silently lost, so it is COUNTED: `washDeferralUnplaced` accumulates the dollars
 * that found no lot. It should normally be zero; a non-zero value is not a crash, it is the
 * model telling you the deferral it could not honour. The disallowance itself stands either
 * way — §1091(a) does not depend on the taxpayer still holding the replacement.
 *
 * ── partial matches split the lot ────────────────────────────────────────────
 *
 * A replacement lot can be larger than the shares matched against it, and only the matched
 * shares take the basis and the tacked date. Raising the whole lot's basis would give
 * unmatched shares a basis nobody paid for; tacking the whole lot's date would age shares
 * that were never sold. So the lot is bifurcated with `resize`, which conserves value and
 * basis exactly, and the matched half carries the adjustment.
 *
 * @returns {{ patch: object }} account patches, plus the unplaced tally when there is one
 */
function _applyBasisTransfers(state, adjustments) {
  if (!Array.isArray(adjustments) || adjustments.length === 0) return { patch: {} };
  // Copy-on-write, once per account: the source array is never touched, and two adjustments
  // landing on one account both see the other's work (design 94 §8.1o's live-alias trap in
  // miniature — a second adjustment reading `state` again would discard the first).
  const touched = new Map();
  const holdingsFor = (stateKey) => {
    if (!touched.has(stateKey)) {
      const hs = state[stateKey]?.holdings;
      if (!Array.isArray(hs)) return null;
      touched.set(stateKey, [...hs]);
    }
    return touched.get(stateKey);
  };
  let unplaced = 0;

  for (const adj of adjustments) {
    const holdings = holdingsFor(adj.stateKey);
    if (holdings == null) { unplaced += adj.amount; continue; }
    const i = holdings.findIndex(h => h?.id === adj.holdingId);
    if (i < 0) { unplaced += adj.amount; continue; }

    const lot   = holdings[i];
    const units = lot.units ?? 0;
    // Whole-lot match (or a lot with no unit count to split on): adjust it in place.
    if (!(units > 0) || adj.units >= units - 1e-9) {
      holdings[i] = _withTransfer(lot, adj);
    } else {
      const f = adj.units / units;
      // The matched shares carry the transfer; the rest is the same lot, smaller. A distinct
      // id is mandatory — HoldingTransactReducer matches on it, so two lots sharing one id
      // would cross-credit each other's earnings. Disambiguated because one lot can be split
      // TWICE in a filing: two entries may each match part of it, and the second split would
      // otherwise mint the same `-1091` id as the first.
      holdings[i] = _withTransfer({ ...resize(lot, f), id: _freshLotId(holdings, `${lot.id}-1091`) }, adj);
      holdings.splice(i + 1, 0, resize(lot, 1 - f));
    }
  }

  const patch = {};
  for (const [stateKey, holdings] of touched) {
    patch[stateKey] = { ...state[stateKey], holdings };
  }
  // Absent when nothing was unplaced, so a run that never loses a deferral gains no key.
  if (unplaced > 0) {
    patch.washDeferralUnplaced = +((state.washDeferralUnplaced ?? 0) + unplaced).toFixed(2);
  }
  return { patch };
}

/** `base`, or the first `base-2`, `base-3`… no lot already uses. Deterministic, so replay holds. */
function _freshLotId(holdings, base) {
  const existing = new Set((holdings ?? []).map(h => h?.id).filter(Boolean));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/**
 * One lot, with the disallowed loss added to its basis and its holding period tacked back.
 *
 * `costBasis` is the origin/US basis. `costBaseByCountry.AU` is Australia's own and is left
 * ALONE: there is no §1091 in Australia (§8.1d), so an AU disposal must still measure the
 * loss the taxpayer really has. Only a US entry in that map — if one is ever written — moves
 * with the US basis.
 */
function _withTransfer(lot, adj) {
  const out = { ...lot, costBasis: +((lot.costBasis ?? 0) + adj.amount).toFixed(2) };
  if (lot.costBaseByCountry?.US != null) {
    out.costBaseByCountry = { ...lot.costBaseByCountry,
                              US: +(lot.costBaseByCountry.US + adj.amount).toFixed(2) };
  }
  // §1223(3). Null when the sold lot carried no acquisition date, and never moved FORWARD:
  // tacking can only lengthen a holding period, never shorten one.
  if (adj.tackMs != null) {
    const current = lot.purchaseDate instanceof Date ? lot.purchaseDate.getTime()
                  : lot.purchaseDate != null ? new Date(lot.purchaseDate).getTime() : null;
    if (current == null || adj.tackMs < current) out.purchaseDate = new Date(adj.tackMs);
  }
  return out;
}
