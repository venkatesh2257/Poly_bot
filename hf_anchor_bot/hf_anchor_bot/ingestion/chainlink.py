"""Chainlink AggregatorV3 latestRoundData — anchor USD price only."""

from __future__ import annotations

import logging
import os

from web3 import Web3

from hf_anchor_bot.smoke_log import line as smoke_line

log = logging.getLogger(__name__)

# Reuse same Polygon mainnet feeds as the TS bot.
DEFAULT_FEEDS: dict[str, str] = {
    "BTC": "0xc907E116054Ad103354f2D350FD2514433D57F6f",
    "ETH": "0xF9680D99D6C9589E2A93A78A04A279E509205945",
    "SOL": "0x10C8264C0935b3B9870013e057f330Ff3e9C56dC",
    "XRP": "0x785ba89291f676b5386652eB12b30cF361020694",
}

AGGREGATOR_V3_ABI = [
    {
        "constant": True,
        "inputs": [],
        "name": "decimals",
        "outputs": [{"name": "", "type": "uint8"}],
        "type": "function",
    },
    {
        "constant": True,
        "inputs": [],
        "name": "latestRoundData",
        "outputs": [
            {"name": "roundId", "type": "uint80"},
            {"name": "answer", "type": "int256"},
            {"name": "startedAt", "type": "uint256"},
            {"name": "updatedAt", "type": "uint256"},
            {"name": "answeredInRound", "type": "uint80"},
        ],
        "type": "function",
    },
]


class ChainlinkAnchorFeed:
    def __init__(self, asset: str = "BTC", rpc_url: str | None = None, feed_address: str | None = None):
        self.asset = asset.upper()
        self.rpc_url = rpc_url or _resolve_rpc_url()
        addr = feed_address or DEFAULT_FEEDS.get(self.asset)
        if not addr:
            raise ValueError(f"No default Chainlink feed for asset={self.asset}")
        self.feed_address = Web3.to_checksum_address(addr)
        self._w3 = Web3(Web3.HTTPProvider(self.rpc_url))
        self._contract = self._w3.eth.contract(address=self.feed_address, abi=AGGREGATOR_V3_ABI)
        # decimals() deferred to first read — __init__ does not hit the network.
        self._decimals: int | None = None
        self._smoke_logged_first_read = False

    def _decimals_value(self) -> int:
        if self._decimals is None:
            self._decimals = int(self._contract.functions.decimals().call())
        return self._decimals

    def read_anchor(self) -> tuple[float, int]:
        try:
            d = self._decimals_value()
            _rid, ans, _sa, updated_at, _air = self._contract.functions.latestRoundData().call()
            price = float(ans) / (10**d)
            ts_ms = int(updated_at) * 1000
            if not self._smoke_logged_first_read:
                self._smoke_logged_first_read = True
                smoke_line("chainlink", "first anchor read ok price=%.4f asset=%s", price, self.asset)
            return price, ts_ms
        except Exception as e:
            smoke_line("chainlink", "read_anchor failed (will surface to runner retry): %s", e)
            raise


def _resolve_rpc_url() -> str:
    for k in ("POLYGON_RPC_URL", "RPC_URL", "POLYGON_RPC_PROXY_URL", "PROXY_URL"):
        v = os.environ.get(k, "").strip()
        if v:
            return v
    return "https://rpc.ankr.com/polygon"
