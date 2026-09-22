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
  src/finance/pools/pool-target-scale.js: 9a3f7a
  src/finance/pools/pool-axis-hygiene.js: 3c8b0c
---

A pool's size, how patient a refill rule is, and when the plan re-plumbs itself can all be
handed to the optimizer, or scanned one against another on a grid, rather than guessed once
and left. Two constraints shape what you can ask for.

**A size is swept as a factor, and a switch year as a shift** — never as an absolute. A pool
that appears in several [shapes](pool-shapes-over-time.md) usually holds a different amount in
each, and a shape can be scheduled more than once. Setting one absolute figure would flatten
that and report it as though it were the policy; scaling or shifting moves the level and
leaves the spacing alone. The price is that a result reads as "1.25" or "−2", so the lever
list shows the years each resolves to. A pool set to hold nothing is not offered at all: no
factor lifts a target off zero.

**A gate clause has to be named before it can be searched.** The clause table's OR column is a
position, and positions shift when a row is inserted above them; an axis pinned to one would
quietly begin steering a different clause. Naming one changes nothing about the run, and a
clause left unnamed simply cannot be swept.

The harder problem is not the search — it is that a comparison can look sound and not be.
Anything the sweep would spoil is reported next to the lever, labelled by which of three
things it causes: an axis nothing reads returns identical cells and looks like a null result;
a second moving part, such as a glide path still governing whatever the pools do not claim,
returns a larger effect than the lever has; and a range that runs past what the plan will
accept returns holes rather than results, because a value out of bounds is refused outright
rather than quietly corrected into a policy nobody chose.

The MPC cockpit can also decide a size one year at a time rather than once for the whole
run; its decisions are saved as dated multipliers (see
[Pool Shapes Over Time](pool-shapes-over-time.md)), and the same reports appear there.

Those reports are never acted on for you. A comparison run against a plan the app silently
corrected is one that cannot be reproduced, so the plan stays as written and the change is
yours to make in the parameters.
