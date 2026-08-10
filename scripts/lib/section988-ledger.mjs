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
 * section988-ledger.mjs — design 87 G5. The lot ledger the ingest was built to feed.
 *
 * Consumes the classified history that `section988-source.mjs` validates and produces,
 * for each disposition, the USD gain or loss and where it lands on a US return. It is the
 * first thing in this pair that computes tax, and it is only meaningful once every ingest
 * gate is green — a path-dependent ledger absorbs an ingest error silently and carries it
 * forward forever.
 *
 * ─── two conventions, both left as parameters on purpose ────────────────────────────
 *
 * `§1.988-2(a)(2)(iii)(B)(1)` permits "any reasonable method that is consistently applied
 * from year to year by the taxpayer to **all accounts**", naming FIFO, LIFO and pro rata,
 * and barring only a method that systematically withdraws the highest basis first. Two
 * independent choices follow, and design 87 flags both as decisions to make BEFORE the
 * ledger is written:
 *
 *   `method`  — FIFO or pro-rata. Pro-rata is design 87 G6's incumbent because the engine
 *               already implements it as `fxBasisRate`; FIFO buys exactly one thing, a
 *               holding period, which the personal capital branch needs and a scalar
 *               cannot supply.
 *   `pooling` — per-account or commingled (design 87 G11). `(a)(1)(iii)(E)` makes a
 *               transfer carry "the adjusted basis of the units transferred", which is
 *               per-account; commingling is a simplification, defensible as a reasonable
 *               method but a recorded choice rather than something the reg hands you.
 *               Under per-account, INTERNAL rows do real work; under commingled they are
 *               no-ops.
 *
 * They are parameters rather than a decision baked in because the choice "is locked at
 * adoption and binds all future years, so the criterion is robustness across paths, not
 * the winner on the path that happened" (§5 G6). Running all four and reading the spread
 * is what turns that from a preference into a measurement.
 *
 * ─── where a disposition lands ──────────────────────────────────────────────────────
 *
 * `businessFraction` splits ONE disposition, per `§988(e)(3)`'s "to the extent":
 *
 *   business share — ordinary `§988` gain or loss. Losses deductible.
 *   personal share — NOT a §988 transaction at all. `§1.988-1(a)(9)` excludes personal
 *                    transactions from the definition, so what survives is a CAPITAL
 *                    gain, and `§988(e)(2)` excludes it from the whole subtitle when it
 *                    is \$200 or less **per transaction**. A personal LOSS is disallowed
 *                    outright — the \$200 floor is written for gain only, and personal-use
 *                    property gets no loss deduction.
 *
 * This mirrors `computeSection988Gain` in `loan-classes.js`, which does the same split for
 * foreign-currency DEBT. Kept as a separate implementation rather than shared because the
 * inputs genuinely differ — debt blends a booking rate, cash consumes lots — but the
 * asymmetry must stay identical, and a test pins them together.
 */

/*
 * ─── the audit trail ────────────────────────────────────────────────────────────────
 *
 * `runLedger({ audit: true })` additionally records, for every row that moves a pool, the
 * inputs it used and the pool state either side of it — see {@link toAuditCsv}. It is
 * off by default because it retains an object per row, and the four-way `compareConventions`
 * sweep has no use for them.
 */

import { KIND, BASIS, reconcileInternal } from './section988-source.mjs';

export const LEDGER_METHOD = { FIFO: 'fifo', PRO_RATA: 'pro-rata' };
export const POOLING = { PER_ACCOUNT: 'per-account', COMMINGLED: 'commingled' };

/** `§988(e)(2)`: personal gain of this much or less is excluded, per transaction. */
export const PERSONAL_DE_MINIMIS_USD = 200;

/** A capital gain is long-term above this, which only FIFO can ever know. */
const LONG_TERM_DAYS = 366;

const round2 = (n) => Math.round(n * 100) / 100;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * One pool of currency: units of AUD and the USD basis they carry.
 *
 * Pro-rata needs only the two totals — that is the whole method, and why design 87 calls
 * it stateless. FIFO additionally needs the lots, because a holding period is a fact
 * about *which* units left, which no aggregate can answer.
 */
class Pool {
  constructor(method) {
    this.method = method;
    this.units = 0;
    this.basis = 0;
    this.lots = [];
  }

  acquire(date, units, basis) {
    if (!(units > 0)) return;
    this.units += units;
    this.basis += basis;
    this.lots.push({ date, units, basis });
  }

  /**
   * Remove `units` and return the USD basis they carried, plus how long they were held.
   *
   * The `held` figure is units-weighted and is `null` under pro-rata — deliberately, and
   * not as a shortcut. Pro-rata cannot say which units left, so it cannot say how long
   * they were held; design 87 is careful that this is an inference from the method's
   * logic rather than a rule in the regulation. Returning a number here would invent a
   * holding period the method is not entitled to.
   */
  consume(date, units) {
    if (!(units > 0) || !(this.units > 0)) return { basis: 0, held: null, shortfall: units };
    const take = Math.min(units, this.units);
    const shortfall = units - take;

    if (this.method === LEDGER_METHOD.PRO_RATA) {
      const basis = this.basis * (take / this.units);
      this.units -= take;
      this.basis -= basis;
      if (this.units <= 1e-9) { this.units = 0; this.basis = 0; this.lots = []; }
      return { basis, held: null, shortfall };
    }

    let left = take;
    let basis = 0;
    let weightedDays = 0;
    while (left > 1e-9 && this.lots.length) {
      const lot = this.lots[0];
      const from = Math.min(left, lot.units);
      const lotBasis = lot.basis * (from / lot.units);
      basis += lotBasis;
      weightedDays += from * daysBetween(lot.date, date);
      lot.units -= from;
      lot.basis -= lotBasis;
      left -= from;
      if (lot.units <= 1e-9) this.lots.shift();
    }
    this.units -= take;
    this.basis -= basis;
    if (this.units <= 1e-9) { this.units = 0; this.basis = 0; this.lots = []; }
    return { basis, held: take > 0 ? weightedDays / take : null, shortfall };
  }
}

/**
 * Split one disposition's gain into where it actually lands on a return.
 *
 * @param gross  total USD gain (positive) or loss (negative) on the units disposed of
 * @param frac   business share, 0..1
 * @param held   units-weighted days held, or null when the method cannot say
 */
export function allocateGain(gross, frac, held) {
  const f = Math.min(1, Math.max(0, frac ?? 0));
  const business = gross * f;
  const personal = gross * (1 - f);

  // `+ 0` normalises -0, which `gross * 0` produces for a negative gross and which then
  // leaks into JSON as "-0".
  const out = {
    ordinary: business + 0,
    capitalGain: 0,
    deMinimisExcluded: 0,
    disallowedPersonalLoss: 0,
    longTerm: held == null ? null : held >= LONG_TERM_DAYS,
  };

  if (personal >= 0) {
    // §988(e)(2) excludes the personal gain from the whole subtitle at or below \$200.
    if (personal <= PERSONAL_DE_MINIMIS_USD) out.deMinimisExcluded = personal;
    else out.capitalGain = personal;
  } else {
    // Personal loss: disallowed outright. The \$200 floor is written for gain only.
    out.disallowedPersonalLoss = -personal;
  }
  return out;
}

/**
 * Which of the four buckets the PERSONAL share of one disposition landed in.
 *
 * Derivable from the four money columns, but only by a reader who already knows the
 * asymmetry — that a personal gain vanishes under \$200 while a personal LOSS is
 * disallowed at any size. Naming it makes the CSV filterable on the distinction that
 * costs the most money and is the easiest to misread as symmetric.
 */
function personalBranchOf(alloc, businessFraction) {
  if (businessFraction >= 1) return 'none (all business)';
  if (alloc.disallowedPersonalLoss > 0) return 'disallowed personal loss';
  if (alloc.capitalGain > 0) return 'capital gain';
  // No commas in any of these labels: this file gets read with cut and awk as often as
  // with a spreadsheet, and a quoted field breaks both of those.
  if (alloc.deMinimisExcluded > 0) return `excluded under the $${PERSONAL_DE_MINIMIS_USD} floor`;
  return 'none (zero personal share)';
}

/**
 * Run the ledger over classified, rate-attached rows.
 *
 * Rows must already carry `rate` from `attachRates` and be sorted chronologically. A row
 * whose rate never resolved is NOT computed and NOT silently zeroed — it is returned in
 * `skipped`, because a disposition with no exchange rate has no gain that anyone can
 * know, and treating it as zero would understate the year by exactly its size.
 */
export function runLedger(classified, options = {}) {
  const method = options.method ?? LEDGER_METHOD.PRO_RATA;
  const pooling = options.pooling ?? POOLING.PER_ACCOUNT;
  if (!Object.values(LEDGER_METHOD).includes(method)) throw new Error(`unknown method ${method}`);
  if (!Object.values(POOLING).includes(pooling)) throw new Error(`unknown pooling ${pooling}`);

  // Sensitivity knob. Replaces the basis rate on rows marked ASSUMED and on nothing else:
  // an observed acquisition is a measurement, and re-pricing it would make the sweep
  // measure the export rather than the assumption. It also overrides a per-row BasisDate
  // or BasisRate, because the question being asked is what the seeded basis is worth AS A
  // WHOLE — a sweep that honoured some rows and moved others would answer neither.
  const seedRate = options.seedRate ?? null;

  const pools = new Map();
  const poolKeyFor = (account) => (pooling === POOLING.COMMINGLED ? '*' : (account ?? ''));
  const poolFor = (account) => {
    const key = poolKeyFor(account);
    if (!pools.has(key)) pools.set(key, new Pool(method));
    return pools.get(key);
  };

  // ── audit trail (opt-in; see toAuditCsv) ────────────────────────────────────────
  const audit = options.audit ? [] : null;
  const before = (pool) => ({ units: pool.units, basis: pool.basis, lots: pool.lots.length });
  const record = (row, pool, snap, fields) => {
    if (!audit) return;
    audit.push({
      step: audit.length,
      date: row.date ?? null,
      taxYear: row.date ? row.date.slice(0, 4) : '',
      account: row.account ?? '',
      pool: pool ? poolKeyFor(row.account) : '',
      kind: row.kind ?? '',
      basisSource: row.basisSource ?? BASIS.OBSERVED,
      classifiedBy: row.via ?? '',
      description: row.description ?? '',
      sourceLine: row.sourceLine ?? '',
      amount: row.amount ?? 0,
      balance: row.balance ?? null,
      // The rate's own date is NOT always the row's: `resolve` carries the last published
      // observation across a weekend or holiday. Which one was used is the first thing a
      // reviewer asks and the last thing any total remembers.
      rateDate: row.rate?.quotedDate ?? null,
      rateCarriedFrom: row.rate?.carriedFrom ?? null,
      spotRate: row.rate?.usdPerAud ?? null,
      basisRate: null,
      unitsPriced: null,
      unitsUnpriced: null,
      usdBasisIn: null,
      usdBasisOut: null,
      proceeds: null,
      gross: null,
      businessFraction: null,
      businessGross: null,
      personalGross: null,
      ordinary: null,
      capitalGain: null,
      deMinimisExcluded: null,
      disallowedPersonalLoss: null,
      recognised: null,
      personalBranch: '',
      heldDays: null,
      longTerm: null,
      ...fields,
      poolUnitsBefore: snap ? snap.units : null,
      poolBasisBefore: snap ? snap.basis : null,
      poolUnitsAfter: pool ? pool.units : null,
      poolBasisAfter: pool ? pool.basis : null,
      // FIFO only. Pro-rata still APPENDS lots — it just never consumes them, because it
      // works off the two aggregates — so under pro-rata this counts acquisitions since
      // the pool last emptied and is not a lot count at all. Emitting it anyway would
      // put a number in a column whose header is a lie.
      poolLotsAfter: pool && method === LEDGER_METHOD.FIFO ? pool.lots.length : null,
    });
  };

  // Under per-account pooling an INTERNAL pair MOVES basis, so the two legs have to know
  // about each other. Match them once up front; the debit computes the basis leaving and
  // the credit receives exactly that, which is `(a)(1)(iii)(E)`'s carryover.
  const carry = new Map();          // debit row -> credit row
  const carried = new Map();        // credit row -> basis handed to it
  // Settled debits are tracked in a Set OWNED BY THIS RUN, never as a flag on the row.
  // `compareConventions` walks the same row objects four times, so a marker left on a row
  // makes every later run skip work the first one did — the comparison then measures the
  // contamination rather than the conventions.
  const settled = new Set();
  if (pooling === POOLING.PER_ACCOUNT) {
    for (const { credit, debit } of reconcileInternal(classified).matched) carry.set(debit, credit);
  }

  const dispositions = [];
  const skipped = [];
  const seeded = [];
  const shortfalls = [];

  const rateOf = (row) => row.rate?.usdPerAud ?? null;

  const settleInternalDebit = (row) => {
    const pool = poolFor(row.account);
    const snap = before(pool);
    const units = Math.abs(row.amount);
    const { basis, shortfall } = pool.consume(row.date, units);
    if (shortfall > 0.005) shortfalls.push({ row, shortfall });
    const partner = carry.get(row);
    if (partner) carried.set(partner, basis);
    settled.add(row);
    record(row, pool, snap, {
      unitsPriced: units - shortfall,
      unitsUnpriced: shortfall,
      usdBasisOut: basis,
      basisRate: units - shortfall > 0 ? basis / (units - shortfall) : null,
      note: partner
        ? 'non-recognition: basis leaves with the units, §1.988-2(a)(1)(iii)(E)'
        : 'non-recognition, but no partner credit was found — basis leaves the visible pool',
    });
  };

  for (const row of classified) {
    if (!row.kind || row.kind === KIND.IGNORE || !row.amount) {
      if (options.auditIgnored) {
        record(row, null, null, {
          note: !row.kind ? 'UNCLASSIFIED — no ledger effect, and nothing below counts it'
            : (!row.amount ? 'zero amount' : 'IGNORE'),
        });
      }
      continue;
    }

    if (row.kind === KIND.INTERNAL) {
      if (pooling === POOLING.COMMINGLED) continue;    // one pool: a transfer is a no-op
      if (row.amount < 0) { if (!settled.has(row)) settleInternalDebit(row); continue; }

      // A credit whose partner debit has not been walked yet (same-date pairs can arrive
      // either way round) settles the debit now, so basis never arrives before it leaves.
      if (!carried.has(row)) {
        const debit = [...carry.entries()].find(([, c]) => c === row)?.[0];
        if (debit && !settled.has(debit)) settleInternalDebit(debit);
      }
      const basis = carried.get(row) ?? 0;
      if (carried.has(row)) {
        const pool = poolFor(row.account);
        const snap = before(pool);
        pool.acquire(row.date, row.amount, basis);
        record(row, pool, snap, {
          unitsPriced: row.amount,
          usdBasisIn: basis,
          // The carried rate, NOT the day's spot. Both columns are emitted precisely so
          // the difference is visible: a transfer does not re-mark currency to market.
          basisRate: row.amount > 0 ? basis / row.amount : null,
          note: 'non-recognition: carryover basis from the matched debit',
        });
      } else {
        // No partner anywhere: currency of unknown basis. The ingest's GATE 4 exists to
        // drive this to zero, and seeding it as an ACQUIRE is the documented remedy —
        // so reaching here means the gate was ignored rather than answered.
        shortfalls.push({ row, shortfall: 0, unknownBasis: true });
        record(row, null, null, {
          note: 'UNKNOWN BASIS: no partner debit. Currency entered the pool carrying nothing',
        });
      }
      continue;
    }

    const rate = rateOf(row);
    if (rate == null) {
      skipped.push(row);
      record(row, null, null, {
        unitsPriced: 0,
        unitsUnpriced: Math.abs(row.amount),
        note: 'NO PUBLISHED RATE — excluded from every total below, not zeroed',
      });
      continue;
    }

    if (row.kind === KIND.ACQUIRE) {
      // An acquisition's two rates are normally the same one. They come apart exactly when
      // an assumed row states its own basis — the currency APPEARED at `rate` but was
      // acquired at `basisRate`, which is the whole reason the two columns exist.
      const isAssumed = row.basisSource === BASIS.ASSUMED;
      const swept = isAssumed && seedRate != null;
      const acquiredAt = swept ? seedRate : (row.basisRate?.usdPerAud ?? rate);
      const basis = row.amount * acquiredAt;
      const pool = poolFor(row.account);
      const snap = before(pool);
      pool.acquire(row.date, row.amount, basis);
      if (isAssumed) seeded.push({ row, basis });
      record(row, pool, snap, {
        unitsPriced: row.amount,
        usdBasisIn: basis,
        basisRate: acquiredAt,
        note: isAssumed
          ? `SEEDED: basis ASSUMED, from ${swept ? 'a seed-rate sweep' : (row.basisFrom ?? 'row-date')}`
          : '',
      });
      continue;
    }

    // DISPOSE
    const units = Math.abs(row.amount);
    const pool = poolFor(row.account);
    const snap = before(pool);
    const { basis, held, shortfall } = pool.consume(row.date, units);
    if (shortfall > 0.005) {
      // Two very different causes, and conflating them would send you hunting for an
      // export that is not missing. If the row's own balance went NEGATIVE the account
      // was overdrawn: you were not holding currency at all, you owed it, and a
      // nonfunctional-currency liability belongs to the DEBT regime (design 86 G7 /
      // `loan-classes.js`), not to a cash lot pool. Anything else means acquisitions
      // really are absent from the history.
      shortfalls.push({ row, shortfall, cause: row.balance < 0 ? 'overdraft' : 'missing-history' });
    }

    const priced = units - shortfall;
    const proceeds = priced * rate;
    const gross = proceeds - basis;
    const alloc = allocateGain(gross, row.businessFraction, held);
    dispositions.push({
      date: row.date,
      taxYear: row.date.slice(0, 4),
      account: row.account,
      description: row.description,
      aud: units,
      usdPerAud: rate,
      basis,
      proceeds,
      gross,
      heldDays: held,
      businessFraction: row.businessFraction ?? 0,
      ...alloc,
    });

    const f = Math.min(1, Math.max(0, row.businessFraction ?? 0));
    record(row, pool, snap, {
      unitsPriced: priced,
      unitsUnpriced: shortfall,
      // THE TWO RATES. `spotRate` is the published rate for the disposal date and prices
      // the proceeds; `basisRate` is what the units that left were carrying, which is the
      // pool's weighted average under pro-rata and the consumed lots' own rate under FIFO.
      // The whole gain is `unitsPriced × (spotRate − basisRate)`, and that identity is
      // the point of emitting both.
      basisRate: priced > 0 ? basis / priced : null,
      usdBasisOut: basis,
      proceeds,
      gross,
      businessFraction: f,
      businessGross: gross * f,
      personalGross: gross * (1 - f),
      ordinary: alloc.ordinary,
      capitalGain: alloc.capitalGain,
      deMinimisExcluded: alloc.deMinimisExcluded,
      disallowedPersonalLoss: alloc.disallowedPersonalLoss,
      recognised: alloc.ordinary + alloc.capitalGain,
      personalBranch: personalBranchOf(alloc, f),
      heldDays: held,
      longTerm: alloc.longTerm,
      note: shortfall > 0.005
        ? `${row.balance < 0 ? 'OVERDRAWN' : 'MISSING HISTORY'}: ${round2(shortfall)} AUD had no basis in the pool`
        : '',
    });
  }

  return {
    method,
    pooling,
    dispositions,
    audit,
    byYear: summariseByYear(dispositions),
    residual: [...pools.entries()].map(([key, p]) => ({
      pool: key, units: round2(p.units), basis: round2(p.basis), lots: p.lots.length,
    })),
    seededBasisUsd: round2(seeded.reduce((s, e) => s + e.basis, 0)),
    skipped,
    shortfalls,
  };
}

/** Per US tax year, in the shape a return actually asks for. */
export function summariseByYear(dispositions) {
  const years = new Map();
  for (const d of dispositions) {
    if (!years.has(d.taxYear)) {
      years.set(d.taxYear, {
        year: d.taxYear, disposals: 0, aud: 0,
        ordinary: 0, capitalGain: 0, capitalLongTerm: 0, capitalShortTerm: 0,
        deMinimisExcluded: 0, disallowedPersonalLoss: 0,
      });
    }
    const y = years.get(d.taxYear);
    y.disposals++;
    y.aud += d.aud;
    y.ordinary += d.ordinary;
    y.capitalGain += d.capitalGain;
    y.deMinimisExcluded += d.deMinimisExcluded;
    y.disallowedPersonalLoss += d.disallowedPersonalLoss;
    if (d.capitalGain > 0 && d.longTerm != null) {
      if (d.longTerm) y.capitalLongTerm += d.capitalGain; else y.capitalShortTerm += d.capitalGain;
    }
  }
  return [...years.values()]
    .sort((a, b) => a.year.localeCompare(b.year))
    .map((y) => ({
      ...y,
      aud: round2(y.aud),
      ordinary: round2(y.ordinary),
      capitalGain: round2(y.capitalGain),
      capitalLongTerm: round2(y.capitalLongTerm),
      capitalShortTerm: round2(y.capitalShortTerm),
      deMinimisExcluded: round2(y.deMinimisExcluded),
      disallowedPersonalLoss: round2(y.disallowedPersonalLoss),
    }));
}

/**
 * What is the seeded-basis assumption actually worth?
 *
 * Re-runs the whole ledger at each candidate rate for the ASSUMED rows and reports all
 * five columns, never just the recognised total. That is the point rather than a detail:
 * where the position is already at a loss, pushing basis UP makes the loss bigger, and the
 * personal share of a §988 loss is disallowed outright. So a sweep reported as one number
 * shows a large, steadily improving figure while most of the movement is landing in
 * `disallowed` — value that does not exist. The five columns show where it went.
 *
 * `null` as a candidate means "leave every row alone", giving the sweep its own baseline
 * computed the same way as every other line rather than quoted from elsewhere.
 */
export function sweepSeedRate(classified, rates, options = {}) {
  return rates.map((seedRate) => {
    const r = runLedger(classified, { ...options, seedRate, audit: false });
    const t = (k) => round2(r.dispositions.reduce((s, d) => s + d[k], 0));
    const ordinary = t('ordinary');
    const capitalGain = t('capitalGain');
    return {
      seedRate,
      seededBasisUsd: r.seededBasisUsd,
      ordinary,
      capitalGain,
      deMinimisExcluded: t('deMinimisExcluded'),
      disallowedPersonalLoss: t('disallowedPersonalLoss'),
      recognised: round2(ordinary + capitalGain),
    };
  });
}

/* ──────────────────────────────── the audit trail ──────────────────────────────── */

const rateOrNull = (basis, units) => (units > 0.005 ? basis / units : null);

/**
 * Columns of the audit CSV: `[header, value, decimals]`.
 *
 * Money is written to 4 decimals rather than 2 on purpose. The sheet's whole value is
 * that its identities close, and rounding to cents ahead of the check manufactures a
 * penny of residual on most rows — which then has to be distinguished from a real break
 * by eye, on 766 rows. Round for reading, never for checking.
 */
const AUDIT_COLUMNS = [
  ['Step', (a) => a.step, null],
  ['Date', (a) => a.date, null],
  ['TaxYear', (a) => a.taxYear, null],
  ['Account', (a) => a.account, null],
  ['Pool', (a) => a.pool, null],
  ['Kind', (a) => a.kind, null],
  ['BasisSource', (a) => a.basisSource, null],
  ['ClassifiedBy', (a) => a.classifiedBy, null],
  ['SourceLine', (a) => a.sourceLine, null],

  // ── what moved ────────────────────────────────────────────────────────────────
  ['Amount_AUD', (a) => a.amount, 2],
  ['Balance_AUD', (a) => a.balance, 2],
  ['UnitsPriced_AUD', (a) => a.unitsPriced, 2],
  ['UnitsUnpriced_AUD', (a) => a.unitsUnpriced, 2],

  // ── the rates. An ACQUIRE has one; a DISPOSE genuinely has two ────────────────
  ['RateDate', (a) => a.rateDate, null],
  ['RateCarriedFrom', (a) => a.rateCarriedFrom, null],
  ['SpotRate_USDperAUD', (a) => a.spotRate, 6],
  ['BasisRate_USDperAUD', (a) => a.basisRate, 6],
  ['RateDelta', (a) => (a.spotRate != null && a.basisRate != null ? a.spotRate - a.basisRate : null), 6],

  // ── USD ───────────────────────────────────────────────────────────────────────
  ['BasisIn_USD', (a) => a.usdBasisIn, 4],
  ['BasisOut_USD', (a) => a.usdBasisOut, 4],
  ['Proceeds_USD', (a) => a.proceeds, 4],
  ['Gross_USD', (a) => a.gross, 4],

  // ── the split, i.e. the five columns the by-year table totals ─────────────────
  ['BusinessFraction', (a) => a.businessFraction, 4],
  ['BusinessGross_USD', (a) => a.businessGross, 4],
  ['PersonalGross_USD', (a) => a.personalGross, 4],
  ['Ordinary_USD', (a) => a.ordinary, 4],
  ['Capital_USD', (a) => a.capitalGain, 4],
  ['Excluded_USD', (a) => a.deMinimisExcluded, 4],
  ['Disallowed_USD', (a) => a.disallowedPersonalLoss, 4],
  ['Recognised_USD', (a) => a.recognised, 4],
  ['PersonalBranch', (a) => a.personalBranch, null],
  ['HeldDays', (a) => a.heldDays, 1],
  ['LongTerm', (a) => (a.longTerm == null ? '' : String(a.longTerm)), null],

  // ── pool state either side. This is what makes the sheet reconstructable ──────
  ['PoolUnitsBefore_AUD', (a) => a.poolUnitsBefore, 2],
  ['PoolBasisBefore_USD', (a) => a.poolBasisBefore, 4],
  ['PoolRateBefore', (a) => rateOrNull(a.poolBasisBefore, a.poolUnitsBefore), 6],
  ['PoolUnitsAfter_AUD', (a) => a.poolUnitsAfter, 2],
  ['PoolBasisAfter_USD', (a) => a.poolBasisAfter, 4],
  ['PoolRateAfter', (a) => rateOrNull(a.poolBasisAfter, a.poolUnitsAfter), 6],
  ['PoolLotsAfter', (a) => a.poolLotsAfter, null],

  // ── the three identities, each written as a residual that must be zero ────────
  ['Check_GrossFromRates', (a) => auditChecks(a).gross, 4],
  ['Check_SplitFoots', (a) => auditChecks(a).split, 4],
  ['Check_PoolBasisFoots', (a) => auditChecks(a).pool, 4],

  ['Description', (a) => a.description, null],
  ['Note', (a) => a.note ?? '', null],
];

/**
 * The three residuals, each of which is zero when the row is arithmetically sound.
 *
 * They are emitted as COLUMNS rather than asserted in code because the question this CSV
 * answers is "convince me", and a check the reader can re-derive in the sheet from the
 * inputs beside it is worth more than one the tool promises it already ran.
 *
 *   gross — the whole §988 calculation in one line: units × (disposal rate − basis rate).
 *   split — the four buckets must reassemble the gross. Note the SIGN: a disallowed
 *           personal loss is stored positive, so it subtracts.
 *   pool  — basis is conserved. Nothing enters or leaves a pool unrecorded.
 */
export function auditChecks(a) {
  const gross = (a.gross == null || a.spotRate == null || a.basisRate == null)
    ? null
    : a.gross - a.unitsPriced * (a.spotRate - a.basisRate);
  const split = a.gross == null
    ? null
    : (a.ordinary + a.capitalGain + a.deMinimisExcluded - a.disallowedPersonalLoss) - a.gross;
  const pool = a.poolBasisBefore == null
    ? null
    : a.poolBasisAfter - (a.poolBasisBefore + (a.usdBasisIn ?? 0) - (a.usdBasisOut ?? 0));
  return { gross, split, pool };
}

/**
 * Render `runLedger({ audit: true }).audit` as a CSV.
 *
 * One line per row that touched a pool, in LEDGER order rather than file order — the two
 * differ where an internal transfer's credit is walked before its debit, and ledger order
 * is the one in which the pool columns make sense.
 *
 * `Description` and `Note` are LAST because they are the only two fields that can contain
 * a comma — bank narrations always do. Every column before them is quote-free, so the
 * numeric part of the sheet survives `cut -d,` and `awk -F,` as well as a spreadsheet.
 */
export function toAuditCsv(audit) {
  const esc = (s) => {
    const v = String(s ?? '');
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const cell = (value, dp) => {
    if (value == null) return '';
    if (typeof value !== 'number') return esc(value);
    if (!Number.isFinite(value)) return '';
    return dp == null ? String(value) : (Math.abs(value) < 5e-11 ? 0 : value).toFixed(dp);
  };
  const lines = [AUDIT_COLUMNS.map(([h]) => h).join(',')];
  for (const a of audit) lines.push(AUDIT_COLUMNS.map(([, get, dp]) => cell(get(a), dp)).join(','));
  return `﻿${lines.join('\n')}\n`;
}

/**
 * Does the audit CSV foot to the report it was produced beside?
 *
 * The failure this exists to catch is a trail that is *plausible but not the calculation*
 * — a column added to the recorder and not to the ledger, or vice versa. A per-row sheet
 * that quietly disagrees with the totals it is meant to explain is worse than no sheet,
 * because it will be believed.
 *
 * @returns {{ breaks: object[], rowChecks: object, totals: object[] }}
 */
export function footAudit(result, tolerance = 0.005) {
  const audit = result.audit ?? [];
  const priced = audit.filter((a) => a.gross != null);
  const sum = (rows, k) => rows.reduce((s, a) => s + (a[k] ?? 0), 0);
  // Footed against `dispositions`, NOT `byYear`. byYear rounds each year to cents, so
  // summing it back up drifts by up to half a cent per year — over a decade that alone
  // trips a 0.005 tolerance and reports a break in a trail that is exactly right.
  const led = result.dispositions;

  const totals = [
    ['dispositions', priced.length, led.length],
    ['AUD out', priced.reduce((s, a) => s + Math.abs(a.amount), 0), sum(led, 'aud')],
    ['ordinary', sum(priced, 'ordinary'), sum(led, 'ordinary')],
    ['capital', sum(priced, 'capitalGain'), sum(led, 'capitalGain')],
    ['excluded', sum(priced, 'deMinimisExcluded'), sum(led, 'deMinimisExcluded')],
    ['disallowed', sum(priced, 'disallowedPersonalLoss'), sum(led, 'disallowedPersonalLoss')],
  ].map(([label, csv, report]) => ({ label, csv, report, gap: csv - report }));

  // The last entry touching each pool must leave it where the run says it ended.
  const lastByPool = new Map();
  for (const a of audit) if (a.poolBasisAfter != null) lastByPool.set(a.pool, a);
  for (const p of result.residual) {
    const last = lastByPool.get(p.pool);
    totals.push({
      label: `pool ${p.pool} basis`,
      csv: last ? last.poolBasisAfter : 0,
      report: p.basis,
      gap: (last ? last.poolBasisAfter : 0) - p.basis,
    });
  }

  const rowChecks = { gross: 0, split: 0, pool: 0 };
  for (const a of audit) {
    const c = auditChecks(a);
    for (const k of Object.keys(rowChecks)) if (c[k] != null && Math.abs(c[k]) > tolerance) rowChecks[k]++;
  }

  return { totals, breaks: totals.filter((t) => Math.abs(t.gap) > tolerance), rowChecks };
}

/**
 * Run every combination of the two conventions.
 *
 * The point is the SPREAD. Design 87 G6 says the criterion is "robustness across paths,
 * not the winner on the path that happened", and G11 says the pooling choice must be made
 * before the ledger is written. Neither can be argued from first principles on this data;
 * both can be measured in one pass, and a narrow spread is itself the answer — it means
 * the cheaper convention costs nothing.
 */
export function compareConventions(classified) {
  const runs = [];
  for (const pooling of Object.values(POOLING)) {
    for (const method of Object.values(LEDGER_METHOD)) {
      runs.push(runLedger(classified, { method, pooling }));
    }
  }
  const total = (r) => r.byYear.reduce((s, y) => s + y.ordinary + y.capitalGain, 0);
  const totals = runs.map(total);
  return {
    runs: runs.map((r, i) => ({
      method: r.method, pooling: r.pooling,
      ordinary: round2(r.byYear.reduce((s, y) => s + y.ordinary, 0)),
      capitalGain: round2(r.byYear.reduce((s, y) => s + y.capitalGain, 0)),
      deMinimisExcluded: round2(r.byYear.reduce((s, y) => s + y.deMinimisExcluded, 0)),
      disallowedPersonalLoss: round2(r.byYear.reduce((s, y) => s + y.disallowedPersonalLoss, 0)),
      recognised: round2(totals[i]),
    })),
    spread: round2(Math.max(...totals) - Math.min(...totals)),
  };
}
