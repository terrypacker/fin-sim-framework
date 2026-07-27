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
 * golden-specs.js — the registry of golden scenarios.
 *
 * One entry per golden. Each is a full end-to-end run of the International
 * Retirement scenario whose ENTIRE final state is pinned to a committed fixture
 * (see golden-harness.js for why a fixture rather than a scalar band).
 *
 * ── Why more than one ────────────────────────────────────────────────────────
 *
 * Measured 2026-08-07: the single pre-existing golden fired 45 of the 147 action
 * types wired into its own compiled config — 31%. The 102 dead ones were not
 * obscure corners; they included the whole loan/mortgage path (design 54/86),
 * §988 currency pools (87), rebalancing and bond ladders, US state tax and the
 * residency-change path, year-of-death settlement (68), RMDs, Roth conversions,
 * house sales (83 G7), AU rental income and economic regimes.
 *
 * Adding features without adding goldens is how that happened, so the coverage
 * gate (golden-coverage-gate.test.mjs) now fails when a new action type appears
 * in the codebase without being either exercised here or explicitly waived in
 * golden-coverage-manifest.js.
 *
 * ── House style for a new golden ─────────────────────────────────────────────
 *
 *  - SHORT. Exercising a feature needs a few years, not forty. The reference
 *    golden is long because its subject IS a long cross-border retirement; a
 *    feature golden should run the minimum span that reaches its own events.
 *    Budget: 8y ≈ 130ms, 24y ≈ 330ms, 44y ≈ 570ms, against a ~40s suite.
 *  - FOCUSED, but not artificial. Group features that genuinely co-occur in a
 *    plan (loans WITH property, death WITH survivor benefits) so the golden
 *    tests interaction, which is what unit tests already cannot see.
 *  - Some features are mutually exclusive by construction — a person cannot be
 *    both a US and an AU resident in the same year, a house cannot be both sold
 *    and held. Those belong in separate goldens; do not contort one scenario to
 *    reach both branches.
 *  - Say in `description` WHICH designs the golden is protecting. That is what a
 *    future reader needs when a fixture diff lands on their desk.
 */

/** @type {import('./golden-harness.js').GoldenSpec[]} */
export const GOLDEN_SPECS = [
  {
    name:        'cross-border-reference',
    description:
      'The default US→AU retiree, 2026-2050 (moveYear 2031). The original design-52 '
      + 'lock-in: real §904 FTC + FITO relief, AU CGT reform (57), NIIT (§1411), '
      + 'bond coupons and maturity (66), per-person AU attribution (76), super fund '
      + 'tax (77) and the Art. 22(4) non-erosion rule (83 G5). Long by design — its '
      + 'subject is a lifetime cross-border plan, and the FTC carryforward pools it '
      + 'guards only misbehave over a decade-plus horizon.',
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2050, 0, 1)),
  },
];

/** Look up a spec by name (throws rather than silently running nothing). */
export function specByName(name) {
  const spec = GOLDEN_SPECS.find(s => s.name === name);
  if (!spec) throw new Error(`no golden spec named '${name}'`);
  return spec;
}
