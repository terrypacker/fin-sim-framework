# 67 — Bond yield curve: from a single fixed-income rate to a term structure

**Status**: **PROPOSED** (2026-07-17). Closes the long-deferred "yield curve"
follow-up flagged in design 24 (§5.5 / roadmap line 272 — *"per-maturity rate
structures. Depends on bond duration shipping first (design 28)"*) and design 28
(§8 / §11 — *"Yield curves (per-maturity rate structures)"*, explicitly **out of
scope**; *"Single short-term rate per bond holding only"*). Design 66 §8 open-question
#3 then chose to stay single-point (*"`effectiveInterestRates[rateKey]` is good
enough"*) — this design revisits exactly that decision now that 66 has shipped the
whole *consuming* side (a maturity primitive, a duration mark, and new-issue /
reinvest / roll all funnelling through one resolvable rate).

Scope: generalize the single `effectiveInterestRates[FIXED_INCOME_US|_AU]` scalar
into a **term structure** (a per-maturity curve), and have every bond-rate consumer
look up the rate at its bond's own tenor. The headline payoff: a bond ladder (design
66 §G8) finally earns a **term premium** — today every rung rolls at the same 5-year
proxy rate, so a ladder captures reinvestment *timing* but no *term structure*.

---

## 1. Motivation

A real fixed-income market prices bonds off a **yield curve**: a 2-year, 10-year, and
30-year bond see different yields, and the whole curve moves *and changes shape*
(steepening, flattening, inversion) over time. Three real behaviors depend on it:

- **Term premium.** An upward-sloping curve pays more for longer maturities. A ladder
  or barbell (§G8) is a strategy *for harvesting the curve* — it is inert without one.
- **Curve-shape risk.** A bear-flattener (short rates up, long flat) marks a long bond
  down hard while barely touching a short one; a bull-steepener does the reverse. A
  single rate can only model a *parallel* shift.
- **Realistic new-issue / roll / reinvest pricing.** A bond issued or rolled today
  should lock in the yield *at its own maturity*, not a blended fund rate.

**Today** the model is a single point on a flat curve: one
`effectiveInterestRates[FIXED_INCOME_{country}]` scalar, with
`RATE_KEY_META[FIXED_INCOME_*].defaultDuration = 5.0` (an intermediate-Treasury
proxy). Every bond — 1-year rung or 30-year long bond — keys off that one rate.

## 2. What exists today (the consuming side design 66 already shipped)

The curve's *consumers* are all built; only the *source* is a single point. Every
rate-read below currently resolves `effectiveInterestRates[rateKey]` (one scalar):

| Consumer | File | Reads |
| --- | --- | --- |
| Rate-sensitivity mark (design 28 §5) | `bond-price-adjust-reducer.js` | `effectiveRates[h.rateKey]` vs `priorRates[h.rateKey]` → `−effDuration·Δrate·mv` |
| G1 new-issue coupon stamp | `rebalance-to-target-apply-reducer.js` `_stampCouponRate` | `effectiveInterestRates[rk::stateKey] ?? [rk]` |
| G10b reinvest pricing | `holdings-earnings.js` `resolvePrevailingCouponRate` | same |
| G8 rung roll re-lock | `bond-maturity-reducer.js` `redeem()` | `effectiveInterestRates[rateKey]` |
| G8 ladder rung stamp | `bond-ladder-reducer.js` `materializeLadder` | `effectiveInterestRates[rateKey]` |

Plus the **maturity primitive** (design 66 §G4: `Holding.maturityDate` +
`yearsToMaturity(h, asOfMs)` + duration decay `min(staticDuration, ttm)`) — every
bond already knows its tenor. **The one missing piece is a rate source that varies by
that tenor.** Because all five consumers funnel through a single resolvable rate, the
change is well-contained: generalize the source, reroute the reads.

## 3. The representation decision (the meta-gap)

How to represent a curve that (a) regimes can already move, (b) is cheap to seed and
serialize, and (c) is back-compatible with the flat single-point default. Three options:

- **A — discrete tenor rate keys** (`FIXED_INCOME_US@2y`, `@5y`, `@10y`, `@30y`),
  interpolate between. *Most native* to the existing rate-key machinery
  (`RegimeApplyReducer` fan-out, `effectiveInterestRates`), but it multiplies the
  RATE_KEYS set and the fan-out maps by the number of tenor buckets per country, and
  every seed/param/shock path grows with it.
- **B — parametric curve** (Nelson–Siegel: level + slope + curvature, 3–4 numbers/
  country), evaluated by a `yield(tenor)` function. Most *realistic* (it's how
  practitioners fit curves) and the most compact state, but the heaviest math and the
  least obvious to a user editing a scenario.
- **C — anchor + shape overlay (RECOMMENDED).** Keep
  `effectiveInterestRates[FIXED_INCOME_{country}]` as the **level** anchor (the 5-year
  point, unchanged — regimes keep moving it as a *parallel shift*), and add
  `state.yieldCurve[country]` as an additive **shape**: an array of
  `{ tenor, spread }` anchor points (spread *relative to* the level), linearly
  interpolated. Then:

  ```
  resolveYield(state, country, tenorYears)
      = effectiveInterestRates[FIXED_INCOME_{country}]      // level (regime-moved)
      + interpolateSpread(state.yieldCurve[country], tenorYears)   // shape (default 0)
  ```

  An **empty/absent** `yieldCurve` ⇒ every spread is 0 ⇒ every tenor returns the
  anchor ⇒ **byte-identical to today** (a flat curve). The level still moves under the
  existing regime machinery; a separate schedule/shock twists the *shape* (§6).

**Recommendation: C.** It preserves the single anchor as the source of truth, keeps
the regime fan-out untouched (the level is still one rate key), makes back-compat a
literal identity (no curve ⇒ flat), and gives a clean single accessor
`resolveYield(...)` that the five consumers call. It mirrors the design-56 Prime
pattern: a base series (the anchor / Prime) plus a derived overlay propagated by a
small reducer (§6, cf. `PrimeRelinkReducer`).

## 4. Phase 1 — the curve primitive + reroute the consumers (golden-neutral)

- **State.** `state.yieldCurve = { US: [{tenor, spread}…], AU: […] }`, seeded by the
  ECONOMIC_REGIMES toolset from a new `usYieldCurveShape` / `auYieldCurveShape` param
  (default **absent ⇒ flat**). Also stash `state.baseYieldCurve` for the base→effective
  delta pattern (§6), symmetric with `baseInterestRates`.
- **Accessor.** `resolveYield(state, country, tenorYears)` in a new
  `finance/economic-regimes/yield-curve.js` (with `interpolateSpread(points, tenor)` —
  linear, clamped to the endpoints). A `null` tenor (perpetual fund, `maturityDate ==
  null`) resolves at the **fund tenor** = `RATE_KEY_META[rateKey].defaultDuration`
  (5y) — the fund sits at its proxy point, so a flat curve is unchanged.
- **Reroute the five consumers** to `resolveYield(state, country, yearsToMaturity(h) ??
  fundTenor)` instead of `effectiveInterestRates[rateKey]`:
  1. `BondPriceAdjustReducer` — `curRate`/`prevRate` become the bond's *own-tenor*
     yield (prior snapshot in `state.priorMarkCurve`, symmetric with `priorMarkRates`).
     A curve **twist** now marks a 2y and a 30y bond *differently* — the core feature.
  2. `_stampCouponRate` (G1) — a freshly established sleeve/bond stamps the yield at
     its tenor (a fund ⇒ 5y point; an individual bond ⇒ its `yearsToMaturity`).
  3. `resolvePrevailingCouponRate` (G10b) — reinvest lots priced at the reinvest
     vehicle's tenor.
  4. `BondMaturityReducer.redeem()` (G8 roll) — a rung rolling to the ladder term
     re-locks at **that term's** yield → **term premium** on the roll.
  5. `materializeLadder` (G8) — each rung stamped at its own tenor's yield, so a
     freshly built ladder is priced along the curve.
- **Country resolution.** From the account/holding: reuse the existing `rateKey`
  (`FIXED_INCOME_US`→US, `_AU`→AU) or `account.country`.
- **Golden.** Ship Phase 1 **flat** (no default curve shape) ⇒ `resolveYield` ≡ the
  anchor everywhere ⇒ **golden unmoved, no re-baseline** (the design-66 "consumers
  before the number moves" discipline; cf. G1-before-G3).

## 5. Phase 2 — a default curve + the term-premium re-baseline (one deliberate move)

Seed a realistic upward-sloping default shape (e.g. `[{tenor:1,spread:-0.010},
{tenor:5,spread:0}, {tenor:10,spread:+0.006}, {tenor:30,spread:+0.012}]` — anchored so
the 5y point is the unchanged level). This makes the default 60/40 golden book earn a
term premium on its longer bonds and re-prices the design-66 individual bond + any
ladder. **Re-baseline the golden once**, after Phase 1, so the curve realism is baked
into the number that everyone reasons about (mirrors design 66 §6, G3). Expected: a
small positive drift on ending net worth (longer bonds yield more), with the individual
Treasury bond's mark now curve-sensitive.

## 6. Phase 3 — curve dynamics (level shifts + shape twists)

The level already moves (existing `RegimeApplyReducer` on `FIXED_INCOME_*` — a parallel
shift). Add **shape** dynamics:

- **Scheduled twists** — a `yieldCurveSchedule` (mirroring design 56 §Phase-2b
  `primeSchedule`) that overrides the shape at set dates, plus a `YieldCurveReducer`
  (priority `PRE_PROCESS + 2`, on the PERIOD_ADVANCE / regime action types, cf.
  `PrimeRelinkReducer`) that rebuilds `state.yieldCurve` = base shape + the accumulated
  twist so a schedule/shock **composes** with the level move.
- **Regime shocks** — named curve moves in the design-21 regime vocabulary:
  *bear-flattener* (short up, long flat), *bull-steepener*, *inversion*. These are the
  curve-shape analog of the existing return/rate shocks.
- **Stochastic evolution (optional)** — this is a natural first consumer of the
  seeded-but-idle in-loop `sim.rng` ([[sim-rng-unused-in-loop]], also eyed by design
  66 §G7 credit and design 47 FX): evolve the level (and optionally slope) by a small
  mean-reverting step each period. Keep it behind a flag so deterministic runs stay
  byte-identical.

## 7. Out of scope / later

- **Convexity** — still second-order after modified duration (design 28 §11); the mark
  stays linear in Δrate. A curve twist already improves fidelity far more than convexity.
- **Real vs nominal curve for TIPS (design 66 §G5)** — a separate *real* curve would
  let TIPS price off real yields; deferred (TIPS today indexes principal to CPI, which
  is the dominant effect). Flag as a follow-on once the nominal curve exists.
- **Credit curves (design 66 §G7)** — a per-rating spread *over* the Treasury curve is
  the natural composition once both this design and G7 exist (G7 spread + this curve).
- **FX-linked / foreign curves** — AU and US curves are independent here; a
  cross-currency basis is out of scope.

## 8. Testing plan

- **Unit** — `resolveYield` / `interpolateSpread`: flat (no shape) ≡ anchor at every
  tenor (the back-compat identity); an upward shape returns level+spread with linear
  interpolation and endpoint clamping; `null` tenor ⇒ 5y fund point.
- **Consumer reroute** — each of the five sites: with a flat curve, byte-identical to
  the pre-67 single-rate result (guards back-compat); with a sloped curve, a long bond
  stamps/rolls/marks at a higher yield than a short one.
- **Term premium (e2e)** — a G8 ladder on an upward curve earns more than the same
  ladder on a flat curve (the payoff); an inversion shock marks the long rung down.
- **Golden** — Phase 1 unmoved (flat); Phase 2 a single deliberate re-baseline.
- **Determinism** — with stochastic evolution off, runs are byte-for-byte identical
  (JOURNAL_STRICT green); the `sim.rng` path is flag-gated.

## 9. Open questions (for owner review)

1. **Representation** — anchor + shape overlay (C, recommended), discrete tenor rate
   keys (A), or parametric Nelson–Siegel (B)?
   Answer:
2. **Default curve** — ship Phase 1 flat (golden-neutral, curve opt-in) then seed a
   sloped default in Phase 2 with one re-baseline (recommended), or seed the slope
   immediately?
   Answer:
3. **Fund tenor** — resolve a perpetual fund (`maturityDate == null`) at the 5y
   `defaultDuration` point (recommended, keeps flat-curve identity), or at a distinct
   configurable fund tenor?
   Answer:
4. **Curve dynamics source** — scheduled twists + named regime shocks only, or also
   stochastic (mean-reverting) evolution via the idle `sim.rng`?
   Answer:
5. **Interpolation** — linear between anchor points (simplest), or monotone-cubic
   (smoother, avoids kinks at the anchors)?
   Answer:
6. **AU curve** — an independent AU shape off the `FIXED_INCOME_AU` anchor (recommended),
   or share the US shape until an AU-specific scenario needs it?
   Answer:

## 10. Relationship to other designs

Depends on **design 28** (the duration mark this generalizes — the mark's Δrate becomes
per-tenor) and **design 66** (the maturity/tenor primitive `Holding.maturityDate` /
`yearsToMaturity` from §G4, and the five rate consumers G1/G10b/G8 this reroutes; it
directly answers 66 §8 open-question #3). Mirrors the **design 56** Prime pattern (a
base rate + a derived overlay propagated each period by a small reducer, cf.
`PrimeRelinkReducer`) and the **design 47** time-varying-rate schedule pattern.
Curve-shape shocks extend the **design 21** regime vocabulary. Stochastic evolution is
a home for the idle [[sim-rng-unused-in-loop]] (shared interest with design 66 §G7
credit and design 47 FX). Unlocks the term premium that makes **design 66 §G8** ladders/
barbells more than a reinvestment-timing lever.
