/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { identityGroupOf }   from '../../holdings/security.js';
import { ACCOUNT_ROLES }     from '../../state/account-roles.js';

/**
 * §1091, as a pure function: which of the year's realized losses the wash-sale rule
 * disallows, and — since design 94 §8.1p — what happens to the money afterwards.
 *
 * ── the rule has TWO consequences, and they differ by WHERE the replacement sits ──
 *
 * §1091(a) disallows the loss whoever bought the replacement. What happens next does not:
 *
 *   - **A TAXABLE replacement.** §1091(d) moves the disallowed loss into the replacement's
 *     BASIS and §1223(3) tacks the sold shares' holding period onto it, so the loss is
 *     recovered on the eventual sale. TIMING, not money — the taxpayer keeps it, later.
 *     Built as `basisAdjustments` below and applied by `UsTaxFileApplyReducer` (§8.1p).
 *   - **An IRA or Roth IRA replacement.** Rev. Rul. 2008-5's holding, verbatim:
 *
 *       > "The loss on the Sale of stock is disallowed under § 1091. A's basis in the
 *       >  individual retirement account or Roth IRA **is not increased** by virtue of
 *       >  § 1091(d)."
 *
 *     Disallowed, and nothing anywhere gets the basis. A subtraction, and that is why the
 *     sheltered half — the smaller one — is the half with all the permanent money in it
 *     (§8.1i, step 7a.2).
 *
 * **IRA and Roth IRA only, for the sheltered branch.** Pub. 550 ch. 4's trigger #4 and the
 * ruling both name those two. A 401(k) or an Australian super fund is NOT covered by anything
 * in `docs/`, and this repo does not extend a rule past its source — so a replacement bought
 * inside a 401(k) is left alone even though the same "command over the property never left"
 * reasoning would plainly reach it. That is a deliberate under-disallowance, and it is why the
 * modelled number is smaller than §8.1f's upper bound. The same discipline bounds the taxable
 * branch: US-domiciled brokerage only, for the basis reason given at `TAXABLE_ROLES`.
 *
 * ── when it is applied ───────────────────────────────────────────────────────
 *
 * **The US settle fires on 31 December — the same day the harvester sells** — so §1091's
 * window for a 31-Dec sale (closing 30 January) is still open when the return is computed.
 * Design 94 §8.1l separates the tax year's END from the return's FILING for exactly this
 * reason: `TAX_FILE_US` runs on 15 April, by which time every window opened in the filed year
 * is closed, and the disallowance lands on the RETURN IT BELONGS TO rather than being clawed
 * out of a later year's carryforward.
 *
 * That is why this file is a pure resolver and no longer a reducer. It reports what §1091
 * disallows; `UsTaxFileHandler` recomputes the return with it and `UsTaxFileApplyReducer`
 * writes the result.
 *
 * ── matching ─────────────────────────────────────────────────────────────────
 *
 * §1091(b) matches SHARES, not dollars: sell 100 at a loss, buy 75 inside the window, and the
 * loss on 75 is disallowed (§1.1091-1(h) Example 2). So the fraction is
 * `matchedUnits / unitsSold`, capped at 1 — which is what the unit counts design 93 gave
 * every equity position are for. Identity is the DECLARED group (§8.1c), never the rate key.
 */
/**
 * Resolve every pending wash-sale entry whose sale falls in `[fromMs, toMs]`.
 *
 * Pure: it reads state and reports what §1091 disallows, and writes nothing. Both the filing
 * handler (which needs the numbers to recompute a return) and its apply reducer (which needs
 * them to write state) call it, so there is exactly one place the matching arithmetic lives.
 *
 * The window check that used to live here is gone with the lag (design 94 §8.1l): the April
 * filing runs at least 30 days after the last possible sale in the year it files, so every
 * window is closed by definition. It is asserted rather than assumed — an entry outside the
 * filed year is left pending rather than resolved early.
 *
 * @param   {object} state
 * @param   {number} fromMs - first ms of the tax year being filed
 * @param   {number} toMs   - last ms of it
 * @returns {{ disallowedShort:number, disallowedLong:number, ledger:object[], remaining:object[] }}
 */
export function resolveWashSales(state, fromMs, toMs) {
  const pending = state?.washPendingLosses;
  const empty   = { disallowedShort: 0, disallowedLong: 0, ledger: [], remaining: [],
                    basisAdjustments: [] };
  if (!Array.isArray(pending) || pending.length === 0) return empty;

  // §1.1091-1(e): replacement shares are CONSUMED — each carries its own remaining count and
  // an entry may only match what earlier entries left (see `_matchUnits`). §1.1091-1(c)/(d)
  // match acquisitions "in accordance with the order of their acquisition
  // (beginning with the earliest acquisition)", so the pool is walked oldest lot first.
  const replacements = _replacementLots(state)
    .map(r => ({ ...r, left: r.units }))
    .sort((a, b) => a.ms - b.ms);
  const remaining = [];
  const ledger    = [];
  const basisAdjustments = [];
  let disShort = 0;
  let disLong  = 0;

  // §1.1091-1(b): where more than one loss is claimed in the year, the section is applied to
  // them "in the order in which the stock or securities ... were disposed of (beginning with
  // the earliest disposition)". Its same-day tie-break — order of original ACQUISITION — is
  // not reachable here, because an entry records the sale, not the sold lot's purchase date;
  // `sort` is stable, so same-day entries keep the order the reducers wrote them in, which is
  // the sale order within the day. Sorting a copy leaves the caller's `washPendingLosses`
  // (and the `remaining` written back from it) in its own order.
  for (const entry of [...pending].sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0))) {
    // Not this return's problem — a sale in a later year is filed a year from now. It also
    // consumes nothing here: the shares are re-tested, against the same lots, at ITS filing.
    if (entry.ms < fromMs || entry.ms > toMs) { remaining.push(entry); continue; }

    const takes   = _matchUnits(replacements, entry);
    const matched = takes.reduce((s2, t) => s2 + t.units, 0);
    if (matched <= 0) continue;                     // no wash — the loss stands, entry retires

    const frac  = Math.min(1, matched / Math.max(entry.units, 1e-9));
    const short = +((entry.shortLoss ?? 0) * frac).toFixed(2);
    const long  = +((entry.longLoss  ?? 0) * frac).toFixed(2);
    if (short <= 0 && long <= 0) continue;
    disShort += short;
    disLong  += long;

    // ── §1091(d): where the replacement is TAXABLE, the loss is deferred, not destroyed ──
    //
    // The disallowance above is the same either way — §1091(a) disallows on this return
    // whoever bought the replacement. What differs is where the money goes afterwards, and
    // that is decided share by share: the dollars matched against IRA/Roth shares are gone
    // (Rev. Rul. 2008-5), and the dollars matched against a taxable lot move into ITS basis.
    // Apportioned by units, because units are what §1091(b) matches.
    const deferred = [];
    for (const take of takes) {
      if (take.lot.kind !== 'TAXABLE') continue;
      const amount = +(((short + long) * take.units) / matched).toFixed(2);
      if (amount <= 0) continue;
      deferred.push(amount);
      basisAdjustments.push({
        stateKey:  take.lot.stateKey,
        holdingId: take.lot.holdingId,
        units:     +take.units.toFixed(6),
        amount,
        // §1223(3): the replacement's holding period INCLUDES the sold lot's, so the
        // replacement is back-dated by however long the sold shares were held. For a
        // same-day sell-and-rebuy this reduces to the sold lot's own purchase date, which
        // is exactly what the harvester's immediate branch (§8.1j) stamps — the two rules
        // agree because they are the same rule.
        tackMs:    entry.heldFromMs == null ? null
                 : take.lot.ms - Math.max(0, entry.ms - entry.heldFromMs),
      });
    }
    const deferredTotal = +deferred.reduce((s2, a) => s2 + a, 0).toFixed(2);

    ledger.push({ ms: entry.ms, group: entry.group, stateKey: entry.stateKey,
                  matchedFraction: +frac.toFixed(4), disallowedShort: short, disallowedLong: long,
                  // Absent when nothing was deferred, following this file's absent-is-absent
                  // discipline: a `deferred: 0` on every sheltered wash would put a field in
                  // every fixture that has one.
                  ...(deferredTotal > 0 ? { deferred: deferredTotal } : {}) });
  }
  return { disallowedShort: +disShort.toFixed(2), disallowedLong: +disLong.toFixed(2),
           ledger, remaining, basisAdjustments };
}

/**
 * The replacement shares one entry may claim — and DEDUCTS them, so the next entry cannot
 * claim the same ones (design 94 §8.1o).
 *
 * §1.1091-1(e), verbatim in `docs/us-tax/CFR-26-1.1091-1-Wash-Sales.txt`: "The acquisition of
 * any share of stock or any security which results in the nondeductibility of a loss under the
 * provisions of this section shall be disregarded in determining the deductibility of any other
 * loss." Without that deduction a single 100-share IRA purchase disallowed a 100-share loss in
 * EVERY pending entry naming its group — two $5,000 sales
 * losing $10,000 to a replacement that can only cover one of them. The over-disallowance is
 * bounded only by how many losses the year realized.
 *
 * It was latent while the harvester was the ledger's only writer (its entries are one sale
 * per harvest, and a book with one harvest a year has nothing to collide with). §8.1n gave
 * the ledger a second writer whose legs consume every lot of an allocation, and a semiannual
 * rebalance plus a December harvest puts several same-group entries in one filing.
 *
 * No units cap the entry itself: `entry.units` is what was SOLD, and taking less than the
 * whole of it is what `matchedFraction` expresses.
 *
 * @returns {Array<{lot: object, units: number}>} which lots were drawn on, and for how many
 *          shares — the taxable ones need naming because §1091(d) writes basis onto them.
 */
function _matchUnits(replacements, entry) {
  let need = Math.max(0, entry.units ?? 0);
  const takes = [];
  for (const r of replacements) {
    if (need <= 0) break;
    if (r.left <= 0 || r.group !== entry.group || Math.abs(r.ms - entry.ms) > WINDOW_MS) continue;
    const take = Math.min(r.left, need);
    r.left -= take;
    need   -= take;
    takes.push({ lot: r, units: take });
  }
  return takes;
}

/** §1.1091-1(a)'s 61-day period, as a half-width: 30 days either side of the sale. */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The wrappers the cited authority reaches. IRA and Roth IRA — including their inherited
 * forms, which are still the taxpayer's own retirement accounts — and nothing else. See the
 * class doc for why a 401(k) is deliberately absent.
 */
const SHELTERED_ROLES = new Set([
  ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.ROTH,
  // The inherited forms are still an IRA and a Roth IRA in the heir's hands.
  ACCOUNT_ROLES.INHERITED_IRA, ACCOUNT_ROLES.INHERITED_ROTH,
]);

// Matched by ROLE, so a spouse's IRA counts as well as the primary's. The ruling speaks of
// "the taxpayer's" IRA and says nothing about a spouse's; on the joint return this model
// files by default they are one taxpayer, which is the reading taken here. It would be the
// wrong reading for a couple filing separately, and that is stated rather than hidden.

/**
 * The roles a §1091(d) basis transfer can be written onto: an ordinary TAXABLE brokerage
 * (design 94 §8.1p).
 *
 * US-domiciled only, and the country test is not decoration. `costBasis` is the origin/US
 * basis while `costBaseByCountry.AU` carries Australia's own (s855-45, design 36 §12.2), so
 * raising `costBasis` on an AU-situs lot would move a basis Australia measures differently —
 * a US rule silently re-pricing an AU disposal. §1091 is resolved against the US return; an
 * AU-domiciled replacement is left alone, in the same direction as the 401(k) exclusion above.
 */
const TAXABLE_ROLES = new Set([ACCOUNT_ROLES.US_STOCK]);

/**
 * Every equity position that can be a §1091 replacement, as
 * `{ group, ms, units, kind, stateKey, holdingId }`.
 *
 * Read off the LOTS rather than from an event log, because a purchase leaves exactly one
 * durable trace in this engine — a lot with a `purchaseDate` — and that trace is still there
 * a year later, which is what makes the lagged resolution possible at all. It is also what
 * lets the taxable branch write basis back: the lot the shares were bought into is named, so
 * the April filing can find it.
 *
 * A lot that was added to rather than opened keeps its original `purchaseDate`, so new money
 * into a seasoned position is not seen. That under-matches, in the same direction as the
 * 401(k) exclusion, and is recorded in §8.1i rather than papered over.
 *
 * **The two kinds are one pool.** §1091 does not rank replacements by where they sit: a share
 * is a share, and §1.1091-1(c)/(d) match them in order of acquisition regardless. The wrapper
 * decides only the CONSEQUENCE — destroyed under Rev. Rul. 2008-5, deferred into basis under
 * §1091(d) — which is why `kind` is carried on the lot rather than resolved by two passes.
 */
function _replacementLots(state) {
  const out = [];
  for (const [stateKey, account] of Object.entries(state ?? {})) {
    if (!account || typeof account !== 'object' || !Array.isArray(account.holdings)) continue;
    const kind = SHELTERED_ROLES.has(account.role) ? 'SHELTERED'
               : (TAXABLE_ROLES.has(account.role) && account.country === 'US') ? 'TAXABLE'
               : null;
    if (kind == null) continue;
    for (const h of account.holdings) {
      if (h?.allocation !== 'EQUITY' || !(h.units > 0)) continue;
      const group = identityGroupOf(h, state.securities ?? null);
      if (group == null || h.purchaseDate == null) continue;
      const ms = h.purchaseDate instanceof Date ? h.purchaseDate.getTime() : new Date(h.purchaseDate).getTime();
      if (!Number.isFinite(ms)) continue;
      out.push({ group, ms, units: h.units, kind, stateKey, holdingId: h.id });
    }
  }
  return out;
}
