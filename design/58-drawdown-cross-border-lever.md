# 58 — Drawdown control levers: cross-border mode, orderable priority, and pooled-tier draws

**Status**: **COMPLETE — ALL PHASES IMPLEMENTED** (2026-07-12). Levers A, B and C plus
all three MPC online controls (`DRAWDOWN_XBORDER`, `DRAWDOWN_WITHINTIER`,
`DRAWDOWN_WEIGHTS`) are done; see §10/§11 for the per-phase record. Originally
**PROPOSED** (2026-07-12) — the header was not updated as the phases landed and still
read "No code yet" until 2026-07-29. Scope: turn the account
drawdown decision into a set of **explicit, composable, optimizable levers**. The
same decision has three orthogonal dimensions the model conflates today:

1. **Where** — which country's accounts are eligible first (`LOCAL_FIRST` vs
   `GLOBAL`). *(Lever A — ✅ implemented.)*
2. **What order** — the priority accounts drain in, and making that order a
   **search space** the optimizer can tune (not just a pick-from-a-fixed-menu).
   *(Lever B — ✅ implemented.)*
3. **How within a tier** — when several accounts share a tier (e.g. two Roths),
   draw them **one-at-a-time, equally, or proportionally by balance** rather than
   always draining one dry first. *(Lever C — the "draw both Roths together" ask;
   ✅ implemented.)*

Levers A/B/C are independent and compose (§5). Phase 1 (Lever A) satisfies the
immediate "let `CUSTOM` honor my account order across the border" request.

---

## 1. Motivation

A `moveYear` optimization surfaced a genuine but non-obvious result: maximizing
final net worth prefers an **earlier** US→AU move, while minimizing lifetime tax
prefers a **later** one. Investigation (headless sweep of the reference scenario)
showed this is **not a contradiction and not a bug** — every move year funds the
*same* real consumption (~\$6.17M) with zero deficit; the entire net-worth swing
lives in the tax-free **Roth**, which is drawn *last*. Moving to AU sooner flips
the drawdown order so AU-side and US-taxable accounts drain first (realizing
taxable gains → more tax now), sheltering the Roth to compound into a large
bequest. See [[residency-drives-drawdown-sequencing]] and the deeper move-vs-no-move
analysis in `design/36-au-move-tax-effect-analysis.md`.

The lesson: **drawdown ordering is one of the highest-leverage decisions in the
plan**, yet its controls are implicit, partly welded to unrelated switches, and
not directly optimizable. This design makes them first-class.

---

## 2. What exists today

**Cross-border mode.** `AccountService.replenishSavings` reads
`state.crossBorderDrawdown` (`account-service.js` ~line 498, filter ~line 528):

```text
const globalDrawdown = state.crossBorderDrawdown === 'GLOBAL';
… (globalDrawdown || v.country === country || isCashRole(v))
```

- `LOCAL_FIRST` (default): only same-country investment accounts are sources; the
  other country is reached only via `INTL_TRANSFER` as a last resort.
- `GLOBAL`: accounts in *either* country compete in one `drawdownPriority` order,
  converting AUD↔USD per draw (`fxOf`/`feeOf`, flat per-transfer fee).
- Cash is liquid in both modes (`isCashRole` bypasses the gate) — `GLOBAL` only
  changes *investment* sequencing.

It is set **implicitly**, welded to a strategy name (`us-retirement-toolset.js`
~line 407):

```text
crossBorderDrawdown: p.drawdownStrategy === 'TAX_EFFICIENT' ? 'GLOBAL' : 'LOCAL_FIRST',
```

**Order (priority).** `DRAWDOWN_STRATEGIES` (`intl-retirement-scenario.js`) maps
`role → rank`; the `accountPriority` node cascade turns the selected strategy into
each account's `drawdownPriority` (`base(role) + ownerRank × ownerStride`).
`CUSTOM: null` ⇒ cascade no-op ⇒ authored per-account `drawdownPriority` stands.
`replenishSavings` sorts sources by `drawdownPriority` and, in the default
`ORDERED` path, **drains each fully before the next**.

**Owner banding (design 35).** `drawdownOwnerOrdering` = `PRIMARY_FIRST` /
`SPOUSE_FIRST` / `POOLED`. `POOLED` sets `ownerStride: 0`, so same-role accounts
across owners collapse into **one tier** (same `drawdownPriority`). But the
`ORDERED` draw still walks that tier sequentially (tie broken by iteration order),
so "both Roths at once" does **not** happen yet.

**Global proportional mode.** `state.drawdownMode === 'PROPORTIONAL'` splits each
pass pro-rata across **all** penalty-free sources at once (`account-service.js`
~line 584). It is *global*, not tier-scoped — it ignores priority entirely — so it
can't express "taxable first, then split the two Roths." Set by
`drawdownStrategy === 'PROPORTIONAL'`.

**Optimizer.** `drawdownStrategy` is a categorical ENUM lever
(`intl-retirement-opt-config.js` ~line 180); the sweep values are the built-in
strategy names **plus any user-authored `customDrawdownStrategies` names**
(~line 404). So the optimizer can only **pick among pre-authored orderings** — it
cannot *search* the ordering space itself.

---

## 3. The gaps

| Want | Reachable today? | Blocked by |
|---|---|---|
| Global order from a *hand-authored* per-account order (`CUSTOM` + `GLOBAL`) | ❌ | mode welded to `TAX_EFFICIENT` (Lever A) |
| Any role strategy, but global (e.g. `TAXABLE_FIRST` + `GLOBAL`) | ❌ | same weld (Lever A) |
| Optimizer **searches** the drawdown order (not just picks a preset) | ❌ | ordering is a categorical ENUM, not a tunable axis (Lever B) |
| Draw two same-type accounts (2 Roths) **together**, equal or by balance | ❌ | `ORDERED` drains one tier member fully first; global `PROPORTIONAL` isn't tier-scoped (Lever C) |

---

## 4. The three levers

### Lever A — Cross-border mode as a standalone parameter *(Phase 1, ready)*

Promote `crossBorderDrawdown` to a scenario parameter (design-55 config-driven).
**Decision (locked, OQ1): a three-value enum with an explicit `AUTO` default** that
keeps the legacy `TAX_EFFICIENT`→`GLOBAL` coupling, so nothing existing moves and
the coupling stays discoverable rather than hidden behind a `null`:

```text
key: 'crossBorderDrawdown', type: 'Enum', options: ['AUTO','LOCAL_FIRST','GLOBAL'],
group: 'Spending', defaultValue: 'AUTO'
label: 'Cross-Border Drawdown'
```

Resolve in `us-retirement-toolset.js` `state()`. `AUTO` (and any unknown value)
falls through to the legacy coupling; `LOCAL_FIRST`/`GLOBAL` override it:

```text
crossBorderDrawdown:
  (p.crossBorderDrawdown === 'LOCAL_FIRST' || p.crossBorderDrawdown === 'GLOBAL')
    ? p.crossBorderDrawdown
    : (p.drawdownStrategy === 'TAX_EFFICIENT' ? 'GLOBAL' : 'LOCAL_FIRST'),  // AUTO
```

- Existing scenarios (key absent ⇒ `AUTO`) → **byte-identical**; `TAX_EFFICIENT`
  still ⇒ `GLOBAL`.
- `crossBorderDrawdown: 'GLOBAL'` + `drawdownStrategy: 'CUSTOM'` ⇒ authored
  per-account `drawdownPriority` honored **across both countries** — the immediate
  ask (§6). No new reducer: the mode stays a compile-time state field
  `replenishSavings` already reads. Bad string → treat as unset.

Add an ENUM axis to `intl-retirement-opt-config.js` (`enabled:false`) so the
optimizer can sweep `{LOCAL_FIRST, GLOBAL} × strategy`.

### Lever B — An *optimize-the-order* mode (role-weight search)

Today the optimizer can only choose among named strategies (fixed `role→rank`
maps) or names the user pre-authored — a categorical pick from a fixed menu. It
cannot *discover* a new order, because a solver can only tune numeric knobs, not
invent a category. Lever B is a true **optimize mode**: encode "an order" as
per-role numbers whose sort *is* the order, and let the solver search them.

**Decision (locked, OQ2): a per-role weight vector, sorted.** Each drawdown-eligible
role gets a continuous weight; the drawdown order is the ascending sort of the
weights. Each named strategy is just one setting of these weights, so they become
**warm-starts**. The search is small (~8 roles), smooth (CEM / pattern-search / SA
handle it directly), and **stable across account edits** (roles, not account ids).

```text
paramKey: 'drawdownWeight.<role>'   // e.g. drawdownWeight.roth, drawdownWeight.us-stock, …
type:     CONTINUOUS   min: 0  max: 1
```

- Consumed by the existing `accountPriority` cascade: the weight vector *is* a
  synthesized strategy (`role → rank = sort index`). Reuse the cascade — no change
  to `replenishSavings`.
- **Same-role siblings (e.g. two Roths) get the same weight → one tier → split by
  Lever C.** The optimizer chooses the *tier* order; pooling chooses how a tier of
  siblings is drawn. This is the clean division of labor from OQ2.
- The named `DRAWDOWN_STRATEGIES` are **presets / warm-starts** (seed the solver
  from `TAXABLE_FIRST`, etc.). `CUSTOM` remains the per-account manual escape hatch
  for hand-authoring individual accounts — it is **not** an optimizer axis.
- Cross-border (Lever A) and owner banding (design 35) compose unchanged — the
  weight vector sets base role rank; owner stride and the country gate apply on top.

*Not built (OQ2):* a per-account optimize mode (one tunable rank per account, so
the solver could order sibling Roths against each other). Rejected as the default —
the lever set would change with every account edit and the search space is larger.
It remains a possible later power-user add.

### Lever C — Within-tier draw policy (pooled / split same-type draws) *(planned)*

When ≥2 eligible accounts share a drawdown tier (equal effective
`drawdownPriority` — e.g. two Roths under `POOLED`, or two roles tied by Lever B),
choose how the tier is split:

```
key: 'withinTierDraw', type: 'Enum',
options: ['SEQUENTIAL', 'EQUAL', 'PROPORTIONAL'],  defaultValue: 'SEQUENTIAL'
```

- **`SEQUENTIAL`** — today's behavior: drain one member fully (stable tiebreak),
  then the next. Default ⇒ byte-identical.
- **`EQUAL`** — split the tier's target evenly across its members ("half the
  monthly spend from each Roth"), capped by each member's availability; residual
  from capped members redistributes to the rest (loop, like the existing
  PROPORTIONAL guard).
- **`PROPORTIONAL`** — split by each member's *available balance at draw time*
  (larger account contributes more), the more real-world-accurate default for like
  accounts and the natural model of a household drawing pro-rata across siblings.

**Implementation.** Generalize the Phase-1 draw loop in `replenishSavings`: after
sorting `sources` by `drawdownPriority`, **group by effective priority** and apply
`withinTierDraw` within each group before advancing to the next tier. Each split
leg still runs through `_drawPenaltyFree` (so per-account eligibility, penalty-free
availability, `minimumBalance` floors, and cross-border fx/fee all apply per leg).
The existing global `drawdownMode === 'PROPORTIONAL'` becomes the degenerate case
"all sources in one tier, PROPORTIONAL" — reframe it as `withinTierDraw:
'PROPORTIONAL'` with a single flat tier (keep the old switch as an alias for
back-compat).

**Scope notes.**
- Most natural for accounts with **no per-account mandate** (Roth, taxable
  brokerage). Tax-deferred RMDs (IRA/401k) are inherently per-account, so pooling
  there must still emit each account's own withdrawal-tax action (it already draws
  per-account — pooling only changes the *amount* taken from each in the tier,
  not the tax wiring).
- Composes with Lever A: a pooled tier under `GLOBAL` may span currencies → each
  split leg converts independently.
- The `withinTierDraw` policy is itself sweepable (categorical) once built.

---

## 5. How the levers compose

The three levers answer independent questions and can be set in any combination:

| Dimension | Lever | Values |
|---|---|---|
| **Where** (country eligibility) | A `crossBorderDrawdown` | `LOCAL_FIRST` or `GLOBAL` |
| **What order** (priority) | B `drawdownWeight.<role>` (+ named presets, `CUSTOM` per-account) | continuous weights / preset / manual |
| **How within a tier** (siblings) | C `withinTierDraw` | `SEQUENTIAL`, `EQUAL`, or `PROPORTIONAL` |

Example the user asked for: `drawdownStrategy: CUSTOM` (or a Lever-B search) that
ranks Roth last, `drawdownOwnerOrdering: POOLED` (both Roths in one tier),
`withinTierDraw: PROPORTIONAL` (split by balance), `crossBorderDrawdown: GLOBAL`
(honor it across the border) ⇒ "spend everything else first, then draw both Roths
together pro-rata, ignoring residence country."

---

## 6. Item 1 quick win — "force the account-defined order"

Satisfied by **Lever A (Phase 1) alone**. Set:

```
drawdownStrategy:    'CUSTOM'      // per-account drawdownPriority authoritative
crossBorderDrawdown: 'GLOBAL'      // …honored across the US↔AU border
```

and every non-cash account drains strictly by authored priority regardless of
country (cash still sweeps first by design).

---

## 7. Registration checklist

**Lever A (Phase 1):**
1. `intl-retirement-scenario.js` — `crossBorderDrawdown` in
   `INTL_RETIREMENT_DEFAULTS` (null) + `INTL_RETIREMENT_PARAM_SCHEMA` (Enum,
   Spending); forward through `buildDefaultConfig().parameters` when set.
2. `us-retirement-toolset.js` — the §4-A resolver; optionally declare in the
   toolset `paramSchema`.
3. `intl-retirement-opt-config.js` — ENUM lever, `enabled:false`. + MC categorical.
4. No `StateSchemaRegistry`/serializer change (live field round-trips via
   `initialState`); add a round-trip test.

**Lever C (Phase 2):** `withinTierDraw` param + resolver; the tier-grouping split in
`replenishSavings`; reframe global `PROPORTIONAL` as the single-tier case; OPT/MC
categorical.

**Lever B (Phase 3):** `drawdownWeight.<role>` params feeding the `accountPriority`
cascade as a synthesized strategy; CONTINUOUS axes in the opt config; solver
warm-start from the named presets; UI (advanced "tune order" panel).

---

## 8. Testing plan

- **Back-compat golden:** all three levers at their defaults ⇒
  `cross-border-relief-scenario.test.mjs` must **not move**; `TAX_EFFICIENT` still
  ⇒ `GLOBAL`; `withinTierDraw:'SEQUENTIAL'` reproduces today's per-tier drain.
- **Lever A resolver matrix:** `{unset, LOCAL_FIRST, GLOBAL} × {CUSTOM,
  TAX_EFFICIENT, TAXABLE_FIRST}`; bad string → legacy default.
- **Lever A behavioral:** a higher-priority *foreign* account is drawn before a
  local lower-priority one only under `GLOBAL` (assert order + the fx leg).
- **Lever C:** two same-type accounts in one tier — `EQUAL` splits 50/50 (residual
  redistributes when one is capped); `PROPORTIONAL` splits by balance; per-account
  `minimumBalance` and eligibility respected; the correct per-account tax actions
  fire. Global `PROPORTIONAL` alias unchanged.
- **Lever B:** a weight vector reproduces a known named strategy's order; a
  swapped weight reorders the draw; ties fall through to Lever C.
- **Serializer round-trip** for each new param.

---

## 9. Phased rollout

- **Phase 1 — Lever A ✅ DONE (2026-07-12).** `crossBorderDrawdown` scenario param
  (`AUTO`/`LOCAL_FIRST`/`GLOBAL`, default `AUTO`) + the `AUTO` resolver in
  `us-retirement-toolset.state()` + the OPT ENUM axis. Golden unchanged (3330 unit +
  864 viz green). Verified end-to-end on the reference scenario: `AUTO` ⇒
  `LOCAL_FIRST` (byte-identical); `GLOBAL + CUSTOM` now honors the authored order
  across the border (net worth 12.15M → 4.80M — the lever bites). Resolver matrix +
  schema tests in `evt-drawdown-strategy.test.mjs`.
- **Phase 2 — Lever C ✅ DONE (2026-07-12).** `withinTierDraw` scenario param
  (`SEQUENTIAL`/`EQUAL`/`PROPORTIONAL`, default `SEQUENTIAL`) + resolver in
  `us-retirement-toolset.state()` + the OPT ENUM axis. `replenishSavings`'s ORDERED
  path now groups already-sorted sources into effective-priority tiers and, for
  `EQUAL`/`PROPORTIONAL`, splits each tier's draw across its members (residual
  redistributes when a member is capped) — each leg still runs through
  `_drawPenaltyFree`, so per-account eligibility, `minimumBalance` floors,
  cross-border fx/fee, and tax actions apply per leg. `SEQUENTIAL` is byte-identical;
  the global `drawdownMode==='PROPORTIONAL'` switch is left untouched as the
  single-flat-tier alias. RMDs are event-driven (account-rules), independent of this
  deficit path, so OQ4's per-account RMD floor is unaffected. Golden unchanged (3341
  unit + 864 viz). Verified: `EQUAL` splits a tier 50/50 with residual
  redistribution, `PROPORTIONAL` by balance, tiers never reshuffle across each other;
  resolver wires end-to-end. Tests in `evt-drawdown-strategy.test.mjs`.
- **Phase 3 — Lever B ✅ DONE (2026-07-12).** `WEIGHTED` drawdown mode: per-role
  continuous `drawdownWeight.<role>` params (0–1) whose ascending sort synthesizes
  the `accountPriority` cascade's role→rank map (`_synthesizeWeightedPriorities` in
  scenario-loader), so the optimizer *searches* the order instead of picking a
  preset. `drawdownWeightsFromStrategy()` converts each named strategy into a
  warm-start weight vector; the default weights (seeded from `TAX_EFFICIENT`)
  reproduce that strategy **to the dollar** (verified). 8 CONTINUOUS OPT axes
  (`enabled:false`), gated by `visibleWhen: drawdownStrategy=WEIGHTED`. Same-role
  siblings share a weight → one tier (Lever C splits it); owner banding + Lever A
  compose unchanged. Golden unchanged (3335 unit + 864 viz). Verified end-to-end:
  `WEIGHTED` default ≡ `TAX_EFFICIENT`; a Roth-first weight vector ends ~\$48k poorer
  at moderate spend — the lever bites. Tests in `evt-drawdown-strategy.test.mjs`.
  *(Deferred: a dedicated drag-to-reorder "tune order" UI panel — the generic
  continuous-slider params render under Spending when `WEIGHTED` is selected.)*

**MPC track (parallel, see §11)** — the levers above are *static* scenario params +
*one-shot* optimizer axes. Making them *online* controls (re-decided each epoch in
the receding-horizon cockpit — the "build the optimum order over time" goal) is a
separate actuation surface, phased to shadow the levers:

- **Phase 1-MPC — Lever A online ✅ DONE (2026-07-12).** `DRAWDOWN_XBORDER`
  categorical cockpit control (`numeric:false`, ENUM `LOCAL_FIRST`/`GLOBAL`) +
  forward-effective `actuate` (state re-stamp + param persist) + the `_seededSim`
  re-stamp shim (`FORWARD_DRAWDOWN_STATE_FIELDS`, covers `crossBorderDrawdown` AND
  `withinTierDraw`, so Phase 2-MPC's projection is already wired). The plugin
  auto-lists the lever (`Object.values(COCKPIT_CONTROLS)`). Verified end-to-end: the
  grid solver searches both modes and recommends the higher-net-worth one; the
  committed mode now **bites under a snapshot-seeded rollout** where it was inert
  before (`scripts/verify-mpc-lever.mjs` GAP→PASS; guarded by
  `tests/unit/mpc-drawdown-xborder.test.mjs`). 3346 unit + 864 viz green.
- **Phase 2-MPC — Lever C online ✅ DONE (2026-07-12).** `DRAWDOWN_WITHINTIER`
  categorical control (`numeric:false`, ENUM `SEQUENTIAL`/`EQUAL`/`PROPORTIONAL`) +
  forward-effective `actuate`. The projection shim was already wired in Phase 1-MPC
  (`withinTierDraw` ∈ `FORWARD_DRAWDOWN_STATE_FIELDS`), so this was just the control
  spec + actuate + tests. Harness PASS; guarded by `mpc-drawdown-xborder.test.mjs`.
- **Phase 3-MPC — Lever B online (flagship) ✅ DONE (2026-07-12).** `DRAWDOWN_WEIGHTS`
  cockpit control: 8 CONTINUOUS weight variables (one per investment role, `::`-keyed
  so `set()` writes them flat), gated on `drawdownStrategy=WEIGHTED`. `describe` renders
  the resulting draw order; `actuate` re-stamps the live sim's per-account
  `drawdownPriority` from the committed weights via the exported
  `synthesizeWeightedPriorities` + owner banding (so advise/apply/live can't drift).
  The `_seededSim` shim captures the compile-resolved per-account priorities before
  injection and re-stamps them after. **Root-cause fix:** the weight keys were
  `drawdownWeight.<role>` (dotted), which `set()` silently drops (it never creates the
  missing `drawdownWeight` parent) — so the Lever-B axis was inert through the one-shot
  optimizer AND MPC. Switching to `::` made it bite in both (verified Δ≈\$35k). CEM
  `advise()` searches the 8-dim order and returns a full recommended order + fan.
  Harness `drawdownWeights` PASS; guarded by `mpc-drawdown-xborder.test.mjs`.

---

## 10. Open questions

1. ✅ **RESOLVED — keep the coupling via an explicit `AUTO` default.** Lever A is a
   three-value enum `AUTO`/`LOCAL_FIRST`/`GLOBAL`, default `AUTO`, where `AUTO`
   preserves the `TAX_EFFICIENT`→`GLOBAL` coupling (§4-A). Byte-identical
   back-compat; the coupling stays visible rather than hidden behind a `null`.
2. ✅ **RESOLVED — role-level optimize mode.** Lever B is a true *optimize mode*
   (the solver searches the order, not just picks a preset), searching at the
   **role** level: ~8 per-role weights, stable across account edits, small search
   space. Ordering of same-role siblings (e.g. two Roths) is delegated to Lever C
   (pooling), not to the optimizer. Per-account ordering stays available for manual
   `CUSTOM` hand-authoring but is **not** an optimizer axis (a per-account optimize
   mode is a possible later add if fine-grained sibling ordering is ever wanted).
3. ✅ **RESOLVED — Lever C defaults to `SEQUENTIAL`** (byte-identical); `EQUAL` /
   `PROPORTIONAL` are opt-in. Making `PROPORTIONAL` a realism default is a later,
   golden-moving change if wanted.
4. ✅ **RESOLVED — RMDs floor their own leg.** Pooling must never under-withdraw a
   mandated per-account RMD: within a tier, each account's mandated minimum is a
   floor on its split leg before `EQUAL`/`PROPORTIONAL` distributes the remainder.
5. ✅ **RESOLVED — names match state fields** (`crossBorderDrawdown`, `withinTierDraw`,
   and the Lever-B field TBD with its granularity) to avoid mapping layers.
6. ✅ **RESOLVED — MPC design (see §11).** (a) **Primary use = online adaptation under
   uncertainty**: MPC-B is built to re-solve the order over *stochastic* epochs
   (paired with the Monte-Carlo layers), where the realized state diverges from
   forecast and re-planning genuinely beats a fixed order — so it is evaluated/tested
   against MC paths, not just a deterministic golden. (b) **Yes — a hold-band
   switching cost**: the controller keeps the current order unless the projected gain
   clears a threshold ε (`score(new) − score(current) > ε`), so it doesn't flip-flop
   epoch-to-epoch and realize needless tax/FX churn. ε is a tunable knob (default TBD;
   calibrate so only material re-orderings fire).

---

## 11. MPC / Cockpit integration — "build the optimum order online over time"

Phases 1–3 deliver the levers as **static** scenario params and **one-shot**
optimizer axes. The end goal — the controller *re-deciding the drawdown order as
the plan unfolds* — lives in the MPC cockpit (design 39): a receding-horizon loop
(`mpc-controller.js`) that re-solves the controls at each epoch, plus a live
forward-effective "Apply" (`apply-forward.js` / SimulationSync). Phase 1 did **not**
touch this surface — hence this section.

### 11.1 The gap: snapshot injection clobbers state-resident controls

The MPC/apply-forward rollout seeds from a **now-snapshot**: `_seededSim` does
`sim.state = clone(snap.state)` to freeze the realized past. That verbatim inject
**overwrites any compile-time state field with its OLD value** — including
`crossBorderDrawdown` (Lever A), `withinTierDraw` (Lever C), and the per-account
`drawdownPriority` the Lever-B cascade bakes in. So a committed candidate is **inert
under MPC** unless a **forward-effective shim** re-applies it after injection — the
twin of the existing `repinExpensesIfChanged` / `retargetRothConversionEvents` /
`retargetEarlyWithdrawalEvents` shims in `_seededSim` (optimization-problem.js
~L312–333).

> One-shot OPT uses `initialState.kind:'compile'` (no injection), so **Phase 1's
> optimizer axis already works there** — verified. MPC uses `kind:'snapshot'`, so it
> needs the shim. This is precisely why MPC is separate work, not free.

### 11.2 The triad per online lever

1. **`COCKPIT_CONTROLS` spec** (`cockpit-controller.js`): `buildVariables(ctx)`
   returns the control's decision variables (paramKeys); `describe`/`describeRecord`
   for the recommendation + save-points log; `appliesTo`/`requirement` gating.
2. **Projection shim** in `_seededSim`: after snapshot injection, re-apply the
   committed control to `sim.state` — a scalar re-stamp for Lever A/C; re-run the
   role→`drawdownPriority` cascade on the injected accounts for Lever B.
3. **Live actuate** (`actuate({ services, scenario, candidate, vars })`): write the
   state field forward-effective on the running sim (SimulationSync) **and** persist
   the scenario param, so subsequent Advise rollouts and the live sim agree
   (mirrors the SPENDING control's three-step actuate).

### 11.3 Phasing

- **Phase 1-MPC — Lever A online ✅ DONE.** `DRAWDOWN_XBORDER` control over
  `crossBorderDrawdown` (`LOCAL_FIRST`/`GLOBAL`; categorical, `numeric:false`). The
  `_seededSim` shim captures the compile-resolved `FORWARD_DRAWDOWN_STATE_FIELDS`
  (`crossBorderDrawdown`, `withinTierDraw`) BEFORE injection and re-stamps them
  after (reading the compiled state avoids re-implementing the AUTO resolver). Live
  actuate = `sim.state = { ...sim.state, crossBorderDrawdown }` + param persist. A
  headless harness (`scripts/verify-mpc-lever.mjs`) proves the gap and the fix by
  comparing the compile vs snapshot paths.
- **Phase 2-MPC — Lever C online ✅ DONE.** `DRAWDOWN_WITHINTIER` control —
  identical scalar pattern; the `_seededSim` re-stamp already covers `withinTierDraw`
  (added alongside Phase 1-MPC), so only the control spec + actuate + tests remained.
- **Phase 3-MPC — Lever B online (flagship) ✅ DONE.** The role-weight vector as a
  multi-variable online control (`DRAWDOWN_WEIGHTS`): each epoch the controller
  re-solves the drawdown **order** from the realized state. Instead of re-running the
  full cascade, the `_seededSim` shim captures the compile-resolved per-account
  `drawdownPriority` before injection and re-stamps it after (equivalent, cheaper).
  The live `actuate` recomputes priorities from the committed weights via the exported
  `synthesizeWeightedPriorities`. The literal "optimum order online over time."
  **Note:** weight keys MUST use `::` (not `.`) — `set()` drops dotted keys whose
  parent object doesn't pre-exist, which had left the axis inert.

### 11.4 Design decisions (OQ6 — locked)

- **Target = online under uncertainty (locked).** MPC-B is designed to re-solve the
  order over **stochastic epochs** — pair it with the Monte-Carlo layers so the
  realized state at each epoch diverges from forecast and re-planning adds real value
  (on a single deterministic path it would merely re-confirm the static Lever-B
  order). Consequence: MPC-B is validated against **MC ensembles** (does the adaptive
  order beat the best fixed order across paths?), not a single deterministic golden.
- **Switching cost = hold-band hysteresis (locked).** The controller keeps the
  committed order unless the projected improvement clears a threshold:
  `score(new) − score(current) > ε`. This prevents epoch-to-epoch flip-flop
  (`GLOBAL`↔`LOCAL_FIRST`, tier reshuffles) and the tax/FX churn it would realize. ε
  is a tunable knob (its own scenario/opt param); default calibrated so only material
  re-orderings fire. Applies to the categorical Lever-A/C flips and to Lever-B order
  changes (compare the sorted role order, not raw weights, so sub-threshold weight
  drift that doesn't change the order is free).
- **Solver fit.** Lever B weights are continuous (CEM-friendly); Lever A/C are
  categorical (pattern-search-friendly). A mixed control vector is supported but
  nudges the default solver choice.
