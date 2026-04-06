"""Chainlink feed: no RPC during construction (decimals deferred to first read)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from hf_anchor_bot.ingestion.chainlink import ChainlinkAnchorFeed


def test_chainlink_feed_init_does_not_call_decimals():
    decimals_calls = 0

    def track_decimals():
        nonlocal decimals_calls
        decimals_calls += 1
        return 8

    mock_contract = MagicMock()
    mock_contract.functions.decimals.return_value.call.side_effect = track_decimals
    mock_contract.functions.latestRoundData.return_value.call.return_value = (
        0,
        95_000_000_000_000,
        0,
        1,
        0,
    )

    with patch("hf_anchor_bot.ingestion.chainlink.Web3") as MockW3:
        w3_instance = MagicMock()
        w3_instance.eth.contract.return_value = mock_contract
        MockW3.return_value = w3_instance
        MockW3.HTTPProvider.return_value = MagicMock()
        MockW3.to_checksum_address.side_effect = lambda a: a

        ChainlinkAnchorFeed(asset="BTC", rpc_url="http://127.0.0.1:9", feed_address="0x" + "1" * 40)

    assert decimals_calls == 0


def test_first_read_anchor_fetches_decimals():
    mock_contract = MagicMock()
    mock_contract.functions.decimals.return_value.call.return_value = 8
    mock_contract.functions.latestRoundData.return_value.call.return_value = (
        0,
        95_000_000_000_000,
        0,
        1,
        0,
    )

    with patch("hf_anchor_bot.ingestion.chainlink.Web3") as MockW3:
        w3_instance = MagicMock()
        w3_instance.eth.contract.return_value = mock_contract
        MockW3.return_value = w3_instance
        MockW3.HTTPProvider.return_value = MagicMock()
        MockW3.to_checksum_address.side_effect = lambda a: a

        feed = ChainlinkAnchorFeed(asset="BTC", rpc_url="http://127.0.0.1:9", feed_address="0x" + "2" * 40)
        price, _ts = feed.read_anchor()

    # 95_000_000_000_000 / 10^8 = 950_000
    assert abs(price - 950_000.0) < 1.0
    mock_contract.functions.decimals.return_value.call.assert_called()
    mock_contract.functions.latestRoundData.return_value.call.assert_called()
