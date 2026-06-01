/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * ReportDefinition — describes a named journal report: its title, available
 * facets, default grouping + aggregates, and how to compile a QueryApi AST from
 * the resolved facet values.
 *
 * `buildQuery(params, api)` is the only method subclasses must implement.
 * `params` carries the facet values that drive this invocation (cc, period, …).
 * `api` is a JournalQueryApi instance wrapping the live journal.
 */
export class ReportDefinition {
  /** @type {string} */
  get id()          { throw new Error('not implemented'); }
  /** @type {string} */
  get title()       { throw new Error('not implemented'); }
  /** @type {string} */
  get description() { return ''; }

  /**
   * Facet descriptors for the FacetPanel.
   * Each: { name, label, kind: 'select'|'text', options?: string[] }
   */
  get facets() { return []; }

  get defaultGroupBy()    { return ['actionType']; }
  get defaultAggregates() { return { total: { fn: 'sum', field: 'amount' }, count: { fn: 'count' } }; }

  /**
   * When true, the plugin routes this report through a per-stateDiff JournalDataSource
   * (one row per stateDiff entry).  State-centric reports like cash-flow-by-account set this.
   */
  get perDiff() { return false; }

  /**
   * When true, the plugin routes this report through a per-personTaxDetails
   * JournalDataSource (one row per person on `TAX_SETTLE_APPLY` entries that
   * carry a `personTaxDetails` array — currently only AU per-person filings).
   * Mutually exclusive with `perDiff`.
   */
  get perPerson() { return false; }

  /**
   * Build a QueryApi AST from resolved params.
   * @param {object}                                              params - facet values + bound params from drillReport
   * @param {import('../journal-query-api.js').JournalQueryApi}   api
   * @returns {object} AST node for use in aggregate() or search()
   */
  buildQuery(_params, _api) { throw new Error('not implemented'); }

  /**
   * Optional: post-process aggregate groups (rename keys, attach display labels).
   * Default is identity.
   */
  decorate(groups) { return groups; }
}

// ─── Shared facet → predicate helpers ────────────────────────────────────────

/**
 * Push an `in` predicate on `field` for the supplied values, only when the
 * caller supplied a non-empty list. Empty/null/undefined values mean
 * "no filter" — the most common state when the facet is showing "All".
 *
 * @param {Array<object>} conditions  - mutated in-place
 * @param {string}        field
 * @param {Array<string>|null|undefined} values
 */
function _appendInFilter(conditions, field, values) {
  if (!Array.isArray(values) || values.length === 0) return;
  conditions.push({ op: 'in', field, value: values });
}

/**
 * Push an account-stateKey filter for per-diff rows. The journal-row `stateKey`
 * is a dotted state path like `usSavingsAccount.balance`; each Account
 * registers a `stateKey` prefix like `usSavingsAccount`. We OR together
 * `contains(stateKey, '<prefix>.')` per selected account so the filter only
 * matches paths rooted at the chosen account, not any path that happens to
 * include the prefix substring.
 *
 * @param {Array<object>} conditions
 * @param {Array<string>|null|undefined} accountStateKeys
 */
function _appendAccountStateKeyFilter(conditions, accountStateKeys) {
  if (!Array.isArray(accountStateKeys) || accountStateKeys.length === 0) return;
  conditions.push({
    op: 'or',
    conditions: accountStateKeys.map(sk => ({
      op: 'contains', field: 'stateKey', value: `${sk}.`,
    })),
  });
}

// ─── Built-in Phase 1 definitions ────────────────────────────────────────────

class OrdinaryIncomeBySourceDef extends ReportDefinition {
  get id()          { return 'ordinary-income-by-source'; }
  get title()       { return 'Ordinary Income by Source'; }
  get description() { return 'Journal entries that contributed to ordinary taxable income for the period.'; }

  get facets() {
    return [
      { name: 'cc',         label: 'Country', kind: 'select',      options: ['US', 'AU']     },
      { name: 'personKeys', label: 'People',  kind: 'multiselect', optionsSource: 'person'   },
      { name: 'period',     label: 'Period',  kind: 'period' },
    ];
  }

  buildQuery(params, api) {
    const { cc, period, personKeys } = params;
    const periodAst   = api.periodOf(period);
    const incomeField = cc === 'AU' ? 'auOrdinaryIncomeYTD' : 'usOrdinaryIncomeYTD';
    const conditions  = [
      periodAst,
      { op: 'contains', field: 'changedFields', value: incomeField },
    ];
    _appendInFilter(conditions, 'personKey', personKeys);
    return { op: 'and', conditions };
  }
}

class PretaxAdjustmentsBySourceDef extends ReportDefinition {
  get id()          { return 'pretax-adjustments-by-source'; }
  get title()       { return 'Pre-tax Contributions by Source'; }
  get description() { return 'Pre-tax contributions (IRA, 401k, etc.) that reduce taxable ordinary income.'; }

  get facets() {
    return [
      { name: 'cc',     label: 'Country', kind: 'select', options: ['US'] },
      { name: 'period', label: 'Period',  kind: 'period' },
    ];
  }

  buildQuery(params, api) {
    const { period } = params;
    const periodAst = api.periodOf(period);
    return {
      op: 'and',
      conditions: [
        periodAst,
        { op: 'contains', field: 'changedFields', value: 'usNegativeIncomeYTD' },
      ],
    };
  }
}

class CapitalGainsByDisposalDef extends ReportDefinition {
  get id()          { return 'capital-gains-by-disposal'; }
  get title()       { return 'Capital Gains by Disposal'; }
  get description() { return 'Realized capital gains from asset sales during the period.'; }

  get facets() {
    return [
      { name: 'cc',         label: 'Country', kind: 'select',      options: ['US', 'AU']   },
      { name: 'personKeys', label: 'People',  kind: 'multiselect', optionsSource: 'person' },
      { name: 'period',     label: 'Period',  kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['actionType', 'description']; }
  get defaultAggregates() {
    return {
      total:    { fn: 'sum', field: 'proceeds' },
      gain:     { fn: 'sum', field: 'gain'     },
      count:    { fn: 'count'                  },
    };
  }

  buildQuery(params, api) {
    const { cc, period, personKeys } = params;
    const periodAst   = api.periodOf(period);
    const actionTypes = api.familyTypes('CAPITAL_GAINS', { cc });
    const conditions = [
      periodAst,
      { op: 'in',  field: 'actionType', value: actionTypes },
      { op: 'gt',  field: 'proceeds',   value: 0           },
    ];
    _appendInFilter(conditions, 'personKey', personKeys);
    return { op: 'and', conditions };
  }
}

class CashFlowByAccountDef extends ReportDefinition {
  get id()          { return 'cash-flow-by-account'; }
  get title()       { return 'Cash Flow by Account'; }
  get description() { return 'Net balance changes per account across journal entries.'; }
  get perDiff()     { return true; }

  get facets() {
    return [
      { name: 'accountStateKeys', label: 'Accounts', kind: 'multiselect', optionsSource: 'account' },
      { name: 'period',           label: 'Period',   kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['stateKey']; }
  get defaultAggregates() {
    return {
      total: { fn: 'sum',   field: 'stateDelta' },
      count: { fn: 'count'                      },
      min:   { fn: 'min',   field: 'stateDelta' },
      max:   { fn: 'max',   field: 'stateDelta' },
    };
  }

  buildQuery(params, api) {
    const { period, accountStateKeys } = params;
    // Tax-year semantics: the chained TAX_PAYMENT_DEBIT (which moves the cash)
    // shares the settle's date but has a higher seq than the settle. Seq-based
    // bounds would clip it; date-based keeps it in the period the user picked.
    const periodAst  = api.periodOfTaxYear(period);
    const conditions = [
      periodAst,
      { op: 'contains', field: 'stateKey', value: 'account.balance' },
    ];
    _appendAccountStateKeyFilter(conditions, accountStateKeys);
    return { op: 'and', conditions };
  }
}

// ─── Phase 3 definitions ──────────────────────────────────────────────────────

class WithdrawalsByAccountDef extends ReportDefinition {
  get id()          { return 'withdrawals-by-account'; }
  get title()       { return 'Withdrawals by Account'; }
  get description() { return 'Money leaving each account via withdrawal-class actions (IRA/401k/Roth/brokerage/super/savings).'; }
  get perDiff()     { return true; }

  get facets() {
    return [
      { name: 'accountStateKeys', label: 'Accounts', kind: 'multiselect', optionsSource: 'account' },
      { name: 'period',           label: 'Period',   kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['stateKey']; }
  get defaultAggregates() {
    return {
      total: { fn: 'sum',   field: 'stateDelta' },
      count: { fn: 'count'                      },
      min:   { fn: 'min',   field: 'stateDelta' },
    };
  }

  buildQuery(params, api) {
    const { period, accountStateKeys } = params;
    // Tax-year semantics: catches withdrawals dated on the settle day even if
    // their seq lands after the settle. Withdrawals are not chained from
    // settles, but the date-window convention keeps period semantics uniform
    // across "stuff that happened in CY/FY" reports.
    const periodAst  = api.periodOfTaxYear(period);
    const conditions = [
      periodAst,
      { op: 'in',       field: 'actionType', value: api.familyTypes('WITHDRAWAL') },
      { op: 'contains', field: 'stateKey',   value: 'account.balance'             },
      { op: 'lt',       field: 'stateDelta', value: 0                             },
    ];
    _appendAccountStateKeyFilter(conditions, accountStateKeys);
    return { op: 'and', conditions };
  }
}

class TaxPaidByYearDef extends ReportDefinition {
  get id()          { return 'tax-paid-by-year'; }
  get title()       { return 'Tax Paid by Year'; }
  get description() { return 'Tax payments debited from cash by year (TAX_PAYMENT_DEBIT entries). Household-level — for per-person AU drill-down use the "AU Tax by Person & Year" report.'; }

  get facets() {
    return [
      { name: 'cc',         label: 'Country', kind: 'select', options: ['', 'US', 'AU'] },
      { name: 'period',     label: 'Period',  kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['year']; }
  get defaultAggregates() {
    return {
      total: { fn: 'sum', field: 'amount' },
      count: { fn: 'count'                },
    };
  }

  buildQuery(params, api) {
    const { cc, period } = params;
    // Tax-year semantics: TAX_PAYMENT_DEBIT is chained from TAX_SETTLE_APPLY
    // and shares its date but has a higher seq. Seq-based bounds drop it from
    // the same-day window; the date-bounded tax-year window keeps it.
    const periodAst   = api.periodOfTaxYear(period);
    const actionTypes = api.familyTypes('TAX_PAYMENT_DEBIT', { cc });
    return { op: 'and', conditions: [
      periodAst,
      { op: 'in', field: 'actionType', value: actionTypes },
    ] };
  }
}

class AuTaxByPersonYearDef extends ReportDefinition {
  get id()          { return 'au-tax-by-person-year'; }
  get title()       { return 'AU Tax by Person & Year'; }
  get description() { return 'AU tax liability per person per year, fanned out from TAX_SETTLE_APPLY.personTaxDetails.'; }
  get perPerson()   { return true; }

  get facets() {
    return [
      { name: 'personKeys', label: 'People', kind: 'multiselect', optionsSource: 'person' },
      { name: 'period',     label: 'Period', kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['year', 'personName']; }
  get defaultAggregates() {
    return {
      total: { fn: 'sum', field: 'personTaxAmount' },
      count: { fn: 'count'                          },
    };
  }

  buildQuery(params, api) {
    const { period, personKeys } = params;
    // Tax-year semantics: this report queries TAX_SETTLE_APPLY itself, and
    // seq-based periodOf excludes the upper-bound settle (the one the user
    // picked). Date-based bounds put the settle inside its own FY window.
    const periodAst   = api.periodOfTaxYear(period);
    const actionTypes = api.familyTypes('TAX_SETTLE_APPLY', { cc: 'AU' });
    const conditions  = [
      periodAst,
      { op: 'in', field: 'actionType', value: actionTypes },
    ];
    _appendInFilter(conditions, 'personKey', personKeys);
    return { op: 'and', conditions };
  }
}

class RothConversionsByYearDef extends ReportDefinition {
  get id()          { return 'roth-conversions-by-year'; }
  get title()       { return 'Roth Conversions by Year'; }
  get description() { return 'IRA→Roth conversion amounts by year (ROTH_CONVERSION_APPLY entries).'; }

  get facets() {
    return [
      { name: 'period', label: 'Period', kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['year']; }
  get defaultAggregates() {
    return {
      total: { fn: 'sum', field: 'amount' },
      count: { fn: 'count'                },
    };
  }

  buildQuery(params, api) {
    const { period } = params;
    // Tax-year semantics so a December conversion that lands after the
    // same-day US settle still shows up in its calendar year. (Roth
    // conversions aren't chained from settles, but the user picks "CY 2026"
    // expecting CY 2026 conversions.)
    const periodAst = api.periodOfTaxYear(period);
    return {
      op: 'and',
      conditions: [
        periodAst,
        { op: 'eq', field: 'actionType', value: 'ROTH_CONVERSION_APPLY' },
      ],
    };
  }
}

class RealPropertyCashFlowDef extends ReportDefinition {
  get id()          { return 'real-property-cash-flow'; }
  get title()       { return 'Real Property Cash Flow'; }
  get description() { return 'Cash movements driven by real-property events: house sales (proceeds) and mortgage payments (debits).'; }
  get perDiff()     { return true; }

  get facets() {
    return [
      { name: 'accountStateKeys', label: 'Accounts', kind: 'multiselect', optionsSource: 'account' },
      { name: 'period',           label: 'Period',   kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['actionType']; }
  get defaultAggregates() {
    return {
      total: { fn: 'sum',   field: 'stateDelta' },
      count: { fn: 'count'                      },
    };
  }

  buildQuery(params, api) {
    const { period, accountStateKeys } = params;
    // Tax-year semantics keeps cash-flow reports consistent across CY/FY
    // boundaries even when actions land on the same day as a settle.
    const periodAst  = api.periodOfTaxYear(period);
    const conditions = [
      periodAst,
      { op: 'in',       field: 'actionType', value: api.familyTypes('REAL_PROPERTY_CASH') },
      { op: 'contains', field: 'stateKey',   value: 'account.balance'                     },
    ];
    _appendAccountStateKeyFilter(conditions, accountStateKeys);
    return { op: 'and', conditions };
  }
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * ReportDefinitionRegistry — keyed by report id.
 *
 * The four Phase 1 built-in definitions are registered on construction.
 * Additional definitions can be registered via register().
 */
export class ReportDefinitionRegistry {
  constructor() {
    /** @type {Map<string, ReportDefinition>} */
    this._defs = new Map();

    for (const def of [
      new OrdinaryIncomeBySourceDef(),
      new PretaxAdjustmentsBySourceDef(),
      new CapitalGainsByDisposalDef(),
      new CashFlowByAccountDef(),
      new WithdrawalsByAccountDef(),
      new TaxPaidByYearDef(),
      new AuTaxByPersonYearDef(),
      new RothConversionsByYearDef(),
      new RealPropertyCashFlowDef(),
    ]) {
      this.register(def);
    }
  }

  /** @param {ReportDefinition} def */
  register(def) {
    this._defs.set(def.id, def);
  }

  /** @returns {ReportDefinition|null} */
  get(id) {
    return this._defs.get(id) ?? null;
  }

  /** @returns {ReportDefinition[]} */
  getAll() {
    return [...this._defs.values()];
  }
}
