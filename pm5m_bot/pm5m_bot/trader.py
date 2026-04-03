"""Read CLOB books; place orders (dry-run or py-clob-client). Early-exit monitor."""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

from pm5m_bot.config import Settings
from pm5m_bot.gamma_client import GammaClient
from pm5m_bot.signal import TradeIntent
from pm5m_bot.risk_manager import SizedOrder

logger = logging.getLogger(__name__)


@dataclass
class OpenPosition:
    token_id: str
    entry_mid: float
    entry_ts: float
    size_shares: float
    usdc_notional: float
    slug: str


def _mid_from_book(book: dict[str, Any] | None) -> float | None:
    if not book:
        return None
    bids = book.get("bids") or []
    asks = book.get("asks") or []
    if not bids or not asks:
        return None

    def px(x: Any) -> float:
        return float(x.get("price", x))

    bb = max(px(b) for b in bids)
    ba = min(px(a) for a in asks)
    return (bb + ba) / 2.0


class Trader:
    def __init__(self, settings: Settings, gamma: GammaClient) -> None:
        self._s = settings
        self._gamma = gamma
        self._clob = None
        if not settings.dry_run:
            self._init_clob()

    def _init_clob(self) -> None:
        try:
            from eth_account import Account
            from py_clob_client.client import ClobClient
            from py_clob_client.clob_types import ApiCreds
        except ImportError as e:
            raise RuntimeError("Live mode requires: pip install py-clob-client eth-account") from e
        pk = self._s.evm_private_key
        if not pk:
            raise RuntimeError("EVM_PRIVATE_KEY required for live trading")
        host = self._s.clob_host
        chain = self._s.chain_id
        creds = None
        if self._s.poly_api_key and self._s.poly_api_secret and self._s.poly_passphrase:
            creds = ApiCreds(
                api_key=self._s.poly_api_key,
                api_secret=self._s.poly_api_secret,
                api_passphrase=self._s.poly_passphrase,
            )
        funder = self._s.clob_funder or Account.from_key(pk).address
        sig = int(os.getenv("SIGNATURE_TYPE", os.getenv("CLOB_SIGNATURE_TYPE", "0")))
        self._clob = ClobClient(
            host,
            chain_id=chain,
            key=pk,
            creds=creds,
            signature_type=sig,
            funder=funder,
        )
        logger.info("ClobClient initialized host=%s chain=%s funder=%s", host, chain, funder[:10])

    def current_mid(self, token_id: str) -> float | None:
        book = self._gamma.fetch_book_json(token_id)
        return _mid_from_book(book)

    def execute_entry(self, intent: TradeIntent, sized: SizedOrder) -> Optional[OpenPosition]:
        mid = self.current_mid(intent.token_id)
        entry_mid = mid if mid is not None else intent.candidate.best_yes_like.price
        if self._s.dry_run:
            logger.info(
                "DRY_RUN enter %s token=%s mid≈%.4f limit=%.4f shares≈%.6f USDC≈%.2f | %s",
                intent.candidate.slug,
                intent.token_id[:16] + "…",
                entry_mid,
                intent.limit_price,
                sized.size_shares,
                sized.usdc_notional,
                intent.rationale,
            )
            return OpenPosition(
                token_id=intent.token_id,
                entry_mid=entry_mid,
                entry_ts=time.time(),
                size_shares=sized.size_shares,
                usdc_notional=sized.usdc_notional,
                slug=intent.candidate.slug,
            )
        assert self._clob is not None
        try:
            from py_clob_client.clob_types import OrderArgs, OrderType
            from py_clob_client.order_builder.constants import BUY
        except ImportError as e:
            raise RuntimeError("py-clob-client missing") from e
        order = self._clob.create_order(
            OrderArgs(
                token_id=intent.token_id,
                price=float(intent.limit_price),
                size=float(sized.size_shares),
                side=BUY,
            )
        )
        resp = self._clob.post_order(order, OrderType.FAK)
        logger.info("LIVE order posted %s resp=%s", intent.candidate.slug, str(resp)[:500])
        return OpenPosition(
            token_id=intent.token_id,
            entry_mid=entry_mid,
            entry_ts=time.time(),
            size_shares=sized.size_shares,
            usdc_notional=sized.usdc_notional,
            slug=intent.candidate.slug,
        )

    def monitor_early_exit(
        self,
        pos: OpenPosition,
        market_end_ts: float,
        sleep_sec: float = 12.0,
    ) -> bool:
        """
        Exit early if mid drops > PM5M_EARLY_EXIT_MOVE_PCT below entry within PM5M_EARLY_EXIT_WINDOW_SEC.
        Live exit: market sell via FAK (best effort).
        """
        deadline = pos.entry_ts + self._s.early_exit_window_sec
        thr = pos.entry_mid * (1.0 - self._s.early_exit_move_pct)
        while time.time() < min(deadline, market_end_ts):
            mid = self.current_mid(pos.token_id)
            if mid is not None and mid < thr:
                logger.warning("early_exit %s mid=%.4f < thr=%.4f", pos.slug, mid, thr)
                if not self._s.dry_run and self._clob is not None:
                    try:
                        from py_clob_client.clob_types import OrderArgs, OrderType
                        from py_clob_client.order_builder.constants import SELL
                    except ImportError:
                        return True
                    sell_px = max(0.01, mid - 0.05)
                    order = self._clob.create_order(
                        OrderArgs(
                            token_id=pos.token_id,
                            price=float(sell_px),
                            size=float(pos.size_shares),
                            side=SELL,
                        )
                    )
                    self._clob.post_order(order, OrderType.FAK)
                return True
            time.sleep(sleep_sec)
        return False


def read_account_usdc(settings: Settings) -> float:
    v = os.getenv("PM5M_ACCOUNT_USDC")
    if v:
        return float(v)
    return 0.0
