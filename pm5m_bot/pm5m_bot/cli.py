"""CLI: scan markets or run trading cycles with retries at HTTP layer."""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import replace

from pm5m_bot.config import Settings, load_settings
from pm5m_bot.gamma_client import GammaClient
from pm5m_bot.market_scanner import MarketScanner
from pm5m_bot.runner import run_cycle, run_loop


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def _apply_mode(settings: Settings, args: argparse.Namespace) -> Settings:
    if getattr(args, "dry_run", False):
        return replace(settings, dry_run=True)
    if getattr(args, "live", False):
        return replace(settings, dry_run=False)
    return settings


def cmd_scan(settings: Settings, args: argparse.Namespace) -> int:
    gamma = GammaClient(settings)
    try:
        scanner = MarketScanner(settings, gamma)
        try:
            candidates = scanner.scan(max_pages=args.max_pages)
        except Exception:
            logging.getLogger(__name__).exception("scan failed after retries")
            return 1
        for c in candidates:
            hi = c.best_yes_like
            logging.getLogger(__name__).info(
                "%s %s rem=%.0fs liq=%.0f spread≈%.4f %s @ %.4f",
                c.asset,
                c.slug,
                c.seconds_remaining,
                c.liquidity_usd,
                c.spread_estimate,
                hi.label,
                hi.price,
            )
        logging.getLogger(__name__).info("total candidates: %d", len(candidates))
        return 0
    finally:
        gamma.close()


def cmd_run(settings: Settings, args: argparse.Namespace) -> int:
    log = logging.getLogger(__name__)
    try:
        if args.loop:
            run_loop(
                settings,
                interval_sec=args.interval,
                max_pages=args.max_pages,
                max_trades=args.max_trades,
                monitor_early_exit=not args.no_early_exit,
            )
            return 0
        slugs = run_cycle(
            settings,
            max_pages=args.max_pages,
            max_trades=args.max_trades,
            monitor_early_exit=not args.no_early_exit,
        )
        log.info("cycle complete traded=%s", slugs)
        return 0
    except KeyboardInterrupt:
        log.warning("interrupted")
        return 130
    except Exception:
        log.exception("run failed")
        return 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="pm5m_bot", description="Polymarket 5m BTC/ETH up/down bot")
    p.add_argument("--log-level", default=None, help="override PM5M_LOG_LEVEL")
    p.add_argument("--max-pages", type=int, default=8, help="Gamma /markets pages (100 each)")

    sub = p.add_subparsers(dest="command", required=True)

    ps = sub.add_parser("scan", help="list filtered markets (read-only)")
    ps.set_defaults(_handler=cmd_scan)
    mx = ps.add_mutually_exclusive_group()
    mx.add_argument("--dry-run", action="store_true", help="no effect for scan; accepted for symmetry")
    mx.add_argument("--live", action="store_true", help="no effect for scan")

    pr = sub.add_parser("run", help="one cycle or loop: signal + optional orders")
    pr.set_defaults(_handler=cmd_run)
    pr.add_argument("--loop", action="store_true", help="repeat until Ctrl+C")
    pr.add_argument("--interval", type=float, default=45.0, help="seconds between loop iterations")
    pr.add_argument("--max-trades", type=int, default=1, help="max entries per cycle")
    pr.add_argument(
        "--no-early-exit",
        action="store_true",
        help="do not monitor first-window adverse move",
    )
    mx2 = pr.add_mutually_exclusive_group()
    mx2.add_argument("--dry-run", action="store_true", help="force PM5M_DRY_RUN on")
    mx2.add_argument("--live", action="store_true", help="force live trading (requires keys)")

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    settings = load_settings()
    if args.log_level:
        settings = replace(settings, log_level=args.log_level)
    _configure_logging(settings.log_level)
    settings = _apply_mode(settings, args)
    handler = args._handler
    return int(handler(settings, args))


if __name__ == "__main__":
    sys.exit(main())
