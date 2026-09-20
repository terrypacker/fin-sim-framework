# 111 — Node-type help: the forms you actually author a plan in

**Status:** COMPLETE — built 19 Sep 2026. Design 108 documented the *parameters* and the
*panels*; this documents the eleven node edit forms, which between them carry 164 controls
and had no coverage at all. It touches no reducer, no handler and no scenario param, so it
moves no golden. Its cost is one generator collector, one gate rule set, one decorator, and
~145 field descriptions.

## 1. The ask

The user was configuring a RealProperty from the Nodes panel and found the form's on-hover
help "a bit lacking". It is. Measured across the eleven kinds in the Nodes panel's own kind
list:

| kind | fields | had any help | where the form comes from |
|---|---|---|---|
| real-property | 45 | 34 | `tpl-real-property-editor` |
| account | 26 | 15 | `tpl-account-editor` |
| person | 25 | 3 + 13 hints | `tpl-person-editor` + `PAYROLL_ELECTION_META` |
| security | 17 | 17 | `FIELD_SPECS` in `security-editor.js` |
| collectible / company | 22 | 2 | two templates |
| event / reducer / action / handler | 22 | 0 | 14 templates |
| bequest | 7 | 0 | imperative `_field()` calls |
| **total** | **164** | **~84** | |

Half the surface said nothing. The half that spoke said it as a native `title=` attribute,
which is exactly the failure design 108 §2 recorded for parameters — it truncates, it
cannot be laid out, and it is invisible to a reader who is not hovering. Worse, that prose
sat in `index.html` and in two `src/` registries, where nothing reviewed it as prose,
nothing checked it against the code, and **the headless reader could not see it at all**:
`help/REFERENCE.md` had no node section.

## 2. The tier split

Design 108's rule is *nothing is written at two tiers*. Applied to a form field:

- **Tier 1, generated.** Which kinds exist, which fields each form has, each field's label,
  its control type, and whether it is backed by a generated parameter. Read out of the form
  itself — the `<template>` the editor clones, or the editor's own exported field spec.
- **Tier 1 also supplies ~20 descriptions for free.** `RECORD_PARAM_TEMPLATES` already
  describes the record fields that become generated params, and those descriptions read
  correctly as field help: *"Current market value of this property."* is the same sentence
  either way. A topic may not restate one — the gate fails on it.
- **Tier 2, `help/nodes/<kind>.md`.** The remaining ~145 field descriptions, plus a
  per-kind overview of what the node models and when to reach for one.

**All help prose moved into `help/`.** The 54 `title=` strings in `index.html`, the 16 in
`security-editor.js`'s `FIELD_SPECS`, and the 13 `hint`s in `PAYROLL_ELECTION_META` were
cut and pasted into topics, and `src/` now carries no field documentation. That was the
user's call and it is the right one: prose in a registry is prose nothing reviews, and the
headless surface is generated from `help/`, so text that never reaches it may as well not
exist.

Four of the payroll hints carried a clause the record param description lacked — the FICA
point, the match-formula supersession, the statutory limits the scenario cap does not
replace, the pre-sacrifice SG base. Those were merged **into the param descriptions**, not
duplicated into a topic. A param description is tier 1 and lives in code by design.

## 3. Tier 1 — `collectNodes()`

`NODE_EDITORS` (`src/visualization/configuration/node-editor-registry.js`) maps each kind
to its label and to where its fields come from: `templates` (ids in `index.html`, including
the per-subtype config sub-editors) or `specs` (a module export, with an `idPrefix` where
the rendered `data-id` differs from the field name, as the payroll section's `pe_` does).

**The registry is load-bearing UI, not documentation.** `ConfigurationListComponent` lost
its private `KIND_LABELS` and renders its kind dropdown from this instead. A registry the
panel renders from cannot drift the way design 108 §2.1's three tables did — a kind removed
from it vanishes from the app, which is not a change anyone ships by accident.

`collectNodes()` emits one entry per kind with `{ field, label, inputType, domId, param,
description, describedBy }` per control, where `describedBy` is `param`, `topic`, or `null`.
`null` is not papered over with a placeholder: it is the state the gate fails on.

Two editors needed work to be legible to it. `security-editor.js` exports its `FIELD_SPECS`
(plus the hand-rendered id row) as `SECURITY_FORM_FIELDS`. `bequest-editor.js` built its
seven decedent fields with bare `_field()` calls carrying no `data-id` at all, so nothing
could see them and nothing could decorate them; its `render()` now loops a declared
`BEQUEST_FORM_FIELDS`, which is the shape `security-editor.js` already had.

## 4. The gate

`kind: node` topics carry a `node:` naming the kind, an overview, and a `## Fields` section
of one markdown list item per control. Budgets: **250 words for the overview**, **80 words
per field entry**, and no whole-file cap — real-property legitimately runs 42 entries, and a
file budget would be a budget on how many controls an editor may have.

Structural failures, all fatal under `--enforce node` (now in `npm test`):

| failure | why it is fatal |
|---|---|
| a kind in `NODE_EDITORS` with no topic | the §2.1 failure, one level down |
| a control on the form that neither tier describes | the undocumented box — 144 of 164 were in this state |
| a `## Fields` entry for a field the form does not have | a page about a control nobody can see |
| an entry for a field a record param already describes | the second copy, which is the one that drifts |
| an over-budget overview or field entry | over budget is usually tier 1 restated |

Coverage is computed from the **topic**, not only from the index's `describedBy`. The index
is built from the topics so the two agree in a normal run, but a check that trusted a
possibly-stale index would report a field as undocumented the moment someone wrote its entry
without rebuilding — which trains people to ignore the gate.

**`node:<kind>` stamps hash the FORM**: the label plus every field and its control type. So
adding a field to a template, renaming one, or swapping a checkbox for a select fails the
gate on that kind — at the moment its topic became wrong, and the only moment anyone is
looking. Rewording a description does not move it; prose is the topic's own business.

## 5. Delivery

The prose reaches the user three ways, all from the one generated index:

- **`help/REFERENCE.md`** gains a Node types section — every kind, every field, its control,
  which tier describes it, and the description. `npm run help -- --kind nodes` searches it,
  and a field hit prints the whole form, because "what does Cost Basis mean" is never the
  last question.
- **Hover.** `decorateNodeFields()` sets each control's `title` from the index.
- **`?`.** The same affordance the Parameters panel puts beside a param label, publishing
  `HELP_OPEN {node, field}`; the Help panel gains a field view and a kind view.

Wired **once**, in `workbench-app.js`'s shared `editorFactory`, which the modal and the
Nodes→Edit pane both use — so it covers every kind and cannot be forgotten by the next
editor added. It is not awaited: the modal wants its editor back synchronously, and the
tooltips land a tick later. The index is a gitignored build artifact and jsdom has no
`fetch`, so an absent index decorates nothing rather than throwing — an edit form that threw
because its documentation was missing would be a far worse bug than an undocumented one.

`help-index-source.js` holds the one cached copy, shared by the panel and the decorator,
because they render the same words and two fetches could disagree mid-session.

## 6. Decisions

**D1 — Field prose lives in `help/`, not in `src/`.** (The user's call, against an earlier
proposal to put it in a code registry.) The headless surface is generated from `help/`, and
prose in a registry is prose nothing reviews. The generator reads the topic; the app reads
the generator's output. `src/` keeps only the field *inventory*, which is code.

**D2 — All eleven kinds, including the four graph primitives.** Event, handler, action and
reducer are engine plumbing, but they are openable from the Nodes panel and had zero help.
Exempting them would have let the gate call the surface covered with 22 silent controls in it.

**D3 — The kind registry is the panel's own.** Not a documentation table beside it. See §3.

**D4 — Row tables are out of scope.** The Account editor's holdings and loan rows, the bond
ladder builder, the bequest asset rows and the payroll split/tier editors are repeating
collections, not node fields; a row's columns want column help, which is a different
affordance. Named here so the next reader sees a decision and not an oversight.

## 7. Test plan

| test | asserts |
|---|---|
| `help-index.test.mjs` HELP-19…22 | every `NODE_EDITORS` kind is in the index with its form; the inventory is parsed from markup, buttons and sub-editor mounts excluded; a param-described field takes that description and the topic does not also carry it; **no field on any form is undescribed** |
| `check-help.test.mjs` | each of the five structural failures fires; the node stamp moves on a field added, a control retyped — and not on a reworded description |
| `node-field-help.test.mjs` (viz) | every described field on a real RealProperty form gets the description as its `title`, character for character; the `?` publishes `{node, field}`; decorating twice does not stack; a missing index degrades to an undecorated form; the panel's field and kind views render and link both ways |
| `npm test` | runs the gate with `--enforce panel,concept,node` |

## 8. Still open

- **Row/column help** (D4). The obvious follow-on, and a different affordance.
- **`visibleWhen` for fields.** Tier 1 records which template a field came from but not the
  condition under which its section is shown, so REFERENCE.md lists a loan's fields beside a
  brokerage's with nothing saying they are never on screen together. The editors hide those
  sections in JS, so there is no declaration to read — it would have to be authored, which
  is a second copy, or the show/hide rules would have to become declarative first.
