# Currency hedging — sources (design 120)

Fetched 5 Oct 2026 with `curl` (each fetched directly; none blocked). `.txt` files are
`pdftotext -layout` extractions, or tag-stripped HTML, of the file beside them. Two MSCI
factsheets for this design live with the other index factsheets in
`docs/market-returns/data/`.

| file | publisher | what it is | as of |
|---|---|---|---|
| `RBA-Bulletin-2009-09-impact-of-currency-hedging-on-returns.pdf` | Reserve Bank of Australia | Baker & Wong, "The Impact of Currency Hedging on Investment Returns", Bulletin Sep 2009 | data to 2009 |
| `RBA-Bulletin-2023-03-foreign-currency-exposure-and-hedging.pdf` | Reserve Bank of Australia | Atkin & Harris, "Foreign Currency Exposure and Hedging in Australia", Bulletin Mar 2023 (2022 ABS survey) | 31 Mar 2022 |
| `RBA-speech-2025-09-16-hedge-between.html` | Reserve Bank of Australia | Deputy Governor speech, "A Hedge Between Keeps Friendship Green", 16 Sep 2025 | 2025 |
| `Rest-investing-made-simple-guide.pdf` | Rest | Investment Guide | effective 31 Aug 2026 |
| `Morningstar-AU-currency-trap-hedged-etfs.html` | Morningstar Australia | "Young & Invested: The currency trap catching ETF investors off guard" — SECONDARY (fees quoted from the issuer) | 2026 |
| `../market-returns/data/MSCI-World-ex-Australia-100pct-Hedged-to-AUD-factsheet.pdf` | MSCI | MSCI World ex Australia 100% Hedged to AUD Index (AUD) — annual returns hedged / local / AUD side by side, risk statistics | Sep 30, 2026 |
| `../market-returns/data/MSCI-World-ex-Australia-Index-USD-factsheet.pdf` | MSCI | MSCI World ex Australia Index (USD) — country weights | Sep 30, 2026 |

Not fetchable: Vanguard's VGS / VGAD product pages render from JavaScript (both URLs
return the same 458 KB shell with no fund data), so the fee figures are Morningstar's.

## Figures used

**Super's foreign-equity hedge ratio — three sources, one answer.**
- RBA Bulletin Mar 2023, citing APRA: super funds "hedge around 70 per cent of their
  international debt and unlisted infrastructure investments, but only around 25 per cent
  of their international equity investments".
- RBA speech Sep 2025: the super sector "is estimated to hedge only around one-fifth of the
  value of its overseas listed equity positions".
- APRA Table 9a, June 2026 (`docs/market-returns/SOURCES.md` §P5c): 110,764 hedged of
  434,406 international listed equity = 0.255 (our division).

**Rest Overseas Shares – Indexed is unhedged.** Investment Guide p.17: objective is to
"perform in line with the MSCI World ex-Australia ex-Tobacco Net Dividends Reinvested Index
(unhedged in AUD)". For its other options Rest sets "how much overseas currency exposure we
want to hold … (at least annually)" and does not publish the target (p.12).

**Mean returns — parity in theory, carry in practice.** RBA 2009: under uncovered interest
parity "the hedged mean returns (excluding transaction costs) should be reasonably similar to
unhedged mean returns" over long horizons, but over the prior two decades the hedge ratio with
the best return for its volatility "would have been between 60 and 100 per cent for most
investment horizons", "consistent with the Australian dollar having depreciated by less than
implied by interest rate differentials".

**The AUD as a natural hedge.** RBA 2025: the AUD "has historically provided a pretty decent
'natural' hedge"; its correlation with US equities "remained close to its historical average"
through the 2025 turmoil; "the minimum variance equity hedge ratio has been pretty low".
Footnote 9 gives the ratio as one minus correlation × volatility ratio. Footnote 10: the cost
of an FX swap is the interest differential plus execution and collateral costs.

**Hedged, local and unhedged history (MSCI, net, AUD).** Annualized since 31 Jan 2001:
hedged 8.14%, local 7.16%, AUD unhedged 6.39%. Annualized std dev from monthly returns:

| | 3 yr | 5 yr | 10 yr | max drawdown |
|---|---|---|---|---|
| 100% hedged to AUD | 10.98 | 14.04 | 14.06 | 55.04% (Oct 2007 – Mar 2009) |
| local | 11.13 | 13.98 | 13.99 | 55.02% |
| AUD (unhedged) | 9.43 | 10.88 | 10.84 | 47.68% (Feb 2001 – Mar 2003) |

From the 14 calendar years 2012–2025 in the same factsheet (OUR computation; the
year-by-year inputs and arithmetic are in design 120 §3.2): FX effect f = (1+AUD)/(1+local) − 1 has sd 6.37% and correlation
**−0.16** with the local return; sd hedged 13.59%, local 13.21%, unhedged 14.86%. On annual
data the cushion is much weaker than on monthly data, and n = 14 is small.

**Basket currency.** MSCI World ex Australia country weights, Sep 30 2026: United States
74.07%, Japan 6%, United Kingdom 3.47%, Canada 3.34%.

**Hedging cost (secondary).** Morningstar: VGAD "management fee of 0.21% p.a. and indirect
costs of 0.01% p.a."; VGS 0.18% p.a. Rolling forwards costs "around 0.02 – 0.03% per year
for major developed-market currencies".

**Local-basis correlation (J.P. Morgan 2026 LTCMA USD matrix, on disk in
`docs/market-returns/data/`).** AC World Equity ~ U.S. Large Cap 0.965 (vol 16.78%); EAFE
Equity ~ U.S. Large Cap 0.874.
