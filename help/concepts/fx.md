---
id: fx
kind: concept
title: FX
panels: [chart, watchlist]
params: [exchangeRateUsdToAud, fxProcessModel, fxVolatility, fxReversionSpeed, fxBasisMethod]
design: [47-time-varying-fx-rates.md, 87-foreign-currency-basis-pools.md]
stamps:
  param:exchangeRateUsdToAud: 4813b3
  param:fxProcessModel: 7ba24c
  param:fxVolatility: ff6e43
  param:fxReversionSpeed: 6f045e
  param:fxBasisMethod: 116d2c
  panel:chart: c05af4
  panel:watchlist: 8af97c
---

The exchange rate between the plan's two currencies, and what the tax code makes of
holding foreign money.

By default the rate is a constant — fine for a plan that is mostly in one currency,
and quietly wrong for one that is not. A household whose assets are in one currency
and whose spending is in the other carries a real exposure, and a flat rate reports
none of it.

Turning on a time-varying process gives the rate its own seeded path. The choice of
process is the usual trade: a mean-reverting rate wanders and returns, a random walk
does not come back, and independent draws are neither. Which is right is a currency
view, and holding one is unavoidable — a flat rate is a view too, and the strongest
one available.

**The tax part is the half people miss.** Holding foreign currency is holding an
asset, and disposing of it can realise a gain or loss in its own right, separately
from whatever the money was spent on. The basis method decides how that is computed —
the regulation permits any reasonable method applied consistently across *all*
accounts in that currency, which is why this is one setting rather than a per-account
one. Picking a method per account would not be the same thing and would not be
allowed.

That consistency requirement also means a currency position has to be analysed as one
pool across every account holding it. Analysing a single account cannot reconcile
transfers between your own accounts, and a transfer is not a disposal.
