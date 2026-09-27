/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ServiceRegistry } from '../services/service-registry.js';
import { realFromUsd }     from '../finance/fx/real-basis.js';

/**
 * Display-currency money formatting for panels that need custom (compact /
 * whole-dollar) output rather than full Intl currency strings — MC and OPT
 * results/runs panels (design 10 §Phase 4). Values are USD-base aggregates by
 * default; conversion + symbol come from the active display currency via the
 * shared StateSchemaRegistry, falling back to native USD when unwired.
 *
 * `opts` ({ at, priceLevel, state }) is forwarded to `presentForDisplay`: a real value
 * basis (design 79) deflates only a value whose caller names the instant it belongs to.
 * An MC or OPT aggregate has no such instant, so these panels pass none and stay nominal.
 */
function _conv(value, nativeCode, opts) {
  const reg = ServiceRegistry.getInstance?.()?.schemaRegistry;
  return reg?.convertForDisplay
    ? reg.convertForDisplay(value, nativeCode, opts)
    : { value, code: nativeCode, symbol: '$' };
}

/** Compact money, e.g. `$1.5M` / `$500k`, in the active display currency. */
export function fmtCompact(value, nativeCode = 'USD', opts = {}) {
  if (value == null || !Number.isFinite(value)) return '—';
  const { value: v, symbol } = _conv(value, nativeCode, opts);
  const abs  = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + symbol + (abs / 1_000_000).toFixed(1) + 'M';
  return sign + symbol + (abs / 1000).toFixed(0) + 'k';
}

/** Whole-dollar money, e.g. `$1,234,568`, in the active display currency. */
export function fmtWhole(value, nativeCode = 'USD', opts = {}) {
  if (value == null || !Number.isFinite(value)) return '—';
  const { value: v, symbol } = _conv(value, nativeCode, opts);
  return (v < 0 ? '-' + symbol : symbol) + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/**
 * A terminal USD figure from an optimizer or MC result, in the app's value basis
 * (design 79 §9). Real restates it by the rates recorded WITH it — that result's own
 * terminal inflation and FX — never by the live sim's, which describe a different world.
 * A result without recorded rates (from before design 79) stays nominal, and says so
 * through `basis`.
 *
 * @param {number} amountUsd
 * @param {{ priceLevels?: object, usdAud?: number|null }} [rates]  `result.terminalRates`
 * @returns {{ value: number, code: string, basis: 'real'|'nominal' }}
 */
export function presentTerminalUsd(amountUsd, rates) {
  const reg = ServiceRegistry.getInstance?.()?.schemaRegistry;
  if (reg?.valueBasis?.() === 'real') {
    const code  = reg.displayCurrencyCode?.() ?? 'USD';
    const value = realFromUsd(amountUsd, rates, code);
    if (value != null) return { value, code, basis: 'real' };
  }
  return { value: amountUsd, code: 'USD', basis: 'nominal' };
}

/** Whole-dollar terminal figure in the app's basis — see {@link presentTerminalUsd}. */
export function fmtTerminalWhole(amountUsd, rates) {
  const { value, code } = presentTerminalUsd(amountUsd, rates);
  return fmtWhole(value, code);
}

/** Compact terminal figure in the app's basis — see {@link presentTerminalUsd}. */
export function fmtTerminalCompact(amountUsd, rates) {
  const { value, code } = presentTerminalUsd(amountUsd, rates);
  return fmtCompact(value, code);
}
