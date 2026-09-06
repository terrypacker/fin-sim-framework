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
 * quicken-import.mjs — the MAPPING half: a parsed Quicken tree + a mapping file →
 * `cfg.accounts` patches and `cfg.securities`.
 *
 * `quicken-csv.mjs` knows Quicken and nothing about this repo. This module knows this
 * repo and nothing about CSV. It is pure: no file I/O, no process exit, no console —
 * everything it wants to say comes back in `errors` and `warnings`, so the CLI can
 * decide what is fatal and a test can assert on the diagnostics instead of scraping
 * stdout.
 *
 * A diagnostic is `{ stateKey, message }`, not a string, and the `stateKey` is the
 * reason: the report marks an account as suspect, and deciding WHICH account a warning
 * belongs to by searching its prose for an account name is the kind of link that works
 * until someone rewords a message.
 *
 * ─── the two things the export cannot tell us, and why the mapping file exists ─────
 *
 * **1. Which scenario account a Quicken account is.** Nothing in the export names a
 * `stateKey`, a tax wrapper, an owner or a currency. `mapping.accounts` supplies it.
 *
 * **2. What market an instrument tracks.** The `Type` column says `Stock` / `Mutual
 * Fund` / `Bond` / `Other`, which is not the question this engine asks. ALLOCATION is
 * the authoritative asset-class signal (design 90 §7.3) and `rateKey` names the return
 * series; VXUS is `EQUITY_INTL_EX_US`, AAAU is GOLD with `isGold`, VMFXX is CASH — and
 * an export where all five of an account's holdings say `Other` cannot distinguish any
 * of them. So `mapping.securities` is required, keyed by symbol, and an instrument that
 * resolves to nothing is a hard error rather than a default. Guessing here does not
 * produce an approximate plan; it produces a confident one that taxes gold at the
 * equity rate.
 *
 * ─── the invariants this module exists to not break ────────────────────────────────
 *
 * **`balance` = Σ `holdings.marketValue`.** `audit-scenario.mjs` checks it, and a
 * balance edit does NOT rescale holdings anywhere in this codebase. Both are written
 * here, from the same sum, every time.
 *
 * **`contributionBasis` + `earningsBasis` = `balance`** on a wrapper account, and
 * `derivedIncomeBasis` ⊆ `earningsBasis` (design 84 G2). Quicken has never heard of a
 * contribution basis, so restating a Roth's balance without restating the split is how
 * the withdrawal-ordering math silently stops being about this plan. `contributionBasis`
 * comes from the mapping or is PRESERVED from the target account; the earnings side is
 * re-derived; and the derived-income share is carried across at its existing RATIO.
 *
 * **`contributionBasis` is also param-owned** (`node: {type:'account', field:
 * 'contributionBasis'}` — design 32). Writing only the account field leaves the param
 * to overwrite it at load. `contributionBasisParamPatches` is how the CLI keeps the
 * pair honest; there is no third store.
 *
 * ─── what is deliberately NOT emitted ──────────────────────────────────────────────
 *
 * **`units` / `pricePerUnit` / `parPerUnit`.** Promotion is an act at the config→run
 * boundary, not a property of a saved file (design 93 §5b) — `projectHoldingsToState`
 * does it, and for a bond `unitiseBond` reproduces the Quicken row exactly, because
 * Quicken's bond "shares" ARE $100-par units and `PAR_PER_UNIT` is 100. Writing units
 * into the scenario file would duplicate that derivation in a second place.
 *
 * For EQUITY the reason is different and worth stating, because the share counts ARE
 * in the export and importing them looks like free fidelity. The engine's equity unit
 * is `marketValue / 100`, a synthetic count, and `prevailingPrice` — which prices every
 * lot the rebalancer and harvester create — averages across all lots of the same
 * ALLOCATION in an account regardless of security. Real share counts there blend VOO
 * against SWTSX into a price that is no instrument's. It stays dollar-conserving, so
 * nothing breaks; it just buys nothing the engine reads. The real share count is kept
 * on the lot's `label`, where it is visible and inert.
 */

import { ALLOCATION }       from '../../src/finance/holdings/allocation.js';
import { RATE_KEYS }        from '../../src/finance/economic-regimes/rate-keys.js';
import { parseBondName }    from './quicken-csv.mjs';
import { scenarioSecurityRegistry, SYNTHETIC_SECURITY_PREFIX }
  from '../../src/finance/holdings/security.js';
import { CLASS_KEYS_BY_ALLOCATION } from '../../src/finance/holdings/default-allocations.js';
import { TAX_CLASS, taxClassForRole } from '../../src/finance/derived-metrics/after-tax.js';

/**
 * The prefix every lot this importer mints carries.
 *
 * Not one of `LOT_POLICIES`' prefixes (`reb-`, `ladder-`, `reinvest-`), and that is the
 * point: `compactLots` merges only lots whose id starts with a policy prefix, so an
 * imported lot is never silently blended into a neighbour. An imported lot is a real,
 * dated acquisition with a real basis — the one kind of lot that must survive intact,
 * because it is what the short/long-term split is computed from.
 */
export const IMPORT_LOT_PREFIX = 'qkn-';

/** What to do with a lot whose cost basis Quicken records as `Add` (unknown). */
export const UNKNOWN_BASIS_POLICY = Object.freeze({
  /** Basis = market value ⇒ zero unrealized gain. The least-wrong placeholder. */
  MARKET: 'market',
  /** Basis = 0 ⇒ the whole position is gain. Honest only if it really was free. */
  ZERO: 'zero',
});

/** Quicken bond "shares" are $100-par units; this is the same constant `unitiseBond` uses. */
const PAR_PER_UNIT = 100;

const round2 = (n) => +(+n).toFixed(2);

/** `Terry Brokerage 567` → `terry-brokerage-567`, for building stable lot ids. */
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The instrument half of a lot id.
 *
 * Stable across re-imports is the requirement — a lot id that moves turns every
 * re-import into a wholesale replacement instead of a readable diff. The security id
 * is best, the symbol next; a bond has neither, so its maturity identifies it (which
 * is what actually distinguishes one T-bill from the next), and a 24-character slug of
 * the name is the last resort rather than the whole 40-character instrument name.
 */
function positionKey(position, spec, maturityDate = null) {
  if (spec.id != null) return slug(spec.id);
  if (position.symbol) return slug(position.symbol);
  if (maturityDate) return `bond-${maturityDate}`;
  return slug(position.name).slice(0, 24).replace(/-$/, '');
}

/**
 * Resolve one Quicken position against `mapping.securities`.
 *
 * Lookup order is symbol, then exact name, then any `match` regex — because the four
 * T-bills have NO symbol at all and the SSgA fund's symbol is the literal string
 * `Unknown`, so a symbol-only map cannot address a third of this portfolio. A single
 * `match` entry keyed `@bond` covers every treasury in one rule.
 *
 * @returns {{ spec: object, key: string }|null} null when nothing matches
 */
function resolveSecuritySpec(position, securityMap) {
  const bySymbol = position.symbol && securityMap[position.symbol];
  if (bySymbol) return { spec: bySymbol, key: position.symbol };
  const byName = securityMap[position.name];
  if (byName) return { spec: byName, key: position.name };
  for (const [key, spec] of Object.entries(securityMap)) {
    if (!spec?.match) continue;
    if (new RegExp(spec.match, 'i').test(position.name)) return { spec, key };
  }
  return null;
}

/**
 * Build the scenario `Security` record for one mapping entry, or null when the entry
 * declines to author one.
 *
 * A mapping entry may omit `id`, and a BOND one usually does: every T-bill in the
 * export is a distinct instrument matched by ONE `@bond` rule, so minting a shared
 * security from it would claim they are the same bond. Their instrument data
 * (maturity) lives on the lot instead, which is where a bond's does anyway.
 */
function securityRecordFor(spec, key) {
  if (spec.id == null) return null;
  const out = { id: spec.id, symbol: spec.symbol ?? (key.startsWith('@') ? '' : key) };
  for (const f of ['name', 'rateKey', 'beta', 'idioVol', 'dividendYield', 'qualifiedDividends',
    'frankingCredit', 'currency', 'country', 'taxExemption', 'issuingState', 'isGold',
    'identityGroup']) {
    if (f in spec) out[f] = spec[f];
  }
  return out;
}

/**
 * Convert one Quicken lot into a scenario holding.
 *
 * @param {object} ctx - `{ position, lot, spec, index, accountName, policy }`
 * @returns {{ holding: object, warnings: string[], errors: string[] }}
 */
function lotToHolding({ position, lot, spec, index, accountName, stateKey, policy }) {
  const warnings = [], errors = [];
  const warn = (message) => warnings.push({ stateKey, message });
  const fail = (message) => errors.push({ stateKey, message });
  const allocation = spec.allocation;
  // A missing market value is NOT a zero position. It means the money column did not
  // parse — an unrecognised currency sign, a reworded Quicken literal — and defaulting
  // it produces an account that imports cleanly at $0. Cost basis has a policy because
  // Quicken legitimately omits it; market value never is legitimately absent.
  if (lot.marketValue == null) {
    fail(
      `${accountName} / ${position.symbol ?? position.name}: lot ${index + 1} has no market value `
      + `(the Market Value column did not parse). Importing it would silently value the lot at $0.`);
  }
  const marketValue = round2(lot.marketValue ?? 0);

  let costBasis;
  if (lot.basisUnknown || lot.costBasis == null) {
    costBasis = policy === UNKNOWN_BASIS_POLICY.ZERO ? 0 : marketValue;
    warn(
      `${accountName} / ${position.symbol ?? position.name}: lot ${index + 1} has no cost basis `
      + `(Quicken "Add" placeholder) — using ${policy === UNKNOWN_BASIS_POLICY.ZERO ? '$0' : 'market value'}`
      + `, so its unrealized gain is fabricated. Fix the acquisition in Quicken.`);
  } else {
    costBasis = round2(lot.costBasis);
  }

  // Design 87 §11: a CASH lot has no capital gain, so its basis IS its value. The
  // Holding constructor enforces this anyway; emitting it correctly means the saved
  // file and the run agree, and a diff of the file is not misleading.
  if (allocation === ALLOCATION.CASH) costBasis = marketValue;

  const holding = {
    id: null,   // set below, once a bond's maturity (its only identity) is known
    allocation,
    marketValue,
    costBasis,
    // null is "carried in from scenario boot" — FIFO's oldest, always long-term. That is
    // exactly what a Quicken placeholder lot is claiming (it labels itself Long Term),
    // and it is the only honest answer when the acquisition date is genuinely unknown.
    purchaseDate: lot.purchaseDate,
    rateKey: spec.rateKey,
    label: lot.shares == null ? '' : `${position.symbol ?? position.name} × ${lot.shares}`,
    ...(spec.dividendYield != null ? { dividendYield: spec.dividendYield } : {}),
    ...(spec.taxExemption != null ? { taxExemption: spec.taxExemption } : {}),
    ...(spec.issuingState != null ? { issuingState: spec.issuingState } : {}),
    ...(spec.id != null ? { securityId: spec.id } : {}),
  };

  if (allocation === ALLOCATION.BOND) {
    // `promoteToUnitised` requires BOTH maturityDate and faceValue, and silently leaves
    // the lot scalar without them — a bond that never redeems and never pulls to par.
    // So a missing maturity is an error, not a warning.
    const parsed = parseBondName(position.name);
    const maturityDate = spec.maturityDate ?? parsed?.maturityDate ?? null;
    if (maturityDate == null) {
      fail(
        `${accountName} / ${position.name}: BOND lot has no maturity date. The name carries no `
        + `"DUE MM/DD/YY" clause and the mapping supplies no \`maturityDate\`. Without one the lot `
        + `stays scalar and never redeems.`);
    }
    // Quicken's bond share count IS a count of $100-par units — 200 units at 99.99
    // is $19,998 against $20,000 par — which is the same convention as PAR_PER_UNIT,
    // so face falls straight out of the count.
    const faceValue = lot.shares == null ? null : round2(lot.shares * PAR_PER_UNIT);
    if (faceValue == null) {
      fail(`${accountName} / ${position.name}: BOND lot has no share count, so no face value.`);
    }
    Object.assign(holding, {
      maturityDate,
      faceValue,
      zeroCoupon: spec.zeroCoupon ?? false,
      couponRate: spec.couponRate ?? null,
      ...(spec.duration != null ? { duration: spec.duration } : {}),
      ...(spec.rollAtMaturity != null ? { rollAtMaturity: spec.rollAtMaturity } : {}),
      ...(spec.inflationLinked != null ? { inflationLinked: spec.inflationLinked } : {}),
    });
  }

  holding.id = `${IMPORT_LOT_PREFIX}${slug(accountName)}-`
    + `${positionKey(position, spec, holding.maturityDate ?? null)}-${index + 1}`;
  return { holding, warnings, errors };
}

/**
 * Validate one mapping security spec against the closed enums it has to live inside.
 *
 * Done here rather than left to load, because `assertValidAllocation` /
 * `assertAllocationMatch` throw inside `new Holding(...)` — i.e. on a scenario that no
 * longer opens, with no mention of which line of the mapping file caused it.
 */
function validateSpec(key, spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') {
    return [`mapping.securities["${key}"] is not an object.`];
  }
  if (!Object.values(ALLOCATION).includes(spec.allocation)) {
    errors.push(`mapping.securities["${key}"].allocation must be one of `
      + `${Object.values(ALLOCATION).join(', ')} — got ${JSON.stringify(spec.allocation)}.`);
  }
  if (spec.rateKey == null) {
    errors.push(`mapping.securities["${key}"] needs a rateKey.`);
  } else if (!Object.values(RATE_KEYS).includes(spec.rateKey)) {
    errors.push(`mapping.securities["${key}"].rateKey "${spec.rateKey}" is not a known rate key.`);
  } else if (spec.allocation === ALLOCATION.GOLD) {
    if (spec.rateKey !== RATE_KEYS.GOLD) {
      errors.push(`mapping.securities["${key}"]: a GOLD allocation must use rateKey GOLD.`);
    }
  } else {
    const legal = CLASS_KEYS_BY_ALLOCATION[spec.allocation];
    if (legal && !legal.has(spec.rateKey)) {
      errors.push(`mapping.securities["${key}"]: rateKey "${spec.rateKey}" is not inside `
        + `ALLOCATION.${spec.allocation}'s class (${[...legal].join(', ')}). A position's allocation `
        + `is authoritative; a security may only refine within it.`);
    }
  }
  if (typeof spec.id === 'string' && spec.id.startsWith(SYNTHETIC_SECURITY_PREFIX)) {
    errors.push(`mapping.securities["${key}"].id uses the reserved "${SYNTHETIC_SECURITY_PREFIX}" `
      + `prefix, which names the engine's synthetic market securities.`);
  }
  return errors;
}

/**
 * Map a parsed Quicken portfolio onto scenario account patches and securities.
 *
 * @param {object} parsed  - from `parseQuickenPortfolio`
 * @param {object} mapping - `{ accounts: {…}, securities: {…}, unknownBasisPolicy? }`
 * @param {object} [opts]
 * @param {Array<object>} [opts.targetAccounts] - the scenario's existing account records,
 *   read (never mutated) for the basis fields Quicken cannot supply.
 * @returns {{ accounts: object[], securities: object[], asOf: string|null,
 *   warnings: Array<{stateKey:?string, message:string}>,
 *   errors:   Array<{stateKey:?string, message:string}>,
 *   contributionBasisPatches: Array<{stateKey:string, value:number}> }}
 */
export function buildImport(parsed, mapping, { targetAccounts = [] } = {}) {
  const warnings = [], errors = [];
  const warn = (stateKey, message) => warnings.push({ stateKey, message });
  const fail = (stateKey, message) => errors.push({ stateKey, message });
  const accountMap = mapping?.accounts ?? {};
  const securityMap = mapping?.securities ?? {};
  const policy = mapping?.unknownBasisPolicy ?? UNKNOWN_BASIS_POLICY.MARKET;

  if (!Object.values(UNKNOWN_BASIS_POLICY).includes(policy)) {
    fail(null, `mapping.unknownBasisPolicy must be one of `
      + `${Object.values(UNKNOWN_BASIS_POLICY).join(', ')} — got ${JSON.stringify(policy)}.`);
  }
  for (const [key, spec] of Object.entries(securityMap)) {
    for (const m of validateSpec(key, spec)) fail(null, m);
  }

  // The export carries no currency column: every figure in one file is in one currency,
  // and which one is only visible in the sign the money cells were printed with. Two
  // signs means the report already mixed them, and nothing downstream converts — the
  // balances would be summed as if they were the same money.
  if (parsed.currencySigns?.length > 1) {
    fail(null, `the export mixes currencies (${parsed.currencySigns.join(', ')}). Quicken prints `
      + `no currency column, so nothing here can tell which figure is which — export one `
      + `currency per file.`);
  }
  if (mapping?.currencySign && parsed.currencySigns?.length
      && !parsed.currencySigns.includes(mapping.currencySign)) {
    fail(null, `mapping.currencySign is "${mapping.currencySign}" but the export's money columns `
      + `are printed "${parsed.currencySigns.join(', ')}". One of the two is about a different file.`);
  }

  if (mapping?.asOf && parsed.asOf && mapping.asOf !== parsed.asOf) {
    fail(null, `mapping.asOf is ${mapping.asOf} but the CSV was taken ${parsed.asOf}. `
      + `Update the mapping, or you are importing a different snapshot than you think.`);
  }

  const byStateKey = new Map((targetAccounts ?? []).map(a => [a.stateKey, a]));
  const usedStateKeys = new Map();
  const securities = new Map();
  const accounts = [];
  const contributionBasisPatches = [];
  const usedSecurityKeys = new Set();

  for (const qa of parsed.accounts) {
    const entry = accountMap[qa.name];
    if (!entry) {
      fail(null, `Quicken account "${qa.name}" is not in mapping.accounts. Add it, or remove `
        + `the account from the export — an unmapped account is silently dropped otherwise.`);
      continue;
    }
    if (entry.skip === true) {
      warn(null, `Quicken account "${qa.name}" is mapped with skip:true — not imported.`);
      continue;
    }
    const stateKey = entry.stateKey;
    if (!stateKey) {
      fail(null, `mapping.accounts["${qa.name}"] has no stateKey.`);
      continue;
    }
    if (usedStateKeys.has(stateKey)) {
      fail(stateKey, `stateKey "${stateKey}" is mapped from both "${usedStateKeys.get(stateKey)}" `
        + `and "${qa.name}". Two Quicken accounts cannot be one scenario account — the second `
        + `would overwrite the first.`);
      continue;
    }
    usedStateKeys.set(stateKey, qa.name);

    const target = byStateKey.get(stateKey);
    if (targetAccounts.length > 0 && !target) {
      fail(stateKey, `mapping.accounts["${qa.name}"].stateKey "${stateKey}" matches no account in `
        + `the target scenario. Known keys: ${[...byStateKey.keys()].join(', ')}`);
      continue;
    }

    const holdings = [];

    // The cash sleeve first, so it reads first in the file and in the editor.
    if (qa.cash != null && qa.cash !== 0) {
      if (qa.cash < 0) {
        warn(stateKey, `${qa.name}: cash is NEGATIVE (${qa.cash}). In Quicken that is the plug a `
          + `placeholder entry leaves behind, not a real overdraft — this account is not fully set `
          + `up. Its balance and every derived figure are wrong until the acquisition is entered.`);
      }
      holdings.push({
        id: `${IMPORT_LOT_PREFIX}${slug(qa.name)}-cash`,
        allocation: ALLOCATION.CASH,
        marketValue: round2(qa.cash),
        costBasis: round2(qa.cash),
        purchaseDate: null,
        rateKey: entry.cashRateKey ?? RATE_KEYS.SAVINGS_US,
        label: 'Cash',
      });
    }

    for (const position of qa.positions) {
      const hit = resolveSecuritySpec(position, securityMap);
      if (!hit) {
        fail(stateKey, `${qa.name}: instrument "${position.name}"`
          + `${position.symbol ? ` (${position.symbol})` : ' (no symbol)'} resolves to no entry in `
          + `mapping.securities. Add one keyed by its symbol, its exact name, or a \`match\` regex.`);
        continue;
      }
      usedSecurityKeys.add(hit.key);
      const record = securityRecordFor(hit.spec, hit.key);
      if (record) {
        const prior = securities.get(record.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(record)) {
          fail(stateKey, `Two mapping entries mint different securities with id "${record.id}".`);
        }
        securities.set(record.id, record);
      }
      // A cost basis of exactly $0.00 against a real market value is not the same claim
      // as Quicken's "Add" placeholder — it parses as a number, so `unknownBasisPolicy`
      // never sees it and the whole position imports as gain.
      //
      // Reported ONLY on an account whose role actually reads a holding's `costBasis`,
      // because on a wrapper nothing does and the warning would be noise on the very
      // accounts where a broker most often reports no basis. A Roth's tax — US
      // §408A(d)(1) and AU s99B alike — is computed from the ACCOUNT ledgers
      // (`contributionBasis` / `earningsBasis` / `derivedIncomeBasis`), never from a
      // lot: its rebalances are gated `taxable &&` so they realize nothing, its
      // withdrawals `scaleHoldings` rather than dispose through `consumeHoldings`, and
      // the after-tax metric's `_unrealizedGainSplit` sits on the TAXABLE_BASIS branch
      // only. `taxClassForRole` is imported rather than re-listed so this cannot drift
      // from the map that decides it.
      const readsLotBasis = taxClassForRole(target?.role) === TAX_CLASS.TAXABLE_BASIS;
      if (readsLotBasis && position.costBasis === 0 && !position.basisUnknown
          && (position.marketValue ?? 0) > 0) {
        warn(stateKey, `${qa.name} / ${position.symbol ?? position.name}: cost basis is exactly `
          + `$0.00 against ${round2(position.marketValue)} of market value, so the position imports `
          + `as 100% unrealized gain — and this account's role (${target.role}) is one whose CGT is `
          + `computed from lot basis. Quicken states the $0.00 as a figure, not as its "Add" `
          + `placeholder, so the importer takes it literally. Enter the acquisition in Quicken.`);
      }

      if (position.lots.length === 0) {
        warn(stateKey, `${qa.name} / ${position.symbol ?? position.name}: no lot rows. Export WITH `
          + `lots, or this position's holding period and basis are lost.`);
        continue;
      }
      position.lots.forEach((lot, i) => {
        const r = lotToHolding({
          position, lot, spec: hit.spec, index: i, accountName: qa.name, stateKey, policy });
        warnings.push(...r.warnings);
        errors.push(...r.errors);
        holdings.push(r.holding);
      });
    }

    const balance = round2(holdings.reduce((s, h) => s + h.marketValue, 0));
    // Quicken rounds every row to the cent and then prints its own rounded total, so a
    // sum of N rows can sit up to N cents from it without anything being wrong. A row
    // that genuinely failed to map is worth dollars, so the tolerance scales with the
    // lot count rather than being widened to a flat figure that could hide one.
    const tieTolerance = 0.01 * holdings.length + 0.01;
    if (qa.marketValue != null && Math.abs(balance - qa.marketValue) > tieTolerance) {
      warn(stateKey, `${qa.name}: imported holdings sum to ${balance} but Quicken's account total `
        + `is ${qa.marketValue} (Δ ${round2(balance - qa.marketValue)}). Some rows did not map.`);
    }

    const patch = { stateKey, balance, holdings };

    // Wrapper accounts: keep contributionBasis + earningsBasis = balance, and carry
    // derivedIncomeBasis across at its existing SHARE of earnings rather than its
    // existing dollar amount — a dollar amount above the new earningsBasis would make
    // `_derivedShareOf` clamp to 1 and quietly reclassify the whole wrapper.
    const hasWrapperBasis = entry.contributionBasis != null || target?.contributionBasis != null;
    if (hasWrapperBasis) {
      const contributionBasis = round2(entry.contributionBasis ?? target.contributionBasis);
      const earningsBasis = round2(Math.max(0, balance - contributionBasis));
      const priorEarnings = target?.earningsBasis ?? 0;
      const derivedShare = priorEarnings > 0
        ? Math.min(1, Math.max(0, (target?.derivedIncomeBasis ?? 0) / priorEarnings))
        : 1;
      Object.assign(patch, {
        contributionBasis,
        earningsBasis,
        derivedIncomeBasis: round2(earningsBasis * derivedShare),
      });
      if (contributionBasis > balance) {
        warn(stateKey, `contributionBasis ${contributionBasis} exceeds the imported balance `
          + `${balance}, so earningsBasis floors at 0. Withdrawals will read as all-basis.`);
      }
      contributionBasisPatches.push({ stateKey, value: contributionBasis });
    }

    accounts.push(patch);
  }

  for (const key of Object.keys(securityMap)) {
    if (!usedSecurityKeys.has(key)) {
      warn(null, `mapping.securities["${key}"] matched no position in this export.`);
    }
  }

  // Build the registry the way the RUN builds it — synthetics first, then the authored
  // set — so a duplicate id or a reserved prefix is reported HERE and not at load, on a
  // scenario that no longer opens.
  const securityList = [...securities.values()];
  try {
    scenarioSecurityRegistry({ securities: securityList });
  } catch (e) {
    fail(null, `securities: ${e.message}`);
  }

  return { accounts, securities: securityList, warnings, errors, contributionBasisPatches, asOf: parsed.asOf };
}
