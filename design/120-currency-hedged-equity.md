# 120 — Currency-hedged and unhedged foreign equity

**Status:** ACCEPTED, rev 3, 6 Oct 2026; building (§6). The author accepted the §8
recommendations by asking for the build.

- **Phase 1 BUILT** (6 Oct). The FX process (`fxProcessModel`, `fxVolatility`,
  `fxReversionSpeed`, the FX tick and the rate-composing reducers) is in ECONOMIC_REGIMES.
  - ECONOMIC_REGIMES contributes it only when a process model is on or US_AU_CROSS_BORDER
    is loaded. An AU-only plan at NONE gets no FX state, so every golden is byte-identical.
  - US_AU_CROSS_BORDER still contributes it when ECONOMIC_REGIMES is not in the compile.
  - **Change from §5.3:** `exchangeRateUsdToAud` stays in US_AU_CROSS_BORDER. Transfers
    convert at that level, while the overlay reads only the rate's moves (R_end / R_start),
    which the anchor does not change. Moving it would show an AU-only plan a rate that
    nothing in it reads.

- **Rev 2** (5 Oct) added the Rest, RBA, MSCI and cost sources (§3.1–3.5) and Q7, the
  FX–equity correlation.
- **Rev 3** (6 Oct) checks the model against how real hedged funds work.
  - **Tax** (§3.7, §5.7): Vanguard's own documents show two tax treatments. VGAD has used
    the TOFA hedging election since 1 July 2024. Before that, its hedge losses wiped out
    its distributions (nil in FY2022 and FY2023). The Act and the ATO guidance for both
    treatments are now on disk. Rev 2's "no primary source is on disk" was wrong: the Act
    was there.
  - **Correlation** (§3.6, Q7): the annual FX–equity correlation is now measured on the
    model's own pair and horizon. It changes by era, and Q7's default moves to that measurement.
  - **Timing** (§5.4): rev 2's correlation step could not run, because the equity draw comes
    after the FX ticks it was meant to steer. It is rewritten.
  - **Volatility** (§3, point 1): the claim that unhedged is always the lower-volatility choice
    is now limited to the periods where it holds.
  - **Carry** (§5.6): unchanged. The model's "Prime" is the central bank's policy rate, so the
    rev 2 carry formula was already right.

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
- **One equity factor, annual, drawn on 31 December.** `EquityReturnTickHandler` draws one
  market deviation a year, defined as the US market. Each sleeve takes
  `β·market + σ_idio·z`. The tick is a `year-end` series, which fires on 31 December of the
  year it belongs to (`simulation-adapter.js`, `endOfYear`). Under `rngStreams` the draw
  comes from the substream `('equity', year)`.
  - The ex-AU sleeve's β 0.81 / σ_idio 2.0% comes from an AUD-basis volatility (BlackRock
    "Global ex-Australia", AUD block, 14.72%).
  - Its correlation, though, is with the US market measured in AUD (0.9904), while the
    factor it loads on is the US market's USD volatility (0.18).
  - That mixes bases. It works today because nothing else in the model is in USD terms. It
    stops working the moment FX is applied to the sleeve (§5.5).
- **FX is a separate process, monthly, USD_AUD only.** `FxTickHandler` walks a log
  deviation around the `exchangeRateUsdToAud` anchor on its own RNG substream (`'fx'`).
  - Its ticks are a `monthly` series, which repeats on the start date's day of the month.
    All twelve ticks of a calendar year therefore run before that year's 31 December equity
    and growth ticks.
  - It is scheduled only when `fxProcessModel` is not NONE, and **only by
    `US_AU_CROSS_BORDER`**. An AU-only plan such as AU Single Homeowner cannot turn it on.
  - It has no correlation with the equity draw (`help/concepts/fx.md` names none, and the
    two handlers share no draw).
- **Equity growth posts annually.** `INTL_AU_STOCK_EARNINGS` and `INTL_AU_STOCK_DIVIDEND`
  fire at year end (`au-retirement-toolset.js`).
- **A security cannot say what currency it is exposed to.** `currency` is one of the five
  forward-declared security fields that nothing reads (`security-editor.js`).
- **The rates for the hedge carry are per country and live in different toolsets.**
  `auPrimeRate` (AU_BANKING) and `usPrimeRate` (US_BANKING) are each "the central-bank
  policy rate" (their parameter descriptions), not a bank's lending rate. An AU-only plan
  does not load US_BANKING.

## 3. What the sources say

Everything here is on disk in `docs/market-returns/data/` and `docs/currency-hedging/`.

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

**Read together, the sources say three things:**

1. **In the recent era, and in J.P. Morgan's forecast, unhedged is the *lower*-volatility
   choice for an AUD investor.** J.P. Morgan has 11.5% against 14.9%, and MSCI's 10-year
   monthly figures agree (§3.2). The AUD falls when world equities fall, so the currency gain
   cushions the equity loss, and hedging removes the cushion. **This does not hold in every
   period.**
   - The RBA's 2009 Bulletin found that over 1988–2008 "returns on the hedged equity
     portfolio had a lower variance than the unhedged equity portfolio", because a monthly
     correlation of about −0.4 "was not large enough to offset the additional volatility from
     the currency movements".
   - On annual data the cushion was absent in 1984–2003 (§3.6).
2. **Unhedged diversifies the domestic market better.** Its correlation with Australian
   equity is 0.65 against 0.84 (J.P. Morgan).
3. **The expected-return gap is a forecast, not a law.** J.P. Morgan has hedged ahead by
   0.7 points. That gap is its interest-rate differential plus its view of the AUD. With no
   currency view (an FX path that is centred on its anchor), the gap is the carry alone.

**Implied currency parameters (OUR computation, not published).** Take unhedged ≈ hedged
+ FX, with hedged standing in for the local-currency return. Then σ_U² = σ_H² + σ_F² +
2ρσ_Hσ_F.
- Solving that together with J.P. Morgan's ρ(U, H) = 0.748 gives a **basket FX volatility of
  9.86%** and an **FX–equity correlation of −0.635**.
- Holding σ_F at the model's own USD/AUD calibration (`fxVolatility` 0.1142, D92 §8.1) gives
  ρ = −0.646 instead.
- The sign convention is that FX is the AUD price of foreign currency, so it rises as the AUD
  falls.

**Super's hedge ratio is on disk too.** APRA Table 9a, June 2026 (`SOURCES.md` §P5c) gives
international listed equity hedged at 110,764 and unhedged at 323,642 (\$m). The hedged
share is 110,764 / 434,406 = **0.255** (OUR division). D99 pooled the two; this design
can separate them.

### 3.1 How Australian super actually hedges

- **Super hedges about a quarter of its foreign equity.** Three sources agree:
  - RBA Bulletin Mar 2023, citing APRA: "around 25 per cent of their international equity
    investments", against about 70% of international debt;
  - the RBA Deputy Governor's Sep 2025 speech: "around one-fifth";
  - APRA Table 9a, June 2026: 0.255.
- **Rest Overseas Shares – Indexed is unhedged.** Its objective is the MSCI World
  ex-Australia ex-Tobacco index "(unhedged in AUD)" (Rest Investment Guide, effective 31 Aug
  2026, p.17). So the scenario's existing `sec-rest-os-index` is hedge ratio 0. For its
  diversified options Rest sets a currency-exposure target "at least annually" and does not
  publish it (p.12).
- **Why so low:** the RBA's reason is the natural hedge.
  - The AUD is a "risk on" currency that falls when world equities fall, so "the minimum
    variance equity hedge ratio has been pretty low. Indeed on some measures it comes quite
    close to the average levels actually chosen by Australian industry super funds."
  - The correlation "remained close to its historical average" through the 2025 turmoil.
  - Footnote 9 gives the minimum-variance ratio as one minus correlation × the ratio of
    volatilities. In this design's terms that is h* = 1 + ρ·σ_L/σ_F.
  - Variance is not the only reason. The RBA's 2023 Bulletin names the liquidity risk of
    meeting margin calls on hedges. A fund's chosen ratio therefore cannot be read back as a
    pure minimum-variance estimate.

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

f = (1+AUD)/(1+local) − 1; hedged − local = (1+hedged)/(1+local) − 1.
- **What the 14 years show:** corr(f, local) = **−0.16** and sd(f) = 6.37%. Unhedged
  (14.86%) is *more* volatile than hedged (13.59%).
- **Why the cushion fades:** the AUD falls in a crash and recovers within the year, so a
  calendar-year view sees little of it.
- **Caveats:** fourteen points is a small sample. 2012–2025 also contains a long AUD decline
  from about parity, which is why unhedged led over the period.

This matters because the model's equity draw is **annual** (§2). §3.6 measures the annual
figure over a longer window, and Q7 decides.

### 3.3 Mean returns: parity or carry

The RBA's 2009 Bulletin (Baker & Wong) states both halves:
- **Theory (uncovered interest parity):** the currency moves to offset the rate gap, so
  "hedged mean returns (excluding transaction costs) should be reasonably similar to unhedged
  mean returns" over long horizons.
- **Practice:** over the prior two decades the best return for its volatility came from a
  hedge ratio "between 60 and 100 per cent for most investment horizons", "consistent with the
  Australian dollar having depreciated by less than implied by interest rate differentials".

That is the forward-premium puzzle. A hedge earns the carry, and the currency has not given it
back in full.
- **J.P. Morgan's forecast:** its AUD matrix (hedged 0.7 points ahead of unhedged, §3) states
  the same thing looking forward.
- **The §3.2 table:** the hedged − local column has the sign of the AU–foreign cash-rate gap
  of those years. It is positive while AU rates were the higher ones (2012–17) and negative
  after. The rate series themselves are not on disk.
- **Slippage:** 2020's −2.81 is too large to be carry. A hedge reset monthly against a market
  that fell and recovered within the year leaves slippage too.

### 3.4 What hedging costs

- **RBA 2025, footnote 10:** an FX swap costs the interest-rate differential "plus execution
  costs and the liquidity/opportunity cost of meeting any variation margin or collateral".
- **VGAD's PDS** (13 Mar 2026, `vanguard/`): management fees and costs are 0.22% p.a. That is
  a 0.21% fee plus 0.01% indirect costs, against VGS's 0.18% fee. Expenses of its TOFA hedging
  election are recovered from the fund. Vanguard's notice estimates them at about 0.01% p.a.
- **Rolling forwards** costs "around 0.02 – 0.03% per year for major developed-market
  currencies" (Morningstar, secondary).

### 3.5 The basket's currencies

MSCI World ex Australia by country, Sep 30 2026: United States 74.07%, Japan 6%, United
Kingdom 3.47%, Canada 3.34%. The factsheet gives country weights, not currency weights. For
this index they are near enough the same thing.

### 3.6 The annual correlation, measured on the model's own pair

`scripts/lab/fx-equity-correlation.mjs` (`npm run fx:equity-correlation`) measures it from
two series already on disk.
- **FX:** the packaged H.10 USD/AUD month-end series that `fxVolatility` is calibrated to.
- **Equity:** the S&P 500's nominal total return from Shiller's monthly file. The S&P is the
  factor the model's equity draw *is*.
- **Method:** returns run December to December. f is the change in AUD per USD, as in §3.
  The columns below are corr(f, local), annual σ_f, σ_local and σ_unhedged, and the
  minimum-variance hedge ratio h*.

| window | n | ρ | σ_f | σ_local | σ_unhedged | h* |
|---|---|---|---|---|---|---|
| 1984–2023 (post-float) | 40 | −0.17 | 11.50% | 16.23% | 20.26% | 0.76 |
| 1984–2003 | 20 | +0.16 | 12.24% | 16.30% | 23.78% | 1.21 |
| **2004–2023** | 20 | **−0.54** | 11.01% | 16.46% | 16.30% | **0.19** |
| 1988–2008 (RBA 2009's window) | 21 | −0.23 | 12.57% | 18.76% | 22.14% | 0.66 |
| 2012–2023 (MSCI overlap) | 12 | −0.24 | 7.83% | 13.39% | 15.33% | 0.60 |

What this says:

- **The correlation is a regime, not a constant.** Over 1984–2003 the AUD did not cushion US
  equity at all on an annual view. Over 2004–2023 it cushioned it strongly. The RBA's 2009
  Bulletin saw the start of the change: the correlation "has been more negative in recent
  years". A 20-year annual correlation has a standard error near 0.2, so the two halves differ
  by more than noise.
- **The recent regime matches the forward-looking sources.**
  - 2004–2023's −0.54 is within one standard error of J.P. Morgan's implied −0.635.
  - Its h* of 0.19 sits next to what super funds hold (0.20–0.26, §3.1).
  - The 40-year average (−0.17) gives h* 0.76, which nothing in §3.1 supports as fund
    behaviour.
- **MSCI's −0.16 (§3.2) is a slice of the recent era with only 14 points.** On the same years
  this measurement gives −0.24.
- **The FX volatility checks out.** The monthly H.10 series annualises to 11.6% on this
  window (calibrate-fx fits 11.42% from 1984). The model's `fxVolatility` needs no change.

### 3.7 How a hedged fund is taxed, and why it matters to the model

A hedged fund holds forward contracts that are settled every month, inside the fund. Whether
the hedge result reaches the investor as income each year or stays in the unit price depends
on one election.

**VGAD has made it.** Vanguard's notice to VGAD holders (28 Jun 2024, `vanguard/`):
"Vanguard Investments Australia will adopt the taxation of financial arrangements (TOFA)
hedging election" from 1 July 2024. The election aligns "the character and the timing of
realisation of hedge gains and losses to be consistent with the tax treatment of the
underlying assets being hedged", and "will likely result in a more consistent distribution".

The law, all on disk:
- **With the election** (ITAA 1997 Subdiv 230-E):
  - A gain or loss on a hedge of a CGT asset "is treated as a capital gain [or loss] from a
    CGT event" (s230-310(4), table item 1).
  - It is allocated to income years by the hedge record's determination (s230-300(3)). The
    ATO describes the timing as "matched with the timing of gains or losses on the hedged
    item" (TOFA guide, Elective methods).
  - The ATO's CGT guide puts the result "on the same basis as the capital gain or capital loss
    on the underlying CGT asset that is being hedged" (`docs/au-tax/ato-hedging/`).
- **Without it:**
  - The MIT capital-account choice covers shares, units, land and options over them, and
    expressly not "a Division 230 financial arrangement" (s275-105(1), (2)(a)).
  - So the forward's gain or loss is on revenue account. It falls under Div 230 or, where
    that does not apply, Div 775 (s775-15 gains assessable, s775-30 losses deductible).
  - An AMIT's assessable-income trust components are net of its deductions, and are nil when
    deductions are larger (s276-265(2), (3)).
  - The excess is a tax loss of the trust (s36-10), deducted from a later year's net income
    (s36-15(2)). It is never passed to the investor.

**What that looked like in VGAD before the election.** The PDS describes it: when the AUD
rises, "gains from currency hedging may result in additional income being distributed";
when it falls, "losses from currency hedging can offset other income received by the Fund,
resulting in reduced or no income distribution for the period". VGAD's annual report (year
to 30 June, %) shows it happening:

| | FY2026 | FY2025 | FY2024 | FY2023 | FY2022 |
|---|---|---|---|---|---|
| capital growth | 19.07 | 8.20 | 14.78 | 16.67 | (12.42) |
| distribution of income | 3.52 | 5.25 | 5.47 | — | — |
| total | 22.59 | 13.45 | 20.25 | 16.67 | (12.42) |

FY2022 and FY2023 paid nothing. A world-equity fund's dividends were absorbed by hedge losses
in two years when the AUD fell against the USD.

**What this means for the model.**
- **The total return is the same under both treatments.** Only how it splits between
  distribution and price differs, and so the character and timing of the investor's tax.
- **With the election,** the hedge result goes where the hedged shares' gains go. The model
  already treats those as unrealised until the investor sells (VGS today). So it belongs in
  the price slice. That was rev 2's phase 1, and it is right for VGAD from FY2025.
- **Without the election,** the result moves the distribution, and losses are trapped in the
  fund (§5.7).

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
them, which is how a partly hedged fund is run. The hedge's own result, per dollar of the lot at
the start of the year, is the difference between the hedged and unhedged lines, scaled by h:

```
hedge result  H = h·(carry − cost − f·(1 + r_L))
```

H is what §5.7 routes into the distribution or the price.

**The sleeve becomes local-currency.** `EQUITY_INTL_EX_AU` keeps its key, its total and its
yield, but its stochastic deviation is re-based to a local-currency volatility (§5.5), and
the FX path supplies the rest. Without that re-base, an unhedged lot would count currency
risk twice: once in the sleeve's AUD volatility and again in `f`.

**Correlation through the shared draw.** The equity tick draws the market z once a year.
The FX process needs a component of its year that loads on that same z with ρ_FX, plus an
independent part sized so the FX path's total volatility is unchanged:

```
annual FX shock  = ρ_FX·σ_F·z_market  +  √(1 − ρ_FX²)·σ_F·z_fx
```

ρ_FX is an **annual** correlation with the market draw. That is the model's horizon and the
quantity §3.6 measures.

**What the anchor means.** With the FX path centred on its anchor (the process's existing
contract), E[f] ≈ 0.
- **Means:** an unhedged lot then expects the local total, and a hedged lot the local total
  plus carry. That is the forward-premium reading of §3.3, and it is what a deterministic run
  shows: hedged and unhedged differ by the carry only.
- **Risk:** the difference (§3 points 1 and 2, §3.1–3.2, §3.6) appears only when the FX
  process and stochastic equity are both on, which means Monte Carlo.

**A check the model must pass.** Under the calibration, the minimum-variance hedge ratio
h* = 1 + ρ·σ_L/σ_F should come out low, as the RBA says history's has.
- **Inputs:** corr(f, r_L) = ρ_FX × 0.965, because the sleeve loads on the factor with that
  correlation (§5.5). σ_L is 15.19% and σ_F is the basket's 9.82% (§5.2).
- **At ρ_FX = −0.54:** h* ≈ 0.19. Super funds actually choose 0.20–0.26.
- **At the 40-year −0.17:** h* ≈ 0.74.

## 5. Engine changes

### 5.1 A hedge ratio on the security
Add `hedgeRatio` (0–1) and make `currency` a read field for equity securities.
- **Default:** both stay silent by default, and silent means today's behaviour: no overlay at
  all.
- **Editor:** following the §10.2b rule, the editor offers `hedgeRatio` only once a reader
  consumes it.
- **Lots without a security** take their account's default, so super can carry APRA's 0.255
  (§3) as a role default, the way `DEFAULT_EQUITY_MARKET_MIX_BY_ROLE` does.
- **Tax treatment:** a security with `hedgeRatio > 0` also has `hedgeTaxTreatment` (§5.7).

### 5.2 The currency an ex-AU basket is exposed to
`EQUITY_INTL_EX_AU` is about 70% US (shock-library comment), plus EUR, JPY, GBP and others.
The model has one pair.
- **Proposal:** use **USD_AUD as the basket's proxy pair**. The US is 74.07% of the index
  (§3.5).
- **Volatility:** scale the pair's volatility to the basket's through a per-market
  `fxExposureVol` factor. §3 implies 9.86% for the basket against USD/AUD's 11.42%, a factor
  of 0.86.
- This is stated as a simplification, not hidden. A real basket would need more currency
  pairs, which no other feature needs (Q3).

### 5.3 FX available to an AU-only plan
Move FX tick scheduling, `exchangeRateUsdToAud`, `fxProcessModel`, `fxVolatility` and
`fxReversionSpeed` out of `US_AU_CROSS_BORDER` and into `ECONOMIC_REGIMES`.
- **Cross-border plans:** `US_AU_CROSS_BORDER` keeps the §988 pools and transfers, and sees
  no change.
- **AU-only plans:** they gain the switch but run with it off by default, so they stay
  byte-identical (memory: the sim is bit-deterministic; the goldens pin
  `fxProcessModel: 'NONE'`).

### 5.4 Correlating the FX path with the equity draw

**The constraint.** The equity tick runs on 31 December of year Y and the FX ticks for Y run
before it (§2). An FX tick in March cannot read a draw that has not happened. Rev 2 had it
read a stamped `equityMarketZ[year]`, which would always be a year stale.

**The fix: the draw for year Y is a pure function of the seed and Y.**
- Under `rngStreams`, the equity tick's market z is the first normal drawn from substream
  `('equity', Y)` (`simulation.js`, `rngStream`).
- A shared helper `equityMarketZ(sim, Y)` returns it. The FX tick calls the helper in any
  month of Y. The year-end equity tick calls the same helper, so the two cannot disagree.
- No new event, no stamped state, and nothing about the equity path changes. The equity
  values with ρ on are the ones the same seed gives with ρ off, which makes the two arms
  common random numbers.

**The monthly split.** The FX ticks are monthly, so the correlated part is spread evenly
over that year's twelve steps:
- Each month's normal becomes `z_m = (ρ/√12)·z_market + √(1 − ρ²)·z_fx,m`.
- Over the year the correlated parts add to ρ·σ_F·z_market and the independent parts to
  variance (1 − ρ²)·σ_F². Total annual FX variance is unchanged.
- Mean reversion (0.114 a year) dilutes the realised annual correlation slightly. A test
  measures it (§7).

**The gates.**
- `fxEquityCorrelation` is the parameter, defaulting to 0. At 0 neither handler draws or
  reads anything new, so seeded runs keep their draw order
  (`equity-sleeve-rng-neutrality.test.mjs` is the model).
- A non-zero value **requires `rngStreams`** (Q9). Without it the market z is drawn from the
  shared cursor at year end and cannot be known in advance. The loader refuses the
  combination with a message saying so, rather than running an inert lever.
- `HISTORICAL_BOOTSTRAP` is excluded in this phase (Q10). The bootstrap's year depends on its
  block state, not on (seed, Y) alone. The loader refuses that combination too.
- The FX substream stays its own.

### 5.5 Re-basing the ex-AU sleeve
When the overlay is active (FX on and any lot exposed), the ex-AU sleeve's β / σ_idio must
describe the local-currency return. The inputs on disk:
- **Volatility:** J.P. Morgan "Developed World Equity hedged", 15.19% (§3).
  - This is the only local-basis figure for a developed-world basket an AUD investor holds.
  - Hedged ≈ local plus a near-constant carry, so the variance is the local variance.
  - MSCI's own local-currency series gives 13.99% (10-year, monthly data; §3.2), a
    cross-check.
- **Correlation with the US factor:**
  - J.P. Morgan's AUD matrix pairs Developed World Equity hedged with an *unhedged-in-AUD*
    U.S. Large Cap (0.646), which is the wrong pair.
  - Its USD matrix gives AC World Equity ~ U.S. Large Cap = **0.965**. In USD, that basket is
    close to a local view of a 74%-US index.
- **Result:** β = 0.965 × 15.19 / 18 = **0.81** (unchanged from today) and σ_idio =
  15.19 × √(1 − 0.965²) = **4.0%** (from 2.0%).
  - Re-basing keeps the sleeve's co-movement with the US and doubles its own dispersion.
  - The FX path then supplies what the AUD volatility used to imply.

When the overlay is off, the sleeve keeps today's AUD calibration exactly. So the re-base
is conditional, and both calibrations live side by side in `rate-keys.js`.

### 5.6 Applying the overlay
At the year-end growth tick (`computeHoldingsGrowth`), for a lot whose market is foreign
to the account's currency:

- **The FX move:** `f = R_end / R_start − 1`, where `R` is the AUD per unit of the exposure
  pair.
  - `R_start` is stored when that tick last ran (`fxLevelAtLastEquityTick`), so a mid-year
    purchase gets no special case: lots are marked once a year, as they are now.
  - The year's twelve FX ticks all precede the growth tick (§2), so no order band is needed.
- **The return:** the lot's total return becomes `(1 + g)(1 + (1 − h)·f) − 1 + h·(carry − cost)`,
  where `g` is the price growth the lot gets today. §5.7 decides how that total splits between
  the price and the distribution.
  - The dividend's own currency conversion happens before it is paid, so it is already in
    the market's AUD yield.
- **The carry:** `carry = Prime(AU) − Prime(foreign)`.
  - Both "Prime" parameters are central-bank policy rates (§2), which is the gap forward
    points follow, so an RBA regime or a Prime sweep moves the carry as it does in reality.
  - When the foreign rate is not in state (an AU-only plan has no US prime), it is
    `hedgeForeignCashRate`, a new ECONOMIC_REGIMES param (Q5).
- **The cost:** `cost` is `hedgeCost`, default **0.025%**, the midpoint of the forward-roll
  estimate (§3.4).
  - The fee gap between a hedged fund and its unhedged twin (0.04 points for VGAD) is left
    out, because no other security in the model carries a fee: the market totals are gross of
    fees (D99 §6.6).

### 5.7 Tax of the hedge

`hedgeTaxTreatment` is a per-security field with two values, matching §3.7.

**`ALIGNED`: the fund has made the TOFA hedging election (VGAD from FY2025).**
- The hedge result H stays in the price slice. The distribution is the market's dividend
  yield, exactly as for the unhedged twin.
- The investor's tax on H then arrives as a capital gain or loss when the lot is sold, under
  the lot's own holding period and discount, as the hedged shares' gains do today.
- **Simplification:** a real fund also realises some share gains each year from its own
  turnover and passes them on with their aligned hedge results. The model does not simulate
  turnover inside a fund for any security, VGS included, so this is consistent, not new.

**`INCOME`: no election (VGAD to FY2024, and any fund that has not elected).**
- Per security, the model keeps a per-unit carried loss `L` (state, starting at 0).
- At year end:

  ```
  distributed  D′ = max(0, D + H − L)
  carried      L′ = max(0, L − D − H)
  price slice       = total return − D′
  ```

  - D is the market dividend for the year and H the hedge result (§4).
  - The total return is unchanged, so `INCOME` and `ALIGNED` lots hold the same value at
    every year end. Only the split moves.
- **Character:**
  - The part of D′ that comes from a positive H is assessable as ordinary income. It is not a
    capital gain, so it has no discount and carries no foreign tax offset (s275-105(2)(a),
    s775-15).
  - A negative H reduces the year's components (s276-265(2)), and they are nil when it
    exceeds them (s276-265(3)). The rest carries forward (s36-15(2)).
- **Simplifications:**
  - Allocating a hedge loss across the dividend's components is "on a reasonable basis"
    (s276-270(2)). The model reduces them pro rata.
  - The trust-loss tests for carried losses are not modelled.
  - `L` is per unit of the security, so a lot bought after a loss year inherits it, as a
    real unitholder does.

**Super lots** take the overlay's return and no new tax path. The fund's hedge is taxed
inside the fund, as the rest of its earnings are today.

**Default** for a security with `hedgeRatio > 0` and no stated treatment: `ALIGNED` (Q8).

## 6. Phases

1. **FX into ECONOMIC_REGIMES** (§5.3). Pure move. Cross-border goldens stay byte-identical,
   and AU-only plans gain the switch.
2. **Security `hedgeRatio` + `currency`, and the overlay with `ALIGNED` tax** (§5.1, §5.6,
   §5.7).
   - The FX path is uncorrelated and the sleeve is not re-based.
   - Deterministic runs then show the carry difference, and nothing moves while every lot is
     silent.
3. **FX–equity correlation** (§5.4) and **sleeve re-base** (§5.5). This is the phase where
   the hedging choice changes risk.
   - Monte Carlo A/B on AU Single Homeowner: VGS against VGAD over the same seeds, paired.
   - `rngStreams` must be on in both arms. §5.4 makes it required, and the memory note
     "seed-matching is not CRN" explains why.
4. **`INCOME` tax treatment** (§5.7): the carried loss state, the split, and the
   ordinary-income character.
5. **Super hedge default** 0.255 from APRA (§3.1), plus the editor fields and a `kind: node`
   help update for Security.
   - The AU Single Homeowner REST lots state their hedge ratio explicitly: OS Index 0 (§3.1),
     AU Index not applicable.
   - VGAD, when added, states `ALIGNED`.

**Later:**
- **FX replay in the historical bootstrap** (Q10). For a bootstrap year after the 1983 float,
  replay that year's H.10 move, re-centred and rescaled like the equity series.
- **A parity switch** (Q1).

## 7. Tests

- **Goldens:** every phase leaves all goldens byte-identical while every security is silent
  and FX is off.
- **Overlay identities:**
  - h = 0 with FX off equals today exactly.
  - h = 1 with FX off equals today plus carry.
  - With FX on, h = 0 tracks `(1+g)(1+f)−1` to the cent.
- **Correlation:**
  - Over many seeds, the sample correlation of the annual FX return with `z_market` is within
    tolerance of ρ_FX, after the measured dilution from mean reversion.
  - Total FX volatility is unchanged against ρ = 0.
  - With ρ on and off, the equity path is byte-identical (§5.4).
- **Loader refusals:** ρ ≠ 0 without `rngStreams` is refused with a message, and so is ρ ≠ 0
  with `HISTORICAL_BOOTSTRAP`.
- **The §3 shape on the model:** with phases 1–3 on and ρ_FX at its default, the simulated
  unhedged ex-AU AUD return has lower volatility than hedged, and lower correlation with
  `EQUITY_AU`.
  - The volatility ordering holds only when corr(f, r_L) < −σ_F / (2σ_L) ≈ −0.32.
  - At ρ_FX = +0.16 (1984–2003, §3.6) it reverses. The test pins both sides of that line.
- **The §4 check:** the minimum-variance hedge ratio measured on simulated paths falls in the
  low range history and funds point to (§3.1, §3.6).
- **Tax treatments:**
  - `ALIGNED` and `INCOME` lots hold the same value at every year end.
  - Under `INCOME`, a year with H < −D distributes nil and carries the excess.
  - A later year with H > 0 first absorbs the carried loss.
  - The ordinary-income part of D′ reaches the AU tax computation without the CGT discount.

## 8. Questions for the author

Each question carries a recommendation from the §3 sources. None is decided until the author
confirms.

- **Q1 — Expected FX drift.** *Recommend:* keep the anchor driftless (E[f] ≈ 0), so a hedged
  lot expects local + carry and an unhedged lot local.
  - This is the forward-premium evidence (RBA 2009, §3.3) and J.P. Morgan's forward view, and
    it is the FX process's existing contract.
  - Parity (E[f] = carry, equal means) can come later as a switch if the author wants to run
    that view.
  - The rejected alternative was anchoring VGS at D99's sourced 7.5% unhedged total. That
    would bake in an FX forecast the sources do not agree on.
- **Q2 — Scope of the overlay.** *Recommend:* unchanged. Ex-AU lots in AUD accounts first;
  every source in §3 is about the AUD investor's world-ex-Australia exposure.
- **Q3 — Basket currency.** *Recommend:* USD_AUD as the proxy with a 0.86 volatility scale.
  The US is 74.07% of the index (§3.5), and J.P. Morgan's numbers imply the basket's FX
  volatility is 9.86% against USD/AUD's 11.42% (§3).
- **Q4 — Local-basis correlation.** *Answered by the sources:* ρ = 0.965 (J.P. Morgan USD AC
  World ~ U.S. Large Cap) and σ = 15.19%, giving β 0.81 / σ_idio 4.0% (§5.5).
- **Q5 — Carry and cost in an AU-only plan.** *Answered:* carry = `auPrimeRate` − the foreign
  policy rate.
  - Both Prime parameters are policy rates (§2), so no new rate is needed where both are
    loaded.
  - An AU-only plan does not load US_BANKING, so ECONOMIC_REGIMES gains
    `hedgeForeignCashRate`, defaulting to the `usPrimeRate` default (0.045).
  - Cost `hedgeCost` 0.025% (§3.4).
- **Q6 — Default for super.** *Recommend:* 0.255 for un-authored super.
  - Three sources agree (§3.1), and the authored REST OS Index lot overrides it with 0.
  - This moves no golden until phase 3, because with the overlay off a hedge ratio does
    nothing.
- **Q7 — The FX–equity correlation (revised in rev 3).** *Recommend:* `fxEquityCorrelation`
  as an annual correlation, swept by Monte Carlo over +0.16 to −0.64. Two choices of default:
  - **(a) −0.54,** the 2004–2023 annual measurement on the model's own pair (§3.6). It agrees
    with J.P. Morgan's forward view (−0.635) and with what super funds hold (h* 0.19 against
    0.20–0.26).
  - **(b) 0,** with −0.54 recommended in studies. This keeps the parameter neutral at the
    cost of a default that matches no era.
  - **Recommend (a).** The +0.16 end is 1984–2003, the stress case in which hedging was the
    lower-risk choice. The 40-year −0.17 averages two regimes and describes neither.
- **Q8 — Default tax treatment for a hedged security (new).** *Recommend:* `ALIGNED`.
  - VGAD, the hedged fund this design exists for, has used the election since FY2025 (§3.7).
  - `INCOME` stays available for funds that have not elected, and for anyone modelling VGAD
    before FY2025.
  - The alternative is to require the field whenever `hedgeRatio > 0`.
- **Q9 — `rngStreams` required for a correlated FX path (new).** *Recommend:* yes, refused at
  load otherwise (§5.4).
  - The alternative is to put the equity and FX draws on keyed streams whenever ρ ≠ 0. That
    changes the equity path between a ρ = 0 and a ρ ≠ 0 run, which spoils the comparison the
    parameter exists for.
- **Q10 — The historical bootstrap (new).** *Recommend:* refuse ρ ≠ 0 under
  `HISTORICAL_BOOTSTRAP` in phase 3. Then add FX replay as the Later item in §6.
  - A bootstrap year after 1983 has a real AUD move on disk.
  - Replaying it gives history's tail behaviour, which a normal correlation cannot.
