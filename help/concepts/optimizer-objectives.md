---
id: optimizer-objectives
kind: concept
title: Objectives and After-Tax Value
panels: [opt-config, opt-results, mpc-cockpit]
params: [terminalWealthTarget, terminalWealthTargetPenalty, afterTaxOrdinaryRate, afterTaxOrdinaryRateAu, afterTaxCapGainsRate, assumedGainFraction, afterTaxRateMethod]
design: [40-after-tax-net-worth.md]
stamps:
  param:terminalWealthTarget: fd83e8
  param:terminalWealthTargetPenalty: b484af
  param:afterTaxOrdinaryRate: 81b164
  param:afterTaxOrdinaryRateAu: 45bf6b
  param:afterTaxCapGainsRate: 8e584d
  param:assumedGainFraction: 53881b
  param:afterTaxRateMethod: da77e9
  panel:opt-config: e04ce5
  panel:opt-results: 36a150
  panel:mpc-cockpit: f4a842
---

What "better" means when something is searching for a better plan.

An objective is a scoring function, and the optimizer will answer exactly the one you
give it. "Maximise ending wealth" produces a plan that under-spends for forty years;
"die with a target" produces something quite different. A result that looks perverse
is usually a correct answer to an objective nobody meant to ask.

The target objective names a net worth to land on, in **real base-year dollars**, with
a penalty for missing it. The penalty shape matters as much as the target: it decides
whether overshooting and undershooting are equally bad, and a plan that treats them
symmetrically will accept a risk of ruin to avoid dying rich.

**After-tax value is the other half, and the one that changes rankings.** A million
dollars in a Roth and a million in a traditional IRA are not the same million, because
one carries an embedded tax liability. Scoring on raw net worth systematically
overrates tax-deferred balances and will favour plans that simply defer tax forever.

Two ways to price that liability. **Configured** rates apply fixed effective
percentages — fast, and adequate for ranking. **Liquidation** stacks the balance
through the real tax engine for an accurate figure at a real cost in time. Use
configured while searching and liquidation to check the winner; if they disagree
about the ranking, the ranking was not robust.

The assumed gain fraction is a fallback for when per-lot basis is unavailable, so the
metric degrades to an estimate rather than pretending there is no gain.
