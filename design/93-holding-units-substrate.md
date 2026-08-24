# 93 — Units as the holding substrate: making par, and eventually shares, unfalsifiable

**Status** (2026-08-24): **COMPLETE except Option C. §4, §5 (5a/5b/5.3/5.4/5.5) and §7 are BUILT; §6's Option C is handed to design 94.** Option A is chosen (§6.1). The eight par
defects it diagnoses are already **fixed** point-by-point (design 66 §10.6b and the
sites listed in §2); this document exists because fixing them one at a time is not a
strategy — five more sites are armed and unfired (§2.3). §6's equity question is
**ANSWERED** (§6.1): Option A now, Option C the destination, B rejected.

Design 25 gave every account an explicit `Holding[]` and made it the source of truth.
Design 66 then put *individual bonds* in that array — instruments whose principal is a
conserved quantity — and the substrate had no way to express conservation. Eight
wealth-creating or wealth-destroying defects followed, none of them visible to the golden.
This document works out what the substrate was missing, fixes it in a way design 25 would
have recognised, and asks whether the same change is the foundation for equity shares.

**Scope.** The representation of a holding's value: what is stored, what is derived, and
who is allowed to write it.

**Out of scope, named so they are not assumed in:**

- Any change to what a bond *does* — coupons, accretion, pull-to-par, redemption, ladder
  mechanics. Design 66 owns those and this document changes none of them, with the single
  exception in §5.3 (a live bug that the substrate change fixes for free).
- A `Security` entity, tickers, or per-instrument price series. §6 names what these would
  cost and why they are the real content of "equity shares"; it does not specify them.
- Options, RSUs, vesting. They are consumers of §6, not of this document.

---

## 1. What design 25 decided, and why this is a departure from it rather than a gap in it

Design 25 §1 shifted the source of truth from `Account.balance` to `Account.holdings`, and
§4 stated the rule that matters here:

> `unrealizedGainLoss` is derived; computed by `AccountService.unrealizedGainLoss(holding)`.
> **Not stored on state to keep the source-of-truth narrow.**

and

> **State is plain data.** No methods, no derived getters inside `sim.state`;
> `structuredClone` is used for snapshots.

Design 25 therefore chose a deliberately narrow, dollar-denominated primitive —
`marketValue` and `costBasis` — and refused to store anything it could compute. That was
correct, and it is *still* correct.

Design 66 §G4 added `faceValue`: a second, independently-maintained value field that must
move in lockstep with `marketValue` for some changes and must stay fixed for others.
Nothing enforced the lockstep. That is exactly the situation design 25's rule existed to
prevent, and the failure mode was not a wrong label — it was a money pump (§2.2).

**The conclusion this leads to is important for the fix:** the rule was right and needs
*enforcing*, not replacing. Anything proposed below that would require a derived getter on
a state object is wrong on arrival, because `structuredClone` snapshots — used by history,
MPC injection and replay — silently drop getters. §4 respects that.

## 2. The defect class

### 2.1 Two changes, one syntax

A holding's value changes for two physically different reasons, written identically:

```js
{ ...h, marketValue: <new number> }
```

| | what happened | par must |
|---|---|---|
| **Unit change** | you own more or less of the instrument — buy, sell, deposit, withdrawal, rollover, conversion, lot merge, balance rescale | **move with it** |
| **Price change** | same instruments, different quote — rate mark, pull-to-par, shock revaluation, CPI accretion | **stay fixed** |

Nothing in the type, the field name, or the call site distinguishes them. Correctness at
each of ~46 write sites depends on the author knowing which one they are performing and
remembering a second field by hand.

### 2.2 Why a stale par is a pump, not a typo

`faceValue` is authoritative twice over:

- `BondPriceAdjustReducer` pulls a bond's price **toward** it every period;
- `BondMaturityReducer` redeems **at** it.

So a par that no longer describes the position does not merely misreport — it becomes a
target the engine actively converges the position onto, every period, forever. Both signs
were observed in practice:

- a deposit that raised market value against a frozen par left pull-to-par **destroying**
  value every period thereafter;
- a rebalancer sell that lowered market value against a frozen par had pull-to-par
  **regenerating roughly 92% of everything sold** on the next mark.

Neither is self-limiting, and both compound.

### 2.3 The count

Measured across `src/finance`:

- **46** sites assign `marketValue:` on a holding.
- **9 files** write it with no `faceValue` awareness at all — among them
  `behavioral-panic-sell-apply-reducer`, `stock-harvest-apply-reducer`,
  `opportunistic-rebalance-apply-reducer`, `asset-location-rebalance-apply-reducer` and
  `inheritance-classes`.
- **8** defects found and fixed during the design-66 ladder study (design 66 §10.6b);
  **7 of them pre-existing**, one introduced by the ladder work itself.
- Of the 9 par-unaware files, roughly **5 are armed but unfired** — correct today only
  because bonds do not currently flow through those paths. `revalue-asset-reducer` is the
  one that is *correctly* par-unaware, because a shock is a price change.

That last line is the argument for this document. The remaining sites are not bugs anyone
introduced; they are bugs the substrate will introduce on the next feature that routes a
bond through a code path someone wrote before bonds had par.

### 2.4 Why the golden never saw any of it

The default scenario's bond sleeves are **perpetual funds** — no `maturityDate`, therefore
no `faceValue`, therefore no par-handling path can touch them. Every one of the eight
defects was invisible to a full-suite green run, and each was ultimately found by a human
noticing an implausible number in a finished report. §7 treats this as the highest-value
item in the document, independent of everything else.

## 3. The substrate

A position is `units` of an instrument. Everything else about its value is that count
times a per-unit quantity:

| stored | meaning | who writes it |
|---|---|---|
| `units` | how many of the instrument | **unit changes only** |
| `pricePerUnit` | current quote | **price changes only** |
| `parPerUnit` | contractual principal per unit; constant for the instrument's life | set at acquisition |

and then, denormalized:

```
marketValue = units × pricePerUnit
faceValue   = units × parPerUnit
```

A unit change writes `units`; both values move together, necessarily. A price change
writes `pricePerUnit`; par cannot move, necessarily. **The defect class in §2 becomes
unrepresentable** — there is no way to express "change the value" without saying which
kind of change it is.

### 3.1 Denormalized, not derived-at-read

`marketValue` is read in hundreds of places and `structuredClone` cannot carry a getter
(§1), so `marketValue` and `faceValue` stay **plain stored scalars** — kept in sync by a
single choke point, exactly as design 25 already treats `Account.balance`:

> `Account.balance` continues to exist as a denormalized scalar kept in sync by reducers —
> preserving every existing read site and matching the framework's plain-data-state
> convention — but the source of truth shifts to the holdings array.

This document applies that same sentence one level down. `_syncBalance` already exists as
the account-level choke point; `_syncHolding` is its holding-level twin. Every read site
in the codebase continues to work untouched; only writers change.

### 3.2 What this does not fix by itself

Storing `units` does not, on its own, stop a careless site from writing `marketValue`
directly and desynchronising it. The data model makes the invariant **expressible and
checkable**; §4 is what makes it **enforced**. Both halves are needed, and §4 is worth
doing even if §5 never happens.

## 4. Stage 1 — encapsulate the distinction — **BUILT** (2026-08-24)

> **Status: DONE.** `resize()` / `addValue()` / `reprice()` in `holding-utils.js`, plus
> `tests/unit/holding-value-write-gate.test.mjs` — a `@babel/parser` pass that fails the
> build on a raw `{ ...holding, marketValue }`.
>
> **The gate targets the mutation SHAPE, not the field.** Constructing a fresh holding
> with a market value is safe (a new lot has no par to fall out of step with); only
> spread-plus-override can silently desynchronise a field it did not mention. Measured:
> **32 such sites** across 16 files — a much tighter target than the 46 raw `marketValue:`
> writes §2.3 counts.
>
> **Per-site annotations, not a file allow-list.** An allow-list would have had to name
> `holdings-fifo`, `bond-maturity-reducer`, `bond-ladder-reducer`,
> `rebalance-to-target-apply-reducer`, `account-service` and `holdings-earnings` — i.e.
> exempt precisely the files the defects lived in. A site instead satisfies the gate by
> using a primitive or carrying `par-reviewed: <reason>`, so a NEW raw write in an
> already-annotated file still fails, and all 21 survivors carry a stated reason a
> reviewer can disagree with. The count is asserted too, so deleting an annotation to get
> green shows up as drift rather than silence.
>
> **Converted (11 sites):** the five par-UNAWARE reducers §2.3 flagged as armed and
> unfired — `stock-harvest`, `asset-location-rebalance`, `behavioral-panic-sell`,
> `opportunistic-rebalance`, `revalue-asset` — plus the rebalancer's buy and sell legs,
> `bond-price-adjust`'s mark, the coupon-reinvest merge, and `holding-utils`' own
> `_scaleOne` / `distributeHoldingsCredit` internals, which were duplicate copies of the
> rule the primitives now own.
>
> **A finding worth its own decision (§9.5): the codebase disagrees with itself about
> rounding.** Converting `AccountService.transaction` to the primitives moved a
> whole-portfolio total by 21 cents and broke a test. The primitives round each value
> write to cents; that loop is deliberately UNROUNDED, apportioning with a last-lot
> remainder so the parts sum exactly. Both are defensible, they cannot both be right, and
> §4 was supposed to be behaviour-preserving — so the conversion was reverted and the site
> annotated. The inconsistency is real and predates this work.
>
> **`split()` was NOT written, and the reason is informative:** in a dollar-denominated
> model a share split is unrepresentable. Two-for-one is twice the units at half the price
> and half the par per unit — every dollar total is unchanged, so the operation is a
> literal no-op on `{marketValue, costBasis, faceValue}`. §6.2 item 5 asked for it as proof
> the substrate could express what C needs; the proof came back negative, which is a point
> FOR §5 rather than against it. It lands with `units`.

### 4.1 Original rationale

Two named operations replace raw assignment:

```js
resize(holding, factor)      // unit change: scales marketValue, costBasis, faceValue,
                             // costBaseByCountry — everything that travels with units
reprice(holding, newValue)   // price change: marketValue only
```

Then convert the ~46 sites, and add a **static AST test** that fails the build on a raw
`marketValue:` write outside those helpers and the serializer. The repo already runs
static AST passes (the design-91 payload-manifest work), so the machinery exists.

This alone would have prevented **7 of the 8** defects — every one except the TIPS floor
in §5.3, which is a semantics bug rather than a lockstep bug. It changes no stored shape,
so it cannot move the golden, and it is revertible in one commit.

**Do this first regardless of what is decided about §5 and §6.** It converts the invariant
from something each author must remember into something the build refuses to let them
forget, and it forces every existing site to *declare* which kind of change it performs —
which is most of the work of §5 anyway.

## 5. Stage 2 — bonds on units — **BUILT** (5a and 5b, 2026-08-24)

> **5a DONE (2026-08-24).** The representation, migration and Option-C seam, with nothing
> yet reading them — a dark launch, so it is reviewable on its own and **every golden is
> unmoved**. Delivered:
> - `Holding.units` / `parPerUnit` / `pricePerUnit` / `cpiIndexRatio` / `securityId`,
>   round-tripping. **Assigned only when present**, which is load-bearing rather than
>   tidy: `normalizeState` keeps explicit nulls, so defaulting them would add five fields
>   to every holding in every fixture and put an unrelated diff on every future change.
>   A test pins that.
> - `instrumentOf(h)` — the Option-C seam (§6.2 item 3). Reads inline today; becomes
>   `securities[h.securityId]` under C, changing one function instead of every consumer.
> - `syncHolding(h)` — the holding-level twin of `_syncBalance`, re-deriving `marketValue`
>   and `faceValue` from the unit count for a unitised holding, passing a scalar through.
> - `promoteToUnitised(h)` — value-preserving migration, and deliberately NOT run on load:
>   promotion is an act, not a side effect of deserialization.
> - `indexedRedemptionValue(h)` — §5.3's fix, computing redemption from `cpiIndexRatio`
>   and applying the deflation floor without ever consulting the market price.
>
> **5b DONE (2026-08-24).** The bond paths read and write units; the money-in paths open
> lots instead of blending; §5.3's redemption bug is fixed. Delivered:
> - **`PAR_PER_UNIT = 100`, and `unitiseBond()` as the one place it is applied.** Every
>   engine-created bond — ladder rung, tail rung, roll — is issued at it, so `parPerUnit`
>   is instrument-level as §6.2 item 3 requires. A par equal to the position's whole face
>   is position-scaled and could never move onto a shared `Security`, which would have made
>   Option C a re-cut of every lot rather than a field move. `promoteToUnitised` was
>   changed from 5a's `units: 1` for the same reason.
> - **The primitives are mode-aware, not branched.** `resize` scales `units` and re-derives;
>   `reprice` moves `pricePerUnit` and re-derives; both pass a scalar through untouched. A
>   fourth primitive, **`establish()`**, absorbed four hand-written copies of "there are no
>   units to scale, so the money becomes the position".
> - **`projectHoldingsToState`** promotes at the config→run boundary in both toolsets — so
>   §5.3 reaches an AUTHORED bond, not only an engine-built ladder — without ever rewriting
>   a saved scenario. Shared, because this repo has had three drifted copies of the
>   `state.people` projection.
> - **A migrated TIPS recovers `cpiIndexRatio` from `marketValue / faceValue`.** Not
>   cosmetic: under the scalar convention the accretion lives in the price, so promoting at
>   a flat ratio of 1 would have redeemed a seasoned TIPS at its ORIGINAL par. Promotion now
>   reproduces the pre-93 `max(marketValue, faceValue)` exactly at the moment it happens.
> - **`HoldingTransactAction.cpiIndexRatioFactor`** (payload manifest updated): accretion is
>   ONE event — the principal indexes, the price follows, the basis steps up — so a replay
>   cannot apply two of the three.
>
> **The invariant that makes it unfalsifiable, and the bug that proved it necessary.**
> A unitised holding derives its value from its count, so a raw `marketValue` write leaves
> the count behind and the next `syncHolding` silently reverts it. Flipping the paths while
> the ladder's absorption still wrote by hand evaporated **40% of the golden's 401(k)** —
> and the whole-state fixture reported it as "355 fields differ", the same undiagnosable
> signal §7 exists to replace. `bond-par-conservation.test.mjs` gained a second walk that
> names the reducer and the lot; verified by reintroducing the raw write. It carries a
> non-vacuity guard and states what it cannot see: a write followed by a `syncHolding`
> stays *consistent* while being *wrong*, and §7's par invariant is what catches that.

### 5.0b What the flip actually cost, measured

- **Whole-portfolio effect: +0.016% net worth, +0.005% lifetime tax** on the
  `bond-par-conservation` golden (net worth 5,894,768.82 → 5,895,721.12). Σ market value
  and Σ par stay **equal to the cent** in every laddered account before and after, which is
  the property the golden exists to hold.
- **The structural change is lot count, not value.** k401 went 4 lots → 12 over eight
  years, spouse-401(k) 4 → 9: the absorbed money now opens its own tail rung instead of
  inflating the standing four. That is **~1 added lot per year per laddered account**, and
  it is *not* bounded the way §5.0a assumed — `_compactSeasonedLots` only merges the
  rebalancer's own `reb-` lots, and two absorption rungs of different vintages carry
  different locked coupons, so they are not fungible anyway. Over a 40-year run expect ~40
  extra lots in a laddered account. Benign at this size; named rather than hidden, and a
  ladder-lot compaction is the obvious follow-up if it ever bites.
- **§5.0 problem (2) did not materialise.** The prediction was that re-basing TIPS accretion
  onto the index ratio would move the golden and lifetime tax with it. Measured on a TIPS
  ladder run both ways, the two bases agree **to the cent** (accretion 6,585.34 either way).
  The reason is that basis is stepped by each year's accretion, so it compounds exactly like
  the principal — the proxy was right wherever basis tracks principal, which is every path
  these scenarios reach. It diverges only where basis carries something that is not
  principal: a rebuild's carryover basis, an absorbed lot's basis, a premium or discount.
  `ACC-U1` constructs that case directly (12,000 of principal against 9,000 of basis) rather
  than waiting for a scenario to produce it. **So the once-only re-baseline this design
  budgeted for was not needed** — which is worth stating plainly, because the budget was
  set by reasoning and the reasoning was wrong about the magnitude, not about the direction.
- **No TIPS golden yet.** The re-base is therefore asserted by unit tests (`ACC-U1`–`ACC-U4`)
  and by the two-way measurement above, not by a fixture. §7's "first follow-up to §5"
  stands, and it is now genuinely straightforward — a TIPS ladder runs end to end with the
  index ratio compounding cleanly (1.0609 after two 3% years) and the floor sitting at
  original par while the price carries the indexation. What still blocks it is §7's own
  reason, unchanged: every account that accretes is either laddered or rebalanced.
  **Also worth fixing while there:** `golden-specs.js`'s `mutateCfg` for this golden still
  carries a long comment describing a hand-authored TIPS rung that is not in the code —
  documentation for an attempt that was abandoned.

### 5.0 The two problems 5b has to answer first

> **REVISED 2026-08-24 after review.** Problem (1) below was framed wrongly and the
> framing has been withdrawn — see §5.0a. It asked how to PRICE a blended TIPS lot, having
> accepted the blend as a given. The blend is not a given: it is an artefact of paths that
> pre-date design 62 §9, and the right answer is to stop blending. Kept here only because
> the reasoning that produced it is instructive about how a bad question narrows the
> options — all three "solutions" were bad because the premise was.

**(1) ~~A blended TIPS lot cannot hold one `parPerUnit`~~ — WITHDRAWN, see §5.0a.**

**(2) TIPS accretion changes shape, and that moves tax.** Today accretion adds
`costBasis × cpiRate` to `marketValue` and `costBasis`. Under units it becomes
`cpiIndexRatio *= (1 + cpiRate)` with the price following the principal. The imputed
ordinary income for the year is then computed off the index ratio rather than off a basis
that has itself been moved by rate marks — which is *more* correct (the phantom income of a
TIPS is its principal indexation, not its price change), but it is a different number, so
**the golden moves and lifetime tax moves with it.** That is a deliberate, once-only
re-baseline under the design 66 §6 discipline, and it should be measured and read line by
line rather than regolded reflexively. **This one stands.**

### 5.0a The answer: a purchase is a new LOT, and this repo already decided that

The question "what `parPerUnit` does a blended lot carry?" has no good answer because a
lot should never be blended in the first place. A lot is the unit of tax accounting
precisely because each one has its own purchase date, price and basis — that is what FIFO,
HIFO, specific-ID, the AU Division 115 discount gate and the residency step-up clock all
key off.

**Design 62 §9 already established this rule in this codebase**, for a rebalance buy, and
for exactly the same reasons:

> A buy is now what it actually is: a purchase made TODAY, in its own lot, with its own
> `purchaseDate`, fresh basis and no per-country step-up history. It inherits the traits
> the existing lots UNANIMOUSLY agree on — you are buying more of the same thing … but
> never their dates or bases.
>
> CASH is the one exception: a currency unit realizes no capital gain (design 87 §11) and
> so has no holding period to preserve.

It was applied to the rebalancer's buy leg and **not** to the other money-in paths —
dividend and coupon reinvestment (`distributeHoldingsCredit`), ladder absorption
(`absorbIntoRungs`), and wrapper deposits (`scaleHoldings`, which inflates existing lots
rather than adding one). The blend survives only there. So §5b's rule is not new policy; it
is **finishing a migration design 62 started.**

Once a purchase is its own lot:

- `parPerUnit` is a constant of the lot and is never blended. The TIPS deflation floor is
  exact, per lot, with no re-pricing rule to invent.
- `cpiIndexRatio` is likewise per lot, anchored at that lot's own acquisition — which is
  what a TIPS bought seasoned actually carries.
- The design-25 §4.4 invariant holds *trivially*: a new lot contributes exactly the cash
  that bought it, so Σ marketValue moves by exactly the deposit. All three of the withdrawn
  options had to trade against this; none of them needed to.
- **The equity case is identical**, which is the point that surfaced this. A lot of shares
  bought at different prices is the same problem, `price` plays the role `par` plays here,
  and the answer is the same: do not blend, add a lot. Option C therefore needs no new
  mechanism for it — one more reason to settle it now rather than at C.

**Cost: lot proliferation**, which design 61 already bounds with `_compactSeasonedLots` —
lots this reducer created, otherwise identical, all past the 12-month mark, collapse into
one. Two TIPS lots with different `cpiIndexRatio` are *not* identical, so that compaction
can never wrongly merge them; the guard is already the right shape.

**Two questions this leaves, both smaller than the one it removes — both now DECIDED
(2026-08-24):**

1. **Granularity of a reinvested-income lot. DECIDED: one lot per (sleeve bucket × calendar
   year)** — the convention `mergeCouponReinvestLots` already used for coupons, so the two
   reinvestment paths stop disagreeing. The credit is split across buckets *by market
   value*, so **which allocation the money lands in does not change** — only which lot
   inside it. The two alternatives were worse for opposite reasons: one lot per account per
   payment has to pick a single sleeve for the whole credit and therefore moves allocation
   drift; one lot per sleeve per payment is exact but grows unbounded until
   `_compactSeasonedLots` seasons it. The vintage lot is always a SCALAR fund position — no
   maturity, no par, no units — so this path can never blend a par either.
   *Built in `distributeHoldingsCredit`; the callers pass the vintage clock. It moved no
   golden, because the goldens reach dividends through the earnings-handler path rather
   than `STOCK_DIVIDEND_APPLY` — worth knowing, since it means the new path's coverage is
   its unit tests, not a fixture.*
2. **`scaleHoldings`. DECIDED: leave it, named — then RE-OPENED and built at §5.4a**, once
   measuring it showed the credit branch was also under-adding cost basis by the value
   ratio, which is not latent. The reasoning below is what the deferral was based on and is
   still correct about the half it was about.
   ~~**DECIDED: leave it, named.**~~ Every caller is a tax-advantaged wrapper
   — `k401-classes` ×5, `ira-classes` ×3, `roth-classes` ×3, `roth-rollover-classes` ×3,
   `ira-rollover-classes` ×1, `roth-conversion-classes` ×1 — where holding period does not
   bite, so the defect is latent rather than live. Folding ~18 more call sites into 5b
   would have added a second independent reason for the golden to move and made the
   measurement in §5.0b unreadable. It is the same latent shape design 62 §9 fixed for
   rebalance buys and it should be closed on its own.

### 5.0c Where 5b diverged from §5.0a, stated plainly

Three places, because a reader comparing the rule to the code will find them anyway:

1. **The absorbed rung carries the absorbed lots' vintage, not today's.** §5.0a quotes
   design 62 §9 — *"a purchase made TODAY, in its own lot, with its own `purchaseDate`,
   fresh basis"* — but absorption is not a purchase. No cash moved and nothing was disposed
   of; a bond FUND sleeve became a dated rung. Re-dating it would restart the holding-period
   clock and re-base the lot on a transaction that never happened, which is the defect
   `ladderCarryover` was written to close (design 62 §9.5). So the new rung takes the
   carried basis, the carried per-country bases and the latest carried acquisition date.
   **The lot rule is about not BLENDING vintages; it is not about stamping today's date on
   money that is not new.** Those came bundled in §5.0a's framing because the case it
   generalised from — a rebalance buy — really was new money.
2. **Within a vintage, money still joins an existing lot.** All three reinvest paths merge
   into `<...>-<year>` when one already exists rather than emitting a lot per firing. Same
   instrument, same sleeve, same calendar year: no holding-period rule — Div 115's twelve
   months, §1222's one year, the post-2027 indexation clock — can distinguish the halves.
   It is the convention `mergeCouponReinvestLots` already used, and it is what keeps the lot
   count bounded. `addValue` on a unitised lot exists for exactly this and nothing else.
3. **`scaleHoldings` is untouched**, by the decision in §5.0a item 2.

### 5.4 Step 3c — closing §5 out — **BUILT** (2026-08-24)

> **Status: DONE, all six.** Suite 5,315 unit + 1,038 viz. What each one turned out to be:
>
> 1. **The vintage-lot path is tested.** Four tests on `distributeHoldingsCredit`: the
>    paying sleeves come back byte-identical, a second payment in the same year merges and a
>    new year does not, the split across buckets leaves allocation drift alone, and a
>    reinvested coupon buys BOND exposure rather than more of the rung that paid it.
> 2. **`tips-ladder-conservation` exists** — the inflation-linked twin of §7's golden,
>    differing in exactly two parameters so a diff between the pair isolates the instrument.
>    It holds the whole path: `cpiIndexRatio` compounding 1.03 → 1.0609 → 1.092727 →
>    1.12550881, the deflation floor sitting at original par while the price carries the
>    indexation, and redemption reading the ratio. **It closed a coverage gap**:
>    `BOND_ACCRETION_APPLY` moved from `KNOWN_GAPS` to `COVERED`, because this is the first
>    golden to hold an inflation-linked instrument at all. It does NOT reach the deflation
>    case — CPI is positive throughout — so the floor's downside is still unit-tested only.
>    A third invariant walk went in with it: **par may not rise on a step that acquired no
>    units**, which is defect #4 (the ratchet) stated as a prohibition rather than a repair.
>    Sabotage-verified, like the other two.
> 3. **`_compactLadderLots`, and it binds.** It merges the ladder's OWN seasoned lots when
>    they have become the same bond — which happens after a roll, not at creation, so the
>    ceiling is about N lots rather than one per year forever. Measured on the bond golden
>    extended to 2060: the IRA's live ladder lots go **22 → 12**, and k401 18 → 14. Growth
>    is slowed roughly 3.5x, **not stopped** — worth saying plainly, since §9 item 7 asked
>    for a ceiling and what this delivers is a much flatter slope.
> 4. **The stale `mutateCfg` comment is gone**, and the golden's description now points at
>    its TIPS twin instead of explaining why it has no TIPS.
> 5. **`scaleHoldings` landed after all** — see §5.4a, because the measurement changed what
>    the decision was about.
> 6. **`split()` is four lines, and the substrate passed its own test.** §4 recorded that a
>    split was unrepresentable in a dollar-denominated model and that the negative result was
>    an argument FOR units. Against the unitised representation it is `units × ratio`,
>    `pricePerUnit ÷ ratio`, `parPerUnit ÷ ratio` — every dollar total unchanged, basis
>    untouched (a split is not a disposal), acquisition dates untouched (§1223 and Div 115
>    both hold the period across one). On a SCALAR holding it is still a no-op, which is §4's
>    finding now confined to the mode that has no units rather than true of the whole model.

### 5.4a `scaleHoldings`: why the deferred decision was re-opened

§5.0a item 2 deferred this because the blend is latent — every caller is a tax-advantaged
wrapper where holding period does not bite. Building it showed the deferral was reasoning
about the wrong half of the defect.

`scaleHoldings` was **two operations sharing a signature**, the same shape as §2.1:

- a **DEBIT** (`newBalance < oldBalance`) is a proportional sell, and scaling is exactly
  right;
- a **CREDIT** is a purchase, and scaling was wrong twice over. It made the deposited
  dollars inherit the destination lots' acquisition dates — the latent half — and it scaled
  **`costBasis` by the value ratio**, which under-adds basis whenever the position carries
  an unrealized gain. That second half is not latent. It is wrong the moment it runs.

Measured on `us-single-homeowner` (40 years): stored **Σ costBasis 383,644 → 869,236**, a
2.3x correction, and the new figure is the one that matches what was actually paid in. Net
worth moves **−$0.31 on $7.1M** and lifetime tax **−$0.01**, because a wrapper withdrawal is
taxed off `contributionBasis` / `earningsBasis` — separate account-level ledgers, untouched
by this. So: a materially wrong stored number, with almost no consequence *today*, in the
fields a future feature would read first.

**Cost: 6 → 69 lots** in that run, roughly one per contribution year per wrapper. That is the
lot rule's price and it is not bounded by anything — `_compactSeasonedLots` reaches only the
rebalancer's own lots and `_compactLadderLots` only the ladder's. A third compaction, for
`reinvest-` vintage lots, is the obvious follow-up and is now the largest single source of
lot growth in the model.

A caller that supplies no `lotVintage` gets the pre-93 proportional scale in both
directions. That is deliberate — the UI and the unit tests have no clock — and it is the one
piece of this that could rot silently, so `lotVintage` is exported from `holding-utils` and
shared rather than copied. The brokerage's local copy was folded into it in the same change.

`debitIra` is the one call site that does NOT pass a vintage: it only ever debits, so there
is no new money to open a lot for.

### 5.5 Compaction as one policy — **BUILT** (2026-08-24)

**Compaction is the other half of the lot rule.** §5.0a says a purchase is a new lot;
followed honestly that grows the holdings array once per purchase forever, and the model
buys constantly. Without a policy that merges them back down, §5.0a is a memory leak with a
tax rationale. §5.4 built the ladder's; this closes the `reinvest-` gap and folds all three
into one function.

**One algorithm, three declared policies.** `compactLots(holdings, { asOfMs, policy })` with
`LOT_POLICIES.REBALANCE` / `.LADDER` / `.REINVEST`. `_compactSeasonedLots` and
`_compactLadderLots` survive as named exports that delegate — the reducer owning a name for
its own policy is the point of the prefix — and **both migrations were behaviour-neutral: no
golden moved.**

What is genuinely shared turned out to be everything that matters:

- **eligibility** — own family (id prefix), holds value, seasoned past twelve months;
- **the key, built by EXCLUSION** — a field is mergeable exactly when the merge has a rule
  for it, so a field added to `Holding` later automatically *prevents* a merge rather than
  being silently averaged away;
- **survivor = earliest lot**, keeping its id and date, so FIFO order across the boundary is
  unchanged and replay stays deterministic;
- **value** — a UNITISED lot sums `units` and re-derives, a SCALAR lot sums `marketValue`
  and `faceValue`. The dispatch is on the LOT, not on config (§6.2 item 2), which is why
  the ladder's unitised rungs and the rebalancer's scalar sleeves need no separate code;
- **`acquisitionPriceLevel`** as the basis-weighted harmonic mean, exact rather than
  approximate.

Only three things are per-family, and writing them side by side is what made them visible:
`prefix`, `blendByValue` (which fields are averaged by market value), and whether
per-country bases are summed or keyed. **The ladder is the only one that sums them**, and
for a specific reason — `ladderCarryover` legitimately produces rungs differing only in how
a step-up was apportioned, whereas a reinvest or rebalance vintage differing that way is a
residency step-up that must not be blended.

**The copies had already drifted, and unifying them found it.** One used 365 days as
"twelve months", the other 365.25 — which is the bond files' MATURITY constant and not a
holding period at all. `holding-period.js` owns that question for the whole codebase
(`isLongTerm`, the FIFO discount gate), so the policy defers to it and the ladder's outlier
is gone. That was a defect I introduced in §5.4 and would not have found by reading either
copy on its own.

**Measured.** `us-single-homeowner`, 40 years: **69 → 12 lots** (22 → 3 per wrapper), with
Σ `costBasis` conserved to **three cents** (869,235.87 → 869,235.84) and net worth moving
−$0.51 on $7.1M. Three per wrapper is the right answer rather than one: compaction merges
only SEASONED lots, so the current and previous year's vintages correctly stay separate.
The ladder's own count on a 2060 run is 17 (11 live), against 28 (22 live) before §5.4.
**Lot growth now has a ceiling in every family.** §9 item 7 is closed.

**It lives in `holding-utils.js`, not its own module, and that is a decision rather than
laziness.** Compaction re-derives value through `syncHolding` and the operations in that
file re-open the lots compaction merges, so splitting them put an import CYCLE through the
substrate's core. Both directions were function-body-only and would have worked; a cycle
here is the kind of thing that becomes a TDZ crash the first time someone adds a top-level
constant, and this is the code Option C builds on. One module owns lot operations.

### 5.4b The original list

5b left four things it should not have, plus two the design already owed. None of them is
Option C, and none needs a decision.

1. **The vintage-lot path has no test.** `distributeHoldingsCredit`'s two existing tests
   call it with no `year`, so they exercise the pre-93 blend fallback kept for callers with
   no clock. The path the §5.0a decision was actually about is asserted by nothing — and it
   moved no golden either, because the goldens reach dividends through the earnings-handler
   stream rather than `STOCK_DIVIDEND_APPLY`. A hole in shipped work; it goes first.
2. **A TIPS golden.** §7 named it the first follow-up to §5 and it is now genuinely
   reachable: a TIPS ladder runs end to end with the ratio compounding cleanly and the floor
   at original par. Until it exists, §5.3's redemption fix and the whole accretion path are
   held by unit tests only — which is precisely the shape §2.4 says lets a defect class live
   for months. Doing it BEFORE 3 and 4 puts a regression net under them, the same argument
   §7 made for doing the golden before §4.
3. **Ladder lot growth has no ceiling** (§9 item 7). ~1 rung per year per laddered account,
   ~40 over a long run. `_compactSeasonedLots` cannot reach them — it only merges the
   rebalancer's own `reb-` lots, and two absorption rungs of different vintages carry
   different locked coupons, so they are not fungible by its key anyway. What IS fungible is
   two rungs that agree on maturity, coupon and every tax attribute and are both seasoned;
   that is the compaction to write, and it belongs next to the ladder rather than inside the
   rebalancer.
4. **`golden-specs.js` documents an attempt that was abandoned.** The `bond-par-conservation`
   `mutateCfg` carries a long comment about a hand-authored TIPS rung promoted in place; the
   code sets an IRA balance and nothing else. Either item 2 makes it true or it goes.
5. **`scaleHoldings`** — §5.0a item 2, deferred out of 5b so the measurement in §5.0b stayed
   readable. With the golden in place it can be done and measured on its own.
6. **`split(holding, ratio)`** — §6.2 item 5. §4 found it unrepresentable in a
   dollar-denominated model and said it "lands with `units`". Units have landed. It is the
   cheapest possible proof that this substrate expresses what C exists for, and if it cannot
   be written cleanly, that is a finding about the substrate we want NOW rather than at C.

### 5.1 Original plan

With every site already declaring its intent, the mechanical conversion is small.

### 5.1 Fields

`units` and `parPerUnit` join `Holding`; `faceValue` becomes denormalized output rather
than hand-maintained input. Nullable throughout: a bond **fund** has no units and no par,
which is exactly why funds were immune to all eight defects and are the only arms of the
design-66 ladder study whose numbers survived it.

### 5.2 Migration

`fromJSON` back-fills `units = 1`, `parPerUnit = faceValue`, `pricePerUnit = marketValue`
for any existing dated bond, which reproduces today's behaviour exactly and lets saved
scenarios round-trip unchanged. The golden cannot move, because it contains no dated bonds
(§2.4) — which is precisely the problem §7 addresses.

### 5.3 The live bug this fixes for free — **BUILT**

A TIPS currently redeems at:

```js
const par = h.inflationLinked ? Math.max(h.marketValue, h.faceValue) : h.faceValue;
```

`marketValue` for a TIPS carries accumulated rate marks, and TIPS are deliberately excluded
from pull-to-par (design 66 §G5), so those marks **never wash out**. A TIPS therefore
redeems for its indexed principal *plus whatever rate noise happened to be sitting in its
price* — which is not what the instrument does.

Under §3 this stops being expressible. `parPerUnit` is the original issue par; the indexed
principal is `parPerUnit × cpiIndexRatio`, tracked explicitly; redemption reads the derived
principal and the deflation floor compares two quantities that are both par-like:

```
redemption = units × max(parPerUnit × cpiIndexRatio, parPerUnit)
```

Market price does not appear. This also retires the overload that caused defect #8, where
`faceValue` meant "redemption amount" for a nominal bond and "deflation floor" for a TIPS —
two different quantities behind one name.

## 6. Stage 3 — equity shares: the fork, left open

The substrate in §3 is the equity-shares substrate. For equity it is *simpler*: `units` are
shares, `pricePerUnit` is the share price, and there is no third quantity because equity has
no par. Bonds are the harder case, so a substrate that carries bonds carries equity.

It is also already latent. `stock-harvest-apply-reducer` and
`behavioral-panic-sell-apply-reducer` each write `marketValue` three times with no par
awareness; they are correct today only because nothing authoritative derives from an equity
unit count. Add stock splits, DRIP share counts, per-share basis or wash-sale share
matching, and §2's pattern reappears on the equity side with no new mistake required.

**But there is a modelling fork underneath, and it is the decision this document wants a
ruling on rather than a default.**

Today a holding is a **dollar-denominated allocation bucket**, not a security position.
Design 25 chose that, and it is why there are no units. Bonds strained it because an
individual bond genuinely *is* N instruments with a conserved par — units are physically
real there. Equity shares strain it much harder, because a share count only means something
against a **named security** with its own price series:

| | allocation bucket (today) | security position |
|---|---|---|
| what a holding is | dollars of an asset class | N shares of a named instrument |
| price | an asset-class return rate | a per-security price path |
| new entities | none | `Security`, tickers, price series, corporate actions |
| what it buys | nothing new | splits, DRIP in shares, per-share basis, wash sales, options/RSUs |
| what it costs | — | a price path per security in every MC path; a much larger state |

**Option A — units for bonds only.** Equity keeps dollar buckets. Smallest change, fixes
everything in §2 that can currently bite, leaves the equity latency armed.

**Option B — units for both, buckets retained.** Equity gets a unit count whose "unit" is a
synthetic bucket unit (an arbitrary opening normalisation, e.g. 1 unit = 1 opening dollar).
Splits and per-share basis become expressible without a `Security` entity. Cheap, and it
disarms §6's latency — but a synthetic unit is a fiction, and fictions in a substrate have a
way of being taken literally later.

**Option C — security positions.** The real thing. Large, and it changes what the simulation
*is* — from an asset-allocation model to a portfolio model. Almost certainly its own design.

### 6.1 DECISION (2026-08-24): **Option A now; Option C is the destination. B is rejected.**

Units for bonds only, and equity keeps dollar buckets for the present — but the intended
end state is **full security support for share modelling**, not a permanent bucket model.
B is rejected precisely because a synthetic unit is a fiction, and a fiction in a substrate
gets taken literally by the next author.

That makes C's cost the thing to manage, so A is constrained: everything below exists so
that C is a **data migration plus new entities**, never a rewrite of the substrate.

### 6.2 What A must do so C is additive

1. **`units` is generic and never bond-gated.** One nullable `units` on every `Holding`;
   bonds are simply the first allocation that populates it. An
   `if (allocation === BOND)` anywhere in the substrate is the single change that would
   turn C into a rewrite, so the substrate must not contain one. Bond-specific behaviour
   belongs in the bond reducers, not in the representation.

2. **Two modes, both first-class from day one.** A holding is either
   **unitised** (`units != null`; value flows from `units × pricePerUnit`) or **scalar**
   (`units == null`; `marketValue` is the stored primary — today's behaviour, and what
   every equity holding and bond *fund* will be under A). `resize`, `reprice` and
   `_syncHolding` must handle both modes as supported paths, not as a legacy branch.
   **C is exactly "flip equity from scalar to unitised"** — so if scalar is a grudging
   special case, C is a rewrite; if it is a supported mode, C is a migration.

3. **The instrument / position partition, behind an accessor.** Many fields on a bond
   holding describe the **instrument**, not the position held in it:

   | position-level (stays on `Holding`) | instrument-level (moves to `Security` in C) |
   |---|---|
   | `units`, `marketValue`, `costBasis`, `costBaseByCountry` | `parPerUnit`, `couponRate`, `maturityDate`, `duration` |
   | `purchaseDate`, `acquisitionDateByCountry`, `acquisitionPriceLevel` | `taxExemption`, `issuingState`, `zeroCoupon`, `inflationLinked` |
   | `rollAtMaturity`, `rollTermYears` *(arguably policy, not instrument — see §9.5)* | `rateKey` |

   Moving them now is a large serialization change for no present benefit. Instead
   introduce **`instrumentOf(holding)`** as the single read path for that column. Under A
   it returns the inline fields; under C it returns `securities[holding.securityId]`.
   Consumers written against the accessor do not change at all. **This accessor is the
   seam that makes C additive** — the same device as design 87's phase-3 observer seam:
   the mechanics are read through one function so the source behind it can be replaced.

4. **`securityId` reserved now, always null.** A nullable field, serialized and
   round-tripped from day one. It costs nothing under A and means C never has to touch
   the schema registry, the serializer, or the round-trip tests.

5. **`split(holding, ratio)` defined alongside `resize` and `reprice`. — BUILT (§5.4
   item 6), and it came back CLEAN.** A corporate action moves `units` and `pricePerUnit`
   inversely and leaves value unchanged. Bonds do not need it. It was defined anyway,
   because it is the cheapest possible proof that the model expresses the thing C exists for
   — and if a split could not be written cleanly against this substrate, the substrate was
   wrong and we wanted to find that out in A. It is four lines, it leaves basis and every
   acquisition date alone, and `parPerUnit` divides with the price because par is per unit.
   **The substrate passed its own test**, which is the strongest evidence in this document
   that C is a migration rather than a rewrite.

### 6.3 What C still has to build (not bought by A)

So the estimate is honest, A buys the *representation* and none of the machinery:

- a `Security` entity and registry, with round-trip and schema-registry entries;
- a **per-security price path** in every Monte Carlo path — the real cost, since state
  size and RNG draws scale with the number of distinct securities rather than with the
  four allocation classes;
- corporate-action events (splits, spin-offs, symbol changes) as first-class dated events;
- migration of existing equity buckets to positions, including what a saved scenario's
  "EQUITY sleeve" becomes when it has no ticker.

## 7. The golden gap — **BUILT** (2026-08-24)

> **Status: DONE.** Golden `bond-par-conservation` + `tests/unit/bond-par-conservation.test.mjs`.
> Verified by reintroducing defect #5 (the rebalancer sell) and confirming both fire:
> the fixture moved **51 fields and $20,480 of net worth**, and the invariant test named
> the mechanism — `RebalanceToTargetApplyReducer: 2 steps, net -14,688.69 with par frozen`
> alongside `BondPriceAdjustReducer: 10 steps, net +16,599.74 with par frozen`, i.e. the
> leak and the pull-to-par pump regenerating it. That pair is the diagnosis the eight
> original defects each cost a session to reach.
>
> **What it holds:** a rolling 4-rung ladder across TWO accounts (k401 + IRA, so the
> single-account resolution bug cannot hide), a Roth conversion depositing into an account
> holding rungs (the unit-change path, defect 1), TARGET_ALLOCATION rebalancing across them
> (defects 5–7), and coupon/dividend reinvestment (defect 8). Eight years — two full rolls.
> It also cleared three action types out of `KNOWN_GAPS`: `ROTH_CONVERSION_APPLY`,
> `ROTH_CONVERSION_TAX` and `REBALANCE_TO_TARGET_APPLY`.
>
> **What it does NOT hold, and why:** an inflation-linked rung. Every account that accretes
> is either laddered (a materialisation replaces its holdings) or rebalanced (the lot is
> sold out from under the golden), and the one role that is neither — `fixed-income` —
> gets no `BondAccretionHandler` and normalises authored lots away by the year after a
> sibling lot matures. Three attempts, all defeated by a different mechanism. TIPS
> mechanics are held by nine unit tests instead (`bond-maturity`, `bond-ladder-reducer`),
> and a TIPS golden becomes straightforward after §5 gives accretion an explicit
> `cpiIndexRatio` rather than hiding it inside `marketValue`. **Tracked as the first
> follow-up to §5.**
>
> A second test asserts the golden still holds >$100k of par, so the conservation test
> cannot quietly become vacuous the way the pre-existing goldens were (§2.4).

### 7.1 Original rationale

Every defect in §2 was invisible to a green full suite, because the default scenario holds
no instrument with a par. Whatever is decided about §4–§6, the substrate needs a golden
scenario that exercises it:

- a short bond ladder (dated rungs, rolling);
- one TIPS rung (accretion + the deflation floor);
- one rollover or conversion into the account holding them (the §2.1 unit-change path);
- one rebalance across it (the sell path that produced the 92% regeneration).

This is a one-time golden re-baseline under the design-66 §6 discipline, and it converts
this entire defect class from "found by squinting at an implausible median in a finished
study" into "found by CI". It is worth doing **before** §4, so that the conversion in §4 has
a regression net under it.

`scenarios/account-asset-classes/ladder-par-check.mjs` is the interim guard: it walks a full
horizon with every reducer wrapped and reports any step that moves bond market value while
par stands still, excluding the one legitimate case (TIPS CPI accretion). It is currently
clean across every structure × equity-weight combination tested. It is a study tool, not
CI — §7 is what makes it unnecessary.

## 8. Sequencing — **§4, §5 and §7 all COMPLETE; only Option C remains**

| step | what | size | blocks |
|---|---|---|---|
| 1 | ~~§7 golden scenario with dated bonds~~ **DONE 2026-08-24** | small | — |
| 2 | ~~§4 `resize`/`reprice` + AST test~~ **DONE 2026-08-24** | small | — |
| 3a | ~~§5a schema, migration, `instrumentOf` seam~~ **DONE 2026-08-24** | small | — |
| 3b | ~~§5b flip the bond paths + finish design 62 §9's lot rule (§5.0a)~~ **DONE 2026-08-24** | medium | — |
| 3c | ~~§5.4 close-out: vintage-lot test, TIPS golden, ladder compaction, `scaleHoldings`, `split()`~~ **DONE 2026-08-24** | medium | — |
| 3d | ~~§5.5 compaction as one policy (`reinvest-` + unify all three)~~ **DONE 2026-08-24** | small | — |
| 4 | ~~§6.2 C-compatibility constraints (seam, modes, reserved field)~~ **DONE** — folded into 2–3b, and item 5 (`split()`) into 3c | small | — |
| 5 | §6 equity as security positions (Option C) | large | **design 94** |

### 8.1 What this document actually delivered, against what it set out to do

Worth recording, because the plan and the outcome differ in ways that are informative:

- **The eight defects are closed by the substrate rather than one at a time**, which was the
  whole argument for writing this. The five armed-and-unfired sites §2.3 counted are
  converted, and the gate refuses new ones.
- **Three invariant walks exist where there were none**: par-conservation (§7),
  unit-derivation (§5b) and the deflation-floor prohibition (§5.4). All three are
  sabotage-verified, and each names a reducer and a lot rather than reporting "N fields
  differ".
- **Two goldens now hold instruments with par** — `bond-par-conservation` and
  `tips-ladder-conservation` — where §2.4 found the default scenario could not reach a single
  par-handling path. `BOND_ACCRETION_APPLY` moved from `KNOWN_GAPS` to `COVERED` as a result.
- **The lot rule was finished, not started**: design 62 §9 had established it for one path in
  2026 and it had never reached the other four. §5.0a, §5.4a and §5.5 close that, and §5.5
  gives all three lot families one compaction policy.
- **Three predictions in this document were wrong, and each is recorded where it was made.**
  §5.0's blended-TIPS pricing question was withdrawn as a bad question (§5.0a). §5.0's
  problem (2) budgeted a once-only tax re-baseline that measurement showed was not needed
  (§5.0b). §5.0a item 2's "latent, defer it" turned out to be hiding a live basis error
  (§5.4a). Two of the three were caught only by building the thing and measuring it.
- **`split()` — §4 predicted it would be unrepresentable and §6.2 item 5 asked for it as
  proof.** Against the finished substrate it is four lines. That is the strongest evidence
  this document produced that Option C is a migration rather than a rewrite, and design 94
  §1 leans on it.

### 8.2 Handover to design 94

Everything Option C was promised is in place and is *tested*, not merely present:
`units` ungated, both modes first-class, `instrumentOf` as the instrument seam, `securityId`
reserved and round-tripping, `split()` built, the lot rule and its compaction, and a
`compactLots` exclusion key that will refuse to merge lots of different securities without
being told about securities at all.

Two caveats design 94 has to carry rather than inherit quietly:

1. **`instrumentOf` has no callers.** It was shipped dark so C would change one function
   instead of every consumer, but the consumers were never converted — so the audit it was
   meant to avoid is still owed. Design 94 §5.2 makes that its first phase.
2. **`cpiIndexRatio` sits on the position**, and under C it is arguably an instrument fact
   with a position-level acquisition level. §9 item 2 settled the `costBasis` version of this
   question; the CPI version is design 94 §12.7 and is unresolved.

## 9. Open questions

1. ~~**§6's fork.**~~ **ANSWERED 2026-08-24: A now, C as the destination, B rejected.**
   See §6.1. The remaining question is scheduling C, not choosing it.
2. ~~**Does `costBasis` belong to units too?**~~ **ANSWERED 2026-08-24 by building it:**
   it stays a plain scalar that `resize` scales. §5b confirms the reason the question
   guessed at — accretion steps basis while the unit count stands still, and a lot's basis
   also carries things that are not principal at all (a rebuild's carryover, an absorbed
   lot's basis). A `basisPerUnit` would have had to be re-blended on every one of those,
   which is the same bad shape §5.0a removed from par.
3. ~~**Fractional units.**~~ **ANSWERED: float, and nothing downstream cares.** `units` is
   rounded to 8dp and per-unit prices likewise; a $100 par needs 4dp to land on cents, so
   8dp is sub-cent on any realistic position. Every consumer reads the derived
   `marketValue` / `faceValue`, which are rounded to cents at the derivation — so the
   fractional count never reaches a money path.
4. **Where do `rollAtMaturity` / `rollTermYears` belong?** They are ladder *policy*
   attached to a position, not properties of the instrument — two holders of the same bond
   can disagree about whether they roll it. Listed as position-level in §6.2 on that
   reasoning, but it is the one row of that table I am least sure of, and C is where it
   would bite.
5. **Rounding: cents-at-every-write, or unrounded with an exact-sum remainder?** The
   primitives do the former, `AccountService.transaction` the latter, and the gap is 21
   cents on a whole-portfolio total over one run (§4). **§5b settled the UNITISED half and
   left the rest open**, which is the honest state: a unitised holding rounds to cents at
   the DERIVATION, once, and never carries a rounded value through a second multiply — so
   it is strictly more stable than the old `mv × f` chain. `AccountService.transaction`
   stays unrounded, and routing its "the credit becomes the position" branch through
   `establish()` (which rounds) moved every golden's cash sleeve by a few thousandths of a
   cent — so it was spelled out inline instead, with the reason. The two conventions still
   coexist; what changed is that the boundary between them is now stated at both ends.
7. ~~**Lot growth has no global ceiling.**~~ **CLOSED 2026-08-24 by §5.5.** All three
   families now compact, through one algorithm with three declared policies: 69 → 12 lots
   on a 40-year run, basis conserved to three cents. The unification also found a real
   defect — the two hand-written copies disagreed about what "twelve months" means.
6. **Does `reprice` need a reason code?** Rate mark, pull-to-par, shock and accretion all
   reprice, but accretion also steps basis. Tagging the reason would let postconditions
   assert per-reason invariants; it also adds ceremony. Not obviously worth it.

## 10. References

- design 25 — holding-level state; the source-of-truth and plain-data rules this restores.
- design 66 §G4/§G5/§G8 — individual bonds, TIPS, ladders; §10.6b lists the eight defects.
- design 87 §11 / G9 — the sell side already conserved principal
  (`partial.faceValue = h.faceValue * (remainingMv / mv)`); the deposit side never got the
  same rule, which is defect #1.
- design 61 — the rebalancer whose buy and sell paths are §2.3's largest cluster; also the
  source of `_compactSeasonedLots`, which §5.5 generalised into the shared policy.
- design 62 §9 / §9.5 — the lot rule this document finished (§5.0a), and `ladderCarryover`.
- design 57 §6.3 — the AU CPI indexation level every compaction blends harmonically.
- **design 94 — equity as security positions**, the Option C this document chose (§6.1) and
  deliberately stopped short of. It revises §6.3's cost estimate downward on two grounds:
  a security that tracks a market key consumes no extra RNG draw, and the migration can
  therefore be numerically byte-identical.
