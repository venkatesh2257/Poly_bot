"""Window PnL limp gate must not allow entries when window metadata is missing."""

from __future__ import annotations

from hf_anchor_bot.config import BotConfig
from hf_anchor_bot.state_machine import AnchorFlowStateMachine
from hf_anchor_bot.types import BookSnapshot, UnifiedTick


def test_window_pnl_limp_blocks_when_window_start_missing() -> None:
    cfg = BotConfig(enable_window_pnl_limp=True)
    fsm = AnchorFlowStateMachine(cfg)
    book = BookSnapshot(0, 99_000.0, 99_001.0, bid_size_top=1.0, ask_size_top=1.0)
    tick = UnifiedTick(
        seq=1,
        book=book,
        anchor_price=99_000.5,
        now_unix=1_700_000_000.0,
        window_start_unix=None,
    )
    assert fsm._window_pnl_allows_entry(tick) is False


def test_window_pnl_limp_disabled_allows_without_window() -> None:
    cfg = BotConfig(enable_window_pnl_limp=False)
    fsm = AnchorFlowStateMachine(cfg)
    book = BookSnapshot(0, 99_000.0, 99_001.0, bid_size_top=1.0, ask_size_top=1.0)
    tick = UnifiedTick(
        seq=1,
        book=book,
        anchor_price=99_000.5,
        now_unix=1_700_000_000.0,
        window_start_unix=None,
    )
    assert fsm._window_pnl_allows_entry(tick) is True
