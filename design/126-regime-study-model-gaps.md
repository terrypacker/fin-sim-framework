# 126 — Model gaps that limit regime studies

**Status:** rev 2 ACCEPTED (15 Oct 2026, the author: Q1, Q3 and the G2 measurement gate as
proposed). §8 step 1, G1 `WINDOW` arrival, BUILT 15 Oct 2026; step 3, G1 `RATE` arrival (§3.8), BUILT
15 Oct 2026. §8 step 2, the G2 measurement, DONE
15 Oct 2026: under the threshold in every case, so G2 is CLOSED as measured (§4.5). Collects five gaps a
macro-regimes study ran into, each of which is a modelling change rather than a fix. The study
judged the first two (§3, §4) able to change a conclusion; the other three (§5–§7) were recorded
with a direction only. 15 Oct 2026: G3 has its own design, **129** (§5). G4 was checked against
design 99's sources and is CLOSED (§6, the author). G5 stays a direction (§7).

- **rev 2 (15 Oct 2026, review before build):** checked against the code.
  - G1: the arrival draw needs the run's seed at compile, and compile runs *before* the
    scenario's `randomSeed` is applied (§3.3). The deterministic-run rule changes from "the
    window's midpoint" to "drawn from the run's seed", because a midpoint says nothing about a
    `probability` below 1 (§3.4, Q1). The drawn date is no longer in the params, so it is
    stamped in state for MC rows to read (§3.5). The no-foresight claim was too broad: no
    runtime code reads a shock's date, but an MPC rollout restores the snapshot's queue and RNG
    cursor and therefore sees the drawn shock, as it already sees every other draw (§3.6). The
    stream key and two collisions it must avoid are stated (§3.3). Nothing saved uses the old MC
    date variable, so it is removed without a migration (§3.7, Q4).
  - G2: a third spending slice would not survive. Six spending writers rebuild
    `monthlyExpenses` from the essential/discretionary slices or pin it from the CPI level
    (§4.1). And "energy inside the CPI, weighted by the household's share" contradicts "headline
    stays the published CPI": the household's share cannot move the national index. G2 is
    re-cast as a **relative price**: the household's spending index runs at
    `π + (s − w)·r`, where the leg's `r` is energy's move against the basket and `w` is the
    CPI's own energy weight. Headline, PPP and brackets are untouched by construction, and the
    default is `s = w`, not 0 (§4.2). The effect scales with `s − w`, so G2 opens with a
    measurement step that may retire it (§4.4, §8).

**Related:** design 121 (shock legs, `startMonths`, phased presets), design 103 (stochastic
inflation, the HISTORICAL_JOINT mode), design 102 (bootstrap equity), design 67 (yield curve and
twists), design 89 (classified spending, the price level a debit carries), design 26 (the
essential/discretionary slices), design 99 (capital-market assumptions), design 122 (PPP exchange
rate), design 107 §15.5 (`rngStreams`), design 39 §14.9.4 (rollouts restore the snapshot queue),
design 97 §20.2 (no clairvoyance).

## 1. Why

A regime study asks "what does this kind of decade do to the plan, and which levers help". Two
properties of the current shock model shape every such answer:

- **Every shock lands on a date the author picked.** A lever whose value depends on timing (a
  pool refill gate, a buffer size, a Roth conversion schedule, a property sale year) is measured
  against one bust date. A study can show a refill rule helps when the bust comes in the first
  year of retirement and still not know whether it helps on average. An earlier study found a
  property-sale "timing edge" that tracked the authored crash date exactly and fell apart when
  the date was sampled.
- **Inflation is one number per country.** An oil shock is a general inflation leg. Spending that
  is mostly energy, food and transport sees the same rate as spending that is mostly services.

## 2. What exists today (confirmed in code, 15 Oct 2026)

| Gap | Today |
|---|---|
| Random arrival | Each `shocks[]` entry has a `startDate`. MC builds a per-shock `UNIFORM_DATE` variable over a fixed absolute window, 2028-01-01 to 2035-01-01 (`buildShockMcConfigs`, `intl-retirement-mc-config.js`), off by default; `mc-run --shock` switches it on for `shocks[0]` only. The shock always happens, exactly once, and the window does not follow the plan's dates. It is drawn by the MC parameter sampler, so enabling it in one arm shifts every other sampled variable in that arm. MC rows report the date from `params.shocks[0].startDate` (`scripts/lib/mc.mjs`). |
| Shock schedule | `resolveShockEntry` needs a valid `startDate` (else the entry is dropped); `scheduleShock` splits `startMonths` legs into groups and queues `ECONOMIC_SHOCK` + recovery ticks at **compile** (`economic-regimes-toolset.js`). |
| Who reads shock dates | At compile: the toolset's `schedules()`, the MC and optimizer config builders. At run time: nothing reads `params.shocks`; every reactive reader (REGIME_AWARE spending, the behavioural strategies, pool flows) reads `activeRegimes`, set on arrival. |
| Energy slice | No per-category price index. `InflationAdjustReducer` inflates `expenses.essential` and `expenses.discretionary` (design 26) by the residence rate and writes their sum to `monthlyExpenses`. Six other writers rebuild it (§4.1). Design 89 classifies spending for reporting, not pricing. |
| Stock–bond correlation | Bond returns come from yield moves (design 67) and regime legs. In MC the two are correlated only through the HISTORICAL_JOINT bootstrap (design 103), which needs stochastic inflation and bootstrap equity together. No authored parameter states it. |
| Valuation | Expected returns are the design 99 CMA totals. No valuation input moves them. |
| Term premium | `yieldCurveTwist` on a regime leg can steepen the curve for a window; no factor lets long yields move for debt reasons independently of inflation. |

## 3. G1 — Random regime arrival (proposed first)

**Goal.** A shock entry can say *when it may happen* instead of *when it happens*: "a dot-com
style bust, some time in the first fifteen years, maybe not at all".

### 3.1 The spec

```
{ preset: 'DOTCOM_2000_LITE', arrival: { mode: 'WINDOW', fromYears: 0, toYears: 15, probability: 0.6 } }
```

- `FIXED` (absent = today): `startDate` as authored. Every existing plan is unchanged.
- `WINDOW`: with `probability`, the shock happens once, on the first of a uniformly drawn month
  in `[simStart + fromYears, simStart + toYears)`. Relative to the plan, so a plan that starts
  later shifts with it. A `startDate` on a `WINDOW` entry is ignored and the editor hides it.
- `RATE`: arrivals as a Poisson process at `perYear`, with `maxCount` and a `minGapYears`
  so two busts cannot overlap absurdly. Specified in §3.8.

`resolveShockEntry` today drops an entry without a valid `startDate`; with `arrival` it takes
the drawn date instead, and an entry that does not arrive resolves to nothing, exactly like an
empty row. A window running past `endDate` is clipped to it, and the clipped share of the
probability is lost — a shock that would have come after the plan ends did not come.

### 3.2 Where the draw is made: at compile

The drawn date feeds `scheduleShock` unchanged, so design 121's `startMonths` groups, recovery
ticks and level effects follow it with no new runtime machinery. An in-run hazard (draw each
month whether the shock arrives now) was considered and rejected: it would only add a
foresight guarantee that rollouts do not use (§3.6), and it needs a runtime path to enqueue a
shock's event set.

### 3.3 The stream and the seed

- **A keyed stream, always.** The draw uses `sim.keyedRng('shock-arrival:<key>', 0)` whether
  or not `rngStreams` is on, the way gold's ε does (design 121 §6). Drawing it from the shared
  cursor would shift every later draw in every stochastic run, and drawing it from the MC
  parameter sampler would shift every other sampled variable in an arm that enables it. Keyed,
  path *i*'s arrival is the same in every arm of a batch, and the pairing holds.
- **The key.** An optional entry `id`; absent, `<preset or shockId>#<n>`, where *n* counts the
  earlier entries with the same preset. Not the array index: reordering two different shocks
  must not swap their dates. Not the bare preset: two `DOTCOM_2000_LITE` entries would draw the
  same date.
- **The seed at compile.** `ScenarioLoader` compiles from the toolsets (`load()`) *before*
  `_applyRandomSeed` reseeds the sim from the `randomSeed` parameter, because that is when the
  parameters first exist. MC is unaffected (its per-iteration seed is explicit at `buildSim`),
  but a single run with an authored `randomSeed` would draw its arrival from the default seed.
  The compile context gains `rngSeed`, resolved with the same precedence `_applyRandomSeed`
  uses: an explicit `buildSim({ seed })` wins, then `parameters.randomSeed`, then the default.
  A test runs one plan at two `randomSeed`s and asserts the arrival moves.

### 3.4 A single run

A single run draws its arrival from its seed like any other stochastic process: it is
bit-deterministic, and it is the same date MC path *i* gets with that seed. The run's output
names the drawn date, or says the shock did not arrive. (Rev 1 proposed the window's midpoint.
A midpoint has no answer for a `probability` below 1, and it is a third world that neither the
author nor MC runs. An author who wants a fixed date writes `FIXED`.)

### 3.5 Recording the draw

MC rows today read the date from `params.shocks[0].startDate`; with `arrival` the date is not
in the params. The compile stamps `state.shockArrivals = { <key>: 'YYYY-MM-DD' | null }`, which
`mc.mjs` rows, the run summary and the arm files read. Absent when no entry uses `arrival`, so
a `FIXED` plan's state is byte-identical.

### 3.6 Foresight

- **Run-time code.** Nothing reads a shock's date before it is active (§2): readers react to
  `activeRegimes`, set on arrival. The design keeps that and adds a structural test: no handler
  or reducer reads `parameters.shocks`, and no reader of the queue looks ahead for
  `ECONOMIC_SHOCK`.
- **The queue.** The drawn shock is a queued event from compile on, like a `FIXED` one. An MPC
  rollout (design 39) restores the snapshot's queue and carries its RNG cursor forward, so the
  cockpit's projection sees the drawn arrival — as it already sees every equity, inflation and
  FX draw of the path it is on. That is a property of how rollouts treat a stochastic plan, not
  of G1, and it is recorded, not fixed here. G1's claim is the narrower one: no **policy**
  inside a run can see the date.

### 3.7 The old MC date variable

The `shocks[i].startDate` `UNIFORM_DATE` variable is removed (its fixed 2028–2035 window is the
defect, not the idea), along with its row in the MC panel. No saved plan enables it; only tests
and archived study scripts do. `mc-run --shock` becomes "`shocks[0]` arrives once, uniformly over
the run (`WINDOW`, probability 1)", with `--shock-window <from>-<to>` in years to narrow it;
the severity variable stays.

**Stacking.** A random-arrival bust on top of bootstrap equity paths stacks a manufactured
downside on history's own, as `--paths` with `--shock` does today. `mc-run` already warns for
that pair; the warning extends to any `arrival` entry when equity paths are on.

**Effort.** Moderate: entry normalization and the editor, the keyed draw and the compile seed,
state stamping, the MC variable's removal, `mc-run` flags, reporting.

### 3.8 `RATE` arrival (§8 step 3)

```
{ preset: 'MARKET_CRASH_2008_LITE', arrival: { mode: 'RATE', perYear: 0.1, maxCount: 3 } }
```

"A crash of this kind about once a decade, any number of times up to three."

- **Fields.** `perYear` (> 0, required); `fromYears` (default 0) and `toYears` (default the
  run's end) bound where arrivals may fall, as in `WINDOW`; `maxCount` (default unlimited);
  `minGapYears` (default: the episode's own span, below).
- **The process.** On the same month grid as `WINDOW` (the firsts of the months in the
  window), month *k* arrives when its uniform is below `1 − e^(−perYear/12)` — a Poisson
  process at `perYear`, discretised to one arrival a month at most — unless it falls inside
  the gap after the previous arrival or `maxCount` is reached. Month *k*'s uniform is
  `keyedRng(seed, 'shock-rate:<key>', k)`: a pure function of the month, so raising `perYear`
  only adds arrivals (without a binding gap or cap), and the same path index sees the same
  months in every arm.
- **The gap.** A shock cannot recur while its previous episode is still in force, so the default
  `minGapYears` is the episode's span: the latest `startMonths + recovery.durationMonths` over
  its legs (the shock's own recovery when it has none), at least one month. `minGapYears: 0`
  allows the next month. A gap makes the realised rate lower than `perYear`; the help says so.
- **Episodes are distinct.** Each arrival is its own episode with its own `shockId`: the first
  keeps the preset's, later ones are `<shockId>#2`, `#3`, … The behavioural strategies (panic
  sell, downturn Roth conversion, opportunistic and target rebalancing) fire once per
  `shockId`, so a shared id would let only the first crash trigger them. The same rule now
  applies across entries: two entries of one preset used to share an id, and the second
  episode was silently invisible to those strategies. A plan whose shocks all have distinct ids
  is unchanged.
- **Severity.** Every arrival of an entry carries the entry's severity (swept or authored).
  Per-arrival severity draws are not built.
- **Recording.** `shockArrivals[<key>]` is the list of drawn dates (`[]` when none); MC rows'
  `shockDate` is the first, and `shockArrivals` carries the rest.

## 4. G2 — Household energy prices (proposed second, after a measurement)

**Goal.** An oil shock raises the cost of an energy-heavy household's spending more than the
CPI says.

### 4.1 Why not a third spending slice (rev 1)

Rev 1 gave energy its own slice of `monthlyExpenses`. It would be overwritten. Besides
`InflationAdjustReducer`, six writers rebuild `monthlyExpenses`:
`spending-strategy-apply-reducer`, `guardrail-adjust-apply-reducer`,
`regime-aware-spending-reducer`, `age-banded-spending-reducer` and
`late-life-care-apply-reducer` as `essential + discretionary`, and
`explicit-bands-spending-reducer` as `monthlyAmount × inflationAccumulator[cc]`. Each would drop
an energy slice on its next write, the bands one silently pricing the plan at CPI again.

### 4.2 A relative price, not a slice

An oil shock in the presets is already in headline inflation: the stagflation preset's
`inflationAdjustment` is the measured CPI, energy included. What the CPI does not capture is a
household whose energy share `s` differs from the CPI's weight `w`. So:

- A shock leg gains `energyRelativePrice: { US, AU }` — energy's annual move *against the CPI
  basket* while the leg is live, on the leg's recovery clock like any other field.
- Per country, `householdEnergyShare` (`s`) and a sourced constant `CPI_ENERGY_WEIGHT` (`w`).
  `s` absent means `s = w`: the household is the CPI household, and nothing changes. (Rev 1's
  default 0 would, under any leg, have made the household *immune* to energy.)
- The household's spending rate is `π + (s − w)·r`. `InflationAdjustReducer` uses it for the
  expense slices, and advances a `spendingPriceLevel[cc]` at it.
  `explicit-bands-spending-reducer` pins from `spendingPriceLevel` instead of
  `inflationAccumulator`. The other five writers rebuild from slices that are already priced,
  and need no change.
- **Headline is untouched.** `effectiveInflationRates`, `inflationAccumulator`, the PPP anchor
  (design 122), bracket and limit indexing and the TIPS expected inflation (design 125) never
  see `s`. The household's share cannot move a national index.
- **The deflator stays CPI.** Real consumption (`residencePriceLevel`, design 89 §5.6) divides
  by `inflationAccumulator`, so a household whose prices outrun the CPI shows lower real
  consumption — which is the cost G2 exists to show. Deflating by `spendingPriceLevel` would
  hide it.
- **Oil and the AUD.** No new mechanism: a leg's existing `fxAdjustment` already moves
  `USD_AUD` (the stagflation preset carries one). Rev 1 listed this as a G2 deliverable; it is
  not one.

### 4.3 What it does not cover

Property running costs (`house-running-cost-handler`) are indexed by `prop.country`'s CPI level
and include utilities. They stay on CPI; a property-level share is a later question.

### 4.4 Measure before building

The whole effect is `(s − w)·r` of spending while a leg is live. A retiree household's energy
share may sit only a few points above the CPI weight, in which case even a large relative move
is a small fraction of spending for a few years — a rounding error next to G1. Step 0 is to put
on disk, with sources: `w` per country (the BLS relative-importance table and the ABS CPI
weights), a retiree `s` per country (the BLS Consumer Expenditure Survey by age and the ABS
Pensioner and Beneficiary Living Cost Index weights), and the energy relative-price path for
1973–74 and 1979–80. Then compute `(s − w)·r` on the study's stagflation window. If it is under
about 1% of spending, G2 is closed as measured and not built.

A preset only gains an `energyRelativePrice` leg from that sourced path; until one does, G2
has no effect on any preset, which is the honest state.

**Effort (if built).** Small to moderate: one leg field, one state level, the inflation
reducer, the bands reducer, the editor, and one preset leg.

### 4.5 The measurement (15 Oct 2026): closed

Sources in `docs/energy-prices/` (`SOURCES.md`); computation in
`scripts/lab/energy-share-measurement.mjs`. Energy = motor fuel + electricity + gas and other
household fuels. With base-period weights, `H/CPI − 1 = (s − w)·(R − 1)/(1 − w)` exactly.

- **`s − w`.** US: the Consumer Expenditure Survey share for households aged 65+ minus its share
  for all households (one survey on both sides), averaged 2013–2022: **+0.24 pp** (75+: +0.16).
  It moves between −0.04 and +0.45 pp year to year. AU: the ABS self-funded retiree living
  cost index weights minus the CPI's: **+0.44 pp** on the 2024 set, +0.14 on the 2025 set
  (whose electricity weights are net of the 2024–25 rebates). The age pensioner index, the
  highest-share household the ABS publishes, is +2.39 pp.
- **`R`.** Energy against all items rose **67%** (US, monthly) and **30%** (AU, OECD quarterly)
  from late 1972 to its peak in 1981–82; 49% and 21% in 2021–23.
- **The gap.** Peak `H/CPI − 1` through 1973–1982: US 65+ **0.17%**, AU self-funded retiree
  **0.14%**, AU age pensioner 0.76%. Summed over the decade it is about a tenth of one month's
  spending. 2021–23 is smaller still.
- **Break-even.** A 1% peak would need `s − w` of +1.4 pp (US) or +3.2 pp (AU) on the 1970s
  path — six and seven times the retiree readings.

Energy is a necessity, so its share falls with income: in the CE it runs from 8.3% of spending
in the lowest income quintile to 4.9% in the highest (2019; 9.6% to 5.6% in 2022). A household
with more to spend than the survey average sits at or below these readings — for a
high-income retiree, `s − w` is more likely negative. **G2 is closed:** at its largest, the
household-specific energy price effect is under a fifth of a percent of spending, inside the
noise of every other spending assumption. An oil shock's cost to a retiree is the CPI's own
energy component, which the presets' inflation legs already carry. Re-open only for a plan
whose household energy share is measured at several points above the CPI's.

## 5. G3 — Stock–bond correlation as a regime property → design 129

**Designed in 129** (15 Oct 2026; ACCEPTED rev 3, 16 Oct: default MC is joint mode, which already replays history's correlation, +0.16 on average). That design keeps this section's direction: the
yield tick's level shock correlates with the year's equity shock while a leg says so. It adds a
run-level base ρ, a measurement gate before the regime half, and the annual correlation by era
(1973–82 +0.42, 2000–2020 −0.53). It also records a gap this section did not name: under
`GAUSSIAN` stochastic inflation an inflation surprise does not move nominal yields (129 §5).

The original direction, kept for the record:

Today the sign of the stock–bond correlation is an emergent property of the legs in a
deterministic run and of the bootstrap window in MC. A regime should be able to say "while this
is active, stocks and bonds fall together" (1970s, 2022) or "bonds hedge stocks" (2000s).

Direction: a leg field `stockBondCorrelation` that the stochastic yield-curve tick
(`YieldCurveTickHandler`) uses to correlate its level shock with the year's equity draw while the
leg is active. Off by default; no effect on deterministic runs, where the legs already set both.

## 6. G4 — Valuation-conditioned expected returns (CLOSED 15 Oct 2026)

The direction was: a starting valuation (CAPE) lowers the expected equity return for the years
after it, fading as valuation reverts. It would be an optional `equityValuation` input shifting
the design 99 anchor by a function of log CAPE.

### 6.1 The level is already valuation-conditioned

Design 99's anchors are the equal-weighted mean of three providers' 10-year forecasts (§6.6
there). All three condition on today's prices. In the sources on disk in `docs/market-returns/data/`:

- **Vanguard.** The VCMM "takes into account current macroeconomic conditions and equity and bond
  valuations to forecast distributions of future returns" (AU asset-allocation report,
  methodology note). The US forecast page attributes its latest cut to valuation: "Valuations
  increased from already elevated levels. As a result, our 10-year expected annualized return
  for U.S. equities declined from a range of 4.9%–6.9% to a range of 4.2%–6.2%."
- **J.P. Morgan.** The LTCMA builds each equity forecast from blocks that include a valuation
  term (Exhibit 6, "Contributions to equity return forecasts": revenue, margins, dilution,
  buybacks, valuations, dividends, FX). Its text: "A better revenue and margin outlook balances
  richer multiples".
- **BlackRock.** The figures are the "Starting point" sheet: expected returns from current
  prices.

A CAPE input on top of these would count valuation twice over the first decade.

### 6.2 What is left: the horizon

The anchors are 10-year numbers, applied to every year of a run that may last 40. BlackRock
publishes the same assumptions out to 30 years ("Starting point" sheet, geometric, gross of fees):

| market (currency) | 5 yr | 10 yr | 20 yr | 30 yr |
|---|---|---|---|---|
| US large cap (USD) | 9.4% | 9.0% | 8.6% | 8.4% |
| Global ex-US large cap (USD) | 7.5% | 7.8% | 8.4% | 8.7% |
| Australia large cap (AUD) | 6.2% | 6.9% | 6.9% | 6.9% |

Beyond year 10 the change is within about 1 point either way. That is smaller than the providers'
disagreement on the 10-year level itself: about 4 points on the US (Vanguard ≈ 5.2, BlackRock
9.0; design 99 §6.6). For the US, one source has returns *falling* after the first decade,
which is the opposite of the fade a CAPE reversion would impose.

### 6.3 Decision (the author, 15 Oct 2026): closed

**Close G4 with no valuation mechanism.**
- The level is covered by design 99's sourced inputs.
- Uncertainty about the level is already an MC axis: `equityAnchorShift` (design 98 M2) moves
  every equity market's total return together.

If a study ever needs the horizon shape, the tool is a dated per-market total-return schedule
(anchors by year) sourced from a provider's horizon columns. That is not a CAPE model, and it is
not designed here.

## 7. G5 — Term premium and fiscal dominance (direction only)

Long yields that rise for debt reasons, independently of inflation, cannot be expressed except
by faking it with rate legs. Direction: a term-premium factor on the long end of the curve,
authored per leg (`termPremiumAdjustment`) and optionally stochastic, separate from the level
that tracks policy and inflation.

## 8. Phasing

1. **BUILT.** G1 `WINDOW` arrival: the spec and editor, the keyed draw with the compile seed,
   `shockArrivals`, the structural foresight test, the old MC variable removed, `mc-run`.
   Code: `shock-arrival.js`; tests: `evt-shock-arrival.test.mjs` (ARR-1..11),
   `evt-shock-mc.test.mjs` (EVT-SHOCK-MC-5/6: paired months across arms, the retired row).
2. **DONE, G2 CLOSED.** G2 step 0: the sources on disk and the `(s − w)·r` measurement (§4.5).
3. **BUILT.** G1 `RATE` arrival (§3.8), with a distinct `shockId` per episode across all
   entries. Tests: `evt-shock-arrival.test.mjs` RATE-1..6.
4. ~~G2 build~~ — not built: step 0 put the effect under 0.2% of spending (§4.5).
5. G3 → design 129 (ACCEPTED rev 3, 16 Oct 2026; step 0 built). G4 → CLOSED after checking the sources
   (§6). G5 gets its own design when a study needs it.

## 9. Open questions

1. **Deterministic runs with a random arrival.** *Decided (the author): drawn from the run's
   seed* (§3.4), replacing rev 1's midpoint. `run-scenario` prints the drawn month per shock.
2. **Several random shocks in one plan.** Independent draws, or one regime process that chooses
   which kind arrives? (Proposed: independent for `WINDOW`, each on its own key; a single
   process is what `RATE` would need, decide then.) Independent windows can overlap; two busts
   in force at once compose as two shocks do today.
3. **What the window counts from.** *Decided (the author): `simStart`.* Or the household's retirement date?
   Sequence risk is about the first years of retirement, and plans start at different
   distances from it; but a retirement anchor needs one date per household and the design 116
   job spells only give one per person. `simStart` now; a `from: 'RETIREMENT'` anchor later if a
   study needs it.
4. **Does G1 change existing MC arm files?** Only plans that opt into `arrival`. The removed MC
   date variable is enabled by no saved plan (checked rev 2), so it needs no migration; archived
   study scripts that enable it stop working, and that is acceptable.
5. **Energy share source** (G2, if built). *Moot: G2 is closed (§4.5).*

## 10. Test plan (G1 and G2, to be written with the code)

- G1: `FIXED` is byte-identical to today (state and goldens); `WINDOW` with probability 1
  draws inside the window, on the first of a month; probability 0 never fires and leaves no
  event; the same path index draws the same date in two arms, including when one arm enables an
  extra MC variable or switches `rngStreams`; reordering two different presets keeps each one's
  date; two entries with the same preset draw different dates; an authored `randomSeed` moves
  the arrival in a single run; `shockArrivals` names the drawn dates; no handler or reducer
  reads `parameters.shocks`.
- G2 (if built): `householdEnergyShare` absent is byte-identical; `s = w` under an energy leg is
  byte-identical; `s > w` moves spending by `(s − w)·r` and leaves `inflationAccumulator`, the
  PPP rate and the bracket index unchanged; an EXPLICIT_BANDS plan follows the household level;
  real consumption falls by the same proportion spending rises.
