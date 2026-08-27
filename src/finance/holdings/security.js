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
 * Security — the INSTRUMENT a position is held in (design 94 §4).
 *
 * A holding is a POSITION: how many units, at what basis, acquired when. A Security is what
 * the position is IN: what market it tracks, what it pays, how it is taxed. Under Option A
 * those instrument fields sit inline on every lot; a Security lets many lots — in different
 * accounts, with different bases and different acquisition dates — name one shared record.
 *
 * ─── three rules this entity is built around ────────────────────────────────────────
 *
 * **1. It is PLAIN DATA and it is FROZEN.** Design 25's rule is that state holds no derived
 * getters, because `deepClone` drops prototypes and state is cloned by history, the journal
 * and MPC injection. This goes further: the registry is shared BY REFERENCE across every
 * snapshot in a run (design 94 §6.4, `cloneState`), which is only safe because nothing can
 * write to it in place. `Object.freeze` turns a violation into a loud `TypeError` in strict
 * mode instead of a silent rewrite of every past snapshot — the journal live-alias defect,
 * pre-empted rather than debugged.
 *
 * **2. Absent is not null.** `instrumentOf` merges `{ ...holding, ...security }`, so any key
 * PRESENT on the security wins — including one holding an explicit `null`. That is why the
 * constructor writes a field only when it was actually given: a Security declares what it
 * knows and says nothing about the rest, and a migrated lot carrying inline fields keeps
 * them for everything its security is silent about. It is design 93 §5a's discipline
 * ("no existing payload gains a field") turned into the merge rule.
 *
 * **3. `id` is stable; `symbol` is decoration.** A symbol change is a corporate action
 * (design 94 §7). If the symbol were the key, a rename would orphan every lot that named it.
 *
 * ─── what is deliberately NOT here ──────────────────────────────────────────────────
 *
 * - **A price.** Two accounts holding the same security are two positions at two bases, and
 *   `pricePerUnit` lives on the position. Design 94 §4 has the two independent reasons —
 *   a per-period-mutable field would forfeit rule 1's by-reference sharing, and a shared
 *   price would silently delete design 55 §8's per-account growth-rate seeding.
 * - **An `assetKind`.** `ALLOCATION` is the closed, authoritative four-value enum the
 *   rebalancer, glidepath, drawdown and the reporting cube are built on (design 90 §7.3),
 *   and this repo has been bitten twice by a second classifier drifting from the first. A
 *   security names the MARKET it tracks (`rateKey`); the holding keeps its allocation; and
 *   `assertAllocationMatch` checks the pair against the containment guard that already
 *   exists for exactly this job.
 */

import { CLASS_KEYS_BY_ALLOCATION } from './default-allocations.js';
import { RATE_KEYS, EQUITY_SLEEVES }  from '../economic-regimes/rate-keys.js';

/**
 * Every field a Security may carry, in design 94 §5.1's INSTRUMENT column order.
 *
 * A list rather than a constructor body full of `??` defaults, because rule 2 above means
 * the write must be conditional on the key being GIVEN — and a default would defeat that by
 * making every security declare every field.
 */
export const SECURITY_FIELDS = Object.freeze([
  // identity
  'symbol', 'name',
  // the return process (design 94 §6.2)
  'rateKey', 'beta', 'idioVol',
  // distributions and their character
  'dividendYield', 'qualifiedDividends', 'frankingCredit',
  // where it lives, for source and currency rules (design 73 / design 87)
  'currency', 'country',
  // tax attributes
  'taxExemption', 'issuingState', 'isGold',
  // §1091 "substantially identical" — design 94 §8.1c
  'identityGroup',
  // bond instrument fields (design 94 §5.1); absent on an equity security
  'parPerUnit', 'couponRate', 'couponFrequency', 'maturityDate', 'duration',
  'zeroCoupon', 'inflationLinked',
]);

/**
 * A frozen, plain-data instrument record.
 *
 * @param {object} spec
 * @param {string} spec.id - stable; what `Holding.securityId` names
 * @returns {Readonly<object>} the security — frozen, and carrying only the fields given
 */
export function makeSecurity(spec = {}) {
  if (spec.id == null || spec.id === '') {
    throw new Error('Security: `id` is required and is what Holding.securityId names.');
  }
  const out = { id: spec.id };
  for (const f of SECURITY_FIELDS) {
    // `in`, not `!= null`: an explicit null is a DECLARATION that the instrument has no
    // such attribute, and it must override a migrated lot's stale inline value. Only a
    // key that was never given is silence. See rule 2 in the file header.
    if (f in spec) out[f] = spec[f];
  }
  return Object.freeze(out);
}

/**
 * Build the run-time registry: `id → frozen Security`, itself frozen.
 *
 * The freeze is not decoration. `cloneState` shares this object by reference across every
 * history snapshot and every journal clone in the run (design 94 §6.4), so an in-place write
 * would not corrupt one state — it would retroactively rewrite every state ever recorded.
 *
 * @param {Array<object>|Object<string,object>|null} securities
 * @returns {Readonly<Object<string,Readonly<object>>>}
 */
export function buildSecurityRegistry(securities) {
  const list = Array.isArray(securities)
    ? securities
    : Object.values(securities ?? {});
  const out = {};
  for (const spec of list) {
    if (!spec) continue;
    const sec = spec.__frozenSecurity === true ? spec : makeSecurity(spec);
    if (out[sec.id]) {
      throw new Error(`Security: duplicate id '${sec.id}' — ids are what lots name, so they must be unique.`);
    }
    out[sec.id] = sec;
  }
  return Object.freeze(out);
}

/**
 * A security's `rateKey` must live inside its holding's ALLOCATION class.
 *
 * This is the guard `resolveRateKey` already applies (`default-allocations.js`), reused
 * rather than re-implemented — it is what stops a BOND sleeve in a `us-stock` brokerage
 * resolving to an equity series, and it does the same job here in the other direction: it
 * stops a lot allocated BOND from naming an equity security and silently taking equity
 * shocks. Design 94 D5 is the decision this enforces — no second classifier.
 *
 * @param {string} allocation - the HOLDING's allocation
 * @param {object} security   - the security it names
 * @throws when the pair is incoherent
 */
export function assertAllocationMatch(allocation, security) {
  const rateKey = security?.rateKey;
  if (rateKey == null) return;                     // a security may decline to name a market
  const legal = CLASS_KEYS_BY_ALLOCATION[allocation];
  if (!legal) return;                              // GOLD / OTHER carry no class table
  if (!legal.has(rateKey)) {
    throw new Error(
      `Security '${security.id}': rateKey '${rateKey}' is not inside ALLOCATION.${allocation}'s class. `
      + `A position's allocation is authoritative (design 90 §7.3); a security may only refine WITHIN it.`
    );
  }
}

/**
 * The §1091 "substantially identical" group a position belongs to (design 94 §8.1c).
 *
 * `identityGroup` if the instrument declares one, otherwise the security's own id — a
 * security is always substantially identical to itself, and that is the only relation the
 * sources actually supply. Two DIFFERENT securities are related only when an author says
 * so, because Pub. 550's test is facts and circumstances and its one anchor (different
 * issuers are *ordinarily* not identical) does not reach the case that matters here: two
 * funds tracking one index. Deriving the relation from `rateKey` would be the same
 * assumption, unlabelled — and it is the assumption `resolveSubstitute` was making silently.
 *
 * **Null for an un-securitised lot**, and deliberately: a lot that names no instrument makes
 * no claim about identity, so it matches nothing rather than matching everything with its
 * rate key.
 *
 * @param {object} holding
 * @param {Object<string,object>|null} [securities]
 * @returns {string|null}
 */
export function identityGroupOf(holding, securities = null) {
  if (holding?.securityId == null) return null;
  const inst = securities?.[holding.securityId];
  return inst?.identityGroup ?? holding.securityId;
}

/**
 * The id a MIGRATED equity lot names: one synthetic security per market (design 94 §9.1).
 *
 * Reserved prefix. An authored scenario security may not use it — `buildSecurityRegistry`
 * throws on the collision, which is the right answer: the synthetic set is the migration's
 * own, and an authored record shadowing one would silently change what every un-securitised
 * lot in that market resolves to.
 */
export const SYNTHETIC_SECURITY_PREFIX = 'sec-auto-';

/**
 * `EQUITY_US` → `sec-auto-EQUITY_US`, and **null for anything that is not a market key**.
 *
 * Derived rather than looked up, so a birth site far from the loader can name the right
 * security without carrying the registry — but bounded by `EQUITY_SLEEVES`, because the
 * synthetic registry holds exactly those four. Minting an id from an arbitrary rateKey
 * would hand the lot a `securityId` that resolves to nothing, and `instrumentOf` would
 * fall back to the lot silently — Option A wearing Option C's field.
 */
export const syntheticSecurityId = rateKey =>
  (EQUITY_SLEEVES.includes(rateKey) ? `${SYNTHETIC_SECURITY_PREFIX}${rateKey}` : null);

/** Display names for the four synthetic market securities. Decoration only — see rule 3. */
const SYNTHETIC_MARKET_NAME = Object.freeze({
  [RATE_KEYS.EQUITY_US]:         'US market index',
  [RATE_KEYS.EQUITY_AU]:         'Australian market index',
  [RATE_KEYS.EQUITY_INTL_EX_US]: 'International ex-US market index',
  [RATE_KEYS.EQUITY_INTL_EX_AU]: 'International ex-AU market index',
});

/**
 * The four synthetic market securities every migrated equity lot resolves through.
 *
 * **β = 1.0 and idioVol = 0 — the IDENTITY, deliberately.** The first pass of design 94
 * §9.1 wrote `beta: DEFAULT_EQUITY_BETA[rateKey]` and that would double-count: the market
 * beta is already applied inside the sleeve deviation `EquityReturnTickHandler` computes,
 * and design 94 §6.2's per-security overlay is defined RELATIVE to the sleeve. A synthetic
 * security must therefore add nothing, and `(β − 1) = 0` with no idiosyncratic vol is what
 * makes it add nothing. Step 4's price path reads these; until then they are inert.
 *
 * **All four, always, whether or not the scenario holds them.** A lot is born mid-run —
 * a rebalance buy, a reinvested dividend, an inherited brokerage funded at death — in
 * whatever market `resolveRateKey` gives it, which is not confined to the markets held at
 * boot. Minting from the boot portfolio would leave those lots naming a security that is
 * not in the registry, i.e. silently back on Option A. Four frozen records shared by
 * reference across every snapshot cost nothing (design 94 §6.4).
 *
 * @returns {Array<Readonly<object>>}
 */
export function syntheticEquitySecurities() {
  return EQUITY_SLEEVES.map(rateKey => makeSecurity({
    id:      syntheticSecurityId(rateKey),
    symbol:  '',
    name:    SYNTHETIC_MARKET_NAME[rateKey] ?? `${rateKey} index`,
    rateKey,
    beta:    1.0,
    idioVol: 0,
  }));
}

/**
 * The registry a SCENARIO resolves to: the four synthetic market securities, then
 * whatever it authored (design 94 §9.1).
 *
 * Extracted at step 9 because there is now a second caller. `ScenarioLoader` builds this
 * to project `state.securities`; the account editor's security picker has to offer the
 * SAME set, and a picker composed slightly differently would offer instruments the run
 * does not have — or, worse, silently omit the synthetics and make every existing lot
 * look unassigned. `state.people` drifted into three projections in this repo for exactly
 * that reason; one call site is how that stops happening again.
 *
 * Note the ORDER: authored securities come second and may not collide, because
 * `buildSecurityRegistry` throws on a duplicate id. The `sec-auto-` prefix is reserved
 * rather than shadowable — an authored record shadowing a synthetic would silently change
 * what every un-securitised lot in that market resolves to.
 *
 * @param {object|null} cfg - a scenario record; only `cfg.securities` is read
 * @returns {Readonly<Object<string,Readonly<object>>>}
 */
export function scenarioSecurityRegistry(cfg) {
  const authored = Array.isArray(cfg?.securities) ? cfg.securities : [];
  return buildSecurityRegistry([...syntheticEquitySecurities(), ...authored]);
}
