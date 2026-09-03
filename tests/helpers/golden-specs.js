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

import { Holding }      from '../../src/finance/holdings/holding.js';
import { ACCOUNT_ROLES } from '../../src/finance/state/account-roles.js';
import { ALLOCATION } from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }  from '../../src/finance/economic-regimes/rate-keys.js';
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
    name:        'payroll-limits',
    description:
      'Design 95 phase 3. The reference goldens defer 10% with a 4% match on a '
      + '\$120,000 salary, which clears EVERY statutory limit by a wide margin — so '
      + 'before this golden the whole of §401(a)(17), §402(g), §414(v) and §415(c) '
      + 'was scenario-unguarded and a green suite said nothing about any of it. '
      + 'This one puts a high earner in the plan and makes the limits bind: pay above '
      + 'the §401(a)(17) compensation cap so both the deferral and the match are '
      + 'computed on capped pay, a deferral rate that exhausts §402(g) partway '
      + 'through each year, and a non-elective employer contribution large enough '
      + 'that the three streams together reach §415(c). It also runs the earner '
      + 'through the §414(v) catch-up boundaries — the plan starts at 48 and the run '
      + 'crosses 50 and 60, so the ordinary and the SECURE 2.0 age-60-to-63 amounts '
      + 'both take effect inside the fixture. Paired with k401-limits.test.mjs, which '
      + 'asserts each limit in isolation; this holds them interacting, and holds the '
      + 'YTD accumulator resetting correctly at each year boundary — the defect that '
      + 'strangled every contribution when phase 3 first ran without a reset.',
    params: {
      primaryMonthlyWage:      40_000,   // \$480,000/yr — above the §401(a)(17) cap
      k401DeferralPct:            0.25,  // exhausts §402(g) inside each year
      k401EmployerMatchPct:       0.05,
      k401NonElectivePct:         0.12,  // pushes the three streams into §415(c)
      k401AnnualCap:              null,  // let the STATUTE bind, not an authored cap
      iraAnnualContribution:         0,
      rothAnnualContribution:        0,
      primaryBirthDate:  new Date(Date.UTC(1978, 3, 15)),
      primaryRetirementDate: new Date(Date.UTC(2044, 0, 1)),
    },
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2032, 0, 1)),
  },
  {
    name:        'bond-par-conservation',
    description:
      'Design 93 §7. The golden that the eight par defects of design 66 §10.6b could '
      + 'not have survived. Every one of them was invisible to a green suite for one '
      + 'reason: the default scenario\'s bonds are perpetual FUNDS, which carry no '
      + '`faceValue`, so no par-handling path can reach them. This golden puts '
      + 'INSTRUMENTS in the book — a rolling multi-account ladder of dated rungs — and '
      + 'then drives the three path families that corrupted par: a '
      + 'Roth CONVERSION depositing into an account that holds rungs (the unit-change '
      + 'path, defect 1), a TARGET_ALLOCATION rebalance selling and buying across them '
      + '(defects 5-7), and coupon/dividend reinvestment (defect 8). Short on purpose: '
      + 'eight years is two full rolls of a four-rung ladder. Paired with '
      + 'bond-par-conservation.test.mjs, which asserts the invariant directly rather '
      + 'than only pinning the end state. Deliberately NOMINAL throughout: its '
      + 'inflation-linked twin is `tips-ladder-conservation`, which differs from it in '
      + 'exactly two parameters, so a diff between the pair isolates the instrument '
      + 'rather than the plan.',
    params: {
      behavioralStrategies:      ['BOND_LADDER', 'TARGET_ALLOCATION'],
      allocationStrategy:        'STATIC',
      allocationSchedule:        'STATIC',
      rebalanceTargetAllocation: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 },
      // 'ALL', not the default single role — the resolution bug that left the ladder
      // inert in a real plan was invisible precisely because one account still laddered.
      // TWO accounts laddered, so the single-account resolution bug cannot hide here —
      // it stayed invisible in a real plan precisely because one account still laddered.
      // The taxable brokerage is deliberately left OUT, because a ladder materialisation
      // replaces every bond holding in its account and the brokerage has to keep both a
      // perpetual FUND and the TIPS rung below.
      bondLadderRole:            ['k401', 'ira'],

      bondLadderRungs:           4,
      bondLadderSpacingYears:    1,
      bondLadderRoll:            true,
      // The conversion is the deposit path that froze par against a doubled market
      // value. Cleared schedule so the bracket form is the live one (design 66 §10.4
      // documents that trap).
      rothConversionEnabled:     true,
      rothConversionSchedule:    [],
      // 24%, not 12%: at the lower ceiling the household's ordinary income already
      // fills the bracket and the policy converts nothing at all.
      rothConversionMaxBracket:  0.24,
      rothConversionOwner:       'both',
      rothConversionStartYear:   2028,
      rothConversionEndYear:     2032,
    },
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2034, 0, 1)),
    mutateCfg: (cfg) => {
      // The IRA starts empty in the default scenario, which would leave both the ladder
      // and the conversion with nothing to act on. Set on the account, not via the
      // `iraBalance` MC alias, which does not resolve through a golden's `params`.
      const ira = cfg.accounts.find(a => a.stateKey === 'iraAccount');
      ira.balance = 300000;
    },
  },
  {
    name:        'tips-ladder-conservation',
    description:
      'Design 93 §5.3 and §5b. The inflation-linked twin of `bond-par-conservation`: the '
      + 'SAME plan, differing in exactly two parameters (`bondLadderInflationLinked`, and '
      + 'a pinned REAL coupon), so a diff between the pair isolates the instrument rather '
      + 'than the household. It exists because a TIPS is the one instrument where '
      + '`faceValue` does not mean "what this redeems for" — it is the ORIGINAL issue par, '
      + 'held only as the Treasury deflation floor, while the indexed principal lives '
      + 'elsewhere. That overload was defect #8, and scaling the floor by a value ratio was '
      + 'defect #4, the ratchet that reached 1e+63. §7 could not hold one because accretion '
      + 'lived inside `marketValue` with nothing to observe; §5b gives it an explicit '
      + '`cpiIndexRatio`, and this golden is what puts the whole path under CI rather than '
      + 'under unit tests alone: CPI accretion stepping the ratio, the price following the '
      + 'principal while the floor stands still, redemption reading the ratio instead of a '
      + 'price polluted by rate marks TIPS never wash out, and a roll re-issuing at the '
      + 'principal it just repaid with its indexation restarted.',
    params: {
      behavioralStrategies:      ['BOND_LADDER', 'TARGET_ALLOCATION'],
      allocationStrategy:        'STATIC',
      allocationSchedule:        'STATIC',
      rebalanceTargetAllocation: { EQUITY: 0.6, BOND: 0.4, CASH: 0, GOLD: 0 },
      bondLadderRole:            ['k401', 'ira'],
      bondLadderRungs:           4,
      bondLadderSpacingYears:    1,
      bondLadderRoll:            true,
      // The two parameters that make this golden different from its twin. The coupon is
      // PINNED to a real yield: the engine models a nominal curve only (design 67), so
      // stamping the market anchor on a principal that also indexes to CPI would pay for
      // inflation twice.
      bondLadderInflationLinked: true,
      bondLadderCouponRate:      0.01,
      rothConversionEnabled:     true,
      rothConversionSchedule:    [],
      rothConversionMaxBracket:  0.24,
      rothConversionOwner:       'both',
      rothConversionStartYear:   2028,
      rothConversionEndYear:     2032,
    },
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2034, 0, 1)),
    mutateCfg: (cfg) => {
      const ira = cfg.accounts.find(a => a.stateKey === 'iraAccount');
      ira.balance = 300000;
    },
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
  {
    name:        'au-super-streams',
    cls:         AuSingleHomeownerScenario,
    description:
      'Design 95 §9.1 phase 6b. Every other AU golden contributes to super one way '
      + 'only — the employer Super Guarantee — so the three MEMBER streams were '
      + 'scenario-unguarded on arrival, and the three ways they differ from the SG '
      + 'and from each other were visible to unit tests alone. This runs all four at '
      + 'once on one earner, which is the only configuration where the differences '
      + 'are observable as arithmetic rather than as assertions: salary sacrifice '
      + 'reduces the wage at source (less cash, less assessable income, 15% Div 295 '
      + 'in the fund) while leaving the SG computed on PRE-sacrifice pay, s290-150 '
      + 'pays out of after-tax cash and takes the deduction back on the return a year '
      + 'later, and the non-concessional stream pays out of after-tax cash and '
      + 'reaches the fund IN FULL with no Div 295 at all. Four streams into one fund, '
      + 'so the fixture also pins that they credit ONE balance record rather than '
      + 'four. Short on purpose: seven years is enough to cross the AU financial-year '
      + 'boundary six times, which is what the s290-150 deduction (available only in '
      + 'the year the contribution is made) and its FY reset actually turn on. '
      + 'Deliberately does NOT test the caps — Div 291, Div 292 and the s10A(5) '
      + 'contributions base arrive in phase 7, and this fixture will move when they '
      + 'do.',
    params: {
      // 5% sacrifice on A\$150,000, so both the sacrifice and its effect on the wage
      // are large enough to read in the fixture rather than lost in rounding.
      superSalarySacrificePct:              0.05,
      superPersonalDeductibleContribution: 8_000,
      superNonConcessionalContribution:   12_000,
      primaryMonthlyWage:                 12_500,
      // Working throughout, so every year of the fixture runs all four streams.
      primaryRetirementDate: new Date(Date.UTC(2044, 0, 1)),
    },
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2033, 0, 1)),
  },
  {
    name:        'two-security-concentration',
    description:
      'Design 94 §11, step 5. Every per-security path in the engine was UNREACHABLE from '
      + 'the fixtures until this golden: the other ten hold nothing but the four synthetic '
      + 'market securities, which are the identity (\u03b2 = 1, \u03c3_idio = 0) by construction, so '
      + 'the whole of §6.2\'s price path evaluated to zero and a green suite said nothing '
      + 'about it. This one authors two real instruments and puts them in the book. '
      + '`sec-emp` is a CONCENTRATED position — \u03b2 1.35 with 35% idiosyncratic vol, so it '
      + 'takes its own annual draw and its price genuinely separates from its sleeve\'s — '
      + 'and it is held in TWO accounts, a taxable brokerage and a 401(k), which is what '
      + 'makes §4\'s no-shared-price decision observable rather than theoretical: one '
      + 'security, two positions, two bases, two prices, and each priced off its own '
      + 'account\'s design 55 §8 rate. `sec-exus` is the other branch — \u03b2 0.90 with NO '
      + 'idiosyncratic vol, which overlays without consuming a uniform. It also carries a '
      + 'security-level `dividendYield`, so the fixture holds the instrument winning over '
      + 'the lot\'s inline value (§12 D11) rather than only the return process. The AU '
      + 'stock lot is deliberately left on its synthetic market security, so one fixture '
      + 'holds both the migrated and the authored representation side by side. '
      + 'STOCHASTIC ON, which no other golden is: the equity path is the subject here, and '
      + 'that makes this fixture the tripwire for RNG-cursor order — a change to the DRAW '
      + 'SEQUENCE re-bases it and nothing else in the repo. Short (8y), and it still '
      + 'crosses the 2031 move, so it also pins that a residency change does not disturb '
      + 'what a position is held IN.',
    params: {
      // The subject. Sleeve idio vol stays 0, so every uniform the run draws beyond the
      // single market factor is drawn BY A SECURITY — which is what makes the cursor
      // assertion in security-positions.test.mjs legible.
      equityReturnStochastic: true,
      equityReturnVol:        0.18,
      // Design 94 step 6. The rebalancer is here for ONE reason: the two accounts give it
      // the two cases D10 distinguishes, in the same run. `usStockAccount`'s equity sleeve
      // holds two securities, so a buy there is a MIXED sleeve and must establish the
      // generic market position; `k401Account`'s holds one, so a buy there must buy more of
      // THAT security. Without a target mix neither branch is reachable from any fixture.
      behavioralStrategies:      ['TARGET_ALLOCATION'],
      allocationStrategy:        'STATIC',
      allocationSchedule:        'STATIC',
      rebalanceTargetAllocation: { EQUITY: 0.7, BOND: 0.3, CASH: 0, GOLD: 0 },
    },
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2034, 0, 1)),
    mutateCfg: (cfg) => {
      cfg.securities = [
        {
          id: 'sec-emp', symbol: 'EMP', name: 'Employer stock (concentrated)',
          rateKey: 'EQUITY_US',
          beta: 1.35, idioVol: 0.35,
          // Instrument-level, and LOWER than the account-level fallback the handler
          // supplies — so a fixture diff shows the security winning the §12 D11 chain
          // rather than the two agreeing by luck.
          dividendYield: 0.006, qualifiedDividends: true,
        },
        {
          id: 'sec-exus', symbol: 'EXUS', name: 'International index fund',
          rateKey: 'EQUITY_INTL_EX_US',
          // Beta only: overlays the growth rate every year, consumes no uniform ever.
          beta: 0.90, idioVol: 0,
        },
      ];
      const lot = (stateKey, id) =>
        cfg.accounts.find(a => a.stateKey === stateKey).holdings.find(h => h.id === id);
      // ONE security, TWO accounts — the point of the golden.
      lot('usStockAccount', 'h-us-equity').securityId   = 'sec-emp';
      lot('k401Account',    'h-401k-equity').securityId = 'sec-emp';
      lot('usStockAccount', 'h-intl-equity').securityId = 'sec-exus';
    },
  },
  {
    name:        'wash-sale-harvest',
    description:
      'Design 94 §8.1o. The whole §1091 path — both reducers that write '
      + '`washPendingLosses`, the April `TAX_FILE_US` that resolves it, and the balance due '
      + 'it assesses — had NO whole-state coverage at all: `washPendingLosses` and '
      + '`washSaleLedger` appeared in no fixture, so a defect anywhere in it shipped green '
      + 'through the repo\'s strongest gate, and one did (§8.1o\'s double-match). Three '
      + 'things had to be true at once before a fixture could reach it, which is why no '
      + 'existing golden does. The plan must HARVEST, so TAX_LOSS_HARVEST is on. It must '
      + 'have a LOSS to harvest, so a 2029 crash puts the book under water. And the '
      + 'replacement must be substantially identical AND land in a wrapper the cited '
      + 'authority reaches (Rev. Rul. 2008-5: IRA and Roth only), so the taxable brokerage, '
      + 'the IRA and the Roth all hold `sec-core` while the harvester rotates into '
      + '`sec-alt` — two authored securities in one market, which is the only way a book '
      + 'can express "economically similar, legally distinct" (§8.1c) and therefore the '
      + 'only way it can also express the opposite. What the run then contains: the '
      + 'REBALANCER writing entries as it relocates equity into the wrappers (§8.1n) and '
      + 'the HARVESTER writing them at year-end (§8.1i), a filing that disallows and '
      + 'assesses a real balance due paid the following April, three more filings that '
      + 'correctly disallow NOTHING (the un-matched entry retires, the snapshot is still '
      + 'retired, no payment is chained), and an entry still pending at simEnd because its '
      + 'return has not been filed yet. Paired with wash-sale-golden.test.mjs, which '
      + 'asserts those facts directly — the fixture pins them, but only that test says '
      + 'which of them is the point. It does NOT reach §8.1o\'s share-consumption rule: '
      + 'the two same-group entries it puts in one filing compete for a pool only one of '
      + 'them can draw on, so the fixture is identical with and without that fix. '
      + 'wash-sale.test.mjs is the detector for it.',
    params: {
      behavioralStrategies:      ['TAX_LOSS_HARVEST', 'TARGET_ALLOCATION'],
      allocationStrategy:        'STATIC',
      // GLIDEPATH, not STATIC: a static mix relocates once and then sits still, and a
      // rebalancer that never trades again writes no §1091 entry after year one. A moving
      // target keeps equity crossing the taxable/wrapper boundary every year, which is the
      // §8.1n fact pattern — and it is what a real de-risking plan does anyway.
      allocationSchedule:        'GLIDEPATH',
      allocationGlidepath: [
        { age: 62, weights: { EQUITY: 0.45, BOND: 0.55, CASH: 0, GOLD: 0 } },
        { age: 72, weights: { EQUITY: 0.75, BOND: 0.25, CASH: 0, GOLD: 0 } },
      ],
      // The GLIDEPATH fallback if the anchors ever stop bracketing the run's ages.
      rebalanceTargetAllocation: { EQUITY: 0.7, BOND: 0.3, CASH: 0, GOLD: 0 },
      // The loss. Without a shock the book only ever appreciates, the harvester finds
      // nothing to sell, and every §1091 path in the engine stays unreachable — which is
      // exactly the state the other ten goldens are in.
      shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2029-06-01' }],
      // Big enough that the Roth holds BOTH classes: a wrapper already at 100% equity is
      // pinned, never buys, and so can never be anyone's replacement.
      rothBalance: 900_000,
    },
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2033, 0, 1)),
    mutateCfg: (cfg) => {
      // Two securities in ONE market, in different identity groups. `resolveSubstitute`
      // prefers a legally distinct partner (§8.1h), so this is also what stops the
      // harvester constructing the wash itself — the disallowance in this fixture comes
      // from the WRAPPER buying, which no substitute choice can avoid.
      cfg.securities = [
        { id: 'sec-core', symbol: 'CORE', name: 'US total market (core)',
          rateKey: 'EQUITY_US', beta: 1, idioVol: 0 },
        { id: 'sec-alt',  symbol: 'ALT',  name: 'US large cap (alternate index)',
          rateKey: 'EQUITY_US', beta: 1, idioVol: 0 },
      ];
      const acct = key => cfg.accounts.find(a => a.stateKey === key);
      acct('usStockAccount').holdings.find(h => h.id === 'h-us-equity').securityId = 'sec-core';
      // The two covered wrappers, each holding `sec-core` and a bond sleeve to fund a buy
      // of it. `_shelteredReplacements` reads a lot's `purchaseDate`, and a rebalance buy
      // establishes a fresh dated lot inheriting the sleeve's security — so a wrapper that
      // holds this security is the only kind that can produce a dated replacement at all.
      acct('iraAccount').balance  = 300_000;
      acct('iraAccount').holdings = [
        new Holding({ id: 'h-ira-equity', label: 'IRA Equity', allocation: ALLOCATION.EQUITY,
          rateKey: RATE_KEYS.EQUITY_US, marketValue: 150_000, costBasis: 150_000,
          securityId: 'sec-core' }),
        new Holding({ id: 'h-ira-bond', label: 'IRA Bond', allocation: ALLOCATION.BOND,
          rateKey: RATE_KEYS.FIXED_INCOME_US, marketValue: 150_000, costBasis: 150_000 }),
      ];
      acct('rothAccount').holdings = [
        new Holding({ id: 'h-roth-equity', label: 'Roth Equity', allocation: ALLOCATION.EQUITY,
          rateKey: RATE_KEYS.EQUITY_US, marketValue: 300_000, costBasis: 300_000,
          securityId: 'sec-core' }),
        new Holding({ id: 'h-roth-bond', label: 'Roth Bond', allocation: ALLOCATION.BOND,
          rateKey: RATE_KEYS.FIXED_INCOME_US, marketValue: 600_000, costBasis: 600_000 }),
      ];
    },
  },
  {
    name:        'wash-sale-two-books',
    description:
      'Design 94 §8.1p — the §1091(d) TWIN of `wash-sale-harvest`, and the other half of the '
      + 'rule. Where that golden matches a loss against an IRA/Roth and Rev. Rul. 2008-5 '
      + 'DESTROYS it, this one matches against a taxable brokerage, where §1091(d) moves the '
      + 'loss into the replacement\'s BASIS and §1223(3) tacks the sold shares\' holding '
      + 'period onto it — disallowed today, recovered on the eventual sale. Same plan, same '
      + 'crash, same two securities; the only difference is one added account, so a diff '
      + 'between the pair isolates the CONSEQUENCE rather than the household. The added '
      + 'account is a second US brokerage seeded with the OTHER security, and that is the '
      + 'whole mechanism: `resolveSubstitute` rotates each book into a legally distinct '
      + 'partner (§8.1h), so on 31 December one book sells `sec-core` and buys `sec-alt` '
      + 'while the other sells `sec-alt` and buys `sec-core` — each rebuy is the other '
      + 'sale\'s substantially identical replacement, on the same day, in a taxable account. '
      + 'Two harvesters rotating past each other is not a contrivance: it is what a '
      + 'household with two brokerage accounts and one harvesting policy does every year, '
      + 'and it is the fact pattern §8.1j named and held. The fixture holds the basis '
      + 'transfers themselves — a matched lot bifurcated at `-1091` with the disallowed loss '
      + 'added to its basis and its purchase date back-dated — plus a filing that both '
      + 'defers the loss AND assesses a balance due, because §1091(a) removes the deduction '
      + 'whichever account bought the replacement. Paired with wash-sale-golden.test.mjs.',
    params: {
      // Identical to `wash-sale-harvest`; see it for why each of these is load-bearing.
      behavioralStrategies:      ['TAX_LOSS_HARVEST', 'TARGET_ALLOCATION'],
      allocationStrategy:        'STATIC',
      allocationSchedule:        'GLIDEPATH',
      allocationGlidepath: [
        { age: 62, weights: { EQUITY: 0.45, BOND: 0.55, CASH: 0, GOLD: 0 } },
        { age: 72, weights: { EQUITY: 0.75, BOND: 0.25, CASH: 0, GOLD: 0 } },
      ],
      rebalanceTargetAllocation: { EQUITY: 0.7, BOND: 0.3, CASH: 0, GOLD: 0 },
      shocks: [{ preset: 'MARKET_CRASH_2008_LITE', startDate: '2029-06-01' }],
      rothBalance: 900_000,
    },
    simStart: new Date(Date.UTC(2026, 0, 1)),
    simEnd:   new Date(Date.UTC(2033, 0, 1)),
    mutateCfg: (cfg) => {
      specByName('wash-sale-harvest').mutateCfg(cfg);
      // The second taxable book, holding the OTHER security. Drawn down late (priority 6) so
      // it is still there to harvest in the crash years — a book spent before the crash
      // cannot be anyone's replacement.
      cfg.accounts.push({
        __type: 'BrokerageAccount', stateKey: 'spouseStockAccount',
        name: 'US Stock (spouse)', role: ACCOUNT_ROLES.US_STOCK,
        balance: 500_000, contributionBasis: 500_000,
        ownerId: 'spouse', drawdownPriority: 6,
        country: 'US', currency: { code: 'USD' },
        holdings: [new Holding({
          id: 'h-spouse-equity', label: 'Spouse Equity', allocation: ALLOCATION.EQUITY,
          rateKey: RATE_KEYS.EQUITY_US, marketValue: 500_000, costBasis: 500_000,
          securityId: 'sec-alt',
        })],
      });
    },
  },
];

/** Look up a spec by name (throws rather than silently running nothing). */
export function specByName(name) {
  const spec = GOLDEN_SPECS.find(s => s.name === name);
  if (!spec) throw new Error(`no golden spec named '${name}'`);
  return spec;
}
