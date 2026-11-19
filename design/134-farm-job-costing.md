# 134 — Farm job costing: a row-crop farm as a FinSim scenario

**Status:** DRAFT (19 Nov 2026), rev 2. Nothing built. The scope questions in §3 are
decided. §7 records what the primary sources on disk decide. §8 proposes the household link
(Q6). The questions in §11 are open. Rev 2 adds §7 and §8, and corrects rev 1's guess that
Nebraska credits school property tax on the income tax return (it no longer does, §7.3).

**Related:** design 98 (the sweepable parameter surface: per-record generated params become
MC and optimizer levers), design 55 (configuration-driven parameters and record templates),
design 69 (US self-employment tax), design 94 / `scripts/scenario/import-quicken.mjs`
(the import pattern §8 follows), design 113 (fixed-rate loans), design 121 / 126 (shocks
and random shock arrival), design 100 (the MC analysis surface).

## 1. The problem

A US corn and soybean farm keeps its books as **job costing**: every field, in every crop
year, is a job, and each cost and each dollar of revenue is charged to one. The question the
owners ask of those books is forward-looking. Given this year's rents, input prices and a
range of yields and grain prices, **where is each field's breakeven, and how likely is a
loss?** A spreadsheet answers that for one set of assumptions at a time. It can't sweep the
inputs, can't carry correlated yield and price uncertainty, and can't show a distribution.

FinSim already has the pieces such a model needs: a deterministic event engine, a journal,
per-record parameters that become MC and optimizer levers, and a workbench. It doesn't have
farm records, a farm calendar, or a Monte Carlo runner that will run anything other than the
retirement scenario.

## 2. What the source data shows

The design is drawn from one real season's job-cost workbook for a multi-operator farm. That
workbook is private and lives under `scenarios/`, not here. This section describes its
**structure** only.

The workbook is a ledger of `(job, category, amount)` rows. The job code encodes the
operator, irrigated or dry, and the field. With the categories stripped away, almost every
row comes from one of a few rules:

| Line | Rule |
|---|---|
| Cash rent | rented acres × \$/acre, per field |
| Property tax | per parcel, on owned fields |
| Crop insurance premium | acres × a rate set by (crop, irrigated/dry) |
| Seed | per hybrid: share of the field × seeding rate × discounted unit price |
| Fertilizer, chemicals | acres × a per-acre bundle set by (crop, irrigated/dry) |
| Land debt interest | the whole-farm payment spread evenly over owned acres |
| Government program payment | per FSA farm number, split across its fields by acres |
| Grain sales | bushels × one flat price per crop |
| Disaster / relief payments | per operator, not per field |

The model underneath is therefore small: **fields × a crop plan × input prescriptions × yield ×
price, plus whole-farm overhead allocated to fields.** Detail is still wanted (§3, Q4), but
it belongs in a product catalog and per-plan prescriptions, not in a longer list of
categories.

What the workbook got wrong, or left out, gives the design its requirements:

- **Principal was booked as an expense.** Loan principal is a balance-sheet movement. The
  model keeps it out of the P&L (it already does for household loans, design 113).
- **Cost categories were planned but never built:** machinery (ownership and repairs),
  fuel, labor, irrigation pumping, drying, trucking, depreciation. Without them each field's
  profit is overstated, and a breakeven computed from the workbook is too low.
- **The summary was stale.** The pivot table had not been refreshed after sales were entered
  for several fields, which made those fields read as large losses. A model computes its
  reports from the ledger every time.
- **Some revenue belongs to the operator, not to a field.** Job costing needs an
  operator-level job as well as field jobs.
- **Rented and planted acres differ** for some fields. Rent is charged on rented acres;
  inputs and yield on planted acres. The field record carries both.

## 3. Decisions

| # | Question | Decision |
|---|---|---|
| Q1 | Who is it for? | One farm: many fields, three operators. Not a generic farm product. |
| Q2 | Accounting basis | Crop-year job costing first, with breakeven and P&L under swept inputs as the goal. Cash basis (Schedule F) reconciled later. |
| Q3 | Are the operators separate businesses? | Yes. Each files married-joint with a Schedule F; some have dependents. |
| Q4 | Level of detail | High. Individual inputs must be adjustable and sweepable in MC. |

## 4. Architecture: a new scenario type and toolsets, not a new application

**No library split now.** The engine (`src/simulation-framework/`), the graph and the
workbench shell are already free of finance code. The scenario compiler, the loader and the
MC and optimizer runners are not. Splitting FinSim into libraries first would be weeks of
refactoring before any farm logic existed. Building the farm module inside FinSim shows
where the real seams are, so a later split can follow them.

**A new scenario class, `FarmScenario`.** The farm is not a household, so it doesn't belong
inside `IntlRetirementScenario`. It has its own param schema, its own toolset list and its
own records. It is one scenario for the whole farm, with all three operators in it (§5.1).

**New toolsets:**

- **`US_FARM_OPERATIONS`**, the core (§5–§6): the farm calendar, cost and revenue actions,
  and the job-cost ledger.
- **`US_FARM_PROGRAMS`**, later (§9 phase 3): crop insurance and FSA commodity programs.
  Both rest on statute and agency handbooks. Those sources are fetched into `docs/` before
  either is modelled.

**The one framework change: a scenario-agnostic MC and optimizer runner.** Today
`IntlRetirementMcRunner` builds its fallback config from `IntlRetirementScenario`, reads that
class's full param schema for its defaults, samples from `DEFAULT_MC_VARIABLE_CONFIGS`, and
reports `finalNetWorthUsd`. The farm needs the same machinery with three things swapped. A
**scenario descriptor** supplies them:

- the scenario class (its schema and default config),
- the variable catalog (what can be sampled, and its default distributions),
- the result extractor (which metrics an iteration reports).

`IntlRetirementScenario` becomes the first descriptor. Its runs must stay byte-identical, and
the golden fixtures confirm that.

## 5. The model

### 5.1 Records

| Record | Carries | Notes |
|---|---|---|
| **Operator** | name, the household it reports to, tax-year basis | One per farming business. Owns fields and pays its own costs. |
| **Field** | operator, tenure (own / cash rent / later crop share), rented acres, planted acres, irrigated, FSA farm number, base acres, proven yield, \$/acre rent or the linked property and loan | A legal parcel can hold several fields (for example its irrigated and dry parts). |
| **Crop plan** | field, crop year, crop (corn, corn-on-corn, soybeans, …), practice, expected yield, prescriptions | The job. One per field per crop year. |
| **Product** | category (seed, nitrogen, P&K, herbicide, fungicide, …), unit, unit price, discount | The shared catalog. One price change moves every plan that uses the product. |
| **Prescription line** | crop plan, product or field operation, rate per acre, share of acres | A seed hybrid planted on 60% of a field is one line. |
| **Field operation** | name (plant, spray, harvest, haul, dry, irrigate), cost basis | Machinery, fuel and labor cost, by custom-hire rate or own cost (§11 Q5). |
| **Overhead pool** | operator or shared, annual amount, allocation basis (acres, owned acres, operations) | Land debt interest, insurance on equipment, office. |

Each record type gets a template in `record-param-templates.js`, so its numbers (a rent, a
product price, a rate, an expected yield) become generated params, and so MC and optimizer
levers, without any schema work (designs 55, 98). The new namespaces (`farm.field.`,
`farm.plan.`, `farm.product.`, …) must be added to `GENERATED_KEY_PREFIXES`, or the dotted
keys are dropped on `set()`.

Prescriptions and products are flat tables joined by id, edited with the row-list editor.
Nothing nests, and nothing is a JSON text area.

### 5.2 The calendar

A crop year is a set of dated events. The dates are params with defaults, so they can move:

- input prepayment (often in December of the year before, for tax reasons),
- cash rent (often split between a spring and a fall date),
- planting, side-dress, spraying passes,
- the crop insurance premium date,
- harvest, and the grain going into storage or to the elevator,
- grain sales (at harvest, or later out of storage),
- property tax,
- the program payment (paid the autumn after the crop year).

### 5.3 Job-cost ledger

Every cost and revenue action writes a journal entry carrying **its cash date, its operator,
its job (crop plan or operator-level job), its crop year and its category.** The job-cost
P&L is a query over those entries grouped by crop year; the cash P&L is the same entries
grouped by calendar year. **Both reports come from one ledger**, which is what makes the later
reconciliation (Q2) a reporting change rather than a model change.

Overhead is allocated to jobs by a declared basis when the report is built, never stored
pre-split. A changed basis then re-allocates every year at once.

### 5.4 What the reports show

Per crop plan, per operator, per crop and whole-farm:

- revenue, direct cost, allocated overhead, net, each per acre and in total;
- **breakeven price** (total cost ÷ expected bushels) and **breakeven yield** (total cost ÷
  expected price);
- under MC: the distribution of net income and the probability of a loss.

## 6. What varies (the MC surface)

| Variable | Shape |
|---|---|
| Grain price per crop | harvest price plus local basis |
| Yield per crop plan | a farm-wide factor plus a per-field factor; irrigated fields vary less |
| Yield–price link | negative, because a short national crop raises the price; weaker locally than nationally |
| Product prices | per product, plus a per-category multiplier lever (for example "all nitrogen +20%") |
| Rent | per field, plus a farm-wide multiplier |
| Interest rate | on variable-rate land debt |

There are two levels of lever, because a sweep of every product price individually is
unreadable. **Category multipliers** answer "what if fertilizer goes up 30%?" in one axis.
**Per-record params** stay available for the detail Q4 asks for.

Distributions and correlations are calibrated from public sources (USDA NASS county yields,
RMA price elections, historical futures). Sources are fetched into `docs/` before any number
is set.

Optimizer levers, for later: crop mix per field, dropping a rented field, seeding rate,
nitrogen rate, insurance coverage level, the share of the crop sold forward.


## 7. What the law on disk decides

Every source below was fetched on 19 Nov 2026. Each directory's `SOURCES.md` lists the
files, the route and the gaps: `docs/us-tax/` (federal tax), `docs/us-farm-programs/` (FSA
and crop insurance), `docs/ne-law/` (Nebraska). The Code files are the 2024 edition, which
predates **P.L. 119-21** (4 Jul 2025). The Act is on disk, and each Code file's row names the
section that amends it.

### 7.1 Federal tax: what the farm model must produce

- **The cash report has Schedule F's shape.** Schedule F lines 10–32
  (`IRS-Schedule-F-Form-2025.txt`) are the expense categories a filed return uses: chemicals,
  custom hire, depreciation and §179, fertilizers and lime, fuel, insurance, interest, labor,
  rent (machinery vs land), repairs, seeds, storage, taxes, utilities, and so on. Lines 1–9
  are income: sales, **agricultural program payments (4a)**, **CCC loans (5a)**, and **crop
  insurance proceeds (6)**. **Every product and cost category in §5.1 declares its Schedule F
  line.** The cash report then groups by that line, with no second mapping.
- **Fertilizer and lime are deductible when paid** (§180). Seed may be expensed in the year
  of purchase on the cash method (Reg. §1.162-12).
- **Prepaying inputs is bounded.** §464(d): prepaid farm supplies above 50% of the year's
  other deductible farming expenses are deferred, with exceptions. The December prepay date
  (§5.2) is a lever, and this is its ceiling.
- **Crop insurance and disaster proceeds can be deferred a year.** §451(f) and Reg. §1.451-6
  let a cash-method farmer elect to report them in the following year, if their normal
  practice is to sell the crop then. This is a per-operator option on the cash report.
- **Machinery is depreciated or expensed.** §179 (limits raised by P.L. 119-21 §70306) and
  §168(k) full expensing (made permanent by §70301). MACRS classes are in Pub. 946. This
  matters only under own-cost machinery (§11 Q5).

### 7.2 Federal tax: what the household side must model

These act on the operator's whole return, not on a field, so they belong to FinSim's US tax
module. **None of them exists in FinSim today:**

| Provision | Effect | Source |
|---|---|---|
| **§199A** QBI deduction | A deduction of up to 20% of qualified business income, so of farm net. `(g)` covers sales to agricultural cooperatives. Extended by P.L. 119-21 §70105. | `sec199A`, Form 8995 instructions |
| **§461(l)** excess business loss | Caps how much farm loss can offset other income in one year. Made permanent by P.L. 119-21 §70601. | `sec461` |
| **§172(b)(1)(B)** farming loss | A farming NOL carries back 2 years. | `sec172` |
| **§1301** income averaging (Schedule J) | Elected farm income is taxed at the 3 prior years' rates. In a good year this can matter a lot. | `sec1301`, Schedule J instructions |

SECA on Schedule F net already exists (design 69, via the `selfEmployed` path). The farm
optional method (Schedule SE instructions) does not.

### 7.3 Nebraska

- **Owned land is assessed at 75% of actual value** (Neb. Rev. Stat. 77-201(2)), or 50% for
  school bonds voted on or after 1 Jan 2022. Irrigated and dry cropland are separate valuation
  classes (77-1363).
- **School-district relief is a credit on the property tax statement.** From tax year 2024
  it comes through the School District Property Tax Relief Act (77-7305), alongside the older
  Property Tax Credit Act (77-4212). **The model enters property tax net of statement credits,
  as billed.** The former refundable *income* tax credit for school-district taxes
  (77-6703) covers taxable years before 2024 only.
- **The community-college credit is still an income tax credit**, and from 2024 it equals
  **100% of the community-college property tax paid** (77-6706(4)). So an owned field's
  property tax carries **two lines**: the net bill (a farm cost) and its community-college
  share (a refundable Nebraska credit on the operator's return). The export (§8) carries the
  second line to the household.
- **Inputs are mostly free of sales tax.** Exempt: agricultural machinery (77-2704.36),
  repair parts (77-2704.64), seed sold to commercial producers (77-2704.46(2)), and
  agricultural chemicals applied to land or crops (77-2704.46(3)). Prices are entered without
  tax. Whether fertilizer counts as an "agricultural chemical" is not settled by the files on
  disk (a gap in `docs/ne-law/SOURCES.md`).
- **Irrigation is bounded by the field's Natural Resources District.** 46-739 lets an NRD
  allocate groundwater, require rotation or metering, and limit or reduce irrigated acres.
  An irrigated field therefore carries an **allocation cap**, which bounds the irrigated-yield
  assumption and the pumping cost. The cap values are each NRD's own rules (§11 Q12).
- **Beginning-farmer credit.** 77-5211 gives an owner who rents to a certified beginning
  farmer a refundable Nebraska credit. It matters only if a family rental qualifies.

### 7.4 Farm programs

- **PLC and ARC run through crop year 2031**, under the reference prices P.L. 119-21 §10301
  set. The effective reference price factor rises from 85% to 88% from crop year 2025.
  ARC-CO's guarantee is 90% of benchmark revenue for 2025–2031 (§10305). Both are paid per FSA
  farm on base acres, not planted acres (7 U.S.C. §9012–9014). That is why the source workbook
  allocates the payment across a farm number's fields.
- **Revenue protection pays on price × yield.** The guarantee uses the higher of the
  **projected price** and the **harvest price**, unless the harvest-price exclusion is
  elected (7 CFR §457.8; corn and soybeans under the Coarse Grains provisions, §457.113). This
  is what makes insurance interesting under MC: it pays out on the joint yield-and-price draw
  of §6.
- **Gap:** 7 CFR parts 413–459 show as "[Reserved]" in the live eCFR, so the §457 text on
  disk is the 1 Jan 2026 annual edition. Before phase 3, find out where the policy now lives.

## 8. The household link: a farm export FinSim imports (Q6)

### 8.1 Why an export, not one combined scenario

The farm scenario and each operator's household plan stay **separate scenarios**, joined by
a file. The farm scenario produces a **farm result export**, and a FinSim tool imports one
operator's slice of it into that operator's household plan. That is the shape
`import-quicken.mjs` already has: an outside system's numbers, mapped and spliced into a plan,
with a dry run first.

Three reasons it's the right shape:

1. **Three households, not one.** Each operator files their own return. A combined scenario
   would put three families' finances into one file. An export lets each operator import only
   their own slice.
2. **Separate time scales.** The farm runs crop years with a dense calendar; a household
   plan runs decades. Coupling the two runners would make every household MC iteration run a
   farm model.
3. **The farm model stays standalone.** If FinSim is later split into libraries (§4), the
   export is already the seam.

### 8.2 The export

One JSON file per farm run, versioned (`farmResultVersion`). For each **operator** and each
**calendar year**:

- **Schedule F lines.** Income lines 1–9 and expense lines 10–32, the net, and any §451(f)
  deferral moved between years.
- **Household-side inputs** (§7.2–§7.3): QBI-eligible income, net SE earnings, the Nebraska
  community-college credit amount, and the farming loss if any.
- **Owned land and its debt** (optional): the fields that are real property, their value and
  the loans against them, so they can appear on the household balance sheet.

Under MC the export carries the **per-iteration paths**, not only percentiles. Each iteration
is one coherent farm history (prices, yields, the resulting Schedule F) with its seed. A
summary of percentiles alone would let a household run draw a good year for one operator and a
bad one for another in the same world.

### 8.3 The FinSim side

- **A new income record: business income.** It is a person's dated, annual, signed
  amount: one Schedule F net per year, which can be negative. A `job` with
  `selfEmployed: true` (designs 69, 116) doesn't fit: a job is a monthly wage with a growth
  rate, and design 116 D3 rules out concurrent jobs, while a farmer can also have an off-farm
  job. The record feeds the same SECA path as a self-employed job, plus the §7.2 provisions.
- **An import tool**, `scripts/scenario/import-farm.mjs`, on the `import-quicken.mjs` pattern:

  ```sh
  npm run import:farm -- --farm farm-result.json --operator <operator-id> \
    --person <person-id> --into plan.json --out plan-imported.json
  ```

  With no `--out` it is a dry run that prints the per-year table and writes nothing. It
  writes both scenarios into the output (the original untouched, and the imported copy) so
  they can be diffed. It never touches records the export doesn't name.
- **Under household MC**, each iteration draws one farm path from the export by index, on its
  own keyed RNG stream (design 107 §15.5). That keeps a farm year's prices, yields and
  Schedule F together. The farm paths are **independent of the household's market draws**
  (a known simplification: grain prices and equity returns are weakly linked).

### 8.4 What this needs that doesn't exist

1. The business-income record, and its path into US tax (ordinary income, the SECA base).
2. §199A, §461(l), the farming-loss carryback and §1301 averaging in the US tax module
   (§7.2). The QBI deduction is the one to build first: it applies to every profitable year.
3. The Nebraska community-college credit, as a refundable credit fed from the record.

## 9. Phases

0. **Scenario-agnostic MC and optimizer runner** (§4). The retirement goldens stay
   byte-identical.
1. **Deterministic job costing.** `FarmScenario`, the §5.1 records (each category declaring
   its Schedule F line, §7.1), `US_FARM_OPERATIONS`, the ledger, and a Field P&L panel with
   breakeven. Tested on a hand-built small farm. A private import reproduces the source
   workbook's per-field totals, as the acceptance test.
2. **Monte Carlo.** The §6 variable catalog, correlated yield and price, category levers, and
   results showing the breakeven and loss distributions.
3. **Programs.** Crop insurance (revenue protection) and PLC/ARC (§7.4).
4. **Household link** (§8): the export, the business-income record, `import-farm.mjs`, then
   §199A and the other §7.2 provisions in the US tax module.
5. **Reconciliation and marketing.** Grain inventory across year end, storage and forward
   contracts, and the cash-to-accrual reconciliation.

## 10. Not in scope

- Livestock, and crops other than corn and soybeans (the data has one alfalfa field; it gets
  a crop plan with no special mechanics).
- Agronomy: yield is an input with a distribution, not the output of a crop model.
- Payroll for hired labor beyond a cost per operation or a lump overhead.
- Entity structures other than a sole proprietor on Schedule F (partnerships, S corporations,
  farm LLCs taxed as partnerships).

## 11. Open questions

For the owners:

- **Q5 — Machinery cost basis.** Custom-hire rates per operation (simple, published by
  extension services), or own cost (depreciation, repairs, fuel, labor hours)? And is
  equipment shared between the operators? If it is, how is its cost split?
- **Q7 — Rent arrangements.** Is cash rent the only form, or are there crop-share or flexible
  leases? A crop share changes who reports the crop, and the landlord's SE status
  (§1402(a)(1)).
- **Q8 — Grain marketing in phase 2.** Sell everything at harvest, or model storage and
  forward sales from the start?
- **Q9 — One season or a rotation.** Phase 1 is one crop year. When rotation enters, the
  corn-on-corn yield penalty and rotation benefits become inputs.
- **Q10 — Shared overhead.** Which costs are paid by the farm as a whole rather than by an
  operator, and on what basis are they split?
- **Q11 — Tax habits.** Does each operator use the cash method? Do they prepay inputs in
  December, elect the §451(f) crop-insurance deferral, or use income averaging? Do they sell
  to a cooperative (§199A(g))?
- **Q12 — Which NRD** covers each irrigated field, and what is its allocation?
- **Q13 — Program elections.** PLC or ARC, per FSA farm?

For the design:

- **Q14 — Export granularity.** Is a calendar-year Schedule F per operator enough for the
  household side, or does it need the crop-year view too?
- **Q15 — Farm and market correlation** (§8.3). Is drawing farm paths independently of
  household market returns acceptable for phase 4?
