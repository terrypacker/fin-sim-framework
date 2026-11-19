---
id: farm-to-household
kind: workflow
title: Farm Results into a Household Plan
panels: []
params: [businessIncomeFarmPaths, mcFarmPaths, usFarmingLossCarryback, usFarmIncomeAveraging]
actions: []
tools: [scripts/farm/farm-export.mjs, scripts/scenario/import-farm.mjs]
design: [134-farm-job-costing.md]
sources: [src/finance/farm/farm-export.js, src/finance/payroll/business-income.js]
stamps:
  param:businessIncomeFarmPaths: 4622e2
  param:mcFarmPaths: f159da
  param:usFarmingLossCarryback: a0bd40
  param:usFarmIncomeAveraging: 25e5dd
  src/finance/farm/farm-export.js: 20aad3
  src/finance/payroll/business-income.js: 5d7870
---

A farm scenario and a household plan stay **separate scenarios**, joined by a file. The farm
runs one crop year on a dense calendar; the household runs decades. Each operator files their
own Schedule F, so each household imports only its own operator's slice.

**1. Export the farm.** `npm run farm:export -- --scenario farm.json --out farm-result.json`
writes a calendar-year Schedule F for every operator, and what the household's return needs
from it. Add `--n 500 --enable all` to carry Monte Carlo paths too, each a whole farm history
with its seed. Run it without `--out` first to read the table.

**2. Import one operator.** `npm run import:farm -- --farm farm-result.json --operator <id>
--person <id> --into plan.json --out plan-farm.json`. Without `--out` it is a dry run. The
output holds the original plan and a copy carrying the import, so the two can be compared.
A second operator in the same household chains on with `--replace`.

**What the household gets.** One business-income row for the person, paying the operator's
**crop-year** Schedule F net every year from 1 January of the crop year (`--start`, `--end`
to change it), indexed by US CPI from its first payment. The crop year is the one full
Schedule F a one-season run produces, carry-in and prepay included, so repeating it treats
each season as a typical one.

**How it is taxed.** The net is ordinary income and the self-employment tax base, exactly as
a self-employed wage is, and Nebraska taxes it the same way. A loss debits the household's US
cash and offsets its other income. It is paid on 15 December, before the year's returns settle.

**Under Monte Carlo** each household year draws its own farm season from the imported paths,
so a run can have a drought year followed by a good one, and the farm's seasons are
independent of the household's markets. A single run pays the deterministic net unless you
turn the draw on; Monte Carlo turns it on unless you turn it off, which isolates the
household's own risk.

**The QBI deduction.** The return deducts 20% of the farm net (less its share of the
self-employment tax deduction), capped at 20% of taxable income less net capital gain.
Above the year's threshold the farm's W-2 wages and machinery basis (`qbiW2Wages`, `qbiUbia`
on the row) limit it; with neither, only the minimum deduction (from 2026) is left. All the
household's farm rows count as one business.

**The Nebraska credit.** The community-college share of the farm's property tax, already an
expense inside the net, is also refunded in full as a credit on the operator's Nebraska
return. It is refundable, so a household owing less gets the difference paid. A person
living outside Nebraska gets none, and the import warns.

**A loss year.** A farm loss offsets other income in its year, down to two limits. A loss
over the year's excess-business-loss threshold (\$256,000 single, \$512,000 joint in 2026)
waits a year, and a loss larger than everything else on the return is not wasted. By
default that second part goes back two years first and refunds tax those returns paid;
the rest, and the over-threshold part, comes off later years' income, at most 80% of each.
Nebraska's return here still nets the loss in its year and carries nothing.

**Income averaging** is an election, off by default. It taxes part of a good year's farm
income at the three prior years' rates. Both it and the carryback need prior returns: the
run's own, or `usPriorReturns` in the plan file (year and taxable income) for the years
before it.
