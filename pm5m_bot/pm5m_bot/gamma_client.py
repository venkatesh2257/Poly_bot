"""Gamma REST with retries."""

from __future__ import annotations

import logging
from typing import Any, List

import httpx

from pm5m_bot.config import Settings
from pm5m_bot.retry_util import http_retry

logger = logging.getLogger(__name__)


class GammaClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = httpx.Client(timeout=30.0, headers={"User-Agent": "pm5m-bot/0.1"})

    def close(self) -> None:
        self._client.close()

    @http_retry
    def fetch_markets_page(self, limit: int = 100, offset: int = 0, active: bool = True) -> List[dict[str, Any]]:
        url = f"{self._settings.gamma_base}/markets"
        r = self._client.get(url, params={"limit": limit, "offset": offset, "active": str(active).lower()})
        r.raise_for_status()
        data = r.json()
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and "data" in data:
            return list(data["data"])
        return []

    @http_retry
    def fetch_book_json(self, token_id: str) -> dict[str, Any] | None:
        url = f"{self._settings.clob_host}/book"
        r = self._client.get(url, params={"token_id": token_id})
        if not r.is_success:
            return None
        return r.json()
