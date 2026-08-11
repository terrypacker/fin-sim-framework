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
node scripts/dev/check-requirements.js
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
| EVT-3 | Roth | Withdrawal – Earnings | − earnings | N (10% penalty if age < 59.5) | Ordinary Income if resident (s99B) | N | ✅ |
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
| EVT-26 | AU Brokerage | Stocks – Div Franked as Resident | + contribution (basis) | Ordinary Income | Ordinary Income (cash + gross-up) + Franking Credit offset | Y | ✅ |
| EVT-27 | AU Brokerage | Stocks – Div Franked as Non-Resident | + contribution (basis) | Ordinary Income | N | N | ✅ |
| EVT-28 | AU Brokerage | Stocks – Div Unfranked as Resident | + contribution (basis) | Ordinary Income | Ordinary Income | Y | ✅ |
| EVT-29 | AU Brokerage | Stocks – Div Unfranked as Non-Resident | + contribution (basis) | Ordinary Income | Non-Resident Withholding | Y | ✅ |
| EVT-30 | AU Brokerage | Stocks – Earnings | + earnings | N | N | N | ✅ |
| EVT-31 | AU Brokerage | Stocks – Withdrawal as Resident | − earnings or contribution | Capital Gain | Capital Gain | Y | ✅ |
| EVT-32 | AU Brokerage | Stocks – Withdrawal as Non-Resident | − earnings or contribution | Capital Gain | N | N | ✅ |
| EVT-33 | Real Property | House Sale – Australia | − contribution & basis | Capital Gain | Non-Resident Tax Rates | Y | ✅ |
| EVT-34 | Real Property | House Sale – US | − contribution & basis | Capital Gain (after \$500K exemption) | Capital Gain if resident | N | ✅ |
| EVT-35 | IRA | IRA Rollover Withdrawal | − contribution & earnings | Ordinary Income | Ordinary Income if resident | N | ✅ |
| EVT-36 | Collectible | Sale – Baseball Cards | − contribution & basis | Collectible (28%) | Capital Gain if resident | N | ✅ |
| EVT-37 | US Checking | Social Security Income | + \$ amount/month | Social Security Income (85% taxable) | Ordinary Income if resident | N | ✅ |
| EVT-38 | US Checking | Wages (Gross) | + \$ amount/month | Ordinary Income | Ordinary Income if resident | N | ✅ |
| EVT-39 | US Checking | Wages – Taxes Withheld | − % of amount | N/A (withholding) | N/A | N | ✅ |
| EVT-40 | IRA | IRA Withdrawal – RMD | − contribution & earnings | Ordinary Income (required at age 72) | Ordinary Income if resident | N | ✅ |
| EVT-41 | Roth | Roth Rollover Contribution | + contribution | N | N | N | ✅ |
| EVT-42 | Roth | Roth Rollover Earnings | + earnings | N | N | N | ✅ |
| EVT-43 | Roth | Roth Rollover Withdrawal – Contributions | − rollover contribution | N income tax (10% §408A(d)(3)(F) recapture if age < 59½ and within 5 yrs of the conversion) | Ordinary Income if resident on the converted IRA-earnings portion (s99B); IRA-contribution portion is corpus (N) | N | ✅ |
| EVT-44 | Roth | Roth Rollover Withdrawal – Earnings | − rollover earnings | N income tax (10% §72(t) penalty if age < 59½) | Ordinary Income if resident (s99B) | N | ✅ |
| EVT-45 | Collectible | Change in Value – Baseball Cards | +/− balance | N | N | N | ✅ |
| EVT-46 | Collectible | Sale – Gold | − contribution & basis | Collectible (28%) | Capital Gain if resident | N | ✅ |
| EVT-47 | Collectible | Change in Value – Gold | +/− balance | N | N | N | ✅ |
| EVT-48 | US Checking | Self-Employment Income | + \$ amount/month | Ordinary Income | Ordinary Income if resident | N | ✅ |
| EVT-49 | AU Savings | Self-Employment Income | + \$ amount/month | Ordinary Income | Ordinary Income if resident | N | ✅ |
| EVT-50 | US Checking | Bonus | + \$ amount | Ordinary Income | Ordinary Income if resident | N | ✅ |
| EVT-51 | US Checking | Company Sale | + \$ amount | Capital Gain | Capital Gain if resident | N | ✅ |
| EVT-52 | Roth Conversion | IRA → Roth Conversion | −IRA, +Roth rollover contribs | Ordinary Income | N (s99B — no distribution received) | N | ✅ |

**EVT coverage: 52 / 52 tested**

### Roth IRA cross-border tax treatment (EVT-1 to 4, EVT-41 to 44, EVT-52)

The Roth events model a US Roth IRA held by a person who may be a US citizen and/or
an Australian tax resident. The two jurisdictions treat the same account very
differently, and the cross-border interaction is the source of the rules below.

**United States — tax-free, even on the gains.**
A *qualified* Roth distribution (holder age ≥ 59½ and the 5-year rule met) is
excluded from gross income in full, including earnings — **IRC §408A(d)(1)**.
The model therefore never books US ordinary income on a Roth withdrawal. The only
US-side charge is the **IRC §72(t)** 10% additional tax on an early (non-qualified,
age < 59½) distribution of *earnings* (EVT-3 and EVT-44). Contributions and
converted principal come out first under the ordering rules (**IRC §408A(d)(4)**)
and are never income-taxed on withdrawal.

**The 5-year conversion recapture (EVT-43).**
Converted principal is normally penalty-free, but **IRC §408A(d)(3)(F)** imposes the
§72(t) 10% additional tax on converted dollars withdrawn within the 5-taxable-year
window that begins Jan 1 of the conversion year, when the owner is under 59½ (at/after
59½ the exception removes it). Each conversion runs its **own** clock (a 2026
conversion clears on 1 Jan 2031). The model records a dated FIFO **conversion lot**
on every IRA→Roth conversion (EVT-52) and consumes those lots oldest-first on EVT-43,
penalising only the still-in-window portion. Lots with no recorded conversion date
(directly-seeded basis) are treated as seasoned.

**Australia — taxed as a foreign trust, on the gains only.**
The ATO does **not** recognise the US Roth's tax-free status. A US IRA/Roth IRA is
treated as a **foreign trust**, and a distribution to an Australian-resident
beneficiary is assessable as ordinary income under **s99B ITAA 1936** to the extent
it represents trust *income* (the earnings/appreciation). Amounts representing
**corpus** — the original after-tax contributions, and (per the note below) rolled-in
converted principal — are excluded from s99B (s99B(2)(a)). Net effect: AU taxes the
**gains only**, as ordinary income, when the resident draws them (EVT-3, EVT-44).
There is no CGT 50% discount — s99B amounts are ordinary income, not a capital gain.

**Roth conversions are corpus, not gains — and are not an AU event.**
An IRA→Roth conversion (EVT-52) is taxed as **US** ordinary income at the time of
conversion (IRC §408A(d)(3)(A) / §408(d)(1)) — a US event for the account owner
regardless of residency. It is **not** an Australian taxable event, even for an
AU resident: **s99B ITAA 1936** assesses only amounts *paid to, or applied for the
benefit of* the resident beneficiary — an actual distribution received by the
person. A conversion merely moves funds within the US retirement system (IRA
trust → Roth trust); nothing is paid to or made available to the individual, so
there is no s99B receipt and nothing to assess (and no FTC, since no AU tax is
levied). Inside the Roth the converted amount is tracked as **rollover
contribution basis** (corpus). Its later treatment depends on its *provenance*
(see below); only the *post-conversion* growth is earnings (EVT-42/EVT-44),
assessable under s99B on distribution if resident.

**Converted IRA earnings stay AU-assessable (stricter s99B view).**
The s99B corpus exemption excludes amounts that *would have been assessable if
derived directly by a resident*. A Traditional IRA is pre-tax money: its earnings,
if distributed straight to a resident, are s99B income (cf. EVT-7). Converting
them to a Roth defers AU tax — it does not erase it. The model therefore records,
on each conversion lot, the **IRA-earnings-sourced portion** (`taxableAmount`,
i.e. the part of the conversion drawn from IRA `earningsBasis` rather than
`contributionBasis`). When that converted principal is later withdrawn (EVT-43),
the earnings-sourced share is consumed FIFO/pro-rata and assessed as **AU ordinary
income under s99B** for a resident, while the contribution-sourced share remains
corpus (AU-free). There is no US income tax on the EVT-43 distribution (the US
taxed the conversion at EVT-52) and therefore no FTC. Directly-seeded
`rolloverContribBasis` with no conversion lots is of unknown provenance and is
treated as corpus (AU-free) for backward compatibility.

**No Foreign Tax Credit on Roth earnings (FTC = N for EVT-3 and EVT-44).**
FTC relieves *double* taxation by crediting foreign tax against the home-country
charge. Because the US levies **no** income tax on a qualified Roth distribution,
there is no foreign tax for Australia to credit and nothing to relieve on the US
side. The AU s99B charge therefore stands alone — the documented Roth
"double-tax-with-no-relief" outcome for Australian residents. Earlier revisions
incorrectly accumulated `ftcYTD` on these events, which spuriously offset US tax on
*unrelated* income; this is now corrected.

> **Tax-law sources:** IRC §408A(d)(1) (qualified distributions excluded from
> income), IRC §408A(d)(4) (distribution ordering: contributions → conversions →
> earnings), IRC §72(t) (10% additional tax on early distributions),
> s99B Income Tax Assessment Act 1936 (Cth) and ATO guidance "Receiving payments
> or assets from foreign trusts" (foreign-trust distributions to resident
> beneficiaries; corpus exclusion under s99B(2)).

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
| EW-3 | Roth | Early drawdown phase 2: draw from `earningsBasis` only after contributions exhausted. 10% penalty if age < 59.5. No US income tax; AU ordinary income if resident (s99B, no FTC — see EVT-3 note). | gross × 0.9 | penalty only | Ord. Income if resident | earningsBasis − amount | ✅ |
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
| WB (Workbench UI) | 0 | 34 | 34 |
| **Total** | **79** | **118** | **39** |

---

## Section: Workbench UI — WB Requirements

Source: *design/6-workbench-ui.md* (vision) and *design/7-workbench-ui-plan.md* (implementation plan).

UI requirements use a `WB-N` ID prefix. Because these are structural/behavioral (not unit-testable in
the same way), the coverage check script does not scan for them. Track status manually in the table.

Coverage legend: ✅ Implemented · ⬜ Not started · 🚧 In progress

---

### Workbench Shell

| ID | Requirement | Phase | Status |
|----|-------------|-------|--------|
| WB-1 | The workbench renders a 3-pane layout (left / center / right) with resizable gutters between panes | P1 | ✅ |
| WB-2 | Each pane contains a tab group that renders a tab bar and the active panel's content area | P1 | ✅ |
| WB-3 | Tabs can be closed via a close (×) button; the next tab in the group becomes active | P1 | ✅ |
| WB-4 | Tabs can be dragged from one pane and dropped into any other pane | P1 | ✅ |
| WB-5 | Pane flex-sizing (gutter position) persists across page reloads via localStorage | P1 | ✅ |
| WB-6 | Active tab layout (which tabs are in each pane and which is active) persists via localStorage | P1 | ✅ |
| WB-7 | A Save Layout / Reset Layout action is available in the top bar | P1 | ✅ |
| WB-8 | The top bar contains: play / step / reset controls, scenario selector, time slider, time label, timezone selector, currency selector | P2 | ✅ |

---

### Panel Component System

| ID | Requirement | Phase | Status |
|----|-------------|-------|--------|
| WB-9 | A `WorkbenchComponent` base class provides `mount(container)`, `unmount()`, and `rerender()` lifecycle hooks | P1 | ✅ |
| WB-10 | A `PluginRegistry` maps plugin IDs to component classes; plugins are registered before the shell renders | P1 | ✅ |
| WB-11 | Panels communicate cross-panel state changes (selected node, sim time, breakpoint hit) via a shared `WorkbenchBus`, not direct method calls | P1 | ✅ |
| WB-12 | Mounting an inactive (background) tab does not trigger rendering; unmounting an active tab calls `onUnmount()` for cleanup | P1 | ✅ |

---

### Production Panel Plugins (Phase 2 migration)

Each existing panel becomes a self-contained plugin that renders into any provided container.

| ID | Plugin | Wraps | Status |
|----|--------|-------|--------|
| WB-13 | ScenarioPlugin | ScenarioTabView / ScenarioTabPresenter / ScenarioTabController | ✅ |
| WB-14 | TimelinePlugin | TimelineView / TimelinePresenter / TimelineController | ✅ |
| WB-15 | ChartPlugin | ChartView / ChartPresenter / ChartController; canvas resizes via ResizeObserver | ✅ |
| WB-16 | ConfigGraphPlugin | ConfigGraphView / GraphBuilderPresenter; emits `selection.changed` on node click | ✅ |
| WB-17 | ConfigurationListPlugin | ConfigurationListComponent; handles add/edit via NodeEditModal | ✅ |
| WB-18 | MonteCarloPlugin | MC config + results panels | ✅ |
| WB-19 | OptimizationPlugin | Opt config + results panels | ✅ |
| WB-20 | InspectorPlugin | GraphNodeInspectorPanel; auto-loads node on `selection.changed` | ✅ |
| WB-21 | ExecHistoryPlugin | GraphNodeExecHistory; updates on `selection.changed` | ✅ |
| WB-22 | LineagePlugin | GraphNodeLineage; updates on `selection.changed` | ✅ |
| WB-23 | StatePanelPlugin | StatePanelView (live state + cumulative metrics + action detail) | ✅ |
| WB-24 | DashboardPlugin | DashCardsComponent; updates on `runtime.tick` | ✅ |

**Migration constraints**: no hardcoded DOM IDs in plugin code; existing simulation behavior unchanged;
default layout matches current production arrangement (see `design/7-workbench-ui-plan.md`).

---

### Detachable Windows (Phase 3)

| ID | Requirement | Status |
|----|-------------|--------|
| WB-25 | Any panel tab can be detached into a standalone browser window via a detach button (⤢) on the tab | ✅ |
| WB-26 | Detached panels synchronize with the main window via `BroadcastChannel`; `selection.changed`, `runtime.tick`, and `scenario.ready` events cross window boundaries | ✅ |
| WB-27 | Closing a detached window reattaches the tab to its source pane | ✅ |

---

### Performance & Replay Debugger (Phase 4)

| ID | Requirement | Status |
|----|-------------|--------|
| WB-28 | Timeline renders smoothly (no frame drop) with 10,000+ journal entries using windowed virtualization | ⬜ |
| WB-29 | Graph renders smoothly with 500+ nodes using viewport culling | ⬜ |
| WB-30 | Breakpoint hit pauses the simulation and emits `breakpoint.hit` on `WorkbenchBus`; Timeline and Graph panels highlight the current execution point | ⬜ |
| WB-31 | Step-through advances one event / handler / action at a time; all panels update after each step | ⬜ |

---

### Domain Plugin SDK (Phase 5)

| ID | Requirement | Status |
|----|-------------|--------|
| WB-32 | A public `WorkbenchPlugin` interface allows external code to register custom panels without modifying core workbench files | ⬜ |
| WB-33 | Named workspace presets (templates) can be saved, loaded, and reset; built-in templates include Default, Analysis, Debugging, and Review | ⬜ |
| WB-34 | Finance-domain plugins are isolated under `plugins/finance/`; the workbench core has zero direct imports from `src/finance/` | ⬜ |

---

### WB Coverage Summary

| Category | Implemented | Total |
|----------|-------------|-------|
| Shell (WB-1–8) | 8 | 8 |
| Component System (WB-9–12) | 4 | 4 |
| Panel Plugins (WB-13–24) | 12 | 12 |
| Detachable Windows (WB-25–27) | 3 | 3 |
| Performance / Debugger (WB-28–31) | 0 | 4 |
| Plugin SDK (WB-32–34) | 0 | 3 |
| **Total** | **27** | **34** |

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
