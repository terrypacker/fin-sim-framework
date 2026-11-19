#!/usr/bin/env python3
"""Extract one state's corn and soybean rows from an FSA ARC-CO benchmark workbook (.xlsx).

Standard library only (FinSim has no xlsx reader, and the docs folder has no Python deps).
Reads the first worksheet, finds the header row (the first row with a cell naming the
state), and writes every row whose state cell matches and whose crop is corn or soybeans,
as CSV on stdout, header first, values exactly as the workbook stores them.

    python3 -I fsa-arcco-extract.py FSA-arcco-2026-data-2026-01-16.xlsx Nebraska > out.csv
"""
import csv, re, sys, zipfile
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def col_index(ref):
    letters = re.match(r'[A-Z]+', ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def rows(path):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
    sheet = sorted(n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', n))[0]
    for row in ET.fromstring(z.read(sheet)).iter('{%s}row' % NS['m']):
        out = []
        for c in row.findall('m:c', NS):
            i = col_index(c.get('r'))
            while len(out) < i:
                out.append('')
            v = c.find('m:v', NS)
            if c.get('t') == 's' and v is not None:
                out.append(shared[int(v.text)])
            elif c.get('t') == 'inlineStr':
                out.append(''.join(t.text or '' for t in c.iter('{%s}t' % NS['m'])))
            else:
                out.append(v.text if v is not None else '')
        yield out


def main(path, state):
    w = csv.writer(sys.stdout, lineterminator='\n')
    header = None
    for r in rows(path):
        cells = [x.strip() for x in r]
        if header is None:
            if any(re.search(r'state', x, re.I) for x in cells) and any(re.search(r'crop', x, re.I) for x in cells):
                header = cells
                w.writerow(header)
            continue
        si = next(i for i, h in enumerate(header) if re.search(r'state', h, re.I))
        ci = next(i for i, h in enumerate(header) if re.search(r'crop', h, re.I))
        if len(cells) <= max(si, ci):
            continue
        if cells[si].lower() == state.lower() and re.match(r'(corn|soybeans?)\b', cells[ci], re.I):
            w.writerow(cells)
    if header is None:
        sys.exit('no header row naming a state and a crop column')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
