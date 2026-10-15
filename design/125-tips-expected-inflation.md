# 125 — Expected inflation for the TIPS market real yield

**Status:** PROPOSED (15 Oct 2026). Revisits design 121 §8 / Q6 (rev 3, the author: expected
inflation = the trailing 12 months), which a study found biased at a shock's onset. The author
asked for this to be written up as a design rather than patched (15 Oct 2026).

**Related:** design 121 §8 (the market real yield, `tipsRealYield`, `bondLadderTipsCouponMode`),
design 103 (stochastic inflation: anchor, reversion speed, global factor), design 67 (the
nominal yield curve), design 97 §20.2 (the "no clairvoyance" rule for gates).

## 1. The problem

A `MARKET` TIPS rung locks a real coupon at build and at each roll:

> real yield (tenor) = nominal `resolveYield(rateKey, tenor)` − expected inflation (country)

with expected inflation = the country's realised inflation over the trailing 12 months
(`trailingInflation`, `src/finance/economic-regimes/yield-curve.js`). Trailing inflation lags the nominal
curve in both directions:

- **At a shock's onset** nominal yields have already moved (a regime moves the fixed-income
  rate in the same tick it moves inflation) but trailing CPI has not. In a calibrated 1970s
  phase 1 a rung built in the first year locks about +3.5% real while the regime's real rate is
  about −1.5%. One year of rolls, in TIPS' favour.
- **After a spike** trailing CPI is high while nominal yields have priced the spike as
  temporary. In 2022 terms: about 3% nominal − 8% trailing = −5% real, when TIPS actually
  traded near +1%. Every rung built in the year after a spike locks a real yield that is far
  too low, against TIPS.

The second case is the larger one and is not in the study flag; it bites any stochastic run with
an inflation spike, not only the stagflation presets.

## 2. What a market actually prices

A TIPS real yield is the nominal yield less **breakeven inflation**: the inflation the market
expects over the bond's life, not the inflation of the last year. For a mean-reverting
inflation process, that expectation starts at today's rate and decays toward the long-run
anchor, so it depends on the tenor: a one-year rung expects roughly today's inflation, a
ten-year rung expects roughly the anchor.

The model already has both ingredients:
- the **anchor** per country: `baseInflationRates` (the authored `inflationRate` /
  `auInflationRate`), which the stochastic path (design 103) reverts to;
- the **reversion speed** per country: `inflationReversionSpeedUs` / `inflationReversionSpeedAu`
  (default 0.33 a year), with a slower shared global factor (`inflationGlobalReversionSpeed`).

## 3. Options

**A. Trailing 12 months (today, design 121 Q6).** Simple, uses only realised data. Wrong in both
directions of §1.

**B. The current effective rate.** Fixes the onset case. Makes the after-spike case worse (one hot
year is assumed for the whole tenor), and it reads the year's drawn rate at the start of the
year, which is the kind of same-year foresight design 97 §20.2 removed from the pool gates.

**C. Tenor-matched expected inflation (proposed).** The average of the mean-reverting path over
the rung's tenor T, from a starting rate π₀ toward the anchor A with speed κ:

> E[π over T] = A + (π₀ − A) · (1 − e^(−κT)) / (κT)

- π₀ is the current effective rate: the same tick's reading the nominal curve was priced
  against, so the two halves of the subtraction describe the same moment (see §5 Q1).
- A is the country's anchor. κ is the country's reversion speed, read whether or not the
  stochastic path is on.
- A one-year rung lands near π₀, a long rung near A, which is what a breakeven curve looks
  like.

Worked through the §1 cases, with a 3% anchor and κ = 0.33, a five-year rung (factor ≈ 0.49):
- **Onset**, 7% nominal, 8% current: E = 3 + 5 × 0.49 ≈ 5.4%, so real ≈ +1.6% (A: +4.0%,
  B: −1.0%).
- **After a spike**, 3% nominal, 8% current: E ≈ 5.4%, real ≈ −2.4% (A: −5.0%, B: −5.0%). The
  remaining gap to the observed +1% is the nominal curve's own lag, which is design 67's, not
  this design's.

**D. A blend parameter.** `expected = w·current + (1 − w)·trailing`. Easy to sweep, but w has no
meaning a reader can check, and no single w fixes both cases.

## 4. Proposal

**C, behind a parameter, defaulting to C.**

- `tipsExpectedInflation`: `TENOR` (default, option C) | `TRAILING` (today's rule) | `CURRENT`.
  TRAILING stays available so earlier runs can be reproduced and design 121's choice is not
  lost.
- One function, `expectedInflation(state, cc, tenorYears)`, beside `trailingInflation`, used by
  `tipsRealYield`, so the build (`BondLadderReducer`) and the roll (`BondMaturityReducer`)
  cannot disagree.
- No floor, as design 121 §8 decided.
- κ = 0 (an author who turns reversion off) degenerates to π₀ for every tenor, i.e. option B,
  which is the honest reading of "inflation does not revert".

**Blast radius.** Any run with a `MARKET` TIPS rung changes whenever current inflation differs
from the anchor. With stochastic inflation off and no regime, current = anchor = trailing, so
those runs are byte-identical. Goldens with an unpinned TIPS ladder under a regime or with
stochastic inflation will move; regold and read the diff.

## 5. Open questions

1. **Same-tick π₀ and foresight.** π₀ is the year's drawn rate, visible from 1 January. For the
   nominal yield it is subtracted from, that is consistent (both are the market's reading at
   the same instant, and a regime moves both together). It is not a forecast of a return the
   household could not know. Agreed, or should π₀ be the trailing rate with the reversion still
   applied (which keeps the onset windfall)?
2. **Which κ.** The country speed (0.33), the global speed (0.1), or a share-weighted mix as
   design 103 composes them? The proposal uses the country speed; the global factor's slower
   reversion would lengthen expected spikes.
3. **Regimes.** A regime's later phases are scheduled in the preset, but the household does not
   know them; the proposal deliberately ignores them (no regime foresight). Confirm.
4. **Default.** Changing the default from TRAILING moves every affected study's TIPS numbers. The
   macro-regimes study's TIPS results would need a re-run.

## 6. Test plan (to be written with the code)

- `expectedInflation`: T → 0 gives π₀; T large gives → A; κ = 0 gives π₀; π₀ = A gives A.
- TRAILING reproduces today's coupons exactly (golden with an unpinned TIPS ladder unchanged
  under TRAILING).
- Onset: a regime that lifts inflation and nominal yields together locks a smaller real coupon
  under TENOR than under TRAILING; after a spike, a larger one.
- Build and roll use the same figure for the same tenor and state.
- No regime, no stochastic inflation: byte-identical under every mode.
