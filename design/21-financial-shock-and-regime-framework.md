# Financial Shock & Economic Regime Framework

## Purpose

Provide a generic mechanism for introducing financial crises, recessions, inflation shocks, interest rate shocks, and other macroeconomic disruptions into a simulation.

Rather than directly manipulating account balances, a shock should alter the economic environment and allow existing simulation systems to react naturally.

---

# Design Philosophy

A financial crash is not a state change.

A financial crash is a generator of state changes.

The simulation should continue to operate through the standard:

```text
Event → Handler → Action → Reducer
```

pipeline.

Economic shocks should inject new events and modify economic regimes that influence future simulation behavior.

---

# Core Concepts

## Financial Shock

Represents a high-level economic event.

Examples:

* Market Crash
* Recession
* Inflation Shock
* Credit Crisis
* Stagflation
* War
* Pandemic
* Custom Scenario

Example:

```typescript
FinancialShock {
    startDate: Date
    duration: Duration

    severity: number

    marketEffects
    interestRateEffects
    inflationEffects
    employmentEffects
    creditEffects

    recoveryProfile
}
```

---

# Economic Regime

A regime represents a persistent modification to simulation behavior.

Rather than modifying account values directly, handlers throughout the system consult active regimes when calculating outcomes.

Example:

```typescript
EconomicRegime {
    id: string

    returnAdjustment: number
    volatilityMultiplier: number

    inflationAdjustment: number

    interestRateAdjustment: number

    creditTightness: number

    startDate: Date
    endDate?: Date
}
```

---

# Regime Stack

The simulation should support multiple simultaneous regimes.

Example:

```typescript
SimulationState {
    activeRegimes: EconomicRegime[]
}
```

Examples:

```text
Normal Market

+ Financial Crisis

+ Inflation Shock

+ War
```

All active regimes contribute to simulation outcomes.

Example:

```typescript
expectedReturn =
    baseReturn
    + sum(regime.returnAdjustment)
```

```typescript
volatility =
    baseVolatility
    * product(regime.volatilityMultiplier)
```

This allows multiple economic forces to coexist.

---

# Event Architecture

## EconomicShockEvent

Represents the beginning of a shock.

Example:

```typescript
EconomicShockEvent {
    shockId
    shockDefinition
}
```

---

## EconomicRecoveryEvent

Represents a scheduled recovery step.

Example:

```typescript
EconomicRecoveryEvent {
    shockId
    recoveryPercent
}
```

---

## Specialized Events

Possible future events:

```text
MarketCrashEvent

InflationShockEvent

InterestRateShockEvent

CreditFreezeEvent

EmploymentShockEvent

RecoveryEvent
```

---

# Event → Handler → Action → Reducer Flow

## Shock Introduction

### Event

```text
EconomicShockEvent
```

### Handler

```text
EconomicShockHandler
```

### Actions Produced

```text
AddEconomicRegimeAction

RevalueAssetAction

ScheduleRecoveryAction

ScheduleSecondaryShockAction
```

### Reducers

```text
Add regime to active regime stack

Adjust asset values

Schedule future recovery events
```

---

# Two Categories of Effects

## 1. Level Effects

Immediate balance sheet changes.

Examples:

* Stock market falls 40%
* Housing values fall 20%
* Bond prices fall 15%

These happen immediately.

### Event

```text
MarketCrashEvent
```

### Handler

```text
MarketCrashHandler
```

### Actions

```text
RevalueAssetAction
```

### Reducer

```typescript
asset.marketValue *= 0.60
```

---

## 2. Flow Effects

Changes to future simulation behavior.

Examples:

* Higher inflation
* Lower expected returns
* Increased volatility
* Higher unemployment risk
* Reduced credit availability

### Event

```text
EconomicShockEvent
```

### Handler

```text
EconomicShockHandler
```

### Actions

```text
AddEconomicRegimeAction
```

### Reducer

```typescript
activeRegimes.push(regime)
```

Future events automatically operate under modified conditions.

---

# Account Impact Model

## Asset Exposure

Accounts should expose allocation information.

Example:

```typescript
AssetAllocation {
    equities: number
    bonds: number
    cash: number
    realEstate: number
    alternatives: number
}
```

This allows shocks to affect only relevant assets.

Example:

```text
Equity Shock
```

Only affects:

```text
Equities
REITs
Stock Funds
ETFs
```

---

# Cost Basis Tracking

Required for realistic downturn modeling.

Store:

```typescript
Holding {
    marketValue
    costBasis

    unrealizedGainLoss
}
```

Supports:

* Tax-loss harvesting
* Forced liquidation analysis
* Recovery analysis
* Sequence-of-return risk

---

# Recovery Framework

Recovery should be modeled separately from the initial shock.

Possible recovery profiles:

## V-Shaped

Fast recovery.

```text
Drop
Recover Quickly
```

---

## U-Shaped

Extended flat period before recovery.

```text
Drop
Stagnate
Recover
```

---

## W-Shaped

Double recession.

```text
Drop
Recover
Drop Again
Recover
```

---

## L-Shaped

Long-term stagnation.

```text
Drop
Remain Depressed
```

---

# System-Wide Effects

## Equity Markets

Parameters:

```typescript
equityDropPercent

expectedReturnAdjustment

volatilityMultiplier
```

---

## Interest Rates

Parameters:

```typescript
interestRateAdjustment

recoveryCurve
```

Affects:

* Mortgages
* Bonds
* Savings Accounts
* Credit Cards
* HELOCs

---

## Bond Markets

Parameters:

```typescript
bondPriceAdjustment

durationSensitivity
```

Long-duration bonds may experience larger losses.

---

## Inflation

Parameters:

```typescript
inflationAdjustment

inflationDuration
```

Affects:

* Expenses
* Wage Growth
* Purchasing Power
* Retirement Sustainability

---

## Real Estate

Parameters:

```typescript
housingAdjustment

rentAdjustment
```

Affects:

* Property Values
* Rental Income
* Housing Expenses

---

## Employment

Parameters:

```typescript
layoffProbability

salaryReduction

unemploymentDuration
```

Primarily affects accumulation-phase households.

---

## Credit Markets

Parameters:

```typescript
creditTightness

loanApprovalReduction

mortgageSpreadAdjustment
```

Affects:

* New Loans
* Refinancing
* Business Lending

---

# Correlation Regimes

One of the most important advanced features.

During crises, asset correlations often increase.

Example:

```text
Normal:

Stocks/Bonds Correlation = 0.20
```

```text
Crisis:

Stocks/Bonds Correlation = 0.85
```

Regime property:

```typescript
correlationMultiplier
```

This creates more realistic diversification behavior during stress periods.

---

# Sequence of Return Risk

A primary benefit of the regime framework.

Example:

```text
Retired Investor

Portfolio: $2,000,000

Withdrawal: $80,000
```

Market:

```text
-40%
```

Portfolio value permanently impaired due to withdrawals occurring during downturn.

No special modeling is required.

Existing withdrawal logic naturally produces the outcome once asset values and future returns are altered by the shock framework.

---

# Example Timeline

## Shock

```text
09/15/2008

EconomicShockEvent
```

Handler generates:

```text
AddEconomicRegimeAction

RevalueAssetAction

ScheduleRecoveryAction
```

Reducer:

```text
Apply market decline

Activate crisis regime
```

---

## Future Events

Annual return events continue executing.

Handlers now calculate returns using active regimes.

Example:

```typescript
actualReturn =
    baseReturn
    + regime.returnAdjustment
```

No crash-specific logic is required in the return system.

The return system simply responds to the current economic environment.

---

# Initial Implementation Recommendation

Phase 1:

* EconomicShockEvent
* EconomicRegime
* Active Regime Stack
* RevalueAssetAction
* Recovery Scheduling

Phase 2:

* Interest Rate Regimes
* Inflation Regimes
* Credit Market Regimes
* Employment Regimes

Phase 3:

* Correlation Regimes
* Behavioral Regimes
* Panic Selling Models
* Monte Carlo Stress Scenarios

This provides a flexible framework capable of modeling anything from a short recession to a multi-decade depression while remaining fully compatible with the existing Event → Handler → Action → Reducer architecture.