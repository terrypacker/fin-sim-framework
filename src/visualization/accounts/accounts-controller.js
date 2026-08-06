/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { AccountBuilder } from '../../finance/builders/account-builder.js';
import { USD, AUD }       from '../../finance/assets/account.js';
import { ACCOUNT_ROLES }  from '../../finance/state/account-roles.js';
import { deriveEarningsBasis } from '../../finance/assets/investment-account.js';

// Account types whose country/currency are variable (US or AU).
const VARIABLE_COUNTRY = new Set(['checking', 'savings', 'brokerage', 'offset', 'loan']);

// Loan (liability) fields the editor sends (design 54 §2 + design 86 terms). Split by
// coercion so create() and update() agree on what a blank field means: a nullable
// number stays null ("unset"), never 0 — 0 is a real maturity year and a real
// "nothing is deductible" fraction.
// `interestRate` is deliberately absent: the generic line above already coerces it,
// and it must stay nullable there (a cash account clearing its rate sends null, which
// a loan-style `Number(null) || 0` would silently turn into a 0% pinned rate).
const LOAN_NUM_FIELDS      = ['monthlyPayment'];
const LOAN_NULLABLE_FIELDS = ['interestOnlyUntilYear', 'maturityYear', 'deductibleFraction', 'bookingFxRate'];
const LOAN_KEY_FIELDS      = ['linkedPropertyKey', 'paymentSourceKey'];

/**
 * Derive the semantic {@link ACCOUNT_ROLES} role for a UI-created account from its
 * editor `type` (+ country for the variable-country types). Without a role an
 * account is invisible to the engine — every toolset selects accounts by role
 * (`accounts.filter(a => a.role === …)`), so a roleless account never gets a
 * state entry, growth, drawdown, or a net-worth contribution.
 *
 * Note: the editor's single "brokerage" type maps to the STOCK role (the common
 * case); a fixed-income brokerage cannot be distinguished from the form, so it
 * must be set on the record directly if needed. Checking is treated as a cash
 * account (savings role — the cash band / transaction pool).
 */
function _deriveRole(type, country) {
  const au = country === 'AU';
  switch (type) {
    case 'checking':
    case 'savings':   return au ? ACCOUNT_ROLES.AU_SAVINGS : ACCOUNT_ROLES.US_SAVINGS;
    case 'brokerage': return au ? ACCOUNT_ROLES.AU_STOCK   : ACCOUNT_ROLES.US_STOCK;
    case '401k':      return ACCOUNT_ROLES.K401;
    case 'roth':      return ACCOUNT_ROLES.ROTH;
    case 'ira':       return ACCOUNT_ROLES.IRA;
    case 'super':     return ACCOUNT_ROLES.SUPER;
    case 'offset':    return au ? ACCOUNT_ROLES.AU_OFFSET : ACCOUNT_ROLES.US_OFFSET;
    case 'loan':      return au ? ACCOUNT_ROLES.AU_LOAN   : ACCOUNT_ROLES.US_LOAN;
    default:          return null;
  }
}

// Retirement account types — the only ones carrying the contribution/earnings
// ledger (design 53 §2). Brokerage is holdings-only and its builder has no basis
// setters, so it must be excluded from the basis-write path below.
const RETIREMENT_TYPES = new Set(['401k', 'roth', 'ira', 'super']);

/** Coerce a form value to a number, treating blank/absent/garbage as 0. */
function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Coerce a form value to a number OR null. Blank/absent stays null — "unset", which
 * for every design-86 loan field means the pre-86 behaviour. Collapsing it to 0 would
 * author a maturity year of 0 and a 0% deductible fraction instead.
 */
function _nullableNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map a currency code string to its descriptor ({code, symbol}); null when unknown. */
function _currencyDescriptor(code) {
  if (code === 'AUD') return AUD;
  if (code === 'USD') return USD;
  return null;
}

/**
 * AccountsController — pure domain layer for Account CRUD.
 * No DOM, no bus, no globals — all dependencies injected.
 */
export class AccountsController {
  /** @param {{ accountService: import('../../finance/services/account-service.js').AccountService }} */
  constructor({ accountService }) {
    this._service = accountService;
  }

  /**
   * Build and register a new account from raw form data.
   *
   * @param {{
   *   type: string, name: string, balance: number|string,
   *   country: string, ownershipType: string, ownerId: string|null,
   *   minimumBalance: number|string, drawdownPriority: number|string|null,
   *   contributionBasis?: number|string, earningsBasis?: number|string
   * }} data
   */
  create(data) {
    const builder = this._builderFor(data.type);

    builder
      .name(data.name)
      .balance(Number(data.balance) || 0)
      .ownershipType(data.ownershipType || 'sole')
      .ownerId(data.ownerId || null)
      .minimumBalance(Number(data.minimumBalance) || 0);

    const dp = data.drawdownPriority;
    if (dp !== '' && dp != null) builder.drawdownPriority(Number(dp));

    if (VARIABLE_COUNTRY.has(data.type)) {
      const ctry = data.country || 'US';
      // Explicit currency override from the editor, else default by country.
      const cur = _currencyDescriptor(data.currency) ?? (ctry === 'AU' ? AUD : USD);
      builder.country(ctry).currency(cur);
    } else {
      // Fixed-country accounts (401k/roth/ira/super) still honor an explicit
      // currency override when one was chosen; the builder otherwise pins it.
      const cur = _currencyDescriptor(data.currency);
      if (cur) builder.currency(cur);
    }

    if (RETIREMENT_TYPES.has(data.type)) {
      if (data.contributionBasis != null && data.contributionBasis !== '') {
        builder.contributionBasis(Number(data.contributionBasis));
      }
      // earningsBasis is DERIVED, never read from the form (design 53 §8) — see
      // deriveEarningsBasis after build(). The builder seeds it to 0; we overwrite.
    }

    // Offset account (design 53 §3 / 54 P3): links to the property whose loan it offsets.
    if (data.type === 'offset') {
      builder.offsetsPropertyKey(data.offsetsPropertyKey || null);
    }

    // Loan (liability) terms (design 54 §2 + design 86 G2/G3/G6/G7). Every setter is
    // called unconditionally so an omitted field lands on the builder's default
    // (0 / false / null) rather than on whatever a previous edit left — the builder
    // defaults ARE the pre-86 loan.
    if (data.type === 'loan') {
      builder
        .interestRate(_num(data.interestRate))
        .monthlyPayment(_num(data.monthlyPayment))
        .linkedPropertyKey(data.linkedPropertyKey || null)
        .paymentSourceKey(data.paymentSourceKey  || null)
        .interestOnly(!!data.interestOnly)
        .deductibleFraction(_nullableNum(data.deductibleFraction))
        .interestOnlyUntilYear(_nullableNum(data.interestOnlyUntilYear))
        .maturityYear(_nullableNum(data.maturityYear))
        .bookingFxRate(_nullableNum(data.bookingFxRate));
    }

    const account = builder.build();
    // earningsBasis = max(0, balance − contributionBasis) (design 53 §8). Derived
    // from the seed the user can actually know; the builder's default-0 is replaced.
    if (RETIREMENT_TYPES.has(data.type)) deriveEarningsBasis(account);
    // Wire the account into the engine: a role selects its behavior, a stateKey
    // is where its balance lives in sim.state. The builder sets neither, so a
    // created account is inert until we stamp them here (design 55 §3.1 —
    // stateKey-at-creation).
    account.role     = _deriveRole(data.type, data.country);
    account.stateKey = this._generateStateKey(account.role, account.ownerId);
    // Transaction-account flag (design 55 §7). Cash accounts only; the editor omits
    // the field for other types. A new account has no generated param yet, so the
    // flag rides the create payload rather than the param cascade.
    if ('isTransactionAccount' in data) account.isTransactionAccount = !!data.isTransactionAccount;
    // Prime-relative cash rate (design 56). The editor sends the derived spread (or a
    // legacy absolute when no Prime is configured); the builder has no setter, so stamp
    // them directly. null → not Prime-linked / unset (global default).
    if ('primeSpread'  in data) account.primeSpread  = data.primeSpread  == null ? null : Number(data.primeSpread);
    if ('interestRate' in data) account.interestRate = data.interestRate == null ? null : Number(data.interestRate);
    return this._service.createAccount(account);
  }

  /**
   * Generate a scenario-unique, camelCase stateKey for a new account. Based on the
   * role + owner so it reads like the built-in keys (e.g. `usStockAccount`,
   * `superSpouseAccount`), with a numeric suffix to avoid colliding with an
   * existing key (including the prebuilt defaults).
   * @private
   */
  _generateStateKey(role, ownerId) {
    const existing  = new Set((this._service?.getAll?.() ?? []).map(a => a.stateKey).filter(Boolean));
    const roleCamel = (role ?? 'account').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const ownerPart = ownerId && ownerId !== 'primary'
      ? ownerId.charAt(0).toUpperCase() + ownerId.slice(1)
      : '';
    const base = `${roleCamel}${ownerPart}`;
    let key = `${base}Account`;
    for (let n = 2; existing.has(key); n++) key = `${base}${n}Account`;
    return key;
  }

  /**
   * Apply field-level updates to an existing account.
   * Type cannot change after creation.
   *
   * @param {string} id
   * @param {object} changes
   */
  update(id, changes) {
    const n = { ...changes };
    if ('balance'          in n) n.balance          = Number(n.balance)          || 0;
    if ('minimumBalance'   in n) n.minimumBalance   = Number(n.minimumBalance)   || 0;
    if ('contributionBasis'in n) n.contributionBasis= Number(n.contributionBasis)|| 0;
    // earningsBasis is NOT an input (design 53 §8): the editor omits it, and the
    // service re-derives it from balance − contributionBasis after mergeChanges. Drop
    // any stray value so a caller can't reassert a hand-set earnings on update.
    if ('earningsBasis' in n) delete n.earningsBasis;
    if ('drawdownPriority' in n) {
      const dp = n.drawdownPriority;
      n.drawdownPriority = (dp === '' || dp == null) ? null : Number(dp);
    }
    if ('isTransactionAccount' in n) n.isTransactionAccount = !!n.isTransactionAccount;
    // Prime-relative cash rate (design 56) — spread (or legacy absolute), null clears.
    if ('primeSpread'  in n) n.primeSpread  = (n.primeSpread  == null) ? null : Number(n.primeSpread);
    if ('interestRate' in n) n.interestRate = (n.interestRate == null) ? null : Number(n.interestRate);
    // Loan (liability) terms (design 54 §2 + design 86). Same null-vs-0 discipline as
    // create(): a cleared year/fraction is `null` (unset), not 0.
    for (const f of LOAN_NUM_FIELDS)      if (f in n) n[f] = _num(n[f]);
    for (const f of LOAN_NULLABLE_FIELDS) if (f in n) n[f] = _nullableNum(n[f]);
    for (const f of LOAN_KEY_FIELDS)      if (f in n) n[f] = n[f] || null;
    if ('interestOnly' in n) n.interestOnly = !!n.interestOnly;
    // Currency arrives from the editor as a code string; the account stores a
    // {code, symbol} descriptor. Map it, dropping an unknown/empty value.
    if ('currency' in n) {
      const cur = _currencyDescriptor(n.currency);
      if (cur) n.currency = cur; else delete n.currency;
    }
    // Coerce holdings array: ensure numeric fields are numbers, drop empty arrays
    if (Array.isArray(n.holdings)) {
      if (n.holdings.length === 0) {
        delete n.holdings; // preserve existing holdings when form clears (shouldn't happen)
      } else {
        n.holdings = n.holdings.map(h => ({
          ...h,
          marketValue: Number(h.marketValue) || 0,
          costBasis:   Number(h.costBasis)   || 0,
          taxLossPartner: h.taxLossPartner || null,
        }));
      }
    }
    return this._service.updateAccount(id, n);
  }

  /** @param {string} id */
  delete(id) {
    return this._service.deleteAccount(id);
  }

  /** @returns {import('../../finance/account.js').Account[]} */
  list() {
    return this._service.getAll();
  }

  /**
   * Return the transaction history for an account from the simulation journal.
   * @param {string} accountId
   * @param {import('../../simulation-framework/journal.js').Journal} journal
   */
  getHistory(accountId, journal) {
    return this._service.getAccountHistory(accountId, journal);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _builderFor(type) {
    switch (type) {
      case 'checking': return AccountBuilder.checking();
      case 'savings':  return AccountBuilder.savings();
      case 'brokerage':return AccountBuilder.brokerage();
      case '401k':     return AccountBuilder.fourOhOneK();
      case 'roth':     return AccountBuilder.roth();
      case 'ira':      return AccountBuilder.traditionalIRA();
      case 'super':    return AccountBuilder.super();
      case 'offset':   return AccountBuilder.offset();
      case 'loan':     return AccountBuilder.loan();
      default:         throw new Error(`AccountsController: unknown account type "${type}"`);
    }
  }
}
