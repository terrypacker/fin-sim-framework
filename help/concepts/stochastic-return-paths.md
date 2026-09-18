---
id: stochastic-return-paths
kind: concept
title: Stochastic Return Paths
panels: [mc-config, mc-results]
params: [equityReturnStochastic, equityReturnModel, equityReturnVol, equityReturnReversionSpeed, equityReturnBeta, equityReturnIdioVol, equityReturnDriftComp, equityReturnBootstrapBlock, equityReturnBootstrapAuReplay, propertyReturnStochastic, propertyReturnBeta, propertyReturnIdioVol, propertyReturnIdioScale, mcSequenceRisk, mcEquityReturnModel]
design: [74-stochastic-return-paths.md, 90-equity-fidelity-and-capital-losses.md, 102-historical-bootstrap-equity-returns.md]
stamps:
  param:equityReturnStochastic: 635a9b
  param:equityReturnModel: 613513
  param:equityReturnVol: 32b4c6
  param:equityReturnReversionSpeed: 99faae
  param:equityReturnBeta: 68fe4a
  param:equityReturnIdioVol: 8bc7ec
  param:equityReturnDriftComp: be12e6
  param:equityReturnBootstrapBlock: 9d8272
  param:equityReturnBootstrapAuReplay: 168628
  param:propertyReturnStochastic: e5f7f2
  param:propertyReturnBeta: 5ce9a3
  param:propertyReturnIdioVol: c3171f
  param:propertyReturnIdioScale: 9b7140
  param:mcSequenceRisk: b1d187
  param:mcEquityReturnModel: 012b08
  panel:mc-config: 2c8dce
  panel:mc-results: 315796
---

A plan that earns exactly 7% every year for forty years is not a plan anyone lives
through. Turning return paths on gives each year its own draw, which is what makes
**sequence risk** measurable: the same average return, arriving in a different order,
is a different retirement.

The structure is one shared market factor plus per-market idiosyncrasy. Each market
loads on the common factor by a beta and adds its own noise, which is what lets one
market fall while another rises — a single global factor would make international
diversification arithmetic rather than a real effect.

Three processes are available, and they answer different questions. Independent
annual draws match history's year-to-year behaviour, which is close to uncorrelated.
A mean-reverting process introduces persistence, and note the direction: a *lower*
pull-back speed means *more* persistence, which is the opposite of the intuition the
name suggests. Replaying blocks of real history keeps the multi-year runs and
crashes that neither of the others produces, at the cost of drawing from fewer
distinct sequences.

Property gets its own version, because a house is one asset with a sale date rather
than a diversified position — the variance that matters is what it is worth on the
day you sell.

One subtlety worth knowing before reading any result. Adding mean-zero noise to a
rate applied multiplicatively *lowers* the compounded return relative to the anchor
you typed. The drift-compensation setting decides whether the anchor is honoured as
a geometric outcome or taken literally as an arithmetic input, and it moves terminal
wealth on its own.

Single runs are deterministic unless these are on. See [Randomness](randomness-and-seeds.md).
