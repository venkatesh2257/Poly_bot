"""One trading cycle: scan → signal → risk → (optional) trade + early-exit monitor."""

from __future__ import annotations

import logging
import os
import time
from typing import List

from pm5m_bot.config import Settings
from pm5m_bot.gamma_client import GammaClient
from pm5m_bot.market_scanner import MarketCandidate, MarketScanner
from pm5m_bot.risk_manager import size_position
from pm5m_bot.signal import SpotTrendFetcher, evaluate
from pm5m_bot.trader import Trader, read_account_usdc

logger = logging.getLogger(__name__)

MIN_NOTIONAL_USDC = float(os.getenv("PM5M_MIN_NOTIONAL_USDC", "1.0"))


def run_cycle(
    settings: Settings,
    *,
    max_pages: int = 8,
    max_trades: int = 1,
    monitor_early_exit: bool = True,
) -> List[str]:
    """
    Returns slugs for which entry was executed (or dry-run logged).
    Retries are on HTTP layers (Gamma, Coinbase); this function logs and skips on other errors.
    """
    out: List[str] = []
    gamma = GammaClient(settings)
    spot = SpotTrendFetcher(settings)
    try:
        try:
            trends = {
                "BTC": spot.trend_for_asset("BTC"),
                "ETH": spot.trend_for_asset("ETH"),
            }
        except Exception:
            logger.exception("spot trend fetch failed")
            return out

        try:
            scanner = MarketScanner(settings, gamma)
            candidates = scanner.scan(max_pages=max_pages)
        except Exception:
            logger.exception("market scan failed")
            return out

        if not candidates:
            logger.info("no candidates after filters")
            return out

        try:
            trader = Trader(settings, gamma)
        except Exception:
            logger.exception("trader init failed")
            return out

        account = read_account_usdc(settings)
        if account <= 0 and not settings.dry_run:
            logger.warning("PM5M_ACCOUNT_USDC unset or zero; skipping live sizing")

        ordered = sorted(candidates, key=lambda c: c.liquidity_usd, reverse=True)
        done = 0
        for cand in ordered:
            if done >= max_trades:
                break
            try:
                intent = evaluate(settings, cand, trends)
            except Exception:
                logger.exception("signal evaluate failed slug=%s", cand.slug)
                continue
            if intent is None:
                continue
            try:
                sized = size_position(settings, intent, account, candidates)
            except Exception:
                logger.exception("risk sizing failed slug=%s", cand.slug)
                continue
            if sized.usdc_notional < MIN_NOTIONAL_USDC:
                logger.debug("skip dust slug=%s usdc=%.4f", cand.slug, sized.usdc_notional)
                continue
            try:
                pos = trader.execute_entry(intent, sized)
            except Exception:
                logger.exception("execute_entry failed slug=%s", cand.slug)
                continue
            if pos is None:
                continue
            out.append(cand.slug)
            done += 1
            if monitor_early_exit:
                try:
                    end_ts = cand.end_date.timestamp()
                    trader.monitor_early_exit(pos, end_ts)
                except Exception:
                    logger.exception("monitor_early_exit failed slug=%s", cand.slug)
        return out
    finally:
        spot.close()
        gamma.close()


def run_loop(
    base_settings: Settings,
    *,
    interval_sec: float,
    max_pages: int,
    max_trades: int,
    monitor_early_exit: bool,
) -> None:
    """Repeat run_cycle until interrupted; uses jittered sleep between cycles."""
    from pm5m_bot.retry_util import with_jitter

    while True:
        try:
            run_cycle(
                base_settings,
                max_pages=max_pages,
                max_trades=max_trades,
                monitor_early_exit=monitor_early_exit,
            )
        except KeyboardInterrupt:
            raise
        except Exception:
            logger.exception("run_cycle top-level failure")
        time.sleep(with_jitter(interval_sec))
