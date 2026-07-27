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
  scenario/           run · diff · sweep · audit one or more scenarios
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

## probes/

Targeted engine-fidelity probes, each tied to a design doc: `probe-residency-cgt`,
`probe-foreign-property-cgt` (both wired to npm scripts), plus
`prototype-crossborder-allocation-scope` and `prototype-rebalance-cadence`.

## dev/

`build-index.js` (`npm run build:index`) regenerates the auto-generated
`src/index.js`. `check-requirements.js` (`npm run requirements`) cross-references the
requirements spec against `EVT-X:` test names.

---

## lib/ — read this before writing a new tool

Not runnable. Import these rather than re-deriving them; each encodes a trap that
produced a wrong answer at least once.

| module | what it owns |
|---|---|
| `scenario-source.mjs` | loading the base cfg; the file-vs-synthetic distinction |
| `fx-rates.mjs` | the **published** rate table; holiday carry-forward vs. not-yet-published |
| `section988-source.mjs` | real-history ingest: footing, the two classification axes, G6 measurements |
| `variant.mjs` | **the single definition of every lever** |
| `run.mjs` | running one cfg → a comparable row; real-spending traces |
| `parallel.mjs` + `grid-worker.mjs` | fanning jobs across worker processes |
| `mc.mjs` | Monte Carlo arm setup and the three traps below |
| `mc-analysis.mjs` | paired rescues, failure bands, driver attribution |
| `format.mjs` | money formats and fixed-width tables |

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
