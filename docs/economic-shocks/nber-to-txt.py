#!/usr/bin/env python3
"""Flatten the NBER business-cycle reference-date table to plain text.
Usage: nber-to-txt.py <page.html> <out.txt>
"""
import html, re, sys

t = open(sys.argv[1], encoding='utf-8').read()
out = ['NBER US Business Cycle Expansions and Contractions',
       'Source: https://www.nber.org/research/data/us-business-cycle-expansions-and-contractions',
       'Fetched by docs/economic-shocks/fetch-sources.sh', '']
for row in re.findall(r'<tr[^>]*>(.*?)</tr>', t, re.S):
    cells = [re.sub(r'\s+', ' ', html.unescape(re.sub('<[^>]+>', '', c)).strip())
             for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', row, re.S)]
    if any(cells):
        out.append(' | '.join(cells))
open(sys.argv[2], 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print(f"  NBER     {len(out) - 4} rows")
