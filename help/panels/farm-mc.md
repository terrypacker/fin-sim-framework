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
  src/finance/farm/farm-mc.js: 759767
---

Runs the farm season many times with its uncertain inputs drawn at random, and shows how
often each field, operator and crop loses money. It reads a farm scenario (US Farm).

**Variables** lists what the batch can draw: yield shocks, price rows, cost multipliers and
the contracted share. Tick a row to sample it. The season yield shocks and price paths come
calibrated from USDA history for Nebraska counties (`npm run farm:calibrate`). Every other
row starts at a spread of 0, because no source sets it, so type one; the panel calls that a
sensitivity run.

**The charts**, for the whole farm or one operator: a fan of the cash in and out month by
month, from the prepay to the next year's ARC payment, as 10th–90th and 25th–75th percentile
bands around the median. It is cash, so it leaves out the custom-rate charges and comes
before the tax-year rules move income. Below it, a histogram of the season's net, losses in
red.

**Results**: *P(loss)* is the share of seasons whose net is below zero. The net shows its
10th, 50th and 90th percentiles, the breakevens their 10th–90th range. An operator row adds
its cash Schedule F net. *Insurance* and *ARC* show the average payment and how often each
pays. The machinery switch works as on the Field P&L.

The same seed always gives the same seasons, so rerunning after one change is a fair
comparison.
