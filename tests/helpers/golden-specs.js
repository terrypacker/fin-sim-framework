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

import { UsSingleHomeownerScenario } from '../../src/scenarios/us-single-homeowner-scenario.js';
import { AuSingleHomeownerScenario } from '../../src/scenarios/au-single-homeowner-scenario.js';

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
  {
    name:        'cross-border-disposals',
    description:
      'The disposal family, which no other golden reaches: both houses and the gold '
      + 'collectible sold inside the run, each on a different side of the 2031 move. '
      + 'The US house sells while the household is AU-resident, so one sale is assessed '
      + 'by BOTH returns — §121 proration on the US side, the AU main-residence '
      + 'concession on the other (83 G7), with the AU assessment measured off the '
      + 's855-45 basis. That is also the case design 91 §8 typed: every money field on '
      + 'a US disposal is USD including the `au*` ones, and the AU return converts. '
      + 'Gold carries the 57 indexation path. Before this golden the entire '
      + 'CAPITAL_GAINS family was scenario-unguarded — isolated reducer tests only.',
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2038, 0, 1)),
    mutateCfg: (cfg) => {
      const prop = key => cfg.realProperties.find(p => p.stateKey === key);
      // Post-move: a US-source disposal landing on an AU return (and on a US one).
      prop('usHouseProperty').plannedSaleYear = 2033;
      // Later, so the two sales do not share a tax year and their gains stay legible
      // in the fixture; AU-domiciled, AU-resident, the simple leg of the pair.
      prop('auHouseProperty').plannedSaleYear = 2035;
      // Pre-move, deliberately: a US-resident collectible disposal, so the golden
      // holds the gold path on the side of the move where no AU assessment applies.
      cfg.collectibles[0].plannedSaleYear = 2029;
    },
  },
  {
    name:        'speculative-stake',
    description:
      'Design 88 phase 1 (recognition): the default plan with its private company '
      + 'stake flagged `speculative` and NO planned sale. Pins that the stake still '
      + 'appreciates in state while contributing nothing to netWorth, that '
      + 'netWorthInclSpeculative discloses it, and — the part a scalar assertion '
      + 'cannot see — that flagging one asset moves NOTHING else in the end state. '
      + 'Paired with control arms in speculative-assets.test.mjs.',
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2032, 0, 1)),
    mutateCfg: cfg => { cfg.companyEquities[0].speculative = true; },
  },
  {
    name:        'speculative-conversion',
    description:
      'Design 88 D2/§2: the same speculative stake WITH a plannedSaleYear inside the '
      + 'run. The flag suppresses the carrying value, never the mechanics — so this '
      + 'golden holds the whole COMPANY_SALE → COMPANY_SALE_TAX path firing normally '
      + 'for a stake that was recognised at zero the day before, with the proceeds '
      + 'recognised in full from the instant they land in the destination account.',
    params:   { companySaleYear: 2029 },
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2032, 0, 1)),
    mutateCfg: cfg => { cfg.companyEquities[0].speculative = true; },
  },
  {
    name:        'us-single-homeowner',
    cls:         UsSingleHomeownerScenario,
    description:
      'The second prebuilt scenario, run whole: one US person from age 45 to 85. Its '
      + 'subject is everything the cross-border reference cannot reach — twenty years of '
      + 'WAGES funding payroll contributions (401(k) deferral, employer match, IRA and '
      + 'Roth), a mortgaged primary residence amortising a linked Loan to discharge in its '
      + 'maturity year (54, 86), Nebraska STATE income tax every year plus its inheritance '
      + 'tax on the age-55 bequest (34, 63), the 401(k)-to-IRA rollover at retirement, and '
      + 'IRA RMDs from 73. It is also the only golden holding a non-gold collectible, the '
      + 'other branch of the 28%-rate / AU-indexation split (57, 91 §8.10), and the only '
      + 'one where a single filer is single for the whole run rather than only its first '
      + 'tax year.',
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2066, 0, 1)),
  },
  {
    name:        'au-single-homeowner',
    cls:         AuSingleHomeownerScenario,
    description:
      'The US single homeowner\'s Australian twin — same person, same age, same '
      + 'salary, same house, all in AUD — so the pair isolates the two tax systems '
      + 'rather than two different people. Holds what only an AU-resident plan '
      + 'reaches: the employer Super Guarantee and the fund\'s Div 295 contributions '
      + 'tax, super decumulation after preservation age, a VARIABLE-rate mortgage '
      + 'tracking RBA cash + spread rather than a fixed coupon (56 Phase 3), franked '
      + 'resident dividends, and the AU CGT discount on a drawn-down AU brokerage. '
      + 'The classic car sells in 2040: the only AU-resident disposal of a TRUE '
      + '(non-gold) collectible anywhere in the suite, which is the un-indexed branch '
      + 'of design 57 Part 2 Q3. It is also the first scenario with no US person in '
      + 'it, and therefore the one that guards the `usPersonHousehold` gate — without '
      + 'which the US module taxes an Australian\'s Australian salary.',
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2066, 0, 1)),
  },
];

/** Look up a spec by name (throws rather than silently running nothing). */
export function specByName(name) {
  const spec = GOLDEN_SPECS.find(s => s.name === name);
  if (!spec) throw new Error(`no golden spec named '${name}'`);
  return spec;
}
