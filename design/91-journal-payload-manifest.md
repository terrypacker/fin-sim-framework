# 91 — The journal payload manifest: what it gates, and what it doesn't

**Status** (2026-08-13): **§3–§7 BUILT — the gate is now wired and the manifest is
authoritative.** §3, §4 and §5 (Tiers A and B) landed first — three payload gaps closed,
the burn-down finished, drift detector repaired. `KNOWN_GAPS` is down from 31 action types to 12,
and everything still pinned is a routing key (Tier C, deliberate). **§2 is a finding with an open
decision** — the manifest gate is not wired on the product path, and turning it on is a data-shape
change that should not ride along with a field declaration. §5.1 explains why the burn-down is the
preparation step for that decision rather than independent of it.

Follows the manifest-drift work that added the static emitter scan to
`tests/unit/action-payload-schema.test.mjs` and pinned 31 action types in `KNOWN_GAPS`. That
work left one flagged item — `US_TAX_SETTLE_APPLY.usTaxPaidOnUsSourceAud`, the design 83 FTC
input — plus the standing question of which of the other ~60 pinned fields are real gaps
rather than reducer plumbing. Answering that turned up something larger.

---

## 1. What a `fields:` declaration is supposed to do

A toolset declares an action's payload:

```text
{ type: 'US_TAX_SETTLE_APPLY', fields: { tax: ValueType.number(), ...  } }
```

`TypeRegistry.pickPayload` keeps **only** declared fields, so the declaration decides three
things at once:

1. **Presence** — what lands in `entry.action.data` in the journal, and therefore what any
   design 71 report or tax document can read.
2. **Unit** — `ValueType.currency('AUD')` is what `report-currency.js` reads to convert a row
   before folding it into a cross-currency total. An undeclared money field is summed as
   though it were already in the report's currency (the `unknown` branch), which is the
   defect that report was built to close.
3. **Meaning** — the manifest is the only machine-readable statement of what an action
   carries. Reducers read the raw action and never consult it.

Reducers are unaffected either way: they receive the whole dispatched action. That is what
makes an undeclared field cost nothing arithmetically and everything reportorially.

---

## 2. The gate is not wired on the product path

`Simulation._pickPayload` resolves the registry through the **sim's own bus**:

```text
_pickPayload(action) {
  const reg = this.bus.serviceRegistry?.typeRegistry;   // simulation.js:271
  if (reg) return reg.pickPayload(action);
  return _heuristicPickPayload(action);
}
```

`ServiceRegistry` stamps `serviceRegistry` onto **its** bus (`service-registry.js:60`). But
`BaseScenario.buildSim` deliberately gives each simulation a private `new EventBus()` so
per-run telemetry dies with the run (`base-scenario.js:339`). Nothing stamps that bus.

So on every path that builds a sim through `BaseScenario` — the app, the studies, the tests —
`sim.bus.serviceRegistry` is `undefined` and **every journal payload comes from
`_heuristicPickPayload`**, which keeps every non-null, non-underscore field regardless of the
manifest.

Three consequences, and they are not the ones the `KNOWN_GAPS` comment assumed:

- **Undeclared fields are not missing from the journal.** They are present and *untyped*. The
  harm is the unit (§1.2) and the absent contract, not a blank column.
- **Declared-but-never-emitted fields are pure fiction.** Nothing fills them, and nothing
  drops them either; they simply do not exist in any payload.
- **The manifest's presence gate has never actually run in production.** Turning it on would
  *remove* fields from journal payloads app-wide — precisely the fields `KNOWN_GAPS` pins. That
  set was ~60 when this was written; §5 has since cut it to 16, all routing keys.

### 2.1 The decision — resolved in §7

Wiring is one line, but it had to land **after** §5's triage: flipping it first would silently
delete every pinned field from every journal, including ones a report might quietly depend on
via the heuristic. The sequence ran:

1. Triage `KNOWN_GAPS` (§5) and declare everything a report should keep.  ✅ DONE
2. Register the types that were declared **nowhere** (§6).  ✅ DONE
3. Wire the gate and diff the journals (§7).  ✅ DONE

Everything below §2 is written in the past tense for that reason: the gate is live.

---

## 3. The drift detector was reporting on nothing (fixed)

The dynamic pass of `action-payload-schema.test.mjs` builds a `DriftDetectorRegistry`,
installs it on the `ServiceRegistry`, runs a 2-year scenario, and asserts over what it
intercepted. Because of §2 it intercepted **zero actions** — `_pickPayload` fell through to
the heuristic every time, and both dynamic assertions passed over an empty set. The header
comment describing pass 1 as "sees actions however they were built" described an intent, not
a behaviour, from the day it was written.

Fixed in the test harness:

- `getDetector()` stamps `sim.bus.serviceRegistry` so the manifest gate is live **for that
  test only**. The 2-year run now exercises ~35 distinct action types through the detector.
- A guard test asserts the interception count against a floor, so the same silence cannot
  return unnoticed.
- The detector no longer skips **null-valued** undeclared keys. A null costs nothing today,
  but the key is part of the action's shape and carries data in another run — that skip is
  half of why §4.3 hid.
- `definitionId` / `timestamp` join the framework-field ignore list: every
  `SimGraphNode`-derived action class carries them, and they are instance plumbing.
- The dynamic pass now subtracts `KNOWN_GAPS`, so it reports only what the static pass
  cannot see (types chosen through a variable, payloads built by spread) instead of
  duplicating the pinned baseline.

---

## 4. Gaps closed

### 4.1 `US_TAX_SETTLE_APPLY.usTaxPaidOnUsSourceAud` — the design 83 FTC input

The AUD restatement of US tax attributable to US-source income, computed at the US settle
(with the treaty dividend/interest ceiling applied) and consumed a fiscal year later by the AU
settle as the FITO input. Declared `ValueType.currency('AUD')` — deliberately AUD, because it
is already converted at the settle-date rate and a missing declaration would let
report-currency read it as USD. An FTC/FITO reconciliation can now be drilled from the
journal.

### 4.2 `COLLECTIBLE_VALUE_CHANGE_APPLY` — a manifest that named the wrong field

The manifest declared `amount`. `CollectibleValueChangeHandler` emits `change` and
`stateKey`, and the reducer reads `action.change`. So the declared field was never sent and
the sent field was never declared: under the manifest gate this action's payload would be
**empty** — a revaluation that moved a collectible's value with no record of by how much or
which one. Now declares `change` (USD) and `stateKey`, and the phantom `amount` is gone.

This is a class the static pass structurally cannot see, because it only looks for emitted
keys that are undeclared, never declared keys that are never emitted. The one-off inverse
scan that found it is worth re-running when a manifest is edited; making it a standing test
is noisy (many actions are built dynamically), so it stays a tool, not a gate.

### 4.3 `workCountry` on the four income apply types

Where employment is **exercised** (design 73 Gap 1). `MonthlyWagesHandler` stamps it on every
wage/SE apply action; `au-tax-module-2026` reads it to decide whether a wage is AU-sourced,
and source decides FEIE and §904 basketing. It was declared on **none** of
`WAGES_INCOME_APPLY`, `AU_WAGES_INCOME_APPLY`, `SE_INCOME_US_APPLY`, `SE_INCOME_AU_APPLY`, or
`AU_WAGES_INCOME_TAX` — so a "wages by source country" drill would have reported every wage
as domestic.

Both detector passes were blind to it, which is why it survived the last sweep:

- the **static** pass needs a string-literal `type:`, and the handler picks the action type
  through a variable (`applyType`);
- the **dynamic** pass skipped null values, and `workCountry` falls back to an unset
  `residency` in the reference plan.

Now declared on all five. §3's null-aware detector would catch the next one of its kind.

### 4.4 Left open, deliberately: the TAX chain drops `workCountry`

`AuWagesIncomeApplyReducer` forwards `workCountry` to `AU_WAGES_INCOME_TAX`. The three
siblings — `WagesIncomeApplyReducer`, `SeIncomeUsApplyReducer`, `AuSeIncomeApplyReducer` —
do not, so the field stops at the apply action on the US side and on both SE paths. Whether
that matters is a **tax question, not a reporting one** (US sourcing of earned income under
§861/§911 turns on where services are performed), so it is not something to fix silently
inside a manifest change. Written up as **design 73 §6b**, which ranks the three questions it
raises — the AU self-employment path is the one most likely to be a real defect.

---

## 5. The remaining baseline, triaged

25 types remain pinned after Tier A. The useful split is not "bug vs. plumbing" but **"is the
fact this field carries recoverable from the journal without it?"**

### Tier A — declared  ✅ DONE

| Field | Types | Why |
|---|---|---|
| `mortgageBalance` | `AU_HOUSE_SALE_APPLY`, `US_HOUSE_SALE_APPLY` | Money. It is the whole bridge from sale price to net proceeds; nothing else on the row states it. |
| `ownerId` / `owners` / `ownershipType` | `AU_HOUSE_SALE_APPLY`, `AU_RENTAL_INCOME_TAX` | Design 76 per-person attribution. The same three are already declared on five sibling `*_TAX` types — these two were the omissions, not the rule. |
| `personId` | `EXPENSE_EVENT_APPLY` | Design 89 spending-by-person. Declared on the `LATE_LIFE_CARE_APPLY` sibling. |
| `holdingId` | `SECTION_988_GAIN` | The §988 audit trail identifies the position a gain came from; `accountKey` alone cannot when a ladder holds many, each with its own `fxBasisRate`. |
| `cashDue` | `LOAN_PAYMENT_APPLY` | Money, and NOT `payment`: `payment` is in the loan's currency, `cashDue` in the paying account's. Already declared on `PROPERTY_PURCHASE_APPLY`. |
| `change` on a value-change action | (closed in §4.2) | — |

Two things the work turned up:

**Every new money field is declared `number()`, not `currency(code)`** — even where the code is
unambiguous (`mortgageBalance` on an AU sale is AUD). The disposal money fields around it
(`salePrice`, `costBasis`, `proceeds`) are deliberately native and unconverted:
`CapitalGainsByDisposalDef`'s own description states that `proceeds` "is NOT in the same currency
as `total`" on a cross-border row. Typing one field of a row and not its siblings would convert
half a row, which is worse than a documented mixed unit. **Typing the whole disposal money set is
a separate decision** — it changes what existing cross-currency reports fold, and it should be
made deliberately with a report diff, not as a side effect of adding a field. `cashDue` stays
`number()` for a different reason: `LOAN_PAYMENT_APPLY` is `cc: null` and settles loans in either
currency, so no single code is right for it.

**`SECTION_988_GAIN` is declared in THREE toolsets, not two.** Both real-property toolsets say so
in their comments; `us-au-cross-border-toolset.js` carries a third copy that neither mentions.
The "shared action types declare identical fields" test caught it immediately — exactly the
last-writer-wins hazard it was written for. All three now agree.

### Tier B — declared  ✅ DONE

| Field | Types | Argument |
|---|---|---|
| `residency` | 11 apply types | Declared on 53 types already, and duplicated by the chained `*_TAX` action — but see §5.1: it is one of the few payload fields `_project` lifts onto report rows, which makes declaring it protective rather than cosmetic. |
| `penaltyAmount` | 4 withdrawal apply types | The §72(t) penalty. Its paired `*_TAX` type declares it in every case, and `ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY` already declared it on the apply side — the family was internally inconsistent, and now is not. |
| `blocked` | both `SUPER_WITHDRAWAL_*_APPLY` | A withdrawal preservation rules refused. It is the only record the attempt happened: a refused withdrawal moves no state, so there is no diff to infer it from. |
| `stateKey` | 4 apply types | Duplicated by the per-diff row's own `stateKey` for anything that moved state — but not for an action that moved none. |
| `direction` | `INTL_TRANSFER_APPLY` | `targetDeficit` alone does not say which way the money went. Already declared on the `INTL_TRANSFER_RECORD` marker. |
| `inheritanceDateMs`, `purchaseMs` | `INHERIT_APPLY`, `PROPERTY_PURCHASE_APPLY` | Dates the journal entry's own date usually equals, but not when an event backdates. Both seed a clock — IRD 10-year, CGT acquisition. |

### 5.1 Why Tier B could be taken in one pass

The question was whether declaring a field can break anything. It cannot, and the reason is
worth recording because it also bounds what declaring *achieves*:

- **`JournalDataSource._project` is an allowlist** (`journal-data-source.js:121`). A report row
  carries a fixed set of payload fields — `amount`, `proceeds`, `costBasis`, `gain`,
  `isLongTerm`, `residency`, `description`, `personKey`, `escalated`, `cc` — and nothing else.
  Declaring a field does not put it on a row, so no existing report, filter, grouping or export
  changes. (A field must be declared **and** projected to become queryable; that is the same
  two-step the `escalated` flag needed.)
- **No `stateKey` collision.** Per-diff rows set `stateKey` from the state diff. A payload
  `stateKey` is never projected, so it cannot shadow it — the concern that would have made this
  tier risky does not exist.
- **The only other reader of field metadata** is `report-currency`'s `fieldCurrency`, which acts
  on `currency()`-typed fields a report aggregates. Every Tier B field is text/number/boolean,
  so it is inert there. (`penaltyAmount` is money but is declared `number()`, matching all four
  `*_TAX` siblings.)
- **`residency` is the one that is actively protective.** It *is* in the `_project` allowlist,
  so once the gate is wired (§2.1) an undeclared `residency` on those apply actions would be
  dropped and `row.residency` would silently go null. Declaring it now is what makes that flip
  a no-op for those rows.

That last point generalises: **declaring is the conservative direction with respect to §2.1.**
Every field declared before the gate is wired is a field whose current behaviour survives the
flip. The burn-down is therefore not just tidying — it is the preparation step for §2.1.

### Tier C — keep pinned (routing keys)

`cashKey`, `dstKey`, `srcKey`, `iraKey`, `rothKey`, `k401Key`, `destinationKey`, `fx`. These
name the state path a reducer should touch, or the rate it used to get there. Every one of
them is recoverable from the state diffs on the same journal entry, which is where a report
should read it from. Declaring them would put the plumbing in the report's field list without
adding a fact.

This is now the **whole** of `KNOWN_GAPS`: 12 action types, 16 fields, all routing keys. The
pin is stronger for it — a new entry can no longer be waved through as "probably plumbing",
because plumbing is all that is left. It has to argue for itself.

---

## 6. Types declared nowhere at all  ✅ DONE

Preparing for §7 meant measuring the flip first, which is what
`scripts/probes/probe-payload-gate-diff.mjs` does: it runs the full 44-year reference plan and
reports, per action type, what the manifest would drop. The first run found something the
`KNOWN_GAPS` framing had no slot for — **eight action types registered in no toolset at all**.

An unregistered type is a worse failure than an undeclared field. It does not lose fields; it
takes a different branch entirely, `TypeRegistry._fallbackPayload`, which keeps everything
permissively **and throws under `setStrict(true)`**. Wiring the gate on a strict run would have
killed the simulation the first time one fired.

| Types | Why nothing caught them |
|---|---|
| `PERSON_DIED_APPLY`, `ACCOUNT_RETITLE_APPLY`, `SOCIAL_SECURITY_SURVIVOR_APPLY`, `SPENDING_STRATEGY_APPLY`, `SUPER_DEATH_BENEFIT_APPLY`, `SCENARIO_COMPLETE_CHECK` | The whole mortality family. The static scan only inspects types some toolset already declares, so an entirely unregistered type is invisible to it *by construction*; the dynamic pass runs 2 years, and nobody dies. |
| `US_INVESTMENT_INTEREST_DEDUCTION`, `AU_INVESTMENT_INTEREST_DEDUCTION` | Design 86 G3. Emitted only when a loan sets `deductibleFraction`, which the reference plan never does — so even the 44-year probe did not see them fire. Found by reading the wiring instead of the run. |

All eight are now declared: the mortality family in both retirement toolsets, the deductions in
both real-property toolsets.

### 6.1 The guard that would have caught them

Both existing passes are run-shaped, and no run is long enough to prove a negative. But handlers
and reducers already state their own action types — `generatedActionTypes` and
`reducedActionTypes` — so a **third pass reads the wiring**: every type any wired handler or
reducer names must be registered. It found the deduction pair immediately, which no length of
run had.

One deliberate exclusion, and it is a genuine finding rather than a suppression:
**`RECORD_FIELD_VALUE` is a label, not an action type.** `FieldValueAction`'s first constructor
argument *is* the type, and every caller passes a per-metric string — `wages_p1`,
`us_rental_income`, `k401_annual_rmd_<owner>`. The emitted set is unbounded, so no manifest can
enumerate it, yet two dozen handlers list `RECORD_FIELD_VALUE` in `generatedActionTypes` as if it
were the type they emit. The 44-year probe confirms none of these ever reach `pickPayload`, so
they cannot trip the strict-mode throw; the exclusion is documented at the test.

---

## 7. Wiring the gate  ✅ DONE

`Simulation._pickPayload` now resolves `opts.typeRegistry` first and falls back to
`bus.serviceRegistry?.typeRegistry`, and `BaseScenario.buildSim` passes
`this.context.typeRegistry`. Explicit hand-off rather than stamping the sim's bus: that bus is
private to the run *by design* (per-run telemetry dies with it), and quietly giving it a
back-reference to the shared registry would trade one confusion for another.

### 7.1 What actually changed, measured

The reference plan run twice — gate on, gate suppressed — with every journal payload key
compared across **29,245 entries over 44 years**:

- **Terminal net worth identical**, entry count identical. The gate is an observation change,
  not a computation one.
- **56 field/type pairs removed, and all but two are `siblingIndex`, `data` or `meta`** —
  framework fields the heuristic was leaking into payloads. `Simulation._FRAMEWORK_FIELDS`
  lists only `id/type/name/kind/layer`, while `TypeRegistry.FRAMEWORK_FIELDS` also excludes
  `siblingIndex/data/meta`; the gate simply applies the stricter list. Nothing reads them
  (no `.data.data` anywhere in `src/` or `tests/`).
- **The only domain fields dropped were `K401_TO_IRA_CONVERSION_APPLY.iraKey` and
  `.k401Key`, on two entries** — Tier C routing keys, pinned deliberately.

So the flip cost nothing and the burn-down is why. §5.1 predicted a no-op for the projected set;
the measurement is that prediction confirmed rather than assumed.

### 7.2 What is now true that was not

The manifest is authoritative: a `fields:` block decides what reaches the journal, and an
undeclared field is genuinely absent rather than merely untyped. That makes every guarantee in
§1 real for the first time — including the currency declarations, which now describe payloads
that actually exist as declared.

---

## 8. Ordered steps

1. **DONE** — §4.1, §4.2, §4.3 declared; `KNOWN_GAPS` ratcheted from 31 types to 29.
2. **DONE** — §3 detector repair (bus stamp, vacuity guard, null-aware, baseline-subtracting).
3. **DONE** — Tier A declared across five toolsets; baseline 29 → 25 types.
4. **DONE** — Tier B declared across eight toolsets; baseline 25 → 12 types, Tier C only.
5. **DONE** — §6 registered six mortality types + two investment-interest deduction types that
   no toolset declared at all; §7 wired the gate and verified the diff.
6. Decide §4.4 / design 73 §6b (the `workCountry` TAX chain) with the design 73 source work.
7. Separately: decide whether the disposal money set should carry real currency codes (§5
   Tier A note). Report-affecting; needs its own diff. **Still open — the only item left.**
