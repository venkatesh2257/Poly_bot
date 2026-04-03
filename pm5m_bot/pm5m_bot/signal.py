"""Align high-probability outcome with BTC/ETH spot trend (Coinbase candles)."""

from __future__ import annotations

import logging
import statistics
from dataclasses import dataclass
from typing import Dict, Literal, Optional

import httpx

from pm5m_bot.config import Settings
from pm5m_bot.market_scanner import MarketCandidate
from pm5m_bot.retry_util import http_retry

logger = logging.getLogger(__name__)

PRODUCT = {"BTC": "BTC-USD", "ETH": "ETH-USD"}


@dataclass(frozen=True)
class TradeIntent:
    candidate: MarketCandidate
    token_id: str
    outcome_label: str
    limit_price: float
    combined_trend: float
    rationale: str


@dataclass
class TrendSnapshot:
    r_5m: float
    r_15m: float
    combined: float


class SpotTrendFetcher:
    def __init__(self, settings: Settings) -> None:
        self._s = settings
        self._client = httpx.Client(timeout=20.0, headers={"User-Agent": "pm5m-bot/0.1"})

    def close(self) -> None:
        self._client.close()

    @http_retry
    def _candles(self, product_id: str, granularity_sec: int = 300) -> list[list[float]]:
        url = f"{self._s.coinbase_candles_base}/products/{product_id}/candles"
        r = self._client.get(url, params={"granularity": granularity_sec})
        r.raise_for_status()
        raw = r.json()
        if not isinstance(raw, list) or not raw:
            return []
        # Each row: [time, low, high, open, close, volume]
        return [list(row) for row in raw]

    def trend_for_asset(self, asset: Literal["BTC", "ETH"]) -> TrendSnapshot:
        pid = PRODUCT[asset]
        bars = self._candles(pid, 300)
        if len(bars) < 4:
            return TrendSnapshot(0.0, 0.0, 0.0)
        bars.sort(key=lambda x: x[0])
        c = [float(b[4]) for b in bars]
        r5 = (c[-1] - c[-2]) / c[-2] if c[-2] else 0.0
        r15 = (c[-1] - c[-4]) / c[-4] if c[-4] else 0.0
        comb = statistics.mean([r5, r15])
        return TrendSnapshot(r_5m=r5, r_15m=r15, combined=comb)


def _norm_label(s: str) -> str:
    return s.strip().upper()


def _is_up_like(lab: str) -> bool:
    return lab in ("YES", "UP", "Y") or "UP" in lab


def _is_down_like(lab: str) -> bool:
    return lab in ("NO", "DOWN", "N") or "DOWN" in lab


def evaluate(settings: Settings, cand: MarketCandidate, trends: Dict[str, TrendSnapshot]) -> Optional[TradeIntent]:
    """
    Probability threshold: already enforced in scanner (best outcome >= PM5M_PROB_THRESHOLD).
    Trend: mean of 5m and 15m log returns on Coinbase 5m candles (close-to-close).
    Trade only if high-probability outcome matches direction (Up-like + risk-on / Down-like + risk-off).
    """
    ts = trends.get(cand.asset)
    if not ts:
        return None
    deadband = 5e-5
    hi = cand.best_yes_like
    lab = _norm_label(hi.label)
    comb = ts.combined
    bullish = comb > deadband
    bearish = comb < -deadband

    if _is_up_like(lab) and bullish:
        rationale = f"Up-like @{hi.price:.4f} aligned with spot comb={comb:.5f} (5m={ts.r_5m:.5f} 15m={ts.r_15m:.5f})"
    elif _is_down_like(lab) and bearish:
        rationale = f"Down-like @{hi.price:.4f} aligned with spot comb={comb:.5f} (5m={ts.r_5m:.5f} 15m={ts.r_15m:.5f})"
    else:
        logger.debug("no align %s lab=%s comb=%.6f", cand.slug, lab, comb)
        return None

    cap = min(hi.price + 0.02, 0.99)
    return TradeIntent(
        candidate=cand,
        token_id=hi.token_id,
        outcome_label=hi.label,
        limit_price=cap,
        combined_trend=comb,
        rationale=rationale,
    )
