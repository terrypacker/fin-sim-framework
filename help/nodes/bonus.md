---
id: bonus
kind: node
title: Bonus
node: bonus
panels: []
params: []
actions: []
tools: []
design: [116-employment-spells.md]
sources: [src/visualization/people/bonuses-section.js, src/scenarios/toolsets/us-income-toolset.js]
stamps:
  node:bonus: d4f4d9
  src/visualization/people/bonuses-section.js: 21edd5
  src/scenarios/toolsets/us-income-toolset.js: eb075a
---

A one-off payment on a date, such as a signing, retention or year-end bonus, on top of a
person's monthly wage. Add rows in the person's **Bonuses** table. Each row is paid once,
by the job the person holds on that date, so a bonus needs no job of its own: it follows
whichever job is current.

Only a USD job that is not self-employment can pay one. The money lands in the US cash
account and is taxed as that person's wages, counting toward their Social Security wage
base. Nothing is withheld from it, so its tax is paid when the year settles. Saving a row
that no such job covers is refused. If a swept job or retire date later moves the job's
end past a bonus, that run just doesn't pay it, and loading warns.

A row dated before the run starts is history (the money is already in the accounts), so
it never fires. Use one only to keep a record of a past bonus.

## Fields

- `date` — The day the bonus is paid. It must fall inside a USD job that is not self-employment.
- `amount` — The bonus in today's money, the same basis as a job's wage. It is scaled by US inflation from the run's start to the date, so a 20,000 bonus five years out pays what 20,000 buys now.
