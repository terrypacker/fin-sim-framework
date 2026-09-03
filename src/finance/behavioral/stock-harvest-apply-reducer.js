/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { Reducer, PRIORITY } from '../../simulation-framework/reducers.js';
import { singleAssetTermFields } from '../holdings/holding-period.js';
import { toMs } from '../account-rules/main-residence.js';
import { resize, addValue, promoteToUnitised, prevailingPrice } from '../holdings/holding-utils.js';
import { identityGroupOf } from '../holdings/security.js';

/**
 * StockHarvestApplyReducer — dedicated sell+rebuy path for tax-loss and tax-gain
 * harvesting (design/29 §3.3, §3.8, Step 9).
 *
 * Unlike StockWithdrawalApplyReducer, this reducer:
 *   - Targets a specific source holding (sourceHoldingId), rather than FIFO-consuming
 *     the whole account, so the harvest hits exactly the holding with the unrealized loss.
 *   - Computes a SIGNED realizedGainLoss (no Math.max(0, …) floor), so losses reach
 *     the tax module's YTD capital-gain accumulator as negative deltas.
 *   - Immediately rebuys a substitute holding for the same proceeds, so the account
 *     stays invested. Cash balance is unchanged (sell + rebuy cancel out).
 *   - Chains STOCK_WITHDRAWAL_TAX with the signed gain — the tax module already
 *     accepts signed values and simply adds them to usCapitalGainsYTD / auCapitalGainsYTD.
 *
 * Action fields:
 *   stateKey          - account state key (e.g. 'usStockAccount')
 *   sellAmount        - dollar amount to realize from sourceHolding (≤ holding.marketValue)
 *   sourceHoldingId   - id of the holding to sell (must be < basis for LOSS; > for GAIN)
 *   substituteHoldingId - id of the holding to rebuy (same account; may equal source for GAIN)
 *   substituteSecurityId - a SECURITY to rebuy into when the account holds no suitable lot;
 *                       a fresh position is opened in it (design 94 §8.1h). This is the
 *                       two-fund rotation the model could not express before a lot named an
 *                       instrument: sell A, buy B, and next year sell B and buy A again —
 *                       "buy A again" was unreachable while a substitute had to be a lot
 *                       that already existed, which is what turned the harvester into a
 *                       one-shot strategy (R2, §8.1f)
 *   purpose           - 'LOSS' | 'GAIN'  (informational; no branch on this field)
 *   residency         - 'US' | 'AU'  (passed to STOCK_WITHDRAWAL_TAX)
 */
/**
 * `base`, or `base-2`, `base-3`… — the first form no lot in `holdings` already uses.
 *
 * Mirrors the rebalancer's `_freshHoldingId`; deterministic, so replay is unaffected.
 */
function _freshLotId(holdings, base) {
  const existing = new Set((holdings ?? []).map(h => h?.id).filter(Boolean));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export class StockHarvestApplyReducer extends Reducer {
  static type        = 'StockHarvestApplyReducer';
  static description = 'Tax-harvest sell+rebuy: signed realized gain/loss on a target holding, immediate substitute rebuy, chains STOCK_WITHDRAWAL_TAX with the signed gain.';

  constructor() {
    super('Stock Harvest Apply', PRIORITY.CASH_FLOW);
    this.reducedActionTypes   = ['STOCK_HARVEST_APPLY'];
    this.generatedActionTypes = ['STOCK_WITHDRAWAL_TAX'];
  }

  reduce(state, action, date) {
    const { stateKey, sellAmount, sourceHoldingId, substituteHoldingId, substituteSecurityId,
            purpose, residency } = action;
    const account = state[stateKey];
    if (!account) return state;

    const holdings = account.holdings ?? [];
    const source   = holdings.find(h => h.id === sourceHoldingId);
    if (!source) return state;

    // How much of the source holding to consume
    const consume     = +Math.min(sellAmount, source.marketValue).toFixed(2);
    const basisFrac   = source.marketValue > 0 ? consume / source.marketValue : 0;
    const basisShare  = +((source.costBasis ?? 0) * basisFrac).toFixed(2);

    // Signed gain/loss — NO Math.max(0, …) floor (the whole point vs normal withdrawal)
    const realizedGainLoss = +(consume - basisShare).toFixed(2);

    // AU assessment of the same disposal (design 36 §12.2, design 62 §4). The other
    // four STOCK_WITHDRAWAL_TAX emitters all stamp these; this one stamped none, and
    // every consumer reads `auGain ?? gain` / `auDiscountableGain ?? auGain` — so the
    // omission silently assessed an AU resident's harvest on the US cost base with a
    // blanket 50% discount (design/inconsistencies §4.11). Held-period test runs from
    // the lot's purchaseDate, matching consumeHoldings.
    const auBasisShare = +(((source.costBaseByCountry?.AU ?? source.costBasis) ?? 0) * basisFrac).toFixed(2);
    const auGainLoss   = +(consume - auBasisShare).toFixed(2);
    const purchasedMs  = source.purchaseDate != null ? new Date(source.purchaseDate).getTime() : null;
    // Design 83 G7 (F3) — the CGT event date, not the start of the AU financial year
    // containing it. This one value does three jobs below: the ≥12-month Div 115 gate,
    // the §1222 short/long split, and the `saleMs` stamped on the emitted payload. The
    // period start understated the hold by up to a full year on all three at once, and
    // a harvest is precisely the disposal whose date the taxpayer CHOSE.
    const asOfMs       = toMs(date) ?? state.currentPeriods?.AU?.startMs ?? null;
    const held12mo     = purchasedMs != null && asOfMs != null
      ? (asOfMs - purchasedMs) >= 365 * 24 * 60 * 60 * 1000
      : false;
    // A capital LOSS is never "discountable" — the discount applies to gains only, so
    // the eligible slice floors at 0 rather than tracking a negative auGainLoss.
    const auDiscountableGain = held12mo ? Math.max(0, auGainLoss) : 0;

    // Design 90 §9 step 2 — the signed, §1222-charactered split. This reducer has
    // always emitted a signed `gain`; what it could not say was WHICH CHARACTER that
    // gain or loss carried, and §1212(b)(1)(A)/(B) carries the two forward separately.
    // Routed through the shared builder rather than reusing `held12mo` above: that
    // test is the AU inclusive one, and reusing it would silently classify a
    // harvest of a lot held exactly one year as US long-term when §1222(3) says short.
    const { usShortTermGain, usLongTermGain, auShortTermGain, auLongTermGain } =
      singleAssetTermFields({
        proceeds: consume, usBasis: basisShare, auBasis: auBasisShare,
        acquisitionMs:   purchasedMs,
        // The AU clock restarts at the residency deemed acquisition where one was
        // stamped (design 62 §4); falls back to the purchase date like every other path.
        auAcquisitionMs: source.acquisitionDateByCountry?.AU ?? purchasedMs,
        saleMs: asOfMs,
      });

    // Reduce/remove source holding
    const afterSell = holdings.map(h => {
      if (h.id !== sourceHoldingId) return h;
      const remainingMv    = +(h.marketValue - consume).toFixed(2);
      if (remainingMv < 0.001) return null; // fully consumed
      // A UNIT change — see design 93 §4. `resize` carries basis, par and every
      // per-country cost base by the same ratio; the hand-rolled version carried basis only.
      return resize(h, remainingMv / Math.max(h.marketValue ?? 0, 0.001));
    }).filter(Boolean);

    // Rebuy substitute: add proceeds to its marketValue and costBasis
    // (new lot at today's price — basis = market price, so gain resets to 0).
    //
    // Special case: when source === substitute (TaxGainHarvest rebuy of same holding),
    // the sell may have fully removed the holding from afterSell. Re-add it with the
    // rebuyed values so the position stays invested.
    let substituteFound = false;
    let replacementId    = null;   // the lot the proceeds landed in — §1091's "replacement"
    let replacementUnits = 0;      // how many SHARES it acquired, which is what §1091(b) matches
    let afterRebuy = substituteHoldingId == null ? afterSell : afterSell.map(h => {
      if (h.id !== substituteHoldingId) return h;
      substituteFound = true;
      // New money into an existing lot: basis rises by the full amount (design 93 §4).
      const grown = addValue(h, consume);
      replacementId    = h.id;
      replacementUnits = Math.max(0, (grown.units ?? 0) - (h.units ?? 0));
      return grown;
    });

    // A SECURITY substitute: open a fresh position in it rather than adding to a lot that
    // does not exist (design 94 §8.1h). Dated today, basis = market, and it takes the
    // sold lot's allocation — it is the same asset class in the same market, differing
    // only in which instrument it is, which is the entire point.
    if (!substituteFound && substituteSecurityId != null) {
      const sec      = state.securities?.[substituteSecurityId] ?? null;
      const siblings = afterSell.filter(h => h.allocation === source.allocation);
      // par-reviewed: CREATES a lot. `source` is a TEMPLATE for allocation and the
      // position-level fields a fresh buy inherits; every instrument field comes from the
      // security it names, so nothing about the sold instrument rides along.
      const fresh = promoteToUnitised({
        // Disambiguated against the account's own lots, exactly as the rebalancer's
        // `_freshHoldingId` is. A harvest can fire more than once on one account on one day
        // — several source lots, one policy — and `tlh-<security>-<ms>` is the SAME id each
        // time. Two lots sharing an id is not cosmetic: `HoldingTransactReducer` matches on
        // it, so each one's growth, dividends and coupons land on whichever it finds first
        // and the other's are lost or doubled. Found by the `wash-sale-two-books` golden
        // (design 94 §8.1p), which is the first fixture to harvest twice in a day.
        id:            _freshLotId(afterSell, `tlh-${substituteSecurityId}-${toMs(date) ?? 0}`),
        allocation:    source.allocation,
        rateKey:       sec?.rateKey ?? source.rateKey ?? null,
        securityId:    substituteSecurityId,
        label:         sec?.name ?? sec?.symbol ?? '',
        marketValue:   consume,
        costBasis:     consume,
        costBaseByCountry: null,
        purchaseDate:  date instanceof Date ? new Date(date) : new Date(toMs(date) ?? 0),
        acquisitionPriceLevel:    source.acquisitionPriceLevel ?? null,
        acquisitionDateByCountry: null,
      }, { price: prevailingPrice(siblings) });
      afterRebuy       = [...afterSell, fresh];
      substituteFound  = true;
      replacementId    = fresh.id;
      replacementUnits = fresh.units ?? 0;
    }

    if (!substituteFound) {
      if (substituteHoldingId === sourceHoldingId) {
        // Source was fully consumed; rebuy it with a fresh cost basis at market price
        afterRebuy = [
          ...afterSell,
          // par-reviewed: CREATES a new lot using an existing one as a template. A fresh lot has no
          // par to fall out of step with; the spread copies traits, it does not mutate a position.
          {
            ...source,
            marketValue: consume,
            costBasis:   consume,
          },
        ];
      } else {
        console.warn(`[StockHarvestApplyReducer] substitute holding '${substituteHoldingId}' not found in ${stateKey}; harvest skipped`);
        return state;
      }
    }

    // ── §1091(a)/(d) + §1223(3): the IMMEDIATE wash (design 94 §8.1j, step 7b) ──
    //
    // The harvester sells and rebuys in one action, in one account, on one day. When the
    // replacement is in the sold lot's own §1091 identity group that IS a wash sale, and it
    // is the only wash in this engine where **both lots are in hand at the moment it
    // happens** — so it needs no ledger, no window scan and no lag. It is also the dominant
    // one: in an un-securitised book every equity lot shares a market synthetic, so step 3
    // of `resolveSubstitute` picks an identical partner and every harvest lands here.
    //
    // Three consequences, and this is the branch that has all three (§8.1b):
    //   (a) §1091(a) — the matched share of the loss is DISALLOWED;
    //   (b) §1091(d) — it is not destroyed: it moves into the replacement's BASIS, so it is
    //       recovered on the eventual sale. Timing, not money, which is why R2 held it;
    //   (c) §1223(3) — the replacement's holding period INCLUDES the sold lot's, so a wash
    //       can never convert long-term into short-term.
    //
    // AU is deliberately untouched. There is no §1091 in Australia; TR 2008/1's answer is a
    // Part IVA cancellation, a different mechanism with a different consequence (§8.1d), and
    // stamping this on `auGain` would be the wrong rule in the wrong country.
    let lossShort = Math.max(0, -usShortTermGain);
    let lossLong  = Math.max(0, -usLongTermGain);
    let unitsLeft = (source.units ?? 0) * basisFrac;
    let disallowed = 0;
    const sourceGroup = identityGroupOf(source, state.securities ?? null);
    const replacement = afterRebuy.find(h => h.id === replacementId) ?? null;
    if ((lossShort > 0 || lossLong > 0) && sourceGroup != null && replacement != null
        && identityGroupOf(replacement, state.securities ?? null) === sourceGroup) {
      // §1091(b) / §1.1091-1(h) Example 2 — shares, not dollars.
      const frac = unitsLeft > 0 ? Math.min(1, replacementUnits / unitsLeft) : 0;
      const dShort = +(lossShort * frac).toFixed(2);
      const dLong  = +(lossLong  * frac).toFixed(2);
      disallowed   = +(dShort + dLong).toFixed(2);
      if (disallowed > 0) {
        lossShort = +(lossShort - dShort).toFixed(2);
        lossLong  = +(lossLong  - dLong).toFixed(2);
        // §1.1091-1(e): shares that have already disallowed a loss are disregarded when
        // testing another. Taking them out of the count here is what stops the sheltered
        // ledger below matching the same shares a second time.
        unitsLeft = +(unitsLeft * (1 - frac)).toFixed(6);
        afterRebuy = afterRebuy.map((h) => {
          if (h.id !== replacementId) return h;
          // (b) and (c) together. `costBasis` rises by the disallowed loss — §1.1091-2's
          // worked form is "basis of the new = basis of the old ± the price difference",
          // which for a same-day sell-and-rebuy at one price reduces to exactly this. The
          // date moves back only for a lot BORN here: an existing lot already carries its
          // own, older, holding period and rewriting it would tack the period onto shares
          // that were never sold.
          const bornHere = replacementUnits > 0 && (h.units ?? 0) - replacementUnits < 1e-9;
          return {
            ...h,
            costBasis: +((h.costBasis ?? 0) + disallowed).toFixed(2),
            ...(bornHere && source.purchaseDate != null ? { purchaseDate: source.purchaseDate } : {}),
          };
        });
      }
    }
    // What the US return actually sees: the loss net of the disallowance. `lossShort` and
    // `lossLong` started as the loss and were reduced by whatever was disallowed above, so
    // the reported figure is simply their negation — a GAIN is never touched, because
    // §1091 is a rule about losses.
    // `|| 0` and not just `-x`: negating a zero gives -0, which survives into the payload
    // and into any fixture written from it, where it compares unequal to 0 under
    // `Object.is` and reads as noise in a diff.
    const usShortTermGainRep = usShortTermGain < 0 ? (-lossShort || 0) : usShortTermGain;
    const usLongTermGainRep  = usLongTermGain  < 0 ? (-lossLong  || 0) : usLongTermGain;
    const gainRep = +(realizedGainLoss + disallowed).toFixed(2) || 0;

    const newBalance = +afterRebuy.reduce((s, h) => s + (h?.marketValue ?? 0), 0).toFixed(2);

    // ── the §1091 pending ledger (design 94 §8.1i) ──────────────────────────────
    //
    // Written HERE rather than from the chained STOCK_WITHDRAWAL_TAX, because this is the
    // only place that knows all four facts at once: the loss, its character, the number of
    // units that left, and WHAT they were units OF. The tax action carries the money but
    // not the instrument, and adding the instrument to a payload five emitters share is a
    // manifest change §8.1i does not need.
    //
    // Only a LOSS, and only a lot that names something: an un-securitised lot makes no
    // identity claim (§8.1c), so it can never be matched and an entry for it would sit in
    // the ledger forever.
    const washPatch = {};
    const group = identityGroupOf(source, state.securities ?? null);
    // NET of anything §8.1j already disallowed on the spot: the same shares must not be
    // matched twice (§1.1091-1(e)), and the same dollars must not be disallowed twice.
    if (realizedGainLoss < 0 && group != null && (lossShort > 0 || lossLong > 0)) {
      washPatch.washPendingLosses = [
        ...(state.washPendingLosses ?? []),
        {
          ms:         toMs(date) ?? 0,
          // §1223(3), for a TAXABLE replacement matched later (design 94 §8.1p): the
          // replacement's holding period includes the SOLD lot's, so the resolver needs to
          // know how long these shares were held. Null when the source carries no date —
          // the basis still transfers, the period simply does not tack.
          heldFromMs: toMs(source.purchaseDate) ?? null,
          group,
          units:      +unitsLeft.toFixed(6),
          shortLoss:  lossShort,
          longLoss:   lossLong,
          stateKey,
        },
      ];
    }

    return this.newState(
      state,
      {
        ...washPatch,
        [stateKey]: {
          ...account,
          holdings: afterRebuy,
          balance:  newBalance,
        },
      },
      [{
        type:        'STOCK_WITHDRAWAL_TAX',
        gain:        gainRep,
        auGain:      auGainLoss,
        auDiscountableGain,
        usShortTermGain: usShortTermGainRep,
        usLongTermGain:  usLongTermGainRep,
        auShortTermGain, auLongTermGain,
        // Stated on the payload rather than silently netted, so the disallowance can be
        // drilled from the journal and footed against the return (design 94 §8.1j).
        ...(disallowed > 0 ? { washDisallowed: disallowed } : {}),
        residency:   residency ?? 'US',
        proceeds:    consume,
        costBasis:   basisShare,
        description: `${purpose ?? 'HARVEST'} harvest on ${stateKey}`,
        // Design 76 Gap B — attribute the gain to the harvested account's owner.
        stateKey,
      }],
    );
  }
}
