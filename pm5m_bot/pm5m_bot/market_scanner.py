"""Discover and filter 5m BTC/ETH up/down markets."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, List, Optional

from pm5m_bot.config import Settings
from pm5m_bot.gamma_client import GammaClient

logger = logging.getLogger(__name__)

SLUG_RE = re.compile(r"^(btc|eth)-updown-5m-\d+$", re.I)


@dataclass(frozen=True)
class OutcomeQuote:
    index: int
    label: str
    token_id: str
    price: float


@dataclass
class MarketCandidate:
    condition_id: str
    slug: str
    asset: str  # BTC | ETH
    question: str
    end_date: datetime
    seconds_remaining: float
    liquidity_usd: float
    outcomes: tuple[OutcomeQuote, OutcomeQuote]
    best_yes_like: OutcomeQuote
    spread_estimate: float


def _parse_iso(dt: str | None) -> datetime | None:
    if not dt:
        return None
    try:
        if dt.endswith("Z"):
            dt = dt.replace("Z", "+00:00")
        return datetime.fromisoformat(dt)
    except ValueError:
        return None


def _liquidity_num(m: dict[str, Any]) -> float:
    for k in ("liquidityNum", "liquidity", "volumeNum", "volume"):
        v = m.get(k)
        if v is None:
            continue
        try:
            return float(v)
        except (TypeError, ValueError):
            continue
    return 0.0


def _parse_outcomes(m: dict[str, Any]) -> tuple[list[str], list[str], list[float]] | None:
    raw_o = m.get("outcomes")
    raw_p = m.get("outcomePrices")
    raw_t = m.get("clobTokenIds")
    if isinstance(raw_o, str):
        try:
            labels = json.loads(raw_o)
        except json.JSONDecodeError:
            return None
    elif isinstance(raw_o, list):
        labels = [str(x) for x in raw_o]
    else:
        return None
    if isinstance(raw_p, str):
        try:
            prices = [float(x) for x in json.loads(raw_p)]
        except (json.JSONDecodeError, ValueError, TypeError):
            return None
    elif isinstance(raw_p, list):
        prices = [float(x) for x in raw_p]
    else:
        return None
    if isinstance(raw_t, str):
        try:
            tids = [str(x) for x in json.loads(raw_t)]
        except json.JSONDecodeError:
            return None
    elif isinstance(raw_t, list):
        tids = [str(x) for x in raw_t]
    else:
        return None
    if len(labels) < 2 or len(prices) < 2 or len(tids) < 2:
        return None
    return labels, tids, prices


def _spread_from_book(book: dict[str, Any] | None) -> float | None:
    if not book:
        return None
    bids = book.get("bids") or []
    asks = book.get("asks") or []
    if not bids or not asks:
        return None

    def px(x: Any) -> float:
        return float(x.get("price", x))

    best_bid = max(px(b) for b in bids)
    best_ask = min(px(a) for a in asks)
    return max(0.0, best_ask - best_bid)


class MarketScanner:
    def __init__(self, settings: Settings, gamma: GammaClient) -> None:
        self._s = settings
        self._gamma = gamma

    def scan(self, max_pages: int = 8) -> List[MarketCandidate]:
        rows: List[dict[str, Any]] = []
        for p in range(max_pages):
            chunk = self._gamma.fetch_markets_page(limit=100, offset=p * 100, active=True)
            if not chunk:
                break
            rows.extend(chunk)
        candidates: List[MarketCandidate] = []
        now = datetime.now(timezone.utc)
        for m in rows:
            slug = str(m.get("slug") or "")
            if not SLUG_RE.match(slug):
                continue
            asset = slug.split("-")[0].upper()
            if asset not in ("BTC", "ETH"):
                continue
            end = _parse_iso(m.get("endDate") or m.get("endDateIso"))
            if end is None:
                continue
            if end.tzinfo is None:
                end = end.replace(tzinfo=timezone.utc)
            sec_left = (end - now).total_seconds()
            if sec_left < self._s.min_seconds_remaining or sec_left > self._s.max_seconds_remaining:
                continue
            parsed = _parse_outcomes(m)
            if not parsed:
                continue
            labels, tids, prices = parsed
            oq = [
                OutcomeQuote(i, labels[i], tids[i], prices[i])
                for i in range(min(2, len(labels), len(tids), len(prices)))
            ]
            if len(oq) < 2:
                continue
            hi = max(oq, key=lambda x: x.price)
            lo = min(oq, key=lambda x: x.price)
            if hi.price < self._s.prob_threshold:
                continue
            liq = _liquidity_num(m)
            if liq < self._s.min_liquidity_usd:
                continue
            book = self._gamma.fetch_book_json(hi.token_id)
            spr = _spread_from_book(book)
            if spr is not None and spr > self._s.max_spread:
                logger.debug("skip wide spread %s %.4f", slug, spr)
                continue
            spread_est = spr if spr is not None else abs(hi.price - lo.price)
            candidates.append(
                MarketCandidate(
                    condition_id=str(m.get("conditionId") or ""),
                    slug=slug,
                    asset=asset,
                    question=str(m.get("question") or slug),
                    end_date=end,
                    seconds_remaining=sec_left,
                    liquidity_usd=liq,
                    outcomes=(oq[0], oq[1]),
                    best_yes_like=hi,
                    spread_estimate=spread_est,
                )
            )
        if not candidates:
            return []
        liqu_sorted = sorted(c.liquidity_usd for c in candidates)
        q_idx = max(0, int(0.75 * (len(liqu_sorted) - 1)))
        q_thr = liqu_sorted[q_idx]
        return [c for c in candidates if c.liquidity_usd >= q_thr]
