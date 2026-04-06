from hf_anchor_bot.runner import TradeDedupeKey, trades_new_since_prev
from hf_anchor_bot.types import TradePrint


def test_flow_dedupe_keeps_distinct_trades_same_price_side_size():
    """Regression: keys must include t_ms so two prints are not merged incorrectly."""
    prev: set[TradeDedupeKey] = set()
    raw = [
        TradePrint(1_000, "BUY", 1.0, 0.5),
        TradePrint(2_000, "BUY", 1.0, 0.5),
    ]
    new1, keys1 = trades_new_since_prev(prev, raw, lookback=10)
    assert len(new1) == 2
    new2, _keys2 = trades_new_since_prev(keys1, raw, lookback=10)
    assert new2 == []
