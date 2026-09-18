---
id: pools
kind: panel
title: Liquidity Pools
panels: [pools]
design: [97-liquidity-pools-and-drawdown-sequence.md]
stamps:
  panel:pools: b2d1aa
---

What the liquidity-pool graph actually did, period by period: each pool's balance
against its capacity and target, its years of cover, and the flows in and out.

It exists because the graph could be authored and could not be observed. Nothing in
the workbench read the pool state, so a gate that never opened, a headroom that was
identically zero and a knob that was never wired all took a separate study to find —
each of them visible in this cube from the first period of the first run.

**The interesting event is nearly always a flow that did *not* fire**, and nothing
else in the run records a non-event. So a gated flow is not a footnote here: it is a
marked point on the chart and a row in the log, with the reason it was gated, vetoed
or capped. A refill that was blocked looks exactly like a refill that was never
configured, unless something says so.

Open it whenever a drawdown came from somewhere you did not expect, or when a pool
you configured appears to be doing nothing.

Needs a scenario built and stepped, with pools configured — an unconfigured plan has
no pool state to show.

Exports the whole cube as CSV, including the per-period reserve figures repeated on
each pool's row.
