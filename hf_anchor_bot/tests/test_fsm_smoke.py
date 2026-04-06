"""Offline FSM smoke: synthetic ticks, no network."""

from hf_anchor_bot.config import BotConfig
from hf_anchor_bot.state_machine import AnchorFlowStateMachine
from hf_anchor_bot.types import BookSnapshot, Direction, TradePrint, UnifiedTick


def _book(mid: float, bias_bid: bool) -> BookSnapshot:
    half = mid * 0.0001
    bb = mid - half
    ba = mid + half
    if bias_bid:
        return BookSnapshot(0, bb, ba, bid_size_top=80.0, ask_size_top=20.0)
    return BookSnapshot(0, bb, ba, bid_size_top=20.0, ask_size_top=80.0)


def test_idle_to_in_trade_long_path():
    cfg = BotConfig(
        imbalance_persist_updates=2,
        anchor_deviation_frac=0.0001,
        imbalance_ratio_threshold=0.55,
        continuation_min_push_frac=0.00001,
        continuation_lookback_updates=5,
        min_net_flow_bias=0.1,
        cooldown_updates=2,
        follow_through_max_updates=99,
        max_trade_duration_updates=999,
        enable_time_to_close_gate=False,
        enable_liquidity_gate=False,
        enable_slippage_gate=False,
        enable_window_pnl_limp=False,
    )
    fsm = AnchorFlowStateMachine(cfg)
    anchor = 100_000.0
    flows = (TradePrint(0, "BUY", 10.0, 100.0), TradePrint(0, "BUY", 5.0, 100.0))

    def tick(mid: float, bias_bid: bool, seq: int) -> None:
        b = _book(mid, bias_bid)
        fsm.process(UnifiedTick(seq=seq, book=b, anchor_price=anchor, trades_since_last=flows))

    # Below anchor — no edge
    tick(99_990.0, True, 1)
    assert fsm.state.value == "IDLE"
    # Above anchor, bid-heavy x2 → SETUP
    tick(100_020.0, True, 2)
    tick(100_025.0, True, 3)
    assert fsm.state.value == "SETUP"
    # Continuation + flow
    tick(100_080.0, True, 4)
    assert fsm.state.value == "IN_TRADE"
    assert fsm.position is not None
    assert fsm.position.side == Direction.LONG


def test_cooldown_after_close():
    cfg = BotConfig(
        imbalance_persist_updates=1,
        anchor_deviation_frac=0.00001,
        continuation_min_push_frac=0.00001,
        continuation_lookback_updates=3,
        min_net_flow_bias=0.05,
        follow_through_max_updates=1,
        cooldown_updates=2,
        max_trade_duration_updates=999,
        enable_time_to_close_gate=False,
        enable_liquidity_gate=False,
        enable_slippage_gate=False,
        enable_window_pnl_limp=False,
    )
    fsm = AnchorFlowStateMachine(cfg)
    anchor = 50_000.0
    flows = (TradePrint(0, "BUY", 10.0, 50.0),)

    b = _book(50_030.0, True)
    fsm.process(UnifiedTick(1, b, anchor, flows))
    fsm.process(UnifiedTick(2, _book(50_040.0, True), anchor, flows))
    assert fsm.state.value == "IN_TRADE"
    # No follow-through
    fsm.process(UnifiedTick(3, _book(50_040.0, True), anchor, ()))
    assert fsm.state.value == "COOLDOWN"
    fsm.process(UnifiedTick(4, _book(50_040.0, True), anchor, ()))
    assert fsm.cooldown_left == 1


def test_time_to_close_gate_fails_closed_without_timing_metadata():
    """When the gate is on, missing now/window metadata must not allow entries."""
    cfg = BotConfig(enable_time_to_close_gate=True)
    fsm = AnchorFlowStateMachine(cfg)
    b = _book(100_000.0, True)
    tick = UnifiedTick(
        seq=1,
        book=b,
        anchor_price=100_000.0,
        trades_since_last=(),
        now_unix=None,
        window_start_unix=None,
    )
    assert fsm._time_to_close_ok(tick) is False
