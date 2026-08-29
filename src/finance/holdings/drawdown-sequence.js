/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ACCOUNT_TYPE }            from '../assets/account.js';
import { DRAWDOWN_SLEEVE_CLASSES } from './holdings-selection.js';

/**
 * DESIGN 97 — the drawdown SEQUENCE: one ordered list of pools.
 *
 * A pool is an account, optionally narrowed to a set of ALLOCATION sleeves:
 *
 *   [ { key: 'auSavingsAccount' },
 *     { key: 'brokerageAccount', sleeves: ['BOND'] },   // bucket 2 — the reserve
 *     { key: 'auOffsetAccount' },                       // the backstop below it
 *     { key: 'brokerageAccount', sleeves: ['EQUITY'] } ]// bucket 3 — growth
 *
 * The list exists because the engine has TWO orderings — accounts by `drawdownPriority`,
 * sleeves by the design-65 selection *inside* one account — and a policy like "after
 * bonds, before equity" lives between them, where neither can say it.
 *
 * This module owns validation. Three failure modes here are silent and produce a
 * perfectly believable number, which is why they throw at config time rather than
 * degrading at runtime:
 *
 *   - an unknown `key` — the pool is skipped and the money quietly comes from elsewhere;
 *   - overlapping sleeve sets — one sleeve is drawn twice in a single walk;
 *   - a sequence set alongside `drawdownMode: 'PROPORTIONAL'` — a sequence IS an
 *     ordering, so one of the two policies would silently win.
 *
 * A fourth is structural: `sleeves` only means anything on an account whose draw runs
 * through `consumeHoldings`, i.e. a BROKERAGE. Narrowing a savings or retirement account
 * would read as a pool boundary and enforce nothing.
 */

const VALID_SLEEVES = new Set(DRAWDOWN_SLEEVE_CLASSES);

/**
 * Validate and normalize an authored sequence.
 *
 * @param {Array<string|{key:string, sleeves?:string[]}>|null} sequence
 * @param {Array<{stateKey:string, type?:string}>} accounts - the scenario's accounts
 * @param {{ drawdownMode?: string }} [opts]
 * @returns {Array<{key:string, sleeves:string[]|null}>|null} null when absent/empty
 * @throws {Error} on any of the four failure modes above
 */
export function normalizeDrawdownSequence(sequence, accounts = [], opts = {}) {
  if (!Array.isArray(sequence) || sequence.length === 0) return null;

  if (opts.drawdownMode === 'PROPORTIONAL') {
    throw new Error(
      'drawdownSequence cannot be combined with drawdownMode PROPORTIONAL: a sequence is '
      + 'an ordering and a pro-rata split is not. Choose one.'
    );
  }

  const byKey = new Map();
  for (const a of accounts) if (a?.stateKey) byKey.set(a.stateKey, a);

  // Per account: the sleeves already claimed, or `true` once a WHOLE-account entry has
  // claimed everything. Both directions are an overlap — a bare entry after a sleeved one
  // re-draws the sleeve it already spent.
  const claimed = new Map();
  const out = [];

  for (const raw of sequence) {
    const entry = typeof raw === 'string' ? { key: raw } : raw;
    const key   = entry?.key;
    if (!key) throw new Error('drawdownSequence entry is missing a `key`');

    const account = byKey.get(key);
    if (!account) {
      throw new Error(
        `drawdownSequence names '${key}', which is not an account stateKey in this scenario. `
        + `Known keys: ${[...byKey.keys()].join(', ')}`
      );
    }

    let sleeves = entry.sleeves ?? null;
    if (sleeves != null) {
      if (!Array.isArray(sleeves) || sleeves.length === 0) {
        throw new Error(`drawdownSequence entry '${key}' has an empty \`sleeves\`; omit it to draw the whole account`);
      }
      for (const cls of sleeves) {
        if (!VALID_SLEEVES.has(cls)) {
          throw new Error(`drawdownSequence entry '${key}' names unknown sleeve '${cls}'. Valid: ${DRAWDOWN_SLEEVE_CLASSES.join(', ')}`);
        }
      }
      if (account.type !== ACCOUNT_TYPE.BROKERAGE) {
        throw new Error(
          `drawdownSequence entry '${key}' narrows sleeves, but only a BROKERAGE account draws through `
          + 'consumeHoldings — on any other account the narrowing would enforce nothing.'
        );
      }
      sleeves = [...sleeves];
    }

    const prior = claimed.get(key);
    if (prior === true) {
      throw new Error(`drawdownSequence claims '${key}' after an entry that already draws the whole account`);
    }
    if (sleeves == null) {
      if (prior) throw new Error(`drawdownSequence draws the whole of '${key}' after already claiming ${[...prior].join(', ')}`);
      claimed.set(key, true);
    } else {
      const set = prior ?? new Set();
      for (const cls of sleeves) {
        if (set.has(cls)) throw new Error(`drawdownSequence claims sleeve '${cls}' of '${key}' twice`);
        set.add(cls);
      }
      claimed.set(key, set);
    }

    out.push({ key, sleeves });
  }

  return out;
}
