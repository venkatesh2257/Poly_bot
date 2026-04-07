"""python -m hf_anchor_bot — requires POLYMARKET_TOKEN_ID (outcome token) and RPC for Chainlink."""

from __future__ import annotations

import logging
import os
import sys

from hf_anchor_bot.config import BotConfig
from hf_anchor_bot.execution import DryRunExecutor, LiveOrderExecutor, OrderExecutor
from hf_anchor_bot.runner import run_loop

# Set True in a deployment that wires a real CLOB `OrderExecutor` (see `_make_executor`).
LIVE_EXECUTOR_AVAILABLE: bool = False


def _live_executor_available() -> bool:
    v = os.environ.get("HF_ANCHOR_LIVE_EXECUTOR_AVAILABLE", "").strip().lower()
    if v in ("1", "true", "yes"):
        return True
    return LIVE_EXECUTOR_AVAILABLE


def _make_executor(dry_run: bool) -> OrderExecutor:
    if dry_run:
        return DryRunExecutor()
    if not _live_executor_available():
        raise RuntimeError(
            "DRY_RUN=false but no live executor configured; cannot run live anchor trading"
        )
    return LiveOrderExecutor()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(message)s",
    )
    token_id = os.environ.get("POLYMARKET_TOKEN_ID", "").strip()
    if not token_id:
        print("Set POLYMARKET_TOKEN_ID to the CLOB outcome token id.", file=sys.stderr)
        sys.exit(1)
    asset = os.environ.get("ANCHOR_ASSET", "BTC").strip().upper()
    interval = float(os.environ.get("POLL_INTERVAL_S", "0.5"))
    dry = os.environ.get("DRY_RUN", "true").lower() in ("1", "true", "yes")

    cfg = BotConfig(dry_run=dry)
    try:
        ex = _make_executor(dry)
    except (RuntimeError, NotImplementedError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
    print(f"[runner] asset={asset} token_id={token_id[:16]}… dry_run={dry} interval={interval}s")
    run_loop(cfg, token_id=token_id, asset=asset, poll_interval_s=interval, executor=ex)


if __name__ == "__main__":
    main()
