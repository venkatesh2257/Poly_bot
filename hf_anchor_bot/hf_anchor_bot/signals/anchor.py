from __future__ import annotations

from hf_anchor_bot.config import BotConfig
from hf_anchor_bot.types import Direction


def anchor_deviation(mid: float, anchor: float) -> float:
    if anchor <= 0:
        return 0.0
    return abs(mid - anchor) / anchor


def directional_edge(mid: float, anchor: float, cfg: BotConfig) -> Direction | None:
    """Aligned direction vs anchor beyond threshold (no indicators)."""
    if anchor <= 0:
        return None
    if anchor_deviation(mid, anchor) < cfg.anchor_deviation_frac:
        return None
    if mid > anchor:
        return Direction.LONG
    if mid < anchor:
        return Direction.SHORT
    return None
