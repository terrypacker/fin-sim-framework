# 119 — Super access dates, multiple funds and ADF Super

**Status:** DRAFT, 4 Oct 2026. A light proposal to present and confirm with the author;
nothing here is decided. §3 lists the decisions to take. Every general super rule in §4 is
cited to the SIS Regulations on disk (`docs/au-tax/SISR-1994/`). **No ADF Super rule is
yet sourced.** §5 marks each one UNVERIFIED, and phase 0 fetches the sources before any of
them is built.

## 1. The ask

> Need a way to set up a super so you can withdraw at different years. Normally it's 60
> but you have up to 67. Military super has separate rules and could be represented as a
> portion of an existing account or its own separate account. Need to support multiple
> super accounts.

On review, "up to 67" turned out to be a misreading of the 60–65 window, in which super
can be released early in some circumstances (§4), or something specific to military
super. So the ask becomes:

1. Each super account can have its own **date to start drawing**, from preservation age
   onward.
2. A person can hold **more than one super account**, and contributions go to the one
   they choose.
3. **ADF Super** can be modelled, as its own account.

## 2. What the code does today (audited 4 Oct 2026)

- **The age gate is fixed at 60.** `SuperannuationAccount` defaults `minimumAge` to 60
  (`investment-account.js`). Design 97 §22.9 deliberately stopped saving `minimumAge` with
  a plan, because it is law rather than a household choice. Nothing represents the
  household's choice of when to start drawing.
- **Pension phase starts automatically at 60.** `superEarningsTaxRate(age)`
  (`super-tax-rate.js`) taxes fund earnings at 0% from age 60, as if every member starts
  a pension that day. A member who delays drawing to 65 gets five years of 0% earnings
  they would not get in reality.
- **Release is checked by age alone.** Between 60 and 65 the law also requires a
  condition of release (§4), but `penalty-free-availability.js` checks only age. A member
  still working at 61 can draw their super in the model.
- **Multiple super accounts partly work.** Several can be authored. The drawdown walk
  checks each against its own owner's age, and same-role siblings share one drawdown
  weight. **Contributions do not follow:** `StateRegistry.getStateKey(SUPER, personKey)`
  returns the *first* match, so every SG, salary-sacrifice and personal contribution goes
  to that account.
- **The payroll fallback has no owner filter.** If a person has no super account,
  `payroll-handler.js` falls back to `getStateKey(SUPER)`, which can return the other
  person's fund.
- **Dormant handlers.** `SuperWithdrawalContributionsHandler` and
  `SuperWithdrawalEarningsHandler`, and their reducers, are hardcoded to
  `state.superAccount` and `age < 60`. They are registered, but nothing schedules their
  events.
- **No military super of any kind.**

## 3. Decisions to take

| # | Decision | Proposal |
|---|---|---|
| D1 | What does the start-drawing setting hold? | A **date** on the account (design 117 style), not an age. Blank means "from the earliest lawful date". |
| D2 | Does the start date also start the pension phase (0% earnings tax)? | **Yes.** It replaces the age-60 proxy with "the date this account starts paying". |
| D3 | Is the condition of release enforced between 60 and 65? | **Yes, using design 116 jobs:** before 65, an account cannot pay out until the owner has no job running. A transition-to-retirement pension is out of scope (§8). |
| D4 | How does a contribution pick a fund? | A **named fund on the job** (design 116), falling back to the person's first super account. Never another person's fund. |
| D5 | Is ADF Super its own account or a portion of one? | **Its own account**, a variant of `SuperannuationAccount`. A "portion" would need sub-balances with different rules inside one account, which nothing else in the model has. |
| D6 | Are the defined-benefit military schemes (MSBS, DFRDB) in scope? | **No.** They pay a formula pension, not a balance. Deferred to a later design once the author confirms which scheme applies (§8). |

## 4. The general rules, from the sources

All from the SIS Regulations 1994, compilation F2026C00541 (`docs/au-tax/SISR-1994/`).

- **Preservation age** (reg 6.01(2)): 55 for a person born before 1 July 1960, rising one
  year per birth year to **60 for a person born after 30 June 1964**.
- **Retirement after 60** (reg 6.01(7)(b)): an arrangement under which the member was
  gainfully employed has ended, *and* either they reached 60 on or before it ended, or
  the trustee is satisfied they never intend to work again.
- **Retirement before 60** (reg 6.01(7)(a)): a job has ended *and* the member never
  intends to work again. This matters only for the older preservation ages.
- **Age 65** (Sch 1, items 106 and 206): release is unconditional, with no cashing
  restrictions.
- **Transition to retirement** (Sch 1, items 110 and 208): at preservation age, a member
  may take a transition-to-retirement income stream while still working. Out of scope here.

As an access rule, this gives **(preservation age AND job ended) OR age 65**. The model
gives a person who stops working at 58 and is born after June 1964 access at 60. That
already matches the rule, so D3 changes only the case where someone keeps working past 60.

## 5. ADF Super — UNVERIFIED, to confirm

Everything in this section is the author's understanding to be confirmed. None of it is
sourced yet, and none of it is built until phase 0 has saved the sources in
`docs/au-tax/`.

- **What it is:** the accumulation fund for ADF members who joined from 1 July 2016
  (UNVERIFIED). It holds a balance like any other super account, so it fits the model
  without a new mechanism.
- **What may differ from an ordinary fund**, each to confirm against the Act and the CSC
  scheme rules:
  - the employer contribution rate, which may be set by the scheme rather than by the SG
    and may be higher than it;
  - the earnings base the employer rate applies to;
  - insurance (ADF Cover) held outside the fund rather than paid from it, which would
    leave the balance untouched;
  - whether preservation and release are the standard SIS rules. They are expected to
    be, which is the whole reason D5 can treat it as an ordinary account.
- **Sources to fetch (phase 0):** the Australian Defence Force Superannuation Act 2015,
  the Australian Defence Force Cover Act 2015, and the CSC product disclosure statement for
  ADF Super. Use the scripted legislation.gov.au route for the Acts (OData plus a
  client-built PDF path). The CSC site is untested.

If phase 0 finds ADF Super differs only in its employer rate, D5 shrinks to **an employer
contribution rate on the job**, and no new account type is needed.

## 6. Design

### 6.1 Start-drawing date on each super account (D1, D2)

- New optional account field `drawStartDate` (super only), saved with the plan because it
  is a household choice, unlike `minimumAge`.
- **Effective start** = the later of `drawStartDate` and the **lawful release date**
  (§6.2). A date before the lawful date is moved to it, as design 117 already does for the
  401(k) rollover.
- `penalty-free-availability.js` reads the effective start instead of `minimumAge`. Pools,
  net liquidity and drawdown all go through it, so they follow automatically.
- `superEarningsTaxRate` takes the account and date instead of the age. It returns 0 from
  the effective start, and 15% before it.
- The date can be swept like the design 117 dates (`acct.<key>.drawStartDate`), which makes
  "draw super from 60 vs 65" an optimizer or grid lever.

### 6.2 Lawful release date (D3)

A pure function in the AU account module:

```
releaseDate(person, jobs) =
  min( date of 65th birthday,
       max( preservation-age birthday, end of the last job ) )
```

Preservation age comes from the reg 6.01(2) table by birth date, which replaces the
hardcoded 60. A person with no jobs gets preservation age.

### 6.3 Contributions to a chosen fund (D4)

- Each job gets an optional `superAccountKey`. The payroll handler sends that job's SG,
  sacrifice and personal contributions to it. Otherwise it uses the person's first super
  account. A job with no matching fund gets no AU contribution, and a loader warning.
- Remove the owner-less `getStateKey(SUPER)` fallback.
- `_auSuperKeyFor` (`tax-settle-classes.js`) already prefers the recorded key. The caps
  and total-super-balance tests must **sum across all of a person's super accounts**, not
  read one. That is a correctness fix in its own right once a person has two funds.

### 6.4 ADF Super account (D5)

`AdfSuperAccount extends SuperannuationAccount`, which inherits every rule. It differs only
in what phase 0 confirms, most likely an employer-rate default. If phase 0 finds nothing
different, it becomes a label on an ordinary super account, and this subsection is
dropped.

### 6.5 Retire the dormant handlers

Delete `SuperWithdrawal*Handler` and the `*_APPLY` reducers that read `state.superAccount`,
or key them to `stateKey`. Check `tests/` first: they back reducer-postcondition and
spending-classification tests.

## 7. Phasing

| Phase | Scope | Golden impact |
|---|---|---|
| 0 | Fetch the ADF Super sources and confirm or strike §5 | none |
| 1 | Multiple funds: job `superAccountKey`, remove the fallback, sum caps across funds | none expected; a plan with one fund per person is unchanged |
| 2 | Lawful release date and the preservation-age table | moves any golden with an AU person still working past 60 |
| 3 | `drawStartDate` and pension phase from the effective start; sweepable | moves goldens where super is untouched past 60 (the earnings tax changes) |
| 4 | ADF Super account, if phase 0 warrants it | none |
| 5 | Help topics (`help/nodes/account.md`, `job.md`), editors, restamp | none |

## 8. Not in this design

- **Defined-benefit military schemes (MSBS, DFRDB):** they pay a formula pension, not a
  balance, and would be modelled as an income stream rather than an account. This needs
  the scheme Acts on disk and confirmation of which scheme applies.
- **Transition-to-retirement income streams.**
- **The transfer balance cap** on pension phase (already elided, design 77 §4.2).
- **Minimum pension drawdown rates** once pension phase starts.

## 9. Questions for the author

1. Is the ADF fund in question **ADF Super** (accumulation), or **MSBS / DFRDB** (defined
   benefit)? If the latter, §5 and phase 4 swap for a defined-benefit income-stream design.
2. Is a **date** the right control for "when to start drawing", or would you rather author
   an **age**?
3. Should a person still working between 60 and 65 really be **blocked** (D3), or only
   warned?
