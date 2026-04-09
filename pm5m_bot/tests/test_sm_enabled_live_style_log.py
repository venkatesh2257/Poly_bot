"""SM_ENABLED=true + dry_run: execute_entry logs DRY_RUN enter (not SM skip)."""

from __future__ import annotations

from datetime import datetime, timezone

from pm5m_bot.config import Settings
from pm5m_bot.market_scanner import MarketCandidate, OutcomeQuote
from pm5m_bot.risk_manager import SizedOrder
from pm5m_bot.signal import TradeIntent
from pm5m_bot.trader import Trader


class _FakeGamma:
    def fetch_book_json(self, token_id: str) -> dict:
        return {
            "bids": [{"price": "0.54", "size": "100"}],
            "asks": [{"price": "0.56", "size": "100"}],
        }


def _minimal_candidate() -> MarketCandidate:
    o0 = OutcomeQuote(0, "Up", "tok_up", 0.55)
    o1 = OutcomeQuote(1, "Down", "tok_dn", 0.45)
    return MarketCandidate(
        condition_id="c",
        slug="btc-updown-5m-1",
        asset="BTC",
        question="q",
        end_date=datetime.now(timezone.utc),
        seconds_remaining=120.0,
        liquidity_usd=1000.0,
        outcomes=(o0, o1),
        best_yes_like=o0,
        spread_estimate=0.05,
    )


def test_sm_enabled_dry_run_logs_dry_run_enter_not_sm_skip(caplog):
    import logging

    caplog.set_level(logging.INFO)
    s = Settings()
    s.sm_enabled = True
    s.dry_run = True
    intent = TradeIntent(
        candidate=_minimal_candidate(),
        token_id="tok_up",
        outcome_label="Up",
        limit_price=0.55,
        combined_trend=0.01,
        rationale="test",
    )
    sized = SizedOrder(usdc_notional=1.0, size_shares=2.0, risk_fraction=0.01, boosted=False)
    t = Trader(s, _FakeGamma())
    pos = t.execute_entry(intent, sized)
    assert pos is not None
    joined = " ".join(r.message for r in caplog.records)
    assert "DRY_RUN enter" in joined
    assert "SM_ENABLED=false" not in joined
