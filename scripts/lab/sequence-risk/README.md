# Sequence risk — the offset as a down-market buffer

Design 97 §20. **Answered twice.** §20.9 said no; §20.12 found the scenario was not minimal —
a company-equity windfall landed in the spend account the year after the crash and funded
eleven years of spending, so the mechanism was switched off across the whole post-crash
recovery window. Re-run, the answer is **yes, for one gate**: §20.13 and §20.14.

The question: *use the offset for spending while the market is down, and top it back up by
selling equities after the recovery — does that mitigate sequence-of-returns risk, and what
does the loan interest cost?*

## The files

| file | what it is |
|---|---|
| `scenario.mjs` | the minimal synthetic scenario (§20.6) — one equity sleeve, no rebalancer, US-only, an interest-only fully-offset loan |
| `arms.mjs` | the arms (§20.7, §20.13, §20.14) and the two return processes |
| `run-deterministic.mjs` | one dated crash, one path — the MECHANISM check, with three assertions that must pass before an MC number means anything |
| `run-mc.mjs` / `mc-worker.mjs` | the study: arms × processes on common random numbers, scored as paired per-path differences |
| `export-json.mjs` | writes an arm as a workbench-importable scenario export, so it can be opened and played with by hand |

## The arms

| arm | refill edge |
|---|---|
| A | control — spend equity, the offset is claimed by no pool |
| B | offset first, refill UNGATED (must land on A, or C measures plumbing) |
| C | `sourceReturnOver: 0` — refill only after an up year (§20.7) |
| D | no refill at all — the pure deferral, and the leverage bound |
| E / F / G | `sourceDrawdownUnder` 1 % / 5 % / 10 % on the peak BALANCE (§20.13) |
| H / I / J | the same three on `drawdownBasis: INDEX`, the flow-neutral series (§20.14) |
| K / L / M / N | J at `sustainedYears` 2 / 3 / 4 / 5 — the dwell sweep (§20.16) |

J is the best-performing arm in the study. D is the worst tail. The dwell sweep is a negative
result: it walks J toward D — coin-flip medians, a doubling left tail, twice the interest.

## Run it

```
node scripts/lab/sequence-risk/run-deterministic.mjs
node scripts/lab/sequence-risk/run-mc.mjs --n 300 --workers 8
node scripts/lab/sequence-risk/run-mc.mjs --n 300 --shock MARKET_CRASH_2008_LITE --crash 2032
node scripts/lab/sequence-risk/run-mc.mjs --n 300 --spend 5000     # re-take §20.6's calibration
SEQRISK_KEEP_WINDFALL=1 node scripts/lab/sequence-risk/run-mc.mjs --n 300   # reproduce §20.9
```

`--spend` overrides `DEFAULTS.monthlySpend`. It exists because §20.6 chose 3.6 % of the book as
"a plan that survives centrally" with the windfall still in the plan: without it arm A fails 66
of 300 paths with no crash and 149 with one, and terminal wealth measured across that many
insolvencies is not a comparison of policies. **Re-taking that calibration is open work** —
until it is, read rescued/broken before the median.

## Open an arm in the browser

```
node scripts/lab/sequence-risk/run-deterministic.mjs --export-json --export-arms C
node scripts/lab/sequence-risk/run-deterministic.mjs --export-json scenarios/arm-c.json --export-arms C --no-shock
```

`--export-json` writes instead of running, and takes the same `--crash` / `--shock` /
`--no-shock` flags as the run — the file is the cfg that run would have used, so the four arms
round-trip to the byte. Upload it in the workbench's Scenario tab.

The export carries **no scenario id**. `upsertUserScenarios` is an upsert keyed on `id`, so an
export claiming a `u:<N>` would silently overwrite whatever already holds it; with the id
absent the registry mints a fresh one and an import can only ever add. `active` is omitted for
the same reason. Each arm is a separate record in one document, so importing gives you N
scenarios that differ only in `liquidityGraph`.

The scenario is built from `IntlRetirementScenario.buildDefaultConfig()` and carries no
household figures, which is why this lives in source control rather than under `scenarios/`.

`buildScenario` empties `companyEquities`, `collectibles` and `bequests` and then asserts they
are empty. That is not tidiness: `buildDefaultConfig` ships a \$500k company-equity grant whose
default `companySaleYear` is 2033, and the arms above put a crash in 2032 (§20.12). A scenario
that claims minimality has to assert it rather than perform it.

## Read it this way

- **`C−B`** is the policy's own effect; `B−A` is the standing carry of routing spending through
  the facility; `C−A` is the household's decision and is the sum of the two.
- Score the **paired per-path** difference, never a difference of two medians, and never gross
  disposal volume — design 97 §19.2c is the record of what that mistake costs.
- Read the median next to p10 and the rescued/broken counts. Leverage always flatters a median.
