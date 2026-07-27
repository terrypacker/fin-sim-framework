# 85 — Cross-border tax coupling: where country-pair logic should live

**Status** (2026-08-05): **PROPOSED**. No code. Written at the end of the design-83
work, while every one of the affected files was freshly in hand.

**Revised the same day — see §9.** Design 83's last three gaps (G11, G10 part 3, G5)
were then built, and they answered two of §8's open questions and changed the proposed
interface in §4.1 twice. Read §9 before implementing anything above it.

**Recommendation: option B** — write this down now, build it in its own session, under a
hard zero-behaviour-change constraint. §6 argues the sequencing.

---

## 1. The evidence

Measured on `main` + the uncommitted design-83 work:

| | count |
|---|---|
| AU-flavoured references in `us-tax-module-2026.js` | **156** |
| — of which `residency === 'AU'` / `isAuResident` branches | 37 |
| — `toAUD()` conversions | 23 |
| — `bookAuResident()` per-person AU attribution stamps | 21 |
| US-side references in `au-tax-module-2026.js` | 63 |
| **AU accumulators the US module writes directly** | **9** |
| files touching both countries' tax state | 12 |

The nine:

```
auOrdinaryIncomeYTD          auCapitalGainsYTD             auDiscountableGainsYTD
auPersonOrdinaryIncomeYTD    auPersonCapitalGainsYTD       auPersonDiscountableGainsYTD
auPersonUsSourceOrdinaryAudYTD  auPersonUsSourceCapGainsAudYTD  auPersonUsSourceRealCapGainsAudYTD
```

The concern is well-founded, and the sharpest way to put it: **a US tax classifier is
currently deciding how Australia attributes income between spouses.** `bookAuResident`
resolves AU ownership fractions and writes AU per-person maps, from inside
`us-tax-module-2026.js`. That is not a treaty question and it is not a US question.

---

## 2. Three kinds of coupling, and only one of them is treaty logic

This is the analytical core, and it is why a single "TaxTreaty module" does not by
itself fix the problem. The 156 references are three unrelated things:

### Category 1 — domestic law that merely *keys off* residency

`§865(a)`/`(g)` sources personal property by the seller's **tax home**. `§911` FEIE
requires a **foreign tax home**. NIIT reaches **worldwide** investment income. All three
are pure US law. They belong in the US module and always did.

The defect is narrower than it looks: the code asks *"is `residency === 'AU'`"* where
the statute asks *"does this person have a foreign tax home"*. Generalising the
predicate deletes the country name **without moving any code**. Cheapest win here, and
it retires a large share of the 37 branches.

Naming matters more than it sounds: `isPersonalPropertyGainForeignSource(state)` reading
`state.auCgtEffectiveRate` is a US rule reaching for an AU-named field. The rule wants
"foreign tax actually paid on this gain, as a fraction of it" — a country-neutral fact
about the taxpayer's residence country, whichever that is.

### Category 2 — genuinely bilateral treaty logic

Re-sourcing (Art. 27(1)(c)), relief ordering (Art. 22(2)/(4)), the Art. 10/11 rate caps,
pension category assignment (Art. 18), and the §904 basket-character map for re-sourced
income. These are properties of the **pair**, belonging to neither module. This is what
a treaty module is for — and it is maybe a fifth of the mess.

### Category 3 — one economic event, two returns

`bookAuResident` × 21, `toAUD` × 23, the nine AU accumulators. **This is the largest
category and the least defensible**, and it is not treaty logic at all. It exists
because a single event — a dividend, a share sale — has to be reported on two returns
in two currencies with two ownership models, and the module that happens to own the
event type writes both.

A treaty module does **not** fix this. The fix is a different seam: classifiers emit a
country-neutral economic fact, and each country's module projects it onto its own
return. §4.2.

> **Recording this because it is the thing most likely to be got wrong:** adopting the
> TaxTreaty idea alone would feel like progress and leave category 3 — the biggest and
> noisiest part — exactly where it is.

---

## 3. On the two shapes proposed

**"Countries register tax hooks into each other's modules" — recommend against.**
It gives N² registrations for N countries, the logic still physically lives inside
country modules, and there is no single place to answer *"what does the US–AU treaty
say?"*. It relocates the coupling into a registration table without removing it. It also
makes the AU module's behaviour depend on which other modules happen to be loaded, which
is a bad property for a deterministic simulator.

**"A TaxTreaty module looked up at execution time" — right shape, with one correction
to the key.**

The proposal says *"looked up based on account location and residency"*. **Account
location must not be in the key.** Design 83 G10 established, at length, that account
domicile is not a sourcing rule — §865(a) sources by the seller's residence, and the
model had a \$19.4m misclassification precisely because it sourced by where the
brokerage account sat. Putting account location in the lookup key would re-introduce
that bug at the architecture level.

The key is **(residence country, source country, tax year)**. Source country is a
*derived* fact — the output of a sourcing rule — not an input.

The year belongs in the key for the same reason it is already in `TaxEngine._modules`
(`${countryCode}_${year}`, resolved to the latest ≤ target): the 2001 Protocol replaced
Articles 10 and 11 outright, so a treaty is a time series, exactly like a rate table.
**The existing registry is the pattern to extend, not a new invention.**

---

## 4. Proposed structure

### 4.1 The treaty registry (category 2)

```
TaxTreatyRegistry.resolve(residenceCc, sourceCc, year) -> TaxTreaty | null
```

with a `UsAuTreaty2001` implementing a small, explicitly bilateral interface:

| method | replaces | authority |
|---|---|---|
| `sourceOverride(item, ctx)` | the re-sourcing scattered through the US classifiers | Art. 27(1) |
| `withholdingCap(itemType)` | `TREATY_DIVIDEND_CAP` / `TREATY_INTEREST_CAP` in `tax-settle-classes.js` | Art. 10(2), 11(2) |
| `exclusiveTaxingRight(itemType)` | the G10 part 3 / G11 questions, currently unmodelled | Art. 18(1), 18(2) |
| `reliefOrdering()` | the FITO ↔ FTC handoff ordering | Art. 22(2), 22(4) |
| `basketCategory(itemType)` | the general/passive map now inlined at 19 classifier sites | Pub 514 + Art. 18(5) |

Null resolution is meaningful and must be handled: **no treaty** is a real case (a
country pair with no convention), and it should degrade to domestic law on both sides
rather than throw.

### 4.2 The projection seam (category 3)

The bigger change, and the one that actually removes `bookAuResident` from the US module.

Today: `STOCK_DIVIDEND_TAX` → the US classifier writes US buckets, AU buckets, AU
per-person maps, the removal set in both currencies, and two subset tags.

Proposed: the classifier emits a country-neutral **taxable fact** —

```
{ itemType: 'DIVIDEND', amount, currency, ownerId, sourceCc, payerCc, … }
```

— and each *resident* country's module projects it onto its own return, applying its own
attribution and its own currency. The US module stops knowing that Australia has
per-person assessment; the AU module stops knowing that the US has a §904 basket.

This is the piece that makes country three cheap instead of quadratic, and it is
strictly larger than the treaty registry. It should be phased second, not first.

### 4.3 What stays put

- Everything in category 1, generalised from "AU" to "the residence country".
- `tax-fx.js` — currency conversion is infrastructure, not coupling.
- `tax-settle-classes.js` orchestration. The settle *is* the bilateral moment; a
  treaty-aware handoff living there is correct, provided the rates and ordering come
  from the treaty module rather than from constants defined next to the handler.

---

## 5. What this would have to preserve

Non-negotiable, and the reason §6 recommends a separate session:

- the §904 invariants (`_assertFtcInvariants`) stay armed throughout;
- lifetime US and AU tax on the reference plan **bit-identical**, both before and after;
- `usSource{General,Passive}UsdYTD` keep their identity — design 83 G8 showed that a
  merged accumulator cannot be un-merged for the FITO counterfactual;
- **no state-field renames in phase 1.** The schema is flat and country-named
  (`auPersonUsSourceCapGainsAudYTD`), and saved scenarios carry it. Moving *code* is
  reversible; renaming persisted state is a migration. Keep them in separate phases.
- **`usSource*UsdYTD` vs `foreign*IncomeYTD` is a THREE-way distinction, not two**
  (added §9.2). Both feed the same §904 numerator; the difference is whether the income
  is in Australia's Art. 22(2) credit base. An Art. 18(1) pension is US-source under
  domestic law and still belongs in the *foreign* accumulator. Nothing in the field
  names says so, which makes this the easiest of these five to break.

---

## 6. Why B, not A or C

**Not A (table it).** The pain is real, named, and measured. It compounds with the third
country, and the design-83 work made it worse — G3 added per-character accumulators, G10
added a §865 predicate reading an AU-named field.

**Not C (build it now, convert at the end).** C's benefit is "feed new changes into the
new structure", and there is very little new work left to feed it:

| remaining design-83 gap | size | benefits from new structure? |
|---|---|---|
| G11 — AU taxing US social security | tiny, one classifier | marginally |
| G10 part 3 — Art. 18(1) pensions | a recorded position, not a build | no |
| G5 — Art. 22(4) ordering | a *decision* problem, not a code problem | no |
| G7 — AU house sale | deferred | n/a |

Against that thin benefit, C carries a specific and serious cost: **it entangles a
refactor with tax-correctness changes.** This session moved lifetime totals five separate
times, each time with a measured, attributable cause. Mixing in a structural change means
the next unexplained delta cannot be attributed to either. The whole reason design 83's
findings are trustworthy is that each was isolated and measured.

**B, with two riders that recover most of C's value for free:**

1. Write this now — done — while the coupling is fresh. It is a proposal, so it costs
   nothing to revise when the implementation session actually starts.
2. Apply a *don't make it worse* rule to the remaining design-83 gaps: G11 and G10 part 3
   should not add new `residency === 'AU'` branches or new AU accumulator writes from US
   code. Both are small enough to comply without the seam existing yet.

Then implement in its own session, in phases, with the §5 constraint.

### Suggested phasing

| phase | scope | verification |
|---|---|---|
| **1** | Category 1: generalise the residency predicates. No moves, no renames. | totals bit-identical |
| **2** | Treaty registry + `UsAuTreaty2001`; move the rate caps, basket map and re-sourcing into it. | totals bit-identical |
| **3** | Projection seam (§4.2): classifiers emit facts; per-country projection. | totals bit-identical |
| **4** | State-field renames + saved-state migration. | migration test |
| **5** | Add a third country as the actual proof. Until something else is plugged in, this is all theory. | new country's tests |

Phase 5 is the honest one. Every argument above is a prediction about a generalisation
nobody has exercised yet; a third country is what turns it into evidence.

---

## 7. Decision record

| # | question | decision | why |
|---|---|---|---|
| 1 | Table, doc, or build now? | **Doc now, build separately (B)** | little new work to feed a new structure; mixing a refactor with correctness changes destroys attribution (§6) |
| 2 | Countries register hooks into each other? | **No** | N² registrations, logic stays in country modules, no single place to read the treaty (§3) |
| 3 | Treaty module keyed by account location? | **No — (residence, source, year)** | design 83 G10: account domicile is not a sourcing rule; source is *derived* (§3) |
| 4 | Does a treaty module fix the coupling? | **Only ~a fifth of it** | category 3 — one event, two returns — is bigger and needs the projection seam (§2) |
| 5 | Where does §865 sourcing live? | **US module, generalised** | it is domestic law that keys off a foreign tax home, not treaty law (§2) |
| 6 | Rename state fields in phase 1? | **No** | saved scenarios carry the flat country-named schema; renaming is a migration, not a move (§5) |
| 7 | How is the refactor verified? | **Lifetime US+AU totals bit-identical** | the only contract strong enough to make a no-op refactor believable |
| 8 | Is one `sourceOverride(item, ctx)` per item enough? | **No — key it by relieving paragraph** | the same dollar is US-source domestically, non-US-source for Art 22(2) and AU-source for Art 22(4) (§9.2) |
| 9 | Does `exclusiveTaxingRight` cover Art 18? | **No — the saving clause is a second axis** | Art 1(4)(a) carves out 18(2) and 18(6) *by paragraph*; article granularity fails silently toward over-relief (§9.3) |
| 10 | Can Art 10/11 and Art 22 move into the registry separately? | **No — one unit** | design 83 §18.3: the rate caps went from 0 to 20 binding years purely because the relief ordering changed (§9.5) |

---

## 8. Open questions

- ~~**Does the treaty module own sourcing, or only override it?**~~ **ANSWERED — §9.2.**
  Worse than "narrows": design 83 G10 part 3 found a dollar that is US-source under
  §861/§865, *not* US-source for Art. 22(2), and *AU-source* for Art. 22(4), all at
  once. Source is a fact **per relieving paragraph**, so `sourceOverride` needs the
  purpose in its key.
- **Where does per-person attribution belong?** Australia has no joint assessment and
  the US files jointly. That is not a treaty difference, it is a difference in what a
  "taxpayer" is, and the projection seam has to carry it without either module knowing
  the other's model.
- ~~**Is `TaxEngine`'s `${cc}_${year}` resolution the right precedent for treaties?**~~
  **ANSWERED: no — §9.4.** The 2001 Protocol replaced Articles 10, 11, 16 and 21
  outright, amended 1, 2, 4, 7, 8, 12, 13 and 22 in part, and left 18 and 27 untouched.
  Model the treaty as a set of **articles**, each with its own effective-date chain.
- **What is the actual third country?** The generalisation cannot be validated without
  one, and its shape will decide several of the above. If one is likely, its identity is
  worth knowing before phase 2.

---

## 9. Evidence from the design-83 close-out (2026-08-05)

Written after G11, G10 part 3 and G5 landed — the three gaps §6's table used to argue
that C (build the structure now) had too little left to feed it. That argument held.
What follows is what the three builds taught about the *shape* proposed above, since
§6 promised this doc would be revised when the implementation session starts.

### 9.1 §6's rider was met, and the counts moved the right way

The rider was *"G11 and G10 part 3 should not add new `residency === 'AU'` branches or
new AU accumulator writes from US code."* Measured on `us-tax-module-2026.js` with the
same patterns §1 used:

| | §1 (design-83 WIP) | after this session |
|---|---|---|
| `residency === 'AU'` / `isAuResident` branches | 37 | **32** |
| `bookAuResident()` call sites | 21 | **18** |
| `toAUD()` conversions | 23 | **20** |

Be honest about what that is. G11 genuinely **deleted** a branch and an AU write —
Social Security no longer touches the AU return at all. G10 part 3's reduction is
mostly **consolidation**: three classifiers that each open-coded the same AU booking
now call one `bookArt18Pension` helper. Category-3 coupling was deduplicated, not
removed; the US module still writes AU accumulators, just from one place instead of
three. That is a smaller win, but it is the right shape of one — a single helper is
what a projection seam eventually replaces.

### 9.2 §8's first open question is answered, and the answer changes §4.1

> *"Does the treaty module own sourcing, or only override it? Art. 27(1) deems source
> for treaty purposes while §861–865 source for domestic purposes, and the two answers
> can differ for the same dollar … that needs checking against a fact pattern where
> the treaty **narrows** rather than moves source."*

Design 83 G10 part 3 is that fact pattern, and it is worse than "narrows". An
Art. 18(1) pension paid to an AU-resident US citizen is simultaneously:

- **US-source** under §861/§865 (domestic law — the trust and the services are both US);
- **not US-source** for Art. 22(2), because Art. 27(1)(b) refuses to deem income
  US-source when the US taxes it solely by reason of citizenship;
- **AU-source** for Art. 22(4), because Art. 27(1)(c) resources it to Australia to the
  extent necessary to give effect to that paragraph's relief.

**Source is not one fact. It is a fact per relieving paragraph.** So
`sourceOverride(item, ctx)` in §4.1 has the wrong arity — it presumes a single answer
per item. It needs the *purpose* in the key:

```
sourceOverride(item, ctx, { forArticle: '22(2)' | '22(4)' }) -> cc | null
```

The model already encodes this correctly by accident of accumulator design:
`usSource{General,Passive}UsdYTD` means "foreign for §904 **and** US-source for 22(2)",
while `foreign{General,Passive}IncomeYTD` means "foreign for §904, and **outside** the
22(2) base" — which is where the Art. 18(1) pension goes. Design 83 §17.3 has the
three-way table. **Any refactor must preserve that distinction**; §5's list of
non-negotiables now has a fourth entry, and it is subtler than the three already there
because nothing in the field *names* says what the difference is.

### 9.3 `exclusiveTaxingRight(itemType)` is not enough — the saving clause is a separate axis

§4.1 proposed one method for the G10-part-3 / G11 questions. Building them showed they
are the **same** question with opposite answers, and what separates them is not the
taxing right at all:

| | Art. 18(2) — Social Security | Art. 18(1) — pensions |
|---|---|---|
| exclusive right | US (paying State) | Australia (residence State) |
| named in Art. 1(4)(a)'s carve-out | **yes** | **no** |
| effect | Australia may not tax it | Australia taxes; US taxes too, on citizenship |

Both are "exclusive taxing right" answers from `exclusiveTaxingRight`, and they produce
completely different bookings — one removes income from a return, the other removes only
a *credit*. The deciding fact is a list of paragraph numbers in Art. 1(4). So the
interface needs a second, orthogonal predicate:

```
survivesSavingClause(article, paragraph) -> boolean
```

keyed **by paragraph, not by article** — Art. 1(4)(a) names "paragraph (2) or (6) of
Article 18" and omits (1) and (3). An article-granular treaty model gets this wrong,
and gets it wrong silently, in the direction of over-relief.

### 9.4 §8's third open question, confirmed: a whole-treaty year key is too coarse

> *"Treaties amend by protocol with effective dates that can differ per article … A
> whole-treaty year key may be too coarse."*

Confirmed in the strongest possible way by what design 83 had to read. The 2001
Protocol **replaced Articles 10, 11, 16 and 21 outright**, amended 1, 2, 4, 7, 8, 12,
13 and 22 in part, and left **18 and 27 untouched** — and §16, §17 and §18 of design 83
turn on Articles 18, 22 and 27 while §15 turns on the replaced 10 and 11. A single
`UsAuTreaty2001` object resolved by year would have to carry both vintages internally
anyway, so the year key buys nothing and hides the real structure. **Model the treaty
as a set of articles each with its own effective-date chain**, the way
`us-tax-rates-base` already carries per-year rate modules.

Design 83 §19.2 records the concrete cost of *not* doing this by hand: two citations in
that document and one in the code pointed at the 1982 Art. 21(2), which the Protocol
had replaced. The substance survived, so nothing moved — but nothing in the model or
the prose could have told anyone.

### 9.5 Two provisions turned out to be non-separable, which constrains the phasing

§4.1 lists `withholdingCap(itemType)` (Art. 10/11) and `reliefOrdering()` (Art. 22)
as separate methods, and §6's phase 2 proposes moving both into the registry in one
step under a bit-identical-totals constraint.

Design 83 §18.3 shows they are coupled: the Art. 10/11 ceilings were measured as
binding in **0 of 39 years** before G5 and **20 of 39** after it, because G5 quadrupled
the quantity the ceiling is tested against. Moving the caps into a registry while
leaving the ordering behind — or vice versa — would satisfy "totals bit-identical" only
if both moved together. Phase 2 must move Art. 10, 11 and 22 as one unit, and its
verification must include the *number of years the cap binds*, not just the totals: a
refactor that silently made the ceiling inert again would keep lifetime tax within
tolerance for years before anyone noticed.

### 9.6 §6's judgement, re-scored

| §6's claim | outcome |
|---|---|
| G11 "tiny, one classifier" — benefits from new structure *marginally* | correct; one classifier, and it *reduced* the coupling |
| G10 part 3 "a recorded position, not a build" | **wrong** — it was a build, and it produced §9.2, the sharpest structural finding in this doc |
| G5 "a decision problem, not a code problem" | correct; the fix was two lines, and the work was entirely in deciding which two |
| don't mix a refactor with correctness changes | **strongly vindicated** — the session moved lifetime totals three more times, each attributable to one named cause. That attribution is the whole reason the results are trustworthy, and it would not have survived a concurrent refactor. |

The recommendation is unchanged: **option B**. Build it in its own session, in the
phases of §6, with §5's constraints plus the fourth one from §9.2.
