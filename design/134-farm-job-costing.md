# 134 — Farm job costing: a row-crop farm as a FinSim scenario

**Status:** DRAFT (19 Nov 2026), rev 7: **ready to build phase 1.** Nothing built. Every owner
question is answered (§3, Q1–Q20); none is open. §7 records what the primary sources on disk decide. §8 is the household
link.

Revision history: rev 2 added §7 and §8, and corrected rev 1's guess that Nebraska credits
school property tax on the income tax return (it no longer does, §7.3). Rev 3 moved grain
marketing into phases 1–2, narrowed programs to ARC-County, and made overhead per-operator.
Rev 4: the custom-hire rate is a costing rate for the operator's own machines, so the cash
view carries the real machinery cost. Rev 5: one season with a carry-in and a carry-out (§5.5),
one machinery figure per operator, purchases expensed in full, and the own-vs-custom study
(§5.6). Rev 6 (final review): **the generic MC runner moves from before phase 1 to the start of
phase 2**, because phase 1 does not need it and it is larger than rev 1 said (§4). Rev 6 also
fixes the breakeven formulas (§5.4), settles contract shortfalls (§6), and states the phase 1
acceptance test and its first spike (§9). Rev 7 records Q20, which turns the own-vs-custom
study into an operation-by-operation fleet model with its own design (§5.6).

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
| Q5 | Machinery | **Custom-hire rates per acre** for planting, spraying and harvesting, in the job-cost view. |
| Q5a | Who is paid the custom rate? | **No one.** It is a costing rate for the operator's own machines. The cash view (Schedule F) carries the real machinery costs instead (§5.1). |
| Q6 | Household link | A farm export each operator imports (§8). |
| Q7 | Rent | **Cash rent only.** No crop-share or flexible leases. |
| Q8 | Grain marketing | **Modelled from the start**: a storage cost, and forward contracts whose prices vary. |
| Q8a | Storage cost | **Per bushel per month held.** |
| Q8b | Contract types | **Fixed-price cash forward contracts only.** The share of the crop contracted is a lever. |
| Q9 | Horizon | **One season at a time.** No rotation. |
| Q10 | Overhead | **Per operator, never shared** between operators. |
| Q11 | Tax habits | **Cash method.** Next year's inputs (seed, fertilizer, …) are **prepaid in Nov/Dec**. Income is **smoothed by deferring some sales** into the next tax year. |
| Q11a | Co-op sales | **Not relevant.** §199A(b)(7) and (g)(2) are out of scope. |
| Q11b | §451(f) deferral, income averaging | **Offer both as options**, to show their effect. |
| Q12 | Irrigation | All irrigated fields are in **one NRD**, with an allocation in acre-inches per acre. It is a minor input (§7.3). |
| Q13 | Programs | **ARC-County** on every FSA farm. No PLC. |
| Q14 | Export granularity | **A calendar-year Schedule F per operator**, until a reason to go deeper appears. |
| Q15 | Farm vs market correlation | **Independent in phase 4.** Correlation is wanted eventually and needs its own design (§8.3). |
| Q16 | Season vs calendar year | **One simulated season** plus a carry-in and a carry-out (§5.5). |
| Q17 | Machinery cost input | **Phase 1: one annual machinery figure per operator, split by acre.** For tax, equipment is **deducted in full in the year it is bought**, not depreciated. Own vs custom harvest is a wanted study (§5.6). |
| Q18 | Contracted share | **A per-crop default**, different for corn and soybeans, recorded privately. MC sweeps it. |
| Q19 | Pumping cost | **Irrigation electricity is metered per field**: an annual \$ cost per irrigated field, not per acre-inch. |
| Q20 | Own vs custom | **It is a choice per operation, not a share of one figure.** Custom options cover different sets of work (combine only, or field to bin), and each changes which machines are still needed. A whole study with its own design (§5.6). |

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

**The one framework change: a scenario-agnostic Monte Carlo runner, at the start of phase 2.**
Today the MC path is the retirement scenario's. `IntlRetirementMcRunner` builds its fallback
config from `IntlRetirementScenario` and reads that class's param schema for its defaults.
`mc-worker-core.js` constructs an `IntlRetirementScenario` for every iteration and extracts
retirement metrics (`finalNetWorthUsd`, `scenarioFailed`). The 592-line
`intl-retirement-mc-config.js` is retirement variables. The retirement classes appear in 22
files under `src/`, including the grid runner, the MC analysis, the optimizer problem and
solvers, and the MC panel. The farm needs the same machinery with three things swapped. A
**scenario descriptor** supplies them:

- the scenario class (its schema and default config),
- the variable catalog (what can be sampled, and its default distributions),
- the result extractor (which metrics an iteration reports).

`IntlRetirementScenario` becomes the first descriptor. Its runs must stay byte-identical, and
the golden fixtures confirm that.

**Timing and scope.** Phase 1 is deterministic and uses none of this, so it comes first. The
generalisation opens phase 2, when the farm's own variable catalog exists and the descriptor
can be shaped by two real users rather than guessed from one. Phase 2 needs only the **MC
path** (runner, worker core, config split into a generic core and a per-scenario catalog).
The grid runner, the optimizer and its solvers follow only when a farm study needs them. The
farm gets its own MC results panel rather than bending the retirement one.

## 5. The model

### 5.1 Records

| Record | Carries | Notes |
|---|---|---|
| **Operator** | name, the household it reports to, tax-year basis | One per farming business. Owns fields and pays its own costs. |
| **Field** | operator, tenure (own / cash rent), rented acres, planted acres, irrigated, FSA farm number, base acres, proven yield, \$/acre rent or the linked property and loan | A legal parcel can hold several fields (for example its irrigated and dry parts). |
| **Crop plan** | field, crop year, crop (corn, corn-on-corn, soybeans, …), practice, expected yield, prescriptions | The job. One per field per crop year. |
| **Product** | category (seed, nitrogen, P&K, herbicide, fungicide, …), unit, unit price, discount | The shared catalog. One price change moves every plan that uses the product. |
| **Prescription line** | crop plan, product or field operation, rate per acre, share of acres | A seed hybrid planted on 60% of a field is one line. |
| **Field operation** | name (plant, spray, harvest, …), **custom-hire \$/acre**, passes | Q5: planting, spraying and harvesting are charged to each job at a per-acre custom rate × passes. **Job-cost view only**: no cash moves (Q5a). A prescription line references the operation. |
| **Machinery cost** | operator, crop year, **one annual amount** (Q17), allocation basis (acres) | Q5a, Q17: the **real** cost of the operator's own machines, split across the operator's fields by acre. A machine bought this year is in it at its **full price**, because it is deducted in full in the purchase year (§7.1). |
| **Irrigation electricity** | irrigated field, crop year, annual \$ (metered) | Q19: a direct cost of the field (Schedule F line 30, utilities). |
| **Overhead pool** | operator, annual amount, allocation basis (acres, owned acres) | Land debt interest, insurance, office. Q10: always one operator's. Allocated across **that operator's** fields only. |
| **Forward contract** | operator, crop, bushels, fixed price (Q8b), delivery date, **payment date** | Q8: prices the contracted bushels. A payment date after 31 Dec is how a sale is deferred into the next tax year (Q11). |
| **Storage** | operator, crop, **cost per bushel per month** (Q8a), from and to dates | Q8: the cost of holding unsold or contracted-later grain. |
| **Planned sale** | operator, crop, share of unpriced bushels, sale date, payment date | The bushels not under contract: sold at harvest or later out of storage, at the price on the sale date. |

Each record type gets a template in `record-param-templates.js`, so its numbers (a rent, a
product price, a rate, an expected yield) become generated params, and so MC and optimizer
levers, without any schema work (designs 55, 98). The new namespaces (`farm.field.`,
`farm.plan.`, `farm.product.`, …) must be added to `GENERATED_KEY_PREFIXES`, or the dotted
keys are dropped on `set()`.

Prescriptions and products are flat tables joined by id, edited with the row-list editor.
Nothing nests, and nothing is a JSON text area.

### 5.2 The calendar

A crop year is a set of dated events. The dates are params with defaults, so they can move:

- **input prepayment in November or December of the year before** (Q11; bounded by §464(d), §7.1),
- cash rent (often split between a spring and a fall date),
- planting, side-dress, spraying passes,
- the crop insurance premium date,
- harvest, and the grain going into storage or to the elevator,
- grain sales: contract deliveries, and planned sales at harvest or later out of storage, each
  with its own payment date,
- storage cost, accruing while grain is held,
- property tax,
- the ARC-County payment, made from 1 October after the end of the crop's marketing year
  (7 U.S.C. §9017(f)), so **in the calendar year after harvest**.

**One season spans three calendar years** (Q9, Q11): its inputs are prepaid in year *Y − 1*,
it is grown and mostly sold in year *Y*, and its deferred sales and ARC payment land in year
*Y + 1*. That is why the ledger carries both dates (§5.3). It is also why a calendar-year
Schedule F needs more than one season's flows (§8.2).

### 5.3 Job-cost ledger

Every cost and revenue action writes a journal entry carrying **its cash date, its operator,
its job (crop plan or operator-level job), its crop year and its category.** The job-cost
P&L is a query over those entries grouped by crop year; the cash P&L is the same entries
grouped by calendar year. **Both reports come from one ledger**, which is what makes the later
reconciliation (Q2) a reporting change rather than a model change.

Overhead is allocated to jobs by a declared basis when the report is built, never stored
pre-split. A changed basis then re-allocates every year at once. Overhead never crosses
operators (Q10).

**Machinery has two bases, and the report can show either** (Q5, Q5a, Q17). The **custom
basis** charges each field the custom-hire rate × passes. The **actual basis** charges each
field its acre share of the operator's real machinery figure; the cash view always uses this
one. The difference is the **machinery margin**: custom value minus real cost. A positive
margin says owning the machines is cheaper than hiring the work done (§5.6).

**Grain on hand at 31 December is inventory**, not yet revenue on the cash basis. The ledger
holds bushels by crop, operator and location (bin or contract). The crop-year report values
them at their contract or expected price. The cash report shows nothing until the payment
date.

### 5.4 What the reports show

Per crop plan, per operator, per crop and whole-farm:

- revenue, direct cost, allocated overhead, net, each per acre and in total;
- **breakeven price**: (total cost − non-grain revenue) ÷ expected bushels, where non-grain
  revenue is ARC, insurance indemnity and other operator income charged to the job;
- **breakeven price on the unpriced bushels**: (total cost − non-grain revenue − contracted
  revenue) ÷ bushels not under contract. This is the number a marketing decision needs: the
  price the rest of the crop must fetch;
- **breakeven yield**: (total cost − non-grain revenue) ÷ expected price per bushel, with the
  contracted bushels at their contract price;
- under MC: the distribution of net income and the probability of a loss.

### 5.5 One season, a carry-in and a carry-out (Q16)

A calendar year's Schedule F mixes three seasons (§5.2). The design simulates **one season**
and supplies the rest as inputs:

| Lands in calendar year *Y* | Source |
|---|---|
| Last crop's deferred sales and storage | **Carry-in**: bushels on hand and open contracts on 1 January, from the operator's own books. They are already known when the plan is made. |
| Last crop's ARC-County payment | **Carry-in**: an expected amount. The county yield is published and the national price nearly settled by then. |
| This crop's flows | **The simulated season.** |
| Next crop's Nov/Dec prepay | **Carry-out**: an amount, set as a lever and capped by §464(d). |

Simulating last season again would replace facts with guesses, and next season reaches year *Y*
only through the prepay decision. So running three seasons back to back costs more setup and
more MC variables without making year *Y* more accurate.

What keeps multi-season open: a scenario holds a **list of seasons** from the start, and
a **roll forward** action copies a season (fields, plans, prescriptions, contracts) into the
next crop year as a starting point. Going back to back later, for example to test an
income-smoothing strategy over several years, is then configuration, not a redesign.

### 5.6 Study: own machinery vs custom hire (Q20)

The owners want to compare running their own machines with hiring work done: harvest first,
and spraying and post-plant fertilizer application next. Q20 shows this is **not** a share of
the machinery figure. It is a choice made per operation, and each choice changes the fleet:

- **Custom combining only.** A per-acre rate. The operator no longer needs a combine, heads or
  grain carts, but still hauls, so still needs semis.
- **Custom combining, field to bin.** A higher per-acre rate. Fewer semis are needed, but some
  are still needed to haul grain out of storage to sell. Tractors are still needed for
  planting and other work.
- **Custom application** (spraying, fertilizer after planting). The same shape: a rate per
  acre, and a sprayer or applicator the operator may no longer need.

So the study needs a small **fleet model**, which phase 1's single machinery figure stands in
for:

| Piece | Carries |
|---|---|
| **Machine** | type (combine, head, grain cart, semi, tractor, planter, sprayer, tender, …), annualised ownership cost (price less trade-in value, spread over the years kept, plus interest), yearly running cost (repairs, fuel, labor, insurance) |
| **Operation** | which machines it needs, and in what number per acre or per bushel hauled |
| **Custom option** | which operations it covers (for example combine, or combine and haul to bin), and its rate per acre or per bushel |

A **provider choice** per operation (own, or a custom option) gives the fleet as the machines
the owned operations still need. Shared machines (tractors, semis) shrink only as far as the
remaining owned work allows. The study then compares fleets: their annualised cost plus the
custom bills, against today's.

Two views of a purchase are shown side by side. For tax a machine is deducted in full in the
year it's bought (§7.1), which makes that year look terrible and the rest look free. So the
comparison uses the **annualised** cost, with the tax view beside it, because the immediate
deduction has real value at the operator's bracket that year (a household-side number, §8).

**This gets its own design**, after phase 2. Phase 1's machinery figure and the custom-rate
basis (§5.3) stay as they are; the fleet model later replaces the single figure with a
computed one.

## 6. What varies (the MC surface)

| Variable | Shape |
|---|---|
| Grain price per crop | futures plus local basis, as a path through the marketing year, so a later sale date sees a different price |
| Forward contracts | the contracted bushels are fixed-price. What varies is the **share of the expected crop contracted**, and the **shortfall** if yield comes in below the contracted bushels |
| Storage cost | per bushel per month held (Q8a) |
| County yield | ARC-County pays on the county's yield, not the farm's (§7.4). Drawn correlated with the farm-wide yield factor |
| National marketing-year price | ARC-County uses the national average price; correlated with the local cash price |
| Yield per crop plan | a farm-wide factor plus a per-field factor; irrigated fields vary less |
| Yield–price link | negative, because a short national crop raises the price; weaker locally than nationally |
| Product prices | per product, plus a per-category multiplier lever (for example "all nitrogen +20%") |
| Rent | per field, plus a farm-wide multiplier |
| Custom-hire rates | per operation, plus a multiplier |
| Machinery figure | per operator, plus a multiplier |
| Irrigation electricity | per field, plus a farm-wide multiplier (a dry year pumps more) |
| Interest rate | on variable-rate land debt |

**A contract shortfall is settled at the market.** If a draw's crop is smaller than the
bushels contracted, the operator delivers what it has and settles the rest at the cash price
on the delivery date (contract price − market price, per bushel short). This is the simplest
rule that keeps the risk visible: a short crop in a high-price year costs money on the
contracted bushels. Any buyout fee in the real contracts is a per-bushel input, zero by
default.

There are two levels of lever, because a sweep of every product price individually is
unreadable. **Category multipliers** answer "what if fertilizer goes up 30%?" in one axis.
**Per-record params** stay available for the detail Q4 asks for.

Distributions and correlations are calibrated from public sources (USDA NASS county yields,
RMA price elections, historical futures). Sources are fetched into `docs/` before any number
is set.

Optimizer levers, for later: crop mix per field, dropping a rented field, seeding rate,
nitrogen rate, insurance coverage level, the share of the crop sold forward, the share of
sales deferred past 31 December, and the size of the December prepay.


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
  other deductible farming expenses are deferred, with exceptions. The owners prepay next
  year's inputs in Nov/Dec (Q11), so this limit is live: the cash report applies it, and it
  caps the prepay lever.
- **Deferring sales moves income between years.** On the cash method a sale is income when
  paid, so a contract or sale paid after 31 December lands in the next year (Reg. §1.61-4,
  cash method). This is the owners' smoothing tool (Q11). It needs no special rule, only the
  payment date (§5.1).
- **Crop insurance and disaster proceeds can be deferred a year.** §451(f) and Reg. §1.451-6
  let a cash-method farmer elect to report them in the following year, if their normal
  practice is to sell the crop then. This is a per-operator option on the cash report
  (Q11b: offered, to show its effect).
- **Machinery is expensed when bought** (Q17). The operators deduct equipment in full in the
  purchase year. Both routes for that are on disk: the §179 election (limits raised by
  P.L. 119-21 §70306) and §168(k) full expensing (made permanent by §70301). So the cash view
  has no depreciation schedule: a purchase is a deduction in its year, inside the operator's
  machinery figure. In phase 1 that figure is one number, so the cash report puts it on one
  line, labelled as mixed (Schedule F lines 14, 19, 21 and 25 in reality). That is exact for
  the net and for SE tax, which is all the household needs. Splitting it by line is optional,
  and needed only for §179's income limit (phase 4). Which route an operator uses only matters at the household level (§179 is
  limited by taxable income; §168(k) is not). That is a phase 4 detail.

### 7.2 Federal tax: what the household side must model

These act on the operator's whole return, not on a field, so they belong to FinSim's US tax
module. **None of them exists in FinSim today:**

| Provision | Effect | Source |
|---|---|---|
| **§199A** QBI deduction | A deduction of up to 20% of qualified business income, so of farm net. Extended by P.L. 119-21 §70105. Selling to a cooperative would change it (`(b)(7)`, `(g)(2)`); the operators don't, so that is out of scope (Q11a). | `sec199A`, Form 8995 instructions |
| **§461(l)** excess business loss | Caps how much farm loss can offset other income in one year. Made permanent by P.L. 119-21 §70601. | `sec461` |
| **§172(b)(1)(B)** farming loss | A farming NOL carries back 2 years. | `sec172` |
| **§1301** income averaging (Schedule J) | Elected farm income is taxed at the 3 prior years' rates. In a good year this can matter a lot. Offered as an option (Q11b). It needs the 3 prior years' taxable income, which the household plan supplies. | `sec1301`, Schedule J instructions |

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
  An irrigated field therefore carries an **allocation cap** in acre-inches per acre (the
  owners supplied it, Q12). Pumping cost is metered per field in dollars (Q19), so the cap
  never prices anything. It could only cap irrigated yield in a drought draw. Phase 1 does
  not model it, and it stays recorded for a later drought study.
- **Beginning-farmer credit.** 77-5211 gives an owner who rents to a certified beginning
  farmer a refundable Nebraska credit. It matters only if a family rental qualifies.

### 7.4 Farm programs

- **The operators use ARC-County on every FSA farm** (Q13). PLC is not modelled; its
  sources stay on disk.
- **ARC-County pays on the county, not the farm.** Actual crop revenue is the **county's
  average yield** times the higher of the **national marketing-year average price** and the
  loan rate (7 U.S.C. §9017(b)(1)). A payment is due when that falls below the guarantee.
  Payments start 1 October after the marketing year ends (§9017(f)). So MC needs a county
  yield and a national price, both correlated with, but not equal to, the farm's own
  draws (§6).
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

One JSON file per farm run, versioned (`farmResultVersion`). Q14: the unit is **a
calendar-year Schedule F per operator**. A season's flows span three calendar years (§5.2),
so the export is built from **dated flows**, and the calendar year is a grouping of them.
A run of one season gives full Schedule Fs only when the neighbouring seasons' flows (last
year's December prepay, this year's deferred sales) are supplied as the carry-in and carry-out (§5.5). For each
**operator** and each **calendar year**:

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
  Schedule F together. Q15: in phase 4 the farm paths are **independent of the household's
  market draws**. The owners want them correlated eventually (for example grain prices with
  inflation, or land values with rates). That needs its own design, because the farm and
  household runs are separate and would have to share a draw.

### 8.4 What this needs that doesn't exist

1. The business-income record, and its path into US tax (ordinary income, the SECA base).
2. §199A, §461(l), the farming-loss carryback and §1301 averaging in the US tax module
   (§7.2). The QBI deduction is the one to build first: it applies to every profitable year.
3. The Nebraska community-college credit, as a refundable credit fed from the record.

## 9. Phases

1. **Deterministic job costing.** `FarmScenario`, the §5.1 records (each category declaring
   its Schedule F line, §7.1), including forward contracts, storage and planned sales (Q8)
   and the operator's real machinery cost (Q5a), `US_FARM_OPERATIONS`, the ledger with grain
   inventory, the carry-in and carry-out (§5.5), the §464(d) prepay limit, and a Field P&L
   panel with breakeven.
   - **First spike:** load a `FarmScenario` with no persons and no accounts through
     `ScenarioLoader` and `ScenarioCompiler`. Both import finance modules (holdings, payroll,
     periods, loans) and assume a household. Find out what breaks before writing farm records.
   - **Tests:** a hand-built small farm, with golden fixtures (the sim is bit-deterministic).
   - **Acceptance:** a private import reproduces the source workbook's per-field totals from
     its **ledger sheets**, not its pivot table, which is stale (§2). The workbook is exported
     to CSV first: FinSim has no runtime dependencies and no xlsx reader. The import script and
     its data stay under `scenarios/`.
2. **Monte Carlo.** It opens with the scenario-agnostic MC runner (§4); the retirement goldens
   must stay byte-identical. Then the §6 variable catalog, correlated yield and price, category levers, and
   results showing the breakeven and loss distributions.
3. **Programs.** Crop insurance (revenue protection) and ARC-County (§7.4).
4. **Household link** (§8): the export, the business-income record, `import-farm.mjs`, then
   §199A and the other §7.2 provisions in the US tax module.
5. **Reconciliation.** The crop-year to cash reconciliation report. Marketing moved into
   phases 1–2 in rev 3. Then a separate design for farm and household correlation (Q15).

## 10. Not in scope

- Livestock, and crops other than corn and soybeans (the data has one alfalfa field; it gets
  a crop plan with no special mechanics).
- Agronomy: yield is an input with a distribution, not the output of a crop model.
- Payroll for hired labor beyond a cost per operation or a lump overhead.
- Crop rotation and multi-season planning (Q9), crop-share and flexible leases (Q7), and
  basis, hedge-to-arrive or minimum-price contracts (Q8b).
- Cooperative patronage (§199A(b)(7), (g)(2); Q11a).
- Entity structures other than a sole proprietor on Schedule F (partnerships, S corporations,
  farm LLCs taxed as partnerships).

## 11. Open questions

None. Every owner question is answered (§3). The fleet model (§5.6) and farm–market
correlation (Q15) each need their own design later.
