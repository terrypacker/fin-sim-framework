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
import { ACCOUNT_ROLES }                       from '../state/account-roles.js';

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
      },
    ],
  },

  CONTRIBUTION_SUSPENSION: {
    handlers:    (_context) => [],
    reducers:    (_context) => [],
    paramSchema: ()         => [],
  },

  TAX_LOSS_HARVEST: {
    handlers: (context) => {
      const p = context.parameters;
      const taxableStateKeys = _taxableStateKeys(context);
      const handler = new TaxLossHarvestHandler({
        taxableStateKeys,
        taxLossHarvestCap: p.taxLossHarvestCap ?? 3000,
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
        defaultValue: 3000,
        description: 'Maximum dollar loss to realize per year via tax-loss harvesting (US deduction cap proxy, design/29 §3.3)',
      },
      {
        key: 'taxLossHarvestOnRegimeEntry', label: 'TLH on Regime Entry',
        type: 'Boolean', group: 'Behavioral', mc: false, opt: true,
        defaultValue: true,
        description: 'Also trigger tax-loss harvesting on PANIC_SELL_TRIGGER regime entry, not just at year-end',
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
        type: 'Object', group: 'Behavioral', mc: false, opt: true,
        defaultValue: null,
        description: 'Map of allocation → preferred account roles for tax-advantaged placement. E.g. {"BOND":["ira","k401"],"EQUITY":["roth-ira"]}. Null = use defaults.',
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
        type: 'Object', group: 'Behavioral', mc: false, opt: true,
        defaultValue: null,
        description: 'Target allocation fractions for opportunistic rebalance. E.g. {"EQUITY":0.60,"BOND":0.40}. Null = 60/40 default.',
      },
      {
        key: 'rebalanceDriftBand', label: 'Rebalance Drift Band',
        type: 'Number', group: 'Behavioral', mc: false, opt: true,
        defaultValue: 0.05,
        description: 'Allocation drift threshold that triggers a rebalance (default 0.05 = 5 percentage points)',
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
      },
    ],
  },

  CASH_BUCKET_DRAWDOWN: {
    handlers:    (_context) => [],
    reducers:    (_context) => [],
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
