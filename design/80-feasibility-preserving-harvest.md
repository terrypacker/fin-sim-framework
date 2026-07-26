# 80 — Feasibility-preserving harvest: why a baked plan goes broke and the controller doesn't

**Status**: Proposed (2026-07-26)
**Related**: `design/39-mpc-financial-controller.md` §13 (the harvest this corrects — §13.3 forms, §13.6.3 POINT, §13.6.6 RESOLVE, §13.7 fidelity, §13.13 the representation question), `design/38-optimization-solver-framework.md` (the solve RESOLVE calls), `design/58-drawdown-levers.md` / `design/65-allocation-aware-drawdown.md` / `design/66-bond-fidelity.md` (the levers with no schedule form), `design/74-stochastic-return-paths.md` (multi-seed feasibility), `design/45` (early-withdrawal mechanics — the access cliff)

> **Reading note**: design 39 §13 specifies *how* to copy a controller run back into a scenario. This design is about a case where doing that correctly still produces a **broken plan** — and argues that the harvest's job is not to reproduce the controller's answer but to **re-solve the controller's problem without feedback**. Those are different problems, and conflating them is the defect.

---

## 1. The observation

Running the cockpit against a `DIE_WITH_TARGET` ("die with zero") goal and harvesting the result: **the baked scenario fails early — insolvency in the 2050s — while the closed-loop MPC run it was baked from does not.** The failure sits where the plan has to bridge from liquid/taxable wealth to retirement accounts that are not yet accessible: die-with-zero drives taxable down as far as it can, and open-loop it goes one step too far.

This is not the drift design 39 §13.7 anticipated. §13.7 promises a **bounded, measurable Δ** on the goal metric, with a fidelity target of ~1% for schedule-form levers. A plan that runs out of money is not 1% off; it is a different kind of object. §13.7's framing quietly assumes the baked plan is *solvent*, and there is nothing in the harvest that enforces that.

---

## 2. Why it happens — four mechanisms, all in the code

### 2.1 The objective is indifferent to solvency margin

`makeDieWithTarget.evaluate` (`optimization-objectives.js`) is:

```
score = running_reward − λ·|realTerminal − target| − μ·deficit
```

Both correction terms actively refuse to reward a buffer:

- **λ is two-sided.** `Math.abs(realTerminal − target)` penalises *overshoot* exactly as hard as shortfall. Ending with margin is a cost. That is the whole point of "die with zero" and it is correct.
- **μ is a cliff, not a gradient.** The `DEFAULT_DEFICIT_PENALTY` docblock says so explicitly: it "is **zero for any solvent plan** … so it never perturbs the interior spend-early ⇄ leave-less optimum." Deliberate, and right for the closed loop — but it means a plan that clears every month by **$1** and a plan that clears by **$500k** score *identically* on the solvency term, and the $1 plan scores strictly better on λ.

So the optimum this goal selects is, by construction, a **knife-edge plan**: no margin, because margin is penalised and safety is not rewarded.

**With `terminal: 'liquid'` the knife edge *is* the ruin boundary.** The motivating run used `DIE_WITH_TARGET_LIQUID` (`finalNetLiquidity`) with `terminalWealthTarget = 0` — chosen for the reason the code itself recommends (`optimization-objectives.js:260`: *"Prefer the LIQUID terminal when the lever set can't liquidate illiquid assets (house equity, age-locked super), so the 'die with $X' target is actually reachable by the controls"*). That is the right call for reachability and it has a consequence nobody wrote down:

> **Terminal net liquidity = 0 and insolvency are the same state.** They differ only in *when* you arrive. λ pulls liquidity to zero; μ is the only thing distinguishing "zero at `simEnd`" from "zero in 2051" — and μ is a cliff with no gradient. The objective is not merely *indifferent* to margin here; it is actively **optimising toward the failure boundary** and relying on a step function to stop at the right moment.

Under feedback that is threadable — the controller re-measures each epoch and steers along the edge. Open-loop it is not, and the error is wildly asymmetric in consequence: overshooting the target by \$1 of leftover liquidity costs `λ·1 = 10`; undershooting by running dry a year early costs `μ ×` a year of spending ≈ `100 × $100k = $10M`. The λ term is symmetric, so nothing in the objective encodes that asymmetry. This is the sharpest available statement of §2.2, and it is specific to the `liquid` scope — `terminal: 'worth'` keeps the house in the terminal, so its optimum is interior and it does not sit on the boundary at all.

### 2.2 Closed-loop, indifference is harmless. Open-loop, it is fatal.

The controller survives its own knife-edge plan not because the objective protects it, but because it gets **~20 more chances**. Each epoch it re-solves full-life (§10 Q1 — the `DIE_WITH_TARGET` family is *not* windowed; `mpc-controller.js` rolls every horizon to `simEnd`), sees the cliff in its own rollout, and steers. Margin is supplied by **feedback**, not by the objective.

Remove feedback and the same plan has no error budget left. This is the general statement, and it is the load-bearing idea of this design:

> **An objective whose optimum lies on a constraint boundary produces plans that fail under any perturbation — and removing feedback *is* a perturbation. The harvest is therefore not safe for boundary-seeking goals unless it re-solves for margin.**

`MAX_NET_WORTH` does not show this, because its optimum is interior. This is a property of **goal × harvest**, not a bug in any single bake.

### 2.3 The bridging maneuver lives in exactly the levers with no schedule form

> **⚠ MEASURED AND REFUTED for the motivating scenario (2026-07-26).** §2.3 and §2.4
> below were the *predicted* mechanism. `scripts/lab/attribute-ruin.mjs` on
> `scenarios/fin-sim-die-with.json` shows the drawdown levers are **not** what broke
> it — see §2.5 for what actually fired. The mechanism described here remains a real
> hazard and the argument stands on its own; it simply is not this failure. Keeping
> it as the record of a prediction that measurement overturned.


`AccountService.replenishSavings` funds a deficit in three phases: **Phase 1** penalty-free sources, **Phase 2** early withdrawal *with* penalty (gated on `rules.ageThreshold` — US 59½, AU preservation age), **Phase 3** taxable backstop. Crossing an access age **changes which phase carries the draw**, and with it which account ordering is correct.

The controller re-decides that ordering every epoch through four levers. Per design 39 §13.3, **all four are POINT-only**:

| Lever | Control param | Harvest form today |
|---|---|---|
| `DRAWDOWN_WEIGHTS` | `drawdownWeight::<role>` | POINT (no `harvest` hook — see the comment in `cockpit-controller.js`) |
| `DRAWDOWN_SLEEVE` | `sleeveWeight::<CLASS>` | POINT |
| `DRAWDOWN_XBORDER` | `crossBorderDrawdown` | POINT |
| `DRAWDOWN_WITHINTIER` | `withinTierDraw` | POINT |

The levers that carry the pre-access bridge are precisely the ones the harvest collapses to a single number. `SPENDING`, `ROTH`, `EARLY_WITHDRAWAL` and `ALLOCATION_MIX` — the four that bake faithfully — are not where this maneuver lives.

### 2.4 POINT does not just lose information, it loses it *with a bias*

§13.6.3 keeps the **last** epoch's value. If the run advanced past the access age, that value is the **post-access** answer, applied retroactively from t₀ — the bridge years get an ordering chosen for a world where the deferred accounts were already open. The collapse is systematically wrong **in the direction that breaks the bridge**.

And §13.6.3's warning would not have caught it. `"changed in 7 of 22 epochs"` measures *variance*; the risk here is *ruin*. A lever can hold constant for twenty epochs and move once, decisively, at the cliff — **low variance, catastrophic collapse**. Variance is the wrong statistic.

### 2.5 What actually fired — measured, 2026-07-26

`scenarios/fin-sim-die-with.json` (an all-levers `terminalWealthTarget=0` harvest, sim 2026→2070, Terry b1978 / Jeanne b1983, move 2031) fails at **out-of-funds 2051-04-30, $5,705,589 cumulative deficit, 194 deficit months — with terminal net worth still $4,803,802.** The plan is *asset-rich and cash-poor*: $4.8M is the illiquid residue (the AU house + collectibles) sitting there while every liquid account is drained. Every insolvent arm below lands on that same $4.8M, which is a useful tell.

**Attribution** (`scripts/lab/attribute-ruin.mjs` — revert one harvested lever group at a time, re-run, look for a flip to solvent):

| Reverted lever | Result |
|---|---|
| drawdown order → `TAX_EFFICIENT` | ❌ ruin 2051-04-30 (unchanged) |
| drawdown order → `TAXABLE_FIRST` | ❌ ruin 2051-04-30 (unchanged) |
| sleeve order → `FIFO` | ❌ ruin 2051-01-31 (3 months *worse*) |
| cross-border → `AUTO` | ❌ ruin 2051-04-30 (unchanged) |
| within-tier → `PROPORTIONAL` | ❌ ruin 2052-02-29 (10 months better) |
| glidepath → `STATIC` | ❌ ruin 2040-02-29 (11 years worse) |
| roth schedule → off | ❌ ruin 2051-05-31 (1 month better) |
| bond ladder → 1 rung | ❌ ruin 2051-04-30 (unchanged) |
| **spending bands → pre-MPC flat $5,500** | **✅ SOLVENT, NW $13,384,480** |

So the four POINT-collapsed drawdown levers — the entire §2.3/§2.4 hypothesis — move the ruin date by **months**. `drawdownWeight::super = 0.0398` (super drawn *first*, despite preservation age) looked exactly like the predicted signature and is **not** load-bearing. The lever that broke the plan is **`SPENDING`** — which is a **SCHEDULE** lever, harvested *faithfully*, with near-zero discretization loss.

> **The lever that broke the plan is the one the harvest reproduces most faithfully.** Fidelity was never the problem. §13.7's drift #1 (discretization) is ≈0 here; drift #2 (loss of feedback) is total.

**How far over the line** (`scripts/lab/spend-ceiling.mjs` — scale the MPC-decided bands and bisect for solvency):

- harvested: 23 decided bands, ages 47–89, **mean $8,731/mo** real base-year USD;
- largest open-loop-affordable version: **×0.830 ≈ $7,244/mo**;
- **feedback premium: 20.5%** — the controller baked a fifth more consumption than the same plan sustains without the right to re-decide.

**And it is not a time-keying artifact.** Replacing the whole schedule with a single flat level fails at *every* recorded level, including the controller's own final answer:

| Flat-for-life level | Result |
|---|---|
| $9,941/mo (first decided epoch) | ❌ ruin 2049-05-31 |
| $10,000/mo (max) | ❌ ruin 2048-11-30 |
| $8,731/mo (mean) | ❌ ruin 2059-06-30 |
| $8,559/mo (**last** epoch — the controller's final answer) | ❌ ruin 2061-06-30 |
| the harvested schedule (mean $8,731) | ❌ ruin 2051-04-30 |

Two things follow. First, the schedule is *worse* than its own mean held flat (2051 vs 2059) because the front-loaded bands do the damage early — so time-variation actively hurt here, a **negative VoTV**. Second, and much more important: **no level the controller ever committed to is affordable over this horizon.** Its final decision goes broke nine years before `simEnd`.

That reframes the whole investigation. `μ = DEFAULT_DEFICIT_PENALTY = 100` per deficit dollar should have made an insolvent rollout unrankable, and the deficit signal *does* reach the objective (`optimization-problem.js:500-502` surfaces `scenarioFailed` / `cumulativeDeficit` / `deficitMonths`). So either the controller's own realized path was insolvent and **nothing surfaced it**, or its rollouts were evaluated against a materially different path (a different design-74 seed, a different snapshot state) than the saved scenario re-runs on.

**That is now the open question, and it is not a harvest question.** It is answered by F5 (ruin diagnostics on the decision record) plus F6 (replay), which is why P1 reorders around them in §8.

### 2.6 The goal metric cannot tell success from ruin

Measured on the same scenario, terminal values under `DIE_WITH_TARGET_LIQUID` (`finalNetLiquidity`, target 0):

| Plan | Solvency | Terminal net liquidity | λ·\|terminal − 0\| |
|---|---|---|---|
| pre-run (flat \$5,500/mo) | ✅ solvent | **\$8,580,678** | large |
| as-harvested | ❌ ruin 2051-04-30 | **\$0** | **exactly 0** |

The bankrupt plan scores a **perfect zero** on the goal's own terminal term. `finalNetLiquidity = 0` is produced identically by "spent down to exactly zero at `simEnd`" — the stated goal — and "went broke in 2051 and sat at zero for 194 months." **The metric is degenerate at the target.** Only `cumulativeDeficit` separates them, and it lives in a different term.

Two things break because of this, both in shipped code:

1. **§13.7's verify cannot catch this class of failure.** It compares A vs B on `objectivePrimaryMetric` — here `finalNetLiquidity`. A faithful bake of a solvent plan and a bake that goes bankrupt both land near 0, so the drift reads ≈0% and the check **passes a bankrupt plan**. Worse, `verify-harvest.mjs` guards its verdict on `a !== 0`, so at a=0 it prints no verdict at all. A Δ% on a metric whose target is 0 is not a fidelity measure.
2. **The cockpit card shows the same number.** The recommended-move card reports the projected terminal; a plan headed for ruin displays "$0" — i.e. *on target*.

This is the strongest possible argument for **F1: feasibility is a separate axis from fidelity, checked before apply, and never expressed as a percentage of the goal metric.**

The full-horizon *ranking* is probably still sound — `μ · 5,705,589` at μ=100 is a far larger penalty than λ on the pre-run plan's leftover liquidity — so the defect is in what gets **reported and verified**, not in what the solver optimises. That matters: it is further evidence for §2.5's candidate (c), since no single epoch ever scored the harvested plan.

### 2.7 λ **saturates** at the boundary — the controller goes blind, and commits anyway

`scripts/lab/epoch-solvency.mjs` drives the real closed loop over the real scenario (34 epochs, `DIE_WITH_TARGET_LIQUID`, spend range \$7,000–\$10,000, 8 levers) and prints each epoch's own projection. Abridged:

| Epoch | Date | Committed | Projected terminal | Projected deficit | `scenarioFailed` |
|---|---|---|---|---|---|
| 1 | 2026 | \$8,037 | \$1,415,552 | \$0 | no |
| 2–4 | 2027–29 | \$7,596 | \$52,744 | \$0 | no |
| 5–23 | 2030–48 | \$8,037 | \$78,181 | \$0 | no |
| **24–28** | **2049–53** | **\$7,646** | **\$0** | **\$1,827** | **❌ YES** |
| 29–34 | 2054–59 | \$7,881 | \$898 | \$0 | no |

**Both §2.5 candidates are confirmed, and they are not exclusive:**

- **(a)** At epochs 24–28 the controller's own rollout reported `scenarioFailed = true` with a non-zero deficit, and it **committed anyway, five epochs running**.
- **(c)** All 34 epochs targeted band index 1 — every decision was a *rest-of-life* level, re-keyed by the harvest into one-year steps.

The mechanism behind (a) is the missing piece, and it is a property of the objective, not the solver:

> **With `terminal: 'liquid'` and `target = 0`, the λ term saturates at the boundary.** Above it, `λ·|L − 0| = λ·L` is a real gradient pulling liquidity down. At and below it, the terminal reads `0`, so `λ·0 = 0` — **flat**. The objective drives `L → 0` and then goes blind: it cannot distinguish "ends at exactly zero, solvent" from "was broke for a decade." Every candidate in the insolvent region scores identically on the terminal term.

`μ·deficit` is then the *only* remaining signal — and `DEFAULT_DEFICIT_PENALTY`'s own docblock calibrates μ to "comfortably exceed the marginal reward of a deficit dollar (1 from consumption **+ at most λ from approaching the target**)." That calibration **assumes λ is still pulling.** At saturation it isn't, so the guard is μ alone, competing against a whole horizon of extra consumption — and at epochs 24–28, with the deficit small (\$1,827), consumption won.

Note also what the epoch table shows about the trajectory: from epoch 2 onward the projected terminal is \$52,744 → \$78,181 → \$0 → \$898 against a multi-million-dollar plan. **The controller rides the boundary for the entire run**, which is exactly what §2.1 predicts and precisely the state in which no error budget remains for a bake.

### 2.8 The bake misses in *both* directions

The same 34-epoch run's harvest re-runs from t₀ at **\$11,421,707** terminal liquidity, against the controller's committed **\$898** — four orders of magnitude, in the *conservative* direction, while the user's saved scenario missed in the *aggressive* direction (ruin 2051). Same root causes (the §2.5(c) re-keying, plus the last-anchor extrapolation noted in §9). The honest conclusion is stronger than "harvested plans go broke":

> **For a lever whose per-epoch decision means "for the rest of life," the SCHEDULE bake does not approximate the plan at all.** It is not a lossy reproduction with bounded drift — it is a different plan, and which direction it errs is incidental.

---

*(Unit note, worth a look on its own: `λ·|terminal − target|` deflates the terminal to real base-year USD via `terminalPriceLevel`, while `μ · deficit` uses `cumulativeDeficit` **nominal**. Over a 44-year run at ~3% that is a ~3.7× relative weighting drift between the two penalty terms, growing with horizon length. Not the cause of anything here — μ dominates either way — but the two terms are not in the same units.)*

---

## 3. What this changes about design 39 §13

| §13 claim | Correction |
|---|---|
| §13.7 — drift is bounded and reported as `Δ` / `Δ%` | Only for solvent bakes. Insolvency is a **feasibility** loss: terminal floors at 0 and the deficit penalty saturates, so `Δ` stops being meaningful. Feasibility is a separate, prior axis. |
| §13.6.3 — POINT + a quantified collapse warning is adequate disclosure | The warning quantifies the wrong thing. A **single decisive move at a statutory boundary** is the dangerous shape, and it reads as near-constant. |
| §13.6.6 — RESOLVE inherits "the MPC run's goal (stamped on the records)" | This is the actual bug in the spec. RESOLVE solves an *open-loop* problem with a *closed-loop* objective, so it faithfully reproduces the knife edge. See §4.2. |
| §13.13.3 — VoTV = B − C, VoFB = A − B | Undefined when `B` is infeasible. The readout needs a feasibility gate before a value comparison; "B failed" is a **stronger** result than any VoTV number, and it is what we actually have. |
| §13.13.2 — "more knots only for exogenous, calendar-driven variation" | The access cliff **is** on §13.13.2's own short list (RMD, preservation age, Medicare). So the drawdown levers do want rung 2 — but with **statutory knots**, not one knot per epoch. See §4.3. |

One secondary finding worth recording: `_deficitPenalty` subtracts `snapshot.state.cumulativeDeficit`, so a per-epoch MPC score never sees deficit accrued before its snapshot. That is correct in the live loop (the past is realized) but it means the **`A` term** in the VoTV readout — the committed terminal from the last epoch's record — is windowed, while `B` from a from-t₀ verify run is not. §13.7 compares on `objectivePrimaryMetric` rather than on score, so the published comparison is apples-to-apples; but any future score-level comparison must not mix the two.

---

## 4. The feature

### 4.1 F1 — Feasibility is a gate, not a warning

Today §13.7's verify is **post-hoc and optional** ("offer a one-click check" after apply). Invert it.

- `applyHarvestPlan` gains a **pre-apply feasibility check**: run the candidate plan from t₀ at the run's seed and assert `cumulativeDeficit === 0` and no `OUT_OF_FUNDS` event.
- An infeasible plan is a **blocking red state** in the review panel, naming the ruin date and the first month of shortfall — not a line in the warnings list.
- Override is explicit and labelled (`Apply anyway — this plan runs out in Aug 2054`), because a truncated exploratory harvest (§13 H2) is a legitimate reason to want it.
- Headless twin in `scripts/lab/verify-harvest.mjs`, so it is regression-testable.

This is small and it stops the harvest shipping broken plans regardless of whether anything else here lands.

### 4.2 F2 — Bake-aware re-solve: the harvest optimises a *different problem*

**The conceptual core.** The MPC optimises knowing it will get to re-decide. A baked plan will not. Those are different problems and must not share an objective.

RESOLVE (§13.6.6) should therefore **not** inherit the MPC's objective verbatim. It should solve the same family with solvency made a *first-class* constraint rather than a cliff:

- **(a) Margin floor.** Constrain `min-over-time` net liquidity ≥ `M`, with `M` a harvest control (default: 24 months of the plan's own real spend). Implemented as a new accumulator (`minForwardLiquidity`) plus a barrier term, so it is a gradient the solver can climb rather than a wall it discovers by falling off.
- **(b) Multi-seed feasibility.** Require solvency on `K` design-74 seeds, not one. This is the honest version — §13.7's own caveat is that RESOLVE is optimal "on the path it solves over" — and design 74/75 already make per-seed rollouts cheap enough to try `K ∈ {3,5}`.

Ship **(a)** as the default and **(b)** as an opt-in harvest setting. Both are objective-level changes; neither needs new plant.

**Prediction, stated so it can be scored:** F2 alone fixes most of the observed failure. If the bridge is the binding constraint, a static drawdown order chosen *with the bridge in view* should be feasible even where it is suboptimal, and the controller's edge over it is real but bounded. **If RESOLVE-with-margin cannot find a feasible static point at all, that is the cleanest possible evidence that these levers need F3** — the failure is then informative rather than embarrassing.

### 4.3 F3 — Statutory-knot drawdown schedules (§13.6.5 Phase 3, now with its gate satisfied)

§13.6.5 deferred schedule forms for the drawdown levers pending a VoTV measurement. The field evidence supplies the gate — but the right build is **not** one knot per epoch.

- Knot **locations** are calendar-known and derivable from the scenario: each person's US 59½, AU preservation age, RMD age, Medicare, plus the move year and the house-sale date. That is ~4–6 knots, chosen once, shared by every drawdown lever.
- Knot **values** are path-dependent and are what the harvest fills in.
- New param forms: `drawdownWeightSchedule`, and siblings for sleeve / cross-border / within-tier — `{ age, <values> }`, STEP interpolation, resolved in the same place `DRAWDOWN_WEIGHT_MODE` reads the static weights today.

The knot set being a property of the **scenario** rather than of the lever is itself an argument for design 39 §13.13.4's factored `Schedule` type (reserved as design 79): four more bespoke `*List` types is exactly what that section warns against. Build F3 behind a shared knot-set helper so 79 can absorb it.

### 4.4 F4 — The bridge as a rung-3 rule

§13.13.2 predicts that where variation *responds to state* rather than to the calendar, a **rule with searchable coefficients** beats more knots. The bridge has an obvious rule form:

> `bridgeReserve` — do not draw taxable/brokerage below `N` years of pre-access spending while any person is below their access age; fund the remainder from the next tier.

Two static numbers. Harvests cleanly (it is rung 3, so its params are scalars again). Reacts on **every** path, including seeds F3 was never fitted to. This is the generalizing answer, and it belongs in design 58 as plant.

Build it alongside F3 specifically so the VoTV/VoFB readout can compare **rung 1 (RESOLVE+margin) / rung 2 (statutory knots) / rung 3 (bridgeReserve)** head-to-head on the case that motivated the question. That comparison is the deliverable §13.13.3 asked for, on a real scenario instead of a synthetic one.

### 4.5 F5 — Ruin-aware diagnostics on the decision record

Each record already carries `result`. Add two derived fields per epoch:

- `minForwardLiquidity` — how much margin the controller was actually operating with;
- `projectedRuinDate` — `null` when solvent.

Then the harvest preview can say *"at epoch 14 the controller had 3 months of margin"*, which is the sentence that would have predicted this failure before the bake. Cheap, and it makes §2.2's knife-edge claim visible per-run rather than theoretical.

### 4.6 F6 — Replay as the referee

The replay driver discussed alongside §13.13 (record the full effective param set per epoch; re-inject at each epoch timestamp; one sim run, no solver) produces **A′** — the controller's exact decisions re-run open-loop from t₀.

That is the missing control in this investigation. Comparing:

- **A′ feasible, B infeasible** ⇒ the *bake* broke it (discretization / POINT collapse) — F1–F4 are the fix;
- **A′ infeasible too** ⇒ *feedback* was load-bearing, not the representation — F4 (rung 3) is the only real answer and F3 would be overfitting;
- **A′ ≡ A** on the same seed is a strong invariant test of the replay itself.

Without A′ a user cannot tell whether the harvest broke the plan or the scenario was always marginal. Build the replay first, in P1.

---

## 5. Decisions locked

- **D1 — Feasibility precedes fidelity.** A harvest plan is checked for solvency *before* apply; infeasible blocks with an explicit, labelled override. `Δ%` fidelity targets apply only to feasible plans.
- **D2 — The harvest re-solves a different problem than the controller solved.** Closed-loop objectives may be indifferent to margin because feedback supplies it; an open-loop bake must buy margin explicitly. RESOLVE gets a min-liquidity floor by default, multi-seed feasibility opt-in.
- **D3 — Variance is the wrong collapse statistic.** §13.6.3's warning is augmented with a **boundary-crossing** check: did this lever move within ±1 year of a statutory access age, a move, or a sale? One decisive move there outranks twenty small ones.
- **D4 — Drawdown schedules get statutory knots, not epoch knots.** Knot placement is derived from the scenario's persons and events, shared across the drawdown levers, behind a helper design 79 can absorb.
- **D5 — Rung 3 is evaluated, not assumed away.** `bridgeReserve` is built as plant alongside F3 so the three representations compete on the motivating case.
- **D6 — Replay is instrumentation, not a harvest destination** (carried over from the design 39 discussion): it supplies `A′` and the VoTV/VoFB terms, and does not replace the param bakes, which are what remain legible, editable and searchable.

---

## 6. Open questions

- **Q1 — What is the right default margin `M`?** 24 months of real spend is a guess. It should probably scale with the *remaining* bridge length (years to the earliest access age), not be a flat figure — a 15-year bridge and a 2-year bridge do not want the same buffer. Calibrate against F6's A′.
- **Q2 — Does the margin floor destroy the die-with-zero result?** A binding `M` late in life directly fights λ. Likely resolution: apply the floor only while a bridge exists (any person below access age), releasing it afterwards — but that is an assumption to test, not a decision.
- **Q3 — Should the *cockpit* also get the margin term?** If the controller optimised with margin, the harvest would inherit a safer plan for free and F2 would shrink. Argument against: it makes the controller strictly worse at its own job, and margin is genuinely free to it. Recommend **no** — keep the two objectives distinct, which is D2's whole point.
- **Q6 — Should the `liquid` scope carry a floor by default?** §2.1 shows `DIE_WITH_TARGET_LIQUID` + `target = 0` optimises straight at the ruin boundary, and it is the *recommended* scope when the levers can't reach illiquid assets. Candidates: (i) refuse `target = 0` on the liquid scope and require a positive floor; (ii) reinterpret the liquid target as "≥ target", i.e. one-sided λ below the target and free above; (iii) leave it and let F2's margin term carry it. (ii) is attractive — the two-sided λ is defensible for net *worth* (a bequest target) but hard to justify for terminal *liquidity*, where leftover cash is not a cost in the same way. Needs the user's intent, not just analysis.
- **Q5 — Was the controller's own run solvent? — ANSWERED 2026-07-26: no, and both candidates hold.** (a) and (c) are both confirmed (§2.7). The controller projected `scenarioFailed = true` at five consecutive epochs and committed anyway, because λ saturates at the boundary; and every epoch decided a rest-of-life level that the harvest re-keys into one-year steps. **The primary defect is in design 39's controller and objective, not in the harvest.** Consequences for this document are in §10.
- **Q4 — Multi-seed RESOLVE cost.** `K` seeds × a budgeted solve, on top of an already opt-in harvest step. Needs a measured number before it can be defaulted on.

---

## 7. Testing sketch

- `harvest-feasibility.test.mjs` — a harvest plan whose baked scenario goes `OUT_OF_FUNDS` is **blocked** by `applyHarvestPlan`; the plan reports the ruin date; the explicit override applies it anyway.
- `resolve-margin.test.mjs` — RESOLVE with a min-liquidity floor returns a solvent static point on a scenario where the unconstrained RESOLVE does not; the floor is inert (byte-identical result) when the unconstrained solution already clears it.
- `bridge-reserve.test.mjs` — `bridgeReserve = N` preserves ≥ N years of pre-access spending in taxable across the access age; `N = 0` reproduces today's behaviour exactly.
- `drawdown-schedule.test.mjs` — a statutory-knot `drawdownWeightSchedule` resolves to the pre-access weights before the knot and the post-access weights after; an empty schedule falls back to the static `drawdownWeight::*` (the design 61 glidepath fallback pattern).
- `replay-invariant.test.mjs` — replaying a recorded run's decisions from t₀ at the same seed reproduces the closed-loop trajectory metric-for-metric (the `A′ ≡ A` gate).
- `scripts/lab/votv.mjs` extended: emit **feasibility** per arm before VoTV/VoFB, and print the rung-1/2/3 comparison table.

---

## 8. Step-by-step implementation plan

### Status legend
- [ ] not started · [x] done

**P0 — Attribution** [x] *(2026-07-26 — done, and it overturned the premise)*
- [x] `scripts/lib/scenario-probe.mjs` — load a real exported scenario, apply param overrides, run it, report **solvency first**. (The harvest lab drives a synthetic params bag through the optimizer's isolated registry; this is the other end — the real `ScenarioLoader` path the user actually saves and re-runs.)
- [x] `scripts/lab/attribute-ruin.mjs` — revert one harvested lever group at a time and look for a flip to solvent.
- [x] `scripts/lab/spend-ceiling.mjs` — bisect the largest open-loop-affordable scaling of the harvested bands; reports the **feedback premium**.
- [x] **Result (§2.5):** drawdown levers exonerated; `SPENDING` is the culprit; 20.5% feedback premium; no committed level is affordable at any time-keying. **§2.3/§2.4 refuted for this scenario.**

**P1 — See it (diagnostics + gate)** — reordered by P0: the live question is now whether the *controller's own* run was solvent, so F5/F6 lead and the gate follows.
- [ ] **1a** — `minForwardLiquidity` accumulator + `projectedRuinDate`; stamp both on each decision record (F5). **Now the highest-value item**: it answers §2.5's open question directly, and if the controller's own epochs were already projecting ruin, that is a controller defect the cockpit has been hiding, not a harvest defect.
- [ ] **1b** — Full effective param set per epoch in the record, alongside the `controlParams` delta (keep the delta authoritative — a mid-run manual edit must not be replayed as a controller decision).
- [ ] **1c** — `replayDecisions(records, { runId })` in `src/finance/mpc/`, plus the `A′ ≡ A` invariant test (F6).
- [ ] **1d** — Pre-apply feasibility gate in `applyHarvestPlan` + blocking red state in the review panel + `verify-harvest.mjs` (F1).
- [ ] **1e** — Boundary-crossing statistic in the POINT warning (D3).

**P2 — Fix it cheaply (objective-level, no plant)** — expected to resolve most of the failure.
- [ ] **2a** — Min-liquidity floor / barrier in RESOLVE; `harvestMarginMonths` control (F2a).
- [ ] **2b** — Multi-seed feasibility as an opt-in harvest setting (F2b).
- [ ] **2c** — Re-run the motivating scenario; record whether P2 alone clears the 2050s failure, and if not, whether RESOLVE could find *any* feasible static point.

**P3 — Representations, measured against each other** — gated on P2's answer.
- [ ] **3a** — Scenario-derived statutory knot-set helper (persons' access ages + move + sale).
- [ ] **3b** — `drawdownWeightSchedule` + siblings, STEP-resolved, static-param fallback (F3).
- [ ] **3c** — `bridgeReserve` rung-3 rule in design 58's drawdown plant (F4).
- [ ] **3d** — `votv.mjs` rung-1/2/3 table with a feasibility column, across ≥3 seeds.

**P4 — Feed design 79.** Whatever P3 shows about knot sets belonging to the scenario rather than the lever is direct input to §13.13.4's factored `Schedule` type. Do not write a fifth bespoke `*List` before that conversation.

---

## 10. Where this leaves the design (2026-07-26)

P0 was supposed to confirm a harvest defect. It found a **controller** defect, and the scope of this document has to move with it. Revised priority, highest first:

1. **U1 — Un-saturate the terminal term (§2.7).** The `liquid` scope with `target = 0` gives the objective no gradient in the insolvent region, and μ's calibration explicitly assumes a gradient that isn't there. Options in Q6; a one-sided λ (free above the target, penalised below) is the cheapest correction and is arguably the right semantics for terminal *liquidity* regardless. **This is a design-39/38 objective fix and it is the root cause.**
2. **U2 — Never commit an epoch whose own rollout reports `scenarioFailed`.** The controller has the flag in hand at decision time and ignores it. A hard feasibility filter on the candidate set — reject infeasible candidates before ranking, fall back to the least-deficit candidate only if *all* are infeasible, and surface that state loudly in the cockpit — is a small, local change with no objective re-tune.
3. **U3 — Fix the SPENDING lever's rest-of-life encoding (§2.5c).** Either the lever must decide a *segment* (a band it owns until the next epoch) rather than the open-ended tail, or the harvest must stop re-keying rest-of-life answers as steps. Until one of these changes, `SPENDING` cannot be harvested faithfully at all (§2.8) — and this is design 39 §13.6.1, not design 80.
4. **F5 / F1** (ruin diagnostics on the record; feasibility gate before apply) — still correct, still wanted, and now justified by §2.6 as much as by §2.5: the goal metric cannot distinguish success from ruin, so neither the cockpit card nor `verify-harvest.mjs` can.
5. **F2 (margin-floor RESOLVE)** — demoted. It is a reasonable robustness measure but it treats a symptom; with U1 and U2 in place its value should be re-measured, not assumed.
6. **F3 / F4 (P3 plant work)** — **do not build.** §2.5 exonerated the drawdown levers and §2.8 shows the schedule form is not the binding constraint. Design 39 §13.13.4's `Schedule` type (design 79) is likewise unmotivated by this evidence.

The general theory in §2.1–2.2 survives intact and is in fact sharper than when it was written: an objective that optimises toward a constraint boundary produces plans with no error budget, and feedback is what was silently paying for the margin. What changed is *where the fix belongs*.

---

## 9. Honest limits

- ~~The attribution to the drawdown levers is **inferred**, not yet measured.~~ **Measured 2026-07-26 and refuted** (§2.5). The general theory in §2.1–2.2 survives — an objective indifferent to solvency margin produces knife-edge plans — but it is `SPENDING`, not the drawdown levers, that carries it here. Worth keeping as a caution: the predicted signature (`drawdownWeight::super` drawn first, ahead of preservation age) was *visibly present in the harvested params* and still not load-bearing. A plausible-looking artifact in a harvested scenario is not evidence.
- P3 (statutory-knot drawdown schedules) has therefore **lost its motivating case** and should not be built on this evidence. Worse, §2.5 measures a **negative VoTV** for spending — the schedule is 8 years worse than its own mean held flat — which is a direct hit on rung 2 and points at design 39 §13.13.2's rung-3 prediction (guardrail spending, design 26) instead.
- ~~§2.5's central puzzle is unresolved.~~ **Resolved (§2.7):** it is **not** primarily a harvest defect. λ saturates at the boundary, μ's calibration assumes a gradient that has vanished, and the controller commits plans its own rollout flags as failed. See §10 for the revised priority.
- **The reproduction is not exact.** `epoch-solvency.mjs` reconstructs the pre-run scenario by reverting spending to the preserved pre-MPC bands, but leaves the other harvested params as the starting point, and runs 34 epochs to age 80 against the original's ~42 to age 89 at a different CEM seed/budget. Its committed levels ($7,596–$8,037) are tighter than the saved scenario's ($7,489–$10,000). Every *mechanism* reported here is directly observed; the specific ruin date is not reproduced and should not be quoted as such.
- The `--spend-range` and `--goal` flags are not cosmetic. Both were needed to reproduce the behaviour and neither is the default; a lab result on this scenario without both is measuring a different system.
- Nothing here makes an open-loop plan as good as the controller. It makes it **solvent**, and states what it cost. §13.7's open-loop caveat stands unchanged and still belongs on the panel.
- A margin floor is a robustness heuristic, not a guarantee. Multi-seed feasibility (F2b) is closer to honest; full chance-constrained harvest is design 39 §10 Q5's territory and stays out of scope.
