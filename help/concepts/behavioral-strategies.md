---
id: behavioral-strategies
kind: concept
title: Behavioral Strategies
panels: [chart, journal-report]
params: [behavioralStrategies, panicFraction, contributionSuspensionMinSeverity, downturnConversionAmount, cashBucketDrawdownMinSeverity]
design: [29-behavioral-layer.md]
stamps:
  param:behavioralStrategies: 65a02c
  param:panicFraction: aa7641
  param:contributionSuspensionMinSeverity: ca955b
  param:downturnConversionAmount: 592c49
  param:cashBucketDrawdownMinSeverity: b361c8
  panel:chart: c05af4
  panel:journal-report: e88448
---

What the household *does* when conditions change — as opposed to what the plan says
it should do. These are modelled reactions to regimes, and they can be either
mistakes or opportunities.

The mistakes are the point of modelling them. A plan that assumes perfect discipline
for forty years is measuring a household that does not exist. Panic selling rotates
equity to cash on entering a crash, scaled by how bad the crash is; suspending
contributions stops saving during a downturn. Both are things people actually do,
and both are expensive in ways that only show up when you run them.

The opportunities are the other half: converting to Roth while asset values are
depressed, drawing from a cash bucket instead of selling into a trough.

**Severity thresholds are how these stay honest.** A reaction that fires on every
ordinary dip is not the behaviour being modelled — households suspend contributions
in a real crisis, not in a bad quarter. Thresholds are stated in the same units a
shock preset's measured trough depth uses, so a threshold set here tracks a severity
sweep instead of drifting out of step with it.

Strategies are a set. Several can be active, and they compose with everything else —
turning one on does not replace the spending rule or the drawdown order, it adds a
reaction on top of them.

Harvesting is related but separate: see [Tax Harvesting](tax-harvesting.md).
