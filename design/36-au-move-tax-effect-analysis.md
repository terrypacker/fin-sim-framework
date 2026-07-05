# 36 — US→AU Move: All-Else-Equal Tax-Effect Analysis

**Status**: Analysis — written 2026-06-24. Three modelling artifacts found and fixed along the way (see §6); two known model gaps remain — caveats in §8, **actionable fix guide (locations, statutory refs, implementation, tests, verification) in §12**.
**Related**: `design/34-us-state-income-tax.md` (the Hawaii state tax that turns out to be the whole story), `design/35-drawdown-owner-ordering.md` (the last-drawn Roth whose compounding amplifies every effect), `design/26-dynamic-spending-strategies.md` (the expense-inflation path that carried a transition bug). Scenarios: `couple-2031-au-move` vs `couple-no-au-move`.

---

## 1. Question

Holding **everything else constant**, what is the effect on terminal (2070) net worth of a US→AU move in 2031? The two scenarios are byte-identical except `moveYear` (2031 vs null), so any difference is *caused by the move alone*. The headline observation that prompted this: the move ended ~$20M vs ~$6M for staying — a 3.3× gap that defied the intuition that emigrating to a higher-tax country should *reduce* wealth.

## 2. Method

- Both scenarios run to `simEnd` (2070) via the real `ScenarioLoader` + `Simulation` (headless harness: `scripts/run-scenario.mjs`, `npm run scenario`).
- **`TAX_EFFICIENT` drawdown** is used for the apples-to-apples comparison: a single global tax-treatment order (taxable → tax-deferred → tax-free last) across both countries, so the answer is not contaminated by residency-driven drawdown *sequencing* (see §6).
- All three artifacts in §6 are fixed; with them in place the only run-affecting difference is `moveYear`.

## 3. Headline result

| | move (2031) | no-move | Δ |
|---|---|---|---|
| **With Hawaii state tax** (`residencyState=HI`) | **$10.99M** | **$8.60M** | **+$2.39M (+28%)** |
| **No state tax** (`residencyState=null`) | $13.14M | **$13.65M** | **−$0.51M (−4%)** |

**The move's entire advantage is escaping Hawaii state tax.** Remove state tax and the move *reverses* — staying wins by ~4%, exactly as the "higher-tax country" intuition predicts. Note also that Hawaii state tax costs the *stay* household ~$5M of terminal wealth ($13.65M → $8.60M over 44 years).

## 4. Tax decomposition (with Hawaii)

| Lifetime tax (USD) | move | no-move | move's Δ |
|---|---|---|---|
| US federal | $75K | $161K | **−$86K** — foreign tax credits zero out federal once AU tax is paid |
| **US state (Hawaii)** | $42K | $184K | **−$141K** — HI residency (≈11% top rate) ends at the 2031 move |
| Australia | $246K | $128K | +$118K — AU now taxes worldwide income (the "higher-tax country" effect) |
| **Total** | **$363K** | **$472K** | **−$109K** |

The move pays **$109K less lifetime tax**, dominated by escaping Hawaii. AU genuinely costs *more* (+$118K), but that is outweighed by ending Hawaii (−$141K) and federal via FTC (−$86K).

## 5. Mechanism

The taxes diverge in the **tax-deferred drawdown decade (2034–2042)**: under `TAX_EFFICIENT` the IRA/401k are drawn in that window, generating ordinary income.

- **No-move**: that income is taxed by US federal + **Hawaii** (~$25–30K/yr).
- **Move**: as an AU resident the same withdrawals are taxed by AU only (lower net; no Hawaii).
- After ~2043 both are living on the tax-free Roth + super and pay ~$0 federal/state.

The ~$109K saved is retained in the portfolio. Because the Roth is drawn **last** (`design/35`), the saving compounds tax-free for ~30 years → the ~$2.4M terminal gap. The effect is super-linear: a modest annual tax edge, leveraged on the longest-compounding account.

## 6. Artifacts found and fixed (why the raw number was 3.3×, not 1.28×)

The original 3.3× was mostly *modelling artifacts*, not real economics. Removing them took the gap from 3.3× → 1.28×:

| Artifact | Effect | Fix |
|---|---|---|
| **Stranded non-residence cash** | Idle AU savings (~$220K) sat in ~2% cash for a decade while the stay scenario liquidated ~9% growth assets (savings excluded from drawdown + not the residence's spend target). The stay scenario even *failed* (out of funds 2063). | Cash band: savings are first-class in the drawdown order (spent first, floored at `minimumBalance`, liquid across the border). `intl-retirement-scenario.js` `CASH_BAND`, `account-service.js`. |
| **Residency-driven drawdown sequencing** | Under `LOCAL_FIRST`, residency dictated *which* country's accounts drained first, preserving the US Roth in the move case purely by sequencing. | `TAX_EFFICIENT` global drawdown (single tax-treatment order across both countries). `DRAWDOWN_STRATEGIES.TAX_EFFICIENT`, `crossBorderDrawdown=GLOBAL`. |
| **Inflation skip at the move** | Expense inflation was gated on "the residence country's period advance." A mid-year US→AU move dropped one year's increment at the US(Jan)→AU(Jul) handoff, so move expenses stayed ~3% low *forever* (~$1.6M of the residual). | Inflate expenses on the always-annual US advance at the **residence rate**. `inflation-adjust-reducer.js`. |

Progression (TAX_EFFICIENT, move / no-move): raw 3.3× → cash fix 1.47× → inflation fix **1.28×**.

## 7. Tax-treatment verification (Roth / Super / IRA)

Confirmed by reading the tax modules and by an action-level tally over a full run (`_processReducers` hook). All treatments routed by `action.residency`.

| Flow | US resident | AU resident | Source |
|---|---|---|---|
| Roth corpus/contributions (withdrawal) | tax-free | **not assessable** (corpus) | `us-tax-module-2026.js` §Roth |
| Roth **earnings** (withdrawal) | tax-free (qualified) | **AU ordinary income (s99B), no FTC** — the documented "Roth double-tax / no relief" | `us-tax-module-2026.js:62` |
| Roth **conversion** | US ordinary income | US only at conversion (deferred, not an AU event). The IRA-**contribution** portion becomes AU-exempt corpus; the IRA-**earnings** portion is tracked per-lot (`auAssessableAmount`) and stays **AU-assessable (s99B) on later withdrawal** — conversion *defers*, not eliminates, AU tax on converted earnings | `us-tax-module-2026.js:407`, `roth-conversion-classes.js:78`, EVT-43/44 |
| IRA/401k **earnings** (withdrawal) | US ordinary income (+penalty if early) | **US + AU ordinary income, FTC relief** | `us-tax-module-2026.js` `IRA_WITHDRAWAL_EARNINGS_TAX` |
| Super **earnings** | 15% AU super tax, no US | 15% AU super tax, no US | `au-tax-module-2026.js:127` |
| Super **withdrawal earnings** | US ordinary income | US ordinary income | `au-tax-module-2026.js:120` |
| Stock sale gain | US capital gain | AU capital gain (CGT) | routed by `residency` |

**Empirical confirmation (full run, both scenarios):**
- `ROTH_CONVERSION_TAX:US` = $296K base (3 conversions) in **both** — the scenario already runs a Roth-conversion ladder; taxed as US ordinary income. ✓
- `STOCK_WITHDRAWAL_TAX` = move **$1.95M base @ residency=AU**, no-move **$1.82M @ residency=US** — sale gains correctly follow residency. ✓
- `SUPER_EARNINGS_TAX` = move $1.44M / no-move $1.28M base, ×15% — super earnings taxed in both. ✓ (but see §8)
- `ROTH_WITHDRAWAL_EARNINGS_TAX` ≈ 0 — the Roth is drawn **last** and barely touched, so the move's Roth benefit is tax-free **compounding** of the preserved balance, not avoided withdrawal tax.

Net: Roth and conversion treatment is correct and sophisticated (it models the s99B Australian-resident Roth trap). The one suspect is super (§8).

## 8. Open questions / caveats

> Items 1 and 2 are model gaps with a step-by-step fix guide in **§12** (locations, statutory refs, implementation, tests, verification). Both over-tax the move scenario, so §3's "+28%" is a conservative floor.

1. **Super pension-phase rate** — `SUPER_TAX_RATE = 0.15` is applied flat to super earnings with **no pension/preservation-phase check** (`au-tax-module-2026.js:14,128`). For retirees 60+ in pension phase, AU super earnings are **tax-free (0%)**. This over-taxes super in *both* scenarios (and slightly more in the move case, which preserves more super). Worth a fix; doesn't change the §3 direction. → **✅ FIXED — see §12.1**
2. **Deemed-disposal / CGT cost-base reset at the move** — `ChangeResidencyApplyReducer` captures `balanceAtResidencyChange` but it is **never read** for CGT. So AU CGT on later sales is computed from the *original US* cost basis, taxing pre-move appreciation that AU would normally exclude (AU deems assets acquired at market value on becoming resident, ITAA97 s855-45). This **over-taxes the move** on **shares** (the AU stock-gain base is inflated by pre-move appreciation), so §3 is conservative — but it's a real gap. Applies to **non-TAP** assets only: shares get the reset; the AU house is Taxable Australian Property and correctly keeps its original basis; retirement accounts aren't CGT assets. (The 50% CGT discount itself *is* correctly applied.) → **fix: §12.2**
3. **Hawaii residency termination** assumed clean on emigration (realistic for a genuine relocation).
4. **Foreign tax credits** assumed to fully relieve US federal once AU tax is paid (model drives federal → ~$0; reasonable).
5. **Constant FX** (USD_AUD = 1.55 throughout) — no currency risk modelled.
6. No move costs, healthcare-cost differences, Medicare/Medibank, or non-financial factors.

## 9. Contributions vs gains — how the model taxes them

The conversion lever turns entirely on the **basis split** (contribution/corpus vs earnings), and the model tracks it precisely (`contributionBasis` / `earningsBasis` per account; per-conversion lots).

| Money | US treatment on withdrawal | AU-resident treatment on withdrawal |
|---|---|---|
| Roth **contributions** (corpus) | tax-free | not assessable (corpus) |
| Roth **earnings** | tax-free (qualified; 10% §72(t) if early) | AU ordinary income (s99B), **no FTC** |
| Traditional IRA/401k **contributions** (pre-tax) | US ordinary income | US ordinary income only (corpus — **no AU**) |
| Traditional IRA/401k **earnings** | US ordinary income | **US + AU** ordinary income (FTC) |
| **Converted** principal — IRA-contribution portion | tax-free (taxed at conversion) | corpus — AU-exempt |
| **Converted** principal — IRA-earnings portion | tax-free (taxed at conversion) | **AU-assessable s99B on withdrawal** (`auAssessableAmount`, deferred) |
| Post-conversion Roth **growth** | tax-free | AU ordinary income (s99B) |

Two consequences for the lever:
1. A conversion is taxed **only by the US at conversion** (full pre-tax amount as ordinary income) — AU never taxes the conversion event; it defers to withdrawal.
2. Conversion does **not** launder IRA *earnings* out of AU's reach — that portion stays s99B-assessable when drawn. What conversion buys an AU resident is (a) moving future growth from *US+AU*-taxed (IRA) to *US-free / AU-s99B-only* (Roth), and (b) US bracket arbitrage at conversion.

## 10. Optimisation results — Roth-conversion ladder (move scenario)

Swept `rothConversion{StartYear, EndYear, MaxBracket}` on the move scenario, terminal net worth (USD), with and without Hawaii. The conversion strategy fills US brackets up to `MaxBracket` each year in the window.

**With Hawaii (the household's actual situation):**

| window \ max bracket | 12% | 22% | 32% |
|---|---|---|---|
| disabled | $12.62M | — | — |
| **pre-move** 2028–30 | $11.74M | $11.09M | $10.51M |
| span 2028–35 *(current config @22%)* | $11.63M | **$10.99M** | $10.41M |
| **post-move** 2032–40 | **$13.17M** | $12.77M | $11.28M |
| post-retirement 2040–50 | $13.16M | — | — |

- **Best: ~$13.17M** — convert **after the move**, capped at the **12% federal bracket**. That is **+$0.55M over not converting**, and **+$2.18M over the scenario's current (mis-configured) ladder** (2028–35 @22%, which converts *in Hawaii*).
- **Converting before/across the move is worse than not converting at all** — those years are (a) in Hawaii (state tax on the conversion) and (b) high-wage working years (conversions stack at high marginal rates).
- **Sharp cliff above 12%**: at 15%+ even post-move conversion destroys value ($11.3M @32%). Only fill the low bracket.

**Without state tax**, the same shape holds (post-move @12% ≈ $15.17M best vs $14.55M disabled, +$0.62M); the *pre-move penalty shrinks* because there is no Hawaii tax to pay on the conversion — confirming the penalty is the state tax.

**Takeaway — and it is the opposite of the natural intuition** ("convert before moving so Australia doesn't tax it"):
- AU does not tax the conversion either way, so there is nothing to escape by converting early.
- Converting *early* means converting **while a Hawaii resident** (state tax) in **working years** (high bracket) — the worst time.
- The optimum is to convert **after establishing AU residency**, in **low-income retirement years**, **only up to the 12% US federal bracket**.

## 11. Bottom line

All else equal, the 2031 move **increases terminal wealth by ~28% (~$2.4M) — but only because the household is in Hawaii**: the mechanism is escaping Hawaii's state income tax (and federal via FTC) during the tax-deferred drawdown years, compounded in the last-drawn Roth. Strip out state tax and the move is mildly *negative*, vindicating the original intuition that Australia is the higher-tax jurisdiction.

The controllable lever is **Roth-conversion sequencing**, and the model says to do it **after the move, in low-income years, capped at the 12% federal bracket** (≈ +$0.55M with Hawaii; the scenario's current pre/cross-move ladder is ≈ $2.2M *worse* than this optimum). Converting before the move — the intuitive play — is actively harmful because it pays Hawaii state tax on the conversion.

---

## 12. Fix-it guide for the two open questions (§8)

Both gaps push the result the *same* direction — they make the model **over-tax the move scenario**, so §3's "+28%" is a conservative floor. Fixing either should *increase* the measured move advantage. Pick up here.

### 12.1 Super earnings taxed at 15% with no pension-phase exemption — ✅ FIXED (2026-06-25)

- **Fix shipped**: `SuperEarningsHandler.call` (`src/finance/handlers/earnings-handlers.js`) now reads the firing `date`, computes the owner's age (`getBirthDate` + a local `getAge`, matching the super withdrawal handlers' age-60 gate), and stamps `taxRate: 0` on the emitted `SUPER_EARNINGS_APPLY` when age ≥ 60 (pension/retirement phase). `SuperEarningsApplyReducer` (`au-super-classes.js`) forwards `action.taxRate` onto `SUPER_EARNINGS_TAX`, and the `SUPER_EARNINGS_TAX` reducer (`au-tax-module-2026.js`) now uses `action.taxRate ?? SUPER_TAX_RATE` (0 in pension phase, flat 15% otherwise). Contributions tax (`SUPER_CONTRIBUTION_TAX`) untouched. Tests: `tests/unit/evt-super.test.mjs` — accumulation (member < 60) → 15% accrues to `auPersonSuperTaxYTD`; pension (member ≥ 60) → 0 while the balance still compounds. Note the `SUPER_EARNINGS` *direct* path (`SuperEarningsDirectHandler`) is unchanged — the gate lives on the scheduled `INTL_SUPER_EARNINGS` path used by real scenario runs.
- **Direction**: over-taxes super earnings in **both** scenarios; slightly more in the move case (which preserves a larger super balance). Lowers absolute wealth in both; minor effect on the gap.
- **What's wrong**: `SUPER_EARNINGS_TAX` is chained **unconditionally** and taxed at a flat 15%.
  - Rate constant: `src/finance/tax/au/au-tax-module-2026.js:14` — `const SUPER_TAX_RATE = 0.15`.
  - Earnings handler (applies 15%): `au-tax-module-2026.js:127` (`SUPER_EARNINGS_TAX`).
  - Chained with no gate: `src/finance/account-rules/au/au-super-classes.js` `SuperEarningsApplyReducer.reduce` (~line 150) emits `SUPER_EARNINGS_TAX` for every earnings accrual.
- **Correct behaviour (ATO)**: super in **accumulation phase** → earnings taxed 15%; in **retirement/pension phase** (member ≥ 60 and a condition of release met — for this model, retired) → fund earnings are **tax-free (0%)**. Contributions tax (15% concessional, `SUPER_CONTRIBUTION_TAX`, line 110) is unaffected — leave it.
- **The age signal already exists**: the super *withdrawal* handler computes the owner's age and gates at 60 — `au-super-classes.js` `SuperWithdrawalContributionsHandler.call({ date, state, data })` (~line 193): `birthDate = getBirthDate(state, personKey); age = getAge(birthDate, date); blocked = age < 60`. `SuperEarningsHandler.call` (`earnings-handlers.js` ~line 535) currently destructures only `{ data, state }` but the **same `date` is in its call context** — just unread. Reuse the `getBirthDate`/`getAge` pattern.
- **Implementation sketch**:
  1. In `SuperEarningsHandler.call`, add `date` to the destructure, compute the owner's age (`getBirthDate(state, this.ownerId ?? firstPerson)` + `getAge(birthDate, date)`), and treat `age ≥ 60` as pension phase (preservation/condition-of-release proxy). Pass `phase`/`taxRate: 0` on the emitted `SUPER_EARNINGS_APPLY` so it rides through to `SUPER_EARNINGS_TAX`.
  2. In the `SUPER_EARNINGS_TAX` reducer (`au-tax-module-2026.js:127`), use `action.taxRate ?? SUPER_TAX_RATE` (0 in pension phase) instead of the constant.
- **Tests**: extend `tests/unit/toolset-au-retirement*.mjs` / the EVT-23 coverage: (a) member < 60 → 15% accrues to `auSuperTaxYTD`; (b) member ≥ 60 retired → `auSuperTaxYTD` unchanged. Grep `SUPER_EARNINGS_TAX` in `tests/` for the existing cases to update.
- **Verify end-to-end**: tally `SUPER_EARNINGS_TAX` over a run (hook `Simulation.prototype._processReducers`, as in §7) — post-fix it should be ~0 once both people are 60+ and retired (≈2040+). Then re-run §3; both scenarios rise, move a touch more.

### 12.2 No AU CGT cost-base reset at the residency change (s855-45)

- **Direction**: over-taxes the **move** scenario's AU capital gains — AU CGT is levied on appreciation that accrued **before** AU residency. Fixing it *increases* the move advantage (§3 conservative).
- **Note**: the AU **50% CGT discount IS correctly applied** at settle (`src/finance/tax/au/au-tax-rates-base.js:68-71`, Division 115) — that is *not* a gap. The gap is purely the **cost base** the gain is measured from.
- **What's wrong**: the AU capital gain on **shares** is computed from the asset's **original (US) cost basis**, not the market value when the person became an AU resident.
  - `balanceAtResidencyChange` is **captured** (`account-service.js:364` `recordResidencyChange`, set by `ChangeResidencyApplyReducer`) and serialized — but **never read** by any tax/gain code. (Confirmed: `grep -rn balanceAtResidencyChange src/` shows only writers.)
  - AU stock gain: `src/finance/account-rules/au/au-brokerage-classes.js:199` — `gain = max(0, salePrice - realizedBasis)`, `realizedBasis` = FIFO holding `costBasis` (original).
  - US-brokerage gain reaching AU: computed in `AccountService._drawPenaltyFree` (BROKERAGE branch) from holding `earningsBasis`/`costBasis`; the `STOCK_WITHDRAWAL_TAX` AU branch (`us-tax-module-2026.js:179`) then books that same `gain` to `auCapitalGainsYTD`. **This is the path the §3 TAX_EFFICIENT analysis actually exercises** (the drawdown engine drains brokerage via `_drawPenaltyFree`, not the scheduled-sale FIFO reducer).
- **NOT a bug — the AU house** (`AU_HOUSE_SALE_TAX`, `au-tax-module-2026.js:209`): the scenario's AU house is **real property situated in Australia, held before the move** → it is **Taxable Australian Property (TAP)** and s855-45 explicitly **does not** reset TAP. Its original basis is the *correct* AU cost base; stepping it up would *under*-tax it. (Earlier drafts of this section wrongly listed it as the same gap.) Only **non-TAP** assets — shares — get the reset. Real property *located in the destination country* must be excluded.
- **Retirement accounts get no step-up** — by tax treatment and by construction. The reset is a CGT cost-base concept; 401k/IRA → ordinary income (`K401_WITHDRAWAL_TAX`/`IRA_WITHDRAWAL_*`), Roth → `ROTH_WITHDRAWAL_EARNINGS_TAX`, AU Super → super rules. None compute a capital gain, so there is no cost base to reset. AU treats US retirement accounts as foreign trusts/super, outside the s855-45 CGT-asset regime. The implementation gates the reset to `ACCOUNT_TYPE.BROKERAGE`, so these accounts are never stamped even though they carry an `earningsBasis` field.
- **Correct behaviour (ITAA 1997 s855-45)**: a person becoming an AU resident is taken to have **acquired their non-TAP assets at market value on the residency date**. So the **AU** cost base resets to market-value-at-residency-change, while the **US** cost base (US citizen) stays original. This is genuinely a **dual cost base** — the two gains differ and are relieved against each other via FTC.
- **Design — country-keyed cost base (multi-country general, no `au*` fields on generic classes)**:
  1. **Data model.** Add a generic `Holding.costBaseByCountry: { [iso]: number } | null` (null/absent ⇒ every country uses the universal `costBasis` = acquisition cost; an entry exists only where a jurisdiction stepped it up). For the account-level proportional path, add a per-country forgiven-gain snapshot on `InvestmentAccount` (the pre-move unrealized gain the new country wipes), keyed the same way. **No `auCostBasis`/`auBasisStepUp`** — nothing country-named on the generic classes.
  2. **Trigger (policy-driven, not `if (AU)`).** A country tax module declares a capability flag `stepsUpCostBaseOnResidency`. On `CHANGE_RESIDENCY` to country *C*, `recordResidencyChange` (via `ChangeResidencyApplyReducer`) consults the flag and, for each **`BROKERAGE`** account, stamps `costBaseByCountry[C] = holding.marketValue` per lot **and** the account-level forgiven-gain = `earningsBasis`. Real property located in *C* (TAP) and non-brokerage accounts are skipped. Lots acquired *after* the move keep their actual cost (no entry).
  3. **Two gains at realisation.** Where a gain is realised for an AU resident, compute `gain = proceeds − costBasis` (US/origin) and `auGain = proceeds − (costBaseByCountry['AU'] ?? costBasis)`. FIFO path: `consumeHoldingsFifo` returns realized basis per country. Proportional path: deplete the account-level forgiven-gain pro-rata (`withdraw/totalBal`) and `auGain = max(0, gain − stepUpConsumed)`. Carry both on the `*_WITHDRAWAL_TAX` action (`gain` for US, `auGain` for AU).
  4. **Route in the tax modules.** `usCapitalGainsYTD += gain`; for AU residents `auCapitalGainsYTD += auGain` (then the existing 50% discount applies). **FTC: `ftcYTD += auGain`, not `gain`** — the pre-move appreciation (`gain − auGain`) is taxed **only** by the US (AU forgave it), so it is not double-taxed and earns no credit. Touch points: `au-tax-module-2026.js` `AU_STOCK_WITHDRAWAL_TAX`, and `us-tax-module-2026.js:179` `STOCK_WITHDRAWAL_TAX` AU branch. `AU_HOUSE_SALE_TAX` is **not** touched (TAP).
- **Tests**: new EVT case — a *share* lot with original basis B, market value M at residency change, sold post-move for P: assert `usCapitalGainsYTD += (P−B)`, `auCapitalGainsYTD += (P−M)`, `ftcYTD += (P−M)`. Cover a lot acquired *after* the move (no entry → both use actual basis) and assert the AU house (TAP) is unaffected.
- **Verify end-to-end**: in §7's tally, the `STOCK_WITHDRAWAL_TAX:AU` / `AU_STOCK_WITHDRAWAL_TAX` gain base should **drop** by the pre-move share appreciation; re-run §3 — the move advantage should widen beyond +28%.

### 12.3 Reproducing the analysis

- **Headless runs/compares**: `npm run scenario -- <file.json> [more…]` (`scripts/run-scenario.mjs`) — net-worth breakdown + side-by-side diff. Scenarios live in the workbench; export to JSON to feed the harness.
- **Apples-to-apples**: set `drawdownStrategy = TAX_EFFICIENT` on both. The sensitivity in §3 / sweep in §10 were produced by overriding params on the exported config and re-running to `simEnd`: `residencyState` (HI vs null) and `rothConversion{Enabled,StartYear,EndYear,MaxBracket}`, reading `computeNetWorth(sim.state)` (`src/finance/derived-metrics/net-worth.js`).
- **Tax / action attribution**: wrap `Simulation.prototype._processReducers` (catches reducer-emitted actions, unlike `_processActionQueue` which only sees the scheduled queue) and tally by `action.type` (+ `action.residency`). This is how §4/§7 tax and basis numbers were produced.
