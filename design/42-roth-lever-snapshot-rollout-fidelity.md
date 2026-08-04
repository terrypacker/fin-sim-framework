# 42 — Roth Lever: snapshot-rollout fidelity (the income-target must move the rollout)

**Status**: Implemented + browser-verified (2026-06-28).

> **Verified.** With the fix, the reported symptom is gone — at the conversion window the three solvers now **agree** on an interior optimum instead of scattering on a flat landscape: GRID `$115,000`, CEM `$106,965`, QP-polish `$114,402` (all ~\$110k, the top of the 12% bracket) for *Maximize After-Tax Net Liquidity* on an 8-yr window. A live objective sweep is **concave** (J rises to a peak at ~\$100k real income-fill, then falls for over-conversion) — was perfectly flat before. The lever also correctly targets the next *actionable* year (2028 window-start) when "now" sits before/at the window. Tests: `roth-retarget.test.mjs` (+5 incl. the snapshot-rollout regression gate), `cockpit-controller.test.mjs` (+3 year-selection). Full suite green (2953 unit, 798 viz).
**Related**: `design/39-mpc-financial-controller.md` (§10 Q4 snapshot-seeded rollout, Step 10 live Roth actuation — this is its missing rollout-side twin), `design/40-after-tax-net-worth.md` / `design/41-windowed-prediction-horizon.md` (the objective + horizon this lets the Roth lever finally exercise), `src/finance/optimization/optimization-problem.js` (`_seededSim`), `src/scenarios/toolsets/us-roth-conversion-toolset.js` (the conversion events), `src/finance/mpc/cockpit-controller.js` (`COCKPIT_CONTROLS.ROTH`).

> **Symptom (reported).** At Dec 31 2027 with ~\$290k in the IRA, an 8-year window on *Maximize After-Tax Net Liquidity*: **CEM and QP-polish advise the maximum conversion, Grid advises none.** A solver disagreement like that is the signature of a **flat objective** — and the Roth income-target lever is indeed **inert** in the cockpit's rollout.

---

## 1. Root cause — the snapshot queue overrides the schedule param

The cockpit seeds every advise rollout from the "now" snapshot. `OptimizationProblem._seededSim` compiles the scenario with the candidate params **and then `_injectSnapshot` overwrites the freshly-compiled event queue with the snapshot's queue** (design 39 §10 Q4 — "carry the heap"). Roth conversions are **scheduled `ROTH_CONVERSION_POLICY_EVALUATE` events**, so the conversions that actually fire come from that **frozen snapshot queue** (here: the legacy window's 2028–2035 events at their bracket ceilings), *not* from the `rothConversionSchedule[year].incomeTarget` variable the solver is tuning. The variable does nothing → the score is flat → solvers scatter (CEM/QP → the max boundary, Grid → the first/lowest = zero). The solvers are correct; there is no gradient to find.

**Evidence (live sweep, Dec 31 2027 snapshot):**

| Rollout mode | Tune the income target | Result |
|---|---|---|
| `kind:'compile'` (from t₀) | 0 → 200k → 400k | rothFinalBalance **347k → 651k**, after-tax liq **1.799M → 1.838M** — a real gradient |
| `kind:'snapshot'` (the cockpit) | any target | rothFinalBalance **788k flat**, after-tax liq **flat** — param ignored |

**The asymmetry with Spending.** The Spending lever works in snapshot rollouts because it is a **reducer** that re-reads params every period, and `_seededSim` already calls `repinExpensesIfChanged` after injection to re-pin it forward. Roth is **event-driven** and has **no equivalent re-target after injection**. Design 39 Step 10 added that queue-mutation only to the *live* `ROTH.actuate` (Apply); the *advise* rollout never got it. (Earlier Roth unit tests passed only because they used `kind:'compile'`, which masked this.)

### Two amplifiers (context, not the bug)

- **Small IRA vs. an aggressive window.** The IRA (~\$290k) is below the window's bracket ceilings (~\$258k+), so even when the queue *is* honored the window fully drains it within ~1–2 years — so per-epoch leverage is modest in this scenario. The fix makes the lever *function*; how much it *moves* is scenario-dependent (a longer window, `MIN_LIFETIME_TAXES`, or `MAX_AFTER_TAX_NET_WORTH` give more signal).
- **`prepareBaseParams` picks the wrong year.** It seeds/tunes `now.getUTCFullYear()` = **2027**, whose conversion date (Dec 1) is already **past** at Dec 31 — so even with the re-target there is no 2027 event to move. The lever must target the **next actionable** conversion year (2028).

---

## 2. The fix

Two coordinated changes plus a shared helper, mirroring the Spending pattern and the live actuate so **advise == apply**.

### 2.1 Re-target hook in the rollout (the core)

A shared `retargetRothConversionEvents(queue, schedule, { inflationRate, nowMs })` in `us-roth-conversion-toolset.js`: for each `{ year, incomeTarget }` schedule entry, rewrite the **future** (`date > nowMs`) queued `ROTH_CONVERSION_POLICY_EVALUATE` events for **that year** to the inflation-compounded nominal target (`incomeTarget · (1+inflationRate)^(year−2025)`, the same path `schedules()` uses). Events for years **not** in the schedule keep their queued (window) target — so the controller overrides only the years it is deciding.

`OptimizationProblem._seededSim` calls it right after `_injectSnapshot` (next to the spending re-pin), only for `kind:'snapshot'`. This makes the income-target variable actually move the snapshot rollout.

### 2.2 Target the next actionable conversion year

`COCKPIT_CONTROLS.ROTH.buildVariables` / `prepareBaseParams` choose the **next year whose conversion date is still in the future** (from `rothConversionMonth`/`Day`), not the calendar year of "now". At Dec 31 2027 that is **2028**.

### 2.3 Refactor the live actuate onto the shared helper

`COCKPIT_CONTROLS.ROTH.actuate` (live Apply) currently hand-mutates the queue; switch it to `retargetRothConversionEvents` so the live re-wire and the advise rollout use **one** implementation (guaranteeing advise == apply).

### Decision — override semantics (revises §39 Step 10 / §40 window→schedule note)

The controller's schedule entries **override the matching queued events; unvisited years keep the window.** There is **no upfront window-wipe** — the snapshot queue already carries the full window, and the receding-horizon loop overrides each year as "now" reaches it. This is the cleanest reading of single-year-per-epoch control (design 39 §9): decide the next year now, let the rest follow the existing plan until you advance to them. A target of `0` for the controlled year is a genuine **"skip this year"** (overrides the window's conversion to none).

---

## 3. Testing

- `roth-retarget.test.mjs` — the helper: rewrites the matching-year future events to the inflation-compounded nominal; leaves other years and already-fired (past) events untouched; `0`/negative target ⇒ event target 0 (skip); empty/missing schedule ⇒ no-op.
- `optimization-problem` (snapshot-rollout regression — the gate this whole doc exists for): a **snapshot-seeded** rollout whose committed `rothConversionSchedule` raises a year's target produces a **higher terminal Roth balance** than target 0 — i.e. the param now moves the snapshot rollout (was flat). Mirrors the existing `kind:'compile'` test.
- `cockpit-controller.test.mjs` — `buildVariables`/`prepareBaseParams` pick the next actionable year when "now" is past this year's conversion date (Dec 31 → next year); `ROTH.actuate` still re-wires via the shared helper (existing test stays green).

---

## 4. Out of scope (follow-ups)

- The **leverage** question (amplifier #1): when the window over-converts a small IRA, per-epoch signal is small. A full multi-year Roth control vector (design 39 §9 "documented enhancement") would let one solve shape the whole schedule; deferred.
- Full **window→schedule materialization** on a Rebuild (design 40 Step 10 note) — orthogonal; this design deliberately does *not* wipe the window, so the trap doesn't fire in the rollout.
