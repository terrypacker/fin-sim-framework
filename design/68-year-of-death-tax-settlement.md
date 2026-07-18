# 68 — Year-of-death tax settlement fidelity

**Status**: **Gap 1 IMPLEMENTED + green** (3625 unit + 875 viz). Gaps 2–5 documented only,
deferred. Verified end-to-end on `scenarios/fin-sim-scenarios.json`: Terry dies 2068-04-15,
and the 30 Jun 2068 AU settle now files his final-year return (`primary ≈ $90k`) and debits
it, where before it was dropped. Golden (default scenario) legitimately unmoved — its death
falls in US-resident years with no AU income, so the fix is inert there.

**Problem in one line:** When a person dies partway through a tax year, the tax that
accrued on their income *during that final partial year* can silently vanish instead of
being filed and debited from the (now survivor-owned) accounts.

**Origin:** Found while reviewing what mortality (`design/27`) misses. Reproduced in the
`scenarios/fin-sim-scenarios.json` default: Primary **Terry** dies at 90 in 2068. **No AU
tax is filed for Terry on 30 Jun 2068**, yet US tax files **jointly** on 31 Dec 2068 and
**single** on 31 Dec 2069. The asymmetry between the AU and US outcomes is the tell.

**Related designs:** `design/27` (mortality & survivor mechanics — §7 Tax row and Step 19
are the touch points), `design/52` (cross-border relief — per-person AU apportionment),
`design/63` (inheritance — the estate/bequest consumer of any stranded liability).

---

## 1. Background — how the two settles differ

Both countries settle annually via an `EventSeries` scheduled at boot (`TaxService.getContributions`):

| Country | Settle date | Accumulation model | Compute path |
|---|---|---|---|
| **US** | 31 Dec | **Household scalars** (`usOrdinaryIncomeYTD`, …) | `computeUsTax(state)` |
| **AU** | 30 Jun | **Per-person maps** (`auPersonOrdinaryIncomeYTD[key]`, …) + shared-pool fallback | `computeAuTaxPerPerson(state)` |

The death chain (`MortalityHandler` → `PersonDiedApplyReducer`,
`src/finance/reducers/person-died-apply-reducer.js:37`) removes the deceased from
`state.people` **immediately** when `PERSON_DIED` fires. Nothing else about their accrued
tax state is touched: their per-person AU accumulators still hold the income earned from the
start of the fiscal year up to the moment of death.

---

## 2. The bug (Gap 1) — AU per-person final return is dropped and then wiped

### 2.1 Mechanism

`computeAuTaxPerPerson` iterates **`state.people`**
(`src/finance/tax-settle-service.js:110-111`):

```js
const people = state.people ?? {};
const residents = Object.entries(people).filter(([, p]) => p != null);
const numResidents = Math.max(1, residents.length);
```

If the deceased died **before** the 30 Jun settle, they are already absent from
`state.people`. So:

1. **Their final return is never computed.** The settle loop only visits surviving keys.
   `auPersonOrdinaryIncomeYTD[deceased]` (plus franking credits, super tax, discountable
   gains, …) accrued for the partial year is never read.
2. **Then it is zeroed without being taxed.** `TaxSettleApplyReducerBase.reduce`
   (`src/finance/tax/tax-settle-classes.js:165-171`) resets **every** key in each
   per-person map — including the deceased's — to zero:
   ```js
   resets[field] = Object.fromEntries(Object.keys(state[field]).map(k => [k, 0]));
   ```
   The accrued liability disappears; it does **not** shift to the survivor.

3. **Survivor's own death-year return is distorted too.** `numResidents` drops 2→1 the
   moment the death is applied, so any household shared-pool AU income for that fiscal year
   is now apportioned 100% to the survivor instead of split — even for income earned while
   both were alive.

### 2.2 Why US looks correct

US settles on **household scalars**, which still contain the deceased's income, so the
31 Dec return captures it. `usFilingSingle` only flips at the *next* `US_PERIOD_ADVANCE`
(1 Jan, `src/finance/tax/period-advance-classes.js:49`), so:

- 31 Dec 2068 → still joint (death occurred mid-2068, flag flips 1 Jan 2069)
- 31 Dec 2069 → single

Exactly the observed behavior. The US correctness is **incidental** to the household-scalar
model, not a deliberate final-return rule.

### 2.3 Repro

Default scenario, mortality enabled, Terry dies mid-2068 (before 30 Jun). Observe the
journal: an `AU_TAX_SETTLE_APPLY` fires 30 Jun 2068 but produces no `taxDetail` entry for
Terry and no incremental `AU_TAX_PAYMENT_DEBIT` for his share; his per-person buckets read
zero afterward.

### 2.4 Fix (Gap 1 — IMPLEMENTED)

Make the AU settle file a return for **anyone who was AU-resident during this fiscal year**,
not just those still in `state.people`. Implemented in `computeAuTaxPerPerson`
(`src/finance/tax-settle-service.js`) with a two-signal resident-of-the-year set:

1. **Living residents** — `state.people` keys (unchanged).
2. **Non-zero per-person AU balance** — catches income already migrated to the per-person
   maps (design 52/55). Field list `AU_PER_PERSON_INCOME_FIELDS` (income/gains/withholding/
   super; franking-credit and earned-income views excluded — a credit or duplicate view is
   not a standalone reason to file).
3. **AU-resident death dated inside the current AU period** — catches income that only ever
   lived in the shared pool (no per-person attribution), and keeps `numResidents` correct so
   the survivor's shared-pool split is unchanged from the pre-death allocation.

Signals 2 and 3 are independent so both the migrated-income and shared-pool-only cases are
covered. Prior-year deaths are excluded automatically (their per-person maps were zeroed at
their own settle, and their death date is outside the current period), so they don't dilute
`numResidents`.

For a deceased filer, `name` and `incomeSupportRecipient` (the Age Pension / JobSeeker CGT
exemption, design 57 §6.6) are now **captured into `state.deceased[key]` at death**: the
`MortalityHandler` carries them on `PERSON_DIED_APPLY` and `PersonDiedApplyReducer` stores
them — they'd otherwise be lost when the person is removed from `state.people`. The settle
resolves the person object from `state.people[key] ?? state.deceased[key]`.

The `AuTaxSettleHandler` per-person guard needed no change: the deceased's key is still
present (non-zero) in `auPersonOrdinaryIncomeYTD` at settle time, so per-person mode already
engages. The resulting `AU_TAX_PAYMENT_DEBIT` draws from AU cash / (now survivor-owned)
accounts via the existing `AuTaxPaymentDebitReducer` path — the liability correctly lands on
the estate the survivor inherited.

**Tests:** `tests/unit/mortality-year-of-death-tax.test.mjs` (YOD-1..4) — death-capture of
name/flag; deceased income-holder gets a taxed final return; `numResidents` preserves the
survivor's shared-pool split; Age Pension exemption survives via `state.deceased`.
`tests/unit/reducer-postconditions-finance.test.mjs` updated for the enriched `deceased`
record shape.

---

## 3. Deferred gaps (documented only — no implementation planned yet)

### Gap 2 — Last-survivor termination strands the entire final year's tax (both countries)

When the last person dies, `ScenarioCompleteReducer` sets `state.scenarioComplete` and the
run loop **breaks** (`src/simulation-framework/simulation.js:1022`). Any tax settle queued
later that year — **AU and US both** — never fires. Ending net worth / bequest omits the
final year's accrued tax liability entirely. This is the same class of defect as Gap 1 but
hits both countries and lands on the *terminal snapshot* that results are read from.

Options: (a) before breaking, flush any pending same-year `TAX_SETTLE_*` events (a "final
settle" pass); (b) accrue a closing tax liability into net worth at termination; (c) accept
and document as a known terminal-state simplification. Interacts with `design/63` (the
bequest is the natural owner of the closing liability).

### Gap 3 — No date-of-death (final) return

Neither system files a partial-year return *at the death date*; both wait for year-end. Real
US and AU practice files a final return covering income to date of death, with the liability
on the estate. Gap 1 approximates this at year-end for AU; a true date-of-death return is a
larger change and probably unnecessary given the annual granularity.

### Gap 4 — AU super death-benefit tax not applied on intra-household death

`SUPER_DEATH_BENEFIT_TAX` exists only on the external-decedent path
(`src/finance/account-rules/inheritance-classes.js:111`, `design/63`). A spouse's super is
retitled via `AccountRetitleApplyReducer` (ownerId swap) with no death-benefit handling.
Spouse-to-spouse super is tax-free in AU, so this is *correct by luck*, not by design —
worth wiring deliberately when `design/63` lands so non-dependent beneficiaries are handled.

### Gap 5 — Deceased's per-person accumulator keys are never cleaned up

`PersonDiedApplyReducer` deletes from `state.people` but leaves the deceased's keys in every
per-person AU map. They linger until zeroed at the next settle. Cosmetic once Gap 1 is
fixed (the fix taxes them first), but any post-death income mis-attributed to a deceased key
is otherwise silently dropped. A tidy-up pass (or folding into the Gap 1 union logic) closes
it.

---

## 4. Summary table

| Gap | Symptom | Scope | Status |
|---|---|---|---|
| **1** | AU per-person final return dropped + wiped; survivor split distorted | AU death-year settle | **IMPLEMENTED + green** |
| **2** | Last-survivor death strands the whole final year's AU+US tax | Terminal snapshot | Deferred |
| **3** | No date-of-death final return (annual granularity only) | Both | Deferred / likely won't do |
| **4** | Super death-benefit tax not applied spouse-to-spouse (correct by luck) | AU super | Deferred (with `design/63`) |
| **5** | Deceased's per-person accumulator keys linger, can drop post-death income | AU maps | Deferred (folds into Gap 1) |
