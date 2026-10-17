# 129 — Stock–bond correlation as a regime property (design 126 G3)

**Status:** COMPLETE at step 0 (16 Oct 2026). **Step 1, the regime half, is not built: it failed
its gate on a short and on a long bond sleeve (§6.1), and the author closed it.** Step 0 (the base
ρ, 603b7d5c) and the MC runner warning (§3.4) stay. Rev 3 corrects §1:
Monte Carlo's *default* is joint mode, not independent noise. Step 0's first gate run on the
study plan gave byte-identical arms, because MC's `mcInflationModel: AUTO` runs
`HISTORICAL_JOINT` whenever equity uses the bootstrap. The fix is in §1, §3.4 (now "joint mode
is the MC default"), §6 (the measurement now forces GAUSSIAN, with joint-mode reference arms)
and the new Q7 (what step 1 means under joint mode). Later on 16 Oct the author decided Q7 = (b), and
the runner-side MC warning (§3.4) was built. Rev 2, the same day, re-checked the design
against the code before building: it corrected the first-year case, the TIPS check, the +0.45
arm and the Q6 cross-reference, and added the timing, cross-country and allow-list notes. The
author settled Q2 and Q4 on 15 Oct, and Q3, Q5 and the MC axis's move into step 0 on 16 Oct.
Q1's 3-point gate was confirmed when the MC was read. Q6 is open. Expands design 126 §5, which recorded only a direction. It
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
- **Monte Carlo, by default, replays history's correlation.** `mcInflationModel` defaults to
  `AUTO`, and AUTO resolves to `HISTORICAL_JOINT` whenever the MC equity model is the historical
  bootstrap. The bootstrap is also the default (`mcEquityReturnModel`). In joint mode
  (design 103 §5.1) the yield shock is the US 10-year change of the year the equity bootstrap
  replayed. So the noise carries the correlation of whichever era each 5-year block came from:
  +0.16 across the 1951–2023 window, the same as the table below on the model's own series.
  Nobody can set it, and no regime moves it. A stagflation regime drawn in the default MC gets
  blocks from random eras, 2000–2020 hedging years included.
- **Everywhere else the noise is independent**: a single seeded stochastic run (whose
  `inflationModel` is GAUSSIAN unless set), and any MC with a Gaussian equity model or a
  non-joint inflation process. There the yield tick draws its level shock from its own stream
  and the equity tick draws from another, so the correlation is 0 in every year, whatever
  regime is active.

(Rev 1 said MC was always at 0, with joint mode as an exception. It is the other way round for
default MC, and step 0's first gate run, which came out byte-identical, is how that was found.)

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

Both of the model's values sit between the eras: 0 outside joint mode, and +0.16 on average
inside it. In an inflationary regime the noise diversifies better than history did, so it
understates the risk. In a 2000–2020-like world it diversifies worse, so it overstates it.
**G3 can move a result either way.** For the default MC the gap is smaller than rev 1 assumed:
a stagflation regime would move the correlation from about +0.16 to +0.4, not from 0.

## 2. What exists (confirmed in code, 15 Oct 2026)

| piece | today |
|---|---|
| Yield noise | `YieldCurveTickHandler.call`: per country, one OU step `prev·e^(−k) + σ·z`, with `z = gaussianFrom(rng)` and `rng` the `yield` substream under `rngStreams`. Defaults σ = `yieldCurveVol` 0.01, k = 0.3. Scheduled only when `yieldCurveStochastic` is on. |
| Event order | Equity, property, inflation and yield ticks all fire at year-end (31 Dec, `startOffset: 1`), so they share every date. The yield tick is pushed with the default order 0, *before* the equity tick, so today it fires first, except in joint mode (`order: 3`). |
| Bond return | `YieldCurveReducer` folds the level onto `effectiveInterestRates[FIXED_INCOME_*]`. `BondPriceAdjustReducer` marks funds and bonds by `−duration × Δrate × value`. Default duration is 5 (`RATE_KEY_META`). Both run on a period advance, and the US advance is 1 Jan, so a draw on 31 Dec of Y is marked in full on 1 Jan of Y + 1. The mark reprices every bond holding on either country's advance, so AU bonds also move on 1 Jan. |
| TIPS | Ladder rungs carry `rateKey: FIXED_INCOME_*` whether or not they are inflation-linked, so a TIPS rung is marked by the *nominal* level's Δ times `min(D, ttm)`. It is not pulled to par, and it redeems at its indexed principal whatever the mark says (`BondMaturityReducer`, design 93 §5.3). |
| The equity shock | Design 120: the equity tick at 31 Dec of year Y stamps `equityMarketShock = { year: Y + 1, z }`. For the Gaussian models z is `zMarket`; for the bootstrap it is `marketDev / vol`. It is only stamped when `_stampMarketShock` says the FX path reads it. |
| The pattern | Gold (design 121 §6): `z_gold = ρ·z_market + √(1 − ρ²)·ε`. FX (design 120 §5.4) does the same and still takes one draw per step, so its draw sequence is the same with ρ on or off. |
| Regime legs | `EconomicShockHandler` copies a fixed allow-list of each leg's `regime.*` fields onto an `activeRegimes` entry. A new field is dropped unless it is added to that list. The entry carries `currentFactor`, the recovery weight (1 at arrival, then fading), which `RegimeApplyReducer` recomputes on each period advance and `RECOMPUTE_REGIMES`. |
| Existing correlation params | `goldEquityCorrelation` and `fxEquityCorrelation` are plain run parameters with `mc: true`. Gold also has a disabled row in `intl-retirement-mc-config.js`. |

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
  to Δy, which is uncorrelated with this year's equity move. In steady state that adds
  `(1 − e^(−k))² / (1 − e^(−2k))` ≈ 0.15 of the innovation variance at k = 0.3, so the
  realised value is ≈ 0.93ρ. Bootstrap years are not Gaussian either. Tests measure the
  realised value rather than assume it (§8).

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
the regimes in force at that moment, with each `currentFactor` as it was last recomputed. A
regime that arrives during Y + 1 affects the noise from the next tick on. Every annual tick
has this one-year lag.

**Within the year the bond moves first.** The yield move is marked in full at the 1 Jan
advance (§2), while year Y + 1's equity draw is credited month by month (design 127). A
correlated bad year therefore shows the bond loss in January and the equity loss across the
year. On annual returns the two are contemporaneous, which is what ρ states. The lumpy
January mark is today's behaviour, and this design leaves it alone.

**The leg field must be added to `EconomicShockHandler`'s allow-list** (§2), and also to the
regime serialisation, or it never reaches `activeRegimes`.

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

**No equity shock that year.** The yield and equity ticks share every date (§2), and the first
yield tick comes at the first year-end, straight after the first equity draw. The run's first
year therefore has no yield tick to correlate. This is unlike FX, which ticks monthly through a
first year that carries no draw. So when correlation is in play, every yield tick finds a
stamp. The handler still checks `year === currentYear + 1` and falls back to the
uncorrelated draw if the stamp is missing. That is a guard, not a path any in-play run takes.

**An inert lever warns.** If ρ is set anywhere but either flag is off, the loader warns once and
the lever is tagged inert (the lever-hygiene rule: a lever that does nothing must say so). The
CLI tools swallow loader warnings, so a test calls the warning function directly rather than
reading CLI output.

### 3.4 Joint mode, the MC default

Under `HISTORICAL_JOINT`, yields come from the replayed year, and history already carries that
era's correlation. The base ρ is **ignored there**. Blending an authored ρ into a historical
change would double-impose co-movement (Q3, decided).

**This is the default MC** (§1), so in the default MC the base ρ does nothing. Two
consequences:

- **The loader warning cannot see it.** The MC runner resolves `AUTO` per iteration, after the
  load, so the plan the loader checks still says GAUSSIAN. The parameter description says so
  and tells the reader to set the MC inflation process to GAUSSIAN to sweep ρ. **The runner
  warns too (built 16 Oct).** It applies MC's own process switches to the batch's base (the
  step `perturbParams` takes per path, now `applyMcPaths`) and runs the §3.3 check on that. A ρ
  that every path ignores is reported in `summary.provenance.inertWarnings`, printed by
  `mc-run` and `mc-report`, and shown in the results panel's banner. A sampled ρ row counts as
  set even with a 0 centre.
- **A regime ρ overrides history while it is in force** (Q7 (b), decided). Only the base is
  ignored. Step 1 builds the override.

### 3.5 Australia

The tick moves both countries' levels, each with its own ε. Both correlate with the one market
factor; the AU sleeve loads on it by β. Per-country ρ is not proposed (Q5).

A side effect: today the US and AU level draws are independent. With ρ set, both load on the
same z_eq, so they correlate with each other at ρ² (0.16 at ρ = 0.4). That moves toward
reality, since the two 10-year yields co-move strongly, but it is not calibrated. A separate
US–AU rate correlation is out of scope.

### 3.6 What the level moves

The level moves `effectiveInterestRates[FIXED_INCOME_*]`, so it reaches:
- **bond funds and individual bonds**, through the duration mark;
- **TIPS `MARKET` rungs**, at build and roll: their real coupon is derived from the nominal
  yield minus expected inflation (design 125);
- **every held TIPS rung's mark** (checked in code, §2). The mark moves with the nominal
  level, so a TIPS sold mid-life feels G3. One held to maturity does not, because it redeems
  at its indexed principal.

Marking a TIPS on the nominal level is a model approximation that predates this design: a real
TIPS price follows the real yield. Under a positive ρ in an inflationary regime this makes
TIPS fall with stocks more than they did. That is flagged separately and not fixed here.

The level does not reach prime, loans, cash or equity.

### 3.7 Deterministic runs

No tick fires, so there is no effect. The legs already set both centres (§1).

### 3.8 Presets

**`STAGFLATION_1970S_LITE`** gets ρ = **+0.4**, on its `inflation` leg. That is the 1973–82
measurement (+0.42), rounded down. The wider 1966–97 era (+0.53) would argue for more, but
ten annual points have an interval from about −0.3 to +0.8, so the preset takes the smaller,
episode-specific value. Both are in §1.

**Every other preset stays without the field in step 1.** That includes the GFC, COVID,
dot-com, lost-decade, railroad-panic, AI-capex, mild-correction and curve presets. The modern
crashes' own years ran negative (2000–2020: −0.53). Adding the field would make every
crash milder in every stochastic plan that uses one, because bonds would hedge, and that should
be a separate, deliberate call (Q2).

### 3.9 Editor, help, MC

- **The parameter description** lives in the toolset, so `help/REFERENCE.md` regenerates. The
  stamped topic the gate names is fixed and restamped.
- **The shock row** in the editor (`ShockList`) gets an optional number, "Stock–bond
  correlation", blank by default, which keeps the preset's value. It is shown when
  `yieldCurveStochastic` is on. The `node:` topic is restamped.
- **The base ρ as an MC sweep axis** (design 98) would let one MC answer "which world are we
  in". Following the gold precedent (§2), that is `mc: true` plus a disabled row in
  `intl-retirement-mc-config.js`. It is built in step 0 (§6; the author, 16 Oct 2026). It is
  a separate question from the default base (Q6).

## 4. How big, before building

**Shape on its own.** Take a 60/40 portfolio with the defaults: σ_equity 0.18,
`yieldCurveVol` 0.01, duration 5. The bond noise is ≈ 5% a year (D·σ). Portfolio sd:

    σ_p² = 0.6²·0.18² + 0.4²·0.05² + 2·0.6·0.4·0.18·0.05·ρ

| ρ | portfolio sd |
|---|---|
| −0.5 (2000–2020) | 9.95% |
| 0 (today) | 10.98% |
| +0.4 (the §3.8 preset value) | 11.74% |

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
design 126 §5 (Q4). It was to be measured next if step 0 showed G3 mattered. It did not (§6.1),
so the link waits for its own reason.

## 6. Phasing

0. **Base ρ and the measurement.**
   - Build: the run parameter (with `mc: true` and a disabled MC row, §3.9), plus §3.1, §3.3
     (stamp, order, in-play gate, inert warning) and §3.4. Tests per §8. (The TIPS question this step used to carry is answered in §2.)
   - Measure: a paired MC on the regime study's plan, n = 400, `rngStreams` on, with
     **`mcInflationModel: GAUSSIAN` in every ρ arm**, since the default joint mode ignores ρ
     (§3.4). Arms: base ρ ∈ {−0.5, 0, +0.16, +0.4}, under the baseline and stagflation regimes.
     +0.4 is the value step 1 would put on the preset. +0.16 is what joint mode replays on
     average, so the +0.16 → +0.4 step is the size of the gap in the default MC. Two reference
     arms run the same regimes under the default (joint). Read the paired discordant counts.
   - **Gate:** build step 1 if stagflation's failure rate moves by **3 points or more** between
     ρ = 0 and +0.4, paired (Q1). Report the +0.16 → +0.4 move beside it, because that is what
     step 1 would change in the study's default MC, where Q7 (b) lets a regime ρ act.
   - The base parameter stays either way: "which world" is a study question on its own.
   - Following the deferred-reruns practice, the code and tooling ship first; the MC can run
     later.
1. ~~**The regime half**~~ (if the gate passes): the leg field, the entry override, the composition
   (§3.2), the stagflation preset value (§3.8), the editor field and help, and Q7 (b)'s
   joint-mode override with its keyed ε stream. **Not built: the gate failed (§6.1).**

### 6.1 The gate result (16 Oct 2026)

Measured on the regime study's plan as §6 specifies (n = 400, paired, GAUSSIAN in every ρ arm).
The runs and tables live with the study, not here.

- **ρ 0 → +0.4 under stagflation moved the failure rate by +0.25 points**, against a gate of 3.
  Only 5 of 400 worlds changed outcome, and they split both ways. The +0.16 → +0.4 step, which is
  what step 1 would change in the default MC, moved one world. ρ did nothing under the baseline.
- **Why so small: the plan's bond sleeve is short.** A trace of the worlds showed that the sleeve
  is sold continually as the spending buffer, so marks are realised. But its effective duration is
  about 2 years, so a year's rate mark is about 0.5% of liquid wealth. ρ does reach the marks
  (realised correlation +0.26 at ρ +0.4). The term is simply small next to equity risk.
- **On a long sleeve the gate fails too.** The same pair with a 20-rung ladder (effective duration
  about 11, marks about 10× larger) moved the failure rate by +0.5 points, and 12 worlds changed
  outcome, splitting 5 rescued to 7 broken. The reading, which was not checked: stagflation's damage comes
  from the regime's scripted path (its inflation centre and yield level), which ρ does not touch. ρ
  only reshapes the noise around that path, and the OU level reverts.
- **The joint-mode reference arms differed from GAUSSIAN by far more than any ρ.** That is the
  inflation and yield process changing, not correlation, and it is a separate question.

**Closed (the author, 16 Oct 2026): step 1 is not built.** The base ρ stays as a "which world"
setting and an MC row. Q7 (b) remains the answer should the regime half ever be reopened, for
instance by a regime whose damage is noise-driven rather than scripted.

## 7. Open questions

1. **The gate threshold.** Proposed: 3 points of failure rate, paired, under stagflation. *Deferred (the author, 15 Oct 2026): reviewed when step 0 starts.* *Reviewed (the author, 16 Oct 2026): 3 points stays the working gate, confirmed when the MC result is read.*
2. **The crash presets.** *Decided (the author, 15 Oct 2026): left without ρ.* The alternative was their own era's negative
   value: historically right, but it makes every MC crash milder, a behaviour change
   for every stochastic plan that uses one.
3. **Joint mode.** *Decided (the author, 16 Oct 2026): ignore ρ and warn.* Blending would
   double-impose co-movement history already carries.
4. **The inflation channel** (§5). *Decided (the author, 15 Oct 2026): its own design, after step 0.*
5. **Per-country ρ.** *Decided (the author, 16 Oct 2026): no.* One global value, AU through its β.
6. **The default base.** *Deferred (the author, 15 Oct 2026).* 0 (proposed: changing it moves every stochastic plan), or the post-2000
   −0.33 / −0.53? A study can set it either way.
7. **A regime ρ under joint mode (rev 3).** The default MC replays history's yields (§3.4).
   What should a leg's `stockBondCorrelation` do there?
   - **(a) Nothing, as for the base ρ.** This is consistent with Q3, but the regime half then
     never touches the default MC, the run the regime study reads.
   - **(b) The regime overrides history while it is in force** (proposed). While a leg with the
     field has `currentFactor > 0`, the yield tick swaps the replayed change for
     `−ρ_r·z_eq + √(1 − ρ_r²)·ε`, scaled to the same `yieldCurveVol`. It blends back to the
     replayed change by `currentFactor`, and outside the regime joint mode is untouched. This
     doesn't double-count, because nothing is added to the historical change. Inflation keeps
     replaying, so yield and inflation stop sharing a year for the regime's window, but the
     leg already sets the inflation centre there. It needs an ε. That has to come from the
     yield stream, which joint mode doesn't draw today, so the draw must come from a keyed
     stream (the gold precedent) to leave every other draw unchanged.
   - **(c) The regime picks the era.** While a leg names an era (say 1966–1982), the bootstrap
     draws its blocks from that era, and equity, inflation and yields all follow coherently.
     This is the most faithful option and the largest change. It also double-counts: era
     deviations are re-centred on the post-war mean, so 1970s blocks are negative on average,
     on top of the leg's own equity cut. It would need per-era re-centring.

   Proposed: (b). It keeps "a regime states its correlation" true in every MC mode, at the cost
   of one keyed draw. *Decided (the author, 16 Oct 2026): (b).* Not built, because step 1 failed
   its gate (§6.1).

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
6. **No stamp.** The handler is driven directly with no `equityMarketShock`, or with one for the
   wrong year: the yield draw equals the uncorrelated one. With equity stochastic off the run
   is not in play (§3.3), which test 5 covers.
7. **Warnings.** Inert (a flag off), and joint mode. The MC runner: MC `AUTO` ⇒ joint reports
   ρ ignored and names the MC setting; GAUSSIAN is silent; the yield curve off is inert even
   though MC turns equity on; a sampled row with a 0 centre warns; the base is not mutated.
8. **Step 1: composition.** Two overlapping legs, a fading `currentFactor`, a rebound factor
   below 0, and the clip. The entry override replaces the preset's value.
9. **Step 1: a scheduled stagflation shock.** ρ moves to the preset's value at arrival and back
   to the base as the leg recovers. Under random arrival (design 126 G1) it follows the drawn
   date.
10. **Step 1: joint mode (Q7 (b)).** Under HISTORICAL_JOINT with no regime carrying ρ, the run
    is byte-identical to today's. With a leg in force, the yield shock is the blend of the
    replayed change and the correlated draw by `currentFactor`; the keyed ε stream leaves every
    other draw unchanged; outside the leg's window the replayed change is used as is.
