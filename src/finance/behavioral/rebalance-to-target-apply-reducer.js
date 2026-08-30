/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY }    from '../../simulation-framework/reducers.js';
import { ALLOCATION }           from '../holdings/allocation.js';
import { consumeHoldings }      from '../holdings/holdings-fifo.js';
import { disposalTermFields }   from '../holdings/holding-period.js';
import { compactLots, LOT_POLICIES, promoteToUnitised, prevailingPrice, instrumentOf } from '../holdings/holding-utils.js';
import { resolveRateKey }       from '../holdings/default-allocations.js';
import { RATE_KEY_META }        from '../economic-regimes/rate-keys.js';
import { resolveYield }         from '../economic-regimes/yield-curve.js';
import { realiseDerivedGain } from '../assets/investment-account.js';
import { section988ForBondPrincipal } from '../account-rules/bond-currency-basis.js';
import { identityGroupOf }       from '../holdings/security.js';
import { toMs } from '../account-rules/main-residence.js';
import { addValue, resize } from '../holdings/holding-utils.js';

/**
 * RebalanceToTargetApplyReducer — design 61 Lever C (Phase 2). Executes the
 * per-account legs of REBALANCE_TO_TARGET_APPLY, routing each by tax treatment:
 *
 *   - **Taxable sell** (US_STOCK / AU_STOCK, non-CASH): FIFO-consume that
 *     allocation's lots and chain the jurisdiction-correct capital-gains tax —
 *     STOCK_WITHDRAWAL_TAX (US), AU_STOCK_WITHDRAWAL_TAX (AU), or COLLECTIBLE_SALE_TAX
 *     (GOLD, US 28% collectible / AU indexed via `isGold`). The gain accrues to the
 *     year's CGT accumulator and settles at year-end — no cash is moved here, because
 *     a rebalance redeploys the proceeds *within* the account.
 *   - **Sheltered sell** (K401/IRA/Roth/Super) and **CASH** sells: free pro-rata
 *     reduce, no tax.
 *   - **Buy**: ESTABLISH a new lot of the target allocation (the design-61 §6 buy
 *     primitive) — stamping allocation, marketValue, costBasis (= amount, fresh basis),
 *     purchaseDate, rateKey (via resolveRateKey) and BOND defaults. A GOLD sleeve may be
 *     established in ANY account, including a US IRA/401k/Roth — the bullion guard was
 *     reversed (design 61 §12 OQ4a, 2026-07-29) because a gold ETF is holdable there and
 *     taxed the same.
 *
 * Legs sum to zero (Σ delta = 0), so gross account value is conserved; the realized
 * CGT is the only (deferred) cost. Balance is re-synced to Σ marketValue. Holdings are
 * rebuilt copy-on-write (never mutated in place) so JOURNAL_STRICT purity holds (G2).
 *
 * ─── why a buy SPLITS a lot instead of merging into the sleeve (design 62 §9) ──
 *
 * A buy used to be spread pro-rata across the existing lots of the target allocation:
 * `marketValue` and `costBasis` moved, `purchaseDate` did not. Freshly bought units
 * therefore inherited the sleeve's original acquisition date and read as held ≥12 months
 * from the instant they were bought. Every holding-period rule keys off that date —
 * `consumeHoldings`' AU Division 115 discount gate and the post-2027 indexation clock
 * today, the residency deemed-acquisition clock (design 62 §4) and anything added later
 * (US short/long-term CGT, wash sales) tomorrow — so on a semiannual cadence, money
 * bought at one rebalance and sold at the next was six months old and discounted anyway.
 * The pro-rata add also raised `costBasis` while leaving `costBaseByCountry` alone, so
 * new money added to a stepped-up lot silently overstated the AU gain by its full amount.
 *
 * A buy is now what it actually is: a purchase made TODAY, in its own lot, with its own
 * `purchaseDate`, fresh basis and no per-country step-up history. It inherits the traits
 * the existing lots UNANIMOUSLY agree on (`_inheritedTraits`) — you are buying more of
 * the same thing, so an AU-share sleeve keeps buying AU shares and a treasury sleeve
 * keeps its state-tax exemption — but never their dates or bases.
 *
 * CASH is the one exception: a currency unit realizes no capital gain (design 87 §11)
 * and so has no holding period to preserve. Cash buys still merge pro-rata, which keeps
 * a cash sleeve one lot.
 *
 * ─── keeping the lot count bounded ──────────────────────────────────────────
 *
 * One new lot per rebalance per allocation would grow without limit over a 44-year run,
 * and every lot costs a per-holding growth / dividend / coupon action every period.
 * `_compactSeasonedLots` bounds it: lots THIS reducer created, of the same allocation
 * and otherwise identical, that are ALL already past the 12-month mark, collapse into
 * one. Once a lot is seasoned it stays seasoned, so no holding-period rule can tell the
 * merged lots apart — and the survivor keeps the EARLIEST `purchaseDate`, so the
 * compacted block still sorts ahead of the young lots under FIFO. Steady state is one
 * seasoned lot plus however many rebalances fall in the trailing 12 months.
 *
 * What that does cost: FIFO ordering *within* the seasoned block is averaged, so a
 * partial sale realizes the block's blended basis rather than its oldest lot's. That is
 * the same pro-rata convention `_reduceProRata` and `mergeCouponReinvestLots` already
 * use, and it is confined to lots this reducer created — authored scenario lots are
 * never merged into.
 *
 * ─── why the dust sweep exists ───────────────────────────────────────────────
 *
 * Liquidating a sleeve to a target weight of zero used to leave a residual of a cent
 * or less, and that residual was IMMORTAL. Three thresholds disagreed:
 *
 *   _reduceProRata pruned a holding only below   0.001
 *   the leg builder emitted a leg only above     0.01   (rebalance-to-target-reducer)
 *   this reducer skipped `delta >= -0.01` and `take <= 0.01`
 *
 * So anything landing in [0.001, 0.01] was simultaneously too large to prune and too
 * small to act on: a $0.01 GOLD sleeve survived 25 consecutive rebalances against a
 * target of `{EQUITY: 1.0}`. Value stayed conserved, so nothing was lost — but the
 * account kept a phantom sleeve of an asset class the policy said it must not hold,
 * which then shows up forever as its own band in the allocation report and its own
 * row in the holdings panel.
 *
 * `_sweepDust` closes the gap at the point the dust would be CREATED, folding the
 * remnant's market value AND cost basis into the largest surviving holding so both
 * gross value and basis stay exact. It deliberately does not touch a sleeve whose
 * basis is material (see the guard there), and it cannot fire on a freshly bought
 * sleeve because a buy leg only runs above the same 0.01 threshold.
 */
export class RebalanceToTargetApplyReducer extends Reducer {
  static type        = 'RebalanceToTargetApplyReducer';
  static description = 'Applies a target-allocation rebalance: taxable sells realize CGT (jurisdiction-correct), sheltered sells are free, buys add-to or establish sleeves; value conserved gross.';

  constructor() {
    super('Rebalance To Target Apply', PRIORITY.POSITION_UPDATE);
    this.reducedActionTypes   = ['REBALANCE_TO_TARGET_APPLY'];
    this.generatedActionTypes = ['STOCK_WITHDRAWAL_TAX', 'AU_STOCK_WITHDRAWAL_TAX', 'COLLECTIBLE_SALE_TAX', 'SECTION_988_GAIN'];
  }

  reduce(state, action, date) {
    const { stateKey, role, taxable, country, legs } = action;
    const account = state[stateKey];
    if (!account || !Array.isArray(account.holdings)) return this.newState(state);

    const residency  = _primaryResidency(state);
    const auLevel    = state.cpiAccumulator?.AU ?? state.inflationAccumulator?.AU ?? 1;
    // Design 83 G7 (F3) — the rebalance date, on BOTH clocks, and the two were wrong in
    // opposite directions. A rebalance runs on 1 January, so `currentPeriods.AU.startMs`
    // put every sell leg's ≥12-month Div 115 test and §1222 split six months EARLY —
    // systematically understating the hold and denying the discount — while the buy
    // legs stamped their new lots as acquired the preceding 1 July, six months early on
    // a clock that runs the other way, starting the next discount period before the
    // taxpayer owned anything. The event date settles both. `Date.now()` is gone: a
    // wall clock in a reducer breaks the sim's bit-determinism.
    const eventMs    = toMs(date);
    const auAsOfMs   = eventMs ?? state.currentPeriods?.AU?.startMs ?? null;
    const purchaseMs = eventMs ?? state.currentPeriods?.[country]?.startMs
                    ?? state.currentPeriods?.US?.startMs ?? null;

    let holdings = [...account.holdings];
    const taxActions = [];
    // Design 94 §8.1n — the §1091 pending entries this reducer's sell legs generate. See
    // `_washPendingEntries` for why they are written here and what they deliberately omit.
    const washEntries = [];
    // Design 84 G2 — realised gain inside a SHELTERED wrapper. It pays no tax today,
    // which is why this path never computed it, but for an Australian resident it is
    // an amount DERIVED by the trust estate and therefore assessable under s99B when
    // it is eventually distributed. Accumulated here and reclassified at the end.
    let shelteredGain = 0;

    // ── Sell legs first (delta < 0) — frees value the buy legs redeploy ──────────
    for (const { allocation, delta } of legs) {
      if (delta >= -0.01) continue;
      const matching = holdings.filter(h => h.allocation === allocation && (h.marketValue ?? 0) > 0);
      const availMv  = matching.reduce((s, h) => s + (h.marketValue ?? 0), 0);
      const take     = +Math.min(-delta, availMv).toFixed(2);
      if (take <= 0.01) continue;

      // A taxable, non-CASH sell realizes CGT; CASH has no gain, and sheltered
      // accounts rebalance for free.
      if (taxable && allocation !== ALLOCATION.CASH) {
        // Design 90 §9 step 2 — switched from the `consumeHoldingsFifo` wrapper to the
        // full entry point so the signed, §1222-charactered split can be requested.
        // Selection stays null, which is exactly what the wrapper passed, so lot
        // choice (and therefore every realized figure) is unchanged.
        const r = consumeHoldings(matching, take, {
          indexation: { level: auLevel, asOfMs: auAsOfMs, country: 'AU' },
          terms:      { asOfMs: auAsOfMs, countries: ['US', 'AU'] },
          securities: state.securities ?? null,
        });
        // Design 94 §8.1n — BEFORE `holdings` is rebuilt, while the pre-sale lots
        // (`matching`) and their post-sale counterparts (`r.newHoldings`) are both in hand.
        // That pairing is the only place the units and identity of what was sold can be
        // recovered exactly, and it is why this could not be done from the tax action.
        washEntries.push(..._washPendingEntries({
          // `purchaseMs`, not `eventMs`: it is the SAME date the buy legs stamp on the
          // replacement lot, via the same fallback chain. §1091's window is ±30 days, so a
          // sale and its replacement dated off two different clocks would silently fail to
          // match — and a null date would skip the entry entirely.
          allocation, country, matching, fifo: r, state, stateKey, ms: purchaseMs,
        }));
        holdings = [...holdings.filter(h => h.allocation !== allocation), ...r.newHoldings];
        taxActions.push(_sellTax({ allocation, country, proceeds: take, fifo: r, residency, stateKey }));
        // Design 87 G9 — a rebalance that trims a foreign-currency BOND sleeve disposes
        // of the instrument just as a drawdown sale does, and Reg. §1.988-2(b)(5) fires on
        // "or the instrument is disposed of" either way. Only the BOND leg can produce a
        // tally, so the EQUITY/GOLD legs pass through unchanged.
        taxActions.push(...section988ForBondPrincipal(state, stateKey, account, r.section988 ?? {}));
      } else {
        // Gain realised by a pro-rata reduction, computed BEFORE it happens and
        // without altering it. `_reduceProRata` scales each lot's costBasis with its
        // marketValue, so the basis consumed is take × (Σbasis / Σmv) and the gain is
        // the remainder. Sheltered only: a taxable CASH leg also lands here and
        // yields ~0, and a brokerage account carries no ledger to credit anyway.
        if (!taxable && allocation !== ALLOCATION.CASH) {
          const totalBasis = matching.reduce((sum, h) => sum + (h.costBasis ?? 0), 0);
          if (availMv > 0) shelteredGain += Math.max(0, +(take * (1 - totalBasis / availMv)).toFixed(2));
        }
        holdings = _reduceProRata(holdings, allocation, take);
      }
    }

    // ── Buy legs (delta > 0) — each establishes a fresh lot dated today ──────────
    for (const { allocation, delta } of legs) {
      if (delta <= 0.01) continue;
      const buyAmt   = +delta.toFixed(2);
      const matching = holdings.filter(h => h.allocation === allocation);
      // CASH realizes no capital gain and so has no holding period worth splitting a
      // lot for (design 87 §11) — merge it and keep the sleeve one lot.
      if (allocation === ALLOCATION.CASH && matching.length > 0) {
        holdings = _addProRata(holdings, allocation, buyAmt);
        continue;
      }
      // Establish a new lot, inheriting only what the existing lots unanimously agree
      // on. The gold backstop that used to sit here is gone with the bullion guard
      // (design 61 §12 OQ4a, reversed 2026-07-29) — a GOLD sleeve may now be
      // established in any account, including a US IRA/401k/Roth.
      holdings = [...holdings, _newSleeve({
        allocation, amount: buyAmt, country, role, purchaseMs, holdings, state, stateKey,
        traits: _inheritedTraits(matching, state.securities ?? null), priceLevel: auLevel, siblings: matching,
      })];
    }

    holdings = _sweepDust(holdings);
    holdings = _compactSeasonedLots(holdings, purchaseMs);

    const newBalance = +holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
    return this.newState(
      state,
      {
        [stateKey]: { ...account, ...realiseDerivedGain(account, shelteredGain), holdings, balance: newBalance },
        // Appended, never replaced: the harvester writes to this same ledger on 31 December
        // and this reducer runs on 1 January, so both years' entries have to coexist until
        // the April filing resolves them (§8.1l).
        ...(washEntries.length > 0
          ? { washPendingLosses: [...(state.washPendingLosses ?? []), ...washEntries] }
          : {}),
      },
      taxActions,
    );
  }
}

/**
 * The §1091 pending-ledger entries a taxable sell leg generates (design 94 §8.1n).
 *
 * ─── why this exists ─────────────────────────────────────────────────────────
 *
 * `state.washPendingLosses` used to have exactly ONE writer, `StockHarvestApplyReducer`, and
 * §8.1j's reasoning for that is quoted in its own comment: the harvester "sells and rebuys in
 * one action, in one account, on one day". True of the harvester — but it treats the harvester
 * as the only SELLER, and it is not. The design-61 LOCATED planner relocates a class by selling
 * it in the taxable book and rebuying it inside a wrapper, and in a down year that sale realizes
 * a loss. If the wrapper is an IRA or Roth, Rev. Rul. 2008-5 DESTROYS that loss — and until this
 * function existed the loss reached the return in full, because `characterizeCapitalGain` reads
 * the signed term fields off any disposal action while `resolveWashSales` only ever saw the
 * harvester's entries.
 *
 * ─── the one real difference from the harvester ──────────────────────────────
 *
 * The harvester sells ONE lot, so `identityGroupOf(source)` is unambiguous. A rebalance leg
 * consumes every lot of an allocation in the account, which may span several identity groups —
 * so the loss is apportioned and **one entry is emitted per group**. A single undifferentiated
 * entry would attribute the whole loss to whichever group sorted first and then match it against
 * that group's replacements, which is a wrong number that still balances.
 *
 * Units and per-lot value are recovered by diffing the pre-sale lots against
 * `fifo.newHoldings` — exact, and the reason this is called before `holdings` is rebuilt.
 *
 * ─── what it deliberately does not do ────────────────────────────────────────
 *
 * - **EQUITY only.** `_shelteredReplacements` matches EQUITY lots and nothing else, so an entry
 *   for a BOND or GOLD leg could never be matched and would sit in the ledger forever. That also
 *   keeps this inside the sourced scope: §8.1b's rule is quoted about stock and securities.
 * - **The US branch only** (`country !== 'AU'`). §1091 is a US rule resolved against the US
 *   return; an AU-domiciled disposal chains `AU_STOCK_WITHDRAWAL_TAX` into the AU module, where
 *   there is nothing for a §1091 entry to reduce. Deliberate under-write, in the same direction
 *   as §8.1i's 401(k) exclusion.
 * - **No §1091(d) basis write-back.** This closes the SHELTERED half only, where the loss is
 *   destroyed and no basis moves anywhere (§8.1i). A taxable replacement bought in another
 *   account is a timing effect and remains §8.1j's standing gap.
 * - **A group whose consumed units are not positive is skipped.** `resolveWashSales` divides by
 *   `max(entry.units, 1e-9)`, so an entry with zero units would match at fraction 1 and disallow
 *   the whole loss against any replacement at all. Note this also skips a lot that carries no
 *   `pricePerUnit`, because `consumeHoldings` rescales `units` on a PARTIAL sale only for a
 *   unitised lot (design 93 §5b) — an un-unitised one keeps its full count and reports no units
 *   consumed. That under-writes rather than over-disallows, which is the safe direction, and it
 *   cannot arise for a lot that names a security: the migration unitises those (§9.2).
 *
 * @returns {object[]} zero or more `{ ms, group, units, shortLoss, longLoss, stateKey }`
 */
function _washPendingEntries({ allocation, country, matching, fifo, state, stateKey, ms }) {
  if (allocation !== ALLOCATION.EQUITY || country === 'AU' || ms == null) return [];

  // The leg's signed, §1222-charactered split — the same fields `_sellTax` stamps, and the
  // only honest reading of the loss: `gain` is clamped at zero and reports every loss as 0.
  const { usShortTermGain, usLongTermGain } = disposalTermFields(fifo.realizedGainByCountryAndTerm);
  const lossShort = Math.max(0, -(usShortTermGain ?? 0));
  const lossLong  = Math.max(0, -(usLongTermGain  ?? 0));
  if (lossShort <= 0 && lossLong <= 0) return [];

  const after = new Map((fifo.newHoldings ?? []).map(h => [h.id, h]));
  const byGroup = new Map();          // group → { units, loss }
  let totalLoss = 0;
  for (const h of matching) {
    const group = identityGroupOf(h, state?.securities ?? null);
    // An un-securitised lot makes no identity claim (§8.1c), so it can never be matched.
    if (group == null) continue;
    const a       = after.get(h.id);
    const units   = (h.units ?? 0) - (a?.units ?? 0);
    const proceeds = (h.marketValue ?? 0) - (a?.marketValue ?? 0);
    const basis    = (h.costBasis   ?? 0) - (a?.costBasis   ?? 0);
    if (!(units > 0) || proceeds <= 0) continue;
    const lotLoss = basis - proceeds;                 // positive ⇒ this lot sold at a loss
    if (lotLoss <= 0) continue;
    const rec = byGroup.get(group) ?? { units: 0, loss: 0 };
    rec.units += units;
    rec.loss  += lotLoss;
    byGroup.set(group, rec);
    totalLoss += lotLoss;
  }
  if (totalLoss <= 0) return [];

  // Character comes from the leg's authoritative split, apportioned across groups by their
  // share of the loss. In the ordinary case there is exactly one group per allocation per
  // account (every equity lot names its market's synthetic security), so the apportionment is
  // the identity; it only approximates when one account genuinely holds two named securities
  // of the same class, and then only in how the short/long split is divided, never in the total.
  const out = [];
  for (const [group, rec] of byGroup) {
    const share = rec.loss / totalLoss;
    const shortLoss = +(lossShort * share).toFixed(2);
    const longLoss  = +(lossLong  * share).toFixed(2);
    if (shortLoss <= 0 && longLoss <= 0) continue;
    out.push({ ms, group, units: +rec.units.toFixed(6), shortLoss, longLoss, stateKey });
  }
  return out;
}

/**
 * Build the jurisdiction-correct capital-gains tax action for a taxable sell leg,
 * mirroring the field computation of the brokerage disposal reducers (floored gains,
 * per-country stepped-up + CPI-indexed AU basis). GOLD routes through
 * COLLECTIBLE_SALE_TAX (US 28% collectible / AU indexed via `isGold`); US vs AU stock
 * routes through STOCK_WITHDRAWAL_TAX vs AU_STOCK_WITHDRAWAL_TAX.
 */
function _sellTax({ allocation, country, proceeds, fifo, residency, stateKey = null }) {
  const realizedBasis        = fifo.realizedBasis;
  const realizedAuBasis      = fifo.realizedBasisByCountry?.AU ?? realizedBasis;
  const realizedIndexedAu    = fifo.realizedIndexedBasisByCountry?.AU ?? realizedAuBasis;
  const gain          = Math.max(0, +(proceeds - realizedBasis).toFixed(2));
  const auGain        = Math.max(0, +(proceeds - realizedAuBasis).toFixed(2));
  const auIndexedGain = Math.max(0, +(proceeds - realizedIndexedAu).toFixed(2));

  if (allocation === ALLOCATION.GOLD) {
    // All consumed lots are GOLD, so the collectible slice is the whole leg. Use the
    // collectible-specific AU bases when present (bullion is an ordinary AU CGT asset).
    const collAuBasis    = fifo.collectibleBasisByCountry?.AU        ?? realizedAuBasis;
    const collIndexedAu  = fifo.collectibleIndexedBasisByCountry?.AU ?? collAuBasis;
    // Design 90 §9 step 2 — every consumed lot is GOLD on this branch, so the signed
    // split comes from the COLLECTIBLE tally, not the ordinary one. Reading the wrong
    // tally here would report zero for the whole leg.
    const { usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain } =
      disposalTermFields(fifo.collectibleGainByCountryAndTerm);
    return {
      type: 'COLLECTIBLE_SALE_TAX', isGold: true, residency, stateKey,
      gain,
      auGain:        Math.max(0, +(proceeds - collAuBasis).toFixed(2)),
      auIndexedGain: Math.max(0, +(proceeds - collIndexedAu).toFixed(2)),
      usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain,
      // Design 91 §8.9 — a disposal register skips any entry without `proceeds`, so
      // omitting these taxed the gold leg while leaving it off every worksheet. The
      // two stock branches below have always stamped them; this branch is the one that
      // did not. All GOLD lots here, so the whole leg is the collectible slice.
      proceeds, costBasis: realizedBasis, description: 'rebalance',
    };
  }
  // CGT 50%-discount-eligible slice (design 62 §4): gain from lots held ≥12 months from
  // the AU deemed-acquisition date, capped at auGain. Must ride on BOTH branches, and on
  // every other emitter of these two action types — every consumer reads
  // `action.auDiscountableGain ?? auGain`, so OMITTING it does not mean "unknown", it
  // means "all of it qualifies". Dropping it on the US-country branch therefore handed a
  // rebalance the full 50% discount with no holding-period test, while a DRAWDOWN
  // disposal from that same account was gated correctly. `tests/unit/disposal-tax-payload-
  // parity.test.mjs` now holds all five emitters to one field contract.
  const auDiscountableGain = Math.min(auGain, fifo.realizedDiscountableGainByCountry?.AU ?? auGain);
  // Design 90 §9 step 2 — the signed, §1222-charactered split. Like `auDiscountableGain`
  // above it must ride on BOTH branches; the comment there explains what a missing field
  // costs, and these four carry the same hazard once step 3 starts reading them.
  const { usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain } =
    disposalTermFields(fifo.realizedGainByCountryAndTerm);
  if (country === 'AU') {
    return {
      type: 'AU_STOCK_WITHDRAWAL_TAX', gain, auGain, auIndexedGain, auDiscountableGain,
      usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain,
      // Design 76 Gap C — attribute the gain to the account that was rebalanced.
      residency, proceeds, costBasis: realizedBasis, description: 'rebalance', stateKey,
    };
  }
  return {
    type: 'STOCK_WITHDRAWAL_TAX', gain, auGain, auIndexedGain, auDiscountableGain,
    usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain,
    residency, proceeds, costBasis: realizedBasis, description: 'rebalance', stateKey,
  };
}

/**
 * The value below which a sleeve is a liquidation remnant rather than a position.
 * Deliberately the SAME 0.01 the leg builder and the sell/buy guards use — the whole
 * defect was these three numbers disagreeing (see the class doc). Keep them equal.
 */
const DUST = 0.01;

/**
 * Fold liquidation remnants into the largest surviving holding.
 *
 * A sleeve qualifies only when BOTH its market value and its cost basis are at or below
 * DUST. The basis half of that test is what keeps this safe: a holding worth a cent but
 * carrying real basis is a total unrealized LOSS, not dust, and silently folding its
 * basis into another sleeve would move that loss onto the wrong lot and mis-state a
 * later disposal. Such a holding is left exactly where it is.
 *
 * Market value and basis are both carried across, so the sweep is value- and
 * basis-neutral: no phantom cent of gain is created for a later year to tax. (Note
 * that basis-neutrality is a property of the SWEEP, not of a rebalance as a whole — a
 * taxable leg realizes gain and re-bases the lots it touches, which is why this is
 * tested directly rather than through an account-level basis total.)
 *
 * Exported for direct testing.
 */
export function _sweepDust(holdings) {
  const isDust = h => {
    const mv = h?.marketValue ?? 0;
    return mv > 0 && mv <= DUST && (h?.costBasis ?? 0) <= DUST;
  };
  if (!holdings.some(isDust)) return holdings;

  const keep = holdings.filter(h => !isDust(h));
  // Nothing to fold into (the whole account is dust) — leave it untouched rather than
  // vanish the value.
  if (keep.length === 0) return holdings;

  let mv = 0, basis = 0, face = 0;
  let anyFace = false;
  for (const h of holdings) {
    if (!isDust(h)) continue;
    mv    += h.marketValue ?? 0;
    basis += h.costBasis   ?? 0;
    if (h.faceValue != null) { face += h.faceValue; anyFace = true; }
  }

  let biggest = 0;
  for (let i = 1; i < keep.length; i++) {
    if ((keep[i].marketValue ?? 0) > (keep[biggest].marketValue ?? 0)) biggest = i;
  }
  return keep.map((h, i) => (i === biggest
    // par-reviewed: a MERGE, not a resize: N dust lots fold into one survivor, so no single
    // ratio describes it. Par is summed explicitly above.
    ? { ...h, marketValue: +((h.marketValue ?? 0) + mv).toFixed(2),
               costBasis:   +((h.costBasis   ?? 0) + basis).toFixed(2),
               // Par is conserved by the sweep like every other value field; a dust lot
               // folded in without its par leaves the survivor redeeming for less than
               // it holds.
               ...(h.faceValue == null && !anyFace ? {} : { faceValue: +((h.faceValue ?? 0) + face).toFixed(2) }) }
    : h));
}

/** Pro-rata reduce the given allocation's holdings by `amount` (free sell). */
function _reduceProRata(holdings, allocation, amount) {
  const matching = holdings.filter(h => h.allocation === allocation && (h.marketValue ?? 0) > 0);
  const totalMv  = matching.reduce((s, h) => s + (h.marketValue ?? 0), 0);
  if (totalMv <= 0) return holdings;
  return holdings.map(h => {
    if (h.allocation !== allocation) return h;
    const fraction = totalMv > 0 ? (h.marketValue / totalMv) : 0;
    const mv    = +(h.marketValue - amount * fraction).toFixed(2);
    const ratio = mv / Math.max(h.marketValue, 0.001);
    const basis = +((h.costBasis ?? 0) * ratio).toFixed(2);
    if (mv < 0.001) return null;
    // Par leaves with the units. Without this, selling an individual bond is a MONEY
    // PUMP: the value goes out, `faceValue` stays, and BondPriceAdjustReducer's
    // pull-to-par regenerates almost exactly what was sold on the next mark — measured
    // at -$1,375,173 sold against +$1,270,813 regenerated over one horizon, which is
    // most of why a nominal ladder looked untouchable next to the same book in funds.
    return resize(h, ratio);   // design 93 §4 — one ratio, every value field
  }).filter(Boolean);
}

/**
 * Pro-rata add `amount` to the given allocation's holdings (buying: basis tracks market).
 *
 * CASH ONLY. Every other allocation buys its own lot, because this merge cannot stamp a
 * purchase date on the units it adds — see the class doc. It is retained for cash because
 * a currency unit has no capital gain and therefore no holding period to preserve.
 */
function _addProRata(holdings, allocation, amount) {
  const matching = holdings.filter(h => h.allocation === allocation);
  const totalMv  = matching.reduce((s, h) => s + (h.marketValue ?? 0), 0);
  return holdings.map(h => {
    if (h.allocation !== allocation) return h;
    const fraction = totalMv > 0 ? (h.marketValue / totalMv) : (1 / matching.length);
    return addValue(h, amount * fraction);
  });
}

/**
 * The traits a freshly bought lot inherits from the lots it sits beside — but ONLY when
 * every one of them agrees. A rebalance buy is "more of the same thing", so an EQUITY
 * sleeve authored as AU shares keeps buying AU shares, a treasury BOND sleeve keeps its
 * state-tax exemption, and a lot carrying an explicit dividend yield keeps paying it
 * rather than silently dropping to the account-level fallback.
 *
 * A field the lots DISAGREE on returns `undefined`, which `_newSleeve` reads as "use the
 * default" — a mixed sleeve gets the plain, resolved defaults rather than an arbitrary
 * lot's traits.
 *
 * **Unanimity is judged on the INSTRUMENT, not on the record** (design 94 §12 D10, step 6).
 * Every field here except `securityId` is instrument-level, so the question "do these lots
 * agree?" is a question about what they are POSITIONS IN, and the answer belongs to the
 * security when they name one. The difference is reachable: two lots naming one security,
 * one of them born here with a null inline `dividendYield` and one authored with its own,
 * are the same instrument and disagree only as records — and the record view would drop the
 * yield on the next buy. That is D10's "collapse to one unanimity check" as behaviour: when
 * the lots name one security, that security answers all five. Where nothing names a security
 * — every BOND lot today — `instrumentOf` returns the holding and this is exactly the
 * historic comparison, field for field.
 *
 * Deliberately excluded: `couponRate` (design 66 G1 — a bond bought today locks TODAY's
 * market yield, which is the whole point of the lock), and everything date- or
 * basis-shaped (`purchaseDate`, `costBaseByCountry`, `acquisitionDateByCountry`,
 * `acquisitionPriceLevel`) — inheriting those is the defect this split exists to fix.
 */
function _inheritedTraits(matching, securities = null) {
  const lots = (matching ?? []).filter(Boolean);
  // Resolved ONCE per lot rather than per field: `instrumentOf` spreads two objects, and
  // this runs per buy leg per rebalance for the life of the run.
  const insts = lots.map(h => instrumentOf(h, securities));
  const unanimousOn = (records) => (field) => {
    if (records.length === 0) return undefined;
    const first = records[0][field] ?? null;
    return records.every(h => (h[field] ?? null) === first) ? first : undefined;
  };
  const unanimous = unanimousOn(insts);
  // `securityId` is the one POSITION field in this set — it is what a lot names, not
  // something the instrument says about itself — so it is read off the records.
  const unanimousLot = unanimousOn(lots);
  return {
    rateKey:       unanimous('rateKey'),
    taxExemption:  unanimous('taxExemption'),
    issuingState:  unanimous('issuingState'),
    dividendYield: unanimous('dividendYield'),
    duration:      unanimous('duration'),
    // Design 94 D10. A sleeve where every lot is one security buys more of THAT security;
    // a mixed sleeve buys the generic market position, which is the honest answer and not
    // an arbitrary lot's. Undefined here falls through to the synthetic market security
    // `promoteToUnitised` derives from the rateKey below.
    securityId:    unanimousLot('securityId'),
  };
}

/** Establish a fresh sleeve of `allocation` at cost = market (design 61 §6 buy primitive). */
function _newSleeve({ allocation, amount, country, role, purchaseMs, holdings = [], state = null, stateKey = null, traits = {}, priceLevel = null, siblings = [] }) {
  // The role is safe to pass now: resolveRateKey only lets it refine WITHIN the
  // allocation's own class, so a BOND sleeve in an equity-role account still
  // resolves to the bond rate. (This used to force role=null to work around the
  // resolver returning the wrapper's equity key for any non-CASH/GOLD sleeve.)
  // Called unconditionally even when a rateKey is inherited, so an unknown allocation
  // still throws here rather than surviving as an unresolvable lot.
  const resolvedKey = resolveRateKey(country, allocation, role);
  const rateKey     = traits.rateKey !== undefined ? traits.rateKey : resolvedKey;
  const defaultDuration = allocation === ALLOCATION.BOND
    ? (RATE_KEY_META[resolvedKey]?.defaultDuration ?? null)
    : null;
  // Duration is a property of the instrument being bought, so it follows the sleeve when
  // the sleeve agrees on one; the coupon below does NOT, because that is the price paid
  // today (design 66 G1).
  const duration = allocation === ALLOCATION.BOND && traits.duration !== undefined
    ? traits.duration
    : defaultDuration;
  // G1 (design 66) — yield lock-in: a newly established BOND sleeve fixes its coupon
  // at the prevailing market yield at purchase, read from state.effectiveInterestRates
  // for the sleeve's fixed-income rate key (per-account `<rateKey>::<stateKey>` override
  // → shared `<rateKey>`), mirroring the earnings-handler rate precedence. This makes a
  // bond bought when yields are high pay that high coupon forever (a fixed contractual
  // coupon that no longer floats with regime moves). When the map has no entry, leave
  // couponRate null so the sleeve falls back to the coupon handler's per-account rate —
  // preserving pre-G1 behavior. Non-BOND sleeves never carry a coupon.
  const couponRate = allocation === ALLOCATION.BOND
    ? _stampCouponRate(state, stateKey, rateKey)
    : null;
  // par-reviewed: a CONSTRUCTION, not a mutation — there is no prior position whose par
  // this could fall out of step with. It reads as the write shape only because design 94
  // step 3 gave it a conditional `...securityId` spread; an established EQUITY sleeve
  // carries no faceValue at all, and a BOND sleeve established here is a bond FUND with
  // no par. `promoteToUnitised` below is what gives it a unit count.
  const lot = {
    // A UNIQUE, deterministic id is mandatory: the per-sleeve growth / dividend /
    // coupon / cash-interest streams emit HoldingTransactActions keyed by holdingId,
    // and HoldingTransactReducer matches `h.id === holdingId`. Two holdings sharing an
    // id (e.g. both null) would collide — a sibling sleeve's earnings would land on the
    // wrong holding and corrupt the account. Derive it from (allocation, purchaseMs),
    // disambiguating against the current holdings so replay stays deterministic.
    id:            _freshHoldingId(holdings, allocation, purchaseMs),
    allocation,
    marketValue:   +amount.toFixed(2),
    costBasis:     +amount.toFixed(2),
    costBaseByCountry: null,
    purchaseDate:  new Date(purchaseMs),
    // The AU indexation base (design 57 §6.3): the CPI level at THIS lot's acquisition,
    // which for a lot bought here is today. Leaving it null meant a lot bought during the
    // simulation indexed at factor 1 forever — never CPI-indexed under the post-2027
    // reform, whose model (design 57 Item B) is "index from acquisition to sale, no
    // pre-2027 carve-out". If the resident later moves to AU, the s855-45 step-up
    // supersedes this level with the move's, because the step-up IS the AU acquisition
    // (`AccountService.recordResidencyChange`).
    acquisitionPriceLevel: priceLevel,
    acquisitionDateByCountry: null,
    rateKey,
    label:         '',
    dividendYield: traits.dividendYield ?? null,
    couponRate,                   // G1: locked to the market yield at purchase (null ⇒ floats)
    appreciationSchedule: null,
    duration,
    taxLossPartner: null,
    // An established sleeve is a generic taxable bond (design 66 §G2) unless the sleeve
    // it joins is unanimously something else — buying more treasuries stays exempt.
    taxExemption:  traits.taxExemption ?? 'none',
    issuingState:  traits.issuingState ?? null,
    ...(traits.securityId == null ? {} : { securityId: traits.securityId }),
  };
  // Design 94 §9.5c — every lot BIRTH site establishes units, not only the config→run
  // boundary. A rebalance buy is the second-largest source of lots in the model, and one
  // born scalar beside unitised siblings is the mixed mode §9.5c measured. The price it
  // joins at is the sleeve's own (`prevailingPrice`), never the convention's 100: minting
  // at 100 beside a seasoned lot fabricates the unit count and defeats compaction.
  // A no-op on BOND-fund and CASH sleeves, which carry no unit count to establish.
  return promoteToUnitised(lot, { price: prevailingPrice(siblings) });
}

/**
 * G1 (design 66) — resolve the market yield to stamp on a freshly established BOND
 * sleeve's `couponRate`, from `state.effectiveInterestRates`: the per-account
 * `<rateKey>::<stateKey>` override wins over the shared `<rateKey>`. Returns null
 * when neither is present (or state is unavailable) so the sleeve keeps the
 * pre-G1 floating behavior (falls back to the coupon handler's per-account rate).
 */
function _stampCouponRate(state, stateKey, rateKey) {
  // design 67 — a rebalance-established sleeve carries no maturityDate (it is a bond
  // FUND), so it locks the yield at the fund tenor (the 5y anchor). resolveYield keeps
  // the per-account `<rateKey>::<stateKey>` → shared `<rateKey>` precedence and returns
  // null when neither is present, preserving the pre-G1 floating fallback.
  return resolveYield(state, { rateKey, stateKey, tenorYears: null });
}

/**
 * The id prefix every lot this reducer establishes carries. Compaction keys off it so
 * the reducer only ever merges lots it created itself — an authored scenario lot, a bond
 * ladder rung or a coupon-reinvestment lot is left exactly where it is.
 */
const REB_LOT_PREFIX = 'reb-';


/**
 * Collapse this reducer's own seasoned lots so the holdings array stays bounded over a
 * long run (see the class doc).
 *
 * The rules — own lots only, both seasoned past twelve months, every unhandled field
 * equal, coupon and duration blended by market value, `acquisitionPriceLevel` as the
 * basis-weighted harmonic mean, survivor keeps the earliest date and id — now live in
 * `lot-compaction.js` as `LOT_POLICIES.REBALANCE`, because two more families grew the
 * same function afterwards (design 93 §5.5) and the copies had already drifted on what
 * "twelve months" means.
 *
 * Kept as a named export because that is what the tests and `src/index.js` reference, and
 * because the reducer owning a name for its own policy is the point of the prefix.
 */
export function _compactSeasonedLots(holdings, asOfMs) {
  return compactLots(holdings, { asOfMs, policy: LOT_POLICIES.REBALANCE });
}


/** Milliseconds of a lot's purchaseDate; 0 (oldest) when it carries none. */
function _purchaseTs(h) {
  if (!h?.purchaseDate) return 0;
  const t = h.purchaseDate instanceof Date ? h.purchaseDate.getTime() : new Date(h.purchaseDate).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * A deterministic holding id unique within `holdings` — `reb-<alloc>-<purchaseMs>`,
 * with a numeric suffix only if that base already exists (e.g. a sleeve re-established
 * in the same period after being fully consumed). Deterministic ⇒ snapshot/replay-safe.
 */
function _freshHoldingId(holdings, allocation, purchaseMs) {
  const base = `${REB_LOT_PREFIX}${allocation}-${purchaseMs}`;
  const existing = new Set((holdings ?? []).map(h => h?.id).filter(Boolean));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function _primaryResidency(state) {
  const people = state.people ?? {};
  for (const p of Object.values(people)) {
    if (p?.residency) return p.residency;
  }
  return 'US';
}
