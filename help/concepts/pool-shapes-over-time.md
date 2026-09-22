---
id: pool-shapes-over-time
kind: concept
title: Pool Shapes Over Time
panels: []
params: [liquidityShapes, liquidityGraphSchedule, liquidityTargetSchedule]
actions: []
tools: []
design: [109-time-varying-pool-shapes.md, 112-dated-pool-targets.md, 97-liquidity-pools-and-drawdown-sequence.md]
sources: []
stamps:
  param:liquidityShapes: c6dadc
  param:liquidityGraphSchedule: 2508ac
  param:liquidityTargetSchedule: 6c32a4
---

A plan rarely wants one buffer for forty years. While a wage is coming in, cash is
mostly drag. The stretch after work stops and before any pension or age-gated account
opens is the hungriest a plan ever has, and wants the largest reserve it will ever hold.
Later the question changes shape rather than size: money that was unreachable becomes
reachable, so what is sensible to spend first is no longer what it was.

Held to one structure, you pick an average that is wrong at both ends. So the structure
can be named, several named alternatives can sit in a plan together, and a small table
says which is in charge from which year — the move [Allocation](allocation.md) already
makes for a target mix. A row can also hand control back to the plan's own structure.

Two rules make this safe rather than merely flexible.

**An alternative is the whole structure, never one bucket's settings.** Flows point at
buckets, a residual target names the buckets it sits behind, and whether the edges form a
loop is a question about all of them at once. Give each bucket its own timeline and the
combination live in some year can break rules every timeline respects, with nothing to
catch it. Naming the structure keeps every version complete and separately validated when
the plan is opened, including versions that take over decades from now.

**Names are identity.** A bucket carried forward under the same name is the same bucket
continuing, and keeps its history — notably its running peak, which the "don't sell into a
fall" rules measure against. A name appearing for the first time has no history, which
reads as *not down at all*, so rules that would hold a sale back stand aside for a period.
Renaming between versions therefore retires one bucket and starts another — a decision
if deliberate, a trap if not.

Changing over moves no money by itself. The new structure states what should be true, and
the ordinary machinery brings it about at its own pace and under its own restraints — so a
plan wanting a deep reserve by a particular year should say so a few years earlier.

**To change only a size, use a multiplier by year instead.** It carries across structure
changes, reads as the resulting years or dollars, and holds an MPC session's size decisions.

See [Liquidity Pools](liquidity-pools.md) for the structure itself.
