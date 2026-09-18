---
id: mortality
kind: concept
title: Mortality and Survivorship
panels: [chart, spending]
params: [mortalityEnabled, survivorEssentialMultiplier, survivorDiscretionaryMultiplier, lateLifeCareMonths, lateLifeCareFactor]
stamps:
  param:mortalityEnabled: 7150d3
  param:survivorEssentialMultiplier: b21345
  param:survivorDiscretionaryMultiplier: 30744f
  param:lateLifeCareMonths: bb7df9
  param:lateLifeCareFactor: 18b1b6
  panel:chart: c05af4
  panel:spending: f9f5c7
---

Whether people in the plan die, and what happens to the household's finances when
one of them does.

Off, the plan runs to its end date regardless of lifespan. That is the right setting
for a clean A/B — a death event landing in different years across two arms confounds
whatever you were comparing — and the wrong setting for asking whether the plan is
actually adequate.

**Survivorship is not "half".** When one spouse dies the household's costs do not
halve, because housing, utilities, insurance and most fixed costs do not care how
many people live there. Two multipliers handle it separately: one for essential
spending, which barely moves, and one for discretionary, which falls further. That
split is the whole point — applying a single factor to total spending gets the answer
wrong in the direction that flatters the plan.

Income changes at the same moment and not in the same proportion: one Social Security
benefit stops, filing status changes, and the survivor's brackets are narrower. A
household can be materially worse off on one income while spending nearly as much,
which is precisely the risk this models.

**Late-life care** is separate and blunt: a window of months at the end of life with
a multiplier on all monthly expenses. It is the largest single expense most
retirements face and the one most plans omit entirely. A plan that survives
comfortably without it and fails with it has not been tested.

Both features are off by default, so a default run is optimistic about both.
