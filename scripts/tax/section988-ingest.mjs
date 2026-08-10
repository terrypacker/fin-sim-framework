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
 *   --emit-classified <f> Write every row back out with Kind/BusinessFraction pre-filled
 *                         from the rules and a Status column saying which ones need you.
 *                         Fix those in a spreadsheet and feed the file back in as --csv;
 *                         the columns override the rules permanently. The file carries
 *                         an Account column, so one sheet holds the whole pool.
 *   --card-statement <name>=<file>
 *                         A credit-card statement. Repeatable. Each payment's business
 *                         fraction is derived from the purchases it retired and stamped
 *                         onto the account row that paid it. Needs a "card" block in the
 *                         rules file — see --card-schema.
 *   --card-schema         Print the card block format and exit.
 *   --json                Emit the structured result instead of the human report.
 *   --top <n>             Rows to show per report section (default 15).
 */

import { FxRateTable } from '../lib/fx-rates.mjs';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  KIND, RULES_SCHEMA, readAccountCsv, loadRules, classifyRow,
  footLedger, checkSigns, reconcileInternal, attachRates,
  measurePoolStructure, screenPersonalSurvivors,
  findSignAmbiguousRules, toClassifiedCsv, groupByAccount, classificationStatus, seededBasis,
} from '../lib/section988-source.mjs';
import {
  CARD_SCHEMA, readCardStatementCsv, footCardStatement,
  allocateCardPayments, matchCardPayments, applyCardFractions,
} from '../lib/section988-card.mjs';

/* ───────────────────────────────── arguments ───────────────────────────────────── */

function parseArgs(argv) {
  const opts = { csv: [], cards: [], top: 15 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--csv') {
      const spec = next();
      const eq = spec.indexOf('=');
      if (eq < 0) throw new Error(`--csv expects <name>=<file>, got "${spec}"`);
      opts.csv.push({ name: spec.slice(0, eq), file: spec.slice(eq + 1) });
    } else if (a === '--card-statement') {
      const spec = next();
      const eq = spec.indexOf('=');
      opts.cards.push(eq < 0
        ? { name: `card${opts.cards.length + 1}`, file: spec }
        : { name: spec.slice(0, eq), file: spec.slice(eq + 1) });
    } else if (a === '--card-schema') opts.cardSchema = true;
    else if (a === '--rules') opts.rules = next();
    else if (a === '--rates') opts.rates = next();
    else if (a === '--from') opts.from = next();
    else if (a === '--to') opts.to = next();
    else if (a === '--top') opts.top = Number.parseInt(next(), 10);
    else if (a === '--emit-classified') opts.emitClassified = next();
    else if (a === '--force') opts.force = true;
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

/* ──────────────────────────────── card statements ──────────────────────────────── */

/**
 * Read every card statement, derive each payment's business fraction, and stamp the
 * fractions onto the account rows that paid them.
 *
 * Returns null when no statement was passed, so the report can stay silent rather than
 * printing an empty section on every ordinary run.
 */
function ingestCards(opts, cardConfig, classified) {
  if (opts.cards.length === 0) return null;
  if (!cardConfig) {
    throw new Error(
      '--card-statement needs a "card" block in the rules file.\n'
      + '  It says which categories are business and which credits are payments, and\n'
      + '  neither can be defaulted. Run --card-schema for the format.');
  }

  const statements = [];
  for (const { name, file } of opts.cards) {
    const statement = readCardStatementCsv(file, name);
    const footBreaks = footCardStatement(statement.rows);
    const allocation = allocateCardPayments(statement.rows, cardConfig);
    statements.push({ ...statement, file, footBreaks, ...allocation });
  }

  const allocations = statements.flatMap((s) => s.allocations);
  const { matched, conflicts, confirmed, unusedAllocations } = matchCardPayments(classified, allocations);
  const applied = applyCardFractions(matched);
  return { statements, matched, conflicts, confirmed, unusedAllocations, applied, allocations };
}

/**
 * Which card findings hold the ledger shut.
 *
 * A statement that does not foot is missing rows, so every fraction derived from it is
 * computed against an incomplete balance. A conflict is a row two sources disagree about.
 * An UNCOVERED payment is deliberately NOT here: it is a payment this evidence simply
 * does not reach, and it stays an open decision on its own account row, which the
 * unclassified gate is already counting. Counting it twice would make the total lie.
 */
function cardBlocking(cards) {
  if (!cards) return 0;
  return cards.statements.reduce((n, s) => n + s.footBreaks.length + (s.conservation.balanced ? 0 : 1), 0)
    + cards.conflicts.length;
}

/**
 * Refuse to write the emit over an existing file that was not one of this run's inputs.
 *
 * Emitting back over a file you also passed with `--csv` is the intended round trip and
 * always allowed: the overrides in it were read a moment ago and are being written back.
 * Emitting over some OTHER existing file is the dangerous case, and it is easy to reach
 * by re-running an earlier command whose `--csv` list is now out of date — the run
 * succeeds, every gate passes, and hours of hand classification are gone with no error
 * and nothing to diff against. Manual answers are the one thing here that cannot be
 * recomputed, so this is the one place worth an outright refusal.
 */
function guardEmitTarget(opts) {
  const target = resolve(opts.emitClassified);
  if (!existsSync(target)) return;
  if (opts.force) return;
  if (opts.csv.some(({ file }) => resolve(file) === target)) return;
  throw new Error(
    `refusing to overwrite ${opts.emitClassified}\n`
    + '  It already exists and is NOT one of this run\'s --csv inputs, so anything you\n'
    + '  classified by hand in it would be replaced by rules-only output and lost.\n'
    + '  Either pass it as --csv so its answers are read first (the normal round trip),\n'
    + '  or emit to a new path. --force overrides this.');
}

/* ─────────────────────────────────── main ──────────────────────────────────────── */

function main() {
  const opts = parseArgs(process.argv);

  if (opts.rulesSchema) { out(RULES_SCHEMA); return; }
  if (opts.cardSchema) { out(CARD_SCHEMA); return; }
  if (opts.help || opts.csv.length === 0) {
    out(readFileHeaderUsage());
    process.exitCode = opts.help ? 0 : 1;
    return;
  }

  const rateTable = FxRateTable.load(opts.rates);
  const loaded = opts.rules ? loadRules(opts.rules) : { rules: [], warnings: [], card: null };
  const rules = loaded.rules;
  for (const w of loaded.warnings) process.stderr.write(`  warning: ${w}\n`);

  // ── ingest ────────────────────────────────────────────────────────────────────
  const accounts = [];
  for (const { name, file } of opts.csv) accounts.push({ ...readAccountCsv(file, name), file });

  // Foot each account SEPARATELY — the balance column is per-account and interleaving
  // two accounts' rows would manufacture breaks that are not there. Group by the rows'
  // OWN account rather than by source file: an emitted sheet carries the whole pool in
  // one file with an Account column, and footing it as a single ledger would break on
  // every switch between accounts.
  const pool = groupByAccount(accounts.flatMap((a) => a.rows));
  const footBreaks = [];
  for (const acct of pool) {
    for (const b of footLedger(acct.rows)) footBreaks.push({ account: acct.account, ...b });
  }

  const classified = [];
  for (const acct of accounts) {
    for (const row of acct.rows) {
      const c = classifyRow(row, rules);
      classified.push({ ...row, ...c });
    }
  }
  // Tie-break on ingest order, NOT on line number — see the `seq` note in readAccountCsv.
  classified.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.seq - b.seq);

  // ── card statements ───────────────────────────────────────────────────────────
  // Runs BEFORE the gates, because resolving a card payment changes what the gates
  // see: a row that was an open decision becomes a DISPOSE carrying a fraction, and
  // it then counts as disposed volume in the turnover measurement and as a candidate
  // in the $200 screen. Running it after would report gates on a state that no longer
  // exists.
  const cards = ingestCards(opts, loaded.card, classified);

  const unclassified = classified.filter((r) => r.kind == null && !r.error);
  const errored = classified.filter((r) => r.error);
  const signProblems = checkSigns(classified.filter((r) => r.kind));
  const ambiguousRules = findSignAmbiguousRules(classified, rules);
  const internal = reconcileInternal(classified);
  const { unresolved, carried, basisIssues } = attachRates(classified, rateTable);
  const seeded = seededBasis(classified);
  const structure = measurePoolStructure(classified);
  const survivors = screenPersonalSurvivors(classified, rateTable);

  const result = {
    accounts: pool.map((a) => ({ account: a.account, rows: a.rows.length })),
    rateSource: { file: rateTable.sourceFile, first: rateTable.firstDate, last: rateTable.lastDate },
    gates: {
      footBreaks, unclassified: unclassified.length, classificationErrors: errored.length,
      signProblems: signProblems.length, signAmbiguousRules: ambiguousRules.length,
      unmatchedInternalCredits: internal.unmatchedCredits.length,
      unmatchedInternalDebits: internal.unmatchedDebits.length,
      unresolvedRates: unresolved.length, carriedRates: carried.length,
      cardFootBreaks: cards ? cards.statements.reduce((n, s) => n + s.footBreaks.length, 0) : 0,
      cardConflicts: cards ? cards.conflicts.length : 0,
    },
    cards: cards && {
      method: cards.statements[0]?.method,
      statements: cards.statements.map((s) => ({
        card: s.card, rows: s.rows.length, payments: s.allocations.length,
        footBreaks: s.footBreaks.length, residual: s.residual, totals: s.totals,
      })),
      applied: cards.applied,
      confirmed: cards.confirmed.length,
      uncoveredPayments: cards.unusedAllocations.length,
      conflicts: cards.conflicts.length,
      allocations: cards.allocations,
    },
    seededBasis: seeded,
    structure, survivors,
  };

  if (opts.emitClassified) {
    guardEmitTarget(opts);
    writeFileSync(opts.emitClassified, toClassifiedCsv(classified));
  }

  if (opts.json) { out(JSON.stringify(result, null, 2)); return; }

  report({ opts, accounts: pool, classified, rateTable, footBreaks, unclassified, errored,
    signProblems, ambiguousRules, internal, unresolved, carried, basisIssues, structure, survivors, cards,
    seeded, sources: accounts });

  // Exit non-zero while any hard gate is open, so this can sit in front of the ledger.
  const blocking = footBreaks.length + unclassified.length + errored.length + signProblems.length
    + ambiguousRules.length + internal.unmatchedCredits.length + unresolved.length + basisIssues.length
    + cardBlocking(cards);
  process.exitCode = blocking > 0 ? 1 : 0;
}

/* ─────────────────────────────────── report ────────────────────────────────────── */

function report(ctx) {
  const { opts, accounts, classified, rateTable, footBreaks, unclassified, errored,
    signProblems, ambiguousRules, internal, unresolved, carried, basisIssues, structure, survivors, cards, seeded } = ctx;
  const top = opts.top;

  out('═'.repeat(84));
  out('§988 INGEST — validation only. No gain is computed here.');
  out('═'.repeat(84));
  for (const a of accounts) out(`  account "${a.account}": ${a.rows.length} rows`);
  // A report-style export carries totals rows that look like data. They are dropped for
  // having no date — say so, rather than let a dropped row be invisible.
  for (const a of ctx.sources ?? []) {
    if (a.skipped) out(`         (${a.file}: ${a.skipped} dateless row(s) with an amount skipped as report furniture)`);
  }
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

  // ── GATE 2b: card statements ──────────────────────────────────────────────────
  if (cards) reportCards(cards, top);

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
  if (basisIssues.length) {
    // A STATED basis that could not be resolved. Kept apart from the rows above because
    // the cause is opposite: those are dates the world has not published a rate for, this
    // is an instruction that could not be carried out. Left unreported the row silently
    // falls back to its own date — the exact default the author was overriding.
    out('');
    out(`  !! ${basisIssues.length} row(s) state a BasisDate or BasisRate that could NOT be used.`);
    out('     Each falls back to the row date, which is the default they were overriding.');
    for (const b of basisIssues.slice(0, top)) {
      out(`       ${b.row.date} ${b.row.account} ${money(b.row.amount)} AUD — ${b.why}`);
    }
  }

  if (seeded.rows) reportSeeded(seeded, top);

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
    const byStatus = new Map();
    for (const r of classified) {
      const s = classificationStatus(r);
      byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
    }
    const needed = classified.length - (byStatus.get('OK') ?? 0);
    out(`\n  wrote ${opts.emitClassified} — ${classified.length} rows, Kind/BusinessFraction`);
    out(`  pre-filled from the rules. ${needed} need you; filter column A (Status):`);
    out('');
    out(`    OK        ${String(byStatus.get('OK') ?? 0).padStart(5)}  classified — leave alone`);
    out(`    DECIDE    ${String(byStatus.get('DECIDE') ?? 0).padStart(5)}  a rule identified it and deferred; answer per row`);
    out(`    UNMATCHED ${String(byStatus.get('UNMATCHED') ?? 0).padStart(5)}  no rule describes it — usually wants a new RULE, not an edit`);
    out(`    REJECTED  ${String(byStatus.get('REJECTED') ?? 0).padStart(5)}  an override was refused; Kind/Note show what you typed and why`);
    out('');
    out('  Feed that file back in as --csv — the columns override the rules, and no later');
    out('  rule change can silently undo them. Keep the Date column as text: a spreadsheet');
    out('  that rewrites the dates on save is now a hard error rather than a quiet skip.');
  }

  const blocking = footBreaks.length + unclassified.length + errored.length + signProblems.length
    + ambiguousRules.length + internal.unmatchedCredits.length + unresolved.length + basisIssues.length
    + cardBlocking(cards);
  out('\n' + '═'.repeat(84));
  out(blocking === 0
    ? 'ALL GATES PASS — this history is safe to build a lot ledger on.'
    : `${blocking} item(s) open. Resolve before computing any gain — a path-dependent`);
  if (blocking > 0) out('ledger absorbs these silently and carries them forward forever.');
  out('═'.repeat(84));
}

/**
 * Standing disclosure of basis that was decided rather than measured.
 *
 * Not an open item — the decision has been made — but printed on every run regardless,
 * because this is the figure most likely to be quietly promoted to fact. In every
 * downstream total it is indistinguishable from an observed acquisition, and nothing
 * else in the report would ever mention that it started as an assumption.
 */
function reportSeeded(seeded, top) {
  out('\n── SEEDED BASIS: assumed, not observed ' + '─'.repeat(45));
  out('  These rows are ACQUIRE because their real acquisition is outside everything we');
  out('  can see — currency already held when the export window opens. Stamping the date');
  out('  it first appears is a DECISION, and this section is where that decision lives.');
  out('');
  out(`  ${seeded.rows} row(s)   ${money(seeded.aud)} AUD   =>   ${money(seeded.usd)} USD of assumed basis`);
  out('');
  // WHERE each rate came from, not just what it was. Once BasisDate and BasisRate exist,
  // a row priced from a stated 2008–2016 blend and one priced from the day it happened to
  // appear print the same two numbers and mean entirely different things — and the one
  // that is a judgement call is the one that has to say so.
  out(`  ${'date'.padEnd(12)} ${'account'.padEnd(10)} ${'AUD'.padStart(12)} ${'rate'.padStart(8)} ${'USD basis'.padStart(12)} ${'basis from'.padEnd(16)} description`);
  let overridden = 0;
  for (const e of seeded.entries.slice(0, top)) {
    const rate = e.usdPerAud == null ? '—' : e.usdPerAud.toFixed(4);
    const from = e.basisFrom === 'row-date' ? 'the row date' : `${e.stated ?? e.basisFrom}`;
    out(`  ${(e.date ?? '').padEnd(12)} ${(e.account ?? '').padEnd(10)} ${money(e.aud).padStart(12)} ${rate.padStart(8)} ${money(e.usdBasis).padStart(12)} ${from.slice(0, 15).padEnd(16)} ${e.description.slice(0, 24)}`);
  }
  for (const e of seeded.entries) if (e.basisFrom !== 'row-date') overridden++;
  if (seeded.entries.length > top) out(`  … and ${seeded.entries.length - top} more`);
  out('');

  if (overridden) {
    // What the override BOUGHT, against the same rows priced the old way. The point of
    // stating a basis is that it changes a number, and the size of that change is the
    // thing a reviewer will ask for first.
    const wouldBe = seeded.entries.reduce((s, e) => s + (e.rowDateRate != null ? e.aud * e.rowDateRate : 0), 0);
    out(`  ${overridden} of these state their own basis via BasisDate or BasisRate. Priced instead`);
    out(`  at the date each row appears, the same ${seeded.rows} rows would carry ${money(wouldBe)} USD —`);
    out(`  so the stated bases add ${money(seeded.usd - wouldBe)} USD of basis.`);
    out('');
  }

  out('  WHICH WAY IT ERRS. A row priced from the date it first appears is only neutral if');
  out('  the AUD was actually acquired at that day\'s rate. Held from a period when AUD was');
  out('  STRONGER, true basis is higher than that figure, which understates basis and so');
  out('  OVERSTATES gain — conservative, but not free. State a BasisDate (a day, or a');
  out('  `from..to` window to average across) or a BasisRate on the rows you have records');
  out('  for; leave the rest and they keep the row-date default.');
  out('  Sizing it needs the ledger, not this report: `--seed-sweep 0.74:0.92:0.02` re-runs');
  out('  the whole calculation across a range. Read the DISALLOWED column there — this');
  out('  position is at a loss, so extra basis largely grows a bucket worth nothing.');
}

function reportCards(cards, top) {
  out('\n── GATE 2b: card statements — what did each payment buy? ' + '─'.repeat(27));
  out('  A card payment disposes of AUD, and the purchases it retired decide the');
  out('  §162/§212 share of that ONE disposition. The purchases are not dispositions');
  out('  themselves: the AUD left the pool on the payment date, and §988(e)(2)\'s $200');
  out('  exclusion is per transaction — splitting a payment into its purchases would');
  out('  put every slice under a threshold the payment itself clears.');
  out('');

  for (const s of cards.statements) {
    out(`  card "${s.card}": ${s.rows.length} rows, ${s.allocations.length} payments, method ${s.method}`);
    out(`    purchases ${money(s.totals.purchases)}  refunds ${money(s.totals.refunds)}`);
    if (s.footBreaks.length === 0) {
      out('    foots — every day\'s balance move is explained by that day\'s rows.');
    } else {
      out(`    ${s.footBreaks.length} DAY(S) DO NOT FOOT — rows are missing, so the fractions below are`);
      out('    computed from an incomplete balance. Fix the export first.');
      for (const b of s.footBreaks.slice(0, top)) {
        out(`      ${b.date}  unexplained ${money(b.gap).padStart(12)}  (${b.rows} row(s) that day)`);
      }
    }
    // Money still owed at the end is money whose purpose is decided but not yet paid —
    // it belongs to a future payment, not to a missing one.
    if (s.residual.business + s.residual.personal > 0.005) {
      out(`    still outstanding at the end: business ${money(s.residual.business)}, personal ${money(s.residual.personal)}`);
    }
    if (s.residual.unspentPrepayments > 0.005) {
      out(`    unspent prepayments at the end: ${money(s.residual.unspentPrepayments)} — paid, but nothing bought yet`);
    }
    if (s.conservation.balanced) {
      out(`    conserves — payments − purchases reproduces the closing balance (${money(s.conservation.actual)}).`);
    } else {
      out(`    DOES NOT CONSERVE — ${money(s.conservation.gap)} of payments landed nowhere.`);
      out(`    expected closing ${money(s.conservation.expected)}, tracked ${money(s.conservation.actual)}.`);
      out('    Every fraction above is derived from a balance that is missing money.');
    }
    for (const w of s.warnings.slice(0, top)) out(`    ! ${w}`);
    if (s.warnings.length > top) out(`    … and ${s.warnings.length - top} more warnings`);
  }

  out('');
  out(`  APPLIED to ${cards.applied} account row(s) — each becomes a DISPOSE carrying the`);
  out('  business share of the balance that payment retired.');
  if (cards.confirmed.length) {
    out(`  ${cards.confirmed.length} further row(s) already carried the same answer as an override, from an`);
    out('  earlier run of this. Agreement, not conflict — nothing to do.');
  }

  if (cards.applied) {
    const fracs = cards.matched.map((m) => m.allocation.businessFraction).sort((a, b) => a - b);
    const at = (q) => fracs[Math.min(fracs.length - 1, Math.floor(q * fracs.length))];
    out(`  fraction spread: min ${pct(fracs[0])}  median ${pct(at(0.5))}  max ${pct(fracs[fracs.length - 1])}`);
  }

  if (cards.unusedAllocations.length) {
    // A statement payment with no account row is the direction that matters least — it
    // usually means the paying account was not passed — but it is still a gap in the
    // evidence, so it is named rather than counted.
    out('');
    out(`  ${cards.unusedAllocations.length} statement payment(s) matched NO account row. Either the account that`);
    out('  paid them was not passed with --csv, or the amounts differ. Matching is exact on');
    out('  date and amount by design: a near miss is a different payment, and attaching the');
    out('  wrong month\'s fraction is invisible everywhere downstream.');
    for (const a of cards.unusedAllocations.slice(0, top)) {
      out(`    ${a.date}  ${money(a.amount).padStart(12)}  ${a.card}`);
    }
    if (cards.unusedAllocations.length > top) out(`    … and ${cards.unusedAllocations.length - top} more`);
  }

  if (cards.conflicts.length) {
    out('');
    out(`  ${cards.conflicts.length} row(s) CONFLICT — the statement says the payment bought something, but`);
    out('  the row was already decided otherwise. Nothing was overwritten. A rule that');
    out('  calls a card payment INTERNAL is the usual cause, and it is wrong: paying a');
    out('  card is not a transfer between accounts in the pool.');
    for (const c of cards.conflicts.slice(0, top)) {
      out(`    ${c.row.date}  ${money(c.row.amount).padStart(12)}  ${c.why}`);
    }
    if (cards.conflicts.length > top) out(`    … and ${cards.conflicts.length - top} more`);
  }
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
    '                        in from the rules and a Status column flagging what needs',
    '                        you. Fix those, then feed that file back in as --csv — the',
    '                        columns override rules. Carries Account, so one edited',
    '                        sheet can hold every account in the pool.',
    '  --card-statement <name>=<file>',
    '                        Credit-card statement. Repeatable. Derives each payment\'s',
    '                        business fraction from the purchases it retired. Needs a',
    '                        "card" block in the rules file — --card-schema prints it.',
    '  --force               Allow --emit-classified to overwrite a file that is not',
    '                        one of the --csv inputs. Refused by default.',
    '  --json                Structured output.',
  ].join('\n');
}

try {
  main();
} catch (err) {
  // Every throw in here is a message written FOR the person running it — a malformed
  // rule, a date a spreadsheet rewrote. A stack trace buries that message under frames
  // from a file they have no reason to open.
  process.stderr.write(`\n${err.message}\n`);
  process.exitCode = 2;
}
