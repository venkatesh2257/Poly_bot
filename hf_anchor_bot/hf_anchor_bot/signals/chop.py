from __future__ import annotations

from collections import deque


def _flip_ratio(signs: deque[int], window: int) -> float:
    if len(signs) < 2:
        return 0.0
    seq = list(signs)[-window:]
    flips = 0
    pairs = 0
    for i in range(1, len(seq)):
        a, b = seq[i - 1], seq[i]
        if a == 0 or b == 0:
            continue
        pairs += 1
        if a != b:
            flips += 1
    if pairs == 0:
        return 0.0
    return flips / pairs


def chop_block_new_entries(
    imbalance_signs: deque[int],
    max_flip_ratio: float,
    window: int,
) -> bool:
    """Frequent book-side flips => do not start new setups."""
    return _flip_ratio(imbalance_signs, window) > max_flip_ratio


def update_consolidation(mids: deque[float], anchor: float, window: int, range_frac: float) -> bool:
    """True if market is ranging (tight mid range vs anchor)."""
    if anchor <= 0 or len(mids) < window:
        return False
    chunk = list(mids)[-window:]
    lo, hi = min(chunk), max(chunk)
    span = (hi - lo) / anchor
    return span < range_frac
