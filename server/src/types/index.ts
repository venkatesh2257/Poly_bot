export type Mode = "SIMULATION" | "LIVE";
export type Direction = "UP" | "DOWN";
export type TradeStatus = "PENDING" | "WIN" | "LOSS";
export type LogLevel = "WIN" | "ERROR" | "SIGNAL" | "TRADE";

export type BotPhase =
  | "STOPPED"
  | "STARTING"
  | "CONFIG_INVALID"
  | "INFRA_HEALTHY"
  | "AUTH_CHECK"
  | "MARKET_DISCOVERY"
  | "BOOK_LOADING"
  | "MARKET_NOT_TRADABLE"
  | "SIGNAL_READY"
  | "RISK_BLOCKED"
  | "EXECUTING"
  | "WAITING_RESOLUTION"
  | "ROLLOVER"
  | "ERROR";

export interface MarketPoint {
  time: string;
  /** Unix ms for ordering / tooltips */
  ts?: number;
  up: number;
  down: number;
  movement: number;
  /** Live BTC/USD spot (exchange REST; not Polymarket’s oracle). */
  btcUsd?: number;
  /** “Price to beat” — first tick after 5m window detection (approximation). */
  btcTargetUsd?: number;
}

export interface Prediction {
  prediction: Direction;
  confidence: number;
  ts: number;
  recommendation: "TRADE" | "NO_TRADE";
  reason: string;
}

export interface Trade {
  id: string;
  time: string;
  market: string;
  price: number;
  amount: number;
  pnl: number;
  status: TradeStatus;
  direction: Direction;
  decisionReason?: string;
  /** Set after CLOB accepts an order (server or browser). */
  clobOrderId?: string;
  /** Post-entry GTC hedge/exit on the opposite outcome token (LIVE only). */
  gtcExitOrderId?: string;
  gtcExitTargetShares?: number;
  gtcProfitLocked?: boolean;
}

export interface Status {
  running: boolean;
  autoTrading: boolean;
  mode: Mode;
  balance: number;
  cooldownMs: number;
  stopLossTriggered: boolean;
  phase: BotPhase;
  phaseReason?: string;
}

/** Rich dashboard payload: market window, book quality, auth hints. */
export interface TradingState {
  executionMode: Mode;
  /** Strong UI label for mode lock. */
  executionLabel: "PAPER_ONLY" | "LIVE_ONLY";
  clobAuthenticated: boolean;
  autoDiscoverEnabled: boolean;
  lastBookRefreshMs: number | null;
  market: {
    label: string;
    slug: string | null;
    endMs: number | null;
    windowStartMs: number | null;
    secondsToExpiry: number | null;
    /** True when endMs is in the future (Gamma end time). */
    windowActive: boolean;
    /** True when window ended — likely stale selection or expired market. */
    marketExpired: boolean;
    tokenIdUp: string | null;
    tokenIdDown: string | null;
  };
  books: {
    up: { spread: number; badge: string; detail: string } | null;
    down: { spread: number; badge: string; detail: string } | null;
  };
}

export interface MarketOption {
  tokenID: string;
  label: string;
  outcome?: string;
}

export interface MarketContext {
  tokenID: string;
  mid: number;
  spread: number;
  liquidity: number;
  /** CLOB best bid / best ask (0–1 decimal share price, not cents). */
  bestBid: number;
  bestAsk: number;
}

/** Structured row for UI “Bet logs” (blocked trades, execution snapshots). */
export interface BetLogEntry {
  ts: number;
  /** Set on new rows; older snapshots may omit (treat as LIVE). */
  tradingMode?: "SIMULATION" | "LIVE";
  outcome: "blocked" | "placed";
  marketTitle: string;
  tokenId: string;
  direction: Direction;
  bestBid: number;
  bestAsk: number;
  mid: number;
  spread: number;
  liquidity: number;
  /** Polymarket CLOB prices are 0–1 decimals; spread = ask − bid in those units. */
  priceUnit: "decimal_0_1";
  secondsSinceWindowStart: number | null;
  /** True when still inside post-rollover warm-up (see MARKET_WARMUP_SEC). */
  warmupWindow: boolean;
  blockReason?: string;
  maxSpread?: number;
  minLiquidity?: number;
}

export interface DirectionalContext {
  up: MarketContext;
  down: MarketContext;
}

export interface GtcExitMetrics {
  postsAttempted: number;
  postsAccepted: number;
  fillLogEvents: number;
  profitLocks: number;
  preResolveCancels: number;
  settleCancels: number;
  /** Sum of (matched/target) at last GTC_FILL log per cycle; divide by fillLogEvents for avg. */
  fillRatioSum: number;
}

export interface Insights {
  totalTrades: number;
  wins: number;
  losses: number;
  noTradeSignals: number;
  marketWinRates: Array<{ market: string; winRate: number; trades: number }>;
  gtcExit: GtcExitMetrics;
}
