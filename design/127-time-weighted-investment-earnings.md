# 127 — Time-weighted investment earnings

**Status:** ACCEPTED rev 2 (16 Oct 2026); phase 1 BUILT (16 Oct, §9); phase 2 MEASURED (16 Oct, §10), which adds §4.7–4.8 and Q6–Q7; phase 2b BUILT (16 Oct, §11); phase 2c BUILT (16 Oct, §12). Raised by a study flag: "year-end earnings pay a full
year's return on the 31-Dec balance".

- **rev 1 (15 Oct):** the problem, options A–D, proposal A with D as a first step.
- **rev 2 (16 Oct), reviewed against the code:** D is no longer a separate step; MONTHLY makes
  it unnecessary, and fixing the stub under ANNUAL would break ANNUAL's byte-identity (§3).
  The review found five more things that depend on equity being credited once a year, each
  of which would be wrong under MONTHLY if nobody touched it (§4): the AU-only plan's
  draw lands on 1 July, the market index steps on 31 December, the currency-hedge overlay
  marks FX on 31 December, the shock presets are calibrated against a 31-December sample,
  and a composed rate below −100% has no guard. Also added: the arithmetic for splitting
  price and dividend (§3.2), the full list of handlers (§5), phases (§6), and an expanded
  test plan (§8). The reference to "design 102's annual tick" now points to design 74, and
  "design 78/82" is gone; those designs do not cover MC's yearly sampling.
- **rev 2 accepted (16 Oct):** the author agreed every §7 recommendation (Q1 monthly, subject
  to phase 2's cost; Q2 one calibration; Q4 multiplicative split; Q5 a separate commit).

**Related:** design 25 §5.4 (holdings as the substrate), design 62 §9 (rebalance buys get their
own lot), design 74 (the annual equity return tick), design 84 G12 (losses are applied),
design 94 §6.6 (one rate per year for every account), design 99 §2 (price return = total −
yield, the dividend paid separately), design 101 §6 (the market index), design 105 (super
taxed on income), design 106 (dividend reinvestment), design 107 (spending as twelve
just-in-time sales a year), design 119 §6.1 (pension phase from the draw date), design 120
§5.6 (currency-hedge overlay), design 121 (shock legs and their monthly recovery curves).

## 1. The problem

Equity growth and dividends are each one event a year, on 31 December
(`INTL_STOCK_EARNINGS`, `DIVIDEND_SCHEDULED`, `interval('year-end')`). The handler
(`IntlUsStockEarningsHandler` and its siblings, through `computeHoldingsGrowth`) credits
**the balance on that day × the annual rate**. Nothing weights by how long the money was there.

The error runs both ways:

- **Money that arrives mid-year earns a full year.** A property sale credited in late October
  earned a full year's equity return on its equity share two months later. The first year of
  every run is a stub (a plan that starts in September), so the whole book earns twelve months
  for four.
- **Money that leaves mid-year earns nothing for the months it was invested.** Design 107 funds
  spending with twelve sales a year; each sale leaves before 31 December and takes none of the
  year's return with it, so a drawn-down account earns `rate × closing balance` instead of
  `rate × average balance`. For a retiree drawing a steady W a year that understates earnings by
  about `rate × W / 2` every year.
- **Prices do not move within a year.** A sale in June sells at the price of the previous
  31 December, so a June rebalance, a June JIT sale and a June purchase all trade at a price
  that is up to a year stale.
- **Rates that change within a year are sampled on one day (found in review).** The regime
  recovery factor is recomputed every month (`ECONOMIC_RECOVERY_TICK`), but equity only reads
  it on 31 December: a drag that is strong from March to November and weak in December
  barely registers. The shock library says so in its header ("for equity it is only ever
  SAMPLED on 31 December"), and its drags are oversized to compensate (§4.4). The same
  applies to the super fund's tax rate. A fund that enters pension phase in March is taxed
  at the 31-December rate (0%) on the whole year's income. A fund that leaves accumulation
  in December is untaxed on all of that year's income.

Every arm of a comparison shares the second and third effects. But any comparison of **when**
money is invested or withdrawn (sale timing, a lump-sum deployment, a mid-year rebalance, a
shock's start month) is biased by all four.

Interest on savings and fixed-income accounts is already monthly (`factor: 1/12`), cash
sleeves earn monthly (`CASH_SLEEVE_INTEREST`), and bond coupons are semi-annual. Only equity
growth, gold growth and dividends are annual.

## 2. Options

**A. Monthly growth.** Fire equity earnings monthly at the geometric monthly rate
`(1 + r)^(1/12) − 1` of the year's drawn annual return, so twelve months compound to exactly
the annual rate and the year's total is unchanged for a buy-and-hold lot.
- Fixes all four effects to within a month. Arrivals earn from the month after they land.
  Withdrawals earn until they leave. A mid-year sale trades at a price that has moved, and
  a rate that changes mid-year is credited for the months it was in force.
- The stub year falls out naturally (four monthly credits for four months), and so does a
  run that ends mid-year, whose last months currently earn nothing.
- Dividends can follow monthly or quarterly, which is how most funds pay.
- Cost: about twelve times the earnings events per equity account. Measure it (MC runs are the
  budget); `telemetry: 'off'` runs pay only the reducer work.
- Every golden with equity moves.

**B. Midpoint (Modified Dietz-lite).** Keep the annual event; credit
`rate × (opening balance + closing balance) / 2`, per lot. Cheap (one stored opening value per
lot), but a lot bought in November is treated as if held half the year, prices still do not move
within the year, and per-lot opening values add state to every fixture.

**C. Exact time-weighting.** Record each dated flow into or out of an account and credit
`rate × (opening balance + Σ wᵢ · flowᵢ)` with wᵢ the fraction of the year remaining after flow
i. Exact for balances, but it needs a hook on every balance-changing path (transactions,
holding transacts, rebalances, transfers, taxes paid from the account), each one a place for a
silent omission. Prices still do not move within the year.

**D. Fix the stub year only.** Prorate the first year by its length (`factor` already exists on
`computeHoldingsGrowth`). Small and safe, but it leaves the mid-year inflow and outflow bias.

## 3. Proposal

**A, monthly growth.** D is not a separate step. MONTHLY handles the stub year and the final
partial year without special cases. Prorating under ANNUAL would change ANNUAL output, and
ANNUAL is kept only to reproduce today's runs (§3.4).

### 3.1 Cadence

- **Growth** fires at every month-end: US stock, AU stock, IRA, 401(k), Roth, super, and the
  MSBS funded benefit (§5). It credits each lot at the period rate of its annual rate. That
  annual rate is the same one ANNUAL credits today, with every overlay already applied: the
  per-account rate, the security overlay, the `appreciationSchedule`, and the currency overlay.
  The year's stochastic return is still drawn once a year (design 74's tick); MONTHLY only
  spreads the crediting of it. Level effects (shock revaluations) stay instantaneous.
- **Dividends** (the two taxable-account handlers) fire at each **quarter-end**, which is how
  the index funds a household holds actually pay. The existing `'quarterly'` interval is
  `addMonths(start, 3)`, anchored to the run's start day, not to quarter-ends. MONTHLY needs a
  new `'quarter-end'` interval (31 Mar, 30 Jun, 30 Sep, 31 Dec), modelled on `'semiannual'`.
  Reinvestment (design 106) works per payment, as it does today.
- **The wrappers' yield slice** (`derivedAmount`, and super's taxed income) is computed per
  growth event, so monthly. It is a slice of the growth credit, not a separate payment.

### 3.2 Arithmetic

Today's annual split is additive: price `p = T − y` (`priceOf`), dividend `y`, each on the
31-December balance, summing to `T`. Spread across the year, an additive split does not sum
to `T`: reinvested dividends earn the price return after they land. MONTHLY therefore splits
multiplicatively, so a buy-and-hold lot with dividends reinvested ends the year at exactly
`1 + T`:

    (1 + T) = (1 + p)(1 + y)
    growth per month   = (1 + p)^(1/12) − 1          (taxable lot, price only)
    dividend per quarter = (1 + y)^(1/4) − 1, on the lot's value that day
    wrapper per month  = (1 + T)^(1/12) − 1, with yield slice (1 + y)^(1/12) − 1

Here `p = (1 + T)/(1 + y) − 1`, which is about `T − y − y(T − y)`. The difference from
`priceOf` is about 0.2 percentage points a year at a 4% yield and a 10% total. The market
index (§4.2) steps by the same formula under MONTHLY, since it must step exactly as the lots do.
Without reinvestment, the lot grows at `p` and the cash dividends total about `y` a year.

`computeHoldingsGrowth` gains `periodsPerYear` (default 1). It converts the composed per-lot
annual rate after every overlay, never before, because the overlays are annual rates as well.
The existing `factor` keeps its meaning for the savings path. Bank interest is quoted as
`r / 12` simple, so that path stays as it is.

### 3.3 Composed rates at or below −100%

A crash drag, a stochastic deviation and a regime drag can stack below −1. Today ANNUAL
credits `mv × rate`, which takes a lot negative. That is a bug in its own right (§7 Q5).
Under MONTHLY, `(1 + r)^(1/12)` with `r < −1` is `NaN`. The period rate floors at −1, so the
lot goes to zero and no lower. The floor is recorded in the journal so a study can count the
times it was hit.

### 3.4 The parameter

`equityEarningsCadence: ANNUAL | MONTHLY`, a household parameter in the economic-regimes
toolset's surface, beside the other return-model settings. Phase 1 lands with ANNUAL as the
default, and ANNUAL is byte-identical to today in every golden. The default switches to
MONTHLY in phase 4 (§6). The parameter is not a lever. The rollout manifest must still
carry it: it decides which earnings events are compiled (derivation manifest), so a rollout
built from a raw bag would otherwise compile the toolset default.

## 4. What depends on equity being annual (found in review)

Each of these reads "equity grows once a year on 31 December" as a fact. Under MONTHLY each
one is silently wrong unless it changes too.

### 4.1 The year's draw lands on 1 July in an AU-only plan

`EquityReturnReducer` folds the year's draw into `effectiveGrowthRates` at the next period
advance. That is 1 January in a plan with US tax and **1 July** in an AU-only plan. The
31-December crediting cannot see the difference. MONTHLY can: in an AU-only plan, January to
June would credit the previous year's draw and July to December the new one. Each calendar
year would then blend two draws, which cuts the yearly volatility by about 30% and makes
consecutive years correlated.

**Fix:** under MONTHLY the fold needs a 1-January carrier in every plan. As built (§9): an
`EQUITY_YEAR_OPEN` event on 1 January at order −0.9 that emits `RECOMPUTE_REGIMES`.
Every reducer that refolds a deviation onto the effective rates already reduces that action
for the monthly recovery ticks: regime apply, equity, inflation, yield curve, FX and prime
relink. A new action type would have needed every one of them to learn it. The event is
scheduled under MONTHLY with a stochastic equity path. In a plan with a US advance it runs
just after that advance and recomputes the same values. The design 94 §6.6 property
survives: every account still sees one rate for the calendar year.

### 4.2 The market index steps once per 31 December

`MarketIndexReducer` counts 31-December year-ends since `marketIndexAsOfMs` and steps by
whole years at the period advance after each. Under MONTHLY a month-end
`MARKET_INDEX_STEP` (order 0.5, after the month's growth and dividends) steps it one
period at the period rates (§3.2) and moves the as-of date to that month-end. The period
advances then find no 31 December after the as-of date, so the annual path needs no flag. Design 101's
watchlists read the index, so it must track the lots month by month or a watchlist alert
fires on a stale level.

### 4.3 The currency-hedge overlay marks FX on 31 December

Design 120's overlay measures `f`, the move in the exchange rate since the last
`HEDGE_YEAR_END` stamp, and adds a full year of `h·(carry − cost)`. Under MONTHLY:

- the FX mark moves to every month-end, still at order 0.5, after all the earnings events
  that fall on the same date;
- the carry and the cost are converted to a period amount with the same geometric
  conversion;
- an `INCOME` fund's split (design 120 §5.7) runs once per **distribution** period, the
  quarter: the same formula on the quarter's yield, price and FX move, measured from a
  second mark (`fxMarkDist`) that the stamp moves only at quarter-ends. The carried loss
  moves from payment to payment. On the quarter-end month, the growth event adds the
  quarter's D − D′ to the price, and the dividend pays D′. ALIGNED and INCOME lots
  therefore still hold the same value at every payment date.
  (Changed in phase 1 from "the carried loss stays annual". An annual true-up would
  have had to claw back quarterly payments already made, and the per-period rule reuses
  the existing formula unchanged. It differs only in netting: a hedge gain early in the
  year is distributed before a later loss could absorb it, as a fund paying quarterly
  does.)

### 4.4 The shock presets are calibrated to a 31-December sample

`shock-library.js` note 1 and `scripts/probes/shock-path-engine.mjs` both state the
assumption. A drag only counts at its 31-December value, so "the drags below are large
because one year-end has to carry a whole year of decline". Under MONTHLY the engine
integrates the whole recovery curve. Every preset with an equity leg then gets a deeper
emergent trough, reached sooner, and `docs/economic-shocks/CALIBRATION.md` stops being true.

**Fix:** recalibrate every equity-leg preset under MONTHLY against the same targets in
`MEASUREMENTS.md`, with `shock-path-engine.mjs --write`. Those targets are monthly, so
MONTHLY should fit them more closely than annual sampling could. The
`--start-sensitivity` run should shrink as well, since a shock's start month now matters
only by a month. Rewrite note 1 in the library header. The fit is not mechanical; it gets a
phase of its own (§6).

The same applies to the dividend-cut legs (`dividendAdjustment`). Dividends paid at
quarter-ends sample the curve four times a year instead of once.

### 4.5 Same-date ordering on 31 December

Today's 31-December sequence includes the year-end earnings and dividends (order 0), the RMD
events (order 0, FIFO with the earnings), the hedge stamp (0.5), the FX and equity ticks (1)
and the inflation tick and house repairs (2). The month-end and quarter-end series are new
series. Under FIFO by instance id, their 31-December instances could interleave differently
with the RMD events. Each new series carries the order of the series it replaces, and a test
pins the 31-December sequence under MONTHLY: it must match the sequence under ANNUAL.
Sequencing that matters gets an explicit order band, not a FIFO accident.

### 4.6 Cost

There are twelve growth events per equity account a year, each emitting one
`HoldingTransactAction` per lot. Plans with many lots (rebalance buys get their own lot,
design 62 §9) pay most. Measure MC wall time and peak memory on a real plan at n = 1000,
under `diffs` and `off` telemetry, before choosing between monthly and quarterly (§7 Q1).

### 4.7 A straight-line year under a stochastic path (found in phase 2)

MONTHLY spreads the year's single draw evenly, so inside a year the price path is a
straight line, and the first half's move predicts the second half's exactly. A trade that
reacts to price inside the year therefore always trades against a known trend. The 1 July
drift rebalance, after a rise, sells equity just before the rest of the rise. After a fall
it buys just before the rest of the fall. The loss is about (share traded) × (half-year
move), which grows with the square of the year's return. It is zero in a deterministic
run, and real at an 18% volatility. ANNUAL has the mirror artifact: no price moves inside
a year, so a July rebalance sees none of the year. Neither matches a market, where the
first half does not predict the second.

Measured on a real plan (§10): with drift rebalancing switched off in both cadences, the
stochastic MONTHLY − ANNUAL gap equals the deterministic one. With it on, the gap
doubles. So the extra is this artifact, not the crediting. **MONTHLY must not become the
default with a straight-line year.**

**Fix: give the months inside a year a realistic shape, keeping the year's draw.** Keep
the year's draw exactly as it is (design 74's tick, design 102's bootstrap, the betas, the
drift compensation), and split its log return `L = ln(1 + r)` into twelve monthly log
returns that compound to it exactly. Where the months' shape comes from depends on the
process (Q6, measured in §10.1):

- **Historical bootstrap: the drawn year's own months (HIST).** The bootstrap already
  picks a historical year. Take that year's twelve monthly log returns, keep their
  deviations from the year's mean month, scale them by the bootstrap's vol rescale and
  by 1/0.85 (the monthly-average correction, §10.1), and add `L/12`. The deviations sum to
  zero, so the year is exact. The AU sleeve in a year with AU data takes the AU months
  (the design 102 §6 replay). Gold, and AU before 1958, take a bridge.
- **Every other process (white noise and the rest): a Brownian bridge (BRIDGE):**

    ℓₘ = L/12 + s·(zₘ − z̄),   s = σ_sleeve / √12,   z₁…z₁₂ iid N(0, 1)

  The noise sums to zero, so the twelve months compound to exactly `1 + r`, and the
  year's distribution is untouched. Drawn this way, with `L` itself drawn with variance
  σ², the months are an ordinary random walk: the first half no longer predicts the
  second.

Either way:
- A bridge's z's are drawn once a year by the tick, for the market factor and per sleeve
  for the idiosyncratic part, from a keyed stream (`rngStreams`). Adding them does not
  move any other draw. HIST draws nothing new: the year is already picked.
- Each sleeve's monthly rate is its share of the market factor's bridge plus its own
  idiosyncratic bridge, at its beta and idio vol, so markets still move together within
  the year. Gold gets its own z at its correlation.
- They are stored per month on state. `computeHoldingsGrowth` reads the month's factor
  in place of `periodRate(r, 12)`. A deterministic run draws nothing and keeps the
  straight line, which is correct there.
- The security overlay and the regime adjustments stay as monthly period rates (they
  are not volatility).

### 4.8 The cost is per-action overhead (found in phase 2)

MONTHLY runs 2.3–2.4× as long, deterministic and in MC alike. Peak memory is unchanged,
and the lot count barely moves (§10). A profile puts about half of a MONTHLY run in the
generic action pipeline: one `HoldingTransactAction` per lot per month-end, each through
every reducer pass with a state copy. The growth arithmetic is about 1%. So quarterly
crediting would divide the overhead by three, but **batching** would remove most of it at
any cadence: one action per earnings event carrying every lot's delta, applied in one
reducer pass.

## 5. What it touches

- **`computeHoldingsGrowth`, `computeHoldingsDividends`, `computeFundIncome`:** a
  `periodsPerYear` argument (§3.2). The floor at −1 (§3.3).
- **Growth handlers,** in `earnings-handlers.js` unless noted: `IntlUsStockEarningsHandler`,
  `IntlAuStockEarningsHandler`, `IntlIraEarningsHandler`, `IntlK401EarningsHandler`,
  `IntlRothEarningsHandler`, `SuperEarningsHandler`, and the MSBS funded-benefit earnings
  in `msbs-classes.js` (also on `INTL_SUPER_EARNINGS`). Each one is told its cadence through
  the event's `data`, as the coupon handlers are told `firingsPerYear`.
- **Dividend handlers:** `DividendScheduledHandler` (US) and `IntlAuStockDividendHandler`.
- **Schedules:** the US and AU retirement toolsets choose `'year-end'` or `'month-end'` /
  `'quarter-end'` by cadence. `simulation-adapter.js` gains `'quarter-end'`.
- **Gold** is on the growth path inside these accounts, so it goes monthly with no work of
  its own (rev 1 Q3, resolved).
- **§4's dependents:** the 1-January fold carrier, `MarketIndexReducer`, the hedge stamp,
  the shock presets and `CALIBRATION.md`.
- **Super tax:** each month's income is taxed at that month's rate (`superEarningsTaxRate`
  on the event date), so a mid-year switch to pension phase is honoured to the month (§1).
  Fund tax is assessed per action and aggregates by financial year as it does today.
- **AU tax year:** quarterly AU dividends fall into the financial year they are paid in.
  Today the 31-December dividend always falls in the July-to-June year that contains it.
  Franking and the US qualified/ordinary split are per payment and still aggregate by year.
  Check that `AU_STOCK_DIVIDEND_*` and `STOCK_DIVIDEND_*` sum by period, not "the one
  dividend this year".
- **Not in scope:** property appreciation (its own handler and tick), bond accretion
  (annual by its units), cash and bond coupons (already sub-annual). The stochastic tick
  stays annual, so there is no volatility within a year: the path between two 31 Decembers
  is smooth, and a June sale receives half of a return that is fixed on 1 January.
- **Help:** the parameter's description in the toolset, a help topic on the cadence and
  why it matters, `npm run help:build`, then restamp whatever topics the gate names
  (the market index, the shock presets, hedged equity).

## 6. Phases

1. **Plumbing, default ANNUAL.** The parameter, `periodsPerYear`, `'quarter-end'`, the
   schedule switch, the handlers, the −1 floor (MONTHLY only), §4.1–4.3 and §4.5. Goldens
   are untouched (ANNUAL is byte-identical). Every MONTHLY test in §8 passes.
2. **Measure.** The cost from §4.6. One deterministic run and one MC run of a real plan under
   both cadences, so the size of the change is known before any default moves. Results go
   in the study folder, not here.
3. **Recalibrate the shock presets under MONTHLY** (§4.4). New `CALIBRATION.md`. The
   presets are shared by both cadences, so after this phase ANNUAL with a shock is no
   longer today's engine (§7 Q2).
4. **Switch the default to MONTHLY.** Regenerate the goldens, read the diffs, and restamp the
   help.

Phase 2 (§10) adds two steps before phase 4, in this order:

- **2b. The intra-year bridge (§4.7).** Without it, a MONTHLY Monte Carlo is biased
  against every plan that rebalances mid-year.
- **2c. Batched lot deltas (§4.8)**, if Q7 says the 2.3× matters. Re-measure after.

Phase 3 (preset recalibration) must run after 2b, because the bridge changes the
emergent path inside each year.

## 7. Decisions (Q1–Q5 accepted 16 Oct 2026; Q6–Q7 open)

1. **Monthly or quarterly growth?** Decided: monthly, which matches design 107's twelve JIT
   sales, unless phase 2's cost measurement says otherwise. Dividends are quarterly either
   way.
2. **What ANNUAL means after phase 3.** The presets are recalibrated for MONTHLY. After that,
   an ANNUAL run with a shock does not reproduce a study from before this design. Keeping
   two calibrations per preset would double the library to preserve a mode nobody should
   choose. Decided: one calibration (MONTHLY). ANNUAL stays a switch for measuring this
   change on a plan without shocks, and an older study is reproduced from its own commit.
   (Rejected: freezing a copy of today's presets for ANNUAL.)
3. **Gold.** Resolved: it goes monthly with equity (§5).
4. **Multiplicative price/dividend split under MONTHLY** (§3.2). Decided: yes, so a
   buy-and-hold lot with reinvested dividends earns exactly the sourced total return.
   Under ANNUAL, today's additive `priceOf` is unchanged.
5. **A composed annual rate ≤ −1 under ANNUAL** takes a lot negative today. Decided: fix it
   in a separate commit after phase 1, floored at −1 as under MONTHLY, with whatever
   goldens it moves read separately. It is a bug, not part of this change, and should not
   be hidden inside phase 4's regold.

6. **The intra-year path (§4.7).** Decided 16 Oct 2026: fix it in phase 2b, before any
   default switch. Leaving the straight line was rejected: its bias is about as large as
   the error MONTHLY removes. The author asked whether rewriting the bootstrap to draw
   months would be more accurate. Old studies moving is not a reason against it, because
   they can be re-run. Measured (§10.1), a full monthly block bootstrap is
   indistinguishable from the drawn year's real months on everything that drives a
   decision. So the measured answer is HIST for the bootstrap and BRIDGE for the other
   processes, with the annual machinery unchanged.
7. **The cost (§4.8).** Decided 16 Oct 2026: batch the lot deltas (phase 2c) rather than
   fall back to quarterly crediting, which would bring back a third of the timing error.
   Built (§12): MONTHLY runs at 1.4–1.5× ANNUAL, down from 2.35×.

## 8. Test plan (phase 1: `tests/unit/earnings-cadence.test.mjs`, CAD-1 to CAD-13)

- **ANNUAL byte-identical:** every golden unchanged in phase 1.
- **Buy-and-hold:** under MONTHLY, a wrapper lot ends the year at exactly `(1 + T)`, and a
  taxable lot with reinvested dividends ends at `(1 + T)` as well (§3.2).
- **Timing:** a lot bought on 1 November ends the year at `(1 + T)^(2/12)`. A lot sold on
  30 June took `(1 + T)^(6/12)` with it. A run that starts on 1 September credits four
  months in its first year.
- **Drawdown:** a drawn-down account earns about `rate × W / 2` a year more under MONTHLY
  than under ANNUAL.
- **AU-only fold (§4.1):** in an AU-only stochastic run under MONTHLY, all twelve months of
  a calendar year credit the same draw.
- **Market index (§4.2):** the index after a year of MONTHLY matches a buy-and-hold lot.
- **Hedge (§4.3):** with `h = 0` and flat FX, MONTHLY equals unhedged MONTHLY. With FX
  moving, the year's overlay sums to the monthly marks.
- **Shock (§4.4):** a drag in force from March to November, and gone by December, moves
  the year's return under MONTHLY.
- **Super pension phase:** a draw date in April taxes January to March income at 15% and
  April onward at 0%.
- **Floor (§3.3):** a composed rate of −1.2 takes a lot to zero, not below, and the floor
  is recorded in the journal.
- **31-December sequence (§4.5):** the order of the events on that date is the same under
  MONTHLY as under ANNUAL.
- **Quarter-end interval:** it fires on 31 Mar, 30 Jun, 30 Sep and 31 Dec from any start
  date.

## 9. Phase 1 as built (16 Oct 2026)

- **`earnings-cadence.js`** holds the parameter values, the order bands, `periodRate`
  (floored at −1), `multiplicativePrice`, `isQuarterEnd` and `earningsSchedule`. Under
  ANNUAL that last returns exactly the old series (a year-end interval, no order, no
  data), so the queue is unchanged. The goldens pass untouched.
- **The cadence travels on the event**, as `data.periodsPerYear`, the way coupons carry
  `firingsPerYear`. No handler gained state, and a saved plan's queue carries it.
- **Order bands (§4.5):** growth −0.5, dividends −0.4. Under ANNUAL, a 31-December year-end
  instance was queued a year earlier than any month-end one, so FIFO ran the earnings and
  dividends before that day's order-0 events, the RMDs included (they read the post-growth
  balance). A month-end instance is queued on 30 November, so FIFO would have flipped
  that. The bands keep it. The hedge stamp (0.5) and the index step (0.5) run after.
- **The first month is a whole month.** A run starting mid-month credits its first
  month-end in full, an error of at most a month's return on the opening book. That is
  small next to the twelve-for-four months ANNUAL credits on a September start.
- **The floor is recorded** as `flooredLots` on the six growth apply actions, declared
  so the payload keeps it.
- **For phase 2:** reinvested dividends open a vintage lot per security per payment
  (design 106 §5), so quarterly dividends open four lots a year where ANNUAL opens one.
  Measure the lot count beside the wall time.

## 10. Phase 2 measured (16 Oct 2026)

On a real plan: a 43-year two-country retirement, starting in September, dividends
reinvested, `rngStreams` on. Study files are private; the findings:

- **Cost:** 2.35× deterministic, 2.33× in MC (400 paths). Peak memory unchanged. Lots
  +1% at the end, +4% at the peak: quarterly reinvestment does not multiply vintages in
  practice. See §4.8.
- **Deterministic:** terminal real net worth −6.0% under MONTHLY. About half is the stub
  year: the run starts in September, and ANNUAL credited a full year on 31 December.
  The rest is a steady drift. Measured per year, MONTHLY's credits ÷ time-weighted equity
  hold at the rate monthly crediting must give. ANNUAL's wander 0.05–0.25 points above
  it with the year's flow timing. ANNUAL was over-crediting; MONTHLY is the correct one.
- **Monte Carlo:** the median paired gap is −12%, and failures rise from 4.5% to 6.5%
  (8 worlds broken, none rescued). The process-by-process decomposition puts all of the
  extra on the stochastic equity path. Turning off drift rebalancing in both cadences
  returns it to the deterministic size. That is §4.7's straight-line artifact.

### 10.1 The shape inside a year, against history (Q6)

Shiller's US real total return (1871–2023) and the OECD AU price index (1958–2023), as
January-to-January years like the annual series. Both are monthly averages.

- **Averaging** (checked on daily NASDAQ closes, 1971–2025) cuts the monthly sd to 0.85×
  that of month-end closes. It triples the lag-1 autocorrelation (0.30 against 0.10) and
  trims the mean in-year drawdown from 14.6% to 12.9%. Month-end is the right target,
  because the engine acts only at month-ends. Hence the 1/0.85 scale.
- **In-year shape, US:** history dips 10.0% on average inside a year, and 18.7% of up years
  dip 10% or more. The straight line gives 3.8% and none, and its first half predicts its
  second exactly (correlation 1.00; history 0.05). A Gaussian bridge gives 10.5% and
  19.9%. It under-produces only the rare deep dip inside an up year (0.2% of years
  against 0.9%), the 1987-style year. AU shows the same pattern.
- **Decision proxy:** a 60/40 book rebalanced every 1 January, with or without a 1 July
  rebalance. July's mean effect on the year is −4.0 bp in US history (AU −6.2), −3.7 bp
  under the bridge (AU −1.5), and **−20.1 bp under the straight line (AU −21.9)**.
- **Real months vs a full monthly bootstrap** (40-year paths, 5-year blocks, from the same
  history): identical path drawdowns (median 50.1%, p90 76.8%), annual sd within 5%
  (which the model's vol rescale absorbs anyway), and July effects within a few bp. The
  full monthly bootstrap buys nothing measurable over the real months.

## 11. Phase 2b as built (16 Oct 2026): the shape of the months inside a year

- **Data.** `build-historical-equity-returns.mjs` now also writes each year's twelve
  monthly log returns (`months`, flat, beside `returns`): US Shiller real total return, AU
  OECD nominal price. The annual series are byte-identical.
- **The tick** (`EquityReturnTickHandler`, `monthShape: true` under MONTHLY) emits
  `monthShape`: per sleeve and GOLD, twelve log-return deviations that sum to zero.
  - The bootstrap uses the drawn year's own months, at the vol rescale and
    ÷ `MONTHLY_AVERAGE_SD_RATIO` (0.848).
  - Other processes use a Brownian bridge at σ/√12.
  - Each sleeve takes β × the market factor's months plus its own idiosyncratic bridge.
    An AU replay year takes AU's own months.
  - Gold takes ρ·(σ_gold/σ) × the market's months plus its own bridge.
  - Every bridge draws from its own keyed stream (`equity-shape`, `equity-shape:<sleeve>`,
    `gold-shape`), so the year's deviations are identical with the shape on or off.
  - `NONE` and a zero vol draw a zero shape.
- **Clock.** `EquityReturnStepReducer` stores the shape as `equityReturnMonthShapeNext`.
  `EquityReturnReducer` publishes it as `equityMonthShape` at the same fold as the
  deviation, so a year's months and its return go live together (design 94 §6.6).
- **Consumers.** `computeHoldingsGrowth` (`monthIndex`, the credited calendar month) and
  the market index step use `shapedPeriodRate`: the period rate × `exp(shape[month])`.
  Twelve months compound to exactly the year. A per-account key takes its sleeve's shape.
- **Not shaped** (period rates, as phase 1):
  - the MSBS funded benefit, which is one blended balance that nothing trades;
  - the `INCOME` hedge split's price term, which is second order;
  - a year with no draw yet (the first year of a run): a deterministic anchor year has
    nothing to shape.
- **Measured** on the real plan, terminal real net worth, MONTHLY ÷ ANNUAL − 1, 20 seeds:

  | case | straight line (phase 2) | shaped (2b) | shaped, no drift rebalancing |
  |---|---|---|---|
  | deterministic | −6.0% | −6.0% | — |
  | stochastic equity, bootstrap (the plan's model) | −12.5% | **−6.1%** | −5.5% |
  | stochastic equity, white noise (bridge) | — | **−6.0%** | −6.2% |
  | as saved | −11.3% | **−6.3%** | — |

  The stochastic gap is now the deterministic one, with or without rebalancing. The
  artifact is gone, and what remains is §2's crediting correction.
- **Tests:** CAD-14 to CAD-17.

## 12. Phase 2c as built (16 Oct 2026): batched lot deltas

- **`HOLDING_TRANSACT_BATCH`** `{ stateKey, legs: [{ holdingId, marketValueDelta,
  costBasisDelta, valueKind?, cpiIndexRatioFactor? }] }`. `HoldingTransactReducer` reduces
  it: every leg goes through `_transactLeg`, the same arithmetic a `HOLDING_TRANSACT` uses
  (zero floors, `valueKind`, index ratio), in order, then one `_syncBalance`. Each leg
  touches only its own lot, and the balance is a function of the final holdings. So the
  account comes out identical to the legs as separate actions.
- **Only under a sub-annual cadence** (`batchHoldingActions(actions, periodsPerYear)`).
  An exported plan carries its compiled graph, and the serializer restores each reducer's
  `reducedActionTypes` from the JSON. So a plan saved before the batch would not reduce
  one: its holdings would stop moving while its balance kept growing. Its earnings events
  are annual, though, and annual events stay unbatched. Every monthly graph is compiled by
  code that knows the batch. ANNUAL is untouched, journal included.
- **Emitters:** the six growth handlers (Roth, IRA, 401(k), US stock, AU stock, super). A
  single lot's action stays a `HOLDING_TRANSACT`.
- **Measured** on the real plan, telemetry off, median of three runs:

  | | ANNUAL | MONTHLY before | MONTHLY after |
  |---|---|---|---|
  | deterministic | 794 ms | 1,837 ms | 1,124 ms (1.42×) |
  | as saved | 856 ms | 2,100 ms | 1,267 ms (1.48×) |

  Final state, hashed whole: identical before and after in all four runs. What is left of
  the extra cost is the monthly apply and `RECORD_BALANCE` actions, one per account per
  month. Those feed the balance history, and coarsening them would cost chart detail.
- **Tests:** CAD-18 (a batch equals its legs, including two legs on one lot, an unknown lot
  and the zero floor) and CAD-19 (handlers batch under MONTHLY only).
- **Monte Carlo after 2b + 2c** (the same plan, 400 paths, paired): MONTHLY against ANNUAL
  costs 1.46× the wall time (2.33× before). The median paired gap is −6.4%, the
  deterministic size (−12.2% before). Failures go from 4.5% to 5.3%: 3 worlds fail only
  under MONTHLY, none only under ANNUAL. Those 3 were surviving on ANNUAL's over-credit.
  Phase 2's open items are closed. Next is phase 3: recalibrate the shock presets under
  MONTHLY, with the shaped months.
