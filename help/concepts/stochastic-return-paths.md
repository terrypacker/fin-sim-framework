---
id: stochastic-return-paths
kind: concept
title: Stochastic Return Paths
panels: [mc-config, mc-results]
params: [equityReturnStochastic, equityReturnModel, equityReturnVol, equityReturnReversionSpeed, equityReturnBeta, equityReturnIdioVol, equityReturnDriftComp, equityReturnBootstrapBlock, equityReturnBootstrapFromYear, equityReturnBootstrapStartYear, equityReturnBootstrapStartRun, equityReturnBootstrapAuReplay, propertyReturnStochastic, propertyReturnBeta, propertyReturnIdioVol, propertyReturnIdioScale, mcSequenceRisk, mcEquityReturnModel, goldReturnVol, goldEquityCorrelation, goldReplay, stockBondCorrelation]
design: [74-stochastic-return-paths.md, 90-equity-fidelity-and-capital-losses.md, 102-historical-bootstrap-equity-returns.md, 121-shock-leg-offset-and-stagflation-calibration.md, 129-stock-bond-correlation.md, 131-gold-return-drivers.md, 133-bootstrap-history-window-and-start-year.md]
stamps:
  param:equityReturnStochastic: 635a9b
  param:equityReturnModel: 8624e4
  param:equityReturnVol: 32b4c6
  param:equityReturnReversionSpeed: 99faae
  param:equityReturnBeta: 68fe4a
  param:equityReturnIdioVol: 8bc7ec
  param:equityReturnDriftComp: be12e6
  param:equityReturnBootstrapBlock: 9d8272
  param:equityReturnBootstrapFromYear: 434fe6
  param:equityReturnBootstrapStartYear: c6a65f
  param:equityReturnBootstrapStartRun: 183cef
  param:equityReturnBootstrapAuReplay: 168628
  param:propertyReturnStochastic: e5f7f2
  param:propertyReturnBeta: 5ce9a3
  param:propertyReturnIdioVol: c3171f
  param:propertyReturnIdioScale: 9b7140
  param:mcSequenceRisk: b1d187
  param:mcEquityReturnModel: 5d713c
  param:goldReturnVol: 81f145
  param:goldEquityCorrelation: 578ce4
  param:goldReplay: 7dc19b
  param:stockBondCorrelation: 45d03d
  panel:mc-config: ad4956
  panel:mc-results: cc2f55
---

A plan that earns exactly 7% every year for forty years is not a plan anyone lives
through. Turning return paths on gives each year its own draw, which is what makes
**sequence risk** measurable: the same average return, arriving in a different order,
is a different retirement.

Each market loads on one shared market factor by a beta and adds its own noise, which
is what lets one market fall while another rises.

Three processes are available, and they answer different questions. Independent
annual draws match history's year-to-year behaviour, which is close to uncorrelated.
A mean-reverting process introduces persistence, and a *lower* pull-back speed means
*more* of it, the opposite of what the name suggests. Replaying blocks of real history keeps the multi-year runs and
crashes the others lack, but draws from fewer distinct sequences.

When inflation replays history too, as Monte Carlo does by default, the replay keeps to
1951 onwards, where inflation records start; otherwise it ranges from 1871, unless you set
a later first year. The Monte Carlo panel shows which. Every span is moved onto your anchor and
volatility, so the span changes how hard crashes hit, not the average return.

A start year instead replays a named era in order from your first year: "what if I retire
into 1966?". In Monte Carlo every path then shares that opening and differs only after it.

Gold replays its own year after 1968 too, so its swings and its ties to inflation and
interest rates are history's; earlier years draw at random. Its default swing is larger
than the share market's and barely tied to it: a diversifier with deep drawdowns, not a
safe harbour.

Bond noise can share that yearly draw. Independent, the default, sits between eras: bonds
fell with shares in the 1970s and hedged them after 2000. Within a year the bond move shows
first.

Property gets its own version: for a house, the variance that matters is its price on
the day you sell.

One subtlety: adding mean-zero noise to a
rate applied multiplicatively *lowers* the compounded return relative to the anchor
you typed. The drift-compensation setting decides whether the anchor is honoured as
a geometric outcome or taken literally as an arithmetic input, and it moves terminal
wealth on its own.

Single runs are deterministic unless these are on. See [Randomness](randomness-and-seeds.md).
