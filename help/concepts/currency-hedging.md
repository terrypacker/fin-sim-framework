---
id: currency-hedging
kind: concept
title: Currency Hedging
panels: []
params: [hedgeForeignCashRate, hedgeCost]
actions: [HEDGE_FX_MARK_APPLY]
tools: []
design: [120-currency-hedged-equity.md]
sources: [src/finance/holdings/currency-overlay.js]
stamps:
  param:hedgeForeignCashRate: b900f1
  param:hedgeCost: 25d37a
  src/finance/holdings/currency-overlay.js: 1dffb8
---

An Australian investor in world shares holds two things at once: the shares, and the
currencies they are priced in. A hedged fund such as VGAD sells the currency forward and
keeps only the shares; its unhedged twin VGS keeps both.

**Nothing changes until a security says so.** Every market return in the model is
already an unhedged Australian-dollar figure, so a lot whose security declares no hedge
ratio grows exactly as it always has. Declaring one — even 0 — opts that security's lots
into the overlay:

- **The currency's move** reaches the unhedged part of the lot. It is measured from one
  31 December to the next, the year the equity return covers, and is zero unless the FX
  process is switched on. The world-ex-Australia basket is priced off USD/AUD, scaled
  down because a basket of currencies moves less than the dollar alone.
- **The carry** reaches the hedged part. A rolling forward earns the gap between the two
  countries' policy rates: the Australian Prime less the foreign one, or less the foreign
  cash rate when the plan does not model the other country. When Australian rates are
  lower, a hedge costs money every year.

So a deterministic run shows only the carry. The reason anyone chooses between the two —
that the Australian dollar tends to fall when world shares fall, which cushions an
unhedged holder — needs the FX process on, and shows up across a Monte Carlo rather than
in one path.

**Tax.** A fund that has made the TOFA hedging election (VGAD has since July 2024) keeps
its hedge gains and losses in the unit price, taxed when you sell, as the shares' own
gains are. That is how the overlay treats every hedged lot at present.

**What it leaves out.** One currency pair stands in for the basket. A hedged fund's
slightly higher fee is not modelled, because no security carries a fee. Super funds
hedge inside the fund and are taxed there, so a super lot takes the overlay's return with
no new tax.
