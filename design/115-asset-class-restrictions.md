# 115 — Asset-class restrictions: keeping gold out of a US citizen's super

**Status:** IN PROGRESS — phase 1 BUILT 27 Sep 2026 (§11). Research done (§3, every citation
on disk); decisions D1–D4 (§4) taken with the author. Phases 2–4 open. Picks up design 61 §4-D / §12 (Lever D,
LOCATED placement) and design 77 §4.1 (super's US character).

---

## 1. The ask

The `allocationLocation` description says LOCATED puts "gold in a shelter (AU super; …)". For
a **US citizen** that is a placement they may not be able to make: holding bullion needs a
self-managed fund, and a self-managed fund is where super's US tax treatment is at its worst.
The author asked for the decision to be backed by research and, if action is warranted, for a
way to **optionally restrict where an asset class may go**, starting with GOLD.

## 2. What the code does today (audited 27 Sep 2026)

The text the ask quotes is **stale in two different ways**:

- `behavioral-strategy-registry.js` (`allocationLocation` description) still says "never a US
  IRA/401k/Roth". That guard was **reversed** on 29 Jul 2026 (design 61 §12 OQ4a) and
  `roleCanHoldGold()` (`rebalance-to-target-reducer.js`) now returns `true` for every role.
- `allocation-location.js`'s header says "gold → a shelter". Gold's home is now set per
  residency by `GOLD_PREFERENCE_BY_RESIDENCY`, chosen by measurement (design 61 §12.2 Q4):
  - **US resident:** IRA → 401k → US brokerage → AU brokerage → **super** → Roth.
  - **AU resident:** **super first**, then IRA, 401k, AU brokerage, US brokerage, Roth.

So the ask's concern is live, and in more places than the comment suggests. Gold can reach
super by:

| path | when |
|---|---|
| LOCATED preference | primary residency AU — super is gold's first choice |
| LOCATED spillover | any residency, once the preferred accounts are full |
| `PER_ACCOUNT` | always — every account, super included, is driven to the uniform mix |
| STRATEGIC_ASSET_LOCATION swap | the swap's counter-leg falls back to `target.holdings[0]`, whatever class it is (`strategic-asset-location-reducer.js` `_computeMoves`) |

The pools (design 97) and drawdown paths do not place gold; every rebalance buy runs through
`rebalance-to-target-reducer.js`.

There is also an **unwired per-account eligibility seam** (design 97 §23, `_canHold` in
`allocation-location.js`). It is keyed by account, and its rule 3 deliberately *relaxes* the
constraint when honouring it would strand value. That is right for a measurement probe and
wrong for a legal restriction, so this design does not reuse its semantics (§5.2).

## 3. Research

Primary sources, all on disk (provenance in `docs/au-tax/SOURCES.md` and
`docs/us-tax/SOURCES.md`).

### 3.1 Australian law does not stop a US citizen, or bullion

- **SIS Act s17A(1)** (`docs/au-tax/SISA-1993/C2026C00361VOL01.txt`): an SMSF has at most 6
  members and "each member of the fund … is a trustee of the fund" (or a director of its
  corporate trustee). **Nothing in s17A turns on citizenship.** A US citizen can be an SMSF
  member-trustee under Australian law.
- **SIS Act s62A** and **SIS Regs reg 13.18AA(1)** (`docs/au-tax/SISR-1994/…VOL01.txt`): the
  collectables rules for SMSFs cover artwork, jewellery, antiques, artefacts, "coins,
  medallions or bank notes", stamps, books, memorabilia, wine, vehicles, boats and club
  memberships. **Bullion is not on the list.** Gold *coins* are, and bring the storage,
  insurance and related-party rules of 13.18AA(2)–(5).
- **ITAA 1997 s295-95(2)(b), (4)**: an "Australian superannuation fund" needs its central
  management and control "ordinarily in Australia", tolerating absence "for a period of not
  more than 2 years". For an SMSF the member-trustees *are* the management, so **an SMSF
  whose trustees live in the US for more than two years fails the test**. That matters for
  any plan with US-resident years.

**So the ask's premise needs one correction.** A US citizen is not *barred* from an SMSF;
Australian law allows it, and allows the SMSF to hold bullion. What stops them is US tax
treatment (§3.2) and, while living in the US, the residency test above.

Whether an **APRA-regulated** (non-SMSF) fund offers gold exposure is a product fact, not a
legal one. Some member-direct options list ETFs; we have not verified that any given fund
lists a gold ETF. The model's `GOLD` sleeve is an *exposure*, not a custody claim (design 61
§12 OQ4a), so for an APRA fund the real question is "does my fund offer gold?", which only
the author can answer for their plan.

### 3.2 US law makes a self-managed super fund expensive

- **§679(a)(1)** (`docs/us-tax/…sec679.txt`): a US person who "transfers property to a foreign
  trust (other than a trust described in section 6048(a)(3)(B)(ii))" is treated as owner of
  that portion if the trust has a US beneficiary. A US-citizen member contributing to their own
  SMSF is both transferor and beneficiary.
- **§6048(a)(3)(B)(ii)**: the carve-out covers trusts "described in section 402(b), 404(a)(4),
  or 404A". Whether super is a §402(b) employees' trust is the unresolved question design 77
  §4.1 and design 83 §7a.5 already record. Design 77 §4.1 notes the grantor view "is strongest"
  for a single-member SMSF. **A member-contributed, member-controlled SMSF is the weakest case
  for the §402(b) carve-out.**
- **§671**: where subpart E makes someone the owner, the trust's income is theirs.
  Grantor-trust status means **current US tax on the fund's earnings**, destroying the deferral
  the model assumes for super.
- **Rev. Proc. 2020-17 §5.03** (already on disk) only **waives Form 3520/3520-A reporting**.
  It does not decide ownership. Its conditions include "(3) Only contributions with respect to
  income earned from the performance of personal services are permitted", which a fund taking
  non-concessional contributions may not meet.
- **PFIC (§1297, §1298(a)(3), §1291):** stock a trust owns is attributed proportionately to its
  beneficiaries, and a foreign pooled fund meeting §1297(a)'s income or asset test is a PFIC
  taxed under §1291 unless a §1296 election applies. **Not concluded here:** whether an
  AU-domiciled gold ETF is a PFIC turns on §954(c) (commodity gains as FPHC income) and the
  entity-classification regs, neither of which is on disk (§9 Q2).

### 3.3 Aside: the US side of design 61's reversal is stronger than it said

**§408(m)(3)(B)** (`docs/us-tax/…sec408.txt`) excludes from "collectible" any gold bullion of
futures-contract fineness "in the physical possession of a trustee". So an IRA can hold
qualifying bullion itself, not only a gold ETF. OQ4a's reversal stands on the statute as well
as the ETF argument.

### 3.4 Conclusion

Whether gold may sit in super **depends on the person and the fund**, not on a rule that holds
for everyone. For a US citizen it is usually a bad idea (SMSF: grantor trust, 3520/3520-A,
possible PFIC, and the residency test while in the US). For an AU citizen, or a US citizen
whose APRA fund offers a gold ETF, it can be fine. **A hard-coded ban would repeat the mistake
OQ4a undid.** The right tool is an **opt-in restriction** the author sets for their own plan,
plus a nudge when the plan looks like the risky case.

## 4. Decisions (taken with the author, 27 Sep 2026)

- **D1 — Opt-in.** Default `null`; every existing run is byte-identical.
- **D2 — Keyed by account type (role), not by account.** This matches `allocationLocationPolicy`,
  so the preference ("prefer these roles") and the restriction ("never these roles") read as a
  pair. It also covers a super account added later without a new row. Per-account was
  considered and set aside: it would add a second way of naming accounts inside Target
  Allocation. The shape leaves room to accept account keys later if two funds of the same role
  ever need different answers.
- **D3 — Hard.** A restriction is a statement about what an account *may* hold, so it is never
  relaxed to conserve value. Unplaceable class weight is redistributed across the permitted
  classes instead (§5.2).
- **D4 — Loader warning** when a US citizen owns a super account and GOLD is not restricted
  there (§6).

## 5. Design

### 5.1 The param

```
allocationClassRestrictions: { "GOLD": ["super"] }     // class → roles it may NEVER occupy
```

- Type `ClassRestrictions`, group Allocation, `mc: false`, `opt: false`, default `null`.
- Read by **both** placement strategies (TARGET_ALLOCATION and STRATEGIC_ASSET_LOCATION), so it
  is visible when either is enabled.
- **An explicit empty list is meaningful:** `{ "GOLD": [] }` means "I have considered gold's
  placement and allow it everywhere". It changes nothing in the run and silences §6's warning
  (for example, when the author's APRA fund offers a gold ETF).
- Validation at load: unknown class or unknown role ⇒ warning naming it (a typo must not become
  a silently inert restriction). Restricting a class from **every** role present in the plan ⇒
  warning, because the class can then never be held (§5.2 handles it, but the author should know).

### 5.2 Enforcement — `allocation-location.js` (LOCATED)

`roleCanHoldGold(role)` becomes `roleCanHold(cls, role, restrictions)`. It returns `true` when
`restrictions` is null, preserving today's behaviour. The existing gold machinery is generalised
from GOLD to any restricted class:

1. **Cap.** Each class's dollar target is capped at the capacity of the accounts that may hold it.
   The excess is spread across the other classes pro rata (today's gold redistribution, with
   `NON_GOLD_CLASSES` becoming "the classes not capped").
2. **Preference, reconcile and §23 relaxation passes** all skip a forbidden `(class, role)`. The
   §23 relaxation pass already never overrides the gold guard; it now never overrides
   `roleCanHold` either.

The cap has to be computed **jointly** when several classes are restricted: redistributed weight
must not flow into a class that is itself capped. With only GOLD restricted this reduces to
today's single-class code.

### 5.3 Enforcement — `PER_ACCOUNT`

`PER_ACCOUNT` gives every account the portfolio mix. For an account whose role forbids a class,
drop that class and rescale the rest to sum to 1. This brings back a per-role target step: the
same seam `targetForRole` occupied before OQ4a removed it, now data-driven. Gold already held
in a restricted account shows up as a held-but-not-targeted class and is sold by the existing
negative leg. The aggregate book then under-hits the gold target by the restricted accounts'
share; that is the honest consequence of the restriction, and it goes into the placement stats
(§5.5).

### 5.4 Enforcement — STRATEGIC_ASSET_LOCATION

In `_computeMoves`, skip a swap that would move a forbidden class into the receiving account's
role. That covers both legs, including the `target.holdings[0]` fallback.

### 5.5 Visibility

Stamp the dollars of class target that could not be placed because of a restriction per period.
Surface them the same way `_eligibilityRelaxed` is surfaced, so a run can say "your gold target
was X% but restrictions let you hold Y%".

## 6. The loader warning

At load, for each person whose `citizen` includes `US` and who owns a `super` account, with
TARGET_ALLOCATION or STRATEGIC_ASSET_LOCATION enabled: warn unless
`allocationClassRestrictions.GOLD` is **present** (restricted or explicitly empty, §5.1). The
message names the account, points to this design, and says how to silence it.

CLI tools swallow loader warnings (known issue), so the warning must also reach the scenario's
validation/warnings surface in the app, and the test must assert the warning, not just the console.

## 7. Authoring surface

A typed row-list editor (no JSON textarea): one row per class, with a class select and a checkset
of roles. It sits next to the Location Policy editor in the Allocation group. Empty ⇒ "No
restrictions — any account may hold any class."

Fix the stale text in the same change:

- `allocationLocation` description: drop "never a US IRA/401k/Roth"; describe gold's residency-aware
  home and point to the new param.
- `allocation-location.js` header and `roleCanHoldGold` JSDoc: describe the data-driven restriction.
- `help/REFERENCE.md` regenerated; `help/concepts/allocation-and-rebalancing.md` gains the
  restriction and is restamped; the node topic for the editor if the form changes.

## 8. Test plan

- **Planner:** with `{GOLD:["super"]}`, under AU residency, gold never lands in super (preference,
  spillover and a book too small to place all the gold); `null` ⇒ output identical to today.
- **Infeasible:** gold restricted from every present role ⇒ gold target 0, redistributed, and each
  account still sums to its own total.
- **Multiple classes restricted:** the joint cap never pushes weight into a capped class.
- **PER_ACCOUNT:** super's target has no GOLD; held gold in super is sold; other accounts unchanged.
- **STRATEGIC_ASSET_LOCATION:** no swap moves GOLD into super.
- **Effect, not presence:** a scenario run with the param set has zero GOLD in super at every
  period, while the same run without it does not (the loaded-config lesson).
- **Loader:** warning fires for a US citizen with super; silent with a restriction or an explicit
  empty list; silent for an AU-only citizen.
- **Goldens:** unchanged (param defaults to null).

## 9. Open questions

- **Q1** — Should an explicit empty list be the only way to silence the warning, or should an
  account-level flag ("this fund offers gold") exist? This depends on whether per-account
  restrictions are ever built (D2).
- **Q2** — PFIC exposure of **AU-domiciled gold ETFs held in AU brokerage** by a US citizen. This
  is outside super, and possibly a bigger modelling gap than this one. It needs §954(c) and
  Reg. §301.7701-3 on disk before anything is claimed.
- **Q3** — The model treats super as tax-deferred for US purposes (design 83 §7a.5). §3.2 is more
  evidence that this is wrong for an SMSF. We do not model SMSFs, so nothing changes here, but an
  SMSF account type would need the grantor treatment, not a restriction.

## 10. Phasing

1. `roleCanHold` + joint cap in the LOCATED planner, with planner tests.
2. PER_ACCOUNT and STRATEGIC_ASSET_LOCATION enforcement; placement stats.
3. Param schema, validation and loader warning.
4. Editor, stale-text fixes, help regeneration and restamp.

## 11. As built — phase 1 (27 Sep 2026)

**`allocation-location.js`**

- `roleCanHold(allocation, role, restrictions)` is exported. Null, an unnamed class, or `[]` ⇒
  permitted. The planner no longer imports from the reducer, which removes the circular import.
- `planLocatedTargets` takes `restrictions`. Every pass (preference, reconcile, §23 relaxation)
  skips a barred `(class, role)`.
- **Cap loop:** each class is capped at the capacity of the roles allowed to hold it; the excess
  spreads pro rata over the classes still under their caps, repeated until none is over. This
  generalises the old gold-only cap. Unrestricted, every cap is the whole book, so nothing moves.
- **`_repairRestrictedGaps`**, a finding while testing. With several classes restricted, per-class
  caps do not guarantee a joint placement, and the greedy passes boxed themselves in: in a 400-case
  random sweep, 87 over-placements had a valid placement available. The repair is a BFS
  augmenting-path search (move X from B into the gap, place the stranded Y into B), and it takes
  that count to **0**. What remains (41/399) fails Hall's condition, i.e. it is genuinely
  infeasible. **With a single restricted class, the GOLD case this design exists for, neither the
  repair nor the fallback ever fires** (0 of 2,000 random cases).
- **Over-place fallback:** a genuinely infeasible gap is filled with a class the account *may*
  hold, beyond that class's target. It never touches a restriction.
- **An account whose role is barred from every class** is planned unrestricted (the loader will
  refuse that shape in phase 3).
- **New stats:** `stats.restricted` (class dollars redistributed by a cap) and `stats.overPlaced`.
  The reducer does not read them yet (phase 2).

**`rebalance-to-target-reducer.js`:** `roleCanHoldGold(role, restrictions = null)` delegates to
`roleCanHold`. Its JSDoc cites §408(m)(3)(B) and this design.

**Tests:** `tests/unit/evt-allocation-class-restrictions.test.mjs` has R-1–R-9:
- the helper;
- byte-identity for `null` / `{}` / `{GOLD:[]}`;
- AU first-choice and US spillover kept out of super;
- a class barred everywhere;
- §23 relaxation never overriding a restriction;
- jointly infeasible over-placement;
- a fully barred role;
- a seeded 400-case property test asserting no violation, conservation, and **over-placement
  only when Hall's condition fails**.

The existing LOC tests' stale "never a US IRA" comments are fixed. Full unit suite: 7,282 pass,
goldens unchanged. The reducer does not pass `restrictions` yet, so no run can reach the new code.
