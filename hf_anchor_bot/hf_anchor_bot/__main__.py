"""python -m hf_anchor_bot — requires POLYMARKET_TOKEN_ID (outcome token) and RPC for Chainlink."""

from __future__ import annotations

import logging
import os
import sys

from hf_anchor_bot.config import BotConfig
from hf_anchor_bot.execution import DryRunExecutor, OrderExecutor
from hf_anchor_bot.runner import run_loop


def _make_executor(dry_run: bool) -> OrderExecutor:
    if dry_run:
        return DryRunExecutor()
    print(
        "[hf_anchor_bot] DRY_RUN=false but this package does not ship a live CLOB executor yet.",
        file=sys.stderr,
    )
    print(
        "[hf_anchor_bot] Run with DRY_RUN=true (default), or inject a custom OrderExecutor from your deployment code.",
        file=sys.stderr,
    )
    sys.exit(2)


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
    ex = _make_executor(dry)
    print(f"[runner] asset={asset} token_id={token_id[:16]}… dry_run={dry} interval={interval}s")
    run_loop(cfg, token_id=token_id, asset=asset, poll_interval_s=interval, executor=ex)


if __name__ == "__main__":
    main()
