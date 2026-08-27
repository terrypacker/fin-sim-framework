/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../../simulation-framework/reducers.js';
import { identityGroupOf }   from '../../holdings/security.js';
import { ACCOUNT_ROLES }     from '../../state/account-roles.js';

/**
 * Rev. Rul. 2008-5: a loss washed into the taxpayer's own IRA or Roth IRA is DESTROYED, not
 * deferred (design 94 §8.1i, step 7a.2) — the matching arithmetic, as a pure function.
 *
 * ── what it implements, and what it deliberately does not ────────────────────
 *
 * §1091 has two consequences and this reducer implements exactly one of them. The ordinary
 * wash — replacement bought in a TAXABLE account — disallows the loss and moves it into the
 * replacement's basis under §1091(d), with the holding period tacked on under §1223(3). That
 * is a TIMING effect, it is the expensive half to build, and R2 (§8.1f–g) held it as 7b.
 *
 * The IRA case has no §1091(d) half at all. Rev. Rul. 2008-5's holding, verbatim:
 *
 *   > "The loss on the Sale of stock is disallowed under § 1091. A's basis in the individual
 *   >  retirement account or Roth IRA **is not increased** by virtue of § 1091(d)."
 *
 * Disallowed, and nothing anywhere gets the basis. So this is a subtraction, and that is why
 * it is the small half with all the permanent money in it.
 *
 * **IRA and Roth IRA only.** Pub. 550 ch. 4's trigger #4 and the ruling both name those two.
 * A 401(k) or an Australian super fund is NOT covered by anything in `docs/`, and this repo
 * does not extend a rule past its source — so a replacement bought inside a 401(k) is left
 * alone here even though the same "command over the property never left" reasoning would
 * plainly reach it. That is a deliberate under-disallowance, and it is why the modelled
 * number is smaller than §8.1f's upper bound.
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
  const empty   = { disallowedShort: 0, disallowedLong: 0, ledger: [], remaining: [] };
  if (!Array.isArray(pending) || pending.length === 0) return empty;

  const replacements = _shelteredReplacements(state);
  const remaining = [];
  const ledger    = [];
  let disShort = 0;
  let disLong  = 0;

  for (const entry of pending) {
    // Not this return's problem — a sale in a later year is filed a year from now.
    if (entry.ms < fromMs || entry.ms > toMs) { remaining.push(entry); continue; }

    const matched = replacements
      .filter(r => r.group === entry.group && Math.abs(r.ms - entry.ms) <= WINDOW_MS)
      .reduce((s, r) => s + r.units, 0);
    if (matched <= 0) continue;                     // no wash — the loss stands, entry retires

    const frac  = Math.min(1, matched / Math.max(entry.units, 1e-9));
    const short = +((entry.shortLoss ?? 0) * frac).toFixed(2);
    const long  = +((entry.longLoss  ?? 0) * frac).toFixed(2);
    if (short <= 0 && long <= 0) continue;
    disShort += short;
    disLong  += long;
    ledger.push({ ms: entry.ms, group: entry.group, stateKey: entry.stateKey,
                  matchedFraction: +frac.toFixed(4), disallowedShort: short, disallowedLong: long });
  }
  return { disallowedShort: +disShort.toFixed(2), disallowedLong: +disLong.toFixed(2),
           ledger, remaining };
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
 * Every equity position in an IRA/Roth as `{ group, ms, units }`.
 *
 * Read off the LOTS rather than from an event log, because a purchase leaves exactly one
 * durable trace in this engine — a lot with a `purchaseDate` — and that trace is still there
 * a year later, which is what makes the lagged resolution possible at all.
 *
 * A lot that was added to rather than opened keeps its original `purchaseDate`, so new money
 * into a seasoned IRA position is not seen. That under-matches, in the same direction as the
 * 401(k) exclusion, and is recorded in §8.1i rather than papered over.
 */
function _shelteredReplacements(state) {
  const out = [];
  for (const account of Object.values(state ?? {})) {
    if (!account || typeof account !== 'object' || !Array.isArray(account.holdings)) continue;
    if (!SHELTERED_ROLES.has(account.role)) continue;
    for (const h of account.holdings) {
      if (h?.allocation !== 'EQUITY' || !(h.units > 0)) continue;
      const group = identityGroupOf(h, state.securities ?? null);
      if (group == null || h.purchaseDate == null) continue;
      const ms = h.purchaseDate instanceof Date ? h.purchaseDate.getTime() : new Date(h.purchaseDate).getTime();
      if (!Number.isFinite(ms)) continue;
      out.push({ group, ms, units: h.units });
    }
  }
  return out;
}
