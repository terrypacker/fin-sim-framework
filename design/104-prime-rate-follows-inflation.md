# 104 — The prime rate follows inflation

**Status: BUILT (13 Sep 2026).** Owner decisions are in §7. Revisits design 103 §8 Q6, where
"prime stays independent of inflation" was accepted on a misunderstanding of the question.

Measurement: `scripts/probes/probe-prime-inflation.mjs`. Tests:
`tests/unit/prime-inflation-link.test.mjs`.

---

## 1. The problem

Design 103 gave inflation a persistent, historically calibrated path, but left the policy
rates (`PRIME_US`, `PRIME_AU`) where the prime setting or the Prime Rate Schedule put them.
In a high-inflation path that's wrong in both directions for a household:

- **Variable-rate loans** track prime plus a spread (`resolveLoanRate`, design 56 Phase 3),
  so a 1970s-style path left mortgage rates flat and understated payment shock.
- **Prime-linked cash accounts** (`PrimeRelinkReducer`, design 56 §5) kept earning a
  pre-inflation rate, which understates what cash earns.

## 2. What history shows

December rates against that year's inflation (US CPI-U Dec→Dec; OECD AU CPI Q4 year-on-year),
fitted as a partial-adjustment rule `rate_t = ρ·rate_{t−1} + (1−ρ)·(c + β·π_t)`:

| | real rate (mean / sd) | ρ (smoothing) | β (response) | R² | residual sd | corr(Δrate, Δπ) |
|---|---|---|---|---|---|---|
| US bank prime, 1955–2025 | +3.3% / 2.2% | 0.63 | **1.31** | 0.84 | 1.3% | +0.60 |
| US prime, 1955–1982 | +2.7% / 2.0% | 0.50 | 1.19 | 0.90 | 1.3% | +0.78 |
| US prime, 1983–2025 | +3.7% / 2.3% | 0.73 | 1.98 | 0.78 | 1.2% | +0.34 |
| US fed funds, 1955–2025 | +1.0% / 2.4% | 0.61 | **1.27** | 0.81 | 1.6% | +0.53 |
| AU RBA cash rate, 1991–2024 | +1.6% / 2.4% | 0.75 | 1.76 | 0.82 | 0.9% | +0.58 |

- **β > 1:** central banks move more than one-for-one with inflation (the Taylor principle),
  but gradually. About 40% (US) or 25% (AU) of the gap closes each year.
- **About 1.3 points a year** of policy movement isn't explained by inflation (Volcker's
  overshoot, emergency cuts).
- **Bank prime has sat at fed funds + 3.1 points (sd 0.1) since 1995.** The engine's
  `usPrimeRate` is labelled and priced as the Fed **policy** rate (default 4.5%), so the
  fed funds fit (β 1.27, ρ 0.61) is the one that applies. It's nearly the prime fit, and
  it puts the floor near zero, not at 3%.

## 3. The rule

Each year, on the inflation tick (design 103 §4.2), each country's prime deviation from its
setting moves toward β times that country's inflation deviation:

    primeDev_t[cc] = ρ·primeDev_{t−1}[cc] + (1 − ρ)·β·inflationDev_t[cc]  (+ noise·z)

- It centres on the prime setting (`usPrimeRate` / `auPrimeRate`, or MC's per-path draw
  of it), so prime moves only when inflation leaves its anchor. A sustained +1 point of
  inflation settles at +β points of prime.
- It works in both inflation modes. In joint mode (design 103 §5) the inflation deviation
  comes from the historical year, so prime answers history's inflation through the rule
  rather than replaying history's prime.
- **Optional policy noise** (sd per year, default 0 = off) stands for the unexplained part.
  Its Gaussian is drawn only when the noise is above 0, after the inflation draws, so the
  default link consumes no randomness.
- **Floors:** each country's policy rate is clamped at its effective zero (US 0.25%, AU
  0.10%).

## 4. Either the schedule OR the link

`primeRateModel` selects ONE of two modes, and the UI shows only the settings of the
selected mode:

| mode | label | behaviour | settings shown |
|---|---|---|---|
| `SCHEDULE` (default) | Fixed, or stepped by the Prime Rate Schedule | the prime setting, stepped by any schedule rows (design 56) | Prime Rate Schedule |
| `INFLATION_LINKED` | Follows inflation — the Prime Rate Schedule is ignored | the rule of §3; the schedule is **not compiled** | β, ρ, floor, noise, for US and AU each |

`SCHEDULE` is the default so a saved plan with a schedule keeps it. With no rows it is the
flat prime setting, as before. `INFLATION_LINKED` needs the inflation path; without it
there is nothing to follow, and prime stays at its setting. Every description says so.

## 5. Wiring

- **`InflationTickHandler`** takes an optional `prime` config (`{ beta, rho, noise, floor }`
  per country), passed only in `INFLATION_LINKED` mode. It emits `primeDeviation` and
  `primeFloor` on `INFLATION_STEP_APPLY`.
- **`InflationStepReducer`** stores `state.primeDev` / `state.primeFloor`.
- **`InflationPathReducer`** (@PRE_PROCESS + 1.5) folds `primeDev` onto
  `effectiveInterestRates[PRIME_*]`, floored. That's after RegimeApplyReducer's reset
  (+1), and before PrimeRelinkReducer (+2), which fans the move onto every prime-linked
  cash account. Variable loans read the effective prime live, so no consumer changes.
- **The toolset** doesn't compile `primeSchedule` in `INFLATION_LINKED` mode.
- **Byte-identical by default:** single runs default to `SCHEDULE`, and the link acts only
  where a deviation is folded.

## 6. Monte Carlo

`mcPrimeRateModel`: `AUTO` (default) / `SCENARIO` / `SCHEDULE` / `INFLATION_LINKED`.
`AUTO` follows inflation when the plan chose `INFLATION_LINKED`, or has no schedule, and
the inflation path is running. A plan with a schedule keeps it, because the modes are
either/or and a written schedule is a choice. `perturbParams` writes the resolved
`primeRateModel` into every path. The pairing record carries `primeModel`, so a batch run
under a different mode is flagged as unpaired. MC's existing per-path draw of the prime
setting (`usPrimeRate` / `auPrimeRate`) stays: it's the anchor the link centres on.

## 7. Decisions (owner, 13 Sep 2026)

- Build it now; expose every knob as a setting. The UI must make the either/or plain.
- β 1.3 both countries; ρ US 0.6, AU 0.75 (post-war US fit; AU's own measured smoothing).
- Floors US 0.25%, AU 0.10%. The earlier proposal of 3% assumed bank prime; the engine's
  prime is the policy rate (§2).
- Monte Carlo default on (`AUTO`), recorded on the pairing record.
- Policy noise available but off by default.
- Joint mode uses the rule, not a replay of history's prime.

## 8. Not in scope

- Linking the bond yield level to inflation in Gaussian mode. Joint mode already moves it
  with each historical year's 10-year change (design 103 §5.1).
- Prime-linking a plan's fixed-rate cash accounts. That's a per-account `primeSpread`
  setting the engine already supports.
