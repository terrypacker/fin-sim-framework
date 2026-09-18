Use the README.md file in the root of this project to understand the architecture and coding styles of the application.

Use `help/REFERENCE.md` for the complete parameter, panel, journal-action, CLI-tool and
state-field surface. It is generated from the code by `npm run help:build`, so it is exact
and never stale — read it instead of grepping `src/` to find a parameter or a tool.
Narrow searches: `npm run help -- --find <text> [--kind params|panels|actions|tools|state]`.
Never hand-edit it; change the `description` in the toolset and regenerate.
