# 98 — The sweepable parameter surface (Monte Carlo + Optimizer)

**Status: PROPOSED.** No code changed.

Started as an audit of one question — *are the growth-rate mechanisms duplicated, and is
the MC UI sweeping the right one?* — and the answer generalised. Growth rates are the
motivating case and §3–§8 are about them specifically, but the wiring defect underneath
them is not about rates at all: **which params can be swept is declared in the schema and
ignored by both sweep engines, each of which keeps its own hand-maintained list.** MC and
Opt have the same defect, the same shape of list, and near-identical panels, so they are
one piece of work.

Related: design 55 §8 (per-account rates), design 56 §7 (gold), design 74 (stochastic
return paths), design 75 §4 (property paths), design 90 §7 (the market axis, §7.4 open),
design 94 §6 (per-security overlay), `design/inconsistencies.md` §4.10 (dead MC axes).

**Vocabulary.** `param-schema-utils.js` already has the right word for this and it is
worth using consistently: a sweep variable list is an **overlay** on the param schema.
The schema owns *identity* (label, options, `visibleWhen`) and should own *sweepability*;
the overlay supplies *sweep metadata* (distribution or range, enabled, group).
`resolveSweepVariables` already merges the two — in one direction only. §9.1 is mostly
"let the schema contribute entries too".

---

## 1. The question

The MC panel's enabled-by-default rate axes are the per-wrapper account growth rates
(Roth / IRA / 401(k) / brokerage / AU stock / super). Separately the codebase has
`RATE_KEYS` — a market axis, a gold key, property sleeves, per-account overrides, a
per-security overlay — none of which appear in that panel.

**Answer: they are not duplicates, they are a five-level precedence ladder, and MC sweeps
level 4 of 5 — the one level a user editing an account in the UI silently overrides.**
Separately, the axes it does sweep are sampled in a way that cancels most of the
uncertainty they exist to represent.

---

## 2. The ladder — who actually sets a holding's growth rate

`computeHoldingsGrowth` (`src/finance/holdings/holdings-earnings.js:110`), highest
authority first:

| # | Source | Where it comes from | Reachable from |
|---|---|---|---|
| 1 | `rateOverride` | the handler's one-off `data.rate` | action payload only |
| 2 | `appreciationSchedule` | per-holding dated schedule | holdings editor |
| 3 | `<holding.rateKey>::<stateKey>` | `seedPerAccountRates` | *seeded from 5* |
| 4 | `<holding.rateKey>` (bare market key) | `collectBaseGrowthRates` | **nothing — §4** |
| 5 | account fallback `<memberKey>::<stateKey>` | `acct.growthRate ?? roleRate ?? market` | account editor / MC |
| 6 | handler-constructed `growthRate` | `acct.growthRate ?? p.<role>GrowthRate` | same as 5 |

Two additive overlays sit on top of whichever rate wins, and are *not* alternatives to it:
`state.securityReturnOverlay[securityId]` (design 94 §6.3), and the design 74 sleeve
deviation plus `RegimeApplyReducer`'s adjustments.

`seedPerAccountRates` (`economic-regimes-toolset.js:213`) is the choke point that collapses
levels 3–6 into one line:

```js
perVal = ownRate ?? roleGrowthRates[acct.role] ?? baseMap[memberKey];
```

`ownRate` is `account.growthRate`, defaulting to `null` (`assets/account.js:138`).
`roleGrowthRates` is `collectRoleGrowthRates(p)` — the six params MC sweeps.

So the model is coherent, not duplicated: **wrapper rates are per-account overrides of a
market rate**, exactly as design 90 §7.2 says. Everything below is exposure and sampling.

**This one line is also the lever.** Because every equity account's rate — and, via the
§7.3 international seed, every equity market key inside it — passes through it, a single
change here reaches the whole equity book coherently. §9.3 uses that.

---

## 3. F1 — the `mc:` / `opt:` schema flags are dead metadata

Every schema entry carries `mc:` and `opt:`, including generated per-record ones
(`record-param-templates.js:77` marks `growthRate` `mc: true`). **Nothing reads either
flag.** The only occurrence outside a declaration is `scenario-param-generator.js:189`
copying it onto the generated entry.

Both real lists are hand-maintained arrays: `DEFAULT_MC_VARIABLE_CONFIGS` plus five
contributors, and `DEFAULT_OPTIMIZATION_CONFIGS` plus four. So `mc: true` reads as wiring
and is decoration — and it has already misled a comment in the codebase:
`intl-retirement-opt-config.js:315` says the inherited-RA knobs are "opt-able via the
generated schema rather than hand-listed here", while `buildInheritedRaOptConfigs`
hand-lists them 200 lines further down.

## 4. F2 — the market axis has no params at all

`collectBaseGrowthRates` reads four keys:

```js
[RATE_KEYS.EQUITY_US]:         p.usEquityGrowthRate       ?? 0.07,
[RATE_KEYS.EQUITY_AU]:         p.auEquityGrowthRate       ?? 0.06,
[RATE_KEYS.EQUITY_INTL_EX_US]: p.intlExUsEquityGrowthRate ?? 0.07,
[RATE_KEYS.EQUITY_INTL_EX_AU]: p.intlExAuEquityGrowthRate ?? 0.07,
```

None of those four is declared in any `paramSchema()`. Not editable, not sweepable, not
settable from a scenario's params bag through the normal path. The market axis runs at
four hardcoded constants.

It is mostly invisible because design 90 §7.3 seeds `<intlKey>::<stateKey>` with the
account's own rate for every account of a known role, so a seeded account never falls
through to the bare key. That is the point: **the Rate Key picker (`rate-key-options.js`)
lets a user select a series whose level nobody can set.** Choosing `EQUITY_INTL_EX_US` on
a lot in a US brokerage today changes its beta, its shock target and its reporting
bucket, and leaves its drift equal to the brokerage's. Design 90 §7.4 names this as open;
this is the parameter half of it.

## 5. F3 — six equity axes, sampled independently, cancel each other out

`intl-retirement-mc-runner.js:704` samples every enabled axis from its own distribution:

```js
set(perturbed, cfg.paramKey, createDistribution(cfg).sample(rng));
```

Six of the enabled-by-default axes are equity growth rates (`rothGrowthRate`,
`iraGrowthRate`, `k401GrowthRate`, `brokerageGrowthRate`, `auStockGrowthRate`,
`superGrowthRate`), each `NORMAL` with `stdDev: 0.03`, drawn independently.

These are six wrappers holding, in substance, one asset class. Independent draws make
*portfolio* drift uncertainty `0.03 × sqrt(Σwᵢ²)` — at equal weights `0.03/√6 ≈ 0.012`.
**The run reports six 3% axes and delivers about 1.2% of portfolio-level equity
uncertainty, and gets narrower the more wrappers the equity is split across.** Which
wrapper an index fund sits in has no bearing on how uncertain the fund's return is.

Equity drift uncertainty is close to purely systematic. Six idiosyncratic draws is not a
smaller version of the right answer, it is the wrong shape.

## 6. F4 — two mechanisms, two different questions, only one on

Not duplicates; they compose:

- **Anchor uncertainty** — "what is the long-run mean return?" — the MC growth axes. One
  draw per iteration, flat for the whole run.
- **Sequence risk** — "in what order do the years arrive?" — the design 74 path
  (`equityReturnStochastic`), with a shared market factor, per-sleeve betas, idio vol.

Today `equityReturnStochastic` defaults to **false** and `equityReturnVol` sits in the MC
list as `enabled: false`. The default run measures only anchor uncertainty, in the shape
F3 describes; the mechanism with the correct correlation structure is the one that is off.

Composition hazard: with both on, the anchor axes' 3% is currently doing duty as a proxy
for *total* return uncertainty, so turning the path on without re-basing double-counts.

## 7. F5 — a per-account Growth Rate silently voids the swept axis

`perVal = ownRate ?? roleGrowthRates[role] ?? …`. The account editor exposes Growth Rate
(`acct.<stateKey>.growthRate`), and the generated param is `mc: true` — which reads as "MC
handles this", but per F1 no consumer exists and no contributor emits it.

So a user sets a Growth Rate on their brokerage; that account is now pinned. MC keeps
listing `brokerageGrowthRate` as enabled, keeps sampling it, and the sampled value reaches
nothing. The distribution narrows and the report still names the axis as a source of
uncertainty — the §4.10 failure exactly.

`tests/unit/mc-axis-liveness.test.mjs` cannot catch it: it runs the reference plan, where
every `account.growthRate` is `null`. The gate is correct; the config that breaks the axis
is one the gate never sees. **A liveness gate for a config-dependent lever has to run
against the loaded config, not a reference one.**

## 8. F6 — the schema/overlay gap, enumerated

Params declared `mc: true` that the MC panel does not offer:

| Key | Why it matters |
|---|---|
| `goldGrowthRate` | the whole gold sleeve's drift; MC-immune |
| `auFixedIncomeInterestRate` | US side has `fixedIncomeInterestRate`; AU does not |
| `auCpiRate` | drives AU CGT indexation and bracket indexation |
| `fxVolatility`, `fxReversionSpeed` | the FX process (design 92) |
| `usFederalBracketIndexSpread`, `usStateBracketIndexSpread`, `auBracketIndexSpread`, `usFeieCapIndexSpread`, `usFicaWageBaseIndexSpread` | fiscal-drag axes |
| `residencyState` | Enum — no categorical distribution exists; opt-only by design |

Plus every generated per-record `mc: true` param — `acct.*.growthRate`,
`acct.*.dividendRate`, `prop.*.appreciationRate`, `prop.*.value`, `person.*.monthlyWage`
— which no contributor emits. The precedent that they *could* be emitted already exists:
the balance axes are hand-aliased to `acct.<stateKey>.balanceTarget` through
`INTL_RETIREMENT_PARAM_ALIASES` (`intl-retirement-scenario.js:1073`).

Two consequences worth naming separately:

- **Property appreciation is not sweepable per property.** `buildRealPropertyMcConfigs`
  emits sale *years* only. The only housing-return axis is `propertyReturnIdioScale`,
  `enabled: false` and inert unless `propertyReturnStochastic` is on. On a plan where a
  house sale funds retirement, the house's appreciation rate is a fixed input.
- **Nothing at the security or holding level is sweepable**, so the design 94 per-security
  overlay and per-holding `rateKey` are single-run-only levers.

The Opt list has the same structure and the same dead-flag problem; its gap set differs
(it is richer in strategy/timing axes and thinner in rates) but the mechanism is identical.

---

## 9. What to change

Two independent tracks: a **wiring** track (§9.1–§9.2, no numeric effect, applies to MC
and Opt equally) and a **modelling** track (§9.3–§9.4, re-bases results, MC-specific).
They should not land in one commit.

### 9.1 Wiring — the schema declares the surface, the overlay supplies sweep metadata

Add a shared harvest step in `param-schema-utils.js`, beside `resolveSweepVariables`,
used by both `buildVariables` (MC) and `buildOptVariables` (Opt):

- a schema entry flagged for that engine (`mc: true` / `opt: true`) with **no** overlay
  entry appears **disabled**, centered on its scenario value, with a by-type default
  spread/range — discoverable, inert until the user enables it;
- an overlay entry whose `paramKey` has **no** schema entry is a **build-time error**, not
  a `console.warn` — that is the §4.10 class of bug, and the current code warns and
  continues (`intl-retirement-mc-config.js` `buildVariables`);
- generated per-record keys come along for free, which is what puts `acct.*.growthRate`
  and `prop.*.appreciationRate` in the panels;
- the existing hand-written arrays shrink to what they should always have been: *curated
  sweep metadata for the axes worth enabling by default*, not the membership list.

Deliberately kept: the dynamic contributors (per-shock, per-bequest, per-expense-band
rows). Those synthesize keys the schema genuinely does not have, and
`resolveSweepVariables` already handles them as orphans.

**Engine-specific defaults differ, and should.** MC can afford "everything declared,
disabled" because a disabled axis costs nothing. Opt cannot be so casual — each dimension
costs CEM budget — but the same harvest still applies, because the cost is in *enabling*,
not in *listing*. That answers open question 3 from the first draft: same mechanism, same
build-time error, different default posture.

### 9.2 Wiring — panels, and making shadowing visible

**Panel.** `McConfigPanel` and `OptConfigPanel` are already near-identical (both
`setVariables(vars)`, both build a `Map` of group → configs, both emit a group header).
With the harvest they get ~40 more rows each and need the parameters panel's treatment,
which is the right precedent and is already written: `scenario-tab-view.js:75-82` and
`_renderParamsList` give live substring filter + per-group collapse, groups collapsed by
default, `_expandedGroups` as the expand state, and an active filter force-expanding
matches (`:330`). Factor that into a shared sweep-variable panel base rather than
duplicating it a third and fourth time.

**Shadowing.** Wherever an enabled axis can be voided by a higher-precedence value in the
loaded config (F5), the panel should say so. The machinery is already there: the MC panel
tracks `centerSource` and `centerDiverges` per row. A `shadowedBy` tag on a row whose
value cannot reach the sim is the same idea one level down. Minimum viable version: warn
at run time when an enabled axis is a role rate and any account of that role carries a
non-null `growthRate`.

### 9.3 Modelling — one equity anchor axis, not six

*(This is the answer to "simplify it down if you can keep the value/control".)*

**Retire the six wrapper growth rates as MC axes. Add one.**

They stay fully editable params, and stay Opt axes if wanted — that is what "editable-only
input" meant, and it is worth stating plainly: *a param can be something the user sets
without being something the engine sweeps.* The wrapper rates are a statement about how
each account is invested. That is a **plan input**, not an uncertainty. Nobody's Roth and
brokerage differ by an amount that is itself random.

What is random is the market they all ride. So:

1. Declare the four market growth params (§4), closing F2 and giving design 90 §7.4 its
   levels.
2. Add one param `equityAnchorShift` (default `0`) and apply it at the §2 choke point:

   ```js
   perVal = (ownRate ?? roleGrowthRates[acct.role] ?? baseMap[memberKey]) + equityAnchorShift;
   ```

   applied for equity member keys only — not interest keys (Prime is its own axis), not
   property, not gold.
3. Make `equityAnchorShift` the single MC equity axis, `NORMAL`, mean `0`.

**Why the shift goes at the choke point and not on the market params.** Sweeping
`usEquityGrowthRate` directly would reach almost nothing: `seedPerAccountRates` overrides
the market rate per account for every account of a known role (§4). The shift has to be
applied where the per-account value is computed, or it is a fifth dead axis.

What this buys, concretely: 6 sampling dimensions → 1; the correlation structure becomes
correct (one systematic draw, wrappers keeping their authored spreads as offsets); the
measured dispersion stops depending on how many wrappers the household happens to have;
and `equityAnchorShift` centers honestly at 0, so the `centerSource` provenance machinery
reports `scenario` rather than a synthetic default.

What it costs: you can no longer sweep one wrapper alone. That is the intended loss —
sweeping one wrapper alone is the thing that produced F3. Genuine per-market dispersion
is design 90 §7.3/§7.4's job (a mix of market sleeves with real idio vol), not six
independent wrapper draws standing in for it.

### 9.4 Modelling — decide what the 3% means

Once §9.3 lands and the design 74 path becomes a realistic default, the anchor's `stdDev`
is no longer "return uncertainty" — it is *estimation* uncertainty about the mean, and
should be smaller. Pick one interpretation, write it into the param descriptions, and
re-base. Otherwise MC double-counts for as long as both mechanisms are on.

---

## 10. Sequencing

| # | Step | Scope | Re-golds? |
|---|---|---|---|
| 1 | Declare the four market growth params (§9.3.1) | shared | No — defaults are the current constants |
| 2 | Shared schema harvest + build-time error on orphan overlay entries (§9.1) | MC + Opt | No — new rows land disabled |
| 3 | Shared panel base: filter + collapsible groups, per `scenario-tab-view` (§9.2) | MC + Opt | No |
| 4 | `shadowedBy` / run-time shadowing warning (§9.2) | MC + Opt | No |
| 5 | `equityAnchorShift`; retire the six wrapper MC axes (§9.3) | MC | **Yes**, and re-bases every MC result |
| 6 | Re-base the anchor `stdDev` against the path model (§9.4) | MC | **Yes** |

Steps 1–4 are exposure fixes with no numeric effect and are worth doing regardless of
5–6. Step 5 changes what every past MC run meant and overlaps design 90 §7.4 — do them
together or not at all. Step 5 wants a before/after on terminal-NW dispersion for the
reference plan; the expected direction is **wider**, by roughly the √6 the current
independence throws away.

## 11. Open questions

1. Should the wrapper rates remain **Opt** axes after §9.3? Optimizing "what return does
   my Roth earn" is not a decision anyone can act on, so probably not — but unlike the MC
   case there is no correctness argument, only a budget one.
2. Does §9.1's harvest want a third flag, or is `mc:`/`opt:` enough? A param that should
   be *listed* but never *enabled by default* is expressible today only by omitting it
   from the curated array, which is the state we are trying to leave.
3. Step 5 assumes the wrapper spreads (Roth 7% vs brokerage 5%) are deliberate. If they
   are actually stale defaults nobody set, the shift is being applied to noise, and the
   right first move is to re-derive them from the accounts' real allocations.
