/**
 * Record parameter templates (design 55 §4).
 *
 * A declarative registry, keyed by record type, that names which record fields
 * become generated parameters. `ScenarioParamGenerator` walks the live domain
 * records and emits one typed param entry per (record × template-field) at
 * Build/Rebuild time, so account/people/property counts and types are flexible
 * without hand-editing `INTL_RETIREMENT_PARAM_SCHEMA`.
 *
 * Each field entry mirrors the metadata a static schema entry carries, plus a
 * `field` naming the record property it binds:
 *   { field, label, type, mc, opt, money?, nullable? }
 *     - field    : record property this param reads/writes (also the node.field)
 *     - label    : field-level label; combined with the record's display name
 *                  into the full param label ("Roth IRA — Balance")
 *     - type     : UI/param type ('Number' | 'Date' | 'Boolean' | 'Enum' | 'Money')
 *     - mc / opt : Monte-Carlo / optimization target flags (carried onto the entry
 *                  so the MC/Opt config UIs can discover the param)
 *     - money    : when true the generator seeds design-10 Money metadata
 *                  (defaultCurrency + currencyStateKeys) from the record's native
 *                  currency. Phase 1 keeps balances as plain Number for byte-for-byte
 *                  display parity with the static params they replace; Phase 2 (§8)
 *                  flips this on alongside per-account rates.
 *     - nullable : field legitimately holds null (e.g. plannedSaleYear = "never")
 *
 * Phase 1 (design 55 §12) covered balances/basis, person wage/retirementDate, and
 * property value/appreciation/sale-year; Phase 2 added the per-account rates; Phase 3
 * adds the SAVINGS/CHECKING isTransactionAccount flag. minimumBalance is still deferred.
 */
import { ACCOUNT_TYPE } from '../../finance/assets/account.js';

// Retirement-account ledger scalar exposed as a param (design 53 §2 / account-basis
// two-concepts). Per-lot holdings and cost basis stay in the account editor (design 25).
const CONTRIBUTION_BASIS = {
  field: 'contributionBasis', label: 'Contribution Basis',
  type: 'Number', mc: false, opt: true,
};

// Cash / investment balance — the field every account type exposes.
const BALANCE = { field: 'balance', label: 'Balance', type: 'Number', mc: true, opt: false };

// Per-account earnings rates (design 55 §8 / Phase 2). An unset rate on the record
// (null) means "use the toolset's global rate"; the generated param therefore starts
// empty and only overrides the global once the user (or MC) gives it a value. The
// earnings handler reads it via the per-account rate key so regimes still apply.
const GROWTH_RATE   = { field: 'growthRate',   label: 'Growth Rate',   type: 'Number', mc: true, opt: false };
const DIVIDEND_RATE = { field: 'dividendRate', label: 'Dividend Rate', type: 'Number', mc: true, opt: false };
const INTEREST_RATE = { field: 'interestRate', label: 'Interest Rate', type: 'Number', mc: true, opt: false };

// Transaction-account flag (design 55 §7 / Phase 3). Marks the cash account that
// expenses debit and cross-border sweeps replenish for its country of residence.
// Boolean, never an MC/Opt target; the cascade writes it onto the account record
// and StateRegistry.resolveTransactionAccountKey reads it (SAVINGS-role fallback).
const IS_TRANSACTION_ACCOUNT = {
  field: 'isTransactionAccount', label: 'Transaction Account',
  type: 'Boolean', mc: false, opt: false,
};

export const ACCOUNT_PARAM_TEMPLATES = {
  [ACCOUNT_TYPE.CHECKING]:        [BALANCE, INTEREST_RATE, IS_TRANSACTION_ACCOUNT],
  [ACCOUNT_TYPE.SAVINGS]:         [BALANCE, INTEREST_RATE, IS_TRANSACTION_ACCOUNT],
  [ACCOUNT_TYPE.BROKERAGE]:       [BALANCE, GROWTH_RATE, DIVIDEND_RATE],
  [ACCOUNT_TYPE.ROTH]:            [BALANCE, CONTRIBUTION_BASIS, GROWTH_RATE],
  [ACCOUNT_TYPE.TRADITIONAL_IRA]: [BALANCE, CONTRIBUTION_BASIS, GROWTH_RATE],
  [ACCOUNT_TYPE.FOUR_OH_ONE_K]:   [BALANCE, CONTRIBUTION_BASIS, GROWTH_RATE],
  [ACCOUNT_TYPE.SUPER]:           [BALANCE, CONTRIBUTION_BASIS, GROWTH_RATE],
  // Liability / linked-cash accounts (design 54) expose their balance too. The
  // loan's own interestRate is its *loan* rate (design 54), not an earnings rate,
  // so it stays out of this earnings-rate template.
  [ACCOUNT_TYPE.LOAN]:            [BALANCE],
  [ACCOUNT_TYPE.OFFSET]:          [BALANCE],
};

export const PERSON_PARAM_TEMPLATE = [
  { field: 'monthlyWage',   label: 'Monthly Wage',    type: 'Number', mc: true,  opt: true },
  { field: 'retirementDate', label: 'Retirement Date', type: 'Date',  mc: false, opt: true },
];

export const REAL_PROPERTY_PARAM_TEMPLATE = [
  { field: 'value',            label: 'Value',            type: 'Number', mc: true,  opt: false },
  { field: 'appreciationRate', label: 'Appreciation Rate', type: 'Number', mc: true, opt: false },
  { field: 'plannedSaleYear',  label: 'Planned Sale Year', type: 'Number', mc: true, opt: true, nullable: true },
];

// Template-ready but empty until these assets grow parameters (design 55 §4 / Phase 4).
export const COLLECTIBLE_PARAM_TEMPLATE    = [];
export const COMPANY_EQUITY_PARAM_TEMPLATE = [];
