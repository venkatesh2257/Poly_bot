"""Gated smoke-test logs (set SMOKE_TEST_LOGS=1). Does not affect trading."""

from __future__ import annotations

import logging
import os

_logger = logging.getLogger("pm5m_bot.smoke")

# Optional last values for smoke debugging (only updated when SMOKE_TEST_LOGS is on).
LAST: dict[str, object] = {}


def enabled() -> bool:
    v = os.getenv("SMOKE_TEST_LOGS", "").strip().lower()
    return v in ("1", "true", "yes")


def line(component: str, fmt: str, *args: object) -> None:
    if not enabled():
        return
    msg = fmt % args if args else fmt
    _logger.info("[smoke][%s] %s", component, msg)


def record(key: str, value: object) -> None:
    if not enabled():
        return
    LAST[key] = value
