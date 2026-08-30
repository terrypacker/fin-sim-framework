# Sequence risk — the offset as a down-market buffer

Design 97 §20. **Answered: no.** See design/97 §20.9.

The question: *use the offset for spending while the market is down, and top it back up by
selling equities after the recovery — does that mitigate sequence-of-returns risk, and what
does the loan interest cost?*

## The files

| file | what it is |
|---|---|
| `scenario.mjs` | the minimal synthetic scenario (§20.6) — one equity sleeve, no rebalancer, US-only, an interest-only fully-offset loan |
| `arms.mjs` | the four arms (§20.7) and the two return processes |
| `run-deterministic.mjs` | one dated crash, one path — the MECHANISM check, with three assertions that must pass before an MC number means anything |
| `run-mc.mjs` / `mc-worker.mjs` | the study: arms × processes on common random numbers, scored as paired per-path differences |

## Run it

```
node scripts/lab/sequence-risk/run-deterministic.mjs
node scripts/lab/sequence-risk/run-mc.mjs --n 300 --workers 8
node scripts/lab/sequence-risk/run-mc.mjs --n 300 --shock MARKET_CRASH_2008_LITE --crash 2032
```

The scenario is built from `IntlRetirementScenario.buildDefaultConfig()` and carries no
household figures, which is why this lives in source control rather than under `scenarios/`.

## Read it this way

- **`C−B`** is the policy's own effect; `B−A` is the standing carry of routing spending through
  the facility; `C−A` is the household's decision and is the sum of the two.
- Score the **paired per-path** difference, never a difference of two medians, and never gross
  disposal volume — design 97 §19.2c is the record of what that mistake costs.
- Read the median next to p10 and the rescued/broken counts. Leverage always flatters a median.
