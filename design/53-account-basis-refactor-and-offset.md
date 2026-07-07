# 53 — Account basis refactor + AU offset account

**Status**: **Proposed** (design only).

**Follow-up**: `design/54-loan-liability-accounts.md` builds on this doc's `OffsetAccount`
(§3). It introduces a first-class **Loan** (liability) account that accrues interest, and
**re-targets** the offset link from a property (`offsetsPropertyKey`, §3.3) to a Loan
account (`offsetsLoanKey`). That is what makes an offset bite on **owner-occupied** loans
and enables a true interest/principal amortization split — the two limitations §3.2 / §7
document as out-of-scope here. Ship 53 first; 54 is the natural next step.

Four related changes to the `Account` / `Holding` model, driven by four questions:

1. Are `contributionBasis` / `earningsBasis` on `InvestmentAccount` still needed now
   that every account carries `holdings` (design 25)?
2. The contribution/earnings split is a *retirement-account* concept — should it live
   on a narrower subclass rather than on the base `InvestmentAccount`?
3. Add an AUD **offset account** that offsets a home loan's interest.
4. A **bond holding** is parameterized by its *interest (coupon) rate*, but today that
   rate is implicit (shared `rateKey` → regime-adjusted `effectiveInterestRates`, or the
   handler fallback). Give bond holdings an explicit per-holding coupon rate — the twin
   of the per-holding `dividendYield` equities already have.

**Builds on**:
- `design/25-holding-level-state.md` — per-holding `costBasis`, the FIFO consumption
  path (`consumeHoldingsFifo`), and the `balance === Σ marketValue` invariant.
- `design/43-basis-accounting-integrity.md` — the `contributionBasis` / `earningsBasis`
  ledger and its reconcile-on-load repair (`reconcileLedgerToBalance`).
- `design/40` after-tax metric (`src/finance/derived-metrics/after-tax.js`), the only
  metric that reads `earningsBasis` (the `SUPER` tax class).

---

## 1. Problem — two different "basis" concepts wearing one name

The codebase tracks **two** things called "basis" that answer different tax questions:

| Field | Lives on | Tax question | Read by |
|---|---|---|---|
| `Holding.costBasis` | each holding | **Capital gain** on sale: `gain = salePrice − FIFO(costBasis)` | brokerage sale reducers; after-tax `TAXABLE_BASIS` |
| `contributionBasis` / `earningsBasis` | `InvestmentAccount` | **Ordinary-income deferral**: withdraw contribution first (tax-free / already-taxed), then earnings (taxed) | retirement reducers (IRA/401k/Roth/super); after-tax `SUPER` |

Holdings cannot replace the contribution/earnings split for retirement accounts —
those accounts pay ordinary income on the *growth* portion, not capital gains, so
`costBasis` is the wrong quantity. Conversely, for **brokerage** the split is now
**dead**: since holdings landed, `STOCK_WITHDRAWAL_APPLY` computes the real CGT from
`consumeHoldingsFifo(sa.holdings, salePrice)` (`us-brokerage-classes.js:202-208`), and
the after-tax `TAXABLE_BASIS` path reads holdings (`_unrealizedGain`, `after-tax.js:175`).
The brokerage reducers still *write* `contributionBasis` / `earningsBasis` in parallel
(`newContrib = newBalance − newEarnings`, `us-brokerage-classes.js:214-224`;
`au-brokerage-classes.js:200-210`) but nothing *reads* them for tax. They are
**write-only bookkeeping** — the redundancy behind the confusing `C.Basis` / `E.Basis`
fields the editor shows for *every* investment type (`index.html:662-671`, gated by
`INVESTMENT_TYPES` in `accounts-controller.js:18`).

### Current hierarchy

```
Account (balance, holdings)
└ InvestmentAccount (contributionBasis, earningsBasis, loanBalance, minimumAge,
   │                 allowsEarlyWithdrawal, costBaseStepUpByCountry, balanceAtResidencyChange)
   ├ BrokerageAccount          ← does NOT conceptually need contribution/earnings basis
   ├ FourOhOneKAccount ┐
   ├ RothAccount       ├ true owners of the contribution/earnings split
   ├ TraditionalIRAAccount │
   └ SuperannuationAccount ┘
```

---

## 2. Target hierarchy

Introduce a `RetirementAccount` between `InvestmentAccount` and the four tax-deferred
account classes. `contributionBasis`, `earningsBasis`, `minimumAge`, and
`allowsEarlyWithdrawal` move onto it. `BrokerageAccount` extends `InvestmentAccount`
directly and becomes holdings-only.

```
Account (balance, holdings)
└ InvestmentAccount (loanBalance, costBaseStepUpByCountry, balanceAtResidencyChange)
   ├ BrokerageAccount                       ← holdings only, no contribution/earnings basis
   └ RetirementAccount (contributionBasis, earningsBasis, minimumAge, allowsEarlyWithdrawal)
      ├ FourOhOneKAccount
      ├ RothAccount
      ├ TraditionalIRAAccount
      └ SuperannuationAccount
```

Fields that stay on `InvestmentAccount` because brokerage uses them:
- `loanBalance` — AU brokerage margin loan (AR-5).
- `costBaseStepUpByCountry` — residency cost-base step-up on the proportional path
  (design 36 §12.2).
- `balanceAtResidencyChange` — set by `AccountService.recordResidencyChange`.

`minimumAge` / `allowsEarlyWithdrawal` move down because only retirement accounts gate
withdrawals by age; brokerage never sets them.

### Why the class move is the *last* step, not the first

`us/au-brokerage-classes.js` currently *write* `contributionBasis` / `earningsBasis`. If
the field simply vanishes from brokerage's prototype chain those reducers throw on
`sa.contributionBasis`. So the field can only leave `InvestmentAccount` **after** the
brokerage reducers stop touching it. That reordering is the whole risk profile of Q1/Q2.

---

## 3. Q3 — AU offset account (interest-reduction only, linked, liquid)

### 3.1 What an offset account does

Cash held in an offset account reduces the *interest-bearing* principal of a linked
home loan without paying the loan down: `effectivePrincipal = max(0, mortgageBalance −
offsetBalance)`. The money stays liquid and spendable; while it sits there it "earns"
the mortgage rate by suppressing interest.

### 3.2 Fit with the current mortgage model

The mortgage model is thin, which keeps this small:
- Properties carry `mortgageBalance`, `monthlyMortgage`, `mortgageInterestRate`
  (`real-property.js:68-85`).
- **Amortization does not split interest vs principal** — the payment reducer just does
  `mortgageBalance −= payment` (`mortgage-payment-classes.js:117`).
- Interest surfaces in exactly one place today: rental deductible interest
  `deductibleInterest = mortgageBalance × rate / 12` (`rental-income-classes.js:57`).

Per the scope decision (interest-reduction only), the offset plugs in **only where
interest is already computed** — the rental deductible-interest line. There is no
owner-occupied interest-cost line in the model, so an offset against an owner-occupied
loan has no cash-flow effect today; it becomes meaningful the moment such a line is
added (a clean future extension, out of scope here). This is documented behavior, not a
gap to paper over.

### 3.3 Account shape

A new AUD, cash-like account type:

```
ACCOUNT_TYPE.OFFSET = 'offset'
ACCOUNT_ROLES.AU_OFFSET = 'au-offset'

class OffsetAccount extends Account {          // cash-like — NOT InvestmentAccount
  constructor(balance = 0, opts = {}) {
    super(balance, {
      country:  opts.country  ?? 'AU',
      currency: opts.currency ?? AUD,
      ...opts,
      type: ACCOUNT_TYPE.OFFSET,
    });
    this.offsetsPropertyKey = opts.offsetsPropertyKey ?? null; // stateKey of linked AU property
  }
}
```

It extends `Account` (not `InvestmentAccount`): it holds cash, has no holdings-driven
allocation, no contribution/earnings split. It behaves like an AUD savings account for
drawdown/replenish (liquid, participates in the AU cash pool per the linkage decision),
plus one extra field `offsetsPropertyKey` linking it to a property.

### 3.4 Where it reads through

`computeRentalTaxables` (`rental-income-classes.js`) gains an offset lookup: when a
property is targeted by an offset account, subtract that account's balance from
`mortgageBalance` before computing `deductibleInterest`:

```
const offset = offsetBalanceForProperty(state, propStateKey);   // Σ balances of offset accts linked here
const effPrincipal = Math.max(0, (propState.mortgageBalance ?? 0) - offset);
const deductibleInterest = effPrincipal * mortgageRate / 12;
```

Offset lookup walks `state` for `type === 'offset'` accounts whose
`offsetsPropertyKey === propStateKey` (mirrors how `_sumAfterTax` walks balance-bearing
state entries). Kept in one helper so both AU and (future) US rental paths share it.

---

## 4. Q4 — per-holding bond coupon rate

### 4.1 What a bond holding is today

Bonds are not a class — they are `allocation === ALLOCATION.BOND` **holdings**
(`allocation.js:21`; `FIXED_INCOME_*` roles map to `BOND` in `default-allocations.js`).
Their economics come from three existing surfaces:

| Field / source | Role | Where |
|---|---|---|
| `holding.rateKey` → `state.effectiveInterestRates[rateKey]` | the **coupon rate**, *regime-adjusted* | `computeHoldingsGrowth` (`holdings-earnings.js:88-91`), via `FixedIncomeInterestHandler` / `AuFixedIncomeInterestMonthlyHandler` |
| handler `interestRate` (default `0.04`) | fallback coupon when no rate-key entry | `earnings-handlers.js:490` |
| `holding.duration` | rate-sensitivity → mark-to-market `Δprice = −D·Δr·MV` | `BondPriceAdjustReducer` (design 28 §5) |
| `holding.costBasis` | **CGT on sale**: `gain = salePrice − FIFO(costBasis)` | `consumeHoldingsFifo` |

Two clarifications that shaped this design:

- **The interest rate is implicit today.** A bond holding has *no per-holding coupon
  field*. Its coupon is whatever the shared `rateKey` resolves to (or the handler
  fallback). Equities, by contrast, already got a per-holding knob — `Holding.dividendYield`
  (design 28 §7), nullable, falling back to the account rate. Bonds have no twin. **That
  gap is Q4.**
- **Bond holdings keep `costBasis`.** Duration mark-to-market moves `marketValue`, so a
  bond sold after rates move realizes a capital gain/loss = `salePrice − costBasis`.
  Stripping `costBasis` from bonds would delete design 28's mark-to-market CGT. What bonds
  legitimately lack is `earningsBasis` — but so does *every* holding: `earningsBasis` is an
  **account-level** retirement field (the very thing §2 moves onto `RetirementAccount`).
  "Bonds don't have cost/earnings basis" conflated a holding-level field bonds keep with an
  account-level one no holding has. **Decision: add `couponRate`, keep `costBasis`.**

### 4.2 The field — `Holding.couponRate`

Optional per-holding coupon rate, the exact mirror of `dividendYield`:

```js
// holding.couponRate  (new optional field, BOND holdings)
holding.couponRate: number | null   // annual coupon rate; null = fall back to rateKey / handler
```

- **Fixed, contractual coupon.** A non-null `couponRate` is the bond's *own* coupon and is
  **not** re-adjusted by `state.effectiveInterestRates` regime moves — a fixed-coupon bond
  pays its stated coupon regardless of where market rates go. Its **price** still moves via
  `duration` mark-to-market (design 28). This composes correctly: rates rise ⇒ coupon
  unchanged, `marketValue` falls. Leaving `couponRate` null preserves today's behavior
  exactly — the coupon floats with the regime-adjusted rate-key rate (a rolling-reinvestment
  proxy). This is the one genuine *behavioral* choice in Q4, and it is opt-in per holding.

### 4.3 Where it reads through

Bond coupons flow through `computeHoldingsGrowth` (`holdings-earnings.js`) with
`rateSource: 'effectiveInterestRates'` (the fixed-income callers). Add the per-holding
override there, **gated on the interest-bearing path** so it never contaminates equity
growth:

```
// inside computeHoldingsGrowth's per-holding loop, when rateSource === 'effectiveInterestRates':
const baseRate = rateOverride
  ?? (h.couponRate ?? (h.rateKey != null ? ratesMap[h.rateKey] : undefined))
  ?? fbRate;
```

The `rateOverride` (a handler's one-off `data.rate`) still wins, matching the existing
precedence. On the equity path (`effectiveGrowthRates`) `couponRate` is ignored — it is a
bond concept. Gate by the existing `rateSource` argument rather than adding a new flag.

### 4.4 Touch points (all mirror `dividendYield` / `duration`)

1. `holding.js` — add `couponRate = null` to constructor, `toJSON`, `fromJSON`.
2. `holdings-earnings.js` — the §4.3 override, gated on `rateSource === 'effectiveInterestRates'`.
3. `state-schema-registry.js` — `registerPattern('*.holdings.*.couponRate', ParameterValueType.rate())`
   next to the `dividendYield` line (`:170`).
4. `account-editor.js` — add a `couponRate` input to the holdings row (`:234-242`), shown for
   BOND allocation; keep the existing `costBasis` input. (Non-bond rows may hide it, but the
   simplest correct behavior is to always render it and let it stay null for equities.)
5. **No serializer change** — holdings round-trip via `Holding.toJSON()`
   (`scenario-serializer.js:641-642`), so the field rides along automatically.

---

## 5. Holdings editor — per-allocation inputs

Surfacing `couponRate` (§4) exposes a pre-existing problem: the holdings editor gives
**every** allocation the *same* fixed input set, so several per-holding fields that the
engine reads have **no editor at all**, and several shown fields are meaningless for the
row's allocation.

### 5.1 The gap today

The holdings table is a fixed 7-column grid — Label, Allocation, Rate Key, Market Value,
Cost Basis, Loss Partner, ✕ (`index.html:678-686`; row render
`account-editor.js:234-242`), identical for all four allocations. Consequences:

- **Unreachable fields.** `Holding.dividendYield` (design 28 §7), `Holding.duration`
  (design 28 §5), and the new `Holding.couponRate` (§4) all exist and are read by the
  engine but have **no input** — you cannot set a dividend yield, a bond duration, or a
  coupon from the UI at all. They're only settable via saved-scenario JSON or toolset
  bootstrap.
- **Meaningless-but-shown fields.** `Cost Basis` and `Loss Partner` render on **CASH**
  rows (cash has no CGT and isn't tax-loss-harvested); `Loss Partner` renders on **BOND**
  rows though the behavioral TLH / panic-sell path is equity-only
  (`panic-sell-reducer.js:79` filters `allocation === EQUITY`; `substitute-holding.js`).

### 5.2 Ideal input set per allocation

`Rate Key` and `Market Value` are universal (Market Value drives the balance invariant;
Rate Key resolves the regime-adjusted rate for **every** allocation, including CASH →
`SAVINGS_*` per `default-allocations.js:59,64`, and BOND, where it's required for the
duration mark even when `couponRate` is fixed).

| Field | EQUITY | BOND | CASH | OTHER | Notes |
|---|---|---|---|---|---|
| Label | ✓ | ✓ | ✓ | ✓ | identity |
| Allocation | ✓ | ✓ | ✓ | ✓ | the selector itself |
| Rate Key | ✓ | ✓ | ✓ | ✓ | growth/interest/savings rate; **required for BOND** (duration mark) |
| Market Value | ✓ | ✓ | ✓ | ✓ | drives `balance = Σ marketValue` |
| Cost Basis | ✓ | *hidden* | ✗ | ✓ | CGT basis; **BOND: hidden, defaulted to MV** (§5.3); cash has no CGT |
| Dividend Yield | ✓ | ✗ | ✗ | ✗ | `dividendYield`, regime-adjusted (design 28 §7) |
| Coupon Rate | ✗ | ✓ | ✗ | ✗ | `couponRate`, fixed contractual (§4.2) |
| Duration | ✗ | ✓ | ✗ | ✗ | `duration`, mark-to-market sensitivity (design 28 §5) |
| Loss Partner | ✓ | ✗ | ✗ | ✓ | `taxLossPartner`; TLH is equity-oriented today |

`OTHER` is the escape hatch — the general set (Label, Rate Key, MV, Cost Basis, Loss
Partner) minus the class-specific income/duration knobs. `Dividend Yield` and `Coupon
Rate` are mutually exclusive by construction (an EQUITY vs a BOND), so they **share one**
table **column** ("Income Rate") that binds to `dividendYield` or `couponRate` by the
row's allocation (decided — §5.3).

### 5.3 UI realization

1. **Per-cell gating, not per-row layout.** Keep one table with a superset of columns;
   each row renders an input only in the cells its allocation uses (per §5.2), leaving the
   others empty. Binding stays trivial — each non-income cell maps to exactly one `Holding`
   field. The income-rate column is the one allocation-switched cell (next point).
2. **Single merged income-rate column (decided).** One `Income Rate` column whose input
   binds to `h.dividendYield` when `allocation === EQUITY` and `h.couponRate` when
   `=== BOND`, and is blank/disabled otherwise. Header stays "Income Rate"; a per-row
   title/placeholder ("Dividend yield" / "Coupon rate") disambiguates. Two mechanical
   consequences to honor: (a) the allocation-change re-render (§5.3.3) must rebind this
   cell to the new target field and repaint its current value; (b) switching EQUITY↔BOND
   does **not** carry the rate across — `dividendYield` and `couponRate` are distinct
   fields, so the cell reads whichever the new allocation owns (null ⇒ empty), leaving the
   other untouched in the data.
3. **Re-render the row on allocation change.** Changing a row's `Allocation` select
   re-renders that row's inputs to the new allocation's set (basis/income/duration/partner
   appear or disappear). This already needs a partial hook — today the whole tbody
   re-renders on add/delete; extend that to fire on the per-row allocation `change`.
4. **Bond Cost Basis — hidden, defaulted to Market Value.** Per the Q4 decision, BOND
   rows do **not** show a Cost Basis input. Two rules keep it correct:
   - **On create / on switch to BOND**: set `costBasis = marketValue`.
   - **Editor-time MV edits** (config authoring, pre-run): while basis is hidden, keep
     `costBasis` synced to `marketValue` so no accidental embedded gain is authored ("a
     bond bought at par today"). This sync is **editor-only** — at runtime the duration
     mark moves `marketValue` while `costBasis` stays fixed, which is exactly how the
     capital gain accrues. A premium/discount bond (basis ≠ MV) is the documented
     exception: model it as `OTHER`, or via saved JSON, until an explicit "advanced" toggle
     is added.

### 5.4 Touch points

1. `index.html:678-686` — the `<thead>` column set (add Income Rate + Duration; the
   others already exist as headers).
2. `account-editor.js` — the row template (`:234-242`), the add-holding default
   (`:194-203`; seed `dividendYield/couponRate/duration = null`, and `costBasis = marketValue`
   for a bond default), per-cell gating by `h.allocation`, and the allocation-change
   re-render (§5.3.3) + bond basis-sync rule (§5.3.4).
3. No new engine or serializer work — all four fields already round-trip and are read by
   the engine; this section only makes them **reachable and allocation-appropriate** in the
   editor.

---

## 6. Phased plan

Ordered so each phase is independently shippable and green.

### Phase 1 — Decouple brokerage from contribution/earnings basis
*Prerequisite for Q2. No hierarchy change yet.*

1. Rewrite `StockWithdrawalApplyReducer` (US + AU) to drop the parallel
   `contributionBasis` / `earningsBasis` writes — they already compute the authoritative
   result from holdings. Keep the `holdings` + `balance` writes.
2. Same for the contribution / dividend / earnings apply reducers: stop maintaining the
   two basis fields on brokerage state (`us-brokerage-classes.js:110,140-141,172,214-224`;
   `au-brokerage-classes.js:44-45,72-73,102-103,134-135,160,200-210`).
3. Verify nothing reads brokerage `earningsBasis` / `contributionBasis`: after-tax
   `TAXABLE_BASIS` uses holdings; CGT uses FIFO. Grep + a targeted brokerage evt test to
   confirm tax unchanged (`evt-us-brokerage`, `evt-au-brokerage`, `basis-invariants`,
   `reducer-postconditions-*-brokerage`).
4. Stop serializing the two fields for brokerage (`scenario-serializer.js:619-621`,
   toolset `_serialize*` helpers) — leave the retirement path untouched.

**Exit test**: brokerage evt suites + basis-invariants green with the fields absent from
brokerage state.

### Phase 2 — Introduce `RetirementAccount`, move the fields
*Q1 / Q2 structural change.*

1. New `RetirementAccount extends InvestmentAccount` carrying `contributionBasis`,
   `earningsBasis`, `minimumAge`, `allowsEarlyWithdrawal`. `reconcileLedgerToBalance`
   **stays a free function** (decided) — it already guards on field presence, and the
   state-is-plain-data rule means it can't live as a method on the state object anyway;
   moving it onto the class buys nothing.
2. Reparent `FourOhOneKAccount` / `RothAccount` / `TraditionalIRAAccount` /
   `SuperannuationAccount` to `RetirementAccount`. Remove the four fields from
   `InvestmentAccount`; `BrokerageAccount` now inherits none of them.
3. Builder split (`account-builder.js:91`): `BaseInvestmentBuilder` **keeps** the
   `loanBalance` setter (brokerage's AU margin loan) and drops the four retirement setters;
   `BrokerageAccountBuilder` extends it directly. A new `RetirementBuilder extends
   BaseInvestmentBuilder` re-adds `contributionBasis` / `earningsBasis` / `minimumAge` /
   `allowsEarlyWithdrawal`, and the four retirement builders extend `RetirementBuilder`.
4. Serializer round-trip: the `in account` guards (`scenario-serializer.js:619`,
   `910`) already degrade gracefully; confirm the retirement classes still hydrate the
   fields and brokerage no longer carries them. `scenario-roundtrip` +
   `serializer-finance-roundtrip` cover this.
5. UI: gate `C.Basis` / `E.Basis` (`index.html:662-671`) on retirement types only.
   Narrow `INVESTMENT_TYPES` in `accounts-controller.js:18` to
   `{'401k','roth','ira','super'}` for the basis-bearing check (holdings visibility stays
   its own broader gate). Relabel `C.Basis`/`E.Basis` → `Contribution Basis` /
   `Earnings Basis` while we're here.

**Exit test**: full unit suite green; brokerage state has no basis fields; retirement
evt suites unchanged.

### Phase 3 — AU offset account
*Q3. Independent of Phases 1–2; can land in parallel.*

1. `ACCOUNT_TYPE.OFFSET`, `ACCOUNT_ROLES.AU_OFFSET`, `OffsetAccount` class + builder +
   serializer case + TypeRegistry registration.
2. `offsetsPropertyKey` linkage; editor row (a property picker) shown for type `offset`.
   Register `<stateKey>.balance` as `currency('AUD')` in `StateSchemaRegistry`.
3. `offsetBalanceForProperty(state, propStateKey)` helper; wire into
   `computeRentalTaxables` for AU (and US, symmetric) rental deductible-interest.
4. Decide toolset home: extend `AU_BANKING` (it already owns AU cash accounts and
   interest schedules) — the offset needs no interest schedule of its own (its "return"
   is the suppressed mortgage interest), so it's just a cash account + the rental hook.
5. New `evt-au-offset.test.mjs`: property with a mortgage + rental, assert
   `deductibleInterest` drops by `offsetBalance × rate / 12` and taxable rental rises
   accordingly; assert offset balance stays liquid/drawdown-eligible.

**Exit test**: `evt-au-offset` green; existing `evt-real-property` rental figures
unchanged when no offset is present.

### Phase 4 — Per-holding bond coupon rate
*Q4. Independent of Phases 1–3; pure-additive, can land in any order.*

1. `Holding.couponRate` field (constructor + `toJSON` + `fromJSON`), default `null`
   (`holding.js`).
2. `computeHoldingsGrowth` per-holding override, gated on
   `rateSource === 'effectiveInterestRates'` so only the fixed-income callers consult it
   (`holdings-earnings.js`); precedence `rateOverride ?? couponRate ?? rateKey-lookup ?? fallback`.
3. `state-schema-registry.js` pattern for `*.holdings.*.couponRate`
   (`ParameterValueType.rate()`), beside `dividendYield` (`:170`).
4. Editor: coupon-rate input on the holdings row, keeping `costBasis`
   (`account-editor.js:234-242`).
5. New `tests/unit/bond-coupon-rate.test.mjs`: a BOND holding with an explicit
   `couponRate` pays `MV × couponRate / 12` regardless of an active
   `effectiveInterestRates` regime shift, while a null-`couponRate` bond still floats with
   the regime-adjusted rate-key rate (today's behavior, unchanged); assert `duration`
   mark-to-market still applies to price and `costBasis` is untouched; assert an equity
   holding with a stray `couponRate` is unaffected (gated off the growth path).

**Exit test**: `bond-coupon-rate` green; existing `evt-us-brokerage` / fixed-income
interest suites unchanged when no `couponRate` is set (null ⇒ bit-for-bit today).

### Phase 5 — Holdings editor per-allocation inputs
*§5. UI-only. Depends on Phase 4 (the `couponRate` field must exist); otherwise
independent. No engine/serializer change.*

1. Add the `Income Rate` and `Duration` columns to the holdings `<thead>`
   (`index.html:678-686`).
2. Per-cell gating by `h.allocation` in the row template (`account-editor.js:234-242`) per
   the §5.2 matrix; merge the income-rate cell to bind `dividendYield` (EQUITY) /
   `couponRate` (BOND) (§5.3.2).
3. Re-render the row on `Allocation` change (§5.3.3); seed new-holding defaults
   (`account-editor.js:194-203`) with `dividendYield/couponRate/duration = null`.
4. Bond Cost Basis hidden + `costBasis = marketValue` on create/switch-to-BOND and on
   editor-time MV edits (§5.3.4).

**Exit test**: manual editor pass — each allocation shows exactly its §5.2 inputs; a bond
row hides Cost Basis and keeps it equal to Market Value across editor edits; a saved
scenario with `dividendYield`/`couponRate`/`duration` round-trips and is now editable.
(No unit-suite delta expected; add a light editor DOM test if the harness supports it.)

---

## 7. Risks / open questions

- **Phase 1 dead-read assumption.** The claim "nothing reads brokerage
  `contributionBasis`/`earningsBasis`" is from a grep + reading the sale/after-tax paths.
  A `--fix`-grade verification pass (or a temporary throwing getter) should confirm no
  serialized-scenario or MC/opt path reads them before deletion.
- **Saved-scenario compatibility.** Old saved brokerage states carry the two fields.
  Deserialization drops unknown opts harmlessly, and `reconcileLedgerToBalance` only
  fires when the fields are present — so old saves load without them and behave
  identically. Worth an explicit round-trip test with a legacy brokerage fixture.
- **Owner-occupied offset has no effect today** (§3.2). This is intended under the
  interest-reduction-only scope; flag it in the editor help text so it isn't read as a
  bug. Full interest-cost modeling is the future extension that makes it bite — that is
  `design/54-loan-liability-accounts.md`, where a first-class Loan account accrues real
  interest each period and the offset re-targets to it (`offsetsLoanKey`).
- **Multiple offsets / partial offset.** `offsetBalanceForProperty` sums all offset
  accounts linked to a property and clamps at `mortgageBalance`; a single offset is the
  common case.
- **Fixed vs floating coupon (§4.2).** A non-null `couponRate` deliberately bypasses the
  regime-adjusted `effectiveInterestRates`, so a fixed-coupon bond ignores the very rate
  shocks that (via `duration`) move its price. That is correct for a real fixed-coupon
  bond, but it means two knobs now describe one instrument (`couponRate` = income,
  `duration` = price sensitivity) and they must be set consistently. A bond with
  `duration` set but `couponRate` still null keeps floating its coupon — that is the
  back-compat default, not a bug.
- **Field name.** `couponRate` (chosen) vs `interestRate` (matches the handler's
  account-level field, but reads as generic on a `Holding` and collides conceptually with
  the account rate). `couponRate` is the bond twin of `dividendYield` and is unambiguous;
  revisit only if a non-coupon interest-bearing holding type appears.
