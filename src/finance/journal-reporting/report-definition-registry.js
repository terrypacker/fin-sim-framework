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
   * Default sort for aggregate groups. Override in time-series (year-keyed) reports
   * to show ascending chronological order instead of the largest-bucket-first default.
   */
  get defaultSort() { return [{ field: 'total', dir: 'desc' }]; }

  /**
   * The currency this report's money aggregates are expressed in, or null when
   * the report declares none.
   *
   * Declaring one makes the aggregation layer convert every currency-typed
   * field into it, per row, at the run's own recorded USD/AUD rate for that
   * row's date (see report-currency.js). A report MUST declare one when its
   * rows can span currencies — a total that adds AUD onto USD is a number in no
   * currency, and both the panel and the CSV present it as if it were dollars.
   *
   * Returning null leaves the fold exactly as the rows were projected. That is
   * right for the reports whose rows are single-currency by construction: the
   * cc-faceted income and capital-gain drills read jurisdiction-fixed
   * accumulators (AU buckets are AUD, US buckets USD), and the tax documents
   * cross-foot against them in that native currency.
   *
   * @param {object} _params - resolved facet values for this invocation
   * @returns {string|null}  - e.g. 'USD'
   */
  reportCurrency(_params) { return null; }

  /**
   * Return the PeriodService period type ('YEAR_US' | 'YEAR_AU') to use for
   * period-based aggregation, or null to use the generic groupBy path.
   * Override in reports that group by year and have a fixed or facet-driven cc.
   * When this returns a non-null value and a PeriodService is available,
   * JournalQueryApi.aggregateByYear() is called instead of aggregate().
   *
   * @param {object} params - resolved facet values for this invocation
   * @returns {'YEAR_US'|'YEAR_AU'|null}
   */
  periodTypeFor(_params) { return null; }

  /**
   * The jurisdiction a year-keyed report's `year` belongs to, for reports whose
   * cc is implicit rather than faceted. Exports use it to restate an AU year as
   * the fiscal-year START year the AU return is filed under (`2025` = FY2025-26,
   * the convention the tax documents and the worksheet CSV use), since the
   * period rollup keys AU years by their END year.
   *
   * Null (the default) = US calendar years, where the two agree.
   */
  get yearCc() { return null; }

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
   * When set to a row field name, the aggregate collapses rows sharing that value
   * to one representative before folding — undoing the journal action×reducer
   * fan-out (one action → N rows carrying identical payload). Reports that sum an
   * action-payload field (e.g. `gain`) across the whole CAPITAL_GAINS family set
   * this to 'instanceId' so each disposal counts once. Null = no deduping.
   */
  get dedupeBy() { return null; }

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
   *
   * @param {Array<object>} groups
   * @param {import('../journal-query-api.js').JournalQueryApi} [api]
   */
  decorate(groups, _api) { return groups; }
}

/**
 * Strip the trailing state field off a journal `stateKey` path to recover the
 * bare account key: `usSavings2Account.balance` → `usSavings2Account`.
 * Returns the input unchanged when it carries no field segment.
 */
function _accountKeyOf(stateKeyPath) {
  const dot = String(stateKeyPath ?? '').indexOf('.');
  return dot > 0 ? stateKeyPath.slice(0, dot) : stateKeyPath;
}

/**
 * Attach the human account name as a group *label* (design 70 §6.2), leaving
 * `g.key` — the identity that expand-to-entries and history keying run on —
 * untouched. Shared by every report that groups by account stateKey.
 *
 * @param {Array<object>} groups
 * @param {import('../journal-query-api.js').JournalQueryApi} [api]
 */
function _labelAccountGroups(groups, api) {
  if (!api?.displayNameFor) return groups;
  for (const g of groups) {
    const sk = g.key?.stateKey;
    if (sk == null) continue;
    const name = api.displayNameFor(_accountKeyOf(sk));
    if (name) (g.labels ??= {}).stateKey = name;
  }
  return groups;
}

/**
 * The currency the account- and action-scoped money reports state their totals
 * in. These have no country facet: one run's rows cover US accounts (USD) and
 * AU accounts (AUD) at once, so every one of them can mix currencies — within a
 * group when it buckets by action type, and in the grand total always. USD is
 * the base currency the rest of the app already reports household money in
 * (computeNetWorth, cumulativeTaxesPaid), and the panel's own formatter has
 * always labelled these totals `$` — this makes that label true.
 *
 * A single-country run converts USD→USD, i.e. not at all, so nothing moves
 * there.
 */
const ACCOUNT_REPORT_CURRENCY = 'USD';

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
 * Drop the escalated re-issue of a tax payment debit.
 *
 * When a tax bill exceeds same-country cash, TaxPaymentDebitReducerBase debits
 * what the balance covers, wires the rest across the border
 * (INTL_TRANSFER_APPLY), then re-issues ITSELF for the uncovered residual with
 * `escalated: true`. Both passes journal a TAX_PAYMENT_DEBIT entry, so a report
 * summing `amount` sees the full bill once (the original action) plus the
 * residual again (the re-issue) — the funded part counted twice. The two passes
 * move one liability between them, and the original action's `amount` is already
 * all of it, so the re-issue is the row to drop.
 *
 * Consequence worth knowing: the surviving row carries the liability ASSESSED,
 * which equals cash paid only while the household stays solvent. If even the
 * cross-border sweep falls short the shortfall is reported separately as
 * OUT_OF_FUNDS, and this report still shows the full bill. Netting that off
 * would need the realized debit on the entry; no action field carries it today.
 *
 * @param {Array<object>} conditions
 */
function _appendNotEscalated(conditions) {
  conditions.push({ op: 'not', condition: { op: 'eq', field: 'escalated', value: true } });
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

/**
 * Scope a per-account report to the account *balance* rows it reports on —
 * either the accounts the user selected in the facet, or (the default) every
 * registered account.
 *
 * This replaces the `contains 'account.balance'` substring (design 63 §14.6,
 * retired by design 70 §6.3), which selected rows by the *spelling* of the key
 * and so silently dropped any account whose stateKey does not end in `…Account`
 * — the bug that made inherited `beq1_a1` invisible in every account report.
 * Matching the real account set instead is exact: for existing `…Account` keys
 * it selects precisely the same rows.
 *
 * Falls back to the old substring when no registry is bound to the api (a bare
 * api in a test harness), so nothing depends on the wiring being present.
 *
 * @param {Array<object>} conditions  - mutated in-place
 * @param {Array<string>|null|undefined} accountStateKeys - facet selection (bare account keys)
 * @param {import('../journal-query-api.js').JournalQueryApi} api
 */
function _appendAccountBalanceScope(conditions, accountStateKeys, api) {
  const selected = (Array.isArray(accountStateKeys) && accountStateKeys.length > 0)
    ? accountStateKeys.map(sk => `${sk}.balance`)
    : null;
  const keys = selected ?? api?.accountBalanceKeys?.() ?? null;
  if (keys) { conditions.push({ op: 'in', field: 'stateKey', value: keys }); return; }
  conditions.push({ op: 'contains', field: 'stateKey', value: 'account.balance' });
  _appendAccountStateKeyFilter(conditions, accountStateKeys);
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

  // design 51: sum each entry's *contribution* to the ordinary-income accumulator
  // (its stateDelta on `incomeField`) rather than the action's native `amount`.
  // Cross-border income (AU-source in AUD, US-source in AUD-resident branch) is
  // normalized into the accumulator's canonical currency at accrual, so the raw
  // `amount` no longer equals the taxable contribution — the stateDelta does, and
  // it is what the Form 1040 / AU return gross line reports.
  get perDiff()           { return true; }
  get defaultGroupBy()    { return ['actionType']; }
  get defaultAggregates() { return { total: { fn: 'sum', field: 'stateDelta' }, count: { fn: 'count' } }; }

  buildQuery(params, api) {
    const { cc, period, personKeys } = params;
    const periodAst   = api.periodOf(period);
    const incomeField = cc === 'AU' ? 'auOrdinaryIncomeYTD' : 'usOrdinaryIncomeYTD';
    const conditions  = [
      periodAst,
      // AU ordinary income accrues into TWO places: the shared household pool and
      // the per-person `auPersonOrdinaryIncomeYTD` map that migrated income types
      // (rental, savings) write to directly. computeAuTaxPerPerson assesses
      // `perPersonMap[key] + shared / numResidents`, so the return's gross line is
      // the union — drilling the pool alone reported ZERO for every year before the
      // move, when all AU income was per-person. Union them (design 73 §0.5, the
      // same fix Gap 2 made for NR withholding). The map diffs per key, so each
      // person's contribution carries its own numeric delta; the US side has no
      // per-person map, making the extra predicate inert there.
      {
        op: 'or',
        conditions: [
          { op: 'eq',       field: 'stateKey', value: incomeField          },
          { op: 'contains', field: 'stateKey', value: `${cc.toLowerCase()}PersonOrdinaryIncomeYTD.` },
        ],
      },
      // Exclude the annual settle, whose diff resets the accumulator to 0 (a large
      // negative delta that would cancel the gross income total).
      { op: 'not', condition: { op: 'eq', field: 'actionType', value: `${cc}_TAX_SETTLE_APPLY` } },
    ];
    _appendInFilter(conditions, 'personKey', personKeys);
    return { op: 'and', conditions };
  }
}

class NrWithholdingIncomeBySourceDef extends ReportDefinition {
  get id()          { return 'nr-withholding-income-by-source'; }
  get title()       { return 'Non-Resident Withholding Income by Source'; }
  get description() { return 'Journal entries that contributed to AU non-resident withholding income for the period.'; }

  get facets() {
    return [
      { name: 'personKeys', label: 'People', kind: 'multiselect', optionsSource: 'person' },
      { name: 'period',     label: 'Period', kind: 'period' },
    ];
  }

  buildQuery(params, api) {
    const { period, personKeys } = params;
    const periodAst  = api.periodOf(period);
    // Match both household (auNonResidentWithholdingYTD) and per-person
    // (auPersonNonResidentWithholdingYTD) reducer paths — the latter is used
    // when state.people is defined and the source account is non-null.
    const conditions = [
      periodAst,
      {
        op: 'or',
        conditions: [
          { op: 'contains', field: 'changedFields', value: 'auNonResidentWithholdingYTD'       },
          { op: 'contains', field: 'changedFields', value: 'auPersonNonResidentWithholdingYTD' },
          // design 73 Gap 2 — the typed accumulators the interest and unfranked
          // dividend feeders moved to. The drill explains the total withholding
          // income line, so it must union every field that feeds it or it would
          // silently under-foot the line it hangs off.
          { op: 'contains', field: 'changedFields', value: 'auNrWithholdingInterestYTD'                },
          { op: 'contains', field: 'changedFields', value: 'auPersonNrWithholdingInterestYTD'          },
          { op: 'contains', field: 'changedFields', value: 'auNrWithholdingUnfrankedDividendYTD'       },
          { op: 'contains', field: 'changedFields', value: 'auPersonNrWithholdingUnfrankedDividendYTD' },
        ],
      },
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

class NiitBaseByComponentDef extends ReportDefinition {
  get id()          { return 'niit-base-by-component'; }
  get title()       { return 'Net Investment Income by Component'; }
  get description() {
    return 'Journal entries that contributed to the IRC §1411 net investment income base'
      + ' — interest, dividends, bond coupons and net rents, plus capital and collectible gains.';
  }

  get facets() {
    return [
      { name: 'personKeys', label: 'People', kind: 'multiselect', optionsSource: 'person' },
      { name: 'period',     label: 'Period', kind: 'period' },
    ];
  }

  // Same stateDelta treatment as ordinary income: NII accrues into three separate
  // accumulators, and it is each entry's *contribution* to them — not the action's
  // native `amount` — that the Form 8960 line reports. The AU-resident branches of
  // the tax reducers convert to AUD for the AU accumulators only, so the US-side
  // deltas stay in USD.
  get perDiff()           { return true; }
  get defaultGroupBy()    { return ['actionType']; }
  get defaultAggregates() { return { total: { fn: 'sum', field: 'stateDelta' }, count: { fn: 'count' } }; }

  buildQuery(params, api) {
    const { period, personKeys } = params;
    const periodAst  = api.periodOf(period);
    // NII = usNetInvestmentIncomeYTD (interest/dividends/coupons/net rents) + capital
    // gains + collectible gains — the three buckets computeTax sums in step 5b. The
    // gains live in their own accumulators and are never folded into the NII one, so
    // drilling on usNetInvestmentIncomeYTD alone would explain only a fraction of the
    // line and leave the bulk of the base unaccounted for.
    const conditions = [
      periodAst,
      {
        op: 'in',
        field: 'stateKey',
        value: ['usNetInvestmentIncomeYTD', 'usCapitalGainsYTD', 'usCollectibleGainsYTD'],
      },
      // Exclude the annual settle, whose diff resets each accumulator to 0 (a large
      // negative delta that would cancel the total).
      { op: 'not', condition: { op: 'eq', field: 'actionType', value: 'US_TAX_SETTLE_APPLY' } },
    ];
    _appendInFilter(conditions, 'personKey', personKeys);
    return { op: 'and', conditions };
  }
}

class CapitalGainsByDisposalDef extends ReportDefinition {
  get id()          { return 'capital-gains-by-disposal'; }
  get title()       { return 'Capital Gains by Disposal'; }
  get description() {
    return 'Realized capital gains from asset sales during the period. `total` is each disposal\'s '
         + 'assessed contribution to the jurisdiction\'s capital-gains accumulator — for an AU '
         + 'return on a US asset that is the AUD-converted figure, not the USD contract gain. '
         + '`proceeds` is the disposal\'s contract amount, converted into the report\'s currency '
         + 'at the rate the run recorded on the disposal date, so it is in the same unit as `total`.';
  }

  /**
   * The jurisdiction's own currency — `total` sums that jurisdiction's accumulator,
   * so the report ties out to the return it explains (same rule as tax-paid-by-year).
   *
   * This was `null` until design 91 §8: `proceeds` was declared `number()` on every
   * disposal type, so declaring a currency here would have converted nothing and
   * merely asserted that a USD proceeds figure was AUD. Typing the disposal money
   * (§8.4) is what makes this line correct rather than cosmetic — measured at §8.7:
   * `total` does not move at all, and a US-asset row's `proceeds` on the AU report
   * converts instead of being counted at face value.
   *
   * NOTE the AU CGT worksheet converts the same figures at the rate IMPLIED by the
   * booking (`audTotal / nativeGain`, tax-document-registry.js) rather than at the
   * date rate used here, deliberately, so its proceeds and cost base move on exactly
   * the same footing as the gain. The two can differ slightly; the worksheet's is the
   * one that ties to the return.
   */
  reportCurrency(params) { return params?.cc === 'AU' ? 'AUD' : 'USD'; }

  // design 51/73 §0b.1: sum each disposal's *contribution* to the jurisdiction's
  // capital-gains accumulator (its stateDelta) rather than the action's native
  // `gain` payload. A US-asset disposal assessed on an AU return accrues the
  // AUD-converted gain, while the payload stays in USD — summing the payload
  // under-reported the AU line by the exchange rate, and by a growing margin as
  // the rate moved. Same fix ordinary-income-by-source already carries.
  get perDiff() { return true; }

  // NOT dedupeBy: the accumulator predicate below already selects exactly one
  // diff row per disposal per jurisdiction (the US accumulator only appears on
  // the US reducer's entry, the AU one on the AU reducer's), so the reducer
  // fan-out is gone by construction. Deduping on top of that would DROP the
  // per-person leg when a disposal writes both the shared and per-person maps.

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
      // `total` is the headline / sort key — the assessed gain, so the report
      // ties out to the tax document's "Capital Gains (before discount)" line
      // (= us/auCapitalGainsYTD) in the currency that line is stated in.
      total:    { fn: 'sum', field: 'stateDelta' },
      proceeds: { fn: 'sum', field: 'proceeds'   },
      count:    { fn: 'count'                    },
    };
  }

  buildQuery(params, api) {
    const { cc, period, personKeys } = params;
    const periodAst  = api.periodOf(period);
    const gainsField = cc === 'AU' ? 'auCapitalGainsYTD' : 'usCapitalGainsYTD';
    const conditions = [
      periodAst,
      // The accumulator IS the line, so selecting contributions to it is exact
      // where the old action-family + `residency === 'AU'` approximation was not.
      // It needs no residency predicate: a non-resident AU disposal routes to NR
      // withholding and never touches auCapitalGainsYTD, so it drops out on its
      // own — and a mid-year move, where the residency tag and the assessing
      // jurisdiction disagree, now lands on whichever side actually assessed it.
      // Losses come through as negative deltas, matching the signed accumulator.
      {
        op: 'or',
        conditions: [
          { op: 'eq',       field: 'stateKey', value: gainsField },
          // Per-person capital-gains maps, assessed alongside the shared pool by
          // computeAuTaxPerPerson (design 73 §0.5). Inert until an income type
          // migrates to them; unioned so it cannot silently under-foot when one does.
          { op: 'contains', field: 'stateKey', value: `${cc.toLowerCase()}PersonCapitalGainsYTD.` },
        ],
      },
      // Exclude the annual settle, whose diff resets the accumulator to 0 (a large
      // negative delta that would cancel the total).
      { op: 'not', condition: { op: 'eq', field: 'actionType', value: `${cc}_TAX_SETTLE_APPLY` } },
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

  /** Mixed-currency by construction: see ACCOUNT_REPORT_CURRENCY. */
  reportCurrency(_params) { return ACCOUNT_REPORT_CURRENCY; }

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
    ];
    _appendAccountBalanceScope(conditions, accountStateKeys, api);
    return { op: 'and', conditions };
  }

  /** Show the account NAME on each group row; g.key keeps the stateKey identity (design 70 §6.2). */
  decorate(groups, api) { return _labelAccountGroups(groups, api); }
}

// ─── Phase 3 definitions ──────────────────────────────────────────────────────

class WithdrawalsByAccountDef extends ReportDefinition {
  get id()          { return 'withdrawals-by-account'; }
  get title()       { return 'Withdrawals by Account'; }
  get description() { return 'Money leaving each account via withdrawal-class actions (IRA/401k/Roth/brokerage/super/savings).'; }
  get perDiff()     { return true; }

  /** Mixed-currency by construction: see ACCOUNT_REPORT_CURRENCY. */
  reportCurrency(_params) { return ACCOUNT_REPORT_CURRENCY; }

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
      { op: 'lt',       field: 'stateDelta', value: 0                             },
    ];
    _appendAccountBalanceScope(conditions, accountStateKeys, api);
    return { op: 'and', conditions };
  }

  /** Show the account NAME on each group row; g.key keeps the stateKey identity (design 70 §6.2). */
  decorate(groups, api) { return _labelAccountGroups(groups, api); }
}

class CreditsToAccountDef extends ReportDefinition {
  get id()          { return 'credits-to-account'; }
  get title()       { return 'Credits to Account'; }
  get description() { return 'All positive balance changes per account — replenishments, contributions, earnings, and transfers in.'; }
  get perDiff()     { return true; }

  /** Mixed-currency by construction: see ACCOUNT_REPORT_CURRENCY. */
  reportCurrency(_params) { return ACCOUNT_REPORT_CURRENCY; }

  get facets() {
    return [
      { name: 'accountStateKeys', label: 'Accounts', kind: 'multiselect', optionsSource: 'account' },
      { name: 'period',           label: 'Period',   kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['stateKey']; }
  get defaultAggregates() {
    return {
      total: { fn: 'sum', field: 'stateDelta' },
      count: { fn: 'count'                    },
      max:   { fn: 'max', field: 'stateDelta' },
    };
  }

  buildQuery(params, api) {
    const { period, accountStateKeys } = params;
    const periodAst  = api.periodOfTaxYear(period);
    const conditions = [
      periodAst,
      { op: 'gt',       field: 'stateDelta', value: 0                 },
    ];
    _appendAccountBalanceScope(conditions, accountStateKeys, api);
    return { op: 'and', conditions };
  }

  /** Show the account NAME on each group row; g.key keeps the stateKey identity (design 70 §6.2). */
  decorate(groups, api) { return _labelAccountGroups(groups, api); }
}

class DebitsFromAccountDef extends ReportDefinition {
  get id()          { return 'debits-from-account'; }
  get title()       { return 'Debits from Account'; }
  get description() { return 'All negative balance changes per account — expenses, taxes, transfers out, and withdrawals.'; }
  get perDiff()     { return true; }

  /** Mixed-currency by construction: see ACCOUNT_REPORT_CURRENCY. */
  reportCurrency(_params) { return ACCOUNT_REPORT_CURRENCY; }

  get facets() {
    return [
      { name: 'accountStateKeys', label: 'Accounts', kind: 'multiselect', optionsSource: 'account' },
      { name: 'period',           label: 'Period',   kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['stateKey']; }
  get defaultAggregates() {
    return {
      total: { fn: 'sum', field: 'stateDelta' },
      count: { fn: 'count'                    },
      min:   { fn: 'min', field: 'stateDelta' },
    };
  }

  buildQuery(params, api) {
    const { period, accountStateKeys } = params;
    const periodAst  = api.periodOfTaxYear(period);
    const conditions = [
      periodAst,
      { op: 'lt',       field: 'stateDelta', value: 0                 },
    ];
    _appendAccountBalanceScope(conditions, accountStateKeys, api);
    return { op: 'and', conditions };
  }

  /** Show the account NAME on each group row; g.key keeps the stateKey identity (design 70 §6.2). */
  decorate(groups, api) { return _labelAccountGroups(groups, api); }
}

class TaxPaidByYearDef extends ReportDefinition {
  get id()          { return 'tax-paid-by-year'; }
  get title()       { return 'Tax Paid by Year'; }
  get description() { return 'Tax payments debited from cash by year (TAX_PAYMENT_DEBIT entries, excluding cross-border escalated re-issues). The US total includes federal AND state income tax; use "US State Tax by Year" to isolate the state portion, or "AU Tax by Person & Year" for the per-person AU drill-down. With Country left blank, AU payments are converted to USD at the run\'s recorded rate on the payment date, so the all-countries total is a single currency.'; }

  // Each country's own currency when a country is picked — an AU return's
  // figures belong in AUD. Blank cc mixes the two families, so it must name one:
  // USD, matching state.cumulativeTaxesPaid (which the reconciliation and every
  // lifetime-tax objective read).
  reportCurrency(params) { return params?.cc === 'AU' ? 'AUD' : 'USD'; }

  get facets() {
    return [
      { name: 'cc',         label: 'Country', kind: 'select', options: ['', 'US', 'AU'] },
      { name: 'period',     label: 'Period',  kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['year']; }
  get defaultSort()       { return [{ field: 'year', dir: 'asc' }]; }
  get defaultAggregates() {
    return {
      total: { fn: 'sum', field: 'amount' },
      count: { fn: 'count'                },
    };
  }

  // Route through PeriodService.aggregate() when the cc is known; fall back to
  // the generic groupBy:['year'] path when cc is '' (all countries) since the
  // two national period hierarchies don't share a common parent period.
  periodTypeFor(params) {
    if (params?.cc === 'US') return 'YEAR_US';
    if (params?.cc === 'AU') return 'YEAR_AU';
    return null;
  }

  buildQuery(params, api) {
    const { cc, period } = params;
    // Tax-year semantics: TAX_PAYMENT_DEBIT is chained from TAX_SETTLE_APPLY
    // and shares its date but has a higher seq. Seq-based bounds drop it from
    // the same-day window; the date-bounded tax-year window keeps it.
    const periodAst   = api.periodOfTaxYear(period);
    const actionTypes = api.familyTypes('TAX_PAYMENT_DEBIT', { cc });
    const conditions  = [
      periodAst,
      { op: 'in', field: 'actionType', value: actionTypes },
    ];
    _appendNotEscalated(conditions);
    return { op: 'and', conditions };
  }
}

/**
 * US state income tax paid by year (design 34). STATE_TAX_PAYMENT_DEBIT shares the
 * TAX_PAYMENT_DEBIT family (so it also rolls into "Tax Paid by Year" as part of the
 * US total), but this report isolates the state portion on its own.
 */
class StateTaxByYearDef extends ReportDefinition {
  get id()          { return 'state-tax-by-year'; }
  get title()       { return 'US State Tax by Year'; }
  get description() { return 'US state income tax debited from cash by year (STATE_TAX_PAYMENT_DEBIT entries, excluding cross-border escalated re-issues). The active state follows the primary person\'s residency state.'; }

  get facets() {
    return [
      { name: 'period', label: 'Period', kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['year']; }
  get defaultSort()       { return [{ field: 'year', dir: 'asc' }]; }
  get defaultAggregates() {
    return {
      total: { fn: 'sum', field: 'amount' },
      count: { fn: 'count'                },
    };
  }

  // State tax follows the US calendar year.
  periodTypeFor(_params) { return 'YEAR_US'; }

  buildQuery(params, api) {
    const { period } = params;
    // Tax-year semantics: STATE_TAX_PAYMENT_DEBIT is chained from
    // STATE_TAX_SETTLE_APPLY (Dec 31) and shares its date with a higher seq.
    const periodAst = api.periodOfTaxYear(period);
    const conditions = [
      periodAst,
      { op: 'eq', field: 'actionType', value: 'STATE_TAX_PAYMENT_DEBIT' },
    ];
    _appendNotEscalated(conditions);
    return { op: 'and', conditions };
  }
}

class AuTaxByPersonYearDef extends ReportDefinition {
  get id()          { return 'au-tax-by-person-year'; }
  get title()       { return 'AU Tax by Person & Year'; }
  get description() { return 'AU tax liability per person per year, fanned out from TAX_SETTLE_APPLY.personTaxDetails.'; }
  get perPerson()   { return true; }
  // Implicitly AU — the report has no cc facet, but its years are AU fiscal ones.
  get yearCc()      { return 'AU'; }

  // AU_TAX_SETTLE_APPLY is journaled once per reducer that consumes it (the
  // settle reducer and AccumulateTaxesPaidReducer), and the per-person
  // projection fans each of those out again per person — so without deduping,
  // every person's liability is summed once per reducer and each one reads as
  // the household total. Dedupe is per group, and personName is a group key, so
  // this collapses the reducer fan-out without merging the people.
  get dedupeBy()    { return 'instanceId'; }

  get facets() {
    return [
      { name: 'personKeys', label: 'People', kind: 'multiselect', optionsSource: 'person' },
      { name: 'period',     label: 'Period', kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['year', 'personName']; }
  get defaultSort()       { return [{ field: 'year', dir: 'asc' }]; }
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
  get defaultSort()       { return [{ field: 'year', dir: 'asc' }]; }
  get defaultAggregates() {
    return {
      total: { fn: 'sum', field: 'amount' },
      count: { fn: 'count'                },
    };
  }

  periodTypeFor(_params) { return 'YEAR_US'; }

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

  /** Mixed-currency by construction: see ACCOUNT_REPORT_CURRENCY. */
  reportCurrency(_params) { return ACCOUNT_REPORT_CURRENCY; }

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
    ];
    _appendAccountBalanceScope(conditions, accountStateKeys, api);
    return { op: 'and', conditions };
  }
}

// ─── QA / diagnostics definitions ─────────────────────────────────────────────

class JournalCompositionDef extends ReportDefinition {
  get id()          { return 'journal-composition'; }
  get title()       { return 'Journal Composition by Action Type'; }
  get description() {
    return 'Count of journal entries per action type for the period — a QA lens for '
         + 'spotting missing, extra, or unexpectedly-frequent actions after a change. '
         + 'Counts are journal ENTRIES (one per action×reducer execution), not distinct '
         + 'actions, so an action run through two reducers is counted twice.';
  }

  // Period-only: this is a whole-window census so that an action type is visible
  // by its *absence*. Account scoping is a per-stateDiff concept (it filters on the
  // dotted `stateKey` path, which bare entry rows don't carry) — left to a
  // per-diff "money moved by action type" variant.
  get facets() {
    return [
      { name: 'period', label: 'Period', kind: 'period' },
    ];
  }

  // One row per journal entry (the default, non-perDiff data source), grouped by
  // action type. `amount` is the action's native payload amount and is summed for
  // reference only — its meaning varies by action type and is null on entries that
  // carry no amount — so `count` is the headline and the default sort key.
  // `count`   — journal entries (action×reducer), the raw census.
  // `actions` — distinct actions (collapses the reducer fan-out via instanceId),
  //             so ROTH_CONVERSION_TAX reads 3 here but 6 under `count`.
  // `amount`  — Σ native payload amount; heterogeneous, reference only.
  get defaultGroupBy()    { return ['actionType']; }
  get defaultAggregates() {
    return {
      count:   { fn: 'count'                    },
      actions: { fn: 'distinct', field: 'instanceId' },
      amount:  { fn: 'sum',      field: 'amount' },
    };
  }
  get defaultSort() { return [{ field: 'count', dir: 'desc' }]; }

  buildQuery(params, api) {
    // No actionType/stateKey predicate: we want every entry in the window so
    // that absent action types stand out. Date-based tax-year bounds keep
    // same-day settle chains inside the period the user picked, consistent with
    // the other "what happened this CY/FY" reports.
    return { op: 'and', conditions: [api.periodOfTaxYear(params.period)] };
  }
}

class MoneyMovedByActionDef extends ReportDefinition {
  get id()          { return 'money-moved-by-action'; }
  get title()       { return 'Money Moved by Action Type'; }
  get description() {
    return 'How much cash each action type moved through account balances in the period. '
         + '`gross` is the magnitude moved (|Δ| summed, so offsetting legs like a rebalance '
         + 'do not cancel); `net` is the signed sum; `out`/`in` are the largest single debit/credit.';
  }
  get perDiff()     { return true; }

  /** Mixed-currency by construction: see ACCOUNT_REPORT_CURRENCY. */
  reportCurrency(_params) { return ACCOUNT_REPORT_CURRENCY; }

  get facets() {
    return [
      { name: 'accountStateKeys', label: 'Accounts', kind: 'multiselect', optionsSource: 'account' },
      { name: 'period',           label: 'Period',   kind: 'period' },
    ];
  }

  get defaultGroupBy()    { return ['actionType']; }
  get defaultAggregates() {
    return {
      count: { fn: 'count'                       },
      gross: { fn: 'sum', field: 'absStateDelta' },
      net:   { fn: 'sum', field: 'stateDelta'    },
      out:   { fn: 'min', field: 'stateDelta'    },
      in:    { fn: 'max', field: 'stateDelta'    },
    };
  }
  get defaultSort() { return [{ field: 'gross', dir: 'desc' }]; }

  buildQuery(params, api) {
    const { period, accountStateKeys } = params;
    const conditions = [
      api.periodOfTaxYear(period),
    ];
    _appendAccountBalanceScope(conditions, accountStateKeys, api);
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
      new NrWithholdingIncomeBySourceDef(),
      new PretaxAdjustmentsBySourceDef(),
      new CapitalGainsByDisposalDef(),
      new NiitBaseByComponentDef(),
      new CashFlowByAccountDef(),
      new WithdrawalsByAccountDef(),
      new CreditsToAccountDef(),
      new DebitsFromAccountDef(),
      new TaxPaidByYearDef(),
      new StateTaxByYearDef(),
      new AuTaxByPersonYearDef(),
      new RothConversionsByYearDef(),
      new RealPropertyCashFlowDef(),
      new JournalCompositionDef(),
      new MoneyMovedByActionDef(),
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
