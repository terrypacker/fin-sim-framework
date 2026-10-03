---
id: editing-liquidity-pools
kind: workflow
title: Editing Liquidity Pools
panels: [parameters]
params: [liquidityGraph, liquidityShapes, liquidityTargetSchedule]
actions: []
tools: []
design: [114-pool-shape-inheritance-and-editor.md, 110-liquidity-pool-control-surface.md, 109-time-varying-pool-shapes.md]
sources: []
stamps:
  param:liquidityGraph: c86d6c
  param:liquidityShapes: eddce3
  param:liquidityTargetSchedule: 6c32a4
  panel:parameters: 671185
---

Everything about the pools lives in one group of the [Parameters](../panels/parameters.md)
list, **Liquidity Pools**, in the order you usually need it: the two on/off switches, the
**Structure**, the schedule that says which structure governs when, and the size multipliers
by year.

**The Structure is one editor with a tab per version.** **Base** is the plan's own structure
and opens first. Every later version gets a tab named for the years the schedule puts it in
charge, or marked *unscheduled* when no row selects it yet. One version is shown at a time.

**Start a later version from what you already have.** **+ New shape** offers a blank one, a
copy, or one that *inherits*. Inherit is almost always the right choice: the new tab starts
empty, lists everything it takes from its parent under **Inherited from …**, and you
**Override** only the bucket or flow you want different — or **Remove** one, which also takes
out the inherited flows that ran into or out of it. **Revert** and **Restore** undo each.
The line under the tab name says what the version changes, field by field, so a bucket you
renamed by accident shows up as one dropped and one added.

**"Inherits from" never changes what a version does.** Pointing a full copy at a parent
stores only its differences and is refused, with the reason, if that would reorder anything;
setting it back to *none* writes the full structure out again. Either way the run sees the
same thing before and after. That is how an existing plan's copies shrink: open each copy,
read its difference line, and choose the parent it says it matches.

**The tables show their essential columns.** Id, spend order, target, size and what a
remainder sits behind for buckets; the route, trigger and amount for flows. **More
columns** shows the rest — label, residency, early access, capacity, flow priority and
cadence, and the Search id a clause needs before it can be searched. A hidden setting that
is not at its default still appears as a badge on its row (*US only*, *cap: offset*,
*once a year*), so hiding a column never hides a decision. The choice is remembered on this
device.

**Look at one bucket at a time.** **Rows for:** narrows the claims, flows and gate tables to
the rows that involve one bucket — what it holds, what fills it, what it fills, and the
conditions on those. Nothing hidden is changed, and a claim added while narrowed goes to that
bucket.

**Size decisions from a cockpit session stay folded.** The multipliers open as one line per
run of equal decisions; **Show rows** lists every year, and adding a row opens them.

Two neighbours share the word "pool" and are not these: the cash and bond *years of spend*
settings size the allocation mix, and the hand-written drawdown sequence is replaced by the
Structure's spend order while the pools are on — it says so in place of an editor, and
offers to clear a leftover one that would stop the plan loading.

See [Pool Shapes Over Time](../concepts/pool-shapes-over-time.md) for why versions are whole
structures, and [Liquidity Pools](../concepts/liquidity-pools.md) for what a bucket is.
