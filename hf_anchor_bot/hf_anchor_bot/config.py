"""All bot thresholds in one place (no technical indicators)."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class BotConfig:
    # --- Order book imbalance (persistent, not single snapshot) ---
    imbalance_ratio_threshold: float = 0.56
    """Bid share of top-of-book liquidity above this => bullish imbalance; below (1-this) => bearish."""

    imbalance_persist_updates: int = 5
    """N: consecutive qualifying imbalance snapshots required."""

    # --- Anchor (Chainlink) deviation ---
    anchor_deviation_frac: float = 0.0008
    """Minimum |mid - anchor| / anchor to consider directional edge (e.g. 0.0008 = 0.08%)."""

    # --- Confirmation (never enter on first raw signal) ---
    continuation_lookback_updates: int = 12
    """Window for recent high/low of Polymarket mid."""

    continuation_min_push_frac: float = 0.0003
    """Second push: mid must move further in trade direction by this fraction of anchor."""

    min_net_flow_bias: float = 0.15
    """|buy-sell| / (buy+sell+eps) must exceed this for flow confirmation."""

    flow_lookback_trades: int = 30
    """Trades aggregated for flow direction (ingestion provides slice)."""

    # --- Anti-spoof: sudden liquidity vanishes ---
    spoof_size_mult: float = 4.0
    """Top-of-book size spike >= this * rolling median => tracked."""

    spoof_vanish_next_tick_reset: bool = True
    """If a spoof-sized level disappears next update without trade, reset SETUP progress."""

    # --- Anti-chop ---
    max_book_flip_ratio: float = 0.45
    """If fraction of sign flips in imbalance_sign_window exceeds this, skip new setups."""

    imbalance_sign_window: int = 20

    consolidation_range_frac: float = 0.0005
    """If (max-min mid)/anchor in consolidation_window < this, treat as ranging (no trade)."""

    consolidation_window: int = 25

    # --- Cooldown ---
    cooldown_updates: int = 15
    """Y: updates after exit before new entries."""

    # --- In-trade exits (no stop-loss) ---
    follow_through_max_updates: int = 10
    """X: if price does not expand in favor within this many updates, exit."""

    follow_through_min_expand_frac: float = 0.0002
    """Minimum favorable mid move (fraction of anchor) to count as follow-through."""

    opposing_imbalance_persist: int = 4
    """Opposite imbalance must persist this many updates to exit on flow reversal."""

    absorption_opposing_ratio: float = 0.62
    """Opposing side top liquidity share above this while mid stagnant => absorption."""

    absorption_stagnant_updates: int = 4
    """Mid fails to expand for this many updates while opposing book heavy."""

    max_trade_duration_updates: int = 80
    """Time-based exit if position held this many ticks without expansion."""

    expansion_without_time_exit_frac: float = 0.0004
    """If mid moves this far in favor (fraction of anchor), reset time-exit pressure (optional)."""

    # --- Execution ---
    dry_run: bool = True

    base_position_usdc: float = 100.0
    """Reference notional; soft/hard fractions apply to this."""

    max_slippage_bps: float = 100.0
    """Skip OPEN if executable slippage (vs top-level mid) exceeds this."""

    max_notional_soft: float = 0.5
    """Fraction of base_position_usdc for marginal (soft) confirmations."""

    max_notional_hard: float = 1.0
    """Fraction of base_position_usdc for strong break / continuation (hard) trades."""

    flow_bias_hard_mult: float = 1.35
    """|flow bias| ≥ min_net_flow_bias * this counts as strong flow for hard classification."""

    # --- Time-to-close (5m window default: length 300s) ---
    window_length_sec: int = 300
    """Bucket length (e.g. 300 for BTC 5m)."""

    min_seconds_before_close: int = 20
    """Do not enter when now > window_end - this (too close to expiry)."""

    max_seconds_before_close: int = 120
    """Do not enter when now < window_end - this (too far from expiry)."""

    # --- Book liquidity gates ---
    min_levels: int = 3
    """Minimum distinct price levels per side."""

    min_depth_usdc: float = 100.0
    """Minimum sum(price * size) per side (USDC notional on the book)."""

    # --- Per-window cumulative risk ---
    max_loss_per_window_usdc: float = -50.0
    """Negative cap; if window cumulative marked PnL falls below this, skip new entries."""

    # --- Optional JS-bot veto ---
    min_signal_conf: float = 0.6
    """When js_edge is provided, require js_signal_confidence ≥ this for CONFIRMED."""

    # --- Guard toggles (tune off without code changes) ---
    enable_time_to_close_gate: bool = True
    enable_liquidity_gate: bool = True
    enable_slippage_gate: bool = True
    enable_window_pnl_limp: bool = True
    enable_js_edge_veto: bool = False

    extra: dict = field(default_factory=dict)
    """Hook for asset-specific overrides without changing code."""
