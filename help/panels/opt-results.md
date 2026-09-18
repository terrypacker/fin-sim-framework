---
id: opt-results
kind: panel
title: OPT Results
panels: [opt-results]
stamps:
  panel:opt-results: 36a150
---

How the search went: badges for the best score, the number of candidates run and how
many failed, a bar chart of the leading candidates' scores, and a ranked table of all
of them with their metrics.

Read the chart before the winner. A search whose top candidates are all within a
hair of each other is telling you the parameter barely matters — the "optimal" value
is noise, and acting on it is precision you do not have. A search with one clear peak
is a real finding. Both look like a single best score in a badge.

The failure count deserves the same attention. A search where most candidates failed
has explored mostly ruin, and its best survivor may be the least bad of a bad
neighbourhood rather than a good plan.

The ranked table carries each candidate's metrics, not just its score, which is how
you notice a candidate that scored well on the objective while doing something you
would not accept on a metric the objective ignores.

Needs a completed [Optimize](opt-config.md) run. To apply a candidate to the live
scenario, use [OPT Runs](opt-runs.md).
