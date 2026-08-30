# Economic-shock sources — provenance

The shock library (`src/finance/economic-shocks/shock-library.js`) asserts specific
numbers about specific historical episodes: how deep the S&P fell, how long it ground,
how far the Fed cut, how much the curve twisted, what happened to the AUD. Those numbers
are the *calibration*, so they get the same treatment as tax law
(`docs/us-tax/SOURCES.md`, and the rule in design 94 §8.1): **fetch the source onto disk
first, then cite it**. Nothing in the library or in `README.md` is quoted from memory.

Everything here has a scripted route. Re-fetch with:

```
docs/economic-shocks/fetch-sources.sh          # into data/
node scripts/probes/measure-shock-history.mjs --write   # regenerate MEASUREMENTS.md
```

## Routes

| family | filename pattern | route |
|---|---|---|
| **FRED** (Federal Reserve Bank of St. Louis) | `FRED-<series-id>.csv` | `https://fred.stlouisfed.org/graph/fredgraph.csv?id=<series-id>` — no key needed, returns CSV, follows redirects. A bad id returns **200 with an HTML error page**, not a 404-ish CSV, so check the first data row after fetching. |
| **RBA** | `RBA-<table>-<name>.csv` | `https://www.rba.gov.au/statistics/tables/csv/<table>-data.csv`. Serves a UTF-8 BOM and ~10 header rows before the data. |
| **NBER** | `NBER-*.txt` | The reference-date page is HTML; `nber-to-txt.py` flattens the table. |
| **Shiller** | `Shiller-SP500-monthly.csv` | `shillerdata.com` serves the *Irrational Exuberance* workbook from a CDN blob URL (`img1.wsimg.com/blobby/go/e5e77e0b-.../ie_data.xls`). Legacy `.xls`, so the conversion needs `python3 -m pip install xlrd`; `shiller-to-csv.py` does it. The copy still mirrored at `econ.yale.edu/~shiller/data/ie_data.xls` is a year staler — prefer the CDN one. |

Two gotchas worth not rediscovering:

- **Blank cells in FRED daily CSVs are empty strings, not `.`** — and `Number('')` is `0`,
  not `NaN`. A naive parser silently reads market holidays as a zero index level, which
  turns every drawdown into −100 %. `measure-shock-history.mjs` rejects empty and zero.
- **`DEXUSAL` is USD per AUD; the model's `USD_AUD` is AUD per USD.** The two move in
  opposite directions. Every FX figure in `MEASUREMENTS.md` is printed in both.

## What each series is here for

### Equity

| series | what | used for |
|---|---|---|
| `Shiller-SP500-monthly.csv` | S&P 500 monthly average price, dividend per share, earnings, CPI and GS10, 1871– | the level-effect depths, and the **only** free long-history S&P **dividend** series — which is what `dividendAdjustment` is calibrated against |
| `FRED-SPASTT01USM661N` | OECD share prices, United States, monthly | the US half of the US-vs-AU asymmetry |
| `FRED-SPASTT01AUM661N` | OECD share prices, Australia, monthly | the AU half. Same methodology as the US series, which is the whole point: it makes `EQUITY_AU −0.18` vs `EQUITY_US −0.35` a like-for-like claim rather than two indices talking past each other |
| `FRED-NASDAQCOM` | Nasdaq Composite, daily 1971– | the tech leg of the dot-com bust; the reason a broad-index preset understates what a concentrated holder felt |
| `FRED-VIXCLS` | CBOE VIX, daily 1990– | context for how violent an episode was. The model has no equity-vol knob, so this calibrates nothing — it is here to keep the FX-vol multipliers honest by comparison |
| `FRED-DIVIDEND` | BEA net corporate dividend payments, quarterly 1947– | economy-wide cross-check on the S&P payout cut |

### Prices

`FRED-CPIAUCSL` (US CPI-U, SA, 1947–), `FRED-CPIAUCNS` (NSA, 1913–),
`FRED-CPALTT01AUQ659N` (OECD CPI Australia, YoY). These set `inflationAdjustment` — and
they are what says a 1970s preset needs roughly **+5 pp over a 2.5 % baseline sustained
for years**, not a one-year spike.

### Rates and the term structure

| series | what | used for |
|---|---|---|
| `FRED-FEDFUNDS` | effective fed funds, monthly 1954– | the size of a policy cut/hike |
| `FRED-MPRIME`, `FRED-DPRIME` | bank prime loan rate | `PRIME_US`. The library moves policy rates on `PRIME_*` only (design 21 §18.4), so this is the series that preset field literally means |
| `FRED-MORTGAGE30US` | Freddie Mac 30-year fixed | the pass-through from policy to a household's loan rate |
| `FRED-DGS1/2/5/10/30` | Treasury constant maturity, daily | `yieldCurveTwist`, stated per tenor |
| `FRED-GS1`, `FRED-GS10` | monthly equivalents, 1953– | the pre-1962 and pre-1977 history the daily series do not cover |
| `FRED-T10Y2Y` | 10y−2y spread, daily 1976– | dating the inversion episodes |
| `FRED-IR3TIB01AUM156N` | AU 3-month interbank, monthly 1968– | `PRIME_AU`, and the evidence that AU policy does **not** track the Fed one-for-one |
| `FRED-IRLTLT01AUM156N` | AU 10-year government bond yield, monthly 1969– | `FIXED_INCOME_AU` |
| `RBA-F1.1-money-market.csv` | RBA cash rate target and money-market yields | the authoritative AU policy rate; the FRED interbank series is a market proxy for it |

### FX

| series | what | used for |
|---|---|---|
| `FRED-DEXUSAL` | USD per AUD, daily 1971– | `fxAdjustment` and `fxVolAdjustment` for `USD_AUD`. **Only usable from 12 December 1983**, when the AUD floated — before that the rate was administered |
| `FRED-TWEXMMTH`, `FRED-DTWEXM` | trade-weighted USD vs major currencies, 1973–2019 | the 1970s "broad USD weakness" claim, which is a trade-weighted claim and does *not* transfer to a pegged AUD |

### Real estate

`FRED-CSUSHPINSA` (Case-Shiller US national) and `FRED-SFXRSA` (Case-Shiller San
Francisco) calibrate `SF_BAY_HOUSING_CRASH` — including the fact that the regional index
fell far further and recovered far later than the national one, which is why that preset
is scoped to a `market` rather than a country. `FRED-QUSN628BIS` / `QAUN628BIS` /
`QAUR628BIS` (BIS residential property prices) give the AU comparison, and say that
Australia had no GFC housing bust worth modelling.

### Cycle dating

`NBER-business-cycle-dates.txt` and `FRED-USREC`. These fix the *duration* half of every
preset: NBER's peak-to-trough months are the outer bound on how long a recession-shaped
regime should hold at full strength.
