# 120 — Currency-hedged and unhedged foreign equity

**Status:** DRAFT, rev 1, 5 Oct 2026. Nothing built. The questions in §8 are for the author.

## 1. The ask

> Lets take a look at adding these 2 securities into the AU Single Homeowner prebuilt
> scenario. The thing I'm interested in is how and if we would model the hedged vs non
> hedged security. These Vanguard funds, domiciled in Australia: VGS VAS

VAS and VGS went into the scenario on the markets the engine already has (`EQUITY_AU`,
`EQUITY_INTL_EX_AU`). With them came a fix: the AU brokerage had been franking every
dividend, ex-AU lots included. This design covers the part that was left open: a
**hedged** foreign-equity fund (VGAD is VGS's hedged twin) next to an **unhedged** one,
modelled so the choice between them means something.

## 2. What the engine does today

- **No FX effect on equity growth.** A lot grows at its market's rate in the account's
  currency (`holdings-earnings.js`). D99 §6.6 picked the inputs to match: every AUD market
  total is an **unhedged** AUD figure (`docs/market-returns/SOURCES.md`, "AUD figures are
  UNHEDGED"). So VGS maps exactly onto `EQUITY_INTL_EX_AU`. The currency risk lives inside
  that sleeve's return distribution and is not a separate process.
- **One equity factor, annual.** `EquityReturnTickHandler` draws one market deviation a
  year, defined as the US market. Each sleeve takes `β·market + σ_idio·z`. The ex-AU sleeve's
  β 0.81 / σ_idio 2.0% comes from an AUD-basis volatility (BlackRock "Global ex-Australia",
  AUD block, 14.72%). Its correlation, though, is with the US market measured in AUD
  (0.9904), while the factor it loads on is the US market's USD volatility (0.18). That
  mixes bases. It works today because nothing else in the model is in USD terms. It stops
  working the moment FX is applied to the sleeve (§5.5).
- **FX is a separate process, monthly, USD_AUD only.** `FxTickHandler` walks a log
  deviation around the `exchangeRateUsdToAud` anchor on its own RNG substream (`'fx'`). It
  is scheduled only when `fxProcessModel` is not NONE, and **only by `US_AU_CROSS_BORDER`**.
  An AU-only plan such as AU Single Homeowner cannot turn it on. It has no correlation with
  the equity draw (`help/concepts/fx.md` names none, and the two handlers share no draw).
- **Equity growth posts annually.** `INTL_AU_STOCK_EARNINGS` and `INTL_AU_STOCK_DIVIDEND`
  fire at year end (`au-retirement-toolset.js`).
- **A security cannot say what currency it is exposed to.** `currency` is one of the five
  forward-declared security fields that nothing reads (`security-editor.js`).
- **The cash rates for the hedge carry are per country and live in different toolsets.**
  `auPrimeRate` is in AU_BANKING and `usPrimeRate` in US_BANKING, which an AU-only plan
  does not load.

## 3. What the sources say

Everything here is on disk in `docs/market-returns/data/`.

**Only J.P. Morgan publishes both bases for an AUD investor.** From its 2026 LTCMA AUD matrix
(`JPM-LTCMA-2026-matrix-AUD.xlsx`; compound return column C, volatility column E,
correlations from the lower triangle, read per `SOURCES.md`):

| row | compound return | volatility | ρ with Australian Equity |
|---|---|---|---|
| AC World Equity (unhedged) | 6.5% | 11.49% | 0.648 |
| AC World Equity hedged | 7.2% | 14.85% | 0.836 |
| Developed World Equity hedged | 7.2% | 15.19% | 0.836 |
| Australian Equity | 7.0% | 14.33% | 1 |
| Australian Cash | 3.4% | 0.70% | — |

ρ(AC World unhedged, AC World hedged) = 0.748. The matrix has no unhedged
developed-world row, and no world-ex-Australia row on either basis (`SOURCES.md` ‡).

Vanguard's AUD report (Figure 5b) gives "Global Equity (unhedged)" only. BlackRock's AUD block
gives "Global ex-Australia" on the unhedged basis only.

**Read together, these say three things:**

1. **Unhedged is the *lower*-volatility choice for an AUD investor.** 11.5% against 14.9%:
   the AUD falls when world equities fall, so the currency gain cushions the equity loss.
   Hedging removes the cushion.
2. **Unhedged diversifies the domestic market better.** Its correlation with Australian
   equity is 0.65 against 0.84.
3. **The expected-return gap is a forecast, not a law.** J.P. Morgan has hedged ahead by
   0.7 points. That gap is its interest-rate differential plus its view of the AUD. With no
   currency view (an FX path that is centred on its anchor), the gap is the carry alone.

**Implied currency parameters (OUR computation, not published).** Take unhedged ≈ hedged
+ FX, with hedged standing in for the local-currency return. Then σ_U² = σ_H² + σ_F² +
2ρσ_Hσ_F. Solving that together with J.P. Morgan's ρ(U, H) = 0.748 gives a **basket FX
volatility of 9.86%** and an **FX–equity correlation of −0.635**. Holding σ_F at the model's
own USD/AUD calibration (`fxVolatility` 0.1142, D92 §8.1) gives ρ = −0.646 instead. The sign
convention is that FX is the AUD price of foreign currency, so it rises as the AUD falls.

**Super's hedge ratio is on disk too.** APRA Table 9a, June 2026 (`SOURCES.md` §P5c) gives
international listed equity hedged at 110,764 and unhedged at 323,642 (\$m). The hedged
share is 110,764 / 434,406 = **0.255** (OUR division). D99 pooled the two; this design
can separate them.

## 4. The model

For an AUD holder of a foreign market whose local-currency return is `r_L`, write `f` for
the period's change in the AUD price of the foreign currency and `h ∈ [0, 1]` for the
fund's hedge ratio:

```
unhedged  (h = 0):  r = (1 + r_L)(1 + f) − 1
hedged    (h = 1):  r = r_L + carry − cost
general:            r = (1 + r_L)(1 + (1 − h)·f) − 1 + h·(carry − cost)
carry = i_AU − i_foreign        (the forward points a rolling FX hedge earns or pays)
```

The general line is an approximation. Exact for h = 0 and h = 1, it is linear in h between
them, which is how a partly hedged fund is run.

**The sleeve becomes local-currency.** `EQUITY_INTL_EX_AU` keeps its key, its total and its
yield, but its stochastic deviation is re-based to a local-currency volatility (§5.5), and
the FX path supplies the rest. Without that re-base, an unhedged lot would count currency
risk twice: once in the sleeve's AUD volatility and again in `f`.

**Correlation through the shared draw.** The equity tick draws the market z once a year.
The FX process needs a component of its year that loads on that same z with ρ_FX (≈ −0.64,
§3), plus an independent part sized so the FX path's total volatility is unchanged:

```
annual FX shock  = ρ_FX·σ_F·z_market  +  √(1 − ρ_FX²)·σ_F·z_fx
```

**What the anchor means.** With the FX path centred on its anchor (the process's existing
contract), E[f] ≈ 0. An unhedged lot then expects the local total, and a hedged lot the
local total plus carry. That is the no-currency-view reading, and it is what a deterministic
run shows: hedged and unhedged differ by the carry only. The **risk** difference (§3 points
1 and 2) appears only when the FX process and stochastic equity are both on, which means
Monte Carlo.

## 5. Engine changes

### 5.1 A hedge ratio on the security
Add `hedgeRatio` (0–1) and make `currency` a read field for equity securities. Both stay
silent by default, and silent means today's behaviour: no overlay at all. Following the
§10.2b rule, the editor offers `hedgeRatio` only once a reader consumes it. A lot without a
security takes its account's default, so super can carry APRA's 0.255 (§3) as a role
default, the way `DEFAULT_EQUITY_MARKET_MIX_BY_ROLE` does.

### 5.2 The currency an ex-AU basket is exposed to
`EQUITY_INTL_EX_AU` is about 70% US (shock-library comment), plus EUR, JPY, GBP and others.
The model has one pair. Proposal: use **USD_AUD as the basket's proxy pair**, with its
volatility scaled to the basket's (§3 implies 9.86% against USD/AUD's 11.42%) through a
per-market `fxExposureVol` factor. This is stated as a simplification, not hidden. A real
basket would need more currency pairs, which no other feature needs (Q3).

### 5.3 FX available to an AU-only plan
Move FX tick scheduling, `exchangeRateUsdToAud`, `fxProcessModel`, `fxVolatility` and
`fxReversionSpeed` out of `US_AU_CROSS_BORDER` and into `ECONOMIC_REGIMES`.
`US_AU_CROSS_BORDER` keeps the §988 pools and transfers. A cross-border plan sees no change.
An AU-only plan gains the switch but runs with it off by default, so it stays byte-identical
(memory: the sim is bit-deterministic; the goldens pin `fxProcessModel: 'NONE'`).

### 5.4 Correlating the FX path with the equity draw
`EquityReturnTickHandler` already holds `z_market`. It stamps it to state
(`equityMarketZ[year]`). `FxTickHandler` reads it and splits its annual variance per §4.
The FX ticks are monthly and the equity tick is annual, so the correlated part enters as
a drift spread over that year's twelve steps (`ρσ_F·z_market/12` per month), and the monthly
independent shock is scaled by √(1 − ρ²). Total FX variance is unchanged. Gated:
`fxEquityCorrelation` defaults to 0, and at 0 neither handler draws or reads anything new,
so seeded runs keep their draw order (`equity-sleeve-rng-neutrality.test.mjs` is the
model). Under `rngStreams` the FX substream stays its own.

### 5.5 Re-basing the ex-AU sleeve
When the overlay is active (FX on and any lot exposed), the ex-AU sleeve's β / σ_idio must
describe the local-currency return. The inputs on disk:
- **Volatility:** J.P. Morgan "Developed World Equity hedged", 15.19% (§3). This is the
  only local-basis figure for a developed-world basket an AUD investor holds. Hedged ≈
  local plus a near-constant carry, so the variance is the local variance.
- **Correlation with the US factor:** J.P. Morgan's AUD matrix gives Developed World
  Equity hedged ~ U.S. Large Cap = 0.646. But that U.S. Large Cap is the *unhedged-in-AUD*
  row, so it is the wrong pair. The USD matrix needs reading for a local-to-local figure
  (Q4).

When the overlay is off, the sleeve keeps today's AUD calibration exactly. So the re-base
is conditional, and both calibrations live side by side in `rate-keys.js`.

### 5.6 Applying the overlay
At the year-end growth tick (`computeHoldingsGrowth`), for a lot whose market is foreign
to the account's currency:

- `f = R_end / R_start − 1`, where `R` is the AUD per unit of the exposure pair.
  `R_start` is stored when that tick last ran (`fxLevelAtLastEquityTick`), so a
  mid-year purchase gets no special case: lots are marked once a year, as they are now.
- The price slice becomes `(1 + g)(1 + (1 − h)·f) − 1 + h·(carry − cost)`, where `g` is
  the price growth the lot gets today. The dividend slice is unchanged. A foreign
  dividend's currency conversion happens before it is paid, so it is already in the
  market's AUD yield.
- `carry = Prime(AU) − Prime(foreign)` when both are in state. When they are not (an
  AU-only plan has no US prime), it is `hedgeCarry`, a new ECONOMIC_REGIMES param (Q5).
- `cost` is `hedgeCost`, default 0, with no source on disk for a value (Q5).

### 5.7 Tax of the hedge
A hedged fund's forward contracts realise gains and losses inside the fund, and they reach
the investor in some character through the fund's distributions. **No primary source for
the Australian treatment is on disk**, so this design makes no claim about it. Phase 1 books
the carry and the hedge result in the price slice, which defers them to disposal. That is a
known gap, recorded here and not hidden. Closing it requires fetching the governing law
first (memory: never quote tax law not on disk).

## 6. Phases

1. **FX into ECONOMIC_REGIMES** (§5.3). Pure move. Cross-border goldens stay byte-identical,
   AU-only plans gain the switch.
2. **Security `hedgeRatio` + `currency`, and the overlay** (§5.1, §5.6) with the FX path
   uncorrelated and the sleeve not re-based. Deterministic runs then show the carry
   difference, and nothing moves while every lot is silent.
3. **FX–equity correlation** (§5.4) and **sleeve re-base** (§5.5). This is the phase where
   the hedging choice changes risk. Monte Carlo A/B on AU Single Homeowner: VGS against
   VGAD over the same seeds, paired (`rngStreams` on in both arms; memory: seed-matching
   is not CRN).
4. **Super hedge default** 0.255 from APRA (§3), plus the editor field and a
   `kind: node` help update for Security.

## 7. Tests

- Every phase: all goldens byte-identical while every security is silent and FX is off.
- Overlay identities: h = 0 with FX off equals today exactly. h = 1 with FX off equals
  today plus carry. With FX on, h = 0 tracks `(1+g)(1+f)−1` to the cent.
- Correlation: over many seeds, the sample correlation of the annual FX return with
  `z_market` is within tolerance of ρ_FX, and total FX volatility is unchanged against
  ρ = 0.
- The §3 shape on the model: with phases 1–3 on, the simulated unhedged ex-AU AUD return
  has lower volatility than hedged, and lower correlation with `EQUITY_AU`. This is the
  test that the design delivers its point.

## 8. Questions for the author

- **Q1 — Expected FX drift.** Should the anchor stay a no-view centre (E[f] ≈ 0, so hedged
  beats unhedged by the carry in expectation)? Or should the market total stay anchored on
  the sourced *unhedged* AUD figure, with the local total derived from it? The second keeps
  D99's 7.5% for VGS and makes VGAD = 7.5% − E[f] + carry. Recommendation: the first, which is
  the process's existing contract and needs no FX forecast.
- **Q2 — Scope of the overlay.** Only `EQUITY_INTL_EX_AU` (the AUD investor's case), or
  every market foreign to its account? That would include US lots held in an AU account
  in the intl plan, and `EQUITY_INTL_EX_US` in USD accounts against AUD. Recommendation:
  ex-AU in AUD accounts first. The others need pairs and sources this design does not have.
- **Q3 — Basket currency.** Is USD_AUD with a vol scale (§5.2) an acceptable proxy, or does
  this need a trade-weighted pair?
- **Q4 — Local-basis correlation source.** Should we read J.P. Morgan's USD matrix for a
  developed-world local ~ U.S. Large Cap correlation (§5.5), or accept BlackRock's USD block
  if it has a world-ex-Australia row? Neither has been checked yet.
- **Q5 — Carry and cost in an AU-only plan.** Should there be a `hedgeCarry` param, or
  should AU-only plans gain `usPrimeRate` so the carry follows both central banks? Is there
  any source for a hedge cost, or does it stay 0?
- **Q6 — Default for super.** Should we apply APRA's 0.255 hedge ratio to un-authored super
  (moves every super golden once phase 3 is on in MC), or leave super unhedged until a
  plan authors it?
