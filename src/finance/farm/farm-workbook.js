/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { harvestDateFor, defaultCalendar, validateFarm } from './farm-records.js';
import { priceHistory, latestPriceMonth } from './farm-price-history.js';

/**
 * The yearly workbook importer (design 134 §17.2, rev 25): the owners' job-cost workbook,
 * exported as four CSVs, becomes `cfg.farm`. Pure: text in, `{ farm, advisories, sheet }` out,
 * no `node:fs`, so the browser can import the same files (phase 6).
 *
 * The layout is the owners' own (the 2026 workbook), which they keep from year to year:
 *
 * - **Fields**: one row per field: name, job code, crop (`C`, `C2`, `B`), acres, irrigated or
 *   dry, owned or rented, operator code, seed units and yield. A row with a name and no
 *   operator is a section heading.
 * - **Admin**: label-keyed blocks. Input rates (`CORN FERT`, \$/corn acre), the forward
 *   contracts (`Corn - Dec Delivery`, bushels, price), the loans paid this year (principal,
 *   interest), the custom farming rates and the "actual rates" notes, from which the fuel,
 *   machine labor and trucking are computed (step 5b, §17.8).
 * - **Direct Expenses**: `(job code, code, amount)`: property taxes, cash rent, crop insurance.
 * - **Income**: `(job code, code, amount)`: a field's program payment, and an operator's
 *   payments on its `<operator> OVERHEAD` job.
 *
 * The workbook gives rules, not a ledger: rates per acre or per unit, and each field's facts.
 * So the import writes the rules as records and the model computes the amounts. Columns are
 * found by header and labels by pattern, after trimming and case folding, never by position.
 * A blank is "not given" and becomes an advisory, never \$0. Cells that show a spreadsheet
 * error (`#REF!`) are skipped and counted.
 *
 * What the sheet does not say is decided by an option, and every such default is an advisory:
 * whose the forward contracts and the loans are (Q22a was declined), the price of the grain
 * that is not contracted, and when it is sold.
 */

export const WORKBOOK_SHEETS = Object.freeze(['fields', 'admin', 'directExpenses', 'income']);

/** Split a split-by-operator default: by each operator's share. */
export const PRO_RATA = 'PRO_RATA';

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const isErrorCell = (s) => /^#(ref!|n\/a|value!|div\/0!|name\?|num!|null!)$/i.test(String(s ?? '').trim());

/** Parse CSV text (RFC 4180 quotes, CRLF or LF, a leading BOM). */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * A money or number cell: tolerates `$`, thousands separators, spaces and accounting
 * negatives `(12.00)`. Blank is null; a lone dash (the accounting zero) is 0; anything else
 * that is not a number is NaN.
 */
export function cellNumber(s) {
  if (s == null) return null;
  let t = String(s).trim();
  if (t === '') return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[$,\s]/g, '');
  if (t === '') return null;
  if (t === '-') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

const CROP_CODES = {
  c: { crop: 'CORN' }, corn: { crop: 'CORN' },
  c2: { crop: 'CORN', rotation: 'CORN_ON_CORN' }, 'corn on corn': { crop: 'CORN', rotation: 'CORN_ON_CORN' },
  b: { crop: 'SOYBEANS' }, beans: { crop: 'SOYBEANS' }, soybeans: { crop: 'SOYBEANS' },
};

/** The crop a label names (`CORN FERT`, `Bean Chem`, `Per Corn Acre`), or null for both. */
function cropIn(text) {
  const t = norm(text);
  const corn = /\bcorn\b/.test(t);
  const beans = /\b(bean|beans|soybean|soybeans|soy)\b/.test(t);
  if (corn && !beans) return 'CORN';
  if (beans && !corn) return 'SOYBEANS';
  return null;
}

/** An input-rate label's product category. Q23a: a fertilizer bundle is not all nitrogen. */
function productCategory(label) {
  const t = norm(label);
  if (/\bseed\b/.test(t)) return 'SEED';
  if (/custom app/.test(t)) return 'CUSTOM_APPLICATION';
  if (/\b(lime|lyme)\b/.test(t)) return 'LIME';
  if (/nitrogen|anhydrous|\buan\b|\burea\b/.test(t)) return 'NITROGEN';
  if (/p ?& ?k|phosph|potash/.test(t)) return 'PHOSPHATE_POTASH';
  if (/fert/.test(t)) return 'OTHER_FERTILIZER';
  if (/herbicide/.test(t)) return 'HERBICIDE';
  if (/fungicide/.test(t)) return 'FUNGICIDE';
  if (/insecticide/.test(t)) return 'INSECTICIDE';
  if (/chem/.test(t)) return 'OTHER_CHEMICAL';
  return null;
}

/** The operator whose overhead job this is ("D OVERHEAD" or "D-OVERHEAD"), or null. */
function overheadOperator(job, operators) {
  const m = /^([a-z0-9]+)(?:\s+|\s*-\s*)overhead$/.exec(job);
  const id = m?.[1].toUpperCase();
  return id && operators.some(o => o.id === id) ? id : null;
}

/** The machine operation a custom-rate or labor label names, or null. */
function operationOf(label) {
  const t = norm(label);
  if (/grain cart|\bcart\b|hauling/.test(t)) return 'cart';
  if (/plant/.test(t)) return 'plant';
  if (/harvest|combin/.test(t)) return 'harvest';
  if (/spray/.test(t)) return 'spray';
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Find the header row (the first holding every `required` header) and map columns by name. */
function headerMap(rows, required, sheet, advise) {
  const at = rows.findIndex(r => required.every(h => r.some(c => norm(c) === h)));
  if (at < 0) throw new Error(`${sheet}: no header row with ${required.map(h => `"${h}"`).join(', ')}`);
  const cols = new Map();
  rows[at].forEach((c, i) => { const k = norm(c); if (k && !cols.has(k)) cols.set(k, i); });
  return { at, cols, col: (...names) => names.map(n => cols.get(n)).find(i => i != null) ?? null, advise };
}

/**
 * Import one crop year's workbook.
 *
 * @param {{ fields: string, admin: string, directExpenses: string, income: string }} csv
 *   each sheet's CSV text
 * @param {object} opts
 * @param {number} opts.cropYear the season's crop year (the workbook does not state it)
 * @param {string} [opts.contractOperator=PRO_RATA] the operator whose the forward contracts
 *   are, or `PRO_RATA` to split each by the operators' expected bushels of its crop
 * @param {string} [opts.loanOperator=PRO_RATA] the operator who pays the loans, or `PRO_RATA`
 *   to split land debt by owned acres and other loans by planted acres
 * @param {Record<string, number>} [opts.prices] \$/bu per crop for the grain not under
 *   contract; a crop left out takes NASS's latest Nebraska price received
 * @param {string} [opts.saleDate] when the unpriced grain is sold; default each crop's harvest
 * @returns {{ farm: object, advisories: object[], sheet: object }} `sheet` holds the sheet's
 *   own totals by kind, for reconciliation, and the costing inputs the import read
 */
export function importFarmWorkbook(csv, opts = {}) {
  const y = Number(opts.cropYear);
  if (!Number.isInteger(y)) throw new Error('importFarmWorkbook: cropYear (a whole year) is required');
  for (const s of WORKBOOK_SHEETS) {
    if (typeof csv?.[s] !== 'string') throw new Error(`importFarmWorkbook: the ${s} sheet's CSV text is required`);
  }
  const contractOperator = opts.contractOperator ?? PRO_RATA;
  const loanOperator = opts.loanOperator ?? PRO_RATA;
  const cal = defaultCalendar(y);
  const advisories = [];
  const advise = (kind, message, extra = {}) => advisories.push({ kind, message, ...extra });
  let errorCells = 0;
  const sheet = {
    rent: 0, propertyTax: 0, cropInsurance: 0, programIncome: 0, interest: 0, principal: 0,
    fuel: 0, irrigation: 0, machinery: 0,
  };

  // ─── Fields ────────────────────────────────────────────────────────────────────
  const fRows = parseCsv(csv.fields);
  const fh = headerMap(fRows, ['jobcode', 'crop', 'acres'], 'Fields');
  const c = {
    // The owners' sheet leaves the name column's header blank.
    name: fh.col('field', 'name') ?? fRows[fh.at].findIndex(h => norm(h) === ''),
    job: fh.col('jobcode', 'job code'), crop: fh.col('crop'),
    acres: fh.col('acres'), practice: fh.col('irr/dry', 'practice'), tenure: fh.col('own/rent', 'tenure'),
    operator: fh.col('operator code', 'operator'), seed: fh.col('seed units'), yield: fh.col('yield'),
  };
  for (const [k, i] of Object.entries(c)) if (i == null) throw new Error(`Fields: no "${k}" column`);
  const known = new Set(Object.values(c));
  const derived = new Set(['corn', 'beans', 'soybeans']); // the sheet's per-crop acre split
  for (const [h, i] of fh.cols) {
    if (!known.has(i) && !derived.has(h)) advise('UNKNOWN_COLUMN', `Fields: column "${h}" is not read`);
  }

  const operators = [];
  const fields = [];
  const cropPlans = [];
  const fieldByJob = new Map();
  const seedUnits = new Map();          // field id → units (null when blank)
  for (const r of fRows.slice(fh.at + 1)) {
    const name = String(r[c.name] ?? '').trim();
    const op = String(r[c.operator] ?? '').trim().toUpperCase();
    if (!op) {
      // A heading ("… Acres") or a blank row. A row with data and no operator is an error.
      if (r.some((v, i) => i !== c.name && String(v ?? '').trim() !== '')) {
        throw new Error(`Fields: "${name}" has no operator code`);
      }
      continue;
    }
    const job = norm(r[c.job]);
    if (!job) throw new Error(`Fields: "${name}" has no job code`);
    if (fieldByJob.has(job)) throw new Error(`Fields: job code "${job}" appears twice`);
    const code = CROP_CODES[norm(r[c.crop])];
    if (!code) throw new Error(`Fields: "${name}" has an unknown crop code "${String(r[c.crop]).trim()}"`);
    const acres = cellNumber(r[c.acres]);
    if (!(acres > 0)) throw new Error(`Fields: "${name}" has no acres`);
    const practice = norm(r[c.practice]);
    if (practice !== 'irr' && practice !== 'dry') throw new Error(`Fields: "${name}" IRR/DRY is "${r[c.practice]}"`);
    const tenure = norm(r[c.tenure]);
    if (tenure !== 'own' && tenure !== 'rent') throw new Error(`Fields: "${name}" OWN/RENT is "${r[c.tenure]}"`);
    if (!operators.some(o => o.id === op)) operators.push({ id: op, name: op });

    let id = slug(name) || slug(job);
    if (fields.some(f => f.id === id)) id = `${id}-${op.toLowerCase()}`;
    const field = {
      id, operatorId: op, name, tenure: tenure === 'own' ? 'OWN' : 'CASH_RENT',
      plantedAcres: acres, irrigated: practice === 'irr', propertyTax: 0, rentPerAcre: 0,
    };
    if (field.tenure === 'CASH_RENT') field.rentedAcres = acres;
    fields.push(field);
    fieldByJob.set(job, field);
    const yld = cellNumber(r[c.yield]);
    if (yld == null || Number.isNaN(yld)) throw new Error(`Fields: "${name}" has no yield`);
    cropPlans.push({
      id: `plan-${id}`, fieldId: id, crop: code.crop, expectedYield: yld, insurancePremiumPerAcre: 0,
      ...(code.rotation ? { rotation: code.rotation, label: 'corn on corn' } : {}),
    });
    const units = cellNumber(r[c.seed]);
    seedUnits.set(id, Number.isNaN(units) ? null : units);
  }
  if (!fields.length) throw new Error('Fields: no fields');
  advise('FIELD_ID_FROM_NAME', 'The Fields sheet has no stable field id, so each id is made from the field\'s '
    + 'name. A renamed field starts a new history (design 134 §17.2).');
  const planOf = (f) => cropPlans.find(p => p.fieldId === f.id);
  const cropsGrown = [...new Set(cropPlans.map(p => p.crop))];
  const expectedBu = (op, crop) => cropPlans
    .filter(p => p.crop === crop && fields.find(f => f.id === p.fieldId).operatorId === op)
    .reduce((s, p) => s + p.expectedYield * fields.find(f => f.id === p.fieldId).plantedAcres, 0);
  const acresOf = (op, pred = () => true) => fields.filter(f => f.operatorId === op && pred(f))
    .reduce((s, f) => s + f.plantedAcres, 0);

  // ─── Admin ─────────────────────────────────────────────────────────────────────
  const products = [];
  const prescriptions = [];
  const operations = [];
  const storage = [];
  const contracts = [];
  const overhead = [];
  const costing = {
    fuelPerAcrePerApplication: null, fuelActual: false, acresPerHour: {}, applications: {}, laborPerHour: null,
    trucking: [], labor: [], ownership: [],
  };
  const customRates = [];               // { op, crop | null, rate, label }
  const setWage = (w) => {
    if (costing.laborPerHour != null && costing.laborPerHour !== w) {
      throw new Error(`Admin: two labor wages, $${costing.laborPerHour} and $${w} an hour`);
    }
    costing.laborPerHour = w;
  };
  const addRx = (plan, extra) => prescriptions.push({ id: `rx-${prescriptions.length + 1}`, planId: plan.id, ...extra });

  let section = 'rates';
  let contractN = 0;
  for (const r of parseCsv(csv.admin)) {
    const cells = r.map(v => String(v ?? '').trim());
    if (cells.every(v => v === '')) continue;
    if (cells.some(isErrorCell)) { errorCells++; continue; }
    const lower = cells.map(norm);
    const label = cells[0];
    const l = norm(label);
    if (lower.includes('bushels') && lower.includes('price')) { section = 'contracts'; continue; }
    if (lower.includes('principal') && lower.includes('interest')) { section = 'loans'; continue; }
    if (/^custom farming rates/.test(l)) { section = 'custom'; continue; }
    if (/^actual rates/.test(l)) { section = 'actual'; continue; }
    if (/^actual (depreciation|ownership|financing)/.test(l)) { section = 'ownership'; continue; }
    // A labor block's heading: "Combining corn actual labor rates | 25 | acres an hour".
    const laborOp = /\brates?\b/.test(l) && /acres? (an|per) hour/.test(norm(cells[2])) ? operationOf(l) : null;
    if (laborOp) {
      const aph = cellNumber(cells[1]);
      if (!(aph > 0)) throw new Error(`Admin: labor block "${label}" has no acres per hour`);
      costing.labor.push({ op: laborOp, crop: cropIn(label), acresPerHour: aph, label });
      section = 'labor';
      continue;
    }

    // Trucking is read wherever it sits: the owners have moved it between blocks.
    if (/^trucking/.test(l) && section !== 'rates') {
      const rate = cellNumber(cells[1]);
      const crop = cropIn(label);
      const leg = /storage/.test(l) ? 'STORAGE_TO_SALE' : /field/.test(l) ? 'FIELD' : null;
      if (crop && leg && rate > 0 && /bushel/.test(norm(cells[2]))) costing.trucking.push({ crop, leg, perBu: rate });
      else advise('ADMIN_ROW_IGNORED', `Admin: trucking row "${cells.filter(Boolean).join(' | ')}" is not per bushel by crop and leg`);
      continue;
    }

    if (section === 'rates') {
      const price = cellNumber(cells[1]);
      const basis = norm(cells[2]);
      const category = productCategory(label);
      if (!label || price == null || Number.isNaN(price) || !category) {
        advise('ADMIN_ROW_IGNORED', `Admin: "${cells.filter(Boolean).join(' | ')}" is not a recognised input rate`);
        continue;
      }
      const crop = cropIn(label) ?? cropIn(basis);
      const crops = crop ? [crop] : cropsGrown;
      const perUnit = /per unit/.test(basis);
      if (!perUnit && !/acre/.test(basis)) {
        advise('ADMIN_ROW_IGNORED', `Admin: "${label}" has basis "${cells[2]}", neither per unit nor per acre`);
        continue;
      }
      for (const cr of crops) {
        const id = slug(`${cr}-${category}`);
        if (products.some(p => p.id === id)) throw new Error(`Admin: two ${category} rates for ${cr}`);
        products.push({ id, name: label, category, unit: perUnit ? 'unit' : 'acre', unitPrice: price });
        for (const plan of cropPlans.filter(p => p.crop === cr)) {
          if (!perUnit) { addRx(plan, { productId: id, ratePerAcre: 1 }); continue; }
          const units = seedUnits.get(plan.fieldId);
          if (units == null) continue;            // farmAdvisories reports NO_SEED
          const f = fields.find(x => x.id === plan.fieldId);
          addRx(plan, { productId: id, ratePerAcre: units / f.plantedAcres });
        }
      }
      if (category === 'OTHER_FERTILIZER') {
        advise('FERTILIZER_NOT_NITROGEN', `"${label}" is a fertilizer bundle, not all nitrogen (owners, Q23a), so it `
          + 'imports as other fertilizer and moves with otherFertilizerMultiplier. A nitrogen-only price lever needs '
          + 'its own rate row.');
      }
    } else if (section === 'contracts') {
      const m = /^(.*?)\s*-\s*(.*)$/.exec(label);
      const crop = cropIn(m?.[1] ?? label);
      const bushels = cellNumber(cells[1]);
      const price = cellNumber(cells[2]);
      if (!crop || !(bushels > 0) || !(price > 0)) {
        advise('ADMIN_ROW_IGNORED', `Admin: contract row "${cells.filter(Boolean).join(' | ')}" is not readable`);
        continue;
      }
      const when = norm(m?.[2] ?? '');
      let deliveryDate;
      const mon = MONTHS.findIndex(x => new RegExp(`\\b${x}`).test(when));
      if (/out of (the )?field|harvest/.test(when)) deliveryDate = harvestDateFor(cal, crop);
      else if (mon >= 0) {
        const harvestMonth = Number(harvestDateFor(cal, crop).slice(5, 7));
        const year = mon + 1 >= harvestMonth ? y : y + 1;
        deliveryDate = `${year}-${String(mon + 1).padStart(2, '0')}-15`;
      } else {
        advise('ADMIN_ROW_IGNORED', `Admin: contract "${label}" names no delivery month`);
        continue;
      }
      contractN++;
      const owners = contractOperator === PRO_RATA
        ? operators.map(o => [o.id, expectedBu(o.id, crop)]).filter(([, b]) => b > 0)
        : [[contractOperator, 1]];
      const total = owners.reduce((s, [, b]) => s + b, 0);
      for (const [op, b] of owners) {
        contracts.push({
          id: `contract-${contractN}${owners.length > 1 ? `-${op.toLowerCase()}` : ''}`, operatorId: op, crop,
          name: label, bushels: bushels * b / total, price, deliveryDate,
        });
      }
    } else if (section === 'loans') {
      const principal = cellNumber(cells[1]) ?? 0;
      const interest = cellNumber(cells[2]);
      if (!label || interest == null || Number.isNaN(interest) || Number.isNaN(principal)) {
        advise('ADMIN_ROW_IGNORED', `Admin: loan row "${cells.filter(Boolean).join(' | ')}" is not readable`);
        continue;
      }
      sheet.interest += interest;
      sheet.principal += principal;
      const landDebt = !/operating|bin|equipment|machine/.test(l);
      const category = landDebt ? 'INTEREST_MORTGAGE' : 'INTEREST_OTHER';
      const basis = landDebt ? 'OWNED_ACRES' : 'ACRES';
      const owners = loanOperator === PRO_RATA
        ? operators.map(o => [o.id, landDebt ? acresOf(o.id, f => f.tenure === 'OWN') : acresOf(o.id)]).filter(([, a]) => a > 0)
        : [[loanOperator, 1]];
      const total = owners.reduce((s, [, a]) => s + a, 0);
      for (const [op, a] of owners) {
        overhead.push({
          id: `loan-${slug(label)}${owners.length > 1 ? `-${op.toLowerCase()}` : ''}`, operatorId: op,
          name: `${label} interest`, category, amount: interest * a / total, basis,
        });
      }
    } else if (section === 'custom') {
      const rate = cellNumber(cells[1]);
      const basis = norm(cells[2]);
      if (/^fuel/.test(l) && /actual/.test(norm(cells.slice(1).join(' ')))) {
        // "Fuel: use actual fuel cost": the fuel is the operator's own figure on Direct Expenses.
        costing.fuelActual = true;
        continue;
      }
      if (rate == null || Number.isNaN(rate)) {
        advise('ADMIN_ROW_IGNORED', `Admin: custom rate "${label}" has no rate`);
        continue;
      }
      if (/bin rental|storing|storage/.test(l)) {
        if (!/bushel/.test(basis) || !/month/.test(basis)) {
          advise('ADMIN_ROW_IGNORED', `Admin: storage rate "${label}" is "${cells[2]}", not per bushel per month`);
          continue;
        }
        for (const o of operators) for (const cr of cropsGrown) {
          storage.push({ id: `storage-${o.id.toLowerCase()}-${slug(cr)}`, operatorId: o.id, crop: cr, costPerBuMonth: rate });
        }
      } else if (/^fuel/.test(l)) {
        costing.fuelPerAcrePerApplication = rate;
      } else {
        const op = operationOf(l);
        if (!op || !/acre/.test(basis)) {
          advise('ADMIN_ROW_IGNORED', `Admin: custom rate "${label}" (${cells[2]}) is not a per-acre operation`);
          continue;
        }
        const crop = cropIn(label);
        if (customRates.some(x => x.op === op && x.crop === crop)) throw new Error(`Admin: two custom rates for "${label}"`);
        customRates.push({ op, crop, rate, label });
      }
    } else if (section === 'ownership') {
      // "Actual Depreciation/Financing/Insurance Rates": owning the machines, per acre.
      const rate = cellNumber(cells[1]);
      if (!label || rate == null || Number.isNaN(rate) || !/acre/.test(norm(cells[2]))) {
        advise('ADMIN_ROW_IGNORED', `Admin: "${cells.filter(Boolean).join(' | ')}" is not a per-acre ownership rate`);
        continue;
      }
      costing.ownership.push({ label, perAcre: rate, crop: cropIn(label) });
    } else if (section === 'labor') {
      // A labor block: its heading row (read above) gives the throughput, then "Times 7 people",
      // "Times 1 person x 4 applications" and "Times $27 an hour". "Total Hours" and the products
      // are the sheet's own arithmetic, which the model redoes; the total wage is kept to compare.
      const block = costing.labor[costing.labor.length - 1];
      const t = norm(cells.filter(Boolean).join(' '));
      const crew = /^times (\d+(?:\.\d+)?) (?:people|persons?|men|operators?)\b/.exec(t);
      const apps = /(\d+) applications?/.exec(t);
      const wage = /^times \$(\d+(?:\.\d+)?) (?:an|per|\/) ?h/.exec(t);
      if (crew) {
        block.crew = Number(crew[1]);
        if (apps) block.applications = Number(apps[1]);
      } else if (wage) {
        setWage(Number(wage[1]));
        const total = cellNumber(cells[1]);
        if (total > 0) block.sheetWages = total;
      } else if (!/^total hours/.test(t)) {
        advise('ADMIN_ROW_IGNORED', `Admin: "${cells.filter(Boolean).join(' | ')}" is not a recognised labor row`);
      }
    } else if (section === 'actual') {
      const text = cells.filter(Boolean).join(' ');
      const t = norm(text);
      const range = (re) => { const m = re.exec(t); return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null; };
      let read = false;
      const comb = range(/combine (?:about )?(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))? acres/);
      if (comb) { costing.acresPerHour.harvest = comb; read = true; }
      const plant = range(/plant (?:about )?(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))? acres/);
      if (plant) { costing.acresPerHour.plant = plant; read = true; }
      const spray = range(/spray (?:about )?(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))? acres/);
      if (spray) { costing.acresPerHour.spray = spray; read = true; }
      for (const [crop, re] of [['SOYBEANS', /beans (\d+) times/], ['CORN', /corn (\d+) times/]]) {
        const m = re.exec(t);
        if (m) { costing.applications[crop] = Number(m[1]); read = true; }
      }
      const wage = /(?:labor|wage)[^$]*\$(\d+(?:\.\d+)?)\s*(?:an|per|\/)\s*h/.exec(t);
      if (wage) { setWage(Number(wage[1])); read = true; }
      if (!read) advise('ADMIN_ROW_IGNORED', `Admin: "${text}" is not a recognised costing note`);
    }
  }
  // The operations (step 5b, §17.8; per crop and crew, §17.9). An operation is split by crop
  // when the sheet distinguishes the crops, in its custom rate or its labor block; otherwise
  // one operation covers every crop. A throughput range is priced at its midpoint, and the
  // range is kept for a later MC lever.
  const laborFor = (op, crop) => costing.labor.find(b => b.op === op && b.crop === crop)
    ?? costing.labor.find(b => b.op === op && b.crop == null);
  for (const op of [...new Set(customRates.map(x => x.op))]) {
    const split = customRates.some(x => x.op === op && x.crop) || costing.labor.some(b => b.op === op && b.crop);
    for (const crop of split ? cropsGrown : [null]) {
      const plans = cropPlans.filter(p => !crop || p.crop === crop);
      if (!plans.length) continue;
      const cr = customRates.find(x => x.op === op && x.crop === crop) ?? customRates.find(x => x.op === op && x.crop == null);
      if (!cr) {
        advise('CUSTOM_RATE_MISSING', `Admin: no custom ${op} rate for ${crop}, so its ${op} is not charged.`, { crop });
        continue;
      }
      const block = crop ? laborFor(op, crop) : laborFor(op, null);
      const o = { id: crop ? `${op}-${slug(crop)}` : op, name: cr.crop || !crop ? cr.label : `${cr.label} (${crop.toLowerCase()})`,
        customRatePerAcre: cr.rate };
      if (costing.fuelPerAcrePerApplication != null) o.fuelPerAcre = costing.fuelPerAcrePerApplication;
      const r = block ? [block.acresPerHour, block.acresPerHour] : costing.acresPerHour[op];
      if (r) { o.acresPerHour = (r[0] + r[1]) / 2; if (r[0] !== r[1]) o.acresPerHourRange = r; }
      if (block?.crew != null) o.crew = block.crew;
      // The grain cart runs with the harvest crew and is fully depreciated (owners, rev 29), so
      // it has no labor or ownership of its own: only its custom rate, for the custom basis.
      if (op === 'cart') o.crew = 0;
      operations.push(o);
      // The spraying rate is per SEASON (owners, rev 24): one pass, however many sprays.
      for (const plan of plans) {
        const n = block?.applications ?? (op === 'spray' ? costing.applications[plan.crop] : null);
        addRx(plan, { operationId: o.id, passes: 1, ...(n > 0 ? { applications: n } : {}) });
      }
    }
  }
  for (const b of costing.labor) {
    if (!customRates.some(x => x.op === b.op)) {
      advise('ADMIN_ROW_IGNORED', `Admin: labor block "${b.label}" has no custom ${b.op} rate to attach to, so it is not read.`);
    }
  }
  const trucking = [];
  for (const t of costing.trucking) {
    for (const o of operators) {
      trucking.push({ id: `truck-${o.id.toLowerCase()}-${slug(t.crop)}-${slug(t.leg)}`, operatorId: o.id, ...t });
    }
  }
  // Machinery ownership (§17.9): a per-acre rate times the operator's acres (of the crop, when
  // the label names one) is its MACHINERY figure, the ACTUAL basis's owning cost.
  const machinery = [];
  for (const w of costing.ownership) {
    for (const o of operators) {
      const acres = acresOf(o.id, f => !w.crop || planOf(f).crop === w.crop);
      if (!(acres > 0)) continue;
      machinery.push({ id: `machinery-${o.id.toLowerCase()}-${slug(w.label)}`, operatorId: o.id, name: w.label,
        amount: w.perAcre * acres, costingOnly: true });
      sheet.machinery += w.perAcre * acres;
    }
  }
  if (costing.ownership.length) {
    // The rates hold economic depreciation, insurance and the opportunity cost of the capital at
    // the operating-loan rate, not the loans' interest (owners, rev 29). So they are a costing
    // charge on the ACTUAL basis, never cash: Schedule F's machinery figure is the real one.
    advise('MACHINERY_FROM_RATES', `Machinery ownership is ${costing.ownership.map(w => `${w.label} ${usd(w.perAcre, 2)}/ac`).join(', ')}, `
      + 'charged on every planted acre (of the crop, where the label names one) in the job cost\'s actual basis. '
      + 'It is costing only, never on Schedule F: it includes the opportunity cost of the capital.');
  }
  if (operations.some(o => o.fuelPerAcre > 0)) {
    advise('FUEL_APPLICATIONS_ASSUMED', 'Fuel per acre per application is charged on every trip: planting, harvest '
      + 'and each spray (Q33 asks whether planting and harvest count).');
  }
  if (operations.some(o => o.acresPerHourRange)) {
    advise('THROUGHPUT_MIDPOINT', `Acres per hour given as a range are priced at the midpoint: `
      + operations.filter(o => o.acresPerHourRange).map(o => `${o.id} ${o.acresPerHourRange.join('–')} → ${o.acresPerHour}`).join(', ') + '.');
  }

  if (contracts.length && contractOperator === PRO_RATA) {
    advise('CONTRACT_OPERATOR_ASSUMED', 'The forward contracts name no operator, so each is split between the '
      + 'operators by their expected bushels of its crop. Pass contractOperator to give them to one.');
  }
  if (overhead.length) {
    advise('LOAN_OPERATOR_ASSUMED', (loanOperator === PRO_RATA
      ? 'The loans name no payer (Q22a was declined), so land debt is split by owned acres and the other loans by '
        + 'planted acres. '
      : `The loans are all charged to ${loanOperator}. `)
      + 'A loan is land debt (Schedule F 21a) unless its name says operating, bin or equipment (21b). '
      + 'None is marked variable-rate, so interestMultiplier moves nothing.');
  }
  if (sheet.principal > 0) {
    advise('PRINCIPAL_EXCLUDED', `Loan principal of ${usd(sheet.principal)} is repayment of debt, not an expense, and is not imported.`);
  }
  if (!products.some(p => p.category === 'NITROGEN')) {
    advise('NO_NITROGEN_LEVER', 'No input rate is nitrogen, so nitrogenMultiplier moves nothing (Q23b).');
  }

  // ─── Direct Expenses ───────────────────────────────────────────────────────────
  const dRows = parseCsv(csv.directExpenses);
  const dh = headerMap(dRows, ['job code', 'code'], 'Direct Expenses');
  const dJob = dh.col('job code'), dCode = dh.col('code'), dAmt = dh.col('amount');
  if (dAmt == null) throw new Error('Direct Expenses: no "amount" column');
  const rentMissing = [];
  const premium = new Map();
  for (const r of dRows.slice(dh.at + 1)) {
    const job = norm(r[dJob]);
    const code = norm(r[dCode]);
    if (!job && !code) continue;
    if (isErrorCell(r[dCode]) || isErrorCell(r[dAmt])) { errorCells++; continue; }
    const f = fieldByJob.get(job);
    const op = overheadOperator(job, operators);
    if (!f && !op) throw new Error(`Direct Expenses: job code "${job}" is not on the Fields sheet or an operator's overhead job`);
    const amt = cellNumber(r[dAmt]);
    if (Number.isNaN(amt)) throw new Error(`Direct Expenses: ${job} ${code} amount "${r[dAmt]}" is not a number`);
    if (op) {
      // An operator's own cost, spread over its acres (§17.9). Only fuel is read so far.
      if (amt == null) continue;
      if (/fuel/.test(code)) {
        overhead.push({ id: `fuel-${op.toLowerCase()}-${slug(code)}`, operatorId: op, name: r[dCode].trim(),
          category: 'FUEL', amount: amt, basis: 'ACRES' });
        sheet.fuel += amt;
      } else {
        advise('EXPENSE_CODE_IGNORED', `Direct Expenses: code "${r[dCode].trim()}" on ${job} is not read`, { operatorId: op });
      }
    } else if (/irrigat/.test(code)) {
      // All electricity (owners, rev 29): any pumping fuel is in the actual fuel.
      if (amt == null) continue;
      if (!f.irrigated) throw new Error(`Direct Expenses: irrigation on "${f.name}", which Fields marks dry`);
      planOf(f).irrigationElectricity = (planOf(f).irrigationElectricity ?? 0) + amt;
      sheet.irrigation += amt;
    } else if (/property tax/.test(code)) {
      if (amt != null) { f.propertyTax += amt; sheet.propertyTax += amt; }
    } else if (/cash rent|^rent/.test(code)) {
      if (amt == null) { rentMissing.push(f); continue; }
      if (f.tenure !== 'CASH_RENT') throw new Error(`Direct Expenses: cash rent on owned field "${f.name}"`);
      f.rentPerAcre += amt / f.rentedAcres;
      sheet.rent += amt;
    } else if (/crop insurance/.test(code)) {
      if (amt == null) continue;
      premium.set(f.id, (premium.get(f.id) ?? 0) + amt);
      sheet.cropInsurance += amt;
    } else {
      advise('EXPENSE_CODE_IGNORED', `Direct Expenses: code "${r[dCode].trim()}" on ${job} is not read`, { fieldId: f.id });
    }
  }
  if (costing.fuelActual) {
    advise(sheet.fuel > 0 ? 'FUEL_ACTUAL' : 'FUEL_ACTUAL_MISSING', sheet.fuel > 0
      ? `Fuel is the actual cost (${usd(sheet.fuel)}), spread over the operator's acres, so no fuel is computed per trip. `
        + 'It is a cost under the custom basis too: the owners list it beside the custom rates.'
      : 'Admin says to use the actual fuel cost, but Direct Expenses has no fuel row, so the farm has no fuel.');
  }
  for (const [fid, amt] of premium) {
    const f = fields.find(x => x.id === fid);
    planOf(f).insurancePremiumPerAcre = amt / f.plantedAcres;
  }
  for (const op of operators) {
    const missing = rentMissing.filter(f => f.operatorId === op.id);
    if (missing.length) {
      advise('RENT_MISSING', `${op.id}: ${missing.length} rented field(s) have no cash rent (${missing.map(f => f.name).join(', ')}), `
        + 'so its costs are understated by the rent.', { operatorId: op.id });
    }
    if (!fields.some(f => f.operatorId === op.id && premium.has(f.id))) {
      advise('NO_CROP_INSURANCE', `${op.id} has no crop insurance premium, so it runs uninsured: its downside is `
        + 'overstated if it does insure (Q27).', { operatorId: op.id });
    }
  }
  if (fields.some(f => f.tenure === 'CASH_RENT' && f.rentPerAcre > 0)) {
    advise('RENTED_ACRES_ASSUMED', 'The sheet gives rent as a lump per field, so rent per acre is per PLANTED acre.');
  }
  if (premium.size) {
    advise('INSURANCE_TERMS_MISSING', 'Premiums are imported as costs, but no plan, coverage level or unit is given, '
      + 'so no indemnity is modelled (farm.insurance is empty).');
  }

  // ─── Income ────────────────────────────────────────────────────────────────────
  const iRows = parseCsv(csv.income);
  const ih = headerMap(iRows, ['job code', 'code'], 'Income');
  const iJob = ih.col('job code'), iCode = ih.col('code'), iAmt = ih.col('amount');
  if (iAmt == null) throw new Error('Income: no "amount" column');
  const otherIncome = [];
  const undecided = new Set();
  for (const r of iRows.slice(ih.at + 1)) {
    const job = norm(r[iJob]);
    const code = norm(r[iCode]);
    if (!job && !code) continue;
    if (isErrorCell(r[iCode]) || isErrorCell(r[iAmt])) { errorCells++; continue; }
    const amt = cellNumber(r[iAmt]);
    if (Number.isNaN(amt)) throw new Error(`Income: ${job} ${code} amount "${r[iAmt]}" is not a number`);
    if (!amt) continue;
    const f = fieldByJob.get(job);
    const opJob = overheadOperator(job, operators);
    if (f) {
      if (!/plc|arc|program/.test(code)) {
        advise('INCOME_CODE_IGNORED', `Income: code "${r[iCode].trim()}" on ${job} is not read`, { fieldId: f.id });
        continue;
      }
      // The sheet's "PLC payment" is a generic label: the farm is on ARC-County (Q13, rev 24).
      otherIncome.push({
        id: `program-${f.id}`, operatorId: f.operatorId, name: 'ARC/PLC payment', category: 'PROGRAM_PAYMENT',
        amount: amt, paymentDate: cal.arcPaymentDate, planId: planOf(f).id,
      });
      sheet.programIncome += amt;
    } else if (opJob) {
      const op = opJob;
      otherIncome.push({
        id: `income-${op.toLowerCase()}-${slug(code)}`, operatorId: op, name: r[iCode].trim(),
        category: 'PROGRAM_PAYMENT', amount: amt, paymentDate: `${y}-12-01`,
      });
      sheet.programIncome += amt;
      undecided.add(r[iCode].trim());
    } else {
      throw new Error(`Income: job code "${job}" is not on the Fields sheet or an operator's overhead job`);
    }
  }
  if (undecided.size) {
    advise('PROGRAM_LINE_UNDECIDED', `${[...undecided].join(', ')}: put on Schedule F line 4a (program payment), paid `
      + `${y}-12-01, PROVISIONALLY. Whether one is a disaster payment (6a) or qualifies for §451(f) is not decided.`);
  }
  if (errorCells) {
    advise('ERROR_CELLS_SKIPPED', `${errorCells} row(s) with a spreadsheet error (#REF! or similar) were skipped.`);
  }

  // ─── Prices and the grain that is not contracted ───────────────────────────────
  const prices = [];
  const sales = [];
  for (const crop of cropsGrown) {
    let price = opts.prices?.[crop];
    if (!(price > 0)) {
      const month = latestPriceMonth(crop);
      price = month ? priceHistory(crop).get(month) : null;
      if (!(price > 0)) throw new Error(`no price for ${crop}: pass prices.${crop}`);
      advise('PRICE_ASSUMED', `${crop} not under contract is priced at ${usd(price, 2)}/bu, NASS's Nebraska price `
        + `received for ${month} (no basis adjustment, Q32).`, { crop });
    }
    const harvest = harvestDateFor(cal, crop);
    prices.push({ id: `price-${slug(crop)}`, crop, date: harvest, price });
    const saleDate = opts.saleDate ?? harvest;
    for (const o of operators) {
      if (!(expectedBu(o.id, crop) > 0)) continue;
      sales.push({ id: `sale-${o.id.toLowerCase()}-${slug(crop)}`, operatorId: o.id, crop, share: 1, saleDate });
    }
  }
  if (!opts.saleDate) {
    advise('SALE_DATE_ASSUMED', 'The grain not under contract is sold at harvest: the sheet gives no sale dates.');
  }
  if (!machinery.length) {
    advise('NO_MACHINERY', 'The sheet has no machinery figure for any operator, so the ACTUAL machinery basis is $0.');
  } else if (machinery.every(m => m.costingOnly)) {
    advise('NO_MACHINERY_CASH', 'The sheet has no cash machinery figure (tax depreciation or §179, machine insurance, '
      + 'repairs), so Schedule F and the household export carry no machinery cost.');
  }

  const farm = {
    seasons: [{ id: `s${y}`, cropYear: y, ...(costing.laborPerHour != null ? { laborPerHour: costing.laborPerHour } : {}) }],
    operators, fields, products, operations, cropPlans, prescriptions, machinery, overhead, prices,
    contracts, storage, sales, carryIn: [], otherIncome, carryOut: [], insurance: [], arcBase: [], arcCounties: [],
    trucking,
  };
  const errs = validateFarm(farm);
  if (errs.length) throw new Error(`the imported farm does not validate:\n  ${errs.join('\n  ')}`);
  return { farm, advisories, sheet: { ...sheet, costing } };
}

function usd(n, digits = 0) {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
