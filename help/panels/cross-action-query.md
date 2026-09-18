---
id: cross-action-query
kind: panel
title: Field × Action
panels: [cross-action-query]
stamps:
  panel:cross-action-query: d845d4
---

One state field, every action type that has ever changed it, across the whole run.

[State](state-panel.md) tells you what a field is now. [Action Detail](action-detail.md)
tells you what one action did to it. This is the population: pick a field and an
action type and see every occurrence, which turns a single suspicious entry into a
pattern or shows that it was a one-off.

It is the fastest way to answer "what is moving this number?" when the answer is not
obvious. A balance that drifts for no reason you can see usually has one action type
behind most of the movement, and this is where that becomes visible.

Open it from the "Field × Action" button in [Action Detail](action-detail.md) and it
arrives pre-seeded with the field and action type you were looking at — which is the
usual way in, because the question almost always starts from one instance.

Needs a run with the journal recorded.

This panel was promoted out of a modal inside the State panel. The behaviour is the
same; having it as a pane means you can leave it open beside the thing you are
investigating instead of losing it on every click.
