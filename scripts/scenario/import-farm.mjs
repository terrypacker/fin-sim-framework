#!/usr/bin/env node
/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * import-farm.mjs — one operator's farm results become a household plan's business income
 * (design 134 §8.3, step 4c).
 *
 *   npm run import:farm -- --farm farm-result.json --operator <operator-id> \
 *     --person <person-id> --into plan.json --out plan-imported.json
 *
 * `--farm` is a farm result export (`npm run farm:export -- --out ...`). The operator's crop
 * year, the only full Schedule F a one-season run gives, becomes one `cfg.businessIncome` row
 * that repeats every year from `--start` (default 1 January of the crop year) to `--end`,
 * indexed by US CPI (design 134 §16.1). If the export has Monte Carlo paths, each one becomes a
 * `cfg.businessIncomePaths` row for a household MC to draw from.
 *
 * Run it with no `--out` first: that is a dry run, and it prints the table and writes nothing.
 *
 * Like import-quicken, the output holds BOTH scenarios: the original untouched, and a copy
 * carrying the import, so the two can be diffed in the workbench. `--replace` patches the
 * scenario at `--index` in place instead, which is how a second operator's import (a couple who
 * both farm) chains onto the first. A re-import replaces the row with the same id and its paths,
 * and touches nothing else.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { parseFlags } from '../lib/cli.mjs';
import { money, columns, heading, note } from '../lib/format.mjs';
import { buildFarmImport, applyFarmImport } from '../lib/farm-import.mjs';

const opts = parseFlags(process.argv.slice(2), {
  usage: 'npm run import:farm -- --farm <export> --operator <id> --person <id> --into <plan> [--out <file>]\n\n'
       + 'import-farm — one operator\'s farm Schedule F becomes a household plan\'s business-income row.',
  farm:     { type: 'string', help: 'farm result export (npm run farm:export -- --out FILE) (required)' },
  operator: { type: 'string', help: 'the operator id in the export (required)' },
  person:   { type: 'string', help: 'the person in the plan who files that Schedule F (required)' },
  into:     { type: 'string', help: 'workbench export holding the household plan (required)' },
  out:      { type: 'string', help: 'where to write; omitted ⇒ dry run, writes nothing' },
  index:    { type: 'number', default: 0, help: 'which scenario in --into' },
  start:    { type: 'string', help: 'first year the row pays from, YYYY-MM-DD (default: 1 January of the crop year)' },
  end:      { type: 'string', help: 'last day the row pays, YYYY-MM-DD (default: to the end of the plan)' },
  rowId:    { type: 'string', help: 'the business-income row id (default farm-<operator>)' },
  name:     { type: 'string', help: 'the new scenario record\'s name' },
  id:       { type: 'string', help: 'the new scenario record\'s id' },
  replace:  { type: 'flag', help: 'patch --index in place instead of appending a copy (chained imports)' },
  force:    { type: 'flag', help: 'write even though errors were reported' },
});

for (const k of ['farm', 'operator', 'person', 'into']) {
  if (!opts[k]) { console.error(`\nimport-farm: --${k} is required.  -h for usage.\n`); process.exit(2); }
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const doc  = readJson(opts.farm);
const file = readJson(opts.into);
const list = file.scenarios ?? (Array.isArray(file) ? file : [file]);
const target = list[opts.index];
if (!target) { console.error(`no scenario at index ${opts.index} in ${opts.into}`); process.exit(2); }

const imp = buildFarmImport(doc, {
  operatorId: opts.operator, personId: opts.person, plan: target,
  rowId: opts.rowId, startDate: opts.start, endDate: opts.end,
});

heading(`Farm import — operator ${opts.operator} → ${target.name ?? target.id ?? 'scenario'} / ${opts.person}`);
if (imp.years.length) {
  columns({ title: `The export's Schedule F for ${opts.operator} (deterministic run)`, rows: imp.years, columns: [
    { head: 'year', get: r => `${r.year}${r.partial ? ' (partial)' : ''}`, align: 'left', width: 15 },
    { head: 'gross', get: r => money(r.grossIncome), width: 12 },
    { head: 'expenses', get: r => money(r.totalExpenses), width: 12 },
    { head: 'Sched F net', get: r => money(r.net), width: 12 },
    { head: 'NE CC tax', get: r => money(r.household.neCommunityCollegeTaxPaid), width: 10 },
  ] });
}
if (imp.row) {
  note(`Row "${imp.row.id}": net ${money(imp.row.net)} and Nebraska community-college tax `
    + `${money(imp.row.neCommunityCollegeTax)} a year, from ${imp.row.startDate}`
    + `${imp.row.endDate ? ` to ${imp.row.endDate}` : ' to the end of the plan'}, indexed by US CPI `
    + 'from its first payment. Only the full crop year is imported (design 134 §16.1).');
  const s = imp.summary;
  if (s.paths) {
    note(`${s.paths} MC paths: net p10 ${money(s.p10)}, p50 ${money(s.p50)}, p90 ${money(s.p90)}; `
      + `a loss in ${(100 * s.lossProbability).toFixed(1)}% of paths. A household MC draws one per year (step 4d).`);
  } else {
    note('The export has no MC paths: a household MC will repeat the deterministic net every year.');
  }
}
for (const w of imp.warnings) console.log(`  ⚠ ${w}`);
for (const e of imp.errors) console.log(`  ✖ ${e}`);

if (imp.errors.length && !opts.force) {
  console.log(`\n  Nothing written — ${imp.errors.length} error(s). --force writes anyway.\n`);
  process.exit(1);
}
if (!imp.row) process.exit(1);
if (!opts.out) {
  console.log('\n  Dry run — no --out, nothing written.\n');
  process.exit(0);
}

const imported = applyFarmImport(target, imp);
imported.initialState = {};   // regenerated by the compile branch; a stale copy is a trap
if (!opts.replace) {
  imported.id = opts.id ?? `${target.id ?? 'u:0'}-farm`;
  imported.name = opts.name ?? `${target.name ?? 'Scenario'} (farm ${opts.operator})`;
  imported.order = (target.order ?? 0) + 1;
  imported.active = false;
} else {
  if (opts.id) imported.id = opts.id;
  if (opts.name) imported.name = opts.name;
}
const scenarios = opts.replace
  ? list.map((sc, i) => (i === opts.index ? imported : sc))
  : [...list, imported];
const ids = scenarios.map(sc => sc.id).filter(Boolean);
const dupe = ids.find((x, i) => ids.indexOf(x) !== i);
if (dupe) {
  console.error(`\nimport-farm: two scenarios would share the id "${dupe}". Pass a distinct --id, `
    + `or --replace to patch --index ${opts.index} in place.\n`);
  process.exit(2);
}
const out = file.scenarios ? { ...file, scenarios } : { scenarios };
writeFileSync(opts.out, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n  Wrote ${opts.out}: row "${imp.row.id}"${imp.paths.length ? ` and ${imp.paths.length} path(s)` : ''}.`);
console.log(`\n  Next:  npm run scenario -- ${opts.out}\n`);
