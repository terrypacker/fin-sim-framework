# rates/ — published exchange rates, pinned

Daily exchange-rate series used by anything that has to **reconcile to a filed return**
rather than project a future. Committed deliberately: a §988 calculation is only as
defensible as its rate source, and a source that changes under you is not a source.

> **This is not `effectiveExchangeRates.USD_AUD`.** That is a *simulated* path the engine
> generates for projection. It is correct for design 87 phases 1–2 and wrong for anything
> touching a real transaction history. The two must never be swapped — see
> `design/87-foreign-currency-basis-pools.md` §12.

## Why these rates specifically

`Treas. Reg. §1.988-1(d)(1)` names acceptable sources for a "spot rate", and one of them
is:

> exchange rates published by the **Board of Governors of the Federal Reserve System
> pursuant to 31 U.S.C. section 5151**

That is the **H.10 release**. `§1.988-1(d)(2)` then lets the Service pick the rate itself
if inconsistent sources distort income — so the rule for us is **one source, every date,
no mixing**. Everything here comes from H.10.

Note `§1.988-1(d)(3)`'s convention relief — accruing a quarter's transactions at one rate
— is confined to *payables and receivables incurred in the ordinary course of business*
for goods or services. **A household currency pool does not qualify**, so month-end or
annual-average rates are not available and daily rates are required.

## Files

| file | series | meaning | source |
|---|---|---|---|
| `DEXUSAL-daily.csv` | `DEXUSAL` | **US dollars per 1 Australian dollar**, noon buying rate, daily | H.10 via FRED (Federal Reserve Bank of St. Louis) |

Retrieved **2026-08-08**; the file then covered 1971-01-04 → 2026-07-31.

### Direction — read this before using it

`DEXUSAL` is **USD per AUD** (~0.70). The simulation engine's `USD_AUD` is the
**inverse**, AUD per USD (~1.42). Silently swapping them inverts every gain. Consumers
should convert once, at the edge, and say which convention they hold — `scripts/lib/
fx-rates.mjs` normalises to USD-per-AUD and documents it.

### Gaps

The series omits US banking holidays and weekends (~570 empty values in the retrieved
file). There is no rate to publish on those days, so a convention is required, and the
convention must be **consistent** per `(d)(2)`. Ours: **the most recent published rate at
or before the transaction date**, i.e. carry the prior business day forward. It is
recorded on every row so a reviewer can see which figures are carried rather than quoted.

Dates *after* the last observation are a different thing entirely and are **never**
carried forward — H.10 publishes weekly in arrears, so a recent transaction simply has no
rate yet. Those rows are reported as unresolved rather than silently filled.

## Refreshing

```bash
node scripts/tax/fetch-fx-rates.mjs          # rewrites DEXUSAL-daily.csv in place
node scripts/tax/fetch-fx-rates.mjs --check  # fetch and diff, write nothing
```

Refreshing **revises history**: FRED restates recent observations as the Fed finalises
them. Re-run any §988 figures after a refresh rather than assuming they still hold, and
commit the rate change and the recomputed figures together so the pair stays auditable.
