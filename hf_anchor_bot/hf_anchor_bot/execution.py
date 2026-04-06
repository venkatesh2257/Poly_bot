"""Execution boundary: slippage-aware sizing; wire CLOB in your deployment."""

from __future__ import annotations

import logging
from typing import Protocol, Sequence

from hf_anchor_bot.types import Direction, ExecutionIntent

log = logging.getLogger("hf_anchor_bot.execution")


class OrderExecutor(Protocol):
    def execute(self, intent: ExecutionIntent) -> None: ...


def weighted_price_buy(asks: Sequence[tuple[float, float]], order_size: float) -> float | None:
    """Walk asks (ascending price) until `order_size` shares filled; return average fill price."""
    if order_size <= 0 or not asks:
        return None
    need = order_size
    paid = 0.0
    got = 0.0
    for price, sz in asks:
        if sz <= 0:
            continue
        take = min(need, sz)
        paid += take * price
        got += take
        need -= take
        if need <= 1e-12:
            return paid / got
    return None


def weighted_price_sell(bids: Sequence[tuple[float, float]], order_size: float) -> float | None:
    """Walk bids (descending price) until `order_size` shares sold; return average proceeds price."""
    if order_size <= 0 or not bids:
        return None
    need = order_size
    recv = 0.0
    got = 0.0
    for price, sz in bids:
        if sz <= 0:
            continue
        take = min(need, sz)
        recv += take * price
        got += take
        need -= take
        if need <= 1e-12:
            return recv / got
    return None


def slippage_bps_for_open(
    side: Direction,
    book_mid: float,
    bids: Sequence[tuple[float, float]],
    asks: Sequence[tuple[float, float]],
    order_size: float,
) -> float | None:
    """
    slippageBps = (orderWeightedMid − bookMid) / bookMid * 10_000 for buys;
    for sells use (bookMid − orderWeightedMid) / bookMid * 10_000.
    """
    if book_mid <= 0:
        return None
    if side == Direction.LONG:
        w = weighted_price_buy(asks, order_size)
        if w is None:
            return None
        return (w - book_mid) / book_mid * 10_000.0
    w = weighted_price_sell(bids, order_size)
    if w is None:
        return None
    return (book_mid - w) / book_mid * 10_000.0


def open_allowed_by_slippage(
    side: Direction,
    book_mid: float,
    bids: Sequence[tuple[float, float]],
    asks: Sequence[tuple[float, float]],
    order_size: float,
    max_slippage_bps: float,
    *,
    window_sec: int | None,
    asset: str,
    log_skip: bool = True,
) -> tuple[bool, float | None]:
    """Returns (allowed, slippage_bps)."""
    bps = slippage_bps_for_open(side, book_mid, bids, asks, order_size)
    if bps is None:
        if log_skip:
            ws = window_sec if window_sec is not None else -1
            log.warning(
                "SLIPPAGE_SKIP: windowSec=%s asset=%s direction=%s slippageBps=None orderSize=%s (insufficient book)",
                ws,
                asset,
                side.value,
                order_size,
            )
        return False, None
    if bps > max_slippage_bps:
        if log_skip:
            ws = window_sec if window_sec is not None else -1
            log.warning(
                "SLIPPAGE_SKIP: windowSec=%s asset=%s direction=%s slippageBps=%.2f orderSize=%s",
                ws,
                asset,
                side.value,
                bps,
                order_size,
            )
        return False, bps
    return True, bps


class DryRunExecutor:
    def execute(self, intent: ExecutionIntent) -> None:
        print(
            f"[EXEC dry_run] {intent.action} {intent.side.value} @ {intent.ref_price:.6f} "
            f"notional={intent.notional_usdc:.2f} type={intent.trade_type.value} "
            f"size={intent.order_size_shares:.4f} slip_bps={intent.slippage_bps} ({intent.reason})"
        )


class LoggingExecutor:
    def __init__(self, inner: OrderExecutor | None = None):
        self.inner = inner

    def execute(self, intent: ExecutionIntent) -> None:
        print(
            f"[EXEC] {intent.action} {intent.side.value} reason={intent.reason} ref={intent.ref_price} "
            f"notional={intent.notional_usdc} slip_bps={intent.slippage_bps}"
        )
        if self.inner:
            self.inner.execute(intent)
