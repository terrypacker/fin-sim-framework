# 121 — Delayed shock legs, a recalibrated stagflation, gold risk, and TIPS real yields

**Status:** ACCEPTED (12 Oct 2026), rev 3. **Phases 1–3 BUILT** (12 Oct 2026); phases 4–5 open.

- **rev 2:** the author answered rev 1's questions.
  - Q1: raise the AU inflation leg (§4).
  - Q2: defer real-rate legs, with a note (§9).
  - Q3: verify the gold–equity correlation. It is worse than unverified: **gold carries no risk
    in Monte Carlo at all** (§6).
  - Q4: draft the TIPS real-yield path here (§8).
  - Q5: AU gets its own phase durations (§4).
- **rev 3:** Q6 trailing 12 months (§8). Q7 agreed: no gold volatility in deterministic runs
  (§6). Q8 agreed and checked: **AU-held gold has no currency exposure today** (§6.1).

**Related:** design 21 (shock and regime framework: legs, recovery curves, severity, §18.6
ticks, §21 composed trough), design 56 §7 (gold as its own rate key), design 66 §G5/§G8 (TIPS,
ladder rolls), design 67 (yield curve), design 120 §5.4 (the stamped `equityMarketShock` a
correlated draw reads), `docs/economic-shocks/` (SOURCES, MEASUREMENTS, CALIBRATION).

## 1. The problem

`STAGFLATION_1970S_LITE` gets the 1970s wrong about money, and it is the one preset where money
is the story.

- **Rates arrive at their peak on day one.** The `rates` leg puts `FIXED_INCOME_US` +7.0pp and
  `PRIME_US` +14.0pp in force from month 0, on a U/240 profile. Those are the 1972 → mid-1981
  *peak* moves, and +14pp is the *bank* prime move. The inflation leg adds +5pp (L/120).
- **So real rates are strongly positive for the whole inflation decade.** At the library default
  bases (US fixed income 4%, policy rate 4.5%, inflation 3%), new bonds yield 11% against 8%
  inflation, which is +3% real. The policy rate, and every cash account linked to it, is at
  18.5%, which is +10.5% real. After the inflation leg ends, fixed income stays at 8–11% against
  3% inflation for another decade.
- **History ran the other way** (§2). Real rates were about −1% through 1973–80. The +6–7% real
  rates came *after* inflation broke.
- **Australia had a different decade from the US.** AU inflation averaged 11.6% over 1973–80
  (the preset gives 7%) and stayed near 8% through 1990. AU real rates stayed high until about
  1999.
- **Gold has no response in any preset.** It is a flat `goldGrowthRate` (default 5% nominal), so
  it loses about 3% a year in real terms through a stagflation. Historically gold was that
  episode's largest real gain.

**Consequence.** In the model, holding bonds and cash *wins* a stagflation, and gold loses one.
A study of liquidity pools under this preset found that an inflation-linked ladder looked
*harmful* in stagflation and helpful everywhere else, which is backwards. The cause was the
preset. Once the rates were calibrated to §2, ladders were neutral. Gold then looked like the
lever that mattered, but §6 shows that reading is also suspect.

**Why values alone cannot fix it.** The real-rate *sequence* (negative during inflation, then
strongly positive) needs legs that start later than their shock, and nothing in
`economic-shocks/` or `economic-regimes/` delays one (§3).

## 2. What history says (all from files on disk)

Sources in `docs/economic-shocks/data/`:
- FRED: CPIAUCSL, FEDFUNDS, DGS5, GS10, GS1, CPALTT01AUQ659N, IR3TIB01AUM156N, IRLTLT01AUM156N.
- MeasuringWorth: annual gold, 1968–1995.
- World Bank Pink Sheet: monthly gold, 1960–2025.
- Shiller: S&P 500 real total return.

The two gold sources are new with this design. Their routes are in `SOURCES.md` and
`fetch-sources.sh`, and their converters are `measuringworth-gold-to-csv.py` and
`worldbank-cmo-gold-to-csv.py`.

"Real" means the phase average of the monthly rate minus CPI. For the US, CPI is Dec/Dec
compounded; for AU it is the average of quarterly YoY.

**United States**

| Phase | CPI/yr | Fed funds real | 5-year real | 10-year real | 1-year real |
|---|--:|--:|--:|--:|--:|
| 1973–80 | 9.3 | −0.8 | −1.0 | −0.9 | −1.1 |
| 1981–85 | 4.9 | +6.4 | +7.2 | +7.4 | +6.3 |
| 1986–90 | 4.2 | +3.5 | +4.0 | +4.2 | +3.3 |

Total return, real, Dec 1972 = 1 (rebought monthly, coupon included):
- The 10-year par bond, marked monthly, falls to 0.627 by Dec 1980 (−37%) and reaches 1.492
  by 1990.
- The 1-year yield, accrued monthly with no price change, falls to 0.935 (−6.5%), then
  reaches 1.534 by 1990.

Every figure in this section is printed by `scripts/probes/measure-shock-history.mjs` into
`MEASUREMENTS.md` §12 (phase 2).

**Australia**

| Phase | CPI/yr (avg YoY) | 3-month bill real | 10-year real |
|---|--:|--:|--:|
| 1973–80 | 11.6 | −1.6 | −2.0 |
| 1981–90 | 8.1 | +6.6 | +5.5 |
| 1991–99 | 2.0 | +4.4 | +6.0 |
| 2000–07 | 3.2 | +2.4 | +2.5 |

**Gold**
- London PM fix, annual average: 1972 → 1980 real ×5.35 (+23%/yr); 1980 → 1990 real ×0.39
  (−8.9%/yr).
- Calendar-year (Dec/Dec) real returns against the S&P real total return. Gold is the World
  Bank monthly series deflated by CPI-U:

| Window | Gold real sd | Geometric real | Corr. with S&P | Corr. with CPI |
|---|--:|--:|--:|--:|
| 1972–2024 | 22% | +4.0% | −0.23 | +0.34 |
| 1985–2024 | 15% | +2.6% | −0.04 | −0.16 |
| 2000–2024 | 15% | +6.6% | +0.17 | −0.04 |

  Rev 3 printed slightly different figures here (22/+3.6/−0.24/+0.35, 14/+2.0/−0.05/−0.17,
  14/+5.8/+0.15/−0.05) from a method no longer on record. These are the ones the script
  reproduces. Nothing downstream moves: the sd since 1985 is 15%, which is §6's
  `goldReturnVol` default, and the correlation windows still centre on 0.

## 3. Mechanism: a leg start offset

### 3.1 The field
A leg gains an optional `startMonths` (integer ≥ 0, default 0): the leg's regime begins that
many months after the shock's `startDate`. Absent or 0 means today's behaviour, byte-identical.
A leg's `recovery.durationMonths` counts from the leg's own start.

### 3.2 Two ways to implement it

**(a) Post-date the regime.** `EconomicShockHandler` adds every leg at the shock's date, with a
later `startDate` on the delayed one. This touches more than it looks:
- Every recovery curve returns **1 for t < 0** (`recovery-curves.js`). A post-dated regime would
  apply at full strength immediately, so `RegimeApplyReducer` would need a "not yet" state.
- More than a dozen reducers read `state.activeRegimes` tags (regime-aware spending, panic sell,
  contribution suspension, pools, rebalancer…). A pending regime in that list would be read as
  live. So it would need a separate `pendingRegimes` list and a promotion step.
- `scheduleShock`'s recovery ticks would need to span offset + duration.

**(b) Split at schedule time — recommended.** `scheduleShock` (economic-regimes toolset) groups
a shock's legs by `startMonths`. It schedules one `ECONOMIC_SHOCK` event per group, at
`startDate + startMonths`, carrying the shock with only that group's legs (and `startDate`
moved to the group's date). Each group gets its own recovery ticks spanning its longest leg.
- **Nothing downstream changes.** The handler, the reducers, the curves and every tag reader see
  an ordinary shock arriving on its date. Regime ids stay `regime-<shockId>-<legId>`, already
  unique per leg.
- **`levelEffects` fire once**, on the offset-0 group. If no leg sits at 0, they fire at the
  shock's `startDate` with an empty leg list, so the level break stays dated to the episode.
- **Severity is applied before the split** (`resolveShockEntry` → `applySeverity`), so every
  group carries the swept values. **A `startDate` sweep moves every group together.**

### 3.3 Validation and surfaces
- **Validation:** `startMonths` must be a non-negative integer. A leg that would start after
  `simEnd` is dropped with a loader warning naming the shock and leg.
- **Rollouts:** confirm that the MPC/optimizer rollouts see the delayed event (the derivation
  manifest). Shock events are compiled from params by the same function, so this should hold.
  Test it rather than assume it.
- **Editors:** the custom-shock leg editor gains a "starts after (months)" field. Its help
  topic (`help/concepts/economic-shocks.md`, and the node topic if the leg form has one) needs a
  restamp.

### 3.4 As built (phase 1)
- `scheduleShock` / `scheduleShockGroup` in `economic-regimes-toolset.js`. A shock whose legs
  are all at offset 0 takes the old path unchanged, and its event carries the same shock object.
- **Tick dates count from the shock's own start** (`shockStart + offset + m`), so a delayed
  group's ticks fall on the same calendar days as an undelayed shock's.
- **The level-only group** (no leg at 0) is `legs: []` with `regime: null`. The handler adds
  no regime for it and it gets no ticks. Without `regime: null`, the handler's single-leg
  fallback would push a regime carrying the shock-level tags, and those tags wake behavioral
  strategies.
- **Groups share the `shockId`.** Regime ids are unchanged, and the behavioral strategies'
  fire-once-per-shock bookkeeping still sees one episode.
- **An invalid `startMonths` throws**, naming the shock and the leg. A silent 0 would put a
  leg meant for year 10 in force on day one.
- **Rollouts need no manifest entry.** A snapshot keeps the compile's queue, so the delayed
  event is already in it. `evt-shock-leg-offset.test.mjs` LAG-9 checks that a seeded rollout
  puts the leg in force on its date.
- **There is no custom-shock leg editor to extend.** The `shocks` editor offers a preset and a
  date only, so legs, and `startMonths` with them, are authored in the scenario JSON. The
  help topic `economic-shocks` describes delayed legs.
- **Presets drop late phases silently.** A preset's later phases running past a plan's end is
  ordinary (a 2045 stagflation in a run to 2060), and a warning would print on every Monte
  Carlo and optimizer compile. Only a custom shock warns (phase 2).
- `applySeverity` is exported so LAG-5 can sweep a custom shock the way `resolveShockEntry`
  sweeps a preset (`SHOCK_LIBRARY` is frozen). A custom shock's own `severity` is its
  headline, so a custom entry is never rescaled. Only presets sweep.

## 4. Recalibrating `STAGFLATION_1970S_LITE`

The stress and equity legs are unchanged (equity is already calibrated: MEASUREMENTS §1).

**Rules.**
- **The model's prime is the policy rate**: `usPrimeRate` is labelled "Fed policy" and
  `auPrimeRate` "RBA policy". So prime calibrates to fed funds (US) and to the 3-month bill
  (AU, the nearest on-disk policy proxy), not to the bank prime rate.
- **Fixed income calibrates to the 5-year** for the US, since `FIXED_INCOME_US` has a default
  duration of 5.0 (`rate-keys.js`). For AU it uses the 10-year, as there is no AU 5-year on
  disk.
- **Legs are additive, so they are computed against the library default bases**: US FI 4%,
  policy 4.5%, inflation 3%; AU FI 4%, policy 4.35%, inflation 3%.
  Leg = target real − base real + whichever inflation adjustment is live in that window.

**Inflation.**

| Leg | Window | US | AU |
|---|---|--:|--:|
| `inflation` | 0–120 mo, L | +5.0 (8% vs 9.3% measured) | **+8.6** (11.6%) — was +4 |
| `inflationAuTail` | `startMonths` 120, L/120 | — | **+5.1** (8.1%, 1981–90) |

The FX adjustment stays on `inflation`, unchanged.

**Rates.** US and AU get their own phase legs and durations:

| Leg | Window | `FIXED_INCOME_US` | `PRIME_US` | `FIXED_INCOME_AU` | `PRIME_AU` |
|---|---|--:|--:|--:|--:|
| `rates` | 0–120 mo, L | +3.0 | +2.7 | +5.6 | +5.65 |
| `realRatesUs` | `startMonths` 120, U/120 | +6.2 | +4.9 | — | — |
| `realRatesAu` | `startMonths` 120, L/120 | — | — | +9.6 | +10.35 |
| `realRatesAu2` | `startMonths` 240, U/216 | — | — | +5.0 | +3.05 |

Where those land:

| Window | US FI / policy (inflation) | US real | AU FI / policy (inflation) | AU real |
|---|---|--:|---|--:|
| 0–120 mo | 7.0 / 7.2 (8.0) | −1.0 / −0.8 | 9.6 / 10.0 (11.6) | −2.0 / −1.6 |
| 120–240 mo | 10.2 / 9.4 (3.0), then fading | +7.2 / +6.4 | 13.6 / 14.7 (8.1) | +5.5 / +6.6 |
| from 240 mo | base | — | 9.0 / 7.4 (3.0) | +6.0 / +4.4 |

- **US phase 2** is flat 5 years, then fades over 5. The fade's average is about half, close to
  the 1986–90 step.
- **AU phase 3** (1991–99) is flat 9 years, then fades over 9. The fade's average lands near
  the 2000–07 real rates (+2.4 / +2.5) above base.
- **`returnAdjustment` mirrors `interestRateAdjustment`** for every fixed-income key, as every
  current rates leg does.
- **The phase steps are yield RISES** (US 7% → 10.2%, AU 9.6% → 13.6%).
  `BondPriceAdjustReducer` therefore marks held bonds *down* at month 120, which is the
  1979–81 direction. Today's L-snap pays a windfall that history never paid.

**Measured check** (a study's US version of this calibration, built as custom shocks): the bond
sleeve earned −1.4%/yr real through the inflation leg (history, 1-year: −0.8%/yr) and +55% real
over the following decade (history, 1-year 1980–90: +64%).

**Limitation, deferred (author, rev 2).** Additive legs fix the *move*, not the *level*. A plan
whose base real rate differs from the defaults keeps that difference inside the regime. For
example, a plan at FI 3% / inflation 3% sits 1pp lower throughout. Real-rate-target legs are
deferred (§9). The preset's rates legs carry a comment saying they are computed against the
library defaults, naming those defaults, so the next reader knows what a non-default base does.

### 4.1 As built (phase 2)
- The preset carries the legs in §4's tables exactly, with the additive-base comment.
  `CALIBRATION.md` (`scripts/probes/shock-path-engine.mjs`) now runs the preset at the library
  defaults and prints each phase's real rates against `MEASUREMENTS.md` §12. Every row lands
  on its target. The US fade window (180–240 mo) reads +4.2 / +4.0 against 1986–90's
  +4.0 / +3.5.
- **The month-120 hand-off is clean.** An L leg's factor is 0 from `t >= durationMonths`, and
  the next phase's shock event recomputes regimes on that same day.
- **Inflation-linked prime does not double-count.** Design 104's link moves prime with the
  *stochastic* inflation deviation (`inflationDev`), not with a regime's
  `inflationAdjustment`. The `PRIME_*` legs therefore add on top in Monte Carlo too.
- `CALIBRATION.md` also writes out §5's historical gold shape as a custom shock to run
  beside the preset (`GOLD_1970S_HISTORICAL`, three legs). Its sizes are computed from the
  measured multiples and the preset's own gold and inflation legs, and the engine reproduces
  ×5.35 and ×0.39.
- Tests: `evt-shock-stagflation-phases.test.mjs` STAG-1..5.

## 5. A gold leg

**Add `returnAdjustment: { GOLD: +0.05 }` to the `inflation` leg** (L/120). Gold then keeps its
base real return through the US inflation decade (+2%/yr at the library defaults, 5% against
3%), moving one-for-one with the US inflation adjustment, instead of losing about 3%/yr.
The gold key is USD-priced, so the US leg is the reference.

**Why not the historical shape** (+23%/yr real for 8 years, then −8.9%/yr for 10)?
- Much of 1972–80 was a one-off re-pricing after Bretton Woods (gold window closed Aug 1971;
  US private ownership legal from 31 Dec 1974). Nothing like it is available to happen again
  from today's free market.
- Building that into the default would make gold the guaranteed winner of every stagflation
  draw.

`CALIBRATION.md` documents the historical shape as a custom shock, written out in full, for
anyone who wants the upper bound.

## 6. Gold carries no risk in Monte Carlo (finding, rev 2)

**What was asked:** is gold's MC draw correlated with equity's? **What is true:** there is no
gold draw.
- `goldGrowthRate`'s MC row is harvested with `enabled: false`. Measured on a real plan's
  prepared variables: mean 0.05, and across 400 seeds the drawn value has **sd 0**.
- Nothing gives gold a year-by-year stochastic path. None of the equity, inflation, property or
  yield-curve tick handlers touches `GOLD`.

So in every MC path gold returns exactly `goldGrowthRate` every year. It is a **riskless 5%
nominal asset** that out-yields the 4% default bond, never draws down, and is uncorrelated with
everything by construction. Any MC result that favours a gold allocation is, at least in part,
an artifact of that. Measured gold (§2): about 14% real annual sd since 1985, 22% including the
1970s, with near-zero correlation to equity. That is a volatile diversifier, not a riskless one.

**Proposal: a stochastic gold path.**
- **Shape:** one annual gold draw on the same cadence as the equity tick. Lognormal around the
  regime-adjusted `goldGrowthRate`, with volatility `goldReturnVol` (default **0.15**, the
  measured 1985–2024 real sd rounded up for nominal).
- **Correlation:** `goldEquityCorrelation` (default **0**, the centre of the measured −0.24 /
  −0.05 / +0.15 windows). It is applied the way design 120 §5.4 correlates FX: read the
  stamped `state.equityMarketShock.z` and draw z_g = ρ·z_eq + √(1−ρ²)·ε on gold's own keyed
  stream, so `rngStreams` keeps it paired across arms.
- **When it is on:** whenever `equityReturnStochastic` is on, which includes every MC path
  under design 98 M3. A single deterministic run is unchanged and byte-identical.
- **MC axes:** `goldReturnVol` and `goldEquityCorrelation` become MC axes, disabled by default
  like `equityReturnVol`.

### 6.1 AU-held gold has no currency exposure (finding, rev 3)

Gold is priced in USD (design 56 §7: one country-agnostic `GOLD` key). An AUD investor's gold
return is the USD return times the AUD/USD move. In the model it is not.
- `currencyOverlay` applies only where `fxExposureOf(rateKey, account)` finds an entry in
  `FX_EXPOSURE_BY_MARKET`, and that table has **one** entry: `EQUITY_INTL_EX_AU`.
- A `GOLD` lot in an AUD account (super, an AU brokerage) therefore earns the USD gold rate,
  applied in AUD, with no currency term.
- Separately, `currencyOverlay` returns null for an instrument with no hedge ratio
  (`hedgeRatioOf`). Any default for gold would have to come from the role defaults, the way
  super equity gets one.

**Proposal (part of phase 4):**
- Add `GOLD` to `FX_EXPOSURE_BY_MARKET`: home `AUD`, foreign `US`, pair `USD_AUD`, `volScale`
  1.0. Gold is a single USD price, not a basket.
- Give gold lots a default hedge ratio of **0** in every role. Physical-backed ASX gold
  products are commonly unhedged. A hedged product sets its own ratio on the security
  (design 120 §5.1).
- A USD account is unchanged, since the overlay only fires where the account's currency is the
  exposure's home.

**Blast radius.** AU-held gold moves with the AUD wherever the FX layer runs. Plans without the
FX layer (`fxProcessModel: NONE` and no cross-border toolset) are unchanged: f = 0 on a flat
rate (`fxMoveFor`).

**Deterministic runs (Q7, agreed):** no gold volatility, the same as equity. A single run with
`equityReturnStochastic` off is byte-identical.

**Blast radius of §6 and §6.1.** Every plan that holds gold gets riskier, more honest MC results. Deterministic
runs and goldens do not move (no golden runs a stochastic path with gold). The study that
prompted this design must re-run its gold arms afterwards.

## 7. Severity should scale only what it measures

`applySeverity` scales **every** `returnAdjustment` by target ÷ headline depth, including
`FIXED_INCOME_*` and, after §5, `GOLD`. It leaves `interestRateAdjustment` untouched. Two
effects today:
- **Pairs drift apart.** Every rates leg sets the fixed-income `returnAdjustment` equal to its
  `interestRateAdjustment`. A severity sweep moves one and not the other, so a bond's coupon
  rate and its return adjustment disagree in every swept draw. This affects all seven presets
  with a rates leg.
- **Gold would scale with the equity crash.** A deeper equity draw would mean a bigger gold
  gain, which no measurement supports.

`severity` is the trough depth of the **equity** decline (design 21 §21). **Recommendation:**
scale only the equity-class keys (`EQUITY_*` and what fans out from them). Leave fixed income,
gold and every other key at the preset's value. This changes MC runs that sweep severity on any
preset with a rates leg; it changes nothing at the preset's own severity.

**As built (phase 3).** `applySeverity` scales a `returnAdjustment` key only when it is an
equity sleeve (`EQUITY_SLEEVES`) or a member key one fans out to. Level effects were already
equity-only (`equityRevaluation`). Nothing else read the old behaviour: the 1873 preset's
`relief` tailwind is an equity key, so its offset shape still survives a sweep. Tests:
`evt-shock-severity-scope.test.mjs` SEV-1..3, which run every rated preset. Phase 1's LAG-5
now sweeps an equity key on the delayed leg.

## 8. TIPS at a market real yield

**Today:**
- **Build** (`BondLadderReducer`, couponRate null): every rung, TIPS included, takes the
  **nominal** curve yield at its tenor. The parameter description warns that this pays for
  inflation twice. The only way to avoid it is to pin `bondLadderCouponRate` to a real yield.
- **Roll** (`BondMaturityReducer`, `rollsAsTips`): a rolling TIPS rung keeps the **contracted
  real yield it already carries**, forever. The code comment calls holding it flat "the neutral
  assumption in the absence of a real-yield curve".

So a TIPS ladder either double-pays (unpinned build) or never reprices (pinned, or any roll). In
a stagflation's phase 2, nominal bonds re-lock at +7% real while TIPS stay at whatever was
pinned. That understates TIPS exactly where they would have done well.

**Proposal: derive a market real yield.** For an inflation-linked rung with no pinned coupon:

> real yield (tenor) = nominal `resolveYield(rateKey, tenor)` − expected inflation (country)

- **Expected inflation is the trailing 12 months** of the country's realised inflation (Q6,
  author, rev 3), read from the CPI accumulator as level(now) ÷ level(12 months ago) − 1. Until
  a run has 12 months of history it falls back to the current `effectiveInflationRates`. The
  same rule applies with the stochastic inflation path on or off; with it off the two
  readings agree.
- **Applied in both places:** at build, replacing the nominal yield, and at roll, replacing the
  carried coupon.
- **Pinned coupons** are respected at build. A new `bondLadderTipsCouponMode`
  (`MARKET` | `PINNED`, default `MARKET` when the coupon is null) decides whether a pinned rung
  re-locks at roll.
- **No floor.** Real yields were negative in 2020–21 and in the 1970s (§2); the deflation floor
  on principal is unchanged.

**Check against §4:** a calibrated phase 1 gives US TIPS 7.0 − 8.0 = −1.0% real (the 1970s
level), and phase 2 gives 10.2 − 3.0 = +7.2%, matching nominal bonds' real yield.

**Blast radius.** Any plan with `bondLadderInflationLinked` and a null coupon changes: it stops
double-paying, so TIPS returns fall. Plans with a pinned coupon change only at roll, and only
under `MARKET`. A golden that builds an unpinned TIPS ladder will move (find them at build time
with a `bondLadderInflationLinked` grep under `tests/`).

## 9. Phases and open questions

**Phases** (each separately shippable):
1. **`startMonths`, split at schedule time (§3).** Tests:
   - A delayed leg is absent from `activeRegimes` before its date and live after it.
   - Level effects fire once.
   - Severity and `startDate` sweeps carry through.
   - Rollouts see the delayed event.
   - Absent the field, byte-identical.
2. **Preset recalibration (§4)** with the US/AU phase legs, the AU inflation legs and the
   additive-base comment; **gold leg (§5)**; MEASUREMENTS/CALIBRATION updates.
3. **Severity scope (§7).**
4. **Stochastic gold and AU gold's currency exposure (§6, §6.1).**
5. **TIPS market real yield (§8).**

**Resolved.**
- Rev 2: Q1 AU inflation raised (§4). Q3 verified, and turned into §6. Q4 drafted as §8.
  Q5 AU gets its own legs and durations (§4).
- Rev 3: Q6 trailing 12 months (§8). Q7 no gold volatility in deterministic runs (§6).
  Q8 checked: AU-held gold had no FX term; fixed in §6.1.

**Open.**
- **Q2. Real-rate-target legs.** *Deferred by the author.* Should a leg be able to say "real FI
  = −1%" rather than "+3pp"? That would remove §4's limitation. It is a larger change to
  `RegimeApplyReducer`; revisit when a second preset needs it. Noted in the preset comment
  (§4).
