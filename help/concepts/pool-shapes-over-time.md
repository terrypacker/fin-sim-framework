---
id: pool-shapes-over-time
kind: concept
title: Pool Shapes Over Time
panels: []
params: [liquidityShapes, liquidityGraphSchedule, liquidityTargetSchedule]
actions: []
tools: []
design: [109-time-varying-pool-shapes.md, 114-pool-shape-inheritance-and-editor.md, 112-dated-pool-targets.md, 97-liquidity-pools-and-drawdown-sequence.md]
sources: []
stamps:
  param:liquidityShapes: eddce3
  param:liquidityGraphSchedule: 2508ac
  param:liquidityTargetSchedule: 6c32a4
---

A plan rarely wants one buffer for forty years. While a wage is coming in, cash is
mostly drag. The stretch after work stops and before any pension or age-gated account
opens wants the largest reserve the plan will ever hold. Later the question changes shape
rather than size: money that was unreachable becomes reachable, so what to spend first
changes too.

Held to one structure, you pick an average that is wrong at both ends. So several named
structures can sit in a plan, and a small table says which is in charge from which year — the move [Allocation](allocation.md) already
makes for a target mix. A row can also hand control back to the plan's own structure.

**An alternative is the whole structure, never one bucket's settings.** Flows point at
buckets, a residual target names the buckets it sits behind, and whether the edges form a
loop is a question about all of them at once. Give each bucket its own timeline and the
combination live in some year can break rules every timeline respects, with nothing to
catch it. So every version is complete and validated when the plan opens, even one that
takes over decades from now.

**An alternative can still be written as only what changes.** Based on another structure,
it names just the buckets and flows it changes and follows its parent for the rest, later
edits included, so copies cannot drift apart. It is filled back out into the
complete structure before anything checks or runs it, so the rule above holds.

**Names are identity.** A bucket kept under the same name continues, with its history —
notably the running peak the "don't sell into a fall" rules measure against. A new name has
no history, which reads as *not down at all*, so those rules stand aside for a period.
Renaming between versions therefore retires one bucket and starts another — a decision
if deliberate, a trap if not.

Changing over moves no money by itself: the ordinary machinery brings the new structure
about at its own pace, so a plan wanting a deep reserve by a given year should switch a
few years earlier.

**To change only a size, use a multiplier by year instead.** It carries across structure
changes, reads as years or dollars, and holds an MPC session's size decisions.

See [Liquidity Pools](liquidity-pools.md) and
[Editing Liquidity Pools](../workflows/editing-liquidity-pools.md).
