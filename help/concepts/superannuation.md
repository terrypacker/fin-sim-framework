---
id: superannuation
kind: concept
title: Superannuation Access
panels: [config-list]
params: []
actions: [MSBS_FUNDED_EARNINGS_APPLY, MSBS_ELECTION_APPLY, MSBS_PENSION_APPLY, MSBS_PENSION_REVERT]
tools: []
design: [119-super-access-and-msbs.md, 77-au-super-fund-tax-and-ftc-creditability.md]
sources: [src/finance/account-rules/au/super-release.js, src/finance/account-rules/au/msbs.js]
stamps:
  panel:config-list: c29391
  src/finance/account-rules/au/super-release.js: be8bb8
  src/finance/account-rules/au/msbs.js: 9bce74
---

When Australian super can be spent, what changes when it starts paying, and how a
preserved military benefit (MSBS) is drawn.

**Release is a date, not an age.** Super opens at the owner's preservation age (55 to
60, by birth date) once they have stopped working, when any job held at 60 or later
ends, or at 65 regardless. The person's jobs decide it, so someone still working at 61
cannot touch their fund in the model, as in law. Every view that asks "can this be
drawn?" — the drawdown walk, pools, net liquidity, the unlock date — reads the same date.

**Starting to draw starts pension phase.** Each fund can wait past its release date.
Until it starts paying, its earnings are taxed at 15%; from then, at 0%. Waiting buys
nothing on its own, so the cost of a late start shows up as fund tax rather than being
hidden. The model does not impose minimum drawdowns or the transfer balance cap.

**Several funds per person.** A job names the fund its Super Guarantee goes to;
otherwise the person's first fund takes it. Caps and the total superannuation balance
sum every fund the person owns, never a spouse's.

**MSBS, preserved.** For a member who has left the ADF, enter the figures from the CSC
statement. The member benefit behaves like any fund. The employer benefit sits beside
it: the funded part grows with CSC's Balanced option and counts in net worth; the
unfunded part rises with CPI each 1 July, never falls, and is shown on its own as the
`msbsUnfundedBenefit` metric rather than in net worth.

**The election.** On the draw date (clamped to between 55, or leaving the ADF, and 65)
the employer benefit converts. The pension is the converted amount divided by 11 at 60,
10 at 65, or 12 at 55, so a later start buys a larger pension per dollar. It is paid
monthly and indexed each 1 July. At 60 and over the funded share is tax-free and the
rest is taxed with a 10% offset, reduced above the defined benefit income cap.
A surviving spouse keeps 67% after three full months.

**What is not modelled.** Serving members, invalidity and redundancy benefits, early
release on hardship, children's pensions, and the US tax on an MSBS pension. CPI is
annual, so the pension rises once a year where the Rules raise it twice.
