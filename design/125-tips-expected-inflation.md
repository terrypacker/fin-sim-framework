# 125 — Expected inflation for the TIPS market real yield

**Status:** BUILT (15 Oct 2026), rev 3 (§4.1). Revisits design 121 §8 / Q6 (rev 3, the author:
expected inflation = the trailing 12 months), which a study found biased at a shock's onset. The
author asked for this to be written up as a design rather than patched (15 Oct 2026).

- **rev 2 (15 Oct 2026, review before build):** §1 re-measured. `trailingInflation` is not a
  12-month lag: it equals the effective rate at the country's last period advance, so it differs
  from the current rate only between a regime move and that country's next advance. The
  after-spike error in stochastic runs comes from applying one year's rate to the whole tenor,
  not from a lag. §3 option B corrected (it is never worse than A). §3 C's formula changed from
  the continuous average to the model's own annual steps (a one-year rung expects exactly π₀),
  and the worked numbers redone. §4 adds the plumbing (a per-rung stamp, like
  `tipsCouponMode`) and corrects the byte-identity claim. §5 Q1 answered from the code; Q2
  sharpened with the two-speed option.
- **rev 3 (15 Oct 2026, the author):** Q2 = the latent path when the stochastic path is on,
  the share-weighted speed otherwise (§3 C); Q3 = no regime foresight; Q4 = TENOR is the default,
  the study re-runs later. The per-rung stamp is dropped: both bond reducers are built from the
  same parameters (§4).

**Related:** design 121 §8 (the market real yield, `tipsRealYield`, `bondLadderTipsCouponMode`),
design 103 (stochastic inflation: anchor, reversion speed, global factor), design 67 (the
nominal yield curve), design 104 (the prime rate follows inflation), design 97 §20.2 (the "no
clairvoyance" rule for gates).

## 1. The problem

A `MARKET` TIPS rung locks a real coupon at build and at each roll:

> real yield (tenor) = nominal `resolveYield(rateKey, tenor)` − expected inflation (country)

with expected inflation = `trailingInflation` (`src/finance/economic-regimes/yield-curve.js`):
the level history `bracketIndexAccumulatorByYear[cc]`, `level(Y) / level(Y − 1) − 1`.

**What that reading actually is.** `InflationAdjustReducer` (PRE_PROCESS + 2) steps the history
once a year, at the country's period advance, by the effective rate in force at that instant.
The ladder build (`BondLadderReducer`, + 5) and the roll (`BondMaturityReducer`, + 3) run on the
same advance, after it. So `trailingInflation` is **the effective rate at that country's last
period advance**. Measured on plan (26):

- **Stochastic inflation, no regime** (seed 7): trailing equals the current effective rate on
  every day of 2027–29, to within 1e-16. The year-end `INFLATION_TICK` draws next year's
  deviation, but `InflationStepReducer` only stores it; it reaches `effectiveInflationRates` at
  the next advance's fold, the same advance that compounds the history.
- **A regime** (STAGFLATION_1970S_LITE from 1 Jan 2027): the regime applies after the 1 Jan
  advance, so through 2027 the current US rate is 8% while trailing reads 3%. From 1 Jan 2028
  the two agree again.

So trailing and current differ only between a regime move (onset, a phase change, a monthly
recovery tick) and that country's next advance. Two errors remain:

- **At a shock's onset** nominal yields move at the regime event and inflation moves with them,
  but trailing does not until the next advance. A US ladder rolls on both the US (1 Jan) and the
  AU (1 Jul) advance, so the 1 Jul 2027 roll read 7% nominal at its 3-year tenor (6.5%) less 3%
  trailing and locked **+3.5% real** while the regime's real rate is about −1.5%. That is the
  study flag's windfall: the rolls inside the lag window, in TIPS' favour. The same lag runs the
  other way when a regime phase drops inflation and nominal together: trailing stays high until
  the next advance.
- **After a spike, the whole tenor gets this year's rate.** With trailing and current equal, a
  hot year is assumed to last for the rung's whole life. In 2022 terms: about 3% nominal − 8% =
  −5% real, when TIPS actually traded near +1%. In this model the error is larger still under
  the stochastic path, because the GAUSSIAN inflation path does not move the nominal
  fixed-income rate at all (only prime, through design 104; FIXED_INCOME moves only through the
  independent `yieldCurveStochastic` walk, or joint mode's historical yield changes). So every
  hot draw lowers the TIPS coupon one for one while nominal rungs do not reprice. This case is
  not in the study flag and bites any stochastic run with a TIPS ladder.

## 2. What a market actually prices

A TIPS real yield is the nominal yield less **breakeven inflation**: the inflation the market
expects over the bond's life, not the inflation of the last year. For a mean-reverting
inflation process, that expectation starts at today's rate and decays toward the long-run
anchor, so it depends on the tenor: a one-year rung expects roughly today's inflation, a
ten-year rung expects roughly the anchor.

The model already has both ingredients:
- the **anchor** per country: `baseInflationRates` (from `inflationRate` / `auInflationRate`),
  which the stochastic path (design 103) reverts to;
- the **reversion speed** per country: `inflationReversionSpeedUs` / `inflationReversionSpeedAu`
  (default 0.33 a year: a deviation keeps e^(−κ) ≈ 0.72 of itself each year), with a slower
  shared global factor (`inflationGlobalReversionSpeed`, 0.1, `inflationGlobalShare` 0.4 of the
  latent).

The process is annual. The rate is constant through a year and steps at the advance, and TIPS
accretion (`BOND_ACCRETION`, year-end) accrues at the effective rate then in force. So a rung
bought this year accretes this year at π₀, next year at the next draw, and so on.

## 3. Options

**A. Trailing (today, design 121 Q6).** The rate at the last advance. Wrong at a regime's onset
(§1, the lag window) and after every spike (one year's rate for the whole tenor).

**B. The current effective rate.** Fixes the onset lag. Otherwise identical to A: in a
stochastic run the two are equal every day, and after a regime phase ends B is better than A, not
worse. It keeps A's main fault, one hot year assumed for the whole tenor.

**C. Tenor-matched expected inflation (proposed).** The average of the expected path over the
rung's tenor T, from the current rate π₀ toward the anchor A, stepping once a year at speed κ:

> E[π over T] = A + (π₀ − A) · g(κ, T),  g(κ, T) = (1/T) ∫₀ᵀ e^(−κ⌊t⌋) dt

For a whole number of years n this is g = (1 − e^(−κn)) / (n · (1 − e^(−κ))).

- π₀ is `effectiveInflationRates[cc]` now: the rate the rung accretes at this year-end, set by
  the same event that priced the nominal curve (see §5 Q1).
- A is `baseInflationRates[cc]`. The decay e^(−κk) is the process's own (Q2, rev 3):
  - **Stochastic path on:** split π₀ − A into the path's part, `inflationDev[cc]`, and a
    residual (a regime's adjustment, or the floor's clamp). The path's part follows the latent
    state exactly as the tick will walk it: E[g_k] = a_g^k·g, E[x_k] = a^k·x, recombined with
    the share (and joint mode's `jointLatentSd`) and mapped through
    `skewedInflationDeviation`. That catches what a single factor misses: a hot global factor
    under a cool country factor reads near the anchor today and drifts up. The residual decays
    at the fallback rate below.
  - **Stochastic path off, or the residual:** the share-weighted decay
    w·e^(−κ_g·k) + (1 − w)·e^(−κ·k), with w = `inflationGlobalShare` (0.4), κ_g =
    `inflationGlobalReversionSpeed` (0.1) and κ = the country speed (0.33). That is the
    latent's autocorrelation, so it is the best forecast without the split, and the two modes
    are one model at two levels of information. It reads the same parameters whether or not
    the path is on.
  - The closed form below is the single-speed case; the share-weighted g is
    w·g(κ_g, T) + (1 − w)·g(κ, T).
- g(κ, 1) = 1: a one-year rung expects exactly π₀, which is what it will accrue. A long rung
  tends to A.
- A null tenor (the fund-tenor fallback in `materializeLadder` and `resolveYield`) uses the same
  `RATE_KEY_META[rateKey].defaultDuration` the nominal half uses, so both halves of the
  subtraction share one T.

(rev 1 used the continuous average (1 − e^(−κT)) / (κT), which is 0.85 at one year and 0.49 at
five. It describes a process that decays within the year, which this model's does not.)

Worked through the §1 cases with the single country speed, for comparison with rev 1: a 3%
anchor and κ = 0.33, a five-year rung (g ≈ 0.575). The share-weighted fallback gives g ≈ 0.68,
so E ≈ 6.4% and every real yield below is about 0.5 pp lower.
- **Onset**, 7% nominal, 8% current, 3% trailing: E = 3 + 5 × 0.575 ≈ 5.9%, so real ≈ +1.1%
  (A: +4.0%, B: −1.0%).
- **After a spike**, 3% nominal, 8% current and trailing: E ≈ 5.9%, real ≈ −2.9% (A and B:
  −5.0%). The remaining gap to the observed +1% is the nominal curve's own lag, which is design
  67's, not this design's.
- **The study's onset roll** (3-year, 6.5% nominal, 8% current, g ≈ 0.745): E ≈ 6.7%, real ≈
  −0.2% (A: +3.5%, B: −1.5%).

**D. A blend parameter.** `expected = w·current + (1 − w)·trailing`. Easy to sweep, but w has no
meaning a reader can check, and since current and trailing are equal outside the lag window, no
w touches the after-spike case.

## 4. Proposal

**C, behind a parameter, defaulting to C.**

- `bondLadderTipsExpectedInflation` (BOND_LADDER strategy, beside `bondLadderTipsCouponMode`,
  visible when `bondLadderInflationLinked`): `TENOR` (default, option C) | `TRAILING` (today's
  rule) | `CURRENT`. TRAILING stays available so earlier runs can be reproduced and design
  121's choice is not lost. The latent and fallback forms are not separate values: TENOR uses
  the latent whenever `state.inflationLatent` exists.
- One function, `expectedInflation(state, cc, tenorYears, spec)`, beside `trailingInflation`;
  `tipsRealYield` takes the spec and passes it through. Every TIPS market-yield site goes
  through it: the build's `couponForTenor`, the `materializeLadder` fallback, the tail rung in
  `absorbAsTailRung`, and the roll.
- **One spec, built once.** The spec is `{ mode, reversionSpeed {US, AU}, globalReversionSpeed,
  globalShare, globalShareJoint, joint, lowerBound {US, AU}, vol {US, AU} }`, from the same
  defaults `InflationTickHandler` uses. Both bond reducers are constructed in the
  economic-regimes toolset's `reducers(context)` (the ladder through
  `BEHAVIORAL_STRATEGY_REGISTRY`), so both take it as a constructor option from the same
  `context.parameters` and cannot disagree. `BondMaturityReducer` gains its first option; with
  none it behaves as TRAILING, so a bare `new BondMaturityReducer()` in a test is unchanged. No
  holding field and no state key.
- **One latent walk.** The step from latent to y (share, joint scaling) moves out of
  `InflationTickHandler.call` into an exported helper both use, so the expectation cannot drift
  from the process it forecasts.
- No floor, as design 121 §8 decided.
- Both speeds 0 (an author who turns reversion off) degenerates to π₀ for every tenor, i.e.
  option B, which is the honest reading of "inflation does not revert". The speed and share
  parameters are visible only when `inflationStochastic` is on, but TENOR reads them in a
  regime-only run too: their descriptions must say so.

**Blast radius.** Any plan with an unpinned (`MARKET`) TIPS ladder. Values move wherever
current inflation differs from the anchor (any regime, any stochastic run). Elsewhere the change
is at the last bit: `trailingInflation` is a ratio of compounded levels and reads 0.03 +
2.8e-17 on a flat 3% run, while TENOR returns the anchor exactly, so even flat runs re-lock
coupons that differ in the last digit. No
golden builds a `MARKET` TIPS ladder today (`tips-ladder-conservation` pins its coupon), so the
fixture set should not move; confirmed: no golden moved (7,669 unit + 1,805 viz pass). `evt-tips-real-yield.test.mjs`
TIPS-2..4 build states where the effective rate and the history disagree, so they assert
TRAILING behaviour and must name that mode explicitly.

**Help.** `bondLadderInflationLinked` and `bondLadderTipsCouponMode` descriptions say "trailing
12 months"; both change, plus the reversion-speed and global-share descriptions (TENOR reads
them with the stochastic path off, while they are hidden), then `help/concepts/
bond-ladders.md` is restamped (`npm run help:gate`).

### 4.1 As built (15 Oct 2026)

- **`expectedInflation(state, cc, tenorYears, spec)`** in `yield-curve.js`, with
  `TIPS_EXPECTED_INFLATION_MODES` and `tipsExpectationSpec(p)` → `{ mode, process }`. No spec
  means TRAILING, so `tipsRealYield` without an `expectation`, a bare `BondLadderReducer` and a
  bare `BondMaturityReducer` all keep design 121's rule. TIPS-1..4 are unchanged for that reason;
  §4's note that they must name the mode did not apply.
- **Process math in `inflation-tick-handler.js`:** `combineInflationLatent` (now used by the
  tick; draws unchanged), `expectedInflationDeviation` and `inflationProcessConfig(p)` (now
  builds the tick handler too). The skew map is lognormal above the bound, so the forecast's
  mean is exact, not the map of the mean: with y_k ~ N(m_k, v_k) the expected deviation is
  (A − F)·(exp(s·m_k + s²(v_k − 1)/2) − 1). Joint mode's v_k carries the global–own covariance
  term, so v_∞ = 1 in both modes.
- **Wiring:** the BOND_LADDER strategy passes `tipsExpectationSpec(p)` to each
  `BondLadderReducer`; the economic-regimes toolset passes the same to `BondMaturityReducer`.
- **Param** `bondLadderTipsExpectedInflation` (Enum, default TENOR). Help: the two TIPS
  descriptions and the four reversion-speed/share descriptions updated; `bond-ladders` and
  `inflation` topics cite design 125 and are restamped.
- **Tests:** `evt-tips-expected-inflation.test.mjs` EXP-1..6, including a 20,000-path check of
  the latent forecast against the real tick + step reducer.
- **Effect on the study** (plan 26, `buf25Tips`, stagflation, deterministic): the 1 Jul 2027
  onset roll locks −0.55% real (was +3.5%); every later 3-year roll locks −0.55% (was −1.5%,
  the regime's own real rate), because the household expects the 8% to fade. Rungs built at
  the 2026 bootstrap are unchanged (inflation was at the anchor).

## 5. Open questions

1. **Same-tick π₀ and foresight.** *Answered from the code (rev 2).* π₀ is not a
   forecast. With the stochastic path, it is the rate the history already compounded at this
   year's advance and that this year-end's accretion pays; the next draw stays in
   `inflationDev` until the next advance. Under a regime, π₀ is set by the same event that moves
   the nominal yield it is subtracted from. Design 97 §20.2's rule (no reading of a year not yet
   completed) is not engaged.
2. **Which κ.** *Decided (rev 3, the author).* The latent path when the stochastic path is on,
   the share-weighted speed otherwise and for any regime residual (§3 C). The share-weighted g is
   0.68 at five years against 0.575 for the country speed alone.
3. **Regimes.** *Decided (rev 3, the author): no regime foresight.* A regime's later phases are
   scheduled in the preset, but the household does not know them.
4. **Default.** *Decided (rev 3, the author): TENOR.* The macro-regimes study's TIPS results
   re-run later (STUDY flag 14).

**Related gap (not this design).** Under the GAUSSIAN stochastic path the nominal fixed-income
rate ignores inflation (§1), so TIPS coupons fall in hot years while nominal coupons hold. TENOR
shrinks the effect by g; it does not remove it. A nominal curve that responds to inflation, as
the prime rate does under design 104, belongs with design 126's list.

## 6. Test plan (to be written with the code)

- `expectedInflation`: T → 0 and T = 1 give π₀; T large gives → A; κ = 0 gives π₀; π₀ = A gives
  exactly A; a whole-number T matches the closed form; w = 0 reduces the fallback to the
  single speed.
- Latent mode: with no regime, matches the mean of many seeded `InflationTickHandler` steps
  from the same latent (within sampling error, skew included); a hot global factor under an
  equal and opposite country factor expects inflation above π₀ at long tenors; a regime
  residual on top decays at the fallback rate; joint mode uses its own share and scaling.
- TRAILING reproduces today's coupons exactly (the existing TIPS-1..4, with the mode named).
- Onset: a regime that lifts inflation and nominal yields together, rolled on the other
  country's advance inside the lag window, locks a smaller real coupon under TENOR and CURRENT
  than under TRAILING. After a spike (current = trailing, both above the anchor), TENOR locks a
  larger one than either.
- Build, tail rung and roll use the same figure for the same tenor, state and spec; the
  toolset hands both reducers the same spec; a `BondMaturityReducer` with no spec rolls under
  TRAILING.
- `InflationTickHandler` draws are unchanged after the latent helper is extracted (golden gate).
- Golden gate: no fixture moves.
