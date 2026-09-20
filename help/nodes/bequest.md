---
id: bequest
kind: node
title: Inheritance
node: bequest
panels: [config-list, config-graph]
design: [63-inheritance.md]
sources: [src/finance/assets/bequest.js]
stamps:
  panel:config-list: 786f94
  panel:config-graph: bbebb1
  node:bequest: 0deb91
  src/finance/assets/bequest.js: dd3ee6
---

An inheritance, modelled as a container: a decedent, an heir, a year, and the assets
that arrive. Until the inheritance year it is **inert** — nothing appears in net
worth, nothing earns, nothing is taxed. In that year its assets are funded at fair
market value and, for the kinds that have a first-class record, promoted into real
accounts, properties and collectibles that behave like any other from then on.

That promotion is why the editor shows two lists. The rows you can edit are the ones
still inline; the read-only block below is what has already become a real record and
is now edited in its own panel, tuned by its own parameters.

Two things the year turns on. The **decedent's** relationship and state of death drive
inheritance tax, which in the modelled US states means Nebraska's class schedule —
there is no federal inheritance tax, and the estate tax is the decedent's, not the
heir's. The **heir** is who receives it, so their residency decides what the assets
are taxed as afterwards, and an AU-resident heir of a US retirement account is a
different plan from a US-resident one.

Basis is the part worth checking. A US heir takes a stepped-up basis at date of death;
Australia does not step up — the deceased's cost base carries over for a CGT asset,
which is why the asset rows carry a separate field for it.

## Fields

- `name` — What this inheritance is called in the Nodes list. Free text — naming it after the decedent is the usual choice, since the assets carry their own names.
- `decedentName` — Who died. Display only, but it is what the promoted assets are tagged with, so it is how you tell inherited records apart from the household's own.
- `relationship` — The heir's relationship to the decedent, as the Nebraska inheritance-tax classes define it: immediate (child, parent, sibling), remote (aunt, uncle, niece, nephew) or unrelated. Each class has its own exemption and rate, and the difference between them is large.
- `decedentState` — The US state the decedent was domiciled in — the situs that decides whether a state inheritance tax applies at all. Only Nebraska currently levies one in this model; the other states are selectable and inert, so choosing one is a statement about the plan, not a no-op you can skip.
- `heirId` — Which person in the household receives it. Their residency and marginal rate govern how the inherited assets are taxed from the inheritance year onward, which is usually a bigger number than the inheritance tax itself.
- `paidViaEstate` — Tick when an Australian super death benefit is paid to the estate rather than directly to the beneficiary. It avoids the additional 2% Medicare levy on the taxable component, which is the whole of the difference; the 15% (or 30%) tax on the taxable component paid to a non-dependant applies either way.
