# US farm markets — sources

The data behind the farm Monte Carlo's yield and price spreads (design 134 §13.8).
`npm run farm:calibrate` derives every figure from these files, and
`tests/unit/farm-calibration.test.mjs` checks that `FARM_CALIBRATION`
(`src/finance/farm/farm-calibration.js`) still matches them. Re-fetch with
`fetch-sources.sh`.

## nass-qs-corn-soy-ne-us-20261119.tsv.gz

**What:** USDA National Agricultural Statistics Service, Quick Stats bulk download, crops
file `qs.crops_20261119.txt.gz` (https://www.nass.usda.gov/datasets), fetched 19 Nov 2026,
filtered by `nass-extract.py` and gzipped. Survey data only.

| Series | Level | Years |
|---|---|---|
| Corn (grain) and soybean yield, bu/acre, all practices | Nebraska counties | 1947–2025 |
| … irrigated and non-irrigated | Nebraska counties | 1947–2018 (NASS stopped the split after 2018) |
| Yield, all practices | Nebraska; US | from 1866 (corn), 1924 (soybeans) |
| Price received, \$/bu, monthly and marketing year | Nebraska; US | from 1908 (corn), 1913 (soybeans) |

**Used for:**

- **Yield shocks.** Each county's yield is detrended on its own linear trend, and the
  deviations' spread is taken. The farm-wide dryland shock's spread is non-irrigated corn's.
  The irrigated fields' common shock is what is left of irrigated corn's deviation after its
  dryland part. The irrigated β is the slope of irrigated on dryland. The soybean scale is
  soybeans' dryland spread over corn's.
- **Price volatility.** This is the spread of ln(October price ÷ January price) across years,
  using Nebraska monthly prices received, annualized over the nine months.
- **Price–yield link.** This is the slope of that log price change on the county's dryland
  yield deviation.

The figures are the median across Nebraska counties, from 1995 on. For one county's own
figures, run `npm run farm:calibrate -- --county NAME`.

**Caveats:**

- Prices received are monthly averages, which damps the measured volatility.
- County yields are smoother than one farm's, and one field's are noisier still. A field's
  own yield spread needs the farm's yield history (design 134 Q26), not this file.

## farmdoc-daily-2026-03-03-projected-prices-volatility.pdf (+ .txt)

**What:** Paulson, Schnitkey, Monaco, Sherrick and Zulauf, "Projected Prices and Volatility
Factors for 2026", *farmdoc daily* (16):35, University of Illinois, 3 March 2026.
https://farmdocdaily.illinois.edu/2026/03/projected-prices-and-volatility-factors-for-2026.html

**Used for:** a cross-check only. It reports the Risk Management Agency's 2026 crop-insurance
volatility factors: corn 0.15 and soybeans 0.13, down from 0.18 and 0.14 in 2025. These are
implied volatilities of the harvest futures contracts in February. The article calls corn's
0.15 the lowest value of the past 15 years, and soybeans' lowest over that span is 0.12.

The NASS history gives 0.18 and 0.17. That is a little above the market's implied figures,
as expected for cash prices, which also move with the basis. The RMA's own price-discovery
site has no scripted export, so this article is the on-disk record of those figures.
