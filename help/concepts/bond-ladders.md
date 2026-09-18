---
id: bond-ladders
kind: concept
title: Bond Ladders
panels: [holdings]
params: [bondLadderRungs, bondLadderSpacingYears, bondLadderRoll, bondLadderTaxTreatment, bondLadderRole, bondLadderInflationLinked, bondLadderCouponRate]
design: [66-bond-fidelity.md]
stamps:
  param:bondLadderRungs: ac8710
  param:bondLadderSpacingYears: 218e34
  param:bondLadderRoll: 1beb56
  param:bondLadderTaxTreatment: 611cb5
  param:bondLadderRole: 95dbbc
  param:bondLadderInflationLinked: 1150a8
  param:bondLadderCouponRate: 134598
  panel:holdings: 359688
---

Bonds held as individual dated rungs rather than as a single balance earning a rate.

The difference matters for one reason: a rung **matures**. It returns its face value
on a date regardless of what rates have done, which a bond fund does not. That makes
a ladder the natural instrument for funding known future spending, and it is why
rungs and years-of-cover appear together in
[Liquidity Pools](liquidity-pools.md).

The shape is a rung count and a spacing. More rungs and wider spacing buy duration
and yield at the cost of rate risk; fewer and tighter buy liquidity and pay
reinvestment drag. The optimizer can search this, which is usually more honest than
guessing.

**Rolling is the decision that changes what the ladder is for.** With rolling on,
each maturing rung is reinvested at the tail and the ladder perpetuates itself —
that is an accumulation instrument. With it off, maturing rungs fall to cash, which
is a spend-down instrument that steadily converts itself into money to live on.
Those are opposite plans, and it is one switch.

Placement takes account roles, and **every** matching account is laddered, not the
first one found — a household commonly holds bonds in several wrappers and
laddering only one of them would quietly model something else.

Tax treatment is stated per ladder, because whether a rung is fully taxable,
state-exempt like a Treasury, or municipal changes the after-tax yield without
changing the coupon.
