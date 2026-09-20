Use the README.md file in the root of this project to understand the architecture and coding styles of the application.

Use `help/REFERENCE.md` for the complete parameter, panel, node-type (every edit-form
field), journal-action, CLI-tool, state-field, topic and design-doc surface. It is generated from the code by
`npm run help:build`, so it is exact and never stale — read it instead of grepping `src/`
to find a parameter, a tool or the design doc that argues for a mechanic.
Narrow searches: `npm run help -- --find <text> [--kind params|panels|nodes|actions|tools|state|topics|design]`;
a param, panel or node hit also names the `help/` topic that explains it.
Never hand-edit it; change the `description` in the toolset and regenerate.

Hand-written explanations live in `help/*.md` as stamped topics (design 108 §5-6). If you
edit a param description or a file a topic stamps, `npm run help:gate` names the topic that
now claims something stale — read it, fix it if it is wrong, then
`npm run help:restamp -- <topic-id>`. Start a new topic from `npm run help:gate -- --template
<panel|concept|workflow|node>`; never restate a param description in one, because tier 1
already emits it exactly and the gate fails on a 12-word shared run. A `kind: node` topic
(design 111) owns the prose for every control on an edit form: add a field to a template
and the gate names it, and its `node:<kind>` stamp moves whenever the form does — so
`npm run help:restamp -- <kind>` after any field change.
