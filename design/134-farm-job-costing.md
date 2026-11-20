# 134 — Farm job costing: a row-crop farm as a FinSim scenario

**Status:** rev 19 (20 Nov 2026): phases 5 (the yearly workbook importer) and 6 (in-app record editors) planned (§17); reconciliation moves to phase 7. Rev 18 (19 Nov 2026): **phase 4 COMPLETE** (§16) bar the export's land-and-debt section (Q22a): the export and import (4a–4c), a farm path per household year (4d), §199A (4e), the Nebraska community-college credit (4f), and the NOL, §461(l), the farming-loss carryback and §1301 averaging (4g, §16.10–16.11). Rev 17: phase 4 started, what the years after the export are (§16.1), its steps, and owner questions Q29–Q31. Rev 16: **phase 3 COMPLETE** (§15): revenue protection, ARC-County, the §451(f) election and Schedule F lines 4a–6d, and the programs' Field P&L lines. **phase 1 BUILT** (§12): the acceptance import passes
(§12.4) and the Field P&L panel is in the workbench (§12.5). **Phase 2 started** (§13): step 2a,
the scenario-agnostic MC path and a farm batch on it, steps 2b–2d (realized yield, price paths, multiplier levers and the contracted share), 2e (calibration from USDA NASS, §13.8) and 2f (the Farm MC panel, §13.7) are built: **phase 2 is complete**. Owner questions Q1–Q20 and Q22–Q25 are answered (§3, §14); Q21, Q26 and the follow-ups Q22a,
Q23a and Q25a (§14) are open. §7 records what the primary sources on disk decide. §8 is the household
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
study into an operation-by-operation fleet model with its own design (§5.6). Rev 8 records the phase 1 build: the spike
result, the record and ledger shapes it settled, and a §464(d) exception that §7.1 missed (§12).
Rev 9 records the acceptance import and the questions it raised (§12.4). Rev 10 records the
Field P&L panel (§12.5). Rev 11 splits phase 2 into steps and records step 2a (§13). Rev 12
records steps 2b–2f; the calibration (§13.8) adds an irrigated-only yield shock and skewed
yield draws, both of which the data required. Rev 13 records the owners' answers to Q22–Q25
and the follow-ups they leave (§14). Rev 14 opens phase 3 (§15). Rev 15 records step 3c, ARC-County (§15.3). Rev 16 records 3d and 3e, which complete phase 3 (§15.4). Rev 17 opens phase 4 (§16). Rev 18 completes it. Rev 19 plans phases 5 and 6, getting a farm in (§17).

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
| Q22 | Land debt interest | **Several loans, each secured by particular fields**; some owned fields are free and clear. **Whole-farm profitability is what must be right**, so one averaged rate over the mortgaged fields is acceptable until the loans are itemized (§14). |
| Q23 | Chemical bundles | **Different chemicals are bought for different fields**, so per-field bundle rates are real data, not errors. Whether a bundle holds fertilizer is still open (Q23a, §14). |
| Q24 | Owned fields with no interest | **Free and clear.** No land interest is right. |
| Q25 | A field with no seed cost | **A missing entry.** The report now flags any annual crop plan without seed (§14.1). |
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
  caps the prepay lever. **Rev 8 correction:** the limit does not apply to a *qualified
  farm-related taxpayer* (§464(d)(2)), see §12.3.
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
- **Gap (closed in rev 14, §15.1):** part 457 left the CFR on 1 May 2026, and the policy text
  is now RMA's (Basic Provisions 27.1-BR).

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
5. **The yearly workbook importer** (§17.2). A fixed template the owners fill each year, one
   tab per `cfg.farm` table, and a product importer that turns its CSVs into a farm scenario.
   Loosely designed: the owners are settling the template's columns now.
6. **In-app record editors** (§17.3). Row-list editors for the `cfg.farm` tables, for small
   changes and what-ifs without a trip back to the spreadsheet, and an export back to the
   template.
7. **Reconciliation.** The crop-year to cash reconciliation report. Marketing moved into
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

Q21 (§12.3), Q26 (§13.8), Q22a, Q23a, Q25a (§14), Q27–Q28 (§15.5) and Q29–Q31 (§16.3) are for the owners. The phase 5 template's columns (§17.2) are being settled by the owners. The fleet model (§5.6) and farm–market correlation (Q15) each
need their own design later.

## 12. Phase 1 build notes (rev 8)

### 12.1 The spike

A `FarmScenario` with no persons and no accounts loads through `ScenarioLoader` and
`ScenarioCompiler` unchanged: the compile path runs its toolset, the household derived metrics
evaluate to zero, and a save and reload through the serialized-graph path runs the same
ledger. Three things did need work, none of them a household assumption:

- **The journal drops undeclared fields.** An action's payload is gated by its toolset's
  `types.actions[].fields` manifest (design 91), so every field §5.3 needs on a ledger entry is
  declared on `FARM_LEDGER_POST`.
- **The serializer writes an explicit key list**, so `cfg.farm` is added to it (as `jobs` was).
- Toolsets and scenario classes are registered statically, in `BUILT_IN_TOOLSETS` and
  `SCENARIO_CLASS_BY_ID`.

### 12.2 Shapes the build settled

- **Records** are flat tables in `cfg.farm`, joined by id (`src/finance/farm/farm-records.js`).
  §5.5's list of seasons is `cfg.farm.seasons`, and every row but an operator carries a
  `seasonId`, filled in when there is one season. Phase 1 refuses more than one. A record that
  cannot run is a load error, as jobs are (design 116 §4.6), never a skip.
- **Irrigation electricity** (Q19) is a field of the crop plan, because a crop plan already is
  the (field, crop year) record §5.1 asks for.
- **The ledger is the journal.** One action, `FARM_LEDGER_POST`, carries operator, job, crop
  year, category, Schedule F line, cash flag and allocation basis; the entry's date is the cash
  date. State holds only what a later event reads: grain pools, open receivables and a cash
  net per operator.
- **Grain revenue is two steps.** The sale or delivery date moves bushels and fixes the amount
  as a receivable; the payment date posts the revenue. That is the cash method (§7.1) and the
  deferral tool (Q11) with no special rule, and the receivable is what the crop-year view
  values at 31 December.
- **Pools** are (operator, crop, crop year). A planned sale sells its share of the pool's
  unpriced bushels (harvested less contracted). Revenue and storage are charged to the pool and
  split to crop plans by expected bushels when the report is built. A sale or delivery of this
  season's crop dated before its harvest is a load error, since it would sell nothing.
- **Storage** is charged when grain leaves the pool, on the months held since it entered
  (bushel-weighted when fields are harvested on different days), as a cash cost on that day.
- **Prices** are a dated step table per crop in phase 1. Phase 2 replaces the table with a
  sampled path through the marketing year (§6), without changing the readers.
- **The cash report** marks the years before and after the crop year as partial and does not
  test §464(d) on them: a lone prepay tested against a year with no other expenses would defer
  almost all of it, an artifact of what was simulated.
- **Levers** are generated as `farm.<kind>.<id>.<field>` (`FARM_PARAM_TEMPLATES`), only for
  fields a mechanic reads. A contract has none (Q8b); the share contracted is phase 2's.

### 12.3 §464(d) has an exception the design missed (Q21)

§464(d)(2) exempts a **qualified farm-related taxpayer**: someone whose main home is on a farm,
whose principal business is farming, or who is family of such a person, **and** whose prepaid
farm supplies over the three prior years were under 50% of their other farm expenses (Pub 225
reads the same). The owners very likely pass the first test, so whether the limit bites turns
on their three-year history, which the model can't know.

The build applies the limit unless an operator record says otherwise (`farmRelated`, and the
three prior years' prepaid supplies and other farm expenses), and the report says which case
applied and why. **Q21, for the owners:** for each operator, is farming the principal
business (or is the home on the farm), and what were the three prior years' prepaid supplies
and total other farm expenses?

### 12.4 Acceptance: the workbook's ledger sheets reproduce (rev 9)

The private import (under `scenarios/`, as §9 requires) rebuilds the records from the
workbook's three ledger sheets exported to CSV. It recovers each line's **rule** (acres × rate,
hybrid acres × cost per acre, one price per crop), checks that the rule holds across the sheet,
and writes it as records; the model recomputes every amount. **Every (job, line) total matches
to within a cent**, the sheet's own rounding. The pivot table is not used.

What the import needed from the model: one more overhead basis, **`FIELDS`**, allocating by
planted acres over a named set of the operator's fields. The sheet spreads land debt interest
over the owned fields a loan covers, not over every owned field.

What it found, for the owners (the specifics are in the private study notes):

| # | Question |
|---|---|
| Q22 | Land debt interest is one \$/acre rate spread over owned fields of **all three operators**, which Q10 says never happens. Is it one loan, and whose? The import splits it into one pool per operator over the same fields. |
| Q23 | What is in each **chemical bundle**? A corn bundle large enough to hold fertilizer would belong on Schedule F line 17, not 11. And why does the soybean bundle differ between operators, with one field at about half the rate? |
| Q24 | Two owned fields carry no land interest. Are they unmortgaged? |
| Q25 | One rented field has no seed cost on the sheet. Is the entry missing? |

Two more for the build, not the owners: the sheet books loan **principal** as an expense (the
import drops it, §2), and the **COVID-era payments**' Schedule F line is not settled by any
source on disk. They are on line 4a provisionally, until the IRS guidance is fetched.

The reproduced net is high by design: the sheets carry no machinery, fuel, labor, drying,
trucking or irrigation electricity (§2). Entering those records is what makes the breakeven
real.

### 12.5 The Field P&L panel (rev 10)

The panel (`field-pnl`, opened by the workbench's **Farm** view) calls the same
`jobCostReport` as the CLI and the acceptance test, on the live run's journal, so the three
cannot disagree. Rows open operator (or crop) ▸ field ▸ lines, and each line names its
Schedule F line. A switch picks custom-rate or actual machinery; the other figure stays on
the field as a memo.

Decided in the build:

- **The answer columns come first.** Net, net per acre and the four breakevens sit left of
  the direct / overhead / machinery split, which is hidden behind a toggle. With all
  fifteen columns, the breakevens fell off the right of a normal pane.
- **Red only.** A breakeven above the expected price or yield is red. Green on every healthy
  field was noise.
- **"Season complete" is the last farm event, not `simEnd`.** The workbench's clock stops at
  the last scheduled event, which is the season's last grain payment. A finished run read
  "to date" until this was keyed to the compiled events.
- **Mid-run it is the season to date**, with a warning that the breakevens are low until the
  grain is sold.

The household panels open on a farm without errors; a household plan's Field P&L says it has
no farm records.

## 13. Phase 2 build notes (rev 11)

### 13.1 Steps

Phase 2 is six steps. Each one ships on its own, and none changes a retirement run.

| Step | Scope | State |
|---|---|---|
| **2a** | The scenario-agnostic MC path (§4), and a farm batch on it: the farm records' levers as the catalog, per-path metrics, the loss and breakeven distributions, `npm run farm:mc` | **built** (§13.2) |
| 2b | **Realized yield**, separate from expected yield (§13.3): a farm-wide factor times a per-field factor, narrower on irrigated fields | **built** (§13.4) |
| 2c | **Price paths** per crop through the marketing year, drawn against the farm yield factor (the yield–price link, §6), replacing the step table on a path | **built** (§13.5) |
| 2d | **Multiplier levers** (product category, rent, custom rates, machinery, irrigation) and the contracted share per crop (Q18) | **built** (§13.6) |
| 2e | **Calibration.** NASS county yields, RMA price elections and futures history fetched into `docs/`, then the 2b–2d distributions set from them (§6) | **built** (§13.8) |
| 2f | **A farm MC results panel** (§4: the farm gets its own, rather than bending the retirement one) | **built** (§13.7) |

2e gates the numbers in 2b–2d, not their mechanics: each mechanism can be built and tested
with its spread at zero, which reproduces the deterministic run exactly. No default spread is
set before its source is on disk.

### 13.2 Step 2a: the scenario-agnostic MC path

§4 named three things a scenario descriptor supplies. The build split them by **thread**,
because a context crosses `postMessage` and a class reference cannot:

- **Worker side**: `MC_SCENARIOS` in `mc-worker-core.js`, keyed by `scenarioId()` and named on
  the context as `scenarioKind`. An entry builds the scenario node, writes the scenario's own
  process switches into a path's params (the retirement return paths; the identity for a
  farm), picks the telemetry level and sampler, and extracts the path's result. A context
  with no kind is a retirement one, so every existing caller is unchanged. An unknown kind
  throws rather than running a retirement.
- **Main thread**: `McRunner` (`mc-runner.js`) is the batch: index-seeded paths, serial or on
  the pool, and paths that threw split out loudly. A scenario's runner subclasses it with its
  own `_prepare` (template, base params, variables) and its own aggregation.
  `McConfig` (`mc-config.js`) is a catalog's shared half (contributors, the schema harvest,
  centres, provenance), and a catalog sets its contributors, schema and aliases.

**The retirement runs did not move.** A fingerprint of an MC batch, its summary, its variable
list and a grid run taken before the split matches after it byte for byte, and the MC test
files pass unchanged.

**The farm batch** (`src/finance/farm/farm-mc.js`):

- **The catalog** is the records' `mc`-flagged levers, harvested and centred on their records
  (design 98 W3). Every row starts **off**, at the harvest's generic spread (±10% on an amount,
  ±20% on a rate). Those spreads are placeholders, so the batch's provenance lists every
  sampled row that uses one as `uncalibrated`, and the CLI says to read the run as a
  sensitivity run.
- **A path is built at telemetry `journal`**, because the ledger is the journal (§12.2).
- **A path's result is a flat map** of metric key to number: net, net per acre, revenue and
  the three breakevens for the farm, each operator, crop and crop plan, under **both**
  machinery bases, plus each operator's crop-year Schedule F net after §464(d). The batch
  reports p10, p50, p90, mean, min and max of each, and the probability of a loss for each net.
- With nothing sampled, every path is the deterministic run to the cent. A sampled lever
  reaches the loaded records, a path replays from its params through
  `applyParamBagToConfig` alone, and a pool run is bit-identical to a serial one (tests).

The grid runner, the optimizer and the MC panel stay retirement-only, as §4 planned.

### 13.3 What 2a shows is missing

Two levers the harvest offers are **not the §6 variables they look like**, so a run that
samples them answers a narrower question than it appears to:

- **`expectedYield` moves the plan, not only the harvest.** It is the yield the crop is
  planned on, so sampling it moves the breakevens and the allocation of pool revenue along
  with the bushels harvested. In §5.4 the breakevens are the plan's numbers, and a short crop
  should change what is earned, not the breakeven it is measured against. Step 2b adds a
  realized yield (expected × a drawn factor) for the harvest and leaves `expectedYield` as
  the plan.
- **A price row is drawn on its own.** Sampling `farm.price.<id>.price` moves each dated price
  independently, so a harvest price and a winter price for one crop can move in opposite
  directions on the same path. That is a sensitivity on each row, not a price path. Step 2c
  replaces it.

Until then the two are useful for "what if this one number were different", and that is all.

### 13.4 Step 2b: realized yield

A crop plan now harvests its **realized** yield, per planted acre:

    expectedYield × max(0, 1 + β·(season yield shock) + (plan yield shock))

The **season shock** is the farm-wide factor every field shares. The **plan shock** is the
field's own. **β** is a season field, `irrigatedYieldBeta`, and applies to irrigated fields
only: it is how much of the farm-wide shock an irrigated field takes (a dry year hurts a
pivot less). Dry fields take all of it. The floor at zero keeps a large draw from harvesting
negative bushels.

Decided in the build:

- **The shocks are record fields, not scenario params.** `farm.season.<id>.yieldShock` and
  `farm.plan.<id>.yieldShock` ride the same record-lever cascade as every other farm lever, so
  a path's params replay through `applyParamBagToConfig` like any other. A blank shock is 0
  (a template's new `blankValue`), so a lever on one still has a centre to sample around.
- **`expectedYield` is no longer an MC row.** It is the plan. The breakevens divide by its
  bushels, and the contracted share is measured against it.
- **The cost side of a breakeven is what the season spent.** A short crop holds fewer
  bushels, so its storage and its total cost fall, and the breakevens move with them. That is
  correct: only the yield side is the plan.
- **A grain pool's revenue and storage follow the bushels each plan harvested**, not its
  expected bushels. A short field earns a smaller share of its pool. In a deterministic season
  the two are equal, so the `farm-demo` golden did not move.
- **The spreads are the catalog's, not the harvest's.** `FarmMcConfig` contributes one row
  per shock at `FARM_MC_SPREADS`, which are **0 until step 2e**. A row switched on at zero
  spread draws nothing, and the path is the plan. Contributors now receive the scenario cfg as
  well as the params, because the farm's rows come from its records.
- **β is 1 until calibrated**, which assumes nothing: irrigated fields take the whole shock,
  like dry ones. (Rev 12: calibrated to 0.05, with an irrigated-only shock beside it, §13.8.)

Still open for 2e: the shape of the yield distribution. Yields are skewed to the left (a
drought year is far below trend, and a great year is only somewhat above it), so a normal
shock is a placeholder for whatever the county history supports. (Rev 12: skew-normal, §13.8.)

### 13.5 Step 2c: price paths

Each crop's price table stays as written, and is now the **expected** path. A season runs a
**realized** path beside it: a log random walk through the table's dates, from the plan date
(1 January of the crop year):

    L_i = L_(i−1) + σ·√Δt_i·z_i − ½σ²·Δt_i − b·Δy_i
    realized_i = price_i · exp(L_i)

- **σ** is the crop's annual price volatility, a season field (`priceVol`, per crop). **z_i**
  is the row's standard-normal `shock`, a record lever. Because z is standard by definition,
  its MC row has sd 1, and the calibration is σ, which is 0 until 2e.
- **The −½σ²Δt drift** keeps each realized price's mean at the table's price, so the table
  keeps meaning "what we expect".
- **b** is the **yield–price link** (`priceYieldBeta`, per crop): the log price move per unit of
  farm-wide yield shock. It is taken once, on the row **in force on the crop's harvest date**,
  and later rows carry it. A positive b makes a short crop dearer. It is a regression
  coefficient rather than a correlation, because it can be read straight off history (log
  price change on yield deviation) and needs no standardisation inside the model.
- **A row dated on or before the plan date never moves.** It is already known.

What reads which path:

| Reader | Path |
|---|---|
| A planned sale's price, a contract shortfall's market price (§6) | realized |
| Grain still in the bin at the end of the run | realized |
| The expected price behind the breakevens (§5.4) | expected |

Decided in the build:

- **The link is on the row in force at harvest, not the first row after it.** The first test
  used "first row after harvest", which in the demo is the January row, so the price harvest
  sales are paid at never saw the size of the crop.
- **`farm.price.<id>.price` is no longer an MC row.** Drawing rows on their own is the defect
  §13.3 named.
- **Old and new crop share one table per crop.** A carry-in sale in February is priced on
  the same path. A separate old-crop path would need its own table, and none of the data asks
  for one yet.

A contract shortfall already settled at the market price (§6, phase 1). It now settles at the
realized market price, so a short crop in a dear year costs money on the contracted
bushels, which is the risk §6 wanted visible. A test pins that case.

### 13.6 Step 2d: multipliers and the contracted share

**Multipliers** are season fields, 1 when blank, each scaling one cost family as it is posted:

| Lever | Scales |
|---|---|
| `rentMultiplier` | cash rent on every rented field |
| `customRateMultiplier` | every operation's custom-hire rate (job-cost view only) |
| `machineryMultiplier` | every operator's real machinery figure |
| `irrigationMultiplier` | every plan's irrigation electricity (a dry year pumps more, §6) |
| `interestMultiplier` | interest on overhead rows marked `variableRate` |
| `<category>Multiplier` | the price of every product in one category (`nitrogenMultiplier`, …) |

Decided in the build:

- **A lever exists only where it can move something.** A category multiplier is generated
  only for a category the farm buys, and the interest multiplier only when an overhead row is
  `variableRate`. That is the dead-axis rule the record templates already follow.
- **The interest lever stands in for the rate.** §6 names "the interest rate on variable-rate
  land debt", and the farm has no loan records, only an interest amount per operator. A
  multiplier on a `variableRate` row is that rate's move, as a ratio. A fixed-rate row never
  moves. `variableRate` on a non-interest row is a load error.
- **The carry-out prepay is not multiplied.** Its amount is the operator's decision about how
  much to prepay (§5.5), not a price.
- **Per-record levers stay.** A multiplier and a product's own `unitPrice` compose, so
  "nitrogen +20%" and "this one product's price" are both still available (§6's two levels).

**The contracted share** (Q18) is a contract field, `shareOfExpected`. When it is set, the
contract's bushels are that share of the operator's **expected** crop of that grain, fixed at
plan time. A short crop is then a shortfall, settled at the realized market price (§13.5).
It sizes only this season's crop; a share on a carry-in contract is a load error, because a
past crop has no expected yield here. Q18's per-crop default goes on the owners' contracts,
in the private scenario, and is not recorded here.

All of these levers' MC rows are the catalog's: centred on the record, off, and at
`FARM_MC_SPREADS`, which are 0 until 2e.

### 13.7 Step 2f: the Farm MC panel

`farm-mc-plugin.js`, a tab in the Farm view beside the Field P&L. It runs `FarmMcRunner` on
the active scenario, on the worker pool where the browser has one; the pool and a serial run
are bit-identical (§13.2).

- **Variables** is a typed table, one row per catalog variable: a switch and a spread (§9's
  "category levers" are rows here). A price shock's row has no spread field. It is a unit
  draw, and its scale is the season's price volatility (§13.5), so a typed number there would
  silently rescale the vol.
- **Results** has the whole farm first, then each operator with its crop plans, then each
  crop. Each row shows P(loss), the net at p10, p50 and p90, and the breakevens' p10–p90. An
  operator row adds its cash Schedule F net and that net's loss probability, after §464(d).
  The machinery switch is the Field P&L's. The CSV carries every metric's distribution.
- **It says what a batch is.** It warns when nothing is sampled, and when a sampled row has a
  spread of 0. It also warns when a spread is typed rather than calibrated: those results are
  a sensitivity run. When a sampled crop's price vol comes from the calibration, it says so.

Checked in the browser on the demo farm (50 paths, worker pool, no console errors). One
finding there is economics, not a bug. An operator whose crop is mostly sold in the next tax
year can lose money on its cash Schedule F in **every** path, while its job-cost net is
positive. That gap between the cash view and the job-cost view is what the column exists
to show.

### 13.8 Step 2e: calibration

**Source.** USDA NASS Quick Stats, via the crops bulk file of 19 Nov 2026, filtered to
Nebraska. It gives county yields by practice (irrigated and non-irrigated, 1947–2018, the
years NASS published the split) and the state's monthly prices received.
`docs/us-farm-markets/` holds the extract, the filter that reproduces it byte for byte, and
`SOURCES.md`. `npm run farm:calibrate` derives every figure, by county or as the
distribution across counties. `tests/unit/farm-calibration.test.mjs` re-derives the shipped
constants (`FARM_CALIBRATION`) from the file on disk, so a constant cannot drift from its
source.

**Method.** Each county's yield is divided by its own linear trend, minus 1: the same ratio
the yield shocks are. The figures are medians across Nebraska counties, from 1995, for
modern genetics: irrigated variance is clearly lower after 1995 than over 1980 on. Prices
use ln(October ÷ January), annualized over nine months.

| Figure | Corn | Soybeans | Shipped as |
|---|---|---|---|
| Dryland yield sd | 0.295 | 0.219 | `yieldShockSd` 0.30 |
| Dryland skewness | −0.78 | −0.72 | `yieldShockSkew` −0.78 |
| Irrigated yield sd | 0.070 | 0.058 | — |
| Irrigated slope on dryland (β) | 0.05 | 0.12 | `irrigatedYieldBeta` 0.05 |
| Irrigated residual sd | 0.065 | 0.049 | `irrigatedYieldShockSd` 0.065 |
| Irrigated residual skewness | −0.22 | −0.31 | `irrigatedYieldShockSkew` −0.22 |
| Soybean ÷ corn sd, dryland / irrigated | | 0.74 / 0.75 | `yieldShockScale.SOYBEANS` 0.74 |
| Price vol, Jan→Oct, annualized | 0.18 | 0.17 | `priceVol` |
| Price–yield link b, on the dryland deviation | 0.19 | 0.24 | `priceYieldBeta` |

The RMA's 2026 crop-insurance volatility factors are corn 0.15 and soybeans 0.13: implied
vols of the harvest futures, near their 15-year lows (the farmdoc article in `docs/`). Cash
prices also move with the basis, so the history's higher figures are expected.

**What the data changed in the model:**

- **An irrigated-only shock.** Irrigated yields barely follow the dryland shock (β 0.05; the
  correlation is 0.23). They do move together, though: irrigated corn and irrigated soybeans
  correlate at 0.55 (county medians, 1995 on). With only the 2b shocks, that common part could go only into each
  field's own shock, which would treat a farm's pivots as independent and understate its
  risk. The season gains `irrigatedYieldShock`, common to every irrigated field. An
  irrigated field harvests `1 + k·(β·Y + I)`, and a dry one `1 + k·Y`.
- **A per-crop scale, k.** Dryland corn and soybean shocks correlate at 0.89, so one
  farm-wide shock is right, but soybeans swing less. `yieldShockScale` is the ratio of the
  soybean sd to the corn sd, and it is the same for both practices (0.74 and 0.75), so one
  scale serves both terms. The price link reads the crop's own shock, `b·k·Y`, which is
  what the calibration regressed on.
- **Skewed draws.** Dryland deviations are left-skewed in three counties out of four. Below
  2 sd they occur 3.7–4.5% of the time, and above 2 sd only 0.3–0.5%. A normal shock puts
  2.3% in each tail, so it would understate droughts and invent bumper crops, and the loss
  probability is the output the owners read. The two season shocks are drawn skew-normal
  (`DISTRIBUTION_TYPES.SKEW_NORMAL`, new, mean/sd/skew parameterized). At −0.78 its tails
  are 4.1% and 0.3%.

**Defaults, and why the vol is not one.** β, k and b default to the calibration on a season
that leaves them blank. Each one is a no-op while the shocks are 0, so a deterministic
season, and the `farm-demo` golden, do not move. The price vol cannot default the same way:
its mean correction (−½σ²t, §13.5) moves a price even at a zero shock. So it stays blank on
the record, and `FarmMcRunner` fills the calibrated vol for each crop whose price shocks a
batch samples. It records the vols it filled in `summary.provenance.priceVolFilled`, and a
path replays as `applyParamBagToConfig(withPriceVol(cfg, priceVolFilled), params)`.

**Still uncalibrated, and why:**

- **A field's own yield shock** (spread 0). County history is smoother than one farm's, and
  one field's is noisier still. It needs the farm's own yield history. **Q26 (owners):** can
  you share each field's yearly yields, the APH records the crop insurance uses? Ten years
  of per-field yields would set the field-level spread.
- **The cost multipliers and the contracted share** (spread 0). They are levers to sweep,
  not uncertainties with a published spread.
- **A farm's county.** The shipped figures are Nebraska's county median. A plan that knows
  its county can read that county's own figures (`--county`) and set them on its season.
  The private scenario does that, and the design does not.

## 14. Owner answers to Q22–Q25 (rev 13)

None of the four needs a new mechanic. Q22 and Q24 confirm that what the import does is
the model the owners want. Q23 and Q25 confirm that two things the sheet shows are real: the
chemical rates differ by field, and one seed entry is missing.

**Q22: several loans, but whole-farm profitability is what matters.** Each loan is secured by
particular fields, and the sheet spreads one averaged \$/acre rate over all of them. The model
already has one row per loan: a `FIELDS` overhead row over the loan's own fields (§12.4). The
import cannot build per-loan rows from one averaged rate, so it keeps one pool per operator at
that rate. The **whole-farm interest is exact**, and so is each operator's total if each
operator pays for its own fields. A field's interest is the average, so a field's net is
off by the gap between its own loan's rate and the average. Both panels and the CLI already
show the whole farm. The loan details would matter for three later things: per-field
accuracy, the `interestMultiplier` (it moves only rows marked `variableRate`, so it cannot
tell a fixed loan from a variable one yet), and the cash side, where the interest belongs on
the Schedule F of **whoever pays it**. **Q22a (owners), needed by phase 4, not before:** for
each loan, which fields secure it, its annual interest (or balance and rate), fixed or
variable, and which operator pays it.

A loan secured by fields of **more than one** operator would be refused today (Q10: overhead
is never shared). Nothing says such a loan exists, so the rule stays until Q22a shows one.
If one does, the loan becomes its own record: the job cost follows the fields, and the cash
follows the payer.

**Q23: different chemicals for different fields.** The three soybean rates are three
different purchases, so the import keeps three products. **Q23a (owners):** does the corn
bundle include fertilizer (nitrogen, P&K)? It matters for more than the Schedule F line (11
or 17). The fertilizer multipliers exist only where the farm has the category (§13.6), so
**until the bundle is split, the imported farm has no nitrogen price lever at all**. Fertilizer
price is one of the swings MC was built to sweep.

**Q24: free and clear.** No interest on those fields is right.

**Q25: a missing seed entry.** The import keeps the sheet as it is, so the acceptance still
compares like with like, and the report now flags the gap (§14.1). **Q25a (owners):** the
field's hybrid, seeded acres and cost, so it can be entered.

### 14.1 Record advisories

`farmAdvisories(farm)` lists records that load and run but are probably incomplete. They are
advisories, not errors, because the season still costs. `jobCostReport` returns them as
`advisories`, and the Field P&L panel and `npm run farm:report` print them with the
unallocated-cost warnings. One check so far:

- **`NO_SEED`:** a crop plan for an annual crop with no seed cost (no seed line, or a line
  costing 0). Every annual crop is planted from seed bought for it, so the plan's costs and
  breakevens are understated. A perennial crop (alfalfa, `CROPS.ALFALFA.perennial`) is
  exempt, because an established stand is not reseeded each year.

On the acceptance farm, it fires on the one field Q25 is about and nowhere else. The demo
farm has none.

## 15. Phase 3: programs (rev 14)

Phase 3 adds the two programs §7.4 names: revenue protection crop insurance and
ARC-County. Both pay on the joint draw of yield and price, which is why they wait for phase
2's MC.

### 15.1 What the sources settled first

§7.4 left two gaps. Both are closed, and the files are in `docs/us-farm-programs/`
(`SOURCES.md` there):

- **Part 457 left the CFR.** A final rule of 1 April 2026 (91 FR 16151, effective 1 May 2026)
  removed and reserved 7 CFR part 457: crop policies are contracts, so they no longer need to
  be codified, and the policy text is published by RMA. The current **Basic Provisions are
  27.1-BR** (released June 2026, effective for the 2027 crop year for crops whose contract
  change date is after 30 June 2026). The **Coarse Grains Crop Provisions are still 25-0041**,
  and RMA posts no newer document. Its text is the 1 January 2026 annual CFR edition already
  on disk, which was codified before the removal.
- **Price discovery (CEPP).** For Nebraska, the projected price is the February average of
  the December corn and November soybean futures, and the harvest price is the October
  average (CEPP Section II, 24-CEPP-0041 and -0081; Section I is 27-CEPP).
- **ARC-County after P.L. 119-21.** The guarantee is 90% of benchmark revenue and the payment
  is capped at 12% of it, for crop years 2025–2031 (§10305). The loan rates for 2026–2031 are
  \$2.42 (corn) and \$6.82 (soybeans) (§10309). The reference prices are \$4.10 and \$10.00,
  the effective reference price factor is 88% (§10301), and the payment limit is \$155,000,
  indexed to CPI from 2025 (§10307). Payment acres are 85% of base acres (7 U.S.C. §9014).
  Where a county has separate irrigated and non-irrigated yields, FSA weights the farm's
  benchmark, guarantee and actual revenue by the farm's **historical irrigated percentage**
  (7 CFR §1412.53(a)(3) and (c); the definition is in §1412.3).
- **FSA's county file reproduces from the statute.** The 2025 ARC-CO data (as of
  2 November 2026) gives, per county, crop and practice, the benchmark yield and price, the
  guarantee, the cap, the actual yield, the national price and the payment rate. In the rows
  checked, guarantee = 90% × benchmark, cap = 12% × benchmark and rate = min(guarantee −
  actual, cap) hold to the cent. That makes the published file an acceptance test for step
  3c, as the NASS file is for the calibration.
- **For 2025, the law pays the higher of PLC and ARC-CO** per commodity (§10303(a)(3)). The
  model has no PLC (Q13), so a 2025 season understates program payments wherever PLC would
  have paid more.

### 15.2 Step 3b: revenue protection (built)

**Records.** An `insurance` row per operator and crop: `plan` (`RP`, `RP_HPE`, `YP`),
`coverageLevel` (0.5–0.85), `unit` and an optional `paymentDate`. The season gains
`projectedPrice` per crop. A crop plan gains `aphYield`, the approved yield, which defaults
to its expected yield, and an insured plan without one is an advisory (`APH_DEFAULTED`).
The premium stays on the crop plan, as the farmer-paid amount from the agent's quote:
premium rates and subsidies are a rating question the model doesn't need to answer.

**Settlement** (`settleInsurance`, `src/finance/farm/farm-programs.js`) follows Coarse Grains
§12(b). Per field, the guarantee is acres × approved yield × coverage × the guarantee price,
and the value to count is the harvested bushels × the value price. RP values the guarantee
at the higher of the projected and harvest prices; the harvest price exclusion values it at
the projected price only; yield protection values both at the projected price. A unit pays
max(0, guarantee − value) summed over its fields. The test reproduces the provisions' own
worked example to the cent (\$3,912.50 RP, \$3,562.50 YP).

**Units.** `ENTERPRISE` (all of the operator's acres of the crop), `ENTERPRISE_BY_PRACTICE`
(irrigated and dry apart) and `FIELD` (each field its own unit). The unit decides whether a
good field covers a bad one, so it changes how often a claim pays. One county is assumed.

**The harvest price comes from the season's own price path.** The path is local cash, not
futures, so the harvest price is the projected price × the path's realized ÷ expected ratio
on the row in force on 31 October. Only the random part moves it, because a futures price's
expected change is zero, and the basis is held constant in ratio. A deterministic season's
harvest price is its projected price. The price–yield link (§13.5) is in that ratio, so a
farm-wide short crop raises the harvest price. That is exactly the case where revenue
protection's harvest-price guarantee matters.

**Postings.** The indemnity is settled at compile time, as the harvest is, and posts as
`CROP_INSURANCE_PROCEEDS` (Schedule F line 6a) on the payment date (15 December by default).
It is charged to the unit's crop plans in proportion to each field's own shortfall, so it
lands on the fields that lost. It is non-grain revenue, so it enters the breakevens (§5.4).
Moisture, quality, appraisals and prevented planting are not modelled.

**MC.** Each path reports `<scope>.insurance` and `<scope>.insurancePays` (1 when a claim
pays, so its mean is the claim probability), and the Farm MC panel shows both. On the demo
farm, with every calibrated variable sampled, a claim pays in about 29% of paths. Each
operator's and crop's own figure is 15–24%. `coverageLevel` is an optimizer lever.

**The tax year of an indemnity** is step 3d's (§15.4).

### 15.3 Step 3c: ARC-County (built)

**Records.** Two flat tables. `arcBase` has one row per FSA farm and crop enrolled: operator,
`fsaFarm`, crop, `baseAcres`, `county` and the farm's historical `irrigatedPct`. `arcCounties`
has one row per county, crop and practice (`IRRIGATED`, `NONIRRIGATED` or `ALL`): the
`benchmarkYield` and `benchmarkPrice` FSA publishes, and an optional `expectedYield` for the
season, which defaults to the benchmark. The season gains `nationalPrice`, the expected
marketing-year average (MYA) per crop. A field's `fsaFarm` places it on a farm. `npm run
farm:arc -- --county NAME` prints a county's rows from FSA's file, with `--json` for rows to
paste.

**The formula is the statute, rounded as FSA rounds.** Benchmark revenue = benchmark yield ×
benchmark price, the guarantee is 90% of it, the cap is 12%, and actual revenue = the county
yield × the higher of the MYA and the loan rate (`arcCountyRate`). With each stage rounded to
the cent, **all 339 Nebraska corn and soybean rows of FSA's 2025 file reproduce exactly**:
benchmark revenue, guarantee, cap, actual revenue and payment rate. Without the rounding they
differ by up to 1.2 cents. The benchmark price is rebuilt too (`arcBenchmarkPrice`). It is the
Olympic average of the MYAs for the five crop years ending two before the program year, each
floored at the effective reference price, which comes from the same five MYAs (§9011(8), the
88% factor from 2025). From NASS's national prices on disk, it gives FSA's \$5.03 (corn) and
\$12.17 (soybeans) for both 2025 and 2026. The terms before 2025 (86%, 10%, 85%) and the loan
rates by year are tables in `farm-programs.js`. The model refuses a season outside 2019–2031.

**A farm's rate is weighted by its irrigated percentage.** Where the county has separate
practices, FSA weights the farm's benchmark revenue, guarantee and actual revenue by its
historical irrigated percentage, and the rate comes from the weighted figures (7 CFR
§1412.53(a)(3), (c)). The payment is rate × 85% × base acres. A blank irrigated percentage
uses this season's irrigated share of the farm's planted acres of the crop, and the
advisories flag it.

**What a season draws.** The county's actual yield is its expected yield moved by the
season's **common** yield shocks: k·Y for dryland, k·(β·Y + I) for irrigated, and a blend
by the irrigated percentage for `ALL`. Those shocks are county-level by construction, since
§13.8 calibrated them on NASS county deviations. A field's own shock never reaches the
county, which is the basis risk ARC carries: a field can fail while the county does not. The
MYA is the expected MYA × the mean of the local path's realized ÷ expected ratio on the 15th
of each month from September to August. As with the harvest price, the local path stands in
for the national one, so the price–yield link makes a short crop dearer and ARC pay less.
A deterministic season pays on its expected figures, and with today's prices below the
benchmark, it often pays: the demo farm's FSA farms are paid \$31–73 per payment acre.

**Postings.** One `PROGRAM_PAYMENT` (Schedule F line 4a) per enrollment, on 1 October after
the crop year (§9017(f)), so in the crop-year view and in the next calendar year's cash. It is
paid on base acres, not on what is planted, so it is split by planted acres over the
operator's plans **of that crop** on the FSA farm's fields. Keeping the crop stops a corn
payment landing in a soybean field's P&L, which the first build did. With none of the crop
planted there, it is split over all of the farm's plans; with no field on the farm, over the
operator's acres.

**Not applied, and reported instead:** the \$155,000 payment limit (it is per person, and an
operator may be a married couple; `ARC_OVER_LIMIT`), sequestration (an OMB order, not on
disk), and the 2025 higher-of-PLC-and-ARC rule (`ARC_2025_HIGHER_OF`).

**MC.** `<scope>.arc` and `<scope>.arcPays`, as for insurance, and a Farm MC column. Each
path also reports `<scope>.grainRevenue`, because total revenue now includes program
payments, which rise in a short year. A step 2b test that checks grain against yield read
total revenue and failed once ARC paid in droughts. It now reads grain revenue.

**The demo farm** enrolls its three FSA farms in a placeholder county shaped like FSA's
file, which moves the `farm-demo` golden by exactly those payments (operator A +\$9,181.51,
operator B +\$8,329.70).

### 15.4 Steps 3d and 3e: tax timing and the Field P&L (built)

**Schedule F lines 4a–6d.** Line 9 adds the taxable lines, not the received ones (Schedule F
2025 and its instructions, on disk). Lines 4a and 6a are what was received, shown but not
added (`memo` in `SCHEDULE_F_LINES`). 4b is the taxable program payment, all of it for ARC.
6b is the taxable insurance, 6a less any deferral, and 6d brings in last year's deferral.
Before 3d the cash report added 6a straight into gross income, which was right only while
nothing was deferred.

**The §451(f) election** (Reg. §1.451-6, on disk) is an operator field, `defer451f`, as Q11b
asked. A cash-method farmer may report crop insurance proceeds in the year after the damage
if, under its normal business practice, the crop's income would have been reported then. One
election covers all of one business's proceeds (§1.451-6(a)(2)), which is one operator here.
The model can see one test of normal practice: some of the operator's grain from the crop
year is paid after 31 December. Elected without it, nothing is deferred and the cash row's
`section451f.reason` says why. Proceeds received in the next year need no election, since
they are that year's income by receipt. The damage year is taken as the crop year.
`npm run farm:report` prints the election's outcome under each Schedule F.

**The Field P&L** shows each kind of non-grain revenue as its own line, with its Schedule F
line: the crop insurance indemnity (6a, charged to the fields that lost) and ARC-County (4a,
noted as paid on base acres the October after harvest). Before 3e they were one "Other income"
lump. The job-cost row carries the split as `revenue.otherByCategory`, and the lines still sum
to the row's revenue.

### 15.5 Questions for the owners (Q27, Q28)

**Q27 (crop insurance):** for each operator and crop, the plan (RP, RP with the harvest price
exclusion, or YP), the coverage level, the unit structure, each unit's approved (APH) yield,
and the premium per acre. The source workbook shows a premium for one operator only: do the
other two insure? Q26's per-field yield history is the same APH record.

**Q28 (ARC-County):** for each FSA farm number, its county, its base acres by crop and its
historical irrigated percentage (both are on the FSA-156EZ), and the 2026 election.

## 16. Phase 4: the household link (rev 17)

### 16.1 What the years after the export are (decided)

The export covers one season: a full Schedule F for the crop year *Y*, and partial years
*Y − 1* and *Y + 1* (§5.5). A household plan runs for decades. **The business-income record
repeats year *Y* every year from its start until an end date the person sets** (retiring
from farming, for instance), indexed to the household's inflation. Year *Y* is the right year
to repeat because it is the only full one: it already holds last season's carry-in and next
season's prepay, so repeating it assumes each season's carry-out equals the next one's
carry-in. The partial years stay in the export for reading but are not imported.

Under household MC, **each household year draws its own farm path** from the export, on its
own keyed RNG stream (design 107 §15.5). Seasons are then independent of one another, and of
the household's market draws (Q15). A deterministic household run uses the export's
deterministic run.

Two other shapes were rejected. Importing only the exported years would drop the farm's
spread after year *Y* in a long plan. Repeating one drawn path in every year of a run would
make every season of a run equally good or bad, which overstates the risk.

### 16.2 Steps

| Step | What | Section |
|---|---|---|
| 4a | The farm export: per operator and calendar year, the Schedule F lines and the household inputs; under MC, every path with its seed | §8.2 |
| 4b | The business-income record on a person, into US tax (ordinary income, the SECA base) and Nebraska tax | §8.3 |
| 4c | `import-farm.mjs`, on the `import-quicken.mjs` pattern | §8.3 |
| 4d | Household MC draws a farm path per year | §8.3, §16.1 |
| 4e | §199A, with P.L. 119-21's minimum deduction. The 2026 thresholds are in Rev. Proc. 2025-32, which is fetched first | §7.2 |
| 4f | The Nebraska community-college credit (77-6706(4)) | §7.3 |
| 4g | §461(l), the §172(b)(1)(B) farming-loss carryback, and §1301 averaging as an option | §7.2 |

The export's optional owned-land-and-debt section (§8.2) waits for Q22a.

### 16.3 Questions for the owners (Q29–Q31)

None of these blocks a step. Each has a default the build uses until it is answered.

**Q29 (community-college tax):** for each owned field, the community-college share of its
property tax bill. 77-6702(1) counts the community-college area's levy, excluding bonded debt
and voter-approved overrides. Until it is entered, the credit is 0.

**Q30 (§199A above the threshold):** for each operator, the W-2 wages paid (hired labor) and
the unadjusted basis of qualified property (machinery). Above the §199A threshold, the
deduction is limited by these figures. Until they are entered they are 0, which gives the
smaller deduction, and only a household above the threshold is affected.

**Q31 (§1301):** for each operator's household, the taxable income of the three prior years.
This is needed only if income averaging is elected.

### 16.4 Step 4a: the farm export (built)

`src/finance/farm/farm-export.js` builds the document and `npm run farm:export` writes it
(`--n N --enable <keys>` adds MC paths; without `--out` it is a dry run). For each operator
and calendar year a row carries the Schedule F income and expense lines, which of them are
memo lines (4a, 6a), the gross, the expenses, the §464(d) deferral and the net. The row's
`household` block carries what the operator's return needs:

- **Schedule SE line 1a** is the Schedule F net (SE instructions 2026). The 92.35% factor
  and the wage-base coordination stay on the household side, because they depend on its wages.
- **QBI before adjustments** is also the net. The Form 8995 instructions reduce QBI by the
  deductible part of SE tax, the SE health insurance deduction and retirement contributions,
  and all three are figured on the household return (step 4e).
- **The community-college tax paid.** A field's new `communityCollegeTax` (Q29) is part of its
  `propertyTax` bill, and a larger value is a load error. It is spread over that field's
  property tax payments in proportion, so it lands in the year paid, as 77-6706(4) credits it.

Under MC, the farm descriptor's per-path result now carries the path's export rows beside its
metrics. A path keeps only its **sampled** params, which replay it with the farm scenario.
Otherwise every lever's centre would be repeated in every path, and a 1,000-path file would
grow from about 6 MB to about 10 MB.

### 16.5 Step 4b: the business-income record (built)

`cfg.businessIncome` holds flat rows joined to a person by `personId`
(`src/finance/payroll/business-income.js`): `kind: 'SCHEDULE_F'`, `startDate`, an optional
`endDate`, `paymentDay` (MM-DD, default 15 December), the signed `net`, and
`neCommunityCollegeTax`. A row that cannot run is a load error, as a job is. Deleting the
person removes the person's rows.

`US_INCOME` schedules one `BUSINESS_INCOME` event a year. Its handler indexes the row by US
CPI **from the row's first payment**: the export's figures are crop-year dollars, so a plan
that starts before the crop year must not inflate them a second time. The reducer credits
the US cash pool, so a loss debits it and the household funds the farm. It records the CPI
base once and chains `SE_INCOME_US_TAX`, so the net is ordinary income and the SECA base,
exactly as a self-employed wage is. The state classifier already maps that action to Nebraska
ordinary income. The default payment day falls before the 31 December settle, so a year's
net is on its own year's return.

The golden `us-farm-operator` is the US single homeowner, a Nebraska resident on a W-2 wage,
with a farm row from 2027 and a second operation's loss from 2029. It pins the index base:
2027 is paid as written and 2028 is 1.03 times it. It also pins SECA:
48,000 × 92.35% × 15.3% = 6,782.18, and in 2029 the loss nets against the farm on
Schedule SE. The 13 existing goldens are byte-identical.

Under household MC, a row's `net` is the deterministic run's for now. Drawing a farm path
per year is step 4d.

### 16.6 Step 4c: `import-farm.mjs` (built)

`npm run import:farm -- --farm <export> --operator <id> --person <id> --into <plan> [--out <file>]`
follows `import-quicken.mjs`: a dry run without `--out`, both scenarios in the output, and
`--replace` to chain a second operator's import onto the first. Its logic is
`scripts/lib/farm-import.mjs`. It writes one `businessIncome` row from the deterministic crop
year, and **one `cfg.businessIncomePaths` row per MC path**: `{ businessIncomeId, seed, net,
neCommunityCollegeTax }`. These are flat rows joined by id, which the loader checks: a path
must name a row, and deleting a person removes that person's rows and paths. A re-import
replaces its own row and paths and nothing else.

The import refuses an operator missing from the export, a person missing from the plan, or an
operator with no full crop-year Schedule F. It warns when community-college tax is imported for
a person who is not a Nebraska resident, when the row starts before the plan does, and when the
paths were sampled from uncalibrated spreads. The help topic `farm-to-household`
(`help/workflows/`) walks through both commands.

### 16.7 Step 4d: a farm path per household year (built)

Two params, the same pair the stochastic inflation path has. `businessIncomeFarmPaths`
(US_INCOME, default off) is the single-run switch. `mcFarmPaths` (default on) is the
Monte Carlo one, and `applyMcPaths` sets the first from it in every path. A deterministic grid
cell turns it off, as it turns off the market and inflation paths.

With the switch on, `US_INCOME` draws at compile, for each row and year, one of the row's
`businessIncomePaths`. It uses `keyedRng(rngSeed, 'business-income:<id>', year)`, design 126's
keyed stream. A year's draw therefore does not move when another row or process is added, and
it is independent of the market draws (Q15). The event, and `BUSINESS_INCOME_APPLY`, record the
path's `farmPathSeed`, so the journal shows which farm season paid each year. The CPI indexing
of §16.5 applies to the drawn figures. A row with no paths pays its deterministic figures with
the switch on or off, so a plan without a farm runs exactly as before.

### 16.8 Step 4e: §199A (built)

**Sources first.** Rev. Proc. 2025-32 (2026) and Rev. Proc. 2023-34 (2024) are now on disk.
The 2026 rates module already cited the first for its brackets without the file. The
thresholds:

| Year | Joint | Other | Range (joint/other) | Minimum | Source |
|---|---|---|---|---|---|
| 2024 | 383,900 | 191,950 | 100,000 / 50,000 | none | Rev. Proc. 2023-34 §3.27 |
| 2025 | 394,600 | 197,300 | 100,000 / 50,000 | none | Form 8995 instructions 2025 |
| 2026 | 403,500 | 201,750 | 150,000 / 75,000 | 400 on 1,000 | Rev. Proc. 2025-32 §3.26; P.L. 119-21 §70105 |
| 2027 | 416,600 | 208,300 | 150,000 / 75,000 | 415 on 1,030 | Rev. Proc. 2026-35 §3.28 |

A projected year indexes the threshold and the minimum like the brackets (§199A(e)(2)(B),
(i)(3)). The range is a fixed width in the statute, so it is not indexed.

**The model** (`_computeQbiDeduction`):

- **QBI.** The business-income rows chain `QBI_US_TAX`. QBI is their net less the deductible
  half of SE tax in proportion to their share of SE earnings (Form 8995 instructions), less
  last year's qualified business loss (§199A(c)(2)).
- **The limits.** The deduction is 20% of QBI. Above the threshold it is limited by the
  §199A(b)(2) wage and property limit, phased in linearly across the range, then capped at
  20% of taxable income less net capital gain. From 2026 it is at least the minimum. An
  operator materially participates, so a farm row is an active trade.
- **Where it enters.** It is a deduction from taxable income, not from AGI, and enters
  exactly where the standard deduction does, so the gain stacking and the Form 1116 identity
  see one deduction. Nebraska starts from federal AGI and does not see it.
- **The carryforward.** A net loss carries forward through the settle, which writes
  `usQbiLossCarryforward`, as it does the other pools.
- **One trade or business.** All the household's rows are treated as one aggregated trade
  (Reg. §1.199A-4 allows that for commonly controlled businesses). Their W-2 wages and UBIA
  are the row fields `qbiW2Wages` and `qbiUbia` (Q30), summed and indexed like the net.
- **Self-employed jobs stay out.** A self-employed job is not fed in. Whether it is a
  specified service trade (§199A(d)) is a question the model cannot answer, and feeding it in
  would change every self-employed plan. That is a gap, recorded here.

**Effect on `us-farm-operator`.** Only its fixture moved. In 2027 QBI is 48,000 − 3,391.09
= 44,608.91, and the deduction is 8,921.78, under the 27,560 income cap. Taxable income falls
by exactly that, and ordinary tax by 24% of it. Taxes paid over the run fall by \$6,545. The
other 13 goldens are byte-identical.

### 16.9 Step 4f: the Nebraska community-college credit (built)

**The law** (`docs/ne-law/NE-Rev-Stat-77-6706-…txt`). Subsection (1) makes it a refundable
credit against Nebraska income tax. From 2024, subsection (4) sets it at 100% of the
community-college taxes paid in the taxable year. Under subsection (5), an S corporation,
partnership, LLC, trust or estate that pays the tax claims the credit itself. A Schedule F row
is a sole proprietor, so the person claims it, and a future entity-owned farm would not.

**The model.**

- **The chain.** `BUSINESS_INCOME_APPLY` chains `STATE_COMMUNITY_COLLEGE_TAX_PAID` with the
  row's indexed `neCommunityCollegeTax`. The shared state classifier routes it to
  `stateCommunityCollegeTaxYTD`, residency-gated like any state income.
- **The credit.** Each state's rates module has a `_communityCollegeCreditRate`: 1 for Nebraska
  from 2024, inherited by 2025 and by projected years, and 0 for every other state. A person
  living outside Nebraska gets no credit, and the import already warns about that.
- **The refund.** The credit comes off the liability after the brackets and may take it below
  zero. `StateTaxSettleApplyReducer` chains `STATE_TAX_REFUND_CREDIT` for a negative liability,
  and that reducer (on the refund-credit base) credits US cash.
- **The new bucket.** The credit bucket is reset at the settle but kept out of
  `STATE_YTD_FIELDS`, so plans with nothing creditable gain no state key.
- **Timing.** The tax is credited in the crop year, the year it was paid, because the row pays
  on 15 December, inside that year's return.

**Effect on `us-farm-operator`.** Only its fixture moved. The credit is 680 in 2027, then 680
indexed by CPI. No golden household's credit exceeds its Nebraska tax, so the refund path is a
KNOWN_GAP in the coverage manifest, unit-tested instead.

### 16.10 Step 4g-1/2: the net operating loss and §461(l) (built)

FinSim had **no net operating loss at all**. A loss larger than the rest of the return
sheltered its capital gains and then vanished. §461(l)(2) turns a disallowed loss into an
NOL, so the NOL had to come first. That splits 4g:

| Sub-step | What | Status |
|---|---|---|
| 4g-1 | The §172 NOL: the year's loss under the (d) modifications, the 80% deduction, the carryforward | built |
| 4g-2 | §461(l): the excess over the threshold added back and carried as an NOL | built |
| 4g-3 | The §172(b)(1)(B) farming-loss carryback and §1301 averaging, both of which need prior years' returns | next |

**Thresholds** (`_eblThresholdMfj`/`_Single`). A projected year indexes them (§461(l)(3)(C)).

| Year | Joint | Other | Source |
|---|---|---|---|
| 2024 | 610,000 | 305,000 | Rev. Proc. 2023-34 §3.32 |
| 2025 | 626,000 | 313,000 | Rev. Proc. 2024-40 §3.32 |
| 2026 | 512,000 | 256,000 | Rev. Proc. 2025-32 §3.31; P.L. 119-21 §70601(b) re-based the index to 2024 |
| 2027 | 528,000 | 264,000 | Rev. Proc. 2026-35 §3.33 |

**The model** (`_computeBusinessLossLimits`, computed after AGI and before §199A):

- **§461(l).** The business net is `usSeEarningsYTD`: the rows plus any self-employed job,
  with no wages ((3)(A)'s last sentence). A loss over the threshold is added back to AGI.
- **The year's NOL.** It comes only from a row's loss, the allowed part, and is what the rest
  of the return cannot absorb. The capital loss allowance is added back ((d)(2)), and the
  standard deduction counts only against nonbusiness income ((d)(4)). Nonbusiness income is
  approximated as income less gross wages and positive SE earnings, which errs toward a
  smaller NOL.
- **The deduction.** It is the lesser of the carry and 80% of taxable income figured without
  it and without §199A ((a)(2)(B); every loss in a run arises after 2017). It is taken above
  the line, so AGI, §199A, NIIT and the §904 identity all see it. The add-back is gross income
  for §904, and the deduction is an unrelated deduction.
- **The carryforward.** The settle persists `usNolCarryforward`, written only once there is a
  carry.

**Gap, recorded: the state return.** Nebraska starts from federal AGI, so in law it sees both
the add-back and the NOL deduction. This model's state base is its own sum of incomes, so it
nets the loss in its year and carries nothing.

**Effect.** All goldens are byte-identical: none loses more than its other income. A test
household with a 400,000 drought loss in 2027 disallows 136,000 (over 2027's 264,000
threshold). Its wage absorbs the rest, and 2028 deducts the 136,000.

### 16.11 Step 4g-3: the farming-loss carryback and §1301 averaging (built)

Both need past returns, which a simulation has to keep itself.

**The return history** (`usReturnHistory`). It is seeded only for a plan with business-income
rows. Each settle appends the year's taxable income, preferential gain, NOL base, NOL used and
the brackets it was taxed at, then keeps the last three years. Keeping the brackets lets a past
year be recomputed at its own (possibly projected) rates and filing status, which Schedule J
requires. The April re-filing (design 94) recomputes from a state pre-image, so the rows hold
everything and nothing has to be looked up later.

Years before the run come from **`cfg.usPriorReturns`** (Q31): one flat row per year,
`{year, taxableIncome}`, at that year's published brackets. A year before 2024 uses 2024's
table, the oldest registered.

**The carryback** (`_farmingLossCarryback`, inside the loss limits).

- **What carries back.** The whole NOL that arises is a farming loss, since every row is a
  Schedule F ((b)(1)(B)(ii)). The §461(l) excess carries forward only ((l)(2)).
- **Order and limit.** The loss goes to the second year back, then the first ((b)(2)). Each
  takes at most 80% of its taxable income before NOL deductions and §199A, less the NOL
  deductions it already took ((b)(2)(A), (C)).
- **The refund.** Each year's regular tax is recomputed on the lower income, ordinary first
  (Form 1045). The settle chains `US_TAX_REFUND_CREDIT {carryback: true}` and amends those
  years' rows.
- **The election.** `usFarmingLossCarryback` defaults to on, the statute's default. Off is the
  (b)(1)(B)(iv) waiver.
- **Approximation, recorded.** A past year's §199A deduction and credits are not refigured, so
  the refund runs a little high for a year that took the deduction.

**§1301** (`_computeFarmIncomeAveraging`, opt-in `usFarmIncomeAveraging`, Q11b).

- **EFI.** The rows' net, less the farm's share of the SE-tax deduction, less any excess
  business loss, capped at taxable income (Schedule J instructions, line 2a).
- **The tax.** This year's regular tax on TI − EFI, plus each base year's extra regular tax on
  base TI + EFI/3 at that year's brackets. The election takes the EFI with the least total.
  The total is piecewise linear, so every bracket edge and both ends are tried, which is
  exact.
- **Applied as.** A reduction of `regularTax`.
- **Base years.** Each is "as previously adjusted": the settle adds EFI/3 to each, and bases
  this year on TI − EFI (Schedule J line 3).
- **Recorded gaps.** A negative base year is floored at 0, where the worksheet can allow a
  negative, so the model understates the benefit. Only ordinary EFI is averaged. FTC limits
  are not refigured. There is no election without three base years.

**Effect.** All goldens' money is byte-identical. `us-farm-operator` gains only the history
and the two election keys. In a test household, a 250,000 drought in 2027 after a good 2026,
with 2025 from Q31, makes an NOL of 99,636. 40,000 (80% of 2025) goes to 2025 and 59,636 to
2026, for a 19,227 refund, and nothing carries forward.

**Phase 4 is complete** apart from the export's owned-land-and-debt section, which waits for
Q22a.

## 17. Phases 5 and 6: getting a farm in (rev 19)

### 17.1 Why

A farm reaches FinSim today in only two ways. One is a hand-written `cfg.farm`, as the demo
farm is. The other is the private acceptance importer (§12.4), and it reads only one year's
workbook layout. The workbench panels show results and the generated `farm.*` levers move
numbers, but nothing in the product adds a field, an operator or a prescription. The owners'
next workbook arrived in a new layout, and a private review of it found it holds **rates and
field facts, not a ledger**. That is close to the §5.1 record model, so a fixed template maps
almost one to one onto `cfg.farm`.

Two routes are planned. The importer is the bulk path, since a whole year arrives at once
from a spreadsheet the owners already keep. The editors handle small changes. Both produce the
same `cfg.farm` and go through the same `normalizeFarm` / `validateFarm`, so a bad row is a
load error whichever way it came in (§12.2).

### 17.2 Phase 5: the yearly template and importer (loose: the template is being settled)

**Shape.**

- One CSV per tab, named after the tab, exported **values only** (the workbook keeps its
  formulas, the CSV doesn't need them).
- The parsing lives in a pure module, `src/finance/farm/farm-import.js`: text in,
  `{ farm, advisories }` out, no `node:fs`. That way phase 6 can import the same files in the
  browser. `scripts/farm/import-farm-workbook.mjs` is a thin CLI over it, on `parseFlags`,
  writing a farm scenario file the existing `farm:report`, `farm:mc` and `farm:export` read.
- The private acceptance importer stays as it is. It reads the old ledger layout.

**Template rules** (the importer enforces them, and the template should make them easy):

1. **A stable id column on every tab that others reference**: field, operator, product,
   loan, insurance unit, contract. A field's id must not be derived from its name, operator or
   practice. Fields move between operators and get renamed between years, and comparing years
   needs the id to survive both. A display name sits in its own column.
2. **One fact per column.** Crop, practice (irrigated or dry) and tenure each get a column of
   their own, from a fixed code list: crop `CORN`, `CORN_ON_CORN`, `SOYBEANS`, …; practice
   `IRR`/`DRY`; tenure `OWN`/`RENT`. Nothing is packed into a job code, and a job-code column
   is ignored if present.
3. **Long, not wide, for anything keyed by crop or practice.** A rate is one row per
   (item, crop, practice), not one column per crop. Adding a crop then means adding rows,
   not columns.
4. **Defaults plus overrides.** The Rates tab gives the default prescription for a (crop,
   practice). An optional Field overrides tab replaces or adds a line for one field: a
   different chemical program, extra nitrogen on corn-on-corn, a seeding rate. This is how
   per-field differences are entered without a full prescription table.
5. **Shares are rows, not formulas.** Anything shared across fields (an insurance unit's
   premium, a seed lot split, a loan securing several fields, an overhead pool on some fields)
   is a link tab: `(group id, field id, share)`. A blank share means "by acres". The importer
   checks that explicit shares sum to 1.
6. **Blank means unknown, 0 means zero.** A blank required cell is an advisory that names the
   tab, row and column, like `NO_SEED` (§14.1), never a silent \$0. An error cell (`#REF!`,
   `#N/A`, `#VALUE!`) is refused.
7. **Money and dates are plain.** Money as a number. The importer still tolerates a currency
   symbol, thousands separators and surrounding spaces, because spreadsheets export them. Dates
   as `YYYY-MM-DD`, or `YYYY-MM` for a month, which reads as the 15th. Delivery and payment are
   separate columns, since the payment date decides the tax year (Q11).
8. **Units stated.** Each rate row has a unit and a basis (`PER_ACRE`, `PER_UNIT`,
   `PER_BU`, `PER_BU_MONTH`, `PER_PASS`), so "per pass or per season" never has to be guessed.
9. **Keys are normalized**: headers and codes are trimmed and case-folded before matching.
   Columns are found by header, never by position. An unknown header is an advisory, not an
   error, so the owners can keep notes columns.
10. **A Meta tab**: crop year, template version, farm name. The importer refuses a version it
    doesn't know rather than misreading a changed layout.

**Tabs** (each → its `cfg.farm` tables):

| Tab | Columns | → |
|---|---|---|
| Meta | template version, crop year, farm name | `seasons` |
| Operators | operator id, name, household, `farmRelated`, §451(f) election, W-2 wages, UBIA (Q30) | `operators`, export row fields |
| Fields | field id, name, operator id, legal description, FSA farm, practice, tenure, rented acres, planted acres, crop, expected yield, APH yield, rent (\$/acre **or** lump, one required for RENT), property tax, community-college share (Q29), metered electricity | `fields`, `cropPlans` |
| Rates | item id, name, Schedule F category, crop, practice, unit, basis, price, discount, passes | `products`, `operations`, default `prescriptions` |
| Field overrides | field id, item id, rate, passes, share, `REPLACE`/`ADD` | `prescriptions` |
| Contracts | contract id, operator id, crop, crop year, bushels **or** share of expected, price, delivery date, payment date | `contracts` |
| Planned sales | operator id, crop, crop year, share of unpriced bushels, sale date, payment date | `sales` |
| Prices | crop, date, price (projected and harvest price for insurance; the step table for the deterministic run) | `prices`, `seasons.projectedPrice` |
| Loans | loan id, payer operator id, balance, rate, fixed/variable, interest paid, principal paid | `overhead` (interest), the export's land-and-debt section (Q22a) |
| Loan fields | loan id, field id, share | `overhead.fieldIds`, land-and-debt section |
| Insurance units | unit id, operator id, crop, plan, coverage, unit structure, premium | `insurance`, `cropPlans.insurancePremiumPerAcre` |
| Insurance unit fields | unit id, field id, share | premium split |
| Program income | operator id, program, Schedule F line, FSA farm, amount, payment date | `otherIncome` |
| FSA base | operator id, FSA farm, crop, base acres, county, irrigated % (Q28) | `arcBase` |
| Operator costs | operator id, item (machinery, fuel, labor, repairs, drying, office, …), Schedule F category, amount, basis, paid date | `machinery`, `overhead` |
| Storage | operator id, crop, cost per bushel per month | `storage` |

The Schedule F line a program payment lands on (4a or 6a) and whether it qualifies for
§451(f) are decided from the program rules on disk, per program, before a row is accepted
(the private review lists programs that have no ruling yet).

**Acceptance.**

- The import of the owners' first template-format year reproduces that workbook's own
  per-field and per-operator totals to the cent, the way §12.4 did for the ledger layout.
- Re-importing an unchanged file gives a byte-identical farm (the sim is bit-deterministic).
- A `--check` mode prints the advisories and the per-operator totals without writing.
- With two years imported, a `--diff` of field ids shows the fields added, dropped, renamed or
  moved between operators.

### 17.3 Phase 6: in-app record editors

- **A Farm Records panel** in the Farm view, with one row-list editor table per `cfg.farm`
  table. The tables stay flat and are joined by id: an id column is a select over the
  referenced table, never a nested form or a JSON text area. Its form-field prose lives in
  `help/nodes/` (design 111).
- **Validation is the loader's.** An edit is applied through `normalizeFarm` / `validateFarm`,
  and the panel shows the same errors and advisories the importer reports, beside the row.
- **Import and export in the panel.** Dropping the template's CSVs runs `farm-import.js` in the
  browser. An export writes the current records back out as the template, so the owners can
  take an edited year back to Excel. Import → export → import must be byte-identical.
- **Levers are unchanged.** The editors change the authored records. The `farm.*` generated
  params still sweep around them.
- **Order.** Operators, fields and crop plans come first, since they are what a what-if
  changes most. Then products, operations and prescriptions, then the marketing and program
  tables.

### 17.4 Panel charts (built, rev 19)

- **Field P&L: cash price vs breakeven.** One crop's cash price (the step table) through the
  season against the breakeven for the unpriced grain, with the zone below it shaded, the
  season's contracts and planned sales as points, and a marker at the run's date. The scope is
  the row last clicked. The breakeven is the **planned** season's: `planFarm` runs the farm to
  its end on an isolated `ServiceRegistry` (the MC worker's pattern), because the table's
  season-to-date breakevens are too low until the grain is sold. An operator row's own
  breakevens are null (it mixes crops), so the chart sums that operator's plans of one crop
  (`sumPlanRows`). A visualMap colouring the line by the breakeven was dropped: ECharts throws
  inside render when the whole line is on one side of it, and then draws no series. A headless
  SVG render test now covers that case.
  - **One chart per crop** (rev 19, after review). A scope growing corn and soybeans has two
    breakevens, and the crops sell at different prices, so a single chart with a crop switch
    hid half the answer. `breakevenChartSet` gives one entry per crop on the widest date range
    among them, so the stacked charts share a time axis. Each keeps its own price axis, and a
    fixed left margin keeps the "now" markers at the same x. Today's cash price is a labelled
    point on the marker, green above the breakeven and red below.
- **Farm MC: a cash fan and a net histogram.** Each path now carries `cashSeries`
  (`farmCashSeries`): the cumulative cash net at each month end over the season window, for
  the farm and each operator. Every path has the same 36-month grid, so percentiles are taken
  month by month. It is cash before §464(d)/§451(f), and without the non-cash custom-rate
  charges. The histogram is the crop-year job-cost net on the panel's basis. Both follow the
  retirement MC panel's charts. The results now sit above the variables table.
- **Run bar.** The paths input and Run button use the app's `.mc-iters-input` and `.btn
  btn-primary`.
- **Bands below \$0.** Each band is a hidden base with its height stacked on it. ECharts'
  default `stackStrategy: 'samesign'` stacks positive and negative values apart, so a band
  over a negative P10 was stacked on \$0 and its shading stopped there. Both fans (this one
  and the retirement MC panel's, whose net liquidity can go negative) now use `'all'`. A test
  reads the stack ECharts computes.
