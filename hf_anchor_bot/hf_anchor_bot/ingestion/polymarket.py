"""Polymarket CLOB REST: order book + recent trades for one outcome token."""

from __future__ import annotations

import os
from typing import Any

import httpx

from hf_anchor_bot.types import BookSnapshot, TradePrint

CLOB_HOST = os.environ.get("POLYMARKET_CLOB_HOST", "https://clob.polymarket.com").rstrip("/")
DATA_HOST = os.environ.get("POLYMARKET_DATA_HOST", "https://data-api.polymarket.com").rstrip("/")


class PolymarketClobIngestion:
    def __init__(self, token_id: str, client: httpx.Client | None = None):
        self.token_id = token_id
        self._client = client or httpx.Client(timeout=15.0)

    def fetch_book(self) -> BookSnapshot:
        snap, _b, _a = self.fetch_book_with_depth()
        return snap

    def fetch_book_with_depth(self) -> tuple[BookSnapshot, tuple[tuple[float, float], ...], tuple[tuple[float, float], ...]]:
        """Snapshot plus bid/ask levels (bids desc, asks asc by price) for liquidity + slippage."""
        r = self._client.get(f"{CLOB_HOST}/book", params={"token_id": self.token_id})
        r.raise_for_status()
        data: dict[str, Any] = r.json()
        bids_raw = data.get("bids") or []
        asks_raw = data.get("asks") or []
        if not bids_raw or not asks_raw:
            raise ValueError("Empty book")
        by_bid: dict[float, float] = {}
        for x in bids_raw:
            p, s = float(x["price"]), float(x["size"])
            by_bid[p] = by_bid.get(p, 0.0) + s
        by_ask: dict[float, float] = {}
        for x in asks_raw:
            p, s = float(x["price"]), float(x["size"])
            by_ask[p] = by_ask.get(p, 0.0) + s
        bids_levels = tuple(sorted(((p, sz) for p, sz in by_bid.items()), key=lambda t: t[0], reverse=True))
        asks_levels = tuple(sorted(((p, sz) for p, sz in by_ask.items()), key=lambda t: t[0]))
        bb = bids_levels[0][0]
        ba = asks_levels[0][0]
        bid_sz = bids_levels[0][1]
        ask_sz = asks_levels[0][1]
        t_ms = int(data.get("timestamp", 0)) or _now_ms()
        snap = BookSnapshot(
            t_ms=t_ms,
            best_bid=bb,
            best_ask=ba,
            bid_size_top=bid_sz,
            ask_size_top=ask_sz,
        )
        return snap, bids_levels, asks_levels

    def fetch_trades_slice(self, limit: int = 50) -> list[TradePrint]:
        """Recent executed trades for this outcome token (Data API; CLOB shape may differ)."""
        for params in (
            {"token_id": self.token_id, "limit": limit},
            {"asset_id": self.token_id, "limit": limit},
        ):
            r = self._client.get(f"{DATA_HOST}/trades", params=params)
            if r.status_code != 200:
                continue
            raw = r.json()
            if isinstance(raw, list) and raw:
                parsed = _parse_trade_rows(raw)
                if parsed:
                    return parsed
        return []

    def close(self) -> None:
        self._client.close()


def _parse_trade_rows(raw: list[Any]) -> list[TradePrint]:
    out: list[TradePrint] = []
    for row in raw:
        try:
            side = str(row.get("side", row.get("taker_side", ""))).upper()
            if side not in ("BUY", "SELL"):
                continue
            tr = row.get("timestamp", row.get("match_time"))
            t_ms = _coerce_ts_ms(tr)
            out.append(
                TradePrint(
                    t_ms=t_ms,
                    side=side,  # type: ignore[arg-type]
                    size=float(row.get("size", 0)),
                    price=float(row.get("price", 0)),
                )
            )
        except (TypeError, ValueError, KeyError):
            continue
    return out


def _coerce_ts_ms(tr: Any) -> int:
    if tr is None:
        return _now_ms()
    try:
        tf = float(tr)
    except (TypeError, ValueError):
        return _now_ms()
    if tf > 1e12:
        return int(tf)
    return int(tf * 1000)


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)
