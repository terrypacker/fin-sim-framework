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
 * currency-lot-observer.js — design 87 phase 3, G5/G8/G11.
 *
 * Maintains a §988 basis lot ledger on every foreign-currency cash pool by watching what
 * each reducer did to the balances, rather than by being called from each of the ~20
 * places that move them.
 *
 * ─── the split this file is built around ────────────────────────────────────────────
 *
 * **This observer owns MECHANICS. Callers declare CHARACTER.**
 *
 * Mechanics — how many units are in the pool and what USD basis they carry — is a fact
 * about the balance, and the balance is observable. Character — whether a debit is a
 * *disposition* under `§1.988-2(a)(1)(iii)`, and what share of it is §162/§212 business
 * use under `§988(e)(3)` — is a fact about *what the money bought*, which a balance delta
 * cannot possibly reveal and only the caller knows.
 *
 * Splitting them this way is what makes the ledger safe to land before any emitter is
 * wired. Mechanics cannot be forgotten, because a new credit path cannot hide from a
 * balance comparison. Character is opt-in, one action at a time.
 *
 * ─── the declaration ────────────────────────────────────────────────────────────────
 *
 * A reducer's action may carry `section988`, using the same three axes the historical
 * ingest tool uses (`scripts/lib/section988-source.mjs`), so a movement is described
 * identically whether it is being projected or reconstructed:
 *
 *     action.section988 = {
 *       kind: 'DISPOSE' | 'INTERNAL' | 'IGNORE',
 *       businessFraction: 0..1,          // §988(e)(3), per DISPOSITION — design 87 G12
 *     }
 *
 * It must be declared in the toolset's `fields` map or `pickPayload` drops it and the
 * observer sees `undefined` — design 87 §7 trap 1, and the failure mode recorded in
 * [[payload-manifest-gate-unwired]].
 *
 * ─── the defaults, and why they lean the way they do ────────────────────────────────
 *
 * | observed              | declared      | ledger does                                   |
 * |-----------------------|---------------|-----------------------------------------------|
 * | balance UP            | (none)        | acquire a lot at today's spot                 |
 * | balance UP and DOWN   | (none)        | same-currency transfer: basis CARRIES OVER    |
 * | balance DOWN          | (none)        | consume lots, carry basis out, realize NOTHING |
 * | balance DOWN          | `DISPOSE`     | consume lots and emit SECTION_988_GAIN        |
 * | either                | `IGNORE`      | rescale the pool, holding basis:units          |
 *
 * The third row is load-bearing. `§1.988-2(a)(1)(iii)(C)` puts a bare withdrawal on the
 * **non-recognition** list, so realizing on every debit would be wrong — and it is the
 * specific error design 87 §1a was written to correct, which the phase-3 sketch would
 * otherwise have inherited. An undeclared debit therefore **understates** §988 rather
 * than inventing it, matching every other default in this design.
 *
 * The second row is `§1.988-2(a)(1)(iii)(E)` (design 87 G11) and needs no declaration:
 * if one pool of a currency falls while another rises in the same transition, that IS a
 * same-currency transfer, and basis follows the units instead of being re-marked to
 * market. Inferring it from the shape of the movement rather than from a flag means a
 * transfer path nobody remembered to annotate still gets the carryover right.
 */

import { accountCurrencyCode, currencyPoolBusinessFraction } from './currency-basis.js';
import { section988Residence } from './loan-classes.js';
import { CurrencyLotPool, LEDGER_METHOD, allocateGain } from './currency-lots.js';
import { ALLOCATION } from '../holdings/allocation.js';

const EPS = 1e-6;

/** Strict mode re-uses the existing env convention rather than inventing a second one. */
const STRICT = typeof process !== 'undefined' && process.env?.JOURNAL_STRICT === 'on';

/**
 * Is this state entry a currency **lot pool** — i.e. a bank deposit in nonfunctional
 * currency?
 *
 * Deliberately NARROWER than `isForeignCurrencyPool`, which keys on currency alone and so
 * also catches an AU brokerage and an AU bond ladder. Those are not §988 currency:
 * design 87 §5's table maps the `ALLOCATION` enum onto `§988(c)(1)(B)`'s closed list, and
 * only CASH *is* nonfunctional currency. A BOND is a debt instrument tracked per-holding
 * by G9; EQUITY and GOLD are on none of the clauses and carry their FX movement inside
 * their §1001 capital gain. Applying an account-level pool to a brokerage would silently
 * claim the equity sleeves too, double-counting the movement AND recharacterising capital
 * gain as ordinary income.
 */
export function isCurrencyLotPool(account) {
  if (!account || typeof account !== 'object') return false;
  if (account.type === 'super' || account.type === 'loan' || account.kind === 'real-property') return false;
  if (!('balance' in account)) return false;
  const ccy = accountCurrencyCode(account);
  if (ccy == null || ccy === 'USD') return false;
  // A pure deposit has no sleeves; a deposit modelled with a cash sleeve is still a
  // deposit. Anything holding a non-CASH sleeve is an investment account.
  const holdings = account.holdings;
  if (Array.isArray(holdings) && holdings.length > 0) {
    return holdings.every(h => h?.allocation === ALLOCATION.CASH);
  }
  return true;
}

/** Foreign units per USD for `ccy`, matching `effectiveExchangeRates.USD_AUD`. */
function spotFor(state, ccy) {
  const rate = state?.effectiveExchangeRates?.[`USD_${ccy}`];
  return rate > 0 ? rate : null;
}

/** USD basis of `units` acquired at `rate` foreign-units-per-USD. */
const usdOf = (units, rate) => units / rate;

/**
 * Build the observer.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.method] LEDGER_METHOD.PRO_RATA or FIFO — design 87 G6. An
 *        EXPLICIT OVERRIDE for tests and probes. Normally omitted: the convention is read
 *        from `state.fxBasisMethod` per call, see {@link methodFor}. Pro-rata is the
 *        incumbent because it is exactly what `fxBasisRate` already implements, so
 *        defaulting to it keeps the golden movement from G8/G11 separable from a method
 *        change.
 */
export function createCurrencyLotObserver({ method: override = null } = {}) {
  /**
   * The convention IN FORCE, read from state on every call rather than captured once.
   *
   * This must be lazy, and the reason is a wiring order that made it silently inert on the
   * first attempt: `BaseScenario` constructs the observer inside `buildSim()`, but a
   * toolset's `state()` patches — where `fxBasisMethod` comes from — are not applied until
   * `ScenarioLoader.load()` runs afterwards. An observer that read the field at
   * construction saw `undefined` every time and quietly ran pro-rata no matter what the
   * scenario elected, with the only symptom being that FIFO's `fxLots` never appeared.
   *
   * Reading per call is also the correct behaviour under `restoreSnapshot` / `rewind`,
   * which replace state wholesale — the same argument that keeps the pools themselves out
   * of this closure (design 87 §14.1: state is authoritative).
   *
   * An unrecognised value falls back to the incumbent rather than throwing, because it
   * arrives from state: an old save, or a hand-edited scenario JSON, must still run.
   */
  const methodFor = (state) => {
    const m = override ?? state?.fxBasisMethod ?? LEDGER_METHOD.PRO_RATA;
    return Object.values(LEDGER_METHOD).includes(m) ? m : LEDGER_METHOD.PRO_RATA;
  };
  /**
   * Cached list of pooled state keys.
   *
   * Re-deriving this per reducer would mean an `Object.entries(state)` scan order 10^5
   * times over a run — the quadratic shape [[sim-perf-telemetry-dominates]] records. It is
   * built once and refreshed on PERIOD_ADVANCE, which is cheap (a few hundred scans) and
   * bounds how long a mid-run account can stay untracked to a single period.
   */
  let keys = null;

  const rescan = (state) => {
    keys = [];
    for (const k in state) if (isCurrencyLotPool(state[k])) keys.push(k);
  };

  /**
   * Apply credit legs, either as fresh acquisitions at spot or as carryover from a
   * matched debit.
   *
   * @param carriedBasis USD basis that left a tracked pool in this same transition
   * @param carriedUnits the units that basis came with
   * @param isTransfer   true when the movement is `(a)(1)(iii)(E)` non-recognition
   */
  const applyCredits = (credits, state, date, carriedBasis, carriedUnits, isTransfer) => {
    if (!credits) return;
    const totalCredit = credits.reduce((s, c) => s + c.delta, 0);
    for (const { key, account, delta, opening } of credits) {
      const pool = readPool(account, state, date, opening);
      const rate = spotFor(state, accountCurrencyCode(account));
      let basis = null;
      if (isTransfer && carriedUnits > EPS) {
        // This leg's share of what left, by units. Anything beyond what a tracked pool
        // actually supplied (a transfer part-funded from somewhere unpooled) is a real
        // acquisition and is priced at spot rather than given free basis.
        const share      = totalCredit > 0 ? delta / totalCredit : 1;
        const carryUnits = carriedUnits * share;
        const carryBasis = carriedBasis * share;
        if (delta <= carryUnits + EPS) {
          basis = carryUnits > 0 ? carryBasis * (delta / carryUnits) : 0;
        } else {
          basis = carryBasis + (rate > 0 ? usdOf(delta - carryUnits, rate) : 0);
        }
      } else if (rate > 0) {
        basis = usdOf(delta, rate);
      }
      if (basis != null) pool.acquire(date, delta, basis);
      syncToState(state, key, pool);
    }
  };

  /** Scale a pool to `targetUnits`, holding the basis:units ratio. */
  const rescale = (pool, targetUnits) => {
    if (!(pool.units > EPS) || !(targetUnits >= 0)) return;
    const f = targetUnits / pool.units;
    pool.units = targetUnits;
    pool.basis *= f;
    for (const lot of pool.lots) { lot.units *= f; lot.basis *= f; }
  };

  /**
   * Reconstruct a pool from the account entry, seeding it on first sight.
   *
   * **State is authoritative, and the observer keeps no pool of its own.** Holding a
   * `Map` here would be faster and would be wrong: `restoreSnapshot` / `rewind` replace
   * `this.state` wholesale (the workbench timeline and the optimizer's MPC seam both do
   * it), and `Simulation` can clone itself — either would leave a cached pool describing a
   * world the run has left, with no symptom until a tax figure came out wrong. Rebuilding
   * from the entry costs two numbers under pro-rata, which is the default.
   *
   * `openingUnits` is the balance BEFORE this transition, never `account.balance`: by the
   * time this runs the reducer has already moved the money, so seeding from the current
   * balance would count a first-sight credit twice.
   *
   * On first sight an authored `fxBasisRate` is the pool's real acquisition history
   * expressed as a rate (design 87 §10) and becomes the opening lot. With none, the
   * balance is stamped at today's spot and recognizes nothing — the rule the debt leg's
   * `bookingFxRate` follows, which **understates** §988 rather than inventing it, because
   * for a balance already present at t0 the true history is unknowable to the model.
   * Design 87 §13.6 step 1 is what eventually replaces that guess.
   */
  const readPool = (account, state, date, openingUnits) => {
    const method = methodFor(state);
    const pool = new CurrencyLotPool(method);
    const units = Math.max(0, openingUnits ?? 0);

    if (method === LEDGER_METHOD.FIFO && Array.isArray(account.fxLots) && account.fxLots.length) {
      for (const l of account.fxLots) pool.acquire(l.date, l.units, l.basis);
      // Self-heal after any out-of-band change to the balance (a restored snapshot, a
      // direct assignment). Rescaling preserves the basis:units ratio, which is the
      // conservative choice: it neither invents basis nor destroys it.
      if (pool.units > EPS && Math.abs(pool.units - units) > 0.005) rescale(pool, units);
      return pool;
    }

    if (account.fxBasisUsd != null) {
      if (units > 0) pool.acquire(date, units, account.fxBasisUsd);
      return pool;
    }

    if (units > 0) {
      const rate = account.fxBasisRate > 0
        ? account.fxBasisRate
        : spotFor(state, accountCurrencyCode(account));
      if (rate > 0) pool.acquire(date, units, usdOf(units, rate));
    }
    return pool;
  };

  /**
   * Publish the pool back onto the account entry.
   *
   * `fxBasisRate` stays authoritative-looking and keeps its phase 1–2 meaning — units per
   * USD of basis — so `realizeCurrencyDisposition` and the UI keep working unchanged while
   * emitters are migrated one at a time. The observer recomputes it from the lots after
   * every movement, which makes the ledger the source of truth without a flag day.
   */
  const syncToState = (state, key, pool) => {
    const account = state[key];
    if (!account) return;
    account.fxBasisUsd  = pool.basis;
    account.fxBasisRate = pool.basis > 0 ? pool.units / pool.basis : account.fxBasisRate ?? null;
    // The lot ARRAY reaches state only under FIFO, and that asymmetry is the point.
    // Pro-rata is fully described by the two aggregates above — it never consults a lot —
    // so publishing several hundred of them per pool would put a per-period, per-MC-path
    // cost on every run to serialize something nothing reads, and would bury every golden
    // fixture's real diff under a wall of lot rows. FIFO genuinely needs them (a holding
    // period is a fact about WHICH units left), so FIFO pays for them. Keeping this
    // conditional is what lets the method stay a cheap experiment rather than a commitment.
    if (methodFor(state) === LEDGER_METHOD.FIFO) account.fxLots = pool.lots.map(l => ({ ...l }));
  };

  return {
    before(state) {
      if (keys === null) rescan(state);
      if (keys.length === 0) return null;
      // BY VALUE. AccountService mutates state entries in place, so a token holding the
      // entry object would be compared against itself and see nothing move.
      const snap = {};
      for (const k of keys) {
        const a = state[k];
        if (a) snap[k] = a.balance ?? 0;
      }
      return snap;
    },

    after(state, token, action, date) {
      if (action?.type === 'PERIOD_ADVANCE') rescan(state);
      if (!token) return [];

      // Collect what actually moved. Almost every reducer moves nothing here, so this
      // loop is the hot path and stays allocation-free until something changes.
      let debits = null;
      let credits = null;
      for (const k of keys) {
        const account = state[k];
        if (!account) continue;
        const beforeBal = token[k];
        if (beforeBal === undefined) continue;
        const delta = (account.balance ?? 0) - beforeBal;
        if (delta > EPS) (credits ??= []).push({ key: k, account, delta, opening: beforeBal });
        else if (delta < -EPS) (debits ??= []).push({ key: k, account, delta: -delta, opening: beforeBal });
      }
      if (!debits && !credits) return [];

      const decl = action?.section988 ?? null;
      const kind = decl?.kind ?? null;

      // ── IGNORE: the balance moved but no currency did ────────────────────────────
      // A revaluation or shock marks a balance without any units changing hands. Consuming
      // lots for it would destroy real basis, which is exactly the failure mode
      // [[basis-ledger-revaluation-drift]] records — and [[shock-revaluation-ignores-allocation]]
      // notes an equity shock also marks CASH down, so this is reachable, not theoretical.
      // Scaling units and basis together holds the ratio, the same thing `holding-utils`
      // does for holdings.
      if (kind === 'IGNORE') {
        for (const { key, account, opening } of [...(debits ?? []), ...(credits ?? [])]) {
          const pool = readPool(account, state, date, opening);
          rescale(pool, Math.max(0, account.balance ?? 0));
          syncToState(state, key, pool);
        }
        return [];
      }

      // ── WHICH debit disposes, and in WHAT ORDER the legs apply ───────────────────
      // A DISPOSE declaration may name the account it applies to. It matters because one
      // reducer can move several pools at once: `IntlTransferApplyReducer` tops its AU
      // pool up — possibly from ANOTHER AUD pool — and then converts out of it. Without a
      // named account, "kind: DISPOSE" would realize the internal top-up leg too, turning
      // a `(a)(1)(iii)(E)` non-recognition transfer into a taxable disposition. An
      // unnamed DISPOSE still applies to every debit, which is right for the single-pool
      // callers and is the back-compatible reading.
      const disposesKey = decl?.accountKey ?? null;
      const isDisposal  = (key) => kind === 'DISPOSE' && (disposesKey == null || disposesKey === key);

      // ── the GROSS disposal, when a net delta would hide it ───────────────────────
      // Observation is per reducer, so a pool credited AND debited inside one reducer
      // shows only its NET movement — and `IntlTransferApplyReducer` does exactly that:
      // `replenishSavings` tops the AU pool up, then the conversion debits it. Realizing
      // on the net would understate the disposition by the whole top-up, and under
      // pro-rata a net movement is NOT arithmetically equivalent to a credit followed by
      // a debit.
      //
      // So a declaration may state the units actually disposed of. The credit is then
      // implied — `net + units` — and applied first, exactly reproducing the two real
      // movements. This is design 87 §6's "realize in the reducer, not the handler"
      // restated: what is declared is the amount that MOVED, which only the caller that
      // moved it knows.
      const declUnits = disposesKey != null && decl?.units > 0 ? decl.units : null;
      if (declUnits != null) {
        if (debits)  debits  = debits.filter(d => d.key !== disposesKey);
        if (credits) credits = credits.filter(c => c.key !== disposesKey);
      }

      // Three phases, and the order is forced by what each needs to see:
      //   1. NON-disposing debits, so basis leaving a pool is available to carry over;
      //   2. credits, which either take that carryover or acquire at spot;
      //   3. disposing debits LAST, so the disposal measures a pool that already includes
      //      whatever funded it. Consuming before the funding credit lands would price the
      //      disposal at whatever rate the pool happened to carry before — the same silent
      //      defect the handler bracket fixed, one scope down.
      const plainDebits    = (debits ?? []).filter(d => !isDisposal(d.key));
      const disposalDebits = (debits ?? []).filter(d =>  isDisposal(d.key));

      let carried = 0;
      let carriedUnits = 0;
      const emitted = [];
      for (const { key, account, delta, opening } of plainDebits) {
        const pool = readPool(account, state, date, opening);
        const { basis, held, shortfall } = pool.consume(date, delta);
        carried += basis;
        carriedUnits += delta - shortfall;
        if (shortfall > EPS && STRICT) {
          // Past zero you are not holding currency, you owe it — a nonfunctional-currency
          // liability is the DEBT regime (design 86 G7), not a cash pool. Those units get
          // no basis rather than a zero one.
          console.warn(
            `[§988] ${key}: disposal of ${delta.toFixed(2)} exceeded the pool by ` +
            `${shortfall.toFixed(2)} — overdraft or missing history; units excluded.`);
        }

        syncToState(state, key, pool);
      }

      // ── Credits ──────────────────────────────────────────────────────────────────
      // A same-currency move (something fell, something rose) is `(a)(1)(iii)(E)`
      // non-recognition and the units keep "the adjusted basis of the units transferred".
      // Inferred from the shape rather than requiring a flag, so an unannotated transfer
      // path still carries basis instead of silently re-marking to market.
      const isTransfer = kind === 'INTERNAL' || (plainDebits.length > 0 && credits);
      applyCredits(credits, state, date, carried, carriedUnits, isTransfer);

      // ── the declared gross disposal, if any: implied credit first, then dispose ──
      if (declUnits != null) {
        const account = state[disposesKey];
        const opening = token[disposesKey] ?? 0;
        const net     = (account?.balance ?? 0) - opening;
        const implied = net + declUnits;
        const pool    = readPool(account, state, date, opening);
        const rate    = spotFor(state, accountCurrencyCode(account));
        if (implied > EPS) {
          // Funded from a tracked same-currency pool ⇒ carryover; otherwise a genuine
          // acquisition priced at spot.
          const fromCarry = Math.min(implied, carriedUnits);
          let basis = 0;
          if (fromCarry > EPS && carriedUnits > EPS) basis += carried * (fromCarry / carriedUnits);
          if (implied - fromCarry > EPS && rate > 0) basis += usdOf(implied - fromCarry, rate);
          pool.acquire(date, implied, basis);
          carried      -= fromCarry > EPS && carriedUnits > EPS ? carried * (fromCarry / carriedUnits) : 0;
          carriedUnits -= fromCarry;
        }
        disposalDebits.push({ key: disposesKey, account, delta: declUnits, opening, pool });
      }

      // ── Disposing debits, last ───────────────────────────────────────────────────
      for (const { key, account, delta, opening, pool: prebuilt } of disposalDebits) {
        const pool = prebuilt ?? readPool(account, state, date, opening);
        const { basis, held, shortfall } = pool.consume(date, delta);
        if (shortfall > EPS && STRICT) {
          console.warn(
            `[§988] ${key}: disposal of ${delta.toFixed(2)} exceeded the pool by ` +
            `${shortfall.toFixed(2)} — overdraft or missing history; units excluded.`);
        }
        {
          const priced = delta - shortfall;
          const rate   = spotFor(state, accountCurrencyCode(account));
          if (priced > EPS && rate > 0) {
            const gain  = usdOf(priced, rate) - basis;     // proceeds − basis, both USD
            // §988(e)(3)'s "to the extent" fraction, per DISPOSITION (design 87 G12).
            // The account's own `deductibleFraction` is only the fallback: one account can
            // be simultaneously §212 (property expenses), personal (household) and
            // carved out (tax payments, §988(e)(3)(B)), and a scalar cannot say so.
            const frac  = decl?.businessFraction ?? currencyPoolBusinessFraction(account);
            const alloc = allocateGain(gain, frac, held);
            if (Math.abs(alloc.ordinary) > 1e-9 || alloc.capitalGain > 1e-9
                || alloc.disallowedPersonalLoss > 1e-9 || alloc.deMinimisExcluded > 1e-9) {
              emitted.push({
                type: 'SECTION_988_GAIN',
                accountKey: key,
                currency: accountCurrencyCode(account),
                // `amount` stays the ORDINARY business share, so every existing consumer
                // keeps its meaning. The personal share leaves separately as `capitalGain`
                // — design 87 G10: `§1.988-1(a)(9)` puts a personal transaction outside
                // §988 altogether, so §988(a)(1)(A)'s ordinary character never attaches and
                // character falls back to §1001/§1221, where currency is a capital asset.
                amount: alloc.ordinary,
                gross: gain,
                capitalGain: alloc.capitalGain,
                // null under pro-rata, which cannot say WHICH units left and so cannot say
                // how long they were held. Consumers must treat null as "unknown", never
                // as short-term.
                longTerm: alloc.longTerm,
                disallowedLoss: alloc.disallowedPersonalLoss,
                deMinimis: alloc.deMinimisExcluded,
                residency: section988Residence(state, account),
              });
            }
          }
        }
        syncToState(state, key, pool);
      }

      if (STRICT) {
        for (const k of keys) {
          const account = state[k];
          if (!account || account.fxBasisUsd == null) continue;
          const tracked = methodFor(state) === LEDGER_METHOD.FIFO && Array.isArray(account.fxLots)
            ? account.fxLots.reduce((sum, l) => sum + l.units, 0)
            : (account.fxBasisRate > 0 ? account.fxBasisUsd * account.fxBasisRate : 0);
          const drift = Math.abs((account.balance ?? 0) - tracked);
          // The invariant that makes FIFO's failure mode loud. Without it a missed credit
          // leaves the pool under-supplied, the shortfall branch fires, and the run
          // OVERSTATES gain — silently, and in the taxpayer's disfavour.
          if (drift > 0.01) {
            console.warn(
              `[§988] ${k}: lot ledger drifted from balance by ${drift.toFixed(4)} ` +
              `(balance ${(account.balance ?? 0).toFixed(2)}, lots ${tracked.toFixed(2)}) ` +
              `after ${action?.type}`);
          }
        }
      }

      return emitted;
    },

    /**
     * Test/diagnostic seam: reconstruct a key's pool from state.
     *
     * Takes `state` because state IS the pool — there is no cached copy to read. That the
     * seam cannot be written any other way is the point: anything able to answer this
     * question without state would be a cache that `restoreSnapshot` could invalidate.
     */
    _poolFor(state, key) {
      const account = state?.[key];
      if (!account) return undefined;
      const units = account.fxBasisRate > 0 && account.fxBasisUsd != null
        ? account.fxBasisUsd * account.fxBasisRate
        : (account.balance ?? 0);
      return readPool(account, state, null, units);
    },
  };
}
