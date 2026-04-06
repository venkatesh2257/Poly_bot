"""
Strict FSM: IDLE → SETUP → CONFIRMED → IN_TRADE → COOLDOWN.
Uses only anchor deviation + book imbalance + executed trade flow (no TA).
Production guards: time-to-close, liquidity, slippage, window PnL limp, soft/hard sizing.
"""

from __future__ import annotations

import logging
from collections import deque

from hf_anchor_bot.config import BotConfig
from hf_anchor_bot.execution import open_allowed_by_slippage
from hf_anchor_bot.smoke_log import line as smoke_line
from hf_anchor_bot.signals.anchor import anchor_deviation, directional_edge
from hf_anchor_bot.signals.chop import chop_block_new_entries, update_consolidation
from hf_anchor_bot.signals.flow import flow_supports_direction, net_flow_bias
from hf_anchor_bot.signals.imbalance import imbalance_sign
from hf_anchor_bot.signals.spoof import spoof_vanish_detected
from hf_anchor_bot.types import (
    BookSnapshot,
    BotStateName,
    Direction,
    ExecutionIntent,
    OpenPosition,
    StateMachineSnapshot,
    TradeType,
    UnifiedTick,
)

_VALID_STATES = frozenset(
    {
        BotStateName.IDLE,
        BotStateName.SETUP,
        BotStateName.CONFIRMED,
        BotStateName.IN_TRADE,
        BotStateName.COOLDOWN,
    }
)

log = logging.getLogger("hf_anchor_bot.state_machine")


class AnchorFlowStateMachine:
    def __init__(self, cfg: BotConfig, asset: str = "BTC"):
        self.cfg = cfg
        self.asset = asset
        self.state = BotStateName.IDLE
        self.setup_dir: Direction | None = None
        self.persist_streak = 0
        self.setup_ref_mid: float | None = None
        self.position: OpenPosition | None = None
        self.cooldown_left = 0
        self.last_exit_side: Direction | None = None
        self.sign_history: deque[int] = deque(maxlen=256)
        self.mid_history: deque[float] = deque(maxlen=256)
        self.bid_sz_hist: deque[float] = deque(maxlen=48)
        self.ask_sz_hist: deque[float] = deque(maxlen=48)
        self.prev_book: BookSnapshot | None = None
        self.opposing_streak = 0
        self.stagnant_streak = 0
        self.no_follow_streak = 0
        self._pnl_window_key: int | None = None
        self._window_cum_pnl_usdc: float = 0.0

    def _assert_fsm_state(self) -> None:
        assert self.state in _VALID_STATES, f"invalid FSM state: {self.state}"

    def _window_sec(self, tick: UnifiedTick) -> int | None:
        return tick.window_start_unix

    def _sync_pnl_window(self, tick: UnifiedTick) -> None:
        if not self.cfg.enable_window_pnl_limp:
            return
        w = tick.window_start_unix
        if w is None:
            return
        if self._pnl_window_key != w:
            self._pnl_window_key = w
            self._window_cum_pnl_usdc = 0.0

    def _log_transition(
        self,
        prev: BotStateName,
        nxt: BotStateName,
        tick: UnifiedTick,
        flow_side: str,
    ) -> None:
        ad = anchor_deviation(tick.book.mid, tick.anchor_price) * 10_000.0
        imb = imbalance_sign(tick.book, self.cfg.imbalance_ratio_threshold)
        log.info(
            "STATE_TRANSITION: %s → %s anchorDev=%.4f imbalance=%s flowSide=%s",
            prev.value,
            nxt.value,
            ad,
            imb,
            flow_side,
        )

    def _set_state(self, nxt: BotStateName, tick: UnifiedTick, flow_side: str) -> None:
        if nxt != self.state:
            self._log_transition(self.state, nxt, tick, flow_side)
            self.state = nxt

    def _continuation_parts(self, tick: UnifiedTick, side: Direction) -> tuple[bool, bool, bool]:
        anchor = tick.anchor_price
        mid = tick.book.mid
        ref = self.setup_ref_mid
        if ref is None or anchor <= 0:
            return False, False, False
        push = self.cfg.continuation_min_push_frac * anchor
        if side == Direction.LONG:
            second = mid >= ref + push
            recent = list(self.mid_history)[-self.cfg.continuation_lookback_updates :]
            prev_high = max(recent[:-1], default=ref) if len(recent) > 1 else ref
            brk = mid > prev_high
        else:
            second = mid <= ref - push
            recent = list(self.mid_history)[-self.cfg.continuation_lookback_updates :]
            prev_low = min(recent[:-1], default=ref) if len(recent) > 1 else ref
            brk = mid < prev_low
        return second or brk, second, brk

    def _classify_trade_type(
        self,
        tick: UnifiedTick,
        side: Direction,
        second_push: bool,
        break_level: bool,
    ) -> TradeType:
        bias_mag = abs(net_flow_bias(tick.trades_since_last))
        strong_flow = bias_mag >= self.cfg.min_net_flow_bias * self.cfg.flow_bias_hard_mult
        if break_level or (second_push and strong_flow):
            return TradeType.HARD
        return TradeType.SOFT

    def _notional_for_type(self, t: TradeType) -> float:
        frac = self.cfg.max_notional_hard if t == TradeType.HARD else self.cfg.max_notional_soft
        return self.cfg.base_position_usdc * frac

    def _time_to_close_ok(self, tick: UnifiedTick) -> bool:
        if not self.cfg.enable_time_to_close_gate:
            return True
        if tick.now_unix is None or tick.window_start_unix is None:
            smoke_line("gate", "time_to_close blocked: missing now_unix or window_start_unix")
            return False
        now = float(tick.now_unix)
        w0 = int(tick.window_start_unix)
        end = w0 + int(self.cfg.window_length_sec)
        earliest = end - int(self.cfg.max_seconds_before_close)
        latest = end - int(self.cfg.min_seconds_before_close)
        return earliest <= now <= latest

    def _liquidity_ok(self, tick: UnifiedTick) -> bool:
        if not self.cfg.enable_liquidity_gate:
            return True
        bids = tick.bids_levels
        asks = tick.asks_levels
        if len(bids) < self.cfg.min_levels or len(asks) < self.cfg.min_levels:
            return False

        def depth_usdc(levels: tuple[tuple[float, float], ...]) -> float:
            return sum(p * s for p, s in levels)

        return depth_usdc(bids) >= self.cfg.min_depth_usdc and depth_usdc(asks) >= self.cfg.min_depth_usdc

    def _js_edge_allows(self, tick: UnifiedTick, flow_dir: Direction) -> bool:
        if not self.cfg.enable_js_edge_veto:
            return True
        ctx = tick.js_edge
        if ctx is None:
            return True
        if ctx.js_signal_direction is None:
            return True
        if ctx.js_signal_direction != flow_dir:
            ws = self._window_sec(tick)
            log.warning(
                "JS_EDGE_VETO: windowSec=%s signalConf=%s jsSignal=%s want=%s",
                ws if ws is not None else -1,
                ctx.js_signal_confidence,
                ctx.js_signal_direction.value,
                flow_dir.value,
            )
            return False
        if ctx.js_signal_confidence < self.cfg.min_signal_conf:
            log.warning(
                "JS_EDGE_VETO: windowSec=%s signalConf=%s jsSignal=%s want=%s",
                self._window_sec(tick) if self._window_sec(tick) is not None else -1,
                ctx.js_signal_confidence,
                ctx.js_signal_direction.value,
                flow_dir.value,
            )
            return False
        if ctx.js_min_edge_bps is not None:
            ad_bps = anchor_deviation(tick.book.mid, tick.anchor_price) * 10_000.0
            if ad_bps < ctx.js_min_edge_bps:
                log.warning(
                    "JS_EDGE_VETO: windowSec=%s anchorDevBps=%.2f jsMinEdgeBps=%s",
                    self._window_sec(tick) if self._window_sec(tick) is not None else -1,
                    ad_bps,
                    ctx.js_min_edge_bps,
                )
                return False
        return True

    def _window_pnl_allows_entry(self, tick: UnifiedTick) -> bool:
        if not self.cfg.enable_window_pnl_limp:
            return True
        if tick.window_start_unix is None:
            log.warning("WINDOW_RISK_LIMP: window_start_unix missing; blocking new entries")
            smoke_line("gate", "window_pnl_limp blocked: window_start_unix missing")
            return False
        self._sync_pnl_window(tick)
        if self._window_cum_pnl_usdc < self.cfg.max_loss_per_window_usdc:
            log.warning(
                "WINDOW_RISK_LIMP: windowSec=%s cumPnL=%.4f cap=%.4f",
                tick.window_start_unix,
                self._window_cum_pnl_usdc,
                self.cfg.max_loss_per_window_usdc,
            )
            return False
        return True

    def _apply_close_pnl(self, pos: OpenPosition, exit_mid: float, tick: UnifiedTick) -> None:
        self._sync_pnl_window(tick)
        if tick.window_start_unix is None:
            return
        if pos.side == Direction.LONG:
            pnl = pos.size_shares * (exit_mid - pos.entry_mid)
        else:
            pnl = pos.size_shares * (pos.entry_mid - exit_mid)
        self._window_cum_pnl_usdc += pnl

    def _flow_side_str(self, tick: UnifiedTick) -> str:
        b = net_flow_bias(tick.trades_since_last)
        if b > 0.05:
            return "buy"
        if b < -0.05:
            return "sell"
        return "flat"

    def _aligned_edge(self, tick: UnifiedTick) -> Direction | None:
        sign = imbalance_sign(tick.book, self.cfg.imbalance_ratio_threshold)
        edge = directional_edge(tick.book.mid, tick.anchor_price, self.cfg)
        if edge is None:
            return None
        if edge == Direction.LONG and sign != 1:
            return None
        if edge == Direction.SHORT and sign != -1:
            return None
        return edge

    def _continuation_ok(self, tick: UnifiedTick, side: Direction) -> bool:
        ok, _a, _b = self._continuation_parts(tick, side)
        return ok

    def _opposing_imbalance(self, tick: UnifiedTick, side: Direction) -> bool:
        s = imbalance_sign(tick.book, self.cfg.imbalance_ratio_threshold)
        if side == Direction.LONG:
            return s == -1
        return s == 1

    def _opposing_book_pressure(self, tick: UnifiedTick, side: Direction) -> bool:
        b, a = tick.book.bid_size_top, tick.book.ask_size_top
        tot = b + a
        if tot <= 0:
            return False
        if side == Direction.LONG:
            return (a / tot) >= self.cfg.absorption_opposing_ratio
        return (b / tot) >= self.cfg.absorption_opposing_ratio

    def _favorable_expansion(self, pos: OpenPosition, tick: UnifiedTick) -> bool:
        anchor = tick.anchor_price
        mid = tick.book.mid
        thr = self.cfg.follow_through_min_expand_frac * anchor
        if pos.side == Direction.LONG:
            return mid >= pos.entry_mid + thr
        return mid <= pos.entry_mid - thr

    def _update_position_extremes(self, pos: OpenPosition, tick: UnifiedTick) -> None:
        mid = tick.book.mid
        if pos.side == Direction.LONG:
            pos.best_favorable_extreme = max(pos.best_favorable_extreme, mid)
        else:
            pos.best_favorable_extreme = min(pos.best_favorable_extreme, mid)

    def process(self, tick: UnifiedTick) -> tuple[list[ExecutionIntent], StateMachineSnapshot]:
        self._assert_fsm_state()
        intents: list[ExecutionIntent] = []
        notes_parts: list[str] = []
        book = tick.book
        flow_side = self._flow_side_str(tick)

        if self.state == BotStateName.IN_TRADE and self.position is None:
            raise RuntimeError("IN_TRADE without position — explicit EXIT required before new entries")
        if self.position is not None and self.state != BotStateName.IN_TRADE:
            raise RuntimeError("Open position only allowed in IN_TRADE")
        self.sign_history.append(imbalance_sign(book, self.cfg.imbalance_ratio_threshold))
        self.mid_history.append(book.mid)
        self.bid_sz_hist.append(book.bid_size_top)
        self.ask_sz_hist.append(book.ask_size_top)

        vanish = spoof_vanish_detected(
            self.prev_book,
            book,
            self.bid_sz_hist,
            self.ask_sz_hist,
            self.cfg.spoof_size_mult,
        )
        self.prev_book = book

        chop = chop_block_new_entries(
            self.sign_history,
            self.cfg.max_book_flip_ratio,
            self.cfg.imbalance_sign_window,
        )
        ranging = update_consolidation(
            self.mid_history,
            tick.anchor_price,
            self.cfg.consolidation_window,
            self.cfg.consolidation_range_frac,
        )

        if vanish and self.state in (BotStateName.IDLE, BotStateName.SETUP):
            self.persist_streak = 0
            self.setup_dir = None
            self.setup_ref_mid = None
            self._set_state(BotStateName.IDLE, tick, flow_side)
            notes_parts.append("spoof_reset")

        aligned = self._aligned_edge(tick)

        # --- COOLDOWN ---
        if self.state == BotStateName.COOLDOWN:
            self.cooldown_left = max(0, self.cooldown_left - 1)
            if self.cooldown_left == 0:
                self._set_state(BotStateName.IDLE, tick, flow_side)
                self.last_exit_side = None
            snap = self._snapshot(notes=";".join(notes_parts) or "cooldown")
            return intents, snap

        # --- IN_TRADE (must EXIT before any new entry path) ---
        if self.state == BotStateName.IN_TRADE and self.position:
            pos = self.position
            self._update_position_extremes(pos, tick)
            held = tick.seq - pos.entry_seq

            if self._favorable_expansion(pos, tick):
                self.no_follow_streak = 0
                pos.updates_without_expansion = 0
            else:
                self.no_follow_streak += 1
                pos.updates_without_expansion += 1

            if self._opposing_imbalance(tick, pos.side):
                self.opposing_streak += 1
            else:
                self.opposing_streak = 0

            if self._opposing_book_pressure(tick, pos.side) and not self._favorable_expansion(pos, tick):
                self.stagnant_streak += 1
            else:
                self.stagnant_streak = 0

            exit_reason: str | None = None
            if self.no_follow_streak >= self.cfg.follow_through_max_updates:
                exit_reason = "no_follow_through"
            elif self.opposing_streak >= self.cfg.opposing_imbalance_persist:
                exit_reason = "order_flow_reversal"
            elif self.stagnant_streak >= self.cfg.absorption_stagnant_updates:
                exit_reason = "absorption"
            elif held >= self.cfg.max_trade_duration_updates:
                a = tick.anchor_price
                if a <= 0:
                    expanded = False
                elif pos.side == Direction.LONG:
                    expanded = (pos.best_favorable_extreme - pos.entry_mid) / a >= self.cfg.expansion_without_time_exit_frac
                else:
                    expanded = (pos.entry_mid - pos.best_favorable_extreme) / a >= self.cfg.expansion_without_time_exit_frac
                if not expanded:
                    exit_reason = "time_no_expansion"

            if exit_reason:
                self._apply_close_pnl(pos, book.mid, tick)
                intents.append(
                    ExecutionIntent(
                        action="CLOSE",
                        side=pos.side,
                        reason=exit_reason,
                        ref_price=book.mid,
                        notional_usdc=pos.notional_usdc,
                        trade_type=pos.trade_type,
                        order_size_shares=pos.size_shares,
                    )
                )
                self.last_exit_side = pos.side
                self.position = None
                self._set_state(BotStateName.COOLDOWN, tick, flow_side)
                self.cooldown_left = self.cfg.cooldown_updates
                self.persist_streak = 0
                self.setup_dir = None
                self.setup_ref_mid = None
                self.opposing_streak = 0
                self.stagnant_streak = 0
                self.no_follow_streak = 0
                notes_parts.append(exit_reason)

            snap = self._snapshot(notes=";".join(notes_parts))
            return intents, snap

        # Anti-chop for new entries
        block_entry = chop or ranging
        if block_entry:
            notes_parts.append("chop" if chop else "consolidation")

        # --- IDLE ---
        if self.state == BotStateName.IDLE:
            if block_entry or aligned is None:
                self.persist_streak = 0
                self.setup_dir = None
            else:
                if self.setup_dir is None or aligned != self.setup_dir:
                    self.setup_dir = aligned
                    self.persist_streak = 1
                else:
                    self.persist_streak += 1
                if self.persist_streak >= self.cfg.imbalance_persist_updates:
                    self._set_state(BotStateName.SETUP, tick, flow_side)
                    self.setup_ref_mid = book.mid
                    notes_parts.append("enter_setup")

        # --- SETUP ---
        elif self.state == BotStateName.SETUP:
            if block_entry or aligned is None or aligned != self.setup_dir:
                self._set_state(BotStateName.IDLE, tick, flow_side)
                self.persist_streak = 0
                self.setup_dir = None
                self.setup_ref_mid = None
                notes_parts.append("setup_broken")
            else:
                cont, second_push, break_level = self._continuation_parts(tick, aligned)
                flow = flow_supports_direction(
                    aligned,
                    tick.trades_since_last,
                    self.cfg.min_net_flow_bias,
                )
                if cont and flow and self._js_edge_allows(tick, aligned):
                    self._set_state(BotStateName.CONFIRMED, tick, flow_side)
                    notes_parts.append("confirmed")

        # --- CONFIRMED → IN_TRADE (all production gates) ---
        if self.state == BotStateName.CONFIRMED:
            assert self.position is None, "CONFIRMED with open position — missing EXIT"
            side = self.setup_dir
            if side is None:
                self._set_state(BotStateName.IDLE, tick, flow_side)
            elif not self._window_pnl_allows_entry(tick):
                notes_parts.append("window_risk_limp")
                self._set_state(BotStateName.SETUP, tick, flow_side)
            elif not self._time_to_close_ok(tick):
                ws = self._window_sec(tick)
                now = tick.now_unix
                w0 = tick.window_start_unix
                end = (w0 + self.cfg.window_length_sec) if w0 is not None else None
                log.warning(
                    "TIME_GATE_SKIP: windowSec=%s now=%s windowEnd=%s minSec=%s maxSec=%s",
                    ws,
                    now,
                    end,
                    self.cfg.min_seconds_before_close,
                    self.cfg.max_seconds_before_close,
                )
                notes_parts.append("time_gate_skip")
                self._set_state(BotStateName.SETUP, tick, flow_side)
            elif not self._liquidity_ok(tick):
                log.warning(
                    "LIQUIDITY_SKIP: bidLevels=%s askLevels=%s minLevels=%s minDepthUSDC=%s",
                    len(tick.bids_levels),
                    len(tick.asks_levels),
                    self.cfg.min_levels,
                    self.cfg.min_depth_usdc,
                )
                notes_parts.append("liquidity_skip")
                self._set_state(BotStateName.SETUP, tick, flow_side)
            else:
                _cont, second_push, break_level = self._continuation_parts(tick, side)
                ttype = self._classify_trade_type(tick, side, second_push, break_level)
                notional = self._notional_for_type(ttype)
                mid = book.mid
                order_size = notional / mid if mid > 0 else 0.0
                slip_ok = True
                slip_bps: float | None = None
                if self.cfg.enable_slippage_gate and tick.bids_levels and tick.asks_levels:
                    slip_ok, slip_bps = open_allowed_by_slippage(
                        side,
                        mid,
                        tick.bids_levels,
                        tick.asks_levels,
                        order_size,
                        self.cfg.max_slippage_bps,
                        window_sec=self._window_sec(tick),
                        asset=self.asset,
                        log_skip=True,
                    )
                elif self.cfg.enable_slippage_gate:
                    slip_ok = False
                    ws = self._window_sec(tick)
                    log.warning(
                        "SLIPPAGE_SKIP: windowSec=%s asset=%s direction=%s slippageBps=None orderSize=%s (no depth)",
                        ws if ws is not None else -1,
                        self.asset,
                        side.value,
                        order_size,
                    )

                if not slip_ok:
                    notes_parts.append("slippage_skip")
                    self._set_state(BotStateName.SETUP, tick, flow_side)
                else:
                    log.info(
                        "TRADE_CLASS: windowSec=%s tradeType=%s notion=%.4f slippageBps=%s",
                        self._window_sec(tick) if self._window_sec(tick) is not None else -1,
                        ttype.value,
                        notional,
                        slip_bps,
                    )
                    intents.append(
                        ExecutionIntent(
                            action="OPEN",
                            side=side,
                            reason="confirmed_anchor_flow",
                            ref_price=mid,
                            notional_usdc=notional,
                            trade_type=ttype,
                            order_size_shares=order_size,
                            slippage_bps=slip_bps,
                        )
                    )
                    self.position = OpenPosition(
                        side=side,
                        entry_mid=mid,
                        entry_anchor=tick.anchor_price,
                        entry_seq=tick.seq,
                        best_favorable_extreme=mid,
                        size_shares=order_size,
                        notional_usdc=notional,
                        trade_type=ttype,
                    )
                    self._set_state(BotStateName.IN_TRADE, tick, flow_side)
                    self.persist_streak = 0
                    self.setup_dir = None
                    self.setup_ref_mid = None
                    self.opposing_streak = 0
                    self.stagnant_streak = 0
                    self.no_follow_streak = 0
                    notes_parts.append("open")

        self._assert_fsm_state()
        snap = self._snapshot(notes=";".join(notes_parts))
        return intents, snap

    def _snapshot(self, notes: str = "") -> StateMachineSnapshot:
        direction: Direction | None = None
        if self.position and self.state == BotStateName.IN_TRADE:
            direction = self.position.side
        elif self.state in (BotStateName.SETUP, BotStateName.CONFIRMED):
            direction = self.setup_dir
        return StateMachineSnapshot(
            state=self.state,
            direction=direction,
            setup_streak=self.persist_streak,
            cooldown_left=self.cooldown_left,
            last_exit_side=self.last_exit_side,
            notes=notes,
        )
