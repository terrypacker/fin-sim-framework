#!/usr/bin/env python3
"""
Convert FinSim JSON configuration to ProjectionLab-compatible JSON format.

This script reads the FinSim scenarios file and converts it to a format
compatible with the ProjectionLab financial planning platform.

ProjectionLab uses a Plugin API with the following structure:
- savingsAccounts: savings, checking accounts
- investmentAccounts: 401k, IRA, Roth, brokerage
- assets: real estate, vehicles, collectibles
- debts: loans, mortgages

Reference: https://projectionlab.com
"""

import json
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional
import uuid


def generate_id() -> str:
    """Generate a UUID for ProjectionLab accounts."""
    return str(uuid.uuid4())


def parse_date(date_str: Optional[str]) -> Optional[str]:
    """Parse ISO date string to YYYY-MM-DD format."""
    if not date_str:
        return None
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d")
    except (ValueError, AttributeError):
        return None


def convert_account_type(finsim_type: str, finsim_role: str) -> Dict[str, str]:
    """Convert FinSim account type/role to ProjectionLab account type."""
    type_mapping = {
        "401k": {
            "plType": "investmentAccount",
            "accountSubType": "401k",
            "taxType": "taxDeferred"
        },
        "ira": {
            "plType": "investmentAccount",
            "accountSubType": "traditionalIRA",
            "taxType": "taxDeferred"
        },
        "roth": {
            "plType": "investmentAccount",
            "accountSubType": "rothIRA",
            "taxType": "taxFree"
        },
        "brokerage": {
            "plType": "investmentAccount",
            "accountSubType": "taxableBrokerage",
            "taxType": "taxable"
        },
        "savings": {
            "plType": "savingsAccount",
            "accountSubType": "savings",
            "taxType": "taxable"
        },
        "checking": {
            "plType": "savingsAccount",
            "accountSubType": "checking",
            "taxType": "taxable"
        },
        "super": {
            "plType": "investmentAccount",
            "accountSubType": "superannuation",
            "taxType": "taxDeferred"
        },
        "offset": {
            "plType": "savingsAccount",
            "accountSubType": "offsetAccount",
            "taxType": "taxable"
        },
    }
    
    if finsim_type in type_mapping:
        return type_mapping[finsim_type]
    
    # Default mapping based on role
    role_mapping = {
        "us-stock": {
            "plType": "investmentAccount",
            "accountSubType": "taxableBrokerage",
            "taxType": "taxable"
        },
        "ira": {
            "plType": "investmentAccount",
            "accountSubType": "traditionalIRA",
            "taxType": "taxDeferred"
        },
        "roth-ira": {
            "plType": "investmentAccount",
            "accountSubType": "rothIRA",
            "taxType": "taxFree"
        },
        "k401": {
            "plType": "investmentAccount",
            "accountSubType": "401k",
            "taxType": "taxDeferred"
        },
        "au-savings": {
            "plType": "savingsAccount",
            "accountSubType": "savings",
            "taxType": "taxable"
        },
        "us-savings": {
            "plType": "savingsAccount",
            "accountSubType": "savings",
            "taxType": "taxable"
        },
        "super": {
            "plType": "investmentAccount",
            "accountSubType": "superannuation",
            "taxType": "taxDeferred"
        },
        "au-offset": {
            "plType": "savingsAccount",
            "accountSubType": "offsetAccount",
            "taxType": "taxable"
        },
    }
    
    return role_mapping.get(finsim_role, {
        "plType": "savingsAccount",
        "accountSubType": "other",
        "taxType": "taxable"
    })


def convert_allocation_to_stock_bond(holdings: List[Dict]) -> Dict[str, float]:
    """Convert FinSim holdings to ProjectionLab stock/bond allocation."""
    total_value = sum(h.get("marketValue", 0) for h in holdings)
    if total_value == 0:
        return {"stockAllocation": 0.7, "bondAllocation": 0.3}  # Default 70/30
    
    equity_value = sum(
        h.get("marketValue", 0) 
        for h in holdings 
        if h.get("allocation") == "EQUITY"
    )
    bond_value = sum(
        h.get("marketValue", 0) 
        for h in holdings 
        if h.get("allocation") == "BOND"
    )
    
    stock_pct = equity_value / total_value if total_value > 0 else 0.7
    bond_pct = bond_value / total_value if total_value > 0 else 0.3
    
    return {
        "stockAllocation": round(stock_pct, 2),
        "bondAllocation": round(bond_pct, 2)
    }


def convert_account(account: Dict, persons: List[Dict]) -> Dict[str, Any]:
    """Convert a FinSim account to ProjectionLab format."""
    account_type_info = convert_account_type(
        account.get("type", ""),
        account.get("role", "")
    )
    
    # Determine owner
    owner_id = account.get("ownerId", "primary")
    owner_name = "Primary"
    for person in persons:
        if person.get("id") == owner_id:
            owner_name = person.get("name", "Primary")
            break
    
    # Get allocation from holdings
    holdings = account.get("holdings", [])
    allocation = convert_allocation_to_stock_bond(holdings)
    
    # Build ProjectionLab account
    pl_account = {
        "id": account.get("id", generate_id()),
        "name": account.get("name", ""),
        "balance": account.get("balance", 0),
        "owner": owner_name,
        "accountSubType": account_type_info["accountSubType"],
        "taxType": account_type_info["taxType"],
        "stockAllocation": allocation["stockAllocation"],
        "bondAllocation": allocation["bondAllocation"],
    }
    
    # Add tax-advantaged specific fields
    if account_type_info["taxType"] == "taxDeferred":
        if account.get("contributionBasis") is not None:
            pl_account["costBasis"] = account.get("contributionBasis", 0)
        if account.get("earningsBasis") is not None:
            pl_account["earningsBasis"] = account.get("earningsBasis", 0)
    
    return pl_account, account_type_info["plType"]


def convert_real_property(property: Dict) -> Dict[str, Any]:
    """Convert a FinSim real property to ProjectionLab asset format."""
    is_primary = property.get("isPrimaryResidence", False)
    
    pl_asset = {
        "id": property.get("id", generate_id()),
        "name": property.get("name", ""),
        "balance": property.get("value", 0),
        "appreciationRate": property.get("appreciationRate", 0.04),
        "isPrimaryResidence": is_primary,
    }
    
    # Add mortgage details if present
    if property.get("mortgageBalance"):
        pl_asset["mortgageBalance"] = property.get("mortgageBalance", 0)
        pl_asset["monthlyPayment"] = property.get("monthlyMortgage", 0)
        pl_asset["interestRate"] = property.get("mortgageInterestRate", 0)
    
    return pl_asset


def convert_collectible(collectible: Dict) -> Dict[str, Any]:
    """Convert a FinSim collectible to ProjectionLab asset format."""
    return {
        "id": collectible.get("id", generate_id()),
        "name": collectible.get("name", ""),
        "balance": collectible.get("value", 0),
        "appreciationRate": collectible.get("appreciationRate", 0.03),
        "assetType": "collectible",
    }


def convert_person_to_profile(person: Dict, spouse: Optional[Dict] = None) -> Dict[str, Any]:
    """Convert a FinSim person to ProjectionLab profile format."""
    profile = {
        "name": person.get("name", ""),
        "birthDate": parse_date(person.get("birthDate")),
        "retirementDate": parse_date(person.get("retirementDate")),
        "lifeExpectancy": person.get("lifeExpectancy", 85),
        "socialSecurityMonthly": person.get("socialSecurityMonthly", 0),
    }
    
    # Add spouse information if this is the primary person
    if spouse:
        profile["spouse"] = {
            "name": spouse.get("name", ""),
            "birthDate": parse_date(spouse.get("birthDate")),
            "retirementDate": parse_date(spouse.get("retirementDate")),
            "lifeExpectancy": spouse.get("lifeExpectancy", 85),
            "socialSecurityMonthly": spouse.get("socialSecurityMonthly", 0),
        }
    
    return profile


def convert_income(primary: Dict, spouse: Optional[Dict] = None) -> List[Dict[str, Any]]:
    """Convert income information to ProjectionLab format."""
    income_streams = []
    
    # Primary income
    if primary and primary.get("monthlyWage"):
        income_streams.append({
            "id": generate_id(),
            "name": f"{primary.get('name', 'Primary')} W2 Income",
            "type": "w2Income",
            "amount": primary.get("monthlyWage", 0) * 12,
            "frequency": "annual",
            "owner": primary.get("name", "Primary"),
            "startYear": 2026,  # Current year
            "endYear": 2027 if primary.get("retirementDate") else 2070,
            "growthRate": 0.03,  # Default 3% annual growth
        })
    
    # Spouse income
    if spouse and spouse.get("monthlyWage"):
        income_streams.append({
            "id": generate_id(),
            "name": f"{spouse.get('name', 'Spouse')} W2 Income",
            "type": "w2Income",
            "amount": spouse.get("monthlyWage", 0) * 12,
            "frequency": "annual",
            "owner": spouse.get("name", "Spouse"),
            "startYear": 2026,
            "endYear": 2027 if spouse.get("retirementDate") else 2070,
            "growthRate": 0.03,
        })
    
    # Social Security for primary
    if primary and primary.get("socialSecurityMonthly"):
        income_streams.append({
            "id": generate_id(),
            "name": f"{primary.get('name', 'Primary')} Social Security",
            "type": "socialSecurity",
            "amount": primary.get("socialSecurityMonthly", 0) * 12,
            "frequency": "annual",
            "owner": primary.get("name", "Primary"),
            "startYear": 2044,  # Age 66 (assuming 1978 birth)
            "endYear": 2070,
            "claimingAge": 66,
        })
    
    # Social Security for spouse
    if spouse and spouse.get("socialSecurityMonthly"):
        income_streams.append({
            "id": generate_id(),
            "name": f"{spouse.get('name', 'Spouse')} Social Security",
            "type": "socialSecurity",
            "amount": spouse.get("socialSecurityMonthly", 0) * 12,
            "frequency": "annual",
            "owner": spouse.get("name", "Spouse"),
            "startYear": 2049,  # Age 66 (assuming 1983 birth)
            "endYear": 2070,
            "claimingAge": 66,
        })
    
    return income_streams


def convert_expenses() -> List[Dict[str, Any]]:
    """Create placeholder expenses for ProjectionLab."""
    return [
        {
            "id": generate_id(),
            "name": "Monthly Living Expenses",
            "type": "recurringExpense",
            "amount": 12000,  # Placeholder - would need actual data
            "frequency": "monthly",
            "startYear": 2026,
            "endYear": 2070,
            "inflationAdjusted": True,
        }
    ]


def convert_finsim_to_projectionlab(finsim_data: Dict) -> Dict[str, Any]:
    """Convert entire FinSim configuration to ProjectionLab format."""
    scenarios = finsim_data.get("scenarios", [])
    if not scenarios:
        return {}
    
    scenario = scenarios[0]  # Take first scenario
    
    # Get persons
    persons = scenario.get("persons", [])
    primary = next((p for p in persons if p.get("id") == "primary"), None)
    spouse = next((p for p in persons if p.get("id") == "spouse"), None)
    
    # Convert user profile
    profile = convert_person_to_profile(primary, spouse) if primary else {}
    
    # Convert accounts - separate by type
    savings_accounts = []
    investment_accounts = []
    assets = []
    
    for account in scenario.get("accounts", []):
        # Skip inherited accounts (they're handled via bequests)
        if account.get("inherited"):
            continue
        
        pl_account, pl_type = convert_account(account, persons)
        
        if pl_type == "savingsAccount":
            savings_accounts.append(pl_account)
        elif pl_type == "investmentAccount":
            investment_accounts.append(pl_account)
    
    # Convert real properties to assets
    for prop in scenario.get("realProperties", []):
        if not prop.get("inherited"):
            assets.append(convert_real_property(prop))
    
    # Convert collectibles to assets
    for collectible in scenario.get("collectibles", []):
        assets.append(convert_collectible(collectible))
    
    # Convert income
    income = convert_income(primary, spouse)
    
    # Convert expenses
    expenses = convert_expenses()
    
    # Build ProjectionLab structure
    projectionlab_config = {
        "profile": profile,
        "currentFinances": {
            "savingsAccounts": savings_accounts,
            "investmentAccounts": investment_accounts,
            "assets": assets,
            "debts": [],  # Would need FinSim debt data
        },
        "plan": {
            "income": income,
            "expenses": expenses,
            "milestones": [
                {
                    "id": generate_id(),
                    "name": "Financial Independence",
                    "type": "customMilestone",
                    "date": "2027-01-01",  # Early retirement
                },
                {
                    "id": generate_id(),
                    "name": "Traditional Retirement",
                    "type": "retirementMilestone",
                    "date": "2044-04-15",  # Age 66
                }
            ],
        },
        "settings": {
            "currency": "USD",
            "country": "US",
            "taxSettings": {
                "filingStatus": "marriedFilingJointly",
                "state": primary.get("residencyState", "CA") if primary else "CA",
            },
            "inflationRate": 0.025,
            "stockGrowthRate": 0.07,
            "bondGrowthRate": 0.03,
        },
    }
    
    return projectionlab_config


def main():
    """Main conversion function.

    Usage: convert_to_projectionlab.py [input.json] [output.json]

    Paths are arguments rather than constants so the tool can convert any scenario
    export without editing the source. The defaults point at the conventional
    (gitignored) working location.
    """
    finsim_file = sys.argv[1] if len(sys.argv) > 1 else "scenarios/fin-sim-scenarios.json"
    output_file = sys.argv[2] if len(sys.argv) > 2 else "scenarios/projectionlab-config.json"

    with open(finsim_file, "r") as f:
        finsim_data = json.load(f)

    # Convert to ProjectionLab format
    projectionlab_config = convert_finsim_to_projectionlab(finsim_data)

    with open(output_file, "w") as f:
        json.dump(projectionlab_config, f, indent=2)

    print(f"Conversion complete! Output written to {output_file}")
    
    # Count accounts
    current = projectionlab_config.get("currentFinances", {})
    print(f"Converted {len(current.get('savingsAccounts', []))} savings accounts")
    print(f"Converted {len(current.get('investmentAccounts', []))} investment accounts")
    print(f"Converted {len(current.get('assets', []))} assets")
    print(f"Converted {len(projectionlab_config.get('plan', {}).get('income', []))} income streams")


if __name__ == "__main__":
    main()