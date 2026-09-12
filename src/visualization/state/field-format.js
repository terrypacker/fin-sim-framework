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

import { get }     from '../../finance/monte-carlo/mc-param-paths.js';
import { toLabel } from './state-paths.js';

const SEP = ' · ';

/** `holdings[id=h1]` → { id: 'h1' }; a plain segment → null. */
function parseElementSegment(seg) {
  const m = /^[^[]+\[[^=\]]+=([^\]]+)\]$/.exec(seg);
  return m ? { id: m[1] } : null;
}

/** "$1.23M" / "A$450k" / "$320": the dense form for watchlist rows and chips. */
function compactMoney(v, symbol) {
  const abs  = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 999_500) return `${sign}${symbol}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1_000)   return `${sign}${symbol}${Math.round(abs / 1e3)}k`;
  return `${sign}${symbol}${Math.round(abs)}`;
}

/**
 * FieldFormatter — design 101 R2. The single entry point for turning a state path
 * and value into what the UI shows: the State panel rows and history modal, the
 * chart's series kinds, legend names, chips and tooltip, and (W3) the Watchlist panel.
 *
 * It sits on ONE StateSchemaRegistry: the stamped one ScenarioLoader fills with each
 * account's currency (R-9). Currency conversion to the display currency is the
 * registry's (design 10 §Phase 4); this adds the labels, the compact form, the
 * conversion hover and the untyped marker on top.
 */
export class FieldFormatter {
  /**
   * @param {object}   opts
   * @param {import('../../finance/services/state-schema-registry.js').StateSchemaRegistry} opts.registry
   * @param {() => object|null} [opts.stateProvider]  the state to read holding labels from
   */
  constructor({ registry, stateProvider = null } = {}) {
    this._registry      = registry ?? null;
    this._stateProvider = stateProvider;
  }

  get registry() { return this._registry; }

  /**
   * Everything the UI needs to present a path.
   * @returns {{ kind: string, currencyCode: string|null, label: string,
   *             contextLabel: string, chartable: boolean, typed: boolean }}
   */
  describe(path, { state } = {}) {
    const vt   = this._registry?.resolve(path);
    const kind = vt?.kind ?? 'unknown';
    return {
      kind,
      currencyCode: vt?.currencyCode ?? null,
      label:        this.label(path),
      contextLabel: this.contextLabel(path, { state }),
      chartable:    this._registry?.isChartable?.(path) ?? true,
      typed:        kind !== 'unknown',
    };
  }

  /** Whether the path has a schema entry (anything but `unknown`). */
  isTyped(path) {
    return (this._registry?.resolve(path)?.kind ?? 'unknown') !== 'unknown';
  }

  /** The short label: a record's display name, else the last segment. */
  label(path) {
    const name = this._registry?.displayNameFor?.(path);
    if (name) return name;
    return toLabel(String(path).split('.').pop().replace(/\[.*?\]/g, ''));
  }

  /**
   * A label that means something out of context (R-7): the owning record's name, the
   * holding's label or security symbol, then the field. For chart legends, chips and
   * watchlist rows, where "Market Value" alone could be any lot.
   *
   *   usStockAccount.holdings[id=h1].marketValue → "US Brokerage · SWTSX · Market Value"
   *   metrics.netWorth                           → "Net Worth"
   *   effectiveGrowthRates.EQUITY_US             → "Effective Growth Rates · EQUITY US"
   *
   * @param {string} path
   * @param {{ state?: object }} [opts]  state to read holding labels from (default: the provider's)
   */
  contextLabel(path, { state } = {}) {
    const reg  = this._registry;
    const segs = String(path).split('.');

    // `metrics.<stateKey>` is an account's balance copy (design 70 §6.1); any other
    // metric is just its own name.
    if (segs[0] === 'metrics' && segs.length === 2) {
      return reg?.displayNameFor?.(segs[1]) ?? toLabel(segs[1]);
    }

    // The longest prefix that names a record: `people.p1` is tried before `people`.
    let owner = null, ownerLen = 0;
    for (let n = Math.min(segs.length, 3); n >= 1; n--) {
      const name = reg?.displayNameFor?.(segs.slice(0, n).join('.'));
      if (name) { owner = name; ownerLen = n; break; }
    }

    const parts = owner ? [owner] : [];
    let st;
    for (let i = ownerLen; i < segs.length; i++) {
      const element = parseElementSegment(segs[i]);
      if (element) {
        st ??= state ?? this._stateProvider?.() ?? null;
        parts.push(this._elementLabel(st, segs.slice(0, i + 1).join('.'), element.id));
      } else {
        parts.push(toLabel(segs[i]));
      }
    }
    return parts.join(SEP);
  }

  /**
   * The display string for a scalar, or null when the caller should render it itself
   * (an object or array, or an untyped non-number).
   *
   * @param {string} path
   * @param {*}      value
   * @param {{ state?: object, compact?: boolean }} [opts]
   *   `compact` renders money as "$1.23M". It converts with the injected rate state
   *   rather than `state`, which only matters once rates vary over time.
   */
  format(path, value, { state, compact = false } = {}) {
    const reg = this._registry;
    if (!reg) return null;
    // A glob can match a whole subtree (`auSuperCapsByPerson.**`); an object under it
    // is not a scalar of that kind and must not print as "[object Object]".
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) return null;
    if (compact && typeof value === 'number' && Number.isFinite(value)) {
      const vt = reg.resolve(path);
      if (vt.kind === 'currency') {
        const { value: v, symbol } = vt.currencyCode
          ? reg.convertForDisplay(value, vt.currencyCode)
          : { value, symbol: '' };
        return compactMoney(v, symbol);
      }
    }
    return reg.format(path, value, { state });
  }

  /**
   * Hover text for a value cell, or null when there is nothing to add:
   *   - an untyped number says so, because its "1,234.56" is only a guess;
   *   - a converted amount shows the native amount and the rate used, e.g.
   *     "A$1,234.00 native @ 0.6500 AUD→USD", since the conversion is otherwise invisible.
   */
  valueTitle(path, value) {
    const reg = this._registry;
    if (!reg || typeof value !== 'number' || !Number.isFinite(value)) return null;
    const vt = reg.resolve(path);
    if (vt.kind === 'unknown') return 'No schema entry: shown as a plain number, which may not be what it is';
    if (vt.kind !== 'currency' || !vt.currencyCode) return null;
    const unit = reg.convertForDisplay(1, vt.currencyCode);
    if (unit.code === vt.currencyCode) return null;
    const native = new Intl.NumberFormat('en-US', { style: 'currency', currency: vt.currencyCode }).format(value);
    return `${native} native @ ${unit.value.toFixed(4)} ${vt.currencyCode}→${unit.code}`;
  }

  /** A holding (or other id-addressed element): its label, security symbol/name, else its id. */
  _elementLabel(state, elementPath, id) {
    const el = state ? get(state, elementPath) : null;
    if (!el || typeof el !== 'object') return id;
    const sec = el.securityId ? state?.securities?.[el.securityId] : null;
    return el.label || sec?.symbol || sec?.name || el.name || el.rateKey || id;
  }
}
