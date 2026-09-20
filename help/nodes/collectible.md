---
id: collectible
kind: node
title: Collectible
node: collectible
panels: [config-list, config-graph]
design: [57-au-cgt-reform-2027.md, 88-speculative-assets.md]
sources: [src/finance/assets/collectible.js]
stamps:
  panel:config-list: 786f94
  panel:config-graph: bbebb1
  node:collectible: a5f795
  src/finance/assets/collectible.js: 6de9b8
---

A physical asset held for its market value — art, wine, jewellery, a vintage car,
bullion. It appreciates on its own rate, holds a cost basis, and is taxed when sold;
it has no mortgage, no running costs and no income. That is the whole model, and it
is the difference from [Real Property](real-property.md), which has all three.

Reach for one when a plan's net worth genuinely depends on something outside the
portfolio and the tax treatment of its sale matters. It is not a way to record
possessions: an asset that will never be sold and never be borrowed against only
moves the net-worth line.

**The country field is a tax decision, not a location.** A collectible's sale is
taxed by the rules of the country you put it in — which in Australia is the
collectables class, with its own loss quarantining, and in the US the 28% rate that
applies to collectibles rather than the ordinary long-term rate.

Sale is a single dated event: in the planned sale year the asset is disposed of at
its grown value, the gain is taxed, and the net proceeds land in the destination
account. There is no partial sale, and no market for it before that year.

## Fields

- `name` — What this asset is called, in the Nodes list and every chart that breaks net worth down. Free text.
- `country` — Which country's capital-gains rules tax the sale, and the default currency that follows from it. AU puts the asset in the collectables class; US applies the collectibles rate rather than the ordinary long-term one. Not a statement about where the object physically is.
- `currency` — The currency this asset's value and basis are stated in. Defaults from the country. A value in one currency and a destination account in another is legal — the proceeds are converted on the sale date.
- `value` — Current market value, in this asset's currency. It grows from here at the appreciation rate; nothing marks it to an external series.
- `costBasis` — What was paid for it, in this asset's currency, plus anything capitalised since. The gain taxed at sale is the sale value less this, so a basis left at 0 taxes the entire proceeds as gain.
- `appreciationRate` — Annual growth as a decimal (0.035 = 3.5%), compounded. Deterministic: unlike a market holding, a collectible does not take a return draw, so this rate is exactly what it earns in every run of a Monte Carlo batch.
- `saleDestinationAccount` — Which account receives the net proceeds when this asset sells. Blank sends them to the country's cash pool. Worth setting when the proceeds are meant to be invested rather than spent, because cash landing in a transaction account is cash the spending rule can quietly consume.
- `ownershipType` — Sole or joint. It decides how the gain is split across people, which matters whenever the two have different marginal rates or different residencies. Joint splits evenly; an explicit per-person breakdown in a scenario file overrides both.
- `ownerId` — The person who owns it when ownership is sole. Their residency and marginal rate are what the sale is taxed at, so this is a tax input rather than a label.
- `speculative` — Simulate this asset but do not count it as yours. It still appreciates, still sells in its sale year and still pays the tax — but until it converts it is worth zero in net worth and in everything downstream of net worth. For a stake that may never find a buyer. Disclosed separately as "incl. speculative", so nothing is hidden. Incompatible with a drawdown priority.
