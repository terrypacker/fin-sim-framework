# Financial Simulator Framework (fin-sim-framework)
This framework provides an event driven framework to simulate financial workflows

## Architecture

### Simulation
The core simulation framework with snapshot, rollback ffwd and rewind of state machine and flows.

### EventBus 
Subscribe to some or all events.

### Handlers
Handle specific event types

### Reducers
Reduce operations with chaining result processing by type.  Allows priorities.


## Testing

Tests live in `tests/` and use the Node.js built-in `node:test` runner — no npm, no external dependencies. Test files use the `.mjs` extension to enable ES6 modules without a `package.json`.

### First-time setup (once per machine / after a Homebrew icu4c upgrade)

```sh
make setup
```

This installs or repairs Node.js via nvm (if present) or Homebrew. The required Node version is pinned in `.nvmrc` (currently `22`).

### Running tests

```sh
make test
```

Or directly:

```sh
node --test tests/simulation.test.mjs
```
