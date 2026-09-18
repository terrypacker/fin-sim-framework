---
id: tax-harvesting
kind: concept
title: Tax Harvesting and Asset Location
panels: [journal-report, holdings]
params: [taxLossHarvestCap, taxLossHarvestOnRegimeEntry, taxGainHarvestBracketCeiling]
design: [29-behavioral-layer.md, 94-equity-as-security-positions.md]
stamps:
  param:taxLossHarvestCap: b55c85
  param:taxLossHarvestOnRegimeEntry: 2f55b6
  param:taxGainHarvestBracketCeiling: ba4590
  panel:journal-report: e88448
  panel:holdings: 359688
---

Realising a gain or a loss on purpose, because of what it does to the tax bill rather
than because you wanted to change the position.

**Loss harvesting** sells a losing lot to bank the loss, which offsets gains and a
limited amount of ordinary income. Two levers: an optional yearly policy cap on how
much to realise, and whether harvesting also fires on entering a stressed regime —
which is when losses exist to harvest.

The cap is a *policy* choice and deliberately not set to the statutory
capital-loss-against-ordinary-income limit. Those are different things: the statute
limits what a return may deduct in a year, and unused losses carry forward, so a
policy cap pinned to that figure would leave real losses unharvested for a reason
that does not apply.

**Gain harvesting** is the mirror image and easier to forget. In a low-income year
some long-term gain is taxed at zero, and realising up to that ceiling costs nothing
while resetting the cost basis upward. The gap between retiring and claiming Social
Security is the classic window, and it closes.

Both interact with lot selection — which lots are sold decides which gains are
realised — so read this beside [Drawdown Order](drawdown-order.md). A harvesting
policy and a lot strategy that disagree will fight each other.

Harvesting a loss and immediately rebuying the same security is a wash sale, which
the engine models; a substitute security avoids it.
