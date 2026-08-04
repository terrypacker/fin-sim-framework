# 60 — Money-market yield on cash sleeves of equity-served accounts

**Status**: **IMPLEMENTED** (2026-07-14; 3386 unit + 866 viz green, real-app
verified). Scope: pay interest on the **`CASH` sleeve** of accounts that are
driven by the equity-growth earnings handler (brokerage, 401k/IRA/Roth, AU
stock, super), so idle brokerage/retirement cash earns a money-market yield
instead of nothing.

---

## 1. Motivation

`CASH`-allocation holdings can live inside any account. Savings / offset /
fixed-income accounts have dedicated **monthly interest** handlers, so their cash
already earns. But **equity-served** accounts — us-stock brokerage, 401k, IRA,
Roth, au-stock, super — are driven by an *equity-growth* earnings handler
(`INTL_STOCK_EARNINGS` etc., on `effectiveGrowthRates`). Their cash sleeve had no
income source of its own.

Historically this was masked by a bug (the design-59 growth follow-up, see
[[design-59]]): `computeHoldingsGrowth` applied the account's **equity** growth
rate to every holding whose `rateKey` wasn't in `effectiveGrowthRates` — so a
`CASH` sleeve silently compounded at ~10% (plus a spurious equity dividend).
Removing that phantom return left brokerage/retirement cash earning **nothing**,
which is also wrong. This design gives it the correct, small, *taxable* yield.

## 2. Design

Model cash yield as **interest** (taxable ordinary income), NOT appreciation —
that is why the per-country growth rate can't carry it. A monthly stream mirrors
the existing savings-interest handlers:

- **Rate** = the account's country **savings rate**, read from
  `effectiveInterestRates` (`SAVINGS_US` / `SAVINGS_AU`) so it responds to regimes
  and per-account overrides, falling back to the `usSavingsInterestRate` /
  `auSavingsInterestRate` param. (Decision: reuse the savings rate — no new knob.)
- **Monthly compounding**: `mv × rate ÷ 12` credited each month-end and reinvested
  into the cash sleeve, so the *effective* annual yield sits slightly above the
  nominal rate — identical to how the savings-interest handlers already behave.
- **Only `CASH` sleeves** earn; EQUITY/BOND/GOLD/OTHER are skipped (BOND income is
  the design-59 coupon; GOLD appreciates; equity grows).

### 2.1 Tax treatment (per-country, by wrapper)

The `CASH_SLEEVE_INTEREST_APPLY` action carries a `taxMode`:

| taxMode | accounts | treatment |
|---|---|---|
| `us` | us-stock brokerage | US ordinary income (federal + state); when AU-resident, mirrored to `auOrdinaryIncomeYTD` + the FITO removal set (design 52), exactly like `UsSavingsInterestCreditReducer` |
| `au` | au-stock | AU ordinary income — chains `AU_SAVINGS_EARNINGS_TAX` (reuses the AU interest tax path) |
| `deferred` | 401k / IRA / Roth / super | balance only, no immediate tax — the grown balance is taxed (or not, for Roth) on withdrawal |

## 3. Implementation

- **`holdings-earnings.js`** — `computeHoldingsCashInterest({ state, stateKey,
  rateKey, fallbackRate, factor=1/12 })`: walks `CASH` holdings, `Σ mv × rate ×
  factor`, returns `{ amount, holdingActions }` (reinvest into each cash sleeve).
- **`CashSleeveInterestHandler`** (new, event `CASH_SLEEVE_INTEREST`, month-end) —
  one per equity-served account, carrying its `taxMode` + country `rateKey`.
  Emits `CASH_SLEEVE_INTEREST_APPLY` + the reinvest `HoldingTransactAction`s.
- **`CashSleeveInterestApplyReducer`** (new) — credits the balance (holdings +
  re-sync come from the emitted holding actions, mirroring
  `StockEarningsApplyReducer`) and applies tax by `taxMode`.
- **Wiring**: US accounts in `US_RETIREMENT` (schedules the shared monthly event +
  registers the reducer once); AU accounts (au-stock, super) in `AU_RETIREMENT`,
  subscribing to the same event. Extending existing always-active toolsets (rather
  than a new toolset) keeps saved scenarios — whose `toolsets` array is fixed —
  working without migration.
- **Serializer**: `CashSleeveInterestHandler` + `CashSleeveInterestApplyReducer`
  registered; coverage manifest + `evt-cash-sleeve-interest.test.mjs` added.

## 4. Notes / risks

- **Direction of the ending number can go DOWN.** In the reference scenario, net
  worth moved \$60.7m → \$59.1m: the direct interest is tiny (cash sleeves are
  small), but the extra taxable income and the monthly balance nudges re-sequence
  drawdowns — a known chaotic lever (see [[residency-drives-drawdown-sequencing]]),
  not a mis-credit. The end-to-end test confirms the sleeve grows and is taxed.
- **Event coupling**: the shared `CASH_SLEEVE_INTEREST` schedule is emitted by
  `US_RETIREMENT` (always active in the intl-retirement family) guarded on any
  equity-served account across both countries; the AU handlers read it from
  `schedulesById`. An AU-only scenario without `US_RETIREMENT` would not schedule
  it — acceptable for this scenario family.
- **Not wired** to savings/offset/fixed-income accounts (they have their own
  interest handlers) — avoids double-counting.

Related: [[design-59]], design 53 §4 (holding rate twins), design 52 (FITO),
design 55/56 (per-account + regime-aware interest rates).
