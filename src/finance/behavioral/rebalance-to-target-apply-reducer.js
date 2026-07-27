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
import { consumeHoldingsFifo }  from '../holdings/holdings-fifo.js';
import { resolveRateKey }       from '../holdings/default-allocations.js';
import { RATE_KEY_META }        from '../economic-regimes/rate-keys.js';
import { resolveYield }         from '../economic-regimes/yield-curve.js';
import { realiseDerivedGain } from '../assets/investment-account.js';

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
 *   - **Buy**: add to an existing sleeve of the target allocation, or ESTABLISH a new
 *     sleeve when none exists (the design-61 §6 buy primitive) — stamping allocation,
 *     marketValue, costBasis (= amount, fresh basis), purchaseDate, rateKey (via
 *     resolveRateKey) and BOND defaults. A GOLD sleeve may be established in ANY
 *     account, including a US IRA/401k/Roth — the bullion guard was reversed (design 61
 *     §12 OQ4a, 2026-07-29) because a gold ETF is holdable there and taxed the same.
 *
 * Legs sum to zero (Σ delta = 0), so gross account value is conserved; the realized
 * CGT is the only (deferred) cost. Balance is re-synced to Σ marketValue. Holdings are
 * rebuilt copy-on-write (never mutated in place) so JOURNAL_STRICT purity holds (G2).
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
    this.generatedActionTypes = ['STOCK_WITHDRAWAL_TAX', 'AU_STOCK_WITHDRAWAL_TAX', 'COLLECTIBLE_SALE_TAX'];
  }

  reduce(state, action) {
    const { stateKey, role, taxable, country, legs } = action;
    const account = state[stateKey];
    if (!account || !Array.isArray(account.holdings)) return this.newState(state);

    const residency  = _primaryResidency(state);
    const auLevel    = state.cpiAccumulator?.AU ?? state.inflationAccumulator?.AU ?? 1;
    const auAsOfMs   = state.currentPeriods?.AU?.startMs ?? Date.now();
    const purchaseMs = state.currentPeriods?.[country]?.startMs
                    ?? state.currentPeriods?.US?.startMs ?? Date.now();

    let holdings = [...account.holdings];
    const taxActions = [];
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
        const r = consumeHoldingsFifo(matching, take, { level: auLevel, asOfMs: auAsOfMs, country: 'AU' });
        holdings = [...holdings.filter(h => h.allocation !== allocation), ...r.newHoldings];
        taxActions.push(_sellTax({ allocation, country, proceeds: take, fifo: r, residency, stateKey }));
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

    // ── Buy legs (delta > 0) — add to a sleeve, or establish a new one ───────────
    for (const { allocation, delta } of legs) {
      if (delta <= 0.01) continue;
      const buyAmt   = +delta.toFixed(2);
      const matching = holdings.filter(h => h.allocation === allocation);
      if (matching.length > 0) {
        holdings = _addProRata(holdings, allocation, buyAmt);
      } else {
        // Establish a new sleeve. The gold backstop that used to sit here is gone with
        // the bullion guard (design 61 §12 OQ4a, reversed 2026-07-29) — a GOLD sleeve
        // may now be established in any account, including a US IRA/401k/Roth.
        holdings = [...holdings, _newSleeve({ allocation, amount: buyAmt, country, role, purchaseMs, holdings, state, stateKey })];
      }
    }

    holdings = _sweepDust(holdings);

    const newBalance = +holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
    return this.newState(
      state,
      { [stateKey]: { ...account, ...realiseDerivedGain(account, shelteredGain), holdings, balance: newBalance } },
      taxActions,
    );
  }
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
    return {
      type: 'COLLECTIBLE_SALE_TAX', isGold: true, residency, stateKey,
      gain,
      auGain:        Math.max(0, +(proceeds - collAuBasis).toFixed(2)),
      auIndexedGain: Math.max(0, +(proceeds - collIndexedAu).toFixed(2)),
    };
  }
  // CGT 50%-discount-eligible slice (design 62 §4): gain from lots held ≥12 months from
  // the AU deemed-acquisition date, capped at auGain. Must ride on BOTH branches. Both
  // brokerage disposal reducers stamp it (au-brokerage-classes, us-brokerage-classes),
  // and every consumer reads `action.auDiscountableGain ?? auGain` — so OMITTING it does
  // not mean "unknown", it means "all of it qualifies". Dropping it on the US-country
  // branch therefore handed a rebalance the full 50% discount with no holding-period
  // test, while a DRAWDOWN disposal from that same account was gated correctly.
  const auDiscountableGain = Math.min(auGain, fifo.realizedDiscountableGainByCountry?.AU ?? auGain);
  if (country === 'AU') {
    return {
      type: 'AU_STOCK_WITHDRAWAL_TAX', gain, auGain, auIndexedGain, auDiscountableGain,
      // Design 76 Gap C — attribute the gain to the account that was rebalanced.
      residency, proceeds, costBasis: realizedBasis, description: 'rebalance', stateKey,
    };
  }
  return {
    type: 'STOCK_WITHDRAWAL_TAX', gain, auGain, auIndexedGain, auDiscountableGain,
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

  let mv = 0, basis = 0;
  for (const h of holdings) {
    if (!isDust(h)) continue;
    mv    += h.marketValue ?? 0;
    basis += h.costBasis   ?? 0;
  }

  let biggest = 0;
  for (let i = 1; i < keep.length; i++) {
    if ((keep[i].marketValue ?? 0) > (keep[biggest].marketValue ?? 0)) biggest = i;
  }
  return keep.map((h, i) => (i === biggest
    ? { ...h, marketValue: +((h.marketValue ?? 0) + mv).toFixed(2),
               costBasis:   +((h.costBasis   ?? 0) + basis).toFixed(2) }
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
    const basis = +((h.costBasis ?? 0) * (mv / Math.max(h.marketValue, 0.001))).toFixed(2);
    if (mv < 0.001) return null;
    return { ...h, marketValue: mv, costBasis: basis };
  }).filter(Boolean);
}

/** Pro-rata add `amount` to the given allocation's holdings (buying: basis tracks market). */
function _addProRata(holdings, allocation, amount) {
  const matching = holdings.filter(h => h.allocation === allocation);
  const totalMv  = matching.reduce((s, h) => s + (h.marketValue ?? 0), 0);
  return holdings.map(h => {
    if (h.allocation !== allocation) return h;
    const fraction = totalMv > 0 ? (h.marketValue / totalMv) : (1 / matching.length);
    return {
      ...h,
      marketValue: +(h.marketValue + amount * fraction).toFixed(2),
      costBasis:   +((h.costBasis ?? 0) + amount * fraction).toFixed(2),
    };
  });
}

/** Establish a fresh sleeve of `allocation` at cost = market (design 61 §6 buy primitive). */
function _newSleeve({ allocation, amount, country, role, purchaseMs, holdings = [], state = null, stateKey = null }) {
  // The role is safe to pass now: resolveRateKey only lets it refine WITHIN the
  // allocation's own class, so a BOND sleeve in an equity-role account still
  // resolves to the bond rate. (This used to force role=null to work around the
  // resolver returning the wrapper's equity key for any non-CASH/GOLD sleeve.)
  const rateKey  = resolveRateKey(country, allocation, role);
  const duration = allocation === ALLOCATION.BOND
    ? (RATE_KEY_META[rateKey]?.defaultDuration ?? null)
    : null;
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
  return {
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
    acquisitionPriceLevel: null,
    acquisitionDateByCountry: null,
    rateKey,
    label:         '',
    dividendYield: null,
    couponRate,                   // G1: locked to the market yield at purchase (null ⇒ floats)
    appreciationSchedule: null,
    duration,
    taxLossPartner: null,
    taxExemption:  'none',        // an established sleeve is a generic taxable bond (design 66 §G2)
    issuingState:  null,
  };
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
 * A deterministic holding id unique within `holdings` — `reb-<alloc>-<purchaseMs>`,
 * with a numeric suffix only if that base already exists (e.g. a sleeve re-established
 * in the same period after being fully consumed). Deterministic ⇒ snapshot/replay-safe.
 */
function _freshHoldingId(holdings, allocation, purchaseMs) {
  const base = `reb-${allocation}-${purchaseMs}`;
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
