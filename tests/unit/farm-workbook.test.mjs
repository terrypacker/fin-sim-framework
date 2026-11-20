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
 * The yearly workbook importer (design 134 §17.2, phase 5): the owners' four-sheet layout
 * becomes `cfg.farm`, and the amounts the sheet states come back out of the model's ledger.
 * The workbook here is synthetic; it has the owners' layout and quirks, not their figures.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { importFarmWorkbook, parseCsv, cellNumber, PRO_RATA } from '../../src/finance/farm/farm-workbook.js';
import { FarmScenario } from '../../src/scenarios/farm-scenario.js';
import { runFarm }      from '../../src/finance/farm/farm-run.js';
import { latestPriceMonth, priceHistory } from '../../src/finance/farm/farm-price-history.js';

// Columns as the owners' sheet has them, with its heading row, trailing spaces and mixed case.
const FIELDS = [
  ',JOBCODE,CROP,Acres,Corn,Beans,IRR/DRY,OWN/RENT,Operator Code,Seed Units,YIELD,',
  'North,A-D-NORTH,C,100.00,100.00,0,Dry,Rent,A,40,200.00,',
  'River ,A-I-RIVER ,C2,50.00,50.00,0,IRR,OWN ,A,20,220.00,',
  'Hill,A-D-HILL,B,80.00,0,80,DRY,Own,A,88,60.00,',
  'Second Acres,,,,,,,,,,,',
  'East,B-D-EAST,B,120.00,0,120,Dry,RENT,B,,70.00,',
  'West,B-I-WEST,C,60.00,60.00,0,IRR,Own,B,24,230.00,',
].join('\n');

const ADMIN = [
  'CORN Seed Price, $300.00 ,Per Unit,',
  'BEAN Seed Price, $50.00 ,Per Unit,',
  'CORN FERT, $200.00 ,Per Corn Acre,',
  'LYME, $30.00 ,Per Corn Acre,',
  'CORN CHEM, $60.00 ,Per Corn Acre,',
  'Custom Application, $15.00 ,Per Corn Acre, ',
  'Bean Chem, $80.00 ,Per Bean Acre,',
  ',,,',
  ',Bushels,Price,',
  'Beans - sold out of field,"1,000.00", $11.00 ,',
  'Corn - Dec Delivery,"10,000.00", $4.50 ,',
  'Corn - Jan Delivery,"5,000.00", $4.75 ,',
  ',,,',
  'Paid this year,Principal,Interest,',
  'Loan 101," $10,000.00 "," $8,000.00 ",',
  'Operating Loan,," $3,000.00 ",',
  ',,,',
  'Custom Farming Rates:,,,',
  '"Storing Grain, bin rental", $0.03 ,Per Bushel/Month,',
  'Planting Corn or soybeans, $30.00 ,per acre,',
  'Harvesting Corn or Soybeans, $50.00 ,per acre,',
  'Spraying corn or soybeans, $40.00 ,per acre,',
  'Fuel, $1.00 ,per acre per application,',
  ',,,',
  'Actual Rates for some analysis:,,,',
  'Can combine about 30 acres an hour (max),,,',
  'Can plant 30-40 acres an hour,,,',
  '"Spray 80-120 acres/hour, have to spray beans 4 times a year and corn 3 times a year",,,',
  'Average Farm Labor Wages operating machinery is $27 an hour,,,',
  'Trucking Corn out of field, $0.15 ,per bushel',
  'Trucking Beans (from storage to sale), $0.10 ,per bushel',
].join('\n');

const DIRECT = [
  'Job Code,Code, Amount ',
  'A-I-RIVER ,PROPERTY TAXES," $2,000.00 "',
  'A-D-HILL,PROPERTY TAXES," $1,500.00 "',
  'B-I-WEST,PROPERTY TAXES," $1,200.00 "',
  'A-D-NORTH,CASH RENT," $25,000.00 "',
  'B-D-EAST,CASH RENT,',
  'A-D-NORTH,CROP INSURANCE,1000',
  'A-I-RIVER ,CROP INSURANCE,400',
].join('\n');

const INCOME = [
  'Job Code,CODE, AMOUNT ',
  'A OVERHEAD,SDR PAYMENT," $5,000.00 "',
  'A-D-NORTH,PLC PAYMENT," $2,000.00 "',
  'A-D-HILL,PLC PAYMENT, $-   ',
  ',,',
  'A-D-NORTHOLD,#REF!,#REF!',
].join('\n');

const WB = { fields: FIELDS, admin: ADMIN, directExpenses: DIRECT, income: INCOME };
const PRICES = { CORN: 4.25, SOYBEANS: 10.5 };
const imp = (opts = {}) => importFarmWorkbook(WB, { cropYear: 2026, prices: PRICES, ...opts });
const kinds = (r) => r.advisories.map(a => a.kind);

describe('farm workbook import (design 134 §17.2)', () => {
  test('cells: CSV quotes, money, the accounting dash and negatives', () => {
    assert.deepEqual(parseCsv('a,"b,c",""\r\n"d""e",f'), [['a', 'b,c', ''], ['d"e', 'f']]);
    assert.equal(cellNumber(' $1,234.50 '), 1234.5);
    assert.equal(cellNumber(' $-   '), 0);
    assert.equal(cellNumber('(12.00)'), -12);
    assert.equal(cellNumber('  '), null);
    assert.ok(Number.isNaN(cellNumber('n/a')));
  });

  test('fields: keyed by header, headings skipped, codes trimmed and case-folded', () => {
    const { farm } = imp();
    assert.deepEqual(farm.operators.map(o => o.id), ['A', 'B']);
    assert.deepEqual(farm.fields.map(f => f.id), ['north', 'river', 'hill', 'east', 'west']);
    const river = farm.fields.find(f => f.id === 'river');
    assert.equal(river.name, 'River');
    assert.equal(river.tenure, 'OWN');
    assert.equal(river.irrigated, true);
    const plan = farm.cropPlans.find(p => p.fieldId === 'river');
    assert.equal(plan.crop, 'CORN');
    assert.equal(plan.rotation, 'CORN_ON_CORN');
  });

  test('a reordered Fields sheet imports the same farm', () => {
    const rows = parseCsv(FIELDS);
    const order = [8, 0, 2, 1, 3, 6, 7, 10, 9];
    const text = rows.map(r => order.map(i => r[i] ?? '').map(v => (/,/.test(v) ? `"${v}"` : v)).join(',')).join('\n');
    const a = imp().farm;
    const b = importFarmWorkbook({ ...WB, fields: text }, { cropYear: 2026, prices: PRICES }).farm;
    assert.deepEqual(b.fields, a.fields);
    assert.deepEqual(b.cropPlans, a.cropPlans);
  });

  test('input rates: seed per unit, the rest per acre of their crop; fertilizer is not nitrogen (Q23a)', () => {
    const r = imp();
    const { farm } = r;
    assert.equal(farm.products.find(p => p.id === 'corn-other-fertilizer').category, 'OTHER_FERTILIZER');
    assert.equal(farm.products.find(p => p.id === 'corn-custom-application').category, 'CUSTOM_APPLICATION');
    assert.ok(!farm.products.some(p => p.category === 'NITROGEN'));
    assert.ok(kinds(r).includes('NO_NITROGEN_LEVER'));
    const seed = farm.prescriptions.find(x => x.planId === 'plan-north' && x.productId === 'corn-seed');
    assert.equal(seed.ratePerAcre, 40 / 100);
    // The C2 field takes the corn rates too.
    assert.ok(farm.prescriptions.some(x => x.planId === 'plan-river' && x.productId === 'corn-lime'));
    // East's seed units are blank: no seed line, and the report's NO_SEED catches it.
    assert.ok(!farm.prescriptions.some(x => x.planId === 'plan-east' && x.productId === 'soybeans-seed'));
  });

  test('spraying is one pass a season (owners, rev 24)', () => {
    const { farm } = imp();
    const spray = farm.prescriptions.filter(x => x.operationId === 'spray');
    assert.equal(spray.length, farm.cropPlans.length);
    assert.ok(spray.every(x => x.passes === 1));
  });

  test('contracts: delivery month → date, the year after for January; split pro rata by default', () => {
    const r = imp();
    const dec = r.farm.contracts.filter(c => c.name === 'Corn - Dec Delivery');
    assert.deepEqual([...new Set(dec.map(c => c.deliveryDate))], ['2026-12-15']);
    const jan = r.farm.contracts.find(c => c.name === 'Corn - Jan Delivery');
    assert.equal(jan.deliveryDate, '2027-01-15');
    const beans = r.farm.contracts.filter(c => c.crop === 'SOYBEANS');
    assert.deepEqual([...new Set(beans.map(c => c.deliveryDate))], ['2026-10-01']);   // at harvest
    // A expects 100·200 + 50·220 = 31,000 bu corn, B 60·230 = 13,800.
    const share = Object.fromEntries(dec.map(c => [c.operatorId, c.bushels]));
    assert.ok(Math.abs(share.A - 10000 * 31000 / 44800) < 1e-9);
    assert.ok(Math.abs(share.A + share.B - 10000) < 1e-9);
    assert.ok(kinds(r).includes('CONTRACT_OPERATOR_ASSUMED'));
    const one = imp({ contractOperator: 'B' });
    assert.ok(one.farm.contracts.every(c => c.operatorId === 'B'));
    assert.equal(one.farm.contracts.length, 3);
  });

  test('loans: interest imported, principal is not; land debt by owned acres, other loans by acres', () => {
    const r = imp({ loanOperator: PRO_RATA });
    const land = r.farm.overhead.filter(o => o.name === 'Loan 101 interest');
    assert.ok(land.every(o => o.category === 'INTEREST_MORTGAGE' && o.basis === 'OWNED_ACRES'));
    // A owns 50 + 80 = 130 acres, B 60.
    assert.ok(Math.abs(land.find(o => o.operatorId === 'A').amount - 8000 * 130 / 190) < 1e-9);
    const op = r.farm.overhead.filter(o => o.name === 'Operating Loan interest');
    assert.ok(op.every(o => o.category === 'INTEREST_OTHER' && o.basis === 'ACRES'));
    assert.equal(r.sheet.principal, 10000);
    assert.ok(kinds(r).includes('PRINCIPAL_EXCLUDED'));
  });

  test('blanks are advisories, never $0; #REF! rows are skipped and counted', () => {
    const r = imp();
    const rent = r.advisories.find(a => a.kind === 'RENT_MISSING');
    assert.equal(rent.operatorId, 'B');
    assert.equal(r.farm.fields.find(f => f.id === 'east').rentPerAcre, 0);
    assert.ok(r.advisories.some(a => a.kind === 'NO_CROP_INSURANCE' && a.operatorId === 'B'));
    assert.match(r.advisories.find(a => a.kind === 'ERROR_CELLS_SKIPPED').message, /^1 row/);
  });

  test('income: a field\'s program payment on its plan; an operator\'s overhead payment, provisionally 4a', () => {
    const r = imp();
    const plc = r.farm.otherIncome.find(i => i.planId === 'plan-north');
    assert.equal(plc.amount, 2000);
    assert.equal(plc.paymentDate, '2027-10-01');
    assert.ok(!r.farm.otherIncome.some(i => i.planId === 'plan-hill'));      // "$-" is zero
    const sdr = r.farm.otherIncome.find(i => i.name === 'SDR PAYMENT');
    assert.equal(sdr.operatorId, 'A');
    assert.equal(sdr.planId, undefined);
    assert.ok(kinds(r).includes('PROGRAM_LINE_UNDECIDED'));
  });

  test('costing inputs are read for the computed operation costs', () => {
    const { costing } = imp().sheet;
    assert.equal(costing.fuelPerAcrePerApplication, 1);
    assert.deepEqual(costing.acresPerHour, { harvest: [30, 30], plant: [30, 40], spray: [80, 120] });
    assert.deepEqual(costing.applications, { SOYBEANS: 4, CORN: 3 });
    assert.equal(costing.laborPerHour, 27);
    assert.deepEqual(costing.trucking, [
      { crop: 'CORN', leg: 'FIELD', perBu: 0.15 }, { crop: 'SOYBEANS', leg: 'STORAGE_TO_SALE', perBu: 0.1 },
    ]);
  });

  test('a crop with no price given takes NASS\'s latest Nebraska price', () => {
    const r = importFarmWorkbook(WB, { cropYear: 2026, prices: { CORN: 4 } });
    const m = latestPriceMonth('SOYBEANS');
    assert.equal(r.farm.prices.find(p => p.crop === 'SOYBEANS').price, priceHistory('SOYBEANS').get(m));
    assert.ok(r.advisories.some(a => a.kind === 'PRICE_ASSUMED' && a.crop === 'SOYBEANS'));
    assert.ok(!r.advisories.some(a => a.kind === 'PRICE_ASSUMED' && a.crop === 'CORN'));
  });

  test('refuses what it cannot read: an unknown job code, a field with no operator, no crop year', () => {
    assert.throws(() => importFarmWorkbook({ ...WB, directExpenses: `${DIRECT}\nZ-D-NOPE,PROPERTY TAXES,10` },
      { cropYear: 2026, prices: PRICES }), /not on the Fields sheet/);
    assert.throws(() => importFarmWorkbook({ ...WB, fields: `${FIELDS}\nLost,X-D-LOST,C,10,10,0,Dry,Rent,,1,100` },
      { cropYear: 2026, prices: PRICES }), /no operator code/);
    assert.throws(() => importFarmWorkbook(WB, {}), /cropYear/);
  });

  test('the season runs, and the sheet\'s stated amounts come back out of the ledger', () => {
    const r = imp();
    const cfg = FarmScenario.buildDefaultConfig({ farm: r.farm });
    const log = console.log; console.log = () => {};
    let run;
    try { run = runFarm(cfg); } finally { console.log = log; }
    const sum = (pred) => run.ledger.filter(p => p.cropYear === 2026 && pred(p)).reduce((s, p) => s + p.amount, 0);
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
    near(sum(p => p.category === 'LAND_RENT'), r.sheet.rent);
    near(sum(p => p.category === 'PROPERTY_TAX'), r.sheet.propertyTax);
    near(sum(p => p.category === 'CROP_INSURANCE'), r.sheet.cropInsurance);
    near(sum(p => p.category === 'PROGRAM_PAYMENT'), r.sheet.programIncome);
    near(sum(p => p.category.startsWith('INTEREST_')), r.sheet.interest);
    // Corn inputs per acre: 300·0.4 seed on North + 200 + 30 + 60 + 15.
    const north = sum(p => p.jobId === 'plan-north' && ['SEED', 'OTHER_FERTILIZER', 'LIME', 'OTHER_CHEMICAL', 'CUSTOM_APPLICATION'].includes(p.category));
    near(north, 100 * (120 + 200 + 30 + 60 + 15));
    // The custom application is cash custom hire (line 13).
    assert.ok(run.ledger.some(p => p.category === 'CUSTOM_APPLICATION' && p.cash && p.line === '13'));
  });
});
