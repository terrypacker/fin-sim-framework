---
id: economic-shocks
kind: concept
title: Economic Shocks
panels: [mc-config, chart]
params: [shocks, repairSeverityScale, repairFreqScale]
stamps:
  param:shocks: a0799f
  param:repairSeverityScale: f1741c
  param:repairFreqScale: 74df07
  panel:mc-config: 2c8dce
  panel:chart: c05af4
---

A named, dated disturbance applied to the run: a market crash, a rate spike, a
recession. Either drawn from the shock library by preset or defined inline.

Shocks and [return paths](stochastic-return-paths.md) are different tools and it is
worth being clear which question you are asking. A return path asks *what range of
futures is this plan exposed to* — the answer is a distribution. A shock asks *what
happens if this specific thing lands in this specific year* — the answer is a story,
and its value is that you choose the year. Retiring into a crash and meeting the same
crash twenty years later are different events for the same plan, and only a dated
shock lets you place it deliberately.

A preset carries a severity, which is its measured trough depth. That matters beyond
the shock itself: other mechanics gate on it, so a bucket strategy that should only
engage in a deep drawdown can state its threshold in the same units a severity sweep
moves. Thresholds expressed that way track the sweep instead of drifting away from
it.

House repairs are here because they are shocks too, just small and frequent ones. The
two scale knobs multiply the configured size and frequency of stochastic repair
events across every property, which is how you stress-test whether lumpy,
badly-timed maintenance bites liquidity — a question about cash flow rather than
about returns.

Shocks compose with everything else; adding one does not switch anything off.
