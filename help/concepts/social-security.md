---
id: social-security
kind: concept
title: Social Security
panels: [config-list, dg-config]
params: []
actions: [SS_ENTITLEMENT_APPLY, SS_INCOME_APPLY, SOCIAL_SECURITY_SURVIVOR_APPLY]
tools: []
design: [118-social-security-claiming.md, 30-decision-graph-analysis.md]
sources: [src/finance/account-rules/us/us-social-security-rules.js, src/finance/handlers/monthly-social-security-handler.js]
stamps:
  panel:config-list: c29391
  panel:dg-config: 5927ca
  src/finance/account-rules/us/us-social-security-rules.js: 8f3b34
  src/finance/handlers/monthly-social-security-handler.js: 35cf71
---

How a US Social Security benefit is paid, and why the age a person claims it is one
of the few retirement decisions that cannot be undone.

**Everything is a factor times a PIA.** Each person's monthly amount on the
[Person](../nodes/person.md) form is their primary insurance amount: the benefit at
full retirement age (FRA), in today's money, inflated each year with US prices. What
is paid is that amount scaled by when they claim. FRA is set by birth year (65 to 67).
Claiming at 62 cuts the benefit by up to 30%, and each year of waiting past FRA adds up to
8%, stopping at 70. The arithmetic is in months, as the regulations do it.

**A claim is made once.** In the month a person first becomes entitled, the run
records that month on them. Every later payment is priced from it, so a decision
schedule or an MPC rollout that changes the claim age afterwards cannot un-claim.

**The spousal top-up.** In a two-person household, someone whose own amount is under
half their spouse's is paid the difference once both have claimed, reduced if it
starts before their FRA. Everyone is deemed to file for both benefits at once, as the
law has required for anyone born after 1 January 1954. Delayed credits on the lower
earner's own benefit come off the top-up, so a lower earner who waits to 70 can lose
it entirely.

**The survivor benefit.** When a spouse dies, the widow(er) keeps the larger of their
own benefit and a survivor benefit based on the deceased's. An early claim by the
deceased lowers it for good, though never below 82½% of their amount; delayed credits
carry over. It starts at the death or at the survivor's own claim age, whichever is
later, so deferring one's own claim to 70 does not defer the survivor benefit past
the survivor's FRA.

**As a lever.** The claim age is a generated per-person parameter, offered to the
optimizer and the decision graph as nine whole-year choices. A blank claim age means
exactly FRA, which is not one of the nine.

**What is not modelled.** The retirement earnings test, so an early claim while still
working overstates income. The PIA is typed in, not computed from an earnings
record. Divorced-spouse, child and disability benefits, the family maximum and
totalization are out.
