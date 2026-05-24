# Requirements Tracker

Source: *JP Spec Retirement path-with-ids.xlsx* (project root).  
Sheet "Period Summary" is informational only and excluded.

Each requirement has a stable ID. Tests that cover a requirement must include the ID in the test name:

```
test('EVT-1: Roth contribution increases balance', () => { ... });
test('TE-3: Ordinary income uses bracket calculation', () => { ... });
```

Run the coverage check at any time:

```sh
node scripts/check-requirements.js
```

---

## Coverage legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Tested — at least one `test('ID:…')` exists |
| ⬜ | Not yet tested |
| ⚠️ | Partially covered — referenced in comments but no dedicated `test('ID:…')` |

---

## Sheet: JP Spec Retirement path — Event Requirements

Columns: Account · Event description · Balance direction · Balance part · Earnings logic · Cash flow · Min-age gate · Early penalty · US tax · US rate · AU tax · AU rate · FTC?

| ID | Account | Event | Direction | US Tax | AU Tax | FTC | Status |
|----|---------|-------|-----------|--------|--------|-----|--------|
| EVT-1 | Roth | Contribution | + contribution | N | N | N | ✅ |
| EVT-2 | Roth | Withdrawal – Contributions | − contribution | N | N | N | ✅ |
| EVT-3 | Roth | Withdrawal – Earnings | − earnings | N (10% penalty if age < 59.5) | Ordinary Income if resident | Y | ✅ |
| EVT-4 | Roth | Earnings | + earnings | N | N | N | ✅ |
| EVT-5 | IRA | Contribution | + contribution | Negative Income | N | N | ✅ |
| EVT-6 | IRA | Withdrawal – Contributions | − contribution | Ordinary Income | N | N | ✅ |
| EVT-7 | IRA | Withdrawal – Earnings | − earnings | Ordinary Income | Ordinary Income if resident | Y | ✅ |
| EVT-8 | IRA | Earnings | + earnings | N | N | N | ✅ |
| EVT-9 | US Brokerage | Fixed Income – Contribution | + balance | N | N | N | ✅ |
| EVT-10 | US Brokerage | Fixed Income – Withdrawal | − balance | N | N | N | ✅ |
| EVT-11 | US Brokerage | Fixed Income – Earnings | + balance | Ordinary Income | Ordinary Income if resident | Y | ✅ |
| EVT-12 | US Brokerage | Stocks – Contribution | + contribution (basis) | N | N | N | ✅ |
| EVT-13 | US Brokerage | Stocks – Dividend Yield | + contribution (basis) | Ordinary Income | Ordinary Income if resident | Y | ✅ |
| EVT-14 | US Brokerage | Stocks – Earnings | + earnings | N | N | N | ✅ |
| EVT-15 | US Brokerage | Stocks – Withdrawal (sale) | − earnings or contribution | Capital Gain | Capital Gain if resident | Y | ✅ |
| EVT-16 | AU Savings | Contribution | + balance | N | N | N | ✅ |
| EVT-17 | AU Savings | Withdrawal | − balance | N | N | N | ✅ |
| EVT-18 | AU Savings | Earnings as Resident | + balance | Ordinary Income | Ordinary Income (always) | Y | ✅ |
| EVT-19 | AU Savings | Earnings as Non-Resident | + balance | Ordinary Income | Non-Resident Withholding (always) | Y | ✅ |
| EVT-20 | Super | Contribution | + contribution | N | Super (15%, always) | N | ✅ |
| EVT-21 | Super | Withdrawal – Contribution | − contribution | N | N (age 60+) | N | ✅ |
| EVT-22 | Super | Withdrawal – Earnings | − earnings | Ordinary Income | N (age 60+) | N | ✅ |
| EVT-23 | Super | Earnings | + earnings | N | Super (15%, always) | N | ✅ |
| EVT-24 | 401K | Contribution | + contribution | Negative Income (pre-tax) | N | N | ✅ |
| EVT-25 | 401K | Earnings / Withdrawal | + earnings | Ordinary Income | N | N | ✅ |
| EVT-26 | AU Brokerage | Stocks – Div Franked as Resident | + contribution (basis) | Ordinary Income | Franking Credit | Y | ✅ |
| EVT-27 | AU Brokerage | Stocks – Div Franked as Non-Resident | + contribution (basis) | Ordinary Income | N | N | ✅ |
| EVT-28 | AU Brokerage | Stocks – Div Unfranked as Resident | + contribution (basis) | Ordinary Income | Ordinary Income | Y | ✅ |
| EVT-29 | AU Brokerage | Stocks – Div Unfranked as Non-Resident | + contribution (basis) | Ordinary Income | Non-Resident Withholding | Y | ✅ |
| EVT-30 | AU Brokerage | Stocks – Earnings | + earnings | N | N | N | ✅ |
| EVT-31 | AU Brokerage | Stocks – Withdrawal as Resident | − earnings or contribution | Capital Gain | Capital Gain | Y | ✅ |
| EVT-32 | AU Brokerage | Stocks – Withdrawal as Non-Resident | − earnings or contribution | Capital Gain | N | N | ✅ |
| EVT-33 | Real Property | House Sale – Australia | − contribution & basis | Capital Gain | Non-Resident Tax Rates | Y | ✅ |
| EVT-34 | Real Property | House Sale – US | − contribution & basis | Capital Gain (after $500K exemption) | Capital Gain if resident | N | ✅ |
| EVT-35 | IRA | IRA Rollover Withdrawal | − contribution & earnings | Ordinary Income | Ordinary Income if resident | N | ✅ |
| EVT-36 | Collectible | Sale – Baseball Cards | − contribution & basis | Collectible (28%) | Capital Gain if resident | N | ✅ |
| EVT-37 | US Checking | Social Security Income | + $ amount/month | Social Security Income (85% taxable) | Ordinary Income if resident | N | ✅ |
| EVT-38 | US Checking | Wages (Gross) | + $ amount/month | Ordinary Income | Ordinary Income if resident | N | ✅ |
| EVT-39 | US Checking | Wages – Taxes Withheld | − % of amount | N/A (withholding) | N/A | N | ✅ |
| EVT-40 | IRA | IRA Withdrawal – RMD | − contribution & earnings | Ordinary Income (required at age 72) | Ordinary Income if resident | N | ✅ |
| EVT-41 | Roth | Roth Rollover Contribution | + contribution | N | N | N | ✅ |
| EVT-42 | Roth | Roth Rollover Earnings | + earnings | N | N | N | ✅ |
| EVT-43 | Roth | Roth Rollover Withdrawal – Contributions | − rollover contribution | N | N | N | ✅ |
| EVT-44 | Roth | Roth Rollover Withdrawal – Earnings | − rollover earnings | N | Ordinary Income if resident | N | ✅ |
| EVT-45 | Collectible | Change in Value – Baseball Cards | +/− balance | N | N | N | ✅ |
| EVT-46 | Collectible | Sale – Gold | − contribution & basis | Collectible (28%) | Capital Gain if resident | N | ✅ |
| EVT-47 | Collectible | Change in Value – Gold | +/− balance | N | N | N | ✅ |
| EVT-48 | US Checking | Self-Employment Income | + $ amount/month | Ordinary Income | Ordinary Income if resident | N | ✅ |
| EVT-49 | AU Savings | Self-Employment Income | + $ amount/month | Ordinary Income | Ordinary Income if resident | N | ✅ |
| EVT-50 | US Checking | Bonus | + $ amount | Ordinary Income | Ordinary Income if resident | N | ✅ |
| EVT-51 | US Checking | Company Sale | + $ amount | Capital Gain | Capital Gain if resident | N | ✅ |
| EVT-52 | Roth Conversion | IRA → Roth Conversion | −IRA, +Roth rollover contribs | Ordinary Income | Ordinary Income if resident | N | ✅ |

**EVT coverage: 52 / 52 tested**

---

## Sheet: Tax Rates — Tax Requirements

| ID | Tax Rate Type | US Treatment | AU Treatment | Status |
|----|--------------|--------------|--------------|--------|
| TE-1 | Superannuation | N/A | 15% flat + negative income (tax deduction) | ✅ |
| TE-2 | Non-Resident Withholding | N/A | 15% | ✅ |
| TE-3 | Ordinary Income | Tax brackets minus standard deduction | Tax brackets | ✅ |
| TE-4 | Long-Term Capital Gains | % gain based on total income (minus std deduction) | Ordinary Income brackets with 50% discount | ✅ |
| TE-5 | Non-Resident Tax Rates | N/A | Different brackets with NO 50% discount | ✅ |
| TE-6 | Franking Credit | Same as ordinary income | Tax brackets with 30% discount | ✅ |
| TE-7 | Collectibles | 28% of gain | Capital Gains | ✅ |
| TE-8 | Social Security Income | 85% of benefit is taxable | Ordinary income | ✅ |

**TE coverage: 8 / 8 tested**

> Note: The tax rate logic is implemented in the tax modules (`UsTaxModule*`, `AuTaxModule*`) and exercised
> indirectly through EVT tests. TE requirements need dedicated tests that verify the *rate calculation*
> in isolation — bracket math, discount factors, exemptions.

---

## Sheet: Assets — Asset Rules Requirements

| ID | Asset | Transaction Account | Ownership | Min Balance | Min Age | Track Contrib/Earnings | Track Balance @ Residency | Allow Loan | Drawdown Priority | Status |
|----|-------|--------------------|-----------|-----------|---------|-----------------------|--------------------------|------------|-------------------|--------|
| AR-1 | US Checking | Y | Y (50/50 or solo) | Y | N | N | N | N | 1 | ✅ |
| AR-2 | AU Savings | Y | Y | Y | N | N | N | N | 3 | ✅ |
| AR-3 | Brokerage – Fixed Income | N | Y | N | N | N | N | N | 2 | ✅ |
| AR-4 | Brokerage – Stocks (US) | N | Y | N | N | Y | Y | N | 4 | ✅ |
| AR-5 | AU Brokerage – Stocks | N | Y | N | N | Y | Y | Y | 4 | ✅ |
| AR-6 | Roth | N | Y | N | Y | Y | Y | N | 5 | ✅ |
| AR-7 | IRA | N | Y | N | Y | Y | Y | N | 7 | ✅ |
| AR-8 | 401k | N | Y | N | Y | Y | Y | N | 8 | ✅ |
| AR-9 | Real Property | N | Y | N | N | Y | Y | Y | 10 | ✅ |
| AR-10 | Superannuation | N | Y | N | Y | Y | N | N | 9 | ✅ |
| AR-11 | Collectible | N | Y | N | N | Y | Y | N | 11 | ✅ |

**AR coverage: 11 / 11 tested**

---

## Sheet: Inflation — Inflation Requirements

| ID | Description | US Treatment | AU Treatment | Status |
|----|------------|--------------|--------------|--------|
| INFL-1 | Country-Based Rate Setting | Per-year rate for US | Per-year rate for AU | ⬜ |
| INFL-2 | Social Security Income | Increases at US inflation rate | Increases at US inflation rate | ⬜ |
| INFL-3 | Salary | Increases at country inflation rate | Increases at country inflation rate | ⬜ |
| INFL-4 | Expenses | Increases at country-of-residence rate | Increases at country-of-residence rate | ⬜ |
| INFL-5 | Tax Rates | Brackets/rates increase with inflation | Brackets/rates increase with inflation | ⬜ |

**INFL coverage: 0 / 5 tested**

---

## Sheet: Early Withdrawal Drawdown — EW Requirements

These requirements govern the *automated drawdown* path (`replenishSavings` / `ReplenishSavingsReducer` /
`IntlTransferApplyReducer`), where the simulation draws from retirement accounts to cover a cash deficit
before the person has reached the normal penalty-free age.  They complement the existing EVT requirements,
which cover explicit manual withdrawal events.

Age threshold for all US retirement accounts: **59.5** (IRS rule, decimal years).  
Super is excluded — AU preservation rules are absolute (no early access in this model).

Columns: Account · Rule · Net cash to target · US Tax · AU Tax · Basis tracking

| ID | Account | Rule | Net to Target | US Tax | AU Tax | Basis Updated | Status |
|----|---------|------|---------------|--------|--------|---------------|--------|
| EW-1 | Roth, IRA, 401k | `allowsEarlyWithdrawal: true` flag on account. `replenishSavings` considers these accounts (after exhausting non-age-gated accounts) when person is below `minimumAge`. Super stays `false`. | — | — | — | — | ✅ |
| EW-2 | Roth | Early drawdown phase 1: draw from `contributionBasis` first. No age gate, no penalty, no US tax, no AU tax. | gross = net | N | N | contributionBasis − amount | ✅ |
| EW-3 | Roth | Early drawdown phase 2: draw from `earningsBasis` only after contributions exhausted. 10% penalty if age < 59.5. No US income tax; AU ordinary income if resident + FTC. | gross × 0.9 | penalty only | Ord. Income if resident | earningsBasis − amount | ✅ |
| EW-4 | IRA | All early draws: US ordinary income + 10% penalty if age < 59.5. Draw contributions first for basis tracking; earnings next (same tax treatment). AU ordinary income if resident + FTC. | gross × 0.9 | Ord. Income + penalty | Ord. Income if resident | contrib/earningsBasis decremented | ✅ |
| EW-5 | 401k | All early draws: US ordinary income + 10% penalty if age < 59.5. No AU tax. | gross × 0.9 | Ord. Income + penalty | N | contrib/earningsBasis decremented | ✅ |
| EW-6 | All early-eligible | Target savings account is credited with `net` (gross − penalty). Penalty is never deposited — tracked via `usPenaltyYTD`. | net only | — | — | — | ✅ |
| EW-7 | All early-eligible | `replenishSavings` return type changes to `{ drawnKeys, pendingTaxActions }`. Callers (`ReplenishSavingsReducer`, `IntlTransferApplyReducer`) chain `pendingTaxActions` so YTD tax fields update correctly. | — | — | — | — | ✅ |
| EW-8 | All early-eligible | Early withdrawal penalty rate (10%) and age threshold (59.5) sourced from the US account rules module (year-aware), not hardcoded in `AccountService`. | — | — | — | — | ✅ |
| EW-9 | Super | `allowsEarlyWithdrawal: false`. Super is never drawn before age 60 regardless of deficit. | — | — | — | — | ✅ |

**EW coverage: 9 / 9 tested**

---

## Overall Summary

| Category | Covered | Total | Remaining |
|----------|---------|-------|-----------|
| EVT (Events) | 51 | 51 | 0 |
| TE (Tax Rates) | 8 | 8 | 0 |
| AR (Asset Rules) | 11 | 11 | 0 |
| INFL (Inflation) | 0 | 5 | 5 |
| EW (Early Withdrawal Drawdown) | 9 | 9 | 0 |
| **Total** | **79** | **84** | **5** |

---

## Implementation Batches (suggested session order)

### Batch 1 — Income events + Collectibles (high value, self-contained)
`EVT-36, EVT-37, EVT-38, EVT-39, EVT-45, EVT-46, EVT-47, EVT-48, EVT-49, EVT-50, EVT-51`  
New test file: `tests/unit/evt-income.test.mjs`, extend `evt-real-property.test.mjs` or new `evt-collectible.test.mjs`

### Batch 2 — IRA Rollover + Roth Rollover + RMD
`EVT-35, EVT-40, EVT-41, EVT-42, EVT-43, EVT-44`  
Extend `tests/unit/evt-ira.test.mjs` and `tests/unit/evt-roth.test.mjs`

### Batch 3 — Asset Rules: Collectible (AR-11)
Extend `tests/unit/asset-rules.test.mjs`

### Batch 4 — Tax Rate unit tests (TE-1 through TE-8)
New test file: `tests/unit/tax-rates.test.mjs`  
Test bracket math, discount factors, SS 85% rule, collectibles 28%, NR rates — all in isolation.

### Batch 5 — Inflation (INFL-1 through INFL-5)
New test file: `tests/unit/inflation.test.mjs`  
Depends on whether an inflation service/module exists yet — may require implementation first.
