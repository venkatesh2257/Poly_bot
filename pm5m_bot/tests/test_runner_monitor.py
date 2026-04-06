"""Non-blocking early-exit: spawn starts a thread without blocking the caller."""

from __future__ import annotations

import threading
import time
from unittest.mock import patch

from pm5m_bot.config import Settings
from pm5m_bot.trader import OpenPosition


def test_spawn_early_exit_monitor_returns_immediately():
    from pm5m_bot import runner as runner_mod

    pos = OpenPosition(
        token_id="t",
        entry_mid=0.5,
        entry_ts=time.time(),
        size_shares=1.0,
        usdc_notional=0.5,
        slug="test-slug",
    )
    started = threading.Event()

    def fake_run(settings, p, end_ts):
        started.set()
        time.sleep(0.2)

    with patch.object(runner_mod, "_run_early_exit_monitor", side_effect=fake_run):
        t0 = time.perf_counter()
        runner_mod.spawn_early_exit_monitor(
            Settings(dry_run=True),
            pos,
            time.time() + 60.0,
        )
        elapsed = time.perf_counter() - t0
    assert elapsed < 0.05, "spawn should not wait for monitor body"
    assert started.wait(timeout=2.0), "background monitor should start"
