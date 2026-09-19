---
id: searching-pool-levers
kind: concept
title: Searching Pool Levers
panels: []
params: []
actions: []
tools: []
design: [110-liquidity-pool-control-surface.md, 97-liquidity-pools-and-drawdown-sequence.md]
sources: [src/finance/pools/pool-target-scale.js, src/finance/pools/pool-axis-hygiene.js]
stamps:
  src/finance/pools/pool-target-scale.js: e2a576
  src/finance/pools/pool-axis-hygiene.js: 080c31
---

A pool's size and a refill rule's patience are decisions this feature raises and cannot
settle on its own. Both can be handed to the optimizer, or scanned one against another
on a grid, instead of being guessed and left.

Two constraints shape what you can ask for.

**A size is swept as a factor, not as a number of years.** A pool that appears in
several [shapes](pool-shapes-over-time.md) usually holds a different amount in each, and
that difference is the reason for writing shapes at all. A sweep of one absolute figure
would flatten the whole profile to that figure, then report it as though it were the
policy. A factor scales what you wrote and leaves its shape alone. The price is that a
result reads as "1.25" rather than "five years", so the lever list shows the values each
factor resolves to.

**A gate clause has to be named before it can be searched.** The clause table's OR
column is a position, and positions shift when a row is inserted above them; an axis
pinned to one would quietly begin steering a different clause. Naming a clause changes
nothing about the run — it only makes that one clause addressable. A clause left unnamed
behaves exactly as it always has and simply cannot be swept.

The harder problem is not the search, it is that a comparison can look sound and not be.
The usual causes are silent: a glide path still governing whatever the pools do not
claim, a dated crash the plan can see coming, or a strategy left deselected so that
nothing reads the value being moved. Each is reported next to the lever, labelled by
which of two failures it causes — an axis nothing reads returns identical cells and
reads as a null result, while a second moving part returns a larger effect than the
lever has.

Those reports are never acted on automatically. A comparison run against a plan the app
quietly corrected is one that cannot be reproduced, so the plan stays exactly as
written and the fix is yours to make in the parameters.
