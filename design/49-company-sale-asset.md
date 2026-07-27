# 49 — Company Sale as a First-Class Sellable Asset (`CompanyEquity`)

**Status**: **Implemented.** All §10 checklist items landed. `evt-company-sale.test.mjs` (EVT-51, 9 tests) green; existing bare-event `evt-income` COMPANY_SALE tests unchanged (backward-compat requirement was dropped per product owner — nothing in the wild used the old shape — but the asset-aware handler/reducer preserve it anyway via fallbacks). Full unit suite (3092) + viz (831) pass; production build clean; default-scenario run and the config-list editor both browser-verified (stake seeds at \$500k, appreciates to \$856,912 by the 2033 sale year, credits US savings, records the capital gain, zeroes out). Mechanic + tax already existed (see §1); this design added the *asset* that drives them and wired it into the default scenario.

**Builds on**:
- The existing, already-correct `COMPANY_SALE` machinery in `src/finance/account-rules/us/us-income-classes.js` — `CompanySaleHandler` (`COMPANY_SALE` event) + `CompanySaleApplyReducer` (`COMPANY_SALE_APPLY` → chains `COMPANY_SALE_TAX`), both registered unconditionally by the `US_INCOME` toolset (`src/scenarios/toolsets/us-income-toolset.js`), which is already in the production scenario.
- The `COMPANY_SALE_TAX` per-action-type reducer in `src/finance/tax/us/us-tax-module-2026.js:298` — US long-term capital gain (`usCapitalGainsYTD`) plus AU CGT (`auCapitalGainsYTD` + `ftcYTD`) when AU-resident. **This is the tax pathway; it is complete and untouched by this design.**
- **`design/48-rental-income.md` is *not* the template** here — that mechanic augmented an existing node. The template for this design is the **`Collectible`**: `src/finance/assets/collectible.js`, `src/scenarios/toolsets/us-collectibles-toolset.js`, `src/finance/account-rules/us/us-collectible-classes.js`, `src/finance/services/collectible-service.js`, `src/visualization/assets/collectible-editor.js`. A company stake is structurally identical to a collectible (appreciating market-value asset, `plannedSaleYear`-driven one-off sale, capital gains on the gain) — **the only difference is the tax family, which already exists.**

**Author note**: The sale event, its APPLY reducer, and its capital-gains tax are all already built and tested (`evt-income.test.mjs`, EVT-51). What is missing is an *asset object* so the position (a) appears on the balance sheet / net worth **before** the sale, (b) is editable in the config UI, (c) fires its own `COMPANY_SALE` event at a planned sale year, and (d) appreciates until then. That is exactly what `US_COLLECTIBLES` does for collectibles. So this design is ~90% "clone the Collectible plumbing under a new `CompanyEquity` type" and ~10% "make the pre-existing `COMPANY_SALE` handler/reducer asset-aware (backward-compatibly)."

---

## 1. Problem

`COMPANY_SALE` today is **event-only income**: something must hand-schedule a `COMPANY_SALE` one-off with `data: { salePrice, costBasis }`, at which point the handler credits the US cash pool and the reducer chains the capital-gains tax. Nothing in the default scenario ever schedules it, there is no backing asset, so:

- A pre-sale equity stake is **invisible** — it contributes nothing to net worth until the day it converts to cash.
- There is **no edit UI** — a user can't set a sale year, cost basis, or growth rate.
- The sale price is a hard-coded event constant, not a value that grows over time.

**Goal:** a `CompanyEquity` asset that sits on the balance sheet, appreciates, and liquidates at a planned sale year through the existing `COMPANY_SALE` → `COMPANY_SALE_TAX` path.

---

## 2. Goals & Non-Goals

### Goals
- New `CompanyEquity` domain asset (`kind: 'company'`) modeled on `Collectible` (§3).
- Appreciates until sale via the **generic** `AssetAppreciationHandler` (`src/finance/handlers/asset-appreciation-handler.js`) — no new appreciation code.
- A new `US_COMPANY_SALE` toolset that seeds asset state, schedules the one-off `COMPANY_SALE` at `plannedSaleYear`, and adds the annual appreciation series (§5).
- Make the existing `CompanySaleHandler` / `CompanySaleApplyReducer` **asset-aware and backward-compatible** (§4): read appreciated sale price from state, zero the asset on sale, credit a chosen destination account — all falling back to today's behavior when the new fields are absent, so `evt-income` stays green.
- Counts toward net worth pre-sale via a `kind === 'company'` branch (§7).
- Full edit UI, serializer round-trip, and a default-scenario instance behind a `companySaleYear` param (§6, §8, §9).

### Non-Goals (deferred)
- **Installment / earn-out sales** (proceeds spread over years). v1 is a single lump-sum liquidation, like the collectible sale.
- **QSBS §1202 gain exclusion**, §1045 rollover, or ordinary-income recapture on a business sale. v1 taxes the full gain at the existing LTCG path. A `qsbsExclusionPct` field piggybacking `COMPANY_SALE_TAX` is a clean Phase 2.
- **Partial sale / secondary rounds.** One asset = one full-liquidation event.
- **Ownership-split attribution** across `owners[]` — v1 uses the primary `ownerId` like the collectible.
- **Dividend / distribution income** from the stake pre-sale. This asset only appreciates and sells.

---

## 3. Data model — `CompanyEquity`

`src/finance/assets/company-equity.js`, `CompanyEquity extends Asset` (`kind: 'company'`), a near-verbatim clone of `Collectible` (`collectible.js`). No methods; safe for `structuredClone`. Fields:

| Field | Default | Notes |
|---|---|---|
| `value` | `0` | Current market value of the stake. |
| `costBasis` | `0` | Original acquisition/strike cost; drives the gain. |
| `appreciationRate` | `0.08` | Annual growth (higher default than a collectible's 3.5% — equity). |
| `appreciationSchedule` | `null` | Optional step-wise schedule (design 28 §3), same as collectible. |
| `plannedSaleYear` | `null` | Calendar year of the liquidity event; drives the one-off. |
| `saleDestinationAccount` | `null` | State key for net proceeds; falls back to US cash pool. |
| `ownershipType` / `ownerId` / `owners` | `'sole'` / `null` / `[]` | Same ownership shape as Collectible. |
| `country` | `'US'` | Determines currency + which cash pool. v1 US only (tax path is US). |
| `currency` | `null` | Currency descriptor; default by country (design 10 §Phase 5). |
| `balanceAtResidencyChange` | `null` | Value snapshot on first residency change (parity with Collectible). |

`CompanyEquityService extends AssetService` (`src/finance/services/company-equity-service.js`) — clone of `CollectibleService`: `createCompanyEquity` / `updateCompanyEquity` / `deleteCompanyEquity`, `applyAppreciation`, `getPersonShare`, `recordResidencyChange`. `idPrefix` distinct from collectible's. Registered in `ServiceRegistry` alongside `collectibleService`.

---

## 4. Making `COMPANY_SALE` asset-aware (backward-compatible)

The pre-existing classes in `us-income-classes.js` currently ignore any asset. Two surgical, backward-compatible changes; the fallbacks reproduce today's behavior exactly so `evt-income.test.mjs` (which fires `COMPANY_SALE` with bare `data: { salePrice, costBasis }` and no `stateKey`) stays green.

**`CompanySaleHandler.call({ data, state })`** — mirror `CollectibleSaleHandler`:
- Resolve `destinationKey` from `data.saleDestinationAccount`, falling back to the default US cash pool.
- `salePrice = data.salePrice ?? state[data.stateKey]?.value ?? 0` — so an appreciated asset sells at its *current* value; a bare event still uses `data.salePrice`.
- Pass `stateKey: data.stateKey ?? null` and `destinationKey` through on the `COMPANY_SALE_APPLY` action; emit `RecordBalanceAction` on the resolved destination.

**`CompanySaleApplyReducer.reduce(state, action)`** — mirror `CollectibleSaleApplyReducer`:
- Credit `state[destinationKey]` (fallback default cash pool) with `salePrice` instead of hard-coding `usCash`.
- **Zero the asset**: if `action.stateKey` and `state[stateKey]` exist, set `{ ...entry, value: 0 }`.
- Unchanged: `gain = max(0, salePrice − costBasis)`, chain `COMPANY_SALE_TAX` with `{ gain, residency }`.

No tax change. `COMPANY_SALE_TAX` continues to flow through `us-tax-module-2026.js:298`.

---

## 5. `US_COMPANY_SALE` toolset

`src/scenarios/toolsets/us-company-sale-toolset.js` — clone of `us-collectibles-toolset.js`. `id: 'US_COMPANY_SALE'`, `capabilities: ['company-sale']`, `dependencies: ['US_TAX', 'US_INCOME']`.

- **Does NOT register the handler/reducer** — `US_INCOME` already registers `CompanySaleHandler` + `CompanySaleApplyReducer`. This toolset only contributes state + schedules + the appreciation handler.
- `types.actions`: `COMPANY_SALE_APPLY` is already declared by `US_INCOME`; nothing new needed here for the sale. Appreciation emits the shared `ASSET_APPRECIATE_APPLY` (already declared).
- `state(context)`: for each `context.companyEquities` with a `stateKey`, seed a plain `{ kind: 'company', stateKey, value, costBasis, appreciationRate, plannedSaleYear, ownershipType, ownerId, country, appreciationSchedule }` entry (mirror `_collectibleToStatePlain`).
- `schedules(context)`: a one-off `COMPANY_SALE` (`data: { costBasis, stateKey, saleDestinationAccount }`, dated `Date.UTC(plannedSaleYear, 0, 15)`) per equity with a `plannedSaleYear`; plus a **toolset-private** annual appreciate `EventSeries` (`type: 'COMPANY_EQUITY_APPRECIATE'`) when any equity appreciates — exactly how `US_COLLECTIBLES` uses `COLLECTIBLE_APPRECIATE` and `US_REAL_PROPERTY` uses `US_REAL_PROPERTY_APPRECIATE`.
- `handlers(context)`: an `AssetAppreciationHandler` projecting the appreciable equities (`stateKey`, `appreciationRate`, `appreciationSchedule`), with `handledEvents` bound to the `COMPANY_EQUITY_APPRECIATE` event resolved from `context.schedulesById`. **No appreciate reducer to register** — the shared `AssetAppreciateReducer` (reduces `ASSET_APPRECIATE_APPLY`) is registered *centrally by the compiler* (`scenario-compiler.js:195`), so it always exists. This toolset contributes **no `reducers()`** at all (the sale reducer belongs to `US_INCOME`).

**Compiler context**: add `companyEquities: services.companyEquityService?.getAll() ?? []` to the context bag in `src/scenarios/toolsets/scenario-compiler.js:170` (next to `collectibles`).

**Registration**: `ToolsetRegistry`, `IntlRetirementScenario.getToolsets()`, the scenario's `toolsetRegistry.register(...)` block (`intl-retirement-scenario.js:918` area), and `buildAndCompile()` (`:913` area).

---

## 6. Default-scenario instance + param

`intl-retirement-scenario.js` `buildDefaultConfig`, next to `collectibles` (`:858`):

```js
companyEquities: [
  { __type: 'CompanyEquity', name: 'Startup Equity', stateKey: 'companyEquityAccount',
    value: 500_000, costBasis: 50_000, appreciationRate: 0.08,
    ownershipType: 'sole', ownerId: 'primary', country: 'US',
    ...(p.companySaleYear != null ? { plannedSaleYear: p.companySaleYear } : {}) },
],
```

Add a `companySaleYear` typed param (group "Assets", like `usHouseSaleYear`) and a param→node cascade entry so edits propagate before compile (same mechanism the house/collectible sale years use — see the `cfg.realProperties[i].plannedSaleYear` cascade at `intl-retirement-scenario.js:944`/`:990`). The editor field is param-linked via `param-linked-field.js` exactly like the collectible's `plannedSaleYear` (`collectible-editor.js:99`).

---

## 7. Net worth

`src/finance/derived-metrics/net-worth.js:38` — add a branch alongside collectible:

```js
} else if (val.kind === 'company' && typeof val.value === 'number') {
  contribution = val.value;
}
```

---

## 8. Serialization

`src/scenarios/scenario-serializer.js` — add `_serializeCompanyEquity` / `_makeCompanyEquity` (clone of `_serializeCollectible` `:713` / `_makeCollectible` `:739`), thread `companyEquities` through `serialize` (`:394`), the two `deserializePersonsAccounts` paths (`:438`, `:466`, `:498`), and `createCompanyEquity` in the deserialize loop. `__type: 'CompanyEquity'` registered for round-trip.

---

## 9. UI

- `src/visualization/assets/company-equity-editor.js` — clone `collectible-editor.js`; fields: name, value, costBasis, country, currency, appreciationRate, plannedSaleYear (param-linked), ownershipType, ownerId, saleDestinationAccount. Template `tpl-company-equity-editor` (clone `tpl-collectible-editor` markup).
- Node renderer under `src/visualization/components/graph/rendering/` (clone `collectible-node-renderer.js`) + register in `node-renderer-registry.js`.
- `src/visualization/configuration/configuration-list.js` — add `company: 'Company Equity'` label + country accessor (`:17`, `:28` area) and mount the editor in the node-edit modal.
- `StateSchemaRegistry` — register `companyEquityAccount.value` / `.costBasis` as `currency('USD')` so chart/state-panel/timeline format correctly.

---

## 10. Implementation checklist

1. `src/finance/assets/company-equity.js` — `CompanyEquity` domain class (§3).
2. `src/finance/services/company-equity-service.js` — `CompanyEquityService` + register in `ServiceRegistry`.
3. `us-income-classes.js` — asset-aware `CompanySaleHandler` + `CompanySaleApplyReducer`, backward-compatible (§4).
4. `src/scenarios/toolsets/us-company-sale-toolset.js` — `US_COMPANY_SALE` (§5); verify `ASSET_APPRECIATE` ownership to avoid double-registration.
5. `scenario-compiler.js:170` — `companyEquities` context.
6. `net-worth.js:38` — `kind === 'company'` branch.
7. `intl-retirement-scenario.js` — default `companyEquities` entry, `companySaleYear` param + cascade, toolset registration in `getToolsets()` / scenario / `buildAndCompile()`.
8. `scenario-serializer.js` — serialize/deserialize `CompanyEquity` (§8).
9. UI: editor + template + node renderer + config-list + StateSchemaRegistry (§9).
10. `tests/unit/evt-company-sale.test.mjs` — asset-backed path (§11); keep `evt-income` COMPANY_SALE tests green.
11. `npm run build:index`; `npm test`; browser-verify the editor round-trip + a run showing the stake in net worth then converting to cash at the sale year.

---

## 11. Testing

`tests/unit/evt-company-sale.test.mjs` (EVT-51 asset-backed):
- Asset seeds into state (`kind: 'company'`, value pre-sale) and contributes to net worth.
- Appreciation grows `value` annually until the sale year.
- At `plannedSaleYear`, `COMPANY_SALE` fires: destination account credited with the **appreciated** sale price, asset zeroed, `COMPANY_SALE_TAX` accrues `usCapitalGainsYTD += (salePrice − costBasis)`.
- AU-resident variant: also accrues `auCapitalGainsYTD` + `ftcYTD`.
- `saleDestinationAccount` routing honored; falls back to US cash pool when unset.
- **Regression**: existing bare-event `COMPANY_SALE` tests in `evt-income.test.mjs` unchanged (no `stateKey` → default cash pool, `data.salePrice` used, no asset zeroed).
