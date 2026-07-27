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
 * section988-ingest.mjs — validate real foreign-currency account history before any
 * §988 gain is computed from it. Design 87 §12; the ledger itself is G5.
 *
 * **It computes no tax and is not supposed to.** Every gate here catches a class of
 * error that a path-dependent lot ledger would otherwise absorb silently and carry
 * forward forever. Run this until it is clean, then build the ledger on top.
 *
 * ─── the pool, not the account ──────────────────────────────────────────────────────
 *
 * `§1.988-2(a)(1)(iii)(E)` makes a transfer between two accounts in the same
 * nonfunctional currency a non-recognition event with carryover basis, and
 * `§1.988-2(a)(2)(iii)(B)(1)` requires the basis method to be applied consistently "to
 * **all accounts** denominated in a nonfunctional currency". Both point the same way:
 * the unit of analysis is the household's **entire foreign-currency position**, not one
 * account. Pass every AUD account with repeated `--csv`, and internal transfers cancel.
 * Pass only one and they cannot — see the RECONCILIATION section of the report, which
 * is where currency of unknown basis shows up.
 *
 * Usage:
 *   node scripts/tax/section988-ingest.mjs \
 *     --csv offset=scenarios/OffsetAccountTransactions.csv \
 *     --csv savings=scenarios/SavingsTransactions.csv \
 *     --rules scenarios/section988-rules.json
 *
 * Options:
 *   --csv <name>=<file>   An account to ingest. Repeatable. `name` labels it in reports.
 *   --rules <file>        Classification rules (see --rules-schema). Real descriptions
 *                         carry payee names, so keep yours in gitignored `scenarios/`.
 *   --rules-schema        Print the rules file format and exit.
 *   --rates <file>        Override the pinned rate table (default rates/DEXUSAL-daily.csv).
 *   --from <YYYY-MM-DD>   Restrict *reporting* to a window. Ingest always reads
 *   --to   <YYYY-MM-DD>   everything, because basis reaches back before any query.
 *   --json                Emit the structured result instead of the human report.
 *   --top <n>             Rows to show per report section (default 15).
 */

import { FxRateTable } from '../lib/fx-rates.mjs';
import { writeFileSync } from 'node:fs';
import {
  KIND, RULES_SCHEMA, readAccountCsv, loadRules, classifyRow,
  footLedger, checkSigns, reconcileInternal, attachRates,
  measurePoolStructure, screenPersonalSurvivors,
  findSignAmbiguousRules, toClassifiedCsv,
} from '../lib/section988-source.mjs';

/* ───────────────────────────────── arguments ───────────────────────────────────── */

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
    else if (a === '--from') opts.from = next();
    else if (a === '--to') opts.to = next();
    else if (a === '--top') opts.top = Number.parseInt(next(), 10);
    else if (a === '--emit-classified') opts.emitClassified = next();
    else if (a === '--json') opts.json = true;
    else if (a === '--rules-schema') opts.rulesSchema = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

const money = (n) => (n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (n) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const out = (s = '') => process.stdout.write(`${s}\n`);

/* ─────────────────────────────────── main ──────────────────────────────────────── */

function main() {
  const opts = parseArgs(process.argv);

  if (opts.rulesSchema) { out(RULES_SCHEMA); return; }
  if (opts.help || opts.csv.length === 0) {
    out(readFileHeaderUsage());
    process.exitCode = opts.help ? 0 : 1;
    return;
  }

  const rateTable = FxRateTable.load(opts.rates);
  const loaded = opts.rules ? loadRules(opts.rules) : { rules: [], warnings: [] };
  const rules = loaded.rules;
  for (const w of loaded.warnings) process.stderr.write(`  warning: ${w}\n`);

  // ── ingest ────────────────────────────────────────────────────────────────────
  const accounts = [];
  for (const { name, file } of opts.csv) accounts.push(readAccountCsv(file, name));

  // Foot each account SEPARATELY — the balance column is per-account and interleaving
  // two accounts' rows would manufacture breaks that are not there.
  const footBreaks = [];
  for (const acct of accounts) {
    for (const b of footLedger(acct.rows)) footBreaks.push({ account: acct.account, ...b });
  }

  const classified = [];
  for (const acct of accounts) {
    for (const row of acct.rows) {
      const c = classifyRow(row, rules);
      classified.push({ ...row, ...c });
    }
  }
  classified.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.sourceLine - b.sourceLine);

  const unclassified = classified.filter((r) => r.kind == null && !r.error);
  const errored = classified.filter((r) => r.error);
  const signProblems = checkSigns(classified.filter((r) => r.kind));
  const ambiguousRules = findSignAmbiguousRules(classified, rules);
  const internal = reconcileInternal(classified);
  const { unresolved, carried } = attachRates(classified, rateTable);
  const structure = measurePoolStructure(classified);
  const survivors = screenPersonalSurvivors(classified, rateTable);

  const result = {
    accounts: accounts.map((a) => ({ account: a.account, rows: a.rows.length })),
    rateSource: { file: rateTable.sourceFile, first: rateTable.firstDate, last: rateTable.lastDate },
    gates: {
      footBreaks, unclassified: unclassified.length, classificationErrors: errored.length,
      signProblems: signProblems.length, signAmbiguousRules: ambiguousRules.length,
      unmatchedInternalCredits: internal.unmatchedCredits.length,
      unmatchedInternalDebits: internal.unmatchedDebits.length,
      unresolvedRates: unresolved.length, carriedRates: carried.length,
    },
    structure, survivors,
  };

  if (opts.emitClassified) {
    writeFileSync(opts.emitClassified, toClassifiedCsv(classified));
  }

  if (opts.json) { out(JSON.stringify(result, null, 2)); return; }

  report({ opts, accounts, classified, rateTable, footBreaks, unclassified, errored,
    signProblems, ambiguousRules, internal, unresolved, carried, structure, survivors });

  // Exit non-zero while any hard gate is open, so this can sit in front of the ledger.
  const blocking = footBreaks.length + unclassified.length + errored.length + signProblems.length
    + ambiguousRules.length + internal.unmatchedCredits.length + unresolved.length;
  process.exitCode = blocking > 0 ? 1 : 0;
}

/* ─────────────────────────────────── report ────────────────────────────────────── */

function report(ctx) {
  const { opts, accounts, classified, rateTable, footBreaks, unclassified, errored,
    signProblems, ambiguousRules, internal, unresolved, carried, structure, survivors } = ctx;
  const top = opts.top;

  out('═'.repeat(84));
  out('§988 INGEST — validation only. No gain is computed here.');
  out('═'.repeat(84));
  for (const a of accounts) out(`  account "${a.account}": ${a.rows.length} rows`);
  out(`  rates: ${rateTable.sourceFile}`);
  out(`         published ${rateTable.firstDate} → ${rateTable.lastDate} (USD per AUD)`);

  const dated = classified.filter((r) => r.date);
  if (dated.length) out(`  history: ${dated[0].date} → ${dated[dated.length - 1].date}`);

  // ── kinds ─────────────────────────────────────────────────────────────────────
  out('\n── CLASSIFICATION ' + '─'.repeat(66));
  const tally = new Map();
  for (const r of classified) {
    const k = r.kind ?? 'UNCLASSIFIED';
    if (!tally.has(k)) tally.set(k, { n: 0, gross: 0 });
    const t = tally.get(k);
    t.n++; t.gross += Math.abs(r.amount ?? 0);
  }
  out(`  ${'kind'.padEnd(16)} ${'rows'.padStart(7)} ${'gross (AUD)'.padStart(16)}`);
  for (const [k, t] of [...tally.entries()].sort((a, b) => b[1].gross - a[1].gross)) {
    out(`  ${k.padEnd(16)} ${String(t.n).padStart(7)} ${money(t.gross).padStart(16)}`);
  }

  // ── GATE 1: footing ───────────────────────────────────────────────────────────
  out('\n── GATE 1: does the ledger foot? ' + '─'.repeat(51));
  if (footBreaks.length === 0) {
    out('  PASS — every balance move is explained by its stated amount.');
  } else {
    out(`  FAIL — ${footBreaks.length} break(s). Each one is a row that is missing from the`);
    out('  export. A missing credit is a missing lot; a missing debit means lots that were');
    out('  never consumed. Both are unrecoverable once the ledger has run.');
    out('');
    out(`  ${'account'.padEnd(10)} ${'date'.padEnd(12)} ${'unexplained'.padStart(14)}  after`);
    for (const b of footBreaks.slice(0, top)) {
      out(`  ${b.account.padEnd(10)} ${(b.date ?? '').padEnd(12)} ${money(b.gap).padStart(14)}  ${(b.afterDate ?? '?')}`);
    }
    if (footBreaks.length > top) out(`  … and ${footBreaks.length - top} more`);
  }

  // ── GATE 2: unclassified ──────────────────────────────────────────────────────
  out('\n── GATE 2: is every row classified? ' + '─'.repeat(48));
  if (unclassified.length === 0) {
    out('  PASS — every row matched a rule or a CSV override.');
  } else {
    out(`  FAIL — ${unclassified.length} row(s) unmatched, grouped by description pattern and`);
    out('  ranked by materiality. These are PATTERN decisions, not row decisions.');
    out('');
    const groups = new Map();
    for (const r of unclassified) {
      if (!groups.has(r.normalized)) groups.set(r.normalized, { key: r.normalized, n: 0, gross: 0, sample: r.description });
      const g = groups.get(r.normalized);
      g.n++; g.gross += Math.abs(r.amount ?? 0);
    }
    const ranked = [...groups.values()].sort((a, b) => b.gross - a.gross);
    out(`  ${'rows'.padStart(6)} ${'gross (AUD)'.padStart(15)}  pattern`);
    for (const g of ranked.slice(0, top)) {
      out(`  ${String(g.n).padStart(6)} ${money(g.gross).padStart(15)}  ${g.sample.slice(0, 46)}`);
    }
    if (ranked.length > top) out(`  … and ${ranked.length - top} more patterns`);
    out(`\n  ${ranked.length} distinct pattern(s) to decide.`);
  }

  const decisions = errored.filter((r) => r.needsDecision);
  const rejects = errored.filter((r) => !r.needsDecision);

  if (decisions.length) {
    out('');
    out(`  ${decisions.length} row(s) need a PER-ROW decision a pattern cannot make. Grouped by`);
    out('  reason, with the money at stake — set Kind/BusinessFraction on these rows via');
    out('  --emit-classified, or resolve the reason and replace the rule.');
    const byReason = new Map();
    for (const r of decisions) {
      if (!byReason.has(r.error)) byReason.set(r.error, { reason: r.error, n: 0, gross: 0 });
      const b = byReason.get(r.error);
      b.n++; b.gross += Math.abs(r.amount ?? 0);
    }
    out('');
    for (const b of [...byReason.values()].sort((a, b2) => b2.gross - a.gross)) {
      out(`    ${String(b.n).padStart(4)} rows  ${money(b.gross).padStart(13)} AUD  ${b.reason}`);
    }
  }

  if (rejects.length) {
    out('');
    out(`  ${rejects.length} row(s) matched something but were REJECTED — a malformed`);
    out('  override, or a sign-aware rule silent on the side the row landed on. These are');
    out('  not defaulted, because a default here is permanent and invisible.');
    for (const r of rejects.slice(0, top)) {
      out(`    ${(r.date ?? '?').padEnd(12)} ${money(r.amount).padStart(12)}  ${r.error}  — ${r.description.slice(0, 28)}`);
    }
    if (rejects.length > top) out(`    … and ${rejects.length - top} more`);
  }

  // ── GATE 3: signs ─────────────────────────────────────────────────────────────
  out('\n── GATE 3: do signs agree with kind? ' + '─'.repeat(47));
  if (signProblems.length === 0) out('  PASS — ACQUIRE rows are credits, DISPOSE rows are debits.');
  else {
    out(`  FAIL — ${signProblems.length} row(s) where the rule and the sign disagree.`);
    out('  Usually a rule that is too broad and has caught a refund or a reversal.');
    for (const p of signProblems.slice(0, top)) {
      out(`    ${p.row.date} ${p.row.kind.padEnd(9)} expected ${p.expected.padEnd(7)} saw ${money(p.saw)}  ${p.row.description.slice(0, 34)}`);
    }
  }

  // ── GATE 3b: one rule, both directions ────────────────────────────────────────
  out('\n── GATE 3b: does any rule cover BOTH directions? ' + '─'.repeat(35));
  if (ambiguousRules.length === 0) {
    out('  PASS — no single-kind rule caught both credits and debits.');
  } else {
    out(`  FAIL — ${ambiguousRules.length} rule(s) gave one treatment to money coming IN and money`);
    out('  going OUT. Those are different transactions: a credit acquires currency, a debit');
    out('  disposes of it. Split each into creditKind / debitKind (--rules-schema).');
    out('');
    out(`  ${'rule'.padStart(5)} ${'kind'.padEnd(9)} ${'credits'.padStart(8)} ${'in (AUD)'.padStart(14)} ${'debits'.padStart(7)} ${'out (AUD)'.padStart(14)}  match`);
    for (const a of ambiguousRules.slice(0, top)) {
      const label = a.rule?.regex ?? a.rule?.match ?? '?';
      out(`  ${`#${a.index}`.padStart(5)} ${String(a.kind).padEnd(9)} ${String(a.credits).padStart(8)} ${money(a.creditGross).padStart(14)} ${String(a.debits).padStart(7)} ${money(a.debitGross).padStart(14)}  ${String(label).slice(0, 26)}`);
    }
  }

  // ── GATE 4: internal reconciliation ───────────────────────────────────────────
  out('\n── GATE 4: do internal transfers reconcile? ' + '─'.repeat(40));
  out(`  matched pairs: ${internal.matched.length}`);
  if (internal.unmatchedCredits.length === 0 && internal.unmatchedDebits.length === 0) {
    out('  PASS — every same-currency transfer has both legs inside the pool.');
  } else {
    out(`  ${internal.unmatchedCredits.length} unmatched CREDIT(s), ${internal.unmatchedDebits.length} unmatched DEBIT(s).`);
    out('');
    out('  An unmatched CREDIT is the serious one: basis carries over on these');
    out('  (§1.988-2(a)(1)(iii)(E)), so currency has entered the pool carrying a basis');
    out('  established somewhere we cannot see. It cannot be stamped at the transfer date');
    out('  without understating or inventing gain. Ingest the source account, or record an');
    out('  explicit seeding assumption — design 87 §10.');
    const worst = [...internal.unmatchedCredits].sort((a, b) => b.amount - a.amount);
    if (worst.length) {
      out('');
      out(`  ${'date'.padEnd(12)} ${'account'.padEnd(10)} ${'AUD in'.padStart(14)}  description`);
      for (const r of worst.slice(0, top)) {
        out(`  ${r.date.padEnd(12)} ${r.account.padEnd(10)} ${money(r.amount).padStart(14)}  ${r.description.slice(0, 34)}`);
      }
      const total = worst.reduce((s, r) => s + r.amount, 0);
      out(`  ${''.padEnd(23)} ${money(total).padStart(14)}  TOTAL of unknown basis`);
    }
  }

  // ── GATE 5: rates ─────────────────────────────────────────────────────────────
  out('\n── GATE 5: is a published rate available for every date? ' + '─'.repeat(27));
  out(`  carried from a prior business day (weekend/holiday): ${carried.length}`);
  if (unresolved.length === 0) out('  PASS — every dated row resolves to a published rate.');
  else {
    const notYet = unresolved.filter((u) => u.why === 'not-yet-published');
    const outside = unresolved.filter((u) => u.why === 'outside-series');
    if (notYet.length) {
      out(`  ${notYet.length} row(s) AFTER the last published observation (${rateTable.lastDate}).`);
      out('  H.10 publishes weekly in arrears. These are not fillable — they are simply not');
      out('  yet knowable, and are never carried forward. Re-run after a rate refresh.');
    }
    if (outside.length) {
      out(`  ${outside.length} row(s) BEFORE the series starts — the pinned file is too short.`);
    }
  }

  // ── measurement 1 ─────────────────────────────────────────────────────────────
  out('\n── MEASUREMENT 1: pool structure (design 87 G6) ' + '─'.repeat(36));
  out('  Turnover = disposals ÷ average balance. Near zero means one lot held throughout,');
  out('  where FIFO and pro-rata converge and the convention hardly matters. The higher it');
  out('  runs, the more they diverge — and the shorter FIFO lot ages get, which is what');
  out('  decides long- vs short-term on the capital branch (G10).');
  out('');
  out('  Turnover is ANNUALISED from the days each year actually covers; a year marked');
  out('  "partial" annualises from a short window and should be read as indicative only.');
  const blindYears = structure.filter((y) => y.unreliable);
  if (blindYears.length) {
    out('');
    out(`  !! ${blindYears.length} year(s) marked BLIND: more than 20% of the year's gross activity is`);
    out('     still unclassified, so it counts as neither acquired nor disposed. Those rows');
    out('     read as a dormant pool when they may be the opposite. CLEAR GATE 2 BEFORE');
    out('     BELIEVING ANY TURNOVER FIGURE BELOW.');
  }
  out('');
  out(`  ${'year'.padEnd(6)} ${'acquired'.padStart(14)} ${'disposed'.padStart(14)} ${'avg balance'.padStart(14)} ${'turnover'.padStart(9)} ${'lot age'.padStart(8)}  days`);
  for (const y of structure) {
    if (opts.from && y.year < opts.from.slice(0, 4)) continue;
    if (opts.to && y.year > opts.to.slice(0, 4)) continue;
    const age = y.impliedLotAgeYears == null ? '—' : `${y.impliedLotAgeYears.toFixed(1)}y`;
    const cover = `${y.coverageDays}${y.partial ? ' partial' : ''}`;
    const blind = y.unreliable ? `  BLIND ${pct(y.blindFraction)}` : '';
    out(`  ${y.year.padEnd(6)} ${money(y.acquired).padStart(14)} ${money(y.disposed).padStart(14)} ${money(y.averageBalance).padStart(14)} ${pct(y.turnover).padStart(9)} ${age.padStart(8)}  ${cover}${blind}`);
  }

  // ── measurement 2 ─────────────────────────────────────────────────────────────
  out('\n── MEASUREMENT 2: personal-branch survivors (design 87 G6) ' + '─'.repeat(25));
  out('  §988(e)(2) excludes personal gains of $200 or less per transaction. If nothing can');
  out('  clear $200, FIFO\'s only advantage — a holding period for the capital branch — is');
  out('  worth nothing. A disposition of D AUD needs |Δ USD-per-AUD| > 200/D to clear.');
  out('  THIS IS A SCREEN, NOT A CALCULATION: real gain needs the lot ledger.');
  const d = survivors.moveDistribution;
  out('');
  out(`  observed |Δ| in USD per AUD over ${survivors.horizonYears}y windows (${d.samples} samples):`);
  out(`    p25 ${d.p25?.toFixed(4)}   median ${d.median?.toFixed(4)}   p75 ${d.p75?.toFixed(4)}   p90 ${d.p90?.toFixed(4)}`);
  out(`  personal-share dispositions: ${survivors.count}`);
  out(`  likely to clear $200 (required move < median): ${survivors.likelyClearing}`);
  if (survivors.count) {
    const biggest = [...survivors.dispositions].sort((a, b) => a.requiredMove - b.requiredMove);
    out('');
    out(`  ${'date'.padEnd(12)} ${'personal AUD'.padStart(14)} ${'needs |Δq|'.padStart(11)}  description`);
    for (const s of biggest.slice(0, top)) {
      out(`  ${s.row.date.padEnd(12)} ${money(s.personalUnits).padStart(14)} ${s.requiredMove.toFixed(4).padStart(11)}  ${s.row.description.slice(0, 32)}`);
    }
  }

  // ── verdict ───────────────────────────────────────────────────────────────────
  if (opts.emitClassified) {
    out(`\n  wrote ${opts.emitClassified} — rows with Kind/BusinessFraction pre-filled from`);
    out('  the rules. Correct the wrong ones there and feed THAT file back in as --csv:');
    out('  a per-row override no later rule change can silently undo.');
  }

  const blocking = footBreaks.length + unclassified.length + errored.length + signProblems.length
    + ambiguousRules.length + internal.unmatchedCredits.length + unresolved.length;
  out('\n' + '═'.repeat(84));
  out(blocking === 0
    ? 'ALL GATES PASS — this history is safe to build a lot ledger on.'
    : `${blocking} item(s) open. Resolve before computing any gain — a path-dependent`);
  if (blocking > 0) out('ledger absorbs these silently and carries them forward forever.');
  out('═'.repeat(84));
}

function readFileHeaderUsage() {
  return [
    'section988-ingest.mjs — validate foreign-currency account history (computes no tax).',
    '',
    'Usage:',
    '  node scripts/tax/section988-ingest.mjs \\',
    '    --csv offset=scenarios/OffsetAccountTransactions.csv \\',
    '    --rules scenarios/section988-rules.json',
    '',
    'Options:',
    '  --csv <name>=<file>   Account to ingest. Repeatable — pass EVERY account in the',
    '                        same currency, or internal transfers cannot reconcile.',
    '  --rules <file>        Classification rules. --rules-schema prints the format.',
    '  --rates <file>        Rate table override (default rates/DEXUSAL-daily.csv).',
    '  --from / --to         Restrict reporting; ingest always reads everything.',
    '  --top <n>             Rows per report section (default 15).',
    '  --emit-classified <f> Write the rows back out with Kind/BusinessFraction filled',
    '                        in from the rules. Fix the wrong ones, then feed that file',
    '                        back in as --csv — the columns override rules.',
    '  --json                Structured output.',
  ].join('\n');
}

main();
