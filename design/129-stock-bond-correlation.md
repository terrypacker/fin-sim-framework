# 129 — Stock–bond correlation as a regime property (design 126 G3)

**Status:** PROPOSED (15 Oct 2026). Expands design 126 §5, which recorded only a direction. It
opens with a measurement step that decides whether the regime half is built (§6).

**Related:** design 126 §5 (the gap), design 67 §6 (the stochastic yield-curve level), design 74
(the equity market draw), design 102 (the equity bootstrap), design 103 §5.1 (joint mode: yields
from history), design 120 §5.4 (the stamped equity market shock and the FX correlation this
copies), design 121 §6 (gold's correlated draw, the same pattern), design 107 §15.5
(`rngStreams`), design 125 (TIPS market real yield), design 21 (regime legs, `currentFactor`).

## 1. The problem

A regime study needs to say "while this regime is active, stocks and bonds fall together" (the
1970s, 2022) or "bonds hedge stocks" (2000–2020). Today:

- **Deterministic runs** already express it. A regime leg sets the centre of both: the
  stagflation preset raises the fixed-income rate and cuts equity in the same window.
- **Monte Carlo** cannot. The random parts are independent. The yield-curve tick draws its
  level shock from its own stream, and the equity tick draws the market factor (or replays a
  historical year) from another. The correlation of the noise is 0 in every year, whatever
  regime is active.
- **The one exception** is `HISTORICAL_JOINT` inflation (design 103 §5.1). There the yield
  shock is the US 10-year change of the historical year the equity bootstrap replayed, so the
  correlation is that of whichever era the block came from. Nobody can set it.

What history says, on the model's own horizon (annual), from series already packaged:

| window | years | n | ρ(equity, bond) |
|---|---|---|---|
| post-war, before the inflation | 1952–1972 | 21 | −0.13 |
| 1970s stagflation | 1973–1982 | 10 | +0.42 |
| high-inflation era | 1966–1997 | 32 | +0.53 |
| disinflation | 1983–1999 | 17 | +0.61 |
| low inflation | 2000–2020 | 21 | −0.53 |
| 2000 to the end of the series | 2000–2023 | 24 | −0.33 |
| whole post-war window | 1952–2023 | 72 | +0.16 |

Shiller S&P 500 real total return against −Δ(US 10-year yield), January to January;
`scripts/lab/stock-bond-correlation.mjs`. Ten points are noisy: +0.42 on n = 10 has a 95%
interval of about −0.3 to +0.8.

The model's 0 sits between the eras. In an inflationary regime its noise diversifies better
than history did, so it understates the risk. In a 2000–2020-like world it diversifies worse,
so it overstates it. **G3 can move a result either way.**

## 2. What exists (confirmed in code, 15 Oct 2026)

| piece | today |
|---|---|
| Yield noise | `YieldCurveTickHandler.call`: per country, one OU step `prev·e^(−k) + σ·z`, with `z = gaussianFrom(rng)` and `rng` the `yield` substream under `rngStreams`. Defaults σ = `yieldCurveVol` 0.01, k = 0.3. Scheduled only when `yieldCurveStochastic` is on. |
| Event order | Equity, property, inflation and yield ticks all fire at year-end. The yield tick is pushed with the default order 0, *before* the equity tick, so today it fires first, except in joint mode (`order: 3`). |
| Bond return | `YieldCurveReducer` folds the level onto `effectiveInterestRates[FIXED_INCOME_*]`. `BondPriceAdjustReducer` marks funds and bonds by `−duration × Δrate × value`. Default duration is 5 (`RATE_KEY_META`). |
| The equity shock | Design 120: the equity tick at 31 Dec of year Y stamps `equityMarketShock = { year: Y + 1, z }`. For the Gaussian models z is `zMarket`; for the bootstrap it is `marketDev / vol`. It is only stamped when `_stampMarketShock` says the FX path reads it. |
| The pattern | Gold (design 121 §6): `z_gold = ρ·z_market + √(1 − ρ²)·ε`. FX (design 120 §5.4) does the same and still takes one draw per step, so its draw sequence is the same with ρ on or off. |
| Regime legs | `EconomicShockHandler` copies each leg's `regime.*` adjustments onto an `activeRegimes` entry, which carries `currentFactor`, the recovery weight (1 at arrival, fading). |

## 3. The design

### 3.1 The correlation and its sign

`stockBondCorrelation` (ρ) is the correlation between the *random parts* of the stock and bond
returns. Bond return ≈ −D·Δy, so the yield innovation gets −ρ:

    z_yield = −ρ · z_eq + √(1 − ρ²) · ε

- **ε** is exactly the draw the tick takes today, from the same stream and in the same place.
  The number of draws does not change, so the cursor and every other process's draws are the
  same with ρ on or off. It is one ε per country, as now.
- **At ρ = 0** the tick uses ε directly, exactly as today, rather than computing `0·z + 1·ε`.
- **The realised correlation comes out a little under ρ.** The OU step adds `−(1 − e^(−k))·prev`
  to Δy, which is uncorrelated with this year's equity move. Bootstrap years are not Gaussian
  either. Tests measure the realised value rather than assume it (§8).

### 3.2 Where ρ comes from

| source | meaning |
|---|---|
| `stockBondCorrelation` (run parameter, ECONOMIC_REGIMES, default **0**, −1…1, shown when `yieldCurveStochastic` is on) | The calm-world value, every year that no regime overrides it. 0 is today's behaviour. |
| `regime.stockBondCorrelation` on a leg | The regime's value while the leg is active. A preset puts it on the leg whose window is the episode: for stagflation, its `inflation` leg (L, 120 months, the decade). |
| `shocks[i].stockBondCorrelation` on a plan entry | Overrides the preset's value on every leg that carries one, the way `severity` overrides depth. Lets the editor set it per shock row without a custom preset. |

**Composition** at each tick, over active regimes that carry the field:

    ρ = clip( ρ_base + Σ_i f_i · (ρ_i − ρ_base),  −1, 1 ),   f_i = clamp(currentFactor_i, 0, 1)

- A single regime pulls ρ from the base to its own value and fades back on its recovery
  profile.
- Two overlapping regimes add their pulls.
- Rebound profiles can push `currentFactor` below 0. The clamp keeps that from flipping the
  pull.

**Timing.** The tick at 31 Dec of Y draws the shock that year Y + 1's bonds carry, and it reads
the regimes in force at that moment. A regime that arrives during Y + 1 affects the noise from
the next tick on. Every annual tick has this one-year lag.

### 3.3 Which equity shock

The yield tick reads the same standardised shock design 120 defined, `state.equityMarketShock`
with `year === currentYear + 1`. Two compile-time switches make that possible:

1. **The stamp** is written when `_stampMarketShock` is true *or* bond correlation is in play.
2. **The order.** The yield tick gets `order: 3` when correlation is in play, so it fires after
   the equity tick (joint mode already does this).

**"In play"** means: `yieldCurveStochastic` and `equityReturnStochastic` are both on, and either
the base is not 0 or some scheduled shock carries the field. Random arrivals are drawn at compile
(design 126 §3.2), so the answer is known there. A plan not in play keeps its exact event order
and state keys, so goldens and existing stochastic runs are byte-identical.

**Reordering and the RNG.**
- Under `rngStreams` (the study default) each tick draws from its own year-keyed substream, so
  reordering changes no draw.
- Without `rngStreams` the ticks share one cursor, so reordering changes which uniform each
  tick takes. That only happens in runs that opt in, and the help says so.

**No equity shock that year** (stochastic equity off, or the run's first year, whose growth
carries no draw): the yield draw is uncorrelated, as FX does.

**An inert lever warns.** If ρ is set anywhere but either flag is off, the loader warns once and
the lever is tagged inert (the lever-hygiene rule: a lever that does nothing must say so).

### 3.4 Joint mode

Under `HISTORICAL_JOINT`, yields come from the replayed year, and history already carries that
era's correlation. ρ is **ignored there, with a loader warning**. Blending an authored ρ into a
historical change would double-impose co-movement. See Q3.

### 3.5 Australia

The tick moves both countries' levels, each with its own ε. Both correlate with the one market
factor; the AU sleeve loads on it by β. Per-country ρ is not proposed (Q5).

### 3.6 What the level moves

The level moves `effectiveInterestRates[FIXED_INCOME_*]`, so it reaches:
- **bond funds and individual bonds**, through the duration mark;
- **TIPS `MARKET` rungs**, at build and roll only: their real coupon is derived from the
  nominal yield minus expected inflation (design 125).

Step 0 checks whether a held TIPS rung's *mark* follows the level. If it doesn't, the TIPS lever
is unaffected by G3 and the design says so.

The level does not reach prime, loans, cash or equity.

### 3.7 Deterministic runs

No tick fires, so there is no effect. The legs already set both centres (§1).

### 3.8 Presets

**`STAGFLATION_1970S_LITE`** gets ρ = **+0.4**, on its `inflation` leg. That is the 1973–82
measurement (+0.42), rounded toward the wider 1966–97 era (+0.53). Both are in §1.

**The crash presets stay without the field in step 1.** This covers dot-com, the GFC and the
lost decade, whose own years ran negative (2000–2020: −0.53). Adding the field would make every
crash milder in every stochastic plan that uses one, because bonds would hedge, and that should
be a separate, deliberate call (Q2).

### 3.9 Editor, help, MC

- **The parameter description** lives in the toolset, so `help/REFERENCE.md` regenerates. The
  stamped topic the gate names is fixed and restamped.
- **The shock row** in the editor (`ShockList`) gets an optional number, "Stock–bond
  correlation", blank by default, which keeps the preset's value. It is shown when
  `yieldCurveStochastic` is on. The `node:` topic is restamped.
- **The base ρ as an MC sweep axis** (design 98) would let one MC answer "which world are we
  in". It is not in step 1 (Q6).

## 4. How big, before building

**Shape on its own.** Take a 60/40 portfolio with the defaults: σ_equity 0.18,
`yieldCurveVol` 0.01, duration 5. The bond noise is ≈ 5% a year (D·σ). Portfolio sd:

    σ_p² = 0.6²·0.18² + 0.4²·0.05² + 2·0.6·0.4·0.18·0.05·ρ

| ρ | portfolio sd |
|---|---|
| −0.5 (2000–2020) | 9.95% |
| 0 (today) | 10.98% |
| +0.45 (1970s) | 11.84% |

That is about ±0.9 points of sd each way.

**Why this can't be dismissed on paper, as G2 was.** Failure is a tail and sequence property:
what matters is whether bonds fall *in the same years* as stocks while the plan is drawing. It
also adds to a regime that already moves both centres. So the gate is a paired MC measurement,
not a formula.

## 5. What it does not cover

**The inflation channel.** Under `GAUSSIAN` stochastic inflation an inflation surprise does not
move nominal yields at all. A hot inflation path therefore costs nominal bonds real value but no
price loss. That missing Fisher link is the structural reason the 1970s correlation was
positive. G3 states the correlation in reduced form; it does not supply the cause.

Tying the yield innovation to the inflation surprise is a separate gap, recorded here and in
design 126 §5 (Q4). If step 0 shows G3 matters, the inflation link is the next thing to
measure.

## 6. Phasing

0. **Base ρ and the measurement.**
   - Build: the run parameter only, plus §3.1, §3.3 (stamp, order, in-play gate, inert warning),
     §3.4 and the §3.6 TIPS check. Tests per §8.
   - Measure: a paired MC on the regime study's plan, n = 400, `rngStreams` on. Arms: base ρ ∈
     {−0.5, 0, +0.45}, under the baseline and stagflation regimes. Read the paired discordant
     counts.
   - **Gate:** build step 1 if stagflation's failure rate moves by **3 points or more** between
     ρ = 0 and +0.45, paired (Q1).
   - The base parameter stays either way: "which world" is a study question on its own.
   - Following the deferred-reruns practice, the code and tooling ship first; the MC can run
     later.
1. **The regime half** (if the gate passes): the leg field, the entry override, the composition
   (§3.2), the stagflation preset value (§3.8), the editor field and help.
2. **Optional:** the MC sweep axis (§3.9).

## 7. Open questions

1. **The gate threshold.** Proposed: 3 points of failure rate, paired, under stagflation.
2. **The crash presets.** Leave them without ρ (proposed), or give them their own era's negative
   value? The second is historically right but makes every MC crash milder, a behaviour change
   for every stochastic plan that uses one.
3. **Joint mode.** Ignore ρ and warn (proposed), or blend?
4. **The inflation channel** (§5). A separate design after step 0, or fold it into step 1?
5. **Per-country ρ.** Proposed no: one global value, AU through its β.
6. **The default base.** 0 (proposed: changing it moves every stochastic plan), or the post-2000
   −0.33 / −0.53? A study can set it either way.

## 8. Test plan

1. **Off is byte-identical.** With the base 0 and no leg carrying the field, goldens are
   unchanged, and a seeded stochastic run's full state JSON equals the pre-change run.
2. **Same draws.** Under `rngStreams`, ε is the same sequence with ρ on and off; only z_yield
   differs.
3. **Sign.** ρ = +0.9: in a year whose equity shock is strongly negative, the bond fund's mark is
   negative. ρ = −0.9: positive.
4. **Realised correlation.** The handler is driven directly with a long sequence of equity
   shocks, and the correlation of the innovations is −ρ within tolerance. This is checked for
   the Gaussian and bootstrap z.
5. **Order and stamp.** The yield tick fires after the equity tick and the stamp exists only when
   in play. Otherwise the event list and state keys equal today's.
6. **No shock that year.** The first year, or equity stochastic off: the yield draw equals the
   uncorrelated one.
7. **Warnings.** Inert (a flag off), and joint mode.
8. **Step 1: composition.** Two overlapping legs, a fading `currentFactor`, a rebound factor
   below 0, and the clip. The entry override replaces the preset's value.
9. **Step 1: a scheduled stagflation shock.** ρ moves to the preset's value at arrival and back
   to the base as the leg recovers. Under random arrival (design 126 G1) it follows the drawn
   date.
