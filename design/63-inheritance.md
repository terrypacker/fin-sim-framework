# 63 — Inheritance (scheduled bequest of external-decedent assets + per-country death tax)

**Status**: **IMPLEMENTED** (all five phases, `wip/inheritance`; 3420 unit + 866 viz green,
browser-verified). Models a scheduled inheritance of assets from a decedent who is *not* a
`Person` in the scenario. Covers the injection mechanism, per-country tax handling (US step-up +
IRD, AU inherited cost base + super death tax, NE inheritance tax), and the cross-border
dual-cost-base interaction. Validated against 2026 tax law (sources §3). See **§12 Implementation
notes** for the as-built shape and the deltas from this plan.

**Builds on**:
- **`design/49` (`CompanyEquity`)** — the template for a config-driven external asset with its
  own domain object, service, toolset, serializer, and editor. Design 63 is the *mirror* of the
  `COMPANY_SALE` mechanic: 49 **zeroes** an asset at a scheduled date; 63 **funds** one.
- **`design/62` (residency-change CGT fidelity)** — supplies the `costBaseByCountry` /
  `acquisitionDateByCountry` dual-cost-base + AU main-residence machinery reused verbatim for the
  cross-border inheritance case (§7).
- Existing RMD / forced-distribution infrastructure (`us-rmd-uniform-table.js`, `K401_RMD_TAX`,
  the `*_WITHDRAWAL_TAX` → `usOrdinaryIncomeYTD` classifiers in `us-tax-module-2026.js`) — reused
  for the SECURE-Act 10-year inherited-IRA drawdown (§6).

---

## 1. Problem

A scenario person may inherit assets from an **external decedent** (a parent, relative, etc.) —
someone with **no `Person` record** in the sim. Today there is no way to:

- Add inherited **real property, collectibles, brokerage holdings, or retirement accounts** to
  the configuration as a bundle attributable to one decedent, on one **inheritance date**.
- Make those assets **appear mid-simulation** (they must contribute nothing to net worth or
  drawdown until the inheritance date).
- Apply the correct **per-country death-tax treatment**, which is sharply asymmetric:
  - **US** steps up cost basis to FMV at death (brokerage/property/collectibles) — but *not*
    inherited IRAs/401(k)s (IRD, ordinary income, SECURE 10-year rule).
  - **AU** has *no* inheritance tax and *no* step-up (heir inherits the deceased's cost base),
    but taxes **super death benefits** paid to a non-dependant (~15–17%).
  - **Nebraska** is the only one of the three modeled states with a true heir-paid
    **inheritance tax**, keyed to the heir's **relationship** to the decedent.

**Goal**: a `Bequest` config object that expands into standard asset/account records, funds them
via a scheduled `INHERIT` event, and routes each through the correct country/state death-tax path.

---

## 2. Goals & Non-Goals

### Goals
- New **`Bequest`** config container (sibling of `realProperties` / `collectibles` /
  `companyEquities`): a decedent descriptor + inheritance date + a list of inherited assets that
  **reuse the existing asset/account types** (`RealProperty`, `Collectible`, brokerage
  `InvestmentAccount`, `RetirementAccount` subclasses). **No new asset classes.**
- **Seed-at-zero, fund-on-event** injection (§5): inherited records seed at t=0 with `value 0`
  (automatically invisible to net worth / drawdown — *no new gating code*), and an `INHERIT`
  event at the inheritance date funds them + stamps basis + records death tax.
- **US step-up (§6.1)**: inherited brokerage/property/collectibles get `costBasis = FMV at death`.
- **US IRD 10-year drawdown, as an optimizable lever (§6.2)**: inherited traditional IRA/401(k)
  become heir-owned pre-tax accounts drained over the SECURE 10-year window by an
  **optimizer-tunable distribution strategy** (equal / lump / max-defer / bracket-fill /
  explicit weights) emitting ordinary-income withdrawal-tax actions; inherited Roth = 10-year
  clock, tax-free. **This is the core value of the design** — how to draw the inbound assets down
  optimally against the heir's other income/brackets.
- **AU inherited cost base (§6.3)**: heir inherits the deceased's cost base (no step-up), with
  the deceased's `acquisitionDate` preserved for the CGT-discount / indexation clock.
- **AU super lump-sum (§6.4)**: inherited super is paid out to cash as a **taxed lump sum**
  (non-dependant: taxable component × 15%, +2% Medicare if paid direct), **not** an ongoing account.
- **NE inheritance tax (§6.5)**: relationship-class-based tax on the heir when the decedent's
  situs is Nebraska.
- **Cross-border dual basis (§7)**: a US-citizen AU-resident heir gets US step-up basis *and* AU
  inherited cost base on the same asset — reusing design 62's `costBaseByCountry`.
- Serializer round-trip, net-worth, editor UI, and a param-gated `inheritanceYear`.

### Non-Goals (deferred)
- **Decedent-side estate tax** (US $15M / HI $5.49M estate tax). **Resolved decision §4.1:
  config amounts are what the heir receives (net of any estate tax).** A decedent gross-estate +
  estate-tax toggle is a clean Phase 2.
- **Spousal / tax-dependant inheritance** (US spousal IRA rollover; AU tax-free super to a
  dependant). v1 assumes a **non-dependant** heir (adult child), which is the taxed, interesting
  case. `relationship` already carries the discriminator for a later dependant path.
- **HI estate tax / SD** — HI is estate-level (decedent side, deferred with §4.1); SD has no
  death tax (nothing to model). Only NE contributes an heir-paid tax in v1.
- **Foreign-resident-beneficiary CGT** on an AU deceased estate (deemed disposal for non-TAP when
  the beneficiary is a foreign resident). Out of scope; note-only (§9).
- **Pre-CGT (pre-20-Sep-1985) inherited assets** getting AU market-value reset. Irrelevant to a
  forward-looking sim; note-only (parallels design 62 Gap 5).
- **Disclaimers, partial disclaimers, GST tax, generation-skipping.** Not modeled.

---

## 3. Tax model reference (2026 law)

### US federal
| Item | Treatment |
|---|---|
| Inheritance tax on heir | **None** (federal has no inheritance tax). |
| Estate tax | On the **decedent's estate**; **$15M/person** exemption (2026, permanent per OBBB, Jul 2025). External decedent ⇒ settled pre-distribution (§4.1). |
| Brokerage / real property / collectibles | **Step-up, IRC §1014** — basis = **FMV at date of death**. |
| Traditional IRA / 401(k) | **No step-up** (IRD). Ordinary income to heir on distribution; **SECURE Act 10-year** full-drawdown rule for non-spouse. |
| Inherited Roth | 10-year drawdown clock, but **tax-free**. |

### US states (all key off the **decedent's** situs, not the heir's residency — §4.2)
| State | Regime | Detail |
|---|---|---|
| **HI** | Estate tax only (decedent side) | 10–20% graduated, **$5.49M** exemption. Deferred with §4.1. |
| **NE** | **Inheritance tax (heir-paid)** | County-level, post-LB310 (eff. 2023): **Class 1** (parents, grandparents, children, grandchildren, siblings) **$100k exempt + 1%**; **Class 2** (aunts/uncles/nieces/nephews + descendants/spouses) **$40k + 11%**; **Class 3** (unrelated) **$25k + 15%**. |
| **SD** | None | No estate or inheritance tax. |

### Australia
| Item | Treatment |
|---|---|
| Inheritance / estate tax | **None** (abolished 1979). |
| Inheriting a CGT asset | **Not a CGT event.** Heir **inherits the deceased's cost base** (post-CGT assets) — *no step-up* — and the deceased's acquisition date for the discount/indexation clock. Pre-CGT ⇒ market value at death (deferred, §2). |
| Deceased main residence | CGT-free if sold **within 2 years** of death and not income-producing at death (ITAA97 s118-195). |
| Superannuation death benefit | Paid to a **non-dependant**: taxable component **15%** (taxed element) / 30% (untaxed element); **+2% Medicare** (→ 17% / 32%) if paid **direct** to the beneficiary rather than via the estate. Tax-free component untaxed. |

**Sources**: [IRS 2026 exemption](https://www.morganlewis.com/pubs/2025/10/irs-announces-increased-gift-and-estate-tax-exemption-amounts-for-2026),
[NE LB310 rates](https://legalunitedstates.com/nebraska-inheritance-tax/),
[HI estate tax](https://smartasset.com/estate-planning/hawaii-estate-tax),
[ATO inherited cost base](https://www.ato.gov.au/individuals-and-families/investments-and-assets/capital-gains-tax/inherited-assets-and-capital-gains-tax/cost-base-of-inherited-assets),
[SECURE Act / IRD](https://www.fidelity.com/learning-center/personal-finance/retirement/secure-act-inherited-iras),
[AU super death benefit](https://www.grantthornton.com.au/insights/blogs/tax-on-superannuation-death-benefits/).

---

## 4. Resolved decisions

### 4.1 Estate tax — assume netted
Config inherited amounts are **what the heir actually receives**, i.e. already net of any
US/HI estate tax the external estate paid. Design 63 models **no decedent-side estate tax**. A
decedent gross-estate + estate-tax toggle is a deferred Phase 2 (§2 Non-Goals).

### 4.2 State tax situs — explicit `decedentState`
The `Bequest` carries a **`decedentState`** field (defaults to the heir's residency state). NE
inheritance tax and (future) HI estate tax key off `decedentState`, **not** the sim person's
HI/NE/SD residency — matching the legal situs rule. One field, correct by construction.

### 4.3 Retirement accounts — optimizable US 10-year drawdown, lump-sum AU super
- **US traditional IRA/401(k) & Roth**: model the **SECURE 10-year drawdown** as a **first-class
  optimizable lever** (not a fixed equal-tenths default) — the distribution schedule is a tunable
  strategy the optimizer co-solves with the rest of the drawdown / Roth-conversion levers (§6.2).
  This is the design's raison d'être: managing the inbound assets optimally against the heir's
  own income and brackets.
- **AU super**: a non-dependant cannot retain it in super ⇒ **taxed lump-sum payout to cash** at
  inheritance (§6.4), not an ongoing account (no distribution lever — it's forced out at once).

### 4.4 Cross-border dual basis — model it
A US-citizen AU-resident heir gets **US step-up** and **AU inherited-cost-base** on the same
asset ⇒ genuine dual cost base via design 62's `costBaseByCountry` (§7).

---

## 5. Injection mechanism — seed-at-zero, fund-on-event

The framework seeds **all** assets at t=0 via toolset `state()`; there is no mid-run
account-creation pattern and this design does not add one.

**Each inherited asset seeds at t=0 with `value 0` / `balance 0`.** A zero-valued asset
contributes 0 to net worth and is ineligible for drawdown **automatically** — no new visibility
gates anywhere. An **`INHERIT` event** at `Date.UTC(inheritanceYear, m, d)` funds each record:

1. **Fund** — set `value`/`balance` to the configured inherited FMV (nominal at the inheritance
   date). This mirrors, in reverse, design 49's `COMPANY_SALE` zeroing an asset.
2. **Stamp basis** per country rules (§6): US step-up ⇒ `costBasis = FMV`; AU ⇒ inherited cost
   base + preserved acquisition date; cross-border ⇒ both (§7).
3. **Record death tax** — NE inheritance tax (§6.5), AU super lump-sum tax (§6.4).
4. **Schedule downstream** — for US inherited retirement accounts, arm the 10-year forced
   drawdown stream (§6.2).

**`InheritHandler` (`INHERIT` event) + `InheritApplyReducer` (`INHERIT_APPLY`)** live in a new
`src/finance/account-rules/inheritance-classes.js`, registered by a new **`INHERITANCE`** toolset
(§8). The handler resolves the destination cash account (via `resolveCashKey`, per the design-55
Phase 6b pattern) for lump-sum proceeds; the reducer funds each state entry copy-on-write (per
the design-journal purity invariant) and chains the per-asset `*_TAX` actions.

> **Why fund-on-event rather than an `inheritedOnMs` visibility gate:** seeding at 0 reuses the
> *existing* net-worth/drawdown zero-handling with no cross-cutting changes. An activation flag
> would require new branches in net-worth, drawdown eligibility, `_syncBalance`, and every tax
> classifier — far more surface. The one cost is that appreciation *before* inheritance isn't
> modeled (the config value is the FMV *at* the inheritance date), which is the correct basis
> anchor anyway (step-up/inherited-base are both measured at death).

---

## 6. Per-country / per-asset mechanics

### 6.1 US step-up (brokerage, real property, collectibles)
On `INHERIT_APPLY`, for a US-situs inherited brokerage lot / property / collectible, stamp
`costBasis = value` (FMV). For holdings-bearing brokerage, seed **a single lot** at the funded
value with `purchaseDate = inheritance date` and `costBasis = value` ⇒ a next-day sale realizes
~zero gain. No new tax code — the existing sale/CGT paths consume the stepped-up basis directly.

### 6.2 US IRD — inherited traditional IRA / 401(k) / Roth (SECURE 10-year), optimizable
The inherited account is funded as a **heir-owned** `TraditionalIRAAccount` / `FourOhOneKAccount`
/ `RothAccount` (no step-up — IRD). The `INHERITANCE` toolset arms a **10-year distribution
`EventSeries`** (`INHERITED_RA_DISTRIBUTION`), analogous to the existing RMD stream, whose
per-year amount is chosen by an **optimizable distribution strategy** (below). Tax routing:
- **Traditional**: each distribution emits the existing `IRA_WITHDRAWAL_*_TAX` /
  `K401_WITHDRAWAL_TAX` actions → `usOrdinaryIncomeYTD` (reuse the classifiers in
  `us-tax-module-2026.js`; +`auOrdinaryIncomeYTD` + FTC when AU-resident, already wired).
- **Roth**: distribution is tax-free (emit the balance to cash, no ordinary-income action).
- Distributions are **penalty-exempt** — the stream emits the plain withdrawal-tax action, never
  `EARLY_WITHDRAWAL`, regardless of the heir's age / `minimumAge` gate.

**The distribution strategy is the primary lever this design exists to optimize.** Modeled as an
`INHERITED_RA_DISTRIBUTION_STRATEGY` registry (sibling of the design-26 spending-strategy and
design-58 drawdown-lever families), each entry a pure `plan(balance, yearIndex, ctx) → amount`
with a **hard terminal constraint**: cumulative distributions must equal the full balance by
`yearIndex === 9` (a forced catch-up in the final year guarantees the SECURE mandate is met, so
no strategy can under-distribute).

| Strategy | Behavior | Tunable params (optimizer) |
|---|---|---|
| `equal` | Equal tenths. | — (baseline) |
| `lump` | All in a chosen year `k` (default year 0). | `inheritedRaLumpYear` (0–9) |
| `maxDefer` | Nothing until year 9, full balance then. | — (worst-case bracket spike; useful bound) |
| `bracketFill` | **Distribute enough each year to fill the heir's ordinary income up to a ceiling; forced catch-up in year 9.** The real bracket-smoothing solution. | `inheritedRaFillCeiling` (real base-year USD) |
| `weights` | Explicit per-year weight vector, renormalized, catch-up-clamped. | `inheritedRaWeight::0`…`inheritedRaWeight::9` |

**`bracketFill` is the recommended default optimizable form** — one scalar (`inheritedRaFillCeiling`)
captures ~all the value (fill to the top of the 22%/24% bracket, spill the rest into year 9), and
it co-optimizes naturally with Roth conversions and the design-58 drawdown order because they all
compete for the same bracket headroom.

**Scheduling (load-bearing).** `INHERITED_RA_DISTRIBUTION` must fire **late in the year**
(Dec, high `order`) so `state.usOrdinaryIncomeYTD` has already accumulated the year's wages,
RMDs, design-58 drawdowns, and Roth conversions — that YTD figure *is* the competing "other
ordinary income" the fill works under. The amount returned is then itself added to
`usOrdinaryIncomeYTD` and settled at year end. Firing early would read a near-empty YTD and
over-distribute. (Event-queue ordering: give it a high `order` so it lands after the year's
income/withdrawal events but before the tax settle.)

**`bracketFill` planner (concrete):**

```js
// INHERITED_RA_DISTRIBUTION_STRATEGY['bracketFill']
// @param balance   remaining inherited-RA balance at the start of this distribution
// @param yearIndex 0..9 within the SECURE 10-year window
// @param ctx { otherOrdinaryIncome,  // state.usOrdinaryIncomeYTD read at fire time (nominal)
//              fillCeilingReal,       // inheritedRaFillCeiling, REAL base-year USD (optimized)
//              cpiIndexUS,            // cpiAccumulator.US — nominal/real factor for this year
//              WINDOW }               // = 10
// @returns amount to distribute this year, 0 <= x <= balance
function bracketFillPlan(balance, yearIndex, ctx) {
  const LAST = ctx.WINDOW - 1;                          // year 9

  // (1) TERMINAL CATCH-UP — the SECURE mandate is non-negotiable. Whatever remains
  //     in the final window-year is fully distributed. Guarantees the constraint.
  if (yearIndex >= LAST || balance <= 0) return Math.max(0, balance);

  // (2) Inflate the REAL ceiling into this year's nominal dollars, so it compares
  //     against nominal usOrdinaryIncomeYTD (design-39 real-units rule: the reducer
  //     inflates; the optimizer search range stays real & fixed).
  const ceilingNominal = ctx.fillCeilingReal * ctx.cpiIndexUS;

  // (3) Headroom under the ceiling after the year's OTHER ordinary income.
  const fillRoom = Math.max(0, ceilingNominal - ctx.otherOrdinaryIncome);

  // (4) Fill the room, capped at what remains. fillRoom === 0 (already at/over the
  //     ceiling) ⇒ distribute nothing this year; it rides to a later year or the
  //     year-9 catch-up.
  return Math.min(balance, fillRoom);
}
```

**Why the ceiling is optimized, not fixed.** A too-low ceiling under-drains and forces a
terminal spike: e.g. a $500k IRA + $60k/yr other income under a $100k ceiling fills $40k/yr,
leaving ~$140k dumped in year 9 (income spikes to ~$200k); a ~$115k ceiling fills ~$55k/yr and
drains smoothly. The spike is *self-penalizing* in the objective (the year-9 bracket jump raises
lifetime tax), so the solver raises the ceiling — unless late-window bracket rates or an
intervening residency change genuinely favor deferral, in which case it keeps it low on purpose.

> **Cliff refinement (deferred).** A `bracketFillPaced` variant would floor the draw at
> `balance / (WINDOW − yearIndex)` (an even share of the *current* balance), capping the terminal
> cliff — but that distributes *above* the ceiling in under-drained years, making it a genuinely
> different strategy. Since `weights` can already express any hand-tuned smoothing, ship
> `bracketFill` pure and add `bracketFillPaced` only if the optimizer struggles with the cliff.

> **Optimizer-key gotcha (see the dotted-key note):** the tunable params route through the
> Opt/MC/MPC `set()` path, which **silently drops dotted keys** (`inheritedRaWeight.3` never
> creates its parent). Use **`::`-delimited flat keys** (`inheritedRaWeight::3`,
> `inheritedRaFillCeiling`) exactly as the design-58 levers do. `inheritedRaFillCeiling` is a
> **real** base-year USD ceiling (do not inflate the search range — the ordinary-income compare is
> done in the reducer's own units), matching the design-39 MPC-lever real-units convention.

### 6.3 AU inherited cost base (no step-up)
For an AU-situs inherited CGT asset, stamp `costBaseByCountry.AU = deceasedCostBase` (a **new
config field on the inherited asset**, not FMV) and `acquisitionDateByCountry.AU =
deceasedAcquisitionDate` (preserving the deceased's holding-period clock for the Div 115 discount
+ design 57 indexation — the design 62 §4 machinery reads exactly these fields). The universal
`costBasis` also takes the inherited base (AU-only heir has no US step-up). **Deceased main
residence**: if `inheritedFromMainResidence` and sold within 2 years, the AU main-residence
exemption applies — reuse design 62 §5.3's `auMainResidenceExemptFraction` with the 2-year window.

### 6.4 AU super death benefit — taxed lump sum
Inherited super is **not** funded as an ongoing `SuperannuationAccount`. On `INHERIT_APPLY`:
- Split the inherited super into `taxFreeComponent` / `taxableComponent` (config fields; taxable
  defaults to the whole balance).
- Emit `SUPER_DEATH_BENEFIT_TAX`: `taxableComponent × 0.15` (+ `× 0.02` Medicare when paid direct;
  a `paidViaEstate` flag toggles the +2%). New classifier in the AU tax module → a dedicated
  `auSuperDeathTaxYTD` bucket settled at year end (this tax is *final*, not a marginal-rate
  addition — model it as a direct liability, like the existing withholding paths, not an
  `auOrdinaryIncomeYTD` add).
- Credit the **net** lump sum to the AU cash account.

### 6.5 NE inheritance tax (heir-paid)
When `decedentState === 'NE'`, the reducer computes, **per inherited asset's funded value**, the
class-based tax: `max(0, assetValue − classExemption) × classRate`, where the class derives from
`Bequest.relationship` (`immediate` → Class 1 1%/$100k; `remote` → Class 2 11%/$40k; `unrelated`
→ Class 3 15%/$25k). Emit `NE_INHERITANCE_TAX` → a `neInheritanceTaxYTD` bucket in the US tax
module (a **state** liability, additive to the US state-tax settle, not federal). The exemption
is per-beneficiary per-class; v1 applies it once across the bequest (aggregate the class-eligible
inherited value, subtract one exemption, apply the rate) — matching NE's per-beneficiary basis.

> **Only NE contributes an heir-paid tax in v1.** HI (estate, decedent side) and SD (none) add
> nothing under §4.1. The `decedentState` switch makes adding HI estate tax later a localized change.

---

## 7. Cross-border dual basis (US-citizen AU-resident heir)

When the heir is AU-resident at the inheritance date, an inherited US-situs brokerage lot /
property gets **both**:
- **US basis** (`costBasis`, universal/worldwide for the US citizen) = **FMV at death** (step-up).
- **AU basis** (`costBaseByCountry.AU`) = **deceased's cost base** (no step-up) +
  `acquisitionDateByCountry.AU` = deceased's acquisition date.

This is exactly the dual-cost-base shape design 62 already produces for a residency step-up — the
only difference is *which* side steps up (there, AU resets to market on immigration; here, US
resets to FMV on inheritance while AU keeps the deceased's base). The existing sale reducers
already emit both `gain` (US) and `auGain` (AU) and compute FTC on `auGain` — **no new sale-path
code**, just the correct basis stamped at `INHERIT_APPLY`. A same-asset sale therefore shows a
small US gain (near-zero, stepped up) and a larger AU gain (deceased's low base), which is the
correct cross-border result.

---

## 8. Wiring

- **Domain**: `Bequest` config object (plain, `structuredClone`-safe) holding `{ name, decedentName,
  relationship, decedentState, inheritanceYear, inheritanceMonth?, inheritanceDay?, paidViaEstate?,
  assets: [...] }`. Each entry in `assets` is a tagged inherited-asset descriptor
  (`__type: 'RealProperty' | 'Collectible' | 'InvestmentAccount' | 'TraditionalIRAAccount' | ...`)
  plus inheritance metadata (`inheritedValue`, `deceasedCostBase?`, `deceasedAcquisitionDate?`,
  `taxFreeComponent?`, `taxableComponent?`, `inheritedFromMainResidence?`, `distributionMode?`).
- **Service**: `BequestService` (register in `ServiceRegistry`) — CRUD + expansion of a `Bequest`
  into (a) zero-valued seed records and (b) the `INHERIT` + `INHERITED_RA_DISTRIBUTION` schedules.
- **Handler/reducer**: `src/finance/account-rules/inheritance-classes.js` — `InheritHandler`,
  `InheritApplyReducer` (§5), and the forced-distribution handler for §6.2. Register in the
  new **`INHERITANCE`** toolset (`id: 'INHERITANCE'`, `dependencies: ['US_TAX', 'AU_TAX',
  'US_INCOME']`).
- **Distribution-strategy registry** (§6.2): `INHERITED_RA_DISTRIBUTION_STRATEGY` +
  `plan(balance, yearIndex, ctx)` entries with the terminal catch-up constraint; the
  distribution handler resolves the active strategy + its tunable params from the bequest config.
- **Optimizer/MC params** (§6.2): register `inheritedRaFillCeiling` (real base-year USD),
  `inheritedRaLumpYear`, and `inheritedRaWeight::0..9` as tunable params in the Opt/MC/MPC config,
  using **`::` flat keys** (never dotted — silently dropped by `set()`). These are optimized
  jointly with the design-58 drawdown levers and Roth-conversion params (shared bracket headroom).
- **Tax classifiers**: `SUPER_DEATH_BENEFIT_TAX` + `auSuperDeathTaxYTD` (AU module);
  `NE_INHERITANCE_TAX` + `neInheritanceTaxYTD` (US-state settle). Both reset at year end and
  registered in the schema registry / per-person slices, mirroring existing YTD buckets.
- **Compiler context** (`scenario-compiler.js:171` area): add
  `bequests: services.bequestService?.getAll() ?? []`.
- **Toolset registration**: `ToolsetRegistry`, `IntlRetirementScenario.getToolsets()`, the
  scenario `toolsetRegistry.register(INHERITANCE)` block, and `buildAndCompile()` (parallel to
  `US_COLLECTIBLES` at `intl-retirement-scenario.js:771` / `:1111`).
- **Net worth**: no change for the zero-seed period (0 contributes 0); after funding, each record
  is a standard asset already handled by `net-worth.js`. Verify the retirement-account and
  brokerage branches accept the funded records (they should — same shapes).
- **Serializer**: `_serializeBequest` / `_makeBequest` + thread `bequests` through
  `serialize` / the `deserializePersonsAccounts` paths; `__type: 'Bequest'` registered.
- **Default scenario + param**: an example `bequests` entry gated behind an `inheritanceYear`
  typed param (group "Assets") with a param→node cascade (parallels `companySaleYear`, design 49 §6).
- **UI**: `bequest-editor.js` (decedent fields + a repeatable inherited-asset sub-editor reusing
  the existing per-type editors), node renderer, config-list label `bequest: 'Inheritance'`,
  and `StateSchemaRegistry` currency registration for the funded state keys.

---

## 9. Phasing

- **P1** — `Bequest` domain + `BequestService` + serializer round-trip + zero-seed expansion
  (assets appear at 0, no funding yet). Net-worth = 0 pre-date. Tests: serializer + seed-shape.
- **P2** — `INHERIT` handler/reducer + `INHERITANCE` toolset: fund records at the date, US step-up
  (§6.1), AU inherited cost base (§6.3). Cross-border dual basis (§7) falls out. Tests:
  `evt-inheritance.test.mjs` — funded net worth jumps at the date; US next-day sale ≈ 0 gain; AU
  sale uses deceased's base.
- **P3** — US IRD 10-year drawdown (§6.2): `INHERITED_RA_DISTRIBUTION` stream + the
  `INHERITED_RA_DISTRIBUTION_STRATEGY` registry (`equal`/`lump`/`maxDefer`/`bracketFill`/`weights`)
  with the terminal catch-up constraint, ordinary/tax-free routing, penalty-exempt. Wire the
  `::` tunable params into Opt/MC/MPC. Tests: each strategy's schedule; catch-up guarantees full
  distribution by year 9; `bracketFill` fills to the ceiling then spills; `usOrdinaryIncomeYTD`
  accrues; a headless optimize picks a lower-tax schedule than `equal` on a bracket-straddling case.
- **P4** — AU super lump-sum (§6.4) + NE inheritance tax (§6.5): new classifiers + buckets + settle
  wiring. Tests: non-dependant super 15/17% split; NE class-1/2/3 exemption+rate; SD/HI ⇒ 0.
- **P5** — default-scenario instance + `inheritanceYear` param + cascade + full editor UI +
  `StateSchemaRegistry`. Browser-verify: editor round-trip, net-worth appearance at the date,
  drawdown of the inherited RA. `npm run build:index` + `npm run test:unit` + `npm run test:viz`.

**Regression guard**: with no `bequests` configured the compiler context is `[]`, the toolset
contributes no state/schedules, and every run is byte-identical to today. The reference golden
(`cross-border-relief-scenario`) has no bequest ⇒ must not move.

---

## 10. Testing

`tests/unit/evt-inheritance.test.mjs` (new, `EVT-*`):
- **Seed-at-zero**: pre-date net worth excludes the bequest; funded net worth jumps on the date.
- **US step-up**: inherited brokerage sold the following period ⇒ `usCapitalGainsYTD ≈ 0`;
  collectible/property same.
- **AU inherited base**: AU-resident heir sells inherited asset ⇒ `auGain` from deceased's cost
  base (not FMV); discount clock uses deceased's acquisition date; main-residence 2-year window.
- **Cross-border dual basis**: US-citizen AU-resident heir ⇒ small US gain (stepped up) + larger
  AU gain (deceased base) + FTC on `auGain`.
- **US IRD**: inherited traditional IRA ⇒ distributions over ≤10 years, `usOrdinaryIncomeYTD`
  accrues, penalty-exempt; inherited Roth ⇒ tax-free distributions.
- **Distribution strategies**: `equal` = tenths; `lump`/`maxDefer` = single-year spike; every
  strategy fully distributes by year 9 (terminal catch-up); `bracketFill` fills ordinary income
  to `inheritedRaFillCeiling` then spills the remainder to year 9; `::` params reach the reducer
  through the optimizer `set()` path (dotted equivalents are dropped — assert both).
- **AU super**: non-dependant taxable component × 15% (direct ⇒ ×17%); tax-free component untaxed;
  net lump sum credited to AU cash.
- **NE inheritance tax**: Class 1 ($100k/1%), Class 2 ($40k/11%), Class 3 ($25k/15%);
  `decedentState` SD/HI ⇒ no heir tax.
- **Fallback safety**: no `bequests` ⇒ byte-identical; old-save round-trip for `Bequest`.

---

## 11. Deferred / documented-only

- **Decedent-side estate tax** (US $15M / HI $5.49M) — §4.1; a gross-estate + estate-tax toggle.
- **Spousal / tax-dependant inheritance** — US spousal IRA rollover (no 10-year rule); AU tax-free
  super to a dependant. `relationship` already carries the discriminator.
- **Foreign-resident-beneficiary CGT** on an AU deceased estate (non-TAP deemed disposal) — §2.
- **Pre-CGT (pre-20-Sep-1985) inherited assets** — AU market-value reset; irrelevant to a
  forward-looking sim (parallels design 62 Gap 5).

---

## 12. Implementation notes (as-built)

Shipped across five phases on `wip/inheritance`. Tests: `tests/unit/evt-inheritance.test.mjs`
(`EVT-63`). Reference golden (`cross-border-relief-scenario`, which *is* the default scenario)
did **not** move.

### 12.1 Files
- **Domain**: `src/finance/assets/bequest.js` (`Bequest extends SimGraphNode`, kind `'bequest'`).
- **Service**: `src/finance/services/bequest-service.js` — CRUD + `expand()` (→ `{ seeds, inherited,
  inheritanceDateMs }`) + `inheritedAssetMeta()` (the `__type` → seed/tax taxonomy).
- **Handlers/reducers**: `src/finance/account-rules/inheritance-classes.js` — `InheritHandler`,
  `InheritApplyReducer`, `InheritanceNeTaxApplyReducer`, `InheritedRaDistributionHandler`,
  `InheritedRaDistributionApplyReducer`.
- **Strategy registry**: `src/finance/account-rules/inherited-ra-distribution-strategy.js`
  (`equal`/`lump`/`maxDefer`/`bracketFill`/`weights`, terminal catch-up).
- **Toolset**: `src/scenarios/toolsets/inheritance-toolset.js` (`INHERITANCE`, deps
  `US_TAX`/`AU_TAX`/`US_INCOME`).
- **Tax classifiers**: `INHERITED_RA_DISTRIBUTION_TAX` + `NE_INHERITANCE_TAX` (US 2026 module);
  `SUPER_DEATH_BENEFIT_TAX` (AU 2026 module). YTD buckets `neInheritanceTaxYTD` /
  `auSuperDeathTaxYTD` added to `YTD_FIELDS` reset (`tax-settle-classes.js`).
- **UI**: `bequest-editor.js` (programmatic DOM: decedent fields + repeatable inherited-asset rows),
  `bequest-node-renderer.js` (🕊️), config-list `bequest: 'Inheritance'`, `workbench-app.js`
  add-flow + editor mount, `scenario-loader.js` currency registration.
- **Scenario**: example `estateBequest` in `buildDefaultConfig` (brokerage / IRA-bracketFill /
  home); `INHERITANCE` added to `getToolsets()`, `buildFullParamSchema()`, and the
  `buildAndCompile()` toolset registry (three lists must stay in sync).

### 12.2 Deltas from the plan
- **Example bequest ships inert** (`inheritanceYear: null`). The toolset `state()` seeds only
  bequests with a set `inheritanceYear`, so the inert default is byte-identical and the golden is
  unmoved (§9 guard). Set the year (param or editor) to activate. Required because the golden *is*
  the default scenario.
- **NE inheritance tax is an immediate heir payment** at the inheritance date
  (`InheritanceNeTaxApplyReducer` debits US cash + `neInheritanceTaxYTD` records it) rather than
  aggregated into the Dec-31 state-tax settle. Amount + incidence are exact; the toolset does not
  depend on `US_STATE_TAX`. Settle-timing aggregation is a follow-up (§11).
- **AU super death tax is withheld at source**: `InheritApplyReducer` credits the *net* lump sum to
  AU cash and records `auSuperDeathTaxYTD` (reporting), rather than adding to the settle (avoids
  double-charge). "Settled at year end" = the bucket resets yearly.

### 12.3 Parameter model — per-record generation (design 55), *in progress*
The first cut exposed the inherited-RA distribution knobs as **static, always-on global** params
(`inheritedRaStrategy`, `inheritedRaFillCeiling`, `inheritedRaLumpYear`, `inheritedRaWeight::0..9`)
plus a single hand-wired `inheritanceYear` param node-linked to the one example bequest. That is the
design-55 anti-pattern: the params clutter *every* scenario (even with no inheritance) and the
tuning knobs are **unlinked** (no `node`, not tied to a record field).

**Corrected to the design-55 template-driven path** (parallels accounts): the params are now
**generated from the Bequest records themselves**, so they exist only when an inheritance does and
each carries a `node` (linking, design 32):
- **Per `Bequest`** (`BEQUEST_PARAM_TEMPLATE`): `inheritanceYear` → `bequest.<stateKey>.inheritanceYear`.
- **Per inherited retirement asset** (`INHERITED_RA_PARAM_TEMPLATE`): `distributionMode`
  (strategy), `fillCeiling` (real USD), `lumpYear` → `raAsset.<stateKey>.<field>`. The distribution
  handler reads these **per-account** (baked from the asset descriptor) instead of from global
  `context.parameters`; the `weights` vector rides on the asset descriptor (editor/JSON), defaulting
  to equal. The old global toolset params + `DEFAULT_OPTIMIZATION_CONFIGS` entries are retired.
- New generator prefixes `bequest.` / `raAsset.` + cascade node types `bequest` / `bequestAsset`.
- **Optimizer discovery**: generated `opt` params are *not* auto-swept — `buildOptVariables`
  only reads `DEFAULT_OPTIMIZATION_CONFIGS` + dynamic builders. So a `buildInheritedRaOptConfigs`
  dynamic builder (sibling of the Roth-schedule / expense-band builders) discovers each inherited
  RA from its `raAsset.<sk>.distributionMode` param and emits its `fillCeiling` + `lumpYear` axes.
- **Note**: the RA drawdown knobs are per-inherited-*retirement*-account — a bequest whose only
  asset is a brokerage / property / collectible generates **no** RA params (correct).

---

## 13. Post-inheritance asset promotion

**Status: IMPLEMENTED (P6a + P6b).** Inherited brokerage / real property / collectible are now
promoted to fully-usable assets; retirement growth + discretionary drawdown remain **v2** (§13.5).
The v1 injection (§5) funded each inherited record in `state` but did **not** integrate it into the
systems that *use* an asset over its remaining life — a funded inheritance was visible on the
balance sheet but otherwise **inert**. This section (now built) closes that gap.

### 13.0 As-built
`BequestService.expandContextRecords(bequest)` turns each ACTIVE bequest's inherited brokerage /
real property / collectible into first-class **record shapes** (role + `drawdownPriority` for
brokerage; `appreciationRate` + `plannedSaleYear` for property/collectible), and the compiler's
`_buildContext` **injects** them into `context.accounts` / `context.realProperties` /
`context.collectibles` (transient — never registered with the services, so they never
double-serialize). The owning toolsets then build the growth / dividend / appreciation / sale
**handlers** for them from `context`, exactly like any other record.

State seeding stays authoritative in the `INHERITANCE` toolset (it runs last, and
`_mergeStatePatches` is last-wins), so **net worth always works even without the owning toolset**
(graceful degradation); the owning toolset only adds the handlers on top. Inherited brokerage gets
its `role` + `drawdownPriority` in the seed itself, so **liquidity + drawdown are state-driven** and
work without the brokerage toolset (growth needs it). The `INHERIT` event still funds everything at
the date (§6); seed-at-0 keeps it invisible until then. Editor: a per-asset **sale-year** field
liquidates an inherited property/collectible. Tests: `EVT-63 §13` — brokerage counts in net
liquidity, is drawn for expenses, and grows; property/collectible appreciate + sell at their year.

### 13.1 Current behavior (what a funded inherited asset participates in)

| Capability | Mechanism | Inherited asset today |
|---|---|---|
| Net worth | `computeNetWorth` sums any state entry with numeric `balance` or `kind` | ✅ counts |
| Net liquidity / after-tax liquidity | `isDrawdownAccessible` requires `drawdownPriority != null` | ❌ seeds have `drawdownPriority: null` |
| Discretionary drawdown (cover expenses) | `AccountService.replenishSavings` iterates `state`, same `drawdownPriority != null` gate | ❌ excluded (brokerage is *stranded*) |
| Post-inheritance growth / dividends / interest | earnings handlers built at **compile** from the `accountService` record list, keyed by role/stateKey (one handler per account) | ❌ not a service record + `role: null` → never grows |
| Real-property / collectible sale | one-off sale event scheduled at compile from `realPropertyService` / `collectibleService` records with a `plannedSaleYear` | ❌ not service records + no sale year → never sellable |
| Role-based systems (design-58 weights, cash-sleeve interest, StateRegistry) | keyed by `role` | ❌ `role: null` → invisible |

The one exception: inherited **retirement** accounts are drained by the SECURE 10-year forced
stream (§6.2) — the handler holds explicit stateKeys, not roles — so they convert to cash over ten
years, but they still don't **grow** between distributions.

### 13.2 Root cause
Inherited assets live **inside the `Bequest` container** and are only **seeded into `state`** (which
is why net worth — the sole system that iterates raw `state` — works). Every other system operates
on the **service records** (`accountService` / `realPropertyService` / `collectibleService`) and the
**role registrations** wired at **compile**. Two distinct integration models:
- **State-driven** (net worth, net liquidity, drawdown): reachable by giving the seed the right
  `role` / `drawdownPriority` / age-gate fields — no compile-handler change.
- **Compile-handler-driven** (growth, dividends, appreciation, sale scheduling): the asset must be
  in the per-record handler/event construction lists — i.e. a **registered service record**.

### 13.3 Proposed approach — promote to first-class records at compile, seeded at 0
`BequestService.expand()` (or the compiler) **registers each inherited asset as a proper service
record**, seeded at value/balance **0**:
- inherited brokerage / retirement → `accountService` (with `role`, `drawdownPriority`, `ownerId`,
  `currency`, `minimumAge`/`allowsEarlyWithdrawal`);
- inherited real property → `realPropertyService`; inherited collectible → `collectibleService`.

Because they are now ordinary records, they flow automatically into **every** system — net worth,
net liquidity, drawdown, earnings/appreciation handlers, sale scheduling, role lookups, the
design-58 levers, the after-tax metric — with **no per-system special-casing**. The `INHERIT` event
still funds them mid-sim (sets balance/value + stamps basis, §6); **seed-at-0 keeps them invisible
until the inheritance date** (0 net worth, 0 liquidity, 0 drawable) — the §5 invariant is preserved.
The `Bequest` stays the config/editor container; each expanded record carries a back-reference
(`bequestId`) + the inheritance metadata the `INHERIT` reducer needs. (Alternative — have the
`INHERITANCE` toolset replicate the earnings/appreciation/sale wiring for bequest-held assets —
was rejected: it duplicates four toolsets' worth of wiring and drifts from them.)

### 13.4 Per-asset-type promotion rules
- **Brokerage** → equity role (`US_STOCK` / `AU_STOCK`), a default `drawdownPriority` (after the
  heir's own investments), country equity growth + dividend handlers ⇒ grows, liquid, drawdownable.
  This fixes the *stranded brokerage*.
- **Traditional IRA / 401(k) / Roth** → heir-owned retirement accounts (roles `IRA`/`K401`/`ROTH`),
  `allowsEarlyWithdrawal: true` (inherited distributions are penalty-exempt, §6.2) so they are
  age-accessible ⇒ grow + count toward liquidity; the **SECURE forced stream still drains them**
  (§6.2). **Decision:** do inherited RAs *also* enter discretionary drawdown (extra draws routed
  through the ordinary-income withdrawal-tax path), or is the forced stream the sole drain? Recommend
  **forced-stream-only** in v1 (the SECURE stream already provides the cash + the tax routing);
  discretionary inherited-RA drawdown is a Phase-2 refinement.
- **Real property** → `realPropertyService` (appreciation via `AssetAppreciationHandler`); an
  **optional inherited sale year** schedules the sale ⇒ converts to cash. The design-62 §5.3
  main-residence 2-year exemption is already wired.
- **Collectible / Gold** → `collectibleService` (appreciation); optional sale year schedules
  `COLLECTIBLE_SALE`. Gold indexation (design 57) already handled.
- **Super** → unchanged: forced taxed lump-sum to cash at inheritance (already liquid, §6.4).

### 13.5 Decisions to resolve
1. **Role collisions** — an inherited IRA vs. the heir's own IRA share a role+owner. Options: (a)
   reuse the role (both drain together at the same rates; the framework already supports
   multi-account-per-role via stateKey-scoped params — simplest); (b) dedicated `inherited-*` roles
   (isolated ordering/rates). **Recommend (a).**
2. **Drawdown priority default** for inherited accounts (fixed band vs. a generated per-account
   param). Recommend a sensible default band + the design-58 lever / the design-55 generated
   `drawdownPriority` param can reorder.
3. **Growth rate default** — inherited accounts use the country global rate; the design-55 per-account
   rate override applies once generated.
4. **Sale-year exposure** — add `plannedSaleYear` (or an inheritance-relative offset) to inherited
   real-property / collectible descriptors, generated as a per-record param (§12.3 pattern) + an
   editor field.

### 13.6 Phasing
- **P6a — DONE.** Promote inherited **brokerage** ⇒ role + `drawdownPriority` (liquidity + drawdown,
  state-driven) + growth/dividends (context-injection). Fixes the stranded brokerage. (Retirement
  promotion — growth + discretionary drawdown — deferred to **v2**: role reuse collides with the
  RMD/contribution machinery, and the SECURE stream already provides the cash + tax routing.)
- **P6b — DONE.** Promote inherited **real property + collectible** ⇒ appreciation + sale year
  (context-injection) + an editor sale-year field.
- **P6c — DONE.** Per-record *generated* sale-year param (design 55 / §12.3 pattern):
  `INHERITED_SALE_PARAM_TEMPLATE` → `saleAsset.<stateKey>.plannedSaleYear` for each inherited
  RealProperty / Collectible (node `bequestAsset`, new `saleAsset.` generator prefix). Cascades onto
  the asset, which `expandContextRecords` reads to schedule the sale — plus the editor sale-year field.

### 13.7 Regression guard
Seed-at-0 keeps every metric byte-identical before the inheritance date; a bequest-free scenario
registers no records. The reference golden stays unmoved.

---

## 14. Full first-class integration — promote to real records

**Status: IMPLEMENTED (P1–P4).** After critical review the **effective-records overlay** below
(§14.2–§14.6, kept for context) was **rejected** in favor of a simpler, lower-risk architecture:
**promote inherited assets to real service records.** Rather than an overlay every consumer must be
rerouted through, inherited **brokerage / real-property / collectible** become ordinary
`accountService` / `realPropertyService` / `collectibleService` records tagged
`{ inherited: true, bequestId }`, seeded at value/balance **0** (the FMV rides in `inheritedValue`;
the `INHERIT` event funds them at the date). Because they are normal records, **every consumer works
with zero reroutes** — holdings dropdown, journal Cash-Flow-by-Account, state metrics, per-record
param generation → OPT/MC/MPC/behavior/spending, net worth, drawdown, growth, sale — and this
**deletes** the overlay, the §13 transient context-injection, the cascade wrinkle, the collision
reconcile, and the load-order trap.

### 14.0 As-built
- **Promotion is a loader cfg-transform** (`ScenarioLoader._promoteBequestAssets`, run BEFORE the
  param cascade so per-record params cascade onto the promoted record — the §14.4 load-order
  invariant). It hoists each **active** bequest's non-retirement inline assets out of
  `cfg.bequests[].assets` into `cfg.accounts / realProperties / collectibles`, tagged + seeded at 0.
  Retirement / super stay inline (SECURE stream / lump-sum). An **inert** bequest (no
  `inheritanceYear`) is left untouched, so the reference golden is byte-identical.
- **Link key = the bequest's `stateKey`** (its durable identity — `createBequest` reassigns `id` at
  deserialize). `BequestService.expand()` reads the promoted records back by `bequestId ===
  bequest.stateKey` to (a) seed them at 0 in the `INHERITANCE` toolset (authoritative net-worth
  fallback, identical to the pre-§14 seed) and (b) build their `INHERIT` funding descriptors.
- **Inheritance metadata** (`inherited, bequestId, inheritedValue, deceasedCostBase,
  deceasedAcquisitionDate, inheritedFromMainResidence`) is a shared helper
  (`src/finance/assets/inheritance-meta.js`) applied on the Account / RealProperty / Collectible
  domain classes + their whitelist serializers (emitted only when `inherited`, so owned records
  round-trip byte-for-byte).
- **Params:** promoted brokerage → `acct.<sk>.{growthRate,dividendRate,…}` + role-based drawdown /
  sleeve levers (role `US_STOCK`/`AU_STOCK`); property/collectible → `prop./coll.<sk>.plannedSaleYear`.
  The bequest keeps `bequest.<sk>.inheritanceYear` + per-inherited-RA `raAsset.<sk>.*`. The old
  `INHERITED_SALE_PARAM_TEMPLATE` / `saleAsset.` prefix is **retired**; `plannedSaleYear` was added to
  `COLLECTIBLE_PARAM_TEMPLATE` (§14.5 collision resolution) so there is one source of the sale-year knob.
- **Editor:** the bequest editor still authors inline assets (retirement always; brokerage/property/
  collectible while the bequest is inert). Once active they are promoted — real records edited in the
  Accounts / Assets panels — and shown read-only in the bequest editor for context. Serialize never
  double-writes (each asset lives in exactly one place).
- **v2 unchanged (§14.8):** inherited retirement / super are NOT promoted (role collision with the
  heir's RMD/contribution/drawdown machinery); they stay inline + SECURE-stream / lump-sum, already
  optimizer-tunable via `raAsset.*`.

Tests: `evt-inheritance.test.mjs` EVT-63 §14 (loader promotion, single-serialize, per-record OPT
params) + `serializer-finance-roundtrip.test.mjs` (inheritance-metadata round-trip). Browser-verified:
an activated default bequest funds at the date (brokerage 0→400k→grows), and the inherited brokerage
appears in the holdings dropdown, journal facet, state metrics, and Scenario/Optimizer param panels.

---

### 14.1 (original proposal — the effective-records overlay, superseded by §14.0)

§13 (P6a/b/c) made inherited brokerage / property / collectible *participate*
in the run (net worth, liquidity, drawdown, growth, sale) by injecting them into the **compiler
context**. But a promoted asset is still **invisible to every tool that discovers accounts from the
serialized config records** rather than from the runtime context/state — the *tuning* and *reporting*
layer. This section closes that gap so an inherited account drops into the OPT/MPC levers, the
behavior / spending strategies, the holdings UI, the state metrics, and the journal reports — while
staying a **projection of the `Bequest`** (never a serialized account of its own).

### 14.1 Symptoms (what a user sees today)
1. Inherited accounts are **absent from the holdings-panel dropdown**.
2. **Cash Flow by Account** (and the sibling per-account journal reports) don't show the inherited
   account's flows.
3. Inherited accounts are **absent from the state-view Metrics**.

All three trace to the **same** structural fact — plus one incidental naming fragility (§14.6).

### 14.2 Root cause — three discovery topologies, one gap
The framework reaches "the accounts" through **three different lists**, and inherited assets are in
two of them but not the third:

| Layer | Built by | Contains inherited assets? | Consumers |
|---|---|---|---|
| **Config records** | `accountService.getAll()` (+ realProperty/collectible services) | ❌ **no** | serialize (`scenario-serializer.js:456,:486`), **`ScenarioParamGenerator.generate(cfg)`** (`:119`), holdings dropdown (`holdings-plugin.js:182`), journal facet options (`journal-report-plugin.js:523`), `buildOptVariables(scenario.accounts)` (`optimization-presenter.js:51`) |
| **Compiled context** | `_buildContext` = services `+ expandContextRecords` (`scenario-compiler.js:181`) | ✅ yes (active bequests) | runtime handlers (growth / dividend / appreciation / sale / drawdown) |
| **Runtime state** | toolset `state()` seeds | ✅ yes | net worth, drawdown eligibility, Lever-B online re-stamp |

The **config-records** layer is the one that both (a) feeds serialization — which is *why* we must not
register inherited assets there (double-serialize → duplicate-on-reload) — and (b) feeds
**per-record param generation** and the **UI/report account lists**. So the very list we must keep
inherited assets *out of for persistence* is the list the tuning + reporting tools *read from*.

**Per-record params are the crux of "drop into OPT/MPC/behavior/spending."** `ScenarioParamGenerator`
generates `acct.<sk>.<field>` / `prop.<sk>.<field>` / `coll.<sk>.<field>` params **from
`cfg.accounts` / `cfg.realProperties` / `cfg.collectibles`** (`scenario-param-generator.js:119-127`).
These generated params *are* the design-58 per-account `drawdownPriority`, the per-account growth /
dividend rate overrides, and the design-61/65 sleeve/allocation levers — the knobs the optimizer,
MC, MPC, and the strategy families tune. Because a promoted inherited account is **not in
`cfg.accounts`**, it generates **no** per-account params, so it rides the bare role default and can't
be independently reordered, rate-overridden, or sleeve-tuned. Fixing visibility (UI) and fixing
tunability (params) are the **same** reroute.

### 14.3 Chosen model — one *effective records* expansion, config stays the source of truth
Keep the **`Bequest` as the sole serialized source of truth** (Direction B). Introduce a single
**effective-records** expansion — `configRecords + expandContextRecords(activeBequests)` — and route
the config-record **consumers that should see inherited assets** through it, while **serialize keeps
reading the raw `getAll()`** (so nothing new is ever persisted). One expansion, reused everywhere;
the promotion logic already exists (`BequestService.expandContextRecords`, `scenario-compiler.js:181`)
— §14 just feeds that *same* output to the four other consumers.

Reroute (read *effective*):
1. **`ScenarioParamGenerator.generate`** — pass an effective `cfg` (config records + active
   promotions) so inherited accounts generate `acct./prop./coll.` per-record params ⇒ they gain
   `drawdownPriority`, rate overrides, sleeve/allocation levers ⇒ **drop into OPT/MC/MPC + behavior /
   spending strategies automatically** (all of those read the generated params / role-keyed state, no
   per-tool special-casing).
2. **Holdings dropdown** (`holdings-plugin.js:182`).
3. **Journal facet options** (`journal-report-plugin.js:523`) + the per-account report **default**
   (§14.6).
4. **`buildOptVariables(scenario.accounts)`** (`optimization-presenter.js:51`) — the Lever-B role
   filter already admits inherited roles (they *reuse* the heir's `US_STOCK`/`AU_STOCK`, §13.4), but
   the effective list makes discovery explicit and future-proofs dedicated inherited roles.

Do **not** reroute:
5. **Serialize / snapshotDomainRecords** (`scenario-serializer.js:456,:486`) — stays on raw
   `getAll()`. This is the invariant that prevents the double-serialize the whole design avoids.

**Where the expansion lives.** Two viable seams; recommend **(a)**:
- **(a) `accountService.getEffective()` (+ realProperty/collectible equivalents)** — a read-through
  overlay = `getAll()` + active promotions, tagged `{ inherited: true, bequestId }`. UI/opt/param-gen
  call `getEffective()`; serialize calls `getAll()`. The service already holds the `bequestService`
  ref path via the registry. Localized, explicit, and the tag lets consumers style/lock inherited
  rows.
- **(b)** Build the effective `cfg` once in `scenario-loader.js` before `ScenarioParamGenerator.
  generate(cfg)` and thread an "effective accounts" array to the UI. Fewer new methods but a longer
  thread through the UI layer.

### 14.4 Persistence semantics (why this is *not* the double-serialize bug)
Rerouting **param generation** means generated param *values* for inherited accounts —
`acct.inheritedBrokerageAccount.drawdownPriority`, rate overrides, `saleAsset.*.plannedSaleYear`,
etc. — get **harvested into `cfg.parameters`**, keyed by `stateKey`. That is **correct and desired**:
it is how a user's post-inheritance edits survive a round-trip, and it is exactly the pattern design 63
already ships for `bequest.*` / `raAsset.*` / `saleAsset.*` params (§12.3). It is **not**
double-serialization: no duplicate *account record* is written — only a scalar param keyed by the
inherited stateKey, whose owning record is **re-expanded from the `Bequest` on every load**.

**Load-order invariant (load-bearing):** the effective expansion **must run before**
`ScenarioParamGenerator.generate` on every load, so the inherited record exists when its params
regenerate. Otherwise the design-55 §14 **de-generation guard** (`scenario-loader.js:793`) sees an
"orphaned" generated param (no owning record) and strips it — silently dropping the user's tuning.
The guard is the safety net *and* the trap: keep the expansion upstream of both generation and
de-generation.

### 14.5 Param-template collisions to reconcile
Promoting property / collectible into the **generation** cfg means the standard `prop.` / `coll.`
templates now fire for them **alongside** the existing bequest-specific `saleAsset.` template — and
`ScenarioParamGenerator` **throws on duplicate keys** (`scenario-param-generator.js:107`). Concretely:
- `prop.<sk>.plannedSaleYear` (`REAL_PROPERTY_PARAM_TEMPLATE`) **collides** with
  `saleAsset.<sk>.plannedSaleYear` (`INHERITED_SALE_PARAM_TEMPLATE`). **Resolution:** retire
  `INHERITED_SALE_PARAM_TEMPLATE` / the `saleAsset.` prefix once property/collectible flow through the
  standard `prop.`/`coll.` generation. Collectibles currently generate **nothing**
  (`COLLECTIBLE_PARAM_TEMPLATE = []`), so to preserve the P6c sale-year knob, **add `plannedSaleYear`
  to `COLLECTIBLE_PARAM_TEMPLATE`**. Net: one source of the sale-year param, via the same template
  every other property/collectible uses.
- **Retirement (v2):** if inherited IRA/401(k)/Roth are ever promoted (§14.7), `acct.<sk>.*` would
  overlap the `raAsset.<sk>.*` distribution knobs — keep them **disjoint** (distribution strategy on
  `raAsset.`, earnings/priority on `acct.`) or the same dup-key guard throws.

### 14.6 Journal naming fragility (task-2, standalone)
The per-account journal reports (`CashFlowByAccountDef` et al.) select account-balance rows with
`{ op: 'contains', field: 'stateKey', value: 'account.balance' }`
(`report-definition-registry.js:328,369,404,439,637,726`). This works **only because every scenario
account's `stateKey` ends in `…Account`** (`usSavingsAccount.balance` contains `account.balance`,
case-folded). It is disambiguation-by-luck: it scopes "balance rows" to accounts and excludes
real-property `.value` and loan `.balance` **purely via the `account` substring**. The report `api`
(`JournalQueryApi`) does **not** expose the account set, so it can't currently build the filter from
real identities.

Inherited assets break this only when their `stateKey` **lacks `account`** — i.e. **auto-keyed**
assets (`${bequest.id}_a<i>`, `bequest-service.js:282`) or a user key without the word. The shipped
example uses `inheritedBrokerageAccount` and is unaffected.

Two fixes, escalating:
- **Tactical (ship now):** make `_assignAssetStateKeys` **category-aware** so an auto-keyed
  *account* asset gets a `…Account` suffix (`${base}_a<i>Account`), conforming to the convention.
  Property/collectible keys stay un-suffixed (correctly excluded from account-balance reports —
  they're `.value`). One function + one pinning-test update; zero regression to existing reports.
- **Robust (folds into §14.3):** once `getEffective()` exists, replace the fragile substring: default
  the report's `accountStateKeys` to the **effective account set** and OR their `${sk}.balance`
  prefixes (generalizing `_appendAccountStateKeyFilter`, which already does this per *selected*
  account). This removes the substring dependency for good and is inheritance-agnostic (also fixes any
  future non-`…Account` account key).

### 14.7 Name propagation (task-2, standalone)
`_seedPlain` omits `name`, so the inherited account's **state entry has no label**
(`bequest-service.js` seed shape) — any surface that labels from state shows a fallback. Carry
`asset.name` into **both** the state seed (`_seedPlain`) and the promoted context record
(`expandContextRecords` already sets `name`, keep in sync), and have `getEffective()` surface it as
the account label. This is the "we aren't leveraging the name" gap — independently correct, no
dependency on §14.3.

### 14.8 Retirement promotion (still v2 — **now specified in §15**)
Inherited IRA/401(k)/Roth remain drained by the SECURE 10-year forced stream (§6.2) and are **not**
promoted to first-class growing/tunable accounts. Doing so collides the reused role
(`IRA`/`K401`/`ROTH`) with the heir's own RMD/contribution machinery (§13.5 decision 1). The
effective-records seam (§14.3) is the substrate for it, but the role-collision resolution
(shared-role vs. dedicated `inherited-*` roles) is deferred with §13.5. **§15 resolves this** —
dedicated `inherited-*` roles (§13.5 decision 1b), the stream-discovery reroute, and the A/B growth
decision.

### 14.9 Phasing
- **P7a (task-2, now):** name propagation (§14.7) + category-aware auto-key (§14.6 tactical). Ships
  independently; no serialize/param changes.
- **P7b:** `getEffective()` overlay (§14.3a) + reroute holdings dropdown, journal facet options, and
  state metrics ⇒ symptoms 1 & 3 fixed; journal facet lists inherited accounts.
- **P7c:** reroute `ScenarioParamGenerator.generate` through the effective cfg + reconcile template
  collisions (§14.5) ⇒ inherited accounts gain per-record params ⇒ drop into OPT/MC/MPC + behavior /
  spending. Load-order invariant test (§14.4).
- **P7d:** robust journal per-account default from the effective set (§14.6 robust); retire the
  `account.balance` substring.
- **P8 (v2):** retirement promotion — dedicated `inherited-*` roles (§14.8 → **fully specified in §15**).

### 14.10 Regression guard
Every reroute reads `getEffective()`, which for an **inert / bequest-free** scenario is identical to
`getAll()` (no active promotions) — so param generation, the UI lists, and the opt variables are
byte-identical and the reference golden stays unmoved. Serialize never changes. The name +
auto-key changes only affect inherited records, which don't exist in the golden.

---

## 15. Retirement promotion — dedicated inherited roles (P8, v2)

**Status: P8a IMPLEMENTED** (visibility + stream preserved; growth still v2 — P8b/P8c open). Closes
the gap §14.8 deferred: inherited **traditional IRA / 401(k) / Roth**
are still *inline* bequest assets — invisible to the Holdings panel and the per-account Journal
reports, and absent from per-record param generation — while inherited brokerage / property /
collectible were promoted to first-class records in §14. §14.8 parked retirement because promoting
it with the heir's own `IRA` / `K401` / `ROTH` role collides with the role-keyed RMD / contribution /
conversion machinery. This section promotes it anyway, using **dedicated `inherited-*` roles**, so
the inherited RA becomes an ordinary visible/tunable `accountService` record **without disturbing the
SECURE 10-year forced stream**. It folds in the resolved **A/B growth decision** (§15.4).

### 15.1 Why the shared-role promotion was rejected — the two couplings (verified in code)
Promotion itself does **not** break the SECURE stream. Two *separate* couplings do, and they must
both be undone:

- **Coupling 1 — role collision (what §14.8 names).** The US retirement toolset builds **RMD,
  contributions, earnings, and k401→IRA conversion** by filtering on role:
  `accounts.filter(a => a.role === ACCOUNT_ROLES.IRA / K401 / ROTH)`
  (`us-retirement-toolset.js:500-502`, per-account handler loops at `:796` / `:835`, conversion
  target lookup at `:631`). A promoted inherited RA carrying `role: IRA` lands in every one of those
  lists and gets **double-machined** — RMD'd and contributed-to *on top of* the SECURE stream.
- **Coupling 2 — stream discovery (the subtler one).** The SECURE stream's account list is built by
  scanning the **inline** `bequest.assets` — `_inheritedRaAccounts()` iterates `context.bequests[].assets`
  for retirement stateKeys (`inheritance-toolset.js:38-44`). Promotion is precisely the act of hoisting
  an asset **out** of `bequest.assets` into `cfg.accounts` (`scenario-loader.js:_promoteBequestAssets`,
  which today `continue`s on `meta.isRetirement`). So a promoted RA would **vanish** from the list the
  stream reads. This — not the role — is the mechanism by which naive promotion severs the drawdown.

What is **not** coupled: the stream's *draining* (`InheritedRaDistributionHandler.call` reads
`state[acct.stateKey].balance` by explicit stateKey, never by role — `inheritance-classes.js:247-276`),
and *visibility* (Holdings lists `accountService.getAll()` filtered by state holdings; the per-account
Journal reports key off the `…Account` stateKey substring, §14.6) — both role-agnostic. So the win is
real: a dedicated role gives visibility **and** keeps the stream, once both couplings are undone.

### 15.2 Chosen model — dedicated `inherited-*` roles
Add three roles to `ACCOUNT_ROLES` (`finance/state/account-roles.js`):
`INHERITED_IRA: 'inherited-ira'`, `INHERITED_K401: 'inherited-k401'`, `INHERITED_ROTH: 'inherited-roth'`.
Promote each inherited traditional-IRA / 401(k) / Roth out of `bequest.assets` into `cfg.accounts`
tagged `{ inherited: true, bequestId }` and seeded at balance **0** (the FMV rides in `inheritedValue`;
the `INHERIT` event funds it at the date — the §5 seed-at-0 invariant is preserved).

**What the dedicated role buys for free** (no code, just non-matching):
- **No RMD** — the RMD handler loops iterate the role-`IRA`/`K401` lists; `inherited-*` never matches.
  (Correct: an inherited IRA has *no* lifetime RMD — the SECURE 10-year rule replaces it.)
- **No contributions** — same role filters; you cannot contribute to an inherited IRA.
- **No k401→IRA conversion** — `iraAccounts.find(...)` / `k401Accounts` never see it.
- **Out of discretionary drawdown** — kept via `drawdownPriority: null` (the `isDrawdownAccessible`
  gate is `drawdownPriority == null → false`, `net-liquidity.js:58`), so it stays **forced-stream-only**
  (preserving the §13.4 / §13.5 decision). It still counts in **net worth** (raw state entry with a
  numeric `balance`) exactly as the inline seed does today.

**What still needs explicit wiring** (§15.7): the stream-discovery reroute (Coupling 2), and — for
growth — an earnings handler keyed on the inherited roles (§15.4), because the earnings loops are
*also* role-filtered and won't pick up `inherited-*` on their own.

### 15.3 Visibility — what promotion unlocks, unchanged from §14
Because the promoted RA is now an ordinary `accountService` record it flows into every config-record
consumer with zero new special-casing (the whole point of §14): the **Holdings dropdown**
(`accountService.getAll()` — now inheritance-aware after the picker-refresh fix so a mid-sim-funded RA
appears once funded), the **per-account Journal reports** (needs the §14.6 `…Account` stateKey suffix —
`_assignAssetStateKeys` already appends it for account-category assets), **per-record param generation**
(`acct.<sk>.*`), and thus the **OPT / MC / MPC / behavior / spending** layers. Serialize stays single
(the record lives in `cfg.accounts`, never re-emitted from the bequest).

### 15.4 Resolved decision — A/B growth
A promoted inherited RA funds as a bare `balance` with **no holdings** today: `InheritApplyReducer`
gates the stepped-up lot on `!isRetirement` (`inheritance-classes.js:162-173`), because IRD accounts
carry no CGT cost base — the whole balance is ordinary income on distribution, so there is nothing to
model per-lot. The question is whether a *promoted* one should stay balance-only or gain a lot.

The pivotal fact: **the earnings path already grows a holdings-less account.** `computeHoldingsGrowth`
falls back to `balance × growthRate` when `holdings.length === 0` (`holdings-earnings.js:128-133`). So
growth does **not** require holdings — it requires an **earnings handler**. That reframes the decision:
it is not "grows vs. doesn't grow"; it is **scalar-balance growth (A)** vs. **allocatable holdings that
also plug into the design-61/65 levers (B)**.

- **Option A — scalar-balance growth (SHIP THIS).** Keep the `!isRetirement` no-lot funding. Add a
  small earnings-handler loop keyed on the `inherited-*` roles (reuse `IntlIraEarningsHandler` /
  `IntlK401EarningsHandler` / `IntlRothEarningsHandler` with the RA's `stateKey` + `growthRate`), which
  grows `balance × rate` via the fallback. Result: **visible, drained by the stream, tax-correct, and
  it grows** — a strict improvement over today (inline RAs don't grow at all, §13.1). What it does *not*
  get: per-holding allocation / sleeve / rebalance levers (design 61/65), because those operate on
  `holdings`. Traditional grows pre-tax; Roth grows tax-free (matching the handler classes).
- **Option B — allocatable holdings (FLAGGED FOLLOW-UP).** Additionally drop the `!isRetirement`
  gate for *promoted* RAs so `InheritApplyReducer` seeds an inherited pre-tax lot (mix from an editor
  allocation input, defaulting to a single equity lot), preserving IRD semantics (`contributionBasis`
  stays 0; no CGT basis is *used* — the lot's basis is inert for a pre-tax wrapper, consumed only as
  ordinary income). Result: everything in A **plus** the RA participates in the design-61/65
  allocation-aware growth / rebalance / drawdown levers and (if its role is added to
  `EQUITY_SERVED_ROLES`, `us-retirement-toolset.js:587`) design-60 cash-sleeve interest.

**Decision: A ships in P8; B is a documented follow-up.** A captures the economics faithfully (an
inherited IRA is a single pre-tax pool drained over ten years — per-holding allocation is a
refinement, not the model), with far less surface area (no funding-reducer change, no editor
allocation input, no lever plumbing). B is the natural sequel once someone wants to tune the inbound
RA's asset mix; the dedicated-role substrate makes it additive.

### 15.5 Per-asset mechanics
- **Traditional IRA → role `inherited-ira`**, `allowsEarlyWithdrawal: true` (inherited distributions
  are penalty-exempt regardless of heir age, §6.2), `drawdownPriority: null` (forced-stream-only),
  `contributionBasis: 0` (whole balance is IRD ordinary income). Earnings handler (A) grows pre-tax.
- **401(k) → role `inherited-k401`** — identical treatment; the SECURE stream + ordinary-income tax
  path already handle it by stateKey.
- **Roth → role `inherited-roth`**, `contributionBasis` semantics moot (distributions tax-free); the
  stream's `isRoth` flag already suppresses `INHERITED_RA_DISTRIBUTION_TAX` (`inheritance-classes.js:315`).
  Earnings handler (A) grows **tax-free**.
- **AU super → unchanged.** Not an ongoing account — forced taxed lump-sum to cash at inheritance
  (§6.4); nothing to promote.

### 15.6 Params — keep `raAsset.` and `acct.` disjoint (§14.5)
The RA keeps its SECURE-drawdown knobs on the bequest-scoped prefix
(`raAsset.<sk>.{distributionMode,fillCeiling,lumpYear,weights}`). Promotion additionally generates
the standard **`acct.<sk>.{growthRate,dividendRate,drawdownPriority}`** per-record params. These must
stay **disjoint** — distribution strategy on `raAsset.`, earnings/priority on `acct.` — or the
`ScenarioParamGenerator` duplicate-key guard throws (`scenario-param-generator.js`, §14.5). `dividendRate`
is inert for a pre-tax wrapper (no dividend stream on retirement); it generates harmlessly or is
suppressed for `inherited-*` roles. `drawdownPriority` generates but stays `null` unless a future
version opts the RA into discretionary drawdown (§13.5 decision — deferred).

### 15.7 Wiring (file-by-file)
1. **`finance/state/account-roles.js`** — add `INHERITED_IRA` / `INHERITED_K401` / `INHERITED_ROTH`
   + an `INHERITED_RETIREMENT_ROLES` set consumers recognize a promoted RA by.
2. **`finance/services/bequest-service.js`** (where `INHERITED_ASSET_META` lives) — give the retirement
   entries an `inheritedRole`; add `promotedRetirementMeta(role)` → `{ isRetirement, isRoth }` so the
   seed / funding-descriptor helpers derive the pre-tax (no-lot) funding + Roth-tax-free flags from the
   promoted record's dedicated role.
3. **`finance/assets/inheritance-meta.js`** — carry the SECURE-drawdown knobs (`distributionMode`,
   `fillCeiling`, `lumpYear`, `weights`) on the inheritance-metadata mixin so they travel onto the
   Account domain object (`context.accounts` is `accountService.getAll()`, not the raw cfg) and
   round-trip. **This is the subtle load-bearing detail** — without it the knobs are dropped at
   deserialization and every promoted RA silently falls back to the default strategy.
4. **`scenario-loader.js` `_promoteBequestAssets` / `_bequestAssetToRecord`** — stop `continue`-ing on
   `meta.isRetirement` (skip only super); hoist retirement into `cfg.accounts` with the dedicated role,
   `drawdownPriority: null`, `allowsEarlyWithdrawal: true`, `contributionBasis: 0`, seeded at 0, keeping
   its RA `__type` + any authored SECURE knobs. Extend the `bequestAsset` param cascade to also target a
   promoted RA in `cfg.accounts`.
5. **`scenario-param-generator.js`** — emit `raAsset.*` for promoted inherited RAs in `cfg.accounts`
   (node `bequestAsset`, by stateKey) so promotion doesn't strand a user's tuned strategy (§14.4).
6. **`inheritance-toolset.js` `_inheritedRaAccounts`** — reroute discovery: in addition to scanning
   inline `bequest.assets`, collect promoted inherited RAs from
   `context.accounts.filter(a => a.inherited && INHERITED_RETIREMENT_ROLES.has(a.role))`, linked to their
   active bequest by `bequestId === bequest.stateKey`, deduped by stateKey. **The load-bearing reroute**
   — without it, promotion severs the stream (Coupling 2).
7. **`us-retirement-toolset.js`** (P8b, not P8a) — add an earnings-handler loop over the inherited RAs
   (Option A), reusing the `Intl*EarningsHandler` classes. RMD / contribution / conversion loops need
   **no change** (dedicated roles don't match).
8. **`bequest-editor.js`** — the RA stays authored inline while the bequest is inert; once active it is
   promoted and shown read-only for context (mirrors §14.0 for the other asset types).

### 15.8 Phasing
- **P8a — DONE.** Roles + meta + loader promotion + inheritance-meta knob carry + param
  generation/cascade reroute + `_inheritedRaAccounts` reroute (visibility + stream preserved,
  **no growth yet**). Stream parity proven byte-identical to the inline path (`inheritIra` funds to FMV
  and drains on the same year-by-year schedule; the deferred RA holds exactly its FMV — no growth, no
  RMD), the RA is now a visible `inherited-ira` service record, and every strategy (equal / lump /
  maxDefer / bracketFill / weights) still reaches the handler. Tests: `evt-inheritance.test.mjs`
  EVT-63 §15. 3687 unit + 878 viz green; reference golden unmoved (default bequest is inert).
- **P8b** — inherited-RA earnings loop (Option A scalar growth) + the `acct.*` growth param going live
  (it already generates; P8a just doesn't build the handler that consumes it).
- **P8c (follow-up, Option B)** — relax the `InheritApplyReducer` `!isRetirement` lot gate for promoted
  RAs + editor allocation input + `EQUITY_SERVED_ROLES` opt-in for cash-sleeve; wire the design-61/65
  levers. Separately schedulable.

### 15.9 Testing
- **Stream parity (P8a):** an inherited traditional IRA, inline vs. promoted, drains to the same
  balances year-by-year over the 10-year window (the reroute is behavior-preserving).
- **No double-machining:** a promoted inherited IRA emits **no** `IRA_RMD_APPLY` and receives **no**
  `IRA_CONTRIBUTION_APPLY` (dedicated role excluded) — only `INHERITED_RA_DISTRIBUTION_APPLY`.
- **Visibility:** the promoted RA appears in `accountService.getAll()`, generates `acct.<sk>.*` params,
  and its `…Account` balance rows select into the per-account Journal reports.
- **Growth (P8b):** balance grows `× growthRate` between distributions; Roth growth is untaxed,
  traditional growth is untaxed until distributed then ordinary income.
- **Roth tax-free:** an inherited Roth distribution chains no `*_TAX` action.

### 15.10 Regression guard
Retirement promotion only fires for an **active** bequest holding a retirement asset; the reference
golden has none, so it stays byte-identical. For an inert/bequest-free scenario the new roles never
appear, param generation and the UI/opt lists are unchanged, and the stream-discovery reroute returns
the same set the inline scan did. Serialize stays single-source.
