#!/usr/bin/env python3
#
# Copyright (c) 2026 Terry Packer.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
"""
xlsx-to-csv.py: write each sheet of an .xlsx workbook as a CSV, the input that
`npm run farm:workbook` reads (design 134 §17.2, phase 5).

Usage:
    python3 scripts/farm/xlsx-to-csv.py <workbook.xlsx> <out-dir>

Each sheet becomes <out-dir>/<sheet name without spaces>.csv, so "Direct Expenses"
becomes DirectExpenses.csv. Uses only the standard library, so no openpyxl or Excel
is needed.

It writes each cell's CACHED value, the result Excel saved, and does not evaluate
formulas. A number is rounded to the decimals of its display format, the way Excel's
Save as CSV writes it: a yield shown as 184.67 is written as 184.67, not 184.6666…
It drops currency symbols and thousands separators, which the importer ignores
anyway. "General" cells keep 15 significant digits. Error cells (#REF!) are kept as
text, so the importer can count and skip them.
"""

import argparse
import csv
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

NS = {
    'm': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}
M = '{%s}' % NS['m']

# Built-in number formats (ECMA-376 §18.8.30) that can carry decimals.
BUILTIN_FORMATS = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%',
    11: '0.00E+00', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
    39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
    44: '_("$"* #,##0.00_)', 48: '##0.0E+0',
}


def shared_strings(z):
    if 'xl/sharedStrings.xml' not in z.namelist():
        return []
    root = ET.fromstring(z.read('xl/sharedStrings.xml'))
    return [''.join(t.text or '' for t in si.iter(M + 't')) for si in root.findall('m:si', NS)]


def style_decimals(z):
    """Return a list: cell style index -> decimals to round to, or None for General."""
    if 'xl/styles.xml' not in z.namelist():
        return []
    st = ET.fromstring(z.read('xl/styles.xml'))
    formats = dict(BUILTIN_FORMATS)
    nf = st.find('m:numFmts', NS)
    if nf is not None:
        for f in nf:
            formats[int(f.get('numFmtId'))] = f.get('formatCode')

    def decimals(code):
        if code is None or code == 'General' or 'E+' in code.upper():
            return None
        # The positive section, without quoted text, escapes and [colour] tags.
        sec = re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', '', code.split(';')[0])
        m = re.search(r'[0#?]\.([0#?]+)', sec)
        d = len(m.group(1)) if m else 0
        return d + 2 if '%' in sec else d

    xfs = st.find('m:cellXfs', NS)
    return [decimals(formats.get(int(x.get('numFmtId', 0)))) for x in (xfs if xfs is not None else [])]


def format_number(text, decimals):
    x = float(text)
    x = round(x, decimals) if decimals is not None else float('%.15g' % x)
    return '%d' % x if x == int(x) and abs(x) < 1e15 else repr(x)


def column_index(ref):
    n = 0
    for ch in re.match(r'[A-Z]+', ref).group():
        n = n * 26 + ord(ch) - 64
    return n - 1


def convert(src, out_dir):
    z = zipfile.ZipFile(src)
    strings = shared_strings(z)
    decimals = style_decimals(z)
    rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
    workbook = ET.fromstring(z.read('xl/workbook.xml'))
    os.makedirs(out_dir, exist_ok=True)

    written = []
    for sheet in workbook.find('m:sheets', NS):
        name = sheet.get('name')
        target = rels[sheet.get('{%s}id' % NS['r'])].lstrip('/')
        path = target if target.startswith('xl/') else 'xl/' + target
        rows = {}
        for c in ET.fromstring(z.read(path)).iter(M + 'c'):
            ref, kind, v = c.get('r'), c.get('t'), c.find('m:v', NS)
            if kind == 's':
                val = strings[int(v.text)]
            elif kind == 'inlineStr':
                val = ''.join(t.text or '' for t in c.iter(M + 't'))
            elif v is None:
                val = ''
            elif kind in ('str', 'e', 'b'):
                val = v.text or ''
            else:
                si = int(c.get('s', 0))
                val = format_number(v.text, decimals[si] if si < len(decimals) else None)
            rows.setdefault(int(re.search(r'\d+', ref).group()), {})[column_index(ref)] = val

        width = max((max(r) for r in rows.values() if r), default=-1) + 1
        file = os.path.join(out_dir, re.sub(r'\s+', '', name) + '.csv')
        with open(file, 'w', newline='') as f:
            w = csv.writer(f)
            for r in range(1, max(rows, default=0) + 1):
                cells = rows.get(r, {})
                w.writerow([cells.get(i, '') for i in range(width)])
        written.append((name, file, len(rows)))
    return written


def main():
    p = argparse.ArgumentParser(description='Write each sheet of an .xlsx workbook as a CSV (cached values).')
    p.add_argument('workbook', help='the .xlsx file')
    p.add_argument('out_dir', help='folder to write the CSVs into (created if missing)')
    a = p.parse_args()
    try:
        for name, file, n in convert(a.workbook, a.out_dir):
            print(f'{name} -> {file} ({n} rows)')
    except (zipfile.BadZipFile, KeyError) as e:
        sys.exit(f'{a.workbook}: not a readable .xlsx workbook ({e})')


if __name__ == '__main__':
    main()
