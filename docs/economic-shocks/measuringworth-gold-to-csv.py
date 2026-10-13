#!/usr/bin/env python3
"""Flatten MeasuringWorth's gold result page (HTML) into year,new_york_usd,london_usd.

usage: measuringworth-gold-to-csv.py <in.html> <out.csv>
The page is the POST result of /datasets/gold/result.php with london + newyork checked.
London = annual average of the daily London PM fix (MeasuringWorth's note cites kitco.com);
New York = USGS (Engelhard quotations). Both US $ per fine ounce from 1950.
"""
import re, sys
html = open(sys.argv[1], encoding='utf-8', errors='replace').read()
text = re.sub(r'\s+', ' ', re.sub(r'<[^>]*>', ' | ', html))
rows = re.findall(r'\| (\d{4}) \| \| ([\d.,]+) \| \| \$ ([\d.,]+)', text)
if not rows:
    sys.exit('no rows parsed: the page layout changed')
with open(sys.argv[2], 'w') as f:
    f.write('year,new_york_usd,london_usd\n')
    for y, ny, ldn in rows:
        f.write(f"{y},{ny.replace(',', '')},{ldn.replace(',', '')}\n")
print(f"{len(rows)} years -> {sys.argv[2]}")
