---
id: farm-mc
kind: panel
title: Farm MC
panels: [farm-mc]
params: []
actions: []
tools: []
design: [134-farm-job-costing.md]
sources: [src/finance/farm/farm-mc.js]
stamps:
  panel:farm-mc: 7bf9f3
  src/finance/farm/farm-mc.js: de0d60
---

Runs the farm season many times with its uncertain inputs drawn at random, and shows how
often each field, operator and crop loses money. It reads a farm scenario (US Farm); a
household plan has no farm records, and the panel says so.

**Variables** lists everything the batch can draw: the season's dryland and irrigated yield
shocks, each crop plan's own, a shock on each price row, the cost multipliers and the
contracted share. Tick a row to sample it. The two season shocks and the price paths come
calibrated from USDA history for Nebraska counties (`npm run farm:calibrate`), with a
drought's long tail, and a price row with no season volatility uses that history's. Every other row starts at a spread of
0, because no source sets it, so type one. The panel calls those a sensitivity run.

**Results** open with the whole farm, then each operator with its crop plans, then each
crop. *P(loss)* is the share of seasons whose net is below zero. The net shows its 10th,
50th and 90th percentiles, the breakevens their 10th–90th range. An operator row adds its
cash Schedule F net, after the prepaid-supplies limit. *Insurance* and *ARC* are the crop
insurance claim and the ARC-County payment: the average over all seasons, and how often
each pays. The machinery switch works as on the Field P&L.

The same seed always gives the same seasons, so rerunning after one change is a fair
comparison. The CSV carries every metric's distribution.
