# 80 — Feasibility-preserving harvest: why a baked plan goes broke and the controller doesn't

**Status**: Proposed (2026-07-26). **Superseded in direction by `design/81-run-as-replayable-artifact.md`** — §2.11's finding (whole-run harvesting is the wrong granularity) is what 81 acts on. F1 here remains required; F2 is de-prioritised (§10).
**Related**: `design/39-mpc-financial-controller.md` §13 (the harvest this corrects — §13.3 forms, §13.6.3 POINT, §13.6.6 RESOLVE, §13.7 fidelity, §13.13 the representation question), `design/38-optimization-solver-framework.md` (the solve RESOLVE calls), `design/58-drawdown-levers.md` / `design/65-allocation-aware-drawdown.md` / `design/66-bond-fidelity.md` (the levers with no schedule form), `design/74-stochastic-return-paths.md` (multi-seed feasibility), `design/45` (early-withdrawal mechanics — the access cliff)

> **Reading note**: design 39 §13 specifies *how* to copy a controller run back into a scenario. This design is about a case where doing that correctly still produces a **broken plan** — and argues that the harvest's job is not to reproduce the controller's answer but to **re-solve the controller's problem without feedback**. Those are different problems, and conflating them is the defect.

---

## 0. Start here

*This document is an investigation log as much as a design. It changed direction three times, and most of the mechanisms proposed along the way were disproved by later measurement. **Read §0 and §2.11; treat §2.3–§2.10 as the record of how we got there, not as current claims.***

### The conclusion

A `DIE_WITH_TARGET_LIQUID` (target \$0) cockpit run over the user's real scenario is **solvent at every one of its 44 epochs**, and the harvest of it goes **out-of-funds 2051-04-30 with a \$5.7M deficit**. Verified against the exported decision log (§2.11):

- **A′** (the realized closed-loop path, replayed) ends solvent at \$106,476.
- **B** (the baked scenario, re-run from t₀) ends at \$0, insolvent.
- Swapping one lever group at a time from its per-epoch sequence to its baked form: **every SCHEDULE bake individually causes ruin; the POINT collapse is the only innocent one.**

The bakes are *faithful* — their errors are a ±1-year step shift, an ε-collapse, a glidepath L1 tolerance. **The plan has no room for any of them**, because A′ leaves ~2% terminal margin, which is exactly what a die-with-zero goal on the liquid scope asks for. **The margin was being supplied by feedback**, and baking removes the feedback while keeping the boundary-hugging trajectory.

### What to build

| # | Item | Why | Where |
|---|---|---|---|
| 1 | ~~**F1 — block an infeasible harvest before apply**~~ **DONE** | Required. Nothing checked solvency, and §2.6 shows the goal metric *cannot* substitute: a ruined plan and a perfect spend-down both read \$0. `design/81` also depends on this for promoting a variant. | §4.1 |
| 2 | ~~**U5 — expose solver budget + seed as cockpit controls**~~ **DONE** | Both hardcoded with no UI. Small, self-contained, independent of everything else. | §10.1 |

**Both landed 2026-07-26 — this document's scope is complete.** Everything else is done, refuted, or has moved.

### What NOT to build

| Item | Status |
|---|---|
| **U1** un-saturate the terminal λ | **Refuted** (§2.9) — the objective ranks feasible above infeasible by ~50×. Also: raising the terminal target \$0→\$30k **cannot** help; the λ ruin penalty is capped at `λ · target`. |
| **U3** SPENDING "rest-of-life" encoding | **Refuted** (§2.11) — an artifact of a 2-band reconstruction. The real pre-run table had 21 bands; each epoch decided a genuine segment. |
| **U4** search adequacy | **Demoted** (§2.10) — at the app's real budget (64) the controller stays feasible throughout. The evals/dimension readout survives inside U5. |
| **F2** margin-aware re-solve | **De-prioritised** by `design/81` — not refuted, out-competed. |
| **F3 / F4** drawdown schedule forms, `bridgeReserve` | **Do not build** (§2.11) — the POINT levers are exonerated outright. Design 39 §13.13.4's `Schedule` type (design 79) is unmotivated by this evidence. |

### Already landed

- **F1** feasibility gate — `checkHarvestFeasibility` / `foldHarvestPlan` / `feasibilityOfResult` / `describeFeasibility` in `src/finance/mpc/harvest-feasibility.js`, wired into the cockpit's harvest preview (blocking red banner + a labelled override), with the headless twin in `verify-harvest.mjs`. Tests: `tests/unit/harvest-feasibility.test.mjs` + four gate tests in `tests/viz/mpc-cockpit-plugin.test.mjs`. See §4.1 for what shipped and what deliberately did not.
- **U5** solver budget + seed controls — one Budget and one Seed input feeding all three call sites, with a live evals/dimension readout. §10.1.
- **U2** feasibility-first ranking — `feasibilityFirst` on `OptimizationProblem` (default off ⇒ OPT path byte-identical; default on for the cockpit), `advise()` returns a `feasibility` block, records stamp `extra.feasibility`. Tests in `tests/unit/feasibility-first.test.mjs`. **Byte-identical at budget 64** — insurance, not a fix.
- **F5** ruin diagnostics on the decision record — landed with U2.
- **`replayDecisions`** (`src/finance/mpc/replay.js`) + `tests/unit/mpc-replay.test.mjs`. This is what produced §2.11, and it is the foundation of `design/81`.
- Lab tooling: `scripts/lib/scenario-probe.mjs`, `scripts/lab/{attribute-ruin,spend-ceiling,epoch-solvency,score-decomposition,replay-vs-bake}.mjs`.

### Moved to design 81

**P1-1b** (full effective param set per epoch) is now `design/81` **Phase 1a** — do it there, not here. It is the fix for index-keyed decisions silently re-keying when the band table changes.

### Method note

Four in-code reconstructions of the user's run produced four *different* wrong mechanisms. One export of the real decision log (`fin-sim-decisions` from browser localStorage) settled it in an afternoon. **Ask for the log first.**

---

## 1. The observation

Running the cockpit against a `DIE_WITH_TARGET_LIQUID` ("die with zero", terminal = net liquidity) goal and harvesting the result: **the baked scenario fails early — out-of-funds 2051-04-30 — while the closed-loop run it was baked from is solvent at every epoch.**

*(As first written, this section attributed the failure to bridging from taxable wealth to not-yet-accessible retirement accounts. That was a guess and it is **wrong** — see §2.5 and §2.11. The real mechanism is in §2.11.)*

This is not the drift design 39 §13.7 anticipated. §13.7 promises a **bounded, measurable Δ** on the goal metric, with a fidelity target of ~1% for schedule-form levers. A plan that runs out of money is not 1% off; it is a different kind of object. §13.7's framing quietly assumes the baked plan is *solvent*, and there is nothing in the harvest that enforces that.

---

## 2. Why it happens — the investigation

> **Reading guide.** These subsections are chronological and several are **disproved by later ones**. If you want the answer, read **§2.11**; if you want the durable general theory, read **§2.1–§2.2**. The rest is kept because the refutations are themselves useful (they record which plausible mechanisms are *not* in play, and each was disproved by a measurement worth being able to repeat).
>
> | | | |
> |---|---|---|
> | §2.1–2.2 | the boundary/margin theory | **stands** — sharpened by §2.11 |
> | §2.3–2.4 | drawdown POINT collapse | **refuted** §2.5, §2.11 |
> | §2.5 | SPENDING blamed, feedback premium | superseded by §2.11 |
> | §2.6 | goal metric degenerate at target | **stands** — load-bearing for F1 |
> | §2.7 | controller commits ruin | **refuted** §2.10 (wrong budget) |
> | §2.8 | bake misses both directions | superseded by §2.11 |
> | §2.9 | objective ranks correctly; λ cap | **stands** |
> | §2.10 | budget correction | **stands** |
> | §2.11 | **the answer, on real data** | **current** |

### 2.1 The objective is indifferent to solvency margin

`makeDieWithTarget.evaluate` (`optimization-objectives.js`) is:

```
score = running_reward − λ·|realTerminal − target| − μ·deficit
```

Both correction terms actively refuse to reward a buffer:

- **λ is two-sided.** `Math.abs(realTerminal − target)` penalises *overshoot* exactly as hard as shortfall. Ending with margin is a cost. That is the whole point of "die with zero" and it is correct.
- **μ is a cliff, not a gradient.** The `DEFAULT_DEFICIT_PENALTY` docblock says so explicitly: it "is **zero for any solvent plan** … so it never perturbs the interior spend-early ⇄ leave-less optimum." Deliberate, and right for the closed loop — but it means a plan that clears every month by **\$1** and a plan that clears by **\$500k** score *identically* on the solvency term, and the \$1 plan scores strictly better on λ.

So the optimum this goal selects is, by construction, a **knife-edge plan**: no margin, because margin is penalised and safety is not rewarded.

**With `terminal: 'liquid'` the knife edge *is* the ruin boundary.** The motivating run used `DIE_WITH_TARGET_LIQUID` (`finalNetLiquidity`) with `terminalWealthTarget = 0` — chosen for the reason the code itself recommends (`optimization-objectives.js:260`: *"Prefer the LIQUID terminal when the lever set can't liquidate illiquid assets (house equity, age-locked super), so the 'die with \$X' target is actually reachable by the controls"*). That is the right call for reachability and it has a consequence nobody wrote down:

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

`scenarios/fin-sim-die-with.json` (an all-levers `terminalWealthTarget=0` harvest, sim 2026→2070, Terry b1978 / Jeanne b1983, move 2031) fails at **out-of-funds 2051-04-30, \$5,705,589 cumulative deficit, 194 deficit months — with terminal net worth still \$4,803,802.** The plan is *asset-rich and cash-poor*: \$4.8M is the illiquid residue (the AU house + collectibles) sitting there while every liquid account is drained. Every insolvent arm below lands on that same \$4.8M, which is a useful tell.

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
| **spending bands → pre-MPC flat \$5,500** | **✅ SOLVENT, NW \$13,384,480** |

So the four POINT-collapsed drawdown levers — the entire §2.3/§2.4 hypothesis — move the ruin date by **months**. `drawdownWeight::super = 0.0398` (super drawn *first*, despite preservation age) looked exactly like the predicted signature and is **not** load-bearing. The lever that broke the plan is **`SPENDING`** — which is a **SCHEDULE** lever, harvested *faithfully*, with near-zero discretization loss.

> **The lever that broke the plan is the one the harvest reproduces most faithfully.** Fidelity was never the problem. §13.7's drift #1 (discretization) is ≈0 here; drift #2 (loss of feedback) is total.

**How far over the line** (`scripts/lab/spend-ceiling.mjs` — scale the MPC-decided bands and bisect for solvency):

- harvested: 23 decided bands, ages 47–89, **mean \$8,731/mo** real base-year USD;
- largest open-loop-affordable version: **×0.830 ≈ \$7,244/mo**;
- **feedback premium: 20.5%** — the controller baked a fifth more consumption than the same plan sustains without the right to re-decide.

**And it is not a time-keying artifact.** Replacing the whole schedule with a single flat level fails at *every* recorded level, including the controller's own final answer:

| Flat-for-life level | Result |
|---|---|
| \$9,941/mo (first decided epoch) | ❌ ruin 2049-05-31 |
| \$10,000/mo (max) | ❌ ruin 2048-11-30 |
| \$8,731/mo (mean) | ❌ ruin 2059-06-30 |
| \$8,559/mo (**last** epoch — the controller's final answer) | ❌ ruin 2061-06-30 |
| the harvested schedule (mean \$8,731) | ❌ ruin 2051-04-30 |

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
2. **The cockpit card shows the same number.** The recommended-move card reports the projected terminal; a plan headed for ruin displays "\$0" — i.e. *on target*.

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

### 2.9 The objective is fine. The **search** is not. (measured 2026-07-26)

§2.7 concluded λ saturation had disarmed μ. `scripts/lab/score-decomposition.mjs` tests that directly — drive the real loop to the first failing epoch (24, snapshot 2050-01-01), then sweep the SPENDING variable across its range at that snapshot and decompose every score:

| spend/mo | reward (Δcons) | λ·\|term−tgt\| | μ·deficit | **score** | terminal | deficit | failed |
|---|---|---|---|---|---|---|---|
| \$7,000 | \$1,600,967 | −\$2,384,998 | −\$0 | −\$784,031 | \$875,641 | \$0 | |
| **\$7,500** | \$1,715,322 | −\$462,932 | −\$0 | **+\$1,252,390** | \$169,963 | \$0 | |
| \$8,000 | \$1,829,677 | −\$0 | −\$64,562,599 | −\$62,732,922 | \$0 | \$645,626 | ❌ |
| \$10,000 | \$2,287,096 | −\$0 | −\$361,262,812 | −\$358,975,716 | \$0 | \$3,612,628 | ❌ |

**The objective gets this right, decisively.** The feasible argmax (\$7,500) beats the nearest infeasible option by ~\$64M — a factor of 50. μ is not disarmed; it is dominant. The controller committed \$7,646 anyway, so **no reweighting of the objective would have prevented this**. U1 is refuted and must not be built.

Two corrections to §2.7 follow, and one survives:

- **Survives, in corrected form:** the λ term genuinely cannot carry solvency. Because `computeNetLiquidity` bottoms at 0, `|L − target|` is bounded above by `target` throughout the insolvent region, so **the terminal penalty for ruin is capped at `λ · target`** no matter how catastrophic. This also answers a user observation directly: **raising the target from \$0 to \$30,000 does not help and cannot** — it lifts the cap to `10 × 30,000 = $300k`, which is noise beside μ's \$64M. Raising the target changes the cap linearly and never makes it a gradient. Worth documenting on the param; not worth code.
- **Wrong:** "the objective goes blind below the boundary." μ·deficit is linear in shortfall and provides a strong gradient. The blindness is confined to the λ term.
- **Wrong:** "μ's documented calibration is violated." It holds comfortably here.

**U4 — search adequacy is the real root cause.** The run was CEM at `budget 20` over 8 levers (13+ variables) — roughly two generations of ten samples in a 13-dimensional space, where the feasible spend region at this epoch is about the bottom fifth of the lever's range. The controller committed \$7,646, sitting just past a feasibility boundary that lies between \$7,500 and \$8,000. That is an under-powered search landing marginally outside the feasible set, not a mis-priced trade. Candidate work, in order:

1. **Report search adequacy.** Budget per dimension is knowable before solving; a cockpit run at 1.5 evaluations/dimension should say so.
2. **Feasibility-seeking initialisation.** Seed the first generation from the previous epoch's *feasible* committed point (the warm start already exists) and bisect toward feasibility on the dominant lever before the general search.
3. **Re-measure at an honest budget** before anything else — the reproduction's budget is mine, not the user's, and the user's actual cockpit budget is unknown (§9).

**What U2 buys — and it is more than expected.** The prediction was "no ranking change, just a guarantee plus reporting," since \$7,500 already won by 50×. Measured, the same 30-epoch run **fixes the failure outright**:

| | before U2 | after U2 |
|---|---|---|
| epochs 24–28 | \$7,646, terminal **\$0**, deficit \$1,827, **❌ failed** | \$8,037 / \$7,596, terminal **\$78,181 / \$34,590**, deficit **\$0**, ✅ |
| infeasible epochs | **5 of 30** | **0 of 30** |

The mechanism is **search guidance, not final ranking**. Under the plain score, infeasible candidates are ordered by `reward − λ − μ·deficit`, which mixes consumption into the comparison — so CEM's elite set, in a 13-dimensional space where feasible samples are scarce, fills with "expensively infeasible" points and refits its mean toward them. Under feasibility-first, infeasible candidates are ordered by **least shortfall alone**: a clean gradient pointing at the feasible set. That is precisely U4's proposed mechanism (2), arriving as a side effect of the ranking change, and it means U2 partially addresses the root cause rather than only masking it.

The guarantee and the reporting still stand on their own: solvency is lexicographic and holds at any μ (pinned by `tests/unit/feasibility-first.test.mjs`, including a μ=0 case), and `advise()` now returns a `feasibility` block. **0-of-N feasible candidates is the signal that the lever's range is the binding constraint**, and it was invisible before.

Confirmed on a second seed: seed 7, 30 epochs, **0 infeasible**, terminals \$597,909 → \$10,496 and every projection solvent. The two seeds pick materially different paths (seed 1 settles near \$8,037/\$7,596, seed 7 wanders \$7,438–\$8,625), so the feasibility result is not a single lucky trajectory.

*Verified on one scenario at budget 20, two seeds; §9's caveats about budget and reproduction fidelity apply, and U4's re-measurement at an honest budget is still owed.*

### 2.10 §2.7 was measured at the wrong budget — the controller does NOT commit ruin

**Correction, 2026-07-26.** §2.7's headline finding — five consecutive epochs committing a plan their own rollout flagged `scenarioFailed` — was produced at `budget 20`. That is **not what the app runs**. `mpc-cockpit-plugin.js` hardcodes `budget: 64, seed: 1` for both manual Advise (`:573`) and Auto (`:708`); the 48 at `:907` is the harvest RESOLVE, a separate path.

Re-run at the real budget, pre-U2 ranking, same 30 epochs, same scenario, same seed:

| | budget 20 (my probe) | **budget 64 (what the app runs)** |
|---|---|---|
| infeasible epochs | 5 of 30 | **0 of 30** |
| committed spend | \$7,646–\$8,037 | \$7,441–\$7,930, settling \$7,646 |
| projected terminal | \$0 at the failing epochs | \$6,826–\$300,869, all solvent |

**So candidate (a) does not occur in the real configuration, and §2.7's mechanism is withdrawn.** The controller rides the boundary — a terminal of \$6,826 on a multi-million-dollar plan is as close to zero as it gets — but it stays solvent at every epoch. What follows:

- **U1 stays refuted** (§2.9's decomposition is budget-independent: the objective ranks feasible above infeasible by ~50×).
- **U2 is insurance, not the fix.** It is a correct structural guarantee with tests and no blast radius on the OPT path, and it matters if U5 ever lets a user *lower* the budget — but it does not explain or repair the user's insolvent scenario. The "U2 removed 5 failing epochs" result in §2.9 is real only at budget 20, i.e. against a defect that the shipped app does not have. §2.9's table is retained with that scope.
- **U4 drops sharply in priority.** At budget 64 the search is adequate to stay feasible throughout. ~4.9 evals/dimension is still thin and the U5 readout is still worth having, but search is not the root cause.
- **What survives is the harvest**, which is where this document started. The controller produces a solvent, boundary-hugging plan; the harvest turns it into a different and more aggressive one; nothing checks the result. **F1 (feasibility gate before apply) and U3 (the rest-of-life encoding) are the live work.**

**Reproduction fidelity — still not matched, and this bounds every claim above.** At budget 64 my run commits \$7,441–\$7,646, while the user's saved scenario carries bands from \$7,489 to \$10,000 (mean \$8,731), several pinned at the range maximum. Values sitting at the max indicate epochs where the controller wanted *more* than the range allowed, which my reconstruction never reaches. Remaining differences: my `baseParams` start from the harvested cfg with the non-spending levers already at harvested values rather than their pre-run state; 30 epochs to age 76 versus ~42 to age 89; and the user may have driven manual Advise rather than Auto. **The mechanisms below are directly observed; the user's specific run is not reproduced.**

#### What is measured, and therefore safe to build on

1. The saved scenario is insolvent — out-of-funds 2051-04-30, \$5,705,589 deficit, terminal net worth \$4,803,802 (the illiquid residue).
2. `SPENDING` is the responsible lever; the four drawdown levers move the ruin date by months (§2.5).
3. The open-loop ceiling is ≈\$7,244/mo mean against a baked \$8,731 — a **20.5% feedback premium** (§2.5).
4. **Every epoch targets band index 1**, so every decision is a *rest-of-life* level that the harvest re-keys into one-year steps (§2.5c). Observed in every run at every budget and seed. **This is the most robust finding in this document.**
5. `finalNetLiquidity` is degenerate at `target = 0`: a bankrupt plan and a perfect spend-down both read \$0, so neither the cockpit card nor `verify-harvest.mjs` can tell them apart (§2.6).
6. The λ penalty for ruin is capped at `λ · target`, so raising the target \$0→\$30k cannot help (§2.9).
7. At the app's real budget the controller stays solvent at every epoch (this section).

---

### 2.11 Ground truth — the real decision log settles it (2026-07-26)

The user exported the browser's `fin-sim-decisions` store: **44 epochs, one run, 9 levers, `DIE_WITH_TARGET_LIQUID`, sim 2026→2070.** The saved scenario was verified to be *exactly* the harvest of these records — the 23 MPC-decided spending bands match the derived harvest age-for-age and dollar-for-dollar. Both ends of the pipeline are now ground truth, and the reconstructions in §2.5–§2.10 can be retired in favour of it.

**Every prior mechanism is refuted:**

| Claim | Verdict against the real log |
|---|---|
| §2.7(a) controller commits ruin | **Refuted** — all 44 epochs record `cumulativeDeficit: 0`, `scenarioFailed: false` |
| §2.5(c) / U3 rest-of-life encoding | **Refuted** — `_bandIndex` increments 2,3,3,4,5,5,5,6,7,8… The user's pre-run table already had **21 bands** (ages 0,45,47,48,50,51,54,55,56,58–68,76 — itself an earlier harvest), so each epoch decided a genuine *segment*. The rest-of-life behaviour was an artifact of my 2-band reconstruction. |
| §2.3/§2.4 the POINT collapse breaks it | **Refuted** — see the isolation below |
| §2.5 SPENDING's bake is unfaithful | **Refuted** — it reproduces every epoch exactly |

**The three terms** (`scripts/lab/replay-vs-bake.mjs`, using the new `replayDecisions`):

| Term | Terminal net liquidity | Solvency |
|---|---|---|
| **A** last epoch projected | \$16,249 | ✅ solvent |
| **A′** realized closed-loop (replay) | **\$106,476** | ✅ **solvent** |
| **B** baked scenario from t₀ | \$0 | ❌ **ruin 2051-04-30, \$5,705,589** |

A and A′ agree to the same order of magnitude, so the controller's projections do describe the path its decisions produce. **The run is solvent; the harvest of it is not.**

**Which bake?** Start from the solvent replay and swap one lever group from its per-epoch sequence to its baked form:

| Swap | Result |
|---|---|
| full replay (A′) | ✅ solvent, \$106,476 |
| bake **SPENDING** | ❌ **ruin, \$3,966,450** |
| bake **ALLOCATION_MIX** | ❌ **ruin, \$1,696,078** |
| bake **ROTH** | ❌ **ruin, \$2,305,959** |
| bake **EARLY_WITHDRAWAL** | ❌ **ruin, \$1,561,963** |
| bake the 5 POINT levers | ✅ solvent, \$3,529,481 |

**Every SCHEDULE bake individually causes multi-million-dollar ruin. The POINT collapse — the one this document was written to indict — is the only bake that doesn't.**

#### Why: there is no achievable fidelity that saves this plan

The four schedule bakes are *faithful* in the sense §13.6 intends. Their residual errors are small: a ±1-year step shift from keying on age-at-`asOfDate`, an ε-collapse of consecutive equal amounts, a glidepath L1 collapse at 0.02, `absence == skip-year` in the two schedules. None of that is a defect. **The plan simply has no room for any of it.**

A′ ends with **\$106,476** of terminal liquidity on a multi-million-dollar plan — about 2% of scale, which is precisely what `DIE_WITH_TARGET_LIQUID` with `target = 0` *asks for*. At that margin a 1% approximation error is a 50% terminal error and a 3% error is insolvency. §13.7's "schedule-form levers within ~1% of the committed terminal" is not merely unmet here; **it is unmeetable**, because the denominator has been optimised to zero.

This is §2.1–§2.2's thesis, now demonstrated end-to-end on real data rather than argued:

> **The margin was being supplied by feedback.** The controller re-measured every year and steered along the boundary. Baking removes the steering while keeping the boundary-hugging trajectory, and then *any* approximation — in *any* lever, schedule or point — tips it over. The direction of the error is incidental; that there is an error at all is sufficient.

**Therefore the fix is not better bakes.** Improving fidelity attacks a term that is already small. The fix is **F2** — the harvest must re-solve with an explicit solvency margin, because an open-loop plan needs a buffer the closed-loop one provably did not. F2 was demoted in §2.10 as "treating a symptom"; that was wrong. It is the only item on the list that addresses the actual mechanism. **F1** (block an infeasible harvest before apply) remains the necessary companion, and §2.6 explains why it cannot be expressed as a fidelity percentage.

---

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

**IMPLEMENTED 2026-07-26.** What shipped, and the two places it differs from the sketch below:

- `src/finance/mpc/harvest-feasibility.js` — `checkHarvestFeasibility({ plan, baseParams, simStart, simEnd, cfgTemplate })` folds the plan onto a copy of the params and runs it from t₀ through the same `OptimizationProblem` compile path the cockpit rolls out on. Solvency comes from `infeasibilityOf` (U2), not a second solvency test.
- `foldHarvestPlan` folds **every** entry plus the enabling params — the sibling `foldScheduleBakes` deliberately folds only SCHEDULE entries because RESOLVE must not pin the POINT ones first. A unit test asserts `foldHarvestPlan(base, plan)` is byte-equal to what `applyHarvestPlan` writes, so the checked bag cannot drift from the written one. `withIncluded` was exported from `harvest-apply.js` to make that one implementation rather than two.
- **Three states, not two.** `feasible: null` ("could not verify") is distinct from `false`. A check that throws must not become a silent veto on the user's own plan, so it enables the copy and says so on the panel.
- **`result.outOfFundsDate` did not exist.** `cockpit-controller.js:1303` and `:1374` already read it into `advice.feasibility` and `extra.feasibility`; `_readResult` never emitted it, so both were dead and stamped `null`. Added to `_readResult` — the deficit fields say how badly a plan failed, and only this says *when*, which is the one fact the panel can put in front of a user.
- **Panel** — the verdict renders above the diff (`.mpc-hv-feas`), an infeasible plan disables **Copy to scenario**, and the override checkbox appears only when blocked, labelled *"Copy anyway — this plan runs out in Apr 2051"*. `_applyHarvest` re-checks rather than trusting the disabled attribute.
- **Verified against the motivating pair**: harvesting `scenarios/fin-sim-decisions.json` (44 epochs, 9 levers) onto `scenarios/fin-sim-die-with.json` is **blocked**, reporting **2051-04-30 · \$5,705,589 · 194 months** — §2.11's ground truth to the dollar. Those files are gitignored, so that check is not a committed test; the committed tests stub the rollout through a `makeProblem` DI seam and the fixture check is reproducible from the scratch script in the session log.

*Original sketch follows.* Today §13.7's verify is **post-hoc and optional** ("offer a one-click check" after apply). Invert it.

- `applyHarvestPlan` gains a **pre-apply feasibility check**: run the candidate plan from t₀ at the run's seed and assert `cumulativeDeficit === 0` and no `OUT_OF_FUNDS` event.
- An infeasible plan is a **blocking red state** in the review panel, naming the ruin date and the first month of shortfall — not a line in the warnings list.
- Override is explicit and labelled (`Apply anyway — this plan runs out in Aug 2054`), because a truncated exploratory harvest (§13 H2) is a legitimate reason to want it.
- Headless twin in `scripts/lab/verify-harvest.mjs`, so it is regression-testable.

This is small and it stops the harvest shipping broken plans regardless of whether anything else here lands.

**Implementation notes (added 2026-07-26 — enough to start cold):**

- **Reuse `isFeasibleResult` / `infeasibilityOf`** from `optimization-objectives.js`; they landed with U2 and already handle the `scenarioFailed`-without-accrued-deficit case and snapshot windowing. Do not re-derive a solvency test.
- **Where the check runs.** `applyHarvestPlan(scenario, plan, { schema })` is pure param-writing today and must stay so. Put the check *above* it — a `checkHarvestFeasibility(scenario, plan, { simStart, simEnd, cfgTemplate })` that folds the plan onto a copy of the params, runs from t₀, and returns `{ feasible, outOfFundsDate, cumulativeDeficit, deficitMonths }`. The preview panel calls it before enabling **Copy to scenario**; `applyHarvestPlan` stays a dumb writer.
- **Never express this as a Δ%.** §2.6: `finalNetLiquidity` reaches zero at the same moment `OUT_OF_FUNDS` fires, so a ruined plan and a perfect spend-down both terminate at \$0 and the drift reads ≈0. `verify-harvest.mjs` additionally guards its verdict on `a !== 0` and so prints **nothing** at a=0 — fix that too, and make the headless verdict report feasibility as its own line above the drift.
- **Partial harvests must be checkable.** Design 81 promotes single values and single levers, so the check takes a *plan*, not a whole run — a plan with one entry is a valid input. That is also what makes it reusable as design 81's Phase-5 promotion gate.
- **Cost.** One extra full-horizon run per preview (a few seconds on this scenario at `telemetry:'off'`). Run it when the preview opens, not on every checkbox toggle, and debounce if the pick-list lands.
- **Test** with `scenarios/fin-sim-die-with.json` + `scenarios/fin-sim-decisions.json`: harvesting that log must be **blocked**, naming 2051-04-30. That pair is a permanent regression fixture for this gate.

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

> **Caveat.** D1–D5 are sound and unchanged. **D6 (RESOLVE for scalar levers) is de-prioritised** with F2, and **D7 (Phase 3 gated on VoTV)** is answered in the negative by §2.11 — the drawdown levers are exonerated, so there is no VoTV case to measure for them.

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

- `harvest-feasibility.test.mjs` — **DONE.** A harvest plan whose baked scenario goes `OUT_OF_FUNDS` is **blocked** before the writer runs; the plan reports the ruin date; the explicit override applies it anyway (the block/override half lives in `tests/viz/mpc-cockpit-plugin.test.mjs`, where the panel is). Also pins the fold against `applyHarvestPlan`'s output and the "unverifiable ≠ infeasible" third state.
- `resolve-margin.test.mjs` — RESOLVE with a min-liquidity floor returns a solvent static point on a scenario where the unconstrained RESOLVE does not; the floor is inert (byte-identical result) when the unconstrained solution already clears it.
- `bridge-reserve.test.mjs` — `bridgeReserve = N` preserves ≥ N years of pre-access spending in taxable across the access age; `N = 0` reproduces today's behaviour exactly.
- `drawdown-schedule.test.mjs` — a statutory-knot `drawdownWeightSchedule` resolves to the pre-access weights before the knot and the post-access weights after; an empty schedule falls back to the static `drawdownWeight::*` (the design 61 glidepath fallback pattern).
- `replay-invariant.test.mjs` — replaying a recorded run's decisions from t₀ at the same seed reproduces the closed-loop trajectory metric-for-metric (the `A′ ≡ A` gate).
- `scripts/lab/votv.mjs` extended: emit **feasibility** per arm before VoTV/VoFB, and print the rung-1/2/3 comparison table.

---

## 8. Step-by-step implementation plan

> **Historical.** This plan was written against the original premise and reorganised twice as measurements came in. **§10 is the current ledger** and §0 is the summary. Kept for the P0 record — the attribution tooling in P0 is real and reusable.

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
- [x] **1d** — Pre-apply feasibility gate + blocking red state in the review panel + `verify-harvest.mjs` (F1). *Landed 2026-07-26 — as a check ABOVE `applyHarvestPlan`, not inside it: the writer stays pure and synchronous (§4.1).*
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

## 9. Honest limits

- ~~The attribution to the drawdown levers is **inferred**, not yet measured.~~ **Measured 2026-07-26 and refuted** (§2.5). The general theory in §2.1–2.2 survives — an objective indifferent to solvency margin produces knife-edge plans — but it is `SPENDING`, not the drawdown levers, that carries it here. Worth keeping as a caution: the predicted signature (`drawdownWeight::super` drawn first, ahead of preservation age) was *visibly present in the harvested params* and still not load-bearing. A plausible-looking artifact in a harvested scenario is not evidence.
- P3 (statutory-knot drawdown schedules) has therefore **lost its motivating case** and should not be built on this evidence. Worse, §2.5 measures a **negative VoTV** for spending — the schedule is 8 years worse than its own mean held flat — which is a direct hit on rung 2 and points at design 39 §13.13.2's rung-3 prediction (guardrail spending, design 26) instead.
- ~~§2.5's central puzzle is unresolved.~~ **Resolved (§2.7):** it is **not** primarily a harvest defect. λ saturates at the boundary, μ's calibration assumes a gradient that has vanished, and the controller commits plans its own rollout flags as failed. See §10 for the revised priority.
- **The reproduction is not exact.** `epoch-solvency.mjs` reconstructs the pre-run scenario by reverting spending to the preserved pre-MPC bands, but leaves the other harvested params as the starting point, and runs 34 epochs to age 80 against the original's ~42 to age 89 at a different CEM seed/budget. Its committed levels (\$7,596–\$8,037) are tighter than the saved scenario's (\$7,489–\$10,000). Every *mechanism* reported here is directly observed; the specific ruin date is not reproduced and should not be quoted as such.
- The `--spend-range` and `--goal` flags are not cosmetic. Both were needed to reproduce the behaviour and neither is the default; a lab result on this scenario without both is measuring a different system.
- Nothing here makes an open-loop plan as good as the controller. It makes it **solvent**, and states what it cost. §13.7's open-loop caveat stands unchanged and still belongs on the panel.
- A margin floor is a robustness heuristic, not a guarantee. Multi-seed feasibility (F2b) is closer to honest; full chance-constrained harvest is design 39 §10 Q5's territory and stays out of scope.

---

## 10. Current state

*§0 is the summary. This is the full ledger, including why each item landed where it did.*

| Item | State | Rationale |
|---|---|---|
| **F1** block an infeasible harvest before apply | **DONE** (2026-07-26) | Verified to block the motivating harvest at 2051-04-30 / \$5,705,589 / 194 months. `design/81` inherits it as its Phase-5 promotion gate — the check takes a *plan*, and a one-entry plan is a valid input. §4.1 |
| **U5** budget + seed cockpit controls | **DONE** (2026-07-26) | One Budget + one Seed feeding Advise, Auto and the harvest RESOLVE, with the evals/dimension readout U4 item 1 asked for. §10.1 |
| **U2** feasibility-first ranking | **DONE** | Correct, tested, byte-identical at budget 64. Insurance, not a fix — matters once U5 lets a user lower the budget. |
| **F5** ruin diagnostics on the record | **DONE** | Landed with U2 as `extra.feasibility`. |
| **P1-1b** per-epoch effective params | **MOVED** → `design/81` Phase 1a | Prerequisite there; index-keyed decisions re-key silently without it. |
| **U4** search adequacy | **DEMOTED** | §2.10 — at budget 64 the search stays feasible. Readout survives in U5; feasibility-seeking init unjustified. |
| **F2** margin-aware re-solve | **DE-PRIORITISED** | Out-competed by `design/81`, not refuted. §2.11's analysis is why 81 exists. |
| **U1** un-saturate terminal λ | **REFUTED** | §2.9 — objective ranks feasible above infeasible ~50×. |
| **U3** SPENDING rest-of-life encoding | **REFUTED** | §2.11 — artifact of a 2-band reconstruction; the real table had 21 bands. |
| **F3 / F4** drawdown schedules, `bridgeReserve` | **DO NOT BUILD** | §2.11 exonerates the POINT levers outright. |
| **P1-1e** boundary-crossing POINT warning | **DROPPED** | Was motivated by §2.4's POINT indictment, which §2.11 refuted. A better collapse warning is still defensible, but nothing here argues for it. |

**The general theory (§2.1–§2.2) survives intact and is sharper than when written:** an objective that optimises toward a constraint boundary produces plans with no error budget, and feedback is what was silently paying for the margin. What moved three times was *where the fix belongs* — from the harvest, to the controller, and back to the objective's zero margin. `design/81` acts on the corollary: if the plan has no margin, stop committing all of it at once.

### 10.1 U5 detail — budget and seed

**IMPLEMENTED 2026-07-26.** One `Budget` and one `Seed` input in the toolbar, read by a single `_solverOptions()` accessor that feeds all three call sites — so the harvest RESOLVE now searches at the same budget as the run it is harvesting instead of a quieter 48 nobody could see. Defaults stay 64/1 (what the app has been running, and the budget §2.10 measured the controller feasible at). Beside them, a live **evals/dimension** readout — `64 evals · 4.9/dim (13 vars)` — computed from the selected levers' `buildVariables` *before* the first Advise, and flagged warm below 10/dim. Junk input falls back to the defaults rather than handing the solver a `NaN` budget.

*Original analysis follows.* `mpc-cockpit-plugin.js` hardcodes `budget: 64, seed: 1` at `:573` (manual Advise) and `:708` (Auto), and `budget: 48, seed: 1` at `:907` (the harvest RESOLVE). Nothing surfaces either. Two consequences the user cannot currently act on:

- **Budget is fixed while the search space is not.** A one-lever run is 1 variable; §2.9's 8-lever run is 13+. A fixed 64 is ~64 evals/dimension in the first case and ~4.9 in the second — a thorough search and a sparse one wearing the same number, with no way to notice or compensate. Pair the control with a live **evals/dimension** readout so sparsity is visible *before* the run rather than inferred from a bad answer after it. This is U4's item 1, and the control is what makes it actionable.
- **`seed: 1` everywhere means every Auto run explores the identical trajectory.** Reproducibility is the right default, but with no way to vary it, solver variance is invisible: a plan that only works on seed 1 looks exactly like a robust one. A seed control is also the cheapest form of the out-of-sample check design 39 §13.7 asks for.

Small, self-contained UI work, independent of U2/U3/U4 and worth doing regardless of how they land. Plumb one budget and one seed through all three call sites rather than adding a per-path control.

The general theory in §2.1–2.2 survives intact and is sharper than when written: an objective that optimises toward a constraint boundary produces plans with no error budget, and feedback is what was silently paying for the margin.

**Where the fix belongs moved three times and landed on §2.1.** P0 moved it from the harvest to the controller; §2.10 moved it back when the controller finding proved to be an artifact of a budget the app does not use; §2.11, on the real decision log, put it on the *objective's zero margin* rather than on any bake. Everything invented along the way — U1, U3, U4 — is withdrawn, and U2 survives only as insurance. **The live work is F2 (margin-aware re-solve) and F1 (block an infeasible harvest), both in the original draft.**

The detour paid for itself in findings that outlast it: §2.6 (the goal metric cannot distinguish success from ruin, so the shipped verify cannot catch this class of failure), the λ cap that explains why raising the terminal target does nothing, the exoneration of the drawdown levers, and `replayDecisions` — without which none of §2.11 was measurable. But the lesson is the cheaper one: **four reconstructions produced four wrong mechanisms, and one export of the real decision log settled it in an afternoon.** Get the log first.

---
