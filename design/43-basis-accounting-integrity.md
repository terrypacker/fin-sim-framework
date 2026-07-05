# 43 — Basis-Accounting Integrity (cost basis & the contribution/earnings ledger)

**Status**: Proposed (draft 2026-06-28). Investigation complete; awaiting greenlight to implement.
**Related**: `design/40-after-tax-net-worth.md` (the metric that surfaced this — reads `earningsBasis` for super and holdings `costBasis` for brokerage), design 25 (holdings / §4.4 invariant), the known-issue family in `design/inconsistencies.md`. Code: `src/finance/services/account-service.js` (`transaction`, `update`, `replenishSavings`), `src/finance/holdings/holding-utils.js` (`rescaleHoldingsToBalance`), `src/finance/holdings/holdings-fifo.js` (`consumeHoldingsFifo`), `src/finance/assets/investment-account.js` (`contributionBasis`/`earningsBasis`).

> **Trigger.** Live accounts show cost basis out of sync with balance — e.g. `superAccount`: `contributionBasis 180k`, `earningsBasis 0`, `balance 39k`. The user asked whether the account-level basis field is now redundant (holdings track cost basis) and could be removed. **Answer: no — it's a different concept, and both ledgers are being corrupted by the same generic balance-mutation paths.** This note explains the two concepts, pinpoints the corruption, and scopes the fix.

---

## 1. There are two distinct "basis" concepts

| | Holdings per-lot **`costBasis`** (+ `marketValue`) | Account **`contributionBasis`/`earningsBasis`** |
|---|---|---|
| Lives on | each lot in `account.holdings` | `InvestmentAccount` scalar fields |
| Answers | what you paid vs current value → **capital-gains tax on a SALE** (taxable brokerage) | after-tax contributions vs untaxed earnings → **withdrawal tax for retirement/super** (Roth basis, super contribution-tax-free vs earnings-taxed-as-US-ordinary, IRA basis) |
| Maintained by | holdings reducers; FIFO consume on sale (`consumeHoldingsFifo`) | account-type reducers (super/Roth/IRA contribution & withdrawal) |
| Consumers | brokerage sale gain, tax-loss/gain harvest, rebalance, after-tax metric (unrealized gain) | ~14 modules: `roth-classes`, `ira-classes`, `k401-classes`, `roth-conversion-classes`, `ira-rollover-classes`, `au-super-classes`, `au-brokerage-classes`, `dividend-scheduled-handler`, `account-service`, `state-schema-registry`, `scenario-compare-utils`, after-tax metric (super earnings) |

They **coincide numerically for a plain taxable brokerage** (contributions ≈ Σ `costBasis`, earnings ≈ Σ unrealized), but **diverge for retirement accounts**, where the split is about tax *timing*, not market gains. **Holdings carry no tax-character dimension** — so the account ledger cannot be replaced by holdings cost basis for super/Roth/IRA. (This is why removing the field is the wrong move; §6.)

The coherence we want, per account:

```
balance == Σ holdings[i].marketValue                 (§4.4 invariant — already enforced)
balance == contributionBasis + earningsBasis         (tax-character ledger — NOT enforced today)
Σ holdings[i].costBasis  tracks real purchase cost    (cap-gains basis — corrupted today)
```

---

## 2. Where it breaks (precise)

Two generic balance-mutation paths move `balance` without honestly maintaining basis:

1. **`AccountService.transaction(account, amount, date)`** (`account-service.js:248`) — the generic cash primitive. Its own doc (`:240`): *"`transaction()` … does not compute"* the basis ledger. It updates `balance` and keeps the §4.4 holdings-marketValue invariant, but **never touches `contributionBasis`/`earningsBasis`.** So any drawdown via the generic path (expense debit, `replenishSavings` cross-account moves `:623–645`, out-of-funds, intl transfer) drops `balance` while the ledger stays put → `contributionBasis 180k` vs `balance 39k`.

2. **`rescaleHoldingsToBalance(holdings, targetBalance)`** (`holding-utils.js:62`), invoked by `AccountService.update()` (`:96–98`) whenever a balance edit arrives without holdings (param cascade / Rebuild / programmatic set). It rescales `marketValue` to the target — correct — but also **rewrites `costBasis`**:
   - **single-holding** (the common case): `holdings[0].costBasis = target` → **cost basis forced to market value → unrealized gain wiped to 0.**
   - **multi-holding**: `costBasis *= target/Σ marketValue` → *this already preserves the gain ratio.* So only the single-holding (and `curSum<=0`) branches are destructive.

**Net effect:** both the cap-gains basis (holdings) and the tax-character ledger (account) drift, in the exact paths that matter (drawdowns + Rebuilds). It's the same family as the known `holdings-balance-desync` / `multi-holding-transaction-desync` issues.

**A basis-correct primitive already exists but isn't used by drawdowns:** `consumeHoldingsFifo(holdings, amount)` (`holdings-fifo.js:34`) FIFO-consumes lots and returns `realizedBasis` (+ per-country), decrementing each lot's `costBasis` proportionally — exactly the right withdrawal math. `replenishSavings` and friends call `transaction()` instead.

---

## 3. Correct semantics, per mutation kind

The root conflation: `transaction()`/`rescaleHoldingsToBalance` can't see *why* balance changed, so they apply one (wrong) rule to all. The honest rules:

| Mutation | `marketValue` | `costBasis` (holdings) | Ledger (`contribution`/`earnings`) |
|---|---|---|---|
| **Market move / earnings accrual** | +gain | unchanged (gain is unrealized) | `earnings += gain` |
| **Contribution** (cash in) | +amt | +amt (new lot at cost) | `contribution += amt` |
| **Withdrawal / drawdown** (cash out) | −amt | −realizedBasis (FIFO) | reduce per tax-ordering (Roth: contributions-first; super: pro-rata; default: proportional) |
| **Sale** (brokerage) | −proceeds | −realizedBasis | n/a (gain → `usCapitalGainsYTD`) |
| **Param/Rebuild balance edit** | rescale to target | **scale by the same factor** (preserve gain ratio) — *not* reset to target | rescale both components by the same factor |

The single rule that fixes most of it: **a balance change never resets cost basis** — it either leaves it (market move), adds at cost (contribution), realizes it proportionally (withdrawal/sale), or scales it by the balance factor (param rescale).

---

## 4. Invariants to enforce (and test)

1. **Ledger sums to balance:** `contributionBasis + earningsBasis == balance` (±rounding) for ledger-bearing accounts, after every mutation.
2. **Basis ≤ value:** `Σ costBasis ≤ Σ marketValue + ε` is *not* required (losses exist), but `costBasis ≥ 0` and `contributionBasis, earningsBasis ≥ 0`.
3. **Rescale preserves gain ratio:** after `rescaleHoldingsToBalance`, each lot's `costBasis/marketValue` is unchanged (so unrealized-gain % survives a Rebuild).
4. **Conservation across a drawdown:** a withdrawal of `w` reduces `Σ marketValue` by `w` and `Σ costBasis` by the FIFO `realizedBasis`, and the realized gain it implies equals `w − realizedBasis`.

A property test harness ("apply N random contributions/withdrawals/market-moves, assert the four invariants hold") would catch regressions across all the type-specific reducers.

---

## 5. Fix plan (phased, low-risk first)

- **Phase 1 — stop the holdings corruption (contained, high-value).** Make `rescaleHoldingsToBalance` scale `costBasis` by the balance factor in **all** branches (mirror the multi-holding branch into the single-holding / `curSum<=0` branches): `costBasis = costBasis * (target / marketValue)` (or `target` only when `marketValue == 0`). Immediately stops Rebuilds/param-edits from wiping unrealized gain — directly improves the after-tax metric's brokerage valuation and tax-loss/gain harvest. Add invariant-3 test.
- **Phase 2 — basis-correct drawdowns.** Route balance-reducing drawdowns through `consumeHoldingsFifo` (realize cost basis) instead of bare `transaction()`, OR have `transaction(account, −amt)` for ledger-bearing accounts reduce the ledger by the appropriate rule (default proportional; the type-specific reducers already implement Roth-contributions-first / super contribution-vs-earnings and should remain the authority where withdrawals flow through them). Add invariants 1 & 4 tests.
- **Phase 3 — reconcile / guard.** A one-time reconcile (clamp `contributionBasis + earningsBasis` to `balance`, preserving the earnings fraction) for already-drifted saved states, plus the property-test harness (§4) wired into the suite.
- **Decision — keep the account field (§6).** Do *not* remove `contributionBasis`/`earningsBasis`.

A worthwhile **simplification** to evaluate in Phase 2: for **taxable brokerage only**, derive contribution/earnings from holdings (`contribution = Σ costBasis`, `earnings = Σ unrealized`) so there's a single source of truth — but this is *only* sound once Phase 1 makes holdings `costBasis` trustworthy, and it does **not** extend to retirement accounts (keep their explicit ledger).

---

## 6. Decision: do not remove the account basis field

The field is **not** redundant with holdings:
- **Holdings can't represent retirement tax character** (contribution-vs-earnings tax *timing*), which drives super/Roth/IRA withdrawal taxation — holdings only know cost vs market value.
- **Holdings cost basis is itself corrupted today** (§2) — removing the ledger would swap one unreliable source for a lossier one.
- **~14 modules** read the ledger.

The drift is a *maintenance* bug, not evidence of redundancy. Fix the maintenance (§5); keep the field.

---

## 7. Impact on the after-tax metric (design 40)

Until Phase 1–2 land, the metric is affected by the drift:
- **Brokerage:** wiped `costBasis` (single-holding rescale) ⇒ unrealized gain reads 0 ⇒ no cap-gains discount ⇒ over-values taxable brokerage. (The metric already has an `assumedGainFraction` fallback for *missing* basis, but not for basis silently reset to balance.)
- **Super:** `earningsBasis` drifting to 0 ⇒ metric treats super as all tax-free contribution. (Mitigated: the metric uses `balance − earningsBasis`, robust to the `contributionBasis`-field drift specifically — but still wrong if real earnings exist and `earningsBasis` was zeroed.)

No metric change is needed once the ledgers are honest — design 40 already reads the right fields.

---

## 8. Risks / downstream to watch

- The year-end `_syncBalance`/earnings re-sync (the "account bounce" in `multi-holding-transaction-desync`) re-snaps `balance` to `Σ marketValue` — any ledger fix must survive that snap.
- Roth-conversion (`roth-conversion-classes`) and rollovers (`ira-rollover-classes`) move basis between accounts; they must be included in the invariant tests.
- Serialization round-trip + `scenario-compare-utils` read the ledger; reconcile (Phase 3) must run before they do.
