# scripts/

Command-line tools that drive the simulation engine headlessly — no browser, no UI.
They exist for the questions the workbench cannot answer in one run: sweeps, grids,
frontier searches, Monte Carlo arms, tax reconciliation and engine-fidelity probes.

Everything here talks to `src/` through the real `ScenarioLoader` and `Simulation`.
There is no second implementation of the engine, so a number a tool prints is a
number the app would produce.

```
scripts/
  lib/                shared modules — imported, never run directly
  scenario/           run · diff · sweep · audit · import one or more scenarios
  lab/                decision analysis: grids, frontiers, spending traces
  montecarlo/         Monte Carlo arm runners and reporters
  probes/             targeted engine-fidelity probes and prototypes
  tax/                tax worksheet export and cross-footing
  dev/                repo tooling (index generation, requirements coverage)
  specs/              grid/arm definitions — yours are gitignored
  config-converters/  export a scenario to third-party planners
```

## Where do I get a scenario?

Every tool in `lab/` and `montecarlo/` takes `--scenario <file.json>` — a workbench
export (`{ "scenarios": [...] }`). Omit it and you get
`IntlRetirementScenario.buildDefaultConfig()`, the framework's synthetic default.

The distinction changes what a result *means*:

| | `--scenario plan.json` | omitted (synthetic default) |
|---|---|---|
| balances, holdings, per-account rates | real, persisted | round placeholders |
| horizon | as authored | ~15 years |
| property sale dates | as authored | none |
| use it for | **a question about a plan** | **a question about the engine**, or a smoke test |

Tools print `** SYNTHETIC DEFAULT **` in their header when running on the default, so
a smoke test can never be mistaken for a decision. Don't draw conclusions about a
plan from it: with no sale dates and a short horizon, solvency on the default is
close to meaningless.

---

## lab/ — decision analysis

### `variant-grid.mjs` — sweep N levers at once and table the result

```bash
node scripts/lab/variant-grid.mjs --spec scripts/specs/example-grid.json
node scripts/lab/variant-grid.mjs --spec my-grid.json --scenario plan.json --workers 8
```

Axes are **data**, not code: a spec names dotted paths into the lever bag, and the
tool builds the cross product, fans it across worker processes, and renders a matrix.
See the file header for the spec format and `specs/example-grid.json` for a runnable
example.

The feature that makes it useful is `reduce`. Without it each cell is one run and the
table shows pass/fail — often uninformative, because at a comfortable spending level
*every* cell passes and a grid where nothing fails carries no information. `reduce`
turns a swept axis into a measured frontier per cell:

- list returns **descending** → each cell reports its **break-even return**
- list spend **ascending** → each cell reports its **sustainable ceiling**

Same primitive; the order you list values in picks the question.

### `frontier.mjs` — find the edge of solvency along one lever

```bash
node scripts/lab/frontier.mjs spend  --scenario plan.json --lo 6000 --hi 15000
node scripts/lab/frontier.mjs return --scenario plan.json --levers '{"retire":{"primary":2032}}'
node scripts/lab/frontier.mjs retire --scenario plan.json --lo 2027 --hi 2045
```

Converts a lever into the three units a plan is actually judged in — highest
sustainable spend, lowest survivable return, earliest safe retirement year. Each is
a number you can hold an opinion about, unlike a pass/fail flag.

Scans by default rather than bisecting, because solvency is **not** guaranteed
monotone in any of these levers — tax-year, residency and age-gate interactions can
make one more year of work locally harmful. The scan counts pass↔fail flips and warns
when there is more than one; a `--bisect` answer on such a lever is not trustworthy.

### `spending-trace.mjs` — what an adaptive spending rule actually costs

```bash
node scripts/lab/spending-trace.mjs --scenario plan.json --strategy GUARDRAIL \
     --levers '{"retire":{"primary":2032},"spendTotal":9000}'
```

Use this whenever an adaptive strategy is involved. A proportional withdrawal rule
**cannot** run out of money — it responds to depletion by spending less — so
switching to GUARDRAIL makes the out-of-funds flag stop measuring anything. This
prints realised spending in **real** base-year dollars, turning "it survived" into
"it survived on 23% less than you intended", which is the comparable number.

### `verify-mpc-lever.mjs`

Confirms an MPC/optimizer lever actually moves the simulation. A zero delta usually
means the *scenario* is inert for that lever (it never exercises the code path), not
that the lever is broken — check the scenario shape before hunting for a bug.

### `calibrate-fx.mjs` — estimate the FX process from history instead of guessing

```bash
npm run calibrate:fx -- --compare
node scripts/lab/calibrate-fx.mjs --from 2000-01 --json
```

Fits `fxVolatility` (σ̂) and `fxReversionSpeed` (k̂) to the packaged USD/AUD monthly
series (design 92 §8.1). Takes no scenario — it reads only the published data.

The **window is the whole argument**, which is why the tool prints it beside every
number. σ̂ is stable across windows (0.109–0.119); k̂ is not, and roughly halves once the
pre-1984 managed float is included, because a pegged currency is not a draw from the same
process. The defaults ship from the post-float window.

μ̂ (realised drift) is **reported and never applied**. Choosing a window is choosing a
currency view; drift belongs in `exchangeRateUsdToAud` or the regime FX lever, where it
is visible and authored, not folded into a number labelled "volatility".

---

## montecarlo/

```bash
node scripts/montecarlo/mc-run.mjs --arms scripts/specs/example-arms.json \
     --out /tmp/mc -n 400 --paths
node scripts/montecarlo/mc-report.mjs --dir /tmp/mc
```

`mc-run` writes raw per-path rows, one file per arm; `mc-report` interprets them. The
split is deliberate — an arm costs minutes, a report costs milliseconds, and the
report is what you rewrite ten times.

**Choosing a risk model.** Default samples only the long-run *average* return, held
constant for the whole horizon: that captures estimation error but contains no
sequence-of-returns risk, so it **understates** failure probability. `--paths` gives
each year its own return, so bad decades happen endogenously — prefer it. `--shock`
adds one manufactured crash and was the best available proxy before `--paths` existed;
combining the two double-counts the downside.

**Read the paired section, not the failure rates.** Arms share their seed sequence, so
path *i* is the same world in every arm. That supports a much sharper question than
comparing two rates: in how many individual worlds did this decision flip the outcome?
A nonzero `reverse` count — worlds the change made *worse* — is worth taking seriously
even when small; it means state-dependent harm with a mechanism, not noise.

**Never quote a mean of terminal wealth** from these runs. A single return compounded
for forty years produces tail numbers with no economic content, and they dominate the
average. The reporter prints medians and low percentiles only.

---

## scenario/

| tool | question |
|---|---|
| `run-scenario.mjs` (`npm run scenario`) | what does this scenario end up with? Two or more files run side-by-side with differing rows flagged. |
| `diff-scenarios.mjs` (`npm run diff`) | why do these two scenarios differ? |
| `sweep-scenario.mjs` (`npm run sweep`) | which way does one param push, and is the response smooth? |
| `audit-scenario.mjs` | is this scenario internally consistent? |
| `import-quicken.mjs` (`npm run import:quicken`) | what does my real portfolio look like as a scenario? |

### import-quicken.mjs

Turns a Quicken **"Investing - Portfolio Value - By Account"** export — taken **with
lots** — into a scenario's accounts: balances, one holding per real tax lot with its own
basis and acquisition date, and the `Security` records those lots are positions in.

```sh
npm run import:quicken -- \
  --csv  scenarios/quicken/export-with-lots.csv \
  --map  scenarios/quicken/mapping.json \
  --into scenarios/quicken/plan.json \
  --out  scenarios/quicken/plan-imported.json
```

Omit `--out` for a dry run: it prints the whole report — a before/after balance table,
the holding-period split, and every data-quality finding — and writes nothing.

**The lots export is not optional.** Short vs. long term is computed per lot from
`purchaseDate`. The plain export has no dates, which `holdings-fifo.js` reads as
"carried in from boot" — oldest, always long-term, and so a silent understatement of tax
on everything recently bought.

**The mapping file is required** because the export cannot answer two questions. It
never names a `stateKey`, and its `Type` column (`Stock` / `Mutual Fund` / `Bond` /
`Other`) is not the asset class this engine branches on — VXUS is `EQUITY_INTL_EX_US`,
a gold ETF is `GOLD` with `isGold`, a money-market fund is `CASH`. An account or an
instrument that resolves to nothing is a hard **error**: guessing there does not produce
an approximate plan, it produces a confident one that taxes bullion at the equity rate.

Quicken's own setup gaps are **warnings**, not errors, so a portfolio still being entered
can be imported: a cost basis Quicken records as `Add` (unknown) defaults to market value
and says so, and the negative cash a placeholder entry leaves behind is reported as the
plug it is.

**One currency per export.** The report prints no currency column — the only evidence is
the sign on the money cells (`$` vs `A$`), so a file that mixes them is rejected rather
than summed. A household with both runs the tool twice, the second `--into` the first's
output with `--replace` (which patches `--index` in place instead of appending another
copy); `securities` merge by id across the two runs. Set `currencySign` in the mapping to
have a file/mapping mismatch caught before it becomes a balance.

```sh
npm run import:quicken -- --csv "…/Quicken Export US.csv" --map …/mapping.json \
  --into "…/fin-sim-scenarios.json" --out /tmp/step1.json --id u:quicken-0904
npm run import:quicken -- --csv "…/Quicken Export AU.csv" --map …/mapping-au.json \
  --into /tmp/step1.json --index 1 --replace --keep-sim-start --out …/imported.json
```

`--into` leaves every account the mapping does not name exactly as it was, and appends
the import as a **second** scenario rather than replacing the first, so the two can be
diffed. It also does three things that are easy to miss: blanks `cfg.initialState` (a
full second copy of every account), re-syncs the `contributionBasis` params that own that
field at load (design 32), and moves `simStart` to the export's snapshot date
(`--keep-sim-start` opts out).

Follow every import with `node scripts/scenario/audit-scenario.mjs <out>` — it checks the
holdings-sum-vs-balance invariant this tool is written around.

`sweep-scenario` is the bug-finding one. A lever that steps sharply at one value is
either a real threshold (a bracket edge, a residency boundary, an age gate) or a bug,
and you cannot tell which from single runs either side. A step larger than the
statutory difference can justify is the tell for a missing relief — that is how
design/72 was found.

## tax/

| tool | question |
|---|---|
| `export-tax-csv.mjs` (`npm run export:tax`) | per-year tax worksheets as CSV |
| `crossfoot-drill-reports.mjs` (`npm run crossfoot`) | do the tax reports add up across years? |
| `section988-ingest.mjs` (`npm run section988:ingest`) | is this real account history fit to compute §988 from? |
| `section988-ledger.mjs` | design 87 G5 — the gain itself, once the ingest is clean |
| `fetch-fx-rates.mjs` (`npm run fetch:rates`) | refresh the pinned published rate series in `rates/` |

`crossfoot` catches report bugs that are invisible one year at a time. Run it after
touching anything on the tax reporting path.

### §988 ingest — the odd one out

`section988-ingest.mjs` is the only tool here that does **not** run the engine. It reads
real bank-account history and answers whether that history is fit to compute foreign
currency gain from — it deliberately computes no tax. Design 87 §12.

Every error that matters in a §988 calculation is an ingest error: a missing row, a rate
from the wrong date, a debit misread as a disposition. A lot ledger is path-dependent, so
it absorbs each one silently and carries it forward forever. Hence five hard gates and a
non-zero exit while any is open.

Two things to know before using it:

- **Pass every account in the currency, not just one.** `§1.988-2(a)(1)(iii)(E)` makes a
  same-currency transfer a non-recognition event with carryover basis, so an account
  ingested alone shows currency arriving with a basis set somewhere invisible. That is
  GATE 4, and it is usually the largest finding.
- **Rates come from `rates/`, never from the engine.** `effectiveExchangeRates.USD_AUD`
  is a simulated path. Real history needs a published source — see `rates/README.md`.

Classification is **two orthogonal axes** — `kind` (what this row does to the ledger,
`§1.988-2(a)(1)(iii)`) and `businessFraction` (what the currency was used for,
`§1.988-1(a)(9)`). A single Personal/Business/Ignored column cannot express either one
without losing the other. Rules go in a JSON file (`--rules-schema` prints the format,
`specs/section988-rules.example.json` is a worked example); keep real ones in gitignored
`scenarios/`, since descriptions carry payee names.

#### classifying a few thousand rows by hand

`--emit-classified <file>` writes every row back out with `Kind`/`BusinessFraction`
pre-filled from the rules and a `Status` column saying what still needs you — `OK`,
`DECIDE` (a rule identified the row and deferred), `UNMATCHED` (no rule describes it),
`REJECTED` (an override was refused, with what you typed and why). Fix those in a
spreadsheet, feed the file straight back in as `--csv`, and the columns win over the
rules permanently. The file carries an `Account` column so one sheet holds the whole
pool, and dates it cannot read are fatal rather than silently skipped — a spreadsheet
rewrites the date column in the machine's locale on save.

#### credit cards

A card payment is one disposition of AUD whose *purpose* lives in a different file.
`--card-statement <name>=<file>` reads the card's own export, works out which purchases
each payment retired, and stamps the resulting business fraction onto the account row
that paid it. The `card` block in the rules file says which categories are business and
which credits are payments (`--card-schema`); neither is defaulted.

Do **not** substitute the card's purchases for the payment row. AUD leaves the pool when
the card is paid, not when it is used, so purchase-dated dispositions apply the wrong
day's rate, invent turnover the pool never had, and — worst — put every slice under
§988(e)(2)'s \$200 per-transaction exclusion that the single payment clears.

#### and then the ledger

`section988-ledger.mjs` is the other half: it computes tax and validates nothing, exactly
as the ingest validates and computes no tax. Run it only once every gate is green.

Both conventions `§1.988-2(a)(2)(iii)(B)(1)` leaves open are parameters, not decisions
baked in — `--method fifo|pro-rata` (design 87 G6) and `--pooling per-account|commingled`
(G11). `--compare` runs all four and prints the spread, which is what turns "which
convention?" from an argument into a measurement. On the real AUD pool the method choice
moves \$29 and the pooling choice moves up to \$7,988, so only one of them is worth
arguing about.

A row marked `BasisSource=assumed` may state what the assumption IS, via two CSV columns
the ingest validates and round-trips: `BasisDate` (a day, or a `from..to` window whose
published rates are averaged) and `BasisRate` (an explicit USD per AUD). They are separate
from the transaction date on purpose — that column orders the ledger walk, drives footing
and decides which lots FIFO consumes, so re-dating a row to reach a better rate corrupts
three things to fix one. Anything unusable is refused rather than silently falling back to
the default it was overriding, including a rate outside everything the series has printed.
`--seed-sweep from:to[:step]` then re-prices every assumed row across a range and reports
all five columns, because on a loss-making position most of the extra basis grows the
DISALLOWED bucket rather than anything deductible.

`--audit <file>` writes the per-row trail behind those totals: one line per movement of a
pool, in ledger order, carrying every input the row's numbers were built from and the pool
state either side of it. Its point is that a **DISPOSE has two rates** — the published rate
for the disposal date, which prices the proceeds, and the rate the units that left were
carrying, which is the pool's weighted average under pro-rata and the consumed lots' own
rate under FIFO. Their difference times the units disposed of is the entire gain, and the
sheet emits that as a residual column that must be zero, alongside one for the four-way
ordinary/capital/excluded/disallowed split and one for basis conservation. The command
then foots the CSV's own columns back against the ledger and says so, because a per-row
sheet that disagrees with the totals it explains is worse than no sheet. Add `--audit-all`
to include the rows that move nothing.

Because a card revolves, the payment and the purchases it covers rarely line up: pick
`"method": "pro-rata"` (default) or `"fifo"` and apply it consistently, as
`§1.988-2(a)(2)(iii)(B)(1)` asks. Overpayments are carried as prepayments and refunds
re-point the payment that funded them, so that every payment dollar ends up against a
purchase or explicitly unspent; the report checks that identity and should reproduce the
statement's own closing balance.

## probes/

Targeted engine-fidelity probes, each tied to a design doc: `probe-residency-cgt`,
`probe-foreign-property-cgt`, `probe-988-method-dispersion` (all wired to npm scripts),
plus `prototype-crossborder-allocation-scope` and `prototype-rebalance-cadence`.

A probe is committed when its answer has to be re-derivable later — when a number in a
design doc would otherwise go stale silently, or when the measurement is the thing a
decision rests on. Throwaway spikes stay throwaway.

`probe-988-method-dispersion` (`npm run probe:988-method`) is design 87 G6's deciding
measurement: the two `§1.988-2(a)(2)(iii)(B)(1)` consumption conventions run across seeded
FX paths, paired by seed, reported as **dispersion** rather than a winner — because the
election is locked at adoption and binds every later year. It prints separability
diagnostics before the answer, because a zero spread means either "the methods agree" or
"this scenario cannot tell them apart", and design 87 §14.2 records what happens when those
two get confused. `--au-rental` is needed to make the ordinary/§212 branch fire at all.

`probe-spending-composition` is design 89 §3/§4/§10 — "what fraction of the plan's outflow
is actually spending?" It sums every negative `.balance` delta by action type **twice**: at
face value, and through the real report machinery (`runReport` + `reportCurrency`) so each
row converts at the run's own rate on its own date. The gap between the two columns is the
point — on the reference plan `EXPENSE_DEBIT` falls ~7 points on conversion while every
other line rises, because expenses are AUD-funded and AU tax is paid from a USD account.
It is committed rather than throwaway because design 89's original table went stale enough
to change its own headline: **shares go stale, the classification does not.** It also
prints a COVERAGE block naming the debited state keys the shipped reports cannot see.

The two **design 94** probes are the step-0 spike for "equity as security positions", and
they exist because the design's first pass got both answers wrong in opposite directions:

- `probe-security-registry-clone-cost` prices a `state.securities` registry the only way
  that matters — `deepClone` cost on a real run's state, because reducers can only read
  what is in state and state is cloned per event (design 78 §3.2). The first pass called
  the registry free; it is roughly **+50% per clone at 20 securities**, paid by every
  scenario whether or not it holds a concentrated position. That number is what design 94
  §6.4's `cloneState()` recommendation exists to remove, so re-run this before adopting or
  dropping it.
- `probe-unitised-equity-rounding` asks whether flipping equity from scalar to unitised
  moves the money. It is exact on the growth path and **sub-cent once units change**, which
  is the difference between "the migration moves no golden" (the first pass's claim) and
  "the migration ships with a re-gold" (what step 3 actually has to plan for). It is a
  replica of `holding-utils.js` arithmetic, not the engine — its job is to make a falsifiable
  prediction for the real golden run, not to replace it.

`probe-consumption-intent-gap` is design 89 §5.1 step A. `AccumulateConsumptionReducer`
builds `cumulativeConsumption` — what `DIE_WITH_TARGET` maximizes — from `action.amount`,
which `ExpenseDebitReducer` then caps at the balance, so a short plan books consumption the
household never received. The probe replicates the reducer's own arithmetic per **dispatch**
(not per journal entry — `EXPENSE_DEBIT` is journaled three times) and **cross-checks its
intent total against the run's own `cumulativeConsumption`** before reporting anything: a
measurement of a bug is worthless if it is measured by a second bug, and that check caught
exactly such a bug while this probe was being written. `--stress <x>` scales monthly
expenses to make the cap bite, since a defect that cannot be provoked cannot be
characterised. On a solvent plan the gap is exactly zero.

## dev/

`build-index.js` (`npm run build:index`) regenerates the auto-generated
`src/index.js`. `check-requirements.js` (`npm run requirements`) cross-references the
requirements spec against `EVT-X:` test names.

`build-fx-series.mjs` (`npm run build:fx-series`) derives the engine-readable monthly FX
module `src/finance/fx/data/usd-aud-h10-monthly.js` from the pinned daily
`rates/DEXUSAL-daily.csv` (design 92 §7). It exists because the engine also runs in the
browser and cannot read `rates/`. It **inverts direction exactly once** — the published
series is USD per AUD, the engine wants AUD per USD — and downsamples with the same
carry-forward rule the daily table uses, never an average. `--check` re-renders and diffs
without writing; `tests/unit/fx-series-package.test.mjs` runs it, so a generated file that
drifts from its source fails the suite rather than being discovered later.

---

## lib/ — read this before writing a new tool

Not runnable. Import these rather than re-deriving them; each encodes a trap that
produced a wrong answer at least once.

| module | what it owns |
|---|---|
| `cuts.mjs` | **the balance-sheet cuts a study reads off state** — one base currency, one scope vocabulary |
| `path.mjs` | reading the PATH a run took: troughs, year walks, untouched-lot sleeve returns |
| `grid.mjs` | the in-process rows × cols runner: the loop, the ETA, the tables, the envelope |
| `cli.mjs` | flag parsing where an unknown flag is an ERROR; `setParam` writes both param stores |
| `preflight.mjs` | the axis-liveness gate: prove the levers MOVE before the grid runs |
| `scenario-source.mjs` | loading the base cfg; the file-vs-synthetic distinction |
| `fx-rates.mjs` | the **published** rate table; holiday carry-forward vs. not-yet-published |
| `section988-source.mjs` | real-history ingest: footing, the two classification axes, G6 measurements |
| `section988-card.mjs` | credit-card statements: which purchases a payment retired, and its business fraction |
| `section988-ledger.mjs` | design 87 G5 lot ledger: lots, FIFO/pro-rata, per-account/commingled, the ordinary-vs-capital split |
| `variant.mjs` | **the single definition of every lever** |
| `run.mjs` | running one cfg → a comparable row; real-spending traces |
| `parallel.mjs` + `grid-worker.mjs` | fanning jobs across worker processes |
| `mc.mjs` | Monte Carlo arm setup and the three traps below |
| `mc-analysis.mjs` | paired rescues, failure bands, driver attribution |
| `format.mjs` | money formats and fixed-width tables |

### Never re-derive a balance-sheet cut

`cuts.mjs` owns "how many years of spending sit outside equity", "what is this book
worth", "where did the BOND target land". Eleven study scripts across four studies had
each written their own version, and they disagreed: three divided AUD by a **literal
1.55** rather than the run's own rate, so their cover figures were not comparable with
the studies they were quoted beside. In the `offset-bond-pool` grid that was live, not
latent — `STAGFLATION_1970S_LITE` carries `fxAdjustment: { USD_AUD: -0.10 }` on a
ten-year L profile, so the rate at the 2042 horizon is 1.45 and every AUD balance in
that column was priced 6.9% wrong.

`src/finance/fx/to-base-currency.js` already said this in its own header — *"adding a
copy of these six lines is a bug waiting for a currency"* — after design 82 §5.3 found
one of five in-engine copies had already drifted. `cuts.mjs` routes every scripts-side
valuation through it.

The scope is the part worth reading before you call it. `wrappers` defaults to
`'exclude'` (age-gated money is not cover for an early retiree) and `offsets` to
`'exclude'` (the backstop *below* the accessible pool, not part of it) — which is right
for a cover question and wrong for a wealth question, so `netWorth` includes both. A
missing FX rate now falls back to 1:1 rather than 1.55, which is a ~55% error on an AUD
book, so call `assertRatesSeeded(state)` — or run the preflight gate, which does.

### Prove the axes move before you run the grid

`preflight.mjs`. The failure it exists to catch is not a crash; it is a grid that
**completes, looks reasonable, and measured nothing**. A `drawdownSequence` authored with
`key` instead of `name` was dropped on the way to the compiler and every arm came back
byte-identical. A mistyped shock preset silently ran a no-crash column. A facility-size
axis moved nothing because the offset was not in the drawdown queue. Each produced a
confident, wrong answer *of exactly the right shape* — an inert axis does not look like
noise, it looks like the finding "the lever doesn't matter", which is the one conclusion
nobody re-checks.

The gate runs the corner cells and asserts the answer CHANGES along each axis, after
checking that each lever reached `sim.state` at all. `scenarios/offset-bond-pool/smoke.mjs`
is the worked example; keep study-specific label checks (does the "6 year" row *realise*
six years?) in the study, since they are the part that cannot generalise.

One thing it taught, worth carrying: `cfg.events` is meaningless until the cell is
opened. `ScenarioLoader` rebuilds the event list from the `shocks` param, and a scenario
can carry an authored `ECONOMIC_SHOCK` of its own — read the cfg unopened and every
column looks like a crash column.

### Read the path, not just the endpoint

`path.mjs`. Terminal wealth is measured after the recovery, so it rewards whoever
carried the most equity through it — on that metric a cash-or-bond reserve can only
lose, which is arithmetic about the equity premium and not a finding about reserves. In
the `offset-bond-pool` study the terminal and trough tables **disagree in sign** in the
lost-decade column.

`troughTracker(read, window)` names the window instead of burying it in a `Math.min`,
because a trough over the horizon and a trough over the vulnerable decade are different
numbers answering different questions. `walkYearEnds` clamps to `simEnd` (stepping past
it throws, and past it income and tax stop while balances keep growing) and starts in
the **simStart year** — a loop that starts a year later closes its first interval at the
end of year two, so a crash dated in year one happens inside it invisibly. That one cost
a 2027 GFC column that read identical to no-crash.

`sleeveReturn` measures a year's total return on the lots **nobody touched**, and adds
income back. Both halves matter: a whole-book estimator reads a SALE as a market loss, so
the arm that sells most looks like the arm that lived through the worst market; and
coupons and dividends are paid out to cash rather than accruing into a lot, so a
price-only reading scores bonds at ~0%/yr — not a small error, the whole of a bond's
return. It is deliberately uncurrency-converted (it is a ratio over fixed lots) and
reports `mixedCurrency` when that assumption stops holding.

### Grids: two runners, and which one you want

`lab/variant-grid.mjs` is the default — axes as DATA in a spec file, fanned across worker
processes. Reach for `lib/grid.mjs` only when the axes cannot be written down as lever
values: `offset-bond-pool` crosses shock presets with a drawdown SEQUENCE rebuilt from the
scenario's own accounts, and a spec file cannot hold a function. `runGrid` owns the cross
product, the progress line with an ETA, per-cell error handling and the results envelope,
and runs cells serially in-process so a cell can read `sim.state` rather than reduce to a
row. That is affordable at ~0.3s a cell; when a cell is a whole Monte Carlo arm it is
minutes, the arm is defined by data anyway, and the answer is `parallel.mjs` plus a worker
module (see `account-asset-classes/ladder-frontier.mjs`).

A cell that throws **aborts the grid** by default. That is the same lesson as the
preflight gate: catching the error turns a wiring failure into one odd entry in an
otherwise complete table.

Keep the axes in a `study-config.mjs` that both the grid and its preflight import, so the
thing that is smoke-tested is literally the thing that runs.

### Declare your flags

`cli.mjs`. Seventeen scripts had their own `flag()` helper and all four spellings shared
one behaviour: an unrecognised flag returns the default, silently. `node study.mjs
--shock-yr 2033` ran the default year and said nothing — a mistyped shock flag is one of
the two failures that produced a complete, plausible, meaningless grid. `parseFlags`
takes a declaration, so an unknown flag is an error that names the near miss, `choices`
are enforced, and `--help` falls out of the same declaration.

`setParam` is in the same module because it is the same class of silence: `name` is the
identity field `ScenarioLoader` syncs on, so a param row written with only `key` reads
back correctly in the script and is dropped on the way to the compiler. Use
`variant.mjs`'s `makeSetParam` when you hold a loaded cfg and the lever bag; use this one
when you hold a parsed scenario document.

### Traps worth knowing before you write a lever

**Two param stores.** A workbench export populates the authored `cfg.params` *list*;
`buildDefaultConfig()` populates only the flat `cfg.parameters` *bag* and leaves the
list empty. Code that reads one store works against a saved plan and is silently
inert against the default — confident numbers from an unchanged scenario. Read via
`numericParams(cfg)` and write via `makeSetParam(cfg)`, which sets both.

**Persisted rate maps shadow params.** Growth rates also live in
`initialState.baseGrowthRates` / `effectiveGrowthRates`, applied *after* the param
bag. Setting `brokerageGrowthRate` without rewriting those maps changes nothing on a
file-sourced cfg. Use `applyEquityShift`. (`tests/unit/mc-sampling-not-inert.test.mjs`
guards the Monte Carlo version of this failure.)

**`monthlyExpenses` is not total outflow.** Mortgage and loan payments are separate
cash outflows (design 54 P2 moved property debt onto synthesized loan accounts), so
"$10k/mo all in" means `monthlyExpenses = 10000 − mortgage` while the house is held.
Use the `spendTotal` lever, which does that arithmetic and switches to the full amount
after the sale. Setting `monthlyExpenses: 10000` models ~35% more spending than
intended.

**`spendTotal` and `spendingStrategy` collide.** `spendTotal` is implemented *via*
`EXPLICIT_BANDS`. Ask for both and the lever bag lets the named strategy win, with
`spendTotal` contributing only the expense level — otherwise a study of what GUARDRAIL
costs would silently re-measure FIXED spending and find no difference.

**MC variable centers follow the loaded scenario (fixed).** They used to come from the
framework defaults unless the caller passed the scenario's params, so a plan assuming
10% returns was sampled around the framework's 5% default — overstating every failure
rate — and a *disabled* lever wrote its framework default over the plan's own value.
`IntlRetirementMcRunner.run()` now seeds its base from the cfgTemplate's own params, so
this holds with no caller cooperation. `summary.provenance` (persisted per arm, printed
by `mc-report`) names any center that is *not* the plan's; `--no-recentre` only silences
`buildMcConfig`'s verification of that.

**MC shock variables need `shocks` in the base params (fixed).** Enabling
`shocks[0].severity` and calling `runner.run({})` used to build no shock variables at
all, silently, so the arm measured a world with no crash in it. The runner now reads
`shocks` off the cfgTemplate; passing `run({ shocks })` still works and still wins.

**One sim per process.** `ServiceRegistry` is a process-global singleton reset on every
run, so two sims cannot be in flight at once. That is why `parallel.mjs` uses processes
rather than threads.

## specs/

Grid and arm definitions. A real spec describes a real plan — retirement dates,
spending levels, asset values — so `specs/.gitignore` ignores everything except the
committed `example-*.json`. Keep your own specs here under any other name and they stay
local.
