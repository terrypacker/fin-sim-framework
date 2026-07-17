# 66 — Bond fidelity: from a bond-fund proxy to first-class fixed income

**Status**: **PHASES 1–2 IMPLEMENTED** (2026-07-16); Phases 3–4 PROPOSED. Scope:
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

- **G5 · TIPS / inflation-linked.** Principal indexes to CPI; coupon pays on the
  adjusted principal; the inflation accretion is (US) currently-taxable "phantom"
  income. A **CPI series + accumulator already exists** from the AU CGT reform (see
  [[inflation-wrapper-drops-cgt-reform]]) and can be reused. Medium.
- **G6 · Zero-coupon / OID.** No cash coupon; accretes to par; the imputed accretion
  is annual ordinary income (Original Issue Discount) despite no cash received.
  Medium; shares the accretion machinery with G5's phantom income.
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

## 9. Relationship to other designs

Builds directly on [[design-59-treasury-bond-state-tax]] (Treasury/state split),
[[design-60-cash-sleeve-money-market-yield]] (the sleeve-stream pattern the coupon
fix mirrors), and **design 53 §4** (holding rate twins: `couponRate`/`duration`).
Consumed by [[design-61-holding-allocation-lever]] (the mix the optimizer searches)
and [[design-65-allocation-aware-drawdown]] (which sleeve/lots to sell). Reuses the
CPI accumulator from [[inflation-wrapper-drops-cgt-reform]] (G5) and the idle
[[sim-rng-unused-in-loop]] (G7). Mark-to-market lives in design 28 §5
(`BondPriceAdjustReducer`).
