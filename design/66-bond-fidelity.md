# 66 — Bond fidelity: from a bond-fund proxy to first-class fixed income

**Status**: **PHASES 1–3 IMPLEMENTED** (2026-07-16); **Phase 4 — G5 (TIPS) + G6
(zero-coupon/OID) IMPLEMENTED** (2026-07-16); **G8 (bond ladders) Phases A/B/C
IMPLEMENTED** (2026-07-17) — see §10: Phase A (rollTermYears roll-to-tail + editor
builder), Phase B ladder-aware drawdown (`drawdownLotStrategy: 'LADDER'`, §10.9), and
Phase C (ladder-length optimizer + MPC lever via `BondLadderReducer`, §10.6). Only the
G8 buy-side inflow-aware tail extension (§10.5) + barbells + G9/G10 remain proposed; G7
out of scope (rate-risk only, open-question #5). Scope:
catalog the gaps between how bonds behave in the real world and what the simulation
models today, and lay out a phased plan to make `BOND` holdings a realistic,
first-class asset now that the design-61 allocation lever routinely establishes
them across every account.

**Phase 1 (G1 yield lock-in + G2 municipal) — DONE.** Shipped behind the existing
golden (default scenario has no bonds, so no re-baseline). Delivered:
- `Holding.taxExemption` enum (`'none'|'state'|'federal'|'both'`) + `issuingState`,
  generalizing the design-59 `treasury` boolean (back-compat: `treasury:true` →
  `'state'` in `fromJSON` + the account editor).
- `computeHoldingsCoupons` now returns `federalTaxableAmount` (excludes munis) and a
  residency-aware `stateTaxableAmount` (excludes Treasuries and *in-state* munis, via
  `primaryResidencyState`); both threaded through the 2 coupon handlers + 3 apply
  reducers into `BOND_COUPON_TAX`. Federal + NIIT tax the federal slice; muni interest
  is NIIT-exempt automatically; an AU resident is assessed on the full coupon with FITO
  on the US-taxed slice only.
- G1: `_newSleeve` (design-61 establish) stamps `couponRate` from
  `effectiveInterestRates[<rateKey>::<stateKey>] ?? [<rateKey>]` at purchase (null ⇒
  floats, pre-G1 behavior). Bootstrap-time bond declarations are deliberately NOT
  stamped in Phase 1.
- UI: the Treasury checkbox became a tax-treatment selector (Taxable / Treasury /
  Municipal / Muni all-state) + an issuing-state input shown for Municipal.
- Tests: `evt-bond-coupon` (federal/state split + muni in/out-of-state + legacy
  back-compat), `evt-target-allocation-taxable` RC-3-G1 (coupon stamp),
  `holdings-roundtrip` (new fields). 3521 unit + 866 viz green; golden unmoved.

**Phase 2 (G3 default bonds + the one golden re-baseline) — DONE.** The default
`IntlRetirementScenario` brokerage + 401(k) were all-equity, so the entire bond path
(coupons, duration marks, Treasury/muni tax splits) was dead in the golden. Delivered:
- Brokerage (`usStockAccount`, taxable) → 60% equity / 40% bond; the bond leg is a
  Treasury (`state`) + corporate (`none`) + CA municipal (`federal`) mix, exercising all
  three `BOND_COUPON_TAX` treatments. Equity bases rescaled to the smaller book to keep
  the domestic-loss / intl-gain TLH intent. `_stockHoldings` in `intl-retirement-scenario.js`.
- 401(k) (`k401Account`, deferred) → 60/40 equity/bond, one deferred sleeve exercising
  `BOND_SLEEVE_COUPON`. `_k401Holdings`.
- Fixed contractual `couponRate` 0.04 / duration 5 on the declared sleeves (declared
  holdings, not the G1 establish path). Also declared `federalTaxableAmount` on the four
  bond-coupon action field schemas (a Phase-1 loose end).
- **Golden re-baseline (deliberate, once):** ending net worth −2.7% (11,911,160 →
  11,584,539, a balanced book compounds slower than all-equity); lifetime tax +0.6%
  (1,121,674 → 1,128,113, ordinary-income coupons ≈ offset by lower CGT).
  `cross-border-relief-scenario` EXPECTED_* updated with the before/after; dependent
  tests re-golded (`holdings-invariant` 2→5 holdings, `accounting-integrity` mixed-book
  equity-sleeve growth). Verified e2e: brokerage coupon 2400 → fed 1800 / state 1440;
  401(k) deferred sleeve 4800. 3521 unit + 866 viz green (no viz snapshot churn).

**Phase 3 (G4 maturity & pull-to-par) — DONE.** The §3 fund-vs-individual identity
decision made concrete: a nullable `maturityDate` promotes a `BOND` sleeve from a
perpetual *fund* to an *individual bond*. Delivered:
- `Holding.maturityDate` / `faceValue` / `rollAtMaturity` fields (+ toJSON/fromJSON,
  string-or-Date tolerant serialization). `maturityDate == null` ⇒ fund (unchanged
  perpetual behavior).
- `BondPriceAdjustReducer` extended (both effects individual-only, funds untouched):
  (1) **duration decay** — effective duration = `min(staticDuration, yearsToMaturity)`,
  so a near-maturity bond is barely rate-sensitive; (2) **pull-to-par convergence** —
  independent of rates, the price amortizes toward `faceValue` over remaining life
  (`frac = Δt/(ttm+Δt)`), so a rate-driven markdown fully recovers by maturity. Reads
  the as-of date from `state.currentPeriods[cc].startMs`; maintains a new
  `state.priorMarkMs`.
- New `BondMaturityReducer` (PRE_PROCESS + 3, after the price mark) scans ALL accounts
  and, on the first period at/after `maturityDate`: redeems at par to a CASH holding
  (return of principal — par bonds have basis = face, so no CGT; premium/discount is
  G9), or, when `rollAtMaturity`, rolls into a fresh same-term par bond re-issued at
  the current yield (`effectiveInterestRates[rateKey]`, the G1 lock-in). Registered in
  `economic-regimes-toolset`, `index.js`, the serializer, and the coverage manifest.
- **Golden re-baseline (small, deliberate):** the default brokerage Treasury sleeve is
  now an individual bond (matures 2035-01-01, par faceValue), so the maturity path runs
  in the golden — it redeems to cash mid-sim. Ending net worth −0.03% (11,584,539 →
  11,581,436), lifetime tax −0.08% (1,128,113 → 1,127,223); both inside the ±1% band
  but re-pinned. Corporate + muni sleeves stay funds (both identities represented).
- UI: BOND rows in `account-editor.js` gained a maturity-date + face-value input
  (setting a maturity defaults faceValue to par); empty ⇒ fund.
- Tests: `bond-maturity` (decay / pull-to-par / snap / redemption / roll),
  `holdings-allocation-inputs` §G4 UI, golden re-pin. 3530 unit + 869 viz green.

**Phase 4 (G5 TIPS + G6 zero-coupon/OID — the shared accretion path) — DONE.**
Both are "phantom income" instruments: they grow a bond's principal each period with
NO cash changing hands, and that growth is currently-taxable ordinary income. They
share one mechanism. Delivered:
- `Holding.zeroCoupon` (G6) + `Holding.inflationLinked` (G5) booleans (+ toJSON/
  fromJSON; absent ⇒ a plain coupon bond). Two mutually-exclusive flags in the
  `treasury`/`taxExemption` style.
- `computeHoldingsAccretion` (new, `holdings-earnings.js`): a zero accretes its
  *adjusted basis* toward par by the **constant-yield** method
  (`basis × ((face/basis)^(1/ttm) − 1)`, capped at `face − basis`); a TIPS indexes
  principal by the period CPI rate (`basis × cpiRate`, reusing `state.cpiAccumulator`
  / `cpiRates`, deflation-symmetric). Each emits a HoldingTransactAction raising
  BOTH `marketValue` AND `costBasis` (the basis step-up is what prevents the accreted
  principal being taxed again as CGT at maturity), and splits the accretion by the
  SAME `couponFederalExempt`/`couponStateExempt` rules as coupons (so a Treasury
  STRIPS `taxExemption:'state'` is state-exempt OID, a muni zero `'federal'` is
  federally-exempt).
- Shared `BOND_ACCRETION` annual stream mirroring `BOND_SLEEVE_COUPON`:
  `BondAccretionHandler` (per-account, carries `country` for the CPI source + a
  `taxMode`) → `BOND_ACCRETION_APPLY` → `BondAccretionApplyReducer`, which routes tax
  exactly like the coupon reducer (`deferred`→none, `us`→`BOND_COUPON_TAX`
  federal+NIIT+state+FITO, `au`→`AU_SAVINGS_EARNINGS_TAX`; `amount` may be negative
  under TIPS deflation). Wired across brokerage + all equity-served + AU accounts in
  the us/au retirement toolsets; no-ops when an account holds no accreting bond.
- `BondPriceAdjustReducer`: zero/TIPS are EXCLUDED from the fixed-face pull-to-par
  (their principal trajectory is owned by the accretion stream) but still take the
  rate-sensitivity mark. `BondMaturityReducer`: a TIPS redeems at
  `max(adjustedPrincipal, faceValue)` — the deflation floor — and the accretion flags
  are cleared on redeem-to-cash / roll.
- UI: BOND rows in `account-editor.js` gained **Zero** + **TIPS** checkboxes beside
  the maturity/face inputs.
- **Golden unmoved** (Phase-4 convention): the default scenario gets no TIPS/zero, so
  this ships behind the existing golden. Tested by `evt-bond-accretion` (constant-
  yield OID + par cap, TIPS index + deflation, fed/state split, three tax modes,
  pull-to-par exclusion, TIPS deflation-floor redemption, + a full-sim e2e where a
  brokerage zero accretes to par) and the `holdings-roundtrip` / `holdings-allocation-
  inputs` field+UI additions. 3543 unit + 870 viz green.

This is a scoping / decision doc in the spirit of designs 53 (holding rate
twins), 59 (Treasury state exemption), 60 (cash-sleeve yield) and 61 (allocation
lever). It does not implement anything on its own; each phase below is sized so it
can ship independently behind the existing golden.

---

## 1. Motivation

Until recently a `BOND` sleeve earned income in **exactly one** account type (US
brokerage). Design 59 wired the `INTL_BOND_COUPON` stream there; the 2026-07-16
follow-up (`BondSleeveCouponHandler`, see [[design-61-holding-allocation-lever]])
extended coupon income to `IRA/401k/Roth/super/au-stock` sleeves. Bonds are now
income-bearing everywhere — but the *instrument model behind them is still thin*.
As the allocation lever (61) and allocation-aware drawdown (65) make Stock/Bond/
Cash/Gold a searchable, tax-aware decision, the optimizer's answer is only as good
as the bond model it optimizes against. A bond that can't lock in a yield, never
matures, and can't be a muni will be systematically mis-weighted.

## 2. What exists today (the foundation to build on)

The current `BOND` model is best understood as a **perpetual bond *fund*** (think
BND / AGG), not an individual bond. Seen that way it is internally coherent and
already correct on a lot:

| Real-world mechanic | Modeled? | Where |
|---|---|---|
| Coupon income at a fixed rate | ✅ | `computeHoldingsCoupons` — `Σ mv × couponRate`, annual, reinvest-or-cash |
| Coupon = federal ordinary income (+ NIIT) | ✅ | `us-tax-module-2026.js` `BOND_COUPON_TAX` |
| US Treasury **state**-tax exemption (31 USC 3124) | ✅ | `holding.treasury` → `stateTaxableAmount` split (design 59) |
| Price ∝ −duration × Δrate (rate sensitivity) | ✅ | `BondPriceAdjustReducer` (design 28 §5), PRE_PROCESS+2 |
| Rates move under economic regimes | ✅ | `FIXED_INCOME_US/AU` in `state.effectiveInterestRates` |
| No equity growth / no dividend on bonds | ✅ | `computeHoldingsGrowth` / `computeHoldingsDividends` skip `BOND` |
| Capital gain/loss on sale (mark ≠ basis) | ✅ | cost-basis CGT machinery |
| Cross-border coupon (AU ordinary income + FITO) | ✅ | `BondSleeveCouponApplyReducer` `taxMode: 'au'` |
| Reinvest-vs-cash-payout | ✅ (US_STOCK) | `BondCouponScheduledHandler` reinvest flag |

**Holding fields available today** (`holding.js`): `allocation='BOND'`,
`couponRate`, `duration` (modified duration, years), `treasury`, `rateKey`,
`marketValue`, `costBasis` / `costBaseByCountry`, `purchaseDate`,
`appreciationSchedule`, `taxLossPartner`.

## 3. The modeling identity decision (the meta-gap)

Everything downstream hinges on one question: **does a `BOND` sleeve represent a
bond *fund* or an *individual bond*?** Real portfolios hold both, and they behave
differently in the one way that matters most for a retirement horizon — **a fund
never matures (perpetual duration), an individual bond pulls to par at maturity.**

**Decision (proposed): support both, disambiguated by a nullable `maturityDate`.**

- `maturityDate == null` ⇒ **fund** — today's exact behavior (perpetual, static
  `duration`, mark-to-market never recovers on its own). Back-compatible default.
- `maturityDate != null` ⇒ **individual bond** — redeems at `faceValue` on that
  date, and its *effective* duration decays toward 0 as the date approaches (pull
  to par). Unlocks ladders (§4 G8).

This convention lets Phase 2 (maturity) land without disturbing any existing
sleeve, and frames the whole gap catalog: several gaps below apply to one identity,
both, or force the distinction.

## 4. Gap catalog (tiered by fidelity-per-effort)

None of G1–G10 exist today (verified: no `maturityDate`, `faceValue`, `redemption`,
premium/discount `amortization`, `accrued` interest, credit/`default`, `municipal`,
`TIPS`, or zero-coupon logic anywhere in the bond path).

### Tier 1 — high value, small/medium effort, few dependencies

- **G1 · Coupon-at-purchase (yield lock-in).** *The biggest correctness gap for the
  optimizer.* A design-61-established sleeve carries `couponRate: null`, and
  `computeHoldingsCoupons` resolves `couponRate ?? fallbackRate` where `fallbackRate`
  is a **static per-account param** — it never reads `effectiveInterestRates`. So
  buying bonds when yields are 7% does **not** lock in a 7% coupon; the sleeve earns
  whatever the static param says, forever. Real bonds fix their coupon at the
  prevailing yield at issue/purchase. **Fix:** at sleeve establishment
  (`_newSleeve` in `rebalance-to-target-apply-reducer.js`, and any other buy site)
  stamp `couponRate` from `effectiveInterestRates[rateKey]` at `purchaseDate`.
  *Small, low-risk, high value.* **Note:** it directly interacts with the
  2026-07-16 sleeve-coupon fix — the null-fallback is what currently *masks* this.

- **G2 · Municipal bonds (federal-tax-exempt).** Today the only tax-type axis is
  Treasury (state-exempt) vs generic (fully taxable). A `municipal` (or generalized
  `taxExemption: 'none'|'state'|'federal'|'both'`) flag mirroring `treasury` would
  classify coupon as **federally** exempt. *Very high value given the existing
  state-tax toolset — taxable-vs-muni is the #1 real bond decision for high earners
  in high-tax states, and it's a natural lever for the location sub-problem (61-D).*
  Interacts with NIIT (muni interest is NIIT-exempt) and the AU side (no AU muni
  concept — US muni held by an AU resident is fully AU-assessable). Small/medium.

- **G3 · Bonds in the default scenario + golden refactor.** The default scenario has
  **zero bonds in equity-served accounts** (`usStockAccount` = EQUITY,EQUITY; the
  fixed-income accounts are empty), so both coupon streams and the duration
  mark-to-market are **unexercised by the golden**. Add a realistic BOND sleeve to
  the default brokerage + a shelter. *Small mechanically; re-baselines the golden —
  see §6.*

### Tier 2 — the structural one

- **G4 · Maturity & pull-to-par.** Today bonds are perpetual and `duration` is
  **static**, so a rate spike is a *permanent* impairment; in reality an individual
  bond's price recovers to par as it matures, and its duration decays to 0. Scope:
  `maturityDate` + `faceValue` fields; a maturity handler that redeems at par → cash
  (with an optional roll-into-new-bond policy so a ladder self-sustains); effective
  duration derived as a function of time-to-maturity rather than a static field.
  Governs terminal-wealth volatility and reinvestment dynamics. *Medium-large.*
  Gated by the §3 identity decision. Enables G8.

### Tier 3 — breadth, as demand / realism requires

- **G5 · TIPS / inflation-linked. DONE (Phase 4).** Principal indexes to CPI; coupon
  pays on the adjusted principal; the inflation accretion is (US) currently-taxable
  "phantom" income. Reuses the CPI accumulator from the AU CGT reform (see
  [[inflation-wrapper-drops-cgt-reform]]). Implemented via the shared accretion path
  (`inflationLinked` flag + `computeHoldingsAccretion` + `BOND_ACCRETION` stream); a
  TIPS redeems at `max(adjustedPrincipal, faceValue)` — the deflation floor.
- **G6 · Zero-coupon / OID. DONE (Phase 4).** No cash coupon; accretes to par by the
  constant-yield method; the imputed accretion is annual ordinary income (Original
  Issue Discount) despite no cash received, and steps up basis. Shares the accretion
  machinery with G5 (`zeroCoupon` flag; same `BOND_ACCRETION` handler/reducer). A
  Treasury STRIPS is state-exempt OID; a muni zero is federally-exempt.
- **G7 · Credit spread + default risk.** Corporate / high-yield bonds price at a
  **spread over Treasury** and carry stochastic default with a recovery rate. This
  is the natural first consumer of the **seeded-but-unused in-loop `sim.rng`** (see
  [[sim-rng-unused-in-loop]]). *Medium-large.* Lower priority for a retirement
  planner (most hold investment-grade / Treasuries), but it's what makes "bonds"
  more than "one rate."
- **G8 · Bond ladders / barbells.** A maturity-structuring strategy layer on top of
  G4 (staggered `maturityDate`s for liquidity + reinvestment smoothing). Large;
  belongs to the 61/65 strategy family once maturity exists.
- **G9 · Premium/discount amortization, market discount, accrued interest.** A bond
  bought above par amortizes the premium (reduces taxable interest + basis); market
  discount is taxed **ordinary** at sale (not CGT); accrued interest changes hands
  at purchase/sale. Tax-fidelity niceties. Medium; second-order for planning.
- **G10 · Coupon frequency & reinvestment risk.** Real coupons are semi-annual and,
  when paid to cash, reinvest at the *then*-prevailing rate (reinvestment risk).
  Today's stream is annual and reinvests at the sleeve's own rate. Small; cosmetic.

## 5. Phased rollout (proposed)

Each phase is independently shippable and green-gated. Sequencing minimizes golden
re-baselines and lets each phase build on the last.

- **Phase 1 — G1 (yield lock-in) + G2 (muni).** Both are field + classification
  changes with no structural churn. Do them **before** G3 so the default bonds are
  realistic on first baseline. Adds: `couponRate` stamping at buy; `municipal`/
  `taxExemption` field + federal-exempt routing (+ NIIT-exempt) + UI in
  `account-editor.js`. Tests: extend `evt-bond-coupon` / `evt-bond-sleeve-coupon`;
  a muni classification test beside the design-59 Treasury tests.
- **Phase 2 — G3 (default scenario + golden).** Add a `BOND` sleeve to the default
  brokerage and one shelter (e.g. a 70/30-ish book). Re-baseline the golden **once**,
  after Phase 1, so coupon realism and muni are already in the number. This turns the
  golden into a live regression guard for coupons + mark-to-market-under-regimes +
  cross-border bond tax.
- **Phase 3 — G4 (maturity & pull-to-par).** The §3 identity decision made concrete:
  `maturityDate`/`faceValue`, a maturity/redemption handler, time-decaying effective
  duration, optional roll policy. Larger; own design sub-section or a `66-…-impl.md`
  companion (mirroring `61-…-implementation.md`).
- **Phase 4+ — breadth on demand.** G5 (TIPS), G6 (zero/OID), G7 (credit/default),
  G8 (ladders), G9 (amortization), G10 (frequency), pulled forward individually as
  scenarios require. G7 is the flagship "bonds are more than one rate" upgrade and
  the natural home for the unused `sim.rng`.

### 5.1 Sequencing & dependencies

```
G1 ─┐
    ├─▶ G3 (golden re-baseline, ONCE) ─▶ G4 ─▶ G8
G2 ─┘                                    │
                                   G5, G6 (share accretion/phantom-income machinery)
                                   G7 (independent; consumes sim.rng)
                                   G9, G10 (independent niceties)
```

- **G1 before G3** — otherwise the default bonds bake in the wrong (static) coupon
  and we re-baseline twice.
- **G4 gated by §3** — decide fund-vs-individual before writing the maturity handler.
- **G8 requires G4**; **G5/G6 share** the phantom-income accretion path; **G7, G9,
  G10 are independent** and can slot in any time.

## 6. Golden refactor plan (G3) — the one deliberate re-baseline

- **Today**: default equity-served accounts hold no bonds; `fixedIncome*` accounts
  exist but are empty. Coupon streams + `BondPriceAdjustReducer` never run in the
  golden.
- **Change**: seed a `BOND` sleeve (with a stamped `couponRate` from G1, and a
  `treasury`/`municipal` mix to exercise both tax paths) into `usStockAccount` and
  one shelter; optionally a small dedicated `fixedIncomeAccount` book.
- **Effect**: the golden ending number **moves** (new coupon income + duration marks
  + drawdown re-sequencing — the last is the usual chaotic lever, see
  [[residency-drives-drawdown-sequencing]]). This is expected, not a regression.
- **Guardrail**: do it exactly **once**, after Phase 1, and record the before/after
  in the commit + a memory note. Every viz snapshot that renders holdings will also
  need updating — budget for the snapshot churn.

## 7. Testing plan

- **Unit**: per-gap postcondition tests (G1 coupon-stamp, G2 muni federal-exempt +
  NIIT-exempt, G4 redemption-at-par + duration decay), mirroring
  `evt-bond-coupon` / `evt-bond-sleeve-coupon` / design-59 Treasury tests.
- **Coverage gate**: any new reducer → add to `reducer-coverage-manifest.js`.
- **End-to-end**: a full-sim probe per phase (a bond sleeve of each new type grows /
  matures / is taxed correctly), following the `EVT-BOND-SLV-6/7` pattern; drive the
  real design-61 lever once the establish path stamps coupons (G1).
- **Golden**: Phase 2 re-baseline; thereafter the golden guards the whole bond path.

## 8. Open questions (for owner review)

1. **Fund vs individual default (§3)** — confirm `maturityDate == null ⇒ fund` as
   the back-compatible default, with individual bonds opt-in via a maturity date. Answer: null => fund is ok
2. **Muni scope (G2)** — model muni as US-federal-exempt only (simplest, correct for
   most), or also the in-state / out-of-state state-exemption nuance? AU residents
   get no muni benefit — confirm US muni is fully AU-assessable. Answer: also in-state / out-of-state exemption nuance
3. **Coupon rate source after G1** — stamp from `effectiveInterestRates[rateKey]`
   (regime-aware market yield) at purchase, or add an explicit bond-yield rate key
   distinct from the fixed-income *fund* rate (a real yield curve would separate a
   new-issue coupon from a fund's blended yield)? Answer: `effectiveInterestRates[rateKey]` is good enough
4. **Default bonds in the golden (G3)** — which accounts and what Stock/Bond split
   make the most representative default (drives the baseline everyone reasons about)? Answer: flexible on this one, some in Retirement, some in Brokerage maybe a 60/40 stock bond split
5. **Credit/default appetite (G7)** — is corporate/HY default risk in scope for the
   planner, or do we stay investment-grade and treat "bonds" as rate-risk only? Answer: rate-risk only

## 10. G8 — Bond ladders (detailed design)

> Status: **Phases A / B (drawdown) / C IMPLEMENTED** (2026-07-17; §10.4, §10.9,
> §10.6). Only the buy-side inflow-aware tail extension (§10.5) + barbells remain.
> Fleshes out the Tier-3 §4 stub into an implementable plan and, in particular, nails
> down the *user-facing* surface.
>
> **Phase A delivered.** `Holding.rollTermYears` (+ toJSON/fromJSON, absent ⇒ roll to
> own term) → `BondMaturityReducer.redeem()` rolls a rung to the fixed ladder term when
> set, preserving `rollAtMaturity`/`rollTermYears` so it self-perpetuates. Account-editor
> **"+ Bond ladder"** builder (`_wireLadderBuilder`) expands (total, rungs, spacing,
> first term, tax, coupon, roll, zero/TIPS) into N staggered BOND rungs. Roll defaults ON
> (§10.8 #1). **Golden unmoved** (default scenario gets no ladder — ships behind the
> existing golden, Phase-4 convention). Tests: `bond-maturity` §G8 (roll-to-tail, coupon
> re-lock, 5-rung self-perpetuation, non-roll→cash), `holdings-roundtrip` rollTermYears,
> `holdings-allocation-inputs` builder. 3581 unit + 874 viz green. Phase B (allocation-
> lever buy routing + ladder-aware drawdown, §10.5/§10.9) and Phase C (optimizer lever,
> §10.6) remain proposed.

### 10.1 The key realization: ~90% of a ladder already ships

A bond ladder is not a new instrument — it is a **maturity-structuring policy over
a set of individual bonds we already model**. Everything a rung needs exists after
Phase 3/4:

- **Individual bonds** — a `BOND` holding with `maturityDate` + `faceValue` (§G4).
- **Pull-to-par + duration decay** — `BondPriceAdjustReducer` already makes a
  near-maturity rung barely rate-sensitive and recovers rate markdowns by maturity.
- **Redeem / roll at maturity** — `BondMaturityReducer` already redeems a matured
  rung to cash *or*, with `rollAtMaturity`, rolls it into a fresh par bond at the
  then-current yield (the G1 lock-in). That is literally a **self-sustaining
  single-rung ladder** today.
- **Per-rung coupons, tax, drawdown, CGT** — every rung is just a `BOND` holding, so
  the coupon streams (`BOND_SLEEVE_COUPON`), tax splits (`BOND_COUPON_TAX`),
  accretion (`BOND_ACCRETION`), and design-65 lot selection all apply per-rung with
  **zero new wiring**.

So a ladder = **N individual `rollAtMaturity` bonds with staggered `maturityDate`s.**
There is exactly **one behavioral gap** and **one convenience gap**:

1. **Behavioral gap — "roll to the tail, not to the same term."** `BondMaturityReducer`
   rolls a matured bond into a bond of *its own original term* (`maturityDate −
   purchaseDate`). That keeps a single bond at constant maturity, but it is **wrong for
   a ladder**: when the 1-year rung matures it must roll to the **longest** term (N
   years) to become the new tail, so the {1,2,…,N} spacing self-perpetuates as the sim
   clock advances. Fix in §10.3.
2. **Convenience gap — nobody hand-authors 10 staggered holdings.** We need a builder
   that expands `(total $, rungs, spacing, term, tax treatment)` into N rungs. §10.4.

This is why G8 is *sized medium, not large*, provided we stop at a **self-maintaining
hand-built ladder** (Phase A). The "large" framing in §4 is the optimizer-fed,
allocation-lever-integrated ladder (Phase B/C), which is genuinely bigger and optional.

### 10.2 The representation decision (the meta-choice, cf. §3)

**Decision: a ladder is N separate `Holding` rungs — NOT a new holding type and NOT a
persistent `account.bondLadder` object (for Phase A).** Rationale:

- The holding array is already the source of truth; every per-holding stream keys off
  `holding.id`. N rungs reuse all of it. A ladder "descriptor" object would duplicate
  state that the rungs already carry and force a materialization reducer to keep the
  two in sync (the classic param→node cascade-drift trap, cf.
  [[param-node-cascade-drift]]).
- A ladder is naturally **per-BOND-sleeve within an account**, not per-account: an
  account can hold equity + a Treasury ladder + a muni ladder simultaneously. N rungs
  express that for free (they coexist with equity/cash holdings); a single
  `account.bondLadder` field could not.
- Phase B (optimizer integration) can *later* add a lightweight per-account
  **ladder-intent tag** (§10.5) without changing the rung representation.

### 10.3 Phase A runtime change — one field, `rollTermYears`

Add one nullable field to `Holding`:

```
rollTermYears: number|null   // BOND, rollAtMaturity only. The term (years) of the
                             // bond a rung rolls INTO at maturity. null ⇒ roll to
                             // the rung's own original term (today's single-bond
                             // "constant-maturity" behavior — back-compat).
```

Then in `BondMaturityReducer.redeem()`, when rolling, prefer `rollTermYears`:

```js
const termMs = h.rollTermYears != null
  ? h.rollTermYears * YEAR_MS                      // ladder: roll to the fixed tail term
  : (purchaseMs != null && matMs > purchaseMs)     // single bond: keep its own term
      ? (matMs - purchaseMs)
      : (h.duration ?? 5) * YEAR_MS;
```

Every rung in a ladder is created with `rollAtMaturity: true` and
`rollTermYears: N`. Walk-through of a 5-year ladder (rungs maturing +1…+5y, each
`rollTermYears: 5`):

- **Year 1:** rung A (matures y1) redeems→rolls into a fresh **5-year** bond at the
  current yield. Holdings now mature at {2,3,4,5, **6**}. As the clock has advanced a
  year, that is exactly {1,2,3,4,5} relative to *now*. Ladder intact.
- Duration holds ≈ (N+1)/2 years; the portfolio reinvests one rung/year at prevailing
  rates (reinvestment smoothing); a rung matures every year (liquidity). ✓

No new reducer, no new stream, no per-account state. `rollTermYears` also round-trips
in `toJSON`/`fromJSON` (absent ⇒ null) and is inert for funds / non-roll bonds.

**Redeem-vs-roll at the tail.** With every rung set to roll, the ladder is perpetual.
To model a **winding-down** ladder (retiree spending it down), leave `rollAtMaturity`
false on the rungs you want to fall to cash as they mature — the builder exposes this
as a "roll maturing rungs" toggle (§10.4). Mixed is allowed (roll some, redeem some).

### 10.4 Phase A user-facing surface — the ladder builder (account editor)

The ladder is authored where individual bonds already live: the account editor
holdings table. Add a **"+ Bond ladder"** button beside the existing "+ Add holding".
It opens a small inline form (or a compact modal) with:

| Field | Default | Notes |
|---|---|---|
| Total amount | balance-aware | Split evenly across rungs (faceValue = total ÷ rungs) |
| Rungs (N) | 5 | 2–30 |
| Spacing (years) | 1 | Rung k matures at `start + firstRung + (k−1)·spacing` |
| First rung (years out) | 1 | Nearest maturity |
| Tax treatment | Taxable | Reuses the existing G2 selector (Taxable / Treasury / Municipal / Muni all-state) + issuing state |
| Coupon rate | blank | A fixed coupon applied to every rung; blank ⇒ `couponRate: null` (the rung floats / falls back to the coupon handler's per-account rate — the editor has no live `effectiveInterestRates` at author time, so runtime resolves the yield) |
| Roll maturing rungs | on | Sets `rollAtMaturity` + `rollTermYears = N·spacing` on every rung |
| Zero / TIPS | off | A **TIPS ladder** or **STRIPS ladder** is just the per-rung flag applied to all rungs |

On submit it **expands into N `Holding` rungs** appended to `this._holdings` — plain
individual bonds the existing table then renders as ordinary editable rows (the ladder
is "baked", not a hidden object). Each rung:
`{ allocation:'BOND', marketValue=costBasis=faceValue=total/N, maturityDate=staggered,
   duration≈yearsToMaturity, rollAtMaturity, rollTermYears, taxExemption, couponRate }`.

This mirrors the existing "add holding" push at `account-editor.js:277`; the builder is
pure UI sugar over data the schema already accepts, so **no serializer or runtime
change beyond §10.3**. A **barbell** (§G8 "barbells") is the same builder with a
`skipMiddle` option (emit only the shortest + longest rungs) — cheap follow-on.

### 10.5 Phase B (optional, larger) — allocation-lever integration

Phase A ladders are correct and self-maintaining, but the design-61 allocation lever
does not *know* they are ladders:

- **Buy side.** When 61 rebalances **into** bonds, `RebalanceToTargetApplyReducer`
  `_addProRata`'s the new $ across existing BOND holdings (grows every rung evenly —
  acceptable) or `_newSleeve`'s a single **perpetual fund** rung when none exist
  (breaks the ladder shape). Phase B: if the account carries a **ladder-intent tag**
  (`account.bondLadderIntent = { rungs, spacing, term, roll, taxExemption }`), route
  bond buys to *seed/extend the tail rung* instead of a fund sleeve, and bond sells to
  *shorten from the tail*. This is the one place a small persistent descriptor earns
  its keep — it is **intent**, not duplicated rung state.
- **Sell side (design 65 drawdown).** Ladder-aware lot selection
  (`drawdownLotStrategy: 'ladder'`): matured-cash → nearest-maturity rung → tail. Fully
  specified in **§10.9**, and deliberately **left OFF for Phase A** — it is the sell-side
  twin of this buy-side routing and shares the `bondLadderIntent` gate.

Phase B is where G8 touches the 61/65 strategy family and is legitimately "large."
It should be its own companion (`66-g8-ladder-impl.md`) if pursued.

### 10.6 Phase C — ladder as an optimizer + MPC lever — **IMPLEMENTED (2026-07-17)**

Ladder **length N** is now a searchable / online parameter, exactly like design-58/61's
drawdown/allocation levers: longer ladder = more duration/yield + rate risk; shorter =
more liquidity + reinvestment drag. Delivered — the **buy-side foundation (§10.5) and
the lever together**, since the lever needs a maintained ladder to turn:

- **`BondLadderReducer`** (`bond-ladder-reducer.js`) — a new behavioral-strategy reducer
  (sibling of design-61's `RebalanceToTargetReducer`). Each period, for a designated
  account, it reads the account's total BOND value and, when it has not yet been
  laddered at the current `targetRungs` (a stamped `_bondLadderRungs` marker), REPLACES
  the account's bonds with `targetRungs` equal, staggered, rolling rungs
  (`materializeLadder`); otherwise it no-ops and lets the Phase-A roll-to-tail
  self-maintain the spacing (no per-period churn). Value conserved; par rungs ⇒ no CGT.
  The rung count lives **on the reducer instance** (not a per-account state field), so
  the optimizer searches it (compile branch) and the MPC cockpit re-wires it live with
  **no `_seededSim` re-stamp** — the design-61 Phase-5 architectural win, reused.
- **`BOND_LADDER` behavioral strategy** (`behavioral-strategy-registry.js`) — opt-in via
  `behavioralStrategies`; constructs the reducer against the taxable brokerage (default)
  and contributes the params (`bondLadderRungs` searchable + spacing / roll / tax
  treatment). Unselected ⇒ no reducer ⇒ **golden byte-identical**.
- **Optimizer param** `bondLadderRungs` (INTEGER 2–15, `intl-retirement-opt-config`,
  `enabled:false`) + **MPC cockpit control** `BOND_LADDER` (`cockpit-controller.js`) whose
  `actuate` re-wires the live reducer's `targetRungs`, re-shaping the ladder next period.
- Registered: `index.js` barrel + `reducer-coverage-manifest`. Tests: `bond-ladder-reducer`
  (materialize/re-shape/idempotence/inert + strategy·opt·MPC wiring + a **full-sim e2e**
  that ladders the real brokerage bonds). 3600 unit + 874 viz green; golden unmoved.

**Still open (Phase B buy-side routing proper):** when the design-61 allocation lever
pumps NEW money into bonds, route it to *extend the ladder's tail* rather than spawn a
fund sleeve (§10.5). The current reducer re-ladders the account's whole bond value on a
rung-count change, which covers the lever; continuous inflow-aware tail extension is the
remaining refinement. Barbell shape (§G8 "barbells") also remains a follow-on.

### 10.7 Golden & testing

- **Golden unmoved** (Phase-4 convention): the default scenario gets no ladder; Phase A
  ships behind the existing golden. Phase B *would* re-baseline (bond buys change
  shape) — do it once, if/when Phase B lands, per §6's discipline.
- **Unit:** `evt-bond-ladder` — build a 5-rung ladder, advance N years, assert (a) one
  rung matures/rolls per year, (b) the rolled rung's `maturityDate` lands at the tail
  (`+N·spacing`, not same-term), (c) `couponRate` re-locks to the current yield,
  (d) constant ≈(N+1)/2 duration, (e) a non-rolling rung falls to cash. Plus a
  `rollTermYears` round-trip in `holdings-roundtrip` and a builder test in
  `holdings-allocation-inputs`.
- **E2e:** a full-sim probe where a Treasury ladder self-perpetuates across a rate
  regime shift and the coupons/tax splits track each re-locked rung (mirrors the
  `EVT-BOND-SLV` / `bond-maturity` patterns).
- **Coverage:** no new reducer in Phase A (reuses `BondMaturityReducer`), so no
  `reducer-coverage-manifest` change; Phase B's lever routing would add one.

### 10.8 Resolved decisions (G8)

1. **Perpetual vs winding-down default — RESOLVED: roll ON by default.** The builder
   defaults "roll maturing rungs" ON, so a freshly built ladder is a perpetual
   constant-maturity ladder that self-sustains (`rollAtMaturity: true` +
   `rollTermYears = N·spacing` on every rung). An accumulating planner wants this; a
   retiree spending the ladder down flips it OFF (per-rung, mixed allowed) so maturing
   rungs fall to cash. This matches the accumulation-first bias of the default scenario.
2. **Phase B intent home — RESOLVED: per-account.** Optimizer/lever integration
   (Phase B, §10.5) hangs a per-account `bondLadderIntent` descriptor
   (`{ rungs, spacing, term, roll, taxExemption }`). One ladder-intent per account is
   the modeled constraint: an account may still *hold* two ladders as raw rungs
   (Phase A), but only one is lever-*maintained*. This keeps the buy/sell routing
   unambiguous (bond buys seed/extend the single intent's tail; sells shorten from it)
   and avoids per-sleeve bookkeeping. Not needed for Phase A.

### 10.9 Ladder-aware drawdown (Phase B, sell side) — **IMPLEMENTED (2026-07-17)**

> **Status.** Shipped as a new design-65 Lever-B lot strategy,
> `drawdownLotStrategy: 'LADDER'` — opt-in (selecting it *is* the gate, so no
> `bondLadderIntent` dependency; that remains only for the Phase-B *buy*-side routing,
> §10.5). Default stays `FIFO`, so the golden is byte-identical.
>
> **How it works.** `LADDER` adds a single per-element sort key in
> `holdings-selection.js` (`ladderKey`), so `buildHoldingsComparator` stays a valid
> total order (transitive, deterministic — the same discipline as HIFO's `basisRatio`):
> CASH → −∞ (already-liquid, e.g. a redeemed rung — spent first); an individual BOND →
> its `maturityTs` (nearest-maturity rung next, ≈ par ⇒ least realized mark); everything
> else → +∞ (perpetual bond funds + EQUITY/GOLD/OTHER last, sparing the growth engine).
> Infinity-safe (`cmpNum` ⇒ equal-tier ties fall through to the FIFO purchaseDate
> tie-break). **Composes with Lever A:** when a `drawdownSleeveOrder` is also set, the
> sleeve rank groups the allocations first, so within the BOND sleeve `LADDER` reduces
> to purely nearest-maturity-first (funds last) and the ±∞ tiers go inert. Tests:
> `holdings-selection` §G8 (standalone cash→near→far→growth ordering, partial-drawdown
> front-absorption, within-sleeve ordering, total-order/NaN guard).
>
> **Not yet done (still Phase B):** the *buy*-side allocation-lever routing (§10.5) and
> the per-account `bondLadderIntent` it needs; the §10.9 point-3 "shorten strictly from
> the tail" refinement (the shipped rule is nearest-first, point 2 — the dominant
> effect). Original framing, kept for context:

> **Decision (superseded 2026-07-17): originally deferred OFF for Phase A.**
> Documented here so the trade-off is captured and we can come back to it.

**The question.** When design-65 drawdown must sell bonds from an account that holds a
ladder, *which rung* should it consume? Two behaviors:

- **Today (default, what Phase A ships with):** drawdown uses the existing
  `drawdownLotStrategy` / FIFO lot selection over BOND holdings, blind to the ladder
  structure. It may sell a **mid-ladder rung** whose price is still marked away from
  par (a rate-driven markup/markdown that has not yet pulled in), realizing a gain/loss
  that a real ladder investor would have avoided by simply waiting for the next
  maturity. It also silently *degrades the ladder shape* (punches a hole in the rung
  spacing) with no re-materialization.
- **The enhancement (`drawdownLotStrategy: 'ladder'`):** prefer liquidity that a
  ladder actually produces, in priority order:
  1. **Matured-to-cash proceeds first** — a rung that has already redeemed to CASH
     (non-rolling rungs, §10.3) is free liquidity; spend that before touching a bond.
  2. **Then the nearest-maturity rung** — its effective duration has decayed toward 0
     and its price has pulled to ≈ par (`BondPriceAdjustReducer`), so selling it early
     realizes the *smallest* mark-to-market deviation. This is the rung a real ladder
     investor lets mature next anyway.
  3. **Only then** reach into longer rungs (largest price risk) — and, ideally, prefer
     shortening **from the tail** so the front of the ladder (the liquidity engine)
     stays intact.

**Why it's a Phase-B item, not Phase-A.**
- It only bites when a ladder-holding account is *also* a drawdown source under a
  spend-down that outruns the coupon + maturity cash flow — a narrower scenario than
  "model a ladder at all."
- It is the sell-side twin of the Phase-B buy-side routing (§10.5): both need the
  per-account `bondLadderIntent` (10.8 #2) to know the account is a *maintained* ladder
  rather than an incidental bag of bonds. Shipping one without the other is half a
  feature.
- Phase A is still correct without it — nearest-maturity liquidity mostly *falls out*
  of FIFO for a ladder built oldest-first, and any mis-selection is a second-order
  price-timing effect, not a correctness bug (coupons, tax, and redemption values are
  all still right per rung).

**When we come back to it:** implement `drawdownLotStrategy: 'ladder'` alongside the
Phase-B lever routing, gated by `bondLadderIntent`, and add a `drawdown-ladder` unit
test asserting the matured-cash → nearest-rung → tail ordering and that the front of
the ladder survives a partial drawdown. Until then, ladder rungs are drawn like any
other BOND lot.

---

## 9. Relationship to other designs

Builds directly on [[design-59-treasury-bond-state-tax]] (Treasury/state split),
[[design-60-cash-sleeve-money-market-yield]] (the sleeve-stream pattern the coupon
fix mirrors), and **design 53 §4** (holding rate twins: `couponRate`/`duration`).
Consumed by [[design-61-holding-allocation-lever]] (the mix the optimizer searches)
and [[design-65-allocation-aware-drawdown]] (which sleeve/lots to sell). Reuses the
CPI accumulator from [[inflation-wrapper-drops-cgt-reform]] (G5) and the idle
[[sim-rng-unused-in-loop]] (G7). Mark-to-market lives in design 28 §5
(`BondPriceAdjustReducer`).

## 11. G10 — Coupon frequency & reinvestment risk (detailed design)

> Status: **COMPLETE** (2026-07-17; all 4 steps of §11.7 — 3612 unit + 875 viz green).
> Delivered: **A2** (real semi-annual cashflows) + **B2** (reinvest into a new-vintage
> bond lot at the prevailing yield), default `couponFrequency` **2**. Golden moved
> +0.024% NW / +0.061% tax (§G10a semi-annual compounding); §G10b is inert on the
> default golden (prevailing yield ≈ source coupon) but the mechanism is live (14
> reinvest lots) and verified by the §G10b-7 rate-divergence probe. G10 is two
> *independent* sub-gaps that share a sentence — **G10a coupon frequency** and **G10b
> reinvestment risk**. The §4 sizing ("Small; cosmetic") held for G10a; B2 was medium.

### 11.1 What today does (baseline)

Coupons run off **one annual `year-end` stream** each:

- `INTL_BOND_COUPON` → `BondCouponScheduledHandler` for the US brokerage
  (`usStockAccount`) BOND sleeve;
- `BOND_SLEEVE_COUPON` → `BondSleeveCouponHandler` for the equity-served shelters
  (IRA/401k/Roth/super/au-stock).

Both compute `Σ holding.marketValue × (holding.couponRate ?? fallbackRate)` once per
sim year (`computeHoldingsCoupons`, `holdings-earnings.js`). The result is credited
via one of two branches (per the `reinvest` param):

- **reinvest = true** → `BOND_COUPON_APPLY` / `BOND_SLEEVE_COUPON_APPLY`:
  `distributeHoldingsCredit(holdings, coupon)` spreads the coupon back **into the
  existing BOND lots**, raising their `marketValue`. Next year the (now larger)
  `marketValue` earns coupon again **at the same `couponRate`** → the reinvested cash
  compounds at *the bond's own coupon*, regardless of where market rates have moved.
  This is the "reinvests at the sleeve's own rate" the §4 stub flags.
- **reinvest = false** → cash path (`BOND_COUPON_CASH_APPLY`): credits the savings
  account, which already earns the regime-adjusted savings rate. (So the *cash* leg
  is arguably already "prevailing-rate" reinvestment; the gap is really on the
  reinvest-in-place leg.)

The then-prevailing market fixed-income yield is available in state as
`state.effectiveInterestRates[RATE_KEYS.FIXED_INCOME_US|_AU]` (regime-adjusted,
duration-aware) — this is the concrete field G10b would reinvest at.

### 11.2 G10a — Coupon frequency

Real Treasuries/corporates pay **semi-annual** coupons; the model pays one annual
lump. Two ways to represent it, with opposite golden profiles:

- **Option A1 — cosmetic frequency field (golden UNMOVED).** Add
  `Holding.couponFrequency` (∈ {1,2,4}, default 2 for realism *display*, or 1 to
  preserve today's number). Keep the single annual event; `couponFrequency` is
  carried for round-trip + shown in the account editor / holdings panel, but the
  *annual* coupon math is unchanged (`Σ mv × couponRate`, paid once). This is the
  literal "cosmetic" reading: the label is right, the cashflow timing is unchanged,
  **the golden does not move**, no re-baseline.
- **Option A2 — real semi-annual cashflows (golden MOVES).** Add a second scheduled
  firing (mid-year) so the coupon pays in two halves of `mv × couponRate / frequency`.
  Reuses the existing `factor` param on `computeHoldingsGrowth`-style paths; the
  handler pays `couponRate / frequency` per firing. Under **reinvest=true** the two
  half-coupons compound intra-year → a small positive drift; earlier cash under
  reinvest=false. Both shift the golden and force a re-baseline. The economic size at
  annual planning resolution is tiny (a half-year of compounding on the coupon of a
  60/40 book), which is why §4 calls it cosmetic — but it is **not golden-neutral**.

### 11.3 G10b — Reinvestment risk

The substantive gap: reinvested coupons should buy exposure at the **then-prevailing
market yield**, not perpetuate the maturing bond's coupon. Three options, increasing
fidelity/cost:

- **Option B0 — leave as-is (do nothing).** Reinvest-in-place stays at the bond's own
  coupon. Zero cost; documents that the gap is knowingly deferred. Reinvestment risk
  is then only *partially* modeled — via the cash leg (reinvest=false) and via G4
  ladder roll (a matured rung re-issues at the prevailing coupon, §10.3), which
  together already capture most of it.
- **Option B1 — route reinvested coupons to the CASH sleeve (small; golden moves
  only where bonds reinvest).** Instead of `distributeHoldingsCredit` into the BOND
  lots, credit the account's **CASH sleeve**, which already earns the prevailing
  money-market rate (design 60). The coupon then compounds at the *current* short
  rate, and design-61 rebalancing may sweep it back toward target on its own cadence.
  Faithful, tiny code change, reuses two existing subsystems. Downside: it conflates
  "reinvest at prevailing" with "hold as cash until rebalanced," and only equity-
  served accounts have a money-market CASH sleeve.
- **Option B2 — reinvest into a new-vintage BOND lot (medium; the "correct" model).**
  Append (or merge into a current-year) BOND lot stamped with
  `couponRate = effectiveInterestRates[FIXED_INCOME_*]` at the reinvest date. The
  sleeve becomes a blend of coupon vintages — exactly reinvestment risk, and it
  dovetails with G4 ladder vintages and G1 yield-lock-in. Downside: lot proliferation
  (one new lot/year) needs consolidation, and it is no longer "cosmetic."

### 11.4 Golden impact summary

| Sub-gap | Option              | Golden                                              |
| ------- | ------------------- | --------------------------------------------------- |
| G10a    | A1 cosmetic field   | **unmoved**                                         |
| G10a    | A2 real semi-annual | moves (re-baseline)                                 |
| G10b    | B0 leave-as-is      | unmoved                                             |
| G10b    | B1 cash-sleeve      | moves (where a golden account reinvests coupons)    |
| G10b    | B2 new-vintage lot  | moves (re-baseline)                                 |

The default golden **does** hold a 60/40 book with bond sleeves (G3), and the shelter
sleeves reinvest, so any option other than A1/B0 forces a coordinated re-baseline.

### 11.5 Testing plan

- **G10a A1**: `holdings-roundtrip` carries `couponFrequency`; account-editor input
  test; a coupon test asserts the annual amount is **unchanged** (cosmetic guard).
- **G10a A2**: extend `evt-bond-coupon` / `evt-bond-sleeve-coupon` — two firings sum
  to the annual coupon; reinvest=true shows the intra-year compounding delta.
- **G10b B1/B2**: an end-to-end probe where prevailing rate ≠ bond coupon shows the
  reinvested cash compounding at the *prevailing* rate (B1: CASH sleeve grows; B2: a
  new lot appears at the prevailing coupon), following the `EVT-BOND-SLV` pattern.
- **Coverage gate**: any new reducer → `reducer-coverage-manifest.js`.

### 11.6 Open decisions (for owner review)

1. **G10a scope** — cosmetic frequency field (A1, golden-neutral) or real semi-annual
   cashflows (A2, re-baseline)? Given §4's "cosmetic" sizing, A1 is the low-risk default.
   Answer: **A2 (real semi-annual cashflows).** Model the true half-year coupon timing.
2. **G10b scope** — leave-as-is (B0), route reinvested coupons to the CASH sleeve (B1),
   or new-vintage bond lot (B2)? Note G4 ladder-roll + the reinvest=false cash leg
   already capture much of reinvestment risk, which argues B0/B1.
   Answer: **B2 (new-vintage bond lot).** Reinvest at the prevailing yield into a fresh
   lot so the sleeve becomes a real blend of coupon vintages.
3. **`couponFrequency` default** — 2 (semi-annual, realistic) or 1 (annual, preserves
   today's numbers)? Under A1 this is display-only either way.
   Answer: **2 (semi-annual).**
4. **Ship together or split** — G10a and G10b are independent; do we land the
   golden-neutral pieces first (A1 and/or B0) and defer any re-baseline, or do one
   coordinated re-baseline for the behavioral options?
   Answer: **One coordinated re-baseline** (both A2 and B2 move the golden).

### 11.7 Implementation plan (decisions locked)

Both chosen options move the golden, so G10 lands as **one phase with a single
re-baseline** at the end. Order the work so the golden is touched exactly once:

**Step 1 — `Holding.couponFrequency` (field plumbing). — DONE (2026-07-17).** Added
`couponFrequency` (default **2**, `?? 2` for old saves) to `Holding` ctor/toJSON/
fromJSON; carried through `holdings-roundtrip`. Account-editor BOND row gets a
frequency `<select>` (Annual/Semi-ann./Quarterly, stored as a Number) in the bond-
terms cell, plus a Freq selector in the `index.html` ladder-builder form that stamps
`couponFrequency` on every rung. Display-only — no math change, **golden unmoved**.
Tests: `holdings-roundtrip` (non-default 4 preserved, absent ⇒ 2); `holdings-
allocation-inputs` (§G10a row selector reflect/edit-as-Number/default-2/EQUITY-absent,
ladder-builder stamps freq). 3600 unit + 875 viz green.

**Step 2 — G10a semi-annual cashflows. — DONE (2026-07-17).** Added a `semiannual`
interval (`intervalFns`/`startSnapFns` in `simulation-adapter.js`) that fires on both
half-year ends (Jun 30 / Dec 31), computed from the calendar half (not day-preserving
`addMonths`, which overflows Jun 31 → Jul 1). Both coupon streams (`INTL_BOND_COUPON`,
`BOND_SLEEVE_COUPON`) switched from `year-end` to `semiannual` and carry
`data.firingsPerYear:2`. `computeHoldingsCoupons` gained `{firingIndex, firingsPerYear}`
and multiplies each holding's coupon by `couponFiringFraction(couponFrequency,
firingIndex, firingsPerYear)` — a holding pays on the last `min(freq, firingsPerYear)`
firings (back-loaded so an annual bond pays only at year-end) and splits evenly, so the
firings sum to exactly the annual coupon. `couponFiringIndex(date, firingsPerYear)`
maps Dec→year-end / Jun→mid-year. Handlers read `date` + `data.firingsPerYear`; default
(`firingsPerYear:1`) is byte-identical to pre-G10 for every direct caller. Also added
`semiannual` to the event-editor interval dropdown.
- **Golden re-pinned** (cross-border-relief): net worth +0.024% (11,581,436 →
  11,584,191), lifetime tax +0.061% (1,127,223 → 1,127,909) — small upward drift from
  reinvested mid-year halves compounding intra-year.
- **Fixed** `evt-state-tax` EVT-STATE-4: its mid-year reconciliation checkpoint was
  `Date.UTC(2026,5,30)` = **Jun 30**, which now coincides with the first semi-annual
  coupon whose Treasury slice is federal-taxable-but-state-exempt (legitimately breaks
  the federal≡state mirror); moved the checkpoint to May 30 (pre-coupon).
- Tests: `evt-bond-coupon` §G10a-1..4 (fraction/index helpers, split sums to annual,
  annual-bond pays nothing mid-year) + EVT-BOND-COUPON-6 (e2e: two firings Jun 30 +
  Dec 31 each half). 3605 unit + 875 viz green.

**Step 3 — G10b reinvest into a new-vintage lot. — DONE (2026-07-17).** New
`computeHoldingsCoupons().reinvestBuckets` groups the firing's coupon by tax character
(`taxExemption|issuingState|rateKey`). New `resolvePrevailingCouponRate(state, stateKey,
rateKey)` (mirrors the G1 `<rateKey>::<stateKey>` stamp) and `mergeCouponReinvestLots(...)`
(holdings-earnings.js) append/merge a BOND lot per `(bucket × year)`, id
`reinvest-<stateKey>-<bucket>-<year>`, stamped `couponRate = prevailing yield` and
inheriting the source's `taxExemption`/`issuingState`/`rateKey`; both semi-annual firings
of a year merge into that year's lot with an mv-weighted blended rate (distinct years =
distinct vintages). Both handlers pass `_reinvestBuckets`/`_prevailingRate`/`_reinvestYear`
on the apply action; `BondCouponApplyReducer` (reinvest branch) and
`BondSleeveCouponApplyReducer` consume them (Σ mv +coupon, balance re-synced ⇒ §4.4
holds). The sleeve handler no longer emits per-source `HoldingTransactAction`s. Back-compat:
absent buckets ⇒ old behavior (`distributeHoldingsCredit` / scalar balance credit), so the
direct-`reduce` unit tests still pass. Tests: `evt-bond-coupon-reinvest` §G10b-1..7 (rate
resolution, new-lot-at-prevailing, within-year blend, distinct vintages, per-bucket
separation, e2e lever-bites where prevailing 6% ≠ source 2%); `evt-bond-sleeve-coupon`
SLV-6/7 updated (source stays at par, reinvest lot appears).

**Step 4 — golden re-baseline (folded into Steps 2–3).** §G10a moved the golden +0.024%
NW / +0.061% tax (re-pinned in Step 2). §G10b is **INERT on the default golden**: it
creates 14 reinvest lots but the prevailing yield ≈ the seeded 0.04 coupon and the only
reinvesting sleeve (k401) is tax-deferred, so NW moved $1 (rounding), tax unchanged.
Golden re-pinned to 11,584,190 / 1,127,909. The lever bites only when the prevailing
rate diverges from the source coupon (a rate-regime shift) — verified by the §G10b-7
e2e probe. `MEMORY.md` design-66 note updated.

Open sub-decisions deferred to implementation (sensible defaults, revisit if wrong):
- **Frequency granularity of the stream** — schedule a fixed semi-annual (2×/yr)
  series and let annual holdings pay only on the year-end firing, vs. a fully general
  per-frequency scheduler. Default: **fixed 2×/yr**, since default is 2 and quarterly
  (4) is rare; generalize only if a scenario needs 4/12.
- **B2 lot rateKey resolution** — reuse the account's `fallbackRateKey`
  (`FIXED_INCOME_US`/`_AU`) already threaded into the coupon handler; the reinvest
  lot's yield is that regime-adjusted rate at the firing date.
