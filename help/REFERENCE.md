# FinSim reference

**Generated — do not edit.** Every fact below is read out of the source by
`scripts/dev/build-help-index.mjs`; run `npm run help:build` to regenerate it. Editing
this file by hand creates exactly the second copy that design 108 §2.1 exists to kill.

This is tier 1 of the help system (design 108): the complete, exact surface, with no
prose about it. For *why* a mechanic exists and when to reach for it, follow the design
doc named in the relevant parameter description, or read the tier-2 topic under `help/`
that cites it — the last section of this file lists every one.

223 parameters · 33 panels · 173 action types · 79 tools · 266 state field types · 60 topics · 118 design docs

---

## Parameters (223)

Every configurable parameter, from `IntlRetirementScenario.buildFullParamSchema()`.
A **sweep** column entry means the param is exposed to that engine: `mc` to Monte Carlo,
`opt` to the optimizer. `via` names the toolset that contributed it (`SCENARIO` = the
scenario's own schema), which is where to go to change it.

### Allocation (18)

- **`allocationGlidepath`** — Allocation Glidepath · `AllocationGlidepath` · default — · conditional · via ECONOMIC_REGIMES
  GLIDEPATH anchors: an array of { age, weights } where weights is a mix map, e.g. [{"age":50,"weights":{"EQUITY":0.8,"BOND":0.2}},{"age":75,"weights":{"EQUITY":0.4,"BOND":0.6}}]. The target is linearly interpolated by the primary's age. Null ⇒ falls back to the static mix.
- **`allocationLocation`** — Allocation Location · `Enum` · default `LOCATED` · one of `LOCATED`, `PER_ACCOUNT` · conditional · via ECONOMIC_REGIMES
  How the whole-portfolio target mix is placed across accounts. LOCATED (default) concentrates each class in its tax-favored account — bonds in tax-deferred (IRA/401k), equity in Roth/taxable, gold in a shelter (AU super; never a US IRA/401k/Roth) — so the aggregate book hits the mix while accounts specialize. PER_ACCOUNT drives every account to the same uniform mix (simpler; a manual escape hatch).
- **`allocationLocationPolicy`** — Allocation Location Policy · `LocationPolicy` · default — · conditional · via ECONOMIC_REGIMES
  LOCATED placement policy: a map of allocation → preferred account roles (in order), e.g. {"BOND":["ira","k401"],"EQUITY":["roth-ira","us-stock"]}. Preference is soft (spills when full); the US-IRA/401k/Roth gold ban is always enforced. Null ⇒ the jurisdiction-aware default.
- **`allocationRegimeTargets`** — Allocation Regime Targets · `AllocationRegimeTargets` · default — · conditional · via ECONOMIC_REGIMES
  REGIME_CONDITIONED targets: a map of regime tag → mix, e.g. {"NORMAL":{"EQUITY":0.6,"BOND":0.4},"ECONOMIC_STRESS":{"EQUITY":0.3,"BOND":0.3,"CASH":0.2,"GOLD":0.2}}. The active regime's mix applies (NORMAL when no stress). Null ⇒ falls back to the static mix.
- **`allocationSchedule`** — Allocation Schedule · `Enum` · default `STATIC` · one of `STATIC`, `GLIDEPATH`, `REGIME_CONDITIONED`, `YEARS_OF_SPEND` · conditional · via ECONOMIC_REGIMES
  How the target mix changes over the plan. STATIC = one mix for the whole run (default). GLIDEPATH = interpolate between {age, weights} anchors by age (e.g. equity 80%→40% from 50→75). REGIME_CONDITIONED = a distinct mix per active economic-regime tag (the "shift to bonds/gold in a downturn" lever). YEARS_OF_SPEND = size the CASH and BOND pools as N years of CURRENT spending and let EQUITY take the residual (design 97 §9) — the only mode in which a plan authored as "2 years of cash, 4 years of bonds" still is that in twenty years; every other mode states a percentage, and a percentage drifts to roughly 4x its authored cover over a long horizon.
- **`allocationStrategy`** — Allocation Strategy · `Enum` · default `STATIC` · one of `STATIC`, `OPTIMIZED` · conditional · via ECONOMIC_REGIMES
  STATIC uses the fixed Rebalance Target Allocation object; OPTIMIZED synthesizes the target mix from the continuous Allocation Weight params the solver can search (design 61 §4-A).
- **`allocWeight::BOND`** — Allocation Weight — Bond · `Number` · default `1` · range 0…1 · sweep: opt · conditional · via ECONOMIC_REGIMES
  Stick-breaking weight for the Bond sleeve (0–1). Active only when Allocation Strategy is OPTIMIZED. The applied target mix is synthesized from all class weights and always sums to 1; Gold is the residual.
- **`allocWeight::CASH`** — Allocation Weight — Cash · `Number` · default `0` · range 0…1 · sweep: opt · conditional · via ECONOMIC_REGIMES
  Stick-breaking weight for the Cash sleeve (0–1). Active only when Allocation Strategy is OPTIMIZED. The applied target mix is synthesized from all class weights and always sums to 1; Gold is the residual.
- **`allocWeight::EQUITY`** — Allocation Weight — Equity · `Number` · default `0.6` · range 0…1 · sweep: opt · conditional · via ECONOMIC_REGIMES
  Stick-breaking weight for the Equity sleeve (0–1). Active only when Allocation Strategy is OPTIMIZED. The applied target mix is synthesized from all class weights and always sums to 1; Gold is the residual.
- **`bondLadderCouponRate`** — Bond Ladder — Coupon Rate (blank = market) · `Number` · default — · range 0…0.15 · conditional · via ECONOMIC_REGIMES
  Fixed coupon stamped on every rung at build. Blank (default) = the prevailing curve yield at each rung's own tenor. For a TIPS ladder this is the REAL yield.
- **`bondLadderInflationLinked`** — Bond Ladder — TIPS (inflation-linked) · `Boolean` · default `false` · conditional · via ECONOMIC_REGIMES
  ON = every rung is a TIPS / inflation-linked bond (design 66 §G5): principal indexes to CPI, the accretion is imputed ordinary income, the coupon pays on the adjusted principal and redemption carries the deflation floor. Set `bondLadderCouponRate` to the REAL yield when ON — leaving it null stamps the NOMINAL market yield on top of CPI indexation, which pays twice for inflation.
- **`bondLadderRole`** — Bond Ladder — Account Role(s) · `EnumMulti` · default `us-stock` · one of `ALL`, `us-savings`, `fixed-income`, `us-stock`, `ira`, `k401`, `roth-ira`, `au-savings`, `au-fixed-income`, `au-stock`, `super`, `us-loan`, `au-loan`, `us-offset`, `au-offset`, `inherited-ira`, `inherited-k401`, `inherited-roth` · conditional · via ECONOMIC_REGIMES
  WHERE the ladder lives: tick the account roles to ladder, or ALL for every account that holds bonds. EVERY account matching a ticked role is laddered, not just the first — a household commonly holds several accounts in one role. Nothing ticked = the default (us-stock). Note there is no SIZE lever here: a ladder is the account's whole BOND sleeve, restruck as N individual bonds, so how much is in it is set by the allocation target (TARGET_ALLOCATION), not by this strategy — this strategy only decides the SHAPE (rungs × spacing) and the LOCATION.
- **`bondLadderRoll`** — Bond Ladder — Roll Maturing Rungs · `Boolean` · default `true` · conditional · via ECONOMIC_REGIMES
  ON (default) = each maturing rung rolls into a fresh rung at the ladder tail, so the ladder self-perpetuates (accumulation). OFF = maturing rungs fall to cash (spend-down).
- **`bondLadderRungs`** — Bond Ladder Length (rungs) · `Number` · default `5` · range 2…15 · sweep: opt · conditional · via ECONOMIC_REGIMES
  Number of rungs in the bond ladder the strategy maintains (design 66 §G8). Longer ladder = more duration/yield + rate risk; shorter = more liquidity + reinvestment drag. Searchable by the optimizer and tunable online in the MPC cockpit.
- **`bondLadderSpacingYears`** — Bond Ladder Spacing (years) · `Number` · default `1` · range 0.25…5 · conditional · via ECONOMIC_REGIMES
  Years between adjacent rung maturities. Ladder term = rungs × spacing. 0.25 is a quarterly ladder — four rungs of it cover a year of spending in three-month steps, which is the shape a liquidity pool wants; the reducer has always accepted it, the control just could not express it.
- **`bondLadderTaxTreatment`** — Bond Ladder — Tax Treatment · `Enum` · default `state` · one of `none`, `state`, `federal`, `both` · conditional · via ECONOMIC_REGIMES
  Holding tax treatment for every rung (design 66 §G2): none = fully taxable, state = US Treasury (state-exempt, default), federal = municipal, both = muni all-state.
- **`rebalanceDriftBandSheltered`** — Rebalance Drift Band — Sheltered · `Number` · default `0.02` · range 0.01…0.2 · sweep: opt · conditional · via ECONOMIC_REGIMES
  Allocation drift (fraction) that triggers a rebalance in a tax-advantaged (401k/IRA/Roth/Super) account. Defaults TIGHT (0.02) — rebalancing there is ~free, so tight banding buys the best risk control at no tax cost (design 61 §OQ3).
- **`rebalanceDriftBandTaxable`** — Rebalance Drift Band — Taxable · `Number` · default `0.1` · range 0.02…0.2 · sweep: opt · conditional · via ECONOMIC_REGIMES
  Allocation drift (fraction) that triggers a rebalance in a TAXABLE brokerage account. Defaults WIDE (0.10) — a wide band beats annual/tight by realizing far less CGT for marginal tracking gain (design 61 §OQ3).

### AU Banking (3)

- **`auFixedIncomeInterestRate`** — AU Fixed Income Interest Rate · `Number` · default `0.04` · sweep: mc · via AU_BANKING
  Annual interest rate for AU fixed income accounts
- **`auPrimeRate`** — AU Prime Rate (RBA policy) · `Number` · default `0.0435` · sweep: mc · via AU_BANKING
  AU central-bank (RBA) policy rate. Prime-linked cash accounts and variable loans earn/pay Prime + their spread.
- **`auSavingsInterestRate`** — AU Savings Interest Rate · `Number` · default `0.045` · via AU_BANKING
  Annual interest rate for AU savings accounts (seed / fallback baseline; rate sweeps go through AU Prime — design 56).

### AU Retirement (2)

- **`auDividendReinvest`** — Reinvest AU Dividends (default) · `Boolean` · default `true` · sweep: opt · via AU_RETIREMENT
  Household DEFAULT for AU brokerage franked dividends: if true they are reinvested into the paying holdings, otherwise paid out as cash to the AU transaction account. The franking credit is assessable and the s207-20 offset applies either way — where the cash lands is not a tax fact. Any AU brokerage account can override this on its own record (design 106).
- **`superFrankedPercent`** — Super Franked Percent · `Number` · default `1` · via AU_RETIREMENT
  Fraction of the dividends on super's Australian shares that are franked (1 = fully franked, 0 = no franking credits). The fund receives a credit of 30/70 of the franked dividend (ITAA97 s202-60(2)) and it is refundable (s67-25): it offsets the fund's 15% tax in accumulation, and is paid in full in pension phase. Only the AU equity part of super earns it; international shares carry no Australian credit.

### AU Tax (2)

- **`auBracketIndexSpread`** — AU Bracket Indexation Spread · `Number` · default `0` · sweep: mc · via AU_TAX
  Annual rate at which AU income tax brackets and the Medicare levy threshold are projected to rise past FY2027-28, expressed as a spread ADDED TO inflation (0 = track CPI, -0.03 against 3% inflation = frozen brackets, which is what AU law actually says). Published years are always used as legislated.
- **`auCpiRate`** — AU CGT Indexation (CPI) Rate · `Number` · default — · sweep: mc · via AU_TAX
  Annual ATO CPI rate used to index AU capital-gains cost bases (FY2027+). Leave unset to track the AU inflation rate.

### Behavioral (13)

- **`assetLocationPolicy`** — Asset Location Policy · `LocationPolicy` · default — · conditional · via ECONOMIC_REGIMES
  Map of allocation → preferred account roles for tax-advantaged placement. E.g. {"BOND":["ira","k401"],"EQUITY":["roth-ira"]}. Null = use defaults.
- **`behavioralStrategies`** — Behavioral Strategies · `EnumMulti` · default `` · one of `PANIC_SELL`, `CONTRIBUTION_SUSPENSION`, `TAX_LOSS_HARVEST`, `STRATEGIC_ASSET_LOCATION`, `OPPORTUNISTIC_REBALANCE`, `TARGET_ALLOCATION`, `BOND_LADDER`, `DOWNTURN_ROTH_CONVERSION`, `CASH_BUCKET_DRAWDOWN`, `TAX_GAIN_HARVEST`, `LIQUIDITY_POOLS` · sweep: opt · via ECONOMIC_REGIMES
  Active behavioral strategies: portfolio reactions to regimes and tax opportunities (design/29). PANIC_SELL rotates equity to cash on crash entry; TAX_LOSS_HARVEST realizes losses at year-end; CONTRIBUTION_SUSPENSION halts contributions under stress; and more.
- **`cashBucketDrawdownMinSeverity`** — Defend Bucket Above Severity · `Number` · default `0.25` · sweep: opt · conditional · via ECONOMIC_REGIMES
  The bucket earns its keep in a deep, long drawdown, not by re-sequencing every withdrawal over an ordinary dip. The shock preset's `severity` is its measured trough depth (0-1) and is the MC/optimizer knob, so a threshold stated here tracks a severity sweep instead of being frozen into the regime tag. At the 0.25 default a mild correction (0.115) and COVID (0.19) pass through untouched, while a GFC (0.51), a lost decade (0.51) or a dot-com bust (0.35) trips it. A shock carrying no severity (a custom or curve shock) always qualifies — an absent number is missing information, not evidence of mildness. Set 0 to react to every tagged shock.
- **`contributionSuspensionMinSeverity`** — Suspend Contributions Above Severity · `Number` · default `0.25` · sweep: opt · conditional · via ECONOMIC_REGIMES
  Halting contributions is not what a household does over every dip. The shock preset's `severity` is its measured trough depth (0-1) and is the MC/optimizer knob, so a threshold stated here tracks a severity sweep instead of being frozen into the regime tag. At the 0.25 default a mild correction (0.115) and COVID (0.19) pass through untouched, while a GFC (0.51), a lost decade (0.51) or a dot-com bust (0.35) trips it. A shock carrying no severity (a custom or curve shock) always qualifies — an absent number is missing information, not evidence of mildness. Set 0 to react to every tagged shock.
- **`downturnConversionAmount`** — Downturn Roth Conversion (\$) · `Number` · default `20000` · sweep: opt · conditional · via ECONOMIC_REGIMES
  Fixed dollar amount to convert from IRA → Roth on each qualifying regime entry (design/29 §3.6)
- **`panicFraction`** — Panic Sell Fraction · `Number` · default `0.3` · sweep: opt · conditional · via ECONOMIC_REGIMES
  Fraction of EQUITY holdings rotated to CASH on PANIC_SELL_TRIGGER regime entry (design/29 §3.1). Multiplied by regime severity.
- **`poolBondYears`** — Bond Pool (years of spend) · `Number` · default — · sweep: opt · conditional · via ECONOMIC_REGIMES
  YEARS_OF_SPEND only (design 97 §9). Size of the BOND pool in years of current annual spending. Filled after the cash pool and before gold, with EQUITY taking whatever is left — so a book too small for both pools ends up all cash and no equity rather than a shrunken copy of a mix it cannot afford. NOTE this sizes the MIX, not where it sits: with the default LOCATED policy bonds go to the tax-favoured wrappers, which for a pre-60 household are age-gated and are not cover for anyone. For accessible cover, also author allocationLocationPolicy with the taxable roles first for BOND and CASH.
- **`poolCashYears`** — Cash Pool (years of spend) · `Number` · default — · sweep: opt · conditional · via ECONOMIC_REGIMES
  YEARS_OF_SPEND only (design 97 §9). Size of the CASH pool as a number of years of CURRENT annual spending, resolved every period against the live, inflated spend line rather than authored as a percentage. A percentage cannot hold a number of years: measured on the reference plan a fixed BOND percentage ran 3.5 years of cover in 2027 to 13.6 by 2042 with no crash, and fell to 4.5 with one — it over-provisions as the book grows and under-provisions after a crash, which is inverted from what a reserve is for. Blank ⇒ the mode falls back to the authored mix.
- **`rebalanceDriftBand`** — Rebalance Drift Band · `Number` · default `0.05` · sweep: opt · conditional · via ECONOMIC_REGIMES
  Allocation drift threshold that triggers a rebalance (default 0.05 = 5 percentage points)
- **`rebalanceTargetAllocation`** — Rebalance Target Allocation · `MixList` · default — · conditional · via ECONOMIC_REGIMES
  Target allocation fractions for opportunistic rebalance. E.g. {"EQUITY":0.60,"BOND":0.40}. Null = 60/40 default.
- **`taxGainHarvestBracketCeiling`** — Tax-Gain Harvest Ceiling · `Number` · default `0` · sweep: opt · conditional · via ECONOMIC_REGIMES
  0% LTCG bracket ceiling (USD). Gains realized up to this threshold in low-income years at zero tax cost (design/29 §3.8). Set to 0 to disable.
- **`taxLossHarvestCap`** — TLH Cap (\$/yr) · `Number` · default — · sweep: opt · conditional · via ECONOMIC_REGIMES
  Optional POLICY cap on how much loss to realize per year — blank (the default) = no cap. It is deliberately NOT the \$3,000 figure any more (design 94 §8.1h): that is §1211(b)'s limit on capital loss deductible against ORDINARY income, it is already applied on the return along with the §1212(b) carryforward, and capping the harvest at it limited the same loss twice — so the strategy could never accumulate the carryforward that is most of what it is for. Set it only if the household genuinely will not sell more than this in a year.
- **`taxLossHarvestOnRegimeEntry`** — TLH on Regime Entry · `Boolean` · default `true` · sweep: opt · conditional · via ECONOMIC_REGIMES
  Also trigger tax-loss harvesting on PANIC_SELL_TRIGGER regime entry, not just at year-end

### Company Equity (1)

- **`companySaleYear`** — Company Sale Year · `Number` · default `2033` · via SCENARIO
  Calendar year the company equity stake is sold (null = no planned sale)

### Contributions (13)

- **`iraAnnualContribution`** — IRA Annual Contribution · `Money` · default `0` · USD · sweep: opt · via US_RETIREMENT
  HOUSEHOLD DEFAULT deductible Traditional IRA contribution per employed person per year, overridden by a Person's own election; paid in twelfths from the cash pool.
- **`k401AnnualCap`** — 401(k) Annual Cap · `Money` · default — · USD · via US_RETIREMENT
  HOUSEHOLD DEFAULT annual dollar cap, applied to the deferral and to the match separately; empty means uncapped. Overridden by a Person's own cap. A scenario-level assumption, NOT an indexed statutory limit — this model carries no §402(g) schedule.
- **`k401DeferralPct`** — 401(k) Employee Deferral · `Number` · default `0` · sweep: opt · via US_RETIREMENT
  HOUSEHOLD DEFAULT for the employee 401(k) deferral, as a fraction of annual pay (0.10 = 10%). A Person's own election overrides it, and an explicit 0 on a Person opts them out entirely (design 95 §7.1). Pre-tax: it leaves the cash pool and reduces taxable income. Applies to every employed person until their retirement date.
- **`k401EmployerMatchPct`** — 401(k) Employer Match · `Number` · default `0` · via US_RETIREMENT
  HOUSEHOLD DEFAULT for the employer 401(k) match, as a fraction of annual pay; a Person's own election overrides it. Employer-funded: it never debits the household cash pool and is not the employee's deduction.
- **`k401MatchTiers`** — 401(k) Match Formula · `Json` · default — · via US_RETIREMENT
  HOUSEHOLD DEFAULT match formula as tiers, e.g. [{"matchRate":1,"uptoPctOfComp":0.03},{"matchRate":0.5,"uptoPctOfComp":0.02}] for the safe-harbor basic match (100% of the first 3%, 50% of the next 2%). Tiers consume the deferral in order, so someone deferring less than the band is matched only what they deferred. Empty falls back to the 401(k) Employer Match rate read as a 100% match on that first N% of pay.
- **`k401NonElectivePct`** — 401(k) Non-Elective Contribution · `Number` · default `0` · via US_RETIREMENT
  HOUSEHOLD DEFAULT employer contribution as a fraction of annual pay that does NOT depend on the employee deferring anything — a profit-sharing or safe-harbor non-elective contribution. This is not a match and is deliberately a separate field. Employer-funded, and it counts toward the §415(c) annual-additions limit.
- **`rothAnnualContribution`** — Roth Annual Contribution · `Money` · default `0` · USD · sweep: opt · via US_RETIREMENT
  HOUSEHOLD DEFAULT after-tax Roth contribution per employed person per year, overridden by a Person's own election; paid in twelfths from the cash pool. No income phase-out is modelled.
- **`superGuaranteeAnnualCap`** — Super Guarantee Annual Cap · `Money` · default — · AUD · via AU_RETIREMENT
  HOUSEHOLD DEFAULT annual cap on the employer contribution, overridden by a Person's own cap; empty means uncapped. A scenario assumption, not the SGAA s10A(5) maximum contributions base — that arrives in design 95 phase 7.
- **`superGuaranteePct`** — Super Guarantee Rate · `Number` · default `0` · via AU_RETIREMENT
  HOUSEHOLD DEFAULT for the employer Superannuation Guarantee, as a fraction of annual pay (0.12 = 12%); a Person's own election overrides it. Employer-funded: it is on top of the quoted salary, never debits the member's cash and is outside their assessable income — only the fund's 15% Div 295 contributions tax applies. A scenario assumption, NOT a legislated schedule; this model carries no SG rate table.
- **`superNonConcessionalContribution`** — Non-Concessional Super Contribution · `Money` · default `0` · AUD · sweep: opt · via AU_RETIREMENT
  HOUSEHOLD DEFAULT annual non-concessional super contribution, spread evenly across the year; a Person's own election overrides it. Paid from AFTER-TAX AU cash and arriving in the fund IN FULL — no 15% Div 295 tax and no deduction. Money already taxed at the member's marginal rate is not taxed again on the way in. UNCAPPED until design 95 phase 7 adds Div 292 and the transfer-balance-cap stop.
- **`superPersonalDeductibleContribution`** — Personal Deductible Super Contribution · `Money` · default `0` · AUD · sweep: opt · via AU_RETIREMENT
  HOUSEHOLD DEFAULT annual personal super contribution claimed as a deduction under ITAA97 s290-150, spread evenly across the year; a Person's own election overrides it. Paid from AFTER-TAX AU cash, taxed 15% in the fund, and deducted on the member's return — so it reaches nearly the same place as salary sacrifice but up to a year later in cash-flow terms. The deduction is limited by s26-55 to assessable income before tax losses: it can reduce taxable income to zero but cannot create a loss, and any excess is lost rather than carried. UNCAPPED until design 95 phase 7 adds Div 291.
- **`superSalarySacrificePct`** — Salary Sacrifice Rate · `Number` · default `0` · sweep: opt · via AU_RETIREMENT
  HOUSEHOLD DEFAULT salary sacrifice into super, as a fraction of annual pay (0.05 = 5%); a Person's own election overrides it. PRE-TAX: the employer diverts it before paying, so it reduces both the cash received and assessable income, and the fund takes the 15% Div 295 tax on the way in. It does NOT reduce the Super Guarantee — SGAA s10A(1)(h) counts a sacrificed reduction as qualifying earnings. Employees only; a self-employed person uses the personal deductible contribution instead. UNCAPPED until design 95 phase 7 adds Div 291.
- **`withholdingMethod`** — Payroll Withholding · `Enum` · default `FICA_ONLY` · one of `FICA_ONLY`, `NONE` · via US_RETIREMENT
  How much of a US paycheque is withheld before it reaches the household. FICA_ONLY withholds Social Security and Medicare exactly — they are a rate times a base, so no estimate is involved — and leaves income tax to settle annually with the withholding credited against it. NONE credits the wage gross and settles everything annually (pre-design-95 behaviour). Income-tax withholding is not modelled: real withholding follows the Form W-4 / Pub 15-T tables, which this model does not carry.

### Cross Border (6)

- **`auInflationRate`** — AU Inflation Rate (cross-border) · `Number` · default `0.03` · sweep: mc · via US_AU_CROSS_BORDER
  AU inflation rate when running combined US+AU scenario
- **`exchangeRateUsdToAud`** — Exchange Rate USD→AUD · `Number` · default `1.55` · sweep: mc · via US_AU_CROSS_BORDER
  USD to AUD exchange rate applied on international transfers
- **`intlTransferFeeUsd`** — International Transfer Fee (USD) · `Number` · default `15` · sweep: mc · via US_AU_CROSS_BORDER
  Fixed fee per international wire transfer in USD
- **`moveYear`** — US→AU Move Year · `Number` · default — · sweep: mc+opt · via US_AU_CROSS_BORDER
  Calendar year of US→AU migration (Jul 1). Leave unset for no move.
- **`startingResidency`** — Starting Residency · `Enum` · default — · one of `US`, `AU` · sweep: opt · via US_AU_CROSS_BORDER
  Starting country of tax residency for all persons (e.g. "US", "AU"). Defaults to "US" when unset.
- **`usFeieElected`** — US FEIE Elected (Form 2555) · `Boolean` · default `false` · sweep: opt · via US_AU_CROSS_BORDER
  Elect the US Foreign Earned Income Exclusion on AU-source earned income (design 52 §4.2). Off by default; a future lever bound by the 5-year revocation lock.

### Early Withdrawal (8)

- **`earlyWithdrawalBeforeBrokerage`** — Early Withdrawal Before Brokerage · `Boolean` · default `false` · via US_EARLY_WITHDRAWAL
  When covering a spending shortfall, tap penalty early withdrawal BEFORE selling taxable brokerage (avoid realizing capital gains), rather than strictly last. Default off.
- **`earlyWithdrawalDay`** — Early Withdrawal Day · `Number` · default `1` · via US_EARLY_WITHDRAWAL
  Day of month the withdrawal fires
- **`earlyWithdrawalEnabled`** — Early Withdrawal Enabled · `Boolean` · default `false` · via US_EARLY_WITHDRAWAL
  Enable the scheduled early-withdrawal decant lever (design 45)
- **`earlyWithdrawalEndYear`** — Early Withdrawal Optimization End Year · `Number` · default — · via US_EARLY_WITHDRAWAL
  Last year of the opt-in optimization window. null = no window.
- **`earlyWithdrawalMonth`** — Early Withdrawal Month · `Number` · default `12` · via US_EARLY_WITHDRAWAL
  Month (1–12) the withdrawal fires each scheduled year
- **`earlyWithdrawalOwner`** — Early Withdrawal Owner · `Enum` · default `primary` · one of `primary`, `spouse`, `both` · via US_EARLY_WITHDRAWAL
  Whose accounts to draw: 'primary', 'spouse', or 'both' (amounts apply per owner)
- **`earlyWithdrawalSchedule`** — Early Withdrawal Schedule (per-year per-class amounts) · `EarlyWithdrawalScheduleList` · default `` · via US_EARLY_WITHDRAWAL
  Per-year decant schedule [{ year, taxDeferredAmount, rothAmount, destinationKey? }]. Amounts are REAL base-year (2025) USD GROSS, compounded by inflation to the year's nominal draw; routed NET (gross − 10% penalty) to destinationKey. `destinationKey` is either a state key (all owners) or an object keyed by ownerId, e.g. { primary: 'usStockAccount', spouse: 'sharedBrokerageAccount' }; omitted or an absent owner falls back to that owner's first us-stock account. Years absent = no withdrawal.
- **`earlyWithdrawalStartYear`** — Early Withdrawal Optimization Start Year · `Number` · default — · via US_EARLY_WITHDRAWAL
  First year of the opt-in optimization window. Set with the end year to let the MPC cockpit tune/discover early withdrawals. null = no window (manual schedule only).

### Economic Shocks (52)

- **`auYieldCurveShape`** — AU Yield Curve Shape · `YieldCurveShape` · default — · via ECONOMIC_REGIMES
  Optional AU term-structure overlay (design 67): an array of { tenor, spread } anchor points added to the FIXED_INCOME_AU level, linearly interpolated and clamped to the endpoints. Independent of the US shape. Absent/empty ⇒ a flat curve.
- **`equityReturnBeta`** — Equity Return Betas · `RateKeyMap` · default — · one of `EQUITY_AU`, `EQUITY_INTL_EX_AU`, `EQUITY_INTL_EX_US`, `EQUITY_US` · via ECONOMIC_REGIMES
  Optional per-market override of each equity market's loading on the shared market factor (the US market), keyed by MARKET rate key (EQUITY_US, EQUITY_AU, EQUITY_INTL_EX_US, EQUITY_INTL_EX_AU). Absent keys use the sourced defaults (design 90 §7.4): US 1.0 / intl ex-US 0.85 / intl ex-AU 0.81 / AU 0.43. The CO-MOVEMENT half — the idiosyncratic volatility is the dispersion half. Only used when Stochastic Equity Returns is on.
- **`equityReturnBootstrapAuReplay`** — Historical Bootstrap — Replay AU Market History · `Boolean` · default `true` · conditional · via ECONOMIC_REGIMES
  When on (default), the AU market replays its OWN history in the same historical year the US market is replaying (OECD Australian share prices, 1958–2023, after inflation), instead of following the US market through its beta plus random noise. So AU-specific episodes, such as the 11-year recovery after 2008, come through. Rescaled so the AU market's volatility matches your beta and idiosyncratic settings. Historical years before 1958 use the random noise. Price-only data, so year-to-year dividend variation is not included (design 102 §6).
- **`equityReturnBootstrapBlock`** — Historical Bootstrap Block Length (years) · `Number` · default `5` · conditional · via ECONOMIC_REGIMES
  How many consecutive historical years are replayed before jumping to a new random start year (design 102 §4.3). Longer blocks keep more of history's multi-year runs and pull-backs, but draw from fewer distinct sequences. 1 replays single years in random order, which throws away any link between neighbouring years. The default of 5 is the usual n^(1/3) rule for a 153-year series. Only used with the Historical bootstrap model.
- **`equityReturnDriftComp`** — Equity Return Drift Compensation · `Enum` · default `GEOMETRIC` · one of `GEOMETRIC`, `NONE` · via ECONOMIC_REGIMES
  How the growth-rate anchor is interpreted once returns are stochastic (design 74 §5.3). Adding a mean-0 shock to a multiplicatively-applied rate lowers the realized geometric (compounded) return by ≈σ²/2. GEOMETRIC (default) adds σ²/2 back per sleeve so the anchor reads as the CAGR you expect to earn and turning volatility on changes only the SPREAD, not the centre. NONE interprets the anchor as an ARITHMETIC mean and leaves the ≈σ²/2 volatility drag in (at σ=0.18 that is ≈−1.6pp/yr). Also governs the stochastic PROPERTY return path (design 75). Only used when Stochastic Equity Returns or Stochastic Property Returns is on.
- **`equityReturnIdioVol`** — Equity Return Idiosyncratic Volatility · `RateKeyMap` · default — · one of `EQUITY_AU`, `EQUITY_INTL_EX_AU`, `EQUITY_INTL_EX_US`, `EQUITY_US` · via ECONOMIC_REGIMES
  Optional per-market override of each equity market's own (idiosyncratic) return sd, keyed by MARKET rate key. It is what lets one market fall while another rises. Absent keys use the sourced defaults (design 90 §7.4): US 0 (it is the market factor) / intl ex-US 8.5% / intl ex-AU 2.0% / AU 13.0%. Set a market to 0 to make it a pure multiple of the US market. Only used when Stochastic Equity Returns is on.
- **`equityReturnModel`** — Equity Return Process Model · `Enum` · default `WHITE_NOISE` · one of `NONE`, `WHITE_NOISE`, `RANDOM_WALK`, `MEAN_REVERTING`, `HISTORICAL_BOOTSTRAP` · via ECONOMIC_REGIMES
  Process for the market factor. White noise (WHITE_NOISE, default) draws an independent shock each year. Annual US returns since 1871 have a lag-1 autocorrelation of +0.01, so this matches history year to year. Historical bootstrap (HISTORICAL_BOOTSTRAP, design 102) replays blocks of consecutive real historical years (US 1871–2023), re-centred on your anchor and rescaled to Equity Return Volatility; the AU market replays its own history for the same year from 1958 (Historical Bootstrap — Replay AU Market History). That keeps history's fat left tail and its mild multi-year pull-back without fitting a parameter to either. Persistent returns (MEAN_REVERTING) applies an Ornstein-Uhlenbeck step to the RETURN, so consecutive years are POSITIVELY correlated at e^(-k): +0.74 at the default k=0.3, against history's +0.01. Long-run outcomes spread about 3.5× wider than white noise, so treat it as a stress test, not a realistic world (design 97 §20.9, design 102 §2). No process makes a crash predict a rebound. Only used when Stochastic Equity Returns is on. Monte Carlo turns that on for every path, and uses its own process setting (Monte Carlo: Equity Return Process, default Historical bootstrap) unless that is set to "Same as single runs".
- **`equityReturnReversionSpeed`** — Equity Return Persistence (OU pull-back speed k) · `Number` · default `0.3` · conditional · via ECONOMIC_REGIMES
  Ornstein-Uhlenbeck pull-back speed k, per year. Consecutive annual returns end up correlated at e^(-k), which is POSITIVE — so a LOWER k is MORE persistent (k=0.15 measures +0.83; k=0.9 measures +0.41), and this is a momentum knob, not a rebound one. Unlike the FX and yield-curve reversion speeds, which run on levels and do mean-revert, this runs on a return. Ignored under WHITE_NOISE. No setting of it makes a down year predict an up year: see design 97 §20.9 for what that rules out. Only used when Stochastic Equity Returns is on with MEAN_REVERTING.
- **`equityReturnStochastic`** — Stochastic Equity Returns · `Boolean` · default `false` · via ECONOMIC_REGIMES
  When on (design 74), each year draws its own equity return from a seeded process instead of holding one constant rate for the whole run — so Monte Carlo measures sequence-of-returns risk, not just uncertainty about the long-run average. One shared market factor drives every equity sleeve (via per-sleeve beta), so systematic risk survives portfolio aggregation. Off by default ⇒ no randomness drawn, runs stay byte-identical. Reproducible: the rng cursor is snapshot-safe. NOTE (Phase 1): the anchor is treated as an ARITHMETIC mean, so turning this on lowers the realized geometric return by ≈σ²/2 (volatility drag). Geometric drift compensation is design 74 Phase 3. Monte Carlo turns this on for every iteration regardless (see "Monte Carlo: Stochastic Return Path"); this switch governs single runs.
- **`equityReturnVol`** — Equity Return Volatility · `Number` · default `0.18` · sweep: mc · via ECONOMIC_REGIMES
  Annualized standard deviation (in rate units, e.g. 0.18 = 18%) of the shared equity MARKET factor — the US market's own volatility (0.18 is the mean of J.P. Morgan's and BlackRock's, design 90 §7.4). Each market loads on it by its beta (US 1.0; intl ex-US 0.85; intl ex-AU 0.81; AU 0.43) and adds its own idiosyncratic volatility. Only used when Stochastic Equity Returns is on.
- **`inflationGlobalReversionSpeed`** — Inflation Path Global Reversion Speed (k) · `Number` · default `0.1` · conditional · via ECONOMIC_REGIMES
  How quickly the shared global inflation cycle fades, per year: 0.1 keeps 0.90 of it each year, a half-life of about 7 years, so it moves on the scale of decades. Only used when Inflation Path Global Share is above 0.
- **`inflationGlobalShare`** — Inflation Path Global Share · `Number` · default `0.4` · conditional · via ECONOMIC_REGIMES
  How much of each country's inflation swings comes from a slow global cycle shared by the US and AU, from 0 (none) to 1 (all). History has both high together in the 1970s and low together since the 1990s: their inflation LEVELS correlated at 0.59 over 1951–2023, even though their yearly surprises correlated at only 0.26–0.35. 0.4 reproduces that (design 103 §10.2). 0 lets the two countries drift apart for years.
- **`inflationGlobalShareJoint`** — Inflation Path Global Share (joint mode) · `Number` · default `0.2` · conditional · via ECONOMIC_REGIMES
  The global cycle's share when inflation is historical and joint with equity (Monte Carlo's default). It is smaller than Inflation Path Global Share because in this mode the global cycle is built from the same historical years as each country's own surprises, so it already moves with them. 0.2 reproduces history's 0.59 US–AU level correlation; 0.4 would give about 0.73 (design 103 §10.4).
- **`inflationLowerBoundAu`** — Inflation Lower Bound — AU · `Number` · default `-0.01` · conditional · via ECONOMIC_REGIMES
  The rate AU inflation approaches in its lowest years but never crosses (1.4% of AU years since 1951 were below 0, none below −0.3%). −0.01 puts about 1% of years below zero.
- **`inflationLowerBoundUs`** — Inflation Lower Bound — US · `Number` · default `-0.01` · conditional · via ECONOMIC_REGIMES
  The rate US inflation approaches in its lowest years but never crosses (design 103 §10.1). Inflation is modelled as this bound plus a skewed distance above it, so it can spike up but only drifts gently down, and its swings grow when it runs high, as it has since 1951 (2.7% of US years below 0, none below −0.7%). −0.01 puts about 1% of years below zero.
- **`inflationModel`** — Inflation Process Model · `Enum` · default `GAUSSIAN` · one of `GAUSSIAN`, `HISTORICAL_JOINT` · conditional · via ECONOMIC_REGIMES
  Gaussian (default): a mean-reverting walk calibrated to post-war inflation, with US and AU correlated. Historical, joint with equity: each year's inflation surprise is the one from the SAME post-war historical year (1951–2023) the equity bootstrap is replaying, so a 1970s stretch brings its high inflation and its poor real returns together. Nominal equity returns also carry the inflation surprise, and bond yields follow that year's 10-year yield change when Stochastic Yield Curve is on. Joint mode needs the equity path on with Historical bootstrap; otherwise it runs as Gaussian.
- **`inflationPathCorrelation`** — Inflation Path US–AU Correlation · `Number` · default `0.35` · conditional · via ECONOMIC_REGIMES
  Correlation between each year's US and AU inflation surprises (0.35 = the measured correlation of their year-on-year changes, 1951–2024). Gaussian only; joint mode uses the historical years' own correlation.
- **`inflationPathFloor`** — Inflation Path Floor · `Number` · default `-0.05` · conditional · via ECONOMIC_REGIMES
  A hard lower clamp on the yearly inflation rate, applied after everything else, including shocks and regimes (−0.05 = 5% deflation). The path itself approaches Inflation Lower Bound instead and practically never reaches this.
- **`inflationPathVolAu`** — Inflation Path Volatility — AU · `Number` · default `0.03` · conditional · via ECONOMIC_REGIMES
  How far AU inflation wanders from its anchor. AU's post-war measurement (4.4 points) is dominated by the 1970s–80s wage spiral and the 1951 wool boom, so 3.0 is the default (design 103 §4.1). The swings are skewed, bigger upward than downward, and shrink when the anchor sits close to Inflation Lower Bound (design 103 §10.1).
- **`inflationPathVolUs`** — Inflation Path Volatility — US · `Number` · default `0.028` · conditional · via ECONOMIC_REGIMES
  How far US inflation wanders from its anchor: the long-run standard deviation of the yearly rate (0.028 = 2.8 points, measured on US CPI 1951–2023, design 103 §2). The swings are skewed, bigger upward than downward, and shrink when the anchor sits close to Inflation Lower Bound (design 103 §10.1).
- **`inflationReversionSpeedAu`** — Inflation Reversion Speed — AU (k) · `Number` · default `0.33` · conditional · via ECONOMIC_REGIMES
  How quickly an AU inflation surprise fades, per year. Defaults to the US value; AU's own post-war measurement is 0.46 (half-life about 1.5 years).
- **`inflationReversionSpeedUs`** — Inflation Reversion Speed — US (k) · `Number` · default `0.33` · conditional · via ECONOMIC_REGIMES
  How quickly a US inflation surprise fades, per year. This year's deviation keeps e^(−k) of last year's: 0.33 keeps 0.72, a half-life of about 2 years, matching US CPI 1951–2023. Lower is more persistent. Unlike the equity persistence knob, this runs on a LEVEL, so it genuinely mean-reverts.
- **`inflationStochastic`** — Stochastic Inflation · `Boolean` · default `false` · via ECONOMIC_REGIMES
  When on (design 103), each country's inflation wanders around its anchor (Inflation Rate / AU Inflation Rate) year by year, with post-war persistence: a high-inflation year tends to be followed by another. Everything priced in today's money follows it: expenses, wages, Social Security, tax brackets, TIPS and house running costs. Off by default, so runs stay byte-identical. Monte Carlo turns it on for every path (Monte Carlo: Stochastic Inflation Path); this switch governs single runs.
- **`mcEquityReturnModel`** — Monte Carlo: Equity Return Process · `Enum` · default `HISTORICAL_BOOTSTRAP` · one of `SCENARIO`, `NONE`, `WHITE_NOISE`, `RANDOM_WALK`, `MEAN_REVERTING`, `HISTORICAL_BOOTSTRAP` · conditional · via ECONOMIC_REGIMES
  The equity return process every Monte Carlo path runs. The default, Historical bootstrap, replays blocks of real historical years (US 1871–2023, and AU's own history from 1958) re-centred on your anchor, and matches history better than white noise on autocorrelation, multi-year pull-back and crash skew (design 102 §2). "Same as single runs" uses Equity Return Process Model instead. Only used when Monte Carlo: Stochastic Return Path is on.
- **`mcInflationModel`** — Monte Carlo: Inflation Process · `Enum` · default `AUTO` · one of `AUTO`, `SCENARIO`, `GAUSSIAN`, `HISTORICAL_JOINT` · conditional · via ECONOMIC_REGIMES
  The inflation process every Monte Carlo path runs. Automatic (default) samples inflation jointly with equity whenever the Monte Carlo equity process is the historical bootstrap, so each path's inflation surprises, equity returns and yield changes come from the same historical years.
- **`mcInflationPath`** — Monte Carlo: Stochastic Inflation Path · `Boolean` · default `true` · via ECONOMIC_REGIMES
  When on (default), every Monte Carlo path runs the stochastic inflation path on top of its sampled inflation anchor, so each path lives through its own inflation history, including high-inflation decades. Single runs are unaffected. Turn off to hold each path's inflation at its sampled rate.
- **`mcPrimeRateModel`** — Monte Carlo: Prime Rate Mode · `Enum` · default `AUTO` · one of `AUTO`, `SCENARIO`, `SCHEDULE`, `INFLATION_LINKED` · via ECONOMIC_REGIMES
  The prime rate mode every Monte Carlo path runs. Automatic (default): a plan that set Prime Rate Mode to "Follows inflation", or has no Prime Rate Schedule, follows each path's inflation. A plan with a schedule keeps it, since the two modes are either/or. Following inflation needs Monte Carlo: Stochastic Inflation Path on.
- **`mcSequenceRisk`** — Monte Carlo: Stochastic Return Path · `Boolean` · default `true` · via ECONOMIC_REGIMES
  When on (default), every Monte Carlo iteration runs the stochastic equity return path — its own year-by-year returns, with the markets able to diverge — on top of the sampled long-run mean (Equity Return Shift). Single runs are unaffected. Turn off to make Monte Carlo sample the long-run mean only.
- **`primeFloorAu`** — Prime Follows Inflation — AU Floor · `Number` · default `0.001` · conditional · via ECONOMIC_REGIMES
  The lowest the AU cash rate can go when following inflation (0.001 = 0.10%, the RBA's 2020–22 low). Only used when Prime Rate Mode is "Follows inflation".
- **`primeFloorUs`** — Prime Follows Inflation — US Floor · `Number` · default `0.0025` · conditional · via ECONOMIC_REGIMES
  The lowest the US policy rate can go when following inflation (0.0025 = 0.25%, where the Fed held it in 2009–15 and 2020–21). Only used when Prime Rate Mode is "Follows inflation".
- **`primeInflationResponseAu`** — Prime Follows Inflation — AU Response (β) · `Number` · default `1.3` · conditional · via ECONOMIC_REGIMES
  How far the AU cash rate eventually moves per point of AU inflation above or below its anchor. Defaults to the US post-war value; the RBA measured 1.76 over 1991–2024, a short and calm sample. Only used when Prime Rate Mode is "Follows inflation".
- **`primeInflationResponseUs`** — Prime Follows Inflation — US Response (β) · `Number` · default `1.3` · conditional · via ECONOMIC_REGIMES
  How far the US policy rate eventually moves per point of inflation above or below its anchor: 1.3 means a sustained +1 point of inflation ends up raising prime 1.3 points. Measured at 1.27–1.31 on US rates 1955–2025 (1.98 since 1983). Above 1 is the "Taylor principle": real rates rise when inflation does. Only used when Prime Rate Mode is "Follows inflation".
- **`primeInflationSmoothingAu`** — Prime Follows Inflation — AU Smoothing (ρ) · `Number` · default `0.75` · conditional · via ECONOMIC_REGIMES
  How gradually the AU cash rate moves: the share of last year's gap it keeps. 0.75 is the RBA's measured value for 1991–2024 (25% of the gap a year). Only used when Prime Rate Mode is "Follows inflation".
- **`primeInflationSmoothingUs`** — Prime Follows Inflation — US Smoothing (ρ) · `Number` · default `0.6` · conditional · via ECONOMIC_REGIMES
  How gradually the US rate moves: the share of last year's gap it keeps. 0.6 closes 40% of the gap to its target each year; 0 moves all the way at once; closer to 1 is slower. Measured at 0.61–0.63 on US rates 1955–2025. Only used when Prime Rate Mode is "Follows inflation".
- **`primePolicyNoiseAu`** — Prime Follows Inflation — AU Policy Noise · `Number` · default `0` · conditional · via ECONOMIC_REGIMES
  Optional yearly random AU policy moves that inflation doesn't explain, as a standard deviation (history: about 0.9 points since 1991). 0 (default) = off. Only used when Prime Rate Mode is "Follows inflation".
- **`primePolicyNoiseUs`** — Prime Follows Inflation — US Policy Noise · `Number` · default `0` · conditional · via ECONOMIC_REGIMES
  Optional yearly random policy moves that inflation doesn't explain, as a standard deviation (0.013 = 1.3 points, the size history shows around the inflation rule). 0 (default) = off: the rate answers inflation only. Only used when Prime Rate Mode is "Follows inflation".
- **`primeRateModel`** — Prime Rate Mode · `Enum` · default `SCHEDULE` · one of `SCHEDULE`, `INFLATION_LINKED` · via ECONOMIC_REGIMES
  How the US and AU prime (central-bank policy) rates move during the run. Choose ONE. "Fixed, or stepped by the Prime Rate Schedule": the rates stay at US / AU Prime Rate, except where a Prime Rate Schedule row sets them for a year. "Follows inflation": each year the rates move toward the inflation path the way central banks have since 1955 (design 104), and the schedule is ignored. That mode needs Stochastic Inflation on; Monte Carlo turns inflation on by default. Either way, prime-linked cash accounts and variable-rate loans follow prime plus their spread.
- **`primeSchedule`** — Prime Rate Schedule · `PrimeScheduleList` · default `` · conditional · via ECONOMIC_REGIMES
  Used only when Prime Rate Mode is "Fixed, or stepped by the Prime Rate Schedule" (not with "Follows inflation"). Optional per-year central-bank policy path: each row sets the absolute PRIME_US / PRIME_AU rate taking effect that year and holding until the next row. A step compiles into a scheduled Prime move that fans out to every Prime-linked cash account and variable loan (design 56 §5).
- **`propertyReturnBeta`** — Property Return Betas · `RateKeyMap` · default — · one of `REAL_ESTATE_AU`, `REAL_ESTATE_US` · via ECONOMIC_REGIMES
  Optional per-sleeve override of each real-estate sleeve's loading on the shared market factor, keyed by rate key (REAL_ESTATE_US, REAL_ESTATE_AU). Absent keys fall back to the near-zero defaults (US 0.03 / AU 0.05). Raise a beta to model a standing correlation with equities; the default assumes almost none (design 75 §4.1). Only used when Stochastic Property Returns is on.
- **`propertyReturnIdioScale`** — Property Idiosyncratic Vol Scale · `Number` · default `1` · sweep: mc · via ECONOMIC_REGIMES
  Monte Carlo multiplier on every property sleeve's idiosyncratic appreciation vol (design 75 §6.4). 1.0 = the calibrated defaults (US 0.09 / AU 0.10); sweeping it widens/narrows single-home price variance — the sequence/timing risk on the house at its sale date. Only bites when Stochastic Property Returns is on; inert (1.0) otherwise.
- **`propertyReturnIdioVol`** — Property Return Idiosyncratic Volatility · `RateKeyMap` · default — · one of `REAL_ESTATE_AU`, `REAL_ESTATE_US` · via ECONOMIC_REGIMES
  Optional per-sleeve idiosyncratic (property-specific) appreciation sd, keyed by rate key. This is where most of a single home's price variance comes from under the near-zero betas. Absent ⇒ the defaults (US 0.09 / AU 0.10, giving a total single-home σ ≈ 9–10%). Only used when Stochastic Property Returns is on.
- **`propertyReturnStochastic`** — Stochastic Property Returns · `Boolean` · default `false` · via ECONOMIC_REGIMES
  When on (design 75), each real property draws its own appreciation each year from a seeded process instead of ramping at a constant appreciationRate — so a house has real sale-price variance at its sale date (the sequence/timing risk on the binding asset). When Stochastic Equity Returns is ALSO on, property REUSES the same market factor so housing co-moves with equities (design 74 §7); when equity is off, property draws its own market shock. Default betas are near zero (US 0.03 / AU 0.05) because the historical house↔equity correlation is ~0.04 — the joint crash is authored via shocks[], not the beta — so housing is ~99% idiosyncratic. Off by default ⇒ no randomness drawn, runs stay byte-identical. Reproducible: the rng cursor is snapshot-safe.
- **`randomSeed`** — Random Seed · `Number` · default — · via ECONOMIC_REGIMES
  Seed for the simulation's in-loop RNG — the single sequence every stochastic process draws from: FX (design 47), the yield curve (design 67) and equity return paths (design 74). null = 1, so a default run is unchanged. Changing it draws a DIFFERENT path from the same distribution, which is how a single deterministic run is varied without a Monte Carlo. Monte Carlo ignores this: it supplies its own per-iteration seed, and must, or every path would collapse onto one ordering.
- **`repairFreqScale`** — House Repair Frequency Scale · `Number` · default `1` · sweep: mc · via ECONOMIC_REGIMES
  Monte Carlo multiplier on the annual probability (Bernoulli) or rate (Poisson) of a stochastic house repair (design 75 §5.2/§6.4). 1.0 = each property's configured repairProb/repairLambda; sweeping it varies how OFTEN the lump lands. Only bites when a property has a repair model; inert (1.0) otherwise.
- **`repairSeverityScale`** — House Repair Severity Scale · `Number` · default `1` · sweep: mc · via ECONOMIC_REGIMES
  Monte Carlo multiplier on the median size of every stochastic house-repair event (design 75 §5.2/§6.4). 1.0 = each property's configured repairMedian/repairValuePct; sweeping it stress-tests how the lumpy repair cost bites liquidity. Only bites when a property has a repair model; inert (1.0) otherwise.
- **`rngStreams`** — Paired RNG Streams · `Boolean` · default `false` · via ECONOMIC_REGIMES
  Draw each stochastic process from its OWN year-keyed stream instead of one shared cursor, so that two scenarios differing in policy experience the SAME realised path. Off (the default) every process draws from `sim.rng` in whatever order the event queue runs them, which is fine for one run and misleading for a comparison: measured on a paycheck-vs-no-paycheck pair, both arms drew the identical 1,862 values in the identical order and still diverged, because the same value landed on a different DATE in each — a z that is 2035's equity shock in one arm is 2036's in the other. On, a draw is a pure function of (seed, process, year), so nothing another process does can shift it and the difference between two arms is causal. Turning it on CHANGES the path a given seed produces, so it is a property of a STUDY, not a better setting: switch it on for every arm of a comparison, or none.
- **`shocks`** — Economic Shocks · `ShockList` · default `` · one of `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]`, `[object Object]` · via ECONOMIC_REGIMES
  List of financial shocks to apply. Each entry can reference a library preset or define a custom shock.
- **`usYieldCurveShape`** — US Yield Curve Shape · `YieldCurveShape` · default — · via ECONOMIC_REGIMES
  Optional US term-structure overlay (design 67): an array of { tenor, spread } anchor points added to the FIXED_INCOME_US level, linearly interpolated and clamped to the endpoints. The 5-year point is the level anchor (spread 0). Absent/empty ⇒ a flat curve (every tenor = the level), identical to a single fixed-income rate.
- **`yieldCurveReversionSpeed`** — Yield Curve Mean-Reversion Speed · `Number` · default `0.3` · via ECONOMIC_REGIMES
  Ornstein-Uhlenbeck pull-back speed per year toward the anchor level. Higher ⇒ the level snaps back faster. Only used when Stochastic Yield Curve is on.
- **`yieldCurveSchedule`** — Yield Curve Schedule · `YieldCurveSchedule` · default — · via ECONOMIC_REGIMES
  Optional per-year yield-curve path (design 67 §6): an array of { year, US:[{tenor,spread}], AU:[…] } ABSOLUTE target shapes, each taking effect that year and holding until the next row (a step path). Each compiles to a scheduled curve twist that composes with the level move. Empty ⇒ the static default shape.
- **`yieldCurveStochastic`** — Stochastic Yield Curve · `Boolean` · default `false` · via ECONOMIC_REGIMES
  When on (design 67 §6), the fixed-income LEVEL evolves as a seeded mean-reverting (Ornstein-Uhlenbeck) walk each year via the in-loop sim.rng, giving bonds realistic year-to-year rate risk. Off by default ⇒ no randomness drawn, runs stay byte-identical. Reproducible: the rng cursor is snapshot-safe.
- **`yieldCurveVol`** — Yield Curve Volatility · `Number` · default `0.01` · via ECONOMIC_REGIMES
  Annualized standard deviation (in rate units, e.g. 0.01 = 100 bps) of the stochastic level walk. Only used when Stochastic Yield Curve is on.

### FX (4)

- **`fxBasisMethod`** — §988 Lot Consumption Method · `Enum` · default `pro-rata` · one of `pro-rata`, `fifo` · via US_AU_CROSS_BORDER
  Reg. §1.988-2(a)(2)(iii)(B)(1) lets a taxpayer use "any reasonable method consistently applied … to all accounts" and names FIFO, LIFO and pro rata. Pro-rata is the default because it is exactly what a single fxBasisRate scalar implements. FIFO additionally supplies a HOLDING PERIOD, which the personal capital branch needs and pro-rata cannot supply — at the cost of publishing a lot array on every pool. The choice is locked at adoption and binds all future years (design 87 G6).
- **`fxProcessModel`** — FX Rate Process · `Enum` · default `NONE` · one of `NONE`, `WHITE_NOISE`, `RANDOM_WALK`, `MEAN_REVERTING` · via US_AU_CROSS_BORDER
  Time-varying FX model (design 47). NONE = flat (today). MEAN_REVERTING/RANDOM_WALK/WHITE_NOISE vary the rate over time via the seeded RNG.
- **`fxReversionSpeed`** — FX Reversion Speed (per year) · `Number` · default `0.114` · sweep: mc · conditional · via US_AU_CROSS_BORDER
  Mean-reversion speed toward the anchor for the MEAN_REVERTING model — a half-life of about 6.1 years. Fitted to the observed TERM STRUCTURE of FX dispersion over the post-float window, not to the lag-1 autocorrelation: the lag-1 AR(1) estimate on the same data is 0.296, which reproduces 1-year moves and then flattens, understating 10-year dispersion by a third. Still the more window-sensitive of the two knobs (whole series 0.072, post-2000 0.104), so it is worth running as a sensitivity axis rather than trusted as a constant.
- **`fxVolatility`** — FX Volatility (annualized) · `Number` · default `0.1142` · sweep: mc · conditional · via US_AU_CROSS_BORDER
  Annualized log-volatility of the FX rate when a process model is active. Default is calibrated from the published USD/AUD series over the post-float window 1984-01 onward (design 92 §8.1), not assumed — reproduce it with scripts/lab/calibrate-fx.mjs. The whole series and the post-2000 era give 0.111 and 0.120, so this is not sensitive to the window; the original 0.06 default was.

### Market Rates (9)

- **`auEquityDividendYield`** — AU Equity Dividend Yield · `Number` · default `0.0343` · sweep: mc · via ECONOMIC_REGIMES
  The part of the AU Equity total return paid as dividends. Changes how the return is TAXED, not its size: a taxable account pays it out as a dividend and grows by the rest. A security or lot that names its own yield overrides this.
- **`auEquityGrowthRate`** — AU Equity Total Return · `Number` · default `0.067` · sweep: mc · via ECONOMIC_REGIMES
  Expected annual TOTAL return of the AU Equity market — price growth plus dividends. Every equity holding tracking this market earns it, in any account: a taxable account grows by this minus the dividend yield and pays the yield out as a dividend; a retirement account or super grows by the whole of it.
- **`equityAnchorShift`** — Equity Return Shift (all markets) · `Number` · default `0` · sweep: mc · via ECONOMIC_REGIMES
  Added to every equity market's total return at once — one systematic draw, so the markets rise and fall together rather than cancelling out. Monte Carlo samples it; leave it at 0 for a single run. Reaches every holding that tracks a market; not an authored appreciation schedule, and not gold, bonds or cash.
- **`intlExAuEquityDividendYield`** — International ex-AU Equity Dividend Yield · `Number` · default `0.0147` · sweep: mc · via ECONOMIC_REGIMES
  The part of the International ex-AU Equity total return paid as dividends. Changes how the return is TAXED, not its size: a taxable account pays it out as a dividend and grows by the rest. A security or lot that names its own yield overrides this.
- **`intlExAuEquityGrowthRate`** — International ex-AU Equity Total Return · `Number` · default `0.075` · sweep: mc · via ECONOMIC_REGIMES
  Expected annual TOTAL return of the International ex-AU Equity market — price growth plus dividends. Every equity holding tracking this market earns it, in any account: a taxable account grows by this minus the dividend yield and pays the yield out as a dividend; a retirement account or super grows by the whole of it.
- **`intlExUsEquityDividendYield`** — International ex-US Equity Dividend Yield · `Number` · default `0.0253` · sweep: mc · via ECONOMIC_REGIMES
  The part of the International ex-US Equity total return paid as dividends. Changes how the return is TAXED, not its size: a taxable account pays it out as a dividend and grows by the rest. A security or lot that names its own yield overrides this.
- **`intlExUsEquityGrowthRate`** — International ex-US Equity Total Return · `Number` · default `0.069` · sweep: mc · via ECONOMIC_REGIMES
  Expected annual TOTAL return of the International ex-US Equity market — price growth plus dividends. Every equity holding tracking this market earns it, in any account: a taxable account grows by this minus the dividend yield and pays the yield out as a dividend; a retirement account or super grows by the whole of it.
- **`usEquityDividendYield`** — US Equity Dividend Yield · `Number` · default `0.011` · sweep: mc · via ECONOMIC_REGIMES
  The part of the US Equity total return paid as dividends. Changes how the return is TAXED, not its size: a taxable account pays it out as a dividend and grows by the rest. A security or lot that names its own yield overrides this.
- **`usEquityGrowthRate`** — US Equity Total Return · `Number` · default `0.07` · sweep: mc · via ECONOMIC_REGIMES
  Expected annual TOTAL return of the US Equity market — price growth plus dividends. Every equity holding tracking this market earns it, in any account: a taxable account grows by this minus the dividend yield and pays the yield out as a dividend; a retirement account or super grows by the whole of it.

### Mortality (5)

- **`lateLifeCareFactor`** — Late-Life Care Factor · `Number` · default `2` · via US_RETIREMENT
  Multiplier applied to all monthly expenses during the late-life care window
- **`lateLifeCareMonths`** — Late-Life Care Window (months) · `Number` · default `0` · via US_RETIREMENT
  Number of months before death to apply the late-life care expense multiplier; 0 = disabled
- **`mortalityEnabled`** — Mortality Enabled · `Boolean` · default `true` · via US_RETIREMENT
  If true, PERSON_DIED events are scheduled and processed; disable to run to simEnd regardless of lifespan
- **`survivorDiscretionaryMultiplier`** — Survivor Discretionary Multiplier · `Number` · default `0.5` · via US_RETIREMENT
  Fraction of discretionary expenses retained after a spouse dies (default 0.50)
- **`survivorEssentialMultiplier`** — Survivor Essential Multiplier · `Number` · default `0.85` · via US_RETIREMENT
  Fraction of essential expenses retained after a spouse dies (default 0.85)

### Optimization (7)

- **`afterTaxCapGainsRate`** — After-Tax Cap-Gains Rate · `Number` · default `0.15` · via SCENARIO
  Assumed effective long-term capital-gains rate on unrealized brokerage gains (after-tax net-worth metric, design 40).
- **`afterTaxOrdinaryRate`** — After-Tax Ordinary Rate (US) · `Number` · default `0.22` · via SCENARIO
  Assumed effective ordinary-income rate to liquidate a US pre-tax IRA/401(k) dollar (after-tax net-worth metric, design 40).
- **`afterTaxOrdinaryRateAu`** — After-Tax Ordinary Rate (AU/super) · `Number` · default `0.15` · via SCENARIO
  Assumed effective rate to liquidate an AU pre-tax / superannuation dollar (after-tax net-worth metric, design 40).
- **`afterTaxRateMethod`** — After-Tax Rate Method · `Enum` · default `configured` · one of `configured`, `liquidation` · via SCENARIO
  How the after-tax metrics price the embedded liquidation tax: "configured" uses fixed effective rates; "liquidation" stacks the balance through the real tax engine for an effective rate (design 40 Phase 3, US accounts).
- **`assumedGainFraction`** — Assumed Gain Fraction · `Number` · default `0.5` · via SCENARIO
  Fraction of a taxable balance treated as unrealized gain when per-lot cost basis is unavailable (after-tax net-worth metric, design 40).
- **`terminalWealthTarget`** — Terminal Wealth Target (today's USD) · `Number` · default `0` · via SCENARIO
  Net worth to land on at the end of plan ("die with zero, or with \$XX"), in REAL base-year (today's) dollars. The Die With Target objective deflates the nominal terminal wealth by accumulated inflation before comparing, so this matches the real consumption it trades against.
- **`terminalWealthTargetPenalty`** — Terminal Wealth Penalty (λ) · `Number` · default `10` · via SCENARIO
  Penalty weight on missing the terminal wealth target; larger makes the target binding (Die With Target objective).

### Roth Conversion (8)

- **`rothConversionDay`** — Roth Conversion Day · `Number` · default `1` · via US_ROTH_CONVERSION
  Day of month when the policy fires
- **`rothConversionEnabled`** — Roth Conversion Enabled · `Boolean` · default `false` · via US_ROTH_CONVERSION
  Enable bracket-fill Roth conversion policy
- **`rothConversionEndYear`** — Roth Conversion End Year · `Number` · default — · sweep: opt · via US_ROTH_CONVERSION
  Last year to convert; null = year before RMD start at primary age 73
- **`rothConversionMaxBracket`** — Roth Conversion Max Bracket Rate · `Number` · default `0.22` · sweep: opt · via US_ROTH_CONVERSION
  Fill ordinary income up to top of this marginal bracket
- **`rothConversionMonth`** — Roth Conversion Month · `Number` · default `12` · via US_ROTH_CONVERSION
  Month (1–12) when the policy fires each year
- **`rothConversionOwner`** — Roth Conversion Owner · `Enum` · default `both` · one of `primary`, `spouse`, `both` · via US_ROTH_CONVERSION
  Whose IRA to convert: 'primary', 'spouse', or 'both'
- **`rothConversionSchedule`** — Roth Conversion Schedule (per-year income targets) · `RothScheduleList` · default `` · via US_ROTH_CONVERSION
  Per-year income-fill schedule [{ year, incomeTarget }] for the closed-loop controller (design 39 §12). incomeTarget is real base-year (2025) USD, compounded by inflation to the year's nominal ordinary-income ceiling. Years absent = not converted (skip-years). Legacy { year, bracketCeiling } (statutory rate) entries are still accepted. Empty = use the start/end/maxBracket window.
- **`rothConversionStartYear`** — Roth Conversion Start Year · `Number` · default — · sweep: opt · via US_ROTH_CONVERSION
  First year to convert; null = primary person's retirement year

### Spending (46)

- **`ageBandDeclineRate`** — Age-Band Decline Rate · `Number` · default — · sweep: mc+opt · conditional · via US_RETIREMENT
  Convenience: a single real %/yr decline anchored at the primary person's retirement age. When set, overrides Spending Age Bands with a synthesized one-band glide (e.g. -0.01 = Blanchett's ~1%/yr smile)
- **`ageBandSpendingSlice`** — Age-Band Spending Slice · `Enum` · default `discretionary` · one of `discretionary`, `both` · sweep: opt · conditional · via US_RETIREMENT
  Which expense slice the age factor bends: 'discretionary' (default) or 'both'
- **`crossBorderDrawdown`** — Cross-Border Drawdown · `Enum` · default `AUTO` · one of `AUTO`, `LOCAL_FIRST`, `GLOBAL` · sweep: opt · via SCENARIO
  How the non-residence country's accounts are ordered for drawdown. AUTO follows the strategy (TAX_EFFICIENT is global, others residence-first). LOCAL_FIRST drains the current residence country first. GLOBAL lets both countries' accounts compete in one drawdownPriority order — pair with CUSTOM to force a hand-authored cross-border order.
- **`crraGamma`** — CRRA Risk Aversion (γ) · `Number` · default `1.5` · via US_RETIREMENT
  Relative risk aversion for the CRRA consumption-utility accumulator (design 39 §4). γ=1 ⇒ log utility; higher γ ⇒ stronger preference for smooth real spending.
- **`customDrawdownStrategies`** — Custom Drawdown Strategies · `DrawdownStrategyList` · default `` · one of `us-savings`, `au-savings`, `fixed-income`, `us-stock`, `ira`, `k401`, `roth-ira`, `au-fixed-income`, `au-stock`, `super` · via SCENARIO
  Define named by-role drawdown orderings, then select one above or sweep them in Optimize
- **`discretionarySharePct`** — Discretionary Share · `Number` · default `0.3` · sweep: opt · via US_RETIREMENT
  Fraction of monthly expenses treated as discretionary (0.30 = 30%)
- **`drawdownLotStrategy`** — Drawdown Lot Strategy · `Enum` · default `FIFO` · one of `FIFO`, `HIFO`, `LOSS_FIRST`, `SPECIFIC`, `LADDER` · sweep: opt · via SCENARIO
  Which lots within a sleeve to sell for a spending debit. FIFO sells oldest first (maximizes AU 12-month CGT-discount eligibility). HIFO sells highest-cost-basis first (least realized gain per dollar). LOSS_FIRST realizes losing lots first (banks losses). SPECIFIC is a gain-minimizing pick (behaves as HIFO until bracket-awareness lands). LADDER draws a bond ladder the natural way — liquid cash first, then the nearest-maturity rung (≈ par, least mark-to-market deviation), sparing funds/equity (design 66 §G8).
- **`drawdownOwnerOrdering`** — Drawdown Owner Ordering · `Enum` · default `PRIMARY_FIRST` · one of `PRIMARY_FIRST`, `SPOUSE_FIRST`, `POOLED` · via SCENARIO
  How accounts owned by different people are ordered within a drawdown strategy. PRIMARY_FIRST: drain the primary's accounts entirely before the spouse's. SPOUSE_FIRST: the reverse. POOLED: same-role accounts across owners share one priority tier (e.g. both Roths drawn together in the strategy's role order).
- **`drawdownRebalanceWeight`** — Drawdown Rebalance Coupling · `Number` · default `0` · range 0…3 · sweep: opt · conditional · via SCENARIO
  How strongly a spending drawdown is biased toward selling the over-weight asset class (per the design-61 target) so the sale also rebalances. 0 disables the coupling; higher values let mix-correction override the tax-cost sleeve order. Only meaningful with a TARGET_ALLOCATION strategy active.
- **`drawdownSecurityOrder`** — Drawdown Security Order · `EnumMulti` · default `` · via SCENARIO
  Which SECURITIES to raise cash out of first, in order, before the ones not listed. Neither a class question nor a lot question: "sell the employer stock before the index fund" is a statement about which INSTRUMENT to sell, and it only became expressible once a position names one. An order, not a filter — once the listed securities are exhausted the draw carries on through the rest, exactly as the sleeve order does with an absent class. Empty = no security bias (the default).
- **`drawdownSequence`** — Drawdown Sequence (pools) · `DrawdownSequence` · default — · via SCENARIO
  ORDERED list of pools to draw spending from, e.g. [{"key":"auSavingsAccount"},{"key":"brokerageAccount","sleeves":["BOND"]},{"key":"auOffsetAccount"},{"key":"brokerageAccount","sleeves":["EQUITY","GOLD"]}]. Each entry is an account, optionally narrowed to allocation sleeves; an account may appear more than once with disjoint sleeves. This is the only way to say "after bonds, before equity": account priority and within-account sleeve order are two separate orderings and that policy lives between them. Accounts not listed follow the sequence in their ordinary drawdownPriority order. Blank (the default) = drawdownPriority alone, byte-identical to before. Sleeves apply only to a BROKERAGE account (the only draw that runs through the holdings primitive).
- **`drawdownSleeveOrder`** — Drawdown Sleeve Order · `Enum` · default `FIFO` · one of `FIFO`, `TAX_COST`, `PRESERVE_GROWTH`, `WEIGHTED` · sweep: opt · via SCENARIO
  Which asset class (sleeve) to sell first when raising cash for spending. FIFO ignores allocation (historic behavior). TAX_COST sells least-taxed first (CASH→BOND→EQUITY→GOLD). PRESERVE_GROWTH sells the safe sleeves first and lets equity compound (CASH→BOND→GOLD→EQUITY). WEIGHTED sorts sleeves by the per-class sleeveWeight params (optimizable).
- **`drawdownStrategy`** — Drawdown Strategy · `Enum` · default `TAXABLE_FIRST` · one of `TAXABLE_FIRST`, `TAX_DEFERRED_FIRST`, `ROTH_FIRST`, `PROPORTIONAL`, `TAX_EFFICIENT`, `WEIGHTED`, `CUSTOM` · sweep: opt · via SCENARIO
  Order accounts are liquidated to cover spending shortfalls
- **`drawdownWeight::au-fixed-income`** — Drawdown Weight — AU Fixed Income · `Number` · default `0.3333` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown weight for AU Fixed Income accounts (0–1; lower = drawn earlier). Active only when Drawdown Strategy is WEIGHTED; the draw order is the ascending sort of all role weights. Same-role siblings share this weight (one tier).
- **`drawdownWeight::au-stock`** — Drawdown Weight — AU Stock · `Number` · default `0.4444` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown weight for AU Stock accounts (0–1; lower = drawn earlier). Active only when Drawdown Strategy is WEIGHTED; the draw order is the ascending sort of all role weights. Same-role siblings share this weight (one tier).
- **`drawdownWeight::fixed-income`** — Drawdown Weight — US Fixed Income · `Number` · default `0.1111` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown weight for US Fixed Income accounts (0–1; lower = drawn earlier). Active only when Drawdown Strategy is WEIGHTED; the draw order is the ascending sort of all role weights. Same-role siblings share this weight (one tier).
- **`drawdownWeight::ira`** — Drawdown Weight — Traditional IRA · `Number` · default `0.5556` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown weight for Traditional IRA accounts (0–1; lower = drawn earlier). Active only when Drawdown Strategy is WEIGHTED; the draw order is the ascending sort of all role weights. Same-role siblings share this weight (one tier).
- **`drawdownWeight::k401`** — Drawdown Weight — 401(k) · `Number` · default `0.6667` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown weight for 401(k) accounts (0–1; lower = drawn earlier). Active only when Drawdown Strategy is WEIGHTED; the draw order is the ascending sort of all role weights. Same-role siblings share this weight (one tier).
- **`drawdownWeight::roth-ira`** — Drawdown Weight — Roth IRA · `Number` · default `0.8889` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown weight for Roth IRA accounts (0–1; lower = drawn earlier). Active only when Drawdown Strategy is WEIGHTED; the draw order is the ascending sort of all role weights. Same-role siblings share this weight (one tier).
- **`drawdownWeight::super`** — Drawdown Weight — Superannuation · `Number` · default `0.7778` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown weight for Superannuation accounts (0–1; lower = drawn earlier). Active only when Drawdown Strategy is WEIGHTED; the draw order is the ascending sort of all role weights. Same-role siblings share this weight (one tier).
- **`drawdownWeight::us-stock`** — Drawdown Weight — US Stock · `Number` · default `0.2222` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown weight for US Stock accounts (0–1; lower = drawn earlier). Active only when Drawdown Strategy is WEIGHTED; the draw order is the ascending sort of all role weights. Same-role siblings share this weight (one tier).
- **`expenseEvents`** — One-Off Expense Events · `ExpenseEventList` · default `` · conditional · via US_RETIREMENT
  List of dated one-off expenses: [{ date, amount, currency, category, fundFrom, personId, propertyKey, capitalize }]. `currency` defaults to the linked property's, else the household expense currency — set it explicitly for a cost that is genuinely denominated in one currency (design 86 §8). `fundFrom` is a state key debited DIRECTLY, taking only what is above that account's minimumBalance, with any remainder falling through to the residence-appropriate savings account; omit it for the residency default. It is the way to draw an out-of-queue account such as an offset WITHOUT giving that account a drawdownPriority, which would drain it against all spending. `propertyKey` + `capitalize` (0-1) add that fraction of the cost to the property's capitalizedImprovements, reducing the eventual capital gain the way capitalizeRepairs does.
- **`guardrailBaseCurrency`** — Guardrail Base Currency · `Text` · default `USD` · conditional · via US_RETIREMENT
  Currency to use when summing multi-currency portfolio values for the Guardrail check
- **`guardrailCutPct`** — Guardrail Cut % · `Number` · default `0.1` · sweep: opt · conditional · via US_RETIREMENT
  Fraction of discretionary spending to cut when the cut threshold is breached (0.10 = 10%)
- **`guardrailCutThreshold`** — Guardrail Cut Threshold · `Number` · default `0.2` · sweep: opt · conditional · via US_RETIREMENT
  Withdrawal rate fraction above initial that triggers a spending cut (0.20 = 20%)
- **`guardrailRaisePct`** — Guardrail Raise % · `Number` · default `0.1` · sweep: opt · conditional · via US_RETIREMENT
  Fraction to raise discretionary spending when the raise threshold is breached (0.10 = 10%)
- **`guardrailRaiseThreshold`** — Guardrail Raise Threshold · `Number` · default `0.2` · sweep: opt · conditional · via US_RETIREMENT
  Withdrawal rate fraction below initial that triggers a spending raise (0.20 = 20%)
- **`inflationAdjust`** — Inflation-Adjust Expenses · `Boolean` · default `true` · sweep: opt · via US_RETIREMENT
  If true, monthly expenses grow with inflation each year
- **`liquidityGraph`** — Liquidity Pools (graph) · `LiquidityGraph` · default — · conditional · via ECONOMIC_REGIMES
  The pool GRAPH: { pools: [...], flows: [...] } (design 97 Part II). A pool is a named node with `claims` of (account, sleeves), an optional `spendOrder` (its position on the draw walk), a `target` ({mode: YEARS_OF_SPEND|PERCENT|AMOUNT, value}), an optional `floor`, and a `capacity` rule (BALANCE, or OFFSET_CAP for an offset, whose ceiling is min(cash parked, loan owed) and falls on a schedule nobody authored). A flow is a directed edge {from, to} with a `trigger` (when the destination wants money), an `amount` (how far to fill it) and a `gate` (whether the SOURCE may be sold at all). `sourceDrawdownUnder` with `drawdownBasis: INDEX` — "only harvest while the source is within x of its peak, measured on its compounded RETURN so the household's own spending does not count as drawdown" — is the gate that measured best in decumulation (design 97 §20.14). On the default `BALANCE` basis the same clause cannot tell a falling market from the pool being spent down and latches shut after the first crash, so use BALANCE only for a pool that is accumulating. `sourceReturnOver: 0` is "only harvest after an up year" and `targetReturnUnder` is the same machinery pointing the other way, i.e. buy the dip. Clauses can be composed — `anyOf` / `allOf` / `not`, an array is an AND — and any of them can carry `sustainedYears: n`, which holds the gate shut until its condition has held n consecutive years; §20.13 measured that DURATION, not the threshold, as the lever. A clause can also carry an `id` (letters, digits, `_`, `-`), which is its ADDRESS: it changes nothing about the run and makes that one clause SEARCHABLE, generating the `gate.<id>.threshold` and `gate.<id>.dwell` levers the optimizer and the MC grid can sweep. Without one a clause is positional — the OR # renumbers on every edit — so it cannot be addressed and no axis for it exists. Ids are unique within a graph; the same id in two shapes is the same clause, and one sweep moves both. Trigger and amount are deliberately two numbers — an (s, S) band — so a refill does not fire every period. The graph COMPILES to the drawdown sequence, so it replaces `drawdownSequence` rather than sitting beside it (authoring both throws). Blank (the default) = no pools, byte-identical to before. In-portfolio refills are executed by the TARGET_ALLOCATION rebalancer, so select that strategy too unless every flow is cross-account.
- **`liquidityGraphEnabled`** — Liquidity Pools Enabled · `Boolean` · default `true` · conditional · via ECONOMIC_REGIMES
  The whole-graph OFF switch. Deselecting the LIQUIDITY_POOLS strategy stops only the refill flows — the graph still compiles to the drawdown sequence and still sizes the rebalancer, because those two read the graph directly and never look at the strategy list. Setting this false makes all three go dark at once: `resolveLiquidityGraph` returns null, so the spend order falls back to `drawdownPriority` (or to an authored `drawdownSequence`, which stops being a second authority once the graph is off) and every pool target, gate and capacity rule is inert. The graph is KEPT — this is how you run a pools-off control without deleting the structure and losing it. It still has to compile: the authoring UI reports a bad pool while the switch is off, so flipping it back on cannot surface an error you were never shown. Contrast `poolFlowsEnabled`, which turns off only the refill edges and leaves the pools, their sizing and the spend order live.
- **`liquidityGraphSchedule`** — Liquidity Pool Schedule · `LiquidityGraphSchedule` · default — · conditional · via ECONOMIC_REGIMES
  When each pool shape takes over: [{ year, shape }], the shape naming a key of Liquidity Pool Shapes (design 109). A step function — the row with the greatest year not after the current one governs, and BEFORE the first row the base Liquidity Pools (graph) governs, so adding a schedule never requires copying the existing graph into a shape. One row per year (two rows for one year is refused; only one shape can be active at a time). A row takes effect at the first period advance on or after 1 January of its year, which on a semi-annual cadence can be up to six months later — shapes govern DECISIONS, and decisions are taken at advances. A change moves no money by itself: the new shape's targets are honoured by the rebalancer and the flows at their own cadence, through their own gates. Pool identity across a change is the pool `id` — the same id continues and keeps its trailing high, a new id starts cold, a dropped id is retired. Blank (the default) = one graph for the whole run.
- **`liquidityShapes`** — Liquidity Pool Shapes · `LiquidityShapes` · default — · conditional · via ECONOMIC_REGIMES
  Named alternative pool GRAPHS, as { <shapeId>: { pools, flows } } — each one exactly the value Liquidity Pools (graph) takes, so a shape is not a new vocabulary, it is the existing one given a name (design 109). A shape is the WHOLE graph, not one pool's settings: flows name pools, remainder targets name pools and cycle detection is a property of the whole edge set, so a per-pool timeline would let a composition that validates in 2030 and 2040 be invalid in 2035. Every shape is compiled and validated at LOAD, beside the base graph, so a shape that takes effect in twenty years fails now rather than mid-run. Selected by Liquidity Pool Schedule; a shape no row selects warns and governs nothing. Blank (the default) = one graph for the whole run, byte-identical to before.
- **`monthlyExpenses`** — Monthly Expenses · `Money` · default `6000` · USD · sweep: mc+opt · via US_RETIREMENT
  Monthly household expenses drawn from savings
- **`monthlyExpensesCurrency`** — Expense Denomination · `Enum` · default `RESIDENCE` · one of `RESIDENCE`, `USD`, `AUD` · via US_RETIREMENT
  What currency the Monthly Expenses figure is a price IN. RESIDENCE (default) treats it as the cost of living in the country you live in: the figure is re-based once into the residence currency at the scenario anchor rate on a move, then indexed to that country’s CPI, and the exchange rate moves the COST OF FUNDING it rather than the standard of living. USD/AUD pin the figure to one currency and convert at spot each month, which for a household that moves country is inconsistent with the CPI indexation and reports far too little FX risk (measured: 1.5% spending dispersion under USD vs 36% under RESIDENCE on a 44-year US→AU plan). Pin to a fixed currency only when the costs really are denominated there regardless of where you live.
- **`paycheckCadence`** — Paycheck Cadence · `Enum` · default `ANNUAL` · one of `ANNUAL`, `QUARTERLY` · conditional · via ECONOMIC_REGIMES
  How often the paycheck fires. ANNUAL is what advisers actually run and it maximises the value of a skip rule — a year's funding is one decision, so "take this year from the reserve instead of selling growth" is a decision there is somewhere to make. QUARTERLY holds a quarter of the cash idle instead of a year and spreads the liquidation over four dates, which is closer to what most households tolerate. The two are the natural A/B: expect the mean to move very little and the trough to move. The CALENDAR is not a setting: both income-year starts are scheduled (1 January and 1 July) and each firing is answered only while the household is resident in that country, so the paycheck follows a move by itself (design 107 §15.3).
- **`paycheckEnabled`** — Spending Paycheck Enabled · `Boolean` · default `false` · conditional · via ECONOMIC_REGIMES
  Fund living costs by a scheduled transfer into the spending float, instead of the just-in-time top-up that fires whenever a debit would breach the transaction account's minimum balance. Off (the default) is today's behaviour: a floor plus one liquidation per month, in the exact amount of that month's shortfall. On, a SPENDING_REFILL event fires the graph's `cadence: PAYCHECK` edges, which fill the destination pool to its own `target` — so the float is sized by the pool and is automatically net of any dividend cash that already landed in it. This changes WHEN assets are sold, not how much is spent: an annual paycheck raises a year of spending in one transaction instead of averaging across twelve, which is a real change in exposure and the reason the reserve-sourced edge usually wants a gate (design 107 §15.1). Requires at least one flow with `cadence: PAYCHECK` and a destination pool with a `target`, or the event fires and nothing moves.
- **`poolFlowsEnabled`** — Pool Refill Flows Enabled · `Boolean` · default `true` · conditional · via ECONOMIC_REGIMES
  Authors the graph's TOPOLOGY without its BEHAVIOUR: pools, targets, capacity and the spend order stay live, refill flows do not fire. This is the arm-vs-control switch a study of the refill rule needs — the alternative is deleting the flows in one arm, which also changes the pool sizing and makes the two arms differ in two ways at once.
- **`regimeAwareCutPct`** — Regime-Aware Spending Cut · `Number` · default `0.15` · sweep: opt · conditional · via US_RETIREMENT
  Fraction of discretionary spending cut while any ECONOMIC_STRESS-tagged regime is active (0.15 = 15% cut)
- **`sleeveWeight::BOND`** — Sleeve Weight — BOND · `Number` · default `0.4` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown sleeve weight for the BOND allocation (0–1; lower = sold earlier for a spending debit). Active only when Drawdown Sleeve Order is WEIGHTED; the sell order is the ascending sort of all sleeve weights.
- **`sleeveWeight::CASH`** — Sleeve Weight — CASH · `Number` · default `0.2` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown sleeve weight for the CASH allocation (0–1; lower = sold earlier for a spending debit). Active only when Drawdown Sleeve Order is WEIGHTED; the sell order is the ascending sort of all sleeve weights.
- **`sleeveWeight::EQUITY`** — Sleeve Weight — EQUITY · `Number` · default `0.6` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown sleeve weight for the EQUITY allocation (0–1; lower = sold earlier for a spending debit). Active only when Drawdown Sleeve Order is WEIGHTED; the sell order is the ascending sort of all sleeve weights.
- **`sleeveWeight::GOLD`** — Sleeve Weight — GOLD · `Number` · default `0.8` · range 0…1 · sweep: opt · conditional · via SCENARIO
  Drawdown sleeve weight for the GOLD allocation (0–1; lower = sold earlier for a spending debit). Active only when Drawdown Sleeve Order is WEIGHTED; the sell order is the ascending sort of all sleeve weights.
- **`spendingAgeBands`** — Spending Age Bands · `AgeBandList` · default `[object Object],[object Object],[object Object],[object Object]` · conditional · via US_RETIREMENT
  Age-band table for the retirement spending smile: each band is { startAge, multiplier, annualRealDrift }; multiplier is the relative step entering the band, annualRealDrift the within-band real glide
- **`spendingExpenseBands`** — Spending Expense Bands · `ExpenseBandList` · default `[object Object],[object Object],[object Object]` · conditional · via US_RETIREMENT
  Absolute monthly spend per age band: each band is { startAge, monthlyAmount } in base-year currency; compounded to nominal by the residence price level at band transitions. The lever for "optimal monthly expense amount per age band" (design 38 §6.1).
- **`spendingStrategy`** — Spending Strategy · `EnumMulti` · default `FIXED` · one of `FIXED`, `REGIME_AWARE`, `GUARDRAIL`, `EXPENSE_EVENTS`, `AGE_BANDED`, `EXPLICIT_BANDS` · sweep: opt · via US_RETIREMENT
  Active spending strategies; FIXED = inflation-adjusted scalar (default), REGIME_AWARE = cut discretionary under economic-stress regimes, GUARDRAIL = Guyton-Klinger withdrawal-rate bands, EXPENSE_EVENTS = dated one-off expenses in a chosen currency, optionally funded from a nominated account (design 86 G8/G9; supersedes HEALTHCARE, which is now the `healthcare` category), AGE_BANDED = age-driven real spending smile (go-go/slow-go/no-go), EXPLICIT_BANDS = absolute monthly amount per age band (design 38 §6.1)
- **`withinTierDraw`** — Within-Tier Draw · `Enum` · default `SEQUENTIAL` · one of `SEQUENTIAL`, `EQUAL`, `PROPORTIONAL` · sweep: opt · via SCENARIO
  How accounts sharing one drawdown tier (equal priority) split a withdrawal. SEQUENTIAL drains one member fully before the next (default). EQUAL splits the tier's draw evenly across members (residual redistributes when one is capped). PROPORTIONAL splits by each member's available balance — e.g. draw two Roths together pro-rata.

### Tax (4)

- **`auDeferredBasPayer`** — Deferred BAS Payer · `Boolean` · default `true` · conditional · via AU_TAX
  Whether the s 45-61(2) due dates apply — the 28th of the month after each instalment quarter rather than s 45-61(1)'s 21st, with the December quarter falling on the next 28 February. True (the default) is most individuals lodging through an agent, and gives the 28 Oct / 28 Feb / 28 Apr / 28 Jul calendar people actually experience.
- **`auGdpUplift`** — AU GDP Adjustment · `Number` · default `0.05` · range 0…0.2 · conditional · via AU_TAX
  The GDP adjustment applied to the base year's income when the Commissioner works out PAYG instalments (TAA 1953 Sch 1 s 45-405(2)–(3)); a negative figure reads as 0% under s 45-405(3)(b). The default 0.05 is the ATO's published factor for the 2026–27 income year (4% for 2025–26) — see docs/au-tax/ato-rates/. It moves only the TIMING of cash, never the total tax, because the assessment credits the instalments exactly (s 45-30), so it is not worth sweeping. It does NOT apply to an annual payer or to the instalment-RATE method: the ATO applies it to the notified AMOUNT only.
- **`auNotionalTaxRate`** — AU Notional Tax Rate · `Number` · default `0.25` · range 0…0.6 · conditional · via AU_TAX
  The flat rate the base year's adjusted taxable income is re-taxed at to get notional tax (s 45-325). A simplification, stated rather than hidden: the section wants the base year's ADJUSTED TAX on that income, i.e. the progressive scale applied again, and computing it would mean re-entering the AU tax engine on a counterfactual state from inside a handler. The error is absorbed completely by the balancing payment at assessment, so it shifts cash between quarters and nothing else.
- **`taxInstalmentsEnabled`** — Pay Tax in Instalments · `Boolean` · default `false` · via AU_TAX
  Pay income tax across the year on the statutory dates instead of as one lump at the settle. Off (the default) the whole year's liability is a single debit on 31 December / 30 June, funded by a draw on that same date — so one date's market price decides what must be sold to pay a bill computed on the previous twelve months, and a crash landing in December is met by selling at the bottom in every path. On, the US pays four instalments on 15 Apr / 15 Jun / 15 Sep / 15 Jan (IRC §6654(c)(2)) sized from the PRIOR year's return — 100% of it, or 110% where that return's AGI exceeded \$150,000 (§6654(d)(1)(B)(ii), (C)(i)) — and Australia pays four PAYG instalments after each quarter (TAA 1953 Sch 1 s 45-61) at 25/50/75/100% of GDP-adjusted notional tax (s 45-400(2)). The settle then moves only the true-up, and refunds an over-payment. Note the two regimes differ in a way that matters: the US basis is last year's whole tax including capital gains, so the prior-year safe harbour is complete, while s 45-330(1)(a) EXCLUDES net capital gain from the AU base — so an AU retiree funding spending by realising gains still meets a large balancing payment at assessment. That is the law, not a modelling gap.

### US Account Balances (3)

- **`stockBasisIntl`** — Stock Basis — International (USD) · `Number` · default `25000` · via SCENARIO
  Cost basis for the international equity holding. Default is below market value (gain position, TaxGainHarvest candidate).
- **`stockBasisUS`** — Stock Basis — Domestic (USD) · `Number` · default `65000` · via SCENARIO
  Cost basis for the domestic equity holding. Default exceeds market value so TLH fires immediately when enabled.
- **`stockSplitRatio`** — Stock Domestic Split (0–1) · `Number` · default `0.6` · via SCENARIO
  Fraction of US stock balance allocated to the domestic equity holding (remainder goes to international). Default 0.6 = 60/40.

### US Banking (2)

- **`usPrimeRate`** — US Prime Rate (Fed policy) · `Number` · default `0.045` · sweep: mc · via US_BANKING
  US central-bank (Fed) policy rate. Prime-linked cash accounts and variable loans earn/pay Prime + their spread.
- **`usSavingsInterestRate`** — US Savings Interest Rate · `Number` · default `0.03` · via US_BANKING
  Annual interest rate for US savings accounts (seed / fallback baseline; rate sweeps go through US Prime — design 56).

### US Retirement (9)

- **`dividendReinvest`** — Reinvest Dividends (default) · `Boolean` · default `false` · sweep: opt · via US_RETIREMENT
  Household DEFAULT for US brokerage dividends and bond coupons: if true they are reinvested, otherwise paid out as cash. A real DRIP election is made per broker, so any brokerage account can override this on its own record (design 106); this value applies to every account that has not.
- **`fixedIncomeInterestRate`** — Fixed Income Interest Rate · `Number` · default `0.04` · sweep: mc · via US_RETIREMENT
  Annual interest rate for fixed income accounts
- **`goldGrowthRate`** — Gold Growth Rate · `Number` · default `0.05` · sweep: mc · via US_RETIREMENT
  Annual commodity growth rate for GOLD holdings (design 56 §7); decoupled from equity returns and central-bank Prime, taxed at the 28% collectibles rate on disposal.
- **`inflationRate`** — Inflation Rate · `Number` · default `0.03` · sweep: mc · via US_RETIREMENT
  Annual inflation rate applied to expenses
- **`k401ToIraConversionDay`** — 401(k)→IRA Conversion Day · `Number` · default — · via US_RETIREMENT
  Day of month for the conversion; null = use the owner's retirement day
- **`k401ToIraConversionEnabled`** — 401(k)→IRA Conversion Enabled · `Boolean` · default `true` · via US_RETIREMENT
  If true, each 401(k) is rolled into the owner's first IRA on the owner's retirement date
- **`k401ToIraConversionMonth`** — 401(k)→IRA Conversion Month · `Number` · default — · via US_RETIREMENT
  Month (1–12) of the conversion; null = use the owner's retirement month
- **`k401ToIraConversionYear`** — 401(k)→IRA Conversion Year · `Number` · default — · sweep: opt · via US_RETIREMENT
  Year of the conversion; null = use the owner's retirement year
- **`primarySsClaimAge`** — Primary SS Claim Age · `Number` · default `67` · via SCENARIO
  Age at which primary claims Social Security (62–70). Note: only age 67 (FRA) is modelled until TODO #292 is resolved.

### US Tax (8)

- **`residencyState`** — US Residency State · `Enum` · default — · one of —, `NE`, `HI`, `SD` · sweep: opt · via SCENARIO
  US state of residency for state income tax (NE, HI, SD). Blank = none.
- **`stateMoveDestination`** — State Move Destination · `Enum` · default — · one of `NE`, `HI`, `SD` · sweep: opt · via US_STATE_TAX
  Destination US state for the Jan-1 state move (design 34 §9).
- **`stateMoveYear`** — State Move Year · `Number` · default — · sweep: mc+opt · via US_STATE_TAX
  Calendar year to establish residency in the destination state (effective Jan 1). Leave unset for no state move.
- **`usFederalBracketIndexSpread`** — US Federal Bracket Indexation Spread · `Number` · default `0` · sweep: mc · via US_TAX
  Annual rate at which US FEDERAL tax brackets, the standard deduction, the FICA wage base and the FEIE cap are projected to rise past the newest published table, expressed as a spread ADDED TO inflation (0 = track CPI, -0.03 against 3% inflation = frozen brackets). Published years are always used as legislated. Does NOT move the FICA wage base or the FEIE cap — those have their own spreads.
- **`usFeieCapIndexSpread`** — US FEIE Cap Indexation Spread · `Number` · default `0` · sweep: mc · via US_TAX
  Annual rate at which the §911 foreign earned income exclusion cap is projected to rise past the newest published table, as a spread ADDED TO inflation (0 = track CPI, matching how §911(b)(2)(D)(ii) indexes it today).
- **`usFicaWageBaseIndexSpread`** — US FICA Wage Base Indexation Spread · `Number` · default `0` · sweep: mc · via US_TAX
  Annual rate at which the Social Security contribution and benefit base (§3121(a)(1)) is projected to rise past the last SSA announcement, as a spread ADDED TO inflation. The real base tracks the SSA average wage index, which runs above CPI, so a positive spread (~0.005) is more faithful than 0.
- **`usFilingSingle`** — Filing Single · `Boolean` · default — · via US_TAX
  Override filing status auto-detection (true = single, false = MFJ)
- **`usStateBracketIndexSpread`** — US State Bracket Indexation Spread · `Number` · default `0` · sweep: mc · via US_STATE_TAX
  Annual rate at which US STATE tax brackets and standard deductions are projected to rise past each state's last published table, expressed as a spread ADDED TO inflation (0 = track CPI, -0.03 against 3% inflation = frozen brackets, which is what HI and NE law actually says). Published years are always used as legislated.

---

## Workbench panels (33)

From `FINANCE_PLUGINS`. **Pane** is where the default layout opens the tab.
Every `category` is empty because these descriptors are plain object literals that
never pass through `definePlugin()`, so the SDK defaults are never applied — that is a
true statement about the registry, not a gap in this file.

| id | title | pane | source |
|---|---|---|---|
| `scenario` | Scenario | left | `src/visualization/workbench/plugins/finance/scenario-plugin.js` |
| `parameters` | Parameters | center | `src/visualization/workbench/plugins/finance/parameters-plugin.js` |
| `mc-config` | Monte Carlo | left | `src/visualization/workbench/plugins/finance/mc-config-plugin.js` |
| `opt-config` | Optimize | left | `src/visualization/workbench/plugins/finance/opt-config-plugin.js` |
| `config-list` | Nodes | left | `src/visualization/workbench/plugins/finance/config-list-plugin.js` |
| `inspector` | Edit | left | `src/visualization/workbench/plugins/finance/inspector-plugin.js` |
| `config-graph` | Graph | center | `src/visualization/workbench/plugins/finance/config-graph-plugin.js` |
| `timeline` | Timeline | center | `src/visualization/workbench/plugins/finance/timeline-plugin.js` |
| `chart` | Chart | center | `src/visualization/workbench/plugins/finance/chart-plugin.js` |
| `mc-results` | MC Results | center | `src/visualization/workbench/plugins/finance/mc-results-plugin.js` |
| `opt-results` | OPT Results | center | `src/visualization/workbench/plugins/finance/opt-results-plugin.js` |
| `state-panel` | State | right | `src/visualization/workbench/plugins/finance/state-panel-plugin.js` |
| `watchlist` | Watchlist | right | `src/visualization/workbench/plugins/finance/watchlist-plugin.js` |
| `holdings` | Holdings | center | `src/visualization/workbench/plugins/finance/holdings-plugin.js` |
| `allocation` | Allocation | center | `src/visualization/workbench/plugins/finance/allocation-plugin.js` |
| `securities` | Securities | center | `src/visualization/workbench/plugins/finance/securities-plugin.js` |
| `spending` | Spending | center | `src/visualization/workbench/plugins/finance/spending-plugin.js` |
| `pools` | Liquidity Pools | center | `src/visualization/workbench/plugins/finance/liquidity-pools-plugin.js` |
| `paycheque` | Paycheque | center | `src/visualization/workbench/plugins/finance/paycheque-plugin.js` |
| `mc-runs` | MC Runs | right | `src/visualization/workbench/plugins/finance/mc-runs-plugin.js` |
| `opt-runs` | OPT Runs | right | `src/visualization/workbench/plugins/finance/opt-runs-plugin.js` |
| `exec-history` | Node History | right | `src/visualization/workbench/plugins/finance/exec-history-plugin.js` |
| `lineage` | Lineage | right | `src/visualization/workbench/plugins/finance/lineage-plugin.js` |
| `action-detail` | Action Detail | right | `src/visualization/workbench/plugins/finance/action-detail-plugin.js` |
| `journal-report` | Journal Report | bottom | `src/visualization/workbench/plugins/finance/journal-report-plugin.js` |
| `cross-action-query` | Field × Action | bottom | `src/visualization/workbench/plugins/finance/cross-action-query-plugin.js` |
| `scenario-compare` | Scenario Compare | bottom | `src/visualization/workbench/plugins/finance/scenario-compare-plugin.js` |
| `dg-config` | Decision Graph | left | `src/visualization/workbench/plugins/finance/dg-config-plugin.js` |
| `dg-results` | DG Results | center | `src/visualization/workbench/plugins/finance/dg-results-plugin.js` |
| `mpc-cockpit` | MPC Cockpit | center | `src/visualization/workbench/plugins/finance/mpc-cockpit-plugin.js` |
| `dashboard` | Dashboard | bottom | `src/visualization/workbench/plugins/finance/dashboard-plugin.js` |
| `perf` | Performance | bottom | `src/visualization/workbench/plugins/finance/perf-plugin.js` |
| `help` | Help | right | `src/visualization/workbench/plugins/finance/help-plugin.js` |

---

## Headless tools (79)

Command-line entry points under `scripts/`. **Purpose** is harvested from each script's
docblock, not re-authored here. Arguments come from each script's declarative
`parseFlags` spec: 66 of 66 entry points carry one (design 108 D6 — all of them).
6 scripts carry no docblock naming themselves and show `(undocumented)`.

### scripts/config-converters/

- **`scripts/config-converters/convert_to_bolden.py`**
  Convert FinSim JSON configuration to Bolden-compatible JSON format
- **`scripts/config-converters/convert_to_projectionlab.py`**
  Convert FinSim JSON configuration to ProjectionLab-compatible JSON format

### scripts/dev/

- **`scripts/dev/build-fx-series.mjs`** — `npm run build:fx-series`
  derive the engine-readable monthly FX series from the pinned
    - `--check` (flag) — report whether the series is in sync; write nothing
- **`scripts/dev/build-help-index.mjs`** — `npm run prebuild`
  regenerate the tier-1 help reference (design 108 phase 1)
    - `--check` (flag) — write nothing; exit 1 if help/REFERENCE.md is not what this run would produce
- **`scripts/dev/build-historical-equity-returns.mjs`**
  designs 102 §4.1 / §6 and 103 §5.3
- **`scripts/dev/build-index.js`** — `npm run build:index`
  _(undocumented — no docblock names this file)_
- **`scripts/dev/check-help.mjs`** — `npm run help:gate`
  the tier-2 gate (design 108 §6)
    - `--strict` (flag) — exit 1 on any structural error or stamp drift (design 108 D5)
    - `--enforce` (list) — report everything, but exit 1 only for these kinds — the phase-4 flip
    - `--kinds` (list) — restrict the REPORT to these topic kinds
    - `--backlog` (flag) — print only the params no topic cites — the phase-4 worklist
    - `--quiet` (flag) — the one-line summary only, no per-item detail (what `npm test` runs)
    - `--template` (string) — print a blank topic of this kind and exit
- **`scripts/dev/check-requirements.js`** — `npm run requirements`
  Scans test files for requirement IDs in test names and reports coverage against the full list defined in docs/requirements.md
    - `--missing` (flag) — list only the uncovered ids
    - `--category` (string) — restrict to one requirement category
- **`scripts/dev/diff-mutation-tracker.mjs`**
  design 78 §5.4 gate
    - `<file>` (string) — scenario export (default: the built-in reference)
    - `--to` (string) — stop at this YYYY-MM-DD
    - `--verbose` (flag) — list every differing path
- **`scripts/dev/help-lookup.mjs`** — `npm run help`
  search the help index from the command line (design 108 §7)
    - `--find` (string) — text to search for (case-insensitive)
    - `--kind` (string, default `all`) — restrict to one surface
    - `--limit` (number, default `25`) — max matches per surface
    - `--brief` (flag) — omit descriptions — just the keys
- **`scripts/dev/migrate-holding-rate-keys.mjs`**
  bring saved scenario exports up to the strict
    - `<files>` (list, repeatable, required) — scenario export(s) to migrate, in place
    - `--dry-run` (flag) — report what would change and write nothing
    - `--quiet` (flag) — print only the totals
- **`scripts/dev/restamp-help.mjs`** — `npm run help:restamp`
  the re-gold half of the tier-2 gate (design 108 §6)
    - `<topic>` (string) — the topic id to restamp
    - `--ref` (string) — restamp only this one reference
    - `--all` (flag) — restamp every topic (a bulk change that really did touch everything)
    - `--dry-run` (flag) — report what would change and write nothing

### scripts/lab/

- **`scripts/lab/allocation-report.mjs`**
  asset allocation over time, as one HTML page
    - `--scenario` (string) — workbench export to run (default: the built-in synthetic scenario)
    - `--index` (number, default `0`) — which scenario inside that file
    - `--out` (string, default `scenarios/allocation-report.html`) — output path
    - `--csv` (flag) — also write the raw cube beside the page as .csv
    - `--open` (flag) — open the result when done (macOS)
- **`scripts/lab/attribute-ruin.mjs`**
  WHICH harvested lever made the baked plan insolvent?
    - `<file>` (string, default `scenarios/fin-sim-die-with.json`) — scenario export to attribute
    - `--only` (list) — run only these arm keys
    - `--scenario` (string) — scenario NAME inside that file (default: the first)
- **`scripts/lab/calibrate-fx.mjs`** — `npm run calibrate:fx`
  estimate the FX process parameters from the packaged historical
    - `--from` (string) — window start YYYY-MM (default: the post-float month)
    - `--to` (string) — window end YYYY-MM (default: the last observation)
    - `--compare` (flag) — fit the standard window set instead of one window
    - `--json` (flag) — machine-readable output
- **`scripts/lab/epoch-solvency.mjs`**
  did the CONTROLLER ever project ruin? (design/80 Q5)
    - `<file>` (string, default `scenarios/fin-sim-die-with.json`) — scenario export to re-decide
    - `--levers` (list, default `SPENDING`) — lever keys the solver may move
    - `--epochs` (number, default `10`) — decision epochs
    - `--budget` (number, default `24`) — solver budget per epoch
    - `--seed` (number, default `1`) — RNG seed
    - `--step-years` (number, default `1`) — years between epochs
    - `--goal` (string, default `DIE_WITH_TARGET`) — optimization objective key
    - `--solver` (string, default `CEM`) — solver key
    - `--spend-range` (string) — lo:hi[:step] bound on the spending lever
    - `--scenario` (string) — scenario NAME inside that file (default: the first)
    - `--no-feasibility-first` (flag) — reproduce PRE-design-80-U2 ranking
    - `--no-harvest` (flag) — skip the harvest step at the end
- **`scripts/lab/frontier.mjs`**
  find the edge of solvency along ONE lever
    - `<mode>` (string, required) — which frontier to trace
    - `--lo` (number) — range low (default: the mode's own)
    - `--hi` (number) — range high (default: the mode's own)
    - `--step` (number) — range step (default: the mode's own)
    - `--bisect` (flag) — bisect to the edge instead of stepping the whole range
    - `--person` (string, default `primary`) — person the mode applies to
    - `--levers` (string) — lever bag applied to every case: inline JSON or a file
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
    - `--json` (flag) — machine-readable output
- **`scripts/lab/glidepath-corners.mjs`**
  audit a baked glidepath for anchors that zero an asset
    - `--scenario` (string, default `scenarios/fin-sim-scenarios.json`) — workbench export
    - `--name` (string) — scenario inside that file (default: the first with a glidepath)
    - `--run` (flag) — price each corner against a smoothed counterfactual
    - `--seeds` (number, default `0`) — re-price over n stochastic seeds (implies --run)
    - `--material` (number, default `0.05`) — share at or above which a class counts as a position
- **`scripts/lab/paired-delta.mjs`**
  re-report a `variant-grid` run as PAIRED DIFFERENCES
    - `--spec` (string) — the grid spec
    - `--results` (string) — what `variant-grid --out` wrote
    - `--pair` (string) — axis name to pair on
    - `--metric` (string, default `afterTaxNW`) — metric to difference
- **`scripts/lab/replay-vs-bake.mjs`**
  did the RUN go broke, or did the HARVEST of it? (design/80 F6)
    - `--decisions` (string, default `scenarios/fin-sim-decisions.json`) — decision record file
    - `--scenario` (string, default `scenarios/fin-sim-die-with.json`) — scenario export
    - `--scenario-name` (string) — scenario NAME inside that file (default: the first)
    - `--run` (string) — runId to replay (default: the last recorded)
- **`scripts/lab/roth-ledger.mjs`**
  what does the Roth actually COST, year by year? (design 84 P3 / G3)
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
    - `--levers` (string) — lever bag as inline JSON (see lib/variant.mjs)
    - `--csv` (string) — also write the rows here as CSV
- **`scripts/lab/score-decomposition.mjs`**
  WHY did the controller commit an infeasible plan?
    - `<file>` (string, default `scenarios/fin-sim-die-with.json`) — scenario export to decompose
    - `--epochs` (number, default `24`) — decision epochs
    - `--budget` (number, default `20`) — solver budget per epoch
    - `--seed` (number, default `1`) — RNG seed
    - `--levers` (list, default `SPENDING,ROTH,ALLOCATION_MIX,DRAWDOWN_WEIGHTS,DRAWDOWN_SLEEVE,DRAWDOWN_XBORDER,DRAWDOWN_WITHINTIER,BOND_LADDER`) — lever keys the solver may move
    - `--spend-range` (string, default `7000:10000`) — lo:hi[:step] bound on the spending lever
    - `--goal` (string, default `DIE_WITH_TARGET_LIQUID`) — optimization objective key
    - `--solver` (string, default `CEM`) — solver key
    - `--scenario` (string) — scenario NAME inside that file (default: the first)
- **`scripts/lab/sequence-risk/arms.mjs`**
  design 97 §20.7, the four arms
- **`scripts/lab/sequence-risk/export-json.mjs`**
  write an arm's cfg as a workbench-importable scenario export
- **`scripts/lab/sequence-risk/mc-worker.mjs`**
  one shard of design 97 §20's paired run
    - `<files>` (list, repeatable, required) — the jobs file to read and the rows file to write
- **`scripts/lab/sequence-risk/run-deterministic.mjs`**
  design 97 §20.6/§20.7, the readable case
    - `--crash` (number, default `2032`) — crash year
    - `--shock` (string, default `MARKET_CRASH_2008_LITE`) — shock preset
    - `--no-shock` (flag) — run the arms with no shock at all
    - `--from` (number) — first reported year (default: crash − 2)
    - `--to` (number) — last reported year (default: crash + 6)
    - `--export-json` (flag) — export the arms as scenario JSON instead of reporting
    - `--export-to` (string) — path for --export-json (default: derived from the arms and shock)
    - `--export-arms` (list, default `A,B,C,D`) — arms to export
- **`scripts/lab/sequence-risk/run-mc.mjs`**
  design 97 §20.7/§20.8, the study
    - `--n` (number, default `300`) — paths per arm
    - `--vol` (number, default `0.18`) — equity return volatility
    - `--shock` (string) — shock preset to land on the crash year
    - `--crash` (number, default `2032`) — crash year
    - `--out` (string) — directory to write per-arm JSON into
    - `--spend` (number) — monthly spend override (§20.6's calibration, re-checkable)
    - `--workers` (number, default `8`) — worker processes
- **`scripts/lab/sequence-risk/scenario.mjs`**
  design 97 §20.6, the MINIMAL scenario
- **`scripts/lab/spend-ceiling.mjs`**
  how far over the open-loop affordable line did the harvest
    - `<file>` (string, default `scenarios/fin-sim-die-with.json`) — scenario export to search
    - `--iters` (number, default `7`) — bisection iterations
    - `--from-age` (number) — treat bands from this age as MPC-decided (default: by amount)
    - `--scenario` (string) — scenario NAME inside that file (default: the first)
- **`scripts/lab/spending-mc.mjs`**
  what the plan costs, as a DISTRIBUTION
    - `--scenario` (string) — workbench export to run (default: the built-in synthetic scenario)
    - `--index` (number, default `0`) — which scenario inside that file
    - `--n` (number, default `25`) — paths
    - `--shock` (flag) — enable the manufactured-crash variables
    - `--no-recentre` (flag) — skip re-centring the MC variables on the scenario (rarely wanted)
    - `--tax-threshold` (list, default `0.4,0.5,0.6`) — report P(tax share > f) at each of these
    - `--json` (string) — also write the raw per-path summaries + the aggregate here
- **`scripts/lab/spending-report.mjs`**
  what the plan actually costs, as one HTML page
    - `--scenario` (string) — workbench export to run (default: the built-in synthetic scenario)
    - `--index` (number, default `0`) — which scenario inside that file
    - `--out` (string, default `scenarios/spending-report.html`) — output path
    - `--csv` (flag) — also write the raw cube beside the page as .csv
    - `--open` (flag) — open the result when done (macOS)
- **`scripts/lab/spending-trace.mjs`**
  what an adaptive spending rule actually COSTS you
    - `--strategy` (string) — FIXED | GUARDRAIL | EXPLICIT_BANDS | … (default: leave as authored)
    - `--returns` (list, default `0.08,0.06,0.05,0.04`) — equity returns to trace
    - `--levers` (string) — lever bag applied to every case: inline JSON or a file (see lib/variant.mjs)
    - `--years` (list) — report years (default: evenly spaced across the horizon)
    - `--country` (string, default `US`) — inflation accumulator to deflate by
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
    - `--json` (flag) — machine-readable output
- **`scripts/lab/study-report.mjs`**
  read a finished study directory and render it as one HTML page
    - `--dir` (string) — REQUIRED. directory of out-*.json grids and mc-out*/ arm dirs
    - `--out` (string) — output path (default <dir>/report.html)
    - `--scenario` (string) — scenario file to freshness-check against
    - `--pairs` (string) — "a:b,c:d" MC arm pairs (default: report-config.json, else vs the first arm)
    - `--open` (flag) — open the result when done (macOS)
- **`scripts/lab/variant-grid.mjs`**
  run an N-dimensional grid of scenario variants and table it
    - `--spec` (string) — the grid spec
    - `--out` (string) — write the results JSON here (what paired-delta reads)
    - `--workers` (number, default `8`) — worker processes
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
    - `--json` (flag) — machine-readable output
- **`scripts/lab/verify-harvest.mjs`** — `npm run verify:harvest`
  does the baked scenario reproduce the run? (design/39 §13.7)
    - `<levers>` (list, default `SPENDING`) — lever keys to harvest
    - `--goal` (string, default `MAX_NET_WORTH`) — optimization objective key
    - `--seeds` (list, default `1`) — RNG seeds
    - `--epochs` (number, default `5`) — decision epochs
    - `--budget` (number, default `24`) — solver budget per epoch
    - `--solver` (string, default `CEM`) — solver key
    - `--birth` (string, default `1978-04-15`) — birth date the ages are taken from
    - `--resolve` (flag) — re-solve at each epoch (the VoTV arm)
    - `--votv` (flag) — alias for --resolve
- **`scripts/lab/verify-mpc-lever.mjs`**
  Headless verification harness for the design-58 MPC / online-control levers
    - `<lever>` (string, default `all`) — which lever to verify
- **`scripts/lab/votv.mjs`** — `npm run votv`
  is time-variation actually worth anything? (design/39 §13.13.3)
    - `<levers>` (list, default `SPENDING`) — lever keys to price
    - `--goal` (string, default `MAX_NET_WORTH`) — optimization objective key
    - `--seeds` (list, default `1`) — RNG seeds
    - `--epochs` (number, default `5`) — decision epochs
    - `--budget` (number, default `24`) — solver budget per epoch
    - `--solver` (string, default `CEM`) — solver key
    - `--birth` (string, default `1978-04-15`) — birth date the ages are taken from

### scripts/montecarlo/

- **`scripts/montecarlo/mc-report.mjs`**
  turn raw Monte Carlo arm output into a decision
    - `--dir` (string) — directory of per-arm JSON files
    - `--pairs` (string) — comma-separated a:b comparisons (default: every arm against the first)
    - `--metric` (string, default `afterTaxNW`) — money metric to table
    - `--thresholds` (string) — JSON file of mix thresholds
    - `--floor` (flag) — report against the spending floor
    - `--html` (string) — write the mix report HTML here
    - `--json` (flag) — structured output
- **`scripts/montecarlo/mc-run.mjs`**
  run Monte Carlo ARMS from a spec and write raw per-path results
    - `--arms` (string) — REQUIRED. { base, arms } spec file
    - `--out` (string) — REQUIRED. one <armKey>.json per arm is written here
    - `--n` (number, default `400`) — paths per arm
    - `--only` (list, default ``) — comma-separated subset of arms to run
    - `--scenario` (string) — base scenario export; omitted => synthetic
    - `--index` (number, default `0`) — scenario index in that file
    - `--paths` (flag) — stochastic year-by-year equity returns (real sequence risk)
    - `--vol` (number, default `0.18`) — equity return vol when --paths
    - `--drift` (string, default `GEOMETRIC`, one of GEOMETRIC|NONE) — return anchor reading
    - `--property-paths` (flag) — stochastic property appreciation path
    - `--shock` (flag) — manufactured single crash (severity + date)
    - `--no-recentre` (flag) — skip the check that MC centers match the scenario
    - `--mix` (flag) — also record the per-year asset mix
    - `--spending` (flag) — also record classified spending — forces FULL telemetry, ~7.5x

### scripts/probes/

- **`scripts/probes/measure-shock-history.mjs`**
  derive the empirical numbers behind SHOCK_LIBRARY
    - `--write` (flag) — write the measured figures back into the source file
- **`scripts/probes/probe-904-limitation.mjs`**
  what the §904 limitation actually did, year by year
    - `--to` (string) — stop at this YYYY-MM-DD instead of the scenario's simEnd
    - `--json` (flag) — machine-readable output
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-988-method-dispersion.mjs`** — `npm run probe:988-method`
  design 87 G6's DECIDING measurement
    - `--seeds` (number, default `40`) — seeds per method
    - `--vol` (number, default `0.1`) — FX volatility
    - `--reversion` (number, default `0.5`) — FX reversion speed
    - `--move-year` (number) — residency move year override
    - `--au-rental` (flag) — add an AU rental position
    - `--json` (string) — write the structured result here
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-au-cgt-attribution.mjs`**
  _(undocumented — no docblock names this file)_
    - `--fy` (number, default `2031`) — Australian financial year
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-bucket-cover.mjs`**
  the three-pool ("bucket") cover schedule, year by year
    - `--years` (number, default `5`) — target years of cover
    - `--from` (number, default `2027`) — first reported year
    - `--to` (number, default `2050`) — last reported year
    - `--pay-source` (string) — account the loan payment draws from
    - `--io-until` (number) — hold the loan interest-only until this year
    - `--loan` (string, default `auHousePropertyLoan`) — loan key to vary
    - `--no-pin-fx` (flag) — let FX float instead of pinning it
    - `--keep-shocks` (flag) — keep the scenario's own shocks
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-bucket-sequencing.mjs`**
  is the plan actually DRAINING its buckets in order?
    - `--from` (number, default `2027`) — first reported year
    - `--to` (number, default `2045`) — last reported year
    - `--offset-priority` (string) — offset priority override
    - `--no-pin-fx` (flag) — let FX float instead of pinning it
    - `--no-shocks` (flag) — strip the scenario shocks
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-claims-as-placement.mjs`**
  what does joining pool CLAIMS to PLACEMENT cost?
    - `--slack-years` (number, default `8`) — years of slack to allow
    - `--as-of` (string, default `2039-09-01`) — as-of date
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-consumption-intent-gap.mjs`**
  design 89 §5.1 step A, and the step-D regression
    - `--stress` (number, default `1`) — stress multiplier on the intent
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-equity-process-fit.mjs`**
  design 102 §2
    - `--paths` (number, default `2000`) — simulated paths per model
    - `--seed` (number, default `7`) — RNG seed
- **`scripts/probes/probe-fito-handoff.mjs`**
  design 83 G5
    - `--to` (string) — stop at this YYYY-MM-DD instead of the scenario's simEnd
    - `--json` (flag) — machine-readable output
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-foreign-property-cgt.mjs`** — `npm run probe:foreign-property-cgt`
  End-to-end runtime check for design 62 §5 (Gap 3): the foreign (US) house of an AU resident is stepped up at the move and AU-assessed on sale, net of the AU main-residence exemption
- **`scripts/probes/probe-inflation-joint.mjs`**
  design 103 §2
- **`scripts/probes/probe-market-index-cost.mjs`**
  what the market index costs a run (design 101 §6.2)
    - `--name` (string, default `cross-border-reference`) — built-in scenario to time
    - `--runs` (number, default `6`) — timed runs
- **`scripts/probes/probe-offset-payment-drain.mjs`**
  design 97 §20, integrity check 2
- **`scripts/probes/probe-payload-gate-diff.mjs`**
  what wiring the manifest gate would change
    - `<years>` (number, default `44`) — horizon in years
- **`scripts/probes/probe-pool-gate-foresight.mjs`**
  design 97 §20, integrity check 1
    - `--seed` (number, default `7`) — RNG seed
    - `--vol` (number, default `0.25`) — equity return volatility
- **`scripts/probes/probe-prime-inflation.mjs`**
  design 104 §2
- **`scripts/probes/probe-refill-laundering.mjs`**
  does the DRAW ORDER survive the REBALANCER?
    - `--from` (number, default `2027`) — first reported year
    - `--to` (number, default `2042`) — last reported year
    - `--shock` (string) — shock preset to inject
    - `--shock-year` (number) — year the shock lands
    - `--b-tail` (string, default `equity`, one of equity|bonds) — arm B's tail sleeve
    - `--no-pin-fx` (flag) — let FX float instead of pinning it
    - `--no-shocks` (flag) — strip the scenario shocks
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-regold-additive.mjs`**
  is a regold ONLY added keys? (design 101 §6.3)
    - `--removals` (string) — removal spec to check against
- **`scripts/probes/probe-residency-cgt.mjs`** — `npm run probe:residency-cgt`
  Headless probe / regression check for the AU residency-change CGT holding-period gate (design 62 §4, Gap 1), driving the REAL production code paths: - AccountService.recordResidencyChange — s855-45 deemed-acquisition step-up + per-country deemed-acquisition date stamp - consumeHoldingsFifo — realized basis + the discountable-gain split (≥12 months from the deemed-acquisition date) - AuTaxRates2025.computeTax / _cgtRelief — the pre-2027 Division 115 50% discount, now applied only to the eligible slice
- **`scripts/probes/probe-return-autocorrelation.mjs`**
  design 97 §20.9
    - `--n` (number, default `40`) — years per world
    - `--vol` (number, default `0.18`) — equity return volatility
- **`scripts/probes/probe-security-registry-clone-cost.mjs`**
  design 94 §6.4's deciding measurement
    - `--step-to` (string, default `2035-01-01`) — end date for the end-to-end arm
    - `--iters` (number, default `2000`) — micro-benchmark iterations
    - `--counts` (list, default `5,20,50`) — security counts to benchmark
    - `--levels` (list, default `off,journal,metrics,full`) — telemetry levels
    - `--reps` (number, default `3`) — repetitions per cell
    - `--n` (number, default `20`) — end-to-end runs
    - `--no-end-to-end` (flag) — skip the end-to-end arm
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-spending-composition.mjs`**
  design 89 §3, §4 and §10, reproducible
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-step3-regold-delta.mjs`**
  _(undocumented — no docblock names this file)_
- **`scripts/probes/probe-tax-payment-tax-leak.mjs`** — `npm run probe:tax-payment-leak`
  Quantifies the SECOND-ORDER TAX generated when a tax bill is paid by liquidating assets — the tax on the sale that funds the tax
    - `--stress` (flag) — run the stressed arm
    - `--scenario` (string) — base scenario export; omitted ⇒ the synthetic default
    - `--index` (number, default `0`) — scenario index in that file
- **`scripts/probes/probe-unitised-equity-rounding.mjs`**
  design 94 §9.3's deciding measurement
    - `--positions` (number, default `20000`) — positions to simulate
    - `--years` (number, default `44`) — horizon in years
    - `--seed` (number, default `12345`) — RNG seed
    - `--par` (number, default `100`) — par value per unit (design 93 §5b's PAR_PER_UNIT)
- **`scripts/probes/probe-wash-sale-materiality.mjs`**
  _(undocumented — no docblock names this file)_
    - `<seeds>` (number, default `25`) — seeds to run
- **`scripts/probes/prototype-crossborder-allocation-scope.mjs`**
  _(undocumented — no docblock names this file)_
    - `--years` (number, default `30`) — horizon in years
    - `--gold-au` (number, default `0.15`) — gold share of the AU side (AU's 50% CGT discount)
- **`scripts/probes/prototype-rebalance-cadence.mjs`**
  _(undocumented — no docblock names this file)_
    - `--paths` (number, default `3000`) — simulated paths
    - `--years` (number, default `40`) — horizon in years
    - `--ltcg` (number, default `0.15`) — long-term capital gains rate (0.20, 0.28 collectible)
    - `--no-crash` (flag) — run without the mid-horizon crash
    - `--crash-year` (number, default `12`) — year the crash lands
    - `--seed` (number, default `12648430`) — RNG seed
    - `--target` (number, default `0.6`) — target equity share
- **`scripts/probes/shock-path-engine.mjs`**
  the EMERGENT equity path of every shock preset, measured by running
    - `--write` (flag) — write the generated table back into the source file
    - `--start-sensitivity` (flag) — also report sensitivity to the start date

### scripts/scenario/

- **`scripts/scenario/audit-scenario.mjs`**
  Headless scenario *auditor* — a QA/sanity-check companion to run-scenario.mjs
    - `<file>` (string, required) — scenario export to audit
    - `--accounts` (list, default ``) — per-action balance-change ledgers for these state keys ("*" = all)
    - `--to` (string) — stop at this YYYY-MM-DD instead of the scenario's simEnd
    - `--first` (flag) — audit only the first scenario if the file holds several
    - `--json` (flag) — emit machine-readable JSON (e.g. to save a regression baseline)
- **`scripts/scenario/diff-scenarios.mjs`** — `npm run diff`
  Answers "where and when do these two scenarios diverge?" — the question run-scenario.mjs cannot, because it only compares *final* summary rows and account balances
    - `<files>` (list, repeatable) — exactly two scenario exports
    - `--at` (string) — point-diff date YYYY-MM-DD (default: simEnd)
    - `--track` (flag) — annual delta series instead of a point diff
    - `--from` (number) — track start year (default: simStart's year)
    - `--fields` (list) — track these dotted state paths (default: net worth, net liquidity, cumulative taxes, cumulative consumption)
    - `--top` (number, default `25`) — point mode: show N largest deltas
    - `--eps` (number, default `1`) — ignore deltas smaller than this
    - `--json` (flag) — machine-readable output
- **`scripts/scenario/import-quicken.mjs`** — `npm run import:quicken`
  a Quicken portfolio export becomes a scenario's accounts
    - `--csv` (string) — Quicken portfolio export, WITH lots (required)
    - `--map` (string) — JSON mapping file (required)
    - `--into` (string) — workbench export to splice into; omitted ⇒ a bare scenario
    - `--out` (string) — where to write; omitted ⇒ dry run, writes nothing
    - `--name` (string) — name for the new scenario record
    - `--id` (string) — id for the new scenario record
    - `--index` (number, default `0`) — which scenario in --into to splice
    - `--keep-sim-start` (flag) — do NOT move simStart to the export snapshot date
    - `--replace` (flag) — patch --index in place instead of appending a copy (chained imports)
    - `--force` (flag) — write even though errors were reported
- **`scripts/scenario/run-scenario.mjs`** — `npm run scenario`
  Headless scenario runner + comparator
    - `<files>` (list, repeatable) — scenario export(s) to run; two or more are compared side-by-side
    - `--to` (string) — stop at this YYYY-MM-DD instead of the scenario's simEnd
    - `--params` (flag) — also table the input params that differ across scenarios
    - `--first` (flag) — run only the first scenario in each file (default: all)
    - `--verbose` (flag) — show the simulation's own console output (e.g. OUT_OF_FUNDS)
    - `--json` (flag) — emit machine-readable JSON instead of tables
    - `--fast` (flag) — drop journal/snapshot/bus telemetry (~12x); disables sim.journal readers
- **`scripts/scenario/sweep-scenario.mjs`** — `npm run sweep`
  Vary ONE scenario param across a range, run the scenario once per value, and table the terminal metrics
    - `<file>` (string, required) — scenario export to sweep
    - `--param` (string) — param to vary (must exist in the scenario's params)
    - `--range` (string) — inclusive numeric range, a:b
    - `--step` (number, default `1`) — range step
    - `--values` (list) — explicit values instead of --range
    - `--to` (string) — stop at this YYYY-MM-DD instead of simEnd
    - `--json` (flag) — machine-readable output

### scripts/tax/

- **`scripts/tax/crossfoot-drill-reports.mjs`** — `npm run crossfoot`
  design 73 §0
    - `<dirs>` (list, repeatable, required) — drill-report directories to crossfoot
    - `--tolerance` (number, default `0.02`) — absolute match tolerance
    - `--verbose` (flag) — list every disagreeing year
- **`scripts/tax/export-tax-csv.mjs`** — `npm run export:tax`
  design 71 Phase 4
    - `<file>` (string) — scenario export; omit with --reference
    - `--reference` (flag) — run the built-in reference scenario instead of loading a file
    - `--cc` (list, default `US`, one of US|AU|STATE|us|au|state) — jurisdictions to export; STATE is the US state return, riding in the 'form' column with country US
    - `--state` (string) — residency state for --reference (NE, HI, SD); without it the reference scenario yields no STATE rows
    - `--year` (list) — restrict to these tax years (default: all settled years)
    - `--schedules` (flag) — also emit supplementary forms (Schedule D)
    - `--to` (string) — stop the run at this YYYY-MM-DD instead of the scenario's simEnd
    - `--out` (string) — write to a file instead of stdout
    - `--check` (flag) — verify the design 71 §6 footing invariants; non-zero exit on failure
    - `--first` (flag) — export only the first scenario if the file holds several
    - `--drill-reports` (list) — export these drill reports alongside the worksheet ("all" for every one)
    - `--drill-out` (string, default `drill-reports`) — drill report output directory
    - `--drill-detail` (string, default `groups`, one of groups|entries) — one row per group per year, or per entry
    - `--drill-cc` (list) — countries for cc-faceted reports (default: --cc, else US,AU)
    - `--list-drill-reports` (flag) — list every report id + title and exit
- **`scripts/tax/fetch-fx-rates.mjs`** — `npm run fetch:rates`
  refresh the pinned daily exchange-rate series in `rates/`
    - `--check` (flag) — report what would change without writing anything
- **`scripts/tax/section988-ingest.mjs`** — `npm run section988:ingest`
  validate real foreign-currency account history before any
    - `--csv` (string) — <name>=<file> account to ingest; `name` labels it in reports
    - `--rules` (string) — classification rules; --rules-schema prints the format
    - `--rules-schema` (flag) — print the rules file format and exit
    - `--rates` (string) — rate table override (default rates/DEXUSAL-daily.csv)
    - `--from` (string) — restrict REPORTING from this YYYY-MM-DD; ingest always reads everything
    - `--to` (string) — restrict reporting to this YYYY-MM-DD
    - `--top` (number, default `15`) — rows per report section
    - `--emit-classified` (string) — write the rows back out with Kind/BusinessFraction filled in and a Status column
    - `--card-statement` (string) — <name>=<file> credit-card statement; needs a "card" block in the rules file
    - `--card-schema` (flag) — print the card block format and exit
    - `--force` (flag) — allow --emit-classified to overwrite a file that is not one of the --csv inputs
    - `--json` (flag) — emit the structured result instead of the human report
- **`scripts/tax/section988-ledger.mjs`**
  design 87 G5
    - `--csv` (string) — <name>=<file> classified history
    - `--rules` (string) — the same rules file the ingest used
    - `--rates` (string) — rate table override
    - `--method` (string, default `pro-rata`, one of fifo|pro-rata) — basis method
    - `--pooling` (string, default `per-account`, one of per-account|commingled) — pooling rule
    - `--compare` (flag) — run all four method × pooling combinations and print the spread
    - `--seed-rate` (number) — re-price every assumed row at this rate (a what-if)
    - `--seed-sweep` (string) — from:to[:step] or a list — what the seeded assumption is worth
    - `--audit` (string) — write the per-row audit CSV and foot it against the report
    - `--audit-all` (flag) — include IGNORE / unclassified rows in that CSV too
    - `--year` (string) — list every disposition in one tax year
    - `--top` (number, default `15`) — rows per report section
    - `--json` (flag) — structured output

---

## Journal action types (173)

Every action a toolset declares, with its payload shape. A type declared by more than
one toolset is one row: the toolsets compose into a single run, so it is one action in
the journal. Reducers that CONSUME each type are deliberately not listed — see design
108 D7.

| type | payload | declared by |
|---|---|---|
| `ACCOUNT_RETITLE_APPLY` | deceasedId: text, survivorId: text | AU_RETIREMENT, US_RETIREMENT |
| `ACCUMULATE_DEFICIT` | amount: number | AU_RETIREMENT, US_RETIREMENT |
| `ADD_REGIME_APPLY` | regime: any | ECONOMIC_REGIMES |
| `ASSET_APPRECIATE_APPLY` | stateKey: text, delta: number | US_REAL_PROPERTY |
| `ASSET_LOCATION_REBALANCE_APPLY` | fromStateKey: text, fromHoldingId: text, toStateKey: text, toHoldingId: text, swapAmount: number | ECONOMIC_REGIMES |
| `AU_DIVIDEND_FRANKED_NONRESIDENT_APPLY` | amount: currency(AUD), stateKey: text | AU_BROKERAGE |
| `AU_DIVIDEND_FRANKED_NONRESIDENT_CASH_APPLY` | amount: currency(AUD), stateKey: text | AU_BROKERAGE |
| `AU_DIVIDEND_FRANKED_NONRESIDENT_TAX` | amount: currency(AUD), stateKey: text | AU_BROKERAGE |
| `AU_DIVIDEND_FRANKED_RESIDENT_APPLY` | amount: currency(AUD), stateKey: text | AU_BROKERAGE |
| `AU_DIVIDEND_FRANKED_RESIDENT_CASH_APPLY` | amount: currency(AUD), stateKey: text | AU_BROKERAGE |
| `AU_DIVIDEND_FRANKED_RESIDENT_TAX` | amount: currency(AUD), stateKey: text | AU_BROKERAGE |
| `AU_DIVIDEND_UNFRANKED_NONRESIDENT_APPLY` | amount: currency(AUD), stateKey: text | AU_BROKERAGE |
| `AU_DIVIDEND_UNFRANKED_NONRESIDENT_TAX` | amount: currency(AUD), stateKey: text | AU_BROKERAGE |
| `AU_DIVIDEND_UNFRANKED_RESIDENT_APPLY` | amount: currency(AUD), stateKey: text | AU_BROKERAGE |
| `AU_DIVIDEND_UNFRANKED_RESIDENT_TAX` | amount: currency(AUD), stateKey: text | AU_BROKERAGE |
| `AU_FIXED_INCOME_EARNINGS_APPLY` | amount: currency(AUD), residency: text, stateKey: text | AU_BANKING |
| `AU_FIXED_INCOME_EARNINGS_TAX` | amount: currency(AUD), residency: text, stateKey: text | AU_BANKING |
| `AU_HOUSE_SALE_APPLY` | salePrice: currency(AUD), costBasis: currency(AUD), stateKey: text, mortgageBalance: currency(AUD), residency: text, ownershipType: text, ownerId: text, owners: any | AU_REAL_PROPERTY |
| `AU_HOUSE_SALE_TAX` | usShortTermGain: currency(AUD), usLongTermGain: currency(AUD), auShortTermGain: currency(AUD), auLongTermGain: currency(AUD), gain: currency(AUD), auIndexedGain: currency(AUD), depreciationGain: currency(AUD), residency: text, proceeds: currency(AUD), costBasis: currency(AUD), description: text, ownershipType: text, ownerId: text, owners: any, auTaxableFraction: number, auExemptionReason: text, acquisitionMs: number, saleMs: number, mainResidenceFrom: text, mainResidenceUntil: text, isPrimaryResidence: boolean | AU_REAL_PROPERTY |
| `AU_INVESTMENT_INTEREST_DEDUCTION` | loanKey: text, amount: number, residency: text, currency: text, ownerId: text, ownershipType: text, owners: any | AU_REAL_PROPERTY, US_REAL_PROPERTY |
| `AU_PERIOD_ADVANCE` | period: any | AU_TAX |
| `AU_QUALIFYING_EARNINGS_APPLY` | amount: currency(AUD), personKey: text, clamps: any, carriedForward: currency(AUD) | AU_RETIREMENT |
| `AU_RENTAL_INCOME_APPLY` | netCash: currency(AUD), taxableRental: number, monthlyDepreciation: number, stateKey: text, residency: text | AU_REAL_PROPERTY |
| `AU_RENTAL_INCOME_TAX` | amount: number, residency: text, ownershipType: text, ownerId: text, owners: any | AU_REAL_PROPERTY |
| `AU_SAVINGS_CONTRIBUTION_APPLY` | amount: currency(AUD) | AU_BANKING |
| `AU_SAVINGS_EARNINGS_APPLY` | amount: currency(AUD), stateKey: text, residency: text | AU_BANKING |
| `AU_SAVINGS_EARNINGS_TAX` | amount: currency(AUD), residency: text, stateKey: text | AU_BANKING |
| `AU_SAVINGS_WITHDRAWAL_APPLY` | amount: currency(AUD) | AU_BANKING |
| `AU_SE_INCOME_TAX` | amount: currency(AUD), residency: text, personKey: text, workCountry: text | AU_INCOME |
| `AU_STOCK_EARNINGS_APPLY` | amount: currency(AUD), stateKey: text | AU_BROKERAGE |
| `AU_STOCK_WITHDRAWAL_APPLY` | salePrice: currency(AUD), costBasis: currency(AUD), residency: text | AU_BROKERAGE |
| `AU_STOCK_WITHDRAWAL_TAX` | gain: currency(AUD), auGain: currency(AUD), auIndexedGain: currency(AUD), auDiscountableGain: currency(AUD), usShortTermGain: currency(AUD), usLongTermGain: currency(AUD), auShortTermGain: currency(AUD), auLongTermGain: currency(AUD), residency: text, proceeds: currency(AUD), costBasis: currency(AUD), description: text, stateKey: text | AU_BROKERAGE |
| `AU_TAX_INSTALMENT_DEBIT` | amount: currency(AUD), quarter: number | AU_TAX |
| `AU_TAX_PAYMENT_DEBIT` | amount: currency(AUD), escalated: boolean, section988: any | AU_TAX |
| `AU_TAX_REFUND_CREDIT` | amount: currency(AUD) | AU_TAX |
| `AU_TAX_SETTLE_APPLY` | tax: number, taxDetail: any, personTaxDetails: any, fxRate: number, fundTax: currency(AUD), fyStartYear: number, limitIndexFactor: number | AU_TAX |
| `AU_WAGES_INCOME_APPLY` | amount: currency(AUD), residency: text, personKey: text, targetKey: text, workCountry: text, netAmount: currency(AUD), splits: any, sacrificed: currency(AUD) | AU_INCOME |
| `AU_WAGES_INCOME_TAX` | amount: currency(AUD), residency: text, personKey: text, workCountry: text | AU_INCOME |
| `BEHAVIORAL_PANIC_SELL_APPLY` | stateKey: text, sourceHoldingId: text, sellAmount: number | ECONOMIC_REGIMES |
| `BOND_ACCRETION_APPLY` | amount: currency(USD), federalTaxableAmount: currency(USD), stateTaxableAmount: currency(USD), stateKey: text, taxMode: text, residency: text | US_RETIREMENT |
| `BOND_COUPON_APPLY` | amount: currency(USD), federalTaxableAmount: currency(USD), stateTaxableAmount: currency(USD), stateKey: text, residency: text | US_BROKERAGE |
| `BOND_COUPON_CASH_APPLY` | amount: currency(USD), federalTaxableAmount: currency(USD), stateTaxableAmount: currency(USD), stateKey: text, residency: text | US_BROKERAGE |
| `BOND_COUPON_TAX` | amount: currency(USD), federalTaxableAmount: currency(USD), stateTaxableAmount: currency(USD), residency: text, stateKey: text | US_BROKERAGE |
| `BOND_SLEEVE_COUPON_APPLY` | amount: currency(USD), federalTaxableAmount: currency(USD), stateTaxableAmount: currency(USD), stateKey: text, taxMode: text, residency: text | US_RETIREMENT |
| `BONUS_APPLY` | amount: currency(USD), residency: text, personKey: text | US_INCOME |
| `BONUS_TAX` | amount: currency(USD), residency: text, personKey: text | US_INCOME |
| `CASH_SLEEVE_INTEREST_APPLY` | amount: currency(USD), stateKey: text, taxMode: text, residency: text | US_RETIREMENT |
| `CHANGE_RESIDENCY_APPLY` | — | US_AU_CROSS_BORDER |
| `CHANGE_STATE_RESIDENCY_APPLY` | destination: text | US_STATE_TAX |
| `COLLECTIBLE_SALE_APPLY` | salePrice: currency(USD), costBasis: currency(USD), residency: text, stateKey: text | US_COLLECTIBLES |
| `COLLECTIBLE_SALE_TAX` | gain: currency(USD), auGain: currency(USD), auIndexedGain: currency(USD), isGold: boolean, currency: text, usShortTermGain: currency(USD), usLongTermGain: currency(USD), auShortTermGain: currency(USD), auLongTermGain: currency(USD), residency: text, stateKey: text, ownershipType: text, ownerId: text, owners: any, proceeds: currency(USD), costBasis: currency(USD), description: text | US_COLLECTIBLES |
| `COLLECTIBLE_VALUE_CHANGE_APPLY` | change: currency(USD), stateKey: text | US_COLLECTIBLES |
| `COMPANY_SALE_APPLY` | salePrice: currency(USD), costBasis: currency(USD), residency: text, stateKey: text, destinationKey: text | US_INCOME |
| `COMPANY_SALE_TAX` | gain: currency(USD), auGain: currency(USD), auIndexedGain: currency(USD), usShortTermGain: currency(USD), usLongTermGain: currency(USD), auShortTermGain: currency(USD), auLongTermGain: currency(USD), residency: text, ownershipType: text, ownerId: text, owners: any, proceeds: currency(USD), costBasis: currency(USD), description: text | US_INCOME |
| `CORPORATE_ACTION_APPLY` | kind: text, securityId: text, stateKeys: any, residency: text, spec: any | CORPORATE_ACTIONS |
| `EQUITY_RETURN_STEP_APPLY` | marketDev: number, deviation: any, driftComp: any, bootstrap: any | ECONOMIC_REGIMES |
| `EXPENSE_DEBIT` | amount: number, realizedAmount: number, priceLevel: number, spendCategory: text, capitalFraction: number, targetKey: text, section988: any | AU_RETIREMENT, US_RETIREMENT |
| `EXPENSE_EVENT_APPLY` | amount: number, category: text, currency: text, propertyKey: text, capitalizeAmount: number, personId: text | AU_RETIREMENT, US_RETIREMENT |
| `FIXED_INCOME_CONTRIBUTION_APPLY` | amount: currency(USD) | US_BROKERAGE |
| `FIXED_INCOME_EARNINGS_APPLY` | amount: currency(USD), stateKey: text, residency: text | US_BROKERAGE |
| `FIXED_INCOME_EARNINGS_TAX` | amount: currency(USD), residency: text, stateKey: text | US_BROKERAGE |
| `FIXED_INCOME_WITHDRAWAL_APPLY` | amount: currency(USD) | US_BROKERAGE |
| `FX_STEP_APPLY` | pair: text, deviation: number | US_AU_CROSS_BORDER |
| `FX_TRANSFER_APPLY` | from: text, to: text, fromAmount: number, toAmount: number, rate: number, fee: currency(USD), section988: any | US_AU_CROSS_BORDER |
| `GUARDRAIL_ADJUST_APPLY` | multiplier: number, cause: text, date: any | AU_RETIREMENT, US_RETIREMENT |
| `GUARDRAIL_BASELINE_APPLY` | initialWithdrawalRate: number, portfolioValue: number, annualSpending: number, date: any | AU_RETIREMENT, US_RETIREMENT |
| `HOUSE_REPAIR_APPLY` | stateKey: text, amount: number, capitalize: number | US_RETIREMENT |
| `INFLATION_STEP_APPLY` | deviation: any, latent: any, floor: number, historicalYear: number, passThrough: any, primeDeviation: any, primeFloor: any | ECONOMIC_REGIMES |
| `INHERIT_APPLY` | stateKey: text, name: text, category: text, country: text, inheritedValue: number, usCitizen: text, auResident: text, inheritanceDateMs: number | INHERITANCE |
| `INHERITED_RA_DISTRIBUTION_APPLY` | amount: currency(USD), stateKey: text, isRoth: text, residency: text | INHERITANCE |
| `INHERITED_RA_DISTRIBUTION_TAX` | amount: currency(USD), residency: text, stateKey: text | INHERITANCE |
| `INTL_TRANSFER_APPLY` | targetDeficit: number, direction: text, section988: any | US_AU_CROSS_BORDER |
| `INTL_TRANSFER_RECORD` | direction: text, srcKey: text, dstKey: text, from: text, to: text, fromAmount: number, toAmount: number, fee: number | US_AU_CROSS_BORDER |
| `IRA_CONTRIBUTION_APPLY` | amount: currency(USD), stateKey: text | US_RETIREMENT |
| `IRA_CONTRIBUTION_TAX` | amount: currency(USD) | US_RETIREMENT |
| `IRA_EARNINGS_APPLY` | amount: currency(USD), stateKey: text, derivedAmount: number | US_RETIREMENT |
| `IRA_RMD_APPLY` | amount: currency(USD), residency: text, stateKey: text | US_RETIREMENT |
| `IRA_RMD_TAX` | amount: currency(USD), residency: text, stateKey: text | US_RETIREMENT |
| `IRA_ROLLOVER_WITHDRAWAL_APPLY` | amount: currency(USD), residency: text | US_RETIREMENT |
| `IRA_ROLLOVER_WITHDRAWAL_TAX` | amount: currency(USD), residency: text, stateKey: text | US_RETIREMENT |
| `IRA_WITHDRAWAL_CONTRIB_APPLY` | amount: currency(USD), penaltyAmount: number | US_RETIREMENT |
| `IRA_WITHDRAWAL_CONTRIB_TAX` | amount: currency(USD), penaltyAmount: number | US_RETIREMENT |
| `IRA_WITHDRAWAL_EARNINGS_APPLY` | amount: currency(USD), penaltyAmount: number, residency: text | US_RETIREMENT |
| `IRA_WITHDRAWAL_EARNINGS_TAX` | amount: currency(USD), penaltyAmount: number, residency: text, stateKey: text | US_RETIREMENT |
| `K401_CONTRIBUTION_APPLY` | amount: currency(USD), stateKey: text, employerFunded: boolean, personKey: text, nonElective: boolean, clamps: any | US_RETIREMENT |
| `K401_CONTRIBUTION_TAX` | amount: currency(USD) | US_RETIREMENT |
| `K401_EARNINGS_APPLY` | amount: currency(USD), stateKey: text, derivedAmount: number | US_RETIREMENT |
| `K401_RMD_APPLY` | amount: currency(USD), residency: text, stateKey: text | US_RETIREMENT |
| `K401_RMD_TAX` | amount: currency(USD), residency: text, stateKey: text | US_RETIREMENT |
| `K401_TO_IRA_CONVERSION_APPLY` | amount: currency(USD) | US_RETIREMENT |
| `K401_WITHDRAWAL_APPLY` | amount: currency(USD), penaltyAmount: number | US_RETIREMENT |
| `K401_WITHDRAWAL_TAX` | amount: currency(USD), penaltyAmount: number | US_RETIREMENT |
| `LATE_LIFE_CARE_APPLY` | active: boolean, factor: number, personId: text | AU_RETIREMENT, US_RETIREMENT |
| `LOAN_PAYMENT_APPLY` | loanKey: text, payment: number, interest: number, cashDue: number, section988: any | AU_REAL_PROPERTY, US_REAL_PROPERTY |
| `NE_INHERITANCE_TAX` | amount: currency(USD) | INHERITANCE |
| `OPPORTUNISTIC_REBALANCE_APPLY` | stateKey: text, legs: any | ECONOMIC_REGIMES |
| `OUT_OF_FUNDS` | deficit: number, currency: text | AU_RETIREMENT, US_RETIREMENT |
| `PERSON_DIED_APPLY` | personId: text, personName: text, date: any, taxJurisdiction: text, deceasedSocialSecurityMonthly: number, incomeSupportRecipient: boolean | AU_RETIREMENT, US_RETIREMENT |
| `POOL_FLOW_APPLY` | flowId: text, from: text, to: text, amountBase: number, year: number | ECONOMIC_REGIMES |
| `PROPERTY_PURCHASE_APPLY` | stateKey: text, price: number, cashDue: number, purchaseMs: number, section988: any | AU_REAL_PROPERTY, US_REAL_PROPERTY |
| `PROPERTY_RETURN_STEP_APPLY` | marketDev: number, deviation: any, driftComp: any | ECONOMIC_REGIMES |
| `REBALANCE_TO_TARGET_APPLY` | stateKey: text, role: text, taxable: any, country: text, legs: any | ECONOMIC_REGIMES |
| `RECOMPUTE_REGIMES` | — | ECONOMIC_REGIMES |
| `RECORD_BALANCE` | fieldPath: text, metricKey: text | AU_TAX, US_TAX |
| `REMOVE_REGIME_APPLY` | regimeId: text | ECONOMIC_REGIMES |
| `REPLENISH_SAVINGS` | deficit: number, targetKey: text | AU_RETIREMENT, US_RETIREMENT |
| `REVALUE_ASSET_APPLY` | rateKey: text, multiplier: number, targetStateKeys: any, holdingsStateKeys: any | ECONOMIC_REGIMES |
| `ROTH_CONTRIBUTION_APPLY` | amount: currency(USD), stateKey: text | US_RETIREMENT |
| `ROTH_CONVERSION_APPLY` | amount: currency(USD), residency: text | US_ROTH_CONVERSION |
| `ROTH_CONVERSION_TAX` | amount: currency(USD), residency: text | US_ROTH_CONVERSION |
| `ROTH_EARNINGS_APPLY` | amount: currency(USD), stateKey: text, derivedAmount: number | US_RETIREMENT |
| `ROTH_ROLLOVER_CONTRIBUTION_APPLY` | amount: currency(USD) | US_RETIREMENT |
| `ROTH_ROLLOVER_EARNINGS_APPLY` | amount: currency(USD) | US_RETIREMENT |
| `ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_APPLY` | amount: currency(USD), penaltyAmount: number, auAssessableAmount: number, residency: text, rolloverConversions: any | US_RETIREMENT |
| `ROTH_ROLLOVER_WITHDRAWAL_CONTRIB_TAX` | amount: currency(USD), penaltyAmount: number, auAssessableAmount: number, residency: text, stateKey: text | US_RETIREMENT |
| `ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_APPLY` | amount: currency(USD), penaltyAmount: number, residency: text | US_RETIREMENT |
| `ROTH_ROLLOVER_WITHDRAWAL_EARNINGS_TAX` | amount: currency(USD), penaltyAmount: number, residency: text, stateKey: text | US_RETIREMENT |
| `ROTH_WITHDRAWAL_CONTRIB_APPLY` | amount: currency(USD) | US_RETIREMENT |
| `ROTH_WITHDRAWAL_EARNINGS_APPLY` | amount: currency(USD), penaltyAmount: number, residency: text | US_RETIREMENT |
| `ROTH_WITHDRAWAL_EARNINGS_TAX` | amount: currency(USD), penaltyAmount: number, auAssessableAmount: number, residency: text, stateKey: text | US_RETIREMENT |
| `SCENARIO_COMPLETE_CHECK` | — | AU_RETIREMENT, US_RETIREMENT |
| `SCHEDULED_EARLY_WITHDRAWAL_APPLY` | taxDeferredAmount: currency(USD), rothAmount: currency(USD), residency: text | US_EARLY_WITHDRAWAL |
| `SE_INCOME_AU_APPLY` | amount: currency(AUD), residency: text, personKey: text, targetKey: text, workCountry: text, netAmount: currency(AUD), splits: any | AU_INCOME |
| `SE_INCOME_US_APPLY` | amount: currency(USD), residency: text, personKey: text, targetKey: text, workCountry: text, netAmount: currency(USD), splits: any | US_INCOME |
| `SE_INCOME_US_TAX` | amount: currency(USD), residency: text, personKey: text | US_INCOME |
| `SECTION_988_GAIN` | loanKey: text, accountKey: text, holdingId: text, currency: text, amount: number, gross: number, disallowedLoss: number, deMinimis: number, capitalGain: number, longTerm: any, residency: text | AU_REAL_PROPERTY, US_AU_CROSS_BORDER, US_REAL_PROPERTY |
| `SET_OUT_OF_FUNDS_DATE` | date: any | AU_RETIREMENT, US_RETIREMENT |
| `SOCIAL_SECURITY_SURVIVOR_APPLY` | survivorId: text, deceasedSocialSecurityMonthly: number | AU_RETIREMENT, US_RETIREMENT |
| `SPENDING_REFILL` | date: any | ECONOMIC_REGIMES |
| `SPENDING_STRATEGY_APPLY` | slice: text, delta: number, reason: text | AU_RETIREMENT, US_RETIREMENT |
| `SS_INCOME_APPLY` | amount: currency(USD), residency: text, personKey: text | US_INCOME |
| `SS_INCOME_TAX` | amount: currency(USD), residency: text, personKey: text | US_INCOME |
| `STATE_TAX_PAYMENT_DEBIT` | amount: currency(USD), escalated: boolean | US_STATE_TAX |
| `STATE_TAX_SETTLE_APPLY` | tax: number, taxDetail: any, fxRate: number | US_STATE_TAX |
| `STOCK_CONTRIBUTION_APPLY` | amount: currency(USD) | US_BROKERAGE |
| `STOCK_DIVIDEND_APPLY` | amount: currency(USD), residency: text, stateKey: text | US_BROKERAGE |
| `STOCK_DIVIDEND_CASH_APPLY` | amount: currency(USD), residency: text, stateKey: text | US_RETIREMENT |
| `STOCK_DIVIDEND_TAX` | amount: currency(USD), residency: text, stateKey: text | US_BROKERAGE |
| `STOCK_EARNINGS_APPLY` | amount: currency(USD), stateKey: text | US_BROKERAGE |
| `STOCK_HARVEST_APPLY` | stateKey: text, sellAmount: number, sourceHoldingId: text, substituteHoldingId: text, substituteSecurityId: text, purpose: text, residency: text | ECONOMIC_REGIMES |
| `STOCK_WITHDRAWAL_APPLY` | salePrice: currency(USD), costBasis: currency(USD), residency: text | US_BROKERAGE |
| `STOCK_WITHDRAWAL_TAX` | currency: text, gain: currency(USD), auGain: currency(USD), auIndexedGain: currency(USD), auDiscountableGain: currency(USD), usShortTermGain: currency(USD), usLongTermGain: currency(USD), auShortTermGain: currency(USD), auLongTermGain: currency(USD), residency: text, proceeds: currency(USD), costBasis: currency(USD), description: text, stateKey: text, washDisallowed: currency(USD) | US_BROKERAGE |
| `SUPER_CAPITAL_GAIN` | stateKey: text, discountableGain: currency(AUD), otherGain: currency(AUD), capitalLoss: currency(AUD), revenueGain: currency(AUD) | AU_RETIREMENT |
| `SUPER_CONTRIBUTION_APPLY` | amount: currency(AUD), stateKey: text, employerFunded: boolean, deductible: boolean, personKey: text, clamps: any, carriedForward: currency(AUD), section988: any | AU_RETIREMENT |
| `SUPER_CONTRIBUTION_TAX` | amount: currency(AUD), stateKey: text | AU_RETIREMENT |
| `SUPER_DEATH_BENEFIT_APPLY` | stateKey: text, taxable: number, paidViaEstate: boolean | AU_RETIREMENT, US_RETIREMENT |
| `SUPER_DEATH_BENEFIT_TAX` | amount: currency(AUD) | INHERITANCE |
| `SUPER_DOWNSIZER_CONTRIBUTION_APPLY` | personKey: text, amount: number, reason: text, section988: any | AU_REAL_PROPERTY |
| `SUPER_EARNINGS_APPLY` | amount: currency(AUD), grossAmount: currency(AUD), frankingCredit: currency(AUD), stateKey: text, taxRate: number | AU_RETIREMENT |
| `SUPER_EARNINGS_TAX` | amount: currency(AUD), frankingCredit: currency(AUD), stateKey: text, taxRate: number | AU_RETIREMENT |
| `SUPER_NON_CONCESSIONAL_APPLY` | amount: currency(AUD), stateKey: text, personKey: text, clamps: any, carriedForward: currency(AUD), section988: any | AU_RETIREMENT |
| `SUPER_PERSONAL_DEDUCTION` | amount: currency(AUD), stateKey: text, personKey: text | AU_RETIREMENT |
| `SUPER_SACRIFICE_APPLY` | amount: currency(AUD), stateKey: text, personKey: text, clamps: any, carriedForward: currency(AUD) | AU_RETIREMENT |
| `SUPER_WITHDRAWAL_CONTRIB_APPLY` | amount: currency(AUD), blocked: boolean | AU_RETIREMENT |
| `SUPER_WITHDRAWAL_EARNINGS_APPLY` | amount: currency(AUD), blocked: boolean | AU_RETIREMENT |
| `SUPER_WITHDRAWAL_EARNINGS_TAX` | amount: currency(AUD) | AU_RETIREMENT |
| `TLH_NO_SUBSTITUTE` | count: number, holdingIds: any, stateKeys: any | ECONOMIC_REGIMES |
| `US_HOUSE_SALE_APPLY` | salePrice: currency(USD), costBasis: currency(USD), stateKey: text, mortgageBalance: currency(USD), residency: text | US_REAL_PROPERTY |
| `US_HOUSE_SALE_TAX` | gain: currency(USD), depreciationGain: currency(USD), auGain: currency(USD), auIndexedGain: currency(USD), auDiscountableGain: currency(USD), usShortTermGain: currency(USD), usLongTermGain: currency(USD), auShortTermGain: currency(USD), auLongTermGain: currency(USD), residency: text, proceeds: currency(USD), costBasis: currency(USD), description: text, ownershipType: text, ownerId: text, owners: any | US_REAL_PROPERTY |
| `US_INVESTMENT_INTEREST_DEDUCTION` | loanKey: text, amount: number, residency: text, currency: text, ownerId: text, ownershipType: text, owners: any | AU_REAL_PROPERTY, US_REAL_PROPERTY |
| `US_PERIOD_ADVANCE` | period: any | US_TAX |
| `US_RENTAL_INCOME_APPLY` | netCash: currency(USD), taxableRental: number, monthlyDepreciation: number, stateKey: text, residency: text | US_REAL_PROPERTY |
| `US_RENTAL_INCOME_TAX` | amount: number, residency: text, ownershipType: text, ownerId: text, owners: any | US_REAL_PROPERTY |
| `US_SAVINGS_INTEREST_CREDIT` | amount: currency(USD), stateKey: text | US_BANKING |
| `US_TAX_FILE_APPLY` | taxYear: number, delta: currency(USD), disallowed: currency(USD), ledger: any, remaining: any, capitalLoss: any, basisAdjustments: any | US_TAX |
| `US_TAX_INSTALMENT_DEBIT` | amount: currency(USD), quarter: number | US_TAX |
| `US_TAX_PAYMENT_DEBIT` | amount: currency(USD), escalated: boolean, section988: any | US_TAX |
| `US_TAX_REFUND_CREDIT` | amount: currency(USD) | US_TAX |
| `US_TAX_SETTLE_APPLY` | withheld: currency(USD), tax: number, taxDetail: any, fxRate: number, usTaxPaidOnUsSourceAud: currency(AUD) | US_TAX |
| `WAGES_INCOME_APPLY` | amount: currency(USD), residency: text, personKey: text, targetKey: text, workCountry: text, netAmount: currency(USD), splits: any | US_INCOME |
| `WAGES_INCOME_TAX` | amount: currency(USD), residency: text, personKey: text | US_INCOME |
| `WAGES_WITHHELD_APPLY` | amount: currency(USD), personKey: text, alreadyNetted: boolean | US_INCOME |
| `YIELD_CURVE_STEP_APPLY` | country: text, deviation: number | ECONOMIC_REGIMES |

---

## State field types (266)

The scenario-INDEPENDENT half of `StateSchemaRegistry`: the globs and exact paths it
installs in its own constructor, with the value type that decides how each formats.
Per-account paths are absent by design — they belong to a loaded plan, not to the
framework, so listing one plan's accounts would be wrong for every other plan.

| path | kind |
|---|---|
| `*._bondLadderRungs` | integer |
| `*.acquisitionDateByCountry.*` | date |
| `*.acquisitionPriceLevel` | decimal |
| `*.appreciationRate` | rate |
| `*.balance` | currency |
| `*.bookingFxRate` | fxRate |
| `*.capitalGainsYTD.capitalLoss` | currency |
| `*.capitalGainsYTD.carriedLoss` | currency |
| `*.capitalGainsYTD.discountableGain` | currency |
| `*.capitalGainsYTD.fy` | year |
| `*.capitalGainsYTD.netGain` | currency |
| `*.capitalGainsYTD.otherGain` | currency |
| `*.capitalGainsYTD.revenueGain` | currency |
| `*.capitalizeRepairs` | percentage |
| `*.contributionBasis` | currency |
| `*.costBaseStepUpByCountry.*` | currency |
| `*.derivedIncomeBasis` | currency |
| `*.drawdownPriority` | integer |
| `*.earningsBasis` | currency |
| `*.fxBasisRate` | fxRate |
| `*.fxBasisUsd` | currency(USD) |
| `*.holdings.*.acquisitionDateByCountry.*` | date |
| `*.holdings.*.acquisitionPriceLevel` | decimal |
| `*.holdings.*.allocation` | text |
| `*.holdings.*.appreciationSchedule` | unknown |
| `*.holdings.*.costBaseByCountry.*` | currency |
| `*.holdings.*.costBasis` | currency |
| `*.holdings.*.couponFrequency` | integer |
| `*.holdings.*.couponRate` | rate |
| `*.holdings.*.cpiIndexRatio` | decimal |
| `*.holdings.*.dividendYield` | rate |
| `*.holdings.*.duration` | decimal |
| `*.holdings.*.faceValue` | currency |
| `*.holdings.*.label` | text |
| `*.holdings.*.marketValue` | currency |
| `*.holdings.*.parPerUnit` | currency |
| `*.holdings.*.pricePerUnit` | currency |
| `*.holdings.*.purchaseDate` | date |
| `*.holdings.*.rateKey` | text |
| `*.holdings.*.rollTermYears` | integer |
| `*.holdings.*.taxLossPartner` | text |
| `*.holdings.*.units` | decimal |
| `*.interestRate` | rate |
| `*.maturityYear` | year |
| `*.minimumAge` | decimal |
| `*.minimumBalance` | currency |
| `*.plannedSaleYear` | year |
| `*.primeSpread` | rate |
| `*.repairLambda` | decimal |
| `*.repairProb` | percentage |
| `*.repairSigma` | decimal |
| `*.repairValuePct` | percentage |
| `*.rolloverConversions.*.conversionMs` | date |
| `*.runningCostGrowth` | rate |
| `*.runningCostValuePct` | percentage |
| `*.targetBand` | percentage |
| `*.targetComposition.*` | percentage |
| `activeRegimes.*.currentFactor` | decimal |
| `activeRegimes.*.durationMonths` | integer |
| `activeRegimes.*.interestRateAdjustment.*` | rate |
| `activeRegimes.*.reboundPeak` | decimal |
| `activeRegimes.*.reboundStart` | decimal |
| `activeRegimes.*.returnAdjustment.*` | rate |
| `activeRegimes.*.severity` | percentage |
| `activeRegimes.*.yieldCurveTwist.*.*.spread` | rate |
| `activeRegimes.*.yieldCurveTwist.*.*.tenor` | decimal |
| `ageBandSpending.appliedFactor` | decimal |
| `auCapitalGainsYTD` | currency(AUD) |
| `auCgtEffectiveRate` | percentage |
| `auDeductibleSuperYTD` | currency(AUD) |
| `auDiscountableGainsYTD` | currency(AUD) |
| `auDiscountAllowanceYTD` | currency(AUD) |
| `auDiscountApportionedBaseYTD` | currency(AUD) |
| `auFrankingCreditYTD` | currency(AUD) |
| `auGdpUplift` | decimal |
| `auNonResidentWithholdingYTD` | currency(AUD) |
| `auNotionalTaxRate` | decimal |
| `auNrWithholdingInterestYTD` | currency(AUD) |
| `auNrWithholdingUnfrankedDividendYTD` | currency(AUD) |
| `auOrdinaryIncomeYTD` | currency(AUD) |
| `auPersonCapitalGainsYTD.*` | currency(AUD) |
| `auPersonCapitalLossPool.*` | currency(AUD) |
| `auPersonDeductibleSuperYTD.*` | currency(AUD) |
| `auPersonDiscountableGainsYTD.*` | currency(AUD) |
| `auPersonDiscountAllowanceYTD.*` | currency(AUD) |
| `auPersonDiscountApportionedBaseYTD.*` | currency(AUD) |
| `auPersonEarnedIncomeYTD.*` | currency(AUD) |
| `auPersonFrankingCreditYTD.*` | currency(AUD) |
| `auPersonNonResidentWithholdingYTD.*` | currency(AUD) |
| `auPersonNrWithholdingInterestYTD.*` | currency(AUD) |
| `auPersonNrWithholdingUnfrankedDividendYTD.*` | currency(AUD) |
| `auPersonOrdinaryIncomeYTD.*` | currency(AUD) |
| `auPersonRealCapitalGainsYTD.*` | currency(AUD) |
| `auPersonSuperTaxYTD.*` | currency(AUD) |
| `auPersonTaxLossPool.*` | currency(AUD) |
| `auPersonUsSourceCapGainsAudYTD.*` | currency(AUD) |
| `auPersonUsSourceOrdinaryAudYTD.*` | currency(AUD) |
| `auPersonUsSourceRealCapGainsAudYTD.*` | currency(AUD) |
| `auRealCapitalGainsYTD` | currency(AUD) |
| `auSuperCapsByPerson.*.bringForward.firstFy` | year |
| `auSuperCapsByPerson.**` | currency(AUD) |
| `auSuperTaxYTD` | currency(AUD) |
| `baseAppreciationRates.*` | rate |
| `baseExchangeRates.*` | fxRate |
| `baseFxFees.*` | currency(USD) |
| `baseFxVol.*` | decimal |
| `baseGrowthRates.*` | rate |
| `baseInflationRates.*` | rate |
| `baseInterestRates.*` | rate |
| `baseYieldCurve.*.*.spread` | rate |
| `baseYieldCurve.*.*.tenor` | decimal |
| `bracketIndexAccumulator` | decimal |
| `bracketIndexAccumulator.*` | decimal |
| `bracketIndexAccumulatorByYear` | decimal |
| `bracketIndexAccumulatorByYear.**` | decimal |
| `bracketIndexSpreads.*` | rate |
| `contributionsSuspended` | boolean |
| `cpiAccumulator` | decimal |
| `cpiAccumulator.*` | decimal |
| `cpiRates.*` | rate |
| `cumulativeConsumption` | currency(USD) |
| `cumulativeConsumptionMarginalUtility` | decimal |
| `cumulativeConsumptionUtility` | decimal |
| `cumulativeConsumptionUtilityCount` | integer |
| `cumulativeDeficit` | currency(USD) |
| `cumulativeTaxesPaid` | currency(USD) |
| `currentPeriods.*.endMs` | date |
| `currentPeriods.*.name` | text |
| `currentPeriods.*.startMs` | date |
| `deceased.*.date` | date |
| `deceased.*.taxJurisdiction` | text |
| `deficitMonths` | integer |
| `discretionarySharePct` | percentage |
| `drawdownRebalanceWeight` | decimal |
| `effectiveAppreciationRates.*` | rate |
| `effectiveExchangeRates.*` | fxRate |
| `effectiveFxFees.*` | currency(USD) |
| `effectiveFxVol.*` | decimal |
| `effectiveGrowthRates.*` | rate |
| `effectiveInflationRates.*` | rate |
| `effectiveInterestRates.*` | rate |
| `equityInflationPassThrough.*` | rate |
| `equityReturnBootstrap.index` | integer |
| `equityReturnBootstrap.remaining` | integer |
| `equityReturnBootstrap.year` | integer |
| `equityReturnDev.*` | rate |
| `equityReturnDriftComp.*` | rate |
| `equityReturnMarketDev` | rate |
| `expenses.discretionary` | currency(USD) |
| `expenses.essential` | currency(USD) |
| `foreignGeneralCapGainsYTD` | currency(USD) |
| `foreignGeneralIncomeYTD` | currency(USD) |
| `foreignPassiveCapGainsYTD` | currency(USD) |
| `foreignPassiveIncomeYTD` | currency(USD) |
| `ftcCurrentForeignTax` | currency(USD) |
| `ftcCurrentGeneral` | currency(USD) |
| `ftcCurrentPassive` | currency(USD) |
| `ftcCurrentResourced` | currency(USD) |
| `ftcPoolGeneral.*` | currency(USD) |
| `ftcPoolPassive.*` | currency(USD) |
| `ftcPoolResourced.*` | currency(USD) |
| `ftcYTD` | currency(USD) |
| `fxAnchorRates.*` | fxRate |
| `fxDeviation.*` | decimal |
| `inflationAccumulator` | decimal |
| `inflationAccumulator.*` | decimal |
| `inflationDev.*` | rate |
| `inflationFloor` | rate |
| `inflationLatent.*` | decimal |
| `inflationRates.*` | rate |
| `k401ContributionsYTD.*.*` | currency(USD) |
| `limitIndexAccumulator` | decimal |
| `limitIndexAccumulator.*` | decimal |
| `marketDividendYields.*` | rate |
| `marketIndex.*.price` | index |
| `marketIndex.*.total` | index |
| `marketIndexAsOfMs` | date |
| `metrics.*` | metric |
| `metrics.afterTaxNetLiquidity` | currency(USD) |
| `metrics.afterTaxNetWorth` | currency(USD) |
| `metrics.netLiquidity` | currency(USD) |
| `metrics.netWorth` | currency(USD) |
| `metrics.netWorthInclSpeculative` | currency(USD) |
| `monthlyExpenses` | currency(USD) |
| `outOfFundsDate` | date |
| `people.*.lifeExpectancy` | integer |
| `people.*.residency` | text |
| `people.*.residencySinceMs` | date |
| `people.*.residencyState` | text |
| `primeDev.*` | rate |
| `primeFloor.*` | rate |
| `primeLinks.*.spread` | rate |
| `priorMarkCurve.*.*.spread` | rate |
| `priorMarkCurve.*.*.tenor` | decimal |
| `priorMarkMs` | date |
| `priorMarkRates.*` | rate |
| `propertyReturnDev.*` | rate |
| `propertyReturnDriftComp.*` | rate |
| `propertyReturnMarketDev` | rate |
| `scenarioComplete` | boolean |
| `scenarioFailed` | boolean |
| `securities.*.beta` | decimal |
| `securities.*.dividendYield` | rate |
| `securities.*.idioVol` | decimal |
| `securityIndex.*.price` | index |
| `securityIndex.*.total` | index |
| `securityReturnDev.*` | rate |
| `securityReturnDriftComp.*` | rate |
| `securityReturnOverlay.*` | rate |
| `stateCapitalGainsYTD` | currency(USD) |
| `stateOrdinaryIncomeYTD` | currency(USD) |
| `statePensionIncomeYTD` | currency(USD) |
| `stateSsIncomeYTD` | currency(USD) |
| `superWithdrawalBlocked` | boolean |
| `taxBasis.AU.*.year` | year |
| `taxBasis.AU.**` | currency(AUD) |
| `taxBasis.US.**` | currency(USD) |
| `taxBasis.US.year` | year |
| `taxInstalmentsPaid.AU` | currency(AUD) |
| `taxInstalmentsPaid.US` | currency(USD) |
| `usCapitalGainsYTD` | currency(USD) |
| `usCollectibleGainsYTD` | currency(USD) |
| `usFeieElected` | boolean |
| `usFilingSingle` | boolean |
| `usFilingSingleBase` | boolean |
| `usForeignPassiveActivityIncomeYTD` | currency(USD) |
| `usInvestmentInterestCarryforward` | currency(USD) |
| `usInvestmentInterestYTD` | currency(USD) |
| `usLongTermCapitalLossCarryforward` | currency(USD) |
| `usNegativeIncomeYTD` | currency(USD) |
| `usNetInvestmentIncomeYTD` | currency(USD) |
| `usOrdinaryIncomeYTD` | currency(USD) |
| `usPassiveActivityIncomeYTD` | currency(USD) |
| `usPassiveLossCarryforward` | currency(USD) |
| `usPenaltyYTD` | currency(USD) |
| `usPersonHousehold` | boolean |
| `usSection988DisallowedLossYTD` | currency(USD) |
| `usSection988GainYTD` | currency(USD) |
| `usSeEarningsYTD` | currency(USD) |
| `usShortTermCapitalGainsYTD` | currency(USD) |
| `usShortTermCapitalLossCarryforward` | currency(USD) |
| `usSourceCapGainsAudYTD` | currency(AUD) |
| `usSourceCapGainsUsdYTD` | currency(USD) |
| `usSourceDividendsUsdYTD` | currency(USD) |
| `usSourceGeneralCapGainsUsdYTD` | currency(USD) |
| `usSourceGeneralUsdYTD` | currency(USD) |
| `usSourceInterestUsdYTD` | currency(USD) |
| `usSourceOrdinaryAudYTD` | currency(AUD) |
| `usSourceOrdinaryUsdYTD` | currency(USD) |
| `usSourcePassiveCapGainsUsdYTD` | currency(USD) |
| `usSourcePassiveUsdYTD` | currency(USD) |
| `usSourceRealCapGainsAudYTD` | currency(AUD) |
| `usSsWagesByPersonYTD.*` | currency(USD) |
| `usSsWagesYTD` | currency(USD) |
| `usTaxPaidOnUsSourceAud` | currency(AUD) |
| `usUnrecaptured1250GainYTD` | currency(USD) |
| `usWithheldYTD` | currency(USD) |
| `washPendingLosses.*.heldFromMs` | date |
| `washPendingLosses.*.ms` | date |
| `washPendingLosses.*.units` | decimal |
| `washSaleLedger.*.filedYear` | year |
| `washSaleLedger.*.matchedFraction` | percentage |
| `washSaleLedger.*.ms` | date |
| `yieldCurve.*.*.spread` | rate |
| `yieldCurve.*.*.tenor` | decimal |
| `yieldCurveLevelDev.*` | rate |

---

## Topics (60)

Tier 2 — the hand-written prose under `help/`, listed by what it CITES rather than
summarised. A topic may not restate a param description (design 108 §3), so there is
nothing here to duplicate: the row points at the file, and the file says the thing
tier 1 cannot. **Cites** is the frontmatter, which is also what the gate checks and
what the in-app panel keys on.

| topic | kind | words | cites |
|---|---|---|---|
| [Action Detail](panels/action-detail.md) | panel | 172 | 1 panel · design 91 |
| [Allocation](panels/allocation.md) | panel | 185 | 1 panel · design 82 |
| [Allocation and Rebalancing](concepts/allocation-and-rebalancing.md) | concept | 266 | 2 panels · 14 params · design 61, 82 |
| [AU Tax and PAYG Instalments](concepts/au-tax.md) | concept | 236 | 2 panels · 6 params · design 107 |
| [Behavioral Strategies](concepts/behavioral-strategies.md) | concept | 232 | 2 panels · 5 params · design 29 |
| [Bond Ladders](concepts/bond-ladders.md) | concept | 237 | 1 panel · 7 params · design 66 |
| [Chart](panels/chart.md) | panel | 199 | 1 panel |
| [Graph](panels/config-graph.md) | panel | 197 | 1 panel |
| [Nodes](panels/config-list.md) | panel | 173 | 1 panel |
| [Contributions and Payroll](concepts/contributions-and-payroll.md) | concept | 242 | 1 panel · 13 params · design 95 |
| [Cost Basis and Company Equity](concepts/cost-basis-and-equity.md) | concept | 247 | 2 panels · 4 params · design 94, 72 |
| [Field × Action](panels/cross-action-query.md) | panel | 196 | 1 panel |
| [Cross-Border Residency](concepts/cross-border-residency.md) | concept | 238 | 2 panels · 4 params · design 36, 52 |
| [Dashboard](panels/dashboard.md) | panel | 183 | 1 panel |
| [Decision Graph](panels/dg-config.md) | panel | 168 | 1 panel · design 30 |
| [DG Results](panels/dg-results.md) | panel | 162 | 1 panel · design 30 |
| [Drawdown Order](concepts/drawdown-order.md) | concept | 272 | 2 panels · 22 params · design 44, 65, 97 |
| [Early Withdrawal](concepts/early-withdrawal.md) | concept | 228 | 1 panel · 8 params |
| [Economic Shocks](concepts/economic-shocks.md) | concept | 242 | 2 panels · 3 params |
| [Event Sourcing](concepts/event-sourcing.md) | concept | 381 | 3 panels · design 2, 16, 91 |
| [Node History](panels/exec-history.md) | panel | 191 | 1 panel |
| [Funding and Instalments](concepts/funding-and-instalments.md) | concept | 248 | 2 panels · 3 params · design 107 |
| [FX](concepts/fx.md) | concept | 257 | 2 panels · 5 params · design 47, 87 |
| [Help](panels/help.md) | panel | 223 | 1 panel · design 108 |
| [Holdings](panels/holdings.md) | panel | 188 | 1 panel · design 82 |
| [Inflation](concepts/inflation.md) | concept | 261 | 2 panels · 18 params · design 103 |
| [Edit](panels/inspector.md) | panel | 182 | 1 panel |
| [Interest Rates and the Yield Curve](concepts/interest-rates.md) | concept | 250 | 2 panels · 23 params · design 56, 67 |
| [Journal Report](panels/journal-report.md) | panel | 193 | 1 panel · design 16 |
| [Lineage](panels/lineage.md) | panel | 196 | 1 panel · design 30 |
| [Liquidity Pools](concepts/liquidity-pools.md) | concept | 294 | 1 panel · 6 params · design 97 |
| [Monte Carlo](panels/mc-config.md) | panel | 194 | 1 panel · design 100 |
| [MC Results](panels/mc-results.md) | panel | 202 | 1 panel · design 100, 89 |
| [MC Runs](panels/mc-runs.md) | panel | 196 | 1 panel · design 100 |
| [Mortality and Survivorship](concepts/mortality.md) | concept | 253 | 2 panels · 5 params |
| [MPC Cockpit](panels/mpc-cockpit.md) | panel | 200 | 1 panel · design 39, 80 |
| [Optimize](panels/opt-config.md) | panel | 186 | 1 panel |
| [OPT Results](panels/opt-results.md) | panel | 186 | 1 panel |
| [OPT Runs](panels/opt-runs.md) | panel | 139 | 1 panel |
| [Objectives and After-Tax Value](concepts/optimizer-objectives.md) | concept | 258 | 3 panels · 7 params · design 40 |
| [Parameters](panels/parameters.md) | panel | 188 | 1 panel · design 98 |
| [Paycheque](panels/paycheque.md) | panel | 197 | 1 panel · design 95, 107 |
| [Performance](panels/perf.md) | panel | 201 | 1 panel · design 78 |
| [Pool Shapes Over Time](concepts/pool-shapes-over-time.md) | concept | 378 | 2 params · design 109, 97 |
| [Liquidity Pools](panels/pools.md) | panel | 217 | 1 panel · design 97 |
| [Randomness and Seeds](concepts/randomness-and-seeds.md) | concept | 251 | 2 panels · 2 params · design 74 |
| [Return Assumptions](concepts/return-assumptions.md) | concept | 266 | 2 panels · 13 params · design 99, 106 |
| [Roth Conversions](concepts/roth-conversions.md) | concept | 242 | 2 panels · 12 params · design 29 |
| [Scenario](panels/scenario.md) | panel | 201 | 1 panel |
| [Scenario Compare](panels/scenario-compare.md) | panel | 205 | 1 panel |
| [Searching Pool Levers](concepts/searching-pool-levers.md) | concept | 385 | design 110, 97 |
| [Securities](panels/securities.md) | panel | 188 | 1 panel · design 94 |
| [Spending](panels/spending.md) | panel | 209 | 1 panel · design 89 |
| [The Spending Rule](concepts/spending-rule.md) | concept | 296 | 1 panel · 17 params · design 89 |
| [State](panels/state-panel.md) | panel | 181 | 1 panel |
| [Stochastic Return Paths](concepts/stochastic-return-paths.md) | concept | 268 | 2 panels · 15 params · design 74, 90, 102 |
| [Tax Harvesting and Asset Location](concepts/tax-harvesting.md) | concept | 235 | 2 panels · 3 params · design 29, 94 |
| [Timeline](panels/timeline.md) | panel | 203 | 1 panel |
| [US Tax](concepts/us-tax.md) | concept | 244 | 1 panel · 9 params · design 71 |
| [Watchlist](panels/watchlist.md) | panel | 209 | 1 panel · design 101 |

---

## Design documents (118)

Tier 3 — the full argument behind each mechanic, in `design/`. The title is each
file's own H1, read out of it; there is no summary column, because a one-line precis
of an argument is a second copy of that argument and the argument is what changes.
Numbered order, not alphabetical: this is a series, and sorting it as text puts 100
between 10 and 11.

| doc | title |
|---|---|
| [`0-period-engine.md`](../design/0-period-engine.md) | Period Engine (UTC Epoch-Based) |
| [`1-adjustment-entry-system.md`](../design/1-adjustment-entry-system.md) | Adjustment Entry System — Technical Requirements Specification |
| [`2-unified-event-schema.md`](../design/2-unified-event-schema.md) | Unified Event Schema — Financial + Simulation Pipeline |
| [`3-branching-event-streams.md`](../design/3-branching-event-streams.md) | Branching Event Streams (Forkable Timelines) |
| [`4-branch-diff-insight-engine.md`](../design/4-branch-diff-insight-engine.md) | Branch Diff Engine & Automated Insight Generation |
| [`5-branch-merge-reconciliation.md`](../design/5-branch-merge-reconciliation.md) | Branch Merge & Reconciliation Engine |
| [`6-workbench-ui.md`](../design/6-workbench-ui.md) | Simulation Workbench UI Redesign Proposal |
| [`7-workbench-ui-plan.md`](../design/7-workbench-ui-plan.md) | Workbench UI Implementation Plan |
| [`8-serialization-test-plan.md`](../design/8-serialization-test-plan.md) | Scenario Serialization — Test Plan & Foundation |
| [`9-toolset-compiler.md`](../design/9-toolset-compiler.md) | 9 — Toolset Compiler MVP |
| [`10-display-settings-service.md`](../design/10-display-settings-service.md) | Design: AppDisplaySettings Service — Unified Timezone, Currency & Theme |
| [`11-taxservice-declarative-refactor.md`](../design/11-taxservice-declarative-refactor.md) | 11 — TaxService Declarative Refactor |
| [`12-toolset-ownership-refactor.md`](../design/12-toolset-ownership-refactor.md) | Design 12 — Toolset Ownership Refactor |
| [`13-prebuilt-scenario-parameters.md`](../design/13-prebuilt-scenario-parameters.md) | Design 13 — Prebuilt Scenario Parameter Editing |
| [`14-vite-migration.md`](../design/14-vite-migration.md) | Design: Vite Migration |
| [`15-config-as-source-of-truth.md`](../design/15-config-as-source-of-truth.md) | Design 15 — Config as Source of Truth (Defaults as Bootstrap Only) |
| [`16-journal-reporting-plugin.md`](../design/16-journal-reporting-plugin.md) | 16 — Journal Reporting Plugin |
| [`17-scenario-as-graph-node.md`](../design/17-scenario-as-graph-node.md) | 17 — Scenario as Graph Node |
| [`18-performance-enhancements.md`](../design/18-performance-enhancements.md) | Design: Simulation Performance Enhancements |
| [`19-type-registry.md`](../design/19-type-registry.md) | 19 — TypeRegistry, Action-Type Families, and the Per-Country Tax Split |
| [`20-decouple-residency-from-citizenship.md`](../design/20-decouple-residency-from-citizenship.md) | 20 — Decouple Residency from Citizenship; Per-Person, Country-Coded |
| [`21-financial-shock-and-regime-framework.md`](../design/21-financial-shock-and-regime-framework.md) | 21 — Financial Shock & Economic Regime Framework |
| [`22-css-design-system.md`](../design/22-css-design-system.md) | 22 — CSS Design System Rework |
| [`23-fx-exchange.md`](../design/23-fx-exchange.md) | 23 — FX Exchange Service |
| [`24-financial-modeling-roadmap.md`](../design/24-financial-modeling-roadmap.md) | 24 — Financial Modeling Roadmap |
| [`25-holding-level-state.md`](../design/25-holding-level-state.md) | 25 — Holding-Level State |
| [`25a-mc-nested-param-paths.md`](../design/25a-mc-nested-param-paths.md) | 25a — Monte Carlo Config: Nested Parameter Paths |
| [`26-dynamic-spending-strategies.md`](../design/26-dynamic-spending-strategies.md) | 26 — Dynamic Spending Strategies |
| [`27-mortality-and-survivor-mechanics.md`](../design/27-mortality-and-survivor-mechanics.md) | 27 — Mortality & Survivor Mechanics |
| [`28-time-varying-appreciation-and-bond-duration.md`](../design/28-time-varying-appreciation-and-bond-duration.md) | 28 — Time-Varying Appreciation & Bond Duration |
| [`29-behavioral-layer.md`](../design/29-behavioral-layer.md) | 29 — Behavioral Layer |
| [`30-decision-graph-analysis.md`](../design/30-decision-graph-analysis.md) | 30 — Decision-Graph Analysis & Scenario Comparison |
| [`31-state-field-exploration.md`](../design/31-state-field-exploration.md) | 31 — State-Field Exploration (Path-Addressable Time-Series) |
| [`32-param-field-linking.md`](../design/32-param-field-linking.md) | Design: Parameter ↔ Field Linking — one source of truth for editable values |
| [`33-age-banded-spending.md`](../design/33-age-banded-spending.md) | 33 — Age-Banded Spending |
| [`34-us-state-income-tax.md`](../design/34-us-state-income-tax.md) | 34 — US State Income Tax (Residency-Based, Pluggable by Year) |
| [`35-drawdown-owner-ordering.md`](../design/35-drawdown-owner-ordering.md) | 35 — Drawdown Owner Ordering |
| [`36-au-move-tax-effect-analysis.md`](../design/36-au-move-tax-effect-analysis.md) | 36 — US→AU Move: All-Else-Equal Tax-Effect Analysis |
| [`37-reducer-test-framework.md`](../design/37-reducer-test-framework.md) | 37 — Reducer Test Framework & Postcondition Coverage |
| [`38-optimization-solver-framework.md`](../design/38-optimization-solver-framework.md) | 38 — Optimization Solver Framework |
| [`39-mpc-financial-controller.md`](../design/39-mpc-financial-controller.md) | 39 — MPC Financial Controller (closed-loop advisor cockpit) |
| [`40-after-tax-net-worth.md`](../design/40-after-tax-net-worth.md) | 40 — After-Tax Re-pricing (pricing the embedded deferred-tax liability) |
| [`41-windowed-prediction-horizon.md`](../design/41-windowed-prediction-horizon.md) | 41 — Windowed Prediction Horizon (sliding fixed-length look-ahead) |
| [`42-roth-lever-snapshot-rollout-fidelity.md`](../design/42-roth-lever-snapshot-rollout-fidelity.md) | 42 — Roth Lever: snapshot-rollout fidelity (the income-target must move the rollout) |
| [`43-basis-accounting-integrity.md`](../design/43-basis-accounting-integrity.md) | 43 — Basis-Accounting Integrity (cost basis & the contribution/earnings ledger) |
| [`44-cross-border-drawdown-actions.md`](../design/44-cross-border-drawdown-actions.md) | 44 — Cross-Border Drawdown Actions (missing INTL_TRANSFER and withdrawal-tax actions in `replenishSavings`) |
| [`45-early-withdrawal-decant-lever.md`](../design/45-early-withdrawal-decant-lever.md) | 45 — Early-Withdrawal "Decant" Lever (proactive pre-move US retirement drawdown, + multi-lever MPC) |
| [`46-mpc-performance-implementation.md`](../design/46-mpc-performance-implementation.md) | 46 — Implementation Guide: Structured Online Surrogate |
| [`46-mpc-performance.md`](../design/46-mpc-performance.md) | 46 — MPC Performance (structured online surrogate over the black-box sim) |
| [`47-time-varying-fx-rates.md`](../design/47-time-varying-fx-rates.md) | 47 — Time-Varying FX Rates (regime-driven, seeded, snapshot-cheap) |
| [`48-rental-income.md`](../design/48-rental-income.md) | 48 — Rental Income on Real Property (dual-country, occupancy-driven, tax-aware) |
| [`49-company-sale-asset.md`](../design/49-company-sale-asset.md) | 49 — Company Sale as a First-Class Sellable Asset (`CompanyEquity`) |
| [`50-au-source-wages.md`](../design/50-au-source-wages.md) | 50 — AU-source Wages (currency-routed, residency-aware tax) |
| [`51-tax-bucket-fx-normalization.md`](../design/51-tax-bucket-fx-normalization.md) | 51 — Tax-bucket FX normalization (single canonical currency per accumulator) |
| [`52-true-foreign-tax-credit.md`](../design/52-true-foreign-tax-credit.md) | 52 — True Cross-Border Relief (FEIE + basketed FTC + AU FITO) |
| [`53-account-basis-refactor-and-offset.md`](../design/53-account-basis-refactor-and-offset.md) | 53 — Account basis refactor + AU offset account |
| [`54-loan-liability-accounts.md`](../design/54-loan-liability-accounts.md) | 54 — Loan (liability) accounts + offset re-targeting |
| [`55-configuration-driven-parameters.md`](../design/55-configuration-driven-parameters.md) | 55 — Configuration-driven (dynamic) parameters |
| [`56-prime-relative-rates.md`](../design/56-prime-relative-rates.md) | 56 — Prime-relative rates (central-bank anchored cash & loan rates) |
| [`57-au-cgt-reform-2027.md`](../design/57-au-cgt-reform-2027.md) | 57 — AU CGT reform: indexation + 30% minimum tax (from 1 July 2027) |
| [`58-drawdown-cross-border-lever.md`](../design/58-drawdown-cross-border-lever.md) | 58 — Drawdown control levers: cross-border mode, orderable priority, and pooled-tier draws |
| [`59-treasury-bond-state-tax.md`](../design/59-treasury-bond-state-tax.md) | 59 — Treasury-aware bond coupon taxation (US state exemption) |
| [`60-cash-sleeve-money-market-yield.md`](../design/60-cash-sleeve-money-market-yield.md) | 60 — Money-market yield on cash sleeves of equity-served accounts |
| [`61-holding-allocation-lever-implementation.md`](../design/61-holding-allocation-lever-implementation.md) | 61 — Implementation Guide: Holding-allocation lever |
| [`61-holding-allocation-lever.md`](../design/61-holding-allocation-lever.md) | 61 — Holding-allocation lever: optimize the Stock/Bond/Cash/Gold mix over time |
| [`62-residency-change-cgt-fidelity.md`](../design/62-residency-change-cgt-fidelity.md) | 62 — Residency-change CGT fidelity (deemed-acquisition holding period + foreign real property) |
| [`63-inheritance.md`](../design/63-inheritance.md) | 63 — Inheritance (scheduled bequest of external-decedent assets + per-country death tax) |
| [`64-mpc-attention-mechanisms.md`](../design/64-mpc-attention-mechanisms.md) | 64 — Attention Mechanisms for the MPC Solver |
| [`65-allocation-aware-drawdown.md`](../design/65-allocation-aware-drawdown.md) | 65 — Allocation-aware drawdown: choose *which holding type* to sell for a debit |
| [`66-bond-fidelity.md`](../design/66-bond-fidelity.md) | 66 — Bond fidelity: from a bond-fund proxy to first-class fixed income |
| [`67-bond-yield-curve.md`](../design/67-bond-yield-curve.md) | 67 — Bond yield curve: from a single fixed-income rate to a term structure |
| [`68-year-of-death-tax-settlement.md`](../design/68-year-of-death-tax-settlement.md) | 68 — Year-of-death tax settlement fidelity |
| [`69-self-employment-income.md`](../design/69-self-employment-income.md) | 69 — Self-Employment Income (US SECA + AU sole-trader), both countries |
| [`70-account-display-names.md`](../design/70-account-display-names.md) | 70 — Account display names (show the name, keep the key) |
| [`71-tax-worksheet-csv-export.md`](../design/71-tax-worksheet-csv-export.md) | 71 — Tax worksheet CSV export (validate the tax framework by hand) |
| [`72-company-equity-sale-fixes.md`](../design/72-company-equity-sale-fixes.md) | 72 — Company equity sale: cross-border fidelity fixes |
| [`73-tax-export-validation-fixes.md`](../design/73-tax-export-validation-fixes.md) | 73 — Cross-border source defects surfaced by tax-export validation |
| [`74-stochastic-return-paths.md`](../design/74-stochastic-return-paths.md) | 74 — Stochastic return paths: from one constant rate per run to sequence-of-returns risk |
| [`75-house-costs-and-property-return-path.md`](../design/75-house-costs-and-property-return-path.md) | 75 — House costs and the property return path: appreciation that co-moves with markets, plus the running cost of owning |
| [`76-au-per-person-income-attribution.md`](../design/76-au-per-person-income-attribution.md) | 76 — AU per-person income attribution |
| [`77-au-super-fund-tax-and-ftc-creditability.md`](../design/77-au-super-fund-tax-and-ftc-creditability.md) | 77 — AU super fund tax: incidence, the age-60 gate, and FTC creditability |
| [`78-simulation-telemetry-cost.md`](../design/78-simulation-telemetry-cost.md) | 78 — Simulation performance: telemetry cost and history-proportional work |
| [`79-real-vs-nominal-display.md`](../design/79-real-vs-nominal-display.md) | 79 — Real vs. Nominal value display (constant-dollar toggle) |
| [`80-feasibility-preserving-harvest.md`](../design/80-feasibility-preserving-harvest.md) | 80 — Feasibility-preserving harvest: why a baked plan goes broke and the controller doesn't |
| [`81-run-as-replayable-artifact.md`](../design/81-run-as-replayable-artifact.md) | 81 — The run as a replayable artifact: playback, branching, and a decision graph rooted at an epoch |
| [`82-allocation-over-time-reporting.md`](../design/82-allocation-over-time-reporting.md) | 82 — Allocation over time: reporting the realized asset mix |
| [`83-us-au-tax-treaty-intricacies.md`](../design/83-us-au-tax-treaty-intricacies.md) | 83 — US–AU tax treaty intricacies: §904 baskets, resourcing, and the limitation |
| [`84-roth-s99b-decant-vs-hold.md`](../design/84-roth-s99b-decant-vs-hold.md) | 84 — Roth IRA under s99B: decant before the move, or hold and pay Australia? |
| [`85-cross-border-tax-coupling.md`](../design/85-cross-border-tax-coupling.md) | 85 — Cross-border tax coupling: where country-pair logic should live |
| [`86-leveraged-property-fidelity.md`](../design/86-leveraged-property-fidelity.md) | 86 — Leveraged property fidelity: loss carryforward, interest-only debt, and interest deductibility |
| [`87-foreign-currency-basis-pools.md`](../design/87-foreign-currency-basis-pools.md) | 87 — Foreign-currency basis pools: §988 on cash, not just on debt |
| [`88-speculative-assets.md`](../design/88-speculative-assets.md) | 88 — Speculative assets: model the what-if without banking it |
| [`89-spending-over-time-reporting.md`](../design/89-spending-over-time-reporting.md) | 89 — Spending over time: what the plan actually costs |
| [`90-equity-fidelity-and-capital-losses.md`](../design/90-equity-fidelity-and-capital-losses.md) | 90 — Equity fidelity and capital losses |
| [`91-journal-payload-manifest.md`](../design/91-journal-payload-manifest.md) | 91 — The journal payload manifest: what it gates, and what it doesn't |
| [`92-fx-observation-overlay.md`](../design/92-fx-observation-overlay.md) | 92 — The FX observation overlay: driving the simulation from a published rate feed |
| [`93-holding-units-substrate.md`](../design/93-holding-units-substrate.md) | 93 — Units as the holding substrate: making par, and eventually shares, unfalsifiable |
| [`94-equity-as-security-positions.md`](../design/94-equity-as-security-positions.md) | 94 — Equity as security positions (design 93's Option C) |
| [`95-wage-logic-and-payroll-contributions.md`](../design/95-wage-logic-and-payroll-contributions.md) | 95 — Wage logic: splits, payroll contributions, and the taxes on a paycheque |
| [`96-percent-of-wealth-spending.md`](../design/96-percent-of-wealth-spending.md) | 96 — Percent-of-wealth spending, and a configurable wealth basis |
| [`97-liquidity-pools-and-drawdown-sequence.md`](../design/97-liquidity-pools-and-drawdown-sequence.md) | 97 — Liquidity Pools: the unified drawdown sequence (scaffolding) |
| [`98-sweepable-parameter-surface.md`](../design/98-sweepable-parameter-surface.md) | 98 — The sweepable parameter surface (Monte Carlo + Optimizer) |
| [`99-market-total-return-model.md`](../design/99-market-total-return-model.md) | 99 — One return per market: accounts derive their growth from their holdings |
| [`100-mc-analysis-surface.md`](../design/100-mc-analysis-surface.md) | 100 — The Monte Carlo analysis surface (in-app) |
| [`101-watchlists.md`](../design/101-watchlists.md) | 101 — Watchlists: named field sets that any panel can read and feed |
| [`102-historical-bootstrap-equity-returns.md`](../design/102-historical-bootstrap-equity-returns.md) | 102 — Historical block bootstrap for equity returns |
| [`103-stochastic-inflation-and-joint-history.md`](../design/103-stochastic-inflation-and-joint-history.md) | 103 — A stochastic inflation path, and history's years sampled jointly |
| [`104-prime-rate-follows-inflation.md`](../design/104-prime-rate-follows-inflation.md) | 104 — The prime rate follows inflation |
| [`105-super-fund-cgt-realisation.md`](../design/105-super-fund-cgt-realisation.md) | 105 — Super fund CGT on realisation |
| [`106-dividend-reinvestment-election.md`](../design/106-dividend-reinvestment-election.md) | 106 — Dividend reinvestment as an account election (and, later, a per-security one) |
| [`107-retirement-paycheck-and-tax-instalments.md`](../design/107-retirement-paycheck-and-tax-instalments.md) | 107 — The retirement paycheck, and paying tax in instalments |
| [`108-help-system.md`](../design/108-help-system.md) | 108 — The help system: generated reference, stamped prose, two surfaces |
| [`109-time-varying-pool-shapes.md`](../design/109-time-varying-pool-shapes.md) | 109 — Time-varying pool shapes: named shapes, and a schedule that selects one |
| [`110-liquidity-pool-control-surface.md`](../design/110-liquidity-pool-control-surface.md) | 110 — The liquidity pool control surface (design 97 §14, effort 2) |
| [`bus-unification-plan.md`](../design/bus-unification-plan.md) | Bus Unification Plan |
| [`inconsistencies.md`](../design/inconsistencies.md) | Inconsistencies, Rework Candidates, and Open Questions |
| [`requirements.md`](../design/requirements.md) | Requirements Tracker |
| [`roth-conversion-design.md`](../design/roth-conversion-design.md) | Roth Conversion: Design & TODO |

