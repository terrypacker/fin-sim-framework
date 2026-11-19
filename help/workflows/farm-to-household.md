---
id: farm-to-household
kind: workflow
title: Farm Results into a Household Plan
panels: []
params: [businessIncomeFarmPaths, mcFarmPaths]
actions: []
tools: [scripts/farm/farm-export.mjs, scripts/scenario/import-farm.mjs]
design: [134-farm-job-costing.md]
sources: [src/finance/farm/farm-export.js, src/finance/payroll/business-income.js]
stamps:
  param:businessIncomeFarmPaths: 4622e2
  param:mcFarmPaths: f159da
  src/finance/farm/farm-export.js: 20aad3
  src/finance/payroll/business-income.js: 1a8c09
---

A farm scenario and a household plan stay **separate scenarios**, joined by a file. The farm
runs one crop year on a dense calendar; the household runs decades. Each operator files their
own Schedule F, so each household imports only its own operator's slice.

**1. Export the farm.** `npm run farm:export -- --scenario farm.json --out farm-result.json`
writes a calendar-year Schedule F for every operator: the lines, the net, and what the
household's return needs from it (the Schedule SE line 1a amount, the QBI before the
household's own adjustments, and the Nebraska community-college tax paid that year). Add
`--n 500 --enable all` to carry Monte Carlo paths as well, each one a whole farm history with
its seed. Run it without `--out` first to read the table.

**2. Import one operator.** `npm run import:farm -- --farm farm-result.json --operator <id>
--person <id> --into plan.json --out plan-farm.json`. Without `--out` it is a dry run. The
output holds the original plan and a copy carrying the import, so the two can be compared.
A second operator in the same household chains on with `--replace`.

**What the household gets.** One business-income row for the person, paying the operator's
**crop-year** Schedule F net every year from 1 January of the crop year (`--start`, `--end`
to change it), indexed by US CPI from its first payment. The crop year is the one full
Schedule F a one-season run produces. It already includes last season's carry-in and next
season's prepay, so repeating it treats each season as a typical one. The years before and
after are partial and are not imported.

**How it is taxed.** The net is ordinary income and the self-employment tax base, exactly as
a self-employed wage is, and Nebraska taxes it the same way. A loss debits the household's US
cash and offsets its other income. It is paid on 15 December, before the year's returns settle.

**Under Monte Carlo** each household year draws its own farm season from the imported paths,
so a run can have a drought year followed by a good one, and the farm's seasons are
independent of the household's markets. A single run pays the deterministic net unless you
turn the draw on; Monte Carlo turns it on unless you turn it off, which isolates the
household's own risk.

**What is not there yet.** The QBI deduction, the Nebraska community-college credit, the
excess business loss limit, the farming-loss carryback and income averaging are later steps
of design 134 phase 4.
