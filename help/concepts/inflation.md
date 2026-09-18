---
id: inflation
kind: concept
title: Inflation
panels: [chart, mc-config]
params: [inflationRate, auInflationRate, auCpiRate, inflationStochastic, inflationModel, inflationPathVolUs, inflationPathVolAu, inflationReversionSpeedUs, inflationReversionSpeedAu, inflationPathCorrelation, inflationPathFloor, inflationLowerBoundUs, inflationLowerBoundAu, inflationGlobalShare, inflationGlobalReversionSpeed, inflationGlobalShareJoint, mcInflationPath, mcInflationModel]
design: [103-stochastic-inflation-and-joint-history.md]
stamps:
  param:inflationRate: de02d4
  param:auInflationRate: d6b181
  param:auCpiRate: f8fbcf
  param:inflationStochastic: 8a1787
  param:inflationModel: 50ac04
  param:inflationPathVolUs: 22355b
  param:inflationPathVolAu: 3cf994
  param:inflationReversionSpeedUs: b7cef2
  param:inflationReversionSpeedAu: 395b8b
  param:inflationPathCorrelation: e5448f
  param:inflationPathFloor: 935f7b
  param:inflationLowerBoundUs: 6770c7
  param:inflationLowerBoundAu: 94331f
  param:inflationGlobalShare: c98326
  param:inflationGlobalReversionSpeed: f2c8db
  param:inflationGlobalShareJoint: 8ac4a0
  param:mcInflationPath: d1d79d
  param:mcInflationModel: b804e9
  panel:chart: c05af4
  panel:mc-config: 2c8dce
---

Two anchors — one per country — and, optionally, a path that wanders around them.

Inflation reaches almost everything: spending grows by it, tax brackets index to it,
policy rates respond to it, and real returns are defined against it. That breadth is
why a fixed anchor flatters a plan. A long retirement's real risk is not that prices
rise at a steady rate you guessed slightly wrong; it is a *decade* of high inflation
landing at the wrong moment, and only a path produces that.

Turning the path on gives each country a year-by-year walk with post-war
persistence, so a high year tends to be followed by another — which is exactly the
property that makes a bad decade possible.

Three things about the shape are worth knowing before reading a result:

- **It is asymmetric.** Inflation is modelled as a floor plus a skewed distance above
  it, so it spikes upward and only drifts down. Symmetric noise around an anchor
  would understate the risk that actually matters.
- **The two countries are linked**, both directly and through a slow global cycle.
  History has them high together in the 1970s and low together since — an
  uncorrelated pair would give a cross-border plan diversification it does not have.
- **The clamp is a backstop**, not the shape. The path approaches its lower bound and
  rarely reaches the hard floor; the floor exists so that shocks and regimes applied
  afterwards cannot drive it somewhere absurd.

The AU capital-gains indexation rate tracks AU inflation unless you set it, since it
is a tax rule rather than a separate forecast.
