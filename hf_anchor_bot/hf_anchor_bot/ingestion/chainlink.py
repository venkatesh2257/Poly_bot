"""Chainlink AggregatorV3 latestRoundData — anchor USD price only."""

from __future__ import annotations

import os

from web3 import Web3

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

    def read_anchor(self) -> tuple[float, int]:
        w3 = Web3(Web3.HTTPProvider(self.rpc_url))
        c = w3.eth.contract(address=self.feed_address, abi=AGGREGATOR_V3_ABI)
        dec = int(c.functions.decimals().call())
        _rid, ans, _sa, updated_at, _air = c.functions.latestRoundData().call()
        price = float(ans) / (10**dec)
        return price, int(updated_at) * 1000


def _resolve_rpc_url() -> str:
    for k in ("POLYGON_RPC_URL", "RPC_URL", "POLYGON_RPC_PROXY_URL", "PROXY_URL"):
        v = os.environ.get(k, "").strip()
        if v:
            return v
    return "https://rpc.ankr.com/polygon"
