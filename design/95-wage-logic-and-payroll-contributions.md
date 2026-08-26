# 95 — Wage logic: splits, payroll contributions, and the taxes on a paycheque

**Status** (2026-08-25): **P0–P5 COMPLETE**, P6–P9 pending. P4 fixed the model's largest
standing omission (§13.5); P5 closed the orphaned `usWithheldYTD` (§13.6).

**One open gap carried out of P5:** the tax-paid report understates US federal tax by the
withheld amount — §13.6, and the first thing to fix in P6. Six decisions locked (§3), seven review
questions answered (§16), every source on disk (§4).

**D7 was corrected by measurement during P0** — a single `PAYROLL` event cannot reproduce the
existing month-end ordering, because it would have to straddle two other events. What shipped is
one handler at two queue positions. §5.2 has the evidence; the correction is the useful part of
this phase, not an embarrassment to it.

**Read §9.2 first if you know the old SG rules.** The *Treasury Laws Amendment (Payday
Superannuation) Act 2025* replaced the quarterly maximum contribution base with an **annual,
per-employer** one that is *derived from the concessional contributions cap*, effective
1 July 2026. That deletes an indexed threshold, a quarterly/annual mismatch risk, and a source
dependency from this design.

This design takes the wage from a single number credited whole to one account, and makes it
the **payroll event it actually is**: a gross figure that has statutory taxes and elective
contributions taken out of it in a defined order, with what survives distributed across
several accounts.

Three asks drive it:

1. splitting a wage across multiple destination accounts;
2. a US pre-tax 401(k) deferral with a real employer match formula; and
3. Australian Super — the employer's Guarantee on top of salary, plus the member's own
   contributions.

Answering any of the three honestly drags in the tax machinery that sits between gross pay and
take-home, most of which this model does not have. §2.4 is the uncomfortable part: **FICA is
not modelled anywhere**, so every US working-year projection this model has ever produced
overstates take-home pay by roughly 7–8% of wages.

---

## 1. What already exists

More than a first look suggests. The 19 Aug 2026 payroll work built most of the contribution
plumbing; what it did not build is the *shape* of a real plan's rules.

| built | where | shape |
|---|---|---|
| Per-person monthly wage credit | `finance/handlers/monthly-wages-handler.js:73` | Iterates `state.people`, filters on `monthlyWage > 0` and `retirementDate`, routes by `wageCurrency` (USD→US pool, AUD→AU pool), stamps `targetKey`, `personKey`, `workCountry`, `residency`. |
| Destination resolution | `finance/account-rules/cash-routing.js` | `resolveTransactionAccountKey(country, ownerId)` → the earner's flagged transaction account, else the household's, else the country savings role. |
| 401(k) deferral + match | `finance/handlers/retirement-contribution-handler.js:117` | `k401DeferralPct`, `k401EmployerMatchPct`, `k401AnnualCap`, both as flat fractions of annual pay. |
| IRA / Roth | same file | Flat annual dollar amounts, paid in twelfths. |
| AU Super Guarantee | same file, `AuSuperGuaranteeHandler` | `guaranteePct` × annual pay, `employerFunded: true`. |
| `employerFunded` semantics | `us/k401-classes.js:49`, `au/au-super-classes.js:100` | Employer money skips the member's cash debit **and** their deduction. Correct, and load-bearing. |
| Div 295 contributions tax | `au/au-super-classes.js`, `tax/au/super-tax-rate.js` | The fund withholds 15% as the contribution is received; net lands in `balance` and `contributionBasis` together, so the basis invariant survives. |
| Self-employment | `monthly-wages-handler.js:93`, `tax/us/us-tax-rates-base.js:185` | `person.selfEmployed` routes to the SE apply path; SECA computed at settle with the §164(f) half-deduction. |

### 1.1 The two design ideas worth preserving

**`employerFunded` is the whole trick.** An employer match and the Super Guarantee never pass
through the member's paycheque. Debiting cash for them double-charges the household; deducting
them hands relief on income never received; and for Super, treating an SG contribution as the
member's money taxes one dollar twice — once at their marginal rate, once at the fund's Div 295
rate. Everything this design adds must preserve that flag's meaning.

**Annual figures, monthly instalments.** Contributions derive each month's amount as a twelfth
of the *capped annual* figure, so a cap binds exactly without a year-to-date accumulator in
state — one less field that can survive a rewind in a stale condition. §7.3 explains why this
design has to abandon that for the tiered match and the statutory caps, and what it puts in its
place.

---

## 2. What is missing

### 2.1 Splitting does not exist

`MonthlyWagesHandler` resolves exactly **one** `targetKey` per person and emits **one** apply
action carrying the whole wage. There is no split concept anywhere in the model — no field, no
action shape, no reducer that fans one credit into several.

### 2.2 The 401(k) match is not a match

`k401EmployerMatchPct` is a flat percentage of salary applied **independently of what the
employee deferred**. That is a *non-elective* contribution, not a match. "Matching up to 3% of
salary" is a function of the deferral — an employee deferring 1% gets 1%, not 3% — and the
current shape cannot express it. The parameter is also a **household scalar**: every earner in
the household defers the same percentage into their own plan.

### 2.3 Super has a rate and nothing else

`superGuaranteePct` is a bare parameter with an optional authored cap. Absent: the SGAA
maximum contribution base, the Div 291 concessional cap and its carry-forward, Div 293, the
Div 292 non-concessional cap, and any member-contribution path driven off payroll.
`SuperContributionHandler` (`au-super-classes.js:239`) takes a hand-authored fixed `data.amount`
— fine for a one-off ConfigBuilder event, useless for "sacrifice 5% of salary until 65".

### 2.4 FICA is absent, and `usWithheldYTD` is a dead accumulator

**Two separate findings, both material.**

`us-tax-rates-base.js` computes SECA (§1401), the 0.9% Additional Medicare surtax (§3101(b)(2))
and NIIT — but **not FICA itself**. There is no 6.2% OASDI and no 1.45% Medicare on wages
anywhere in the model. A W-2 earner in this simulation pays income tax and nothing else, so
their take-home is overstated by up to 7.65% of pay below the wage base. This has been true of
every US working-year projection the model has produced.

Separately: `WagesWithheldApplyReducer` (`us/us-income-classes.js:105`) increments
`usWithheldYTD` — and **nothing reads it**. It does not appear in the settle reducer's YTD reset
list (`tax/tax-settle-classes.js:32`), so it is not merely unused, it is orphaned: it accumulates
monotonically for the life of the run and never offsets a liability. Any withholding this design
introduces has to build the credit leg, because there isn't one. See the
`config-field-in-state-is-not-read` pattern — a field being written is not evidence it is read.

### 2.5 Contribution elections are household-wide

Every knob in §1's table lives in the toolset param bag, shared across all earners. Once wages
split per person, elections must too — you cannot have one spouse sacrificing into Super and
the other not.

---

## 3. Decisions locked

| # | Decision | Chosen |
|---|---|---|
| D1 | Split shape and basis | **Per-person ordered list on `Person`, applied to pay net of pre-tax deductions.** Retirement deferrals and statutory withholding come off the gross first; the remainder is split; the unallocated residue falls to the transaction account. |
| D2 | Statutory limits | **Real limits from the authority, indexed forward on a schedule.** Transcribe the published base into a versioned rates module and index with the existing machinery (§11). |
| D3 | Employer match formula | **General tier list** — `matchTiers: [{ matchRate, uptoPctOfComp }]`. Default `[{ 1.00, 0.03 }]`. Safe-harbor and 50%-on-6% become data, not code. |
| D4 | Additional tax mechanics in scope | **All four**: FICA (OASDI + Medicare), AU Div 293, SGAA maximum contribution base, Div 291 concessional cap with s291-20 carry-forward. |
| D5 | AU member contribution paths | **Salary sacrifice, personal deductible (s290-150), and non-concessional.** Co-contribution / LISTO out of scope — they bite only at low incomes. |
| D6 | Withholding vs annual accrual | **Withhold monthly, true up at the annual settle.** Wages are credited net; the split then divides genuine take-home. |

Four more were settled in review on the same day, after the sources came in:

| # | Decision | Chosen |
|---|---|---|
| D7 | Event structure | ~~One `PAYROLL` event~~ → **one `PayrollHandler` at TWO queue positions**: `PAYROLL` (order 0) and `PAYROLL_CONTRIBUTIONS` (order 1). Corrected during P0 — see §5.2. |
| D8 | Cap enforcement | **Track and clamp**, journaling the clamp. Not warn-and-proceed. §7.3. |
| D9 | SG base per-employer scoping | **Single accumulator now**, shaped so a second employer extends rather than rewrites. §9.2. |
| D10 | Bonuses | **Explicitly out of scope.** Splits do not apply to `BONUS`. §6.4. |

D6 is the expensive one and it is worth being explicit about why. Every other tax in this model
accrues to a YTD accumulator and is paid in one debit at the annual settle. Withholding breaks
that symmetry deliberately: D1 makes the split operate on take-home, and a split of a figure the
household never actually receives is a split of a fiction. It will move every golden fixture
that has a working earner (§14.4).

---

## 4. Sources

Per the standing rule — **never quote tax law that is not on disk**. What follows was fetched
into `docs/` as part of this design, and every figure below is quoted from the file named.

### 4.1 US — fetched 25 Aug 2026, GPO/govinfo, US Code 2024 edition

Path pattern `https://www.govinfo.gov/content/pkg/USCODE-2024-title26/html/{name}.htm`, converted
to text and stored in `docs/us-tax/` under the same names as the existing §904 / §988 files.

| File | Gives us |
|---|---|
| `…subpartA-sec401.txt` | §401(a)(17) compensation limit (base **\$200,000**, base period Q3 2001, rounded down to a multiple of \$5,000); §401(k)(12)–(13) safe-harbor match. |
| `…subpartA-sec402.txt` | §402(g)(1)(B) elective deferral limit (base **\$15,000**); §402(g)(4) COLA — indexed as under §415(d), base period Q3 2005, rounded **down** to a multiple of \$500. |
| `…subpartB-sec414.txt` | §414(v) catch-up contributions; §414(v)(7)(A) the SECURE 2.0 Roth catch-up mandate. |
| `…subpartB-sec415.txt` | §415(c)(1) annual additions — lesser of base **\$40,000** or 100% of compensation. |
| `…partVII-sec219.txt` | IRA deduction limits and the §219(g) active-participant phase-out. |
| `…subpartA-sec408A.txt` | Roth IRA contribution limit and §408A(c)(3) AGI phase-out. |
| `…chap21-subchapA-sec3101.txt` | Employee FICA: OASDI and HI rates, and the §3101(b)(2) Additional Medicare surtax. |
| `…chap21-subchapB-sec3111.txt` | Employer FICA. |
| `…chap21-subchapC-sec3121.txt` | §3121(a)(1) — "wages" and the contribution and benefit base by reference to SSA §230. |

**The statute gives bases, not current numbers.** \$15,000 and \$40,000 are 2006 and 2002 base
amounts. The indexed figures come from the IRS COLA notice:

`docs/us-tax/IRS-Notice-2025-67-Retirement-COLA-2026.txt` — **2026 amounts**, verbatim:

| Provision | 2025 | 2026 |
|---|---|---|
| §402(g)(1) elective deferral | \$23,500 | **\$24,500** |
| §414(v)(2)(B)(i) catch-up, 50+ | \$7,500 | **\$8,000** |
| §414(v)(2)(E)(i) catch-up, age 60–63 | \$11,250 | **\$11,250** (unchanged) |
| §415(c)(1)(A) annual additions | \$70,000 | **\$72,000** |
| §401(a)(17) compensation limit | \$350,000 | **\$360,000** |
| §219(b)(5)(A) IRA | \$7,000 | **\$7,500** |
| §219(b)(5)(B)(ii) IRA catch-up 50+ | \$1,000 | **\$1,100** |
| §414(v)(7)(A) Roth catch-up wage threshold | \$145,000 | **\$150,000** |

That last row is not incidental. Under SECURE 2.0, an employee whose prior-year FICA wages from
the employer exceed the threshold **must** designate their catch-up contributions as Roth. For a
high earner reaching 50 mid-simulation this silently converts \$8,000/yr of deduction into
\$8,000/yr of after-tax basis. §7.5.

### 4.2 AU, income tax — ITAA 1997, already on disk

`docs/au-tax/ITAA-1997/C2026C00324VOL06.txt`, Compilation No. 266, compilation date 1 Jul 2026,
Authorised Version C2026C00324. Verified to contain, verbatim:

- **s291-20(2)** — concessional contributions cap: **\$25,000** for 2017-18, indexed annually
  thereafter under Subdiv 960-M. Note to the subsection: *"annual indexation does not necessarily
  increase the amount of the cap: see section 960-285."*
- **s291-20(3)–(7)** — five-year carry-forward of unused cap. Conditions: contributions would
  otherwise exceed the cap; **total superannuation balance just before the start of the year is
  less than \$500,000**; unapplied unused cap exists for one or more of the previous 5 years.
  Applied **earliest year first** (s291-20(5)). No unused cap accrues for a year earlier than
  2018-19 (s291-20(7)).
- **s291-25** — what counts as a concessional contribution.
- **s292-85(2)** — non-concessional cap is **4 × the s291-20(2) cap**, and **nil** if total super
  balance at the start of the year is at or above the general transfer balance cap. The note is
  explicit that the carry-forward increase under s291-20(4) is *not* taken into account.
- **s292-85(3)–(7)** — three-year bring-forward, gated on age under 75 and on first-year cap space.
- **s293-15 / s293-20** — Div 293 tax is payable on *taxable contributions*, being the lesser of
  low-tax contributions and the excess of (income for surcharge purposes + low-tax contributions)
  over **\$250,000**.
- **s290-150** — personal contributions are deductible subject to the conditions in ss290-155,
  290-165, 290-167, 290-168, 290-169 and **290-170** (notice of intent).

### 4.3 AU, Super Guarantee — SGAA 1992, fetched 25 Aug 2026

`docs/au-tax/SGAA-1992/C2026C00272.txt` — **Compilation No. 78, compilation date 1 July 2026**,
Authorised Version C2026C00272, including *Treasury Laws Amendment (Payday Superannuation) Act
2025* (Act No. 57, 2025). Downloaded manually from the Federal Register (the site is an Angular
SPA and AustLII returns 403; see `tax-authority-sites-block-fetch`) and converted with
`pdftotext -layout`.

**This compilation does not contain the provisions the pre-Payday-Super literature describes.**
There is no s15 "maximum contribution base" and no s19 charge percentage. Both concepts survive
under new numbers and materially new shapes:

| Provision | Text |
|---|---|
| **s10A(1)** | *Qualifying earnings* — ordinary time earnings, commissions, directors' fees, and **(h) salary-sacrificed reductions**. |
| **s10A(3)** | Exclusions — reversals of sacrificed contributions, and prescribed classes. |
| **s10A(5)** | *Maximum contributions base* = `concessional contributions cap ÷ charge percentage × 100`, **rounded down to the nearest \$10**. The cap referenced is the **basic** concessional cap under ITAA 1997 for the financial year of the payment. |
| **s10A(6)** | The base is tested against **total qualifying earnings during the financial year in relation to that employer**. Past it, a payment counts as nil. |
| **s17A(2)** | Individual SG amount = `qualifying earnings × charge percentage ÷ 100`, where **"charge percentage means 12"** — a literal in the Act, not a schedule. |
| **s17B** | An employer shortfall exemption certificate is modelled as the employee having already reached the base. |

Three consequences, each of which deletes something from this design:

1. **The SG rate is 12, stated in the statute.** The step-up schedule has finished. The existing
   `superGuaranteePct` param's note that this model "carries no SG rate table" is now moot — there
   is nothing to schedule.
2. **The maximum contributions base is derived, not published.** It falls out of the concessional
   cap and the charge percentage, so it needs no independent indexed figure and cannot drift out of
   step with the cap. For **2026–27**: `32,500 ÷ 12 × 100 = 270,833.33`, floored to \$270,830.
3. **Salary sacrifice does not reduce SG.** s10A(1)(h) counts the sacrificed reduction as
   qualifying earnings, so SG is computed on **pre-sacrifice** pay. This is the anti-avoidance rule
   now embedded in the definition, and it is the opposite of the PAYG treatment in §5.

### 4.4 The applied figures

The statutes above give **base amounts and indexation rules**; these give the applied results.
All fetched 25 Aug 2026. Per [[published-base-guard]] these are transcribed from the authority,
never compounded forward from the base by our own series.

**`docs/au-tax/ato-rates/ato-contributions-caps.txt`** (ATO, *Contributions caps*):

| Financial year | Concessional cap (s291-20(2)) | Non-concessional cap (s292-85(2)) |
|---|---|---|
| **2026–27** | **\$32,500** | **\$130,000** |
| 2025–26 | \$30,000 | \$120,000 |
| 2024–25 | \$30,000 | \$120,000 |
| 2021–22 → 2023–24 | \$27,500 | \$110,000 |
| 2017–18 → 2020–21 | \$25,000 | \$100,000 |

The non-concessional column is **exactly 4×** the concessional column in every row, which is
s292-85(2) confirmed against the regulator's own published table rather than inferred. The design
should compute it, not carry it.

**`docs/au-tax/SGAA-1992/Super-Sustaining-Contribution-Concession-Imposition-Act-2013.txt`** —
s5: *"The amount of the tax is 15% of a person's taxable contributions for an income year."*
The Div 293 rate is now sourced, not assumed.

**`docs/us-tax/SSA-COLA-Fact-Sheet-2026.txt`** — the §3121(a)(1) contribution and benefit base that
Title 26 defers to SSA §230 for:

| | 2025 | 2026 |
|---|---|---|
| OASDI maximum taxable earnings | \$176,100 | **\$184,500** |
| Medicare (HI) | No limit | No limit |
| OASDI rate / HI rate | 6.2% / 1.45% | 6.2% / 1.45% |
| Additional Medicare (over \$200k / \$250k MFJ) | +0.9% | +0.9% |

The fact sheet is explicit that the 7.65% combined figure **excludes** the 0.9% surtax — which the
model already computes separately at `us-tax-rates-base.js:201`, so the two must not be summed.

---

## 5. The pipeline

Everything in this design is one ordering question. Today a wage is a single credit. It becomes
a **four-stage pipeline**, and the stages are not interchangeable — each one's base is the
previous one's output.

```
  GROSS WAGE  (person.monthlyWage)
      │
      ├─ (1) PRE-TAX / SACRIFICED  — reduces taxable pay
      │       US: 401(k) deferral, §125 pre-tax (not modelled)
      │       AU: salary sacrifice to Super
      │
      ├─ (2) STATUTORY WITHHOLDING — computed on the base each tax defines
      │       US: FICA OASDI+HI  (on gross, NOT reduced by 401(k) deferral)
      │       US: income tax withholding (on pay net of stage 1)
      │       AU: PAYG withholding (on pay net of sacrifice)
      │
      ├─ (3) AFTER-TAX PAYROLL     — from take-home, no deduction
      │       US: Roth 401(k), after-tax IRA
      │       AU: personal deductible (s290-150), non-concessional
      │
      └─ (4) NET PAY → SPLIT across destination accounts (D1)

  EMPLOYER-SIDE, parallel and never touching the paycheque:
       US: 401(k) match          ─┐
       AU: Super Guarantee       ─┴─ employerFunded: true

  NOTE: the SG base is PRE-sacrifice pay (SGAA s10A(1)(h)) — stage 1 reduces
        the PAYG base but NOT the SG base. See §5.1.
```

### 5.1 The one rule most models get wrong

**A 401(k) deferral reduces income tax but NOT FICA.** §3121(a) defines wages for FICA purposes
without the §402(g) exclusion; elective deferrals are wages for FICA and are not for income tax.
Salary sacrifice to Super is the opposite — it genuinely never becomes the employee's income at
all, which is why it reduces the PAYG base.

So stage 2 has **two different bases** on the US side, and they must not be collapsed into one.
Getting this wrong understates FICA by the deferral rate — for a maximal deferrer, by about
\$1,900/yr. This asymmetry is the single most likely place for this design to be quietly wrong,
and §14.1 puts a test directly on it.

**Australia has the mirror-image asymmetry, and it points the other way.** Salary sacrifice *does*
reduce the PAYG withholding base — it is never the employee's income — but it does **not** reduce
the Super Guarantee base, because SGAA s10A(1)(h) counts the sacrificed reduction as qualifying
earnings. So in both countries a pre-tax contribution reduces one base and not the other; the
countries simply disagree about which. A single "taxable pay" figure feeding every downstream
calculation is wrong in four distinct ways, and it is the obvious thing to build.

### 5.2 Event ordering

Contributions currently fire at `order(1)`, after wages and expenses at `order(0)`, so a
deferral cannot overdraw the pool into the drawdown cascade. The pipeline makes that ordering
**structural rather than defensive**: stages 1–3 are computed from the wage *before* anything is
credited, and the split in stage 4 credits only what survives. Nothing can overdraw, because
nothing is spent that was not first credited.

**D7, as corrected by measurement.** The draft called for a single `PAYROLL` event. Building P0
disproved it. The month-end sequence, read off the journal of `us-single-homeowner`, is:

```
  LOAN_PAYMENT_APPLY
  WAGES_INCOME_APPLY          ← MONTHLY_WAGES, order 0
  EXPENSE_DEBIT ×3            ← MONTHLY_EXPENSES, order 0
  US_SAVINGS_INTEREST_CREDIT
  K401_CONTRIBUTION_APPLY …   ← US_RETIREMENT_CONTRIBUTION, order 1
```

Wages and contributions **sandwich** two other events. A single event fires at one queue
position and cannot straddle them. And the straddle is not cosmetic:
`UsSavingsInterestMonthlyHandler` reads the **live** balance
(`us-savings-interest-handler.js:59`), not a period-start snapshot, so moving contributions ahead
of the interest credit lowers the balance interest accrues on by the entire deferral — about
\$2.50 a month on the reference household, every month, compounding for the whole run. The
exact-match goldens catch that every time, and correctly.

**So the COMPUTATION is unified and the EMISSION is split.** One `PayrollHandler` class holds the
pipeline; it is scheduled twice, as `PAYROLL` (order 0, income) and `PAYROLL_CONTRIBUTIONS`
(order 1, contributions), and emits only its stage's slice on each call. `computePayroll()` is a
pure function of (date, state, params) — no memoisation, no writes — so calling it once per stage
is safe and, critically, needs **no figures stashed in state between the two events**. That
stashing was the fragility that argued against keeping three handlers in the first place, and
avoiding it is what makes the split acceptable rather than a retreat.

What D7 actually wanted survives intact: there is now **one** definition of "who is earning this
month, in what currency, into which account, and what is diverted from it", instead of three
copies that happened to agree. They already differed in one respect — only the wage path branched
on `selfEmployed`.

**Migration.** The new event is introduced **alongside** the existing three, not in place of them:

- A scenario with no `PAYROLL` schedule behaves exactly as today. The three legacy events keep
  their handlers, which are untouched.
- `PAYROLL` is what the toolsets schedule for new and rebuilt scenarios; the legacy handlers stay
  registered so saved scenarios and hand-authored ConfigBuilder events keep replaying.
- The legacy handlers are removed only after the goldens have been re-cut on the `PAYROLL` path
  (P5), so at no point is there a change that both moves numbers and deletes the old path.

This is the same coexistence pattern design 93 used for the SCALAR/UNITISED split, and for the
same reason: a migration that cannot be run twice is a migration that cannot be debugged.

---

## 6. Wage splits (D1)

### 6.1 Shape

```
person.wageSplits = [
  { destinationKey: 'usSavingsAccount',      mode: 'PERCENT', value: 0.60 },
  { destinationKey: 'spouseSavingsAccount',  mode: 'PERCENT', value: 0.20 },
  { destinationKey: 'brokerageAccount',      mode: 'FIXED',   value: 1000 },
]
```

Ordered. `FIXED` amounts are taken first in list order, then `PERCENT` slices of the *original*
net (not of the post-fixed remainder — a percentage of a shrinking base is unintuitive and
order-dependent). Anything unallocated goes to the transaction account resolved exactly as today,
so **an empty or absent `wageSplits` reproduces current behaviour byte for byte**.

### 6.2 Rules

- **Shortfall.** If fixed amounts exceed net pay, satisfy in list order and stop; later entries
  get nothing. Never overdraw, never escalate into drawdown. A wage event is not a spending event.
- **Percentages over 100%.** Normalise and warn once per session, in the style of
  `resolveBonusEarner`'s fallback warning.
- **Currency.** Every destination must match the earner's `wageCurrency`. A cross-currency split
  is an INTL transfer with an FX leg and a §988 disposal, and routing one silently through a wage
  credit would produce currency from nowhere. Reject at validation with a clear message.
  See `disposal-currency-assumed-usd` for what happens when currency is assumed rather than checked.
- **Missing destination.** A `destinationKey` naming an account not in state falls through to the
  transaction account with a warning — never drops the money. Design 72's Gap 2 is the precedent:
  a destination stamped as an account *id* rather than a state key silently sent proceeds to the
  cash pool. `resolveSaleDestinationKey` already handles both forms; splits must use it, not a
  bare `state[key]`.

### 6.3 Action shape

`WAGES_INCOME_APPLY` gains `splits: [{ targetKey, amount }]`, and the reducer credits each in
turn instead of one `targetKey`. `targetKey` stays, and stays authoritative when `splits` is
absent — legacy actions and saved scenarios replay unchanged. `RECORD_BALANCE` is emitted once
per distinct touched key, as `MonthlyWagesHandler` already does via its `touched` set.

The tax chain is **unchanged and must stay unchanged**: `WAGES_INCOME_TAX` carries the gross,
not the split slices. Splitting is a cash-routing concern with no tax consequence whatever. The
temptation to derive taxable income from what landed in accounts is exactly the bug class that
`residency-and-source-are-two-axes` describes — two independent axes fused because they happened
to be computed together.

---

### 6.4 Bonuses are out of scope (D10)

**Splits do not apply to `BONUS`, and this is deliberate.** `BonusHandler`
(`us-income-classes.js:384`) credits the whole bonus to the cash pool, resolving an earner via
`resolveBonusEarner`. That behaviour is unchanged by this design.

Real payroll treats a bonus as a separate cheque: its own supplemental withholding rate
(a flat 22% under §3402 for amounts under \$1M), frequently its own deferral election, and often
a different split. Modelling any of that means a second pipeline, not a flag on this one.

Recorded here so the next author does not read §6's silence about bonuses as an oversight and
"fix" it by routing `BONUS` through the wage splits — which would apply a wage's withholding
treatment to supplemental income and silently under-withhold.

---

## 7. US 401(k) (D3)

### 7.1 Per-person elections

Elections move to `Person`, exposed through the existing per-record param mechanism
(`scenarios/params/record-param-templates.js`, which already carries `monthlyWage` and
`retirementDate`):

```
person.k401 = {
  deferralPct:      0.10,    // fraction of eligible compensation
  deferralType:     'PRETAX' | 'ROTH',
  matchTiers:       [{ matchRate: 1.00, uptoPctOfComp: 0.03 }],
  afterTaxPct:      0,       // non-Roth after-tax; enables mega-backdoor, §415(c)-bound
}
```

The existing household-scalar params become **defaults** applied to any person without their own
election, so no scenario changes behaviour on upgrade.

### 7.2 The match

```
matched_pct = Σ over tiers of  matchRate_i × min(remaining_deferral_pct, uptoPctOfComp_i)
match       = matched_pct × eligible_compensation
```

Tiers consume the deferral in order. Your stated case — 100% on the first 3% — is
`[{ 1.00, 0.03 }]`. Safe-harbor basic (§401(k)(12)(B)(i)) is
`[{ 1.00, 0.03 }, { 0.50, 0.02 }]`. A 50%-on-6% plan is `[{ 0.50, 0.06 }]`. A non-elective 3%
contribution is *not* a match and gets its own field rather than being faked as a tier.

**Eligible compensation is capped at §401(a)(17)** — \$360,000 for 2026. Both the deferral
percentage and the match percentage apply to the capped figure. For a salary above the cap this
is the difference between a \$10,800 match and a \$15,000 one, and it is the single most commonly
omitted rule in retirement projections.

### 7.3 Caps, and why the twelfths trick has to go

Three caps bind, at different levels:

| Cap | 2026 | Applies to |
|---|---|---|
| §402(g)(1) | \$24,500 | Employee **elective** deferrals (pre-tax + Roth combined), across all plans |
| §414(v) catch-up | +\$8,000 (50+), +\$11,250 (60–63) | On top of §402(g) |
| §415(c)(1) | lesser of \$72,000 or 100% of comp | **All** annual additions: deferral + match + after-tax |
| §401(a)(17) | \$360,000 | The compensation *base* the percentages apply to |

The current handler derives each month as `min(annualPay × rate, cap) / 12`, which keeps the cap
exact with no state. That works only because the rate and the pay are both constant across the
year. It **breaks the moment any of the following is true**, and this design makes all three
reachable:

- a raise, or a mid-year change of election;
- retirement part-way through a year (11 months of pay, but a twelfth of the *annual* cap each
  month, so the cap under-binds);
- §415(c), whose base is the *sum* of three separate contribution streams.

So this design introduces **`k401ContributionsYTD` per person per tax year**, reset on the same
period boundary as the existing YTD accumulators (`tax-settle-classes.js:32`), and each month
contributes `min(elected_amount, remaining_cap)`. This is a real cost — a new stateful
accumulator that must survive rewind and branch correctly — and it is unavoidable.

**D8: track and clamp, and journal the clamp.** The cheaper alternative — compute the elected
contribution and merely *warn* on a breach — was rejected. A warning leaves the model projecting a
scenario the IRS would reject, and in a Monte Carlo run nobody reads the warnings. The clamp is
journaled so that "you elected 20% but §402(g) stopped you in September" is visible in the output
rather than inferred from a number being lower than expected.

### 7.4 Front-loading and the true-up

A high earner deferring 15% of a large salary hits §402(g) partway through the year, at which
point deferrals stop and the match stops with them — unless the plan has a true-up provision.
Whether the plan trues up is a real plan-document variable with a material effect. Model it as
`k401.trueUpMatch: boolean`, defaulting **true** (compute the match on the full-year deferral at
year end), because that is the more common large-plan design and the less surprising result.

### 7.5 The Roth catch-up mandate

§414(v)(7)(A): where prior-year FICA wages from the employer exceed the indexed threshold
(\$150,000 for 2026 per Notice 2025-67), catch-up contributions **must** be Roth. Implemented as
a forced flip of the catch-up slice's `deferralType`, not as an error — the participant does not
get a choice. It moves \$8,000–\$11,250/yr from deduction to after-tax basis for exactly the
earners these scenarios describe, and it interacts with design 84's s99B work, since Roth basis
is what that design prices.

---

## 8. US FICA and withholding (D4, D6)

### 8.1 FICA

From `docs/us-tax/…sec3101.txt` and `…sec3121.txt`:

- **OASDI**, §3101(a) — 6.2% of wages up to the §3121(a)(1) contribution and benefit base, which
  §3121 fixes by reference to **SSA §230**. That base is not in Title 26; it is now on disk in
  `docs/us-tax/SSA-COLA-Fact-Sheet-2026.txt` — **\$184,500 for 2026** (\$176,100 for 2025).
- **HI (Medicare)**, §3101(b)(1) — 1.45%, **uncapped**.
- **Additional Medicare**, §3101(b)(2) — 0.9% above the filing-status threshold. **Already
  modelled** at `us-tax-rates-base.js:201`; must not be double-counted.

**Base is gross wages, not reduced by the 401(k) deferral** (§5.1). It *is* reduced by genuine
§125 cafeteria-plan amounts, which this model does not have and which this design does not add.

**Coordination with SECA.** `usSsWagesYTD` already exists and already consumes the OASDI wage
base ahead of self-employment income (`us-tax-module-2026.js:834`) — the coordination is built,
it simply has no wages feeding it, because no wage event ever writes to it. Wiring FICA means
writing that accumulator, and the SECA path then works as designed for a person with both W-2
and SE income.

### 8.2 Withholding and the true-up leg

Per D6, wages are credited **net**. That requires three things, of which only the first exists:

1. A monthly debit of the withheld amount — `WAGES_WITHHELD_APPLY` already does this.
2. An accumulator the settle reads. `usWithheldYTD` is written and **read by nothing** (§2.4).
   This design makes the settle credit it against the computed liability and adds it to the US
   YTD reset list.
3. A withholding *estimate*. FICA is exact — a rate times a base. Income-tax withholding is not:
   real withholding follows the Form W-4 / Pub 15-T tables, which are not on disk and are not
   worth transcribing for this purpose.

For (3), the recommendation is a **`withholdingMethod` with three settings**:

| Setting | Behaviour |
|---|---|
| `FICA_ONLY` (default) | Withhold FICA exactly; income tax still settles annually in one debit. Honest about what it does and does not model. |
| `PRIOR_YEAR_SAFE_HARBOR` | Withhold FICA plus 1/12 of the prior year's total income-tax liability. Self-correcting, needs no tables, and mirrors the §6654(d) estimated-tax safe harbour a real household would use. |
| `NONE` | Current behaviour. Gross credit, everything at settle. Retained so existing goldens can be re-run unchanged. |

`FICA_ONLY` as the default is the conservative choice: it fixes the outright omission (§2.4)
without inventing a withholding table. `PRIOR_YEAR_SAFE_HARBOR` is what makes monthly cash flow
genuinely realistic, and it is one line of state (`priorYearUsTaxLiability`).

**Year one has no prior year.** Fall back to `FICA_ONLY` for the first tax year rather than
guessing, and say so in the journal.

---

## 9. Australian Super (D5)

### 9.1 The four contribution streams

| Stream | Funded by | Cash debit? | Deduction? | Div 295 15%? | Counts to |
|---|---|---|---|---|---|
| Super Guarantee | Employer | No | No | Yes | Concessional cap, Div 293 |
| Salary sacrifice | Employee, pre-tax | **No** — reduces the wage at source | n/a (never income) | Yes | Concessional cap, Div 293, **and the SG base** (s10A(1)(h)) |
| Personal deductible (s290-150) | Employee, after-tax cash | **Yes** | **Yes** (notice of intent) | Yes | Concessional cap, Div 293 |
| Non-concessional | Employee, after-tax cash | **Yes** | No | **No** | Div 292 cap only |

Salary sacrifice and personal deductible reach nearly the same place by different routes, and
the difference is exactly the kind of thing this model is for: sacrifice reduces the PAYG base
every payday, while a s290-150 contribution is paid from taxed cash and refunded through the
return. The cash-flow timing differs by up to a year even though the annual tax outcome matches.

`SuperContributionApplyReducer` already implements the personal-deductible path correctly —
gross debit from AU cash, net of Div 295 credited to balance and `contributionBasis` together,
`SUPER_CONTRIBUTION_TAX` chained. Salary sacrifice needs a **new action** rather than a reuse,
because it must reduce the wage before the AU tax action is emitted. Non-concessional needs a
third: **no Div 295 withholding at all**, and it credits the tax-free component.

That last one matters beyond Australia. Design 84 prices the s99B treatment of a Roth decant
off exactly this component split, and `downsizer-contribution.js` already carries the precedent
— it deliberately bypasses `SuperContributionApplyReducer` so its 15% shave does not apply, and
notes that routing a non-concessional amount through the concessional reducer "would split one
pool's character."

### 9.2 The Super Guarantee after Payday Super (SGAA s10A, s17A)

**Rewritten after reading Compilation 78.** The pre-1-July-2026 rules — a quarterly maximum
contribution base, indexed independently, and a charge percentage stepping up by financial year —
no longer exist. What replaced them is simpler and much easier to model correctly.

**The amount.** s17A(2): `individual SG amount = qualifying earnings × 12 ÷ 100`, with
*"charge percentage means 12"* written into the Act as a literal.

**The base.** s10A(5): the maximum contributions base is

```
  max_contributions_base = floor_to_10( basic_concessional_cap ÷ charge_percentage × 100 )
```

and s10A(6) tests it against **cumulative qualifying earnings for the financial year, per
employer**. Once cumulative earnings pass it, further payments are treated as nil for SG.

Four things follow, and they are all simplifications:

1. **No independent threshold to source or index.** The base is a function of the concessional
   cap. It cannot drift out of step with the cap, because it *is* the cap, rearranged. As built
   in P7 the statutory base ALWAYS applies and `superGuaranteeAnnualCap` survives as an optional
   scenario override **on top of** it — a scenario may model an employer contributing less than
   the SGAA requires, never more. It is measured against the SG's own running total, not the
   shared concessional pool; see §13.9.
2. **No quarterly/annual mismatch.** The base is annual and cumulative. The risk that a model
   applying a quarterly cap annually would let SG through — flagged as a real hazard before this
   compilation was read — simply does not exist under the current Act.
3. **The rate is not a schedule.** 12 is a literal.
4. **The base and the Div 293 threshold have just diverged — compute the base, never hard-code
   it.** Through 2025–26 the two were numerically identical, which makes \$250,000 a very
   attractive constant to write down:

   | | 2025–26 | 2026–27 |
   |---|---|---|
   | Concessional cap | \$30,000 | \$32,500 |
   | Max contributions base = `cap ÷ 12 × 100`, floor \$10 | **\$250,000** | **\$270,830** |
   | Div 293 threshold (s293-20, a literal) | \$250,000 | \$250,000 |

   They were equal by construction of the parameters, not by law. s293-20's \$250,000 is a fixed
   literal in the statute; the base moves with the indexed cap. **From 1 July 2026 they differ by
   \$20,830**, so any model that hard-codes \$250,000 for both is now wrong on one of them — and
   was silently right for the preceding two years, which is the worst way for a constant to be
   wrong.

**What this needs from state**: `auQualifyingEarningsYTD`, per person **per employer**, reset on
the financial year. The per-employer scoping is in the statute (s10A(6)(b)) and matters for anyone
with two jobs — each employer gets its own base, so two employers can together contribute SG on
well over the base. This model has one employer per person, so a single accumulator suffices
today; the field should be named and shaped so a second employer is an extension, not a rewrite.

**Salary sacrifice is inside the base, not outside it** (s10A(1)(h)). Sacrificing does not reduce
SG. §5.1.

**Not modelled**: the employer shortfall exemption certificate (s17B), which lets an employee with
multiple employers opt one out. It is a real instrument for exactly the multi-employer case above,
and it is out of scope while the model has one employer per person.

### 9.3 Concessional cap and carry-forward (s291-20)

Cap is \$25,000 for 2017-18 indexed annually (s291-20(2)), and indexation **never decreases** it
(s960-285). Carry-forward, from the text quoted in §4.2:

- available only if contributions **would otherwise exceed** the cap — it is not an election;
- gated on **total superannuation balance < \$500,000** just before the start of the year;
- looks back **5 years**, applied **earliest first**;
- no unused cap accrues for a year before 2018-19.

The \$500,000 gate is the interesting one for these scenarios. ~~It switches off permanently once
the balance crosses~~ — **wrong, and corrected in P7 (§13.9)**: s291-20(3)(b) tests the balance
just before the start of **each** financial year, and the ATO's own Table 2 example has it cross
to \$505,000 in 2020-21 and fall back to \$490,000 in 2021-22, with the full accrued cap
available again. Accrual is not gated at all — s291-20(6) has no balance condition — so an
over-threshold year still banks its own unused cap while being unable to spend anyone else's.
Worth modelling precisely rather than approximating in either direction: a model that lets the
carry-forward apply at any balance overstates late-career room, and one that switches it off
permanently destroys a member's accrued cap on a single good year.

**Requires a 5-year rolling per-person history in state** — the first genuinely multi-year
accumulator this model has needed, and per D8 it clamps rather than warns.

### 9.4 Div 293

s293-20: taxable contributions = **lesser of** low-tax contributions and the excess of
(income for surcharge purposes, disregarding reportable super contributions, + low-tax
contributions) over **\$250,000** — a literal in the statute, not an indexed figure (§9.2).

The rate is **15%**, from s5 of the *Superannuation (Sustaining the Superannuation Contribution
Concession) Imposition Act 2013*, now on disk (§4.4). s293-15 imposes the liability; the
Imposition Act sets the amount.

Two properties that make it easy to get wrong:

- **It is the member's own liability**, not the fund's. It appears on their notice of assessment
  and must accumulate to a *personal* YTD field, not to `auSuperTaxYTD`. `super-tax-rate.js`
  already says this in a comment: *"If it is ever modelled it does NOT belong in this constant."*
- **The "lesser of" makes it non-linear.** Just over the threshold, only the excess is taxed. A
  naive `15% × concessional_contributions` above the threshold overstates it, sometimes by a lot.

For a US/AU household with one high earner, this is a real ~\$4,500/yr liability the model
~~currently shows as zero~~ **now charges** (P8, §13.10 — the figure is reproduced exactly). It
also interacts with design 83's treaty work: Div 293 is an income tax paid to Australia by an
individual, so whether it is creditable against US tax under Art 22 is a question this design
raises and does not answer. §16 Q5. **As built it is NOT credited** — the conservative reading,
and the one that moves in a known direction if it is turned on later.

### 9.5 Non-concessional cap (s292-85)

Cap = **4 × the s291-20(2) cap**, ignoring any carry-forward increase, and **nil** where total
super balance is at or above the general transfer balance cap. **\$130,000 for 2026–27**; the
ATO's published table is 4× the concessional column in every row back to 2017–18 (§4.4), so this
is a derived quantity and the design should compute it rather than carry a second table. Three-year bring-forward available
under 75 with sufficient first-year cap space.

The nil-at-the-transfer-balance-cap rule is a hard stop, not a taper, and for a household of the
size these scenarios model it will bind. The general transfer balance cap is itself an indexed
figure needing the ATO source (§4.3 item 2).

---

## 10. Statutory limits as a versioned, indexed module (D2)

Both countries follow the same pattern and neither has it: **a published base amount, a base
period, an indexation series, and a rounding rule.** The model already has the shape to hold
this — `tax/inflation-adjusted-tax-rates.js` and the year-versioned modules (`us-tax-rates-2025.js`,
`us-tax-rates-2026.js`, `UsTaxRates2026`) — so this is a new consumer of existing machinery,
not new machinery.

```
src/finance/tax/us/us-contribution-limits.js
src/finance/tax/au/au-super-limits.js
```

Each exports limits for a given tax year: the transcribed published figure where one exists, and
the indexed projection beyond the last published year. **Built in P9 (§13.11)**, with the shared
method in `tax/statutory-indexation.js`.

**Follow the published-base guard.** Transcribe the cumulative published figure from the
authority — \$24,500 from Notice 2025-67, not \$15,000 compounded forward from 2006 by our own
CPI. Rounding differs per provision (§402(g) rounds **down** to \$500; §401(a)(17) **down** to
\$5,000) and compounding our own series through a decade of those rounding steps will not
reproduce the published number. Transcribe, then index only from the last published year forward.

Indexation beyond the published horizon should use the **scenario's own inflation assumption**,
not a second independent series. A run whose salaries grow at one rate while its contribution
caps grow at another is measuring the gap between two assumptions, not a policy outcome.

---

## 11. State additions

| Field | Scope | Reset | Why |
|---|---|---|---|
| `k401ContributionsYTD` | per person | Annual, US | §402(g) / §415(c) cap tracking (§7.3) |
| `usSsWagesYTD` | per person | Annual, US | **Exists**; needs writing from the wage event (§8.1) |
| `usWithheldYTD` | household | Annual, US | **Exists, orphaned**; needs reading and resetting (§8.2) |
| `priorYearUsTaxLiability` | household | Carried, not reset | Safe-harbor withholding (§8.2) |
| `auQualifyingEarningsYTD` | per person, per employer | Annual, AU (FY) | SGAA s10A(6) maximum contributions base |
| `auConcessionalYTD` | per person | Annual, AU (FY) | Div 291 cap |
| `auNonConcessionalYTD` | per person | Annual, AU (FY) | Div 292 cap |
| `auUnusedConcessionalCap` | per person, 5-year ring | Rolls annually | s291-20(3)–(7) carry-forward |
| ~~`auDiv293TaxYTD`~~ | — | — | **Not built (P8, §13.10).** Nothing to accrue: the s293-20 computation needs the whole year's taxable income and the whole year's contributions, both of which exist only at the settle. Computed once there and folded into the liability. The point it was making stands — it is the MEMBER's liability, never `auSuperTaxYTD`. |

**The AU accumulators reset on the financial year, the US ones on the calendar year.** The model
already handles this — `au-house-sale-study-rerun` records that AU `taxYear` is the FY *start*
year — but it is the kind of thing that silently produces a 6-month misalignment if a new
accumulator is added to the wrong reset list.

---

## 12. Cross-border interactions

A US citizen resident in Australia contributing to Super is the case this household actually
faces, and it is the one where this design touches the most existing work.

- **Super is not a 401(k) to the IRS.** Employer contributions to a foreign fund may be currently
  taxable to a US person; the fund's earnings may be too. `docs/us-tax/IRS-Rev-Proc-2020-17-Foreign-Retirement-Trusts.txt`
  and `CFR-26-1.402(b)-1-Employees-Trusts.txt` are already on disk. Design 83 covers the treaty
  side (Art 18). **This design does not resolve it** — it makes contributions reachable, which
  makes the question reachable. Flagged, not answered.
- **Div 293 creditability** — §9.4, §16 Q5.
- **§988.** `SuperContributionApplyReducer` already stamps a `DISPOSE` on the member's own
  contribution (AUD leaving the cash pool) and deliberately **does not** stamp the employer-funded
  one — currency that was never the member's. Any new contribution action must make the same
  distinction. Design 87's finding that both legs cancel to the dollar applies here: stamping one
  leg alone is worse than stamping neither.
- **Salary sacrifice and `workCountry`.** Sacrifice reduces AU assessable income. If the earner
  is US-resident working for an AU employer, what it reduces is a design 73 §6b question — source
  and residency are two axes, and sacrifice acts on one of them.

---

## 13. Phasing

Each phase is independently shippable and independently verifiable. Phases 1–3 have no source
gaps and could start now.

**No phase is gated on an external source any more.** Every figure this design needs is on disk
(§4), so the only ordering constraints are internal.

| Phase | Content | Depends on |
|---|---|---|
| **P0** | ✅ **DONE.** `PayrollHandler` + the two events (D7, §5.2). Legacy handlers retained and still registered. **Byte-identical, verified** (§13.1). | — |
| **P1** | ✅ **DONE.** Per-person elections on `Person`; household params become defaults. No behaviour change; one additive-only regold (§13.2). | P0 |
| **P2** | ✅ **DONE.** Wage splits (§6) — `splitWage`/`creditPay` in `finance/payroll/wage-splits.js`, `splits[]` on all four pay-apply actions. Absent splits ⇒ byte-identical (§13.3). | P1 |
| **P3** | ✅ **DONE.** Tiered match, §401(a)(17), §402(g)/§414(v)/§415(c) with `k401ContributionsYTD`, and a golden that binds all three (§13.4). **First phase to change behaviour.** | P1 |
| **P4** | ✅ **DONE.** Employee FICA (§3101), per-person OASDI base. **Moved 8 of 9 goldens** — the first deliberate regold (§13.5). | P0 |
| **P5** | ✅ **DONE.** FICA withheld monthly, credited at settle; `usWithheldYTD` finally read AND reset (§13.6). Legacy events NOT yet retired — moved to P6. | P4 |
| **P6a** | ✅ **DONE.** The tax-paid report counts withheld tax; the three legacy handlers deleted. No number moved — every golden held byte-exact (§13.7). | P5 |
| **P6b** | ✅ **DONE.** AU salary sacrifice + s290-150 + non-concessional as payroll streams (§9.1), with the s26-55 limit on the deduction. Additive-only regold; new `au-super-streams` golden (§13.8). **Streams are UNCAPPED — P7 is now load-bearing.** | P1 |
| **P7** | ✅ **DONE.** Div 291 + s291-20 carry-forward, Div 292 + bring-forward + the transfer-balance nil, s10A(5)/(6) contributions base. Verified against the ATO's own worked example; only the caps golden moved (§13.9). | P6 |
| **P8** | ✅ **DONE.** Div 293 — the s293-20(1) "lesser of", inside net liability, outside gross tax, and NOT staged as a creditable foreign tax (Q5). One golden moved (§13.10). | P7 |
| **P9** | ✅ **DONE.** Both limit tables project past their published horizon on the scenario's own inflation, with each provision's own rounding step. All 10 goldens moved (§13.11). **Design 95 COMPLETE.** | P3, P7 |
| **P10** | ✅ **DONE.** The UI (§17). All thirteen elections editable in the person editor with an explicit inherit state, repeating-row editors for `wageSplits` and `k401MatchTiers`, a Paycheque panel, a contributions-by-year report with the clamps as a column, and the AU cap ring as a table. **No number moved** — the second phase whose success criterion is that nothing does (§13.13). | P1–P9 |

**P0 first, and it should be boring.** It is the only phase whose success criterion is that
nothing changes, which makes it the only phase where a golden diff is unambiguously a bug. Doing
the restructure while it cannot move a number is worth a phase of its own.

### 13.13 P10 as built — the evidence

**Design 95's UI. The success criterion was that nothing move, and nothing did:**
5,493 unit / 1,086 viz green, all ten goldens byte-identical, no regold.

**The decisions (§17.3) were taken as tabled — U1 through U5, all five as recommended.**

**G2 + U2 — the elections are editable, and blank still means inherit.** A collapsed
`<details>` in the person editor, built from a new `PAYROLL_ELECTION_META` list rather
than from markup, so adding an election does not mean editing a template. The list is
**the fifth place that must agree** with `PAYROLL_ELECTION_FIELDS` — the constructor,
both serializer halves and the state projection being the other four — and a test
asserts the two are the same set, because a field missing here is invisible rather
than wrong: the election simply cannot be set.

**The inheritance map is not the identity, and one field proves it.** Eleven scalar
elections share a name with their household default; `superAnnualCap` does not — its
household key is `superGuaranteeAnnualCap`, because at household level it is
explicitly a cap on the EMPLOYER's SG (§13.9's defect). A UI assuming the names
matched would have shown "inherits 0" over a cap that was really set.

**A scenario keeps its parameters in TWO stores and NEITHER is complete.** The first
build read `getActive().parameters`, the flat bag. On the reference plan that bag holds
70 entries against 230 in the typed `params` list, and **every design-95 election is
among the 160 missing**, because a toolset-declared param is materialized onto the LIST
at load and reaches the bag only on the next save+reload. Every "inherit 10%" hint
degraded to "inherit (unset)" — a placeholder not wrong so much as silently useless.
Fixed by reading `scenarioParamValues()`, which already existed for exactly this reason
and which no editor was using. **Only the running app showed this**; every component
test passes a bag directly.

**Chasing that led to a live money bug in the ACCOUNT editor, unrelated to design 95.**
The bag is incomplete in one direction and STALE in another: `_normalizeParams` copies
the list into it **only on load, i.e. on Rebuild**, while the scenario panel writes the
list on every keystroke. `primeRates` (design 56) read the bag, so between editing a
Prime rate and rebuilding, the account and property editors worked against the previous
Prime. That is not a display bug: the rate fields edit an ABSOLUTE rate and store
`primeSpread = absolute − Prime`, so an absolute typed against the stale Prime is
stored as a spread that resolves against the real one. **Measured in the running app on
the reference plan** — AU Prime edited 4.35% → 7%, no Rebuild, a Prime-linked savings
account displayed as 4.5% with the hint naming `Prime (4.35%)`; correcting it to "5%"
stored a 0.65% spread and the plan ran the account at **7.65%**. Both editors now go
through `primeRatesOf()`, which reads through `scenarioParamValues`; after the fix the
same sequence displays 7.15%, names `Prime (7.00%)`, and stores a spread that resolves
to exactly the 5% asked for. Pinned by `tests/unit/scenario-param-values.test.mjs`.

**G1/G3 — one widget, twice.** `row-list-editor.js` serves both `wageSplits` and
`k401MatchTiers`; the scenario panel already had three near-copies of the shape and
this is deliberately not the fourth and fifth. `k401MatchTiers` was declared
`type: 'Json'`, which made D3's *"safe-harbor becomes data, not code"* true only in
the sense that hand-typed JSON is data. The safe-harbor basic match is now four
numbers in two rows, and a live run confirms it: 100% of the first 3% plus 50% of the
next 2% paid exactly 4.00% of pay.

**The split editor cannot author a split the model would mishandle.** Three filters,
each removing a real defect rather than a nuisance:

- **no stateKey** — an id persisted here silently never matches, and the share falls
  back to the transaction account (design 72 §2, in a new place);
- **wrong currency** — `splitWage` refuses one, since a cross-currency split is an
  international transfer with an FX leg and a §988 disposal attached;
- **not depositable** — new `DEPOSITABLE_ROLES` in `wage-splits.js`. `creditPay`
  credits a balance and does nothing else, which is right for cash and taxable
  accounts and wrong everywhere else. **The picker was offering the 401(k), the IRAs
  and the mortgage.** Into a wrapper that is a contribution nothing accounted for — no
  basis, no deduction, past §402(g) and Div 291 alike. Into a loan, whose positive
  balance IS the debt (design 54), *"send 20% of my pay to the mortgage"* would have
  **grown the mortgage**. Found by looking at the real dropdown, not by a test.

**G4 — the paycheque.** A workbench panel (U3), because the payslip's month tracks the
run and a modal cannot follow a cursor. `paycheque-report.js` is assembly and nothing
else: it re-derives no amount, applies no rate and knows no statute, because a payslip
that recomputed its own withholding could disagree with the run it claims to show and
nothing would say which was right. Two hazards it does have to respect:

1. **A journal entry is one REDUCER execution, not one action.** `spending-cube.js`
   sidesteps this by reading `stateDiff` balance deltas; this module reads the payload
   instead — a withheld amount moves no balance, which is the whole point of
   `alreadyNetted` — so it dedupes on `action.instanceId` explicitly.
2. **The wage action carries four figures meaning four different things.** `amount` is
   assessable and ALREADY net of sacrifice; `netAmount` is stamped only when
   withholding differs from it, so reading an absent one as 0 shows a month with no
   take-home. The package is `amount + sacrificed`, which is the only figure the four
   stages read as reductions from.

**G5/G6 — clamps and the cap ring.** D8's promise was that a contribution stopped by a
cap be *"visible in the output rather than inferred from a number being lower than
expected"*; it is only kept when the year that clamped says so **in the same table as
the contributions**, so `clamps` is a column. `carriedForward` renders as RELIEF with
its own badge — §13.9 records the day these two shared a field and 363 actions
announced a concession as a stoppage, and they must never read alike again.

**Two more defects a real compile found that no unit test would have.** Both in the
rollup, both silent:

1. **Three of the six action types carry more than one stream.** A match and a
   non-elective employer contribution are both `K401_CONTRIBUTION_APPLY` with
   `employerFunded: true`; so are the SG and a personal deductible contribution. A key
   of (type, funded) **added two different streams together and labelled the total as
   whichever arrived first** — a 4% match reported as 6% of pay, and twelve months of
   it as twenty-four, with nothing anywhere flagging either figure.
2. **AU streams were rolled up by CALENDAR year while every cap that clamps them is a
   FINANCIAL-year cap.** On an A\$480k earner that put half of one FY's contributions
   beside half of the next one's: **A\$41,166 against a A\$32,500 concessional cap, in
   a row whose own Div 291 clamp sat beside it, reading as though the cap had failed.**
   Each stream now rolls up on its own country's year — §10 records the identical
   hazard on the indexation side, where reading one country's figure with the other's
   convention shifts it silently. Rolled up correctly, the same run reads SG 21,833 +
   sacrifice 8,000 + deductible 2,667 = **A\$32,500 to the dollar**, which is §9.3's
   interlock visible in a table for the first time.

**The AU run is also the first place D8's whole point is legible.** A A\$480k earner's
SG stops dead in month five of the financial year; the payslip for the months after it
shows only the non-concessional stream surviving, with **`Div 291` and `s10A(5) base`
both named on the line**. §9.2 predicted exactly this and nothing could see it before.

**U5 is pinned two ways.** A component test drives the editor untouched through
`PeopleController` into `projectPerson` and asserts `computePayroll` returns the same
`k401` as a person the editor never saw — **and that the deferral is non-zero**, since
two silent handlers are trivially identical (P6a's lesson about equivalence tests
needing a working-detector control). The goldens are the second: all ten held.

**One payload inconsistency corrected in passing.** `K401_CONTRIBUTION_APPLY` declared
`clamps: ValueType.text()` while all four AU streams declared `ValueType.any()` for the
same array. Display metadata only — `pickPayload` copies the value either way — but the
clamps are a first-class column now.

### 13.12 Close-out review — ten defects, three of them money

A `/code-review` pass over P6a-P9 (`c4acb3e..HEAD`) after the suite was green at
5,462 / 0. **Every finding was latent — none was caught by an existing test**, which is
the useful fact about it: the phases were verified against what they set out to do, and
these live in the gaps between them.

| # | severity | defect |
|---|---|---|
| 1 | **HIGH** | Salary sacrifice computed twice from different inputs; the two disagreed and the difference VANISHED |
| 2 | **HIGH** | `AU_QUALIFYING_EARNINGS_APPLY` emitted twice a month in any cross-border run |
| 3 | **HIGH** | The Div 292 bring-forward was never persisted, so it re-triggered every year |
| 4 | MED | The settle resolved a member's fund by naming convention, not ownership |
| 5 | MED | Div 293 structurally zero on the single-return settle path |
| 6 | MED | The non-resident branch kept both new charges but dropped the s290-150 deduction |
| 7-10 | LOW | Undeclared chained action; an unnamed clamp; SG for the self-employed; a wrong comment |

**Findings 1, 2 and 9 are all the same seam**, and it is the one this design should be
most suspicious of: **two `PayrollHandler` instances sit on `PAYROLL_CONTRIBUTIONS`,
one per country's toolset, and each evaluates the WHOLE pipeline while carrying only
its own country's elections** (§5.2). P6b was already bitten by it once — the income
stage did not know the sacrifice rate at all. The two found here are subtler:

- **The income stage knew the rate but not the SG** (finding 1), so it rationed
  sacrifice against an empty Div 291 pool while the contributions stage rationed
  against a full one. The wage was reduced by one figure and the fund credited with
  another. Measured at **A\$83.33 a month** on a A\$250k salary with the cap partly
  consumed — money that left the household and reached nothing. Both stages now carry
  the full AU election set.
- **The US-configured instance emitted the AU accumulator** (finding 2), because the
  emission was gated on "this person earns" rather than "this instance owns the AU
  stream". `qualifyingEarningsYTD` doubled, bringing the s10A(5) base forward to half
  the earner's true pay and stopping their SG mid-year with a spurious clamp. Ownership
  is now read off the election bag (`_ownsAuStream`), NOT off the computed amounts —
  the accumulator must keep running in a month where every stream was clamped to zero.

**Finding 3 is the one a unit test actively hid.** CAP-14 tested `nonConcessionalCap`
with a hand-built `bringForward` object and passed — but nothing in the system ever
BUILT one. `bringForwardTriggered` was computed, returned, forwarded, and consumed by
nobody, so s292-85(6)/(7)'s remainder branch was unreachable and every year re-evaluated
as a new first year: a member over the general cap got a 3x cap **every** year instead
of once per three. The settle now creates the arrangement, re-derived from what the year
actually contributed. CAP-19 drives it through the real roll for five years rather than
by hand, which is what the original test should have done.

**Finding 4's first fix was a regression, caught by the goldens.** Restricting the
household-`superAccount` fallback to single-person households dropped `primary`'s
A\$1,052,866 balance to zero in `cross-border-reference`. Accounts carry `ownerId` in
state, so ownership is a FACT available here rather than something to infer — the
resolution now prefers the key the payroll handler actually resolved (recorded on the
caps record by the accumulator) and falls back to `ownerId`, never to a convention that
can hand one balance to two people.

**Only `au-super-streams` moved**, by A\$25 of ordinary income and A\$246 of lifetime
tax — the finding-1 fix landing: the wage is now reduced by less in months where Div 291
binds, and the difference stays in the brokerage where it belongs.

Final: **5,470 unit / 0 fail**, 1,043 viz / 0, saved scenarios diff-identical. Six new
regression tests (AUS-10 to AUS-13, CAP-19, CAP-20, D293-15, D293-16), each written
against the reproduction rather than against the fix — AUS-10 sweeps the cap boundary
because the two stages agreed everywhere the cap did NOT bind, and a single unclamped
fixture would have passed throughout.

### 13.11 P9 as built — the evidence

| check | result |
|---|---|
| Unit | 5,462 pass / 0 fail (12 new in `statutory-indexation.test.mjs`) |
| Viz | 1,043 pass / 0 fail |
| Goldens | **all 10 moved** — the first phase since P4 to move every one |
| Saved scenarios | all load identically to the pre-P6a baseline |

`src/finance/tax/statutory-indexation.js` — one shared helper and one table of
rounding steps, consumed by both limit modules.

**Both countries state the rule, and the AU statute states it best.** ITAA97
**s960-285(2)**: *"(a) first, multiplying its base amount by its indexation factor;
and (b) next, rounding the result in paragraph (a) DOWN to the nearest multiple of its
rounding amount."* Multiply, then round the RESULT down — once, on the level. The US
provisions are drafted as an adjustment to the *increase* (§402(g)(4): *"any increase
... which is not a multiple of \$500 shall be rounded to the next lowest multiple of
\$500"*) and reach the same place, because their bases are multiples of the step and
the increase is measured from the base once rather than compounded.

**Rounding the level rather than each year's increment is what keeps a long
projection honest**, and IDX-2 measures the difference rather than asserting it.
Round-down applied annually loses up to a full step every year and compounds: ten
years at 3% on the §402(g) limit already differs by more than a step, and over a
forty-year run it would drift thousands of dollars low while looking like careful
arithmetic.

**Caps never fall.** s960-285(4) — *"You do not index the amount if the indexation
factor is 1 or less"* — is the rule behind the note under s291-20(2), and it makes
every limit monotonic non-decreasing. The guard matters most just under 1: a factor of
0.999 would otherwise round the level down a whole step, turning a mild deflation into
a \$500 cut no statute authorises.

**Six provisions, five different rounding steps**, each verified against the paragraph
that sets it: §402(g)(4) \$500, §414(v)(2)(C) \$500, §415(d)(4)(B) \$1,000,
§401(a)(17)(B) \$5,000, s960-285(7) item 2 \$2,500 (concessional cap), item 3
\$100,000 (transfer balance cap). A single shared step would be wrong for most of them.

**The third accumulator, and why it could not be a reuse.** `limitIndexAccumulator` is
anchored at each country's **last published limit year**, not at sim start.
`inflationAccumulator` is 1.0 at sim start — right for wages and expenses, wrong for a
published limit, because the authority's 2026 figure already contains the inflation up
to 2026 and indexing it from sim start would count that twice. IDX-10 pins the
distinction with a control showing the wage accumulator advancing in the same tick the
limit accumulator does not.

It compounds the **same effective rate the wages use**, which is §10's actual
requirement: *"a run whose salaries grow at one rate while its contribution caps grow
at another is measuring the gap between two assumptions, not a policy outcome."* Reading
the realised per-year rate rather than projecting a constant also means the caps track
the path the wages actually took under an economic-regimes run.

The two countries index off their own horizons **and their own year conventions** — AU
by financial-year start, US by calendar year, which is what `currentPeriods[cc].startMs`
yields for each. IDX-11 pins that, because reading one with the other's convention
would shift a whole country's caps by a year silently: adjacent years' caps are often
equal, so it would surface only in a year the cap moved.

**Indexing one AU figure carries three.** Everything on that side derives from the
concessional cap, so the projection carries the non-concessional cap (4x) and the
s10A(5) contributions base with it — and IDX-8 checks that **the interlock survives**:
12% of the projected base is still the projected cap to within the base's own \$10
rounding (39,999.60 against 40,000 ten years out). If indexation had broken that, the
Super Guarantee alone could have started producing excess concessional contributions.

**The published range is inviolable.** Inside it the transcribed figures stand whatever
the factor — the authority's number for a year it has published is not ours to adjust,
and a caller whose accumulator has drifted must not be able to move it. With no factor
at all, every function returns exactly its pre-phase-9 answer, which is what lets a
unit test, a report or a UI probe read the tables without threading state.

**What this is NOT, stated plainly.** The real calculations run off published index
numbers — AWOTE for the AU concessional cap, CPI for the transfer balance cap, the
§415(d) CPI method for the US — measured from a fixed base quarter and applied to the
ORIGINAL statutory base, with the authority's own rounding at each publication.
Reproducing that would need those series on disk and still would not reproduce a
published number. **In particular the AU concessional cap indexes to AWOTE, not CPI**,
and AWOTE has historically run above CPI — so projecting it on the scenario's
CPI-like inflation UNDERSTATES its growth, which is the conservative side.

**Every golden moved, and the two that were built to bind limits moved most:**

| golden | contributions | lifetime tax | net worth |
|---|---|---|---|
| `payroll-limits` | 401(k) basis **+5.06%** | −0.48% | +0.36% |
| `au-super-streams` | super basis **+1.40%** | +0.20% | +0.35% |
| the other eight | — | — | — (ring + accumulator only) |

The eight quiet ones are the containment check: their contributions never approach a
limit, so only the unused-cap ring and the new accumulator move. `us-single-homeowner`
shows the projection working on its own: the FY2060–2064 unused-cap entries step
87,500 → 90,000 → 92,500 → 95,000 → 97,500, one \$2,500 rounding step per year, which
is what a ~2.7% factor on an ~85,000 cap produces. The rounding is doing real work
rather than being a no-op.

**`au-super-streams` moves the interesting way: contributions up, net worth up, and
lifetime tax UP.** More concessional room means more money into super — and a
concessional contribution is taxed 15% going in (Div 295) and can pull the member into
Div 293. So on the Australian side extra contribution room is wealth-positive but not
tax-positive, which is the opposite of the US result on the same phase and worth
knowing before reading a lifetime-tax objective on an AU-resident plan.

**Design 95 is complete.** All ten phases shipped.

### 13.10 P8 as built — the evidence

| check | result |
|---|---|
| Unit | 5,450 pass / 0 fail (14 new in `au-div293.test.mjs`) |
| Viz | 1,043 pass / 0 fail |
| Goldens | **1 of 10 moved** — `au-single-homeowner`, 19 fields, all in-place |
| Saved scenarios | all load identically to the pre-P6a baseline |

`src/finance/tax/au/div293.js` — a leaf module with no imports, following
`fica-rates.js` and `super-tax-rate.js`. The rate and the threshold are the whole of
it, and nothing else in the model carries a second copy of either.

**The "lesser of" is the whole subtlety, and it is a 200x error if you miss it.**
s293-20(1) charges the lesser of the low tax contributions and the amount by which
(income for surcharge purposes + low tax contributions) exceeds \$250,000. Someone one
dollar over owes **15 cents**, not 15% of their contributions — D293-2 pins exactly
that, against a flat `15% x concessional` that would say \$3,000. The provision phases
in over precisely one contribution's width of income, and `binding` names which limb
won, because they mean different things to someone deciding whether to sacrifice more:
`EXCESS` is inside the band, where a dollar of income costs 15c; `CONTRIBUTIONS` is
past it, where every concessional dollar does.

**Income for surcharge purposes is taxable income here, and both omissions are
conservative.** s995-1 defines it as taxable income + reportable fringe benefits +
reportable super contributions + total net investment loss; s293-20(1)(a) then
**disregards the reportable-super-contributions limb**, which is what stops the
provision counting a sacrificed dollar twice. This model has no fringe benefits and no
total-net-investment-loss concept (the Div 36 pool is a carried-forward loss, a
different quantity), so ISP is taxable income. Both omissions push the figure DOWN,
which is the right direction for a tax being introduced.

**The offsetting-limbs design is worth seeing, and D293-6 pins it.** A member who
sacrifices has a smaller limb (a) and a larger limb (b), so the sum barely moves:
Div 293 cannot be sacrificed away, which is the point of it. Sacrificing MORE
*increases* the base, because the concession being clawed back is the concession on
the sacrifice itself.

**Placement on the return was the substantive decision.** Div 293 goes in AFTER the
franking offset and the FITO and BEFORE the Net Tax Liability line:

- **After the offsets** because it is imposed by its own Act on a base of its own —
  contributions, not income — so it is not part of the income tax assessment those
  offsets reduce. Folding it in earlier would let a refundable franking offset wipe
  out a liability it has no reach over, which is design 84 G10's mistake running the
  other way. D293-9 puts a return's whole income tax under water with franking credits
  and shows the Div 293 standing untouched.
- **Before the total** because it is INSIDE it. Design 71 §6's footing identity has to
  hold line by line, and printing it under the total it belongs to would leave the
  visible lines not summing. D293-8 foots the return.

**Q5 resolved as tabled: paid, but not creditable.** Div 293 is inside `action.tax` —
the member genuinely owes it, so it is debited and reaches `cumulativeTaxesPaid` — and
subtracted again when the AU settle stages `ftcCurrentForeignTax`. It has to be both,
and a test asserting only one would pass on an implementation that never charged it.
D293-13 and D293-14 pin both settle shapes, per-person and the household fallback,
because a fix applied to one of the two is the recurring shape of defect here.

**A non-resident is liable too.** Nothing in s293-15 or s293-20 conditions the
liability on residency, and a foreign resident working in Australia has an employer
paying the Super Guarantee for them just the same. Omitting the non-resident branch
would have let a cross-border household's US-resident earner escape it silently —
the shape of defect design 73 §6b was about.

**Only `au-single-homeowner` moved, and its four Div 293 years are each explicable:**

| FY settled | taxable income | low tax contributions | tax | binding |
|---|---|---|---|---|
| 2040 | 296,954 | 21,464 | 3,219.61 | CONTRIBUTIONS |
| 2044 | 226,453 | 24,158 | **91.66** | EXCESS |
| 2045 | 237,889 | 24,883 | 1,915.77 | EXCESS |
| 2046 | 256,036 | 25,629 | 3,844.39 | CONTRIBUTIONS |

2040 is the year that golden's classic car sells — a capital gain lands in taxable
income while the member is still working and contributing, which is the year a working
member is most likely to be caught. 2044–46 are salary growth walking through the
phase-in band, three consecutive years showing 91.66 → 1,915.77 → 3,844.39. That is
the non-linearity demonstrated on live data rather than asserted, and it means the
existing golden covers Div 293 without a new one. Lifetime AU tax rises A\$8,898 and
the 2066 super balance falls A\$40,516 — the liability is paid from cash, so it
compounds into the drawdown for the rest of the run.

The design's §9.4 estimate of *"a real ~\$4,500/yr liability the model currently shows
as zero"* is reproduced exactly: an earner past the phase-in with the full 30,000 of
concessional contributions owes 4,500.

**MODELLING CHOICE — it is paid from the member's cash.** Div 293 arrives as its own
notice of assessment and the member may instead pay it by releasing money from the
fund, which is their election. This model debits it with the rest of the AU bill, so a
member short of cash draws down to pay it rather than shrinking their super directly.
That is the conservative side for a plan's cash-flow test and the wrong side for
anyone whose real intention is a release authority.

**§11's `auDiv293TaxYTD` row is superseded.** It anticipated accruing the liability
through the year into a per-person YTD field. There is nothing to accrue: the
computation needs the whole year's taxable income and the whole year's contributions,
both of which exist only at the settle. It is computed once, reported on the return,
and inside the liability that gets debited.

### 13.9 P7 as built — the evidence

| check | result |
|---|---|
| Unit | 5,436 pass / 0 fail (18 new in `au-super-caps.test.mjs`, 2 reducer postconditions) |
| Viz | 1,043 pass / 0 fail |
| Goldens | **8 of 9 additive-only**; `au-super-streams` moved, which is what it exists for |
| Saved scenarios | all load identically to the pre-P6a baseline |

**One published figure determines three limits, so almost nothing is transcribed.**
`au-super-limits.js` carries the concessional cap per financial year and the general
transfer balance cap, and derives the rest:

| limit | source | 2026–27 |
|---|---|---|
| Concessional cap | s291-20(2), transcribed from the ATO's Table 1.1 | \$32,500 |
| Non-concessional cap | **derived**, s292-85(2)(a) = 4 x | \$130,000 |
| Max contributions base | **derived**, SGAA s10A(5) = cap ÷ 12 x 100, floor \$10 | \$270,830 |

Both derived figures reproduce the ATO's published tables exactly, which is the check
that says the derivation is the statute rather than a coincidence — CAP-9 asserts the
4x relation against every row of Table 4 back to 2017–18.

**The interlock is the point, and it is what makes clamping defensible.** 12% of the
s10A(5) base IS the concessional cap, to within the base's own \$10 rounding
(\$32,499.60 against \$32,500). So the Super Guarantee ALONE can never produce an
excess concessional contribution — CAP-15 runs a \$400,000 earner through a full year
and shows the SG stopping dead in month 10 at exactly 12% of the base. Any clamping of
the member's own streams is therefore genuinely the member's own doing.

**CAP-1 replays the ATO's own worked example, column for column.** Table 2 of
*Contributions caps* is five financial years of accrual, expiry, earliest-first
ordering and the \$500,000 balance gate, with the regulator's own answers in the
"total unused available" and "maximum cap available" rows. The implementation
reproduces both rows for all five years. That is a far stronger check than any
assertion written from our own arithmetic, and it caught the design's one error:

**§9.3 was WRONG about the \$500,000 gate, and the ATO's example disproves it.** The
design says the gate "switches off permanently once the balance crosses, so the
carry-forward is a feature of early career and effectively dead later". It is not
permanent. s291-20(3)(b) tests the balance *just before the start of* **each**
financial year, and the ATO's example has it cross to \$505,000 in 2020–21 (no
carry-forward that year) and fall back to \$490,000 in 2021–22 (all \$69,000 available
again). A one-way switch would permanently destroy a member's accrued cap on a single
good year — and accrual is not gated at all (s291-20(6) has no balance condition), so
the over-threshold year still banks its own unused cap while being unable to spend
anyone else's. CAP-2 and CAP-6 pin both halves.

**The caps ration one pool, in an order the statute implies rather than states.** SG →
salary sacrifice → personal deductible. Employer money has first claim because the
member cannot decline it: an SG dollar crowded out by the member's own sacrifice would
be a contribution their employer still legally owes them. The personal deductible
gives way LAST because it is the one the member can redirect — money that cannot go in
concessionally can still go in non-concessionally, whereas a forgone salary sacrifice
has to be unwound with the employer.

**Carry-forward is reported as RELIEF, not as a clamp — after the first cut got it
wrong.** It was initially pushed onto `clamps`, which made 363 actions on the
reference run announce `s291-20 carry-forward` as though something had been stopped.
`clamps` names what STOPPED a contribution; the carry-forward is the opposite. It now
rides on its own `carriedForward` field. CAP-17 pins that a relieved month reports
`clamps: []`.

**A second naming bug the same probe found: the SG scenario cap was eating the
member's streams.** `superGuaranteeAnnualCap` is a cap on the EMPLOYER's contribution,
but it was measured against the shared concessional total, so it bound in every month
of a scenario whose SG was nowhere near it. The record now carries `sgYTD` alongside
`concessionalYTD` for exactly this. Neither bug changed a number — both would have
shipped as a journal that cried wolf.

**`AUS-6` caught a real defect during the rewrite.** Replacing the uncapped block lost
the clamp holding a salary sacrifice to the month's earnings, and a 200% rate produced
a **negative wage** flowing into the tax chain. The test was written in P6b for a
condition that could not then occur; it fired the moment the code moved underneath it.

**The state is one record per person, not six parallel maps.** `auSuperCapsByPerson`
holds `{ concessionalYTD, sgYTD, nonConcessionalYTD, qualifyingEarningsYTD,
unusedByFy, tsbAtFyStart, bringForward }`. Div 291 rations three streams against one
pool, and four separate accumulations living beside four reducers would be four
chances for that pool to be counted differently — silently, because a cap fed too
little simply never binds. One accumulator writes it during the year; the settle owns
the boundary and owns it alone, exactly as the Div 36 loss pool does.

It sits OUTSIDE `PER_PERSON_AU_FIELDS` deliberately: that loop zeroes a map wholesale
and three of the seven fields must survive the year. **`unusedByFy` is the model's
first genuinely multi-year accumulator**, and zeroing it every June would have deleted
the whole carry-forward feature while leaving it looking wired.

**The TSB snapshot is taken at the settle because that is the only moment it is
right.** Both s291-20(3)(b) and s292-85(2)(b) test the balance "just before the start
of the financial year", and 30 June is exactly that instant for the year about to
begin. The roll also re-derives what the carry-forward actually released, from the
year's REAL contributions rather than the payroll handler's monthly view of intended
ones — a member who retires in March intended more than they contributed, and would
otherwise have spent banked cap on a contribution that never happened.

**Only the caps golden moved, and it moved the right way.** `au-super-streams`
contributes 33,500 against a 32,500 cap by construction, so P7 was always going to
bite it: super **−13,200**, taxable brokerage **+6,797**, net worth **−6,403** over
seven years. That last figure is the real cost of the cap — money forced out of a
15%-taxed environment into a marginal-rate one — and the run reproduces the ATO
example's own dynamic on live data, with the carry-forward lifting FY2027 and FY2028
above the basic cap and then the \$500,000 gate shutting as the balance grows:

| FY | concessional total |
|---|---|
| 2026–27 | 32,337 |
| 2027–28 | **32,659** (carry-forward) |
| 2028–29 | **32,699** (carry-forward) |
| 2029–30 onward | 32,500 (gate shut, cap binding) |

**KNOWN GAP — clamping is not what the Act does, and this is the one place the design
departs from the statutes it cites.** Exceeding either cap is lawful:

- excess CONCESSIONAL contributions (s291-20(1)) are included in the member's
  assessable income and taxed at their marginal rate, with a 15% offset for the tax
  the fund already paid, and the excess then counts toward the non-concessional cap;
- excess NON-CONCESSIONAL contributions (s292-85(1)) trigger a determination, which
  the member answers by releasing the money or paying tax on the associated earnings.

Both are *rectification* regimes — an accounting for something that already happened —
and modelling them faithfully means modelling a determination, a release authority and
an election, none of which a projection can decide on a member's behalf. Clamping
instead models the member noticing the cap and stopping, which is what a person with a
financial plan does, and D8's journalled clamp names the limit so the divergence is
visible rather than silent. Recorded here rather than buried in the module because it
is the assumption most likely to matter to someone reading a result.

**P6b's KNOWN GAP 1 is now CLOSED** — the streams are capped, and an optimizer
sweeping them can no longer discover unlimited tax-free contribution room. **KNOWN
GAP 2 stands**: `contributionBasis` still conflates the taxable and tax-free
components, and P7 did not touch it.

### 13.8 P6b as built — the evidence

| check | result |
|---|---|
| Unit | 5,416 pass / 0 fail (9 new in `au-super-streams.test.mjs`, 2 reducer postconditions) |
| Viz | 1,043 pass / 0 fail |
| Goldens | **91 insertions, 0 deletions, 0 modifications** across 9 fixtures — additive only |
| New golden | `au-super-streams`, 2026–2033, all four AU streams on one earner |

**The regold signature is the one that matters.** Not a single computed value moved
in any existing fixture: the 91 new lines are three null `Person` elections × the
people in each scenario, plus the two new zeroed accumulators. Exactly P1's shape,
and it is what says the three streams are inert unless a scenario opts in.

**Three streams, three action types, and the reason is three independent axes.**
Whether cash moves, whether the fund takes 15% on the way in, and whether the member
gets a deduction vary independently across the four AU streams. A `stream`
discriminator on one action would have been invisible to every report that groups by
action type, and `downsizer-contribution.js` had already set the precedent in the
same words: a contribution whose tax mechanics differ gets its own action rather than
reusing one that looks close enough.

| stream | action | cash debit | Div 295 | deduction | §988 |
|---|---|---|---|---|---|
| Super Guarantee | `SUPER_CONTRIBUTION_APPLY` `employerFunded` | no | yes | no | no |
| Salary sacrifice | `SUPER_SACRIFICE_APPLY` | no\* | yes | n/a | no |
| s290-150 | `SUPER_CONTRIBUTION_APPLY` `deductible` | yes | yes | **yes** | DISPOSE |
| Non-concessional | `SUPER_NON_CONCESSIONAL_APPLY` | yes | **no** | no | DISPOSE |

\* no cash moves *in the reducer* — `PayrollHandler` already removed it from the wage.

**Sacrifice is the only stream that spans both payroll stages, and that broke the
two-instance design.** The handler reduces the wage at stage INCOME and puts the
money in the fund at stage CONTRIBUTIONS, but those are two separate `PayrollHandler`
INSTANCES on two events (§5.2), and only the second carried the AU election. The
first run produced a member paid in FULL whose sacrifice also arrived in super — the
same money twice, with assessable income never reduced. Caught by probing the emitted
wage payload, not by any test: every unit test constructs one handler with all the
params, so none of them can see a wiring split that exists only in the toolsets.
Fixed by passing `salarySacrificePct` to the income-stage instance in **both**
toolsets — including `us-retirement-toolset.js`, which now reads an AU parameter.
That coupling is deliberate and commented: the INCOME stage is country-agnostic and
credits both earners, and in a cross-border scenario it is the *only* income-stage
instance there is.

**Ordering is the statute, twice, in opposite directions.** SG is computed BEFORE the
sacrifice is subtracted (SGAA s10A(1)(h) counts a sacrificed reduction as qualifying
earnings, so sacrificing does not reduce the employer's contribution); the wage
reduction is applied BEFORE withholding and the split, so assessable income, PAYG and
the cash that reaches the household all see the reduced figure. AUS-3 pins the first
with a working-detector control, since two handlers agreeing about an SG of zero
would prove nothing.

**The s290-150 deduction needed a limit nobody had asked for.** ITAA97 **s26-55(1)(d)
and (2)**, both on disk, cap the deduction at *assessable income less all deductions
except tax losses*: it can take taxable income to zero but cannot create or increase
a tax loss, and the excess is lost rather than carried. That is why it is applied
between assessable income and the Div 36 loss pool rather than after it — s26-55(2)(a)
names tax losses as the one thing NOT subtracted when working out the limit, so
applying the two in the other order would manufacture relief the Act denies twice
over. AUS-7 holds both sides of the clamp.

**The measured contrast is the design's own claim, confirmed.** On a seven-year AU
run at A\$150,000 (control: no member streams, lifetime AU tax A\$283,195):

| arm | lifetime AU tax | super balance |
|---|---|---|
| control | 283,195 | 626,590 |
| sacrifice 5% | **261,332** | 687,846 |
| s290-150 A\$8,000/yr | **261,706** | 686,690 |
| non-concessional A\$12,000/yr | 283,486 | 732,648 |

Sacrifice and s290-150 land within A\$374 of each other on tax and A\$1,156 on
balance for near-identical contributions — §9.1's "nearly the same place by different
routes", with the residual being the cash-flow timing it names. The non-concessional
arm moves tax by A\$291 on A\$84,000 contributed, which is the correct answer for a
stream with no deduction and no Div 295: it buys a tax-sheltered *location*, not a
deduction.

**KNOWN GAP 1 — the streams are UNCAPPED.** ✅ **CLOSED in P7 (§13.9).** Div 291, its
s291-20 carry-forward, Div 292 and the s10A(5) contributions base are all P7. Nothing here stops a scenario
contributing past any of them, and the param descriptions say so. This matters more
than a normal deferral because these keys are `opt: true`: **an optimizer sweeping
them will discover that shovelling money into super minimises tax, because in this
phase it does.** P7 is not a refinement of P6b, it is the half that makes it usable.

**KNOWN GAP 2 — `contributionBasis` conflates the taxable and tax-free components,
and P6b makes that reachable in a new way.** ⚠️ **Still open; see §15.1 for why it is
its own design and where to start.** §9.1 says a non-concessional
contribution "credits the tax-free component". There is no such ledger: super carries
`contributionBasis` / `earningsBasis`, and concessional contributions credit
`contributionBasis` net of Div 295 exactly as the new non-concessional stream credits
it gross. The only place the split exists is the death-benefit path (design 63 §6.4),
where `taxableComponent` is a hand-authored bequest field that **defaults to the whole
balance**. So a fund built partly from non-concessional money is taxed on death as if
all of it were taxable. Pre-existing, not introduced here — but before P6b there was
no ordinary way to get tax-free money into a fund, and now there is. It also matters
beyond death: design 84 prices the s99B treatment of a Roth decant off exactly this
component split. Deferred deliberately — fixing it moves `au-single-homeowner` and
needs a decision about where the split lives, which belongs with P7's cap work.

### 13.7 P6a as built — the evidence

Two pieces of cleanup that P5 named and deferred, both number-neutral by construction.

| check | result |
|---|---|
| Unit | 5,403 pass / 0 fail (2 new: the report's withholding rows, the retired-type failure) |
| Viz | 1,043 pass / 0 fail |
| Goldens | **unchanged** — no fixture re-cut, both changes are outside the sim |
| Saved scenarios | all 28 export files load identically to the pre-change baseline, diff-clean |

**The tax-paid report understatement is closed, and the fix was a FAMILY, not a
classification.** §13.6 recorded that mapping `WAGES_WITHHELD_APPLY` into
`spending-classification.js` did not work; the reason is that the report never read
action categories in the first place. It reads
`api.familyTypes('TAX_PAYMENT_DEBIT', { cc })` — a query over declared action
families — and withholding is deliberately not a debit, because when the payroll
handler nets it out of the paycheque no cash moves at all. So the withholding action
now declares `family: 'TAX_WITHHELD', cc: 'US'` and the report unions the two
families. Reference run: \$528,232 → **\$716,455.51**, which is
`cumulativeTaxesPaid` less the in-fund Div 295 tax to the cent.

`TAX_WITHHELD` rather than folding it into `TAX_PAYMENT_DEBIT` for two reasons: the
action genuinely does not debit when `alreadyNetted`, so filing it under a debit
family would make the family name a lie; and P7 needs somewhere to hang AU PAYG
withholding, which will want the same treatment under a different `cc`.

**The two families partition the liability exactly** — withheld plus balance due —
and that identity is what makes the union safe rather than a double count. It holds
only while withholding cannot EXCEED the liability, which is true of every method
that has shipped (FICA is always part of the liability it is credited against).
`balanceDue` is clamped at zero, so a future over-withholding method would show up
here as an overstatement equal to the un-refunded excess — the same no-refund gap
§8.2 already names as the reason `PRIOR_YEAR_SAFE_HARBOR` is deferred.

The e2e reconciliation in `report-currency.test.mjs` no longer subtracts the withheld
term. It asserts instead that withholding is a material share (>10%) of the total, so
the check cannot pass by the withholding quietly going to zero.

**The three legacy handlers are deleted.** `MonthlyWagesHandler`,
`UsRetirementContributionHandler` and `AuSuperGuaranteeHandler` are gone from disk,
from the toolsets' `types.handlers`, from `_ALL_CLASSES` and from `index.js`.

**Deleting them was safe for a reason worth writing down, because it is not
obvious.** Every saved scenario export on disk — 28 files — still carries a
`MonthlyWagesHandler` node in its persisted `handlers[]`, and
`ScenarioSerializer._makeHandler` throws on a type it cannot resolve. They keep
loading because `ScenarioLoader.load` branches on `cfg.toolsets`: a scenario that
carries toolsets is RECOMPILED from them and its persisted handler nodes are never
deserialized. All 28 do. Verified rather than assumed — every file was loaded before
and after the deletion and the results are diff-identical, pre-existing unrelated
failures included.

Only a pre-toolsets export could reach the missing class, so `_RETIRED_TYPES` in the
serializer makes that failure explain itself: which class, what replaced it, and that
Rebuild is the way out. Deliberately an error and not a skip — silently dropping the
wage handler yields a household that earns nothing, which reads as a pessimistic plan
rather than as a broken load.

**The equivalence tests could not survive, so they were re-cut as frozen streams.**
PAY-1/1b/2/2b/3 ran the legacy handler beside `PayrollHandler` and demanded identical
action streams; with one side deleted there is nothing to compare. They now assert
the emitted stream as an explicit list of one-line shapes
(`TYPE amount →destination (person) [employer]`). That form is strictly harder to
fool than the equivalence form was: two handlers emitting nothing are trivially
"identical" — which is why every one of those tests needed a working-detector control
— whereas a frozen list fails on silence, on reordering, and on a dropped field, and
says which. The compact shape is deliberate over a serialized object dump: a diff
nobody reads before re-cutting is not a test.

`shapeOf` reads five fields, so PAY-1 also pins the action's field SET. That is the
exact defect class P5 hit twice, when `splits` and `netAmount` went undeclared and
were stripped from the journal payload without any test noticing.

### 13.6 P5 as built — the evidence

| check | result |
|---|---|
| Unit | 5,401 pass / 0 fail (4 new withholding tests) |
| Viz | 1,043 pass / 0 fail |
| Goldens | moved −0.07% to −0.13% of lifetime tax, regolded |

**Only `FICA_ONLY` and `NONE` shipped.** §8.2's `PRIOR_YEAR_SAFE_HARBOR` is deferred,
and the reason is structural rather than effort: it can OVER-withhold when income
falls, and an over-withholding has to come back as a refund. `TaxPaymentDebitReducerBase`
debits cash and replenishes from investments when short — it has no credit path at all.
FICA alone can never over-withhold, because the liability it is credited against always
includes it, so the methods that shipped need no refund machinery. `balanceDue` is
clamped at zero regardless, so a future over-withholding is a visible no-refund rather
than a negative debit doing something unpredictable.

**The rates moved to a leaf module.** `finance/tax/us/fica-rates.js`, no imports,
following `au/super-tax-rate.js`'s precedent: the annual charge and the monthly
withholding MUST use the same rates and the same wage base, and any drift between them
would surface as a plausible-looking balance due rather than as an error. The monthly
withholding reads the same running per-person `usSsWagesByPersonYTD`, so it foots to
the annual charge exactly — including for a high earner whose OASDI stops mid-year.

**The regold signature is a pure timing change**, and that is what makes it reviewable:
lifetime tax **down** 0.07–0.13% across every golden, `us_savings_interest` down,
`au-single-homeowner` exactly 0. Cash leaves monthly instead of at year-end, so it earns
slightly less interest and slightly less tax is due on it. The number that mattered was
the *sign*: withholding while still charging the full liability would have added roughly
**7.65% of wages** to lifetime tax — and would have looked like FICA working. FICA-9
pins it directly by comparing a withholding arm against a non-withholding one at zero
interest, where the two must agree to the dollar.

**`usWithheldYTD` is finally wired at both ends.** It was written by the wages reducer
and read by nothing, and was not even in the settle's reset list, so it accumulated
monotonically for the life of the run. It now credits the liability and resets with the
other US accumulators.

**Two things caught late, both worth recording:**

1. **A `toFixed(2)` on the tax debit moved every golden by a fraction of a cent.** The
   settle previously debited the raw float. Rounding it looked harmless and was not —
   exactly what a whole-state fixture exists to catch, and a tolerance band never would.
2. **`alreadyNetted` was undeclared**, so it was stripped from the journal payload. The
   reducer saw it (the goldens would have been wildly wrong otherwise), but the audit
   trail could not explain why a withholding moved no money. `netAmount` and `splits`
   were undeclared too — `splits` since phase 2, unnoticed because no scenario in the
   manifest scan sets `wageSplits`.

**KNOWN GAP — the tax-paid report understates US federal tax.** ✅ **CLOSED in P6a
(§13.7).** The report sums CASH MOVEMENTS from the journal, and withheld FICA never
becomes a `US_TAX_PAYMENT_DEBIT`: the settle debits only the balance due. On the
reference run the report showed \$528,232 against a true \$716,456. Adding
`WAGES_WITHHELD_APPLY` to `spending-classification.js` does **not** fix it —
verified, then reverted rather than left as unverified dead code — because the report
reads neither cash movements nor action categories but declared action FAMILIES.
That is what the fix uses.

### 13.5 P4 as built — the evidence

| check | result |
|---|---|
| Unit | 5,397 pass / 0 fail (9 new in `evt-fica.test.mjs`) |
| Viz | 1,043 pass / 0 fail |
| Goldens | **8 of 9 moved**, regolded after verification; `au-single-homeowner` untouched (no US wages) |

**§8.1 was wrong about the state of the code, in our favour.** It said `usSsWagesYTD`
"has no wages feeding it". It does — `WAGES_INCOME_TAX` has accumulated it since design
69, and `_ficaWageBase` was already carrying the correct \$184,500 for 2026. What was
missing was only the employee tax itself: the model charged SECA, the 0.9% surtax and
NIIT, but no §3101 FICA, so a W-2 earner paid income tax and nothing else.

**The diff was read, not accepted** (§14.4). Measured against the wages each golden
actually runs:

| golden | wages | Δ tax | of wages | theoretical FICA | unexplained |
|---|---|---|---|---|---|
| bond-par-conservation | \$1,280,496 | \$95,304 | 7.44% | 7.65% | **−\$2,654** |
| cross-border-reference | \$2,460,431 | \$170,744 | 6.94% | 7.46% | **−\$12,828** |
| payroll-limits | \$3,415,320 | \$120,088 | 3.52% | — | (OASDI caps early on \$480k) |
| us-single-homeowner | \$3,332,812 | \$328,004 | **9.84%** | 7.52% | **+\$77,389** |

A *slightly negative* residual is the expected sign — a smaller cash pool earns less
interest, so marginally less income tax is due. **`us-single-homeowner` came back at
9.84%, above the 7.65% a tax capped at 7.65% can possibly cost**, which is a bug
signature rather than a regold. An A/B against the pre-FICA code explained it:

```
IRA_WITHDRAWAL_EARNINGS_TAX  206 -> 360    STOCK_DIVIDEND_TAX    76 -> 18
K401_WITHDRAWAL_TAX            0 ->  40    STOCK_EARNINGS_APPLY  38 ->  9
```

The taxable brokerage now depletes ~29 years earlier, so the drawdown cascade reaches
the IRA and the 401(k) — ordinary income, and hence income tax on top of the FICA. It
is a 40-year run with 21 working years, the longest career of any golden, and \$250k of
FICA plus \$77k of re-sequenced income tax compounded over that horizon works out at
≈\$2.4M against the \$2.68M of terminal net worth actually lost. Legitimate, and
precisely §15 risk 1: **a conclusion drawn from any earlier run with a working earner
should be re-examined, not merely re-run.**

**A real defect the probing exposed: the OASDI base is per EMPLOYEE, not per household.**
`usSsWagesYTD` is a household total, so two earners shared one \$184,500 base and the
model under-charged OASDI from the moment their combined pay passed it — most of a real
couple's career, and exactly this household's shape. Fixed with `usSsWagesByPersonYTD`,
keyed off the `personKey` the wage action already carried. Measured on two \$165,000
earners: **\$20,460 correct versus \$11,439 pooled**, a 79% under-charge. An absent map
falls back to the household total, which is both the single-earner answer and what every
pre-phase-4 action replays as. Medicare stays on the household total — it is uncapped,
so the distinction cannot matter.

**Three test families caught the incomplete wiring, each seeing something the others
could not:**

1. **The cross-form footing checks** (`TWE-8`, `F1040-1`) — FICA was inside `grossTax`
   but not listed on the Form 1040 document, so the visible lines stopped summing to the
   stated total. This is the check that spans two forms and it is the only thing that
   would have found it.
2. **`SE-6`'s exhaustive identity** — `grossTax === chapter1 + niit + seca + surtax` is
   now one term short. The identity is still true; it gained a term.
3. **The golden coverage gate** — `K401_WITHDRAWAL_TAX` fires in a golden for the first
   time, because the FICA cascade reaches the 401(k). Promoted out of `KNOWN_GAPS`. A
   phase that *increases* golden coverage as a side effect is worth noting.

**The design-52 lock-ins were re-based, not loosened.** Lifetime tax 630,228 → 800,974
and net worth 12,320,962 → 12,038,047, both matching the independently measured FICA
impact on that run to the dollar. The reasoning is recorded beside the constants so the
next reader does not have to re-derive it.

**Deliberately still not done:** the withholding leg. FICA currently accrues and is paid
with the annual settle like every other tax; `usWithheldYTD` remains orphaned. Phase 5
moves FICA to a monthly withholding and builds the true-up that credits it — which is
what makes the phase-2 split divide genuine take-home rather than gross.

### 13.4 P3 as built — the evidence

Two new modules: `finance/tax/us/us-contribution-limits.js` (the transcribed table)
and `finance/payroll/k401-limits.js` (the match formula and the clamps).

| check | result |
|---|---|
| Unit | 5,388 pass / 0 fail (13 new in `k401-limits.test.mjs`) |
| Viz | 1,043 pass / 0 fail |
| Existing goldens | **0 deletions, 34 insertions** — two null election fields + the accumulator |
| New golden | `payroll-limits`, which binds §401(a)(17), §402(g), §414(v) and §415(c) |

**The behaviour change, stated plainly.** `k401EmployerMatchPct` is now read as *"100%
of the first N% of pay"* rather than as a flat percentage paid regardless of the
deferral. It is numerically identical wherever the deferral covers the band — which
is every pre-existing scenario, and why no existing golden moved — and differs
exactly where the old model was wrong: someone deferring 1% into a plan matching the
first 3% is now matched 1%, not 3%. A genuinely non-elective employer contribution is
a different instrument and has its own field, `k401NonElectivePct`, rather than being
faked as a tier.

**The goldens gave P3 no protection, so it got its own.** The reference goldens defer
10% with a 4% match on \$120,000; every limit sits far above that, so a green suite
said nothing about any of them. `payroll-limits` puts a \$480,000 earner in the plan
and measures, per person per year:

| | 2026 | 2027 | 2028 | 2029-31 |
|---|---|---|---|---|
| primary deferral | \$24,500 | \$24,500 | **\$32,500** | \$32,500 |
| primary additions | \$72,000 | \$72,000 | \$72,000 | \$72,000 |
| clamps | §401(a)(17), §402(g), §415(c) | … | … | … |
| spouse | *no clamps* | | | |

The 2028 step is §414(v): the earner attains 50 that year, so \$8,000 of catch-up
headroom opens inside the fixture. The spouse is an **unclamped control in the same
run** — a golden where every person is clamped could not tell "the limits work" from
"contributions are broken".

**Two defects found while building it.**

1. **The accumulator had no reset, and §415(c) strangled everything.** The first run
   showed 76 golden fields moving and `k401ContributionsYTD.primary.additions` sitting
   at exactly \$72,000 — the annual-additions limit, reached once and never released,
   after which every contribution clamped to zero for the rest of the run. `YTD_FIELDS`
   resets flat scalars; a per-person MAP needs the map-shaped treatment the AU side
   already had. Added `PER_PERSON_US_FIELDS`.
2. **New params declared on `Person` but not on the toolset.** `k401MatchTiers` and
   `k401NonElectivePct` reached the record and the state projection but had no entry in
   `paramSchema` and were never passed to the handler, so the new golden's values were
   silently dropped. The same shape as phase 1's scheduling-gate defect: a field can be
   carried by three of the four places that matter and be entirely inert. Caught only
   by probing whether the golden's clamps actually fired — the golden itself was
   green, and green for a scenario that was exercising nothing.

**Two pre-existing tests encoded the old semantics and were reshaped, not deleted.**
Both configured a 5% "match" with *no deferral* and asserted a 5%-of-pay credit. Their
intent — employer money never touches the paycheque and is never the employee's
deduction — is still right and still worth pinning, so one now varies only the match
between two equally-deferring arms, and the other uses `k401NonElectivePct`, which is
the instrument it was actually describing.

**Deliberately not built in P3:**
- **Indexation.** The table holds the last published year flat beyond 2026, which
  understates later headroom *visibly*. §10 / phase 9 replaces it.
- **§7.5's Roth catch-up mandate.** §414(v)(7)(A) keys off prior-year **FICA wages**,
  which do not exist until phase 4. The threshold is already transcribed in the limits
  table, unused, waiting for it.
- **An explicit `trueUpMatch` flag (§7.4).** The match is computed from the annual
  election rather than from the deferral actually made each month, so a deferral that
  stops at §402(g) in September does not stop the match — i.e. the model already
  behaves as a trued-up plan, which §7.4 named as the default. A plan that does *not*
  true up is not modelled, and that is the honest description rather than a flag that
  only has one working setting.

### 13.3 P2 as built — the evidence

`src/finance/payroll/wage-splits.js` — a new `payroll/` module, which is also where
phases 4-5's FICA and withholding will live. Two exports: `splitWage()` allocates,
`creditPay()` credits. `person.wageSplits` joins `PAYROLL_ELECTION_FIELDS` so the
constructor, both serializer halves and the state projection carry it automatically.

| check | result |
|---|---|
| Unit | 5,372 pass / 0 fail (16 new in `wage-splits.test.mjs`, 3 scenario-level) |
| Viz | 1,043 pass / 0 fail |
| Goldens | pass after an **additive-only** regold: 14 × `"wageSplits": null`, **0 deletions** |

**The no-split path returns `null`, deliberately.** `splitWage` yields null for every
degenerate case — no list, nothing resolvable, or a list that after merging allocates
solely to the transaction account — and the handler then omits `splits` from the
action entirely. So the emitted action is byte-identical to phase 1 and no existing
scenario moves. That is why the only golden change is the projected null field.

**Four properties, each with a test that would fail if it were dropped:**

| property | why it matters | test |
|---|---|---|
| Σ(credited) === total, always | the remainder is `total − Σ allocated`, so rounding dust lands in the fallback structurally rather than by a reconciliation that could disagree | WS-5, over 32 configurations including repeating decimals, shortfalls, >100%, duplicate keys and rejections |
| a shortfall never goes negative | a wage event is not a spending event; overdrawing would escalate into the drawdown cascade and sell assets to fund a direct deposit | WS-6, WS-7 |
| an unresolvable destination falls back | money is never created or destroyed by a routing decision | WS-9 |
| a cross-currency destination is refused | crediting AUD from a USD wage conjures currency at an implied rate of 1.0; a real cross-currency split is an INTL transfer with an FX leg and a §988 disposal | WS-10 |

**Splitting has no tax consequence, and PAY-S2b pins it.** The tax chain keeps
carrying the gross wage; only the cash destination changes. The standing temptation
is to derive taxable income from where the money landed, which fuses two independent
axes exactly as design 73 §6b found source and residency fused — invisible until
someone splits across accounts of different tax character.

**Two things measurement changed:**

1. **Same-key allocations are merged.** "50% to the transaction account, remainder to
   the transaction account" produced two credits to one balance — arithmetically
   equivalent, but it reads in the journal as though the account were paid twice, and
   it defeated the collapse-to-null check. Merging happens before that check, which
   is what makes the check correct rather than merely usually correct. Found by
   WS-10's control, not by the assertion it was controlling.
2. **`creditPay` reconciles rather than trusts.** `splitWage`'s output always sums to
   the amount, but actions are persisted and replayed (design 81), so the reducer can
   be handed a stale or hand-edited action whose splits do not. It credits the
   difference to the fallback and warns once. An unbalanced split that silently loses
   cash is invisible in every downstream number; a warning plus a balanced ledger is
   merely untidy. WS-15.

**Not in scope, and said so explicitly:** bonuses (§6.4, D10). `BONUS` still credits
the cash pool whole.

### 13.2 P1 as built — the evidence

Elections moved from toolset parameters onto `Person`, resolved as
`person.X ?? householdDefault`. Seven fields, listed once in
`PAYROLL_ELECTION_FIELDS` (`finance/person.js`) because **four** places must agree
on them: the constructor, both halves of the serializer, and the state projection.

**`??` and not `||`, and that is the whole semantics.** `null` means "no preference
expressed — inherit the household default"; `0` means "elect nothing". With `||` a
person who had explicitly opted out of the 401(k) would silently re-acquire the
household rate and contribute a perfectly plausible-looking amount that no balance
assertion would flag. PAY-11 and PAY-P1d pin the distinction at both the handler and
the scenario level.

| check | result |
|---|---|
| Unit | 5,353 pass / 0 fail |
| Viz | 1,043 pass / 0 fail |
| Goldens | pass after an **additive-only** regold: 98 insertions, **0 deletions, 0 modifications** |

**Two defects found, and neither was reachable from the handler tests.**

1. **Both scheduling gates read household parameters only.** `_hasPayrollContributions`
   (US) and the AU SG condition tested `context.parameters` and nothing else, so a
   person could carry an election that the compiler never wired up: the field is
   written, saved, shown in the UI — and inert, because no event was ever scheduled
   to consume it. Replaced with a shared `hasPayrollContributions(people, params,
   fields)` that reads both, living next to the resolver that consumes the same
   fields. Note it treats a person who has explicitly elected 0 in every gating
   field as opted out, rather than as someone who can still inherit.
2. **`state.people` is a projection, and the elections were not in it.** With the
   gate fixed the event scheduled correctly and the contribution was *still* zero:
   `computePayroll` reads `state.people[key]`, not the `Person` record. This is the
   exact hazard `person-projection.js` was extracted to prevent — its own docstring
   describes `residencyState` going missing and silently disabling US state tax —
   and it recurred anyway on the first new field added after the extraction. The
   projection is now driven off `PAYROLL_ELECTION_FIELDS` rather than a hand-written
   list, and projects a missing election as `null`, never `0`.

**Why the regold is safe.** The additive diff *is* the projection change: seven new
nullable fields × 14 people across 8 goldens. Zero deleted or modified lines means
no computed value moved — which is exactly the reviewable, field-naming diff the
whole-state fixture design was chosen to produce, rather than a tolerance band that
would have said nothing either way.

**Scenario-level tests matter here.** PAY-P1a…d in `evt-payroll-contributions.test.mjs`
run a real compile; the handler-level PAY-9…14 could not have caught either defect,
because both live upstream of the handler. PAY-P1c's cash assertion is differential
against a no-SG arm rather than `start + wages` — an absolute figure there would have
been asserting the AU income-tax calculation, not the SG's employer-funded nature.

### 13.1 P0 as built — the evidence

| check | result |
|---|---|
| Goldens (17) | **byte-identical**, no regold |
| Payroll action counts, all 8 goldens | identical to the pre-change baseline, type by type |
| Unit suite | 5,343 pass / 0 fail (was 5,334 — the 9 new below) |
| Viz suite | 1,043 pass / 0 fail |

`tests/unit/evt-payroll-pipeline.test.mjs` (PAY-1 … PAY-8) asserts the contract the goldens
cannot state: that `PayrollHandler` emits the **same action stream** — same types, same fields,
same order — as `MonthlyWagesHandler`, `UsRetirementContributionHandler` and
`AuSuperGuaranteeHandler` for the same state. Every equivalence is paired with a
working-detector control, because two handlers that both emit nothing are trivially identical.

**A control earned its keep immediately.** PAY-2's control (`'control: Roth'`) failed on first
run: the test's own registry stub had `roth` where `ACCOUNT_ROLES.ROTH` is `'roth-ira'`, so the
legacy handler emitted no Roth contribution and the equality assertion would have passed on two
empty streams. The stub now derives from the enum. This is the exact failure mode the control
convention exists for, and it fired within a minute of the tests existing.

**Two defects found and fixed while wiring:**

1. **`UsRetirementContributionHandler` and `AuSuperGuaranteeHandler` were never in
   `_ALL_CLASSES`** (`scenario-serializer.js`). They shipped 19 Aug 2026 and have never been in
   the serializer's class registry, so a saved scenario carrying payroll contributions could not
   restore its handler — it would reload with the contribution stream silently absent. Same
   defect class as the unserialized `stateKey` pins in the AU earnings handlers: works in a fresh
   compile, vanishes on reload. Both are now registered, along with `PayrollHandler`.
2. **The AU toolset attached its own wage handler** (`au-retirement-toolset.js`, inside the
   `_auSharedDelegated` block) — a second attachment site that a grep for the handler's name in
   the US toolset alone does not reveal. An AU-only household gets its wage handler from there,
   which is why `au-single-homeowner` has no `US_RETIREMENT` toolset yet still pays wages.

**What P0 deliberately did NOT do:** the legacy handlers are still exported, still registered, and
still work. Nothing has been deleted. Per §5.2 they retire at P5, after the goldens are re-cut on
the new path — so no single change both moves numbers and removes the old route.

**P4 is the disruptive one.** It is also the one that fixes an outright omission rather than
adding fidelity, so it should not be deferred to the end on the grounds of being inconvenient.

---

## 14. Tests

### 14.1 The asymmetry test (§5.1)

The highest-value test in the design. A person defers 10% pre-tax:

- `usOrdinaryIncomeYTD` **is** reduced by the deferral;
- `usSsWagesYTD` and the FICA debit are **not**.

Paired with a working-detector control — a zero-deferral arm where both figures equal gross —
because a test that passes because both numbers are zero proves nothing. See
`mpc-lever-tests-scenario-shaped` and `offset-earns-no-yield` for what an absence test costs
when it has no control.

### 14.2 Cap behaviour

- §402(g) binds mid-year for a high deferrer; deferrals stop; match trues up or does not, per flag.
- §401(a)(17): a salary above the cap produces a match on the capped figure. Assert the *ratio*,
  not the dollar amount, so the test survives indexation.
- §415(c): deferral + match + after-tax stops at the annual-additions limit.
- s291-20 carry-forward: three arms — balance under \$500k with unused cap (applies, earliest
  first), balance over \$500k (does not apply), no unused cap (does not apply).
- Div 293 "lesser of": a case just over the \$250,000 threshold, where the naive
  `15% × contributions` answer is materially larger than the correct one.

### 14.3 Conservation and identity

- **Split conservation.** Σ(credited across all destinations) === net pay, to the cent, for every
  split configuration including the shortfall and over-100% cases. The unrealized-gain
  conservation harness (`unrealized-gain-conservation-harness`) is the model to copy.
- **Basis invariant.** `balance === contributionBasis + earningsBasis` must survive every new
  contribution path, in particular the non-concessional one that skips the 15% shave.
- **Byte-identity on the no-op path.** Absent `wageSplits`, absent elections, `withholdingMethod:
  NONE` ⇒ every existing golden unchanged. Given the sim is bit-deterministic
  (`sim-is-bit-deterministic`), assert byte-identity of the whole state, not a tolerance band.
- **Serialization.** Every new handler field in `toJSON`/`fromJSON`. Per
  `earnings-handlers-resolve-by-role`, an unserialized pin is a bug that only shows up after a
  save/reload, which no unit test catches by default.
- **Payload manifest.** New action types and fields must be declared, or the manifest gate
  silently passes them (`payload-manifest-gate-unwired`).

### 14.4 Regolding

P4 and P5 move goldens by design. Regold **once**, at the end of P5, and read the diff rather
than accepting it — the expected signature is take-home down by roughly the FICA rate and terminal
net worth down by the compounded difference. Anything else is a bug (`golden-fixture-harness`).

---

## 15. Risks

1. **The FICA correction is large and directional.** Adding ~7.65% of wages as a new cost will
   reduce terminal net worth in every working-years scenario, and reduce it most in the scenarios
   with the longest remaining career. Any prior conclusion drawn from a run with a working earner
   should be re-examined, not just re-run.
2. **The §415(c) / §402(g) YTD accumulators must survive rewind and branch.** They are the first
   contribution-side state this model has carried across months. A stale accumulator after a
   branch produces a plausible-looking wrong answer, which is the worst kind.
3. **Reading superseded SG rules.** ~~Quarterly vs annual mismatch on the SG base.~~ Dissolved by
   Compilation 78 — the base is annual now (§9.2). Kept as a note because **most secondary sources
   still describe the quarterly regime**, and the next author who checks this design against a
   commentary article will find they disagree. The Act on disk is the authority; the commentary is
   describing the law as it stood before 1 July 2026.
4. **Div 293 attributed to the fund rather than the member** would put a personal liability in
   `auSuperTaxYTD`, where the after-tax metrics would treat it as concessionally taxed. §9.4.
5. **Splits are cash routing, not tax.** If any tax figure is ever derived from split
   destinations, the model acquires a bug that is invisible until a scenario splits across
   accounts with different tax characters.
6. **OPEN, and NOT closed by this design: super's basis ledger conflates the taxable and
   tax-free components.** P6b made this reachable in a new way and could not close it; the
   reasons are in §15.1 below, because it is the one thing a reader of design 95 is most
   likely to assume was handled.

### 15.1 The super component split — why it is its own design

`contributionBasis` / `earningsBasis` is design 53's **cross-wrapper** ledger, shared by Roth,
IRA, 401(k), super and the AU brokerage. The AU taxable/tax-free split does not fit inside it:
concessional contributions (net of Div 295) and non-concessional ones both land in
`contributionBasis`, so a fund built partly from after-tax money is indistinguishable from one
built entirely from concessional money. §9.1 says a non-concessional contribution "credits the
tax-free component"; there is no such ledger to credit.

**What it currently costs, precisely.** One consumer is wrong today:
`inheritance-classes.js` computes an AU super death benefit as `taxableComponent ?? fmv` — a
hand-authored bequest field that **defaults to the whole balance**. A fund holding
non-concessional money is therefore taxed on death to a non-dependant as if all of it were
taxable, at 15% (+2% Medicare paid direct). **No golden holds a super death benefit**, so nothing
under test produces a wrong number today: the defect is latent, not live.

**Why it cannot be a further phase of this design.** Closing it needs four things design 95
never scoped:

1. **A third component on one wrapper's ledger**, breaking the two-way basis invariant
   (`balance === contributionBasis + earningsBasis`) for super alone. 64 test files touch that
   ledger.
2. **A different withdrawal ordering rule for super, inside a function four wrappers share.**
   `AccountService.reduceLedgerForWithdrawal` draws contribution-basis FIRST, then earnings —
   sequentially. **ITAA97 s307-125 forbids that for the component split**: a benefit "is taken to
   be paid in a way such that each of those components of the benefit bears the same proportion
   to the amount of the benefit that the corresponding component of the interest bears to the
   value of the interest", determined just before payment. Proportional, not sequential, and not
   electable. So this is not "add a ledger" — it is a second, incompatible drawdown rule living
   inside the seam that already carries design 84's rollover buckets and derived-income slices.
3. **A decision only the author can make**: does the proportioning rule apply to *every* super
   withdrawal, or only at death? Applying it throughout moves the drawdown numbers on every
   AU-resident plan; applying it only at death leaves the ledger self-inconsistent between the
   two paths. Neither is obviously right and design 95 has no basis for choosing.
4. **Re-deciding design 84's s99B pricing**, which reads this split to price a Roth decant. That
   is that design's decision to revisit, not this one's.

**Where to start.** `s307-125` is on disk at
`docs/au-tax/ITAA-1997/C2026C00324VOL06.txt` (with a worked example), alongside s307-215 (taxable
component) and s307-220 ff (tax-free component). The consumers to re-wire are
`au-super-classes.js`, `downsizer-contribution.js`, `inheritance-classes.js`,
`bequest-service.js`, `after-tax.js` and `AccountService.reduceLedgerForWithdrawal`.

---

## 16. Review — questions and their answers

All seven raised at draft are closed. Recorded with their reasoning so the next author can see
what was traded away, not just what was chosen.

**Q1 — One `PAYROLL` event, or keep three? → ONE.** D7. Three events communicating through state
makes the pipeline's ordering a convention enforced by `order(n)` rather than a structure, and
puts the constraint in a comment instead of the call stack. Introduced alongside the legacy three
so P0 is byte-identical and the legacy path retires only after P5's regold. §5.2.

**Q2 — Track caps, or validate them? → TRACK AND CLAMP,** journaling each clamp. D8. Warn-and-
proceed is cheaper and leaves the model projecting scenarios the IRS or ATO would reject; in a
Monte Carlo run nobody reads warnings. §7.3.

**Q3 — Where does the SSA contribution and benefit base come from? → SOURCED.** The SSA COLA fact
sheet is on disk: **\$184,500 for 2026**, \$176,100 for 2025, Medicare uncapped. Treated like
§402(g) in §4.1 — the statute for the rule, the published sheet for the applied number. §4.4, §8.1.

**Q4 — Does Payday Super change the SG base? → YES, COMPLETELY.** s15 is gone; the base is s10A(5),
annual and per-employer, derived from the concessional cap. The charge percentage is a literal 12
in s17A(2). §9.2 rewritten; one source dependency and one risk deleted. §4.3.

**Q5 — Is Div 293 creditable against US tax? → TABLED.** It is an Australian income tax on an
individual, which points toward creditable under Art 22 / §901, but it is imposed on
*contributions* rather than income received, which is at least arguable. The liability gets
modelled first (P8) and creditability is decided separately, in design 83's per-§904-basket
framing. **Not blocking**: an uncredited Div 293 is conservative, and turning credit on later
moves the number in a known direction.

**Q6 — Does the split apply to bonuses? → NO, AND SAID SO EXPLICITLY.** D10, §6.4 — a named
section rather than silence, so it reads as a decision instead of an omission. A bonus is a
separate cheque with supplemental withholding; routing it through wage splits would apply the
wrong withholding treatment.

**Q7 — Per-employer SG base now or later? → SINGLE ACCUMULATOR NOW.** D9. `Person` has one
`monthlyWage` and no employer concept, and adding an employer entity is well beyond this design.
`auQualifyingEarningsYTD` is named and shaped so a second employer extends it rather than
rewrites it, and s10A(6)(b)'s per-employer scoping is recorded in §9.2 so the gap is deliberate
and legible. The s17B shortfall exemption certificate — the instrument that exists precisely for
the multi-employer case — is out of scope for the same reason.

---

## 17. Phase 10 — the UI (✅ DONE — see §13.13 for what it took)

Design 95 built a four-stage pipeline, thirteen per-person elections, four AU
contribution streams, five statutory cap families and a set of journalled clamps.
**A user can reach almost none of it.** This phase is about that gap, and it is worth
stating the sharpest case first because it sets the priority for everything below.

### 17.1 What is already free

Not everything needs building, and the parts that do not are worth naming so nobody
rebuilds them:

- **Household parameters render themselves.** Eleven of the design's twelve household
  params have a `paramSchema` entry, and the scenario editor renders `Number`, `Money`,
  `Boolean`, `Date` and `Enum` without further work. `withholdingMethod`,
  `superSalarySacrificePct`, `superPersonalDeductibleContribution` and the rest are all
  already editable.
- **The tax return already shows the new lines.** `tax-document-modal.js` renders
  `lineItems`, so P6b's *"Personal Super Contributions Deducted (s290-150)"*, its
  *"Deduction Denied by s26-55 Limit"* companion, and P8's two Div 293 lines appear on
  the AU return with no UI work at all. §13.10's footing requirement was what made that
  true — the lines sit in the right place in the sequence, so they read correctly.
- **The journal drills exist.** Every new action type is registered and payload-declared,
  so the existing journal report plugin can already group and filter them.

### 17.2 The gaps, in priority order

**G1 — `wageSplits` is unreachable from anywhere.** D1 is the design's first locked
decision and P2 built it in full: `splitWage`/`creditPay`, four pay-apply actions
carrying `splits[]`, 32 configurations under test, Σ === total structurally. It has
**no `paramSchema` entry and no field in the person editor**, so the only way to set one
is to hand-author scenario JSON. A feature that ships with tests and no way to turn on
is indistinguishable from one that was never built.

**G2 — every per-person election is uneditable.** `PAYROLL_ELECTION_FIELDS` carries
thirteen fields. `person-editor.js` renders twelve fields and **not one of them is a
payroll election**. So P1's whole mechanism — a person's own election overriding the
household default — is UI-unreachable, and every scenario a user can build through the
workbench is a household-scalar scenario, which is exactly the pre-P1 behaviour P1 set
out to replace.

This one carries a real interaction-design problem rather than just markup. `??` not
`||` is load-bearing (§13.2): **null means inherit the household default and 0 means
elect nothing**, and those must not collapse. A number input whose empty state is
indistinguishable from zero would silently convert every "inherit" into an opt-out on
the first save. The editor needs an explicit inherit state — a placeholder showing the
inherited value, cleared to blank rather than to 0 — and the round-trip test that pins
it should be modelled on PAY-14, which already asserts an explicit 0 survives.

**G3 — `k401MatchTiers` is a param the renderer cannot draw.** It is declared
`type: 'Json'`; the scenario editor handles `Number`, `Money`, `Boolean`, `Date` and
`Enum`. D3's promise was that *"safe-harbor and 50%-on-6% become data, not code"* — as
shipped they become **hand-typed JSON**, which is data in the least usable sense. A
small tier editor (rate, up-to-% of comp, add/remove row) would close D3 properly, and
the same widget shape serves G1's split rows.

**G4 — there is no paycheque.** The design's organising idea is §5's four-stage
pipeline, and nothing anywhere shows one month of it. Everything needed already exists
on the actions: gross wage, `sacrificed`, `alreadyNetted` withholding, `netAmount`,
`splits[]`, and the contribution streams with their `clamps`. A single view —
**one earner, one month, gross down to net** — would be the most explanatory thing this
design could add, and it is assembly rather than computation.

**G5 — the clamps are journalled but not surfaced.** D8's exact promise was that a
contribution stopped by a cap should be *"visible in the output rather than inferred
from a number being lower than expected"*. Half-kept: `clamps` and `carriedForward` ride
on every affected action, but reading them means drilling the journal by hand. The
promise is only really kept when the year that clamped says so where the contributions
are shown.

**G6 — the multi-year cap state is raw JSON.** `auSuperCapsByPerson` holds the
five-year unused-cap ring, the TSB snapshot and the bring-forward arrangement — the
state that makes Div 291 and Div 292 comprehensible, and the model's first genuinely
multi-year accumulator. It is visible only as an object in the state panel. The ATO
publishes this as a table (§13.9's CAP-1 replays it); the model should show one too.

### 17.3 Decisions to lock before building

**All five were answered as recommended (26 Aug 2026) and are now LOCKED.**

| # | Question | Decision |
|---|---|---|
| U1 | Where do per-person elections live in the UI? | **In the person editor**, in a collapsed "Payroll" section. They are properties of a person, and splitting them into a separate modal would break the link with `monthlyWage` and `retirementDate` that every one of them depends on. |
| U2 | How is "inherit" expressed? | **Blank input with the inherited value as placeholder text.** Never a 0 default. See G2 — this is the one that silently corrupts saved scenarios if it is got wrong. |
| U3 | Is the paycheque a panel or a modal? | **A workbench panel**, following `spending-plugin.js` (design 89 phase 5). It wants to follow the timeline cursor, which a modal cannot. |
| U4 | Do clamps get their own report or a badge? | **Both, cheaply**: a `contributions-by-year` report grouped by person with the clamp names as a column, which the existing report registry can express declaratively. |
| U5 | Does this phase change any number? | **No.** P10 is presentation over state that already exists. Any golden movement is a defect, which makes it the second phase in this design whose success criterion is that nothing moves (P0 was the first). |

### 17.4 Suggested order

1. **G2 + U2 first.** It unblocks every other item — a paycheque view of a household
   nobody can configure per person is a view of the household default.
2. **G1 and G3 together.** Both are repeating-row editors over a list of small objects;
   built once, the widget serves both.
3. **G4**, once G1–G3 make there be something to look at.
4. **G5 and G6**, which are reports over existing journal and state.

### 17.5 Tests

The workbench suite is Jest (`tests/viz/`, 1,043 passing), so these are component tests
rather than golden ones:

- **The inherit/opt-out round trip.** Set a person's election, clear it, save, reload:
  cleared must come back `null` and never `0`. This is G2's whole risk and it is the
  same assertion PAY-14 makes at the model layer.
- **A split editor that cannot produce an invalid split.** `splitWage` already refuses
  cross-currency destinations and reconciles a stale total; the editor should not be
  able to author one that the model then has to defend against.
- **A golden-equivalence check for U5.** Build a scenario through the UI path with no
  elections set and assert the compiled config equals the household-default one — the
  P0 trick, reused: the phase is safe exactly when it cannot move a number.

### 17.6 Risk

**As built, the one that actually bit was neither U2 nor anything in this list.** U2 was
got right first time precisely because §17.6 named it — the inherit placeholder and the
round-trip test were written together. What went wrong instead was the *source* of the
inherited value: a scenario keeps its parameters in two stores, and the one every
editor reads is empty of toolset defaults until the scenario has been saved and
reloaded. Same symptom class as the risk below (a hint that silently says the wrong
thing), reached from a direction this section did not anticipate, and visible only in
the running app. See §13.13.

**The one this section watched, and it held. U2**, and it is worth being blunt about it. Every scenario the
user already has was saved with `null` in all thirteen election fields. An editor that
writes `0` for an untouched field would convert every one of them from "inherit the
household default" into "elect nothing" on the first save — silently, with no error,
and the symptom would be contributions quietly stopping in scenarios the user did not
think they had edited. The `??`-not-`||` rule that §13.2 records at the model layer has
to be honoured at the UI layer too, and it is easier to get wrong here.

---

## 18. What to read first when building this

1. **§5.1** — the four-way base asymmetry. Everything else is bookkeeping; this is the part that
   is easy to get confidently wrong.
2. **§9.2** — the SG rules changed on 1 July 2026 and most commentary still describes the old
   ones. Trust the Act on disk over any article.
3. **§2.4** — FICA's absence and `usWithheldYTD`'s orphaning are live defects in `main` today,
   independent of whether this design ever gets built.
