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
 * The flat Australian superannuation fund tax rate (ITAA 1997 Div 295): 15% on
 * concessional contributions received and on the fund's taxable earnings while
 * the member's interest is in **accumulation** phase.
 *
 * Deliberately a leaf module with no imports. Design 77 made this rate visible to
 * three call sites that must agree on it — the earnings handler (which now credits
 * growth NET of the tax), the contribution apply reducer (which credits the
 * contribution net), and the year-versioned tax modules' classifiers (which record
 * the tax into `auSuperTaxYTD` / `auPersonSuperTaxYTD`). Before that it was a
 * private constant in `au-tax-module-2026.js`, which is where it would have had to
 * be duplicated.
 *
 * NOT modelled here, and each is a real Div 295 wrinkle:
 *   - **Div 293** — an ADDITIONAL 15% on concessional contributions for members
 *     whose income + concessional contributions exceed $250,000. Unlike the tax
 *     below, Div 293 IS personally assessed on the member (it appears on their
 *     notice of assessment), though it may be released from super to pay it. If it
 *     is ever modelled it does NOT belong in this constant — it is the member's own
 *     liability, not the fund's.
 *   - **Transfer balance cap** — the pension-phase 0% rate applies only to the
 *     portion supporting a retirement-phase income stream. See §4.2 of design 77.
 *   - **Franking credits / CGT discount inside the fund** — the fund's own offsets,
 *     which make the *effective* rate on fund earnings lower than 15%.
 */
export const SUPER_TAX_RATE = 0.15;

/**
 * Fund tax rate on earnings for a member of the given age.
 *
 * Age 60 is the model's proxy for "has met a condition of release and commenced a
 * retirement-phase income stream", at which point the fund's earnings on the
 * supporting assets are exempt current pension income (ECPI) and taxed at 0%.
 * See design 77 §4.2 for what this proxy elides (the cap, and the fact that
 * commencing a pension is a choice, not automatic at 60).
 */
export function superEarningsTaxRate(age) {
  return age >= 60 ? 0 : SUPER_TAX_RATE;
}
