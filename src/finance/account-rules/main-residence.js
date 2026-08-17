/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * main-residence.js — the day-count rules that decide how much of a house-sale gain
 * either country actually taxes. Design 83 G7, steps 1, 2 and 5.
 *
 * Both countries give a main-home concession, both prorate it by time, and **neither
 * gives the round number people expect**. Australia's s118-185 exempts the fraction of
 * the *ownership period* the dwelling was your main residence; the United States'
 * §121(b)(5) denies the exclusion for the fraction allocable to post-2008
 * "nonqualified use". A dwelling rented for years and then moved into is partly
 * sheltered in both, fully sheltered in neither.
 *
 * The asymmetry that decides the interesting case: **Australia forgives the rental
 * years only in proportion; the United States forgives rental AFTER you move out but
 * not BEFORE you move in** (§121(b)(5)(C)(ii)(I), Pub 523 Exception 1). Rent-then-occupy
 * is the penalised order in the US and merely proportional in AU. Occupy-then-rent is
 * the forgiven order in the US and, via s118-145, potentially free in AU. Same dwelling,
 * same total years, opposite answers — which is why every rule here is a day count over
 * a stated interval rather than a boolean.
 *
 * Everything is pure and takes epoch-ms, so the reducers stay testable and the FITO /
 * counterfactual passes can re-run them without side effects.
 */

const DAY_MS  = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

/** §121(b)(5)(C)(i): nonqualified use never includes any period before 1 Jan 2009. */
const NONQUALIFIED_USE_EPOCH_MS = Date.UTC(2009, 0, 1);

/** §121(b)(3)/(a): the ownership-and-use test runs over the 5 years ending at sale. */
const US_LOOKBACK_MS  = 5 * YEAR_MS;
const US_USE_TEST_MS  = 2 * YEAR_MS;

export const US_PRIMARY_HOME_EXCLUSION_MFJ    = 500_000;
export const US_PRIMARY_HOME_EXCLUSION_SINGLE = 250_000;

/** Overlap of two closed intervals, in ms; 0 when they do not meet. */
function overlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Normalise a date-ish field (epoch ms, Date, or ISO string) to epoch ms, or null.
 * Saved scenarios carry all three shapes depending on which editor last wrote them.
 */
export function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * Was the dwelling the main residence for its whole ownership? True only on the
 * backward-compatible path: every pre-G7 property carries the static
 * `isPrimaryResidence` boolean and no dates, and that boolean can only mean
 * "throughout". A property that states `mainResidenceFrom` has said something more
 * precise, and the dates win.
 *
 * This is what lets G7 land without touching a single saved scenario: an old
 * `isPrimaryResidence: true` keeps producing a full exemption, an old
 * `isPrimaryResidence: false` keeps producing none, and only a property that opts into
 * the dates gets the day-count treatment.
 */
export function isMainResidenceThroughout(prop) {
  return toMs(prop?.mainResidenceFrom) == null
      && toMs(prop?.mainResidenceUntil) == null
      && prop?.isPrimaryResidence === true;
}

/**
 * The window during which a dwelling was its owner's main residence, clipped to the
 * ownership period. `mainResidenceUntil == null` means "still is at sale".
 *
 * @returns {{fromMs: number, untilMs: number}|null} null when it never was one
 */
export function mainResidenceWindow(prop, acquisitionMs, saleMs) {
  if (isMainResidenceThroughout(prop)) return { fromMs: acquisitionMs, untilMs: saleMs };
  const fromRaw = toMs(prop?.mainResidenceFrom);
  const untilRaw = toMs(prop?.mainResidenceUntil);
  // "The main residence from the start, then we moved out" — expressed as the
  // `isPrimaryResidence` flag with only an END date. It needs no start date because the
  // start IS the acquisition, and inventing a sentinel to say so would put a magic
  // constant in saved scenarios. This is the occupy-then-rent history, which is the
  // forgiven order under §121 Exception 1 and the one s118-145 would extend, so it must
  // be expressible distinctly from "throughout" rather than collapsing into it.
  if (fromRaw == null && untilRaw != null && prop?.isPrimaryResidence === true) {
    const untilMs = Math.min(untilRaw, saleMs);
    return untilMs > acquisitionMs ? { fromMs: acquisitionMs, untilMs } : null;
  }
  if (fromRaw == null) return null;
  const fromMs  = Math.max(fromRaw, acquisitionMs);
  const untilMs = Math.min(toMs(prop?.mainResidenceUntil) ?? saleMs, saleMs);
  return untilMs > fromMs ? { fromMs, untilMs } : null;
}

/**
 * ITAA97 s118-185 — the AU partial main-residence exemption, with the s118-110(3)
 * foreign-resident denial applied first (design 83 §7b.2a, stages 0 and 2).
 *
 * **Stage 0 is a snapshot, not a look-back.** s118-110(3) and s118-185(3) deny relief
 * only if you are an excluded foreign resident *at the time the CGT event happens*.
 * Return, become resident, then sell and the denial never engages — that single
 * sequencing fact is worth more than every other rule here, and it is the whole
 * difference between selling before and after the move. The life-events test in
 * s118-110(5) (terminal illness, death of a spouse, divorce, within 6 years) is narrow
 * and deliberately not modelled; it can only ever *restore* relief, so omitting it is
 * conservative.
 *
 * **Stage 2** is s118-185(2), which yields the TAXABLE slice, not the exempt one:
 *
 *     CG × (non-main-residence days ÷ days in the ownership period)
 *
 * **What is deliberately not here.** s118-145 (the absence rule) and s118-192 (the
 * mandatory market-value reset) both require the dwelling to have been a fully-exempt
 * main residence *before* it first produced income — s118-145(1) says "a dwelling **that
 * was your main residence** ceases to be", and s118-192(1)(b) asks whether a full
 * exemption would have been available just before the income time. A dwelling rented
 * first and occupied later fails both limbs, so for that history they are not merely
 * unimplemented, they are unavailable. s118-190 (the further reduction where interest
 * would have been deductible) is likewise omitted, and its omission is conservative in
 * the same direction: it would shrink the exemption further.
 *
 * **An unknown acquisition date denies the exemption rather than guessing.** Falling
 * back to the simulation start would treat a twenty-year hold as a three-year one and
 * inflate the exempt fraction — a silent overstatement in the user's favour, which is
 * the worst failure mode available here. `reason` names which branch fired so a caller
 * can surface it instead of shipping a quiet zero.
 *
 * @param {object} prop            property state (reads mainResidenceFrom/Until)
 * @param {object} opts
 * @param {?number} opts.acquisitionMs  when the dwelling was acquired
 * @param {?number} opts.saleMs         the CGT event date
 * @param {?string} opts.residencyAtSale 'AU' | 'US' | null — snapshot at the CGT event
 * @returns {{exemptFraction: number, taxableFraction: number, reason: string}}
 */
export function auMainResidenceExemption(prop, { acquisitionMs, saleMs, residencyAtSale }) {
  const deny = (reason) => ({ exemptFraction: 0, taxableFraction: 1, reason });

  // Stage 0 — s118-110(3)/s118-185(3), tested at the CGT event only.
  if (residencyAtSale !== 'AU') return deny('foreign-resident-at-cgt-event');
  // A dwelling that was the main residence THROUGHOUT is fully exempt without any day
  // count, so it needs no acquisition date — which is what keeps every pre-G7
  // `isPrimaryResidence: true` property producing exactly its old answer.
  if (isMainResidenceThroughout(prop)) {
    return { exemptFraction: 1, taxableFraction: 0, reason: 'main-residence-throughout' };
  }
  if (acquisitionMs == null || saleMs == null || saleMs <= acquisitionMs) {
    return deny('unknown-ownership-period');
  }
  const window = mainResidenceWindow(prop, acquisitionMs, saleMs);
  if (window == null) return deny('never-a-main-residence');

  // Stage 2 — s118-185(2).
  const ownershipMs      = saleMs - acquisitionMs;
  const mainResidenceMs  = overlapMs(window.fromMs, window.untilMs, acquisitionMs, saleMs);
  const exemptFraction   = Math.min(1, Math.max(0, mainResidenceMs / ownershipMs));
  return {
    exemptFraction,
    taxableFraction: 1 - exemptFraction,
    reason: exemptFraction >= 1 ? 'main-residence-throughout' : 's118-185-partial',
  };
}

/**
 * IRC §121 — the US principal-residence exclusion, prorated by nonqualified use.
 *
 * Pub 523's ordering, which is what makes this more than a cap:
 *   1. gain = price − adjusted basis (basis already net of depreciation);
 *   2. **subtract depreciation** — §1250 gain is never excludable, whatever the use
 *      history (Pub 523: "you can't exclude the portion of gain equal to any section
 *      1250(b)(3) depreciation adjustments allowed or allowable after May 6, 1997");
 *   3. allocate the remainder between qualified and nonqualified use by a time fraction;
 *   4. exclude only the qualified slice, capped at \$250k / \$500k.
 *
 * **Two gates, and they fail differently.** The 2-of-5 ownership-and-use test is a
 * cliff: below it the exclusion is zero however long you later live there. The
 * nonqualified-use fraction is smooth. So the lever is a ramp with a hard edge at the
 * bottom, and a sweep coarser than a year can step straight over it.
 *
 * **Exception 1 is the asymmetry that matters.** §121(b)(5)(C)(ii)(I) excludes from
 * nonqualified use "any portion of the 5-year period … **after** the last date the
 * property is used as the principal residence". Renting a home out after you move out
 * is forgiven; renting it out before you move in is not. A dwelling held as a rental
 * and then occupied is therefore in the penalised order, and its exclusion is capped by
 * a fraction that no amount of subsequent occupancy can fully undo.
 *
 * **`gain` sets the currency, and the cap has to follow it.** Every figure here is in
 * whatever currency the caller measured the disposal in — USD for a US dwelling, AUD
 * for an Australian one, since the AU sale reducer stamps its payload in the property's
 * own currency. The §121 ceiling is a US dollar amount, so a caller working in anything
 * else must convert it and pass it as `cap`; leaving the default in place compares a
 * US$500,000 ceiling against an A$ gain and denies exclusion that is actually available
 * (at 1.55 the ceiling should be A$775,000, so a qualified gain anywhere between the
 * two is over-taxed). Defaulting rather than requiring the argument keeps the US caller
 * — where the statutory constant IS the right answer — reading as it always did.
 *
 * @param {object} prop        property state (reads mainResidenceFrom/Until)
 * @param {object} opts
 * @param {number}  opts.gain             total realised gain (post-depreciation basis)
 * @param {number}  opts.depreciationGain the §1250 slice, never excludable
 * @param {?number} opts.acquisitionMs
 * @param {?number} opts.saleMs
 * @param {boolean} opts.filingSingle
 * @param {?number} opts.cap   the §121 ceiling in `gain`'s currency; omit for USD
 * @returns {{excluded: number, eligible: boolean, nonqualifiedFraction: number,
 *            cap: number, reason: string}}
 */
export function us121Exclusion(prop, { gain, depreciationGain = 0, acquisitionMs, saleMs, filingSingle,
                                       cap: capOverride = null }) {
  const cap  = capOverride ?? (filingSingle ? US_PRIMARY_HOME_EXCLUSION_SINGLE : US_PRIMARY_HOME_EXCLUSION_MFJ);
  const none = (reason) => ({ excluded: 0, eligible: false, nonqualifiedFraction: 1, cap, reason });

  if (!(gain > 0)) return none('no-gain');

  // A dwelling that was the principal residence THROUGHOUT passes the 2-of-5 use test
  // and has no nonqualified use, both by construction — so it needs no dates. This is
  // what keeps every pre-G7 property (a bare `isPrimaryResidence: true`, no acquisition
  // date) excluding exactly what it excluded before. Without this branch the unknown-
  // ownership guard below would deny the exclusion outright, which is a silent tax rise
  // on every existing plan rather than the new fidelity G7 is supposed to add.
  if (isMainResidenceThroughout(prop)) {
    const base = Math.max(0, gain - Math.max(0, depreciationGain));
    return { excluded: +Math.min(base, cap).toFixed(2), eligible: true,
             nonqualifiedFraction: 0, cap, reason: 's121-full' };
  }

  if (acquisitionMs == null || saleMs == null || saleMs <= acquisitionMs) {
    return none('unknown-ownership-period');
  }
  const window = mainResidenceWindow(prop, acquisitionMs, saleMs);
  if (window == null) return none('never-a-principal-residence');

  // Gate — §121(a): used as the principal residence for ≥ 2 of the 5 years ending at
  // the sale. Ownership is implied here: the window is already clipped to the
  // ownership period.
  const lookbackStart = saleMs - US_LOOKBACK_MS;
  const useInLookback = overlapMs(window.fromMs, window.untilMs, lookbackStart, saleMs);
  if (useInLookback < US_USE_TEST_MS) return none('fails-2-of-5-use-test');

  // §121(b)(5) — nonqualified use, measured over the whole ownership period from
  // 1 Jan 2009, with Exception 1 removing everything after the last day of use as the
  // principal residence.
  const periodStart = Math.max(acquisitionMs, NONQUALIFIED_USE_EPOCH_MS);
  const periodEnd   = saleMs;
  const periodMs    = Math.max(0, periodEnd - periodStart);

  let nonqualifiedFraction = 0;
  if (periodMs > 0) {
    const qualifiedMs = overlapMs(window.fromMs, window.untilMs, periodStart, periodEnd);
    // Exception 1: the tail after the last date of principal-residence use is NOT
    // nonqualified use. Everything before the first such date is.
    const forgivenTailMs = Math.max(0, periodEnd - Math.max(window.untilMs, periodStart));
    const nonqualifiedMs = Math.max(0, periodMs - qualifiedMs - forgivenTailMs);
    nonqualifiedFraction = Math.min(1, nonqualifiedMs / periodMs);
  }

  // Depreciation comes out first and is never excludable; the balance is prorated.
  const excludableBase = Math.max(0, gain - Math.max(0, depreciationGain));
  const qualifiedGain  = excludableBase * (1 - nonqualifiedFraction);
  return {
    excluded: +Math.min(qualifiedGain, cap).toFixed(2),
    eligible: true,
    nonqualifiedFraction,
    cap,
    reason: nonqualifiedFraction > 0 ? 's121-prorated-for-nonqualified-use' : 's121-full',
  };
}

/**
 * The depreciation-attributable slice of a gain — unrecaptured §1250 gain, taxed at a
 * maximum 25% rate rather than the 0/15/20% LTCG rates, and never excludable under
 * §121 (design 83 §7b.2b-dep).
 *
 * Capped at the gain because depreciation below a sale price that fell can exceed the
 * gain itself; the excess is a §1231 loss question this model does not reach.
 *
 * Australia needs no equivalent: s110-45(2) already takes Div 43 out of the cost base,
 * which enlarges the ordinary capital gain, and that enlarged gain then flows through
 * s118-185 and the CGT discount like any other — so Australia taxes recaptured capital
 * works at half rate after the discount and shelters it proportionally with the
 * main-residence exemption. The United States does neither. For a long-rented dwelling
 * that asymmetry can be the largest single term in the answer, and it points the
 * opposite way from the intuition that moving in makes a sale tax-free.
 */
export function unrecaptured1250Gain(gain, accumulatedDepreciation) {
  return Math.max(0, Math.min(Math.max(0, gain), Math.max(0, accumulatedDepreciation ?? 0)));
}

/**
 * ITAA97 s115-105/110/115 — the CGT discount percentage, apportioned by residency.
 *
 * A gain does not attract a flat 50% discount; it attracts
 *
 *     50% × (days an Australian resident ÷ days in the discount testing period)
 *
 * with the testing period fixed by s115-105(2)(d) as **acquisition → CGT event**. Own an
 * asset for twenty years and be resident for the last three and the discount is about
 * 7.5%, not 50%. Note 1 to s115-115 is explicit that the percentage is 0% for someone
 * who was a foreign resident throughout.
 *
 * ─── why this is not simply "the resident gets 50%, the non-resident gets 0" ──
 * The binary switch the model used before is wrong in BOTH directions, and neither is
 * conservative. A returning resident selling a long-held asset is given a full 50%
 * discount on a gain that mostly accrued while they were abroad — too generous. A
 * departing resident selling the same asset is given nothing, when their years of
 * residence entitle them to a real fraction — too harsh, and against the taxpayer.
 *
 * ─── where it actually bites, which is narrower than it looks ────────────────
 * Design 62's s855-45 deemed acquisition restarts the clock at the move for every
 * NON-taxable-Australian-property asset, so for those the testing period lies entirely
 * inside the residency and the answer is 50% — unchanged. The apportionment therefore
 * only moves assets that keep their original acquisition date across the move, which is
 * TAP: Australian real property. That is a narrow set and a large number.
 *
 * `residencySinceMs == null` on an AU-resident person means resident for the whole
 * period, which is the pre-move-history default and reproduces the old 50% exactly.
 *
 * @param {object} opts
 * @param {?number} opts.acquisitionMs     start of the discount testing period
 * @param {?number} opts.saleMs            the CGT event
 * @param {?number} opts.residencySinceMs  when AU residency began; null = always
 * @param {?string} opts.residencyAtSale   'AU' | 'US' | null
 * @param {number}  [opts.maxRate=0.5]     the statutory discount ceiling
 * @returns {{fraction: number, residentDays: number, testingDays: number, reason: string}}
 */
export function cgtDiscountFraction({ acquisitionMs, saleMs, residencySinceMs, residencyAtSale, maxRate = 0.5 }) {
  // A foreign resident at the CGT event still gets the discount for the days they WERE
  // resident — s115-115 apportions, it does not deny. What a foreign resident loses is
  // the main-residence exemption (s118-110(3)), which is a different provision entirely
  // and is applied separately; conflating the two is what the binary switch did.
  if (acquisitionMs == null || saleMs == null || saleMs <= acquisitionMs) {
    // No testing period to divide by. Fall back to the pre-apportionment answer so an
    // asset with no acquisition date behaves exactly as it did before this existed.
    return { fraction: residencyAtSale === 'AU' ? maxRate : 0,
             residentDays: 0, testingDays: 0, reason: 'unknown-testing-period' };
  }
  const testingMs = saleMs - acquisitionMs;

  // Residency start: null means "for the whole period". Someone who has never been an
  // AU resident and is not one now has no resident days at all.
  let residentFromMs;
  if (residencySinceMs != null)      residentFromMs = Math.max(residencySinceMs, acquisitionMs);
  else if (residencyAtSale === 'AU') residentFromMs = acquisitionMs;
  else return { fraction: 0, residentDays: 0, testingDays: testingMs / DAY_MS,
                reason: 'never-an-australian-resident' };

  const residentMs = Math.max(0, saleMs - residentFromMs);
  const fraction   = maxRate * Math.min(1, residentMs / testingMs);
  return {
    fraction,
    residentDays: residentMs / DAY_MS,
    testingDays:  testingMs / DAY_MS,
    reason: fraction >= maxRate ? 'resident-throughout' : 's115-115-apportioned',
  };
}
