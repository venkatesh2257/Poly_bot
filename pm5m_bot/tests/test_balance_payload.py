"""CLOB balance-allowance parsing for live USDC sizing."""

from pm5m_bot.trader import _collateral_usdc_from_balance_payload


def test_parses_micro_usdc_balance() -> None:
    assert _collateral_usdc_from_balance_payload({"balance": "150000000"}) == 150.0


def test_parses_small_decimal_as_usdc() -> None:
    assert _collateral_usdc_from_balance_payload({"balance": "50.0"}) == 50.0
