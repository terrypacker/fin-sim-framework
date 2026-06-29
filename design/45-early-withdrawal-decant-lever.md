# 45 — Early-Withdrawal "Decant" Lever (proactive pre-move US retirement drawdown, + multi-lever MPC)

**Status**: Implemented (2026-06-29). §9 resolved (see **§9 Resolutions**); **Phases 1–4 landed** including the interactive cockpit multi-select UI (see the ✅ markers in §10). Remaining follow-ups: the §12 multi-lever outcome test and solver widening (`design/46 §2a`). §8 was re-scoped down — the joint-search solver already exists (CEM), so Phase 4 was cockpit plumbing (`control`→`controls[]`), not a framework rewrite.
**Related**: `design/39-mpc-financial-controller.md` (the MPC controller + cockpit levers this extends), `design/40-after-tax-net-worth.md` (the metric that scores the payoff), `design/42-roth-lever-snapshot-rollout-fidelity.md` (per-epoch lever fidelity), `design/43-basis-accounting-integrity.md` (brokerage basis on the cash that lands), `design/44-cross-border-drawdown-actions.md` (the withdrawal-tax actions this reuses), `design/36` (AU CGT cost-base step-up). Code: `src/finance/mpc/cockpit-controller.js` (`COCKPIT_CONTROLS`), `src/finance/mpc/mpc-controller.js`, `src/finance/mpc/apply-forward.js`, `src/finance/services/account-service.js` (`replenishSavings` Phase 2, `reduceLedgerForWithdrawal`, `recordResidencyChange`), `src/finance/account-rules/us/us-early-withdrawal-rules.js`, `src/finance/account-rules/us/roth-conversion-classes.js` (the scheduled-lever pattern to mirror).

> **Goal.** Let the planner (and ultimately the MPC optimizer) deliberately withdraw from US tax-deferred / Roth accounts **early, at penalty, while US-resident in a controllable bracket**, to **decant** those dollars into taxable brokerage **before a move to Australia** — where AU does not honor the US tax-advantaged status. Today early withdrawal exists only as an involuntary last-resort inside `replenishSavings` Phase 2; it cannot be *scheduled*, *journaled as a plan*, or *optimized*. This note designs (A) a proactive per-class early-withdrawal lever, (B) a drawdown-ordering variant, and — the gating piece — (C) the **multi-lever MPC mechanics** needed to search them jointly with the existing Spending and Roth-conversion levers.
>
> **Scope: US accounts only.** AU super has no legal early-access pathway worth modeling and stays locked (design 44 / preservation age). Nothing here touches super.

---

## 1. The decant thesis (why pay a penalty on purpose)

An early withdrawal is a **guaranteed loss** (income tax now + 10% penalty), so it only wins when the loss buys something the objective values more. For pure income-bracket smoothing it **never** wins — a Roth *conversion* fills the same low brackets with **no penalty and the money stays tax-advantaged**, so conversion strictly dominates. The early-withdrawal lever is therefore **not a tax-smoothing lever**; it is a **liquidity / cross-border-timing lever**. Its payoff comes from exactly one situation in this codebase's world:

**Decant before the AU move.** AU does not recognize the tax-free/tax-deferred character of US Roth/IRA/401k. Leaving the money in the wrapper exposes it to AU taxation post-move. Moving it into **taxable brokerage while still US-resident** converts a future AU problem into a present, controllable US event.

## 2. The step-up amplification (the headline rationale — must be in scope)

Decanting into **brokerage** compounds with the AU residency cost-base step-up, and this is the real reason the lever can beat its own penalty:

1. Cash landing in brokerage establishes **fresh cost basis at market value** (the deposited cash carries basis = market value — design 43 / holdings `transaction`).
2. On the AU move, `AccountService.recordResidencyChange` performs a **CGT cost-base step-up** for BROKERAGE (design 36 §12.2 — non-TAP assets reset to market at residency change), so **AU forgives all pre-move appreciation**.

Net: **decant → land in brokerage → step-up at the move ⇒ pre-move gains are wiped for AU, and only post-move AU cap gains apply** — versus leaving it in a wrapper AU taxes unfavorably. The design-40 after-tax metric and the step-up logic already model both sides, so the objective *will* see the trade. Consequence for the lever: its value is **coupled to the timing of a scheduled move** — it should fire in the years approaching a residency change, not in a vacuum (see §12 test plan).

## 3. Current state vs. what's missing

| | Today | Needed |
|---|---|---|
| Early withdrawal exists? | Yes — `replenishSavings` Phase 2, ROTH/IRA/401k, 10% penalty (`us-early-withdrawal-rules.js`) | — |
| Triggered how? | **Involuntary**: only when penalty-free sources can't cover a deficit | **Proactive**: a scheduled, intentional amount |
| Destination of cash | Target **savings** (to cover the deficit) | **Brokerage (default)** or savings — *never another retirement account* |
| Journaled as a plan? | No — buried in a fallback | Yes — a scheduled action, visible & optimizable |
| Optimizer can choose it? | No | Yes — a cockpit lever in the joint search |

## 4. Decisions already settled (from design discussion)

1. **Destination:** Savings or **Brokerage, default Brokerage; never another retirement account.**
2. **Per-class control, Roth earnings in scope.** Two classes:
   - `TAX_DEFERRED` (IRA + 401k) → ordinary income + 10% penalty.
   - `ROTH` → **contributions first (penalty-free)**, then **earnings (penalty)** — one per-class amount applied in that order (matches `reduceLedgerForWithdrawal`'s Roth ordering).
3. **Build both (A) and (B)** — first deliberate multi-lever MPC step.
4. **Conversion + withdrawal co-occur** (e.g. convert IRA→Roth *and* pull seasoned Roth contributions/earnings out in the same year, pre-move). The levers must **compose on shared balances**, not be mutually exclusive.

---

## 5. (A) The proactive per-class lever — spec (mirror `COCKPIT_CONTROLS.ROTH`)

A new `COCKPIT_CONTROLS.EARLY_WITHDRAWAL` (or two specs, `EARLY_TAX_DEFERRED` + `EARLY_ROTH`), built like the Roth-conversion control:

- **Control variable / units:** next-actionable-year early-withdrawal **target dollars per class**, real base-year USD (parallel to the Roth ceiling). Receding-horizon: re-decided each epoch as "now" advances.
- **`defaultRange`:** `{ min: 0, max: <class drawable balance>, step }`; `0 = OFF` for the year. Cap to what the class can actually give (drawable balance, age/penalty aware).
- **`appliesTo`:** active only when the owner is **below** the age gate (59.5/60) — above it withdrawals are penalty-free and normal drawdown handles them — **and** has a positive class balance. (Optionally also gate on "a residency change is scheduled within N years," per §2.)
- **`prepareBaseParams`:** append a `{ year, taxDeferredAmount, rothAmount, destination }` entry to an `earlyWithdrawalSchedule` param for the next actionable year (mirrors the Roth schedule append; `set()` never creates nodes).
- **`buildVariables`:** one INTEGER variable per active class for the next actionable year, capped to class drawable balance.
- **`describe`:** "Withdraw \$X early from tax-deferred (≈\$P penalty) → brokerage."
- **`liveActuatable` / `actuate`:** forward-effective re-wire of the schedule param + live reducer (same pattern as the Roth control's three-step actuate: re-wire reducer, re-pin live state if it hits the current year, persist to scenario param).

## 6. The actuation mechanism — a scheduled early-withdrawal action (new)

The lever needs a **planned** withdrawal path distinct from the Phase-2 fallback — mirror the Roth-conversion scheduled machinery (`roth-conversion-classes.js`):

- **Param:** `earlyWithdrawalSchedule: [{ year, taxDeferredAmount, rothAmount, destinationKey }]`.
- **Handler:** an annual `EarlyWithdrawalPolicyHandler` that, on the scheduled date, emits a `SCHEDULED_EARLY_WITHDRAWAL` action per class.
- **Reducer:** `ScheduledEarlyWithdrawalApplyReducer` that, per class:
  - draws the amount (capped to drawable balance), updating the ledger via `reduceLedgerForWithdrawal` (design 43);
  - applies the 10% penalty and emits the existing tax actions (`IRA_/K401_/ROTH_WITHDRAWAL_*` + penalty — design 44 Gap B already defined these shapes);
  - routes **net** cash to `destinationKey` (brokerage default), where it lands at cost basis = market (design 43);
  - emits a journal-visible record so the plan is auditable.
- **Reuse, don't fork:** the per-type draw/penalty/tax-action logic already lives in `replenishSavings` Phase 2 and `_drawPenaltyFree`. Factor the per-class "withdraw + penalize + tax-action + ledger" core into a shared helper both the fallback and the scheduled reducer call, so they can't diverge.

## 7. (B) The drawdown-ordering permission variant

Separate from the scheduled amount: a **strategy switch** that lets the *involuntary* Phase-2 fallback tap early withdrawal **earlier in the drawdown order** (e.g. before selling taxable brokerage and realizing gains) rather than strictly last. This captures the "pay the penalty instead of realizing cap gains / draining the buffer" liquidity decision without a scheduled amount. Model as a drawdown-strategy option, not an optimizable scalar.

**A↔B precedence:** treat (A)'s scheduled amount as a planned **floor** (the deliberate decant) and (B) as governing the *order* the fallback uses once a real deficit appears — so the two never double-draw. Define the precedence explicitly before coding.

---

## 8. (C) Multi-lever MPC mechanics — ⚠️ THE GATING PIECE

**(A) and (B) are inert without it** — but it is **smaller than first feared**. The original draft assumed multi-lever search "forces the move off per-control grids onto the smarter optimizer." That's largely already done: `CockpitController.advise()` defaults to the **CEM solver** (`createSolver('CEM')`) over a generic `OptimizationProblem.variables` vector, and CEM samples the *joint* space natively — its cost is `samples × generations` rollouts and is largely **independent of dimension** (scale the population modestly with dims, not combinatorially). So the solver that handles an N-dimensional joint vector **already exists and is the default**. What's actually missing is **cockpit plumbing**: `CockpitController.control` is singular. Today the cockpit is effectively **single-lever**: the UI selects one `COCKPIT_CONTROLS` spec and the controller searches that spec's variables. "A + B composing with the existing Spending and Roth-conversion levers" requires the MPC layer to:

1. **Activate a *set* of levers**, not one — a selection model in the cockpit/controller for "these N controls are live this run."
2. **Union their decision variables** into a single decision vector (each spec's `buildVariables` contributes; `prepareBaseParams` from all active specs must compose without clobbering each other's schedule params).
3. **Search the joint space.** ~~Per-control grid search blows up combinatorially.~~ **Resolved (Q1):** use the existing **CEM** solver (already the cockpit default) — it samples the joint vector directly, so this is *not* a solver rewrite. Budget **≤ ~6 decision variables/epoch** (Spending 1 + Roth 1 + TaxDeferred 1 + Roth-early 1 = 4 today); bump CEM population modestly with dimension. Do **not** route the multi-lever case through `GridSearchSolver`. *(CEM is already ~10 s/epoch in auto mode at the single-lever default budget; growing the vector grows the budget. Performance is tracked separately in `design/46-mpc-performance.md` — not a blocker for Phases 1–3.)*
4. **Commit all active levers per epoch** in `apply-forward` (the COMMIT/ADVANCE step), and preserve each across epochs (design 42 fidelity — each lever's prior committed years must survive the receding-horizon roll).
5. **Score interactions in one objective.** Shared balances mean the levers are coupled (a dollar of IRA can be converted *or* withdrawn, not both): the objective must evaluate them **jointly**, not as independent 1-D sweeps.

(A)/(B) can be built and exercised **manually via scenario params** (scheduled amounts set by hand) in Phases 1–3 with **no §8 dependency**. Phase 4 then lands the plumbing above on the already-present CEM solver.

---

## 9. Open questions — RESOLVED (2026-06-29)

All seven resolved in design discussion; decisions recorded below drive the §10 plan.

1. **Multi-lever search strategy (§8).** → **CEM, not grid.** `CockpitController.advise()` already defaults to the CEM solver over a generic `OptimizationProblem.variables` vector, which samples the joint space natively. No solver rewrite. **Budget: ≤ ~6 decision variables/epoch** (4 today); scale CEM population modestly with dimension. Per-epoch solve cost is `samples × generations` rollouts, ~independent of variable count. *(Blocks only Phase 4; §8 re-scoped to cockpit plumbing.)*
2. **Intra-year ordering on shared balances.** → **Conversions, then withdrawals**, pinned via the queue's `order` tiebreak (comparator is `(a.date − b.date) || ((a.order ?? 0) − (b.order ?? 0))` — `simulation.js:91`; the design-34 hazard only bites events that leave `order` at the default 0). `ROTH_CONVERSION_POLICY_EVALUATE` keeps `order` 0; `SCHEDULED_EARLY_WITHDRAWAL` takes a higher `order` (e.g. 10) on the same date. **Same-year converted dollars are NOT withdrawable that year:** the Roth early-withdrawal cap = `contributionBasis + earningsBasis − Σ(current-year rolloverConversions)`, excluding lots by `conversionMs` year. This respects the §408A 5-year recapture clock and blocks the nonsensical convert-then-penalty-pull.
3. **A↔B precedence (§7).** → They compose **through mutated state**; no shared "floor" accounting. (A) fires on its scheduled date as a planned absolute amount and lowers balances; (B) governs only the *order* `replenishSavings` Phase 2 taps sources when a real **deficit** later appears, drawing only what's needed from whatever (A) left. Same-period collision: (A) fires first (scheduled date / `order`), Phase 2 covers any residual. No double-draw because (B) is deficit-sized against post-(A) balances.
4. **Class granularity.** → **Combined `TAX_DEFERRED` (IRA + 401k)**, drawn IRA-then-401k. Identical tax treatment (ordinary income + 10% penalty), so separating them only doubles the decision vector for no objective-relevant distinction. `ROTH` stays a separate class (contributions-penalty-free-first differs). Two classes, matching settled decision §4.2.
5. **Lever units & cap semantics.** → **Raw withdrawal dollars per class, real base-year USD, 0 = OFF** (not an income-fill target — the payoff is liquidity/decant, not bracket-fill). Cap each lever to its **full class drawable balance** in `buildVariables`; resolve IRA/bracket contention with the Roth-conversion lever at **runtime via the Q2 ordering** — conversion first (clamped to live balance), then withdrawal (clamps to what remains; its ordinary income stacks above the conversion's). Don't statically co-cap two levers whose values are both free in the same candidate; let the joint search explore and the runtime clamp make candidates feasible, with the objective scoring the realized (clamped) result.
6. **Move-timing gating.** → **Always-available.** `appliesTo` gates only on below-age + positive class balance — **no** "move within N years" requirement. The objective already prices the penalty (design 40) and the step-up (design 36), so it leaves the lever ~off absent a move; a hard gate would duplicate that thesis, risk a wrong N, and hide the behavior the §12 "pulls-near-move" test should prove. CEM spends a few samples in a near-zero region absent a move — cheap, and keeps the lever simple.
7. **Penalty/cost realism.** → **10% federal penalty + ordinary income**, per existing `us-early-withdrawal-rules.js`. **Out of scope, explicitly:** state penalties (framework models federal only) and all exception pathways (SEPP/72(t), first-home, etc.). Inherited quirk noted, unchanged: IRA `ageThreshold` is coded 60.0 (vs. the statutory 59.5).

## 10. Phased plan (once §9 is resolved)

- **Phase 1 — scheduled decant action (no MPC). ✅ DONE (2026-06-29).** `earlyWithdrawalSchedule` param + `EarlyWithdrawalPolicyHandler` + `ScheduledEarlyWithdrawalApplyReducer`, reusing the factored per-class withdraw/penalty/tax-action core (§6). Cash → brokerage. Manually parameterized. Tests: penalty + tax actions emitted, ledger ties, cash lands at market basis, step-up forgives pre-move gain — all green (`tests/unit/early-withdrawal-decant.test.mjs`, `early-withdrawal.test.mjs` EW-10).
  - **As-built notes (decisions made during implementation):**
    - **§6 helper boundary:** the shared core is `AccountService.earlyWithdrawalTaxActions(account, { fromContrib, fromEarnings, penaltyRate, residency })` — *pure* (no cash/ledger mutation), keyed off a split each caller computes. Phase 2 kept its robust Roth earnings cap + inline basis mutation; only the tax-action shapes are shared. Both callers reproduce the design-44 Gap B action shapes identically.
    - **One apply action, per-class loop in the reducer** (not one action per class): `SCHEDULED_EARLY_WITHDRAWAL_APPLY` carries both class amounts; the reducer draws TAX_DEFERRED as IRA-then-401k, then ROTH contrib-then-earnings. Simpler and deterministic.
    - **Destination** defaults to the owner's `US_STOCK` brokerage; net (gross − penalty) lands via `transaction()` (holdings at market basis) **plus** `contributionBasis += net` (account-level ledger, zero gain) — which is what the AU step-up keys off.
    - **Units:** schedule amounts are real base-year (2025) USD GROSS, compounded to nominal by inflation in `schedules()` (parallels the Roth lever). `earlyWithdrawalOwner` default `primary`; for `both`, amounts apply **per owner**.
    - **Q2 ordering** enforced via the event `order: 10` (Roth conversions stay at 0), so same-date conversions apply first.
    - **Integration test ✅** (`tests/unit/early-withdrawal-decant-integration.test.mjs`): through the real compile→schedule→run engine — (A) schedule→handler→reducer→tax chain lands net cash in brokerage; (B) Q2 same-date ordering proven (conversion-first, distinguished by the brokerage net 36k vs 54k); (C) §2 end-to-end — decant grows while US-resident and the `moveYear` CHANGE_RESIDENCY step-up forgives the pre-move gain.
- **Phase 2 — (B) drawdown-ordering option. ✅ DONE (2026-06-29).** Strategy switch + A↔B precedence.
  - **As-built notes:**
    - **Switch:** a `earlyWithdrawalBeforeBrokerage` boolean param (US_EARLY_WITHDRAWAL toolset) → `state.earlyWithdrawalBeforeBrokerage`, read by `AccountService.replenishSavings`. Independent of the scheduled decant (A); default off (historical strictly-last order).
    - **Mechanism:** `drawdownStrategy`/`drawdownPriority` only orders the *penalty-free* Phase 1, so it can't move the penalty draw ahead of a brokerage sale (under the gate, IRA/401k have ~0 penalty-free availability). So (B) is a **phase-structure** change: when on, taxable `type===BROKERAGE` (us-stock + fixed-income, the STOCK_WITHDRAWAL_TAX bucket) is **held back from Phase 1**, the Phase 2 penalty draw runs, then a new **Phase 3** realizes brokerage gains only as a backstop for any residual.
    - **A↔B precedence (§9 Q3):** no coupling code — (A) fires on its scheduled date lowering balances; (B) is deficit-sized against whatever (A) left, so they compose through state and never double-draw. Proven by the `(A+B)` composition test.
    - **Tests:** EW-11 (unit, `early-withdrawal.test.mjs`) — default sells brokerage first vs. flag draws penalty first vs. Phase-3 backstop; integration (`early-withdrawal-decant-integration.test.mjs`) — the flag flips brokerage-sold↔IRA-drawn end-to-end through a real spending deficit, plus the A+B composition.
- **Phase 3 — single-lever cockpit control (A). ✅ DONE (2026-06-29).** `COCKPIT_CONTROLS.EARLY_WITHDRAWAL` spec, `actuate`/`prepareBaseParams`, usable as *one* selected lever (auto-listed in the cockpit dropdown).
  - **As-built notes:**
    - **One spec, two variables** (not two specs): `buildVariables` returns a tax-deferred + a Roth INTEGER variable for the next-actionable year, each real base-year USD GROSS, capped to the owner's class drawable balance (deflated) and to **0 above the age gate** (≥60 tax-deferred / ≥59.5 Roth — the lever only helps below the gate, Q6/§5). Mirrors the ROTH lever's convertible-IRA cap.
    - **Opt-in optimization window (chosen approach):** snapshot rollouts re-write only *existing* queued events (`_seededSim` → `retargetEarlyWithdrawalEvents`, the rollout-side twin of `actuate`), so the lever can't conjure an event from a param alone. New params `earlyWithdrawalStartYear`/`earlyWithdrawalEndYear` (default null) seed 0-amount tunable placeholder events per window year; **off by default → manual Phase 1 scenarios stay clean** (no phantom events). Explicit schedule entries override the placeholder for their year.
    - **actuate** mirrors ROTH: persist both real per-class amounts to the `earlyWithdrawalSchedule` param (0/0 cancels the year), then live-re-wire the queued events via the shared helper.
    - **Tests:** `cockpit-controller.test.mjs` (12: next-year targeting, per-class caps, age-gate collapse, owner scoping, describe, actuate persist/cancel/rewire, appliesTo/liveActuatable); `early-withdrawal-decant.test.mjs` (window emission, override, retarget helper); integration (window seeds placeholders in the live queue); viz dropdown updated. Full suite 3044 unit + viz green.
- **Phase 4 — multi-lever MPC (§8). ✅ FRAMEWORK DONE (2026-06-29).** Lever-set activation, joint decision vector (union of active specs' `buildVariables`, composed `prepareBaseParams`), per-epoch commit across all active levers. Landed on the **already-present CEM solver** (Q1) — cockpit plumbing (`control`→`controls[]`), not a solver rewrite.
  - **As-built notes:**
    - **`CockpitController.controls[]`** (back-compat `control` getter → `controls[0]`, `setControls()`): `_prepareControl` composes every active control's `prepareBaseParams` (§8.2 — they address distinct schedule params, no clobber); `_variables` unions each control's `buildVariables`, **tagging every variable with `_controlKey`** so `describeMove`/`describeRecordMove` route a candidate back to its owning control (§8.1); `_rangeFor` gives each control its own default/override range (not one shared range).
    - **§8.3–8.5 came for free:** `apply`/`advance`/`autoRun` were already vector-agnostic — they commit the full unioned candidate into `committed` and roll it forward, preserving each lever across epochs; and the objective scores the single joint rollout once, so the levers are evaluated **jointly** (coupling on shared balances priced by the one rollout), not as independent 1-D sweeps.
    - **`runMpc` (headless) is already generic** — it takes a `buildVariables` function, so a caller composes the lever set; no change needed.
    - **Tests:** `cockpit-controller.test.mjs` (6: compose-no-clobber, union+tagging, per-control range, joint describe, per-epoch commit of all levers, single-lever back-compat). Full suite 3050 unit + 27 viz green.
  - **Interactive UI multi-select ✅ DONE (2026-06-29):** `mpc-cockpit-plugin.js` Levers control is now a `<select multiple>` (Ctrl/Cmd-click) wired to `setControls`. `_currentControls()` drives the joint set; `_leverApplies` requires every selected lever to apply (reports the first inert); the manual Min/Max/Step row greys to "per-lever defaults" with >1 lever; `_applyCandidate` actuates **each** control on its own `_controlKey`-filtered variable subset (so ROTH/SPENDING `actuate`, which read `vars[0]`, get the right variable). Tests: 4 new viz cases (multi-select default, joint set, range-grey, all-must-apply); full viz suite 806 + unit 3050 green.
  - **Remaining (follow-ups, not blocking):**
    - **§12 outcome test** — "multi-lever joint search beats (or ties) each lever alone" through a real solve (deferred: optimizer-noise-sensitive; the structural tests above prove composition/no-regression).
    - **Solver widening** — CEM is the default but the joint vector is higher-dim + mixed INTEGER/continuous; evaluate QP_POLISH and alternatives. Tracked in `design/46-mpc-performance.md §2a` (owner ask, refine next session).

## 11. Risks / downstream

- **Combinatorial blow-up (§8)** is the main risk; it likely pulls the solver rework forward.
- **Double-draw** between scheduled (A) and fallback Phase 2 / (B) if precedence isn't pinned.
- **Conversion/withdrawal coupling** on the same IRA balance and bracket headroom — the optimizer can produce nonsensical combos if the joint objective or the intra-year ordering is wrong.
- **Same-date ordering** (design 34 §13) for conversion-then-withdrawal in one year.
- **Objective must already price** the penalty *and* the step-up payoff (it does, via design 40 + design 36) — verify with a test that the lever is only pulled when the benefit clears the penalty and a move is in sight.

## 12. Test plan (sketch)

- **Penalty-clears-benefit:** optimizer pulls the lever only when decant value (incl. step-up) > penalty; leaves it at 0 otherwise.
- **Pulls-near-move:** with a scheduled AU move, early withdrawals concentrate in the pre-move low-bracket years; with no move, the lever stays ~off.
- **Conversion + withdrawal same year:** IRA convert + Roth contribution/earnings withdrawal compose with correct ordering, ledger integrity (design 43 invariants), and correct tax/penalty actions.
- **Cash lands at market basis** in brokerage and receives the AU step-up at the move (pre-move gain forgiven).
- **Multi-lever joint search** beats (or ties) each lever alone on the objective (no regression from composition).
