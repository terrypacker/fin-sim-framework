/*
 * Copyright (c) 2026 Terry Packer.
 *
 * This file is part of Terry Packer's Work.
 * See www.terrypacker.com for further info.
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

import {currencyForCountry} from "../country-codes.js";

/**
 * Descriptor for how a state field value should be interpreted and displayed.
 * Used by the display layer to format raw numbers with the right currency,
 * unit, or precision — without baking that context into raw journal data.
 */
export class ParameterValueType {
  constructor(kind, options = {}) {
    this.kind         = kind;
    this.currencyCode = options.currencyCode ?? null; // string|null — for kind 'currency'
    this.precision    = options.precision    ?? 2;    // number      — for kind 'decimal'
  }

  static currency(code = null) { return new ParameterValueType('currency', { currencyCode: code }); }
  static rate()                { return new ParameterValueType('rate'); }
  static percentage()          { return new ParameterValueType('percentage'); }
  static integer()             { return new ParameterValueType('integer'); }
  static decimal(precision=2)  { return new ParameterValueType('decimal', { precision }); }
  static boolean()             { return new ParameterValueType('boolean'); }
  static date()                { return new ParameterValueType('date'); }
  static text()                { return new ParameterValueType('text'); }
  static metric()              { return new ParameterValueType('metric'); }
  static unknown()             { return new ParameterValueType('unknown'); }
}

function _globToRegex(glob) {
  // Escape regex special chars (but not *)
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // ** before * to avoid double-replace
  const pattern = escaped.replace(/\*\*/g, '.+').replace(/\*/g, '[^.]+');
  return new RegExp(`^${pattern}$`);
}

/**
 * Default income currency for a person — derived from residency, then first
 * citizenship, falling back to USD. Used when a person carries no explicit
 * wageCurrency / ssCurrency.
 */
function _personDefaultCurrency(person) {
  return currencyForCountry(person?.residency)
    ?? currencyForCountry(person?.citizen?.[0])
    ?? 'USD';
}

/** Currency symbol for a code, e.g. 'USD' → '$', 'AUD' → 'A$'. */
function _currencySymbol(code) {
  if (!code) return '$';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
      .formatToParts(0).find(p => p.type === 'currency')?.value ?? '$';
  } catch { return '$'; }
}

function _fmt(vt, value) {
  if (value == null) return '—';
  switch (vt.kind) {
    case 'currency': {
      if (typeof value !== 'number') return String(value);
      if (vt.currencyCode) {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: vt.currencyCode }).format(value);
      }
      return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    case 'rate':
      return typeof value === 'number'
        ? value.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 6 })
        : String(value);
    case 'percentage':
      return typeof value === 'number' ? `${(value * 100).toFixed(2)}%` : String(value);
    case 'integer':
    case 'metric':
      return typeof value === 'number' ? Math.round(value).toLocaleString('en-US') : String(value);
    case 'decimal':
      return typeof value === 'number'
        ? value.toLocaleString('en-US', { minimumFractionDigits: vt.precision, maximumFractionDigits: vt.precision })
        : String(value);
    case 'boolean':
      return String(value);
    case 'date':
      return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
    case 'text':
    case 'unknown':
    default:
      return typeof value === 'number'
        ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : String(value);
  }
}

/**
 * Maps state field paths to ValueType descriptors so the display layer can
 * format raw journal values with correct currency, unit, and precision.
 *
 * Resolution order: exact path → first matching glob pattern → unknown.
 * registerAccount() stamps exact paths from a stamped Account, overriding
 * any glob pattern for that account's fields.
 *
 * Usage:
 *   registry.registerPattern('effectiveExchangeRates.*', ParameterValueType.rate());
 *   registry.registerPattern('*.balance', ParameterValueType.currency());
 *   registry.registerAccount('usSavingsAccount', account); // exact → currency('USD')
 *   registry.format('usSavingsAccount.balance', 50000);    // → '$50,000.00'
 */
export class StateSchemaRegistry {
  constructor() {
    this._exact    = new Map(); // path → ParameterValueType
    this._patterns = [];       // [{ glob, re, vt }] ordered by registration

    // Display-currency conversion wiring (design 10 §Phase 4). Injected by the
    // app layer; duck-typed so this finance-layer class needs no UI imports.
    this._displaySettings    = null; // { get displayCurrency }
    this._currencyConverter  = null; // CurrencyConverter
    this._rateStateProvider  = null; // () => state snapshot carrying effectiveExchangeRates
    this._warnedCodeless     = new Set(); // paths already warned about (dev)

    // ── Glob patterns ─────────────────────────────────────────────────────────
    this.registerPattern('*.balance',           ParameterValueType.currency());
    this.registerPattern('*.contributionBasis', ParameterValueType.currency());
    this.registerPattern('*.earningsBasis',     ParameterValueType.currency());
    // Per-country residency cost-base step-up / per-lot AU cost base (design 36 §12.2).
    this.registerPattern('*.costBaseStepUpByCountry.*',   ParameterValueType.currency());
    this.registerPattern('*.holdings.*.costBaseByCountry.*', ParameterValueType.currency());
    this.registerPattern('*.minimumBalance',    ParameterValueType.currency());
    this.registerPattern('metrics.*',           ParameterValueType.metric());
    // Money metrics are aggregates in the USD base currency (computeNetWorth /
    // computeNetLiquidity). Type them as currency so the display layer converts
    // them (design 10 §Phase 4); exact paths override the generic metrics.* glob.
    this.register('metrics.netWorth',     ParameterValueType.currency('USD'));
    this.register('metrics.netLiquidity', ParameterValueType.currency('USD'));
    // After-tax re-priced aggregates (design/40) — USD-normalized like the above.
    this.register('metrics.afterTaxNetWorth',     ParameterValueType.currency('USD'));
    this.register('metrics.afterTaxNetLiquidity', ParameterValueType.currency('USD'));
    // Lifetime running accumulators, USD-normalized (design 38 §5). Exact paths
    // so the chart/state-panel format them as money.
    this.register('cumulativeTaxesPaid',   ParameterValueType.currency('USD'));
    this.register('cumulativeConsumption', ParameterValueType.currency('USD'));
    // CRRA running utility of consumption (design 39 §4) — a unitless utility sum.
    this.register('cumulativeConsumptionUtility', ParameterValueType.decimal(2));

    // Holdings (design 25 §5.6). Per-account exact paths take precedence
    // when an account stamps them with its specific currency; globs cover
    // anything the per-account stamp misses.
    this.registerPattern('*.holdings.*.marketValue', ParameterValueType.currency());
    this.registerPattern('*.holdings.*.costBasis',   ParameterValueType.currency());
    this.registerPattern('*.holdings.*.allocation',  ParameterValueType.text());
    this.registerPattern('*.holdings.*.rateKey',     ParameterValueType.text());
    this.registerPattern('*.holdings.*.label',       ParameterValueType.text());
    this.registerPattern('*.holdings.*.purchaseDate', ParameterValueType.date());
    this.registerPattern('*.holdings.*.dividendYield',       ParameterValueType.rate());
    this.registerPattern('*.holdings.*.couponRate',          ParameterValueType.rate());
    this.registerPattern('*.holdings.*.duration',            ParameterValueType.decimal(2));
    this.registerPattern('*.holdings.*.appreciationSchedule', ParameterValueType.unknown());

    // ── FX rate/fee maps ──────────────────────────────────────────────────────
    this.registerPattern('baseExchangeRates.*',      ParameterValueType.rate());
    this.registerPattern('effectiveExchangeRates.*', ParameterValueType.rate());
    // Time-varying FX stochastic layer (design 47) — unitless scalars.
    this.registerPattern('fxDeviation.*',    ParameterValueType.decimal(4));
    this.registerPattern('baseFxVol.*',      ParameterValueType.decimal(4));
    this.registerPattern('effectiveFxVol.*', ParameterValueType.decimal(4));
    this.registerPattern('fxAnchorRates.*',  ParameterValueType.rate());

    // ── Economic regime effective/base rates (design 21) ─────────────────────
    // Growth rates are per-account-type (EQUITY_US_ROTH, EQUITY_US_IRA, …) so
    // each account's effective rate is independently chartable.
    this.registerPattern('effectiveGrowthRates.*',       ParameterValueType.rate());
    this.registerPattern('baseGrowthRates.*',            ParameterValueType.rate());
    this.registerPattern('effectiveInflationRates.*',    ParameterValueType.rate());
    this.registerPattern('effectiveAppreciationRates.*', ParameterValueType.rate());
    this.registerPattern('effectiveInterestRates.*',     ParameterValueType.rate());
    this.registerPattern('baseInflationRates.*',         ParameterValueType.rate());
    this.registerPattern('baseAppreciationRates.*',      ParameterValueType.rate());
    this.registerPattern('baseInterestRates.*',          ParameterValueType.rate());
    this.registerPattern('inflationRates.*',             ParameterValueType.rate());
    this.registerPattern('baseFxFees.*',             ParameterValueType.currency('USD'));
    this.registerPattern('effectiveFxFees.*',        ParameterValueType.currency('USD'));

    // ── Well-known exact fields ───────────────────────────────────────────────
    this.registerPattern('people.*.residency',      ParameterValueType.text());
    this.registerPattern('people.*.residencyState', ParameterValueType.text());
    // Move date (ms) stamped by ChangeResidencyApplyReducer — backs the FEIE
    // full-qualifying-year gate (design 52 §4.2).
    this.registerPattern('people.*.residencySinceMs', ParameterValueType.date());
    // Person income (monthlyWage / socialSecurityMonthly) is stamped per-person and
    // per-field via registerPerson() (design 10 §Phase 5), keyed on each person's
    // wageCurrency / ssCurrency. No code-less glob remains so an unstamped person
    // surfaces as `unknown` (caught by the coverage guard) rather than a wrong code.
    this.register('scenarioFailed',              ParameterValueType.boolean());
    this.register('scenarioComplete',            ParameterValueType.boolean());
    this.register('superWithdrawalBlocked',      ParameterValueType.boolean());
    this.register('usFilingSingle',              ParameterValueType.boolean());
    this.register('outOfFundsDate',              ParameterValueType.date());
    this.registerPattern('deceased.*.date',           ParameterValueType.date());
    this.registerPattern('deceased.*.taxJurisdiction', ParameterValueType.text());
    this.register('monthlyExpenses',             ParameterValueType.currency('USD'));
    this.register('expenses.essential',          ParameterValueType.currency('USD'));
    this.register('expenses.discretionary',      ParameterValueType.currency('USD'));
    this.register('ageBandSpending.appliedFactor', ParameterValueType.decimal(4));

    // US YTD
    this.register('usOrdinaryIncomeYTD',         ParameterValueType.currency('USD'));
    this.register('usNegativeIncomeYTD',         ParameterValueType.currency('USD'));
    this.register('usCapitalGainsYTD',           ParameterValueType.currency('USD'));
    this.register('usCollectibleGainsYTD',       ParameterValueType.currency('USD'));
    this.register('usPenaltyYTD',                ParameterValueType.currency('USD'));
    // Deprecated pre-52 field: retained only as a back-compat read shim so old
    // saves deserialize with the right currency typing. No live code writes it;
    // design 52 replaced it with the sourced/basketed relief fields below.
    this.register('ftcYTD',                      ParameterValueType.currency('USD'));
    this.register('cumulativeDeficit',           ParameterValueType.currency('USD'));

    // Cross-border relief — US side, canonical USD (design 52).
    // §904 foreign-source numerators (post-FEIE), per basket.
    this.register('foreignGeneralIncomeYTD',     ParameterValueType.currency('USD'));
    this.register('foreignPassiveIncomeYTD',     ParameterValueType.currency('USD'));
    // Current-year AU foreign tax available to credit this US settle, per basket
    // (funded at the AU settle §4.4, consumed + banked at the US settle §4.3).
    this.register('ftcCurrentGeneral',           ParameterValueType.currency('USD'));
    this.register('ftcCurrentPassive',           ParameterValueType.currency('USD'));
    // 10-year carryforward pools, per basket: { [vintageCY]: remainingUSD }.
    this.registerPattern('ftcPoolGeneral.*',     ParameterValueType.currency('USD'));
    this.registerPattern('ftcPoolPassive.*',     ParameterValueType.currency('USD'));
    // US-source income booked while AU-resident — the FITO "without" removal set,
    // captured in both currencies (USD funds §4.6, AUD funds §4.5).
    this.register('usSourceOrdinaryUsdYTD',      ParameterValueType.currency('USD'));
    this.register('usSourceCapGainsUsdYTD',      ParameterValueType.currency('USD'));

    // Cross-border relief — AU side, canonical AUD (design 52).
    this.register('usSourceOrdinaryAudYTD',      ParameterValueType.currency('AUD'));
    this.register('usSourceCapGainsAudYTD',      ParameterValueType.currency('AUD'));
    // US-source *real* (indexed) AU cap gain (AUD) — FY2027 FITO "without" CG slice
    // (design 57 Part 2, Item D).
    this.register('usSourceRealCapGainsAudYTD',  ParameterValueType.currency('AUD'));
    // US tax paid on US-source income (AUD), the FITO input; single-year handoff.
    this.register('usTaxPaidOnUsSourceAud',      ParameterValueType.currency('AUD'));
    // FEIE election (param): whether the Foreign Earned Income Exclusion is elected.
    this.register('usFeieElected',               ParameterValueType.boolean());

    // US state income tax YTD (design 34) — USD
    this.register('stateOrdinaryIncomeYTD',      ParameterValueType.currency('USD'));
    this.register('statePensionIncomeYTD',       ParameterValueType.currency('USD'));
    this.register('stateSsIncomeYTD',            ParameterValueType.currency('USD'));
    this.register('stateCapitalGainsYTD',        ParameterValueType.currency('USD'));

    // AU YTD
    this.register('auOrdinaryIncomeYTD',         ParameterValueType.currency('AUD'));
    this.register('auCapitalGainsYTD',           ParameterValueType.currency('AUD'));
    this.register('auDiscountableGainsYTD',      ParameterValueType.currency('AUD'));
    this.register('auRealCapitalGainsYTD',       ParameterValueType.currency('AUD'));
    this.register('auNonResidentWithholdingYTD', ParameterValueType.currency('AUD'));
    this.register('auSuperTaxYTD',               ParameterValueType.currency('AUD'));
    this.register('auFrankingCreditYTD',         ParameterValueType.currency('AUD'));

    // AU per-person YTD (design 10 §Phase 3) — jurisdiction-fixed AUD
    this.registerPattern('auPersonOrdinaryIncomeYTD.*',         ParameterValueType.currency('AUD'));
    this.registerPattern('auPersonCapitalGainsYTD.*',           ParameterValueType.currency('AUD'));
    this.registerPattern('auPersonRealCapitalGainsYTD.*',       ParameterValueType.currency('AUD'));
    this.registerPattern('auPersonFrankingCreditYTD.*',         ParameterValueType.currency('AUD'));
    this.registerPattern('auPersonNonResidentWithholdingYTD.*', ParameterValueType.currency('AUD'));
    this.registerPattern('auPersonSuperTaxYTD.*',               ParameterValueType.currency('AUD'));
    // FEIE cap accumulator (design 52 §4.2): AU-source *earned* income only
    // (wages/SE), per person — distinct from auPersonOrdinaryIncomeYTD which mixes
    // wages with AU interest/rent and so cannot back the per-person FEIE cap.
    this.registerPattern('auPersonEarnedIncomeYTD.*',           ParameterValueType.currency('AUD'));

    this.register('inflationAccumulator',        ParameterValueType.decimal(4));
    // Dedicated ATO CPI indexation series (design 57 Part 2, Item A) — unitless
    // price level + per-country rate for AU CGT cost-base indexation.
    this.register('cpiAccumulator',              ParameterValueType.decimal(4));
    this.registerPattern('cpiRates.*',           ParameterValueType.rate());

    // Bond mark-to-market snapshot (design 28 §5)
    this.registerPattern('priorMarkRates.*',     ParameterValueType.rate());

    // Behavioral layer (design/29 §6)
    this.register('contributionsSuspended',      ParameterValueType.boolean());
    this.registerPattern('*.holdings.*.taxLossPartner', ParameterValueType.text());
  }

  /**
   * Register an exact-path → ValueType mapping.
   * Overwrites any prior registration for the same path.
   */
  register(path, valueType) {
    this._exact.set(path, valueType);
  }

  /**
   * Register a glob pattern → ValueType mapping.
   * Patterns are tested in registration order; first match wins.
   * Supported wildcards: `*` = one segment (no dots), `**` = any segments.
   * Idempotent: re-registering the same glob replaces the prior entry (the
   * registry is reused across scenario rebuilds, so callers may re-register).
   */
  registerPattern(glob, valueType) {
    this._removePattern(glob);
    this._patterns.push({ glob, re: _globToRegex(glob), vt: valueType });
  }

  /**
   * Like registerPattern but inserts at the front, so this glob is tested
   * before any previously-registered (less specific) pattern. Used for
   * per-account / per-asset holdings paths that must win over the generic
   * code-less `*.holdings.*` globs registered in the constructor.
   */
  registerPatternFront(glob, valueType) {
    this._removePattern(glob);
    this._patterns.unshift({ glob, re: _globToRegex(glob), vt: valueType });
  }

  _removePattern(glob) {
    const i = this._patterns.findIndex(p => p.glob === glob);
    if (i !== -1) this._patterns.splice(i, 1);
  }

  /**
   * Register exact field paths for an account, using the account's currency.
   * Call once per account immediately after _assignAccount() stamps stateKey.
   * Exact registrations override any matching glob pattern for that account.
   *
   * @param {string}  stateKey  - e.g. 'usSavingsAccount'
   * @param {object}  account   - Account instance; reads account.currency?.code
   */
  registerAccount(stateKey, account) {
    const code = account?.currency?.code ?? null;
    const vt   = ParameterValueType.currency(code);
    this.register(`${stateKey}.balance`,          vt);
    // The contribution/earnings ledger lives only on RetirementAccount (design 53 §2);
    // register its display paths only when the account actually carries them.
    if ('contributionBasis' in account) this.register(`${stateKey}.contributionBasis`, vt);
    if ('earningsBasis' in account)     this.register(`${stateKey}.earningsBasis`,     vt);
    // Loan (liability) interest rate (design 54).
    if ('interestRate' in account)      this.register(`${stateKey}.interestRate`, ParameterValueType.rate());
    this.register(`${stateKey}.minimumBalance`,   vt);
    this.register(`${stateKey}.loanBalance`,      vt);
    // The per-account balance is also recorded into state.metrics[stateKey] via
    // RecordBalanceAction(`${stateKey}.balance`, stateKey) for charting; type it
    // as the account's currency so the chart/state-panel convert it (design 10
    // §Phase 4) — otherwise it falls through the generic `metrics.*` → metric glob.
    this.register(`metrics.${stateKey}`,          vt);
    // Holdings per-account stamp with the account's currency (design 25 §5.6).
    // Front-inserted so the coded per-account pattern wins over the generic
    // code-less `*.holdings.*` globs registered in the constructor.
    this.registerPatternFront(`${stateKey}.holdings.*.marketValue`, vt);
    this.registerPatternFront(`${stateKey}.holdings.*.costBasis`,   vt);
  }

  /**
   * Register exact money field paths for a RealProperty / Collectible, using
   * the asset's currency code (falling back to its country when the currency
   * descriptor is absent). Mirrors registerAccount() for non-account assets so
   * the display layer can resolve a native currency for conversion (design 10).
   *
   * @param {string} stateKey  - e.g. 'usHouseProperty'
   * @param {object} asset     - RealProperty | Collectible; reads currency?.code or country
   */
  registerAsset(stateKey, asset) {
    const code = asset?.currency?.code ?? currencyForCountry(asset?.country);
    const vt   = ParameterValueType.currency(code);
    this.register(`${stateKey}.value`,                   vt);
    this.register(`${stateKey}.costBasis`,               vt);
    this.register(`${stateKey}.mortgageBalance`,         vt);
    this.register(`${stateKey}.monthlyMortgage`,         vt);
    this.register(`${stateKey}.balanceAtResidencyChange`, vt);
    // Rental income (design 48)
    this.register(`${stateKey}.monthlyRent`,             vt);
    this.register(`${stateKey}.accumulatedDepreciation`, vt);
    this.register(`${stateKey}.occupancyRate`,           ParameterValueType.rate());
    this.register(`${stateKey}.rentalExpenseRatio`,      ParameterValueType.rate());
    this.register(`${stateKey}.mortgageInterestRate`,    ParameterValueType.rate());
    this.register(`${stateKey}.landValueRatio`,          ParameterValueType.rate());
  }

  /**
   * Register exact income field paths for a person, using the person's
   * per-field native currency (design 10 §Phase 5). wageCurrency stamps
   * `people.<id>.monthlyWage`; ssCurrency stamps
   * `people.<id>.socialSecurityMonthly`. Each defaults from residency /
   * citizenship when the person carries no explicit code.
   *
   * @param {object} person  Person instance; reads id, wageCurrency, ssCurrency
   */
  registerPerson(person) {
    const id = person?.id;
    if (!id) return;
    const fallback = _personDefaultCurrency(person);
    const wage = person.wageCurrency ?? fallback;
    const ss   = person.ssCurrency   ?? fallback;
    this.register(`people.${id}.monthlyWage`,           ParameterValueType.currency(wage));
    this.register(`people.${id}.socialSecurityMonthly`, ParameterValueType.currency(ss));
  }

  /**
   * Stamp a list of exact state paths to a single currency code. Used for
   * free-standing money params (design 10 §Phase 5) whose native currency is
   * chosen in the param editor (e.g. monthlyExpenses → its expense breakdown).
   *
   * @param {string[]} paths  exact state field paths
   * @param {string}   code   currency code (e.g. 'USD' / 'AUD')
   */
  registerCurrencyPaths(paths, code) {
    if (!code || !Array.isArray(paths)) return;
    const vt = ParameterValueType.currency(code);
    for (const path of paths) this.register(path, vt);
  }

  /**
   * Resolve the ValueType for a field path.
   * Returns ValueType.unknown() when no registration matches.
   *
   * @param {string} fieldPath - e.g. 'usSavingsAccount.balance'
   * @returns {ParameterValueType}
   */
  resolve(fieldPath) {
    const exact = this._exact.get(fieldPath);
    if (exact) return exact;
    for (const { re, vt } of this._patterns) {
      if (re.test(fieldPath)) return vt;
    }
    return ParameterValueType.unknown();
  }

  /** Inject the AppDisplaySettings (read for the active display currency). */
  set displaySettings(ds)   { this._displaySettings   = ds ?? null; }
  /** The injected AppDisplaySettings, or null. Read by plugins for timezone-aware
   *  date formatting (formatDate) and the active display currency. */
  get displaySettings()     { return this._displaySettings; }

  /** Inject the CurrencyConverter used for native → display conversion. */
  set currencyConverter(c)  { this._currencyConverter = c ?? null; }

  /**
   * Inject a provider returning the state snapshot whose recorded exchange
   * rate should be used when a caller does not pass an explicit `{ state }`.
   * Typically `() => sim.state`.
   */
  set rateStateProvider(fn) { this._rateStateProvider = fn ?? null; }

  /**
   * Format a value using its registered ValueType.
   * For unknown or non-numeric types that need richer formatting
   * (dates, objects, arrays), returns null so the caller can fall back
   * to its own renderer.
   *
   * When a display currency is wired and differs from a currency field's native
   * code, the value is converted (design 10 §Phase 4) and formatted with the
   * display currency's symbol. Conversion uses `opts.state` when provided (the
   * snapshot relevant to that value), else the injected rate-state provider. If
   * no rate is available the value renders in its native currency unchanged.
   *
   * @param {string} fieldPath
   * @param {*}      value
   * @param {{ state?: object }} [opts]  state snapshot for the conversion rate
   * @returns {string|null}  formatted string, or null for unknown/non-scalar
   */
  format(fieldPath, value, opts = {}) {
    if (value == null) return '—';
    const vt = this.resolve(fieldPath);
    if (vt.kind === 'unknown' && typeof value !== 'number') return null;
    if (vt.kind === 'currency' && typeof value === 'number') {
      const display = this._toDisplayCurrency(vt, fieldPath, value, opts.state);
      if (display) return _fmt(display.vt, display.value);
    }
    return _fmt(vt, value);
  }

  /**
   * Resolve a currency value to the active display currency, or null when no
   * conversion should apply (no display preference, already native, code-less
   * source, or no rate available).
   *
   * @returns {{ vt: ParameterValueType, value: number } | null}
   */
  _toDisplayCurrency(vt, fieldPath, value, state) {
    const display = this._displaySettings?.displayCurrency;
    if (!display || !this._currencyConverter) return null;
    const native = vt.currencyCode;
    if (!native) { this._warnCodeless(fieldPath); return null; }
    if (native === display) return null;
    const src       = state ?? this._rateStateProvider?.() ?? null;
    const converted = this._currencyConverter.convert(value, native, display, src);
    if (converted == null) return null; // no recorded rate → render native
    return { vt: ParameterValueType.currency(display), value: converted };
  }

  /** The active display currency code, or null when none is wired. */
  displayCurrencyCode() { return this._displaySettings?.displayCurrency ?? null; }

  /**
   * Convert a raw amount from its native code to the active display currency,
   * returning the pieces for callers that do their own (e.g. compact "$1.5M")
   * formatting rather than full Intl currency output.
   *
   * @param {number} value
   * @param {string} nativeCode  e.g. 'USD'
   * @returns {{ value: number, code: string, symbol: string }}
   */
  convertForDisplay(value, nativeCode) {
    let code = nativeCode, amount = value;
    const display = this._displaySettings?.displayCurrency;
    if (display && this._currencyConverter && display !== nativeCode) {
      const state = this._rateStateProvider?.() ?? null;
      const conv  = this._currencyConverter.convert(value, nativeCode, display, state);
      if (conv != null) { code = display; amount = conv; }
    }
    return { value: amount, code, symbol: _currencySymbol(code) };
  }

  /**
   * Format a raw amount given its native currency code (not a state path),
   * converting to the active display currency when one is set and differs.
   * Used for action-payload money fields whose currency comes from the
   * TypeRegistry rather than a registered state path. Returns null for
   * non-numeric input.
   *
   * @param {number} value
   * @param {string} nativeCode  e.g. 'USD'
   * @returns {string|null}
   */
  formatAmount(value, nativeCode, opts = {}) {
    if (typeof value !== 'number' || !nativeCode) return null;
    let code = nativeCode, amount = value;
    const display = this._displaySettings?.displayCurrency;
    if (display && this._currencyConverter && display !== nativeCode) {
      const state = this._rateStateProvider?.() ?? null;
      const conv  = this._currencyConverter.convert(value, nativeCode, display, state);
      if (conv != null) { code = display; amount = conv; }
    }
    const max = opts.maximumFractionDigits ?? 2;
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: code,
      minimumFractionDigits: Math.min(2, max), maximumFractionDigits: max,
    }).format(amount);
  }

  /** Warn once per path when a currency value cannot be converted (no code). */
  _warnCodeless(fieldPath) {
    if (this._warnedCodeless.has(fieldPath)) return;
    this._warnedCodeless.add(fieldPath);
    console.warn(
      `[StateSchemaRegistry] currency conversion requested for '${fieldPath}' but ` +
      `no native currencyCode is registered; rendering native.`,
    );
  }

}
