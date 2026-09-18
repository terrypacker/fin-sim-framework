---
id: action-detail
kind: panel
title: Action Detail
panels: [action-detail]
design: [91-journal-payload-manifest.md]
stamps:
  panel:action-detail: 863051
---

One action, in full: its payload fields and the state changes its reducer made.

Open it by clicking an action in [Timeline](timeline.md) or a journal row elsewhere.
It answers "what exactly did this do", which is the question that follows finding a
suspicious entry.

The payload is the action's own declared fields — what it was told to do — and the
state changes are what actually happened as a result. Those are two different things,
and comparing them is the point: an action carrying a $40,000 amount whose state diff
moves $12,000 is telling you something.

Its "Field × Action" button opens [Field × Action](cross-action-query.md) pre-seeded
with the field and the action type you are looking at, which turns one instance into
the whole population: every other time that action type touched that field.

Needs a run with the journal recorded. Runs made with telemetry reduced — the
headless `--fast` path, or a Monte Carlo batch — carry no journal to open, so this
panel has nothing to show for them by design rather than by failure.
