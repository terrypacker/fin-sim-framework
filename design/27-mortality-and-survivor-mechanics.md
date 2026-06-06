# 27 — Mortality & Survivor Mechanics

**Status**: Skeleton (Phase B per `design/24-financial-modeling-roadmap.md` §5)
**Phase dependencies**: Phase A (`design/25-holding-level-state.md`) lands first (for single-threaded build-order reasons; this design does not read holdings). `design/25a-mc-nested-param-paths.md` is required for per-person actuarial MC lifespan draws.
**Related**: `design/24-financial-modeling-roadmap.md` §3.3, `design/20-decouple-residency-from-citizenship.md` (`state.people` mutation pattern this design re-uses), `design/26-dynamic-spending-strategies.md` (survivor expense multiplier interoperates with active spending strategies).
**Author note**: Skeleton document. Section bodies are placeholders to be filled when Phase B opens. The shape captured here is what the roadmap commits to in §3.3.

---

## 1. Purpose

`Person.lifeExpectancy` is a fixed input; the simulation runs until `simEnd` regardless of person ages; no household-composition change on death. A defensible plan needs the simulation to **end** (or transition) at the right time and to model survivor mechanics: spending shifts, Social Security transitions, late-life care windows, MC actuarial lifespan draws.

---

## 2. Today

> *To populate when Phase B opens.*

Pointer: `Person.lifeExpectancy` (`src/finance/person.js`) is configured at scenario boot and read by some UI surfaces but not by any handler. `state.people` is mutated by `ChangeResidencyHandler` per design 20 — same pattern this design reuses.

### 2.1 Scheduling-layer invariant (load-bearing for this design)

The simulation framework currently maintains a strict separation between **config-time scheduling** and **runtime action emission**:

- **Config-time (boot, scenario edits):** `SimulationAdapter._scheduleOneOffEvent` / `_scheduleEventSeries` reads each enabled `BaseEvent` from the config graph and calls `sim.schedule(event)`. The only runtime path back into queue mutation is `_applyEventChange` (triggered when the user edits an event in the graph), which calls `sim.unschedule(type)` then re-schedules.
- **Runtime (during a simulation run):** Finance handlers (`HandlerEntry` subclasses in `src/finance/handlers/*`) return arrays of **actions** from `call({ state })`. They do **not** call `sim.schedule()` or `sim.unschedule()`. Grep-confirmed across `src/finance` and `src/services`: zero call sites.

Several recent features (e.g. the OneOff→EventSeries refactor; `ChangeResidencyHandler`) were materially simpler because of this invariant: handlers are pure action emitters, the queue is a known-static set after boot, and the execution graph / journal / GraphRecorder don't have to model dynamic schedule churn.

**Implication for this design:** any mechanism that needs to *change* a person's death date mid-simulation (e.g. redraw lifespan on residency change — see §10 Q1) conflicts with this invariant. Three resolution paths were considered:

| Path | Mechanism | Cost |
|---|---|---|
| **A. Honor the invariant** *(chosen)* | Lifespan distribution is fixed at scenario boot from boot-time residency. Mid-life moves do not redraw. Users model residency-driven lifespan shifts via scenario branching (design 17) — branch from the move date with new residency baked in. | Loses the "AU residency adds years" realism in single-scenario runs. Acceptable if branching is already idiomatic. |
| **B. Handler-driven queue mutation** | A new `ResidencyChangedMortalityHandler` (chains off `CHANGE_RESIDENCY_APPLY`) directly calls `sim.unschedule('PERSON_DIED')` and `sim.schedule(newDeathEvent)`. | First precedent of a finance handler touching the queue. Requires GraphRecorder / ExecutionGraph to model the cancel+reschedule edge (today they assume schedule-once-at-boot). Journal needs to log the mutation. |
| **C. Action-driven queue mutation** | Introduce framework-level actions `SCHEDULE_EVENT_APPLY` / `UNSCHEDULE_EVENT_APPLY` whose reducers perform the queue mutation. Handlers stay pure; mutation is journaled and visible to the execution graph. | Larger substrate add (new actions, new reducers, new edge type in ExecutionGraph). Likely the *right* long-term shape if more designs need runtime rescheduling, but premature if this is the only consumer. |

**Decision: Path A.** Scenario branching (design 17) already covers the residency-shift use case for users who care, and no other Phase B design currently needs runtime rescheduling. If implementation surfaces a concrete need to revise — e.g. design 26's `HealthcareEventDriven` strategy wanting to schedule events from a handler, or a Phase C feature needing dynamic event timing — revisit and likely jump to Path C (Path B remains the worst of both worlds). See §10 Q1 for the open thread.

---

## 3. Lifecycle event: `PERSON_DIED`

| Event | Kind | When | Carries |
|---|---|---|---|
| `PERSON_DIED` | `OneOffEvent` | Scheduled at `Person.birthDate + Person.lifeExpectancy (years)` at scenario boot | `personId` |

`MortalityHandler` consumes `PERSON_DIED` and emits a chain of secondary actions:

| Action | Reducer | Purpose |
|---|---|---|
| `PERSON_DIED_APPLY` | `PersonDiedApplyReducer` | Removes person from `state.people`. |
| `SURVIVOR_EXPENSES_APPLY` | `SurvivorExpensesApplyReducer` | Switches household monthly expenses to `survivorMultiplier × current` (default 0.70). |
| `SOCIAL_SECURITY_SURVIVOR_APPLY` | `SocialSecuritySurvivorApplyReducer` | Surviving spouse's monthly SS becomes `max(self, deceased)`. |
| `ACCOUNT_RETITLE_APPLY` | `AccountRetitleApplyReducer` | Solo-owned retirement accounts → surviving spouse per estate rules (minimum viable: transfer ownership; full estate machinery is out of scope). |
| `SCENARIO_COMPLETE` | `ScenarioCompleteReducer` | If no spouse survives: terminate the scenario by setting `state.scenarioComplete = true` and short-circuiting the queue. |

---

## 4. Late-life care window

Per-person parameter `lateLifeCareMonths` (default 0). During the last N months before death, monthly expenses are multiplied by `lateLifeCareFactor` (default 2.0). Implemented as a `LateLifeCareScheduler` at scenario boot that emits a `LATE_LIFE_CARE_BEGIN` event at `deathDate - lateLifeCareMonths` and a `LATE_LIFE_CARE_END` co-terminus with `PERSON_DIED`.

The factor interoperates with design 26's spending strategies as one more additive `SPENDING_STRATEGY_APPLY` delta.

---

## 5. Monte Carlo lifespan

`IntlRetirementMcConfig` consumes `design/25a-mc-nested-param-paths.md`'s nested-path substrate to register one MC variable per person:

```js
// Contributed by this design's MC-config contributor
[
  { paramKey: 'people.primary.lifeExpectancy', label: 'Primary lifespan (years)', type: ACTUARIAL_LIFESPAN, table: 'CDC_2024', sex: 'M', enabled: true },
  { paramKey: 'people.spouse.lifeExpectancy',  label: 'Spouse lifespan (years)',  type: ACTUARIAL_LIFESPAN, table: 'CDC_2024', sex: 'F', enabled: true },
]
```

`ACTUARIAL_LIFESPAN` is a new `DISTRIBUTION_TYPE` backed by CDC 2024 life tables (or similar — exact table is a Phase B decision). Single runs use the fixed `Person.lifeExpectancy`; MC sweeps draw from the actuarial table per person, per sex.

This matches the shock-framework stance from design 21: **deterministic single runs, stochastic MC**.

---

## 6. State additions

> *To populate.*

Sketch:

- `state.deceased` — `{ [personId]: Date }`; populated by `PersonDiedApplyReducer`.
- `state.scenarioComplete` — boolean; ends iteration when no survivors remain.
- `state.survivorMultiplier` — scalar; written by `SurvivorExpensesApplyReducer`.

---

## 7. Interaction with existing designs

| Design | Interaction |
|---|---|
| **25 Holdings** | None direct. Mortality acts on `state.people`, not on holdings. Sequencing only. |
| **25a MC paths** | Per-person actuarial draws live at `people.primary.lifeExpectancy` etc.; consumes the path-walking substrate. |
| **26 Spending** | Survivor multiplier + late-life-care factor compose with whichever spending strategies are active via additive `SPENDING_STRATEGY_APPLY` deltas. **Dependency satisfied (2026-06-05):** design 26 was finalized to materialize the split as `state.expenses = { essential, discretionary }`, so the per-slice survivor multipliers (§10 Q2 Option B) are unblocked — no fallback to a scalar multiplier needed. |
| **20 Residency** | When a spouse dies, the surviving spouse's residency is unchanged; the household's primary-residence determination falls back to the survivor. Reuses design 20's `state.people` mutation pattern. |
| **17 Branching** | Branching off a pre-death save explores different MC death timings naturally — the lifespan param is part of the cfg. |
| **Tax** | Filing-status change (married-joint → single) on widowhood is tax-significant. Mechanically handled by tax modules reading `state.deceased`; the rule policy is per-year-module work. |

---

## 8. Out of scope

- **Full estate / inheritance mechanics** — RMDs for inherited IRAs, step-up basis (mentioned as design-25 follow-up), beneficiary rules, joint trust accounts. This design ships a minimum viable "transfer to surviving spouse" answer; the full machinery is a future design.
- **Multi-spouse / remarriage** — out of scope; one death, one surviving spouse.
- **Insurance products** — life insurance, annuities, long-term-care policies. Not modeled.
- **Cause-of-death modeling** — the actuarial table gives a draw; cause is uniform-unknown.
- **Disability / pre-death incapacity** — not modeled. The late-life-care window is the only proxy.

---

## 9. Testing sketch

- `tests/unit/evt-person-died.test.mjs` — single-spouse death triggers expected action chain; orphan death terminates scenario.
- `tests/unit/mortality-actuarial-draws.test.mjs` — MC actuarial draws produce sensible distributions; seeded RNG reproduces.
- `tests/unit/late-life-care.test.mjs` — late-life-care window multiplies expenses for N months then stops.
- Extend `intl-retirement-mc-runner.test.mjs` with a per-person lifespan sweep.
- Extend `intl-retirement-scenario.test.mjs` to confirm a multi-decade run with both deaths terminates cleanly.

---

## 10. Open questions

> *Capture during Phase B kickoff. Initial seed:*

- Which actuarial table (CDC 2024 vs. SSA vs. AU lifetables) is the default per country? **Answer (table choice):** Table is keyed off `Person.residency`, not citizenship. CDC 2024 for US residency and as the fallback for any residency without a dedicated table; AU lifetables for AU residency. Single deterministic runs use the configured `Person.lifeExpectancy` directly and ignore residency for table selection — residency only matters when MC is drawing actuarially. **Answer (redraw on move): Path A from §2.1 — no runtime redraw.** Lifespan distribution is set once at scenario boot from boot-time residency. Mid-life `CHANGE_RESIDENCY_APPLY` does **not** re-roll the lifespan or shift `PERSON_DIED`. Users wanting to model residency-driven lifespan changes use scenario branching (design 17) — branch from the move date with the new residency baked in at boot. **Leave this thread open during implementation:** if a concrete need to revise surfaces (e.g. a Phase B/C feature requires runtime rescheduling, or the loss of redraw realism is more painful than expected in MC sweeps), jump to Path C rather than Path B.
- Does the survivor multiplier interact with `discretionarySharePct` from design 26, or override the whole household expense? **Answer:** Per-slice multipliers (Option B). Replace the single `survivorMultiplier` with `survivorEssentialMultiplier` (default 0.85) and `survivorDiscretionaryMultiplier` (default 0.50); at `discretionarySharePct = 0.30` these blend to ~0.75, close to the original flat-0.70 default. The survivor reducer emits two `SPENDING_STRATEGY_APPLY` deltas — one per slice — so it composes cleanly with `Guardrail` / `RegimeAware` (which already operate on the discretionary slice only). **Hard dependency on design 26:** the essential/discretionary split must be materialized in state (e.g. `state.expenses = { essential, discretionary }`), not just an inline calc inside Guardrail/RegimeAware reducers. If 26 ships with `discretionarySharePct` as an ephemeral param only, this design must either (a) push back into 26 to materialize the split or (b) fall back to a single scalar multiplier with documented order-of-operations.
- How does account retitling interact with the design 25 holdings model — does the surviving spouse's inherited holdings carry stepped-up basis (a `HOLDING_SET_BASIS` chain at death)? **Answer:** Yes, governed by **real US estate-tax law**: stepped-up basis applies when the **deceased's tax jurisdiction at time of death** is US. AU has no equivalent step-up (CGT cost-base carries over to the survivor), so an AU-resident-at-death produces no basis adjustment. The `MortalityHandler` reads `state.deceased[personId].taxJurisdiction` (captured at death from `Person.residency`) and dispatches into the tax/account module registry, which decides whether to emit a `HOLDING_SET_BASIS_APPLY` chain. The decision lives in the tax module per country, matching the existing TaxEngine + AccountRulesEngine pattern. Note: jurisdiction-at-death may differ from the surviving spouse's jurisdiction (e.g. AU-resident widow inheriting from US-resident deceased) — that's fine, the rule keys off the deceased only.
- Is `simEnd` redundant once MC lifespans drive termination? (Probably not — but worth deciding.) **Answer:** No, keep it. Effective termination is `min(simEnd, last-survivor death)`. `simEnd` remains the hard cap; mortality is the soft end.

---

## 11. Doc-body follow-ups (from §10 answers)

Sections to update before implementation begins:

- **§3 mortality handler chain:** rename `SURVIVOR_EXPENSES_APPLY` to emit *two* deltas (essential + discretionary), or split into `SURVIVOR_ESSENTIAL_APPLY` + `SURVIVOR_DISCRETIONARY_APPLY`. Add `HOLDING_SET_BASIS_APPLY` chain (US deceased only) ahead of `ACCOUNT_RETITLE_APPLY`. No `ResidencyChangedMortalityHandler` (Path A from §2.1).
- **§4 late-life care:** confirm the factor applies per-slice or as a uniform multiplier on the combined expense (probably uniform — late-life medical hits both essential and discretionary). Late-life care events are scheduled at boot relative to the boot-time death date and do not shift on residency change (consistent with §2.1 Path A).
- **§5 MC:** lifespan distribution is residency-keyed at MC variable-registration time; `IntlRetirementMcConfig` consults `Person.residency` once at boot to pick `CDC_2024` vs. AU lifetables. No mid-run redraw on residency change.
- **§6 state additions:** replace `state.survivorMultiplier` (scalar) with `state.survivorEssentialMultiplier` + `state.survivorDiscretionaryMultiplier`. Add `state.deceased[personId].taxJurisdiction`.
- **§7 interaction table:** update **26 Spending** row to call out the materialized-slice dependency; update **Tax** row to specify deceased's jurisdiction drives basis step-up. Add a **Simulation framework** row noting that this design honors the §2.1 schedule-once-at-boot invariant; modeling residency-driven lifespan shifts is delegated to **17 Branching**.

---

## 12. Step-by-step Implementation Plan (added 2026-06-05)

### Status legend
- [ ] not started  ✅ complete

### Sequencing rationale

Mirrors the design-26 approach: land the lowest-risk deterministic core first, validate it end-to-end, then layer the event-driven and stochastic machinery. All four increments honor §2.1 **Path A** — no finance handler mutates the scheduling queue; the only new framework touch is a single read-only check of `state.scenarioComplete` in the run loop (Increment 1, Step 8).

**Build order:** Increment 1 (deterministic mortality + survivor core) → Increment 2 (late-life care window) → Increment 3 (MC actuarial lifespan) → Increment 4 (estate basis step-up + filing-status interaction). Increments 2–4 are independent of each other and may be reordered; all depend on Increment 1. Increment 4 additionally depends on design 25 holdings being live (it is — substrate landed 2026-06-03).

**Dependency check before starting:** design 26's `state.expenses = { essential, discretionary }` materialization is COMPLETE (2026-06-05), so §10 Q2 Option B (per-slice survivor multipliers) is unblocked — no scalar fallback needed. Design 25a nested param paths are COMPLETE, so Increment 3's per-person actuarial draws can use `people.primary.lifeExpectancy` paths directly.

---

### Increment 1 — Deterministic mortality + survivor core

The deterministic single-run skeleton: schedule `PERSON_DIED` at boot, the handler + reducer chain, state additions, and scenario termination. Defers basis step-up (Increment 4) and MC draws (Increment 3).

**Step 1 — State additions in `InternationalRetirementFinancialState`** ✅
- `src/finance/state/intl-retirement-state.js`:
  - `this.deceased = {};` — map `{ [personId]: { date, taxJurisdiction } }`; populated by `PersonDiedApplyReducer`.
  - `this.scenarioComplete = false;` — set true when no survivors remain.
  - Survivor multipliers (per §10 Q2 Option B — replaces the scalar `survivorMultiplier` from the §6 sketch): these are *parameters* consumed by the handler at death time, not running state, so they do **not** live on the state object — they flow in via the toolset (Step 7). No `state.survivorMultiplier` field is added.

**Step 2 — `PERSON_DIED` lifecycle event scheduled at boot** ✅
- `src/scenarios/toolsets/us-retirement-toolset.js` (and `au-retirement-toolset.js`) `schedules()`:
  - For each person with a `lifeExpectancy`, push a `OneOffEvent`:
    ```js
    schedules.push(new OneOffEvent({
      name: `Death — ${person.name}`,
      type: 'PERSON_DIED',
      date: new Date(Date.UTC(birthYear + person.lifeExpectancy, birthMonth, birthDay)),
      data: { personId: person.id },
      enabled: true,
      color: '#37474F',
    }));
    ```
  - Compute the death date from `person.birthDate + lifeExpectancy years` (UTC, mirror the `K401_TO_IRA_CONVERSION` date-math at lines 453–461). Skip if the computed date is past `simEnd` (no-op — `simEnd` is the hard cap, §10 Q4).
  - Gate on a new boolean param `mortalityEnabled` (default `true`) so existing scenarios/tests that don't expect termination can opt out.

**Step 3 — `MortalityHandler`** ✅
- Create `src/finance/handlers/mortality-handler.js` (`HandlerEntry`, `static eventType = 'PERSON_DIED'`).
- `call({ state, date })` reads `data.personId` from the event, looks up the person in `state.people`, determines the surviving spouse (the other entry in `state.people`, if any), and emits an ordered action chain:
  1. `{ type: 'PERSON_DIED_APPLY', personId, date, taxJurisdiction: person.residency }` — record death + jurisdiction (captured from `Person.residency` at time of death, §10 Q3) and remove from `state.people`.
  2. *(Increment 4 inserts `HOLDING_SET_BASIS_APPLY` here — US deceased only.)*
  3. If a spouse survives: `{ type: 'ACCOUNT_RETITLE_APPLY', deceasedId, survivorId }`.
  4. If a spouse survives: two `{ type: 'SPENDING_STRATEGY_APPLY', slice, delta, reason: 'survivor' }` deltas — one for `essential`, one for `discretionary`. The handler computes `delta = state.expenses[slice] * (multiplier - 1)` from the survivor multipliers (Step 7) so the existing `SpendingStrategyApplyReducer` (`expenses[slice] += delta`) applies the reduction additively and composes with active spending strategies.
  5. If a spouse survives: `{ type: 'SOCIAL_SECURITY_SURVIVOR_APPLY', survivorId, deceasedId }`.
  6. `{ type: 'SCENARIO_COMPLETE_CHECK' }` — always last.
- `generatedActionTypes` lists all of the above.
- Follows the `ChangeResidencyHandler` pure-emitter pattern (no queue mutation).

**Step 4 — `PersonDiedApplyReducer`** ✅
- Create `src/finance/reducers/person-died-apply-reducer.js` (`Reducer`, `actionType = 'PERSON_DIED_APPLY'`, priority `PRE_PROCESS (10)` so downstream reducers in the same chain see the updated `state.people`).
- Writes `state.deceased[personId] = { date, taxJurisdiction }`; removes `personId` from `state.people` (clone-and-delete, do not mutate in place — mirror the design-20 `state.people` mutation pattern via `this.newState`).

**Step 5 — `SocialSecuritySurvivorApplyReducer`** ✅
- Create `src/finance/reducers/social-security-survivor-apply-reducer.js` (priority `PRE_PROCESS (10)`).
- Sets `state.people[survivorId].socialSecurityMonthly = max(survivor.socialSecurityMonthly, deceased.socialSecurityMonthly)`. Read the deceased's value from `action` (the handler captured it pre-removal) since they are already gone from `state.people`.

**Step 6 — `AccountRetitleApplyReducer`** ✅
- Create `src/finance/reducers/account-retitle-apply-reducer.js` (priority `PRE_PROCESS (10)`).
- Minimum-viable estate handling (§3, §8): for each account state entry solo-owned by `deceasedId`, reassign `ownerId → survivorId`. Iterate the account state keys; do not touch jointly-owned accounts. Full estate/RMD/beneficiary machinery is explicitly out of scope.
- **Holdings travel with their parent account** — ownership lives at the account-state level, so reassigning the account's `ownerId` carries its holdings to the survivor with no per-holding action. Do **not** reach for `HoldingRetitleAction` here: it patches holding *metadata* (allocation, rateKey, label) only and has no ownership semantics (verified `src/finance/holdings/holding-actions.js:259`).

**Step 7 — `ScenarioCompleteReducer` + survivor-multiplier params** ✅
- Create `src/finance/reducers/scenario-complete-reducer.js` (`actionType = 'SCENARIO_COMPLETE_CHECK'`, priority `POST_PROCESS` — runs after the rest of the chain).
- If `Object.keys(state.people).length === 0`, set `state.scenarioComplete = true`.
- Toolset wiring (`us-retirement-toolset.js` / `au-retirement-toolset.js`):
  - `paramSchema()`: add `survivorEssentialMultiplier` (Number, default `0.85`, group `Mortality`), `survivorDiscretionaryMultiplier` (Number, default `0.50`, group `Mortality`), and `mortalityEnabled` (Boolean, default `true`, group `Mortality`).
  - `reducers()`: when `mortalityEnabled`, register `PersonDiedApplyReducer`, `SocialSecuritySurvivorApplyReducer`, `AccountRetitleApplyReducer`, `ScenarioCompleteReducer`.
  - `handlers()`: when `mortalityEnabled`, register `MortalityHandler` and attach the `PERSON_DIED` schedules via `handledEvents` (mirror the `RetirementDateHandler` wiring at lines 684–692). Pass the survivor multipliers into the handler constructor.
- `INTL_RETIREMENT_DEFAULTS` (`src/scenarios/intl-retirement-scenario.js`): add `survivorEssentialMultiplier: 0.85`, `survivorDiscretionaryMultiplier: 0.50`, `mortalityEnabled: true`.

**Step 8 — Scenario termination in the run loop** ✅
- `src/simulation-framework/simulation.js` `stepTo()` (the `while (this.queue.size() > 0)` loop at ~line 951): after `this.execute(next)` returns, add `if (this.state?.scenarioComplete) break;`.
- This is the only framework change and it honors §2.1 Path A: a reducer sets the flag, the loop reads it; no handler touches the queue. Remaining queued events are simply not processed (soft end). `simEnd` remains the hard cap.
- Confirm the MC runner and any other `stepTo` callers tolerate an early break (they should — the queue draining naturally is equivalent to reaching `simEnd`).

**Step 9 — `state-schema-registry.js`** ✅
- Register `deceased` and `scenarioComplete` so the journal / state panel / CSV export render them. `deceased` is a map of `{ date, taxJurisdiction }`; follow the nested-registration pattern used for `expenses` (design 26 Step 10).

**Step 10 — Unit tests** ✅
- `tests/unit/evt-person-died.test.mjs` — single-spouse death triggers the full action chain in order; survivor SS becomes `max(self, deceased)`; survivor expense deltas applied per-slice; solo accounts retitled to survivor.
- `tests/unit/mortality-scenario-complete.test.mjs` — orphan (last-survivor) death sets `state.scenarioComplete` and the run loop stops before `simEnd`.
- Extend `tests/unit/intl-retirement-scenario.test.mjs` — a multi-decade run with both deaths terminates cleanly; `mortalityEnabled: false` preserves run-to-`simEnd` behavior (regression guard).

---

### Increment 2 — Late-life care window

Per-person elevated spending in the final N months before death (§4). Independent of Increments 3–4.

**Step 11 — Late-life-care events scheduled at boot** ✅
- Toolset `schedules()`: per-person params `lateLifeCareMonths` (default `0`) and `lateLifeCareFactor` (default `2.0`). When `lateLifeCareMonths > 0`, push two `OneOffEvent`s:
  - `LATE_LIFE_CARE_BEGIN` at `deathDate - lateLifeCareMonths` (data `{ personId, factor }`).
  - `LATE_LIFE_CARE_END` co-terminus with `PERSON_DIED` (data `{ personId }`).
- Scheduled relative to the boot-time death date; does not shift on residency change (§2.1 Path A, §11 follow-up).

**Step 12 — `LateLifeCareHandler` + reducer** ✅
- Create `src/finance/spending/strategies/late-life-care-handler.js` handling both `LATE_LIFE_CARE_BEGIN`/`LATE_LIFE_CARE_END`, emitting `LATE_LIFE_CARE_APPLY { active, factor }`.
- Create `src/finance/spending/strategies/late-life-care-apply-reducer.js` (priority `CASH_FLOW (20)`):
  - On `active: true`: multiply **both** slices uniformly (`expenses.essential *= factor`; `expenses.discretionary *= factor`) — late-life medical hits both (§11 follow-up: uniform, not per-slice). Store the applied factor in `state.lateLifeCare = { active, appliedFactor }` so the END event divides it back out cleanly (mirror the `RegimeAwareSpendingReducer` apply/revert pattern, design 26 Step 6).
  - On `active: false`: divide both slices by `appliedFactor`; clear the entry.
  - Always sync `monthlyExpenses = essential + discretionary`.
- Add `state.lateLifeCare = {}` init in `intl-retirement-state.js`.
- Toolset `handlers()`/`reducers()`: register when any person has `lateLifeCareMonths > 0`.

**Step 13 — Tests** ✅
- `tests/unit/late-life-care.test.mjs` — both slices multiplied by `factor` for the window, reverted at END; composes additively with an active `RegimeAware` cut and with the survivor multiplier (apply-order is well-defined and reversible).

---

### Increment 3 — Monte Carlo actuarial lifespan

Per-person stochastic lifespan draws for MC sweeps; deterministic single runs keep the fixed `Person.lifeExpectancy` (§5, design-21 stance). Consumes design 25a nested param paths.

**Step 14 — `ACTUARIAL_LIFESPAN` distribution + life tables** ✅
- `src/simulation-framework/distributions.js`: add `ACTUARIAL_LIFESPAN: 'actuarialLifespan'` to `DISTRIBUTION_TYPES`, an `ActuarialLifespanDistribution` class with `sample(rngFn)`, and a `createDistribution` case.
- Create `src/finance/monte-carlo/life-tables.js` exporting `CDC_2024` (US) and an AU lifetable, plus a `lookupLifeTable(residency)` helper that returns `CDC_2024` as the fallback for any residency without a dedicated table (§10 Q1 answer). The distribution samples a remaining-years value conditioned on the person's current age and sex.

**Step 15 — `buildMortalityMcConfigs` contributor** ✅
- `src/finance/monte-carlo/intl-retirement-mc-config.js`: add a `buildMortalityMcConfigs(params)` function and register it in `IntlRetirementMcConfig.contributors` (mirror `buildShockMcConfigs` / `buildRealPropertyMcConfigs`).
- Emit one variable per person at nested paths `people.primary.lifeExpectancy` / `people.spouse.lifeExpectancy`:
  ```js
  { paramKey: 'people.primary.lifeExpectancy', label: 'Primary lifespan (years)',
    type: DISTRIBUTION_TYPES.ACTUARIAL_LIFESPAN, table: lookupLifeTable(residency),
    sex: <person.sex>, group: 'Mortality', enabled: false }
  ```
- Table is **residency-keyed** and resolved **once at boot** from `Person.residency` (§10 Q1: no mid-run redraw). `enabled: false` by default (opt-in, like balances/wages).
- Note: `Person` has no `sex` field today — add `sex` to `Person` (`src/finance/person.js`, default `'M'`) and thread it through the toolset people-build (line 288). Small prerequisite; call it out in the increment.

**Step 16 — Runner applies per-person sampled lifespan** ✅
- `src/finance/monte-carlo/intl-retirement-mc-runner.js`: confirm the 25a `structuredClone` + `set()` path writes sampled `people.primary.lifeExpectancy` into the param tree, and that the toolset `schedules()` death-date math (Increment 1 Step 2) reads `params.people.<key>.lifeExpectancy` rather than the hardcoded scenario value. Round the sampled value to an integer before use (mirror the real-property sale-year rounding note in `buildRealPropertyMcConfigs`).

**Step 17 — Tests** ✅
- `tests/unit/mortality-actuarial-draws.test.mjs` — actuarial draws produce sensible distributions; seeded RNG reproduces; residency selects the correct table.
- Extend `tests/unit/intl-retirement-mc-runner.test.mjs` with a per-person lifespan sweep; assert each run's `PERSON_DIED` date tracks the sampled lifespan and that single (non-MC) runs are unaffected.

---

### Increment 4 — Estate basis step-up + filing-status interaction

The estate-law interaction layer (§7 Tax row, §10 Q3). Depends on design 25 holdings (live) and the tax/account module registry.

**Step 18 — Basis step-up chain (US deceased only) — reuse design-25 holdings actions** [ ]
- **No new action or reducer needed.** Design 25 already ships `HoldingSetBasisAction` (action type `HOLDING_SET_BASIS`, `src/finance/holdings/holding-actions.js:187`) and `HoldingSetBasisReducer` (`src/finance/holdings/holding-reducers.js:132`, runs at `PRIORITY.COST_BASIS`, overwrites `holding.costBasis` with no balance impact). Their descriptions literally cite *"rollover step-up, residency reset"* — purpose-built for this. **Reconcile the doc:** §3 / §11 invented the name `HOLDING_SET_BASIS_APPLY`; the real action type is `HOLDING_SET_BASIS` — update those sections to match.
- Extend `MortalityHandler` (Increment 1 Step 3, action #2): after `PERSON_DIED_APPLY`, dispatch into the tax/account module registry keyed on `state.deceased[personId].taxJurisdiction`. US jurisdiction → for each inherited holding, emit a `HoldingSetBasisAction({ stateKey, holdingId, costBasis: holding.marketValue })` (step basis up to date-of-death fair value; market value is unchanged so no `HoldingRevalueAction` is required). AU jurisdiction → emit nothing (CGT cost-base carries over). The US-vs-AU decision lives in the per-country tax module (TaxEngine + AccountRulesEngine pattern), **not** baked into the handler — the handler asks the module which holdings to step up.
- Keys off the **deceased** only; the survivor's jurisdiction is irrelevant (§10 Q3 note). Ordering: basis step-up runs *before* `ACCOUNT_RETITLE_APPLY` so the stepped-up basis is what transfers to the survivor (the reducer's `COST_BASIS` priority already lands it after position updates within the chain).

**Step 19 — Filing-status change on widowhood** [ ]
- Tax modules read `state.deceased` to switch filing status (married-joint → single) in the year after death. This is per-year-module policy work (§7 Tax row) — scope it as "tax modules consult `state.deceased`"; the actual bracket/standard-deduction changes are owned by each year's tax module, not this design.

**Step 20 — Tests** [ ]
- Extend `tests/unit/evt-person-died.test.mjs` (or a new `tests/unit/mortality-estate-basis.test.mjs`): US-resident-at-death produces a `HOLDING_SET_BASIS_APPLY` chain; AU-resident-at-death produces none; AU-resident widow inheriting from a US-resident deceased still gets the step-up (rule keys off deceased).
