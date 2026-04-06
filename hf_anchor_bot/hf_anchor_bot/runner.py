"""Poll loop: ingestion → unified tick → state machine → executor."""

from __future__ import annotations

import logging
import time
from typing import Callable

from hf_anchor_bot.config import BotConfig
from hf_anchor_bot.execution import DryRunExecutor, OrderExecutor
from hf_anchor_bot.ingestion.chainlink import ChainlinkAnchorFeed
from hf_anchor_bot.ingestion.polymarket import PolymarketClobIngestion
from hf_anchor_bot.state_machine import AnchorFlowStateMachine
from hf_anchor_bot.smoke_log import enabled as smoke_enabled, line as smoke_line, record as smoke_record
from hf_anchor_bot.types import JsEdgeContext, TradePrint, UnifiedTick

log = logging.getLogger(__name__)

TradeDedupeKey = tuple[int, str, float, float]


def _window_start(now: float, window_len: int) -> int:
    return int(now // window_len) * window_len


def trades_new_since_prev(
    prev_keys: set[TradeDedupeKey],
    raw_trades: list[TradePrint],
    lookback: int,
) -> tuple[list[TradePrint], set[TradeDedupeKey]]:
    """
    Flow dedupe: identity includes event time so distinct prints are not collapsed
    when price/side/size repeat.
    """
    keys: set[TradeDedupeKey] = set()
    out: list[TradePrint] = []
    for t in raw_trades[-lookback:]:
        k = (t.t_ms, t.side, t.price, t.size)
        keys.add(k)
        if k not in prev_keys:
            out.append(t)
    return out, keys


def run_loop(
    cfg: BotConfig,
    token_id: str,
    asset: str = "BTC",
    poll_interval_s: float = 0.5,
    executor: OrderExecutor | None = None,
    on_tick: Callable[[object, object], None] | None = None,
    js_edge_provider: Callable[[], JsEdgeContext | None] | None = None,
) -> None:
    anchor_feed: ChainlinkAnchorFeed | None = None
    book_ingest = PolymarketClobIngestion(token_id=token_id)
    fsm = AnchorFlowStateMachine(cfg, asset=asset)
    exec_ = executor or DryRunExecutor()
    seq = 0
    prev_trade_keys: set[TradeDedupeKey] = set()
    err_backoff_s = poll_interval_s
    max_err_backoff_s = 60.0

    try:
        while True:
            try:
                seq += 1
                now = time.time()
                snap, bids_levels, asks_levels = book_ingest.fetch_book_with_depth()
                if anchor_feed is None:
                    smoke_line("chainlink", "lazy ChainlinkAnchorFeed construct attempt asset=%s", asset)
                    anchor_feed = ChainlinkAnchorFeed(asset=asset)
                    smoke_line(
                        "chainlink",
                        "lazy ChainlinkAnchorFeed construct success feed=%s",
                        anchor_feed.feed_address[:14],
                    )
                    smoke_record("chainlinkFeedAddress", anchor_feed.feed_address)
                ap, _ = anchor_feed.read_anchor()
                raw_trades = book_ingest.fetch_trades_slice(limit=max(50, cfg.flow_lookback_trades))
                trades_since, prev_trade_keys = trades_new_since_prev(
                    prev_trade_keys,
                    raw_trades,
                    cfg.flow_lookback_trades,
                )

                w0 = _window_start(now, cfg.window_length_sec)
                js_edge = js_edge_provider() if js_edge_provider else None

                tick = UnifiedTick(
                    seq=seq,
                    book=snap,
                    anchor_price=ap,
                    trades_since_last=tuple(trades_since),
                    now_unix=now,
                    window_start_unix=w0,
                    bids_levels=bids_levels,
                    asks_levels=asks_levels,
                    js_edge=js_edge,
                )
                intents, snap_fsm = fsm.process(tick)
                if on_tick:
                    on_tick(snap_fsm, intents)
                for it in intents:
                    exec_.execute(it)
                err_backoff_s = poll_interval_s
            except KeyboardInterrupt:
                raise
            except Exception as e:
                if smoke_enabled():
                    log.warning(
                        "[smoke][chainlink] tick failed before next steady-state tick (will retry/backoff): %s",
                        e,
                    )
                log.exception("tick failed; retrying after %.1fs", err_backoff_s)
                time.sleep(err_backoff_s)
                err_backoff_s = min(max_err_backoff_s, max(poll_interval_s, err_backoff_s * 2.0))
                continue
            time.sleep(poll_interval_s)
    finally:
        book_ingest.close()


def run_replay_ticks(
    cfg: BotConfig,
    ticks: list[UnifiedTick],
    executor: OrderExecutor | None = None,
    asset: str = "BTC",
) -> list[tuple[object, list]]:
    fsm = AnchorFlowStateMachine(cfg, asset=asset)
    exec_ = executor or DryRunExecutor()
    out: list[tuple[object, list]] = []
    for tick in ticks:
        intents, snap = fsm.process(tick)
        out.append((snap, intents))
        for it in intents:
            exec_.execute(it)
    return out
