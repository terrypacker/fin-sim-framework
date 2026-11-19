# Filter the USDA NASS Quick Stats crops bulk file (gunzipped, on stdin) down to what the farm
# Monte Carlo calibration reads (design 134 §13.8). Writes tab-separated text to argv[1].
#
# Kept, SURVEY rows only:
#   yields, BU / ACRE (corn for GRAIN only): Nebraska counties from 1947 (the first year with
#     an irrigated / non-irrigated split), Nebraska state and the US, all years;
#   prices received, $ / BU: Nebraska state and the US, monthly and annual.
# Dropped: agricultural districts, and the `short_desc` column (it restates the others).
#
# Run by fetch-sources.sh; see SOURCES.md.
import sys, csv

out = open(sys.argv[1], 'w', newline='')
r = csv.reader(sys.stdin, delimiter='\t', quoting=csv.QUOTE_NONE)
hdr = next(r)
ix = {h.lower(): i for i, h in enumerate(hdr)}
keep = ['source_desc', 'commodity_desc', 'class_desc', 'prodn_practice_desc', 'util_practice_desc',
        'statisticcat_desc', 'unit_desc', 'agg_level_desc', 'state_alpha', 'asd_desc',
        'county_name', 'county_ansi', 'year', 'freq_desc', 'reference_period_desc', 'value', 'cv_%']
w = csv.writer(out, delimiter='\t', lineterminator='\n')
w.writerow(keep)
n = 0
for row in r:
    if len(row) < len(hdr):
        continue
    g = lambda k: row[ix[k]]
    if g('commodity_desc') not in ('CORN', 'SOYBEANS') or g('source_desc') != 'SURVEY':
        continue
    st, lvl, cat = g('state_alpha'), g('agg_level_desc'), g('statisticcat_desc')
    if cat == 'YIELD' and g('unit_desc') == 'BU / ACRE':
        if g('commodity_desc') == 'CORN' and g('util_practice_desc') != 'GRAIN':
            continue
        ok = ((st == 'NE' and lvl == 'COUNTY' and int(g('year')) >= 1947)
              or (st == 'NE' and lvl == 'STATE') or lvl == 'NATIONAL')
    elif cat == 'PRICE RECEIVED' and g('unit_desc') == '$ / BU':
        ok = (st == 'NE' and lvl == 'STATE') or lvl == 'NATIONAL'
    else:
        ok = False
    if ok:
        w.writerow([g(k) for k in keep])
        n += 1
out.close()
print('rows', n, file=sys.stderr)
