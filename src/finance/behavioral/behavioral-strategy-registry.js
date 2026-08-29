/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { TaxLossHarvestHandler }                from './tax-loss-harvest-handler.js';
import { TaxGainHarvestHandler }               from './tax-gain-harvest-handler.js';
import { StockHarvestApplyReducer }            from './stock-harvest-apply-reducer.js';
import { DownturnRothConversionReducer }       from './downturn-roth-conversion-reducer.js';
import { StrategicAssetLocationReducer }       from './strategic-asset-location-reducer.js';
import { AssetLocationRebalanceApplyReducer }  from './asset-location-rebalance-apply-reducer.js';
import { OpportunisticRebalanceReducer }       from './opportunistic-rebalance-reducer.js';
import { OpportunisticRebalanceApplyReducer }  from './opportunistic-rebalance-apply-reducer.js';
import { PanicSellReducer }                    from './panic-sell-reducer.js';
import { BehavioralPanicSellApplyReducer }     from './behavioral-panic-sell-apply-reducer.js';
import { ContributionSuspensionToggleReducer } from './contribution-suspension-toggle-reducer.js';
import { CashBucketDrawdownReducer }           from './cash-bucket-drawdown-reducer.js';
import { RebalanceToTargetReducer, TAX_ADVANTAGED_ROLES, TAXABLE_ROLES, ALLOCATION_SCHEDULE, ALLOCATION_LOCATION, countryForRole, assertAuthoredMixes } from './rebalance-to-target-reducer.js';
import { RebalanceToTargetApplyReducer }       from './rebalance-to-target-apply-reducer.js';
import { BondLadderReducer }                   from './bond-ladder-reducer.js';
import { ACCOUNT_ROLES }                       from '../state/account-roles.js';
import {
  ALLOCATION_OPTIMIZED_MODE, synthesizeTargetAllocation, presentAllocations,
  buildAllocWeightSchema, DEFAULT_ALLOC_WEIGHTS,
} from '../../scenarios/intl-retirement-scenario.js';

/**
 * Registry of pluggable behavioral strategies (design/29).
 *
 * Each entry exposes:
 *   handlers(context)   → HandlerEntry[] to add to the simulation
 *   reducers(context)   → Reducer[] to add to the simulation
 *   paramSchema()       → paramSchema entries contributed by this strategy
 *
 * Selected via parameters.behavioralStrategies: string[] (EnumMulti).
 * Strategies are mutually independent — no cross-strategy registry coordination.
 * The toolset flatMaps the selected strategies, exactly like design-26 pattern.
 */
export const BEHAVIORAL_STRATEGY_REGISTRY = {

  PANIC_SELL: {
    handlers: (_context) => [],
    reducers: (context) => {
      const p = context.parameters;
      const allAccounts = (context.accounts ?? []).map(a => ({ stateKey: a.stateKey, role: a.role }));
      return [
        new PanicSellReducer({ allAccounts, panicFraction: p.panicFraction ?? 0.30 }),
        new BehavioralPanicSellApplyReducer(),
      ];
    },
    paramSchema: () => [
      {
        key: 'panicFraction', label: 'Panic Sell Fraction',
        type: 'Number', group: 'Behavioral', mc: false, opt: true,
        defaultValue: 0.30,
        description: 'Fraction of EQUITY holdings rotated to CASH on PANIC_SELL_TRIGGER regime entry (design/29 §3.1). Multiplied by regime severity.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'PANIC_SELL' },
      },
    ],
  },

  CONTRIBUTION_SUSPENSION: {
    handlers:    (_context) => [],
    reducers:    (_context) => [new ContributionSuspensionToggleReducer()],
    paramSchema: ()         => [],
  },

  TAX_LOSS_HARVEST: {
    handlers: (context) => {
      const p = context.parameters;
      const taxableStateKeys = _taxableStateKeys(context);
      const handler = new TaxLossHarvestHandler({
        taxableStateKeys,
        // Null, not 3000 — design 94 §8.1h. The \$3,000 was a "US deduction cap proxy",
        // but §1211(b) is enforced downstream and correctly: `_computeCapitalLossLimitation`
        // nets by character, allows ORDINARY_CAPITAL_LOSS_CAP against ordinary income and
        // carries the rest forward under §1212(b). Capping the HARVEST at the same figure
        // limited it twice, in the wrong place — the strategy could never build the
        // carryforward that is most of its value. The param survives as a POLICY cap for a
        // household that does not want to sell more than \$X; it is no longer a
        // statutory-looking default that silently duplicates the statute.
        taxLossHarvestCap: p.taxLossHarvestCap ?? null,
      });
      // Wire to the TAX_LOSS_HARVEST scheduled event
      const evt = context.schedulesById?.['TAX_LOSS_HARVEST'];
      if (evt) handler.handledEvents.push(evt);
      return [handler];
    },
    reducers: (_context) => [new StockHarvestApplyReducer()],
    paramSchema: () => [
      {
        key: 'taxLossHarvestCap', label: 'TLH Cap ($/yr)',
        type: 'Number', group: 'Behavioral', mc: false, opt: true,
        defaultValue: null,
        description: 'Optional POLICY cap on how much loss to realize per year — blank (the default) = no cap. '
          + 'It is deliberately NOT the $3,000 figure any more (design 94 §8.1h): that is §1211(b)\'s limit on '
          + 'capital loss deductible against ORDINARY income, it is already applied on the return along with the '
          + '§1212(b) carryforward, and capping the harvest at it limited the same loss twice — so the strategy '
          + 'could never accumulate the carryforward that is most of what it is for. Set it only if the household '
          + 'genuinely will not sell more than this in a year.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'TAX_LOSS_HARVEST' },
      },
      {
        key: 'taxLossHarvestOnRegimeEntry', label: 'TLH on Regime Entry',
        type: 'Boolean', group: 'Behavioral', mc: false, opt: true,
        defaultValue: true,
        description: 'Also trigger tax-loss harvesting on PANIC_SELL_TRIGGER regime entry, not just at year-end',
        visibleWhen: { param: 'behavioralStrategies', includes: 'TAX_LOSS_HARVEST' },
      },
    ],
  },

  STRATEGIC_ASSET_LOCATION: {
    handlers: (_context) => [],
    reducers: (context) => {
      const p = context.parameters;
      const TAX_ADV_ROLES = new Set([
        ACCOUNT_ROLES.K401, ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.ROTH, ACCOUNT_ROLES.SUPER,
      ]);
      const taxAdvantaged = (context.accounts ?? [])
        .filter(a => TAX_ADV_ROLES.has(a.role))
        .map(a => ({ stateKey: a.stateKey, role: a.role }));
      const policy = p.assetLocationPolicy ?? undefined;
      return [
        new StrategicAssetLocationReducer({ taxAdvantaged, ...(policy ? { assetLocationPolicy: policy } : {}) }),
        new AssetLocationRebalanceApplyReducer(),
      ];
    },
    paramSchema: () => [
      {
        key: 'assetLocationPolicy', label: 'Asset Location Policy',
        type: 'LocationPolicy', group: 'Behavioral', mc: false, opt: true,
        defaultValue: null,
        description: 'Map of allocation → preferred account roles for tax-advantaged placement. E.g. {"BOND":["ira","k401"],"EQUITY":["roth-ira"]}. Null = use defaults.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'STRATEGIC_ASSET_LOCATION' },
      },
    ],
  },

  OPPORTUNISTIC_REBALANCE: {
    handlers: (_context) => [],
    reducers: (context) => {
      const p = context.parameters;
      const TAX_ADV_ROLES = new Set([
        ACCOUNT_ROLES.K401, ACCOUNT_ROLES.IRA, ACCOUNT_ROLES.ROTH, ACCOUNT_ROLES.SUPER,
      ]);
      const taxAdvantaged = (context.accounts ?? [])
        .filter(a => TAX_ADV_ROLES.has(a.role))
        .map(a => ({ stateKey: a.stateKey, role: a.role }));
      return [
        new OpportunisticRebalanceReducer({
          taxAdvantaged,
          targetAllocation:  p.rebalanceTargetAllocation ?? { EQUITY: 0.60, BOND: 0.40 },
          rebalanceDriftBand: p.rebalanceDriftBand ?? 0.05,
        }),
        new OpportunisticRebalanceApplyReducer(),
      ];
    },
    paramSchema: () => [
      {
        key: 'rebalanceTargetAllocation', label: 'Rebalance Target Allocation',
        type: 'MixList', group: 'Behavioral', mc: false, opt: true,
        defaultValue: null,
        description: 'Target allocation fractions for opportunistic rebalance. E.g. {"EQUITY":0.60,"BOND":0.40}. Null = 60/40 default.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'OPPORTUNISTIC_REBALANCE' },
      },
      {
        key: 'rebalanceDriftBand', label: 'Rebalance Drift Band',
        type: 'Number', group: 'Behavioral', mc: false, opt: true,
        defaultValue: 0.05,
        description: 'Allocation drift threshold that triggers a rebalance (default 0.05 = 5 percentage points)',
        visibleWhen: { param: 'behavioralStrategies', includes: 'OPPORTUNISTIC_REBALANCE' },
      },
    ],
  },

  // Design 61 — holding-allocation lever. A NEW strategy beside OPPORTUNISTIC_REBALANCE
  // (they coexist, §OQ5): to study the allocation lever alone, select TARGET_ALLOCATION
  // and leave the legacy reactive strategies unselected. Byte-identical golden when
  // unselected (no reducer added). When selected with allocationStrategy=OPTIMIZED, the
  // target mix is synthesized from the continuous `allocWeight::<CLASS>` params
  // (stick-breaking) the solver searches; STATIC falls back to the Object param.
  //
  // Phase 2 (Lever C): the RebalanceToTargetReducer/ApplyReducer pair rebalances BOTH
  // tax-advantaged (free) AND taxable (CGT-realizing) accounts, establishes new sleeves
  // (the §6 buy primitive), honors the US-IRA gold guard (§OQ4a), and uses split drift
  // bands (taxable wide / sheltered tight, §OQ3).
  TARGET_ALLOCATION: {
    handlers: (_context) => [],
    reducers: (context) => {
      const p = context.parameters;
      // Design 61 §12.2 Q3 — validate every AUTHORED mix here, at the boundary where
      // scenario params become reducer config. Throws (no shim) on a partial mix or a
      // non-unit sum: an absent key is indistinguishable from a deliberate 0, and that
      // difference decides whether a class is held or liquidated.
      assertAuthoredMixes(p);
      const accounts = (context.accounts ?? [])
        .filter(a => TAX_ADVANTAGED_ROLES.has(a.role) || TAXABLE_ROLES.has(a.role))
        .map(a => ({ stateKey: a.stateKey, role: a.role }));
      const target = (p.allocationStrategy === ALLOCATION_OPTIMIZED_MODE)
        ? synthesizeTargetAllocation(p, presentAllocations(context.accounts))
        : (p.rebalanceTargetAllocation ?? DEFAULT_ALLOC_WEIGHTS);
      return [
        new RebalanceToTargetReducer({
          accounts,
          targetAllocation:   target,
          driftBandTaxable:   p.rebalanceDriftBandTaxable   ?? 0.10,
          driftBandSheltered: p.rebalanceDriftBandSheltered ?? 0.02,
          // Lever B time variation (design 61 §4-B). STATIC default ⇒ target unchanged.
          scheduleMode:  p.allocationSchedule ?? ALLOCATION_SCHEDULE.STATIC,
          glidepath:     p.allocationGlidepath ?? null,
          regimeTargets: p.allocationRegimeTargets ?? null,
          // Lever D location (design 61 §4-D). LOCATED (default) places each class in
          // its tax-favored account; PER_ACCOUNT drives every account to the uniform mix.
          locationMode:   p.allocationLocation ?? ALLOCATION_LOCATION.LOCATED,
          locationPolicy: p.allocationLocationPolicy ?? null,
          // Design 97 §9 — YEARS_OF_SPEND pools. Absent ⇒ null ⇒ the mode falls back to the
          // authored target, so selecting the mode without sizing a pool is inert rather
          // than a zero-reserve plan.
          poolYears: (Number.isFinite(p.poolCashYears) || Number.isFinite(p.poolBondYears))
            ? { CASH: p.poolCashYears ?? 0, BOND: p.poolBondYears ?? 0 }
            : null,
          // What `state.monthlyExpenses` is a price IN — the same param the expense handler
          // reads. Passed rather than re-derived so the target and the debit cannot disagree
          // about the currency of the spend line.
          expensesCurrency: p.monthlyExpensesCurrency ?? 'RESIDENCE',
        }),
        new RebalanceToTargetApplyReducer(),
      ];
    },
    paramSchema: () => [
      {
        key: 'poolCashYears', label: 'Cash Pool (years of spend)',
        type: 'Number', group: 'Behavioral', mc: false, opt: true,
        defaultValue: null,
        description: 'YEARS_OF_SPEND only (design 97 §9). Size of the CASH pool as a number of '
          + 'years of CURRENT annual spending, resolved every period against the live, inflated '
          + 'spend line rather than authored as a percentage. A percentage cannot hold a number '
          + 'of years: measured on the reference plan a fixed BOND percentage ran 3.5 years of '
          + 'cover in 2027 to 13.6 by 2042 with no crash, and fell to 4.5 with one — it '
          + 'over-provisions as the book grows and under-provisions after a crash, which is '
          + 'inverted from what a reserve is for. Blank ⇒ the mode falls back to the authored mix.',
        visibleWhen: { param: 'allocationSchedule', equals: 'YEARS_OF_SPEND' },
      },
      {
        key: 'poolBondYears', label: 'Bond Pool (years of spend)',
        type: 'Number', group: 'Behavioral', mc: false, opt: true,
        defaultValue: null,
        description: 'YEARS_OF_SPEND only (design 97 §9). Size of the BOND pool in years of current '
          + 'annual spending. Filled after the cash pool and before gold, with EQUITY taking whatever '
          + 'is left — so a book too small for both pools ends up all cash and no equity rather than a '
          + 'shrunken copy of a mix it cannot afford. NOTE this sizes the MIX, not where it sits: with '
          + 'the default LOCATED policy bonds go to the tax-favoured wrappers, which for a pre-60 '
          + 'household are age-gated and are not cover for anyone. For accessible cover, also author '
          + 'allocationLocationPolicy with the taxable roles first for BOND and CASH.',
        visibleWhen: { param: 'allocationSchedule', equals: 'YEARS_OF_SPEND' },
      },
      {
        key: 'allocationStrategy', label: 'Allocation Strategy',
        type: 'Enum', group: 'Allocation', mc: false, opt: false,
        options: ['STATIC', ALLOCATION_OPTIMIZED_MODE], defaultValue: 'STATIC',
        description: 'STATIC uses the fixed Rebalance Target Allocation object; OPTIMIZED synthesizes ' +
          'the target mix from the continuous Allocation Weight params the solver can search (design 61 §4-A).',
        visibleWhen: { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' },
      },
      {
        key: 'rebalanceDriftBandTaxable', label: 'Rebalance Drift Band — Taxable',
        type: 'Number', group: 'Allocation', mc: false, opt: true,
        min: 0.02, max: 0.20, step: 0.01, defaultValue: 0.10,
        description: 'Allocation drift (fraction) that triggers a rebalance in a TAXABLE brokerage ' +
          'account. Defaults WIDE (0.10) — a wide band beats annual/tight by realizing far less CGT ' +
          'for marginal tracking gain (design 61 §OQ3).',
        visibleWhen: { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' },
      },
      {
        key: 'rebalanceDriftBandSheltered', label: 'Rebalance Drift Band — Sheltered',
        type: 'Number', group: 'Allocation', mc: false, opt: true,
        min: 0.01, max: 0.20, step: 0.01, defaultValue: 0.02,
        description: 'Allocation drift (fraction) that triggers a rebalance in a tax-advantaged ' +
          '(401k/IRA/Roth/Super) account. Defaults TIGHT (0.02) — rebalancing there is ~free, so ' +
          'tight banding buys the best risk control at no tax cost (design 61 §OQ3).',
        visibleWhen: { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' },
      },
      // Lever B — how the target mix varies over time (design 61 §4-B / Phase 3).
      {
        key: 'allocationSchedule', label: 'Allocation Schedule',
        type: 'Enum', group: 'Allocation', mc: false, opt: false,
        options: [ALLOCATION_SCHEDULE.STATIC, ALLOCATION_SCHEDULE.GLIDEPATH,
                  ALLOCATION_SCHEDULE.REGIME_CONDITIONED, ALLOCATION_SCHEDULE.YEARS_OF_SPEND],
        defaultValue: ALLOCATION_SCHEDULE.STATIC,
        description: 'How the target mix changes over the plan. STATIC = one mix for the whole run ' +
          '(default). GLIDEPATH = interpolate between {age, weights} anchors by age (e.g. equity ' +
          '80%→40% from 50→75). REGIME_CONDITIONED = a distinct mix per active economic-regime tag ' +
          '(the "shift to bonds/gold in a downturn" lever). YEARS_OF_SPEND = size the CASH and BOND ' +
          'pools as N years of CURRENT spending and let EQUITY take the residual (design 97 §9) — ' +
          'the only mode in which a plan authored as "2 years of cash, 4 years of bonds" still is ' +
          'that in twenty years; every other mode states a percentage, and a percentage drifts to ' +
          'roughly 4x its authored cover over a long horizon.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' },
      },
      {
        key: 'allocationGlidepath', label: 'Allocation Glidepath',
        type: 'AllocationGlidepath', group: 'Allocation', mc: false, opt: true,
        defaultValue: null,
        description: 'GLIDEPATH anchors: an array of { age, weights } where weights is a mix map, e.g. ' +
          '[{"age":50,"weights":{"EQUITY":0.8,"BOND":0.2}},{"age":75,"weights":{"EQUITY":0.4,"BOND":0.6}}]. ' +
          'The target is linearly interpolated by the primary\'s age. Null ⇒ falls back to the static mix.',
        visibleWhen: [
          { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' },
          { param: 'allocationSchedule',   equals:   ALLOCATION_SCHEDULE.GLIDEPATH },
        ],
      },
      {
        key: 'allocationRegimeTargets', label: 'Allocation Regime Targets',
        type: 'AllocationRegimeTargets', group: 'Allocation', mc: false, opt: true,
        defaultValue: null,
        description: 'REGIME_CONDITIONED targets: a map of regime tag → mix, e.g. ' +
          '{"NORMAL":{"EQUITY":0.6,"BOND":0.4},"ECONOMIC_STRESS":{"EQUITY":0.3,"BOND":0.3,"CASH":0.2,"GOLD":0.2}}. ' +
          'The active regime\'s mix applies (NORMAL when no stress). Null ⇒ falls back to the static mix.',
        visibleWhen: [
          { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' },
          { param: 'allocationSchedule',   equals:   ALLOCATION_SCHEDULE.REGIME_CONDITIONED },
        ],
      },
      // Lever D — how the portfolio target is placed across accounts (design 61 §4-D).
      {
        key: 'allocationLocation', label: 'Allocation Location',
        type: 'Enum', group: 'Allocation', mc: false, opt: false,
        options: [ALLOCATION_LOCATION.LOCATED, ALLOCATION_LOCATION.PER_ACCOUNT],
        defaultValue: ALLOCATION_LOCATION.LOCATED,
        description: 'How the whole-portfolio target mix is placed across accounts. LOCATED (default) ' +
          'concentrates each class in its tax-favored account — bonds in tax-deferred (IRA/401k), equity ' +
          'in Roth/taxable, gold in a shelter (AU super; never a US IRA/401k/Roth) — so the aggregate ' +
          'book hits the mix while accounts specialize. PER_ACCOUNT drives every account to the same ' +
          'uniform mix (simpler; a manual escape hatch).',
        visibleWhen: { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' },
      },
      {
        key: 'allocationLocationPolicy', label: 'Allocation Location Policy',
        type: 'LocationPolicy', group: 'Allocation', mc: false, opt: true,
        defaultValue: null,
        description: 'LOCATED placement policy: a map of allocation → preferred account roles (in order), ' +
          'e.g. {"BOND":["ira","k401"],"EQUITY":["roth-ira","us-stock"]}. Preference is soft (spills when ' +
          'full); the US-IRA/401k/Roth gold ban is always enforced. Null ⇒ the jurisdiction-aware default.',
        // Gate on the lever being selected AND LOCATED — without the first clause this
        // leaked into every scenario because allocationLocation defaults to LOCATED.
        visibleWhen: [
          { param: 'behavioralStrategies', includes: 'TARGET_ALLOCATION' },
          { param: 'allocationLocation',   equals:   ALLOCATION_LOCATION.LOCATED },
        ],
      },
      ...buildAllocWeightSchema(),
    ],
  },

  // Design 66 §G8 (Phase C) — bond-ladder length lever. A NEW opt-in strategy: when
  // selected it materializes a self-perpetuating N-rung ladder in a designated account
  // (default the taxable brokerage) from that account's BOND value, and re-shapes it
  // when the searchable `bondLadderRungs` changes. The rung count is held on the
  // reducer instance, so the optimizer searches it (compile branch) and the MPC cockpit
  // re-wires it live (design 66 §10.6). Byte-identical golden when unselected (no
  // reducer constructed). Sibling of TARGET_ALLOCATION.
  BOND_LADDER: {
    handlers: (_context) => [],
    reducers: (context) => {
      const p = context.parameters;
      // `bondLadderRole` is a role, a LIST of roles, or 'ALL'. Every account whose role
      // matches gets its own ladder — not just the first. A household routinely holds
      // several accounts in one role (five `us-stock` accounts is ordinary), and a
      // single `.find` laddered exactly one of them while every other bond sleeve
      // stayed a perpetual fund. Same class of defect as the earnings handlers that
      // resolved a role to one account (design 55 §13).
      // `bondLadderRole` is 'ALL', one role, or a LIST of roles (the UI writes a list).
      // 'ALL' anywhere in the list means all — a list is how the multi-select expresses
      // itself, so `['ALL']` has to mean what the bare string 'ALL' means; reading it as
      // a role named "ALL" matched nothing and silently laddered the default account
      // instead. An EMPTY selection is the same as absent: the documented default role.
      const want   = p.bondLadderRole ?? ACCOUNT_ROLES.US_STOCK;
      const wanted = (Array.isArray(want) ? want : [want]).filter(r => r != null && r !== '');
      const roles  = wanted.includes('ALL') ? null
        : new Set(wanted.length ? wanted : [ACCOUNT_ROLES.US_STOCK]);
      let accts = (context.accounts ?? []).filter(a => roles == null || roles.has(a.role));
      // Back-compat: a role that matches nothing falls back to the taxable brokerage,
      // exactly as before, so an existing scenario naming an absent role is unchanged.
      if (!accts.length && roles != null) {
        accts = (context.accounts ?? []).filter(a => a.role === ACCOUNT_ROLES.US_STOCK);
      }
      if (!accts.length) return []; // no account to ladder ⇒ inert
      return accts.map(acct => new BondLadderReducer({
        stateKey:        acct.stateKey,
        country:         countryForRole(acct.role),
        targetRungs:     p.bondLadderRungs        ?? 5,
        spacingYears:    p.bondLadderSpacingYears ?? 1,
        roll:            p.bondLadderRoll         ?? true,
        taxExemption:    p.bondLadderTaxTreatment ?? 'state',
        inflationLinked: p.bondLadderInflationLinked ?? false,
        couponRate:      p.bondLadderCouponRate ?? null,
      }));
    },
    paramSchema: () => [
      {
        key: 'bondLadderRungs', label: 'Bond Ladder Length (rungs)',
        type: 'Number', group: 'Allocation', mc: false, opt: true,
        min: 2, max: 15, step: 1, defaultValue: 5,
        description: 'Number of rungs in the bond ladder the strategy maintains (design 66 §G8). ' +
          'Longer ladder = more duration/yield + rate risk; shorter = more liquidity + reinvestment drag. ' +
          'Searchable by the optimizer and tunable online in the MPC cockpit.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'BOND_LADDER' },
      },
      {
        key: 'bondLadderRole', label: 'Bond Ladder — Account Role(s)',
        type: 'EnumMulti', group: 'Allocation', mc: false, opt: false,
        options: ['ALL', ...Object.values(ACCOUNT_ROLES)],
        defaultValue: [ACCOUNT_ROLES.US_STOCK],
        description: 'WHERE the ladder lives: tick the account roles to ladder, or ALL for every account ' +
          'that holds bonds. EVERY account matching a ticked role is laddered, not just the first — a ' +
          'household commonly holds several accounts in one role. Nothing ticked = the default (us-stock). ' +
          'Note there is no SIZE lever here: a ladder is the account\'s whole BOND sleeve, restruck as N ' +
          'individual bonds, so how much is in it is set by the allocation target (TARGET_ALLOCATION), not ' +
          'by this strategy — this strategy only decides the SHAPE (rungs × spacing) and the LOCATION.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'BOND_LADDER' },
      },
      {
        key: 'bondLadderInflationLinked', label: 'Bond Ladder — TIPS (inflation-linked)',
        type: 'Boolean', group: 'Allocation', mc: false, opt: false,
        defaultValue: false,
        description: 'ON = every rung is a TIPS / inflation-linked bond (design 66 §G5): principal indexes ' +
          'to CPI, the accretion is imputed ordinary income, the coupon pays on the adjusted principal and ' +
          'redemption carries the deflation floor. Set `bondLadderCouponRate` to the REAL yield when ON — ' +
          'leaving it null stamps the NOMINAL market yield on top of CPI indexation, which pays twice for ' +
          'inflation.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'BOND_LADDER' },
      },
      {
        key: 'bondLadderCouponRate', label: 'Bond Ladder — Coupon Rate (blank = market)',
        type: 'Number', group: 'Allocation', mc: false, opt: false,
        min: 0, max: 0.15, step: 0.0005, defaultValue: null,
        description: 'Fixed coupon stamped on every rung at build. Blank (default) = the prevailing ' +
          'curve yield at each rung\'s own tenor. For a TIPS ladder this is the REAL yield.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'BOND_LADDER' },
      },
      {
        key: 'bondLadderSpacingYears', label: 'Bond Ladder Spacing (years)',
        type: 'Number', group: 'Allocation', mc: false, opt: false,
        min: 0.5, max: 5, step: 0.5, defaultValue: 1,
        description: 'Years between adjacent rung maturities. Ladder term = rungs × spacing.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'BOND_LADDER' },
      },
      {
        key: 'bondLadderRoll', label: 'Bond Ladder — Roll Maturing Rungs',
        type: 'Boolean', group: 'Allocation', mc: false, opt: false,
        defaultValue: true,
        description: 'ON (default) = each maturing rung rolls into a fresh rung at the ladder tail, so the ' +
          'ladder self-perpetuates (accumulation). OFF = maturing rungs fall to cash (spend-down).',
        visibleWhen: { param: 'behavioralStrategies', includes: 'BOND_LADDER' },
      },
      {
        key: 'bondLadderTaxTreatment', label: 'Bond Ladder — Tax Treatment',
        type: 'Enum', group: 'Allocation', mc: false, opt: false,
        options: ['none', 'state', 'federal', 'both'], defaultValue: 'state',
        description: 'Holding tax treatment for every rung (design 66 §G2): none = fully taxable, ' +
          'state = US Treasury (state-exempt, default), federal = municipal, both = muni all-state.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'BOND_LADDER' },
      },
    ],
  },

  DOWNTURN_ROTH_CONVERSION: {
    handlers:    (_context) => [],
    reducers: (context) => {
      const p = context.parameters;
      // Resolve IRA/Roth state keys from context.accounts (primary by default)
      const iraAcct  = (context.accounts ?? []).find(a => a.role === ACCOUNT_ROLES.IRA);
      const rothAcct = (context.accounts ?? []).find(a => a.role === ACCOUNT_ROLES.ROTH);
      return [new DownturnRothConversionReducer({
        iraKey:                   iraAcct?.stateKey  ?? 'iraAccount',
        rothKey:                  rothAcct?.stateKey ?? 'rothAccount',
        downturnConversionAmount: p.downturnConversionAmount ?? 20000,
      })];
    },
    paramSchema: () => [
      {
        key: 'downturnConversionAmount', label: 'Downturn Roth Conversion ($)',
        type: 'Number', group: 'Behavioral', mc: false, opt: true,
        defaultValue: 20000,
        description: 'Fixed dollar amount to convert from IRA → Roth on each qualifying regime entry (design/29 §3.6)',
        visibleWhen: { param: 'behavioralStrategies', includes: 'DOWNTURN_ROTH_CONVERSION' },
      },
    ],
  },

  CASH_BUCKET_DRAWDOWN: {
    handlers:    (_context) => [],
    reducers:    (_context) => [new CashBucketDrawdownReducer()],
    paramSchema: ()         => [],
  },

  TAX_GAIN_HARVEST: {
    handlers: (context) => {
      const p = context.parameters;
      const taxableStateKeys = _taxableStateKeys(context);
      const handler = new TaxGainHarvestHandler({
        taxableStateKeys,
        taxGainHarvestBracketCeiling: p.taxGainHarvestBracketCeiling ?? 0,
      });
      const evt = context.schedulesById?.['TAX_GAIN_HARVEST'];
      if (evt) handler.handledEvents.push(evt);
      return [handler];
    },
    reducers: (_context) => [new StockHarvestApplyReducer()],
    paramSchema: () => [
      {
        key: 'taxGainHarvestBracketCeiling', label: 'Tax-Gain Harvest Ceiling',
        type: 'Number', group: 'Behavioral', mc: false, opt: true,
        defaultValue: 0,
        description: '0% LTCG bracket ceiling (USD). Gains realized up to this threshold in low-income years at zero tax cost (design/29 §3.8). Set to 0 to disable.',
        visibleWhen: { param: 'behavioralStrategies', includes: 'TAX_GAIN_HARVEST' },
      },
    ],
  },

};

/**
 * Resolve state keys for taxable brokerage accounts (US_STOCK, AU_STOCK roles).
 * Called by TAX_LOSS_HARVEST and TAX_GAIN_HARVEST registry entries.
 */
function _taxableStateKeys(context) {
  return (context.accounts ?? [])
    .filter(a => a.role === ACCOUNT_ROLES.US_STOCK || a.role === ACCOUNT_ROLES.AU_STOCK)
    .map(a => a.stateKey);
}
