# 116 — Employment spells: more than one job per person

**Status:** IN PROGRESS, 3 Oct 2026. Phase 1 (engine) BUILT — see §11. Decisions in §3 were
taken with the author; Q1 and Q3 are answered (D6, D7) and Q2 is open with one constraint (§10).
D6 (Social Security decoupled from work) moved to design 118 as its phase 1, 2 Oct 2026:
the claim age it defers to cannot be defined while `retirementDate` also gates payment.
Phase 4's date sweeps needed the optimizer to gain a Date variable type. Design 117 phase 1
built it (2 Oct 2026): `OPT_PARAM_TYPES.DATE`, plus NORMAL_DATE and UNIFORM_DATE for MC.

## 1. The ask

Simulate different salaries or jobs for one person over the course of a scenario: a raise,
a pay cut, a gap between jobs, part-time work before retirement, and in particular a US job
followed by an Australian one after a move.

## 2. What the code does today (audited 2 Oct 2026)

A Person carries exactly one job for the whole run:

- **The fields.** `monthlyWage`, `wageCurrency`, `workCountry`, `selfEmployed` and
  `retirementDate` sit on the Person (`src/finance/person.js`). `projectPerson`
  (`src/finance/state/person-projection.js`) copies them into `state.people[id]`.
- **Who is paid.** `isEarning()` (`payroll-handler.js`) checks that the wage is above 0 and
  the date is before `retirementDate`. Its doc comment calls it "the single definition", but
  `us-income-classes.js` (~line 341) has a second copy, and that file also picks the
  household's higher earner by comparing `monthlyWage` (~line 385).
- **Inflation.** `InflationAdjustReducer` multiplies each person's `monthlyWage` in place, once
  a year, on `US_PERIOD_ADVANCE`. The rate is the inflation rate of the *wage currency's*
  country (design 50), so an AUD wage tracks AU CPI from the start of the run, even before
  any AU period exists. There is no real wage growth.
- **`retirementDate` means more than "wages stop".** Beyond payroll it is read by the Social
  Security handler (benefits start there), the US and AU retirement toolsets at compile, the
  Roth conversion toolset's default start year, and the spending registry's age anchor.
- **Sweeps.** `person.<id>.monthlyWage` is a generated per-record key (MC + optimizer), one
  number for the whole run. `retirementDate` is not sweepable, because the optimizer has no
  Date type.

So none of the cases in §1 can be modelled. The cross-border one cannot be faked either,
because `wageCurrency` gates which payroll stream (US or AU) a person's elections reach.

## 3. Decisions (taken with the author, 2 Oct 2026)

| # | Question | Decision |
|---|---|---|
| D1 | Shape | A person has an ordered list of **spells**, each a job with its own wage, currency, work country and employer terms. Not a wage-only schedule. |
| D2 | How the wage moves | Each spell's **base** wage (in sim-start money) is kept, with an **inflation index in state**. The wage on a date is computed from those when it is needed. No dated `EMPLOYMENT_CHANGE` event. |
| D3 | Overlapping spells | **Rejected** by the loader in this design (§5.4). Two concurrent jobs bring per-employer rules (§9) that are out of scope. |
| D4 | Sweeps | Wage, real growth and dates are all sweepable. Dates depend on the optimizer's Date type, which lands first. |
| D5 | Stochastic job loss / career shocks in MC; career change as an MPC lever | **Later.** Not in this design. |
| D6 | When Social Security starts (was Q1) | **At the claiming age only.** The work end date no longer gates benefits, for any person, with or without spells (§5.1a). |
| D7 | Real growth (was Q3) | **Per spell.** `realGrowth` lives on the spell and compounds from that spell's start. No career-long rate on the Person. |

**Why D2 and not an event.** An event at each spell boundary would need:

- its own event type per irregular date, since EventSeries dedupes series by type;
- an explicit order slot against payroll on the same day, because the queue is FIFO only
  within one `(date, order)` band;
- a declaration in the derivation manifest, or MPC rollouts silently lose it.

A resolver that reads state has none of those failure modes.

## 4. Design

### 4.1 The record

A new cfg record type, `job`, one row per spell, joined to its person by `personId`. It is a
flat table, not a list nested inside the Person.

| field | type | notes |
|---|---|---|
| `id` | text | Stable id; the sweep key is built from it (§6). |
| `personId` | select | The person this spell belongs to. |
| `startDate` | date | Inclusive. Empty means from the start of the run. |
| `endDate` | date | Exclusive, matching how `retirementDate` is read today. Empty means open-ended (until death). |
| `monthlyWage` | money | Gross per month, in **sim-start money** (the same convention as `socialSecurityMonthly`). Inflation applies on top (§4.3). |
| `realGrowth` | percent | Optional annual raise above inflation while the spell is in force. Default 0. |
| `wageCurrency` | select | Moves from the Person to the spell. |
| `workCountry` | select | Moves from the Person to the spell. Empty means "where they live", as today. |
| `selfEmployed` | checkbox | Moves from the Person to the spell. |
| employer terms | — | Phase 3 (§8): `k401EmployerMatchPct`, `k401MatchTiers`, `k401NonElectivePct`, `superGuaranteePct`. Empty inherits the Person's value, then the household default. The *employee's* elections (deferral %, salary sacrifice, IRA, Roth, personal super contributions) stay on the Person. |

**Why sim-start money rather than nominal-at-start.** A spell starting in 2035 is authored the
way a person thinks about it ("a job paying what X pays today"). It also stays correct when
an inflation sweep changes the path to 2035. Nominal-at-start would silently mean a different
real salary under every inflation draw.

### 4.2 Legacy people: no spells means the run is unchanged

A person with no `job` rows keeps today's code path exactly:

- `projectPerson` projects the flat fields as now and adds **nothing** to state.
- The resolver (§4.4) builds a one-spell view from those flat fields on the fly, ending at
  `retirementDate`.
- `InflationAdjustReducer` keeps multiplying `state.people[id].monthlyWage` in place.

Every existing golden is therefore byte-identical, both in state shape and in arithmetic.
Routing legacy people through the base × index form of §4.3 instead would not be:
`w·f₁·f₂·…` and `w·(f₁·f₂·…)` differ in the last bits, and the whole-state goldens are
exact-match.

### 4.3 State for a person with spells

```
state.people[id].spells = [{ id, startMs, endMs, baseMonthlyWage, realGrowth,
                              wageCurrency, workCountry, selfEmployed, ...employerTerms }]
state.wageIndex = { US, AU }   // written only when some person has spells
```

- `spells` is sorted by `start` and projected **complete**. `_mergeStatePatches` replaces a
  person's whole entry, so a partial projection would delete fields (the trap
  `person-projection.js` already documents).
- `state.wageIndex[cc]` starts at 1 and is advanced by `InflationAdjustReducer` on
  `US_PERIOD_ADVANCE` at the same `rateFor(cc)` it uses for wages today.

`startMs`/`endMs` are epoch ms (the `ssEntitledMs` convention). An empty `startDate` is
projected as the run's start, which is also the anchor `realGrowth` compounds from.

**Why a new index and not `inflationAccumulator`.** `inflationAccumulator.AU` advances only on
`AU_PERIOD_ADVANCE`, and the AU period only starts at a move. Today an AUD wage inflates from
the start of the run. Reusing the accumulator would leave a spell's AUD wage flat until the
move, which disagrees with legacy people in the same run.

`state.people[id].monthlyWage` (and the other flat job fields) are **not** projected for a
person with spells, so no reader can quietly fall back to stale values (§4.5 audits the
readers).

### 4.4 The resolver: `employment.js` (a leaf module)

```
spellAt(person, date)       → the in-force spell view, or null
wageAt(person, date, state) → nominal monthly wage, 0 when no spell is in force
everEarns(person)           → any spell with a wage > 0 (compile-time gating)
lastWorkDate(person)        → the end of the last spell (null if open-ended)
```

- For a person **with** spells, the wage is
  `baseMonthlyWage × wageIndex[cc(wageCurrency)] × (1 + realGrowth)^n`, where `n` is the
  number of whole years since the spell's `start`. Before the first year boundary that factor
  is exactly 1.
- For a person **without** spells, `spellAt` returns a view over the flat fields and `wageAt`
  returns `state.people[id].monthlyWage` unchanged (§4.2).

The module imports nothing, so that `lever-schedule.js` (design 81 §16.5, leaf imports only) can
use it if D5's MPC lever is ever built.

### 4.5 Readers that move onto the resolver

| reader | today | after |
|---|---|---|
| `isEarning` (`payroll-handler.js`) | `monthlyWage > 0 && date < retirementDate` | `wageAt(...) > 0` |
| `computePayroll` | reads `monthlyWage`, `wageCurrency`, `workCountry`, `selfEmployed` from the person | reads them from `spellAt(person, date)` |
| `us-income-classes.js` ~341 | a second copy of `isEarning` | deleted; uses the resolver |
| `us-income-classes.js` ~385 | higher earner by `monthlyWage` | by `wageAt` on the date |
| `hasPayrollContributions` | `monthlyWage > 0` on cfg people | `everEarns`. A person whose spells include both a USD and an AUD job must schedule **both** the US and the AU payroll streams. |
| `InflationAdjustReducer` | multiplies `monthlyWage` | unchanged for legacy people; advances `wageIndex` when any person has spells |
| `MonthlySocialSecurityHandler` | `age ≥ minAge` **and** `date ≥ retirementDate` | `age ≥ minAge` only (D6, §5.1a) |
| other `retirementDate` readers (both retirement toolsets, Roth default, spending anchor) | the authored field | `lastWorkDate(person)` when spells exist |

The build starts with a fresh grep for `monthlyWage`, `wageCurrency`, `workCountry`,
`selfEmployed` and `retirementDate` across `src/`. This table records the audit on 2 Oct and
will go stale.

### 4.6 Validation (loader)

The loader errors (not warns: an inert spell is a silent wrong answer) on:

- overlapping spells for one person (D3);
- `endDate ≤ startDate`;
- a `personId` that names no person.

Gaps between spells are legal: they are unemployment.

## 5. Interactions

### 5.1 `retirementDate` when spells exist

The editor locks the Person's Retire Date field and shows the derived `lastWorkDate`, so there
is one source of truth. An open-ended last spell means "works until death": no work end date,
the same as an empty `retirementDate` today.

### 5.1a Social Security is decoupled from work (D6)

**Moved to design 118 phase 1** (`118-social-security-claiming.md` §5.1, D4). The text below
stays as the record of the decision; design 118 builds it.

Today `MonthlySocialSecurityHandler` pays a benefit only when the person is at least the rules'
`minAge` (67) **and** past `retirementDate`, so someone who works past 67 has their benefit
deferred until they stop. D6 removes the second test: benefits start at the claiming age
whether or not the person is still working. This matches the law once full retirement age is
reached, since the retirement earnings test stops applying at FRA.

Two things to know when building it:

- **"Claiming age" is the rules' `minAge` today.** `primarySsClaimAge` is authored but read by
  nothing (TODO #292), so the claiming age is effectively FRA. Wiring that param in is TODO
  #292's job, not this design's; D6 only removes the work-end gate.
- **It changes existing results.** Any scenario where a person's `retirementDate` is after
  their claiming age gains benefits for the overlap years. It ships as its **own commit at the
  start of phase 1**, separate from the spells engine. Regold only after reading the diff, and
  confirm that every changed golden has a person working past 67 and that nothing else moved.
  The spells engine then lands against those goldens, byte-identical.

### 5.2 Cross-border

A US→AU move plus an AUD spell starting at the move is the motivating case. Payroll routing,
the 401(k) gate (by `wageCurrency`) and the source of income (by `workCountry`) all move with
the spell, because they are now spell fields. Residency still comes from the scenario's
residency params; a spell does not move anyone.

### 5.3 Real vs nominal display (design 79)

Unaffected. Wages are nominal in state, as now, and are deflated for display by the existing
per-row fold.

## 6. Sweeps (D4)

- **Prefix.** A new generated namespace, `job.`, added to `GENERATED_KEY_PREFIXES`. Without it,
  `set()` drops the dotted key and the lever is inert in a real solve while passing every
  hand-written flat-bag test (design 98 W0).
- **Templates** (`record-param-templates.js`, a new `JOB_PARAM_TEMPLATE`):

  | field | mc | opt | note |
  |---|---|---|---|
  | `monthlyWage` | ✓ | ✓ | |
  | `realGrowth` | ✓ | ✓ | |
  | `startDate`, `endDate` | — | ✓ | Waits for the optimizer's Date type. `mc` stays off until the MC sampler has a Date distribution; that is the author's call when Date support lands. |
  | employer terms | — | — | Employer-set, not household choices (design 98 W2), matching the Person template. |

- **Harvest.** MC centers come from the loaded `job` records through `resolveRecordCenters`,
  the same path person and account records use.
- **Sweeping a date must respect D3.** An optimizer draw that moves `endDate` past the next
  spell's `startDate` creates an overlap. How to prevent that is Q2 (§10), still open.
- **Proof of liveness on a loaded cfg.** Every new lever gets a test that loads a scenario
  through `ScenarioLoader`, sets the generated key, and asserts the *effect* (a wage credit
  changes). A flat-bag test is not enough: earlier levers were dead behind toolset
  forwarding, legacy aliases or a zero base, and only a loaded config found them.

## 7. Authoring surface

- **People panel.** A Jobs table under each person, built from `row-list-editor`
  (start · end · wage · growth · currency · work country · self-employed). No JSON textarea.
- **Migration.** An "Add job" action on a person with no spells seeds the first row from the
  flat fields, then clears them. Nothing migrates automatically on load; a legacy scenario
  stays legacy until the author converts it.
- **Help.** A new `kind: node` topic, `help/nodes/job.md`. The gate fails on any undocumented
  control (design 111). Run `npm run help:build` to regenerate `REFERENCE.md`, then
  `help:restamp` for the `person` topic, because Wage, Currency, Work Country, Self-employed
  and Retire Date change meaning when spells exist.

## 8. Phasing

1. **Engine.** `job` record type + loader validation, `employment.js` resolver, `wageIndex`,
   the reader moves in §4.5, serializer round trip. D6's Social Security commit (§5.1a) is
   design 118 phase 1 and lands before this. Tests: goldens byte-identical with no spells; a
   two-spell US→AU person pays from the right stream on each side of the boundary; a gap pays
   nothing; `realGrowth` compounds on whole years from each spell's own start; a person working
   past 67 draws a benefit and a wage in the same month.
2. **Editor + help.** Jobs table, migration action, `help/nodes/job.md`, REFERENCE regen.
3. **Employer terms per spell.** Match, tiers, non-elective, Super Guarantee, with the
   inheritance chain spell → person → household.
4. **Sweeps.** `job.` prefix, `JOB_PARAM_TEMPLATE`, harvest, liveness tests on a loaded cfg.
   Dates once the optimizer's Date type is in.
5. **Later (D5).** MC job loss / career shocks; career change as an MPC lever.

## 9. Out of scope: concurrent jobs (D3)

Recorded so a later design starts from the list:

- **FICA.** Each employer withholds Social Security up to the wage base, and the excess is a
  credit on the return (§31(b)). With D3 a mid-year job change is modelled as one cumulative
  base per person: the tax is right, but the cash timing of the over-withholding refund is
  not modelled. **Confirmed in phase 1:** `computePayroll` withholds against
  `state.usSsWagesByPersonYTD[personKey]`, a per-PERSON running total, so a second job in
  the same year continues from the first job's base rather than restarting at 0.
- **401(k) limits.** §402(g) applies per person, as now. §415(c) applies per employer, and
  the model's per-person cap is conservative for someone who changes employer mid-year.
- **Super Guarantee.** The s10A maximum contributions base applies per employer per quarter.
  A mid-quarter job change gives the person two bases. Phase 3 has to handle this even
  without overlap, because two sequential spells can share a quarter.

## 10. Open questions

- **Q1 — answered: D6.** Social Security starts at the claiming age only (§5.1a).
- **Q2 — open.** How spell dates are swept without creating an overlap. One constraint is
  decided: the sweep must **not duplicate date ranges**. Two adjacent spells must not each
  carry their own range for the boundary they share, since that is two variables for one fact
  and most draws of the pair would be invalid. Clamping versus rejecting a candidate, and how
  a boundary is named as a sweep variable, are still to decide. This blocks only phase 4's date
  sweeps.
- **Q3 — answered: D7.** Real growth is per spell.

## 11. Build log

### Phase 1 — engine (3 Oct 2026)

- **Storage.** `cfg.jobs` is plain authored scenario data, like `cfg.securities` and
  `cfg.corporateActions`: one store, no service copy. `serializeScenario` emits it only when
  non-empty, so a scenario without jobs round-trips byte-for-byte. The compiler resolves it
  once into `context.spellsByPerson` (`buildSpellsByPerson`), which the three people
  projections and the compile-time readers share.
- **Resolver.** `src/finance/payroll/employment.js`, a leaf (no imports): `spellAt`,
  `wageAt`, `earnerView`, `everEarns`, `lastWorkDate`, `buildSpells`, `validateJobs`. Each
  takes either a state person (which carries `spells`) or a Person plus `spellsByPerson`.
  `earnerView` returns a legacy earner as the SAME object, which is why the payroll pipeline
  is byte-identical without a second code path.
- **Validation.** `ScenarioLoader.load` throws before deserializing anything on an overlap,
  `endDate ≤ startDate`, an unparseable date, a duplicate job id, or an orphan `personId`.
- **Readers moved** (§4.5): `computePayroll` (via `earnerView`), the bonus earner in
  `us-income-classes.js` (its private `_isEarning` copy deleted; a legacy person is still
  ranked by flat wage when nobody is working, so that fallback is unchanged),
  `hasPayrollContributions` (4th arg `spellsByPerson`), `InflationAdjustReducer` (skips
  `monthlyWage` for a spell person; advances `state.wageIndex` only when one exists), the
  guardrail `RETIREMENT_DATE_REACHED` schedules, the Roth window default, the age-band anchor,
  and the paycheque report (currency and SE flag from the wage action's type). The Social
  Security row was design 118's.
- **401(k) rollover separation** is the end of the last **USD** spell, not of the last spell:
  a US→AU mover separates from the 401(k) sponsor at the move. A person whose jobs include no
  USD spell has separated at the run's start.
- **Display.** `registerSpells` stamps each spell's base wage in its own currency;
  `wageIndex.*` is a decimal.
- **Tests.** `tests/unit/evt-employment-spells.test.mjs` (ESP-1..11). Every golden is
  byte-identical (7445 unit tests green).
