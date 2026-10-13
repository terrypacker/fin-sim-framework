# 122 — The exchange rate follows the inflation gap (relative PPP)

**Status:** ACCEPTED (13 Oct 2026, the author: "fix it product-wide"). The sub-decisions in §4 are
the proposal's; the author can revise them. **COMPLETE** (13 Oct 2026): phases 1–3 built. Help topic `fx` updated; no golden moved (every golden has equal US/AU inflation, §3.1).

**Related:** design 47 (time-varying FX: `anchor × exp(deviation)`), design 92 (FX calibration,
k = 0.114), design 103 (stochastic inflation, the US–AU global share), design 121 (the
stagflation preset whose 20-year AU inflation gap exposed this), design 89 §5.6 (expense price
level), design 120 (currency overlay on hedged/unhedged lots).

## 1. The problem

The USD_AUD rate does not respond to inflation. Its anchor is the authored rate plus any regime
`fxAdjustment`, and the stochastic walk (MEAN_REVERTING) pulls back toward that anchor. Nothing
moves the anchor when the two countries' price levels drift apart.

So a sustained inflation gap compounds straight into the real cost of living for a household that
holds one currency and spends the other:

- **The 1970s stagflation preset** (design 121) runs AU inflation at 11.6% against US 8% for ten
  years, then an AU-only 8.1% tail for ten more: AU prices end ×2.25 relative to US prices. The
  preset's FX leg moves USD_AUD −0.10, so the AUD gets *stronger*. A plan holding USD assets and
  spending AUD after a move pays roughly 2.5× too much in USD for its AU life by year 20, and in
  the macro-regimes study every stagflation regime failed for this reason alone, in every lever
  setup.
- **Authored base rates that differ** (AU 4%, US 3%) with FX at NONE: an earlier measurement found
  +59% real USD cost of the AU lifestyle over 44 years from a 1pp gap, with no offsetting currency
  move.
- **Monte Carlo** draws US and AU inflation as two correlated paths (design 103). When they drift
  apart, the FX walk still reverts to a fixed anchor, so the real exchange rate drifts with them.

## 2. What history says

FRED on disk (`docs/economic-shocks/data`): DEXUSAL (USD per AUD; model USD_AUD = 1/DEXUSAL),
CPIAUCSL (US CPI, Dec), CPALTT01AUQ659N (AU CPI, Q4 YoY, compounded).

| Year | AU CPI | US CPI | AU/US | USD_AUD | USD_AUD / 1972 | Real (FX ÷ gap) |
|---|--:|--:|--:|--:|--:|--:|
| 1972 | 1.00 | 1.00 | 1.00 | 0.785 | 1.00 | 1.00 |
| 1976 | 1.71 | 1.37 | 1.25 | 0.918 | 1.17 | 0.94 |
| 1980 | 2.43 | 2.03 | 1.19 | 0.846 | 1.08 | 0.90 |
| 1983 | 3.26 | 2.39 | 1.37 | 1.115 | 1.42 | 1.04 |
| 1986 | 3.96 | 2.61 | 1.52 | 1.503 | 1.91 | 1.26 |
| 1990 | 5.27 | 3.16 | 1.67 | 1.295 | 1.65 | 0.99 |
| 1995 | 5.89 | 3.62 | 1.63 | 1.346 | 1.71 | 1.05 |
| 1999 | 6.17 | 3.97 | 1.55 | 1.524 | 1.94 | 1.25 |

Over 18 years the AU/US price gap was ×1.67 and the AUD fell ×1.65: **relative PPP held**, with a
real deviation of ±25% that took years to close. That is exactly the shape the model already has
for the deviation (OU, half-life ~6 years, design 92). What it lacks is the moving centre.

## 3. The change

```
anchor[USD_AUD]    = (authored rate + regime fxAdjustment) × pppIndex
effective[USD_AUD] = anchor × exp(fxDeviation)                         (unchanged)
pppIndex           = inflationAccumulator.AU / inflationAccumulator.US
```

Both accumulators are 1.0 at sim start, so the index is the realised AU/US price ratio since then.
The mean-reverting walk becomes what it measures: the real exchange rate's deviation from PPP.

### 3.1 When the index is sampled

The US accumulator steps on the US period advance (1 Jan), the AU one on the AU advance (1 Jul),
each once per period start **strictly after** sim start. A ratio read at an arbitrary date is a
6-month sawtooth: at equal 3% inflation it swings between 1/1.03 and 1. So the index is **sampled
once a year, right after the advance that makes the two step counts equal**: the AU advance for a
plan starting July–December, the US advance for one starting January–June (`pppSampleAdvance`).
Both accumulators then hold the same number of annual steps, and at equal rates the two products
are the same float sequence, so the index is **exactly 1.0** and nothing is written. Every plan with
equal inflation in both countries and no stochastic inflation stays byte-identical, whatever its
start date. (A first build sampled on the AU advance only; a 1 January start then put AU one step
ahead and moved the rate 3% at equal inflation. Test PPP-1 covers both halves of the year.)

A new reducer, `FxPppReducer`, runs at `PRE_PROCESS + 3` on that advance, after
`InflationAdjustReducer` (+2) has stepped the accumulator, so the order is explicit rather than a
priority tie. It **only stores** `fxPppIndex.USD_AUD`. `FxProcessReducer`, the one place the rate is
composed, multiplies the next fresh anchor by it: the other country's advance about six months
later, or the next regime recompute. A second formula that rescaled the live rate (anchor × new ÷
old) rounded one ulp differently from `base × index`, which is enough to break the byte-identity, so
the rate keeps one formula and the index lands with up to six months' lag. That lag is a timing
approximation inside one year, not drift.

A plan with no period advance in one of the two countries never samples, and its index stays 1:
today's behaviour.

### 3.2 Regime drift scales with the level

The index multiplies the regime-shifted anchor, not just the base. A crisis leg of +0.25 AUD per
USD was calibrated at today's level. At twice the price gap it is the same *percentage* move only
if it scales too.

### 3.3 The expense conversion at the move

Under `monthlyExpensesCurrency: RESIDENCE` the household's figure is indexed at the **residence**
rate (US CPI before the move, AU after) and converted to AUD at `baseExchangeRates`. That was
consistent with a pinned exchange rate. With PPP it is not: the AU price rise *relative to the US*
before the move is lost, and the household lands paying US-inflated prices at the old rate, a
permanent discount equal to the pre-move gap.

The fix: on `CHANGE_RESIDENCY_APPLY`, stamp `expenseRebaseRates.USD_AUD = baseExchangeRates ×
fxPppIndex`, and convert at that frozen rate from then on. The AUD figure at the move is then
`X × US(move) × base × AU(move)/US(move) = X × base × AU(move)`: the AU basket priced at the
authored rate and inflated by AU CPI. It is frozen, not live, because after the move the figure is
already indexed at AU CPI; reading the live index would count the gap twice.

The consumption reducers (`baseExchangeRates` to convert base-year AUD) are unchanged: deflating
by the AU accumulator and converting at the base-year rate is already the PPP-consistent identity.

## 4. Decisions in this proposal

1. **Full relative PPP on realised price levels, including authored base differences.** An AU 4% /
   US 3% plan now sees the AUD fall about 1% a year. That is the economics, and it is the case the
   earlier +59% measurement complained about. A plan that wants a real AUD appreciation can author
   a regime FX leg for it.
2. **On by default, with a switch.** `fxPurchasingPowerParity` (Boolean, default true, FX group).
   False is today's model, kept for A/B and for reproducing pre-122 results.
3. **No partial-PPP speed knob.** The OU deviation already supplies the slow real-rate reversion;
   a second half-life on the anchor would double-count it.
4. **The stagflation preset's −0.10 FX leg stays.** On top of PPP it now reads as what it was
   meant to be, the real AUD strength of 1973–80 (real 0.90 in 1980, table above).

## 5. Blast radius

- Deterministic runs with equal base inflation and no inflation-moving regime: byte-identical
  (§3.1).
- Plans with unequal base inflation, any regime with an `inflationAdjustment` gap, and every Monte
  Carlo run with stochastic inflation: the FX path changes. That is the point.
- Goldens: those with unequal US/AU inflation or inflation-gap shocks change. Each regold must show
  only FX-driven movement.

## 6. Out of scope

- **The stagflation preset's US inflation stops at month 120.** US 1981–90 ran 4.5% a year (CPIAUCSL
  Dec 1980 → Dec 1990, ×1.557), not the 3% base, so the preset's 20-year AU/US gap is ×2.25 against
  a measured ×1.67. A US tail leg is a preset calibration, design 121's territory, and a separate
  decision.
- Pairs other than USD_AUD (none exist).
- A plan with an AUD base currency living in the US before a move: the conversion runs before any
  move and stays at the authored rate. Noted, not handled.

## 7. Phases

1. `fxPppIndex`, `FxPppReducer`, `FxProcessReducer` composition, the param. Tests: equal-rate byte
   identity, a gap moves the anchor by exactly the accumulator ratio, regime drift scales, the
   switch off is today's model, rollouts carry the index (derivation manifest).
2. The frozen expense rate at the move. Tests: with a pre-move gap the post-move USD cost equals
   the no-gap cost; with no gap it is identical.
3. Help (REFERENCE regenerated, the FX topic), goldens regolded and read.
