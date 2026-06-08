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
| **26 Spending** | Survivor multiplier + late-life-care factor compose with whichever spending strategies are active via additive `SPENDING_STRATEGY_APPLY` deltas. |
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
