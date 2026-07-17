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
import { roleCanHoldGold }      from './rebalance-to-target-reducer.js';

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
 *     resolveRateKey) and BOND defaults. A GOLD establish is guarded out of a US
 *     tax-advantaged account (bullion ban, §OQ4a) as a defensive backstop; the leg
 *     reducer already renormalizes a guarded account's target so no gold leg is generated.
 *
 * Legs sum to zero (Σ delta = 0), so gross account value is conserved; the realized
 * CGT is the only (deferred) cost. Balance is re-synced to Σ marketValue. Holdings are
 * rebuilt copy-on-write (never mutated in place) so JOURNAL_STRICT purity holds (G2).
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
        taxActions.push(_sellTax({ allocation, country, proceeds: take, fifo: r, residency }));
      } else {
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
        // Establish a new sleeve. Backstop the gold guard (§OQ4a) — normally the leg
        // reducer already dropped GOLD from a guarded account's target.
        if (allocation === ALLOCATION.GOLD && !roleCanHoldGold(role)) continue;
        holdings = [...holdings, _newSleeve({ allocation, amount: buyAmt, country, role, purchaseMs, holdings, state, stateKey })];
      }
    }

    const newBalance = +holdings.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);
    return this.newState(
      state,
      { [stateKey]: { ...account, holdings, balance: newBalance } },
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
function _sellTax({ allocation, country, proceeds, fifo, residency }) {
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
      type: 'COLLECTIBLE_SALE_TAX', isGold: true, residency,
      gain,
      auGain:        Math.max(0, +(proceeds - collAuBasis).toFixed(2)),
      auIndexedGain: Math.max(0, +(proceeds - collIndexedAu).toFixed(2)),
    };
  }
  if (country === 'AU') {
    const auDiscountableGain = Math.min(auGain, fifo.realizedDiscountableGainByCountry?.AU ?? auGain);
    return {
      type: 'AU_STOCK_WITHDRAWAL_TAX', gain, auGain, auIndexedGain, auDiscountableGain,
      residency, proceeds, costBasis: realizedBasis, description: 'rebalance',
    };
  }
  return {
    type: 'STOCK_WITHDRAWAL_TAX', gain, auGain, auIndexedGain,
    residency, proceeds, costBasis: realizedBasis, description: 'rebalance',
  };
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
  // Resolve by (country, allocation) with NO role: the role's default rate key
  // (e.g. IRA → EQUITY_US) would otherwise override a non-default sleeve — a BOND
  // sleeve in an equity-role account must grow at the bond rate, not the wrapper's
  // equity rate. Allocation must win (as it already does for CASH/GOLD in resolveRateKey).
  // For an EQUITY sleeve this is identical to the role-keyed result.
  const rateKey  = resolveRateKey(country, allocation, null);
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
  const rates = state?.effectiveInterestRates;
  if (!rates || rateKey == null) return null;
  const perAcct = (stateKey != null) ? rates[`${rateKey}::${stateKey}`] : undefined;
  return perAcct ?? rates[rateKey] ?? null;
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
