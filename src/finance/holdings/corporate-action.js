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
 * Corporate actions beyond splits — the POSITION-level transforms (design 94 §7, step 8).
 *
 * A corporate action is something the ISSUER does. Every other thing that moves a position
 * in this engine is something the PLAN does — a contribution, a drawdown, a rebalance, a
 * harvest — and that difference is why these could not be written before step 3. A split, a
 * spin-off and a stock merger all leave the holder's wealth unchanged while changing what
 * they hold; in a dollar-denominated model with no instrument identity there was literally
 * nothing to write down (`split()`'s header records that negative result). Once a lot is a
 * POSITION IN A SECURITY, each of them is a small, checkable function.
 *
 * ─── the tax content, from the sources on disk ──────────────────────────────────────
 *
 * Per this repo's rule nothing below is quoted from memory; every rule cites a file in
 * `docs/`. The eight files R3 put there:
 *
 *   IRC §301   `docs/us-tax/USCODE-2024-…-subchapC-partI-subpartA-sec301.txt`
 *   IRC §305   `…-subchapC-partI-subpartA-sec305.txt`      (a split is not income)
 *   IRC §354   `…-subchapC-partIII-subpartB-sec354.txt`    (stock-for-stock, no gain)
 *   IRC §355   `…-subchapC-partIII-subpartB-sec355.txt`    (spin-off, no gain)
 *   IRC §356   `…-subchapC-partIII-subpartB-sec356.txt`    (boot)
 *   IRC §358   `…-subchapC-partIII-subpartB-sec358.txt`    (basis to distributees)
 *   IRC §1223  `…-subchapP-partIII-sec1223.txt`            (holding-period tack-on)
 *   26 CFR §1.358-2 `docs/us-tax/CFR-26-1.358-2-Allocation-Of-Basis-Among-Nonrecognition-Property.txt`
 *
 *   ITAA 1997 Subdiv 124-M (scrip for scrip) and s124-790 (partial roll-over),
 *   Div 125 (demerger relief, s125-80), s104-135 (CGT event G1) and s115-30 —
 *   `docs/au-tax/ITAA-1997/C2026C00324VOL03.txt` and `VOL04.txt`.
 *
 * **The two countries do NOT agree, and the disagreements are the reason this is modelled
 * per country rather than once.** Both are reproduced below at their own call sites:
 *
 *  1. **Boot in a merger.** §356(a)(1) recognizes *the lesser of the realized gain and the
 *     boot*; s124-790 recognizes *the cash minus the part of the cost base attributable to
 *     it*. On the Act's own worked example (Ken, 100 Aim shares, cost base \$2, offered
 *     1 LBZ share worth \$4 plus \$1 cash) Australia assesses \$60 where §356 would
 *     recognize \$100. Neither is an approximation of the other.
 *  2. **Basis after that merger.** §358(a)(1) SUBSTITUTES — old basis, less money received,
 *     plus gain recognized. s124-785(2)/(3) APPORTIONS by market value. Same example:
 *     \$200 of US basis against \$160 of AU basis on the identical share.
 *  3. **The holding period of a spun-off interest.** §1223(1), read with §1223(1)(B) which
 *     expressly treats a §355 distribution as an exchange, TACKS the parent's period onto
 *     the new stock. Australia does not: Div 125 deems nothing, and s115-30's table reaches
 *     only same-asset and *replacement-asset* roll-overs — a demerger is neither. So the
 *     new interest's AU clock starts at the demerger while its US clock does not.
 *     (A scrip-for-scrip merger IS a replacement-asset roll-over, s115-30 item 2, so the
 *     AU clock tacks there. The asymmetry is between the two ACTIONS, not the two countries.)
 *
 * ─── how a size is expressed, and why it is a FRACTION ──────────────────────────────
 *
 * Every action here is sized by a fraction of the position's market value rather than by a
 * dollar amount or a share count. Three reasons, in order of weight:
 *
 *   - it is what the corporate-action notice actually publishes. §1.358-2(a)(2)(iv) allocates
 *     "in proportion to their fair market values" and s125-80(3) asks for a proportion
 *     "reasonable having regard to the market values" — an author transcribing a real
 *     spin-off has the percentage in front of them, not a per-share dollar figure;
 *   - it is mode-agnostic. A scalar sleeve and a unitised position take the same input, so
 *     none of this waits on bonds being securitised;
 *   - it cannot mint or destroy money by arithmetic. A dollar amount authored against a
 *     position whose value has drifted since the scenario was written would.
 *
 * `split` is the one exception, because a ratio is what a split IS.
 */

import { split, reprice, isUnitised, syncHolding, instrumentOf } from './holding-utils.js';
import { auIndexedCostBase, singleAssetTermFields } from './holding-period.js';

/** The kinds §7's table names, minus the two that are not position transforms. */
export const CORPORATE_ACTION_KIND = Object.freeze({
  /** Value-, basis- and holding-period-neutral. §305(a); ITAA97 s130-20 / s109-55 item 9. */
  SPLIT:             'SPLIT',
  /** `symbol` / `name` only. The reason `Security.id` is not the symbol (design 94 §4 rule 3). */
  RENAME:            'RENAME',
  /** §355 / §358(b)(2) / §1.358-2(a)(2)(iv); ITAA97 Div 125 s125-80. */
  SPIN_OFF:          'SPIN_OFF',
  /** §354 / §356 / §358; ITAA97 Subdiv 124-M s124-785, s124-790. Cash-only ⇒ a plain disposal. */
  MERGER:            'MERGER',
  /** §301(c)(2)-(3); ITAA97 s104-135 (CGT event G1). */
  RETURN_OF_CAPITAL: 'RETURN_OF_CAPITAL',
});

const KINDS = new Set(Object.values(CORPORATE_ACTION_KIND));

/** A position's cost base for one country, falling back to the single `costBasis`. */
const basisFor = (h, cc) => +((h?.costBaseByCountry?.[cc] ?? h?.costBasis ?? 0));

/** Scale every per-country cost base by the same factor; null stays null. */
function scaleByCountry(byCountry, factor) {
  if (!byCountry) return null;
  const out = {};
  for (const [cc, v] of Object.entries(byCountry)) out[cc] = +((v ?? 0) * factor).toFixed(2);
  return out;
}

const money = (v) => +(+(v ?? 0)).toFixed(2);

/**
 * Validate and normalize one authored corporate action.
 *
 * Throws rather than skipping, and that is deliberate: a corporate action is authored data
 * with no default, so a malformed one silently ignored would be a scenario that runs to
 * completion having modelled something the author did not write. Compare the synthetic
 * security prefix (design 94 §9.1), which throws on collision for the same reason.
 *
 * @param {object} spec
 * @returns {object} the normalized spec
 */
export function normalizeCorporateAction(spec) {
  if (!spec || !KINDS.has(spec.kind)) {
    throw new Error(`Corporate action: unknown kind '${spec?.kind}' — expected one of ${[...KINDS].join(', ')}.`);
  }
  if (spec.securityId == null || spec.securityId === '') {
    throw new Error(`Corporate action '${spec.kind}': securityId is required — it names the instrument the action happens TO.`);
  }
  if (spec.date == null) {
    throw new Error(`Corporate action '${spec.kind}' on '${spec.securityId}': a date is required; these are dated events, not a state of the world.`);
  }
  const frac = (name, v, { required = true } = {}) => {
    if (v == null) {
      if (!required) return null;
      throw new Error(`Corporate action '${spec.kind}' on '${spec.securityId}': ${name} is required.`);
    }
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`Corporate action '${spec.kind}' on '${spec.securityId}': ${name} must be a fraction in [0,1], got ${v}.`);
    }
    return v;
  };
  switch (spec.kind) {
    case CORPORATE_ACTION_KIND.SPLIT:
      if (!Number.isFinite(spec.ratio) || spec.ratio <= 0) {
        throw new Error(`Corporate action 'SPLIT' on '${spec.securityId}': ratio must be > 0 (2 for a two-for-one, 0.1 for a 1:10 reverse).`);
      }
      break;
    case CORPORATE_ACTION_KIND.RENAME:
      if (spec.symbol == null && spec.name == null) {
        throw new Error(`Corporate action 'RENAME' on '${spec.securityId}': give a symbol, a name, or both.`);
      }
      break;
    case CORPORATE_ACTION_KIND.SPIN_OFF:
      frac('fmvFraction', spec.fmvFraction);
      if (!spec.newSecurity?.id) {
        throw new Error(`Corporate action 'SPIN_OFF' on '${spec.securityId}': newSecurity.id is required — the controlled corporation is a new instrument, and its id is what the new lots name.`);
      }
      break;
    case CORPORATE_ACTION_KIND.MERGER:
      frac('cashFraction', spec.cashFraction);
      if (spec.cashFraction < 1 && !spec.acquirerSecurityId && !spec.newSecurity?.id) {
        throw new Error(`Corporate action 'MERGER' on '${spec.securityId}': a stock leg (cashFraction < 1) needs acquirerSecurityId or newSecurity.`);
      }
      break;
    case CORPORATE_ACTION_KIND.RETURN_OF_CAPITAL:
      frac('fmvFraction', spec.fmvFraction);
      break;
  }
  return spec;
}

/**
 * SPLIT — §305(a) puts no amount in gross income and ITAA97 s109-55 item 9 keeps the
 * original acquisition date, so this is `split()` and nothing else. A no-op on a scalar
 * lot, correctly: there is no count to double.
 *
 * @returns {{position: object, cash: number, tax: null}}
 */
function applySplit(h, spec) {
  return { position: split(h, spec.ratio), cash: 0, tax: null };
}

/**
 * SPIN_OFF — §355 / §358(b)(2) and ITAA97 Div 125.
 *
 * No gain either side, so `tax` is null. What moves is BASIS, apportioned between the
 * parent and the new interest by relative market value — §1.358-2(a)(2)(iv)'s "in
 * proportion to their fair market values" and s125-80(2)-(3)'s proportion "reasonable
 * having regard to the market values", which are the same instruction.
 *
 * The parent is REPRICED, not resized: the holder keeps every share and each share is worth
 * less. Getting that backwards would silently reduce the unit count that §1091's share
 * matching and the drawdown's per-security selection both read.
 *
 * @returns {{position: object, spun: object, cash: number, tax: null}}
 */
function applySpinOff(h, spec, ctx) {
  const f  = spec.fmvFraction;
  const mv = h.marketValue ?? 0;
  const spunValue = money(mv * f);
  if (spunValue <= 0) return { position: h, cash: 0, tax: null };

  const parent = {
    ...reprice(h, money(mv - spunValue)),
    costBasis:         money((h.costBasis ?? 0) * (1 - f)),
    costBaseByCountry: scaleByCountry(h.costBaseByCountry, 1 - f),
  };

  const sec   = spec.newSecurity;
  // A spun-off lot's unit count is its own: real spin-offs distribute a whole number of
  // SpinCo shares per N parent shares, and that ratio has nothing to do with the value
  // ratio. Default 1-for-1, which makes the new price the value ratio times the parent's.
  const perShare = Number.isFinite(spec.unitsPerShare) && spec.unitsPerShare > 0 ? spec.unitsPerShare : 1;
  const units    = isUnitised(h) ? h.units * perShare : null;

  // par-reviewed: CREATES a lot. It is a position in a DIFFERENT instrument, so nothing
  // instrument-level is copied from the parent — every such field comes from `newSecurity`
  // through `instrumentOf`. What IS copied is position-level and required by law: the
  // apportioned basis, and the US holding period.
  const spun = syncHolding({
    // Dated. Two spin-offs of the same instrument out of the same parent lot are rare
    // but expressible, and a colliding lot id is the class of defect design 61's
    // e2e found and no unit test can (`holdings.find(h => h.id === …)` silently picks
    // the first).
    id:          `${h.id}-spin-${sec.id}-${ctx.dateMs}`,
    allocation:  h.allocation,
    // Through `instrumentOf`, not off the lot: the parent's market may live on the
    // security the parent NAMES, and reading past it would give a spun-off lot a market
    // key its parent stopped carrying at step 3 (design 94 §5.2's gate).
    rateKey:     sec.rateKey ?? instrumentOf(h, ctx.securities ?? null).rateKey ?? null,
    securityId:  sec.id,
    label:       sec.name ?? sec.symbol ?? sec.id,
    marketValue: spunValue,
    costBasis:   money((h.costBasis ?? 0) * f),
    costBaseByCountry: scaleByCountry(h.costBaseByCountry, f),
    // §1223(1), with §1223(1)(B) putting a §355 distribution inside it expressly: the
    // parent's period is INCLUDED in the new stock's.
    purchaseDate: h.purchaseDate ?? null,
    // Australia does not tack. Div 125 deems no acquisition time and s115-30's table
    // reaches same-asset and replacement-asset roll-overs only; a demerger is neither, so
    // the AU clock on the new interest starts here. Stamped explicitly rather than left to
    // fall back on `purchaseDate`, because the fallback would silently grant the Div 115
    // discount a year early.
    acquisitionDateByCountry: { ...(h.acquisitionDateByCountry ?? {}), AU: ctx.dateMs },
    // …and the CPI level that AU clock starts at, for design 57's indexation.
    acquisitionPriceLevel: ctx.auPriceLevel,
    ...(units == null ? {} : { units, pricePerUnit: spunValue / units }),
  });

  return { position: parent, spun, cash: 0, tax: null };
}

/**
 * MERGER — §354 / §356 / §358 against ITAA97 Subdiv 124-M.
 *
 * `cashFraction` is the share of the target's value paid in cash. 1.0 is an all-cash
 * acquisition, which is simply a disposal; 0 is pure stock-for-stock, which is tax-free
 * both sides; anything between is BOOT, and boot is where the two countries part company.
 *
 * @returns {{position: object|null, cash: number, tax: object|null}}
 */
function applyMerger(h, spec, ctx) {
  const c    = spec.cashFraction;
  const mv   = h.marketValue ?? 0;
  const cash = money(mv * c);
  const bUs  = basisFor(h, 'US');
  const bAu  = basisFor(h, 'AU');

  // ── US: §356(a)(1) — "the gain … shall be recognized, but in an amount not in excess of
  // the sum of such money and the fair market value of such other property", and §356(c)
  // allows NO loss while the exchange still qualifies. An all-cash deal is not a §354
  // exchange at all, so its loss is an ordinary capital loss and passes through signed.
  const realizedUs = money(mv - bUs);
  const recognizedUs = c >= 1 ? realizedUs : money(Math.min(Math.max(realizedUs, 0), cash));
  // §358(a)(1): substitute the old basis, "decreased by … the amount of any money received"
  // and "increased by … the amount of gain … recognized". NOT an FMV apportionment.
  const newBasisUs = money(bUs - cash + recognizedUs);

  // ── AU: s124-790's ineligible part, on the Act's own worked example. The cost base of
  // the ineligible part is the proportion of the original cost base attributable to the
  // cash, and the gain is the cash less that. Then s124-785(2)-(3): the replacement's cost
  // base is what is left, i.e. an FMV apportionment — which for c = 1 collapses to a plain
  // disposal, and for c = 0 to a full roll-over, both correctly.
  const auBootBasis = money(bAu * c);
  const newBasisAu  = money(bAu - auBootBasis);

  const stockValue = money(mv - cash);
  const keeps = c < 1 && stockValue > 0;

  let position = null;
  if (keeps) {
    const targetId = spec.acquirerSecurityId ?? spec.newSecurity?.id ?? h.securityId;
    // Acquirer shares per target share. Independent of the value ratio for the same reason
    // `unitsPerShare` is in a spin-off — the terms of a deal set it.
    const r = Number.isFinite(spec.exchangeRatio) && spec.exchangeRatio > 0 ? spec.exchangeRatio : 1;
    const units = isUnitised(h) ? h.units * r : null;
    const acquirerRateKey = spec.newSecurity?.rateKey
      ?? ctx.securities?.[targetId]?.rateKey ?? null;
    // A NEW LOT ID whenever the instrument changes, never a relabel of the old one. Design
    // 94 §11's fourth walk (`security-position-identity.test.mjs`) makes that a build
    // failure, and it is right: a lot that keeps its id while changing what it is a
    // position IN reads, forever after, as though it had always been the acquirer's stock
    // — the basis and the date say one thing and the security says another, with no
    // evidence left that they ever agreed. Every number is conserved, which is exactly why
    // nothing else would catch it.
    //
    // A new lot is not a disposal. §354 recognizes no gain and §358 carries the basis over;
    // the position ENDED and another BEGAN holding the same basis and, per §1223(1), the
    // same holding period. That is what the fields below say.
    //
    // par-reviewed: the raw `marketValue` below is the SCALAR answer only. On a unitised
    // position `syncHolding` immediately re-derives it — and `faceValue` with it — from
    // `units x pricePerUnit` and `units x parPerUnit`, both of which are set from the
    // exchange ratio in the same literal, so the two cannot disagree. A scalar lot has no
    // `parPerUnit` for them to disagree ABOUT.
    position = syncHolding({
      ...h,
      ...(targetId === h.securityId ? {} : { id: `${h.id}-merge-${targetId}-${ctx.dateMs}` }),
      securityId:  targetId,
      // The instrument's market moves with it; the position's ALLOCATION does not, because
      // allocation is authoritative and a security may only refine within it (design 94 D5).
      rateKey:     acquirerRateKey ?? instrumentOf(h, ctx.securities ?? null).rateKey ?? null,
      marketValue: stockValue,
      costBasis:   newBasisUs,
      // Stamped whenever the two answers differ, EVEN IF the lot carried no per-country
      // map before. A merger with boot is precisely the event that splits a single basis
      // into two — §358(a)(1) substitutes where s124-785 apportions — so leaving the map
      // null here would silently make the AU return read the US number through
      // `costBaseByCountry?.AU ?? costBasis`, which is a wrong answer, not an unknown one.
      costBaseByCountry: (h.costBaseByCountry || newBasisUs !== newBasisAu)
        ? { ...(h.costBaseByCountry ?? {}), US: newBasisUs, AU: newBasisAu }
        : null,
      // Both clocks tack. §1223(1) on the US side; on the AU side s115-30 item 2, because
      // unlike a demerger a scrip-for-scrip exchange IS a replacement-asset roll-over
      // (Subdiv 124-M sits in Division 124, "Replacement-asset roll-overs").
      ...(units == null ? {} : { units, pricePerUnit: stockValue / units }),
    });
  }

  // Nothing recognized on either side ⇒ no disposal to report. A pure stock-for-stock deal
  // must leave no row in the capital-gains register, which is the whole content of §354.
  if (cash <= 0 && recognizedUs === 0 && auBootBasis === 0) {
    return { position, cash: 0, tax: null };
  }

  return {
    position,
    cash,
    tax: buildDisposal(h, {
      proceeds: cash,
      // The basis attributable to the money, written as `proceeds − recognized` so the two
      // countries' different recognition rules both arrive as one subtraction and the term
      // split below cannot drift from the amount assessed.
      usBasis:  money(cash - recognizedUs),
      auBasis:  auBootBasis,
      // §356(c) / the roll-over: with a stock leg a loss is not available, so it is floored.
      // An all-cash deal is a real disposal and keeps its sign.
      deductibleLoss: c >= 1,
      description: `Merger — ${h.label || h.securityId || h.id}`,
    }, ctx),
  };
}

/**
 * RETURN_OF_CAPITAL — §301(c)(2)-(3) against ITAA97 s104-135 (CGT event G1).
 *
 * The two countries agree here, which is worth stating because they agree on almost nothing
 * else in this file: the payment is not income, it is applied against and reduces basis, and
 * only the excess over basis is a gain "from the sale or exchange of property" (§301(c)(3)(A))
 * / a capital gain with the cost base reduced to nil (s104-135(3)). s104-135's Note 1 —
 * "You cannot make a capital loss" — is the floor both sides already have.
 *
 * @returns {{position: object, cash: number, tax: object|null}}
 */
function applyReturnOfCapital(h, spec, ctx) {
  const mv   = h.marketValue ?? 0;
  const cash = money(mv * spec.fmvFraction);
  if (cash <= 0) return { position: h, cash: 0, tax: null };

  const bUs = basisFor(h, 'US');
  const bAu = basisFor(h, 'AU');
  const appliedUs = money(Math.min(cash, bUs));
  const appliedAu = money(Math.min(cash, bAu));

  // The company paid the money out, so the shares are worth that much less. A PRICE change:
  // the holder's unit count did not move.
  const position = {
    ...reprice(h, money(mv - cash)),
    costBasis:         money(bUs - appliedUs),
    costBaseByCountry: h.costBaseByCountry
      ? { ...h.costBaseByCountry, US: money(bUs - appliedUs), AU: money(bAu - appliedAu) }
      : null,
  };

  // Basis fully absorbed the payment on both sides ⇒ no gain, and so no disposal row.
  if (appliedUs >= cash && appliedAu >= cash) return { position, cash, tax: null };

  return {
    position,
    cash,
    tax: buildDisposal(h, {
      proceeds: cash,
      usBasis:  appliedUs,
      auBasis:  appliedAu,
      // Neither §301(c)(3) nor s104-135(3) can produce a loss — the excess OVER basis is
      // the only thing either recognizes.
      deductibleLoss: false,
      description: `Return of capital — ${h.label || h.securityId || h.id}`,
    }, ctx),
  };
}

/**
 * The gain figures a corporate action's taxable slice contributes, in the shape every
 * `CAPITAL_GAINS` consumer already reads.
 *
 * Returned as data rather than as an action so the reducer keeps the one object literal the
 * static parity scan can see (`disposal-tax-payload-parity.test.mjs` — a payload built
 * behind a helper is invisible to it, which is the failure mode that test exists to stop).
 *
 * @returns {object} gain / auGain / auIndexedGain / auDiscountableGain / term fields
 */
function buildDisposal(h, { proceeds, usBasis, auBasis, deductibleLoss, description }, ctx) {
  const clamp = (v) => (deductibleLoss ? v : Math.max(0, v));
  const gain   = clamp(money(proceeds - usBasis));
  const auGain = clamp(money(proceeds - auBasis));

  const purchasedMs = h.purchaseDate != null ? new Date(h.purchaseDate).getTime() : null;
  const auAcqMs     = h.acquisitionDateByCountry?.AU ?? purchasedMs;

  // Design 57 Part 2: the AU cost base is indexed for CPI before the gain is struck. The
  // slice of basis attributable to THIS event is indexed, not the whole position's — the
  // ratio is what the reform relieves, so it applies to whatever part is being assessed.
  const auIndexedBasis = auIndexedCostBase({
    auBasis,
    acquisitionPriceLevel: h.acquisitionPriceLevel ?? null,
    currentPriceLevel:     ctx.auPriceLevel,
    auAcquisitionMs:       auAcqMs,
    saleMs:                ctx.dateMs,
    cpiRate:               ctx.auCpiRate,
  });
  const auIndexedGain = clamp(money(proceeds - auIndexedBasis));

  const terms = singleAssetTermFields({
    proceeds, usBasis, auBasis,
    acquisitionMs:   purchasedMs,
    auAcquisitionMs: auAcqMs,
    saleMs:          ctx.dateMs,
    deductibleLoss,
  });
  // A capital LOSS is never discountable — Div 115 applies to gains — so the eligible
  // slice floors at zero rather than tracking a negative auGain.
  const auDiscountableGain = Math.max(0, terms.auLongTermGain);

  return {
    gain, auGain, auIndexedGain, auDiscountableGain,
    proceeds: money(proceeds), costBasis: money(usBasis),
    description,
    ...terms,
  };
}

const APPLY = {
  [CORPORATE_ACTION_KIND.SPLIT]:             applySplit,
  [CORPORATE_ACTION_KIND.SPIN_OFF]:          applySpinOff,
  [CORPORATE_ACTION_KIND.MERGER]:            applyMerger,
  [CORPORATE_ACTION_KIND.RETURN_OF_CAPITAL]: applyReturnOfCapital,
};

/**
 * Apply one corporate action to one position.
 *
 * `RENAME` never reaches here — it touches the registry and no position at all, which is
 * exactly why `Security.id` is stable and the symbol is decoration (design 94 §4 rule 3).
 *
 * @param {object} h    - the position (not mutated)
 * @param {object} spec - a normalized corporate action
 * @param {{dateMs:number, auPriceLevel:number, auCpiRate:number,
 *          securities:(Object<string,object>|null)}} ctx
 * @returns {{position: object|null, spun?: object, cash: number, tax: object|null}}
 */
export function applyCorporateAction(h, spec, ctx) {
  const fn = APPLY[spec.kind];
  if (!fn || !h) return { position: h ?? null, cash: 0, tax: null };
  return fn(h, spec, ctx);
}

/**
 * The registry after a `RENAME` or the arrival of a `SPIN_OFF`/`MERGER`'s new instrument.
 *
 * Copy-on-write, because `cloneState` shares `state.securities` BY REFERENCE across every
 * snapshot in the run (design 94 §6.4): writing into the existing map would not change one
 * state, it would retroactively rewrite every state ever recorded. The map is frozen, so
 * the attempt is a strict-mode `TypeError` rather than a silent rewrite — this function is
 * how a corporate action gets its change without meeting that wall.
 *
 * A spin-off is the ONLY path in the engine that adds a security mid-run, which is what
 * §6.4's by-reference sharing was designed against and what makes this the test of it.
 *
 * @param {Object<string,object>|null} securities - `state.securities`
 * @param {object} spec - a normalized corporate action
 * @returns {Array<object>|null} the full spec list for `buildSecurityRegistry`, or null when
 *                               the action does not touch the registry
 */
export function registryPatchFor(securities, spec) {
  const existing = Object.values(securities ?? {});
  if (spec.kind === CORPORATE_ACTION_KIND.RENAME) {
    const target = securities?.[spec.securityId];
    if (!target) return null;
    return existing.map(s => (s.id === spec.securityId
      ? { ...s, ...(spec.symbol == null ? {} : { symbol: spec.symbol }),
              ...(spec.name   == null ? {} : { name:   spec.name }) }
      : s));
  }
  const added = spec.newSecurity;
  if (!added?.id || securities?.[added.id]) return null;
  return [...existing, added];
}
