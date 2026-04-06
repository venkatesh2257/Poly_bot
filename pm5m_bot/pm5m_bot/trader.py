"""Read CLOB books; place orders (dry-run or py-clob-client). Early-exit monitor."""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

from pm5m_bot.config import Settings
from pm5m_bot.gamma_client import GammaClient
from pm5m_bot.signal import TradeIntent
from pm5m_bot.risk_manager import SizedOrder
from pm5m_bot.smoke_log import line as smoke_line

logger = logging.getLogger(__name__)


@dataclass
class OpenPosition:
    token_id: str
    entry_mid: float
    entry_ts: float
    size_shares: float
    usdc_notional: float
    slug: str


def _order_id_from_post_response(resp: Any) -> str | None:
    if resp is None:
        return None
    if isinstance(resp, dict):
        if resp.get("success") is False:
            return None
        oid = resp.get("orderID") or resp.get("orderId") or resp.get("id")
        return str(oid) if oid else None
    for attr in ("orderID", "order_id", "id"):
        oid = getattr(resp, attr, None)
        if oid:
            return str(oid)
    return None


def _matched_and_status(order_row: Any) -> tuple[float, str]:
    if isinstance(order_row, dict):
        raw_m = (
            order_row.get("size_matched")
            or order_row.get("sizeMatched")
            or order_row.get("matched")
            or 0
        )
        try:
            matched = float(raw_m)
        except (TypeError, ValueError):
            matched = 0.0
        status = str(order_row.get("status", "unknown"))
        return matched, status
    try:
        matched = float(getattr(order_row, "size_matched", None) or getattr(order_row, "sizeMatched", None) or 0)
    except (TypeError, ValueError):
        matched = 0.0
    status = str(getattr(order_row, "status", "unknown"))
    return matched, status


_TERMINAL_UNFILLED_STATUS_SUBSTR = ("CANCEL", "REJECT", "EXPIR", "KILL", "INVALID")


def poll_fak_entry_fill(
    clob: Any,
    order_id: str,
    *,
    timeout_sec: float = 45.0,
    poll_sec: float = 0.4,
) -> tuple[float, str]:
    """Return (size_matched, last_status) after fill, terminal empty, or timeout."""
    deadline = time.time() + timeout_sec
    last_status = "unknown"
    while time.time() < deadline:
        row = clob.get_order(order_id)
        matched, last_status = _matched_and_status(row)
        if matched > 0:
            return matched, last_status
        up = last_status.upper()
        if any(s in up for s in _TERMINAL_UNFILLED_STATUS_SUBSTR):
            return 0.0, last_status
        time.sleep(poll_sec)
    return 0.0, "timeout"


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

    def fetch_live_collateral_usdc(self) -> float | None:
        """
        Live-only: USDC collateral from CLOB (L2). Used for sizing — not env PM5M_ACCOUNT_USDC.
        Returns None if the balance cannot be fetched (caller should skip live entries).
        """
        if self._s.dry_run or self._clob is None:
            return None
        try:
            from py_clob_client.clob_types import AssetType, BalanceAllowanceParams
        except ImportError as e:
            raise RuntimeError("py-clob-client missing") from e
        try:
            resp = self._clob.get_balance_allowance(
                BalanceAllowanceParams(asset_type=AssetType.COLLATERAL)
            )
        except Exception as e:
            smoke_line("balance", "get_balance_allowance raised: %s", e)
            logger.warning("LIVE: get_balance_allowance failed: %s", e)
            return None
        if not isinstance(resp, dict):
            smoke_line("balance", "unexpected balance response type=%s", type(resp).__name__)
            logger.warning("LIVE: unexpected balance response type: %s", type(resp).__name__)
            return None
        parsed = _collateral_usdc_from_balance_payload(resp)
        if parsed is None:
            smoke_line("balance", "could not parse balance keys=%s", list(resp.keys()))
            logger.warning("LIVE: could not parse USDC balance from CLOB response keys=%s", list(resp.keys()))
        return parsed

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
        if isinstance(resp, dict) and resp.get("success") is False:
            logger.error(
                "LIVE order rejected slug=%s errorMsg=%s",
                intent.candidate.slug,
                resp.get("errorMsg") or resp.get("error") or resp,
            )
            return None
        order_id = _order_id_from_post_response(resp)
        if not order_id:
            logger.error(
                "LIVE post_order missing orderID slug=%s resp_head=%s",
                intent.candidate.slug,
                str(resp)[:400],
            )
            return None
        smoke_line("entry", "live order posted orderId=%s slug=%s", order_id[:32], intent.candidate.slug[:48])
        matched, st = poll_fak_entry_fill(self._clob, order_id)
        if matched <= 0:
            smoke_line("entry", "zero fill matched=%s status=%s orderId=%s", matched, st, order_id[:32])
            logger.warning(
                "LIVE entry not filled (matched=%s status=%s) slug=%s orderID=%s… — no position",
                matched,
                st,
                intent.candidate.slug,
                order_id[:20],
            )
            try:
                self._clob.cancel(order_id)
            except Exception:
                logger.debug("cancel unfilled entry failed", exc_info=True)
            return None
        if matched + 1e-9 < float(sized.size_shares):
            smoke_line(
                "entry",
                "partial fill matched=%.6f requested=%.6f status=%s",
                matched,
                float(sized.size_shares),
                st,
            )
            logger.info(
                "LIVE partial fill slug=%s matched=%.6f requested=%.6f status=%s",
                intent.candidate.slug,
                matched,
                float(sized.size_shares),
                st,
            )
        else:
            smoke_line("entry", "verified fill matched=%.6f status=%s orderId=%s", matched, st, order_id[:32])
        usdc_filled = matched * float(intent.limit_price)
        return OpenPosition(
            token_id=intent.token_id,
            entry_mid=entry_mid,
            entry_ts=time.time(),
            size_shares=matched,
            usdc_notional=usdc_filled,
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


def _collateral_usdc_from_balance_payload(resp: dict[str, object]) -> float | None:
    """Parse CLOB /balance-allowance JSON; balance is raw USDC with 6 decimals (Polymarket convention)."""
    raw = resp.get("balance")
    if raw is None:
        raw = resp.get("availableBalance")
    if raw is None:
        return None
    try:
        x = float(raw)
    except (TypeError, ValueError):
        return None
    if x < 0:
        return None
    if x >= 1_000.0:
        return x / 1_000_000.0
    return x


def read_account_usdc(settings: Settings) -> float:
    """Dry-run sizing: USDC from PM5M_ACCOUNT_USDC. Live sizing uses CLOB via Trader.fetch_live_collateral_usdc."""
    v = os.getenv("PM5M_ACCOUNT_USDC")
    if v:
        return float(v)
    return 0.0
