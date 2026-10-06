# 120 — Currency-hedged and unhedged foreign equity

**Status:** DRAFT, rev 2, 5 Oct 2026. Nothing built. Rev 2 adds the Rest, RBA, MSCI and cost
sources (§3.1–3.5, all on disk in `docs/currency-hedging/` and `docs/market-returns/data/`) and
turns each §8 question into a recommendation for the author to confirm. It also adds Q7, the
FX–equity correlation, which the new data shows depends on the horizon.

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

### 3.1 How Australian super actually hedges

- **Super hedges about a quarter of its foreign equity.** Three sources agree: RBA Bulletin
  Mar 2023 (citing APRA, "around 25 per cent of their international equity investments",
  against about 70% of international debt), the RBA Deputy Governor's Sep 2025 speech
  ("around one-fifth"), and APRA Table 9a, June 2026 (0.255).
- **Rest Overseas Shares – Indexed is unhedged.** Its objective is the MSCI World
  ex-Australia ex-Tobacco index "(unhedged in AUD)" (Rest Investment Guide, effective 31 Aug
  2026, p.17). So the scenario's existing `sec-rest-os-index` is hedge ratio 0. For its
  diversified options Rest sets a currency-exposure target "at least annually" and does not
  publish it (p.12).
- **Why so low:** the RBA's reason is the natural hedge. The AUD is a "risk on" currency that
  falls when world equities fall, so "the minimum variance equity hedge ratio has been pretty
  low. Indeed on some measures it comes quite close to the average levels actually chosen by
  Australian industry super funds." The correlation "remained close to its historical
  average" through the 2025 turmoil. Footnote 9 gives the minimum-variance ratio as one minus
  correlation × the ratio of volatilities, which in this design's terms is h* = 1 + ρ·σ_L/σ_F.

### 3.2 What history shows, and the horizon problem

MSCI publishes the three bases of the same index side by side (World ex Australia, net, AUD;
factsheet Sep 30, 2026):

| since Jan 2001, annualized | return | std dev, 10 yr (monthly data) | max drawdown |
|---|---|---|---|
| 100% hedged to AUD | 8.14% | 14.06% | 55.04% (2007–09) |
| local currency | 7.16% | 13.99% | 55.02% |
| AUD, unhedged | 6.39% | 10.84% | 47.68% (2001–03) |

On **monthly** data the cushion is plain: unhedged is the low-volatility basis, and in the
GFC its drawdown was smaller than the hedged one. On the factsheet's 14 **calendar-year**
returns (2012–2025; OUR computation) it is much weaker:

| year | hedged | local | AUD | FX effect f | hedged − local |
|---|---|---|---|---|---|
| 2012 | 18.71 | 15.51 | 14.14 | −1.19 | +2.77 |
| 2013 | 32.26 | 29.18 | 48.03 | +14.59 | +2.38 |
| 2014 | 12.55 | 9.95 | 15.01 | +4.60 | +2.36 |
| 2015 | 3.83 | 2.10 | 11.80 | +9.50 | +1.69 |
| 2016 | 10.34 | 8.91 | 7.92 | −0.91 | +1.31 |
| 2017 | 20.02 | 18.69 | 13.38 | −4.47 | +1.12 |
| 2018 | −7.58 | −7.50 | 1.52 | +9.75 | −0.09 |
| 2019 | 26.81 | 27.43 | 27.97 | +0.42 | −0.49 |
| 2020 | 10.57 | 13.77 | 5.73 | −7.07 | −2.81 |
| 2021 | 23.88 | 24.33 | 29.58 | +4.22 | −0.36 |
| 2022 | −18.06 | −16.40 | −12.52 | +4.64 | −1.99 |
| 2023 | 21.66 | 23.32 | 23.23 | −0.07 | −1.35 |
| 2024 | 20.66 | 21.22 | 31.18 | +8.22 | −0.46 |
| 2025 | 18.65 | 18.65 | 12.53 | −5.16 | 0.00 |

f = (1+AUD)/(1+local) − 1; hedged − local = (1+hedged)/(1+local) − 1. Over these years
corr(f, local) = **−0.16**, sd(f) = 6.37%, and unhedged (14.86%) is *more* volatile than
hedged (13.59%). The AUD falls in a crash and recovers within the year, so a calendar-year
view sees little of the cushion. Fourteen points is a small sample, and 2012–2025 contains
a long AUD decline from about parity, which is also why unhedged led over the period.

This matters because the model's equity draw is **annual** (§2). See Q7.

### 3.3 Mean returns: parity or carry

The RBA's 2009 Bulletin (Baker & Wong) states both halves:
- **Theory (uncovered interest parity):** the currency moves to offset the rate gap, so
  "hedged mean returns (excluding transaction costs) should be reasonably similar to unhedged
  mean returns" over long horizons.
- **Practice:** over the prior two decades the best return for its volatility came from a
  hedge ratio "between 60 and 100 per cent for most investment horizons", "consistent with the
  Australian dollar having depreciated by less than implied by interest rate differentials".

That is the forward-premium puzzle. A hedge earns the carry, and the currency has not given it
back in full. J.P. Morgan's AUD matrix (hedged 0.7 points ahead of unhedged, §3) is a
forward-looking statement of the same thing. The hedged − local column in §3.2 has the sign
of the AU–foreign cash-rate gap of those years: positive while AU rates were the higher ones
(2012–17), negative after (the rate series themselves are not on disk). 2020's −2.81 is too
large to be carry. A hedge reset monthly against a market that fell and recovered within the
year leaves slippage too.

### 3.4 What hedging costs

RBA 2025 footnote 10: an FX swap costs the interest-rate differential "plus execution costs
and the liquidity/opportunity cost of meeting any variation margin or collateral". Morningstar
(secondary, quoting the issuer): VGAD's management fee is 0.21% plus 0.01% indirect costs,
against VGS's 0.18%. Rolling forwards costs "around 0.02 – 0.03% per year for major
developed-market currencies".

### 3.5 The basket's currencies

MSCI World ex Australia by country, Sep 30 2026: United States 74.07%, Japan 6%, United
Kingdom 3.47%, Canada 3.34%. The factsheet gives country weights, not currency weights. For
this index they are near enough the same thing.

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
local total plus carry. That is the forward-premium reading of §3.3, and it is what a
deterministic run shows: hedged and unhedged differ by the carry only. The **risk** difference
(§3 points 1 and 2, §3.1–3.2) appears only when the FX process and stochastic equity are both
on, which means Monte Carlo.

**A check the model must pass.** Under the calibration, the minimum-variance hedge ratio
h* = 1 + ρ·σ_L/σ_F (§3.1) should come out low, as the RBA says history's has. With ρ = −0.64,
σ_L = 15.19% and the model's USD/AUD σ_F = 11.42%, h* = 0.15. Super funds actually choose
0.20–0.26. With ρ = −0.16 (§3.2's annual figure) it is 0.67, which no evidence supports as
what funds do.

## 5. Engine changes

### 5.1 A hedge ratio on the security
Add `hedgeRatio` (0–1) and make `currency` a read field for equity securities. Both stay
silent by default, and silent means today's behaviour: no overlay at all. Following the
§10.2b rule, the editor offers `hedgeRatio` only once a reader consumes it. A lot without a
security takes its account's default, so super can carry APRA's 0.255 (§3) as a role
default, the way `DEFAULT_EQUITY_MARKET_MIX_BY_ROLE` does.

### 5.2 The currency an ex-AU basket is exposed to
`EQUITY_INTL_EX_AU` is about 70% US (shock-library comment), plus EUR, JPY, GBP and others.
The model has one pair. Proposal: use **USD_AUD as the basket's proxy pair** (the US is 74.07% of
the index, §3.5), with its volatility scaled to the basket's (§3 implies 9.86% against
USD/AUD's 11.42%, a factor of 0.86) through a per-market `fxExposureVol` factor. This is stated as a simplification, not hidden. A real
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
  MSCI's own local-currency series gives 13.99% (10-year, monthly data; §3.2), a
  cross-check.
- **Correlation with the US factor:** J.P. Morgan's AUD matrix pairs Developed World Equity
  hedged with an *unhedged-in-AUD* U.S. Large Cap (0.646), which is the wrong pair. Its USD
  matrix gives AC World Equity ~ U.S. Large Cap = **0.965**. In USD, that basket is close to a
  local view of a 74%-US index.
- **Result:** β = 0.965 × 15.19 / 18 = **0.81** (unchanged from today) and σ_idio =
  15.19 × √(1 − 0.965²) = **4.0%** (from 2.0%). Re-basing keeps the sleeve's co-movement with
  the US and doubles its own dispersion. The FX path then supplies what the AUD volatility
  used to imply.

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
- `cost` is `hedgeCost`, default **0.025%**, the midpoint of the forward-roll estimate
  (§3.4). The fee gap between a hedged fund and its unhedged twin (0.03% plus 0.01% indirect for
  VGAD) is left out, because no other security in the model carries a fee: the market totals
  are gross of fees (D99 §6.6).

### 5.7 Tax of the hedge
A hedged fund's forward contracts realise gains and losses inside the fund, and they reach
the investor in some character through the fund's distributions. **No primary source for
the Australian treatment is on disk**, so this design makes no claim about it. Phase 1 books
the carry and the hedge result in the price slice, which defers them to disposal. That is a
known gap, recorded here and not hidden. Rev 2's search turned up only secondary statements
that hedging profits appear in a fund's attribution amounts. None was fetched, because the
ATO site blocks scripted fetches, so none is relied on here. Closing it requires fetching the governing law
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
4. **Super hedge default** 0.255 from APRA (§3.1), plus the editor field and a
   `kind: node` help update for Security. The AU Single Homeowner REST lots state their hedge
   ratio explicitly: OS Index 0 (§3.1), AU Index not applicable.

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
- The §4 check: the minimum-variance hedge ratio measured on simulated paths falls in the low
  range history and funds point to (§3.1).

## 8. Questions for the author

Rev 2 recommends an answer to each, from the §3 sources. None is decided until the author
confirms.

- **Q1 — Expected FX drift.** *Recommend:* keep the anchor driftless (E[f] ≈ 0), so a hedged
  lot expects local + carry and an unhedged lot local. This is the forward-premium evidence
  (RBA 2009, §3.3) and J.P. Morgan's forward view, and it is the FX process's existing
  contract. Parity (E[f] = carry, equal means) can come later as a switch if the author wants
  to run that view. The rejected alternative was anchoring VGS at D99's sourced 7.5% unhedged
  total. That would bake in an FX forecast the sources do not agree on.
- **Q2 — Scope of the overlay.** *Recommend:* unchanged. Ex-AU lots in AUD accounts first;
  every source in §3 is about the AUD investor's world-ex-Australia exposure.
- **Q3 — Basket currency.** *Recommend:* USD_AUD as the proxy with a 0.86 volatility scale.
  The US is 74.07% of the index (§3.5), and J.P. Morgan's numbers imply the basket's FX
  volatility is 9.86% against USD/AUD's 11.42% (§3).
- **Q4 — Local-basis correlation.** *Answered by the sources:* ρ = 0.965 (J.P. Morgan USD AC
  World ~ U.S. Large Cap) and σ = 15.19%, giving β 0.81 / σ_idio 4.0% (§5.5).
- **Q5 — Carry and cost in an AU-only plan.** *Recommend:* carry = `auPrimeRate` − a foreign
  cash rate, so an RBA regime or a Prime sweep moves the carry as it does in reality (§3.3).
  An AU-only plan does not load US_BANKING, so ECONOMIC_REGIMES gains `hedgeForeignCashRate`,
  defaulting to the `usPrimeRate` default. A plan that has `usPrimeRate` uses it directly.
  Cost `hedgeCost` 0.025% (§3.4).
- **Q6 — Default for super.** *Recommend:* 0.255 for un-authored super. Three sources agree
  (§3.1), and the authored REST OS Index lot overrides it with 0. This moves no golden until
  phase 3, because with the overlay off a hedge ratio does nothing.
- **Q7 — The FX–equity correlation (new in rev 2).** On monthly data, and in J.P. Morgan's
  forward-looking matrix, the AUD's cushion is strong (ρ ≈ −0.64). On 14 calendar years it
  is weak (−0.16, §3.2). The model draws equity once a year, so which horizon is right is a
  real choice. *Recommend:* default ρ_FX = −0.64, as a parameter Monte Carlo can sweep, with
  −0.16 as the documented low end. −0.64 reproduces what the RBA and the funds' own behaviour
  say: a low minimum-variance hedge ratio (0.15 against funds' 0.20–0.26, §4). −0.16 gives
  0.67, and nothing in §3 supports that.
