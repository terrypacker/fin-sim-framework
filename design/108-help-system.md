# 108 — The help system: generated reference, stamped prose, two surfaces

**Status:** phases 1-5 BUILT; phase 6 (retiring the drifted copies) remains. Originally
proposed, and **fully specified bar one seam** — §12 records the seven decisions
taken with the user on 17 Sep 2026, and §13 holds the single remaining question (Q4, which
phase 4 settles against the real topic list rather than in advance). This design touches no
reducer, no handler and no scenario param, so it moves no golden. Its whole cost is tooling,
prose, one workbench plugin, and the CLI migration in §11 phase 2.

## 1. The ask

The app has outgrown the ability to explain itself. Answering *"what does this parameter
do"* or *"what is this panel for"* currently requires reading source or design docs, and
that is true for two different readers with two different failure modes:

1. **An LLM driving the app headlessly** for studies and analysis. It needs a map — what
   params exist, who owns them, which CLI tool sweeps them — and today it rebuilds that map
   by grepping `src/` on every session.
2. **The user, in the app.** Parameter descriptions exist and are good, but they are
   delivered as native browser tooltips and the long ones are cut off. Panels have no
   documentation at all beyond a tab title.

The hard part is not writing documentation. It is writing documentation that stays true and
stays short enough to be read. §2 shows that this repo has already failed at that twice, in
exactly the way a hand-maintained second copy always fails.

## 2. Where we are today

Measured, not assumed.

| fact | where |
|---|---|
| The full param surface is **221 params**, assembled from the scenario schema plus 20 toolsets | `IntlRetirementScenario.buildFullParamSchema()`, `src/scenarios/intl-retirement-scenario.js:1228` |
| **100% of them carry a `description`** — zero gaps | measured over `buildFullParamSchema()` |
| Median description is **229 characters**; **134 exceed 200**; the longest is **1,901** | same |
| Each entry also carries `type`, `group`, `defaultValue`, and variously `options`, `min`/`max`/`step`, `visibleWhen`, `mc`, `opt`, `node`, `optionsFrom` | `[...new Set(schema.flatMap(Object.keys))]` |
| 34 params are MC-sweepable, 64 optimiser-controllable | `mc`/`opt` flags |
| They fall into **21 groups**, the largest being Economic Shocks (52) and Spending (44) | `group` field |
| Those descriptions reach the user as `labelEl.title = tooltip` — a **native browser tooltip** | `src/visualization/scenario/scenario-tab-view.js:497` |
| The param filter already searches descriptions, and defaults to searching *only* descriptions | `scenario-tab-view.js:84,378` |
| **32 workbench panels** are registered, each with `{id, title, component}` and no prose | `FINANCE_PLUGINS`, `src/visualization/workbench/plugins/finance/finance-plugin-package.js` |
| ~160 journal action types are declared with typed field schemas | `{ type, fields }` entries across `src/scenarios/toolsets/*.js` |
| **61 CLI entry points** exist under `scripts/`; **2** use the declarative `parseFlags` spec | `grep -rl parseFlags scripts` |
| …but every one carries a `/** <name>.mjs — <purpose>. */` docblock as its second comment | sampled across `lab/`, `probes/`, `tax/` |
| State fields carry a *value type* (`currency`, `rate`, `index`, …) but no prose | `src/finance/services/state-schema-registry.js` |
| `public/help/main.htm` exists — 188 bytes, five conceptual lines — and **nothing references it** | `grep -rn main.htm` returns only itself |
| Generated-source-committed-to-repo is established precedent | `scripts/dev/build-index.js` → `src/index.js` |

### 2.1 The drift is already measurable

Three hand-maintained indexes, all of them stale:

| index | covers | actual | missed |
|---|---|---|---|
| README plugin table (`README.md:406`) | 18 plugin ids in 14 rows | 32 plugins | **14** |
| README design-doc list (`README.md:544`) | `0-` through `19-` | 116 files | **97** |
| `design/README.md` index | 10 links | 116 files | **106** |

The 14 undocumented panels are `parameters`, `watchlist`, `holdings`, `allocation`,
`securities`, `spending`, `pools`, `paycheque`, `journal-report`, `cross-action-query`,
`scenario-compare`, `dg-config`, `dg-results`, `mpc-cockpit` — that is, most of the last
year's work. Every one of them was added by a commit that could have updated the table and
did not, because nothing failed when it didn't.

**This table is the design constraint.** Any scheme whose answer to "keep it in sync" is
"remember to update the other copy" has already been tried here, three times, and lost.

## 3. The shape

Three tiers, and one rule that holds them apart.

```
  tier 1  REFERENCE   generated from code      221 params · 32 panels · ~160 actions · 61 tools
             │                                 never hand-edited · cannot go stale
             │
  tier 2  TOPICS      hand-written prose       ~53 files · word-budgeted · stamped
             │                                 why / when / how it connects
             │
  tier 3  DESIGN      design/*.md              the full argument, already written
```

**The rule: nothing is written at two tiers.** Tier 2 may not restate a param description —
tier 1 already emits it exactly, and a restatement is precisely the copy that drifts. Tier 2
says what code cannot: what a panel is *for*, when you would reach for it, which concepts it
assumes. When a topic needs more than its budget, the answer is a design doc, not a longer
topic.

This is what makes "concise enough to read" and "useful enough to be worth reading"
compatible rather than opposed. Each tier is short because the next one exists.

## 4. Tier 1 — the generated index

`scripts/dev/build-help-index.mjs` imports the real registries — not a parallel description
of them — and emits one structure:

```
params[]    key · label · group · type · defaultValue · options · min/max/step
            visibleWhen · mc · opt · description · contributedBy (toolset id)
panels[]    id · title · category · defaultPane · source file
actions[]   type · fields{name: valueType} · declaringToolset
tools[]     path · npmScript · purpose (from docblock) · flags[] (name · type · default · help)
state[]     path glob · ParameterValueType kind · chartable
topics[]    tier-2 frontmatter, resolved
```

`contributedBy` is derivable: `_paramToolsets()` is public and ordered, so walking it and
recording first-writer-wins per key reproduces the merge rule `buildFullParamSchema()` and
`ScenarioLoader._mergeParamSchema` already share.

`flags[]` is read from each script's `parseFlags` spec, which **D6 makes universal** — until
that migration lands, a script without one contributes its docblock purpose and an empty flag
list, and the gate names it (§6).

Two outputs, deliberately different:

- **`help/REFERENCE.md`** — committed. Human- and LLM-readable, and its *git diff is the
  review signal*: a PR that adds a param shows the new row, and a PR that changes a
  description shows the change in a reviewable place for the first time.
- **`public/help/help-index.json`** — gitignored build artifact, produced by `prebuild` and
  by `npm run help`. Keeping it out of git avoids a large mechanical diff on every PR, and
  regenerating it on build means a deploy can never ship a stale one.

Maintenance cost of this tier is zero, because it is not a copy of the code. It is the code.

## 5. Tier 2 — topics

A new top-level `help/` tree. Markdown with frontmatter:

```yaml
---
id: liquidity-pools
kind: concept              # concept | panel | workflow
title: Liquidity Pools
panels: [pools]            # workbench plugin ids this explains
params: [poolGraph, drawdownSequence]
design: [97-liquidity-pools-and-drawdown-sequence.md]
sources: [src/finance/pools/liquidity-graph.js]   # optional, 0-2 files, see §6
stamps:
  param:poolGraph: a3f1c9
  param:drawdownSequence: 7d20b4
  src/finance/pools/liquidity-graph.js: e81f06
---
```

**Word budgets, enforced by the gate:**

| kind | budget | answers |
|---|---|---|
| `panel` | 250 | what this panel shows, when you'd open it, what it needs loaded first |
| `concept` | 400 | the mechanic: what it models, what it deliberately does not |
| `workflow` | 600 | a task across panels or CLI tools, start to finish |

Roughly 32 panel topics and 21 group concepts, plus a handful of workflows. `main.htm`'s five
orphaned lines become the seed of the `event-sourcing` concept rather than being deleted.

**The non-restatement rule is checkable.** A topic that shares a run of 12 or more consecutive
words with a param description it cites fails the gate. That is crude, and it is enough:
it catches paste, which is the only way restatement actually happens.

## 6. Stamps, and the gate

A presence check — "does every panel have a topic" — keeps documentation **complete**. It
does not keep it **true**: a topic about `drawdownSequence` stays silently wrong when the
param's meaning changes underneath it. Since truth is the stated problem, topics are stamped.

**Stamps are per-reference, not per-topic**, so the gate names the one thing that moved
instead of invalidating a whole page:

- `param:<key>` — hash of the whitespace-normalised description. Short, dense, load-bearing.
- `panel:<id>` — hash of title plus category. Catches renames.
- `src/<path>` — **optional, author-chosen, at most two files.** The topic declaring "I am a
  claim about this code." This is the stamp that catches drift a description edit would miss,
  and the one with the highest noise, which is why the author chooses it and the budget is
  small.

**Design docs are referenced but never stamped.** They are long and edited constantly; a
stamp on one would fire on every paragraph and teach blind re-stamping, which destroys the
signal everywhere else.

`scripts/dev/check-help.mjs`, wired into `npm test`, fails on two classes:

| class | example | fix |
|---|---|---|
| structural | a `FINANCE_PLUGINS` id with no `kind: panel` topic; a `params:` key that no longer exists; a topic over budget; a 12-word paste | edit the topic |
| stamp drift | `param:drawdownSequence` hash no longer matches | look, then `npm run help:restamp -- liquidity-pools` |

**It fails `npm test`, not only CI (D5).** Failing locally is the entire mechanism that
would have caught the 14 missing panels, and a gate that fires only after you have pushed
teaches you to push first. The one case that argues the other way — deliberately editing a
description mid-refactor and not yet touching the topic — costs one `help:restamp`, which is
cheaper than the drift in §2.1. If that friction turns out to be real in practice, a
`HELP_STRICT=off` escape matching the existing `JOURNAL_STRICT` convention is the shape to
add; it is not being built up front.

A third class **reports without failing**: params whose group has no concept topic. That one
is a backlog made visible rather than a gate, because Q4 has not settled which groups deserve
a topic of their own. The CLI backlog is *not* in this class — D6 migrates all 61 scripts to
`parseFlags`, after which a script without a flag spec is a structural failure like any
other.

This is deliberately the workflow the repo already runs for golden fixtures: a hash moves, the
gate fails, you look, you re-gold. Stamps are goldens for prose, and the re-stamp shows up in
the diff — so "cleared without reading" is visible at review rather than invisible forever.

## 7. Tier 3a — the headless surface

What an LLM needs is not prose, it is a map it can load in one read and then query.

- **`help/REFERENCE.md`** — the whole index in one committed file: every param with group,
  type, default, owning toolset, sweepability and description; every panel; every action
  type; every CLI tool and its purpose. One `Read` replaces a session of grepping.
- **`npm run help -- --find <text>`** — lookup over the index, printing the matching param,
  panel, action or tool entry plus any topic that cites it, with `--kind` to restrict to one
  surface. For when the file is more than the question needs. It takes a flag rather than a
  bare word because `cli.mjs` refuses positionals outright, and D6 puts every entry point on
  that spec — carving an exception for the first tool written after that decision would be a
  poor start.
- A one-line pointer in `.claude/CLAUDE.md` next to the existing README pointer, so the file
  is found without being asked for.

## 8. Tier 3b — the in-app panel

A 33rd plugin, `help`, default pane `right`.

- **It follows the active tab.** `WorkbenchShell._onActivate(tab, pane)` already runs on
  every tab change (`workbench-shell.js:304`); emitting a new `WB_EVENTS.TAB_ACTIVATED` there
  is a two-line change, and the panel renders that tab's topic with no user action.
- **It fixes the tooltip.** A `?` affordance on each param label and group header opens the
  full description in the panel — the complete 1,901 characters, laid out, next to the
  default, the range, the sweepability, the owning toolset, and any topic that cites it.
  `scenario-tab-view.js:497` keeps its `title` attribute as the hover shortcut.
- **Markdown is pre-rendered at build time.** `marked` as a devDependency; the generator
  emits HTML into the index. Nothing new ships to the browser, there is no renderer to own,
  and no untrusted HTML path is introduced. Vite watches `help/` in dev so editing a topic
  refreshes the panel.

## 9. What this deliberately does not do

- **It does not document state fields with prose.** 
  `StateSchemaRegistry` gives every field a value type, and there are far more fields than
  params. Tier 1 emits the typed list; prose about state lives in concept topics about the
  mechanic that writes it.
- **It does not replace the design docs.** Tier 2 links to them and is budgeted precisely so
  that the temptation to inline their argument fails the gate instead of succeeding quietly.
- **It does not backfill the README tables.** Once tier 1 exists, `README.md:406` and
  `README.md:544` should be replaced by a pointer to the generated file rather than repaired
  by hand — repairing them recreates the exact copy that produced §2.1.
- **It does not add a scenario parameter, a handler or a reducer.** No golden moves.
- **It does not build a global search.** The param filter already searches descriptions; a
  cross-index search over panels, actions and topics is a natural follow-on, and is out of
  scope here.

## 10. Test plan

| test | asserts |
|---|---|
| `help-index.test.mjs` | the generator runs, and emits one entry per param in `buildFullParamSchema()`, one per `FINANCE_PLUGINS` id, one per declared action type |
| | `contributedBy` reproduces the `_mergeParamSchema` first-writer-wins rule for a key contributed by two toolsets (the US/AU retirement spending family) |
| `check-help.test.mjs` ✅ | a topic naming a nonexistent param fails; a topic over budget fails; a 12-word paste from a cited description fails |
| | a changed description fails the stamp check, and `restamp` clears exactly that stamp and no other |
| | a new `FINANCE_PLUGINS` entry with no topic fails |
| | a script under `scripts/` with no `parseFlags` spec fails once D6 has landed |
| `cli-migration.test.mjs` ✅ | every entry point under `scripts/` parses `--help` and exits 0; an unknown flag exits 2 rather than running the default |
| `help-plugin.test.mjs` (viz) ✅ | `TAB_ACTIVATED` renders the matching topic; a tab with no topic renders the fallback, not a throw |
| | the `?` affordance renders the full description for the longest param in the schema without truncation |
| | and: every registered panel resolves to a topic; activating Help does not clobber what Help was asked to show; following a tab does not push history; a missing index reports how to build one rather than rendering empty |

## 11. Build order

**Phase 1 — tier 1 and the headless surface.** `build-help-index.mjs`, `help/REFERENCE.md`,
`npm run help`, the `.claude/CLAUDE.md` pointer. Delivers the LLM half outright, and produces
the exact inventory of what tier 2 owes.

**Phase 2 — the CLI migration (D6). ✅ DONE 2026-09-17.** All 64 entry points are on
`parseFlags`; `cli-migration.test.mjs` runs `--help` on every one and fails on a script that
declares no arguments. Two additions to `cli.mjs` the real tree demanded: a declared
`positional:` (`variadic`, `required`, `choices`), so `npm run scenario -- a.json b.json`
and `frontier.mjs <mode>` survive the migration rather than being rewritten as flags; and
`repeat: true`, because `--csv <name>=<file>` is repeatable in both §988 tools and last-wins
there ingests one account and reports on it as the whole pool. `isEntryPoint()` keeps
modules and the two Python converters out of the D6 denominator. Original plan below.

Move the 59 hand-rolled argv parsers onto `parseFlags`. Independent of every other phase and parallelisable, but it belongs early for
two reasons: it completes `tools[]` while the generator is still being shaped around it, and
`cli.mjs` was written for exactly this migration and has stalled at 2 of 61 once already —
the longer it waits, the larger it gets. Each script is a small, mechanical, individually
testable edit, and the payoff is not only documentation: `parseFlags` errors on an unknown
flag, which is the failure mode `cli.mjs` records as having produced "a complete, plausible,
meaningless grid".

**Phase 3 — the gate, in warn mode. ✅ DONE 2026-09-17.** `scripts/lib/help-topics.mjs`
(reader, stamps, checks), `npm run help:gate`, `npm run help:restamp`, and
`check-help.test.mjs`. Wired into `npm test` as `help:gate -- --quiet`: it prints the
one-line summary and exits 0. Today that reads **32 structural · 0 stamp · 21 backlog**, the
32 being the panel topics phase 4 owes and the 21 the groups Q4 has not settled. `--strict`
makes structural errors and drift fatal, and `--kinds panel` restricts it to one kind, which
is the mechanism phase 4 flips. One seed topic, `help/concepts/event-sourcing.md`, exists so
the machinery runs against real data rather than only fixtures; `public/help/main.htm` is
still there and retires in phase 6 as planned. `--template <kind>` prints a blank topic
generated from the same constants the gate reads.

Original plan: `check-help.mjs` runs and reports; nothing fails yet.
Stamps are written by the generator as topics appear.

**Phase 4 — tier 2 prose. ✅ DONE 2026-09-17.** 32 panel topics and **25 concept topics**,
12,500 words, every one inside its budget. `npm test` runs the gate with
`--enforce panel,concept`, so both kinds now fail the build. **Q4 is settled: per-MECHANIC**
(see §13). The backlog metric changed with it — it counts uncited PARAMS, not groups,
because under per-mechanic topics a per-group count would call a 52-param group covered the
moment one topic cited one of its params. It reads 0 of 221.

Original plan: 32 panel topics, then 21 group concepts. The gate flips to
failing per-kind as each kind completes, so `panel` can be enforced while `concept` is still
being written. Q4 is settled here, against the real list.

**Phase 5 — the in-app panel. ✅ DONE 2026-09-18.** A 33rd plugin, `help`, in the right
pane. `WorkbenchShell._onActivate()` publishes `WB_EVENTS.TAB_ACTIVATED` and the panel
renders that tab's topic with no user action; `activatePlugin()` was routed through the same
method so a programmatic activation (a drill-down) is announced too. The `?` beside a param
label and on each group header publishes `WB_EVENTS.HELP_OPEN`, and the 1,901-character
description renders in full — asserted character for character against the schema, because a
panel that also truncated would be the same bug with more markup. `marked` is a
devDependency: `collectTopics()` pre-renders every topic into `topics[]`, so the browser
bundle carries no markdown renderer (checked in `dist/`). Additions the real tree demanded:
`topics[]` in the index and a Topics section in `REFERENCE.md` (frontmatter only — a topic
may not be restated, so there is nothing to duplicate); `--kind topics` in `npm run help`,
with a param or panel hit now naming the topic that explains it, which §7 asked for and
phase 1 could not do; a vite dev plugin that regenerates the index JSON when a topic
changes; and the toolbar's `#btnHelp`, wired to something for the first time — it had been
listening to nothing since before the workbench existed.

The gate's own test had hard-coded `32 panel`, and the 33rd panel broke it. That literal was
a small drifting index of exactly the §2.1 kind, so it now counts `FINANCE_PLUGINS`.

**Phase 6 — retire the copies.** Replace the README plugin table and design-doc list with
pointers; fold `public/help/main.htm` into the `event-sourcing` concept.

## 12. Decisions (17 Sep 2026)

**D1 — Stamps, not a presence gate.** Proposed presence-only on workflow-cost grounds; the
user pushed back and was right. A presence gate keeps docs complete, not true, and truth is
the stated problem. The cost objection does not survive the observation that this repo
already runs the identical workflow for golden fixtures. Mitigations against noise are in §6:
per-reference granularity, design docs unstamped, `src/` stamps optional and capped at two.

**D2 — Markdown pre-rendered at build time.** `marked` as a devDependency, HTML in the index.
No runtime dependency, no renderer to maintain.

**D3 — Phase 1 is the generator and the headless surface.** The in-app panel and the ~53
topics come after, so the LLM half ships without waiting on a writing backlog.

**D4 — Prose lives in a new top-level `help/`.** Not `docs/` (primary tax sources) and not
`design/` (decisions). Generated JSON stays out of git; generated `REFERENCE.md` stays in it.

**D5 — The gate fails `npm test`, not only CI.** (Was Q1.) A gate that fires only after a
push teaches you to push first, and local failure is the whole mechanism that would have
caught the drift in §2.1. No escape hatch is built up front; §6 records `HELP_STRICT=off` as
the shape to add if mid-refactor friction proves real.

**D6 — All 61 CLI entry points migrate to `parseFlags`.** (Was Q2. ✅ **DONE** — 64 of 64;
the count rose because `isEntryPoint()` counts what actually reads a command line.) It completes `tools[]`,
gives every script a real `--help`, and — independently of documentation — makes a mistyped
flag an error instead of a silent default. Scheduled as §11 phase 2, early, because this
migration has already stalled at 2 of 61 once and only grows.

**D7 — `actions[]` does not map reducers to action types.** (Was Q3, deferred.) It is a real
question a journal reading raises, but it needs a static scan of the reducer registry rather
than a registry read, and nothing else in this design waits on it. Revisit once the scan is
shown to be cheap; until then `actions[]` carries the type and its field schema only.

## 13. Still open

- ~~**Q4 — Per-group concept topics, or per-mechanic?**~~ **SETTLED 2026-09-17:
  per-mechanic**, and the guess in this section was right. Against the real list the groups
  are an arrangement of a panel, not of the engine:

  | group | what it actually is |
  |---|---|
  | Economic Shocks (52) | five mechanics — return paths, inflation, rates + yield curve, shocks, RNG |
  | Spending (44) | four — drawdown order, the spending rule, pools, funding timing |
  | US Retirement (9) | a junk drawer: `inflationRate` and `goldGrowthRate` are return assumptions, not US retirement |
  | Allocation + Behavioral | rebalancing is split across both; pool sizing sits in Behavioral |
  | 5 small groups | Company Equity is one param; none deserve a page of their own |

  25 mechanic topics cover all 221 params. Five groups dissolve entirely, three split, and
  two merge.
