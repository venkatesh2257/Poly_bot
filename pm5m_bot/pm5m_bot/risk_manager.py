"""USDC risk budget per trade; optional size boost for high-conviction BTC."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List, Tuple

from pm5m_bot.config import Settings
from pm5m_bot.market_scanner import MarketCandidate
from pm5m_bot.signal import TradeIntent

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SizedOrder:
    usdc_notional: float
    size_shares: float
    risk_fraction: float
    boosted: bool


def _liquidity_quartile_threshold(candidates: List[MarketCandidate]) -> float:
    if not candidates:
        return 0.0
    xs = sorted(c.liquidity_usd for c in candidates)
    return xs[max(0, int(0.75 * (len(xs) - 1)))]


def size_position(
    settings: Settings,
    intent: TradeIntent,
    account_usdc: float,
    scanner_pool: List[MarketCandidate],
) -> SizedOrder:
    """
    Base risk: random between risk_pct_low and risk_pct_high of account (use midpoint).
    Boost 2–3× if prob >= boost threshold, asset BTC, liquidity in top quartile of current pool.
    Shares ≈ usdc / limit_price (conditional token units).
    """
    base_pct = (settings.risk_pct_low + settings.risk_pct_high) / 2.0
    risk_frac = base_pct
    boosted = False
    q_thr = _liquidity_quartile_threshold(scanner_pool)
    hi_p = intent.candidate.best_yes_like.price
    if (
        hi_p >= settings.prob_boost_threshold
        and intent.candidate.asset == "BTC"
        and intent.candidate.liquidity_usd >= q_thr
    ):
        import random

        mult = random.uniform(settings.size_boost_mult_min, settings.size_boost_mult_max)
        risk_frac = min(base_pct * mult, 0.03)
        boosted = True
    usdc = max(0.0, account_usdc * risk_frac)
    px = max(intent.limit_price, 1e-6)
    shares = usdc / px
    logger.info(
        "risk: account=%.2f frac=%.4f%s usdc=%.4f shares≈%.6f px=%.4f",
        account_usdc,
        risk_frac,
        " BOOST" if boosted else "",
        usdc,
        shares,
        intent.limit_price,
    )
    return SizedOrder(
        usdc_notional=usdc,
        size_shares=shares,
        risk_fraction=risk_frac,
        boosted=boosted,
    )
