from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal


class BotStateName(str, Enum):
    IDLE = "IDLE"
    SETUP = "SETUP"
    CONFIRMED = "CONFIRMED"
    IN_TRADE = "IN_TRADE"
    COOLDOWN = "COOLDOWN"


class Direction(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"


class TradeType(str, Enum):
    SOFT = "soft"
    HARD = "hard"


@dataclass(frozen=True)
class TradePrint:
    t_ms: int
    side: Literal["BUY", "SELL"]
    size: float
    price: float


@dataclass(frozen=True)
class BookSnapshot:
    """Top of book + mid; no indicators — raw microstructure."""

    t_ms: int
    best_bid: float
    best_ask: float
    bid_size_top: float
    ask_size_top: float

    @property
    def mid(self) -> float:
        return (self.best_bid + self.best_ask) / 2.0


@dataclass(frozen=True)
class JsEdgeContext:
    """Optional veto layer from the JS anchor bot (per window)."""

    js_min_edge_bps: float | None = None
    js_signal_direction: Direction | None = None
    js_signal_confidence: float = 0.0


@dataclass(frozen=True)
class UnifiedTick:
    """One decision tick: book + anchor + prints + optional risk context."""

    seq: int
    book: BookSnapshot
    anchor_price: float
    trades_since_last: tuple[TradePrint, ...] = ()
    now_unix: float | None = None
    """Wall-clock seconds; required for time-to-close gate when enabled."""

    window_start_unix: int | None = None
    """Start of the current fixed window (e.g. floor(now/300)*300 for BTC 5m)."""

    bids_levels: tuple[tuple[float, float], ...] = ()
    """Descending price, (price, size) per level — for liquidity + slippage walk (sell side)."""

    asks_levels: tuple[tuple[float, float], ...] = ()
    """Ascending price, (price, size) per level — for buy walk."""

    js_edge: JsEdgeContext | None = None


@dataclass
class OpenPosition:
    side: Direction
    entry_mid: float
    entry_anchor: float
    entry_seq: int
    best_favorable_extreme: float
    size_shares: float
    notional_usdc: float
    trade_type: TradeType

    updates_without_expansion: int = 0
    last_follow_through_seq: int = 0


@dataclass
class ExecutionIntent:
    action: Literal["OPEN", "CLOSE"]
    side: Direction
    reason: str
    ref_price: float
    notional_usdc: float = 0.0
    trade_type: TradeType = TradeType.SOFT
    order_size_shares: float = 0.0
    slippage_bps: float | None = None


@dataclass
class StateMachineSnapshot:
    state: BotStateName
    direction: Direction | None
    setup_streak: int
    cooldown_left: int
    last_exit_side: Direction | None
    notes: str = ""
