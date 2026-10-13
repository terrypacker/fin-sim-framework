#!/usr/bin/env python3
"""Extract the monthly GOLD price from the World Bank "Pink Sheet" workbook to CSV.

usage: worldbank-cmo-gold-to-csv.py <CMO-Historical-Data-Monthly.xlsx> <out.csv>

Standard library only (no openpyxl): an .xlsx is a zip of XML. Reads the "Monthly Prices"
sheet, finds the column whose header names Gold, and writes month,gold_usd_per_troy_oz.
Months in the sheet look like 1960M01.
"""
import re, sys, zipfile
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
z = zipfile.ZipFile(sys.argv[1])

shared = []
if 'xl/sharedStrings.xml' in z.namelist():
    for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
        shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))

wb = ET.fromstring(z.read('xl/workbook.xml'))
rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
target = {r.get('Id'): r.get('Target') for r in rels}
sheet = next(s for s in wb.find('m:sheets', NS) if s.get('name') == 'Monthly Prices')
path = 'xl/' + target[sheet.get('{%s}id' % NS['r'])].lstrip('/').removeprefix('xl/')

def col(ref):
    n = 0
    for ch in re.match(r'[A-Z]+', ref).group():
        n = n * 26 + ord(ch) - 64
    return n

rows = []
for row in ET.fromstring(z.read(path)).find('m:sheetData', NS):
    cells = {}
    for c in row:
        v = c.find('m:v', NS)
        if v is None:
            continue
        val = shared[int(v.text)] if c.get('t') == 's' else v.text
        cells[col(c.get('r'))] = val
    rows.append(cells)

gold_col = next(k for r in rows[:10] for k, v in r.items() if isinstance(v, str) and v.strip().lower().startswith('gold'))
out = []
for r in rows:
    m = r.get(1, '')
    if re.fullmatch(r'\d{4}M\d{2}', str(m)) and gold_col in r:
        try:
            out.append((f"{m[:4]}-{m[5:]}", float(r[gold_col])))
        except ValueError:
            pass
if not out:
    sys.exit('no rows parsed: the workbook layout changed')
with open(sys.argv[2], 'w') as f:
    f.write('month,gold_usd_per_troy_oz\n')
    for m, v in out:
        f.write(f"{m},{v}\n")
print(f"{len(out)} months ({out[0][0]} .. {out[-1][0]}) -> {sys.argv[2]}")
