"""HTTP retries with exponential backoff + jitter."""

from __future__ import annotations

import logging
import random
from functools import wraps
from typing import Any, Callable, TypeVar

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_random_exponential,
    before_sleep_log,
)

logger = logging.getLogger(__name__)

F = TypeVar("F", bound=Callable[..., Any])

RETRY_EXC = (httpx.HTTPError, httpx.TimeoutException, ConnectionError)


def http_retry(fn: F) -> F:
    """Decorator for functions that perform httpx calls."""

    @retry(
        retry=retry_if_exception_type(RETRY_EXC),
        stop=stop_after_attempt(5),
        wait=wait_random_exponential(multiplier=0.5, max=20),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    )
    @wraps(fn)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        return fn(*args, **kwargs)

    return wrapped  # type: ignore[return-value]


def with_jitter(base: float, spread: float = 0.15) -> float:
    return base * (1.0 + random.uniform(-spread, spread))
