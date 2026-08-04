# 35 — Drawdown Owner Ordering

**Status**: Implemented — design written 2026-06-23, landed same day. Browser verification pending.
**Related**: "Drawdown Order as Parameters" (commit `0d1d0e2`, the custom-drawdown-strategy feature this extends), `design/15-config-as-source-of-truth.md` (the param is a round-tripped scenario param), `design/32-param-field-linking.md` (the param→record `accountPriority` node cascade this rides on).

---

## 1. Purpose

A drawdown strategy ranks accounts **by role** (e.g. Roth = 3, US Stock = 7). When the same role is owned by more than one person (primary + spouse), the `accountPriority` cascade adds a fixed **owner band** on top of the role rank:

```js
rec.drawdownPriority = base + ownerRank * ownerStride;   // ownerStride = 100
```

with `ownerOrder: ['primary','spouse']`. So every spouse account is offset by +100 and the **entire primary band (1–8) drains before any spouse account (101–106)**, regardless of role. This starves the spouse's high-priority buckets: in a real run a Spouse Roth (dp 103) was never drawn and compounded to ~\$10.9M while the primary Roth (dp 3) was depleted early. The banding was hard-coded and not user-selectable.

This design exposes the banding as a scenario param so the user can instead **pool** same-role accounts across owners (both Roths in one tier), or flip which owner drains first.

## 2. Today

- The `drawdownStrategy` param carries an `accountPriority` node (`src/scenarios/intl-retirement-scenario.js`) with static `ownerOrder: ['primary','spouse']` and `ownerStride: 100`.
- `ScenarioLoader._applyParamNode` (`src/scenarios/scenario-loader.js`) resolves the selected strategy's per-role base ranks and writes `drawdownPriority = base + ownerRank * ownerStride` onto each eligible account record.
- At runtime `AccountService.replenishSavings` (`src/finance/services/account-service.js`) sorts drawdown sources by a cash-first tier then `drawdownPriority`, and (ORDERED mode) drains each source fully in that order.

## 3. Design

Add an **Enum** scenario param `drawdownOwnerOrdering` (group **Spending**, default `PRIMARY_FIRST`) with three modes. The modes are **data-driven on the node** (mirroring how `customStrategiesKey` already parameterizes the same node), so the loader stays generic:

| Mode | ownerOrder | ownerStride | Effect |
|------|-----------|-------------|--------|
| `PRIMARY_FIRST` (default) | `['primary','spouse']` | 100 | legacy behavior — primary band 1–8, spouse 101–106 |
| `SPOUSE_FIRST` | `['spouse','primary']` | 100 | spouse band first |
| `POOLED` | (n/a) | 0 | same-role accounts across owners share a priority tier (both Roths = 3) |

The node gains `ownerModeKey: 'drawdownOwnerOrdering'` and an `ownerModes` map of mode → `{ ownerOrder?, ownerStride }`. The cascade reads the selected mode from `cfg.parameters[ownerModeKey]` and overrides the node's default `ownerOrder`/`ownerStride` before computing each account's priority. The bare `ownerOrder`/`ownerStride` remain as `PRIMARY_FIRST` fallbacks.

`drawdownOwnerOrdering` carries **no node of its own** — it is consumed by the `drawdownStrategy` node's cascade. Param values are synced into `cfg.parameters` before any node cascade runs, so it is available regardless of param ordering.

### Runtime tie semantics (no runtime change)

With `POOLED`, the two same-role accounts get **equal** `drawdownPriority`. `replenishSavings` ORDERED mode sorts by `drawdownPriority` (stable sort) and drains each source fully, so a tie drains **sequentially** — one owner's account fully, then the other (deterministic by state-key registration order), both ahead of any lower-ranked role. Pro-rata *within* a pool is not expressible in ORDERED mode and is out of scope (use the global `PROPORTIONAL` strategy for pro-rata). `PROPORTIONAL` drawdownMode is unaffected — it ignores banding entirely.

## 4. Back-compat / drift

No migration needed. The node-resync behavior in `_mergeParamSchema` (node is schema-owned metadata, re-synced on every load) propagates `ownerModeKey`/`ownerModes` onto already-saved scenarios' `drawdownStrategy` node, and the schema-drift guard appends the new `drawdownOwnerOrdering` param with its `PRIMARY_FIRST` default. A cfg saved before this design therefore keeps exactly today's banding. The cascade also falls back to the node's default `ownerStride: 100` when the param is absent. No UI editor work — a plain Enum renders with the existing control. Optimizer sweep is off (`opt: false`) for now; it can be enabled later like `drawdownStrategy`.

## 5. Testing

Unit (`tests/unit/scenario-loader.test.mjs`): `PRIMARY_FIRST` bands spouse +100; `POOLED` gives same-role accounts across owners equal priority; `SPOUSE_FIRST` bands primary +100; missing param falls back to legacy banding; the param is appended to a sparse saved cfg with its default.

End-to-end (browser): set `drawdownOwnerOrdering = POOLED`, rebuild, confirm Spouse Roth `drawdownPriority` equals the primary Roth's, run to completion, and confirm the Spouse Roth is now drawn down rather than left as a large untouched balance.
