# Nebraska law sources — provenance

Added 19 Nov 2026 for design 134 (farm job costing). Every field and every operator in that
design is in Nebraska. These are the Nebraska Revised Statutes that can change a field's
cost: property tax on agricultural land, the state's property tax relief, sales tax on farm
inputs, and Natural Resources District groundwater controls.

FinSim's Nebraska **income** tax module (`src/finance/tax/state/ne/`) cites the Department of
Revenue's rate schedules. Those are not here.

## Route

`https://nebraskalegislature.gov/laws/statutes.php?statute=<section>` returns the section
as HTML (no block on scripted fetches, 19 Nov 2026). The files keep the section text, the
`Source` history and any annotations, and drop the site's header and footer. The chapter
index, for finding a section by heading, is
`https://nebraskalegislature.gov/laws/browse-chapters.php?chapter=<N>`.

## Files

| file | what it says | why it matters |
|---|---|---|
| `NE-Rev-Stat-77-201-…` | `(2)` agricultural and horticultural land is a separate class, **valued at 75% of actual value**, or 50% for school bonds approved by a vote on or after 1 Jan 2022 | The property-tax base on owned fields. |
| `NE-Rev-Stat-77-1359-…`, `77-1363-…` | Definition of agricultural land, and the classes it is valued in (irrigated cropland, dryland cropland, grassland, …), by NRCS soil capability groups | Irrigated and dry fields of one parcel are valued as different classes. |
| `NE-Rev-Stat-77-6701-…` to `77-6706-…` | The **Nebraska Property Tax Incentive Act**: a refundable **income tax** credit for school-district (77-6703) and community-college (77-6706) property tax paid | **The school-district credit (77-6703(1)) applies to taxable years before 1 Jan 2024 only.** It was amended by LB 34 (2024 First Special Session). **The community-college credit continues: 77-6706(4) gives 100% of the community-college taxes paid, for taxable years from 1 Jan 2024.** On an owned field, that slice of the property tax bill comes back on the operator's Nebraska return. The model has to carry it as a separate line, not net it away. 77-6702(1) defines the community-college taxes. |
| `NE-Rev-Stat-77-7301-…` to `77-7305-…` | The **School District Property Tax Relief Act**: from **tax year 2024**, school-district relief is a **property tax credit on the property tax statement** (77-7305(1)), allocated to each parcel by its share of school-district taxes levied (77-7305(2)) | Replaces the income tax route for school taxes. The model takes property tax **net of statement credits**, as billed. |
| `NE-Rev-Stat-77-4209-…` to `77-4212-…` | The **Property Tax Credit Act**: a further credit on the statement. Since 2017 it is allocated by "credit allocation valuation", which weights agricultural land at **120%** of taxable value (77-4212(5)) | Also already netted on the statement. |
| `NE-Rev-Stat-77-2704.36-…` | Sales and use tax exemption: depreciable agricultural machinery and equipment for commercial agriculture | Machinery is entered without sales tax. |
| `NE-Rev-Stat-77-2704.64-…` | Exemption: repair and replacement parts for agricultural machinery | Repairs are entered without sales tax. |
| `NE-Rev-Stat-77-2708.01-…` | Refund procedure for sales tax paid before 1 Oct 2014 on depreciable repairs | Historical. Kept because the chapter index groups it with 77-2704.64. |
| `NE-Rev-Stat-77-2704.46-…` | Exemption: `(2)` seeds sold to commercial producers; `(3)` agricultural chemicals and adjuvants applied to land or crops in commercial agriculture | Seed and chemical prescriptions are entered without sales tax. |
| `NE-Rev-Stat-77-2704.41-…` | Exemption: feed, water, veterinary medicines and agricultural chemicals for animal life | Livestock. Out of scope, but it defines "agricultural chemicals" (insecticides, fungicides, growth regulators, hormones) in that context. |
| `NE-Rev-Stat-77-5211-…` | **Beginning Farmer Tax Credit**: a refundable income tax credit to an owner who rents agricultural assets to a qualified beginning farmer, under a board-certified three-year agreement | Can change the economics of renting land between family members. Relevant only if an operator qualifies. |
| `NE-Rev-Stat-46-739-…` | NRD groundwater management-area controls: allocations (1)(a), rotation, metering, reduction or limit on irrigated acres (1)(e)–(f), well permits | Bounds irrigated yield and water use. The controls themselves are each NRD's own rules. |

## Gaps

- **Fertilizer under the sales tax.** 77-2704.46(3) exempts "agricultural chemicals" applied
  to land or crops but does not define the term there. Whether fertilizer is inside it is not
  settled by these files. Next: the Department of Revenue's sales tax regulations (Title 316,
  the agricultural chapter) or its agricultural information guide.
- **The NRD rules** that actually apply to the fields (allocation in inches per acre over a
  period, certified acres). Each district publishes its own rules. Find out which NRD covers
  each irrigated field first.
- **How the community-college share is shown on a tax statement.** 77-6706(4) credits the
  community-college taxes paid, so the model needs that levy split out per parcel. Next: a
  county treasurer's statement layout, or the parcel's levy breakdown.
