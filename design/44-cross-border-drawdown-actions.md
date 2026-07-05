# 44 — Cross-Border Drawdown Actions (missing INTL_TRANSFER and withdrawal-tax actions in `replenishSavings`)

**Status**: Implemented (2026-06-28). Gap B done; Gap A done via **A2** (not A1 — see §5). All unit + viz suites green.
**Related**: `design/43-basis-accounting-integrity.md` (surfaced the eligible-drawdown gap), design 36 (cross-border FX / residency), the `residency-drives-drawdown-sequencing` known issue. Code: `src/finance/services/account-service.js` (`replenishSavings`, `_drawPenaltyFree`, `fxOf`/`feeOf`), `src/finance/reducers/replenish-savings-reducer.js`, `src/finance/reducers/intl-transfer-apply-reducer.js`.

> **Trigger.** Late in life, an AU-resident couple draws down to meet monthly expenses. The Monthly Expenses event fires `REPLENISH_SAVINGS(targetKey = auSavingsAccount)`; money flows **Roth → US Savings → AU Savings** (`auSavingsAccount.balance $1,942 → $33,605`, `+$31,663`, to cover a `$31,670` expense debit). Two things are wrong in the journal:
> 1. **No `INTL_TRANSFER_APPLY` action** is emitted for the USD→AUD move — the currency border is crossed silently.
> 2. **No tax actions** are emitted for the drawdown.
>
> Both stem from one design choice: `replenishSavings` reaches the non-resident **cash pool across the currency border itself** and draws **age-eligible** accounts through a branch that only emits tax for brokerage. The dedicated `IntlTransferApplyReducer` (transfer action + FX semantics) and the tax-action chain are bypassed.

---

## 1. How the money actually moves (and why no action is recorded)

`ReplenishSavingsReducer.reduce` (`replenish-savings-reducer.js:55`) calls `AccountService.replenishSavings(state, 'auSavingsAccount', deficit, …)` and turns the result into `RecordBalanceAction`s + the returned `pendingTaxActions`. It only chains `INTL_TRANSFER_APPLY` **in the `catch`** — i.e. *only when `replenishSavings` throws `InsufficientFundsError`* (domestic sources exhausted).

But `replenishSavings` does **not** throw here, because it treats the non-resident cash pool as a reachable source:

- **Cash roles are liquid across the border** (`account-service.js:494–497`): `isCashRole(v)` (US_SAVINGS / AU_SAVINGS) lets a source in the *other* country compete even under `LOCAL_FIRST`. So for an AU target, `usSavingsAccount` (a US cash role) is a valid source.
- The cross-currency conversion + flat FX fee are applied **inline** in `_drawPenaltyFree` (`account-service.js:728–771`):
  - `fxOf(account)` = units of target currency per 1 unit of source currency (`:484`),
  - `feeOf(account)` = flat USD fee converted to target currency, charged only when `fx !== 1` (`:490`),
  - `credited = withdraw * fx - fee`; then two bare `transaction()` calls move the cash (`:740–741`).

So the USD→AUD transfer happens entirely inside `replenishSavings` via `transaction()`, the deficit is covered, **no exception is thrown, and `INTL_TRANSFER_APPLY` is never chained.** The journal shows the AU savings balance jump with no transfer event.

**This is a second, divergent implementation of the same cross-currency conversion** that `IntlTransferApplyReducer` already owns (`intl-transfer-apply-reducer.js:73–124`, same `rate`/`feeUsd` source). The two can drift, and only one emits an action / journal entry.

---

## 2. Why no tax action is emitted

`replenishSavings` has two phases:

- **Phase 1 — penalty-free** (`_drawPenaltyFree`, eligible branch `:734–771`): for age-eligible accounts it debits the source and credits the target, but **only `BROKERAGE` pushes a tax action** (`STOCK_WITHDRAWAL_TAX`, `:763`). An age-eligible **IRA / 401k / super** drawn here emits **nothing**.
- **Phase 2 — early withdrawal** (`:583–681`): *does* push `ROTH_/IRA_/K401_WITHDRAWAL_*` tax actions — but Phase 2 only runs for **under-age** accounts when Phase 1 can't cover the deficit.

Net: **age-eligible retirement/super withdrawals via `replenishSavings` escape income tax.** In the trigger, the source drawn was a **Roth** while eligible — a *qualified* Roth withdrawal is genuinely US-tax-free, so "no tax action" is *coincidentally* correct for that one type (modulo any AU treaty treatment of Roth, which we do not currently model). But the same code path under-taxes:

| Eligible account drawn via `replenishSavings` | Correct tax on withdrawal | Emitted today |
|---|---|---|
| BROKERAGE | cap-gains on the realized gain | ✅ `STOCK_WITHDRAWAL_TAX` |
| TRADITIONAL_IRA | ordinary income on the whole draw | ❌ nothing |
| FOUR_OH_ONE_K | ordinary income on the whole draw | ❌ nothing |
| SUPER (earnings portion) | US-ordinary on earnings (per design 43 §1) | ❌ nothing |
| ROTH (qualified) | tax-free (US) | ✅ correctly nothing* |

\* assuming no AU-side Roth taxation is modeled.

This is the same branch design 43 §2 patched for the **basis ledger** (`reduceLedgerForWithdrawal`); the **tax-action** half was explicitly deferred to here.

---

## 3. Root cause

One method, `replenishSavings`, is doing three jobs that the action pipeline already has dedicated handlers for:

1. **domestic drawdown** (its real job),
2. **cross-currency transfer** — duplicating `IntlTransferApplyReducer` and skipping its action,
3. **withdrawal taxation** — partially (brokerage only) in Phase 1, fully in Phase 2.

Because (2) and (3) are inlined rather than expressed as chained actions, the cross-border move and the retirement-withdrawal tax are invisible to the journal, telemetry, tax documents, and any reducer that reacts to those action types.

---

## 4. What "correct" looks like

Every balance movement that crosses the currency border or realizes a taxable withdrawal should be expressed as an **action** so it is journaled, telemetered, and processed by the one authority for that concern:

```
cross-currency cash sweep   → INTL_TRANSFER_APPLY (rate + fee + FX gain, one implementation)
eligible IRA/401k draw      → ordinary-income tax action
eligible super earnings draw→ SUPER_WITHDRAWAL_EARNINGS_TAX
eligible Roth (qualified)   → (no US tax; explicit, not silent)
```

Invariant to test: **for any drawdown that debits a source in a different currency than the target, exactly one `INTL_TRANSFER_APPLY` (or equivalent FX action) appears in the journal**, and **for any eligible withdrawal from a tax-bearing retirement account, a withdrawal-tax action is emitted** (amount/character matching the account type).

---

## 5. Fix options

**Gap A — missing transfer action.** Two directions:

- **A1 (preferred) — don't cross the border inside `replenishSavings`.** Restrict its sources to the **target's own currency** (drop `isCashRole` cross-border reachability), and let it throw `InsufficientFundsError` when the local country is exhausted — which already chains `INTL_TRANSFER_APPLY` (`replenish-savings-reducer.js:66–71`). The transfer then runs through the one authority, emitting the action and its FX semantics. Removes the duplicate conversion entirely. *Risk*: changes drawdown sequencing for cross-border scenarios (the non-resident cash pool is no longer swept first) — pairs with the `residency-drives-drawdown-sequencing` lever; needs scenario regression.
- **A2 (smaller) — emit the action from the inline path.** Keep the cross-border sweep in `replenishSavings` but have it (or the reducer, from `drawnKeys` + currency) emit an `INTL_TRANSFER_APPLY`/record action for the converted leg so it's journaled. *Risk*: keeps two conversion implementations; they must stay in sync.

**Gap B — missing withdrawal-tax actions.** Mirror the Phase-2 tax-action logic into the Phase-1 eligible branch (`_drawPenaltyFree`), keyed by `account.type`: IRA/401k → ordinary-income action on the gross; SUPER → `SUPER_WITHDRAWAL_EARNINGS_TAX` on the earnings portion (use the same earnings/contribution split `reduceLedgerForWithdrawal` now computes); ROTH-qualified → no action (explicitly). Reuse the existing action `type`s so downstream tax settle / tax documents pick them up unchanged. Add a test asserting an eligible IRA/super draw via `replenishSavings` produces the right tax action.

**Recommendation:** **A1 + Gap B.** A1 collapses the cross-border duplication onto the existing transfer authority (fewer code paths, automatic journaling); Gap B closes the under-taxation. Stage A1 behind a scenario regression because it shifts drawdown ordering.

### 5a. What was actually implemented (and why A2, not A1)

During implementation, A1 was found to **directly conflict with an explicit, tested design decision** — `EVT-DRAWDOWN: non-residence cash is repatriated even under LOCAL_FIRST` (`tests/unit/evt-drawdown-strategy.test.mjs:268`), the "stranding fix." That fix deliberately sweeps idle foreign cash *inside* `replenishSavings` so it is spent **before** liquidating domestic investments. A1 would reverse that ordering (drain domestic investments first, realizing taxable gains, and repatriate idle foreign cash only after a country is fully exhausted) — a real behavioral regression, not just a reshuffle. Per that finding the user chose **A2**.

- **Gap B — done.** `_drawPenaltyFree`'s eligible branch now emits the withdrawal-tax action the type reducers would: `IRA_WITHDRAWAL_CONTRIB_TAX` + `IRA_WITHDRAWAL_EARNINGS_TAX` (IRA), `K401_WITHDRAWAL_TAX` (401k, gross), `SUPER_WITHDRAWAL_EARNINGS_TAX` (super, earnings portion only); qualified Roth emits nothing. Amounts are source-currency, matching Phase 2 and the brokerage path. `reduceLedgerForWithdrawal` now returns the `{ fromContrib, fromEarnings }` split so the tax amounts and the ledger reduction come from one computation. Tests in `account-service.test.mjs`.
- **Gap A — done via A2 (journal the inline sweep).** The inline cross-border sweep is preserved (ordering unchanged). `replenishSavings` now collects an `INTL_TRANSFER_RECORD` per cross-currency leg (via a `pushTransfer` closure that reuses the already-computed `withdraw`/`credited`/`fee` — one conversion, faithfully recorded) and returns them as `crossBorderTransfers`. `ReplenishSavingsReducer` (and the two `replenishSavings` calls inside `IntlTransferApplyReducer`) emit them. A new no-op-state `IntlTransferRecordReducer` makes them appear in the journal/telemetry (an emitted action with no registered reducer is silently dropped, so the record needs its own reducer). Wired into `US_AU_CROSS_BORDER` (reducers + action schema), the serializer class list, the reducer-coverage manifest, and `index.js`. Tests in `evt-drawdown-strategy.test.mjs`.
- **Shared-FX-helper extraction — done.** `src/finance/fx/fx-conversion.js` is now the single source of truth for the USD↔AUD rate+fee math (`fxRate`, `fxFeeIn`, `convertNetOfFee`, `grossUpForTarget`). Both `replenishSavings` (`fxOf`/`feeOf`) and `IntlTransferApplyReducer` (both directions) route through it, so they cannot drift. Verified equivalent against the prior inline formulas (`(src − feeUsd)·rate` / `src/rate − feeUsd`) by the unchanged cross-border suites plus `tests/unit/fx-conversion.test.mjs`.
- **Other replenish call sites — done.** `tax-settle-classes`, `state-tax-settle-classes`, and `fx-transfer-handler` now capture and emit `crossBorderTransfers`, so a cross-currency cash leg of a tax-payment top-up or an FX-transfer source top-up is journaled as `INTL_TRANSFER_RECORD` too. All `replenishSavings` call sites that can pull foreign cash now surface the record.

---

## 6. Risks / downstream to watch

- A1 changes which accounts drain first in cross-border scenarios (sequencing is a large hidden lever on ending wealth — see `residency-drives-drawdown-sequencing`). Gate on a before/after scenario diff via `scripts/run-scenario.mjs`.
- `IntlTransferApplyReducer` itself calls `replenishSavings` to top up the *source* before transferring (`:86`, `:108`); under A1 that inner call must stay same-currency (it already targets the source's own savings) to avoid recursion across the border.
- Tax actions emitted in Phase 1 must use the same residency/character fields the settle reducers expect (`STOCK_WITHDRAWAL_TAX` already carries `residency`); verify IRA/401k/super action shapes against `tax-settle-classes` / `tax-document-registry`.
- The flat FX fee and any FX gain/loss currently realized inline in `replenishSavings` would, under A1, be realized by `IntlTransferApplyReducer` instead — confirm the fee is charged once, not twice.
