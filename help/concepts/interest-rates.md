---
id: interest-rates
kind: concept
title: Interest Rates and the Yield Curve
panels: [chart, holdings]
params: [usPrimeRate, auPrimeRate, primeRateModel, primeSchedule, primeInflationResponseUs, primeInflationResponseAu, primeInflationSmoothingUs, primeInflationSmoothingAu, primeFloorUs, primeFloorAu, primePolicyNoiseUs, primePolicyNoiseAu, mcPrimeRateModel, usYieldCurveShape, auYieldCurveShape, yieldCurveSchedule, yieldCurveStochastic, yieldCurveVol, yieldCurveReversionSpeed, usSavingsInterestRate, auSavingsInterestRate, fixedIncomeInterestRate, auFixedIncomeInterestRate]
design: [56-prime-relative-rates.md, 67-bond-yield-curve.md]
stamps:
  param:usPrimeRate: d44dc4
  param:auPrimeRate: 108952
  param:primeRateModel: 9b66da
  param:primeSchedule: 3fb735
  param:primeInflationResponseUs: 5b642e
  param:primeInflationResponseAu: 06418f
  param:primeInflationSmoothingUs: 85daaa
  param:primeInflationSmoothingAu: 6f658a
  param:primeFloorUs: 160578
  param:primeFloorAu: c201cc
  param:primePolicyNoiseUs: aea152
  param:primePolicyNoiseAu: a631cb
  param:mcPrimeRateModel: e04a0a
  param:usYieldCurveShape: a0687b
  param:auYieldCurveShape: ee0262
  param:yieldCurveSchedule: 5ee5f6
  param:yieldCurveStochastic: e56522
  param:yieldCurveVol: 598f5a
  param:yieldCurveReversionSpeed: ef74ac
  param:usSavingsInterestRate: 207bf7
  param:auSavingsInterestRate: 513d33
  param:fixedIncomeInterestRate: 7d74cd
  param:auFixedIncomeInterestRate: 14f6cd
  panel:chart: c05af4
  panel:holdings: 359688
---

Two layers that are easy to confuse: the **policy rate** each central bank sets, and
the **term structure** that prices bonds of different maturities.

**The policy rate** drives borrowing costs — mortgages, offset accounts, anything
quoted relative to prime. It can be held flat, stepped through a hand-authored path
year by year, or made to follow inflation. The last of those is the interesting one,
because it closes a loop: inflation rises, policy responds, mortgage costs rise, and
the plan feels the second effect as well as the first. A fixed rate silently assumes
a central bank that ignores the inflation you just modelled.

The response is a long-run relationship with smoothing, not an instant one: a
sustained move in inflation eventually moves policy by a multiple of it, arriving
gradually. A floor exists because policy rates stop near zero rather than going
wherever arithmetic sends them. Optional policy noise adds the part of central-bank
behaviour that inflation does not explain; at zero the rate is a pure function of the
inflation path, which is cleaner for an A/B and less realistic.

**The term structure** is a set of spreads over the fixed-income level, interpolated
across tenors. Authored as a shape it is static; scheduled, it steps year by year;
made stochastic, the whole level wanders with mean reversion, which is what gives
bonds genuine year-to-year rate risk rather than a smooth accrual.

Savings and fixed-income rates are the simple case: flat account-level yields that do
not participate in either layer.
