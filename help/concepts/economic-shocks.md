---
id: economic-shocks
kind: concept
title: Economic Shocks
panels: [mc-config, chart]
params: [shocks, repairSeverityScale, repairFreqScale]
stamps:
  param:shocks: 2c4a39
  param:repairSeverityScale: f1741c
  param:repairFreqScale: 74df07
  panel:mc-config: ad4956
  panel:chart: db45f8
---

A named, dated disturbance applied to the run: a market crash, a rate spike, a
recession. Either drawn from the shock library by preset or defined inline.

Shocks and [return paths](stochastic-return-paths.md) answer different questions. A
return path asks *what range of futures is this plan exposed to*. A shock asks *what
happens if this specific thing lands in this specific year*, and its value is that you
choose the year: retiring into a crash and meeting it twenty years later are different
events for the same plan.

Choosing the year is also its weakness. A timing lever — a sale year, a refill gate, a
conversion schedule — gets scored partly on dodging the date you picked, with foresight
the household lacks. To ask whether a lever helps *whenever* the bust comes, give the
shock a random arrival and read the answer across Monte Carlo paths; a rate lets the
same kind of bust recur, and each arrival is its own episode, so strategies that react
to a crash react to every one. One run of such a plan is one draw, not a typical one. Nothing in the run reacts to the shock
before it arrives, though cockpit projections, which look ahead along the run's own
path, do see it.

A preset carries a severity, its measured trough depth. Other mechanics gate on it, so
a bucket strategy that should engage only in a deep drawdown states its threshold in
the units a severity sweep moves. A severity sweep deepens or eases only the equity
side of a preset; its rate, bond, inflation and gold legs keep their values.

House repairs are here because they are shocks too, small and frequent. The two scale
knobs multiply the size and frequency of stochastic repairs across every property,
which tests whether lumpy maintenance bites liquidity.

A custom shock can split into legs, each with its own regime and recovery curve, and a
leg can start later than the shock (`startMonths`) — a 1970s-style decade where
inflation runs ahead of rates first and real rates spike only after it breaks. No
strategy sees a delayed leg until its own date; the level break still lands on the
shock's date. A leg that would start after the run ends is dropped with a warning.

Shocks compose with everything else; adding one does not switch anything off.
