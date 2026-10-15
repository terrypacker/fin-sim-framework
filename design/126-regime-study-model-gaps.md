# 126 — Model gaps that limit regime studies

**Status:** PROPOSED (15 Oct 2026). Collects five gaps a macro-regimes study ran into, each of
which is a modelling change rather than a fix. The study judged the first two (§3, §4) able to
change a conclusion; the other three (§5–§7) are recorded with a direction and left open.

**Related:** design 121 (shock legs, `startMonths`, phased presets), design 103 (stochastic
inflation, the HISTORICAL_JOINT mode), design 102 (bootstrap equity), design 67 (yield curve and
twists), design 89 (classified spending), design 99 (capital-market assumptions), design 122
(PPP exchange rate), design 97 §20.2 (no clairvoyance).

## 1. Why

A regime study asks "what does this kind of decade do to the plan, and which levers help". Two
properties of the current shock model shape every such answer:

- **Every shock lands on a date the author picked.** A lever whose value depends on timing (a
  pool refill gate, a buffer size, a Roth conversion schedule) is measured against one bust
  date. A study can show a refill rule helps when the bust comes in the first year of
  retirement and still not know whether it helps on average.
- **Inflation is one number per country.** An oil shock is a general inflation leg. Spending that
  is mostly energy, food and transport sees the same rate as spending that is mostly services.

## 2. What exists today (confirmed in code, 15 Oct 2026)

| Gap | Today |
|---|---|
| Random arrival | Each `shocks[]` entry has a `startDate`. MC builds a per-shock `UNIFORM_DATE` variable over a fixed absolute window, 2028-01-01 to 2035-01-01 (`buildShockMcConfigs`, `intl-retirement-mc-config.js`), off by default; `mc-run --shock` switches it on for `shocks[0]` only. The shock always happens, exactly once, and the window does not follow the plan's dates. |
| Energy slice | No per-category price index. `InflationAdjustReducer` inflates `monthlyExpenses` by the country rate. Design 89 classifies spending for reporting, not pricing. |
| Stock–bond correlation | Bond returns come from yield moves (design 67) and regime legs. In MC the two are correlated only through the HISTORICAL_JOINT bootstrap (design 103), which needs stochastic inflation and bootstrap equity together. No authored parameter states it. |
| Valuation | Expected returns are the design 99 CMA totals. No valuation input moves them. |
| Term premium | `yieldCurveTwist` on a regime leg can steepen the curve for a window; no factor lets long yields move for debt reasons independently of inflation. |

## 3. G1 — Random regime arrival (proposed first)

**Goal.** A shock entry can say *when it may happen* instead of *when it happens*: "a dot-com
style bust, some time in the first fifteen years, maybe not at all".

**Proposal: an `arrival` spec on a shock entry.**

```
{ preset: 'DOTCOM_2000_LITE', arrival: { mode: 'WINDOW', fromYears: 0, toYears: 15, probability: 0.6 } }
```

- `FIXED` (absent = today): `startDate` as authored. Every existing plan is unchanged.
- `WINDOW`: with `probability`, the shock happens once, at a uniform month within
  `[simStart + fromYears, simStart + toYears)`. Relative to the plan, so a plan that starts
  later shifts with it.
- `RATE` (later): arrivals as a Poisson process at `perYear`, with `maxCount` and a `minGapYears`
  so two busts cannot overlap absurdly.

**Where the draw lives.** On a dedicated keyed RNG stream (the `rngStreams` mechanism), so a
shock's arrival in path *i* is the same in every arm of a batch and paired A/B analysis still
works. A deterministic single run uses the arrival's expected position (or the authored
`startDate` if one is given), and says so.

**No foresight.** The draw is made at build time, but nothing in the run may read a future
shock's date. Today's readers react on onset (REGIME_AWARE spending, regime-conditioned
allocation), which keeps that property; the design adds a test that no reducer reads
`shocks[].startDate` before the shock is active.

**The existing MC date variable** becomes the `WINDOW` mode with probability 1 and is retired
(its fixed 2028–2035 window is the defect, not the idea). Arm files stamp the arrival spec and
each row records its drawn date(s), as `shockDate` does today.

**Effort.** Moderate: config normalization, the MC draw, the shock handler's schedule (design
121 legs already offset by `startMonths` from whatever start date they get), reporting.

## 4. G2 — An energy slice of spending (proposed second)

**Goal.** An oil shock raises the cost of the energy-heavy part of spending more than the rest,
and can move the AUD (a commodity currency) at the same time.

**Proposal.**
- Per country, an `energyShare` of spending (0 = today) with its own price index:
  `energyInflation = country inflation + energy leg`.
- A shock leg gains `energyPriceAdjustment: { US, AU }`, on the same recovery clock as any leg.
- `InflationAdjustReducer` inflates the two slices separately; `monthlyExpenses` remains their
  sum, so every reader of it is unchanged.
- The oil-to-AUD link uses the existing `fxAdjustment` on the same leg; no new FX mechanism.

**Questions it raises.** Is energy inside the CPI the PPP anchor reads (design 122), or outside
it? (Proposed: inside, weighted by the share, so headline inflation stays the published CPI
concept.) Do tax brackets index to headline or core? (Headline, as today.) Does the stagflation
preset split its inflation leg into core and energy? (Not without a measured split; the presets
stay as they are until one is on disk.)

**Effort.** Moderate: a second expense index, a new leg field, the inflation reducer, presets
untouched.

## 5. G3 — Stock–bond correlation as a regime property (direction only)

Today the sign of the stock–bond correlation is an emergent property of the legs in a
deterministic run and of the bootstrap window in MC. A regime should be able to say "while this
is active, stocks and bonds fall together" (1970s, 2022) or "bonds hedge stocks" (2000s).

Direction: a leg field `stockBondCorrelation` that the stochastic yield-curve tick
(`YieldCurveTickHandler`) uses to correlate its level shock with the year's equity draw while the
leg is active. Off by default; no effect on deterministic runs, where the legs already set both.

## 6. G4 — Valuation-conditioned expected returns (direction only)

A starting valuation (CAPE) should be able to lower the expected equity return for the years
after it, fading as valuation reverts. Direction: an optional `equityValuation` input that shifts
the design 99 anchor by a calibrated function of log CAPE, decaying at a stated speed. This is a
capital-market-assumption change, not a regime, and needs its own calibration against the
sources design 99 uses.

## 7. G5 — Term premium and fiscal dominance (direction only)

Long yields that rise for debt reasons, independently of inflation, cannot be expressed except
by faking it with rate legs. Direction: a term-premium factor on the long end of the curve,
authored per leg (`termPremiumAdjustment`) and optionally stochastic, separate from the level
that tracks policy and inflation.

## 8. Phasing

1. G1 `WINDOW` arrival (with the CRN stream, the no-foresight test, and the old MC date variable
   folded in).
2. G1 `RATE` arrival.
3. G2 energy slice.
4. G3–G5: each gets its own design when a study needs it.

## 9. Open questions

1. **Deterministic runs with a random arrival:** use the window's midpoint, or require an
   authored `startDate` for a deterministic run? (Proposed: midpoint, stated in the run's
   output.)
2. **Several random shocks in one plan:** independent draws, or one regime process that
   chooses which kind arrives? (Proposed: independent for `WINDOW`; a single process is what
   `RATE` would need, decide then.)
3. **Energy share source:** authored per plan, or a default from household spending surveys per
   country? (Proposed: authored, default 0, with sourced suggestions in the help topic.)
4. **Does G1 change existing MC arm files?** Only plans that opt into `arrival`. The retired MC
   date variable changes plans that had it enabled; a migration maps it to `WINDOW` with its
   old absolute window converted to years from the plan start.

## 10. Test plan (G1 and G2, to be written with the code)

- G1: `FIXED` is byte-identical to today; `WINDOW` with probability 1 draws inside the window;
  probability 0 never fires; the same path index draws the same date in two arms; no reducer
  reads an inactive shock's date.
- G2: `energyShare` 0 is byte-identical; an energy leg moves spending by share × leg; headline
  inflation (and PPP, brackets) reads the share-weighted rate.
