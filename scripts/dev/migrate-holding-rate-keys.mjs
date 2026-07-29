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
 * migrate-holding-rate-keys.mjs — bring saved scenario exports up to the strict
 * Holding contract.
 *
 * `Holding`'s constructor now rejects an allocation outside the ALLOCATION enum and
 * a `rateKey` outside RATE_KEYS, so a scenario carrying a legacy key fails to load
 * instead of silently mis-resolving its rate series. Older exports carry keys that
 * never existed in `RATE_KEYS` (`BOND_US`, `CASH_US`, `EQUITY_INTL`) — the account
 * editor deliberately preserves out-of-enum values on edit, so they survived every
 * round-trip and quietly fell back to the account-level rate.
 *
 * Rather than table a rename, this RE-DERIVES each bad key from the holding's own
 * allocation via the engine's `resolveRateKey(country, allocation, role)`. That way
 * the migration cannot drift from what the loader would resolve, and it picks up
 * the jurisdiction from the owning account (an AU account's bond → FIXED_INCOME_AU).
 *
 * Holdings live in BOTH trees of an export — `scenario.accounts[].holdings` and
 * `scenario.initialState[<stateKey>].holdings` — and the loader reads both, so both
 * are rewritten.
 *
 * Usage:
 *   node scripts/dev/migrate-holding-rate-keys.mjs <file.json> [more.json ...]
 *   node scripts/dev/migrate-holding-rate-keys.mjs scenarios/*.json --dry-run
 *
 * Options:
 *   --dry-run   report what would change; write nothing
 *   --quiet     only print files that changed
 *
 * Files are rewritten in place. Commit (or back up) before running.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { RATE_KEYS }       from '../../src/finance/economic-regimes/rate-keys.js';
import { ALLOCATION_VALUES } from '../../src/finance/holdings/allocation.js';
import { resolveRateKey }  from '../../src/finance/holdings/default-allocations.js';

const KNOWN_RATE_KEYS = new Set(Object.values(RATE_KEYS));

const argv    = process.argv.slice(2);
const dryRun  = argv.includes('--dry-run');
const quiet   = argv.includes('--quiet');
const files   = argv.filter(a => !a.startsWith('-'));

if (files.length === 0) {
  console.error('usage: migrate-holding-rate-keys.mjs <file.json> [more.json ...] [--dry-run] [--quiet]');
  process.exit(2);
}

let totalFixed = 0, totalBad = 0;

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const doc = JSON.parse(raw);
  const scenarios = doc.scenarios ?? (Array.isArray(doc) ? doc : [doc]);

  const changes = [];
  const blockers = [];

  for (const scen of scenarios) {
    // stateKey → {country, role}, so an initialState holding can find its account.
    const meta = new Map();
    for (const a of scen.accounts ?? []) {
      if (a.stateKey) meta.set(a.stateKey, { country: a.country ?? null, role: a.role ?? null });
    }

    const visit = (holdings, stateKey, where) => {
      for (const h of holdings ?? []) {
        if (!h) continue;

        if (!ALLOCATION_VALUES.includes(h.allocation)) {
          // Not auto-fixable: there is no longer a catch-all allocation, and guessing
          // one would silently change the holding's tax and rebalance treatment.
          blockers.push(`${where} ${stateKey}/${h.id ?? '?'}: allocation "${h.allocation}" is not one of ${ALLOCATION_VALUES.join(', ')}`);
          continue;
        }
        if (h.rateKey == null || KNOWN_RATE_KEYS.has(h.rateKey)) continue;

        const { country, role } = meta.get(stateKey) ?? { country: null, role: null };
        const resolved = resolveRateKey(country, h.allocation, role);
        if (resolved == null) {
          blockers.push(`${where} ${stateKey}/${h.id ?? '?'}: cannot resolve a key for ${h.allocation} in country "${country}"`);
          continue;
        }
        changes.push(`${where} ${stateKey}/${h.id ?? '?'} ${h.allocation}: ${h.rateKey} -> ${resolved}`);
        h.rateKey = resolved;
      }
    };

    for (const a of scen.accounts ?? []) visit(a.holdings, a.stateKey, 'accounts');
    for (const [stateKey, node] of Object.entries(scen.initialState ?? {})) {
      if (node && Array.isArray(node.holdings)) visit(node.holdings, stateKey, 'initialState');
    }
  }

  totalFixed += changes.length;
  totalBad   += blockers.length;

  if (changes.length === 0 && blockers.length === 0) {
    if (!quiet) console.log(`${file}: already clean`);
    continue;
  }

  console.log(`${file}: ${changes.length} rewritten${blockers.length ? `, ${blockers.length} NEED MANUAL FIX` : ''}`);
  for (const c of changes)  console.log(`   ${c}`);
  for (const b of blockers) console.log(`   !! ${b}`);

  if (!dryRun && changes.length > 0) {
    // Preserve the file's trailing newline convention.
    writeFileSync(file, JSON.stringify(doc, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
  }
}

console.log(`\n${dryRun ? '[dry run] ' : ''}${totalFixed} holding rateKey(s) rewritten${totalBad ? `; ${totalBad} need manual attention` : ''}.`);
if (totalBad > 0) process.exit(1);
