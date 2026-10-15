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
 * A Roth ranked ahead of taxed money in the `drawdownPriority` order.
 *
 * The walk spends the lowest priority first, and nothing checks what that costs. A Roth drawn
 * before a taxable brokerage or a traditional IRA gives up tax-free growth on the money spent,
 * while the taxed accounts keep compounding toward a larger taxed withdrawal later. A study
 * found a real plan carrying exactly this order (Roths one place ahead of taxable), paying
 * materially more lifetime tax and emptying its Roths decades early, with nothing in the app
 * saying so.
 *
 * Only a TAX-FREE account ahead of a taxed one is reported. Taxable-before-deferred is the usual
 * advice, but drawing a traditional IRA early to fill a low bracket is a legitimate choice, so a
 * deferred-before-taxable order is not flagged. Super is left out: its access and tax rules are
 * a different system (preservation age, pension phase) and its place in the walk is not a US
 * tax-order question.
 *
 * Advisory only. When a liquidity-pool sequence governs the draw (design 97), the walk follows
 * it instead and this order is not what runs.
 */
import { ACCOUNT_TYPE } from '../assets/account.js';

/** The tax character of what a draw from an account costs. */
export const DRAW_TAX_CLASS = Object.freeze({
  TAX_FREE:     'TAX_FREE',
  TAX_DEFERRED: 'TAX_DEFERRED',
  TAXABLE:      'TAXABLE',
});

/** @returns {string|null} a DRAW_TAX_CLASS, or null for an account this advisory does not rank */
export function drawTaxClassOf(account) {
  switch (account?.type) {
    case ACCOUNT_TYPE.ROTH:            return DRAW_TAX_CLASS.TAX_FREE;
    case ACCOUNT_TYPE.TRADITIONAL_IRA:
    case ACCOUNT_TYPE.FOUR_OH_ONE_K:   return DRAW_TAX_CLASS.TAX_DEFERRED;
    case ACCOUNT_TYPE.BROKERAGE:       return DRAW_TAX_CLASS.TAXABLE;
    default:                           return null;
  }
}

const priorityOf = (a) => {
  const p = a?.drawdownPriority;
  return (p === '' || p == null || !Number.isFinite(Number(p))) ? null : Number(p);
};
const nameOf = (a) => a?.name || a?.stateKey || a?.id || '?';

/**
 * Every tax-free account ranked strictly ahead of a taxed one.
 *
 * @param {Array<object>} accounts - account records or graph nodes ({ type, drawdownPriority, name, stateKey })
 * @returns {Array<{ account: object, priority: number, before: Array<{ account: object, priority: number, cls: string }> }>}
 */
export function rothAheadOfTaxed(accounts) {
  const ranked = (accounts ?? [])
    .map(account => ({ account, priority: priorityOf(account), cls: drawTaxClassOf(account) }))
    .filter(r => r.priority != null && r.cls != null);
  const out = [];
  for (const r of ranked) {
    if (r.cls !== DRAW_TAX_CLASS.TAX_FREE) continue;
    const before = ranked.filter(o => o.cls !== DRAW_TAX_CLASS.TAX_FREE && o.priority > r.priority)
      .sort((a, b) => a.priority - b.priority)
      .map(({ account, priority, cls }) => ({ account, priority, cls }));
    if (before.length) out.push({ account: r.account, priority: r.priority, before });
  }
  return out;
}

/**
 * The advisory sentence for ONE account, or null: a Roth ranked ahead of taxed accounts, or a
 * taxed account that a Roth is ranked ahead of.
 *
 * @param {object} account
 * @param {Array<object>} accounts - every account, `account` included (its priority as edited)
 * @returns {string|null}
 */
export function drawdownOrderAdvisory(account, accounts) {
  const hits = rothAheadOfTaxed(accounts);
  const same = (a) => a === account || (a?.stateKey != null && a.stateKey === account?.stateKey)
    || (a?.id != null && a.id === account?.id);
  const label = (x) => `${nameOf(x.account)} (${x.priority})`;
  const mine = hits.find(h => same(h.account));
  if (mine) {
    return `Spent before ${mine.before.map(label).join(', ')}. Drawing a Roth ahead of taxed `
      + 'accounts gives up its tax-free growth while they keep compounding toward a larger taxed '
      + 'withdrawal; the usual order is taxable, then tax-deferred, then Roth. Applies when no '
      + 'liquidity-pool sequence sets the draw order.';
  }
  const ahead = hits.filter(h => h.before.some(b => same(b.account)));
  if (ahead.length) {
    return `${ahead.map(label).join(', ')} ${ahead.length === 1 ? 'is' : 'are'} spent before this `
      + 'account. A Roth drawn ahead of taxed money gives up tax-free growth; the usual order is '
      + 'taxable, then tax-deferred, then Roth.';
  }
  return null;
}
