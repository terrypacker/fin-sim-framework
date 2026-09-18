---
id: timeline
kind: panel
title: Timeline
panels: [timeline]
stamps:
  panel:timeline: a6af45
---

The run as a scrollable calendar: every date something happened, the events that
fired on it, and the actions each event emitted.

This is the flat, ordered view of the run — what happened, in the order it happened.
[Lineage](lineage.md) is the other half: what happened *because of* what. Two actions
next to each other here may be unrelated; two actions far apart here may be parent
and child.

Open it when you want to find the moment something went wrong, or to confirm that a
thing you configured is actually firing on the dates you meant. Scrolling to a date
and seeing nothing there is a common and useful answer.

It is virtualised, so a forty-year run scrolls without building tens of thousands of
rows up front. The panel manages its own scrolling for that reason and deliberately
does not sit inside a scrolling wrapper.

Needs a run that has stepped. Clicking through to an action opens it in
[Action Detail](action-detail.md).

Same-date ordering is decided by a tie rule, not by anything you set. Adding an
event anywhere in a plan can therefore change which of two same-day actions runs
first elsewhere — a diff that looks unrelated to your change often is not.
