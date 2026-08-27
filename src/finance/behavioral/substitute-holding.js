/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { instrumentOf }     from '../holdings/holding-utils.js';
import { identityGroupOf }  from '../holdings/security.js';

/**
 * Resolve the substitute holding id for a tax-loss harvest (design/29 §3.3 Q1).
 *
 * Algorithm:
 *   1. If `soldHolding.taxLossPartner` is set → use it (explicit pair)
 *   2. Else the first OTHER holding in the account with the same `rateKey` but a DIFFERENT
 *      §1091 identity group — a replacement that is economically similar and legally
 *      distinct, which is what step 2 always CLAIMED to be (design 94 §8.1h)
 *   3. Else the first OTHER holding with the same `rateKey`, identical or not — today's
 *      behaviour, preserved so an un-securitised book harvests exactly as it did
 *   4. Else return null (caller skips the harvest, records it, and warns)
 *
 * This was documented as modelling wash-sale avoidance — "the rebuy is a different security
 * by construction (or the same rateKey = economically similar but legally distinct)". That
 * claim did not survive design 94 R1 and is corrected below.
 *
 * ⚠️ **The old step 2 WAS the wash sale, not a way around it** (design 94 §8.1a). Two lots
 * sharing a `rateKey` are the same MARKET in the model's own terms, and design 90 §1.3 calls
 * selling one and rebuying the other "a wash sale wearing a disguise". Worse, the engine's
 * cadence fires `TAX_LOSS_HARVEST` on 31 December and every rebalancer on 1 January, one day
 * inside §1091's 61-day window, every year.
 *
 * The new step 2 is the fix, and it is the cheapest possible one: **prefer a partner in a
 * different identity group.** The model stops CONSTRUCTING the disallowed pattern rather
 * than learning to price it — and that is worth more than the pricing, because a harvest
 * into a genuinely distinct security is a legal harvest with no disallowance to model at all
 * (design 94 §8.1h). Identity is DECLARED (`Security.identityGroup`, defaulting to the
 * security's own id) because §8.1c is explicit that no source supplies a mechanical test for
 * two funds tracking one index; deriving it from `rateKey` is the same assumption unlabelled.
 *
 * Step 3 exists so this is not a behaviour change for a book that cannot express the
 * distinction. Where every equity lot names the synthetic security for its market — which is
 * every un-securitised scenario — all candidates share one group, there is no better partner,
 * and the old choice is made. What that book gets instead is the honest reading of what it
 * did: the substitute IS substantially identical, and §8.1f's disallowance applies to it.
 *
 * @param {object[]} holdings    - account.holdings (the full holdings array)
 * @param {object}   soldHolding - the holding being sold
 * @param {Object<string,object>|null} [securities] - `state.securities`; absent ⇒ Option A
 * @returns {string|null}        - substitute holding id, or null if none found
 */
export function resolveSubstitute(holdings, soldHolding, securities = null, { requireDistinct = false } = {}) {
  // 1. Explicit partner
  if (soldHolding.taxLossPartner) return soldHolding.taxLossPartner;

  const soldKey = instrumentOf(soldHolding, securities).rateKey;
  if (!soldKey) return null;

  const sameMarket = holdings.filter(
    h => h.id !== soldHolding.id && instrumentOf(h, securities).rateKey === soldKey,
  );
  if (!sameMarket.length) return null;

  // 2. Economically similar, legally DISTINCT — the claim the docstring always made, now
  //    actually enforced. A null group (an un-securitised lot) is not "distinct from
  //    everything": it makes no identity claim at all, so it cannot be relied on here.
  const soldGroup = identityGroupOf(soldHolding, securities);
  if (soldGroup != null) {
    const distinct = sameMarket.find((h) => {
      const g = identityGroupOf(h, securities);
      return g != null && g !== soldGroup;
    });
    if (distinct) return distinct.id;
  }

  // 3. Nothing distinct on offer — take the same partner as before, so a book that cannot
  //    express the distinction behaves exactly as it did. It is a wash sale, and §8.1f is
  //    what prices it. `requireDistinct` lets the caller ask for step 2 only, so it can try
  //    a REGISTRY security (below) before settling for this.
  return requireDistinct ? null : sameMarket[0].id;
}

/**
 * A substitute the account does not hold YET: a SECURITY in the same market, in a different
 * §1091 identity group (design 94 §8.1h).
 *
 * ── why this exists, and why only Option C could provide it ──────────────────
 *
 * `resolveSubstitute` can only offer a lot the account ALREADY holds, and that is what made
 * the harvester a one-shot strategy. R2 measured it: uncap the harvest and the first one
 * consumes the whole underwater lot; the account is then left holding a single equity lot,
 * a single lot has no partner, and **every harvest for the next twenty years is skipped**
 * (4.0 skips per lifetime path, §8.1f). The \$3,000 cap was accidentally propping the
 * strategy up by never selling a whole position — remove the cap without this and realised
 * loss FALLS, which is how this defect was found.
 *
 * A real harvester rotates between two funds: sell A, buy B, and next year sell B and buy A
 * again. The model could not express "buy A again" because A was no longer a holding. It can
 * now, because a lot is a position in a SECURITY and the registry still lists A.
 *
 * Deterministic by sorted id, because the choice must not depend on object insertion order —
 * the same rule the return-path draw set follows (§6.2).
 *
 * @param {object} soldHolding
 * @param {Object<string,object>|null} securities - `state.securities`
 * @returns {string|null} a security id to open a fresh lot in, or null
 */
export function resolveSubstituteSecurity(soldHolding, securities = null) {
  if (!securities) return null;
  const inst      = instrumentOf(soldHolding, securities);
  const soldKey   = inst.rateKey;
  const soldGroup = identityGroupOf(soldHolding, securities);
  if (soldKey == null || soldGroup == null) return null;
  for (const id of Object.keys(securities).sort()) {
    const sec = securities[id];
    if (sec?.rateKey !== soldKey) continue;
    const group = sec.identityGroup ?? sec.id;
    if (group !== soldGroup) return sec.id;
  }
  return null;
}
