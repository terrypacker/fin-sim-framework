# 91 — The journal payload manifest: what it gates, and what it doesn't

**Status** (2026-08-13): **§3–§7 BUILT — the manifest gate is wired and authoritative.** The
`fields:` declarations now decide what reaches the journal; until §7 they decided nothing at all
(§2). `KNOWN_GAPS` is down from 31 action types to 12, and everything still pinned is a routing
key by choice (§5 Tier C). **§8 COMPLETE** — the disposal money carries currency codes,
`capital-gains-by-disposal` converts (measured first, §8.7), the AU CGT worksheet reads the
manifest instead of a private table, and the declarations are cross-checked against what the tax
modules actually do (§8.9). Along the way: the CAPITAL_GAINS family had no golden at all, so
`cross-border-disposals` was added and the coverage floor moved 45 → 51 (§8.8). One new defect is
open — collectible disposals are assessed but never disclosed on the AU CGT worksheet (§8.9).

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

## 2. The gate was not wired on the product path  (fixed in §7)

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

## 8. Typing the disposal money  ✅ COMPLETE (steps 1–4)

The one item §5 Tier A deferred: `salePrice`, `costBasis`, `proceeds`, `gain`, `mortgageBalance`
and the whole `us*`/`au*` gain family are declared `ValueType.number()` on every disposal action,
while **every other money field in the model is declared `ValueType.currency(code)`**. The
deferral was right — it changes what cross-currency reports fold — but the investigation turned
the question from "would this be nice" into "this is the third copy of a fact that has already
shipped as a bug".

### 8.1 The naming trap: `auGain` is not in AUD

The unit rule for a disposal action is:

> **Every money field is denominated in the disposing asset's currency — which is the ACTION
> TYPE's country, not the field name's prefix.**

So on `STOCK_WITHDRAWAL_TAX` (a US brokerage disposal) `auGain`, `auDiscountableGain`,
`auShortTermGain` and `auLongTermGain` are all **USD**. The `au` prefix means "measured on the AU
basis" — the s855-45 stepped-up cost base, the 12-month discount test — not "denominated in AUD".
Conversion happens in the consumer, not the emitter:

- `us-tax-module-2026.js:496` — `toAUD(auGain, 'USD', state)` on a US disposal.
- `au-tax-module-2026.js:588` — `toUSD(char.long, 'AUD', state)` on an AU disposal, with the
  comment "`gain` is in AUD here (the account's currency)".

Both sites hard-code the currency as a literal, keyed off which module is handling which action
type. The fact is real, load-bearing, and stated nowhere a machine can read it.

### 8.2 It has already cost something

`tax-document-registry.js:233` carries `AU_DISPOSAL_CURRENCY` — a hand-maintained map from
disposal action type to currency code. Its own comment says why it exists:

> *"The currency is what the old CGT schedule got wrong: `STOCK_WITHDRAWAL_TAX` carries USD
> figures (it is a US brokerage disposal) and the schedule printed them straight onto an
> AUD-denominated document, so the modal formatted USD as A\$."*

That is this exact gap, found the hard way, and patched with a private lookup table rather than
by declaring the unit where the unit belongs. The TypeRegistry is the designated home for
"what unit is this field in" — and for the disposal family it answers `number()`, meaning
"nothing".

### 8.3 The live trap: one line away from a wrong total

`CapitalGainsByDisposalDef` aggregates `proceeds` (`fn: 'sum'`) and declares **no**
`reportCurrency`, so `normalizeAggregateCurrency` returns early and nothing converts. Its
description carries the warning as prose instead: *"`proceeds` is the disposal's native-currency
contract amount and is informational only, so on a cross-border row it is NOT in the same
currency as `total`."*

The state side of the same report is already fully typed — `usCapitalGainsYTD` → USD,
`auCapitalGainsYTD` → AUD, and the per-person patterns too (`state-schema-registry.js:249+`), so
`total` (which sums `stateDelta`) would convert correctly today.

That asymmetry is the trap. Giving this report a `reportCurrency` is an obvious improvement and a
one-line change — and doing it **now** would silently corrupt the `proceeds` column, because an
undeclared money field takes `normalizeAggregateCurrency`'s `unknown` branch: counted as already
being in the target currency. A US-source proceeds figure would be added to an AUD total at face
value, wrong by the whole exchange rate, with only a console warning.

So the honest statement of the situation is not "typing would be nice". It is: **the disposal
family is the only thing standing between this report and a correct cross-currency mode, and
while it stands there it is also a live footgun for whoever tries.**

### 8.4 Scope

10 action types, ~70 fields — all currently `number()`:

| Currency | Types |
|---|---|
| USD | `STOCK_WITHDRAWAL_APPLY`, `STOCK_WITHDRAWAL_TAX`, `US_HOUSE_SALE_APPLY`, `US_HOUSE_SALE_TAX`, `COLLECTIBLE_SALE_APPLY`, `COLLECTIBLE_SALE_TAX`, `COMPANY_SALE_APPLY`, `COMPANY_SALE_TAX` |
| AUD | `AU_STOCK_WITHDRAWAL_APPLY`, `AU_STOCK_WITHDRAWAL_TAX`, `AU_HOUSE_SALE_APPLY`, `AU_HOUSE_SALE_TAX` |

Every money field on a type takes that type's code, `au*`-prefixed fields included — §8.1 is the
whole point, and typing `auGain` as AUD would be the exact error the declaration exists to
prevent.

### 8.5 The one caveat, and why it does not block

A fixed per-type code assumes a US-country asset is USD-denominated and an AU-country asset AUD.
`RealProperty` does carry an explicit `currency` descriptor that a scenario could set against
type, and `us-brokerage-classes.js` consults currency **nowhere at all**.

But that assumption is not introduced by the declaration — it is already load-bearing in both tax
modules (§8.1) and in `AU_DISPOSAL_CURRENCY` (§8.2). A declaration cannot be more wrong than the
arithmetic it describes; it makes an implicit assumption explicit and therefore testable. The
fully general alternative — stamp an explicit `currency` field on each disposal action, as
`SECTION_988_GAIN` already does — is the right answer *if* mixed-currency assets ever become real,
and it is a strictly larger change (emitter-side, every disposal path). Not now.

### 8.6 The work, in order

1. **Declare the codes** (§8.4). Inert on its own: `proceeds` is the only disposal money field any
   report aggregates, and that report declares no `reportCurrency`. Verify inertness the same way
   §7.1 did — journal payload keys are unchanged by a type change, so the check is that reports
   render identically.
2. **Give `CapitalGainsByDisposalDef` a `reportCurrency`** and delete the prose warning from its
   description. This is the change with visible output, and it needs a before/after on the report
   plus the tax-document exports that link to it.
3. **Derive `AU_DISPOSAL_CURRENCY` from the registry** rather than maintaining it. Requires
   threading a `TypeRegistry` into `TaxDocumentRegistry` / `JournalReportingService`, which today
   are constructed bare (`journal-reporting-service.js:32`) — two constructors and two call sites.
   Optional, and last: it removes the duplicate rather than fixing a defect.
4. **Pin the assumption with a test**: for each type in §8.4, the declared code equals the code its
   tax-module consumer converts from. That is what turns §8.5's caveat from a comment into a gate.

Step 1 is safe and self-contained. Step 2 is the one that changes numbers on screen and should
carry its own measurement, exactly as §7.1 did for the gate.

**Steps 1 and 2 are now built** — §8.7 has the measurement that authorised step 2. Steps 3 and 4
remain open.

### 8.7 Measured: what step 2 actually changes

Step 1 landed first (68 fields across 12 types), then step 2 was measured on three arms before
being applied:

| Arm | Meaning |
|---|---|
| **A** | today — no `reportCurrency`, nothing converts |
| **B** | proposed, with step 1 landed |
| **C** | proposed, with the disposal money still untyped — i.e. step 2 applied in the wrong order |

**`total` does not move in any arm, on any scenario.** It sums `stateDelta`, whose currency comes
from the state schema, so it was already correct. **Step 2's entire effect is the `proceeds`
column** — a pleasingly small blast radius for a change that had looked risky.

On a scenario that sells an AU property and reports in USD, the AU-denominated proceeds convert
in arm B and do not in arm A/C: measured at a **16.3% overstatement** of the proceeds total when
left unconverted. On a synthetic AU-report journal holding one USD and one AUD disposal, the
USD row's proceeds convert at the run's own rate rather than being counted at face value.

**The refinement this measurement forced.** §8.3 said applying step 2 without step 1 would
"silently corrupt" the column. That is not quite right, and the precise version is worse:
**arm C is numerically identical to arm A.** Converting an undeclared field is the identity, so
the number would not change at all — what would change is the claim about it. The report would
start declaring a currency, the honest warning in its description would be deleted as
"no longer needed", and a raw AUD figure would sit in a column labelled USD with nothing left
saying otherwise. The order of the two steps was load-bearing for the labelling, not the
arithmetic.

### 8.8 The disposal family had no golden at all

The first attempt to measure step 2 could not: the reference plan books **no AU-assessed disposal
in 44 years**, and its only disposal of any kind is a USD company-equity sale reported in USD —
nothing to convert. Checking the golden coverage manifest explained why that was not already
known: every disposal type — both house sales, both stock disposals, the collectible pair — sat
in `KNOWN_GAPS`. **The entire CAPITAL_GAINS family was scenario-unguarded**, protected only by
isolated reducer tests, while carrying the §121 proration, the AU main-residence concession, the
s855-45 basis and (as of §8.4) the currency declarations.

A new golden, `cross-border-disposals`, sells both houses and the gold collectible inside the run
and on different sides of the 2031 move, so the US house is disposed of while AU-resident and is
assessed by both returns. Six action types moved from `KNOWN_GAPS` to `COVERED` and the coverage
floor ratcheted 45 → 51.

That is the more valuable outcome of this section. The currency declarations were a real gap;
the missing golden is why nobody had noticed either that gap or the report trap in §8.3.

---

---

### 8.9 Steps 3 and 4, and what step 4 found

**Step 3 — `AU_DISPOSAL_CURRENCY` is no longer an independent opinion.**
`TaxDocumentRegistry` now takes an optional `{ typeRegistry }` and resolves a disposal's
currency through `_disposalCurrency()`, which reads the manifest first
(`fieldCurrency(type, 'proceeds')`). `JournalReportingService` forwards it;
`workbench-app` and `scripts/tax/export-tax-csv.mjs` both had a `ServiceRegistry` in hand
already, and `buildTaxWorksheetRows` takes a `typeRegistry` option for callers that build
their own service.

The map survives as the **no-registry fallback** — several callers construct the registry
bare, and a hard dependency would have turned a lookup table into a wiring problem. What
makes that safe is step 4's second test: build the same worksheet with and without a
registry and require identical output, so the fallback cannot drift back into being a
second answer.

**Step 4 — the manifest is now checked against behaviour, not against a copy of itself.**
`tests/unit/disposal-currency-declarations.test.mjs` runs every disposal type through its
real tax-module reducer with a distinctive rate and infers, from how far the watched
accumulator moved, which currency the module treated the payload as — then compares that
to the declaration. A US disposal's payload landing in `auCapitalGainsYTD` scaled by the
rate means the module read it as USD; landing 1:1 means AUD. Restating the table in the
test would have proved nothing; deriving it from behaviour is what makes the test a check.

Three supporting tests: the `au*`-on-a-US-disposal case called out by name (§8.1), the
fallback-vs-manifest agreement above, and a **detector control** — a registry that lies
about the currency must change the worksheet, or the first two would pass against a lookup
nobody reads.

#### The defect step 4 surfaced: collectible disposals never reach the AU CGT worksheet

The cross-check could not probe `COLLECTIBLE_SALE_TAX` on `proceeds`, because that type
declares none — and it declares none because **neither emitter sends one**.
`us-collectible-classes` and the gold sleeve in `us-brokerage-classes` both emit gains
only, no `proceeds`, no `costBasis`.

`_extractAuDisposals` opens with `if (!d?.proceeds) continue;`. So an AU resident who
sells gold or a collectible has the gain assessed — it feeds `auCapitalGainsYTD` and is
taxed — but the disposal **never appears as a row on the NAT 4151 worksheet**. The return
foots; the working that justifies it silently omits the asset.

`AU_DISPOSAL_CURRENCY` even carries a `COLLECTIBLE_SALE_TAX: 'USD'` entry, for a case its
own guard clause drops one line earlier. That entry has never been reachable.

Not fixed here: adding `proceeds`/`costBasis` to both collectible emitters changes what a
tax-facing document discloses, and belongs with a look at whether the 28% collectibles
rate and the AU indexation path want the same treatment. Filed as the next item.

---

## 9. Ordered steps

1. **DONE** — §4.1, §4.2, §4.3 declared; `KNOWN_GAPS` ratcheted from 31 types to 29.
2. **DONE** — §3 detector repair (bus stamp, vacuity guard, null-aware, baseline-subtracting).
3. **DONE** — Tier A declared across five toolsets; baseline 29 → 25 types.
4. **DONE** — Tier B declared across eight toolsets; baseline 25 → 12 types, Tier C only.
5. **DONE** — §6 registered six mortality types + two investment-interest deduction types that
   no toolset declared at all; §7 wired the gate and verified the diff.
6. Decide §4.4 / design 73 §6b (the `workCountry` TAX chain) with the design 73 source work.
7. **DONE** — disposal money typed (§8.4) and `capital-gains-by-disposal` given a
   `reportCurrency` (§8.6 steps 1–2), measured first at §8.7. A `cross-border-disposals` golden
   now guards the family (§8.8); coverage floor 45 → 51.
8. **DONE** — §8.6 steps 3 (the worksheet reads the manifest, fallback pinned) and 4 (declared
   codes cross-checked against tax-module behaviour), both at §8.9.
9. **Open, found by step 4**: collectible disposals emit no `proceeds`, so they are assessed
   but never disclosed on the AU CGT worksheet (§8.9). Tax-document-facing; needs its own call.
