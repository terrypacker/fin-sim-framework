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
 * section988-ledger.mjs — design 87 G5. Compute §988 gain from validated history.
 *
 * The other half of `section988-ingest.mjs`. That script validates and computes no tax;
 * this one computes tax and validates nothing. **Run the ingest until every gate is green
 * first** — a lot ledger is path-dependent, so an ingest error is absorbed silently here
 * and carried forward forever.
 *
 * It re-reads the same classified CSV and the same rules, so the two always agree about
 * what the history says.
 *
 * Usage:
 *   node scripts/tax/section988-ledger.mjs \
 *     --csv pool=scenarios/S988/pool-review.csv \
 *     --rules scenarios/S988/section988-rules.json
 *
 * Options:
 *   --csv <name>=<file>   Classified account history. Repeatable, same as the ingest.
 *   --rules <file>        The same rules file the ingest used.
 *   --rates <file>        Rate table override (default rates/DEXUSAL-daily.csv).
 *   --method <m>          fifo | pro-rata (default pro-rata — design 87 G6's incumbent).
 *   --pooling <p>         per-account | commingled (default per-account — §1.988-2
 *                         (a)(1)(iii)(E) carryover; commingling is a recorded choice).
 *   --compare             Run all four convention combinations and print the spread.
 *   --seed-rate <r>       Price EVERY BasisSource=assumed row at this USD/AUD, ignoring
 *                         any BasisDate/BasisRate stated per row. A what-if, not a filing
 *                         position, and it says so on every run.
 *   --seed-sweep <spec>    from:to[:step], or a comma list. Re-runs the ledger at each and
 *                         prints all five columns, because raising basis on a position
 *                         already at a loss mostly grows the DISALLOWED bucket.
 *   --audit <file>        Write the per-row audit trail as a CSV: every input each total
 *                         was built from, the pool either side of every row, and three
 *                         identity residuals. Then foot the CSV against the report.
 *   --audit-all           Also include IGNORE and unclassified rows, which move nothing.
 *   --year <YYYY>         Show every disposition in one tax year.
 *   --json                Structured output.
 *   --top <n>             Rows per section (default 15).
 */

import { writeFileSync } from 'node:fs';
import { FxRateTable } from '../lib/fx-rates.mjs';
import {
  readAccountCsv, loadRules, classifyRow, attachRates, groupByAccount,
} from '../lib/section988-source.mjs';
import {
  runLedger, compareConventions, toAuditCsv, footAudit, sweepSeedRate,
  LEDGER_METHOD, POOLING, PERSONAL_DE_MINIMIS_USD,
} from '../lib/section988-ledger.mjs';

function parseArgs(argv) {
  const opts = { csv: [], top: 15 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--csv') {
      const spec = next();
      const eq = spec.indexOf('=');
      if (eq < 0) throw new Error(`--csv expects <name>=<file>, got "${spec}"`);
      opts.csv.push({ name: spec.slice(0, eq), file: spec.slice(eq + 1) });
    } else if (a === '--rules') opts.rules = next();
    else if (a === '--rates') opts.rates = next();
    else if (a === '--method') opts.method = next();
    else if (a === '--pooling') opts.pooling = next();
    else if (a === '--seed-rate') opts.seedRate = Number.parseFloat(next());
    else if (a === '--seed-sweep') opts.seedSweep = next();
    else if (a === '--audit') opts.audit = next();
    else if (a === '--audit-all') opts.auditAll = true;
    else if (a === '--year') opts.year = next();
    else if (a === '--top') opts.top = Number.parseInt(next(), 10);
    else if (a === '--compare') opts.compare = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

const money = (n) => (n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const out = (s = '') => process.stdout.write(`${s}\n`);

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || opts.csv.length === 0) { out(usage()); process.exitCode = opts.help ? 0 : 1; return; }

  const rateTable = FxRateTable.load(opts.rates);
  const { rules } = opts.rules ? loadRules(opts.rules) : { rules: [] };

  const classified = [];
  for (const { name, file } of opts.csv) {
    for (const row of readAccountCsv(file, name).rows) classified.push({ ...row, ...classifyRow(row, rules) });
  }
  classified.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.seq - b.seq);
  attachRates(classified, rateTable);

  const open = classified.filter((r) => !r.kind).length;
  if (open > 0) {
    out(`!! ${open} row(s) are still unclassified. The ledger SKIPS them, so every figure`);
    out('   below understates by whatever they hold. Clear the ingest gates first:');
    out('   node scripts/tax/section988-ingest.mjs ...\n');
  }

  if (opts.compare) {
    const cmp = compareConventions(classified);
    if (opts.json) { out(JSON.stringify(cmp, null, 2)); return; }
    reportCompare(cmp);
    return;
  }

  if (opts.seedSweep) {
    const rates = parseSweep(opts.seedSweep);
    const rows = sweepSeedRate(classified, rates, { method: opts.method, pooling: opts.pooling });
    if (opts.json) { out(JSON.stringify(rows, null, 2)); return; }
    reportSweep(rows);
    return;
  }

  const result = runLedger(classified, {
    method: opts.method,
    pooling: opts.pooling,
    seedRate: Number.isFinite(opts.seedRate) ? opts.seedRate : undefined,
    audit: Boolean(opts.audit),
    auditIgnored: Boolean(opts.auditAll),
  });
  if (Number.isFinite(opts.seedRate)) {
    out(`!! --seed-rate ${opts.seedRate}: EVERY row marked BasisSource=assumed is priced at`);
    out('   this rate, overriding any BasisDate or BasisRate stated in the CSV. This is a');
    out('   what-if, not a filing position.\n');
  }
  if (opts.json) { out(JSON.stringify({ ...result, dispositions: undefined, skipped: undefined, shortfalls: undefined, audit: undefined }, null, 2)); return; }
  report(result, opts, groupByAccount(classified).length);
  if (opts.audit) reportAudit(result, opts.audit);
}

/**
 * Write the per-row trail, then check that it foots to the report printed above it.
 *
 * The check is not ceremony. The trail is a SECOND rendering of the same walk, so it can
 * drift from the ledger it explains — and a per-row sheet that disagrees with its own
 * totals is worse than no sheet, because it is the one that gets believed. A break here
 * means the trail is wrong; the totals above it are still the calculation.
 */
function reportAudit(result, file) {
  writeFileSync(file, toAuditCsv(result.audit));
  const { totals, breaks, rowChecks } = footAudit(result);

  out(`\n── AUDIT TRAIL → ${file} ` + '─'.repeat(Math.max(0, 60 - file.length)));
  const moved = result.audit.filter((a) => a.poolBasisAfter != null).length;
  out(`  ${result.audit.length} rows in LEDGER order, ${moved} of which moved a pool.`);
  out('  A DISPOSE carries TWO rates: SpotRate prices the proceeds at the disposal date,');
  out('  BasisRate is what the units that left were carrying. Gross is the whole of');
  out('  UnitsPriced x (SpotRate - BasisRate) — Check_GrossFromRates is that identity as a');
  out('  residual. Check_SplitFoots reassembles the four buckets; Check_PoolBasisFoots');
  out('  says basis was conserved. All three are zero on every sound row.');
  out('');
  out(`  ${'total'.padEnd(22)} ${'from the CSV'.padStart(16)} ${'from the ledger'.padStart(16)}   gap`);
  for (const t of totals) {
    const flag = Math.abs(t.gap) > 0.005 ? '  <-- BREAK' : '';
    out(`  ${t.label.padEnd(22)} ${money(t.csv).padStart(16)} ${money(t.report).padStart(16)}   ${money(t.gap)}${flag}`);
  }
  out('');
  const bad = rowChecks.gross + rowChecks.split + rowChecks.pool;
  if (bad === 0 && breaks.length === 0) {
    out('  AUDIT FOOTS. Every identity closes on every row, and the CSV reproduces the');
    out('  five totals above from its own columns.');
  } else {
    out(`  !! ${breaks.length} total(s) disagree; per-row residuals over 0.005: `
      + `${rowChecks.gross} gross, ${rowChecks.split} split, ${rowChecks.pool} pool.`);
    out('     The TRAIL is wrong, not necessarily the ledger. Filter the CSV on the');
    out('     Check_ columns to find them.');
    process.exitCode = 1;
  }
  out('═'.repeat(84));
}

function report(r, opts, accounts) {
  const top = opts.top;
  out('═'.repeat(84));
  out('§988 LEDGER — gain on foreign-currency cash. Design 87 G5.');
  out('═'.repeat(84));
  out(`  method ${r.method}   pooling ${r.pooling}   accounts ${accounts}`);
  out(`  dispositions computed: ${r.dispositions.length}`);
  if (r.seededBasisUsd) {
    out(`  of which basis ASSUMED, not observed: ${money(r.seededBasisUsd)} USD went into the pool`);
    out('  from seeded rows. Every figure below inherits that assumption.');
  }

  if (r.skipped.length) {
    out('');
    out(`  !! ${r.skipped.length} row(s) had NO published rate and were NOT computed.`);
    out('     They are excluded rather than zeroed — a disposition with no rate has no');
    out('     gain anyone can know, and zeroing it would understate the year by its size.');
    for (const s of r.skipped.slice(0, top)) out(`       ${s.date} ${s.account} ${money(s.amount)} AUD  ${s.description.slice(0, 34)}`);
  }

  if (r.shortfalls.length) {
    const overdrafts = r.shortfalls.filter((s) => s.cause === 'overdraft');
    const missing = r.shortfalls.filter((s) => s.cause !== 'overdraft');
    out('');
    out(`  ${r.shortfalls.length} disposition(s) consumed more currency than the pool held.`);
    if (overdrafts.length) {
      const aud = overdrafts.reduce((s, x) => s + x.shortfall, 0);
      out(`     ${overdrafts.length} because the account went OVERDRAWN (${money(aud)} AUD). Not an error and not`);
      out('     missing data: past zero you are not holding currency, you owe it, and a');
      out('     nonfunctional-currency liability is the DEBT regime (design 86 G7), not a');
      out('     cash pool. Those units are excluded here rather than given a zero basis.');
    }
    if (missing.length) {
      out(`     !! ${missing.length} with the balance still positive — acquisitions really are MISSING.`);
      out('        Their gain is computed as if basis were zero, which OVERSTATES it.');
      for (const s of missing.slice(0, top)) {
        out(`       ${s.row.date} ${s.row.account} short ${money(s.shortfall)} AUD  ${s.row.description.slice(0, 30)}`);
      }
    }
  }

  out('\n── BY TAX YEAR ' + '─'.repeat(69));
  out('  ordinary = the business share, §988. capital = the personal share, which');
  out(`  §1.988-1(a)(9) puts outside §988 entirely; §988(e)(2) excludes it at $${PERSONAL_DE_MINIMIS_USD} or less`);
  out('  per transaction. A personal LOSS is disallowed — the floor is written for gain.');
  out('');
  out(`  ${'year'.padEnd(6)} ${'disposals'.padStart(9)} ${'AUD out'.padStart(14)} ${'ordinary'.padStart(12)} ${'capital'.padStart(12)} ${'excluded'.padStart(11)} ${'disallowed'.padStart(11)}`);
  let o = 0; let c = 0; let e = 0; let d = 0;
  for (const y of r.byYear) {
    out(`  ${y.year.padEnd(6)} ${String(y.disposals).padStart(9)} ${money(y.aud).padStart(14)} ${money(y.ordinary).padStart(12)} ${money(y.capitalGain).padStart(12)} ${money(y.deMinimisExcluded).padStart(11)} ${money(y.disallowedPersonalLoss).padStart(11)}`);
    o += y.ordinary; c += y.capitalGain; e += y.deMinimisExcluded; d += y.disallowedPersonalLoss;
  }
  out(`  ${'TOTAL'.padEnd(6)} ${''.padStart(9)} ${''.padStart(14)} ${money(o).padStart(12)} ${money(c).padStart(12)} ${money(e).padStart(11)} ${money(d).padStart(11)}`);
  out('');
  out(`  recognised on the return: ${money(o + c)} USD`);

  if (r.method === LEDGER_METHOD.FIFO) {
    const lt = r.byYear.reduce((s, y) => s + y.capitalLongTerm, 0);
    const st = r.byYear.reduce((s, y) => s + y.capitalShortTerm, 0);
    out(`  capital split: ${money(lt)} long-term, ${money(st)} short-term`);
    out('  (only FIFO can say — pro-rata cannot identify which units left, so it cannot');
    out('   supply a holding period at all. Design 87 G6.)');
  }

  if (opts.year) {
    const rows = r.dispositions.filter((x) => x.taxYear === opts.year)
      .sort((a, b) => Math.abs(b.gross) - Math.abs(a.gross));
    out(`\n── ${opts.year}: every disposition, largest gain first ` + '─'.repeat(30));
    out(`  ${'date'.padEnd(12)} ${'AUD'.padStart(11)} ${'rate'.padStart(7)} ${'basis'.padStart(11)} ${'gross'.padStart(10)} ${'biz'.padStart(5)}  description`);
    for (const x of rows.slice(0, top)) {
      out(`  ${x.date.padEnd(12)} ${money(x.aud).padStart(11)} ${x.usdPerAud.toFixed(4).padStart(7)} ${money(x.basis).padStart(11)} ${money(x.gross).padStart(10)} ${String(x.businessFraction).padStart(5)}  ${x.description.slice(0, 30)}`);
    }
    if (rows.length > top) out(`  … and ${rows.length - top} more`);
  }

  out('\n── POOL AT THE END ' + '─'.repeat(65));
  for (const p of r.residual) {
    const rate = p.units > 0 ? (p.basis / p.units) : null;
    out(`  ${p.pool.padEnd(12)} ${money(p.units).padStart(14)} AUD   basis ${money(p.basis).padStart(12)} USD${rate ? `   (${rate.toFixed(4)} avg)` : ''}`);
  }
  out('');
  out('  This is the unrealised position — the gain that has NOT been recognised yet, and');
  out('  what a future disposal will be measured against.');
  out('═'.repeat(84));
}

/** `0.74:0.90:0.02` (from:to:step) or a comma list `0.74,0.82,0.90`. */
function parseSweep(spec) {
  const asNumbers = (s) => s.split(/[,:]/).map((x) => Number.parseFloat(x));
  if (spec.includes(':')) {
    const [from, to, step = 0.02] = asNumbers(spec);
    if (![from, to, step].every(Number.isFinite) || step <= 0 || to < from) {
      throw new Error(`--seed-sweep "${spec}": want from:to[:step], e.g. 0.74:0.90:0.02`);
    }
    const rates = [];
    // Accumulating `r += step` drifts and can emit 0.8200000000000001 as a label; stepping
    // by index keeps every candidate exactly the number that was asked for.
    for (let i = 0; from + i * step <= to + 1e-9; i++) rates.push(Math.round((from + i * step) * 1e6) / 1e6);
    return [null, ...rates];
  }
  const rates = asNumbers(spec);
  if (!rates.every(Number.isFinite)) throw new Error(`--seed-sweep "${spec}": want numbers`);
  return [null, ...rates];
}

function reportSweep(rows) {
  const base = rows.find((r) => r.seedRate == null);
  out('═'.repeat(84));
  out('§988 LEDGER — what the SEEDED-BASIS assumption is worth.');
  out('═'.repeat(84));
  out('  Every row marked BasisSource=assumed is re-priced at each rate below; observed');
  out('  acquisitions are untouched. The first line is the file as it stands.');
  out('');
  out('  READ THE DISALLOWED COLUMN. This position is already at a loss, so raising basis');
  out('  makes the loss LARGER — and the personal share of a §988 loss is disallowed');
  out('  outright, not merely deferred. Much of what looks like an improving recognised');
  out('  figure is landing there, where it is worth nothing.');
  out('');
  out(`  ${'seed rate'.padEnd(11)} ${'seeded basis'.padStart(13)} ${'ordinary'.padStart(12)} ${'capital'.padStart(11)} ${'excluded'.padStart(10)} ${'disallowed'.padStart(11)} ${'recognised'.padStart(12)}`);
  for (const r of rows) {
    const label = r.seedRate == null ? 'as filed' : r.seedRate.toFixed(4);
    out(`  ${label.padEnd(11)} ${money(r.seededBasisUsd).padStart(13)} ${money(r.ordinary).padStart(12)} ${money(r.capitalGain).padStart(11)} ${money(r.deMinimisExcluded).padStart(10)} ${money(r.disallowedPersonalLoss).padStart(11)} ${money(r.recognised).padStart(12)}`);
  }
  const moved = rows.filter((r) => r.seedRate != null);
  if (base && moved.length) {
    const last = moved[moved.length - 1];
    const d = (k) => last[k] - base[k];
    const basis = d('seededBasisUsd');
    const ordinary = d('ordinary');
    const capital = d('capitalGain');
    const excluded = d('deMinimisExcluded');
    const disallowed = d('disallowedPersonalLoss');
    // Extra basis does not all land in the four buckets. Most of the pool is still HELD,
    // so basis attached to units that were never disposed of sits unrealised — and a
    // summary that split the whole figure across the buckets would overstate what the
    // better records buy by whatever is still in the pool.
    const recognisedChange = ordinary + capital + excluded - disallowed;
    const unrealised = basis + recognisedChange;

    out('');
    out(`  Across the range, ${money(basis)} USD of extra basis lands as:`);
    out(`    ${money(ordinary).padStart(12)}  ordinary — deductible, and the only part worth full value`);
    out(`    ${money(capital).padStart(12)}  capital gain — worth the capital rate`);
    out(`    ${money(disallowed).padStart(12)}  DISALLOWED personal loss — worth nothing at all`);
    out(`    ${money(excluded).padStart(12)}  excluded under the floor — worth nothing`);
    out(`    ${money(unrealised).padStart(12)}  still unrealised, sitting in the pool against a future disposal`);
    const dead = Math.abs(disallowed) + Math.abs(excluded);
    const live = Math.abs(ordinary) + Math.abs(capital);
    if (dead > live) {
      out('');
      out(`  MORE THAN HALF IS DEAD (${money(dead)} vs ${money(live)}). Better records for the seeded`);
      out('  rows would move a large number and buy much less than it looks like. Weigh that');
      out('  before spending time digging them up.');
    }
  }
  out('═'.repeat(84));
}

function reportCompare(cmp) {
  out('═'.repeat(84));
  out('§988 LEDGER — the two convention choices, measured. Design 87 G6 and G11.');
  out('═'.repeat(84));
  out('  §1.988-2(a)(2)(iii)(B)(1) permits any reasonable method consistently applied to');
  out('  ALL accounts, every year. The choice is locked at adoption and binds every future');
  out('  year, so the criterion is robustness, not whichever wins on the path that');
  out('  happened. A narrow spread IS the answer: the cheaper convention costs nothing.');
  out('');
  out(`  ${'pooling'.padEnd(13)} ${'method'.padEnd(9)} ${'ordinary'.padStart(12)} ${'capital'.padStart(12)} ${'excluded'.padStart(11)} ${'disallowed'.padStart(11)} ${'recognised'.padStart(12)}`);
  for (const r of cmp.runs) {
    out(`  ${r.pooling.padEnd(13)} ${r.method.padEnd(9)} ${money(r.ordinary).padStart(12)} ${money(r.capitalGain).padStart(12)} ${money(r.deMinimisExcluded).padStart(11)} ${money(r.disallowedPersonalLoss).padStart(11)} ${money(r.recognised).padStart(12)}`);
  }
  out('');
  out(`  SPREAD across all four conventions: ${money(cmp.spread)} USD of recognised gain.`);
  out('═'.repeat(84));
}

function usage() {
  return [
    'section988-ledger.mjs — compute §988 gain from validated history (design 87 G5).',
    '',
    'Run scripts/tax/section988-ingest.mjs until every gate is green FIRST. This ledger',
    'is path-dependent and absorbs an ingest error silently, forever.',
    '',
    'Usage:',
    '  node scripts/tax/section988-ledger.mjs \\',
    '    --csv pool=scenarios/S988/pool-review.csv \\',
    '    --rules scenarios/S988/section988-rules.json',
    '',
    'Options:',
    '  --csv <name>=<file>   Classified history. Repeatable.',
    '  --rules <file>        The same rules file the ingest used.',
    '  --method <m>          fifo | pro-rata      (default pro-rata)',
    '  --pooling <p>         per-account | commingled  (default per-account)',
    '  --compare             Run all four combinations and print the spread.',
    '  --seed-rate <r>       Re-price every assumed row at this rate (a what-if).',
    '  --seed-sweep <spec>   from:to[:step] or a list — what the seeded assumption is worth.',
    '  --audit <file>        Write the per-row audit CSV and foot it against the report.',
    '  --audit-all           Include IGNORE / unclassified rows in that CSV too.',
    '  --year <YYYY>         List every disposition in one tax year.',
    '  --rates / --top / --json',
  ].join('\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`\n${err.message}\n`);
  process.exitCode = 2;
}
