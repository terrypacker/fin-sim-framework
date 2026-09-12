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

/**
 * The shared field row (design 101 R2): [toggle][label][sparkline][value], as the
 * State panel draws it and the Watchlist panel (W3) will. Pure DOM builders; the
 * caller supplies formatted text (see FieldFormatter) and behaviour.
 * Styles: assets/css/plugins/state-panel.css (`lsp-metric-*`).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * An inline trend line: green up, red down, grey flat, with a dot on the last point.
 * A long series is sampled down to `maxPoints` (first and last always kept), so a
 * full-resolution buffer of thousands of events stays cheap to redraw each frame.
 *
 * @param {number[]} values
 * @returns {SVGElement|null} null with fewer than two finite values
 */
export function renderSparkline(values, { width = 56, height = 14, maxPoints = 64 } = {}) {
  let vs = (values ?? []).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (vs.length < 2) return null;
  if (vs.length > maxPoints) {
    const n = vs.length;
    vs = Array.from({ length: maxPoints }, (_, i) => vs[Math.round(i * (n - 1) / (maxPoints - 1))]);
  }

  const P = 1;
  const min = Math.min(...vs);
  const range = (Math.max(...vs) - min) || 1;
  const pts = vs.map((v, i) => {
    const x = P + (i / (vs.length - 1)) * (width - P * 2);
    const y = P + (height - P * 2) - ((v - min) / range) * (height - P * 2);
    return [x.toFixed(1), y.toFixed(1)];
  });

  const trend = vs[vs.length - 1] - vs[0];
  const color = trend > 0 ? '#34d399' : trend < 0 ? '#f87171' : '#6b7280';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.cssText = 'flex-shrink:0;vertical-align:middle;';

  const poly = document.createElementNS(SVG_NS, 'polyline');
  poly.setAttribute('points', pts.map(p => p.join(',')).join(' '));
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', color);
  poly.setAttribute('stroke-width', '1.5');
  poly.setAttribute('stroke-linejoin', 'round');
  poly.setAttribute('stroke-linecap', 'round');
  svg.appendChild(poly);

  const [cx, cy] = pts[pts.length - 1];
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', cx);
  dot.setAttribute('cy', cy);
  dot.setAttribute('r', '2');
  dot.setAttribute('fill', color);
  svg.appendChild(dot);
  return svg;
}

function valueCell(valueText, valueTitle, untyped) {
  const val = document.createElement('span');
  val.className = 'lsp-metric-value';
  if (untyped) val.classList.add('is-untyped');
  val.textContent = valueText;
  if (valueTitle) val.title = valueTitle;
  return val;
}

/**
 * A numeric field row. Clicking the row (not the toggle) calls `onClick`.
 *
 * @param {object}       o
 * @param {string}       o.path        the raw state path, kept on the label's hover
 * @param {string}       o.label
 * @param {string}       o.valueText   the formatted value
 * @param {string|null}  [o.valueTitle] hover for the value (conversion / untyped note)
 * @param {boolean}      [o.untyped]   marks a value with no schema entry
 * @param {number[]|null}[o.history]   values for the sparkline
 * @param {Element|null} [o.toggle]    the checkbox for the first column
 * @param {Function|null}[o.onClick]
 */
export function buildFieldRow({ path, label, valueText, valueTitle = null, untyped = false,
                                history = null, toggle = null, onClick = null }) {
  const row = document.createElement('div');
  row.className = 'lsp-metric-row lsp-clickable-row';
  row.appendChild(toggle ?? document.createElement('span'));

  const lbl = document.createElement('span');
  lbl.className = 'lsp-metric-label';
  lbl.textContent = label;
  lbl.title = path;
  row.appendChild(lbl);

  const sparkCell = document.createElement('span');
  sparkCell.className = 'lsp-metric-spark';
  const spark = history ? renderSparkline(history) : null;
  if (spark) sparkCell.appendChild(spark);
  row.appendChild(sparkCell);

  row.appendChild(valueCell(valueText, valueTitle, untyped));
  if (onClick) row.addEventListener('click', onClick);
  return row;
}

/**
 * A static row (text, flag, date, year): no toggle, no sparkline. The raw path stays
 * on the label's hover, the only place the identity is recoverable once the label is a
 * display name (design 70 §6.1).
 */
export function buildStaticRow({ label, valueText, path = null, valueTitle = null }) {
  const row = document.createElement('div');
  row.className = 'lsp-metric-row lsp-static-row';
  row.appendChild(document.createElement('span')); // toggle column spacer
  const lbl = document.createElement('span');
  lbl.className = 'lsp-metric-label';
  lbl.textContent = label;
  if (path) lbl.title = path;
  const spark = document.createElement('span');
  spark.className = 'lsp-metric-spark';
  row.append(lbl, spark, valueCell(valueText, valueTitle, false));
  return row;
}
