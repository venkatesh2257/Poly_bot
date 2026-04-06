"""Environment-driven settings: RPC, CLOB, risk, thresholds."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Optional

from dotenv import load_dotenv

load_dotenv()


def _f(name: str, default: float) -> float:
    v = os.getenv(name)
    if v is None or v.strip() == "":
        return default
    return float(v)


def _i(name: str, default: int) -> int:
    v = os.getenv(name)
    if v is None or v.strip() == "":
        return default
    return int(v)


def _b(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).lower() in ("1", "true", "yes")


@dataclass
class Settings:
    # Network / API
    gamma_base: str = field(default_factory=lambda: os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com").rstrip("/"))
    clob_host: str = field(default_factory=lambda: os.getenv("CLOB_HOST", "https://clob.polymarket.com").rstrip("/"))
    data_api_base: str = field(default_factory=lambda: os.getenv("DATA_API_BASE", "https://data-api.polymarket.com").rstrip("/"))
    coinbase_candles_base: str = "https://api.exchange.coinbase.com"

    # Auth (L2 CLOB — set when placing orders)
    poly_api_key: Optional[str] = field(default_factory=lambda: os.getenv("POLY_API_KEY") or None)
    poly_api_secret: Optional[str] = field(default_factory=lambda: os.getenv("POLY_API_SECRET") or None)
    poly_passphrase: Optional[str] = field(default_factory=lambda: os.getenv("POLY_PASSPHRASE") or os.getenv("POLY_API_PASSPHRASE") or None)
    evm_private_key: Optional[str] = field(default_factory=lambda: os.getenv("EVM_PRIVATE_KEY") or None)
    clob_funder: Optional[str] = field(default_factory=lambda: os.getenv("CLOB_FUNDER_ADDRESS") or None)
    chain_id: int = field(default_factory=lambda: _i("CLOB_CHAIN_ID", 137))

    # Scanner
    min_seconds_remaining: int = field(default_factory=lambda: _i("PM5M_MIN_SEC_REMAINING", 60))
    max_seconds_remaining: int = field(default_factory=lambda: _i("PM5M_MAX_SEC_REMAINING", 300))
    prob_threshold: float = field(default_factory=lambda: _f("PM5M_PROB_THRESHOLD", 0.85))
    prob_boost_threshold: float = field(default_factory=lambda: _f("PM5M_PROB_BOOST_THRESHOLD", 0.90))
    max_spread: float = field(default_factory=lambda: _f("PM5M_MAX_SPREAD", 0.12))
    min_liquidity_usd: float = field(default_factory=lambda: _f("PM5M_MIN_LIQUIDITY_USD", 0.0))

    # Risk (PM5M_ACCOUNT_USDC is dry-run-only; see trader.read_account_usdc / runner.run_cycle for live CLOB balance)
    risk_pct_low: float = field(default_factory=lambda: _f("PM5M_RISK_PCT_LOW", 0.005))
    risk_pct_high: float = field(default_factory=lambda: _f("PM5M_RISK_PCT_HIGH", 0.01))
    size_boost_mult_min: float = field(default_factory=lambda: _f("PM5M_SIZE_BOOST_MULT_MIN", 2.0))
    size_boost_mult_max: float = field(default_factory=lambda: _f("PM5M_SIZE_BOOST_MULT_MAX", 3.0))

    # Early exit
    early_exit_move_pct: float = field(default_factory=lambda: _f("PM5M_EARLY_EXIT_MOVE_PCT", 0.10))
    early_exit_window_sec: int = field(default_factory=lambda: _i("PM5M_EARLY_EXIT_WINDOW_SEC", 150))

    dry_run: bool = field(default_factory=lambda: _b("PM5M_DRY_RUN", True))
    log_level: str = field(default_factory=lambda: os.getenv("PM5M_LOG_LEVEL", "INFO"))


def load_settings() -> Settings:
    return Settings()
