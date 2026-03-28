export type Direction = "UP" | "DOWN";

export interface BetLogEntry {
  ts: number;
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
  priceUnit: "decimal_0_1";
  secondsSinceWindowStart: number | null;
  warmupWindow: boolean;
  blockReason?: string;
  maxSpread?: number;
  minLiquidity?: number;
}
export type Mode = "SIMULATION" | "LIVE";
export type TradeStatus = "PENDING" | "WIN" | "LOSS";

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
  ts?: number;
  up: number;
  down: number;
  movement?: number;
  btcUsd?: number;
  btcTargetUsd?: number;
}

export interface Prediction {
  prediction: Direction;
  confidence: number;
  ts: number;
  recommendation?: "TRADE" | "NO_TRADE";
  reason?: string;
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
  clobOrderId?: string;
  gtcExitOrderId?: string;
  gtcExitTargetShares?: number;
  gtcProfitLocked?: boolean;
}

export interface BotStatus {
  running: boolean;
  autoTrading: boolean;
  mode: Mode;
  balance: number;
  cooldownMs: number;
  stopLossTriggered: boolean;
  phase: BotPhase;
  phaseReason?: string;
}

export interface TradingState {
  executionMode: Mode;
  executionLabel: "PAPER_ONLY" | "LIVE_ONLY";
  clobAuthenticated: boolean;
  autoDiscoverEnabled: boolean;
  lastBookRefreshMs: number | null;
  /** Always present; use label + flags even before Gamma metadata loads. */
  market: {
    label: string;
    slug: string | null;
    endMs: number | null;
    windowStartMs: number | null;
    secondsToExpiry: number | null;
    windowActive: boolean;
    marketExpired: boolean;
    tokenIdUp: string | null;
    tokenIdDown: string | null;
  };
  books: {
    up: { spread: number; badge: string; detail: string } | null;
    down: { spread: number; badge: string; detail: string } | null;
  };
}

export interface WalletSummary {
  mode: Mode;
  /** Polymarket trading / funder (proxy or EOA). */
  address?: string;
  /** EOA from server `EVM_PRIVATE_KEY` (browser MetaMask should match this for proxy/Safe). */
  signerAddress?: string;
  funderAddress?: string;
  signatureType?: number;
  network?: string;
  connected: boolean;
  /** CLOB collateral balance (USDC), LIVE only */
  polymarketUsdc?: number | null;
}

export interface AuthNonceResponse {
  nonce: string;
  message: string;
}

export interface AuthVerifyResponse {
  token: string;
  address: string;
}

export interface AuthMeResponse {
  authenticated: boolean;
  address?: string;
  userId?: string;
  authType?: "wallet" | "password";
}

export interface PasswordLoginResponse {
  token: string;
  userId: string;
}

export interface MarketOption {
  tokenID: string;
  label: string;
  outcome?: string;
}

export interface GtcExitMetrics {
  postsAttempted: number;
  postsAccepted: number;
  fillLogEvents: number;
  profitLocks: number;
  preResolveCancels: number;
  settleCancels: number;
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

export interface PolymarketAccountSummary {
  connected: boolean;
  address?: string;
  signerAddress?: string;
  funderAddress?: string;
  mode: Mode;
  network?: string;
  polymarketUsdc?: number | null;
  balanceAllowanceRaw?: unknown;
  openOrdersCount: number;
  userTradesCount: number;
}
