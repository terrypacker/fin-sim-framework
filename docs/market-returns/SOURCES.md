# Market-return sources — provenance (design 99 P5b)

The four equity markets' default TOTAL returns and dividend YIELDS
(`src/finance/economic-regimes/market-returns.js`) set every plan's baseline return, so
they get the same treatment as tax law and the shock calibration
(`docs/economic-shocks/SOURCES.md`): **fetch the source onto disk first, then cite it.**
Nothing here is quoted from memory or from a search-result summary. One search summary
quoted MSCI World ex Australia's AUD yield as 1.65%; the factsheet on disk says 1.47%.

Re-fetch the scripted sources with `docs/market-returns/fetch-sources.sh` (into `data/`).

## Decisions (with the user, 10 Sep 2026)

- **Totals: an average of several forward-looking capital-market-assumption (CMA)
  providers**, not one provider's view. The three providers below disagree by up to ~4
  points on US equity — the reason to average rather than pick.
- **International ex-US means DEVELOPED ex-US**, matching common fund types. Emerging
  markets become their own market later, rather than being blended in here.
- **Horizon: 10 years** (J.P. Morgan publishes 10–15 years).
- **Geometric (compound), nominal, gross of fees.** BlackRock states "All component numbers
  are geometric" and "The published returns are gross of fees"; Vanguard's VCMM figures
  are annualised 10-year returns.
- **AUD figures are UNHEDGED.** The engine applies no exchange-rate effect to equity
  growth (`holdings-earnings.js`), so an ex-AU lot in an AUD account earns its AUD rate
  and the unhedged AUD return is the right one — no double counting.
- **Yields: MSCI standard-index factsheets** — the same indices the CMA rows are defined on.

## Files

| file | publisher | what | as of |
|---|---|---|---|
| `Vanguard-US-VCMM-return-forecasts-2026-06-30.html` (+ `.txt`) | Vanguard | VCMM 10-year annualised nominal return RANGES, USD | June 30, 2026 |
| `Vanguard-AU-Asset-allocation-report-2026Q2.pdf` (+ `.txt`) | Vanguard Australia | Asset allocation report, June quarter 2026: Figure 5b, 10-year nominal return percentiles, AUD | 31 May 2026 VCMM simulation (the report's closing methodology note says December 2025; the figure notes say 31 May 2026) |
| `BlackRock-CMA-2026.xlsx` | BlackRock Investment Institute | CMA workbook, sheet "Starting point" (the headline scenario), expected returns by horizon | August 2026, data as of 30 June 2026 |
| `BlackRock-CMA-page-2026.html` (+ `.txt`) | BlackRock | The CMA page: return definitions ("geometric", "gross of fees") | August 2026 |
| `MSCI-USA-Index-USD-factsheet.pdf` (+ `.txt`) | MSCI | MSCI USA Index factsheet | Aug 31, 2026 |
| `MSCI-World-ex-USA-Index-USD-factsheet.pdf` (+ `.txt`) | MSCI | MSCI World ex USA Index factsheet | Aug 31, 2026 |
| `MSCI-Australia-Index-AUD-factsheet.pdf` (+ `.txt`) | MSCI | MSCI Australia Index factsheet | Aug 31, 2026 |
| `MSCI-World-ex-Australia-Index-AUD-factsheet.pdf` (+ `.txt`) | MSCI | MSCI World ex Australia Index (AUD) factsheet | Aug 31, 2026 |
| `JPM-LTCMA-2026-full-report.pdf` (+ `.txt`) | J.P. Morgan Asset Management | 2026 Long-Term Capital Market Assumptions, full report; horizon 10–15 years | estimates as of September 30, 2025 (downloaded by hand, 10 Sep 2026) |
| `JPM-LTCMA-2026-matrix-USD.xlsx` | J.P. Morgan Asset Management | "2026 Long-Term Capital Market Assumptions – USD" assumptions matrix | as above |
| `JPM-LTCMA-2026-matrix-AUD.xlsx` | J.P. Morgan Asset Management | "2026 Long-Term Capital Market Assumptions – AUD" assumptions matrix | as above |

## Figures taken from them

### Total returns, 10-year, geometric, nominal

| market (model key) | index | Vanguard | BlackRock | J.P. Morgan |
|---|---|---|---|---|
| US — `usEquityGrowthRate` (USD) | MSCI USA | 4.2%–6.2% range; midpoint 5.2%* | 8.97% | 6.7% (U.S. Large Cap) |
| Developed ex-US — `intlExUsEquityGrowthRate` (USD) | MSCI World ex-US | 4.5%–6.5% range; midpoint 5.5%* | 7.77% | 7.5% (EAFE Equity)† |
| Australia — `auEquityGrowthRate` (AUD) | MSCI Australia | 6.2% (median) | 6.87% | 7.0% (Australian Equity) |
| International ex-AU — `intlExAuEquityGrowthRate` (AUD) | MSCI World ex Australia | 5.9% (median, "Global Equity (unhedged)") | 9.00% | no ex-Australia row‡ |

† EAFE is J.P. Morgan's nearest developed-ex-US row; it omits Canada (about 8% of MSCI
World ex-US). ‡ The AUD matrix has no world-ex-Australia equity row. Its nearest unhedged
row is AC World Equity at 6.5%, which also holds emerging markets (about 10%) and Australia
itself (about 2%); "Developed World Equity hedged" (7.3%) is hedged, the wrong basis.

**Reading the J.P. Morgan matrices.** Each row's four value columns (C–F) run in the
REVERSE order of the stacked labels in B5–B8: C = Compound Return 2026, D = Arithmetic
Return 2026, E = Annualized Volatility, F = Compound Return 2025. Two checks confirm it:
arithmetic ≈ compound + σ²/2 (U.S. Large Cap 6.7 + 1.36 ≈ 7.94; EAFE 7.5 + 1.55 ≈ 8.90),
and F reproduces the 2025 edition's EAFE 8.1%. The report's own printed matrix agrees
(EAFE 7.50 / 8.90 / 17.63 / 8.10). A search-result summary quoting "EAFE 7.4%" was wrong.
The COMPOUND column is the one used — the same basis as BlackRock's geometric figures and
Vanguard's annualised medians.

\* Vanguard's US page publishes ranges only. The midpoint is OUR computation, not a
median Vanguard published. The same page gives emerging markets at 2%–4%, unused here.

BlackRock's figures are the 10-year column of the "Starting point" sheet, rounded here to
two places; the workbook holds them to full precision. Its "Post-tax" sheets carry
different numbers (e.g. 7.00% for World ex-US) and are not used.

### Dividend yields — MSCI factsheets, Aug 31, 2026, "Div Yld (%)"

| market (model key) | index | yield |
|---|---|---|
| US — `usEquityDividendYield` | MSCI USA | 1.10% |
| Developed ex-US — `intlExUsEquityDividendYield` | MSCI World ex USA | 2.53% |
| Australia — `auEquityDividendYield` | MSCI Australia | 3.43% (cash yield; franking is applied by the AU dividend handler) |
| International ex-AU — `intlExAuEquityDividendYield` | MSCI World ex Australia (AUD) | 1.47% |

## Adopted defaults (design 99 P5b, 10 Sep 2026)

Total = the equal-weighted mean of the providers above, rounded to 0.1% — the precision
the sources publish at (BlackRock's workbook carries more digits, not more certainty).
International ex-AU averages Vanguard and BlackRock only: J.P. Morgan has no
world-ex-Australia row, and its AC World row (with EM and Australia in it) was not used
as a proxy (user decision). Yields are MSCI's, to the 0.01% MSCI publishes.

| market | mean | total | yield | price (taxable lot = total − yield) |
|---|---|---|---|---|
| US | (5.2 + 8.968 + 6.7) / 3 = 6.956 | **7.0%** | **1.10%** | 5.90% |
| Developed ex-US | (5.5 + 7.768 + 7.5) / 3 = 6.923 | **6.9%** | **2.53%** | 4.37% |
| Australia | (6.2 + 6.873 + 7.0) / 3 = 6.691 | **6.7%** | **3.43%** | 3.27% |
| International ex-AU | (5.9 + 9.002) / 2 = 7.451 | **7.5%** | **1.47%** | 6.03% |

Previous defaults: 7% total everywhere; yields US 2%, AU 4%, ex-US 2%, ex-AU 2%.

## Volatility and correlation (design 90 §7.4, 11 Sep 2026)

`DEFAULT_EQUITY_BETA` / `DEFAULT_EQUITY_IDIO` (`src/finance/economic-regimes/rate-keys.js`)
and the factor volatility `equityReturnVol`. Used only when Stochastic Equity Returns is on.

**Model.** One factor, defined as the US market. Each market keeps its own volatility σ
and its correlation ρ with the US: β = ρ·σ / σ_F and σ_idio = σ·√(1 − ρ²), so the market's
variance is σ² and its correlation with the US is ρ exactly. Two non-US markets correlate
only through the US (ρ₁·ρ₂).

**Decisions (user):** the equal-weighted mean of the providers where both publish a
volatility (the P5b rule); correlations from the matrices; factor vol kept at 0.18.

| input | J.P. Morgan 2026 LTCMA | BlackRock CMA ("Starting point") | used |
|---|---|---|---|
| US vol (the factor), USD | U.S. Large Cap 16.47% | US large cap, USD block, 19.35% | mean 17.91% → **0.18** |
| Developed ex-US vol, USD | EAFE 17.63% | Global ex-US (MSCI World ex-US) 17.57% | **17.60%** |
| Developed ex-US ρ with US | EAFE ~ U.S. Large Cap 0.8745 (USD matrix) | — (correlations only to its own reference) | **0.8745** |
| Australia vol, AUD | Australian Equity 14.33% | Australia large cap, AUD block, 15.81% | **15.07%** |
| Australia ρ with US | Australian Equity ~ U.S. Large Cap 0.5105 (AUD matrix) | — | **0.5105** |
| Intl ex-AU vol, AUD | no world-ex-Australia row | Global ex-Australia (MSCI World ex Australia) 14.72% | **14.72%** |
| Intl ex-AU ρ with US | — | US large cap ~ Global ex-Australia 0.9904 (AUD block) | **0.9904** |

BlackRock's "Correlation" columns are to two references per currency block (Government
bonds, Equities); in the AUD block the Equities reference is MSCI World ex Australia (its
own row reads 1.0), which is what makes the ex-AU row usable. J.P. Morgan's matrices hold a
full lower-triangle correlation matrix (columns G onward, in row order); the volatility is
column E.

| market | β = ρσ/0.18 | σ_idio = σ√(1−ρ²) | adopted β / σ_idio |
|---|---|---|---|
| US | 1 | 0 | **1.00 / 0** |
| Developed ex-US | 0.8549 | 0.0854 | **0.85 / 8.5%** |
| Australia | 0.4275 | 0.1296 | **0.43 / 13.0%** |
| Intl ex-AU | 0.8102 | 0.0203 | **0.81 / 2.0%** |

Implied AU ~ ex-AU correlation 0.51 (BlackRock: 0.52). Previous defaults: β US 1.0 / ex-US
0.85 / ex-AU 0.95 / AU 0.8, all idio 0 — unsourced, and unable to disperse.

## Super's equity market mix (design 99 P5c, 11 Sep 2026)

`DEFAULT_EQUITY_MARKET_MIX_BY_ROLE` (`src/finance/holdings/default-allocations.js`): the
split an un-authored SUPER account bootstraps across `EQUITY_AU` / `EQUITY_INTL_EX_AU`.

**Decisions (user):** equity split only — super stays 100% equity, and the ~19% of a
MySuper fund in cash and fixed income is not modelled. SUPER only — an AU brokerage keeps
its domestic default (APRA describes funds, not a person's own holdings). No lifecycle
glide.

### Files

| file | publisher | what | as of |
|---|---|---|---|
| `APRA-Quarterly-superannuation-industry-publication-2026-06.xlsx` | APRA | Quarterly Superannuation Industry Publication; **Table 9a "MySuper asset allocation"** (entities with more than six members, effective exposure) and Table 9 (whole industry) | June 2026 (published Sep 2026) |
| `APRA-Quarterly-MySuper-statistics-2020-09-to-2026-06.xlsx` | APRA | Quarterly MySuper statistics; Table 1b lifecycle-stage benchmark allocations | Sep 2020 – Jun 2026 |
| `APRA-Quarterly-superannuation-performance-statistics-2004-12-to-2026-06.xlsx` | APRA | Quarterly superannuation performance statistics; old Table 6a MySuper allocation | series ends Sep 2023 |
| `APRA-CPPP-2026-MySuper.xlsx` | APRA | 2026 Comprehensive Product Performance Package, MySuper; strategic growth allocation per product | 30 June 2026 |
| `APRA-Quarterly-superannuation-product-publication-performance-2026-06.xlsx` | APRA | Quarterly Superannuation Product Publication – Performance; Tables 8a–d per-product strategic sector allocation (not used) | June 2026 |

### Figures — Table 9a, June 2026, MySuper, \$ million

| row | \$m | % of investments |
|---|---|---|
| Australian listed equity | 285,914 | 22.4 |
| International listed equity (hedged) | 110,764 | 8.7 |
| International listed equity (unhedged) | 323,642 | 25.4 |
| Listed equity | 720,320 | 56.5 |
| Total investments | 1,274,343 | 100 |

International share of listed equity = (110,764 + 323,642) / 720,320 = 434,406 / 720,320 =
**0.6031 → 60.3%**; Australian 285,914 / 720,320 = 0.3969 → **39.7%**. Rounded to 0.1%, as
the P5b totals are. Hedged and unhedged are pooled: the engine applies no exchange-rate
effect to equity growth (see P5b's decisions above).

Counting unlisted equity too (AU 18,448; international 38,151 + 15,609) gives 61.6%
international — not used, because unlisted equity is not what `EQUITY_INTL_EX_AU` (MSCI
World ex Australia) prices. For context, not modelled: cash (net of the FX-derivative
rows) + fixed income incl. private debt = 18.9%; everything else (equity, property,
infrastructure, alternatives, commodities) = 81.1%.

### Not used, and why

- **Quarterly MySuper statistics, Table 1a** — no product-level allocation targets in
  any quarter. APRA exempted single-strategy MySuper products from SRS 533.0.
- **Table 1b** (lifecycle-stage benchmarks, weighted by stage assets): 55.2% international
  of listed equity. Lifecycle products only (\$515bn), and targets, not holdings — the
  exempted single-strategy products include some of the largest funds.
- **Performance statistics Table 6a / 1d** — "This series has been superseded"; the
  series ends September 2023 (SRS 530.0 revoked, replaced by SRS 550.0).
- **CPPP** — one strategic *growth* percentage per product, no AU/international split.
  Single-strategy products (\$818.5bn): 75.0% growth, asset-weighted.

## Routes

| family | route |
|---|---|
| **Vanguard** | `fund-docs.vanguard.com/AU-Vanguard_Asset_allocation_report.pdf` (always the latest quarter — rename on fetch) and the US VCMM page (HTML; ranges in the prose). Both fetch headlessly. |
| **BlackRock** | the "Download the CMA data" workbook, `blackrock-capital-market-assumptions.xlsx`. Read with the standard library (`zipfile` + the shared-strings table); `openpyxl` is not installed and not needed. |
| **MSCI** | `msci.com/documents/10199/255599/<index-slug>.pdf`; the AUD World ex Australia sheet lives under `msci.com/resources/factsheets/index_fact_sheet/`. The "Div Yld (%)" value sits on the index's own row a few lines below the header — not on the header line. |
| **J.P. Morgan** | **manual.** The LTCMA landing page renders its downloads with JavaScript, and the direct full-report URL returns a genuine 404. Download from `am.jpmorgan.com/.../portfolio-insights/ltcma/` in a browser and save as `JPM-LTCMA-2026-full-report.pdf`, `JPM-LTCMA-2026-matrix-USD.{pdf,xlsx}`, `JPM-LTCMA-2026-matrix-AUD.{pdf,xlsx}`. |
