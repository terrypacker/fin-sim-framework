# 119 — Super access dates, multiple funds and MSBS

**Status:** ACCEPTED, rev 5, 5 Oct 2026. Q1–Q5 (§9) are answered by the author, and
§3 records the decisions. **Phases 1–4 BUILT** 5 Oct 2026 (multiple funds §6.3; release date §6.2; draw date and pension phase §6.1; the preserved MSBS account §6.4, built as §6.4.1 records); phases 5–6 not started. Rev 4 adds the CSC documents and the
valuation law (§5.6), which settle the tax and total-super-balance questions. Rev 5
closes the last two points (§5.7). No source questions remain open.

Rev 2 replaces ADF Super with the **Military Superannuation and Benefits Scheme (MSBS)**,
at the author's direction. It also gives the military account its own setting for when it
is drawn from. Every general super rule in §4 is cited to the SIS Regulations on disk
(`docs/au-tax/SISR-1994/`). Every MSBS rule in §5 is cited to the MSBS Trust Deed on disk
(`docs/au-tax/MSB-Trust-Deed/`, compilation No. 19), fetched 5 Oct 2026. §5.6 adds what
the Trust Deed does not settle, from CSC's documents and the tax and valuation law.

## 1. The ask

> Need a way to set up a super so you can withdraw at different years. Normally it's 60
> but you have up to 67. Military super has separate rules and could be represented as a
> portion of an existing account or its own separate account. Need to support multiple
> super accounts.

Then, in rev 2:

> Rework design 119 to use the MSBS instead. This will also need to have year setting for
> when the account should be drawn from.

So the ask is now:

1. Each super account can have its own **date to start drawing**, from the earliest lawful
   date onward.
2. A person can hold **more than one super account**, and contributions go to the one
   they choose.
3. **MSBS** can be modelled as its own account, with **its own draw date**, and inside the
   limits the Trust Deed sets (§5.4).

"Up to 67" was a misunderstanding (Q5); nothing on disk sets 67. The MSBS deadline is
**65**: a preserved benefit with no pension election by then is paid out as a lump sum
(r 53(1), §5.4).

The member in question has **already left the ADF with a preserved benefit** (Q1). So the
MSBS account is authored from a CSC statement, and the model does not rebuild service and
salary. A serving member is out of scope (§8).

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
- **No defined-benefit super of any kind.** The nearest thing is US Social Security
  (`monthly-social-security-handler.js`), which is also an indexed income with no balance
  behind it.

## 3. Decisions to take

| # | Decision | Proposal |
|---|---|---|
| D1 | What does the start-drawing setting hold? | A **free date** on the account (design 117 style), not an age or a year (Q2). Blank means "from the earliest lawful date". No year stepping. |
| D2 | Does the start date also start the pension phase (0% earnings tax) on an ordinary account? | **Yes.** It replaces the age-60 proxy with "the date this account starts paying". |
| D3 | Is the condition of release enforced between 60 and 65? | **Yes, blocked, using design 116 jobs:** before 65, an account cannot pay out until the owner has no job running. Blocking is the simpler of the two (Q4): it falls out of the release date (§6.2) that availability already reads, where a warning would need a new channel. A transition-to-retirement pension is out of scope (§8). |
| D4 | How does a contribution pick a fund? | A **named fund on the job** (design 116), falling back to the person's first super account. Never another person's fund. |
| D5 | How is MSBS represented? | **Its own account type, `MsbsAccount`**, holding a **preserved** benefit in two parts: the **member benefit**, which is a real invested balance, and the **employer benefit**, which is an amount authored from the statement and indexed by CPI, with no balance behind its unfunded part (§5.2, §6.4). Not a "portion" of an ordinary account, because the employer benefit follows rules no other account has. |
| D6 | What does the MSBS draw date do? | It is the date of the **election** under r 52(1) or r 14(3): on it the employer benefit becomes a pension, a lump sum, or a split. It is clamped to the window the Trust Deed allows (§5.4). |
| D7 | Is the pension/lump-sum choice authored? | **Yes**, as a pension share: 0 (all lump sum), or from 0.5 to 1 (r 52(1)(c) requires at least half if split). **Default 1, a full pension** (Q3). Sweepable. |
| D8 | Where does an MSBS lump sum go? | Into AU cash only once the owner meets a condition of release under §6.2 (preservation age and no job, or 65). Otherwise it is **rolled into the person's ordinary super account** (r 84; M65 says a lump sum is "subject to meeting an appropriate condition of release"). |
| D9 | Is ADF Super still in scope? | **No.** It moves to §8. The Trust Deed provides for MSBS members moving to it (r 14A). |

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

## 5. MSBS, from the Trust Deed

All rule (r) and Schedule (Sch) references are to the MSBS Rules, the Schedule to the
*Military Superannuation and Benefits Trust Deed*, compilation No. 19, 8 Apr 2022
(`docs/au-tax/MSB-Trust-Deed/F2022C00514.txt`). The Act it is made under is
`docs/au-tax/MSBA-1991/`.

### 5.1 Contributions

- **Member contributions** (r 4): each fortnight, a "relevant percentage" of salary,
  which is "a whole number that is not less than 5 and not more than 10, elected by the
  member", or **5% if no election** (r 4(10)).
- **Employer contribution** (r 10(3)): "3 per centum of the amount of the salary payable to
  the member in respect of the relevant fortnight", paid on each pay-day the member
  contributes. This is the only part of the employer benefit that is funded.
- **Maximum benefit limits** (r 5, Sch 3): once the total benefit reaches a multiple of
  final average salary, contributions stop. The dollar bands in Sch 3 are increased under
  r 55. The model does not apply the limit (§6.4).

### 5.2 The two benefits

- **Member benefit** (Sch 1): from 1 July 2002, "the sum of the value of units in the
  person's member funded account and member unfunded account". In practice, the member's
  contributions plus investment returns. It is an accumulation balance.
- **Employer benefit** (Sch 1, Sch 8): a formula, not a balance. Sch 8 item 2:

  ```
  employer benefit = FPES × 18% × FAS  +  SPES × 23% × FAS  +  TPES × 28% × FAS
  ```

  FPES is eligible service in the first 7 years, SPES is years 8 to 20, and TPES is
  service after 20 years. FAS is **final average salary** (Sch 7): one third of the salary
  paid in the last 1,095 days of service, or annualised over all service if shorter.
- **Funded employer benefit** (Sch 1): the value of the units bought with the 3% employer
  contributions. It is *part of* the employer benefit, not added to it. The rest is the
  **unfunded** part.

### 5.3 What happens on leaving

| Leaves | Member benefit | Employer benefit |
|---|---|---|
| Before 55, not redundancy or invalidity (r 12) | Lump sum under Part 11, or preserved by election. If neither is chosen within 3 months, it is preserved (r 12(4)). | **Preserved** (r 12(2)(b)). |
| At or after 55, not invalidity (r 14) | Lump sum, or preserved. | Lump sum, **or a pension**, or a pension of at least half with the rest as a lump sum, or preserved (r 14(3)). |
| Redundancy, limited tenure, or a retiring age below 55 (r 13) | Lump sum, or preserved. | Preserved, **or converted to a pension at once** (r 13(4)). Out of scope (§8). |

Part 11 limits the lump sums. Member benefit accrued from 1 July 1999 "must be preserved in a
regulated superannuation fund until he or she attains his or her preservation age"
(r 83). If a person turns 55 before preservation age, the employer benefit must be
preserved the same way until then (r 84).

### 5.4 Drawing a preserved benefit: the draw window

- **From 55** (r 52(1)): a person aged 55 or more whose preserved benefit includes employer
  benefit "may, at any time" elect a lump sum, a pension, or a pension of at least half
  with the balance as a lump sum.
- **Not while still serving** (r 52(1A)): r 52(1) "does not apply to a person if he or she
  is either a member of the Permanent Forces; or a member of the Reserves rendering
  continuous full-time service."
- **By 65** (r 53(1)): if no pension election is made "on or before attaining the age of 65
  years, the preserved benefit is payable to the person as a lump sum."
- **Minimum for a pension** (r 65B): a pension is not available if the employer benefit is
  below 25 times the SIS preservation threshold amount, which is **\$5,000** (§5.7 item 2).

So the **MSBS draw window** is from the later of the 55th birthday and the end of
military service, to the 65th birthday. The draw date (D6) is clamped into it. If
the author leaves it blank, it is the start of the window.

### 5.5 The pension

- **Rate** (r 65, Sch 5): the annual pension is the converted amount divided by a factor:
  **10 at age 65, plus 0.2 for each year under 65**, pro rata by days. A conversion at 55
  divides by 12, and one at 60 by 11. Drawing later buys a higher rate for each dollar
  converted.
- **Indexation** (r 56): twice a year, the pension rises by the CPI (weighted average of
  the 8 capital cities) for the March or September quarter, measured against **the highest
  earlier index**. It never falls. The increase is rounded to a tenth of a per cent
  (r 61(3)).
- **Preserved benefit before the draw** (r 61A): the **unfunded** part of a preserved
  employer benefit is increased each year by the March-quarter CPI, on the same
  never-falls basis. The funded part stays invested.
- **Reversion**: Sch 4 Table 1 sets the spouse's share at **67%** where there is a spouse and
  no eligible child (r 42, death of a member). For the death of a pensioner, CSC's *Death
  and invalidity benefits* booklet states the same: "your eligible spouse will receive up
  to 67% of the pension that you were receiving". Phase 5 checks that against Trust Deed
  Part 4 Div 2 before building the survivor pension.

### 5.6 From CSC and the tax law

Fetched 5 Oct 2026. CSC's documents are in `docs/au-tax/csc-msbs/`, and the valuation law
is in `docs/au-tax/ITAR-2021/` and `docs/au-tax/FLSR-2025/` (provenance in
`docs/au-tax/SOURCES.md`). CSC's documents are the trustee's restatement. The Trust Deed
and the Acts decide.

1. **The formula and the funded part.** The PDS (§3) and MB13 both give the 18/23/28% of
   FAS table for an ordinary member, which settles the Sch 8 scope question. The member is
   preserved, so the model does not use the formula, but the statement figures come from it.
2. **Where each part is invested.** PDS §3: after leaving, "the funded and unfunded
   components will accrue separately. The funded amount will be subject to investment
   performance in the **Balanced option**, whether positive or negative, while the unfunded
   amount will accrue in line with the consumer price index." The **member and ancillary
   benefits** are invested in the option(s) the member chooses (PDS §5). So the funded part
   does *not* follow the member's choice.
3. **Ancillary benefit.** Personal, salary-sacrifice and government contributions, plus
   interest. These are paid as a lump sum like the member benefit (PDS §2). The model folds
   them into the member benefit.
4. **The pension from 55.** PDS §2: the employer benefit "can be paid as a non-commutable
   pension on or after age 55 provided you have transitioned from the ADF—it is not
   subject to normal retiring conditions". This confirms §5.4: a civilian job does not
   block the MSBS pension.
5. **Tax elements.** *Tax and your MilitarySuper* and MS08: the **unfunded employer
   component** is the *taxable component, untaxed element*. The **funded (productivity)
   part** and the earnings on member contributions are the *taxed element*. Member
   contributions are the *tax-free component*. This puts the pension under ITAA 1997
   s301-100 at 60 or over (the untaxed element is assessable, with a 10% offset) and
   s301-110 from preservation age to 60. The taxed element of a pension is tax-free from 60
   (s301-10), and from preservation age to 60 it gets a 15% offset (s301-25). Any part of a lump sum that comes from an untaxed source is taxed under
   s301-95/-105/-115, or at 15% in the receiving fund if rolled over (*Tax and your
   MilitarySuper*, "Rollovers").
6. **Defined benefit income cap** (ITAA 1997 s303-3, s303-4): the cap is the general
   transfer balance cap divided by 16. Above it, the 10% offset is reduced by 10% of the
   excess. `au-super-limits.js` already has `transferBalanceCap`.
7. **Total super balance.** A preserved MSBS interest does count. ITAA s307-205 leaves the
   value to the regulations. ITAR reg 307-230A.01(2) makes it the **family law value**.
   Reg 307-230A.04 points that at the *Family Law (Superannuation) (Methods and Factors…)
   Approval 2025*, read **as if the member were male** and had **no reversionary
   beneficiary** (reg 307-230A.04(3)(g), (h)). Approval Sch 1 Part 4, item 2.1, preserved
   member:

   ```
   value = FDB × FDBF(y+m) + UDB × UDBF(y+m) + MB
   ```

   FDB is the funded employer benefit, UDB is the unfunded part, and MB is the member
   benefit. The factors come from Table 1 by age and by whether the member was an
   **officer** when they left, interpolated by month. Once the pension is paid, item 3.1
   values it at `P × (PF(y+m) + 0.67 × RF(y+m))`. The reversion term drops out under
   reg 307-230A.04(3)(h), leaving `P × PF(y+m)` from Table 4A.

### 5.7 Closed in rev 5

1. **What a preserved member's statement shows.** CSC does not publish a sample statement.
   The *militarysuper book* (ComSuper, 30 June 2011, "Preserved benefits" chapter, saved
   in `docs/au-tax/csc-msbs/`) describes each preserved component and how it moves:
   - **member benefit**: "shown on your annual Member Statement as a fixed number of
     units", valued at the unit price when claimed;
   - **funded productivity benefit**: units in "the fund's default investment strategy",
     fixed at exit;
   - **unfunded employer benefit**: "the total employer benefit less the value of the
     productivity benefit at the time you left", increased each year by CPI;
   - **unfunded productivity benefit**: only for members who transferred from DFRDB, and
     also CPI-indexed.

   Today's CSC pages say the annual statement shows "the balance of these components",
   the member, employer and ancillary benefits. So the statement gives the fields in §6.4
   directly. Two consequences:
   - The unfunded productivity benefit of a former DFRDB member is CPI-indexed like the
     unfunded employer benefit, so it is entered **into `unfundedEmployerBenefit`**.
   - If a statement shows only an employer benefit total, the editor accepts the total and
     the funded part, and derives the unfunded part.

   The 2011 book predates the 2016 investment-option changes. It is used here only for
   the statement's structure, which the Trust Deed's definitions (Sch 1) fix.
2. **The SIS preservation threshold amount** (r 65B). Rev 4 misread the table. SIS Regs
   Sch 1 Part 1 has three columns: *Item*, *Conditions of release* and *Cashing
   restrictions*. **Column 2 is the condition**, and for item 104 it reads "where the
   member's preserved benefits in the fund at the time of the termination are less than
   **\$200**". "Nil" is column 3. So the threshold is \$200, and the r 65B minimum for a
   pension is 25 × \$200 = **\$5,000**. The same threshold drives r 53(2): a preserved
   benefit made up wholly of member benefit and under \$200 is paid out. The loader rejects
   a `pensionShare` above 0 when the employer benefit is under \$5,000. The figure is a
   constant read from the Regulations, not an indexed amount.

## 6. Design

### 6.1 Start-drawing date on each super account (D1, D2)

- New optional account field `drawStartDate` (super and MSBS), saved with the plan because
  it is a household choice, unlike `minimumAge`.
- **Effective start** = the draw date clamped into the account's **lawful window**: §6.2
  for an ordinary account, §5.4 for MSBS. A date before the window moves to its start, as
  design 117 already does for the 401(k) rollover. An MSBS date after the 65th birthday
  moves to it, and becomes a lump sum (r 53(1)).
- **A free date** (Q2), as design 117 requires of every new moment-in-time field, with a
  plain date input in the editor. It is not anchored. The sweep `acct.<key>.drawStartDate`
  is searched like other unanchored dates, as a month count, so "draw MSBS at 55 vs 60 vs
  65" is a single lever, and the grid can also try any month between.
- `penalty-free-availability.js` reads the effective start instead of `minimumAge`. Pools,
  net liquidity and drawdown all go through it, so they follow automatically.
- `superEarningsTaxRate` takes the account and date instead of the age. It returns 0 from
  the effective start, and 15% before it.

### 6.2 Lawful release date for an ordinary account (D3)

A pure function in the AU account module:

```
releaseDate(person, jobs) =
  min( date of 65th birthday,
       max( preservation-age birthday, end of the last job ),     reg 6.01(7)(a), (b)(ii)
       end of any job that ends on or after the 60th birthday )   reg 6.01(7)(b)(i)
```

The third term was added when building phase 2. Reg 6.01(7)(b)(i) releases a member aged
60 or over when any employment arrangement ends, even if another job follows.

Preservation age comes from the reg 6.01(2) table by birth date, which replaces the
hardcoded 60. A person with no jobs gets preservation age. The same table gives the
preservation age that r 83 and r 84 use for MSBS.

### 6.3 Contributions to a chosen fund (D4)

- Each job gets an optional `superAccountKey`. The payroll handler sends that job's SG,
  sacrifice and personal contributions to it. Otherwise it uses the person's first super
  account. A job with no matching fund gets no AU contribution, and a loader warning.
- A job cannot name an `MsbsAccount`: the scheme is closed to this member, and no
  contribution reaches it (loader error).
- Remove the owner-less `getStateKey(SUPER)` fallback.
- `_auSuperKeyFor` (`tax-settle-classes.js`) already prefers the recorded key. The caps
  and total-super-balance tests must **sum across all of a person's super accounts**, not
  read one. That is a correctness fix in its own right once a person has two funds.

### 6.4 The MSBS account (D5)

The account holds a **preserved** benefit only (Q1). It is authored from the member's
latest CSC statement. Service and salary are not rebuilt, so Sch 6 to 8 are not
modelled.

`MsbsAccount extends SuperannuationAccount`. Its invested balance (holdings, returns,
earnings tax, the allocation editor) is the **member benefit**, with the ancillary benefit
folded in (§5.6 item 3). The **funded employer benefit** is a second invested sleeve,
held at CSC's Balanced allocation and not the member's choice (§5.6 item 2). It adds:

| Field | Meaning | Source |
|---|---|---|
| `unfundedEmployerBenefit` | The unfunded part of the employer benefit on `statementDate` | r 61A |
| `fundedEmployerBenefit` | The funded part on `statementDate`, which opens the Balanced sleeve | Sch 1; PDS §3 |
| `fundedAllocation` | The Balanced option's target mix, defaulted from the PDS and editable, since CSC changes it | PDS §5 |
| `serviceEndDate` | When the member left the ADF, which opens the draw window | r 52(1A) |
| `officerOnExit` | Whether the member was an officer when they left; picks the column of the valuation table | Approval Sch 1 Pt 4 Table 1 |
| `drawStartDate` | The draw date (D6), a free date | r 52, r 53 |
| `pensionShare` | 0, or 0.5 to 1; default 1 (D7) | r 52(1)(c) |

State the sim keeps on the account:

- **Before the draw**: the unfunded employer benefit, which is **not** a balance. It is
  indexed each 1 July by the March-quarter CPI on the never-falls rule (r 61A, effective
  1 July under r 61D(b)), and never enters drawdown or net liquidity. Rule 61B adds a
  proportionate part-year increase from the date the benefit becomes payable (r 61D(a)).
  Phase 4 reads r 61B before building it. Both invested sleeves earn returns on their own
  allocations. Neither is reachable by drawdown before the draw: both are preserved.
- **On the effective draw date**: one `MSBS_ELECTION` event. The employer benefit is the
  indexed unfunded part plus the funded sleeve. The event converts
  `pensionShare` of it into a pension (funded part included, r 65A) at the Sch 5 rate for the owner's age that day,
  and pays the rest as a lump sum (D8). The member benefit then follows the ordinary
  release rules for the owner's own account (§6.2).
- **After it**: a monthly `MSBS_PENSION` income, paid to the AU cash account like Social
  Security, and indexed twice a year by CPI on the never-falls rule (r 56). CPI comes
  from the model's AU inflation path, so stochastic runs index the pension consistently
  with the rest of the plan.

Where it shows: the pension is income, not an asset. Net worth carries both invested
sleeves. The employer benefit is reported as a
side figure ("MSBS employer benefit, not in net worth"), the same treatment Social
Security gets.

The maximum benefit limit (r 5, Sch 3) does not arise, because it applies only while
contributing.

**Tax** (§5.6 items 5 and 6). The pension is split into a taxed part and an untaxed part,
in proportion to the funded and unfunded amounts converted. Each part is tracked
separately so the offsets can apply:

- From preservation age to 60, the untaxed part is assessable at marginal rates
  (s301-110), and so is the taxed part, with a 15% offset (s301-25; MS08).
- At 60 or over, the taxed part is tax-free, and the untaxed part is assessable with a 10%
  offset (s301-100), capped under s303-3.

A lump sum rolled into the ordinary account carries its untaxed element. That element
pays 15% in the receiving fund, which the rollover reducer deducts. A lump sum paid as
cash is taxed under s301-95/-105.

**Total super balance** (§5.6 item 7). Before the draw, the account contributes
`FDB × FDBF + UDB × UDBF + MB` at 30 June, with factors from Approval Table 1: the
male column, picked by `officerOnExit`, and interpolated by month. After the draw, it
contributes `P × PF` from Table 4A. The two tables go into a data module transcribed from
`docs/au-tax/FLSR-2025/F2026C00100VOL03.txt`, never from model output. §6.3's
summed total super balance then includes the MSBS account.

### 6.4.1 As built (phase 4)

- **Still a super account.** `MsbsAccount extends SuperannuationAccount` keeps type `super`
  and role `super`, so the member benefit gets the release gate, the earnings tax, holdings
  and the total-super-balance sum with no new branches. `scheme: 'MSBS'` marks it. The
  election is its draw start: `auSuperDrawStartMs` takes the later of the release date and
  the draw date clamped into the §5.4 window.
- **The employer benefit is two numbers on the state entry**, `employerBenefit: { funded,
  unfunded, fundedAllocation, cpiPeak }`, not holdings. So no draw, rebalance or pool can
  reach it, by construction rather than by a guard in each.
- **Funded part**: grown on the year-end super earnings event, at the mix's market returns
  less 15% on income (an equity market's yield; all of a bond or cash rate), the way CSC
  credits a unit price. Franking is not modelled on it. The Balanced mix (PDS ed. 10, 31 Oct
  2025) maps to the model's classes as 74.5% equity (shares, property, infrastructure,
  alternatives), 12.5% bonds, 13% cash. The PDS does not split shares by market, so the
  default is half Australian and half international; the editor can change it.
- **Unfunded part**: indexed on the AU period advance (1 July), after the inflation reducer,
  by the rise in the model's AU CPI level over `cpiPeak`, rounded to 0.1% (r 61E(3)). The
  model's CPI is annual, so the March-quarter index is approximated by the year's level.
- **Both stop at the election**; phase 5 pays them.
- **Net worth** counts the funded part and not the unfunded one. The allocation cube adds one
  `employer-benefit` row per mix class so it still ties to net worth (design 82 §3).
- **Total super balance**: the 30 June that ends each year, from Table 1 (male columns,
  `officerOnExit` picks officer or other ranks), interpolated by month.
- **`statementDate` dropped.** Growing or indexing from a date before the run would need the
  CPI and returns from before it, which the model does not have. The statement figures are
  taken as at the start of the run.
- **No contribution reaches it**: a job naming it fails to load, the Jobs editor does not
  offer it, and the "first fund" fallback skips it.
- **Worked example**: the AU Single Homeowner (born 1 Jul 1981) left the ADF on 30 Jun 2014
  as other ranks, with an AUD 60,000 member benefit, 25,000 funded and 140,000 unfunded, and
  a draw date of 1 Jul 2041 (age 60). The flat salary became two jobs at the same pay. The
  current one pays the existing fund until 1 Jul 2036, and the next one pays a second fund
  opened for it. The two static wage and retirement params went with the flat salary;
  the jobs' generated `job.` levers sweep them now.
- **Not yet**: the unfunded part as a side figure in the panels (phase 6).

### 6.5 Retire the dormant handlers

Delete `SuperWithdrawal*Handler` and the `*_APPLY` reducers that read `state.superAccount`,
or key them to `stateKey`. Check `tests/` first: they back reducer-postcondition and
spending-classification tests.

## 7. Phasing

| Phase | Scope | Golden impact |
|---|---|---|
| 0 | Sources: **DONE** 5 Oct 2026 (§5.6, §5.7) | none |
| 1 | **BUILT.** Multiple funds: job `superAccountKey`, remove the fallback, sum caps across funds. `super-fund-key.js`; the downsizer uses the same resolver; tests `super-fund-routing.test.mjs` | none expected; a plan with one fund per person is unchanged |
| 2 | **BUILT.** Lawful release date and the preservation-age table (`super-release.js`), read by the drawdown walk, pool metrics, net liquidity and the unlock date. Also releases at the end of any job held at 60+ (reg 6.01(7)(b)(i)), which §6.2's formula left out. Tests `super-release.test.mjs` | none moved: every golden run ends before its AU members reach 60 |
| 3 | **BUILT.** `drawStartDate` on ordinary accounts, pension phase from the effective start, the date sweep. `auSuperDrawStartMs` (`super-release.js`) is the one effective start: the gate and `superEarningsTaxRate(drawStartMs, asOf)` both read it, so the bond-income and capital-gain reducers follow. Lever `acct.<key>.drawStartDate` (Opt only, no `sweepUnset`: blank is a default, not an absent event), declared in `AU_RETIREMENT.derivedState` so a rollout takes it from the candidate. Tests `super-draw-start.test.mjs` | two moved, both by fund tax a member now pays from 60 until their job ends: au-single-homeowner (works to 65) ends with \$206k less super, \$45k at retirement compounded over 20 years of drawdown; cross-border-reference (works to 61¾) \$11.6k less |
| 4 | **BUILT.** `MsbsAccount` from a statement: the fields, the member sleeve, the Balanced funded sleeve, the unfunded benefit with r 61A indexation, preserved before the draw; total super balance value from Table 1. `msbs.js`, `msbs-classes.js`, `msbs-valuation-factors.js` (parsed from the Approval text). The AU Single Homeowner plan is the worked example (§6.4.1). Tests `msbs-preserved.test.mjs` | au-single-homeowner moved: the plan gained two jobs, a second fund and the MSBS account |
| 5 | MSBS draw: the window, `MSBS_ELECTION`, the Sch 5 pension and r 56 indexation, the lump-sum routing, `pensionShare`; pension tax with the taxed/untaxed split and the defined benefit income cap; total super balance from Table 4A; survivor pension at 67% after checking Part 4 Div 2 | none (new account type) |
| 6 | Help topics (`help/nodes/account.md`, `job.md`), editors, restamp | none |

## 8. Not in this design

- **A serving MSBS member** (Q1): contributions (r 4, r 10), the employer benefit
  formula (Sch 6 to 8, whose scope for an ordinary member is unconfirmed), and the
  maximum benefit limit.
- **ADF Super.** It is an accumulation fund, and the Trust Deed provides for an MSBS
  member moving to it (r 14A). An ordinary super account models it already, once phase 1
  routes contributions to it.
- **DFRDB**, the earlier military defined-benefit scheme.
- **Invalidity benefits** (Part 3 Div 2) and **redundancy, limited tenure, or a retiring
  age below 55** (r 13), including the immediate pension under r 13(4).
- **Early release** of a preserved benefit for incapacity, compassionate grounds or
  hardship (r 51).
- **Partial member-benefit draws** under r 49 (multiples of \$10,000) before the member
  benefit is otherwise released.
- **Transition-to-retirement income streams.**
- **The transfer balance cap** on pension phase, including the special value of a
  defined-benefit pension (already elided, design 77 §4.2).
- **Minimum pension drawdown rates** once pension phase starts on an ordinary account.
- **Family law splits** (Part 13).

## 9. Questions for the author — answered 5 Oct 2026

1. **Serving, or left with a preserved benefit?** Left with a preserved benefit. The
   account is authored from a CSC statement (§6.4), and a serving member moves to §8.
2. **A year, or a date?** A date, with no year stepping (D1, §6.1).
3. **Default to a full pension, or the r 53(1) lump sum at 65?** A full pension
   (`pensionShare` 1, D7).
4. **Block or warn when working between 60 and 65?** Whichever is easier: blocking (D3).
5. **Where did 67 come from?** A misunderstanding; dropped (§1).
