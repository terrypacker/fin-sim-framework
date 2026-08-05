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
 * probe-904-limitation.mjs — what the §904 limitation actually did, year by year.
 *
 * Design 83 was opened on a single exported year showing a limitation fraction of
 * 5.157, and the reason it survived so long is that no view of the model shows the
 * limitation across time: the tax worksheet shows one year, and `npm run crossfoot`
 * cannot see §904 at all (it only checks worksheet lines carrying a `drillReport`
 * link, and none of the §904 lines do). This prints the whole run.
 *
 * Emits one row per US settle: the limitation base, the denominator, each basket's
 * gross / apportioned deduction / taxable numerator / fraction / credit, and the
 * running pools. `--json` for diffing two revisions of the engine against each
 * other, which is how G1 and G2 were sized.
 *
 * Usage:
 *   node scripts/probes/probe-904-limitation.mjs [--scenario <file.json>] [--index n]
 *                                                [--json] [--to YYYY-MM-DD]
 */

import { loadBaseConfig, parseSourceArgs, describeSource } from '../lib/scenario-source.mjs';
import { openSim, quiet } from '../lib/run.mjs';
import { money } from '../lib/format.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt  = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
};

const loaded = loadBaseConfig(parseSourceArgs(argv));
const cfg    = loaded.cfg;
const asJson = flag('--json');

const sim = quiet(() => openSim(cfg, { telemetry: 'full' }));
quiet(() => sim.stepTo(opt('--to') ? new Date(opt('--to')) : new Date(cfg.simEnd)));

const rows = [];
const seen = new Set();
// getActions returns journal ENTRIES, not actions; the settle payload lives on
// entry.action.data (and only the fields the toolset declares survive pickPayload).
// One settle action is journalled once per reducer that consumes it, so the same
// instanceId appears more than once — dedupe or every year is double-counted.
for (const entry of sim.journal.getActions('US_TAX_SETTLE_APPLY')) {
  const d = entry.action?.data?.taxDetail;
  const ftc = d?.ftc;
  if (!ftc) continue;
  if (seen.has(entry.action.instanceId)) continue;
  seen.add(entry.action.instanceId);
  const basket = (b) => b == null ? null : {
    gross:      round(b.gross),
    deduction:  round(b.apportionedDeduction),
    numerator:  round(b.numerator),
    frac:       Number(b.frac.toFixed(5)),
    limit:      round(b.limit),
    available:  round(b.avail),
    credit:     round(b.credit),
    carryforward: round(b.carryforwardRemaining),
  };
  rows.push({
    year: new Date(entry.date).getUTCFullYear() || null,
    // Design 83 G2 — the limitation base is the §26(b)(1) regular tax, NOT gross
    // tax: the §72(t) penalty, NIIT, SECA and the Additional Medicare surtax are
    // all outside it. Printed side by side so the gap is visible.
    regularTax:     round(d.regularTax),
    grossTax:       round(d.grossTax),
    penaltyTax:     round(d.penaltyTax),
    limitationBase: round(ftc.limitationBase),
    totalTaxable:   round(ftc.totalTaxable),
    // Design 83 G1 — Form 1116 lines 3e and 3c, the two figures that turn a gross
    // basket income into a foreign taxable one.
    grossAllSources:     round(ftc.grossIncomeAllSources),
    unrelatedDeductions: round(ftc.unrelatedDeductions),
    fracSum: Number((ftc.general.frac + ftc.passive.frac + (ftc.resourced?.frac ?? 0)).toFixed(5)),
    general:   basket(ftc.general),
    passive:   basket(ftc.passive),
    resourced: basket(ftc.resourced),
    credits:      round(d.credits),
    netLiability: round(d.netLiability),
  });
}

function round(n) { return n == null ? 0 : Math.round(n * 100) / 100; }

if (asJson) {
  console.log(JSON.stringify(rows, null, 1));
} else {
  console.log(`\n§904 limitation by year — ${describeSource(loaded)}\n`);
  const head = ['year', 'regular tax', 'penalty', 'denominator', 'Σfrac',
                'gen frac', 'pas frac', 'res frac', 'credit', 'net tax'];
  console.log(head.map((h, i) => (i === 0 ? h.padEnd(6) : h.padStart(13))).join(''));
  for (const r of rows) {
    console.log([
      String(r.year ?? '?').padEnd(6),
      money(r.regularTax).padStart(13),
      money(r.penaltyTax).padStart(13),
      money(r.totalTaxable).padStart(13),
      r.fracSum.toFixed(5).padStart(13),
      r.general.frac.toFixed(5).padStart(13),
      r.passive.frac.toFixed(5).padStart(13),
      (r.resourced?.frac ?? 0).toFixed(5).padStart(13),
      money(r.credits).padStart(13),
      money(r.netLiability).padStart(13),
    ].join(''));
  }
  const totalCredit = rows.reduce((s, r) => s + r.credits, 0);
  const totalNet    = rows.reduce((s, r) => s + r.netLiability, 0);
  const worst       = rows.reduce((m, r) => Math.max(m, r.fracSum), 0);
  console.log(`\n${rows.length} settles — lifetime credit ${money(totalCredit)}, `
    + `lifetime net US tax ${money(totalNet)}, worst Σfrac ${worst.toFixed(5)}`);
  console.log('Σfrac > 1 is impossible on a real Form 1116 (design 83 §8).');
}
