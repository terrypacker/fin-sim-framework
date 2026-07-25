#!/usr/bin/env python3
"""
Convert FinSim JSON configuration to Bolden-compatible JSON format.

This script reads the FinSim scenarios file and converts it to a format
compatible with the Bolden (formerly NewRetirement) financial planning platform.
"""

import json
import sys
from datetime import datetime
from typing import Any, Dict, List, Optional


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
    """Convert FinSim account type/role to Bolden accountType and category."""
    type_mapping = {
        "401k": {"accountType": "taxAdvantaged", "category": "401k"},
        "ira": {"accountType": "taxAdvantaged", "category": "ira"},
        "roth": {"accountType": "taxAdvantaged", "category": "roth"},
        "brokerage": {"accountType": "afterTax", "category": "brokerage"},
        "savings": {"accountType": "afterTax", "category": "savings"},
        "checking": {"accountType": "afterTax", "category": "checking"},
        "super": {"accountType": "taxAdvantaged", "category": "superannuation"},
        "offset": {"accountType": "housingOther", "category": "offsetAccount"},
    }
    
    if finsim_type in type_mapping:
        return type_mapping[finsim_type]
    
    # Default mapping based on role
    role_mapping = {
        "us-stock": {"accountType": "afterTax", "category": "brokerage"},
        "ira": {"accountType": "taxAdvantaged", "category": "ira"},
        "roth-ira": {"accountType": "taxAdvantaged", "category": "roth"},
        "k401": {"accountType": "taxAdvantaged", "category": "401k"},
        "au-savings": {"accountType": "afterTax", "category": "savings"},
        "us-savings": {"accountType": "afterTax", "category": "savings"},
        "super": {"accountType": "taxAdvantaged", "category": "superannuation"},
        "au-offset": {"accountType": "housingOther", "category": "offsetAccount"},
    }
    
    return role_mapping.get(finsim_role, {"accountType": "afterTax", "category": "other"})


def convert_holding_to_rate(holdings: List[Dict]) -> Dict[str, float]:
    """Extract rate assumptions from holdings."""
    rates = {
        "meanRate": 0.05,
        "optimisticRate": 0.07,
        "pessimisticRate": 0.03
    }
    
    if not holdings:
        return rates
    
    # Try to infer rates from holdings
    for holding in holdings:
        allocation = holding.get("allocation", "")
        dividend_yield = holding.get("dividendYield")
        coupon_rate = holding.get("couponRate")
        
        if allocation == "EQUITY" and dividend_yield is not None:
            # Equity with dividend yield - assume moderate growth
            rates["meanRate"] = 0.06
            rates["optimisticRate"] = 0.08
            rates["pessimisticRate"] = 0.04
        elif allocation == "BOND" and coupon_rate is not None:
            # Bond with coupon rate
            rates["meanRate"] = coupon_rate
            rates["optimisticRate"] = coupon_rate * 1.2
            rates["pessimisticRate"] = coupon_rate * 0.8
        elif allocation == "CASH":
            # Cash - low return
            rates["meanRate"] = 0.02
            rates["optimisticRate"] = 0.03
            rates["pessimisticRate"] = 0.01
    
    return rates


def convert_account(account: Dict, persons: List[Dict]) -> Dict[str, Any]:
    """Convert a FinSim account to Bolden format."""
    account_type_info = convert_account_type(
        account.get("type", ""),
        account.get("role", "")
    )
    
    # Determine owner
    owner_id = account.get("ownerId", "primary")
    owner_name = "primary"
    for person in persons:
        if person.get("id") == owner_id:
            owner_name = "primary" if owner_id == "primary" else "spouse"
            break
    
    # Get rate assumptions from holdings
    holdings = account.get("holdings", [])
    rates = convert_holding_to_rate(holdings)
    
    bolden_account = {
        "name": account.get("name", ""),
        "accountType": account_type_info["accountType"],
        "category": account_type_info["category"],
        "balance": account.get("balance", 0),
        "owner": owner_name,
        "linked": False,
        "manual": True,
        "meanRate": rates["meanRate"],
        "optimisticRate": rates["optimisticRate"],
        "pessimisticRate": rates["pessimisticRate"],
        "rateName": "custom",
        "rateCurve": [],
        "disableOptimalWithdraw": False,
    }
    
    # Add tax-advantaged specific fields
    if account_type_info["accountType"] == "taxAdvantaged":
        if account.get("contributionBasis") is not None:
            bolden_account["contributions"] = account.get("contributionBasis", 0)
        if account.get("earningsBasis") is not None:
            bolden_account["earnings"] = account.get("earningsBasis", 0)
    
    # Add housing-specific fields
    if account_type_info["accountType"] == "housingOther":
        if account.get("mortgageBalance"):
            bolden_account["mortgageBalance"] = account.get("mortgageBalance", 0)
        if account.get("monthlyMortgage"):
            bolden_account["mortgagePayment"] = account.get("monthlyMortgage", 0)
        if account.get("mortgageInterestRate"):
            bolden_account["mortgageRate"] = account.get("mortgageInterestRate", 0)
    
    return bolden_account


def convert_real_property(property: Dict) -> Dict[str, Any]:
    """Convert a FinSim real property to Bolden housing format."""
    is_primary = property.get("isPrimaryResidence", False)
    
    bolden_property = {
        "name": property.get("name", ""),
        "accountType": "primaryResidence" if is_primary else "housingOther",
        "balance": property.get("value", 0),
        "linked": False,
        "manual": True,
    }
    
    # Add mortgage details
    if property.get("mortgageBalance"):
        bolden_property["mortgageBalance"] = property.get("mortgageBalance", 0)
    if property.get("monthlyMortgage"):
        bolden_property["mortgagePayment"] = property.get("monthlyMortgage", 0)
    if property.get("mortgageInterestRate"):
        bolden_property["mortgageRate"] = property.get("mortgageInterestRate", 0)
    
    # Add appreciation rate
    if property.get("appreciationRate"):
        bolden_property["appreciationRate"] = property.get("appreciationRate", 0.04)
    
    return bolden_property


def convert_person_to_profile(person: Dict, spouse: Optional[Dict] = None) -> Dict[str, Any]:
    """Convert a FinSim person to Bolden user profile format."""
    profile = {
        "first_name": person.get("name", ""),
        "birth_date": parse_date(person.get("birthDate")),
        "gender": None,  # Not available in FinSim
    }
    
    # Add spouse information if this is the primary person
    if spouse:
        profile["spouse_first_name"] = spouse.get("name", "")
        profile["spouse_birth_date"] = parse_date(spouse.get("birthDate"))
    
    return profile


def convert_social_security(person: Dict) -> Dict[str, Any]:
    """Convert Social Security information."""
    return {
        "monthlyAmount": person.get("socialSecurityMonthly", 0),
        "currency": person.get("ssCurrency", "USD"),
        "claimingAge": 67,  # Default FRA
    }


def convert_retirement_settings(person: Dict) -> Dict[str, Any]:
    """Convert retirement settings."""
    return {
        "retirementDate": parse_date(person.get("retirementDate")),
        "lifeExpectancy": person.get("lifeExpectancy", 85),
    }


def convert_events_to_bolden(events: List[Dict]) -> Dict[str, Any]:
    """Convert FinSim events to Bolden settings."""
    bolden_settings = {
        "rateAssumptions": {
            "inflation": 0.025,
            "medicalInflation": 0.04,
            "socialSecurityCOLA": 0.025,
            "housingAppreciation": 0.04,
        },
        "taxSettings": {
            "filingStatus": "marriedFilingJointly",
            "state": "HI",  # From residencyState
        },
        "withdrawalStrategy": "spendingNeeds",  # Bolden default
    }
    
    # Look for specific event types
    for event in events:
        event_type = event.get("type", "")
        
        if event_type == "US_SAVINGS_INTEREST_MONTHLY":
            bolden_settings["rateAssumptions"]["savingsInterest"] = 0.02
        elif event_type == "TAX_SETTLE_US":
            bolden_settings["taxSettings"]["federalTaxSettlement"] = True
        elif event_type == "TAX_SETTLE_STATE":
            bolden_settings["taxSettings"]["stateTaxSettlement"] = True
    
    return bolden_settings


def convert_finsim_to_bolden(finsim_data: Dict) -> Dict[str, Any]:
    """Convert entire FinSim configuration to Bolden format."""
    scenarios = finsim_data.get("scenarios", [])
    if not scenarios:
        return {}
    
    scenario = scenarios[0]  # Take first scenario
    
    # Get persons
    persons = scenario.get("persons", [])
    primary = next((p for p in persons if p.get("id") == "primary"), None)
    spouse = next((p for p in persons if p.get("id") == "spouse"), None)
    
    # Convert user profile
    user_profile = convert_person_to_profile(primary, spouse) if primary else {}
    
    # Add additional profile attributes
    if primary:
        user_profile["user_data_attributes"] = {
            "ZipCode": primary.get("residencyState", ""),
            "LifeExpectancy": str(primary.get("lifeExpectancy", 85)),
            "RetirementDate": parse_date(primary.get("retirementDate")),
            "SpouseLifeExpectancy": str(spouse.get("lifeExpectancy", 85)) if spouse else "85",
            "SpouseRetirementDate": parse_date(spouse.get("retirementDate")) if spouse else None,
        }
    
    # Convert accounts
    accounts = []
    for account in scenario.get("accounts", []):
        # Skip inherited accounts (they're handled via bequests)
        if account.get("inherited"):
            continue
        accounts.append(convert_account(account, persons))
    
    # Convert real properties
    real_estate = []
    for prop in scenario.get("realProperties", []):
        if not prop.get("inherited"):  # Skip inherited properties
            real_estate.append(convert_real_property(prop))
    
    # Convert events to settings
    events = scenario.get("events", [])
    settings = convert_events_to_bolden(events)
    
    # Add Social Security info
    if primary:
        settings["socialSecurity"] = convert_social_security(primary)
        settings["retirement"] = convert_retirement_settings(primary)
    
    # Build final Bolden structure
    bolden_config = {
        "userProfile": user_profile,
        "accounts": accounts,
        "realEstate": real_estate,
        "debts": [],  # Not directly mapped from FinSim
        "income": {
            "workIncome": {
                "primary": primary.get("monthlyWage", 0) * 12 if primary else 0,
                "spouse": spouse.get("monthlyWage", 0) * 12 if spouse else 0,
            }
        },
        "expenses": {
            "monthlyExpenses": 5000,  # Placeholder - would need FinSim data
        },
        "settings": settings,
    }
    
    return bolden_config


def main():
    """Main conversion function.

    Usage: convert_to_bolden.py [input.json] [output.json]

    Paths are arguments rather than constants so the tool can convert any scenario
    export without editing the source. The defaults point at the conventional
    (gitignored) working location.
    """
    finsim_file = sys.argv[1] if len(sys.argv) > 1 else "scenarios/fin-sim-scenarios.json"
    output_file = sys.argv[2] if len(sys.argv) > 2 else "scenarios/bolden-config.json"

    with open(finsim_file, "r") as f:
        finsim_data = json.load(f)

    # Convert to Bolden format
    bolden_config = convert_finsim_to_bolden(finsim_data)

    with open(output_file, "w") as f:
        json.dump(bolden_config, f, indent=2)

    print(f"Conversion complete! Output written to {output_file}")
    print(f"Converted {len(bolden_config.get('accounts', []))} accounts")
    print(f"Converted {len(bolden_config.get('realEstate', []))} real estate properties")


if __name__ == "__main__":
    main()