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

/** POST /api/mode and POST /api/config — execution flags after sync (server-owned). */
export interface SetModeResponse {
  ok: boolean;
  mode: Mode;
  reason?: string;
  paperTrading?: boolean;
  executeTrades?: boolean;
  paperOnly?: boolean;
  /** Same booleans as paperTrading / executeTrades (API echo). */
  PAPER_TRADING?: boolean;
  EXECUTE_TRADES?: boolean;
  envMode?: string;
}
export type TradeStatus = "PENDING" | "WIN" | "LOSS" | "OPEN" | "CLOSED";

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

export type DashboardOrderbookSource =
  | "native_polymarket"
  | "synthesis"
  | "synthesis_stale_fallback_native";

export type SynthesisChartMode = "native_primary" | "synthesis_overlay" | "native_only";

export type DriftStatusLevel = "ok" | "warn" | "critical";

export type SynthesisFallbackBlockReason =
  | "native_fresh"
  | "synthesis_stale"
  | "drift_too_high"
  | "incomplete_book_match"
  | "synthesis_disabled"
  | "bot_fallback_disabled"
  | "drift_unavailable"
  | "fallback_ok";

export type SynthesisStalenessSlice = {
  stale: boolean;
  ageMs: number | null;
  thresholdMs: number;
  lastUpdateMs: number | null;
  staleReason?: "never_updated" | "age_exceeded";
};

/** Matches server `SynthesisMarketDataHistoryWirePayload` — compact series for charts. */
export interface SynthesisMarketDataHistoryWirePayload {
  maxPoints: number;
  sampleMs: number;
  maxEvents: number;
  t: number[];
  mb: number[];
  lv: Array<0 | 1 | 2>;
  ub: number[];
  ua: number[];
  db: number[];
  da: number[];
  na: Array<number | null>;
  so: Array<number | null>;
  sp: Array<number | null>;
  fb: Array<0 | 1>;
  events: Array<{ t: number; k: string; d?: string }>;
  lastEvent?: { t: number; k: string; d?: string };
}

export interface SynthesisMarketDataHealthPayload {
  history?: SynthesisMarketDataHistoryWirePayload;
  drift: {
    level: DriftStatusLevel;
    maxBps: number;
    comparedAtMs: number | null;
    perOutcome: Array<{
      outcome: "up" | "down";
      bidBps: number;
      askBps: number;
      midBps: number;
      spreadDeltaBps: number;
    }>;
    incomplete: boolean;
    incompleteReason?: string;
  };
  staleness: {
    nativeOrderbook: SynthesisStalenessSlice;
    synthesisOrderbook: SynthesisStalenessSlice;
    synthesisTrades: SynthesisStalenessSlice;
    synthesisPrices: SynthesisStalenessSlice;
  };
  fallbackEligible: boolean;
  fallbackBlockReason: SynthesisFallbackBlockReason;
}

export interface SynthesisTelemetryPayload {
  enabled: boolean;
  orderbookConnected: boolean;
  tradesConnected: boolean;
  dataConnected: boolean;
  subscribedTokenIds: string[];
  conditionId: string | null;
  activeAsset: string | null;
  lastOrderbookMsgMs: number | null;
  lastTradesMsgMs: number | null;
  lastDataMsgMs: number | null;
  stale: boolean;
  dashboardPreferred: boolean;
  botFallbackEnabled: boolean;
  lastError?: string;
}

export interface NormalizedSynthesisTradePayload {
  venue: "polymarket";
  tokenId: string;
  price: number;
  shares: number;
  notionalUsd: number;
  side: "buy" | "sell" | "unknown";
  createdAtMs: number;
}

/** WebSocket `market` payload (server may still send a bare `MarketPoint[]` for older builds). */
export interface MarketWsPayload {
  primary: MarketPoint[];
  byAsset: Record<string, MarketPoint[]>;
  synthesis?: {
    telemetry: SynthesisTelemetryPayload;
    trades: NormalizedSynthesisTradePayload[];
    booksSynthesis: {
      up: {
        tokenID: string;
        mid: number;
        spread: number;
        liquidity: number;
        bestBid: number;
        bestAsk: number;
      } | null;
      down: {
        tokenID: string;
        mid: number;
        spread: number;
        liquidity: number;
        bestBid: number;
        bestAsk: number;
      } | null;
      stale: boolean;
    };
    orderbookSource: DashboardOrderbookSource;
    chartMode: SynthesisChartMode;
    priceOverlayUsd: Array<{ t: number; priceUsd: number }>;
    health?: SynthesisMarketDataHealthPayload;
  };
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
  paper?: {
    missed?: boolean;
    entryVwap?: number;
    markPrice?: number;
    unrealizedPnlUsd?: number;
    exitVwap?: number;
    closeMethod?: string;
  };
  /** From server `getTrades()`: simulated vs CLOB-backed row. */
  executionMode?: "PAPER" | "LIVE";
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
  /** Session env from server (Go LIVE / Switch to PAPER). */
  paperTrading?: boolean;
  paperOnly?: boolean;
  executeTrades?: boolean;
  lastAutoTradeTickMs?: number | null;
  lastAutoTradeDecisionMs?: number | null;
  lastAutoTradeSkipReason?: string | null;
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
  | "momentum"
  | "anchor"
  | "market_making"
  | "fair_value_arb"
  | "selective_momentum";

export type EntryStrategyKind =
  | "momentum"
  | "anchor"
  | "market_making"
  | "fair_value_arb"
  | "selective_momentum";

export interface EntryStrategyState {
  effective: EntryStrategyKind;
  runtimeOverride: DashboardEntryStrategyId | null;
  fromEnv: EntryStrategyKind;
  label: string;
}

export type AnchorCadence = "normal" | "fast" | "off";
export type LiveReadinessLevel = "full" | "partial" | "degraded";

export type AnchorLiveExecutionReason =
  | "DRY_RUN_MODE"
  | "SIMULATION_MODE"
  | "LIVE_EXECUTOR_MISSING"
  | "LIVE_EXECUTOR_DISABLED_BY_CONFIG";

export interface AnchorReadinessSnapshot {
  anchorConfigured: boolean;
  anchorTradingEnabled: boolean;
  anchorFastLaneEnabled: boolean;
  anchorCadence: AnchorCadence;
  anchorBlockReason: string | null;
  anchorDiagnostics: string[];
  anchorStatusSummary: string;
  liveExecutionAvailable: boolean;
  liveExecutionReason: AnchorLiveExecutionReason | null;
  liveExecutionBanner: { indicator: "green" | "yellow"; text: string };
}

export interface LiveReadinessSnapshot {
  level: LiveReadinessLevel;
  summary: string;
}

export interface ExecutionEligibilityWire {
  eligibleStrategies: EntryStrategyKind[];
  blockedReasons: string[];
  selectedEligible: boolean;
  primaryBlockedReason?: string;
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
    /** Alias for `slug` (useful for per-asset UI even when temporary). */
    activeMarketSlug?: string | null;
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
    /** Data source for `oracleSpotUsd`. */
    oracleSource?: "chainlink" | "rtds" | "cache" | null;
    priceToBeatUsd?: number | null;
    diffUsd?: number | null;
    secondsToExpiry?: number | null;
  }>;
  /** Server auto-trade limits (runtime API overrides .env until reset or process restart). */
  riskSettings?: RiskSettingsSnapshot;
  entryStrategy?: EntryStrategyState;
  lagSnipeEnabled?: boolean;
  lagSnipeBanner?: string;
  anchorReadiness?: AnchorReadinessSnapshot;
  liveReadiness?: LiveReadinessSnapshot;
  executionEligibility?: ExecutionEligibilityWire;
  /** CLOB/Gamma/RTDS-aligned snapshot (matches `/api/status` phase when polling). */
  liveEngine?: LiveEngineSnapshot;
  /** Mirrors WS `prediction` for REST clients (newer servers). */
  predictionLive?: Pick<Prediction, "prediction" | "confidence" | "ts" | "recommendation" | "reason">;
  anchorStrategy?: AnchorStrategySnapshot;
  synthesis?: {
    telemetry: SynthesisTelemetryPayload;
    dashboardOrderbookSource: DashboardOrderbookSource;
    recentTrades: NormalizedSynthesisTradePayload[];
    health?: SynthesisMarketDataHealthPayload;
  };
}

export interface AnchorStrategySnapshot {
  envEnabled: boolean;
  runtimeEnabled: boolean;
  effectiveEnabled: boolean;
  selectedAsEntryStrategy?: boolean;
  fallbackEnabled?: boolean;
  stabilityTicks: number;
  ticksRecorded: number;
  lastSignal: {
    shouldTrade: boolean;
    side: "UP" | "DOWN" | null;
    imbalanceScore: number;
    stabilityMet: boolean;
    chainlinkMom: number;
    anchorPrice: number;
    reason: string;
    skipCategory?: string;
  } | null;
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
  lastAutoTradeTickMs?: number | null;
  lastAutoTradeDecisionMs?: number | null;
  lastAutoTradeSkipReason?: string | null;
  discoveryGraceActive?: boolean;
  lastMarketPayloadMs?: number | null;
  lastChartUpdateMs?: number | null;
  lastChartSourceByAsset?: Record<string, string>;
  marketDataHealthy?: boolean;
  marketDataBlockReason?: string | null;
  tradingDiagnostics?: string[];
  anchorLastSkipCategory?: string | null;
  anchorLastSkipReason?: string | null;
  anchorFastLaneEnabled?: boolean;
  anchorUsingNormalCadence?: boolean;
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
