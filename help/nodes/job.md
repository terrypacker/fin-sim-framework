---
id: job
kind: node
title: Job
node: job
panels: [config-list, paycheque]
design: [116-employment-spells.md, 50-au-source-wages.md, 73-tax-export-validation-fixes.md, 119-super-access-and-msbs.md]
sources: [src/finance/payroll/employment.js, src/visualization/people/jobs-section.js]
stamps:
  panel:config-list: c29391
  panel:paycheque: d4e25c
  node:job: ded547
  src/finance/payroll/employment.js: 82a7ee
  src/visualization/people/jobs-section.js: b4f3e3
---

One stretch of employment for one person: a raise, a pay cut, part-time work before
retiring, or a US job followed by an Australian one after a move. A person with no jobs
has the single job described by their own Wage, Currency, Work Country and Retire Date
fields. Add a job in the person's **Jobs** table and they have a sequence instead; the
first row is filled from those fields, which then lock. Retire Date then shows when the
last job ends, and stays blank when it never ends.

Jobs may not overlap, and the scenario refuses to load if two do. A gap between jobs is
unemployment and pays nothing. Social Security does not wait for work to stop: it starts
at the claim age.

The wage is entered in **today's money** and inflates with the CPI of its own currency's
country from the start of the run, before any move. A job starting in 2035 at 9,000 means
a job paying what 9,000 buys now. The person's payroll elections (deferrals, salary
sacrifice, splits) apply to whichever job is current; a USD job feeds the 401(k) and an
AUD one feeds super, the fund the job names or else the first one the person owns. Employer terms (match, non-elective, Super Guarantee) can differ by
job; blank inherits. The Nodes panel lists every job; selecting one opens its person.

## Fields

- `wageCurrency` — The currency this job pays in. It picks the payroll stream: USD pay reaches the 401(k), IRA and Roth elections; AUD pay reaches super. A split that names an account in the other currency falls back to the transaction account.
- `workCountry` — Where this job's work is physically done, which decides which country taxes it as local income. "Residency" follows wherever the person lives at the time.
- `selfEmployed` — This job's pay is self-employment income rather than wages: US self-employment tax applies, and in Australia there is no employer to pay the Super Guarantee or take a salary sacrifice.
- `k401EmployerMatchPct` — This employer's 401(k) match, read as a full match on the first share of pay; 0.04 matches up to 4%. Blank uses the person's own setting, then the household's. A typed 0 means this employer matches nothing.
- `k401NonElectivePct` — A contribution this employer makes whether or not the person defers anything, as a share of pay. Blank inherits; 0 means none.
- `superGuaranteePct` — The Super Guarantee rate this employer pays on AUD wages. Blank inherits the person's rate, then the household's. Each employer has its own maximum contributions base, so a new job in the same year starts its base again.
- `superAccountKey` — The super fund this job's Super Guarantee, salary sacrifice and personal contributions go into, picked from the person's own funds. "First fund" uses the first one they own. A preserved MSBS benefit is never offered. Only that person's funds are offered, and a scenario that names someone else's fund refuses to load. A person with an Australian job and no fund of their own gets no AU contributions, and loading warns about it.
