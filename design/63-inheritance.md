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
</content>
</invoke>
