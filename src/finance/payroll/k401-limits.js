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
 * k401-limits.js — design 95 §7, phase 3. What a 401(k) actually allows.
 *
 * Three things phase 0-2 carried over unchanged from the original handler, and all
 * three were wrong in ways that only bite a real plan:
 *
 * 1. **The "match" was not a match.** `k401EmployerMatchPct` was a flat percentage
 *    of salary applied *independently of what the employee deferred* — a
 *    non-elective contribution. A real match is a function of the deferral: someone
 *    deferring 1% into a plan matching "100% of the first 3%" gets 1%, not 3%.
 * 2. **Compensation was uncapped.** §401(a)(17) limits the pay a plan may take into
 *    account. On a salary above the cap this is the difference between a \$10,800
 *    match and a \$15,000 one, and it is the most commonly omitted rule in
 *    retirement projections.
 * 3. **The caps were a scenario assumption.** A single authored `k401AnnualCap`
 *    stood in for §402(g), §414(v) and §415(c), which bind at different levels on
 *    different bases.
 *
 * ─── why a running total became unavoidable ──────────────────────────────────
 *
 * Phases 0-2 derived each month as `min(annualPay × rate, cap) / 12`, which keeps a
 * cap exact with no state at all — but only while the rate and the pay are both
 * constant across the year. Phase 3 makes three cases reachable that break it:
 *
 *   - a raise, or a mid-year change of election;
 *   - retirement part-way through a year (11 months of pay against a twelfth of the
 *     annual cap each month, so the cap under-binds); and
 *   - §415(c), whose base is the SUM of three separate contribution streams.
 *
 * So `state.k401ContributionsYTD` is a per-person running total, reset by the US
 * settle with the other YTD accumulators. It is real state that has to survive a
 * rewind and a branch correctly, and that cost is why phases 0-2 avoided it.
 *
 * ─── clamp, do not warn (D8) ─────────────────────────────────────────────────
 *
 * When a limit binds, the contribution is reduced and the reduction is REPORTED on
 * the action, so "you elected 20% but §402(g) stopped you in September" is visible
 * in the journal rather than inferred from a number being lower than expected. The
 * cheaper alternative — compute the elected amount and warn — leaves the model
 * projecting a plan the IRS would reject, and in a Monte Carlo run nobody reads
 * warnings.
 */

import { usContributionLimits, catchUpAllowance } from '../tax/us/us-contribution-limits.js';

/** Cents. */
const cents = n => +n.toFixed(2);

/**
 * The default employer match when a scenario says nothing: 100% of the first 3% of
 * compensation. Design 95 D3's stated default and the most common small-plan
 * formula; a scenario that wants the safe-harbor basic match writes
 * `[{matchRate: 1.0, uptoPctOfComp: 0.03}, {matchRate: 0.5, uptoPctOfComp: 0.02}]`.
 */
export const DEFAULT_MATCH_TIERS = [{ matchRate: 1.00, uptoPctOfComp: 0.03 }];

/**
 * The fraction of compensation an employer matches, given what the employee deferred.
 *
 * Tiers consume the deferral in order:
 *
 *     matched = Σ  matchRate_i × min(remaining_deferral, uptoPctOfComp_i)
 *
 * so `[{1.00, 0.03}]` with a 10% deferral matches 3%, and with a 1% deferral
 * matches 1%. `[{1.00, 0.03}, {0.50, 0.02}]` is §401(k)(12)(B)(i)'s safe-harbor
 * basic match: 100% on the first 3%, 50% on the next 2%, capped at 4% of pay.
 *
 * @param {number} deferralPct  fraction of compensation deferred
 * @param {Array<{matchRate:number, uptoPctOfComp:number}>} tiers
 * @returns {number} fraction of compensation matched
 */
export function matchedFraction(deferralPct, tiers) {
  let remaining = Math.max(0, deferralPct ?? 0);
  let matched   = 0;
  for (const t of tiers ?? []) {
    const band = Math.max(0, t?.uptoPctOfComp ?? 0);
    if (band <= 0 || remaining <= 0) continue;
    const used = Math.min(remaining, band);
    matched  += used * Math.max(0, t?.matchRate ?? 0);
    remaining = remaining - used;
  }
  return matched;
}

/**
 * Resolve a person's match formula.
 *
 * `matchTiers` wins when present. Otherwise the legacy `k401EmployerMatchPct` is
 * reinterpreted as **a 100% match on the first N% of pay** rather than as a flat
 * non-elective contribution.
 *
 * That reinterpretation is a deliberate behaviour change and the point of phase 3:
 * the old parameter is named "employer match" and every scenario that set it meant a
 * match. It is numerically identical wherever the deferral is at least as large as
 * the match band, which is the normal case and covers every existing scenario; it
 * differs only for someone deferring LESS than the band, where the old code paid
 * them a match they had not earned.
 *
 * A genuinely non-elective employer contribution is a different thing and has its
 * own field (`k401NonElectivePct`) rather than being faked as a tier.
 */
export function resolveMatchTiers(matchTiers, legacyMatchPct) {
  if (Array.isArray(matchTiers) && matchTiers.length > 0) return matchTiers;
  if ((legacyMatchPct ?? 0) > 0) {
    return [{ matchRate: 1.00, uptoPctOfComp: legacyMatchPct }];
  }
  return [];
}

/**
 * Compute one month's 401(k) amounts for one person, honouring every statutory
 * limit and reporting which ones bound.
 *
 * @param {object}  o
 * @param {number}  o.annualPay          gross annual compensation
 * @param {number}  o.deferralPct
 * @param {Array}   [o.matchTiers]
 * @param {number}  [o.legacyMatchPct]
 * @param {number}  [o.nonElectivePct=0]  employer contribution independent of deferral
 * @param {number}  [o.age]               age attained during the tax year (§414(v))
 * @param {number}  o.taxYear
 * @param {number}  [o.deferralYTD=0]     employee deferrals already made this year
 * @param {number}  [o.additionsYTD=0]    ALL annual additions already made this year
 * @param {?number} [o.scenarioCap=null]  authored cap; applies ON TOP of the statute
 * @returns {{deferral:number, match:number, nonElective:number, clamps:string[],
 *            eligiblePay:number}}
 */
export function monthlyK401({
  annualPay, deferralPct, matchTiers, legacyMatchPct, nonElectivePct = 0,
  age, taxYear, deferralYTD = 0, additionsYTD = 0, scenarioCap = null,
  indexFactor = 1,
}) {
  // Design 95 §10 phase 9 — past the last published year the table is projected off
  // the scenario's own cumulative inflation. Inside it, `indexFactor` is 1 and the
  // transcribed figures stand.
  const limits = usContributionLimits(taxYear, { indexFactor });
  const clamps = [];

  // ── §401(a)(17): the plan may not take account of pay above the limit ───────
  // Applied to BOTH the deferral percentage and the match percentage, because both
  // are percentages "of compensation" and compensation is the capped figure.
  const eligiblePay = Math.min(annualPay, limits.compensation);
  if (annualPay > limits.compensation) clamps.push('401(a)(17)');

  // ── The elected amounts, before any dollar limit ────────────────────────────
  const tiers        = resolveMatchTiers(matchTiers, legacyMatchPct);
  const wantDeferral = eligiblePay * Math.max(0, deferralPct ?? 0) / 12;
  const matchPct     = matchedFraction(Math.max(0, deferralPct ?? 0), tiers);
  const wantMatch    = eligiblePay * matchPct / 12;
  const wantNonElec  = eligiblePay * Math.max(0, nonElectivePct ?? 0) / 12;

  // ── §402(g) + §414(v): the employee's own deferral ceiling ─────────────────
  // The catch-up is genuinely additional headroom above §402(g), not part of it.
  const deferralCeiling = limits.electiveDeferral + catchUpAllowance(age, limits);
  // An authored cap applies ON TOP of the statute, never instead of it: a scenario
  // may model a plan-imposed limit stricter than the Code, but not a laxer one.
  const effectiveCeiling = scenarioCap == null
    ? deferralCeiling : Math.min(deferralCeiling, scenarioCap);

  let deferral = Math.max(0, Math.min(wantDeferral, effectiveCeiling - deferralYTD));
  if (deferral < wantDeferral - 0.005) {
    clamps.push(scenarioCap != null && effectiveCeiling === scenarioCap
      ? 'plan cap' : '402(g)');
  }

  // ── §415(c): annual additions, the sum of ALL three streams ────────────────
  // Lesser of the dollar limit or 100% of compensation. Note this uses the UNCAPPED
  // pay: §415(c)(1)(B) is "100 percent of the participant's compensation", which
  // §415(c)(3) defines separately from the §401(a)(17) plan-compensation limit.
  const additionsCeiling = Math.min(limits.annualAdditions, annualPay);
  let room = Math.max(0, additionsCeiling - additionsYTD);

  // The employee's own deferral has first claim on the remaining room — it is their
  // money and their election, and an employer contribution crowding it out would be
  // the wrong way round.
  if (deferral > room) { deferral = room; clamps.push('415(c)'); }
  room -= deferral;

  let match = Math.min(wantMatch, room);
  if (match < wantMatch - 0.005 && !clamps.includes('415(c)')) clamps.push('415(c)');
  room -= match;

  let nonElective = Math.min(wantNonElec, room);
  if (nonElective < wantNonElec - 0.005 && !clamps.includes('415(c)')) clamps.push('415(c)');

  return {
    deferral:    cents(Math.max(0, deferral)),
    match:       cents(Math.max(0, match)),
    nonElective: cents(Math.max(0, nonElective)),
    eligiblePay,
    clamps,
  };
}
