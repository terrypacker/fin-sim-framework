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
 * div293.js — design 95 §9.4, phase 8. ITAA97 Division 293.
 *
 * The extra 15% a high earner pays on their concessional super contributions, which
 * halves the concession: contributions taxed at 15% inside the fund are taxed at 15%
 * again on the member, bringing the total to 30% against a 47% top marginal rate.
 *
 * A leaf module with no imports, following `fica-rates.js` and `super-tax-rate.js`:
 * the rate and the threshold are the whole of it, and nothing else in the model
 * should carry a second copy of either.
 *
 * ─── it is the MEMBER'S liability, not the fund's ────────────────────────────
 *
 * s293-15 makes the individual liable. It arrives as its own notice of assessment,
 * separate from their income tax return, and it is theirs to pay — from their own
 * cash, or by releasing money from the fund. That is what separates it from the
 * Div 295 contributions tax in `super-tax-rate.js`, which the FUND owes and withholds
 * from the contribution on receipt. That file's comment says so already: *"If it is
 * ever modelled it does NOT belong in this constant."*
 *
 * ─── the "lesser of" is the whole subtlety ───────────────────────────────────
 *
 * s293-20(1): taxable contributions are the **lesser of** the low tax contributions
 * and the amount by which (income for surcharge purposes + low tax contributions)
 * exceeds \$250,000. A naive `15% x concessional_contributions` for anyone over the
 * threshold overstates it, sometimes enormously — someone \$1 over pays 15c, not
 * \$4,875. The provision phases in over exactly one cap's width of income, and the
 * marginal effect at the bottom of that band is what makes salary sacrifice near the
 * threshold a genuinely finely balanced decision rather than an obvious one.
 *
 * ─── \$250,000 is a LITERAL, and it is no longer the SG base ──────────────────
 *
 * s293-20(1) writes \$250,000 into the statute. It is not indexed, and it must not be
 * derived: through 2025-26 it happened to equal the SGAA s10A(5) maximum
 * contributions base, and from 1 July 2026 the two differ by \$20,830 because the base
 * moves with the indexed concessional cap and this does not. See `au-super-limits.js`.
 *
 * ─── sources, on disk ────────────────────────────────────────────────────────
 *
 *   - `docs/au-tax/ITAA-1997/C2026C00324VOL06.txt` — s293-15, s293-20, s293-25, s293-30
 *   - `docs/au-tax/ITAA-1997/C2026C00324VOL10.txt` — the "income for surcharge
 *     purposes" definition in the s995-1 dictionary
 *   - `docs/au-tax/SGAA-1992/Super-Sustaining-Contribution-Concession-Imposition-Act-2013.txt`
 *     — s5: *"The amount of the tax is 15% of a person's taxable contributions for an
 *     income year."*
 */

/** s293-20(1). A literal in the statute — never indexed, never derived. */
export const DIV293_THRESHOLD_AUD = 250_000;

/** Imposition Act s5. */
export const DIV293_RATE = 0.15;

/**
 * s293-20 + s293-25 — the Division 293 liability for one person for one year.
 *
 * ─── what goes in limb (a), and what deliberately does not ───────────────────
 *
 * "Income for surcharge purposes" is defined in s995-1 as taxable income plus
 * reportable fringe benefits, plus reportable superannuation contributions, plus
 * total net investment loss. **s293-20(1)(a) then disregards the reportable
 * superannuation contributions limb**, and that exclusion is not a rounding of the
 * rule — it is what stops the provision counting the same dollar twice, since a
 * salary-sacrificed contribution is a reportable super contribution AND a low tax
 * contribution under limb (b).
 *
 * The effect is elegant and worth seeing: a member who sacrifices has a smaller
 * taxable income in limb (a) and a larger figure in limb (b), and the sum is roughly
 * what they would have had without sacrificing at all. Div 293 cannot be avoided by
 * sacrificing into super, which is precisely the design of it.
 *
 * This model carries no fringe benefits and no total-net-investment-loss concept
 * (the Div 36 pool is a different quantity — a carried-forward tax loss, not an
 * added-back current-year investment loss), so income for surcharge purposes here IS
 * taxable income. Both omissions push the figure DOWN, i.e. toward under-charging,
 * which is the conservative direction for a tax the model is introducing.
 *
 * ─── limb (b): low tax contributions ─────────────────────────────────────────
 *
 * s293-25: the low tax contributed amounts (s293-30 — contributions included in the
 * fund's assessable income, i.e. the concessional ones) LESS any excess concessional
 * contributions. Design 95 phase 7 clamps contributions at the Div 291 cap, so excess
 * concessional contributions are structurally zero in this model and the subtraction
 * is inert — but the parameter is real and is taken, so that a future phase which
 * models the excess regime instead of clamping does not have to find this line.
 *
 * Non-concessional contributions are NOT low tax contributed amounts: they are paid
 * from taxed money and never enter the fund's assessable income (s293-30(2)(b)). A
 * model that swept all contributions into this figure would tax them a second time
 * for no reason.
 *
 * @param {object} o
 * @param {number} o.taxableIncome           the person's taxable income for the year
 * @param {number} o.concessionalContributions  low tax contributed amounts (s293-30)
 * @param {number} [o.excessConcessional=0]  s293-25(b); zero while phase 7 clamps
 * @returns {{ tax: number, taxableContributions: number, lowTaxContributions: number,
 *             incomeForSurchargePurposes: number, excessOverThreshold: number,
 *             binding: ?string }}
 */
export function div293({ taxableIncome = 0, concessionalContributions = 0,
                         excessConcessional = 0 } = {}) {
  const isp     = Math.max(0, taxableIncome);
  const lowTax  = Math.max(0, concessionalContributions - Math.max(0, excessConcessional));
  const excess  = Math.max(0, isp + lowTax - DIV293_THRESHOLD_AUD);

  const nil = { tax: 0, taxableContributions: 0, lowTaxContributions: lowTax,
                incomeForSurchargePurposes: isp, excessOverThreshold: excess,
                binding: null };

  // s293-20(2) — an explicit carve-out, and not merely an optimisation: without any
  // low tax contributions there is nothing for the tax to attach to, however high
  // the income.
  if (!(lowTax > 0)) return nil;
  if (!(excess > 0)) return nil;

  // s293-20(1) — the lesser of the two. `binding` names which, because they mean
  // very different things: EXCESS means the member is inside the phase-in band and a
  // dollar more income costs 15c more tax, while CONTRIBUTIONS means they are past it
  // and every concessional dollar is taxed at the full extra 15%.
  const taxableContributions = Math.min(lowTax, excess);
  return {
    tax: +(taxableContributions * DIV293_RATE).toFixed(2),
    taxableContributions,
    lowTaxContributions: lowTax,
    incomeForSurchargePurposes: isp,
    excessOverThreshold: excess,
    binding: excess < lowTax ? 'EXCESS' : 'CONTRIBUTIONS',
  };
}
