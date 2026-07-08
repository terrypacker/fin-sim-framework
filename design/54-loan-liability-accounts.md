# 54 — Loan (liability) accounts + offset re-targeting

**Status**: **IMPLEMENTED** — all 3 phases complete and green on branch
`wip/accounts-and-loans` (P1 `d1e9464`/`888adca`, P2 `6886590`, P3 `f9e4b75`). Phase 3
(offset re-target) was **co-implemented with design 53 Q3/Phase 3** — see §9 per-phase status.

Phase 1 landed: `LoanAccount` (liability, `ACCOUNT_TYPE.LOAN`, `US_LOAN`/`AU_LOAN` roles),
the `LOAN_PAYMENT` handler+reducer (interest/principal split + negative-amort flag),
net-worth/after-tax liability branches, drawdown/replenish exclusion, serializer +
schema-registry wiring, and `tests/unit/evt-loan.test.mjs`. Also fixed a design-53-§2
serializer regression (brokerage `loanBalance` was gated on the now-absent
`contributionBasis`).

Promote a mortgage from three scalar fields on `RealProperty` to a first-class **Loan**
account: a *liability* that accrues real interest each period and amortizes into interest
vs principal. This is the foundation that (a) makes design 53's offset account bite on
**owner-occupied** loans, not just the rental deductible-interest line, (b) enables a true
interest/principal split, and (c) lets non-property loans (car, student, personal) exist
at all.

**Builds on**:
- `design/53-account-basis-refactor-and-offset.md` §3 — the asset-side `OffsetAccount`
  and the `offsetBalanceForProperty` helper. This doc **re-targets** the offset link from a
  property to a Loan account.
- `RealProperty` scalar mortgage fields — `mortgageBalance`, `monthlyMortgage`,
  `mortgageInterestRate` (`real-property.js:68-85`).
- `mortgage-payment-classes.js` — today's payment flow (`mortgageBalance -= payment`,
  no interest split, `:117`).
- `rental-income-classes.js` — the one interest surface today,
  `deductibleInterest = mortgageBalance × rate / 12` (`:57`).
- `net-worth.js` / `after-tax.js` — the `value − mortgageBalance` property-equity lines
  (`net-worth.js:38`, `after-tax.js:266`).

---

## 1. Problem — the loan is a scalar, not an account

A mortgage today is three fields on `RealProperty`. That has four consequences:

1. **No interest accrual.** Amortization is `mortgageBalance -= payment`
   (`mortgage-payment-classes.js:117`) — the payment never splits into interest and
   principal, and the balance never *grows* with accrued interest.
2. **No owner-occupied interest line.** Interest is computed in exactly one place — the
   rental deductible-interest line (`rental-income-classes.js:57`). An owner-occupied loan
   has no interest-cost line, so design 53's offset (§3.2) has nothing to reduce and no
   cash-flow effect.
3. **No standalone loans.** A car / student / personal loan with no backing property
   cannot be represented — the mortgage fields only exist on `RealProperty`.
4. **Loan entangled with property.** One property = one implicit mortgage; you can't model
   two loans on a property, or a loan that outlives/precedes the property.

---

## 2. Concept — Loan is a liability; Offset is its linked asset

The real-world structure (and the AU offset structure specifically):

- A **Loan** is a *liability*: outstanding principal you owe, that accrues interest and is
  paid down.
- An **offset account** is a separate *asset*: your own liquid cash, which *suppresses* the
  loan's interest without paying it down. The two coexist — you hold both at once, and the
  offset account links to the **loan**, not to the property.

So this doc adds a `LoanAccount` (liability) and **re-targets** 53's `OffsetAccount` from
`offsetsPropertyKey` → `offsetsLoanKey`. The offset stays exactly what 53 designed — a
cash-like asset account — it just points at the loan.

### Sign convention (decided): positive balance + liability marker

A liability could be stored as a **negative** `balance` (so `net-worth.js`'s generic
`total += balance` "just works") or as a **positive** `balance` (outstanding principal)
plus a type marker, with the wealth metrics special-casing the subtraction.

**Decision: positive `balance` = outstanding principal, discriminated by
`type === 'loan'`.** A negative balance would poison everything else that assumes a
positive asset — formatting, the editor, `AccountService.transaction`, `minimumBalance`,
`InsufficientFundsError`, drawdown/replenish. Keeping `balance` positive means those paths
stay unchanged, and the only cost is one extra branch in the two wealth metrics (which
already special-case real-property equity — see §7). Drawdown exclusion is via the existing
`drawdownPriority = null` plus a type filter (§8).

---

## 3. `LoanAccount` shape

```
ACCOUNT_TYPE.LOAN   = 'loan'
ACCOUNT_ROLES.US_LOAN = 'us-loan'
ACCOUNT_ROLES.AU_LOAN = 'au-loan'    // per-country, mirroring savings: drives currency + cash pool

class LoanAccount extends Account {          // liability — NOT InvestmentAccount
  constructor(balance = 0, opts = {}) {      // balance = outstanding principal (positive)
    super(balance, { ...opts, type: ACCOUNT_TYPE.LOAN });
    this.interestRate      = opts.interestRate      ?? 0;    // annual rate (decimal)
    this.monthlyPayment    = opts.monthlyPayment    ?? 0;    // fixed P&I payment
    this.linkedPropertyKey = opts.linkedPropertyKey ?? null; // optional: property this loan finances
    this.paymentSourceKey  = opts.paymentSourceKey  ?? null; // cash pool the payment debits (default: country cash)
    this.drawdownPriority  = null;                           // never a source of drawdown cash
  }
}
```

Extends `Account` (not `InvestmentAccount`): no holdings, no contribution/earnings split.
Per-country role (`US_LOAN` / `AU_LOAN`) so the payment reducer resolves the right cash
pool and currency the same way savings do.

---

## 4. Interest accrual + amortization (the real loan)

Replace the scalar `mortgageBalance -= payment` with a monthly `LOAN_PAYMENT` flow that
splits interest from principal, with the offset reducing the interest-bearing base:

```
effPrincipal   = max(0, loan.balance − offsetBalanceForLoan(state, loanKey))   // §6
interest       = effPrincipal × interestRate / 12
payment        = min(monthlyPayment, loan.balance + interest)   // never overpay past payoff
principalPart  = payment − interest
loan.balance  -= principalPart                                  // debt shrinks by principal only
debit cash pool by `payment`                                    // full P&I leaves cash
```

- **Offset bites here**, universally — owner-occupied and rental alike — because interest
  is now computed on `effPrincipal`. That is the whole point of the loan-as-account move.
- **Negative amortization (decided: allow + flag)**: if `payment < interest`,
  `principalPart` is negative and `balance` grows. This is a real state (interest-only /
  underwater loan), so it is **not** clamped. Instead the reducer emits a journal
  `FieldValueAction` flag (e.g. `loan_negative_amortization`) whenever `principalPart < 0`,
  so the UI surfaces a ballooning balance rather than it reading as a silent bug.
- Record interest paid as a field value (feeds rental deductible-interest, §5, and any
  future interest-expense metric).

---

## 5. Migration — property scalars → Loan account

Per the design decision, a property's `mortgageBalance` / `monthlyMortgage` /
`mortgageInterestRate` **become a linked `LoanAccount`**; they stop being the source of
truth.

1. **Payment flow.** `UsMortgagePaymentHandler` / `AuMortgagePaymentHandler` operate on the
   linked `LoanAccount` (the §4 split) instead of decrementing `propState.mortgageBalance`.
2. **Rental deductible interest.** `computeRentalMonth` reads the linked loan's
   `effPrincipal × rate / 12` (`rental-income-classes.js:57`) instead of
   `propState.mortgageBalance × rate / 12`. Resolution: property → `linkedPropertyKey` loan
   → offset.
3. **Net worth / after-tax.** The property-equity branch stops subtracting the scalar
   mortgage; the Loan contributes its negative-signed liability instead (§7).
4. **Bootstrap.** Toolset / scenario seeding that sets `mortgageBalance` now seeds a
   `LoanAccount` linked to the property.
5. **Legacy saves — migration-on-load.** On deserialize, if a property carries legacy
   scalar mortgage fields and has **no** linked loan, synthesize a `LoanAccount` from them
   (a one-time upgrade). Old scenarios keep working and round-trip forward. A
   double-count guard (§7) keeps net worth correct during the window where a property
   *might* still carry a scalar and a loan.

---

## 6. Offset re-target

The one change to design 53's offset:

- `OffsetAccount.offsetsPropertyKey` → **`offsetsLoanKey`** (a `LoanAccount` stateKey).
- `offsetBalanceForProperty(state, propKey)` → **`offsetBalanceForLoan(state, loanKey)`** —
  sums balances of offset accounts whose `offsetsLoanKey === loanKey`, clamped at the loan
  balance (unchanged logic, new target).
- The rental line (§5.2) resolves property → linked loan → offset, so 53's rental behavior
  is preserved. The **new** capability is that owner-occupied loans now feel the offset,
  via §4's `effPrincipal`.
- **Generalized to US (decided).** 53 scoped the offset AU-only. Because the loan now
  carries a real interest line for every country, the offset is meaningful for US
  owner-occupied loans too, so the AU-only gate is dropped: `OffsetAccount` is wired into
  `US_BANKING` as well as `AU_BANKING` (53 §Phase 3.4), and `offsetBalanceForLoan` /
  `effPrincipal` are country-agnostic (they key on `offsetsLoanKey`, not currency). An
  offset account still carries its own currency and links only to a same-currency loan.

---

## 7. Wealth-metric changes (the ripple)

Both `computeNetWorth` (`net-worth.js`) and the after-tax metric (`after-tax.js`) currently
treat **any** entry with a numeric `balance` as `+balance` (`net-worth.js:35`). A loan must
subtract. Add a **liability branch before the generic balance branch**:

```
if (val.type === 'loan') {            // liability: owed principal reduces net worth
  contribution = -(val.balance ?? 0);
} else if (typeof val.balance === 'number') {
  contribution = val.balance;         // asset (incl. offset accounts — positive)
} else if (val.kind === 'real-property' …) {
  // stop subtracting mortgageBalance once a linked loan exists (double-count guard):
  contribution = val.value - (hasLinkedLoan(state, val) ? 0 : (val.mortgageBalance ?? 0));
}
```

The offset account is an ordinary positive asset — it counts `+`. The loan counts `−`. The
property-equity line subtracts its scalar mortgage **only** when no linked loan exists,
which keeps net worth correct through migration and for any property still on the legacy
scalar path.

---

## 8. Drawdown / replenish exclusion

A loan is never a spendable pool. `drawdownPriority = null` (constructor default) plus a
`type === 'loan'` filter in `AccountService`'s drawdown and `replenishSavings` iteration
keep loans out of the cash pools. Confirm both paths skip liabilities (a loan with a stray
`drawdownPriority` must still be excluded by type).

---

## 9. Phased plan

### Phase 1 — `LoanAccount` type + interest accrual (standalone)
*No property coupling yet; a loan can stand alone (car/student/personal).*

1. `ACCOUNT_TYPE.LOAN`, `ACCOUNT_ROLES.US_LOAN` / `AU_LOAN`, `LoanAccount` class + builder +
   serializer case + `TypeRegistry` registration + `StateSchemaRegistry` (`balance` as the
   country currency; `interestRate` as `rate()`).
2. `LOAN_PAYMENT` handler + reducer: the §4 interest/principal split, cash debit, negative-
   amortization flag. (Offset term reads as 0 until Phase 3.)
3. `net-worth.js` / `after-tax.js` liability branch (§7); drawdown/replenish exclusion (§8).
4. `evt-loan.test.mjs`: a standalone loan amortizes (interest + principal split correct over
   several months), counts as **negative** net worth, is excluded from drawdown/replenish,
   and round-trips through the serializer.

**Exit test**: `evt-loan` green; net worth of a scenario with a loan is asset-total minus the
loan balance; drawdown never draws from a loan.

**✅ DONE (committed `d1e9464` / `888adca`).** Landed as scoped — `LoanAccount` is the
codebase's first liability account; positive `balance` = owed principal, negative sign applied
by the wealth metrics (not stored); excluded from drawdown; `LOAN_PAYMENT` interest/principal
split + negative-amortization flag.

### Phase 2 — Property migration
*Move property mortgages onto linked loans; keep existing figures intact.*
**✅ DONE (committed `6886590`).** The invasive migration below all landed; figures identical
(loan `interestRate` defaults 0 → pure-principal amortization = the old mortgage math). Live-
validated in Chrome (loan synthesized, payments amortize, house sale closes the loan). Two
deviations from the plan below: **(a)** per-country wiring used **subclasses**
`UsLoanPaymentHandler` / `AuLoanPaymentHandler` (each `static eventType`, auto-wired) over the
base `LoanPaymentHandler({country})` — cleaner than instance config; the shared
`LoanPaymentApplyReducer` is registered **once** by the compiler substrate (both toolsets
registering it would double-reduce). **(b)** The **migration-on-load shim (item 4) was
deferred** — no legacy saves exist on this branch, and new scenarios' snapshots already carry
the synthesized loan (round-trip tests green). Add it if a real pre-migration fixture appears;
hook = where `initialState` is applied to `sim.state` on the deserialize path.

*Original analysis + scaffolding notes (retained for reference):*

Findings from grounding the plan in the code (these refine §5):

- **Blast radius is safe.** No *tested* config combines `mortgageInterestRate > 0` with
  monthly payments: rental tests use `monthlyMortgage: 0` (interest only for the deduction),
  payment tests use `mortgageInterestRate: 0` (interest-free amortization). So a faithful
  loan keeps every current figure identical; real amortization diverges only in the
  currently-untested rate>0-plus-payments case (which becomes correct).
- **Loan as a plain state entry.** The toolset synthesizes the loan the way it synthesizes
  a property — a plain state entry keyed `${propKey}Loan` (helper `synthesizeLoanForProperty`,
  looked up by `findLoanForProperty`, both in `loan-classes.js`). Not a registered Account;
  net-worth / payment / drawdown all key on `type === 'loan'`, not the class.
- **Zero the property scalars → no guard.** `_propertyToStatePlain` zeroes
  `mortgageBalance` / `monthlyMortgage` (and drops `mortgageInterestRate` into the loan), so
  `value − mortgageBalance` = `value − 0` and the loan's `−balance` is the sole debt. No
  double-count, no §7 guard needed.
- **Extra touch point (not in the original §5):** the **house-sale payoff** reads
  `property.mortgageBalance` in `us/au-real-property-classes.js` and `real-property-service.js`
  — zeroing the scalar breaks it, so the sale must pay off / close the linked loan too.
- **Per-country event wiring.** The P1 `LoanPaymentHandler` scans *all* loans, so scheduling
  it from both US and AU real-property toolsets would double-pay. Mirror the existing
  `US_MORTGAGE_PAYMENT` / `AU_MORTGAGE_PAYMENT` split: distinct `US_LOAN_PAYMENT` /
  `AU_LOAN_PAYMENT` events with a **country-filtered** `LoanPaymentHandler({ country })`
  (default null = all loans, preserving P1). One shared `LoanPaymentApplyReducer`.

Remaining work (atomic — can't be cleanly half-done):
1. US + AU real-property toolsets: synthesize the loan state entry, zero the property mortgage
   scalars, schedule `US_LOAN_PAYMENT` / `AU_LOAN_PAYMENT`, wire the country-filtered handler
   + shared reducer, register the loan types; retire the US/AU mortgage-payment classes for
   properties.
2. `computeRentalMonth` → read `findLoanForProperty(...).effPrincipal × rate / 12`.
3. House sale (US/AU classes + `real-property-service.js`) → pay off / close the linked loan.
4. Migration-on-load shim (§5.5): a saved property with a legacy `mortgageBalance` and no
   linked loan synthesizes one on deserialize.
5. Tests: move mortgage-payment + house-sale assertions from `property.mortgageBalance` to the
   loan balance (figures identical); legacy-scalar fixture upgrades on load.

**Landed scaffolding (green, unused):** `loanKeyForProperty`, `findLoanForProperty`,
`synthesizeLoanForProperty`, and an exported `effectivePrincipal` in `loan-classes.js`.

**Exit test**: `evt-real-property` + `toolset-mortgage-payment` green with the loan as the
mortgage source of truth; a legacy save loads, upgrades, and reports identical net worth.
*(Met, except the legacy-save-upgrade clause — deferred with the item-4 shim above.)*

### Phase 3 — Offset re-target (design 53 → loan)
*Depends on 53's `OffsetAccount` existing.*

1. `offsetsPropertyKey` → `offsetsLoanKey`; `offsetBalanceForProperty` →
   `offsetBalanceForLoan` (§6). Rental resolution property → loan → offset.
2. `effPrincipal` in the §4 payment flow consults the offset, so an offset on an
   **owner-occupied** loan reduces interest paid and speeds principal payoff.
3. Drop the AU-only gate: register `OffsetAccount` in `US_BANKING` as well as `AU_BANKING`
   (§6), so a US owner-occupied loan can carry a same-currency offset.
4. Extend `evt-au-offset` (from 53): an offset on an owner-occupied loan lowers monthly
   interest and shortens the amortization vs the no-offset baseline; the rental-offset case
   from 53 still matches (property → linked loan → offset). Add a US mirror
   (`evt-us-offset`, or a US case in the same suite): a USD offset on a US owner-occupied
   loan reduces interest paid and speeds payoff.

**Exit test**: offset suites green for AU **and** US, each covering owner-occupied (new:
interest + payoff effect) and — where applicable — rental (53's effect, preserved); offset
balance stays liquid/drawdown-eligible.

**✅ DONE (committed `f9e4b75`), co-implemented with design 53 Q3/Phase 3.** Because 53's
`OffsetAccount` and this re-target landed together, the offset went straight to the loan (no
intermediate property-scalar wiring). Deviations from the plan above:
- **Kept `offsetsPropertyKey`, did *not* rename to `offsetsLoanKey`** (item 1). The offset
  links to a *property*; resolution is property → its synthesized loan → offset, since loan
  keys are synthetic (`${propKey}Loan`). `offsetBalanceForLoan(state, loan)` matches offsets
  on `offsetsPropertyKey === loan.linkedPropertyKey`, with a **same-currency guard**.
- Item 2 (owner-occupied interest/payoff) works because `effectivePrincipal` is consulted by
  **both** the rental line and the monthly `LOAN_PAYMENT` accrual (from P2).
- Item 3 (drop AU-only gate) done — `US_OFFSET` + `AU_OFFSET` roles; offset is currency-
  agnostic; added to `SAVINGS_ROLES` for liquidity.
- Tests: `evt-offset.test.mjs` (AU + US, owner-occupied + rental + drawdown-eligibility) plus
  a full-sim integration test in `accounting-integrity.test.mjs`.
- **⚠️ Outstanding:** editor-created offsets get no `stateKey` and don't reach `sim.state`
  (config-declared ones work). Deferred to **design 55 §3.1**. Full detail in design 53 §6
  Phase 3 "Outstanding".

---

## 10. Sequencing against design 53

Two tracks, one collision point.

**Track A — independent of loans** (53's basis / bond / editor work). Lands before, after, or
interleaved with everything below, in 53's own internal order; none of it touches loans,
offsets, net worth, or the rental line:
- 53 P1 (decouple brokerage basis) → 53 P2 (`RetirementAccount`)
- 53 P4 (bond coupon) → 53 P5 (holdings editor)

**Track B — the loan / offset chain**, with real dependencies:
- 54 P1 (standalone loan) — depends on nothing in 53.
- 54 P2 (property migration) — reworks the rental deductible-interest line
  (`rental-income-classes.js:57`) and the mortgage payment flow; depends on 54 P1.
- Offset integration — needs **both** 53 P3's `OffsetAccount` infra **and** 54 P2's linked
  loans; 54 P3 re-targets the offset link property → loan.

**The one collision.** The rental deductible-interest line and the offset link target are
touched by 53 P3 (offset → property → rental) *and* by 54 P2 / P3 (loan → rental,
offset → loan). 53 P3's **property-linkage + rental hook is superseded by 54**; the
`OffsetAccount` class / type / builder / serializer itself is **permanent and reused
unchanged**. Net worth has no collision — 53 never touches it; 54 P1 adds the liability
branch and 54 P2 the double-count guard.

### Recommended global order (co-landing 53 + 54)

1. **53 P1** — decouple brokerage basis
2. **53 P2** — `RetirementAccount`
3. **54 P1** — `LoanAccount` + accrual (net-worth liability branch, drawdown exclusion)
4. **54 P2** — property migration (mortgage payment → loan, rental line → `loan.effPrincipal`,
   net-worth double-count guard, migration-on-load)
5. **53 P3 (infra only)** — `OffsetAccount` type / class / builder / serializer / TypeRegistry
   + editor row. **Skip** the property-linkage + rental hook — wire straight to loans in the
   next step.
6. **54 P3** — offset ↔ loan wiring (`offsetsLoanKey`, `offsetBalanceForLoan`, `effPrincipal`
   in the payment flow, `US_BANKING` + `AU_BANKING` registration, evt tests)
7. **53 P4 → P5** — bond coupon + holdings editor (any time; fully independent)

This writes the rental line **once** (step 4) and the offset link **once** (step 6) — no
throwaway.

### If 53 must ship before 54

53 P3 lands **as written** (offset → property → rental deductible-interest), delivering the
rental-interest offset immediately. 54 then reworks it: 54 P2 moves the rental line to
`loan.effPrincipal`, and 54 P3 renames `offsetsPropertyKey → offsetsLoanKey` and
`offsetBalanceForProperty → offsetBalanceForLoan`. The rework is small (one field rename,
one helper rename, one rental-line rewrite, `evt-au-offset` update) and the `OffsetAccount`
infra is untouched — the interim value of a shippable 53 usually justifies it.

## 11. Risks / open questions

- **Sign convention** (§2). Chosen: positive `balance` + `type === 'loan'` marker, with the
  metrics subtracting. The alternative (negative balance) was rejected because it poisons
  every asset-assuming path. Worth a throwing-getter / grep pass to confirm nothing sums
  `balance` without the new liability branch.
- **Double-count during migration** (§7). The property-equity line must subtract the scalar
  mortgage *only* when no linked loan exists. A property that carries both a legacy scalar
  and a fresh loan (mid-migration) is the fixture to test.
- **Negative amortization** (§4) — *settled*: allowed + flagged rather than clamped, so
  interest-only / underwater loans are modelable; the `loan_negative_amortization` flag keeps
  it from reading as a silent bug.
- **Offset generality** (§6, Phase 3) — *settled*: the AU-only gate is dropped; the offset
  works for US owner-occupied loans too (`OffsetAccount` registered in `US_BANKING` +
  `AU_BANKING`, country-agnostic `effPrincipal`).
- **Role granularity** (§3). Per-country `US_LOAN` / `AU_LOAN` (currency + cash-pool
  resolution) vs a single `LOAN` role. Per-country chosen to mirror savings; revisit if a
  loan needs to be paid from an arbitrary account regardless of country.
- **Legacy save compatibility.** Migration-on-load synthesizes a loan from scalar fields;
  needs an explicit round-trip test with a pre-54 property fixture (mirrors 53 §7's
  legacy-brokerage concern).
