---
id: currency-hedging
kind: concept
title: Currency Hedging
panels: []
params: [hedgeForeignCashRate, hedgeCost, fxEquityCorrelation]
actions: [HEDGE_YEAR_END_APPLY]
tools: []
design: [120-currency-hedged-equity.md, 121-shock-leg-offset-and-stagflation-calibration.md]
sources: [src/finance/holdings/currency-overlay.js]
stamps:
  param:hedgeForeignCashRate: b900f1
  param:hedgeCost: 25d37a
  param:fxEquityCorrelation: 3f56d7
  src/finance/holdings/currency-overlay.js: 8d969d
---

An Australian investor in world shares holds two things at once: the shares, and the
currencies they are priced in. A hedged fund such as VGAD sells the currency forward and
keeps only the shares; its unhedged twin VGS keeps both.

**Nothing changes until a security says so.** Every market return in the model is
already an unhedged Australian-dollar figure, so a lot whose security declares no hedge
ratio grows as it always has. Declaring one — even 0 — opts its lots into the overlay:

- **The currency's move** reaches the unhedged part, measured from one 31 December to the
  next, and is zero unless the FX process is on. The world-ex-Australia basket is priced
  off USD/AUD, scaled down because a basket of currencies moves less than the dollar.
- **The carry** reaches the hedged part: the Australian policy rate less the foreign one.
  When Australian rates are lower, a hedge costs money every year.

Gold is the exception: priced in US dollars, Australian-dollar gold takes the currency's
move, unhedged by default.

A deterministic run shows only the carry. The reason anyone chooses — the Australian
dollar tends to fall when world shares fall, cushioning an unhedged holder — shows up
across a Monte Carlo with the FX process and stochastic equity both on.

**The cushion is a correlation, and it is an era.** Each year's currency path leans on
that year's equity shock: strong over 2004–2023 on the model's own pair, absent over
1984–2003. The default is the recent era; the earlier one, where hedging was the
lower-risk choice, is the stress case worth sweeping.

**Once the currency is modelled, the world-ex-Australia market is re-based** to its
local-currency volatility, so the currency is not counted twice. A lot whose security
says nothing is then unhedged, or a quarter hedged in super, as funds are.

**Tax** depends on one election. A fund that has made the TOFA hedging election (VGAD
since July 2024, and the default) keeps hedge results in the unit price, taxed when you
sell. One that has not pays a hedge gain out as ordinary income, while a hedge loss eats
the distribution and is carried inside the fund. Either way the total return is unchanged; only its timing and character move. Super lots
are taxed inside the fund and get no new tax path.

**Left out:** one pair stands in for the basket; no security carries a fee.

