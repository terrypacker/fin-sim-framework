---
id: real-property
kind: node
title: Real Property
node: real-property
panels: [config-list, config-graph]
design: [75-house-costs-and-property-return-path.md, 83-us-au-tax-treaty-intricacies.md, 86-leveraged-property-fidelity.md, 48-rental-income.md]
stamps:
  panel:config-list: 786f94
  panel:config-graph: bbebb1
  node:real-property: 783cd4
---

A dwelling or land parcel: the most configurable record in the app, because a house is
four mechanics at once. It **appreciates** on its own rate; it may carry a **mortgage**,
with its own term, deductibility and currency exposure; it may **earn rent** and be
depreciated; and it **costs money to hold**, in a fixed annual bill and in repairs that
arrive at random.

The form is grouped that way, and most of it is optional. A dwelling with a value, an
acquisition date and a main-residence history is a complete record; everything below
that is there when the plan needs it.

Two sections repay reading before authoring. The **main residence history** is what
the capital-gains concessions turn on in both countries, and the fields are a dropdown
plus one date precisely so that a contradictory history is unreachable rather than
merely invalid. Leaving the acquisition date blank does not default to the start of the
run — it denies the concessions, deliberately, because defaulting it would treat a
twenty-year hold as a three-year one in your favour.

The **purchase** section is how a mid-run downsize is authored: a property bought in a
future year sits dormant, worth and costing nothing, until that January. Selling one
dwelling and buying another in the same January works, because the purchase settles
after the sale.

## Fields

- `name` — What this property is called throughout the app. Free text.
- `country` — Which country's rules tax this dwelling's sale, rent and holding costs, and the default currency that follows. It drives the whole capital-gains path — the Australian main-residence exemption and CGT discount, or the US §121 exclusion and depreciation recapture.
- `currency` — The currency the value, basis, rent and mortgage are stated in. Defaults from the country. A non-USD property held by a US person carries currency exposure on both the asset and its debt.
- `costBasis` — What was paid, plus capitalised improvements — the number the taxable gain is measured from. A basis left at 0 taxes the entire sale proceeds as gain. Capitalised repairs lift it over the run; depreciation claimed against rent reduces it, and is recaptured on a US sale.
- `saleDestinationAccount` — Which account receives the net proceeds when this property sells. Blank sends them to the country's cash pool, where the spending rule can consume them. Naming a brokerage account is how a downsize is reinvested rather than quietly spent.
- `ownershipType` — Sole or joint, which decides how the gain, the rent and the deductions are split between the two people. With different marginal rates or different residencies it is one of the larger levers on a property plan.
- `ownerId` — The person who owns it when ownership is sole. Their residency, age and rate at the sale year decide what the gain costs.
- `purchaseYear` — The calendar year this dwelling is bought. Blank means it is already owned at the start of the run. Set, the property is dormant — worth nothing, costing nothing — until 15 January of that year, when the price is debited and it becomes an ordinary property. The purchase settles after any sale on the same date.
- `purchasePrice` — What the dwelling costs, in today's money, in its own currency. It is grown to the purchase date at this property's own appreciation rate rather than at CPI, so a price set as a share of what you are selling keeps that share. A purchase year with no price buys nothing.
- `purchasePriceIsNominal` — Tick when the price is already stated as at the purchase date — a contracted price. Unticked, the default, treats it as today's money and grows it to that year.
- `purchaseFundFrom` — The account the purchase price is debited from. Blank uses the property country's cash pool. If the balance would breach its minimum the shortfall is raised through the ordinary drawdown queue, which is what makes a purchase interact with the portfolio instead of looking free.
- `acquisitionDate` — When the dwelling was actually bought. It is the denominator of the Australian ownership-period fraction and of the CGT discount testing period, and the start of the US nonqualified-use window. LEAVE IT BLANK AND THOSE CONCESSIONS ARE DENIED — it is deliberately not defaulted to the start of the run, because that would inflate every fraction in your favour. Set automatically when a dwelling is bought mid-run.
- `mainResidenceMode` — Which main-residence history this dwelling has: never, throughout, from the start then moved out, or became one later. Never is an investment property with no exemption in either country; throughout is fully exempt in Australia and takes the full US exclusion. The two mixed options each prorate, and the order matters — renting after you move out is forgiven by the US look-back rule, renting before you move in is not.
- `mainResidenceFrom` — When this dwelling first became the main residence. Australia exempts only the fraction of ownership days it actually was one, so moving into a long-rented house late buys a small fraction of the exemption and not the whole of it.
- `mainResidenceUntil` — When it stopped being the main residence. Everything after this date is a rental period — which the US rules forgive, unlike the years before you moved in.
- `claimDownsizerContribution` — Claim the Australian downsizer superannuation contribution on this dwelling's sale: up to A\$300,000 per owner aged 55 or over, outside the contribution caps, for an Australian dwelling held ten years or more. It requires the main-residence exemption to be at least partly available, so a dwelling never lived in funds nothing.
- `mortgageBalance` — Outstanding principal, in the property's currency. Above zero this synthesizes a linked loan liability, and the property itself then contributes equity only. Set it to zero and author a separate loan account instead when the debt needs its own payment source or a second lender.
- `monthlyMortgage` — The fixed monthly principal-and-interest payment. Inert while interest-only is on, because the payment is then derived from the accrued interest, and inert again after the interest-only expiry when a maturity year re-amortises the loan over its remaining term.
- `mortgageInterestRate` — The annual rate the bank quotes, as an absolute decimal. Where Prime is configured it is stored as a spread over it, so a Prime move re-rates this loan along with every other.
- `mortgageInterestOnly` — Pay exactly the interest accrued on the effective, offset-reduced principal each month. The balance is flat by construction and a variable rate is tracked automatically. This is the safe way to express interest-only — a fixed payment below the accrued interest negatively amortises instead, silently.
- `mortgageInterestOnlyUntilYear` — The calendar year the interest-only period ends. From then the loan reverts to principal-and-interest over the remaining term, which needs a maturity year. Blank means interest-only forever, and the step-up at that expiry is the exposure a leveraged plan is actually carrying.
- `mortgageMaturityYear` — The calendar year the loan must be discharged: the whole remaining balance plus interest is paid that year, and a shortfall runs the ordinary replenish path. Blank means no term.
- `mortgageDeductibleFraction` — The income-producing share of the borrowed money's use, 0 to 1 — the use test, not what secures the loan. Blank keeps the default rule: fully deductible while the property is renting, nil otherwise. It also decides the §988 business share, so it moves the exchange gain or loss treatment with it.
- `mortgagePaymentSourceKey` — The cash pool the monthly payment debits. Blank resolves to a same-currency offset linked to this property when one exists, then the flagged transaction account or country savings pool. Paying from the offset is what a real offset facility direct-debits, and it is not cosmetic — draining it raises the interest-bearing principal.
- `mortgageBookingFxRate` — Foreign units per USD on the date the debt was incurred. A non-USD mortgage held by a US person realises ordinary gain or loss on each principal repayment against this rate. Blank stamps it at the first payment, understating the exposure for a loan already outstanding at the start of the run.
- `rentalEnabled` — Turn this property into a rental. It starts earning rent, its deductible expenses and depreciation begin, and its capital-gains treatment changes in both countries. The fields below it are inert until this is on.
- `monthlyRent` — Gross rent at full occupancy, in the property's currency, in today's money. It inflates over the run; what is actually received is this multiplied by the occupancy rate.
- `occupancyRate` — The fraction of gross rent actually realised, covering vacancy, arrears and turnover. A long-term let is around 0.95; a short-term let is far lower, near 0.55, which is the honest cost of the higher headline rent.
- `rentalExpenseRatio` — Deductible cash operating expenses as a fraction of gross rent — management, letting fees, maintenance billed as expense. Separate from the fixed annual running cost below, which is charged whether or not the property is let.
- `landValueRatio` — The non-depreciable land share of the cost basis. Only the building depreciates, so this fraction sets how much of the purchase is written off against rent — and, on a US sale, how much is later recaptured.
- `annualDepreciationOverride` — An explicit annual depreciation amount, overriding the per-country derivation. For a property whose schedule is known rather than assumed. Blank derives it from the building's share of basis under the country's own rules.
- `annualRunningCost` — The base-year fixed cost of holding this property — rates, insurance, utilities, servicing — in its own currency. It inflates each year and is charged whether the property is let or lived in. Zero turns it off, which understates the cost of owning a house.
- `runningCostValuePct` — An optional value-proportional running cost, as a fraction of current value per year (0.005 is 0.5% a year). Added on top of the fixed cost, and it grows as the property does, which is the part a fixed bill misses over a long run.
- `runningCostGrowth` — Optional real growth of the running cost, on top of inflation. Zero tracks inflation exactly; above zero models costs outrunning CPI, which rates and insurance have done.
- `repairModel` — Which stochastic repair process this property runs: none, Bernoulli (one large repair in some years), Poisson (a variable count each year), or continuous (a lognormal cost every year). Repairs are drawn from the run's random stream, so they differ across a Monte Carlo batch — which is the point of modelling them at all.
- `repairProb` — The annual probability of a repair under the Bernoulli model. 0.25 is roughly one large repair every four years.
- `repairLambda` — The expected number of repairs per year under the Poisson model. Above 1 it models a property with several things going wrong each year rather than one large event.
- `repairMedian` — The median severity of one repair event, in the property's currency. Ignored when the value-proportional anchor below is set.
- `repairValuePct` — An alternative severity anchor: the median repair is this fraction of current value (0.02 is about 2% of the house). It overrides the fixed median when above zero, and keeps severity growing with the property instead of staying at a base-year figure.
- `repairSigma` — The lognormal shape of repair severity — how heavy the tail is. Higher means more of the cost arrives in rare, large repairs, which is what actually threatens a plan with a thin cash buffer.
- `capitalizeRepairs` — The fraction of each repair treated as a capital improvement rather than maintenance. It lifts the cost basis and so cuts the eventual capital-gains tax. Zero treats every repair as pure maintenance.
- `speculative` — Simulate this property but do not count it as yours. It still appreciates, still sells in its sale year and still pays the tax — but until it converts it is worth zero in net worth and in everything downstream of it. Disclosed separately as "incl. speculative", so nothing is hidden. Incompatible with a drawdown priority.
