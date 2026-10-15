# 123 — What a cockpit session's pool rows mean after the session

**Status:** PROPOSED (15 Oct 2026). The author decided the default (§4.3): a session's last
decision **holds**, because that is what the controller priced. Everything else here is the
proposal's and open to revision.

**Related:** design 39 (the MPC controller and cockpit), design 41 (windowed prediction horizon:
rollouts score to `simEnd` unless H is set), design 81 (a run as a replayable artifact; §Q6
"hold this decision for the rest of life"), design 112 (dated pool targets, `POOL_TARGET`,
PTL-6b "rollout ≡ t₀ compile"), design 61 §12.1 D5 (the glidepath TERMINAL warning, the
precedent for warning instead of rewriting).

## 1. The problem

`liquidityTargetSchedule` and `liquidityGraphSchedule` rows are open-ended: a row holds until the
next row for the same pool (or, for shapes, the next row at all). A cockpit session writes one
row per decided year. When the operator stops advancing, the session's **last** row has no
successor, so it holds to the end of the plan.

A study found this the hard way. A session run to test the controller's behaviour over a
six-year window left a doubled buffer target in force for the remaining four decades of the
plan, and that tail, not the six years, drove the study's result. Nothing in the app said so:
the row editor's summary read like "reserve 2y (×2), 2030–2035, 6 rows", which looks like a run
that ends in 2035.

## 2. How the rows work today

### 2.1 Every epoch writes a row, changed or not

`POOL_TARGET.actuate` (`src/finance/mpc/cockpit-controller.js`) writes a
`{ year, pool, scale, by: runId }` row for **every pool it searched**, whether or not the factor
differs from the one already in force. `POOL_SHAPE.actuate` writes one `{ year, shape }` row per
epoch the same way (no `by` mark: the shape normalizer carries only `{ year, shape }`). The
harvest (bake) writes the same rows from the recorded epochs.

So a row is a dated **decision**, not a change. A session that holds ×2 for six years leaves six
identical rows; `collapseTargetRuns` (`src/finance/pools/pool-target-schedule.js`) folds them into
one run for display. That is deliberate and this design keeps it: the rows are the session's
audit trail, and a replay (design 81) folds exactly them.

### 2.2 Every decision is priced as permanent

A rollout runs each candidate to `simEnd` (design 41: `scoreEnd = simEnd` unless H is set, and
die-with-target objectives are forced to the full horizon). The candidate row is open-ended in the
candidate compile, so each epoch chooses its factor believing it means "this factor from next
1 January to the end of the plan". Design 81 §Q6 says the same of every projection.

### 2.3 Inside a session each row lasts one year; only the last is ambiguous

The next epoch's row replaces the previous one at the next year-open, so in the realised run each
interior decision governs exactly one year. The last row is the only one whose tail nobody
decided against. Holding it is **faithful to how it was priced**: the controller's last decision
really was "hold this". But whether the operator *meant* the session to end there, and what the
plan should do afterwards, is a decision the controller never made.

### 2.4 The cockpit has no "end"

A session ends when the operator stops pressing Advance. There is no event at which a closing
row could be written, and nothing records where the session meant to stop.

### 2.5 The other levers already differ

| Lever | After its last decision |
|---|---|
| ROTH, EARLY_WITHDRAWAL | Per-year: an undecided year reverts to the authored value (`ROTH_SCHEDULE.foldAlso`). |
| POOL_TARGET, POOL_SHAPE | Holds until the next row, i.e. to plan end. |
| SPENDING | Age-keyed bands; the last band holds. |
| ALLOCATION_MIX | The glidepath clamps above its last anchor, and `_zeroedClassWarnings` raises a TERMINAL warning when that anchor zeroes a class. It does not rewrite the bake. |

This design does not unify them. ROTH reverts because a conversion is an amount in one tax year;
a pool size is a standing policy. The glidepath precedent (warn, do not rewrite) is the one the
pool levers follow.

## 3. What is rejected

### 3.1 An automatic closing row

Writing a scale-1 row (or the authored shape) after the session's last year would:

- **decide on the author's behalf.** "Revert after the window" is a choice nobody made, just as
  "hold forever" is; swapping one silent default for another fixes nothing.
- **break the pricing contract.** The last decision was priced as held. A replay that reverts it
  differs from every projection the session showed, and from the live run (design 81 B ≡ A′).

### 3.2 A per-year pool lever

Having each actuate write `(year, ×s)` and `(year + 1, ×1)` would keep replays faithful only if
the rollout priced the same shape: a one-year resize. That is a different control (the ROTH
model), and the controller would then optimise knowing the factor reverts. It would also break
design 112 PTL-6b. Not proposed; §6 Q3 keeps it as a question.

## 4. Proposal

### 4.1 Say how long the last run lasts (row editors)

`collapseTargetRuns` gains an `openEnded` flag: true for a pool's last run when its scale is not
1 (a scale-1 row is the identity, which `appliedScales` drops). The target editor's summary then
reads:

> reserve 2y (×2), 2030–2035, then held to the end of the plan (2060) · 6 rows · by run-…

A single-row run reads "from 2030, held to the end of the plan". The shape schedule editor does
the same for its last row when that row names a shape (a `null` row is the base graph, so it is
not a departure from the plan).

### 4.2 An advisory when a session's last row holds past the session

When a pool's last row was written by a session (`by` set) and is not ×1, or the shape
schedule's last row names a shape and was written by a session (§4.4 gives shape rows a mark),
raise a warning naming the pool, the factor, the last decided year and the plan end:

> Liquidity Pool Target: the session's last decision for reserve (×2, 2035) holds to 2060 — the
> controller priced it as held for the rest of the plan. End the session (§4.3) to choose hold or
> revert.

Shown in two places:

- **the harvest/bake warnings**, alongside `_zeroedClassWarnings`, so a baked run says it;
- **the row editor**, under the summary, so a plan loaded later still says it.

The advisory is silenced by an explicit end choice (§4.3), not by time: once the author has
decided, it is no longer news.

### 4.3 "End session": hold (default) or revert after a year

The cockpit gains an **End session** action. It offers:

- **Hold** (default) — keep the last decision in force to the end of the plan. This is what the
  controller priced, so it is the default. It writes no rows; it records the choice (§4.5).
- **Revert after <year>** — from 1 January of the year after <year> (default: the last decided
  year), the plan returns to its authored policy. It writes closing rows:
  - **targets:** a `{ year, pool, scale: 1, by: runId, end: 'revert' }` row for every pool whose
    last session row is not ×1;
  - **shapes:** a `{ year, shape: <authored shape in force>, … }` row, where the authored shape
    is `_plannedShapeAt` evaluated over the schedule **without** the session's rows (the plan as
    authored, not as the session left it).

  If the operator chooses a year before the last decided year, the rows after it are not deleted:
  End session only appends. Truncating a session is an edit the author makes in the row editor.

Both choices are idempotent: ending a session twice replaces its earlier closing rows rather than
stacking them.

### 4.4 Marks on the rows

- Target rows keep `by`, and a closing row adds `end: 'revert'`. The normalizer and serializer
  carry `end` through; a row without it is an ordinary decision.
- Shape rows gain the same optional `by` (and `end`), so §4.2 can tell a session's shape row from
  an authored one. The shape editor shows it as the target editor does.

Both fields are optional; a plan without them round-trips byte-identical, and no golden moves.

### 4.5 The run record carries the end choice

The design 81 run record (`src/finance/mpc/run-record.js`) gains `source.end`:
`{ policy: 'hold' | 'revert', afterYear }`. A replay folds the decision schedule exactly as today
and, for `revert`, the closing rows the record names. A record without `source.end` replays as
today (hold), so every existing record is unchanged.

Note the asymmetry this accepts: a **revert** replay differs from what the session's projections
showed after the end year. That is the point of the choice, and the End session dialog says so
("the controller priced these decisions as held; reverting changes the plan after <year>").

### 4.6 Not proposed: pricing a declared window

A session could declare its window up front so that rollouts price "×s until the window end, then
×1". That makes the controller's choices consistent with a revert, but it changes what every
candidate means and needs its own design-41-style horizon argument. Left as §6 Q2.

## 5. Phasing

1. **Visibility** — `openEnded` on `collapseTargetRuns`; target and shape editor wording; help
   topic for the pool schedules updated. No model change.
2. **Advisory** — harvest warnings for both pool levers; editor advisory. Needs the shape-row
   `by` mark (§4.4), which lands here.
3. **End session** — the cockpit action, closing rows with `end`, `source.end` on the run record,
   replay folding the closing rows.

Phases 1–2 change no simulation output. Phase 3 changes output only for a plan whose author
chooses revert.

## 6. Open questions

1. **Should the advisory also fire for authored rows?** An author who writes a ×2 row means it;
   the proposal says no (session rows only).
2. **Declared windows (§4.6)** — worth a design of its own if revert becomes the common choice.
3. **Per-year pool lever (§3.2)** — only if a study shows the controller choosing differently
   when it knows the factor reverts.
4. **Unchanged rows (§2.1)** — keep writing a row per epoch even when the factor is unchanged? The
   proposal keeps it (audit trail, replay fidelity); the cost is only display, which the run
   collapse already handles.

## 7. Test plan (to be written with the code)

- `collapseTargetRuns`: `openEnded` true only for a pool's last run with scale ≠ 1; false for a
  closing ×1 run; per pool, not global.
- Editor summary text for open-ended, closed and single-row runs (targets and shapes).
- Harvest warning present for a session-written last row ≠ ×1, absent once a closing row exists
  or `source.end.policy === 'hold'`.
- End session revert: writes one ×1 row per non-identity pool and the authored shape row; second
  End replaces, not stacks; rows after `afterYear` untouched.
- Replay: a record without `source.end` is byte-identical to today; a revert record folds the
  closing rows and changes the state only from the closing year.
- Round trip: `by`/`end` on shape and target rows survive serialize → load; a plan without them is
  byte-identical (goldens unchanged).
