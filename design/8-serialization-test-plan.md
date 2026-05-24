# Scenario Serialization — Test Plan & Foundation

## Why this exists

The `scenario-roundtrip.test.mjs` integration test was testing too much at once:
build a full IntlRetirementScenario → serialize → deserialize → run 3 months →
assert balances match.  When things went wrong, the failure pointed at the end
of the chain rather than the broken component.

During debugging we found three serialization bugs, each of which could have
been caught much earlier with a focused unit test:

| # | Bug | Symptom | Root cause |
|---|-----|---------|------------|
| 1 | `BaseScenario.constructor` | `initialState` silently ignored | Comma expression set `this.initialState = {}` instead of the param |
| 2 | `IntlRetirementScenario.buildSim()` | `DynamicTaxReducer` crash after restore | `currentPeriods` injected into `sim.state` but not into `this.initialState` |
| 3 | `ScenarioSerializer._serializeEvent` | `ChangeResidencyHandler` fired every month-end after restore, setting `isAuResident = true` on tick 1 | `BaseEvent.eventType` getter returns `this.constructor.name` (e.g., `'OneOffEvent'`), but serializer checked for the string `'OneOff'` — condition always false, every OneOffEvent became an EventSeries with `interval: 'month-end'` |

---

## Test pyramid

```
Level 4  Full scenario round-trip (scenario-roundtrip.test.mjs)
          ↑  already exists; depends on Levels 1–3 being correct
Level 3  Finance execution round-trip (serializer-finance-roundtrip.test.mjs)
          ↑  serialize finance handlers/reducers → run sim → assert balances
Level 2  Framework execution round-trip (serializer-framework-execution.test.mjs)
          ↑  serialize pure-framework components → run sim → assert state changes
Level 1  Component serialization unit tests (serializer-components.test.mjs)
          ↑  just serialize/deserialize each component type, assert field parity
```

Each level has a single job.  Bugs at Level 1 cause failures at Level 1, not
at Level 4 where they are hard to diagnose.

---

## Level 1 — Component serialization (no simulation)

**File:** `tests/unit/serializer-components.test.mjs`

Covers every `_serializeX` / `_makeX` pair in `ScenarioSerializer`.

### Events
- `EventSeries` round-trip: all fields (`id`, `name`, `type`, `interval`, `startOffset`, `enabled`, `color`) are identical after serialize → deserialize.
- `OneOffEvent` round-trip: `__type` is `'OneOffEvent'` (not `'EventSeries'`), `date` ISO string is preserved, `interval` is absent.

### Actions
- `AmountAction`, `FieldAction`, `FieldValueAction`, `ScriptedAction`: each produces the right `__type` and all fields are restored correctly.

### Handlers (framework)
- `HandlerEntry` (generic): `id`, `name`, `handledEventIds`, `generatedActionTypes` all round-trip.

### Reducers (framework)
- `FieldReducer`, `NumericSumReducer`, `ArrayReducer`, `MultiplicativeReducer`, `NoOpReducer`, `ScriptedReducer`, `MetricReducer`, `BalanceSnapshotReducer`: each produces the right `__type` and all fields round-trip.

---

## Level 2 — Framework execution round-trip

**File:** `tests/unit/serializer-framework-execution.test.mjs`

Builds a minimal scenario with *only* framework-level components (no finance
domain), serializes it, restores it into a fresh `BaseScenario`, runs the
simulation, and asserts that state changes match.

### Tests

1. **EventSeries + HandlerEntry + NumericSumReducer**
   - Event fires every month-end.
   - Handler generates `CREDIT` actions with amount 1000.
   - Reducer accumulates into `state.total`.
   - After 3 months: `state.total === 3000` in both original and restored.

2. **OneOffEvent fires exactly once**
   - A OneOffEvent is wired to set `state.fired = true`.
   - Before the target date: `state.fired === false`.
   - After the target date: `state.fired === true`.
   - After round-trip: same behaviour — event fires exactly once on the correct date.

3. **ScriptedReducer state mutation survives round-trip**
   - A ScriptedReducer sets `state.x = action.value * 2`.
   - After round-trip, the multiplier is still 2.

---

## Level 3 — Finance execution round-trip

**File:** `tests/unit/serializer-finance-roundtrip.test.mjs`

Uses real finance handlers and reducers but builds them directly (not via
`IntlRetirementScenario`) so each test covers one concern.

### Tests

1. **`isAuResident` stays false after round-trip** *(regression for Bug 3)*
   - Build a scenario that includes a `ChangeResidencyHandler` wired to a
     OneOffEvent dated 2031-07-01.
   - Serialize, restore, run to 2026-03-31.
   - Assert `sim.state.isAuResident === false`.

2. **`MonthlyExpensesHandler` debits `usSavingsAccount` when not AU resident**
   - Build scenario: US savings account at $30k, `MonthlyExpensesHandler`
     ($6k/month), `ExpenseDebitReducer`.
   - After 3 months: `usSavingsAccount.balance === 12000` (30k − 3×6k).
   - After round-trip: same result.

3. **Account `stateKey` round-trip**
   - Serialize an account with `stateKey = 'usSavingsAccount'`.
   - Deserialize and assert `account.stateKey === 'usSavingsAccount'`.

4. **`UsSavingsInterestMonthlyHandler` round-trip**
   - US savings account at $12k, interest rate 3%.
   - After 3 months: balance matches expected.
   - After round-trip: identical result.

---

## Level 4 — Full scenario round-trip

**File:** `tests/unit/scenario-roundtrip.test.mjs` (already exists)

These tests only need to pass once Levels 1–3 are green.  No new tests at this
level unless a full-scenario regression is found that can't be caught at a
lower level.

---

## Implementation order

1. Fix the known bugs (serializer event-type check, etc.)
2. Write Level 1 tests → run → they pass (or reveal new serializer bugs)
3. Write Level 2 tests → run → they pass
4. Write Level 3 tests → run → they pass
5. Run Level 4 (existing) → should now pass

---

## Known issue for Level 1 — `initialState` with Account instances

`InternationalRetirementFinancialState.toPlain()` returns enumerable own
properties including live Account instances (e.g., `usSavingsAccount`).
`ScenarioSerializer.serialize()` passes `initialState` through as-is.
`Simulation` then calls `structuredClone(initialState)` which strips class
prototypes (Account → plain object).

This is intentional: the simulation treats state as a plain data bag.
The account service independently holds the live Account instances for
transaction logic.  `ExpenseDebitReducer.reduce()` reads `state[accountKey]`
to get the balance but calls `accountService.transaction()` to mutate the
authoritative object.

The `initialState` stored in the serialized config therefore contains Account-
shaped plain objects (after structuredClone) — not the live instances.  Tests
at Level 3+ must account for this: assert `sim.state.usSavingsAccount.balance`
(plain object in state), not the Account instance in accountService.
