from __future__ import annotations

from hf_anchor_bot.types import Direction, TradePrint


def net_flow_bias(trades: tuple[TradePrint, ...]) -> float:
    """[-1, 1] buy vs sell size; 0 if no prints."""
    b = sum(t.size for t in trades if t.side == "BUY")
    s = sum(t.size for t in trades if t.side == "SELL")
    tot = b + s
    if tot <= 1e-12:
        return 0.0
    return (b - s) / tot


def flow_supports_direction(side: Direction, trades: tuple[TradePrint, ...], min_bias: float) -> bool:
    bias = net_flow_bias(trades)
    if side == Direction.LONG:
        return bias >= min_bias
    return bias <= -min_bias
