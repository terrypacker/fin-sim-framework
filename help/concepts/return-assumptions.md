---
id: return-assumptions
kind: concept
title: Return Assumptions
panels: [allocation, holdings]
params: [usEquityGrowthRate, usEquityDividendYield, auEquityGrowthRate, auEquityDividendYield, intlExUsEquityGrowthRate, intlExUsEquityDividendYield, intlExAuEquityGrowthRate, intlExAuEquityDividendYield, equityAnchorShift, goldGrowthRate, dividendReinvest, auDividendReinvest, superFrankedPercent]
design: [99-market-total-return-model.md, 106-dividend-reinvestment-election.md]
stamps:
  param:usEquityGrowthRate: ebebda
  param:usEquityDividendYield: 3ab1d3
  param:auEquityGrowthRate: 1397b7
  param:auEquityDividendYield: 6bf199
  param:intlExUsEquityGrowthRate: 89051f
  param:intlExUsEquityDividendYield: e3cee3
  param:intlExAuEquityGrowthRate: 62b577
  param:intlExAuEquityDividendYield: 3ea635
  param:equityAnchorShift: f91607
  param:goldGrowthRate: ba6860
  param:dividendReinvest: 9db9f3
  param:auDividendReinvest: 551114
  param:superFrankedPercent: 07a227
  panel:allocation: fc1993
  panel:holdings: 359688
---

What each market is assumed to earn, before any year-to-year variation is layered on
top.

There are **four equity markets**, each with two numbers: a total return and the
portion of it paid as dividends. Every holding that tracks a market earns that
market's figure, in whatever account it sits in — the account decides the tax, not
the return.

The relationship between the pair is the thing most often misread. The dividend
yield does not add to the total or subtract from it; it **splits** it. A higher yield
against the same total means more of the return arrives as taxable distributions and
less as price growth, which changes the tax bill and the cost basis without changing
what the position is worth. Authoring a growth figure where a total is expected
therefore overstates the return by the yield — a meaningful gap on markets yielding
three percent.

Whether distributions are reinvested or paid out as cash is a separate setting per
country, with a household default. It matters for cash flow rather than for total
return, but it is the difference between a portfolio that compounds and one that
quietly accumulates idle cash.

One shift lever moves every equity market together in a single systematic draw, which
is the honest way to sample uncertainty about long-run returns: markets that rise and
fall as one rather than cancelling each other out.

Gold is deliberately independent of both equities and policy rates, and carries its
own disposal treatment. For franking credits on Australian shares, see the franked
fraction — it is a real return component, not an accounting detail.
