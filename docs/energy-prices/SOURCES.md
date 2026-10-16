# Energy prices and household energy shares — sources

Fetched 15 Oct 2026 for design 126 §4.4 (G2 step 0). Read by
`scripts/lab/energy-share-measurement.mjs`.

## US

**Prices** (FRED, `https://fred.stlouisfed.org/graph/fredgraph.csv?id=<ID>`), in `data/`:

| file | series |
|---|---|
| `CPIAUCSL.csv` | CPI-U all items, SA, monthly, 1947– |
| `CPIENGSL.csv` | CPI-U energy, SA, monthly, 1957– |
| `CPIAUCNS.csv`, `CPIENGNS.csv` | the same, not seasonally adjusted |
| `CPGREN01USQ657N.csv`, `CPALTT01USQ657N.csv` | OECD MEI energy / all-items CPI, % change on previous quarter (cross-check only) |

**Spending shares**: BLS Consumer Expenditure Survey, annual means in dollars, via FRED (BLS's own
site and `download.bls.gov` return 403 to scripted requests). In `data/ce/`, one file per
`CXU<item><demographic>M`:

- items: `TOTALEXP` total expenditures, `ELECTRIC` electricity, `NATRLGAS` natural gas,
  `OTHRFUEL` fuel oil and other fuels, `GASOIL` gasoline, other fuels and motor oil;
- demographics: `LB0101` all consumer units, `LB0407` reference person 65+, `LB0408` 65–74,
  `LB0409` 75+, and `LB0102`–`LB0106` quintiles of income before taxes, lowest to highest
  (FRED title of `CXUTOTALEXPLB0106M`: "…by Quintiles of Income Before Taxes: Highest 20 Percent
  (81st to 100th Percentile)").

`GASOIL` ends at 2022 on FRED: its 2023 value is `1`, a placeholder, so the measurement stops at
2022.

**CPI-U relative importance**, December 2025 (2024 weights), BLS Table 1,
`https://www.bls.gov/cpi/tables/relative-importance/2025.htm`. The page refuses scripted
download; these rows were read through a page fetch and are a cross-check only — the
measurement does not use them:

| item | CPI-U | CPI-W |
|---|---|---|
| Energy | 6.383 | 8.052 |
| Energy commodities | 3.120 | 4.198 |
| Motor fuel | 2.981 | 4.078 |
| Energy services | 3.262 | 3.855 |
| Electricity | 2.489 | 3.008 |
| Utility (piped) gas service | 0.773 | 0.846 |

## Australia

**Weights** (ABS, "Annual weight update of the CPI and Living Cost Indexes", released
7 May 2025), in `data/abs/`:

- `cpi-2025-weights.xlsx` — *Consumer Price Index – 2025 Weighting Pattern*,
  `https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/annual-weight-update-cpi-and-living-cost-indexes/dec-2024/Consumer%20Price%20Index%20-%202025%20Weighting%20Pattern.xlsx`
- `slci-2025-weights.xlsx` — *Selected Living Cost Indexes – 2025 Weighting Pattern*,
  `https://www.abs.gov.au/statistics/economy/price-indexes-and-inflation/annual-weight-update-cpi-and-living-cost-indexes/dec-2024/Selected%20Living%20Cost%20Indexes%20-%202025%20Weighting%20Pattern.xlsx`

Rows used (percentage contribution to All groups, weighted average of eight capital cities).
2025 set = December quarter 2024; 2024 set from the CPI file's Table 5 and the SLCI file's
Table 6:

| expenditure class | CPI 2025 | CPI 2024 | self-funded retiree 2025 | 2024 | age pensioner 2025 | 2024 |
|---|---|---|---|---|---|---|
| Automotive fuel | 3.3469 | 3.73 | 3.20 | 3.80 | 3.58 | 4.24 |
| Electricity | 1.8353 | 2.36 | 1.99 | 2.58 | 3.08 | 3.69 |
| Gas and other household fuels | 0.9616 | 0.98 | 1.09 | 1.13 | 1.47 | 1.53 |

The 2025 electricity weights are net of the 2024–25 Energy Bill Relief Fund rebates, so the
2024 set is the unrebated reading.

**Prices**: OECD Main Economic Indicators via FRED, quarterly, % change on previous period,
chained into indexes by the script:

- `CPGREN01AUQ657N.csv` — CPI energy, Australia, 1971–2023
- `CPALTT01AUQ657N.csv` — CPI all items, Australia, 1948–2023

No ABS expenditure-class series for the 1970s was found in a scriptable form.
