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

- Which actuarial table (CDC 2024 vs. SSA vs. AU lifetables) is the default per country?
- Does the survivor multiplier interact with `discretionarySharePct` from design 26, or override the whole household expense?
- How does account retitling interact with the design 25 holdings model — does the surviving spouse's inherited holdings carry stepped-up basis (a `HOLDING_SET_BASIS` chain at death)?
- Is `simEnd` redundant once MC lifespans drive termination? (Probably not — but worth deciding.)
