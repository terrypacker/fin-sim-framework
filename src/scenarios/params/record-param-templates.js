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
 * adds the SAVINGS/CHECKING isTransactionAccount flag; minimumBalance is now a
 * per-account SAVINGS/CHECKING field so the cash floor travels with the flagged
 * transaction account (§7.4) instead of the old global us/auSavingsMinBalance params.
 */
import { ACCOUNT_TYPE } from '../../finance/assets/account.js';

// Retirement-account ledger scalar exposed as a param (design 53 §2 / account-basis
// two-concepts). Per-lot holdings and cost basis stay in the account editor (design 25).
const CONTRIBUTION_BASIS = {
  field: 'contributionBasis', label: 'Contribution Basis',
  type: 'Number', mc: false, opt: true,
  description: 'After-tax contribution basis for this retirement account — the portion ' +
    'already taxed. Withdrawals of basis come out tax-free; the balance above it is the ' +
    'taxable earnings.',
};

// Cash / investment balance — the field every account type exposes.
const BALANCE = { field: 'balance', label: 'Balance', type: 'Number', mc: true, opt: false,
  description: 'Current total balance of this account.' };

// Holdings-bearing balance MC/Opt lever (design 55 §13). A holdings-bearing account's
// `balance` is DERIVED from Σ holdings.marketValue and is therefore NOT emitted as a
// plain param (a stale `balance` would rescale holdings on Rebuild and revert editor
// edits — the very bug design 55 fixed). To still let Monte-Carlo sweep an account's
// total, the generator swaps the skipped `balance` field for this hidden, compile-only
// `balanceTarget`: it is honored ONLY when explicitly injected into cfg.parameters (by
// the MC/Opt runner), where the loader cascade rescales the holdings to it
// non-destructively. `hidden: true` keeps it out of the param editor AND out of the
// persisted cfg.params (see ScenarioLoader._mergeParamSchema), so it never round-trips
// as a stale value. The generator seeds its defaultValue from the record's balance.
export const BALANCE_TARGET = {
  field: 'balanceTarget', label: 'Balance', type: 'Number',
  mc: true, opt: false, hidden: true, deriveDefaultFrom: 'balance',
};

// Cash floor (design 55 §7 / §13). The replenish threshold that drives
// REPLENISH_SAVINGS. Per-account so it travels with the flagged transaction
// account (§7.4) instead of being pinned to the canonical savings account by the
// old global usSavingsMinBalance / auSavingsMinBalance params. Plain Number: the
// floor is always in the account's native currency (no cross-currency display
// conversion), so the currency is inferred from the account, not the param.
const MINIMUM_BALANCE = { field: 'minimumBalance', label: 'Minimum Balance', type: 'Number', mc: false, opt: true,
  description: 'Cash floor for this account. When the balance drops below it, the model ' +
    'replenishes from other liquid accounts.' };

// Per-account earnings rates (design 55 §8 / Phase 2). An unset rate on the record
// (null) means "use the toolset's global rate"; the generated param therefore starts
// empty and only overrides the global once the user (or MC) gives it a value. The
// earnings handler reads it via the per-account rate key so regimes still apply.
const GROWTH_RATE   = { field: 'growthRate',   label: 'Growth Rate',   type: 'Number', mc: true, opt: false,
  description: 'Annual growth (appreciation) rate for this account\'s holdings, as a ' +
    'fraction (0.05 = 5%). Leave blank to use the scenario\'s global rate for this account type.' };
const DIVIDEND_RATE = { field: 'dividendRate', label: 'Dividend Rate', type: 'Number', mc: true, opt: false,
  description: 'Annual dividend yield for this account\'s holdings, as a fraction ' +
    '(0.02 = 2%). Leave blank to use the scenario\'s global dividend rate.' };
// Per-account cash interest rate (CHECKING/SAVINGS). Retired as an MC lever (design 56
// Decision 6 / §3.1): a cash account's rate is now Prime + primeSpread, so the systemic
// rate sweep is Prime, not this per-account knob — retiring it removes the MC double-move
// at the source. Still a live editable/seed field (mc:false, opt:false).
const INTEREST_RATE = { field: 'interestRate', label: 'Interest Rate', type: 'Number', mc: false, opt: false,
  description: 'Annual cash interest rate for this account, as a fraction (0.03 = 3%). ' +
    'Leave blank to track the country\'s Prime rate plus this account\'s spread.' };

// Transaction-account flag (design 55 §7 / Phase 3). Marks the cash account that
// expenses debit and cross-border sweeps replenish for its country of residence.
// Boolean, never an MC/Opt target; the cascade writes it onto the account record
// and StateRegistry.resolveTransactionAccountKey reads it (SAVINGS-role fallback).
const IS_TRANSACTION_ACCOUNT = {
  field: 'isTransactionAccount', label: 'Transaction Account',
  type: 'Boolean', mc: false, opt: false,
  description: 'When on, this is the cash account that expenses debit and cross-border ' +
    'transfers replenish for its country of residence. Flag exactly one account per country.',
};

export const ACCOUNT_PARAM_TEMPLATES = {
  [ACCOUNT_TYPE.CHECKING]:        [BALANCE, MINIMUM_BALANCE, INTEREST_RATE, IS_TRANSACTION_ACCOUNT],
  [ACCOUNT_TYPE.SAVINGS]:         [BALANCE, MINIMUM_BALANCE, INTEREST_RATE, IS_TRANSACTION_ACCOUNT],
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
  { field: 'monthlyWage',   label: 'Monthly Wage',    type: 'Number', mc: true,  opt: true,
    description: 'Gross monthly employment wage for this person, before tax, in their native currency.' },
  { field: 'retirementDate', label: 'Retirement Date', type: 'Date',  mc: false, opt: true,
    description: 'Date this person stops earning wages (their last working month).' },
];

export const REAL_PROPERTY_PARAM_TEMPLATE = [
  { field: 'value',            label: 'Value',            type: 'Number', mc: true,  opt: false,
    description: 'Current market value of this property.' },
  { field: 'appreciationRate', label: 'Appreciation Rate', type: 'Number', mc: true, opt: false,
    description: 'Annual appreciation rate for this property, as a fraction (0.04 = 4%).' },
  { field: 'plannedSaleYear',  label: 'Planned Sale Year', type: 'Number', mc: true, opt: true, nullable: true,
    description: 'Calendar year this property is sold. Leave blank for no planned sale.' },
];

// Template-ready but empty until these assets grow parameters (design 55 §4 / Phase 4).
export const COLLECTIBLE_PARAM_TEMPLATE    = [];
export const COMPANY_EQUITY_PARAM_TEMPLATE = [];

// ── Inheritance (design 63 §12.3) ────────────────────────────────────────────
// Per-record params derived from Bequest records + their inherited retirement
// assets, so the inheritance param surface exists only when an inheritance does
// and each knob carries a `node` (linked, design 32) — parallel to accounts.

// Per Bequest: the activation year. Blank ⇒ inert (no INHERIT event, no seed).
export const BEQUEST_PARAM_TEMPLATE = [
  { field: 'inheritanceYear', label: 'Inheritance Year', type: 'Number', mc: false, opt: false, nullable: true,
    description: 'Calendar year this bequest is inherited. Leave blank to keep it inert — the ' +
      'inherited assets stay invisible (no net-worth, no drawdown) until a year is set.' },
];

// Per inherited retirement account (IRA / 401(k) / Roth): the SECURE 10-year
// drawdown strategy + its tuning (design 63 §6.2). Blank fields fall back to the
// handler defaults (bracketFill / $100k / year 0), mirroring the per-account
// "blank = use the default" rate convention above.
export const INHERITED_RA_PARAM_TEMPLATE = [
  { field: 'distributionMode', label: 'RA Distribution Strategy', type: 'Enum',
    options: ['equal', 'lump', 'maxDefer', 'bracketFill', 'weights'],
    mc: false, opt: false, nullable: true,
    description: 'SECURE 10-year drawdown strategy for this inherited retirement account. ' +
      'Blank = bracketFill (fill ordinary income to the ceiling, spill the rest to year 9).' },
  { field: 'fillCeiling', label: 'RA Fill Ceiling (real USD)', type: 'Number', mc: false, opt: true, nullable: true,
    description: 'bracketFill ordinary-income ceiling in REAL base-year USD (the reducer inflates ' +
      'it to nominal). Blank = the $100k default. The primary optimized scalar.' },
  { field: 'lumpYear', label: 'RA Lump Year', type: 'Number', mc: false, opt: true, nullable: true,
    description: 'lump strategy: the window year (0–9) the whole account is distributed in. Blank = year 0.' },
];
