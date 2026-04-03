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

/** WebSocket `market` payload (server may still send a bare `MarketPoint[]` for older builds). */
export interface MarketWsPayload {
  primary: MarketPoint[];
  byAsset: Record<string, MarketPoint[]>;
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
  asset?: string;
  /** CLOB mid (0–1) for UP / DOWN tokens at entry. */
  upPriceAtEntry?: number;
  downPriceAtEntry?: number;
  decisionReason?: string;
  clobOrderId?: string;
  gtcExitOrderId?: string;
  gtcExitTargetShares?: number;
  gtcProfitLocked?: boolean;
  paper?: { missed?: boolean };
}

export interface BotStatus {
  running: boolean;
  autoTrading: boolean;
  mode: Mode;
  balance: number;
  cooldownMs: number;
  stopLossTriggered: boolean;
  olaKillTriggered?: boolean;
  phase: BotPhase;
  phaseReason?: string;
}

export interface RiskSettingsSnapshot {
  entryUsd: number;
  minTrade: number;
  maxTrade: number;
  stopLossUsd: number;
  cooldownMs: number;
  env: {
    entryUsd: number;
    minTrade: number;
    maxTrade: number;
    stopLossUsd: number;
    cooldownMs: number;
  };
  overridesActive: boolean;
}

export type DashboardEntryStrategyId =
  | "ensemble"
  | "momentum"
  | "orderbook"
  | "mean_revert"
  | "chart"
  | "whale_edge"
  | "ola";

export type EntryStrategyKind =
  | "momentum"
  | "contrarian"
  | "orderbook"
  | "mean_revert"
  | "chart"
  | "whale_edge"
  | "ensemble"
  | "ola";

export interface EntryStrategyState {
  effective: EntryStrategyKind;
  runtimeOverride: DashboardEntryStrategyId | null;
  fromEnv: EntryStrategyKind;
  label: string;
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
  /** From server `UPDOWN_ASSETS` (optional for older API responses). */
  updownAssetsConfigured?: string[];
  /** Per asset: auto-trade on/off (server `assetAutoTradeEnabled`). */
  assetAutoTradeEnabled?: Record<string, boolean>;
  updownWindows?: Array<{
    asset: string;
    slug: string;
    label: string;
    upMid?: number | null;
    downMid?: number | null;
    upSpread?: number | null;
    downSpread?: number | null;
    upBadge?: string | null;
    downBadge?: string | null;
    oddsSource?: "gamma" | "clob" | null;
    oracleSpotUsd?: number | null;
    /** Age of the oracle tick used for `oracleSpotUsd` (ms). */
    oracleAgeMs?: number | null;
    priceToBeatUsd?: number | null;
    diffUsd?: number | null;
    secondsToExpiry?: number | null;
  }>;
  /** Server auto-trade limits (runtime API overrides .env until reset or process restart). */
  riskSettings?: RiskSettingsSnapshot;
  entryStrategy?: EntryStrategyState;
  lagSnipeEnabled?: boolean;
  lagSnipeBanner?: string;
  /** CLOB/Gamma/RTDS-aligned snapshot (matches `/api/status` phase when polling). */
  liveEngine?: LiveEngineSnapshot;
  /** Mirrors WS `prediction` for REST clients (newer servers). */
  predictionLive?: Pick<Prediction, "prediction" | "confidence" | "ts" | "recommendation" | "reason">;
}

export interface LiveEngineSnapshot {
  phase: BotPhase;
  phaseReason?: string;
  running: boolean;
  autoTrading: boolean;
  lastBookRefreshMs: number | null;
  secondsSinceBookRefresh?: number | null;
  discoveredSlotCount: number;
  hasLiveMarketData: boolean;
  rtdsConnected: boolean;
  lagSnipeEnabled?: boolean;
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

export interface TradeLogRow {
  id: string;
  timeIso: string;
  asset: string;
  strategy: string;
  side: "UP" | "DOWN";
  prob: number | null;
  entry: number;
  exit: number | null;
  pnl: number;
  status: "WIN" | "LOSS";
}

export interface TradeLogStats {
  total: number;
  wins: number;
  winRate: number;
  pnl: number;
  avgPnl: number;
  bestAsset: string | null;
  bestStrategy: string | null;
}

export interface TradeLogQueryResponse {
  rows: TradeLogRow[];
  stats: TradeLogStats;
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

export interface BoneFilterBlocks {
  highConf: number;
  equilibrium: number;
  longshot: number;
  latency: number;
}

export interface Insights {
  totalTrades: number;
  wins: number;
  losses: number;
  noTradeSignals: number;
  marketWinRates: Array<{ market: string; winRate: number; trades: number }>;
  gtcExit: GtcExitMetrics;
  highConfMidBlocked: number;
  boneEntryFilters: BoneFilterBlocks;
}

export type PingResultRow = {
  id: string;
  label: string;
  url: string;
  ms: number;
  ok: boolean;
  httpStatus: number;
  error?: string;
  note?: string;
};

export type PingResponse = {
  ts: number;
  results: PingResultRow[];
};

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
