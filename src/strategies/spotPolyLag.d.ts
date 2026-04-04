/**
 * Minimal typings for spotPolyLag.js (CommonJS `module.exports`).
 */

export interface SpotPolyLagContext {
  clob_client?: { getOrderBook: (marketSlug: string, side: string) => Promise<Record<string, unknown>> } | null;
  coinbase_btc?: () => Promise<number>;
  binance_btc?: () => Promise<number>;
  get_active_btc_5m_market?: () => Record<string, unknown> | null;
  emit_strategy_status?: (strategy: string, payload: Record<string, string | number>) => void;
  can_enter_window?: ((windowKey: string) => boolean) | null;
  check_kill_switch?: () => boolean;
  lag_size?: (tier: string, walletBalance: number) => number;
  place_order?: (req: SpotPolyLagTradeRequest) => Promise<Record<string, unknown> | null | void>;
  hard_settle_trade?: (tradeId: string) => Promise<void>;
  wallet_balance?: number;
  log?: (...args: unknown[]) => void;
  detect_lag?: (spot: number, upProb: number) => LagSignal | null | undefined;
  update_btc_history?: (spot: number) => void;
}

export interface LagSignal {
  exists?: boolean;
  move_pct?: number;
  tier?: string;
  direction?: string;
  edge_pct?: number;
  true_prob?: number;
}

export interface BinanceImbalance {
  ratio: number;
  signal: string;
  valid: boolean;
  bid_vol?: number;
  ask_vol?: number;
}

export interface PolyClobSnapshot {
  valid: boolean;
  best_ask?: number;
  best_bid?: number;
  spread?: number;
  spread_pct?: number;
  depth?: number;
  raw_book?: unknown;
}

export interface SpotPolyLagTradeRequest {
  market_slug: string;
  side: string;
  size: number;
  price?: number;
  order_type?: string;
  strategy?: string;
  prob?: number;
  true_prob?: number;
  edge_pct?: number;
  tier?: string;
  spot_at_entry?: number;
  ob_ratio?: number;
  clob_ask?: number;
  clob_spread?: number;
  price_to_beat?: number;
  reason?: string;
}

interface SpotPolyLagExports {
  configureSpotPolyLagContext: (ctx: Partial<SpotPolyLagContext> | null | undefined) => void;
  connect_binance_ob?: () => Promise<void>;
  get_binance_imbalance: () => BinanceImbalance;
  binance_ob_confirms: (direction: "UP" | "DOWN" | "YES" | "NO", imbalance: BinanceImbalance) => boolean;
  get_poly_clob: (marketSlug: string, direction: string) => Promise<PolyClobSnapshot>;
  poly_clob_valid: (clob: PolyClobSnapshot, direction: string, size: number) => boolean;
  spot_poly_lag_engine: (...args: unknown[]) => void | Promise<void>;
}

declare const spotPolyLag: SpotPolyLagExports;
export = spotPolyLag;
