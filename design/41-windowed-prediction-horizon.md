# 41 — Windowed Prediction Horizon (sliding fixed-length look-ahead)

**Status**: Phase 1 implemented + browser-verified (2026-06-28); decisions locked (§8 D1, D2). Phase 2 (terminal value for die-with-target) deferred.
**Related**: `design/39-mpc-financial-controller.md` (§6 epochs, §10 Q1 full-life-vs-windowed, §10 Q2 terminal value), `design/40-after-tax-net-worth.md` (§5.1 the spend-down/terminal-stock interaction this resolves; D2 the Roth-lever default), `src/finance/optimization/optimization-problem.js` (the rollout end-date this parameterizes), `src/finance/mpc/cockpit-controller.js` (the per-epoch solve).

> **One-liner.** Today every MPC solve rolls each candidate from "now" to **`simEnd`** and scores the terminal there (`OptimizationProblem.evaluate` → `_rollout` → `stepTo(simEnd)`, `optimization-problem.js:171,280`). This design adds a **fixed-length sliding window** `H`: each solve instead rolls to `scoreEnd = min(now + H, simEnd)` and scores there. The window slides forward with "now," clamps at `simEnd`, and shrinks over the final `H` years — so **`H = remaining years` recovers today's full-horizon behavior exactly.** One mechanism, both modes, every lever. It exists so the **after-tax terminal-stock objectives can see Roth-conversion value before the pre-tax pile is spent down by death** (design 40 §5.1).

---

## 1. Why

The prediction horizon today is full-life: `scoreEnd == simEnd` for every solve, every lever (confirmed in code, §3). Design 40 §5.1 showed the consequence for the flagship Roth lever: over a full-life **spend-down** plan the pre-tax pile is consumed by death, so a terminal *stock* read at `simEnd` (after-tax net worth) is flat w.r.t. conversion — the value has leaked out as a lifetime-tax *flow*. A **shorter, sliding window** puts the scoring terminal *before* death, where the un-converted pre-tax pile still exists and a conversion visibly raises after-tax net worth at the window edge. That edge stock is the controller's continuation value: "leave me holding more spendable-after-tax wealth `H` years out."

The window is also the standard MPC move (design 39 §10 Q1) — a bounded look-ahead keeps each solve cheap and lets the controller react to nearer information — so it's worth building generally, not just for Roth.

---

## 2. The mechanism (lever-agnostic, trivial)

```
scoreEnd = H ? min(addYears(now, H), simEnd) : simEnd     // H unset / 0 ⇒ full horizon
```

- **`now`** = the snapshot's date for a `kind:'snapshot'` rollout, else `simStart`.
- **Slides** with "now" (each Advance moves "now"; the window's start and end move with it).
- **Clamps** at `simEnd` — the window never extends past the run.
- **Shrinks** over the final `H` years: at `now = simEnd − 3y` with `H = 10`, the effective window is 3 years. This is the "truncate the last H slides by 1 each step" behavior — it falls out of the `min`, no special case.
- **`H = remaining` ⇒ `scoreEnd = simEnd`** ⇒ byte-identical to today.

The horizon lives entirely in the rollout's end date inside `OptimizationProblem`, which is **lever-agnostic** — so the window is automatically available to Spending, Roth, and any future lever from one cockpit `Horizon` control. **The commit step is independent**: `now` still advances 1 year per Advance (`rollToSnapshot(candidate, toDate)`, `optimization-problem.js:295`) regardless of `H`. `H` is *how far each solve looks*; the commit cadence is *how far "now" moves before re-solving*.

### Terminology (as used across designs 39–41)

| Term | Meaning | Status |
|---|---|---|
| **Prediction horizon** | how far each solve simulates to score a candidate | today = now→`simEnd`; this design = now→`scoreEnd` |
| **Window / windowed horizon** | a *fixed length* `H` shorter than remaining life; the prediction horizon when `H` is set | **new here** |
| **Receding horizon** | the loop: solve over the horizon, commit the first segment, advance "now," re-solve | implemented (Advise→Apply→Advance) |
| **Commit step / epoch** | how far "now" advances before re-solving | 1 year, independent of `H` |

---

## 3. What the code does today (grounded)

- `evaluate(candidate)` → `params = _applyCandidate({ ...baseParams, endDate: this.simEnd }, candidate)` → `_rollout(params)` (`optimization-problem.js:170-172`).
- `_rollout(params)` → `sim.stepTo(params.endDate)`; `_readResult(state, params.endDate, params)` (`:278-281`).
- `rolloutSeries` (the cockpit fan) samples to `this.simEnd` (`:317-331`); `rollToSnapshot` (the commit) rolls to an intermediate `toDate` (`:295-298`).
- Running-accumulator objectives are **already windowed to `[now, end]`** by subtracting the snapshot accumulator in `evaluate(result, { snapshot })` (e.g. `MIN_LIFETIME_TAXES`, `objectives.js`); terminal-stock objectives read the stock at `end`.
- The cockpit builds the problem with `simEnd: this.simEnd` for **every** lever (`cockpit-controller.js:_problem`) — so today both levers share the full horizon (the clarification from the prior discussion).

So the only rollout change is: replace the `simEnd` used as the **scoring end** with `scoreEnd`. The *simulation* is still compiled with the real `simEnd` (`buildDefaultConfig(..., simEnd)`, `:198,214`); we just `stepTo` the window edge and read metrics there.

---

## 4. The load-bearing constraint — which objectives may be windowed

A window is only sound for an objective whose **score at an arbitrary end date `T` is a faithful proxy for "the value of the realized state at `T`"** — a Bellman continuation value. That is a *narrower* set than "any objective," and narrower than the stock-vs-flow split floated earlier. Three buckets:

| Objective | Shape | Windowable? | Why |
|---|---|---|---|
| `MAX_NET_WORTH` | terminal stock | ✅ | the stock at the edge **is** the continuation value |
| `MAX_AFTER_TAX_NET_WORTH` | terminal stock | ✅ **(flagship)** | after-tax stock at the edge sees the un-converted pre-tax pile → Roth value is visible (design 40 §5.1) |
| `MAX_NET_LIQUIDITY` | terminal stock | ✅ | spendable stock at the edge |
| `MAX_ROTH_BALANCE` | terminal stock | ✅ | balance at the edge |
| `MIN_LIFETIME_TAXES` | **pure running flow** | ❌ full-horizon | windowing counts only in-window taxes and **drops the post-window tax savings that are the Roth payoff** → myopically "never convert" |
| `MAX_CRRA_UTILITY` | **pure running flow** | ❌ full-horizon | windowing maximizes in-window utility only → "spend the max this window," ignoring the carried-forward state |
| `DIE_WITH_TARGET*` family | death-anchored (running + terminal **penalty**) | ❌ full-horizon | `−λ·\|terminal − target\|` is meaningless at a non-death edge; needs a terminal **value** (§7, design 39 Q2) |

**The rule: only pure terminal-stock *maximizers* honor `H`.** Everything else — pure running accumulators **and** death-anchored objectives — is scored at the full horizon (`scoreEnd` forced to `simEnd`), because windowing them silently discards the out-of-window value that is their whole point.

> **This generalizes the locked D1.** We agreed to force *die-with-target* to full horizon; the same myopia argument applies to the running-accumulator objectives (`MIN_LIFETIME_TAXES`, `MAX_CRRA_UTILITY`), so they are full-horizon too. The safe default is therefore **full-horizon; windowing is opt-in per objective.** This keeps the `H = remaining ≡ full` identity for windowable objectives, and makes non-windowable objectives ignore `H` entirely (no silent myopia, no surprise).

**Practical note on levers.** The mechanism is lever-agnostic, but windowing is *useful* mainly for the **Roth** lever, where the edge stock (`MAX_AFTER_TAX_NET_WORTH`) captures conversion value with no spend-down tradeoff. For the **Spending** lever the natural objective is die-with-target (full-horizon, and a pure stock-maximizer would myopically say "spend nothing"). So in practice Spending stays full-life and Roth gains the window — but the control is offered uniformly and the per-objective gate does the right thing for any pairing.

---

## 5. Code surface

Small, additive; default preserves current behavior exactly.

1. **`OptimizationProblem`** (`optimization-problem.js`):
   - Constructor gains `horizonYears` (default `null` = full).
   - `_scoreEnd()` → `null`/`0` ⇒ `this.simEnd`; **objective not windowable** ⇒ `this.simEnd`; else `min(addYears(nowDate, horizonYears), simEnd)`, where `nowDate = this.initialState?.snapshot?.date ?? this.simStart`.
   - `evaluate` (`:171`), `_rollout` (`:280`), `rolloutSeries` (`:317`) use `this._scoreEnd()` as the rollout end + `_readResult` date in place of `this.simEnd`. `rollToSnapshot` (the commit) is **untouched** (commit ≠ score).
   - Compile still uses the real `simEnd` (`:198,214`) — the sim's configured end never changes; we only stop stepping early.
2. **Objective tag** (`optimization-objectives.js`): add `windowable: true` to the four terminal-stock maximizers (`MAX_NET_WORTH`, `MAX_AFTER_TAX_NET_WORTH`, `MAX_NET_LIQUIDITY`, `MAX_ROTH_BALANCE`). `objectiveIsWindowable(objective)` defaults false. (Opt-in keeps "full horizon" the safe default for everything untagged, incl. future objectives.)
3. **`CockpitController`**: pass `horizonYears` into `_problem(...)` (and `advance`/`rolloutSeries` paths via the shared problem). A setter `setHorizonYears(h)` mirrors `setObjective`/`setControl`.
4. **Cockpit UI** (`mpc-cockpit-plugin.js` + CSS): a `Horizon (yrs)` number field next to Search (blank/0 = "Full"). When the selected goal is **not** windowable, the field is disabled with a hint ("Full horizon — this goal scores at end of plan"), since `H` would be ignored. Wire it through `setHorizonYears`.
5. **OPT panel** (optional, Phase 1.5): the same `horizonYears` field for the batch optimizer, same gate.

No new simulation primitive, no reducer/event changes. The fan (`rolloutSeries`) automatically draws to the window edge, so the user *sees* the horizon they're optimizing over.

---

## 6. The unification, made precise

- **Windowable objective, `H = remaining`** ⇒ `scoreEnd = simEnd` ⇒ **exactly today's behavior** (identity).
- **Windowable objective, `H < remaining`** ⇒ running reward windowed to `[now, now+H]` (snapshot delta, already in `evaluate`) + terminal stock at `now+H` (the continuation value). This is the new, useful mode (Roth flagship).
- **Non-windowable objective, any `H`** ⇒ `scoreEnd` forced to `simEnd` ⇒ today's behavior, `H` ignored (with the UI hint).

So "treat the sliding `H` as the full horizon by setting `H = years-to-simEnd`" holds as an **exact identity** for the windowable objectives, and the non-windowable ones are always full — there is never a silently-myopic score.

---

## 7. The deferred piece — a terminal value for die-with-target (design 39 Q2)

The only thing windowing *can't* do today is the die-with-target family, because its death-anchored penalty has no meaning at a non-death edge. Making it windowable needs a **terminal value function** `V(state, edge)` — a continuation value standing in for "the rest of life beyond the window" — so the windowed score becomes `running_within_window + V(state_at_edge)`. The natural `V` is the after-tax terminal-stock the family already targets (e.g. `+afterTaxNetLiquidity(edge)` as a reward, replacing the `−λ·|·−target|` death penalty), possibly with a calibrated weight. This is design 39 §10 Q2 and is **out of scope for Phase 1**; it's the Phase 2 follow-up that would let die-with-target be driven on a window too.

---

## 8. Decisions

- **D1 — Non-windowable objectives are full-horizon (generalizes the agreed die-with-target clamp). DECIDED.** Only the four terminal-stock maximizers (`windowable: true`) honor `H`; die-with-target **and** the pure running accumulators (`MIN_LIFETIME_TAXES`, `MAX_CRRA_UTILITY`) are scored at `simEnd` regardless of `H`, with a UI hint. Rationale: windowing a non-continuation-value objective is myopic (§4). Full horizon is the safe default; windowing is opt-in per objective.
- **D2 — Single cockpit-level `Horizon (yrs)` field. DECIDED.** One control (blank/0 = full), applied to the active lever's solve. The cockpit solves one lever at a time, so a single field suffices; switch levers and set it differently as needed. Per-lever *persisted* `H` is a later nicety, not now.

---

## 9. Testing sketch

- `windowed-horizon.test.mjs` —
  - `_scoreEnd`: `H=null`⇒`simEnd`; `H` huge ⇒ clamps to `simEnd`; `H` small ⇒ `now+H`; shrinks as `now`→`simEnd`; non-windowable objective ⇒ `simEnd` regardless of `H`.
  - **Identity**: a windowable objective with `H = years(now→simEnd)` produces a result **metric-for-metric identical** to `H=null` (the unification gate).
  - **The fix**: on a solvent scenario, `MAX_AFTER_TAX_NET_WORTH` with a *short* `H` (pre-spend-down edge) shows a Roth conversion **raises** `finalAfterTaxNetWorth` at the edge (a gradient), where the same objective at full horizon is flat (design 40 §5.1) — the windowed solve recommends a positive conversion, the full-horizon one does not.
  - **Myopia guard**: `MIN_LIFETIME_TAXES` ignores `H` (scoreEnd==simEnd) so it never degenerates to "never convert."
- `cockpit-controller.test.mjs` (+): `setHorizonYears` flows into the problem's `_scoreEnd`; advise under a window returns an edge-dated fan.
- `mpc-cockpit-plugin.test.mjs` (+): the `Horizon` field renders, disables + hints for a non-windowable goal, enables for a windowable one, and wires `setHorizonYears`.

---

## 10. Phasing

- **Phase 1 (this design). [x] IMPLEMENTED.** `horizonYears` + `_scoreEnd()` gate in `OptimizationProblem` (evaluate + fan; the commit `rollToSnapshot` untouched); `windowable` tag on the four terminal-stock maximizers + `objectiveIsWindowable`; `CockpitController.setHorizonYears` threaded into `_problem`; cockpit `Horizon (yrs)` field with the non-windowable disable/hint. Tests: `windowed-horizon.test.mjs` (+10: `_scoreEnd` clamp/slide/shrink/gate, the **H=remaining ≡ full identity**, window-is-a-distinct-horizon, myopia guard), `cockpit-controller.test.mjs` (+2: `setHorizonYears`→`_scoreEnd`, normalize ≤0→null), `mpc-cockpit-plugin.test.mjs` (+2: field gating + `_currentHorizon`). Full suite green (2945 unit, 798 viz). **Browser-verified**: the `Horizon` field gates by goal (enabled for after-tax worth; disabled+hint for lifetime-taxes / die-with-target); a windowed solve scores a **distinct** horizon — at an 8-yr edge the after-tax worth sits *below* nominal (pre-tax pile still present → a real embedded-tax discount), where at full horizon (2070) the two are equal (pile spent down). *Caveat:* surfacing a *positive* conversion recommendation needs a year with a funded Traditional IRA/401(k); the verification scenario read `$0` pre-tax in the checked years, so the lever was correctly inert there — the window code is proven, the conversion payoff is gated on scenario timing (the user's scheduled 401k→IRA rollover).
- **Phase 2 (deferred — design 39 Q2).** A terminal value `V(state, edge)` so the **die-with-target** family can be windowed (running-within-window + continuation value), with λ/weight calibration. Then die-with-target + Spending can be driven on a window too.
- **Later.** Per-lever persisted `H`; a discount factor within the window; OPT-panel `Horizon` for the batch optimizer.
