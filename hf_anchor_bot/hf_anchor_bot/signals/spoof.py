from __future__ import annotations

from collections import deque

from hf_anchor_bot.types import BookSnapshot


def _median(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else 0.5 * (s[m - 1] + s[m])


def spoof_vanish_detected(
    prev: BookSnapshot | None,
    cur: BookSnapshot,
    bid_med: deque[float],
    ask_med: deque[float],
    mult: float,
) -> bool:
    """
    Heuristic: prior tick had a huge top-of-book size vs rolling median,
    and the next tick that side collapses without trade evidence (we only see book).
    """
    if prev is None or mult <= 0:
        return False
    bid_m = _median(list(bid_med))
    ask_m = _median(list(ask_med))
    if bid_m <= 0 or ask_m <= 0:
        return False
    huge_bid = prev.bid_size_top >= mult * bid_m
    huge_ask = prev.ask_size_top >= mult * ask_m
    bid_vanish = huge_bid and cur.bid_size_top < prev.bid_size_top * 0.35
    ask_vanish = huge_ask and cur.ask_size_top < prev.ask_size_top * 0.35
    return bid_vanish or ask_vanish
