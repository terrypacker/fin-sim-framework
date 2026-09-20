---
id: security
kind: node
title: Security
node: security
panels: [config-list, securities, holdings]
design: [94-equity-as-security-positions.md, 66-bond-fidelity.md, 93-holding-units-substrate.md]
sources: [src/visualization/assets/security-editor.js]
stamps:
  panel:config-list: 786f94
  panel:securities: 80facb
  panel:holdings: 359688
  node:security: 644d74
  src/visualization/assets/security-editor.js: e79b48
---

An instrument definition: what a position is a position *in*. A lot in an account
names a security by id, and the security says what that lot tracks, how it pays, and
how it is taxed. Without one, a lot carries its own inline fields and is an island —
two lots of "the same" ETF in two accounts are unrelated, which is wrong wherever the
answer depends on their being the same thing: wash sales, a market's return path, one
dividend yield.

Three rules run through the whole form.

**Only fields the engine reads are offered.** An editable box nothing consumes is a
lie that stays plausible, so the form shows a strict subset of the record. Fields
carried for later are round-tripped untouched and simply not rendered.

**Declared and silent are different.** Each field has a `declares` toggle. Off, the
security says nothing and the position's own value stands. On with an empty box is an
explicit null, which *overrides* the position. The booleans are the exception — a
reader tests them for truthiness, so "declared false" and silent are the same
statement and they carry no toggle.

**The id is the identity.** Every lot names it; a symbol change is a corporate action
rather than an edit here.

## Fields

- `id` — The stable identity every position names. Settable once, at creation, and read-only afterwards: renaming it in place would orphan every lot holding it, silently, because a lot whose id resolves to nothing falls back to its own inline fields with no error anywhere. Pick something durable rather than a ticker.
- `symbol` — Ticker, and decoration only. A symbol change is a corporate action, not an edit — nothing in the engine keys on it.
- `name` — Display name, shown wherever a symbol is absent.
- `rateKey` — The market-return series this instrument tracks. It must lie inside the allocation class of any lot that names it — a bond lot may not name an equity market — and that is checked rather than assumed.
- `beta` — Loading on the sleeve's own deviation, not on the market. 1.0 is the identity: the instrument does exactly what its sleeve does.
- `idioVol` — Idiosyncratic volatility. A security declaring more than zero takes a random draw every tick whether or not any position holds it, because the draw set is the registry rather than the portfolio — so declaring one perturbs the whole run. Zero, or silent, draws nothing.
- `dividendYield` — Overrides the lot's own yield; the account rate remains the floor beneath both.
- `identityGroup` — Marks two different securities as substantially identical for the wash-sale rule, which only relates them when an author says so. Give both the same group. Silent means identical to itself and nothing else.
- `taxExemption` — How this instrument's bond coupons are taxed: fully taxable, Treasury (state-exempt), municipal (federal-exempt), or exempt everywhere. A declared value overrides the lot's.
- `issuingState` — The municipal issuer's state. The coupon is state-exempt only when it matches the resident's own state, which is the whole reason this is a field and not a flag.
- `parPerUnit` — Face value of one unit. The units substrate checks its par walk against it.
- `couponRate` — Annual coupon as a decimal. Silent falls back to the lot's own, then to the prevailing rate.
- `couponFrequency` — Payments per year. Each firing pays the coupon rate divided by the frequency.
- `maturityDate` — Set makes this an individual bond: the price pulls to par and it redeems on the date. Silent makes it a perpetual bond fund, which never redeems and never rolls.
- `duration` — Modified duration — how far a rate move marks the price. The larger it is, the more of the plan's risk is in rates rather than equities.
- `zeroCoupon` — No cash coupon: the price accretes to par and the annual accretion is imputed as ordinary income anyway. The tax arrives without the cash, which is the point of modelling it.
- `inflationLinked` — Principal indexes to CPI, and the accretion is imputed ordinary income. Same shape as a zero: taxable before it is spendable.
