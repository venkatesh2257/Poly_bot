from __future__ import annotations

from collections import deque

from hf_anchor_bot.types import BookSnapshot


def imbalance_sign(book: BookSnapshot, ratio_threshold: float) -> int:
    """+1 bid-heavy, -1 ask-heavy, 0 neutral (no RSI/MACD — size only)."""
    tot = book.bid_size_top + book.ask_size_top
    if tot <= 0:
        return 0
    share = book.bid_size_top / tot
    if share >= ratio_threshold:
        return 1
    if share <= (1.0 - ratio_threshold):
        return -1
    return 0


def persistent_direction(signs: deque[int], n: int, direction: int) -> bool:
    """Last n snapshots all have same non-zero imbalance sign matching `direction` (+1 / -1)."""
    if len(signs) < n or direction == 0:
        return False
    tail = list(signs)[-n:]
    return all(s == direction for s in tail if s != 0) and all(s != 0 for s in tail)
