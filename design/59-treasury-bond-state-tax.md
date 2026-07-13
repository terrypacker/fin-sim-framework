# 59 — Treasury-aware bond coupon taxation (US state exemption)

**Status**: **IMPLEMENTED** (2026-07-12; all six phases green — 3360 unit + 865
viz, plus real-app verification). Scope: model bond **coupon interest** as a
distinct, taxable ordinary-income stream for `BOND` holdings, and add a
per-holding **`treasury`** flag that makes that coupon **federally taxable but
exempt from US state income tax** — the correct treatment for direct U.S.
Treasury obligations.

The user-facing surface is a single **"Treasury" checkbox** on each BOND holding
in the holdings editor: checked ⇒ Treasury (federal tax, no state tax); unchecked
⇒ non-Treasury/corporate (federal **and** state tax).

---

## 1. Motivation

The reference scenario holds bonds in several places — the two "Treasury Direct"
accounts (a single Treasury `BOND` holding each) and corporate bonds inside
"Brokerage (Terry)" and "Shared Brokerage". These should not be taxed the same
way: **interest on direct U.S. Treasury obligations is exempt from state income
tax**, while corporate-bond interest is fully taxable at both levels.

Two things block modeling this today:

1. **`couponRate` is dormant on brokerage bonds.** All bonds live as `BOND`-
   allocation **holdings inside `us-stock` `BrokerageAccount`s** (there is no
   `FIXED_INCOME` account in the reference scenario). On that path `couponRate`
   is never read — so there is no bond-interest tax line to exempt. See §3.
2. There is **no per-holding notion of Treasury-ness**, so even a correct
   interest stream could not be split into taxable vs exempt.

This design fixes (1) first (the larger half of the work) and then layers the
`treasury` exemption on top.

---

## 2. Tax law (research)

The Treasury exemption is **universal, not per-state**: federal law
(**31 U.S.C. § 3124**) prohibits every state from taxing interest on direct U.S.
Treasury obligations. So **no per-state (HI/NE) rule tables are needed** — a
single state-agnostic flag suffices.

| State | Treasury interest | Non-Treasury (corporate) interest | Notes |
|---|---|---|---|
| **NE** | Exempt (Schedule I subtraction) | Fully state-taxable | [NE Info Guide 8-646](https://revenue.nebraska.gov/sites/default/files/doc/info/8-646.pdf) |
| **HI** | Exempt (direct US obligations) | Fully state-taxable | [HI TIR 84-1](https://files.hawaii.gov/tax/legal/tir/1963_89/tir84-1.pdf) |
| **SD** | N/A — no individual income tax | N/A | Already a no-op via `hasIncomeTax = false` |

**Federal:** Treasury interest **is** federally taxable as ordinary income — the
exemption is state-only.

**Deliberately out of scope:** municipal bonds — the mirror image (exempt in the
*issuing* state, taxable elsewhere). That is a separate axis (needs issuer-state
vs residency-state comparison) and the current scenario holds no munis. Noted for
a future design.

---

## 3. Current mechanics (what a brokerage bond does today)

`BOND` holdings live in `us-stock` accounts, which are served by two income
events (`us-retirement-toolset.js`):

- **`INTL_STOCK_EARNINGS`** → `IntlUsStockEarningsHandler` → `computeHoldingsGrowth`
  on `effectiveGrowthRates` → `STOCK_EARNINGS_APPLY` (**untaxed** unrealized
  appreciation). `couponRate` is ignored here (it only fires on the
  `effectiveInterestRates` path, which these accounts never use — there is no
  `BOND_US` key in `effectiveInterestRates`).
- **`DIVIDEND_SCHEDULED`** → `DividendScheduledHandler` → `computeHoldingsDividends`.
  A BOND holding has `dividendYield: null`, so it **falls back to the account's
  equity dividend rate** and pays a *spurious equity dividend*, taxed as
  `STOCK_DIVIDEND_TAX` (ordinary income, federal + state).

Net: the bond's stated `couponRate` (0.038 / 0.0426 in the reference data) drives
**no** income; the bond instead earns equity-style growth plus a wrong-sized
"dividend." The holdings editor already *intends* the split (it binds `couponRate`
for BOND, `dividendYield` for EQUITY, mutually exclusive by allocation) — the
runtime just doesn't honor it.

### State-tax plumbing (ready to extend)

`StateIncomeClassificationReducer` (`state-income-classification.js`) folds each
federal income `*_TAX` action into one of four household accumulators via
`STATE_INCOME_ROUTING`. Adding a new taxable stream = one routing row. A Treasury
exemption = route on a **`stateTaxableAmount`** field (non-Treasury portion)
instead of the full `amount`; federal keeps using `amount`.

---

## 4. Design

Model bond coupon as its own stream, replacing the spurious bond dividend
(no double-count), and carry a Treasury split on the resulting tax action.

### 4.1 Data model (`src/finance/holdings/`)

- **`holding.js`** — add `treasury = false` (constructor + `toJSON` + `fromJSON`).
  Meaningful only for `BOND`; ignored for other allocations.
- **`holdings-earnings.js`** — add `computeHoldingsCoupons({ state, stateKey, fallbackRate })`:
  walks `BOND` holdings, `Σ marketValue × (couponRate ?? fallbackRate)`, returns
  `{ amount, stateTaxableAmount, holdingActions }` where `stateTaxableAmount`
  **excludes** `treasury` holdings' coupons. Mirrors `computeHoldingsDividends`.
- **`holdings-earnings.js`** — `computeHoldingsDividends`: **skip `BOND` holdings**
  (`if (h.allocation === 'BOND') continue;`) so bonds no longer pay an equity
  dividend. *(Behavior change — see §6.)*

### 4.2 Income event + handler + reducers

- **`BondCouponScheduledHandler`** (new, event `INTL_BOND_COUPON`, annual/year-end)
  mirroring `DividendScheduledHandler`. Emits `BOND_COUPON_APPLY` (reinvest) or
  `BOND_COUPON_CASH_APPLY` (cash payout), carrying `amount` (full coupon) **and**
  `stateTaxableAmount` (non-Treasury portion) + `stateKey` + `residency`.
- **`BondCouponApplyReducer` / `BondCouponCashApplyReducer`** (in
  `us-brokerage-classes.js`) — credit the account (reinvest) or the US savings
  pool (cash), then chain **`BOND_COUPON_TAX`** carrying `amount` +
  `stateTaxableAmount` + `residency`.
- **Wiring** (`us-retirement-toolset.js`): schedule `INTL_BOND_COUPON` per
  us-stock account that holds bonds (next to the `DIVIDEND_SCHEDULED` series,
  ~L538) and attach the handler in the us-stock loop (~L786).

### 4.3 Tax routing

- **Federal** (`us-tax-module-2024/2025/2026.js`): add `BOND_COUPON_TAX` →
  `usOrdinaryIncomeYTD += amount` (**full** coupon — Treasuries are federally
  taxable). Mirrors the `STOCK_DIVIDEND_TAX` handler.
- **State** (`state-income-classification.js`): add `BOND_COUPON_TAX` to
  `STATE_INCOME_ROUTING` → bucket `stateOrdinaryIncomeYTD`, folding
  **`stateTaxableAmount`** (extend the routing shape to allow a distinct state
  field, or stamp `stateTaxableAmount` and route on it). Update the state-vs-
  federal reconciliation guard — the Treasury exemption **intentionally** makes
  the state base < federal base.
- **Toolset types** (`US_BROKERAGE`): register `BOND_COUPON_APPLY`,
  `BOND_COUPON_CASH_APPLY`, `BOND_COUPON_TAX` action types and the new
  handler/reducer types.

### 4.4 UI (`account-editor.js`)

Add a **"Treasury" checkbox** cell on BOND holding rows (gated `alloc === 'BOND'`,
alongside the coupon/income cell ~L331), bound to `h.treasury`. Non-BOND rows
render an N/A cell. Route the edit through the holdings service like the other
per-holding fields.

---

## 5. Phased build & progress tracker

- [x] **P1 — Data model.** `Holding.treasury`; `computeHoldingsCoupons`; excluded
  BOND from `computeHoldingsDividends`.
- [x] **P2 — Income stream.** `BondCouponScheduledHandler` (`bond-coupon-handler.js`)
  + `BondCouponApplyReducer` (us-brokerage-classes) + `BondCouponCashApplyReducer`
  (`reducers/bond-coupon-cash-apply-reducer.js`) + `INTL_BOND_COUPON` scheduling/
  wiring in `us-retirement-toolset.js`; type registration in `US_BROKERAGE` and
  `scenario-serializer.js`.
- [x] **P3 — Federal tax.** `BOND_COUPON_TAX` → `usOrdinaryIncomeYTD` (full amount)
  in `us-tax-module-2026.js` (2024/2025 inherit the routing map).
- [x] **P4 — State tax.** `BOND_COUPON_TAX` routed on `stateTaxableAmount` (with an
  `amount` fallback) in `state-income-classification.js`; reconciliation guard
  (EVT-STATE-4) stays valid because it checks mid-year and defaults are unflagged.
- [x] **P5 — UI.** "Treasury" checkbox on BOND holding rows (`account-editor.js` +
  `index.html` header); checkbox wiring reads `.checked`.
- [x] **P6 — Tests + verify.** `evt-bond-coupon.test.mjs` (5 tests: coupon compute
  + split, fallback, all-Treasury exempt, end-to-end federal+state split, flag
  lowers state not federal); reducer coverage manifest updated; full suite green
  (3360 unit + 865 viz). Real-app verified: flagging Terry's Treasury Direct bond
  makes its $468.60 coupon federally taxable but `stateTaxable: 0`, other bonds
  unchanged.

---

## 6. Risks / notes

- **Behavior change (P1):** excluding BOND from `computeHoldingsDividends` stops
  bonds paying an equity dividend, so **golden numbers move even before the
  Treasury flag does anything**. This is the correct fix. If a purely additive
  path is preferred (coupon *on top of* the existing bond dividend, accepting the
  double-count), P1's dividend exclusion is dropped — call it out before P1.
- **Reconciliation guard:** the state/federal base-equality assertion (referenced
  in `state-income-classification.js` and the accounting tests) must learn that
  Treasury coupon is a legitimate federal-only line.
- **Serialization:** `Holding.treasury` needs round-trip coverage
  (`serializer-finance-roundtrip`); default `false` keeps old saves valid.
- **Related:** [[account-basis-two-concepts]], design 53 §4 (`couponRate` as the
  "bond twin of `dividendYield`"), design 34 (state tax engine).
