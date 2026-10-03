# 118 — Social Security claiming: claim age, spousal and survivor benefits

**Status:** ACCEPTED, 2 Oct 2026. D1–D3 in §3 were taken with the author; D4–D11 are
proposals. **COMPLETE** 3 Oct 2026: phases 1–4 built 2 Oct (§12–§15), phase 5 (close-out) 3 Oct (§16). Resolves issue #292 (`MonthlySocialSecurityHandler` is FRA-only), and
takes over design 116's D6, Social Security decoupled from work (§5.1, D4).
Every rule below is cited to a source saved in `docs/us-social-security/` (§4).

## 1. The ask

Make the age a person claims Social Security a real decision. Claiming before full
retirement age (FRA) should reduce the benefit, and claiming after it should earn delayed
retirement credits up to 70. Include the spousal benefit, and pay survivors what the law
pays them, which depends on when the deceased claimed. Design 30's decision graph and the
optimizer both want the claim age as a lever. Today it does nothing.

## 2. What the code does today (audited 2 Oct 2026)

- **`MonthlySocialSecurityHandler`** (`src/finance/handlers/monthly-social-security-handler.js`)
  pays `socialSecurityMonthly` each month to every person who is at least `minAge` **and**
  past `retirementDate`. `minAge` is `getSsEligibilityRules()` in
  `us-account-module-2026.js`, a constant `{ minAge: 67 }`. The TODO #292 comment says so.
- **No adjustment for claim timing.** The amount paid is always `socialSecurityMonthly`
  (documented on `Person` as the benefit at FRA). There is no early-claim reduction and no
  delayed retirement credit. Someone who works to 70 starts at 70 with no credits.
- **FRA ignores birth year.** 67 is right only for people born on or after 2 Jan 1960.
- **`primarySsClaimAge` is read by nothing.** It is declared in
  `intl-retirement-scenario.js` (default 67, `opt: false`, a description admitting it is
  inert), only for the primary. Design 30's `DecisionPoint` names it as its example
  `paramKey`. Design 117 §2.3 kept it an age, not a date.
- **No spousal benefit.** A person with `socialSecurityMonthly` 0 receives nothing, whatever
  their spouse's record.
- **Survivor = `max(own, deceased)` of the FRA amounts.** `MortalityHandler` emits
  `SOCIAL_SECURITY_SURVIVOR_APPLY` carrying the deceased's `socialSecurityMonthly`, and
  `SocialSecuritySurvivorApplyReducer` **overwrites** the survivor's own
  `socialSecurityMonthly` with the larger. The deceased's claim age and the survivor's age
  are both ignored, and the survivor's own FRA amount is lost.
- **COLA.** `InflationAdjustReducer` inflates every person's `socialSecurityMonthly` at the
  US rate each year from sim start. That stands in for both wage indexing before 60 and
  COLA from 62. This design keeps it (§10).
- **Help is wrong.** `help/nodes/person.md` says "claiming age and the spousal rules live in
  the scenario parameters". Neither is modelled.

## 3. Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Claim-age resolution | **Whole years, 62–70.** A 9-value lever for the optimizer and the decision graph. The factor arithmetic is still done in months (§4), because FRA can be 66 and some months. *(Author, 2 Oct.)* |
| D2 | Spousal benefit | **In scope** (§5.4). *(Author, 2 Oct.)* |
| D3 | Form | A design doc first, with the law on disk before any number is cited. *(Author, 2 Oct.)* |
| D4 | Design 116's D6 (drop the `retirementDate` gate) | **Moves here, as phase 1.** While `retirementDate` also gates payment, the month benefits start is not the claim month, and someone working past FRA would earn delayed credits they never chose. The claim age cannot be defined honestly until the gate is gone (§5.1). |
| D5 | Where the claim age lives | **On the Person**, as `ssClaimAge`, exposed as the generated param `person.<id>.ssClaimAge`. Blank means exactly FRA. `primarySsClaimAge` becomes an alias for `person.primary.ssClaimAge`. |
| D6 | What `socialSecurityMonthly` means | **Unchanged: the primary insurance amount (PIA)**, the FRA amount in today's money, still inflated yearly. Every benefit is a factor times a PIA (§5.2). The field is not derived from an earnings record (§10). |
| D7 | Fixing a claim once made | **Stamped in state.** The first month a person is entitled is written to `state.people.<id>.ssEntitledMs` and never moves. A lever changed after that date (an MPC rollout, a decision schedule) cannot un-claim (§5.3). |
| D8 | Who is a spouse | **The two people of a two-person household** are treated as married for at least a year (20 CFR 404.330(a)(1)). A household of one has no spousal or survivor benefit. A relationship field is out of scope. |
| D9 | Deemed filing | **Everyone is deemed to file for both** their own and any spousal benefit in the month they claim (42 U.S.C. 402(r), as amended by Pub. L. 114-74 §831 for people reaching 62 after 2015, so born on or after 2 Jan 1954). Restricted applications are not modelled. |
| D10 | When the survivor benefit starts | **The later of the death month and the month the survivor reaches `min(ssClaimAge, survivor FRA)`.** One claim age per person: a survivor deferring their own benefit to 70 still takes the survivor benefit unreduced at their survivor FRA, and a survivor claiming early takes both early. A separate survivor claim age (from 60) is §11 Q1. |
| D11 | Sub-dollar rounding | **Not modelled.** SSA rounds reductions and credits to dimes and the benefit down to a dollar (404.304(f), 404.313(b), 404.410). The sim carries exact values, as it does for every other amount. |

## 4. The rules, from the sources

All sources were fetched on 2 Oct 2026 into `docs/us-social-security/`. The eCFR files are
the current text as of 1 Sep 2026; the statute is 42 U.S.C. 402 (Social Security Act §202)
with its amendment notes.

### 4.1 Full retirement age (20 CFR 404.409)

Two tables keyed by birth date: (a) for own and spousal benefits, (b) for widow(er)'s
benefits. Each row's boundaries are the CFR's (`1/2/1955—1/1/1956` and so on), which already
reflect that a person attains an age on the day before their birthday (404.102). Own/spousal
FRA is 67 for births on or after 2 Jan 1960. Survivor FRA is 67 for births on or after 2 Jan
1962, and between 66 and 67 for 1957–1961. The tables are transcribed as data, row by row,
from the file, not from memory.

**Month counting.** A person attains age N in the month containing the day before their Nth
birthday. All reductions and credits count whole months between two such months.

### 4.2 Own benefit claimed early (404.410(a); statute 402(q)(1))

The PIA is reduced by 5/9 of 1% for each of the first 36 months before FRA and 5/12 of 1%
for each month beyond 36. For FRA 67 that is 30% at 62, 25% at 63, 20% at 64, 13⅓% at 65 and
6⅔% at 66.

### 4.3 Own benefit claimed late (404.313)

A delayed retirement credit is earned for each month from FRA to the month the person
reaches 70 in which they are entitled but not receiving a benefit. For births after
1 Jan 1943 each credit is 2/3 of 1%, so 8% a year: 108% at 68, 116% at 69, 124% at 70 for
FRA 67. Credits do not apply to spousal benefits (they are an increase to the old-age
benefit only, 402(w)).

### 4.4 Spousal benefit (404.330, 404.333, 404.410(b), 404.407(a); statute 402(b), (q)(3)(B))

- **Entitlement.** The spouse must be 62 or older and must have applied, and the worker must
  be **entitled** to their own benefit, so the spousal benefit cannot start before the
  worker claims (402(b)(1)).
- **Amount.** Half the worker's PIA (404.333). It is the PIA, so the worker's own early
  reduction or delayed credits do not change it.
- **Dual entitlement.** A spouse entitled to their own benefit receives only the excess of
  the spousal amount over their own (404.407(a)). Under 402(q)(3)(B), when the spouse
  claimed their own benefit early, the total is:
  `own PIA × own factor + max(0, ½ × worker PIA − own PIA) × spousal factor`.
  *(Corrected in phase 3, §14.)* When the spouse's own benefit carries delayed credits,
  the credits come out of the excess: the combined amount is computed without them, and
  the own benefit with them is subtracted to give the spousal amount payable, not below
  zero (POMS RS 00615.694, saved in `docs/us-social-security/`). So the total is
  `max(own with credits, own without credits + reduced excess)`.
- **Spousal reduction.** 25/36 of 1% for each of the first 36 months before the spouse's
  FRA, then 5/12 of 1% (404.410(b)). For FRA 67: 35% at 62, 30% at 63, 25% at 64, 16⅔% at
  65, 8⅓% at 66, none from 67. The months are counted from the month the spousal benefit
  starts, which is the later of the spouse's claim and the worker's claim.

### 4.5 Survivor benefit (404.338, 404.410(c)(1); statute 402(e)(2)(C)–(D))

- **Base amount.** The deceased's PIA (404.338(a)).
- **Deceased claimed late, or died after FRA without claiming.** The base is the benefit
  including the delayed credits earned up to the month before death (402(e)(2)(C),
  404.338(b)).
- **Deceased claimed early.** The survivor's benefit, after the survivor's own age
  reduction, is capped at the larger of what the deceased would be receiving if alive and
  82½% of the deceased's PIA (402(e)(2)(D), 404.338(c)).
- **Survivor's age reduction.** Months before the survivor's FRA (table 404.409(b)) × 0.285 ÷
  the number of months from age 60 to that FRA (404.410(c)(1)). For a survivor FRA of 67
  that is about 20.4% at 62.
- **Dual entitlement.** A survivor also entitled to their own benefit receives the larger of
  the two (404.407(a): the survivor benefit is reduced by the own benefit).
- **Before death, after death.** Any spousal benefit ends at the worker's death; the survivor
  benefit replaces it.

## 5. Design

### 5.1 Phase 1: Social Security decoupled from work (was design 116 D6)

Design 116 §5.1a, unchanged in substance: the handler stops reading `retirementDate`, so
benefits start at the claim age whether or not the person is still working. It is the law
from FRA on, where the earnings test no longer applies. It lands first, as its own commit,
because it moves goldens and nothing else in this design should be mixed into that diff.
Before regolding, confirm that every changed golden has a person working past 67 and that
nothing else moved.

Claiming before FRA while still working is subject to the retirement earnings test, which
this design does not model (§10). Until it is, an early claim while employed overstates
income, and the help says so.

### 5.2 One pure rules module

`src/finance/account-rules/us/us-social-security-rules.js`, pure functions with no state:

- `fullRetirementAge(birthDate, kind)`: `kind` is `'own'` (table a, also used for spousal) or
  `'survivor'` (table b). Returns `{ years, months }`.
- `attainMonth(birthDate, years, months)`: the UTC month index in which the age is attained
  (§4.1).
- `ownFactor(birthDate, entitledMonth)`: below 1 for early, above 1 for delayed credits,
  months past 70 not counted.
- `spousalFactor(birthDate, spousalStartMonth)`.
- `survivorFactor(survivorBirthDate, survivorStartMonth)`.
- `survivorBaseRatio({ deceasedBirthDate, deceasedEntitledMonth, deathMonth })`: returns
  `{ ratio, ribLimCap }`. `ratio` is relative to the deceased's PIA: 1, or the deceased's
  delayed-credit factor. `ribLimCap` is set only when the deceased claimed early:
  `max(deceased own factor, 0.825)`.

`getSsEligibilityRules()` keeps `minAge: 62` as the earliest claim and returns the module, so
the handler still reads its rules through the `AccountRulesEngine`. These tables are law by
birth date, not by tax year, so they are not repeated in each year module.

### 5.3 The person, the param, the state

- **Record.** `Person.ssClaimAge`: an integer 62–70, or null for exactly FRA (D1, D5). It is
  serialized, edited on the person form, and projected into `state.people` by
  `projectPerson`, because a handler that reads `state.people` cannot see an unprojected
  field (`person-projection.js` documents that failure).
- **Param.** A `PERSON_PARAM_TEMPLATE` row: `ssClaimAge`, discrete options 62–70, nullable,
  `mc: false`, `opt: true`. It harvests as an enum row, so the optimizer and decision graph
  see nine values. The legacy `primarySsClaimAge` schema entry is removed and its key added
  to `INTL_RETIREMENT_PARAM_ALIASES` → `person.primary.ssClaimAge`, so saved plans, saved
  MC/Opt configs and design 30 decision points keep working.
- **Stamp (D7).** In the month a person is first entitled, the handler emits an action that
  writes `ssEntitledMs` (the epoch ms of that month's first day) on the person. From then on,
  the factor is computed from the stamp, not from `ssClaimAge`. A claim month before sim
  start (someone already collecting) is stamped with the computed past month, so their
  factor is right. A state field, not a compile-time fact, so MPC rollouts read it without a
  derivation-manifest entry.
- **Survivor fields.** `SOCIAL_SECURITY_SURVIVOR_APPLY` stops overwriting
  `socialSecurityMonthly`. The reducer writes `ssSurvivorPia` (the deceased's PIA, inflated
  yearly by `InflationAdjustReducer` like `socialSecurityMonthly`), `ssSurvivorRatio`,
  `ssSurvivorRibLimCap` and `ssSurvivorFromMs` (the D10 start month). `MortalityHandler`
  carries the deceased's `birthDate` and `ssEntitledMs` on the action, since the deceased is
  gone from `state.people` by the time the reducer runs.
- **State schema.** Each new field is typed in `state-schema-registry.js`: dates as
  `…Ms`, per the design 117 convention for state.

### 5.4 The handler, per person per month

For each living person `p` (with spouse `s` when the household has two):

1. **Own.** If `p` has reached their claim month (or is stamped): stamp if needed, then
   `own = p.socialSecurityMonthly × ownFactor(p, entitledMonth)`. Before the claim month,
   `own = 0`.
2. **Spousal** (only while `s` is alive and stamped, and `p` is entitled, D9):
   `excess = max(0, ½ × s.socialSecurityMonthly − p.socialSecurityMonthly)`;
   `spousal = excess × spousalFactor(p, max(p.entitledMonth, s.entitledMonth))`, less any
   delayed credits on `p`'s own benefit, not below zero (§4.4, §14). A person
   with no record of their own (`socialSecurityMonthly` 0) is entitled at their claim age
   on the spousal benefit alone.
3. **Survivor** (only once widowed and at or past `ssSurvivorFromMs`):
   `w = ssSurvivorPia × ssSurvivorRatio × survivorFactor(p, survivorFromMonth)`, capped at
   `ssSurvivorPia × ssSurvivorRibLimCap` when that is set.
4. **Paid.** Married: `own + spousal`. Widowed: `max(own, w)`.

The handler emits one `SS_INCOME_APPLY` for the total, as today, so tax and cash routing are
unchanged. The action's data gains `{ own, spousal, survivor }` so the journal can show what
the payment was made of. The toolset's scheduling gate (`personsWithSS`) is unchanged: a
household where nobody has a PIA cannot have a spousal or survivor benefit either.

## 6. Authoring surface

- **Person form.** A Claim Age select (blank = "At full retirement age (66y 10m)", computed
  from the birth date, then 62–70) beside `socialSecurityMonthly`. The FRA it shows is the
  rules module's, so the form and the sim cannot disagree.
- **Help.** `help/nodes/person.md` gets an `ssClaimAge` entry and the corrected
  `socialSecurityMonthly` sentence (the gate requires the first, and the stamp moves, so
  `npm run help:restamp -- person`). A new concept topic, `help/concepts/social-security.md`,
  explains the factors, spousal and survivor benefits and the earnings-test caveat;
  `mortality.md` links to it rather than restating the survivor rule.
- **Decision graph.** Design 30's example decision becomes real: options 62–70 on
  `person.primary.ssClaimAge` (or the alias).

## 7. State and goldens

Whole-state goldens pin `state.people`, so each phase that adds a field changes every fixture
with a person, even when no number moves. As in design 117 §9, each regold is checked
mechanically, never by eye: strip the phase's new keys from both sides and assert the rest
is byte-identical, except where §8 says numbers are expected to move.

The checked-in goldens' people are all born after 1960 and have no `primarySsClaimAge`
other than 67, so blank-or-67 resolves to FRA 67, the old `minAge`. Phase 2 should therefore
move no number.

## 8. Phasing

1. **Decouple from work** (§5.1, was design 116 D6). One commit. Numbers move only for
   people working past 67; verify that, then regold. Help: drop "starts at their
   retirementDate" from the handler description and the person topic.
2. **Claim age and the own benefit.** Rules module with FRA tables, `ownFactor`, the
   `ssClaimAge` field, projection, serializer round trip, editor, template row, alias,
   `ssEntitledMs` stamp. Unit tests reproduce the CFR's worked examples (404.410(a) and
   404.313(b)) to the cent before rounding. **Liveness test on a loaded plan**: 62, 67 and 70
   on `person.primary.ssClaimAge` produce three different first-payment months and amounts,
   through the param path the optimizer uses, not only on a hand-built config. Numbers
   unchanged on the goldens (§7).
3. **Spousal.** `spousalFactor`, the excess rule, deemed filing. Unit tests: the
   404.410(b) example; a zero-PIA spouse; a worker claiming after the spouse (the spousal
   start waits); a spouse whose own PIA exceeds half the worker's (no excess). Goldens move
   wherever one person's PIA is under half the other's: verify, then regold.
4. **Survivor.** `survivorFactor`, `survivorBaseRatio`, the new reducer fields, the mortality
   handler carrying the deceased's stamp. Unit tests: the 404.410(c)(1) example; a deceased
   who claimed at 62 (82½% floor); one who claimed at 70 (credits carry over); one who died
   at 68 without claiming (credits to the month before death); a survivor under their FRA
   at death. Goldens with mortality on move: verify, then regold.
5. **Close out.** Concept topic, design 30's example, delete the TODO #292 comment and the
   `design/inconsistencies.md` §2.5 entry (and the §4 note on `primarySsClaimAge`), close #292.

Design 116 then starts without its D6 commit; its §5.1a points here.

## 9. Testing notes

- The rules module is pure, so the tables and factors are tested exhaustively by birth year
  and claim age without a sim.
- The liveness test in phase 2 is the one that matters most: a lever that compiles,
  serializes and appears in the optimizer can still be dead on a loaded plan if a toolset
  forwarding step drops the generated key. It must run through `ScenarioLoader.load()`.

## 10. Not in this design

- **Retirement earnings test** (benefits withheld while claiming early and earning over an
  annual limit, 404.415–.418). It needs the wage on a date, which design 116's spells
  provide. It belongs in design 116 or straight after it. The limits will be fetched from SSA
  before they are cited.
- **PIA from an earnings record** (AIME, bend points). `socialSecurityMonthly` stays an
  authored input (D6). Design 116 spells are the start of an earnings history, but the
  computation is its own design.
- **COLA timing.** The yearly US-CPI inflation of the PIA from sim start stays as it is.
- **Family maximum, child and mother/father benefits, disability, divorced-spouse benefits,
  restricted applications for people born before 2 Jan 1954, voluntary suspension.**
- **Totalization** (the US–AU agreement). A person's `socialSecurityMonthly` is assumed to be
  an insured PIA already.
- **WEP and GPO.** Repealed by Pub. L. 118-273 (5 Jan 2025); the statute on disk already
  shows 402(k)(5) struck. Nothing to model.
- **Claim age as an MPC control.** A re-decidable claim age (each year until the stamp) fits
  D7 naturally, but it is an MPC feature, not part of this design.

## 11. Questions

- **Q1 — a separate survivor claim age.** A widow(er) may take the survivor benefit from 60
  and switch to their own at 70, which D10 cannot express. **Proposal: later.** The
  whole-years lever (D1) does not reach 60, and D10's rule already covers the common case.
- **Q2 — the earnings test's home.** Design 116 (it owns the wage on a date) or a short
  follow-up design. **Proposal: a phase at the end of design 116.**

## 12. As built — phase 1 (2 Oct 2026)

`MonthlySocialSecurityHandler` no longer reads `retirementDate`: a person is paid from the
claiming age (`minAge`, still 67) whether or not they are working. Its static description
and doc comment say so. (`help/REFERENCE.md` does not carry handler descriptions, so it did
not change.)

- **Goldens: none changed.** Every golden person retires at 65 or earlier (the latest is a
  2046-07-01 retirement for a 1981 birth), so the gate never bound past 67 in any fixture.
  This was checked against each fixture's people before accepting the unchanged run, rather
  than inferred from it.
- **Tests.** `tests/unit/monthly-social-security-handler.test.mjs`: a person past 67 with a
  future `retirementDate` is paid; a person under 67 is not, whatever `retirementDate`
  says; in one household each person is gated on their own age. Two of the three fail
  against the old handler. `toolset-us-retirement.test.mjs` EVT-37 pinned the old gate (a
  1958 birth, 67 in 2026, working to 2028, asserted zero benefit); it now asserts three
  months of benefit in Q1 2026, through the full toolset.
- **Help.** No topic tied the benefit to `retirementDate`, so no prose changed.

## 13. As built — phase 2 (2 Oct 2026)

**Rules.** `src/finance/account-rules/us/us-social-security-rules.js`: the three tables
(404.409(a), 404.409(b), 404.313(b)(2)) as data, `attainDate` / `attainMonth` (404.102),
`fullRetirementAge`, `entitlementMonth`, `earlyReduction`, `ownFactor`,
`normalizeClaimAge`. `tests/unit/us-social-security-rules.test.mjs` parses each table out
of the saved CFR text and compares it to the module, so the transcription is checked
against the authority, not retyped. It also reproduces the 404.410(a) and 404.313(b)
worked examples. Two more sources were fetched for this phase: 20 CFR 404.102 (age is
attained the day before the birthday) and 404.310/.311 (when entitlement begins).

**Two rules the design did not spell out, both now modelled:**

- **Entitlement before FRA starts in the first month the person is that age throughout**
  (404.311(a)(2)). That is the month after the attain month, unless the age is attained
  on the 1st (a birthday on the 2nd). From FRA on it is the attain month (404.311(a)(1)).
- **Credits earned in the year of filing are added the following January**, unless the
  filing is at 70 (404.313(c)(2)–(3)). `ownFactor(birth, entitledMonth, asOfMonth)`
  therefore steps up once, the January after a late claim.

**Departures from §5.**

- **No `AccountRulesEngine` indirection (§5.2).** `getSsEligibilityRules()` returned one
  constant, and only the US toolset passed the engine to the handler; the AU toolset
  never did and always fell back to 67. The handler now imports the pure module, and the
  method is removed from `BaseAccountModule` and `UsAccountModule2026`.
- **Harvest of an unset enum (§5.3).** A blank claim age means FRA, which is not one of
  the nine options. `sweepUnset` documented itself as never for "null means the
  default", but without it a plan with blank claim ages has no lever. The template row
  sets `sweepUnset`, its doc now carves out an Enum whose options are every alternative
  to the blank default, and `harvestSweepVariables` accepts an unset `enum` (its row is
  the option list) and a numeric enum value.
- **`primarySsClaimAge`** stays in `INTL_RETIREMENT_DEFAULTS` as `null`, the primary's
  person record reads it, and the alias maps it to `person.primary.ssClaimAge`. That is
  the `primaryMonthlyWage` pattern.

**Wiring.** `Person.ssClaimAge` (normalized in the constructor, so a bad save fails at
load), `PersonBuilder.ssClaimAge`, `projectPerson` (`ssClaimAge` normalized, and
`ssEntitledMs: null`), the serializer both ways, the state schema
(`people.*.ssClaimAge` integer, `people.*.ssEntitledMs` date), the person form (a select
whose blank option names this birth date's FRA), and the people controller.
`SsEntitlementApplyReducer` writes the stamp and never overwrites one.
`SS_ENTITLEMENT_APPLY` is declared identically in both retirement toolsets, and the
reducer is registered beside the handler under the same guards.

**Goldens: 15 regolded.** Each was checked mechanically against the pre-phase fixture
with `ssClaimAge` and `ssEntitledMs` stripped. Fourteen are byte-identical. In
`us-single-homeowner` the numbers move: the primary, born 1 Jul 1981, attains 67 on
30 Jun 2048 and is entitled from June (404.102, 404.409(a)). The old whole-years
birthday test paid from July. Counting `SS_INCOME_APPLY` entries in both runs gives 211
against 210, first month 2048-06 against 2048-07, and nothing else. §7's prediction of
no number moving missed this born-on-the-1st case.

**Liveness.** `tests/unit/ss-claim-age-liveness.test.mjs` loads the reference plan:
- the Opt harvest offers `person.primary.ssClaimAge` and `person.spouse.ssClaimAge` as
  nine-value ENUM rows;
- optimizer rollouts at 62, 67 and 70 differ;
- `primarySsClaimAge` matches the generated key and moves the run;
- a claim at 62 stamps May 2040 and pays 70.4% of the PIA;
- the serializer round-trips the field.

Against a handler that ignores the claim age, the 62/67/70 test and the May 2040 test
fail.

**Help.** `help/nodes/person.md` documents the PIA meaning and the claim-once rule, and
says what is not modelled yet. The field itself is described only by its template
(tier 1). `help/concepts/us-tax.md` drops the retired param and points at the person.

## 14. As built — phase 3 (2 Oct 2026)

**Rules.** `us-social-security-rules.js` adds `spousalReduction` (404.410(b): 25/36 of 1%
for the first 36 months, 5/12 beyond), `spousalFactor` (counted to the spouse's own FRA,
table 404.409(a), never above 1) and `spousalPayable`, which follows POMS step by step:
nothing when the own PIA is at least half the worker's (404.330(d)); otherwise the own
benefit without credits plus the reduced excess, less the own benefit with credits, not
below zero.

**A correction to §4.4 and §5.4.** The design took the excess to be untouched by the
spouse's own delayed credits. The statute on disk did not settle it: 402(k)(3)(A)
subtracts the old-age benefit "after reduction under subsection (q)" and says nothing of
(w). SSA's manual does. Two POMS sections were fetched (secure.ssa.gov serves them,
unlike www.ssa.gov) and saved: RS 00615.020 (dual entitlement, method C: the full own
benefit comes off the full spouse benefit, then each is reduced) and RS 00615.694 (credits
on the own benefit are subtracted from the combined amount). The tests read both pages'
example figures from the saved files and reproduce them: 920 for method C, 290 for
RS 00615.694. A spouse who delays to 70 can therefore lose the top-up entirely.

**The handler.** In a household of exactly two (D8), each person's spouse is the other
entry in `state.people`; the top-up ends when that entry is removed at death. Per person:

- **Worker's month.** The spouse's stamp, or their claim age's month; none if the spouse
  has no PIA.
- **Own entitlement.** A person with a PIA is stamped at their own claim month, as in
  phase 2. A person with no PIA is entitled, and stamped, at the later of their claim
  month and the worker's (402(b)(1): no spousal benefit before the worker is entitled).
  `ssEntitledMs` is therefore "first month entitled to any benefit", and both spouses'
  stamps fix the spousal start for good (D7).
- **Spousal start** is the later of the two entitlement months; the factor is counted
  from it, not from the person's own claim. Deemed filing (D9) is this rule: no separate
  spousal claim age exists.
- **Paid** is `own + spousal`, as one `SS_INCOME_APPLY` whose payload now carries `own`
  and `spousal` (declared on the action, so the journal keeps them). Survivor is phase 4.

**Goldens: none changed.** Every golden with two people sets the spouse's PIA to exactly
half the primary's, and 404.330(d) pays nothing at equality, so no top-up is due
anywhere. That was checked against each fixture's people, not inferred from the
unchanged run. The handler payload's two new fields are journal data, not state.

**Tests.** `us-social-security-rules.test.mjs` SSR-SP-*: the 404.410(b) example (80.18,
which the CFR truncates from 80.189), the two POMS examples, the FRA-67 spousal factors
(65% at 62 … 100% from 67), no top-up at or above half, a zero-PIA spouse, credits that
consume the whole excess. `monthly-social-security-handler.test.mjs` SS-SPOUSE-*: a
zero-PIA spouse entitled at their claim age once the worker is; a worker claiming after
the spouse (the top-up waits, reduced from its own start: 44 months); own PIA at or above
half; the spouse's own credits eating the excess; a household of one; the worker's
claim factor not reaching the spousal amount. `ss-claim-age-liveness.test.mjs` SSCA-6
loads the reference plan with the spouse's PIA cut to 400 and a claim at 62, and finds
the October 2045 payment split into the reduced own benefit and the reduced top-up.

**Help.** `help/nodes/person.md` says the top-up exists and that survivor benefits are
not modelled yet; `help/REFERENCE.md` lists the two new action fields.

## 15. As built — phase 4 (2 Oct 2026)

**Rules.** `us-social-security-rules.js` adds:

- `survivorReduction` / `survivorFactor`: 404.410(c)(1), with the survivor FRA from table
  404.409(b);
- `survivorStartMonth`: the D10 rule;
- `survivorBaseRatio`: 404.338 and 402(e)(2)(C)–(D);
- `survivorBenefit`;
- `claimMonthOf`: the stamp, else the claim age's month. It moved here from the
  handler, because the survivor reducer needs it too.

Three cases come from the statute rather than the CFR text, and are tested:

- A late claimant who dies in the filing year passes on every credit. 402(e)(2)(C)
  counts the death year's months "notwithstanding" the January wait of 404.313(c).
- A deceased who never claimed and died after FRA passes on credits up to the month
  before death, stopping at 70 (404.313(e)(1)).
- A deceased who died before FRA without claiming passes on the plain PIA.

**State (§5.3, as designed).** `SOCIAL_SECURITY_SURVIVOR_APPLY` no longer overwrites the
survivor's `socialSecurityMonthly`. `MortalityHandler` carries the deceased's PIA, birth
date, `ssEntitledMs` stamp and the death date. The reducer computes the terms and writes
`ssSurvivorPia`, `ssSurvivorRatio`, `ssSurvivorRibLimCap` and `ssSurvivorFromMs`. The
fields are absent until a death, not projected as nulls, so only a widowed person
carries them. `InflationAdjustReducer` inflates `ssSurvivorPia` with the PIAs, only when
present. All four are typed in the state schema. A deceased stamped before the death is
taken to have claimed. One whose claim month is the death month dies before the
month-end payment that would stamp them, so they are treated as never having claimed.

**The handler.** A widow(er) is paid from the earlier of their own entitlement and
`ssSurvivorFromMs`, so the survivor benefit no longer waits for their own claim (D10).
The payment is `own + max(0, survivor − own)`, the larger of the two (404.407(a)), and
the payload's new `survivor` field is that excess. A person with no record of their own
is paid the survivor benefit and is never stamped: `ssEntitledMs` stays the own or
spousal claim. Any spousal top-up ends at the death, because the worker leaves
`state.people`.

**Goldens: none changed.** No golden has a death (`golden-coverage-manifest.js` lists
`SOCIAL_SECURITY_SURVIVOR_APPLY` and `PERSON_DIED_APPLY` as uncovered), and every
new field and branch is reached only through one. §8 expected goldens with mortality on
to move; there are none.

**Tests.**

- `us-social-security-rules.test.mjs` SSR-SV-*: the 404.410(c)(1) example (55.98, read
  from the saved file); 28.5% at 60 and 60/84 of it at 62 for a survivor FRA of 67; a
  deceased who claimed at 62 (the 82½% floor) and at 66 (the RIB-LIM); one who claimed
  at 70; one who died at 68 without claiming; a late claimant dying in the filing year;
  a survivor under FRA at the death.
- `monthly-social-security-handler.test.mjs` SS-SURV-*: a smaller own benefit topped up
  to the survivor benefit; a survivor with no record of their own; deferring the own
  claim to 70 without deferring the survivor benefit, then the own benefit overtaking
  it; the cap and inherited credits reaching the payment.
- `evt-person-died.test.mjs` MORT-2/3 and the reducer postconditions: they pinned the
  old overwrite and now pin the four fields.
- `ss-claim-age-liveness.test.mjs` SSCA-7: on the loaded reference plan, the primary
  claims at 62 and dies at 68. The spouse is paid from April 2046, the death month, at
  the survivor factor, under the 82½% cap.

**Help.** `help/nodes/person.md` now covers survivor benefits, and
`help/concepts/mortality.md` says the survivor keeps the larger benefit.
`real-vs-nominal` was restamped because the schema file it cites changed. Its claims
are about currency and date types, which still hold.

## 16. As built — phase 5, close-out (3 Oct 2026)

- **Concept topic.** `help/concepts/social-security.md` covers the PIA-times-factor model,
  the claim-once stamp, the spousal top-up, the survivor benefit, the lever, and what is
  not modelled. `help/nodes/person.md` and `help/concepts/mortality.md` link to it rather
  than restating it. The person topic dropped its earnings-test sentence to stay in budget,
  because the concept topic says it.
- **Design 30's example is real.** Its `DecisionPoint.paramKey` example (design doc and
  model comment) now names `person.primary.ssClaimAge`. `ss-claim-age-liveness.test.mjs`
  SSCA-8 runs a claim-age decision point (62, 67, 70, 67) through `DecisionGraphRunner` and
  the real `IntlRetirementMcRunner` on the loaded reference plan. The three ages give
  three different p50s, and the repeated 67 gives the same one. The factory leaves out the
  runner's per-leaf seed offset, which would make any two leaves differ. Against a dead
  `paramKey` all three leaves are equal and the test fails.
- **TODO #292.** The handler comment was already removed in phase 2. The
  `design/inconsistencies.md` §2.5 entry is struck as resolved, and its §4 note on
  `primarySsClaimAge` now says the alias is live.
- **#292** closed.

