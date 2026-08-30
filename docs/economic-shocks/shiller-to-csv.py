#!/usr/bin/env python3
"""Convert Robert Shiller's ie_data.xls (the workbook behind *Irrational Exuberance*)
into data/Shiller-SP500-monthly.csv. Called by fetch-sources.sh.

Needs xlrd for the legacy .xls format: python3 -m pip install xlrd
Usage: shiller-to-csv.py <ie_data.xls> <out.csv>
"""
import csv, sys
import xlrd

sh = xlrd.open_workbook(sys.argv[1]).sheet_by_name('Data')
rows = []
for r in range(8, sh.nrows):
    d = sh.cell_value(r, 0)
    if not isinstance(d, float):
        continue
    y, m = int(d), int(round((d - int(d)) * 100))
    if not 1 <= m <= 12:
        continue
    g = lambda c: ('' if isinstance(sh.cell_value(r, c), str) else sh.cell_value(r, c))
    rows.append([f"{y:04d}-{m:02d}-01", g(1), g(2), g(3), g(4), g(6), g(7), g(8), g(9)])

with open(sys.argv[2], 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['observation_date', 'SP500_price', 'SP500_dividend_12m', 'SP500_earnings_12m',
                'CPI', 'GS10', 'real_price', 'real_dividend', 'real_total_return_price'])
    w.writerows(rows)
print(f"  SHILLER  {len(rows)} months, {rows[0][0]} .. {rows[-1][0]}")
