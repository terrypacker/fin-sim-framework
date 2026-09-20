---
id: company
kind: node
title: Company Equity
node: company
panels: [config-list, config-graph]
design: [49-company-sale-asset.md, 72-company-equity-sale-fixes.md, 88-speculative-assets.md]
sources: [src/finance/assets/company-equity.js]
stamps:
  panel:config-list: 786f94
  panel:config-graph: bbebb1
  node:company: 9c4add
  src/finance/assets/company-equity.js: 3b5bc0
---

A stake in a private company: founder shares, an early-employee holding, an LLC
interest. It grows at its own rate and converts to cash in one dated liquidity
event — the exit — which is exactly how a private holding behaves and exactly what
a market holding does not.

Use it rather than a brokerage position whenever the stake has no market. A
[Security](security.md) position can be sold in part, at any time, to fund spending,
and takes a market return draw each tick. This cannot be sold before its year, cannot
be sold in part, and appreciates deterministically. Modelling illiquid equity as a
brokerage balance is the single most flattering mistake available in this app: it
makes the portfolio look like it can absorb a shock it cannot.

The honest way to model an exit that might not happen is the **speculative** flag,
which keeps the asset in the run while keeping it out of net worth until it converts.

Sale taxes the gain over the cost basis in the country you place the stake in, at the
owner's rate, and the net proceeds land in the destination account. Refinements the
real thing has — QSBS, options and strike mechanics, staged liquidity, escrow — are
not modelled; see design 49 for what is and is not claimed.

## Fields

- `name` — What the stake is called, in the Nodes list and in every net-worth breakdown. Free text.
- `country` — Which country's capital-gains rules tax the exit, and the default currency that follows. Not where the company is incorporated in any legal sense — it is the tax regime the gain is assessed under.
- `currency` — The currency the value and basis are stated in. Defaults from the country. Proceeds are converted on the sale date when the destination account is in another currency.
- `value` — Current market value of the stake, in its own currency: the number you would put on it today, not the exit you are hoping for. It grows from here at the appreciation rate.
- `costBasis` — What the stake cost — the acquisition price, or the strike paid to exercise. The taxable gain at exit is the sale value less this, so a basis left at 0 taxes the whole exit as gain.
- `appreciationRate` — Annual growth as a decimal, compounded (the default, 0.08, is an equity-like 8%). Deterministic: a private stake takes no return draw, so it grows identically in every run of a Monte Carlo batch, and a plan that depends on it is not being stress-tested by one.
- `plannedSaleYear` — The calendar year of the liquidity event. Blank means the stake is never sold, so it appreciates forever and contributes only to net worth. There is no partial exit: the whole stake converts in that year.
- `saleDestinationAccount` — Which account receives the net proceeds. Blank sends them to the country's cash pool, where the spending rule can consume them; naming a brokerage account instead is how an exit is reinvested rather than spent.
- `ownershipType` — Sole or joint, which decides how the gain is split between people. It matters most when the two have different marginal rates or different residencies at the exit.
- `ownerId` — The person holding the stake when ownership is sole. Their residency and rate at the sale year is what the gain is taxed at.
- `speculative` — Simulate this stake but do not count it as yours. It still appreciates, still sells in its sale year and still pays the tax — but until it converts it is worth zero in net worth and in everything downstream of net worth. This is the honest setting for an exit that may never come, and it is disclosed separately as "incl. speculative" rather than hidden. Incompatible with a drawdown priority.
