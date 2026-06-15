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

/**
 * Display-currency money formatting for panels that need custom (compact /
 * whole-dollar) output rather than full Intl currency strings — MC and OPT
 * results/runs panels (design 10 §Phase 4). Values are USD-base aggregates by
 * default; conversion + symbol come from the active display currency via the
 * shared StateSchemaRegistry, falling back to native USD when unwired.
 */
function _conv(value, nativeCode) {
  const reg = ServiceRegistry.getInstance?.()?.schemaRegistry;
  return reg?.convertForDisplay
    ? reg.convertForDisplay(value, nativeCode)
    : { value, code: nativeCode, symbol: '$' };
}

/** Compact money, e.g. `$1.5M` / `$500k`, in the active display currency. */
export function fmtCompact(value, nativeCode = 'USD') {
  if (value == null || !Number.isFinite(value)) return '—';
  const { value: v, symbol } = _conv(value, nativeCode);
  const abs  = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return sign + symbol + (abs / 1_000_000).toFixed(1) + 'M';
  return sign + symbol + (abs / 1000).toFixed(0) + 'k';
}

/** Whole-dollar money, e.g. `$1,234,568`, in the active display currency. */
export function fmtWhole(value, nativeCode = 'USD') {
  if (value == null || !Number.isFinite(value)) return '—';
  const { value: v, symbol } = _conv(value, nativeCode);
  return (v < 0 ? '-' + symbol : symbol) + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
