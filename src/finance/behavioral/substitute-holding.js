/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Resolve the substitute holding id for a tax-loss harvest (design/29 §3.3 Q1).
 *
 * Algorithm:
 *   1. If `soldHolding.taxLossPartner` is set → use it (explicit pair)
 *   2. Else find the first OTHER holding in the account with the same `rateKey`
 *   3. Else return null (caller skips the harvest and warns)
 *
 * The substitute mechanic also models wash-sale avoidance: the rebuy is a
 * different security by construction (or the same rateKey = economically
 * similar but legally distinct). The precise 30-day window is out of scope.
 *
 * @param {object[]} holdings    - account.holdings (the full holdings array)
 * @param {object}   soldHolding - the holding being sold
 * @returns {string|null}        - substitute holding id, or null if none found
 */
export function resolveSubstitute(holdings, soldHolding) {
  // 1. Explicit partner
  if (soldHolding.taxLossPartner) return soldHolding.taxLossPartner;

  // 2. Same rateKey in the same account (different holding)
  if (soldHolding.rateKey) {
    const partner = holdings.find(
      h => h.id !== soldHolding.id && h.rateKey === soldHolding.rateKey,
    );
    if (partner) return partner.id;
  }

  // 3. No substitute found
  return null;
}
