export type Mode = "SIMULATION" | "LIVE";
export type Direction = "UP" | "DOWN";

/** Result of `WalletService.placeOrder` (CLOB or simulation). */
export interface ClobPlaceOrderResult {
  ok: boolean;
  success?: boolean;
  orderID: string;
  /** Alias for dashboards / strict null checks */
  orderId?: string | null;
  sizeFilled: number;
  price: number;
  tokenID: string;
  errorMsg?: string;
  clobStatus?: string;
  simulated?: boolean;
}

/** Shared nullable numeric fields (API / snapshots). */
export type NullableNumber = number | null;
/** PAPER rail: PENDING→WIN|LOSS. LIVE rail: OPEN→CLOSED (pnl &lt; 0 = loss). */
export type TradeStatus = "PENDING" | "WIN" | "LOSS" | "OPEN" | "CLOSED";
export type LogLevel = "WIN" | "ERROR" | "SIGNAL" | "TRADE";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  message: string;
}

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

export type DashboardOrderbookSource =
  | "native_polymarket"
  | "synthesis"
  | "synthesis_stale_fallback_native";

export type SynthesisChartMode = "native_primary" | "synthesis_overlay" | "native_only";

/** Telemetry for Synthesis market-data integration (non-execution). */
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

export interface SynthesisStalenessTelemetryPayload {
  nativeOrderbook: {
    stale: boolean;
    ageMs: number | null;
    thresholdMs: number;
    lastUpdateMs: number | null;
    staleReason?: "never_updated" | "age_exceeded";
  };
  synthesisOrderbook: {
    stale: boolean;
    ageMs: number | null;
    thresholdMs: number;
    lastUpdateMs: number | null;
    staleReason?: "never_updated" | "age_exceeded";
  };
  synthesisTrades: {
    stale: boolean;
    ageMs: number | null;
    thresholdMs: number;
    lastUpdateMs: number | null;
    staleReason?: "never_updated" | "age_exceeded";
  };
  synthesisPrices: {
    stale: boolean;
    ageMs: number | null;
    thresholdMs: number;
    lastUpdateMs: number | null;
    staleReason?: "never_updated" | "age_exceeded";
  };
}

export interface SynthesisDriftTelemetryPayload {
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
}

/** Rolling observability — parallel arrays + capped events (WS/REST). */
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

/** Guardrails for Synthesis vs native (dashboard + bot-fallback gating only). */
export interface SynthesisMarketDataHealthPayload {
  drift: SynthesisDriftTelemetryPayload;
  staleness: SynthesisStalenessTelemetryPayload;
  fallbackEligible: boolean;
  fallbackBlockReason: SynthesisFallbackBlockReason;
  /** Populated on WS broadcast; REST may mirror last snapshot. */
  history?: SynthesisMarketDataHistoryWirePayload;
}

/** WebSocket `market` message: primary series (first UPDOWN asset, momentum engine) + per-asset spot charts. */
export interface MarketWsPayload {
  primary: MarketPoint[];
  byAsset: Record<string, MarketPoint[]>;
  /** Optional Synthesis augmentation — omitted when `SYNTHESIS_ENABLED=false`. */
  synthesis?: {
    telemetry: SynthesisTelemetryPayload;
    trades: NormalizedSynthesisTradePayload[];
    booksSynthesis: {
      up: MarketContext | null;
      down: MarketContext | null;
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
  recommendation: "TRADE" | "NO_TRADE";
  reason: string;
}

/** REST parity for `TradingState.predictionLive` (same shape as WS `prediction`). */
export interface PredictionLiveSnapshot {
  prediction: Direction;
  confidence: number;
  ts: number;
  recommendation: "TRADE" | "NO_TRADE";
  reason: string;
}

/** Virtual fills on live CLOB books (SIMULATION); mirrors live sizing/fees/slippage. */
export interface TradePaperLeg {
  missed?: boolean;
  tokenId?: string;
  /** Wall-clock ms when paper entry fill completed (oracle settle min-hold guard). */
  entryFilledAtMs?: number;
  entryVwap?: number;
  entryShares?: number;
  entryCostUsd?: number;
  entryFeesUsd?: number;
  entrySlippageBps?: number;
  entryLatencyMs?: number;
  entryBestBid?: number;
  entryBestAsk?: number;
  /** Last mark for open paper rows (bid or mid per `PAPER_MARK_TO_BID`). */
  markPrice?: number;
  /** Estimated P&amp;L if closed at `markPrice` after exit-fee estimate. */
  unrealizedPnlUsd?: number;
  closeMethod?: "EARLY_EXIT" | "SETTLEMENT_YES" | "SETTLEMENT_NO";
  exitVwap?: number;
  exitProceedsUsd?: number;
  exitFeesUsd?: number;
  exitSlippageBps?: number;
  exitLatencyMs?: number;
  exitPartial?: boolean;
}

export interface Trade {
  id: string;
  time: string;
  market: string;
  /** Polymarket condition id for winner redemption / reclaim after resolution. */
  conditionId?: string;
  price: number;
  amount: number;
  pnl: number;
  status: TradeStatus;
  direction: Direction;
  /** Active Up/Down asset symbol (e.g. BTC, ETH) when known from discovery. */
  asset?: string;
  /** CLOB mid (0–1) for the UP outcome token at entry; pair snapshot when bot opened. */
  upPriceAtEntry?: number;
  /** CLOB mid (0–1) for the DOWN outcome token at entry. */
  downPriceAtEntry?: number;
  /** Session target (price-to-beat) snapshot captured at entry. */
  targetPriceUsdAtEntry?: number;
  /** Oracle spot snapshot captured at entry (for auditing only). */
  spotPriceUsdAtEntry?: number;
  decisionReason?: string;
  /** Set after CLOB accepts an order (server or browser). */
  clobOrderId?: string;
  /** Post-entry GTC hedge/exit on the opposite outcome token (LIVE only). */
  gtcExitOrderId?: string;
  gtcExitTargetShares?: number;
  gtcProfitLocked?: boolean;
  /** Lag Snipe: no auto GTC / live flatten; paper settles at window without simulated exit sell. */
  lagSnipeHold?: boolean;
  /** Paper path: live book simulation metadata (entry/exit). */
  paper?: TradePaperLeg;
  /** PAPER vs LIVE: set when the row is enqueued; `getTrades()` fills missing values via infer. */
  executionMode?: "PAPER" | "LIVE";
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
  /** Runtime session env (after Go LIVE / Switch to PAPER). */
  paperTrading: boolean;
  paperOnly: boolean;
  executeTrades: boolean;
  /** Auto-trade loop observability (mirrors `liveEngine` in `getTradingState`). */
  lastAutoTradeTickMs?: number | null;
  lastAutoTradeDecisionMs?: number | null;
  lastAutoTradeSkipReason?: string | null;
  executionTruth?: ExecutionTruthSnapshot;
  sessionTelemetry?: SessionTelemetrySnapshot;
}

export interface CounterTop {
  reason: string;
  count: number;
}

export interface ExecutionTruthSnapshot {
  lastSignalRecommendation: string | null;
  lastStrategyDecision: string | null;
  lastExecutionAttempt: string | null;
  lastExecutionBlockReason: string | null;
  lastOrderPostedAt: number | null;
  lastOrderId: string | null;
}

export interface SessionTelemetrySnapshot {
  topAutoTradeSkips: CounterTop[];
  topAnchorSkips: CounterTop[];
  topExecutionBlocks: CounterTop[];
  topOrderPostFailures: CounterTop[];
  topFillVerificationFailures: CounterTop[];
  topDiscoveryFailures: CounterTop[];
  topOracleStaleEvents: CounterTop[];
}

/** Effective + env defaults for auto size, limits, cooldown, paper stop (runtime overrides via API). */
/** Engine / .env entry strategy union. */
export type EntryStrategyKind =
  | "momentum"
  | "anchor"
  | "market_making"
  | "fair_value_arb"
  | "selective_momentum"
  | "professional_trader";

/** Dashboard-selectable strategies (API). */
export type DashboardEntryStrategyId =
  | "momentum"
  | "anchor"
  | "market_making"
  | "fair_value_arb"
  | "selective_momentum"
  | "professional_trader";

export interface EntryStrategyState {
  effective: EntryStrategyKind;
  runtimeOverride: DashboardEntryStrategyId | null;
  fromEnv: EntryStrategyKind;
  label: string;
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

export type AnchorCadence = "normal" | "fast" | "off";

export type LiveReadinessLevel = "full" | "partial" | "degraded";

/** Machine codes for why real-chain anchor execution is unavailable. */
export type AnchorLiveExecutionReason =
  | "DRY_RUN_MODE"
  | "SIMULATION_MODE"
  | "LIVE_EXECUTOR_MISSING"
  | "LIVE_EXECUTOR_DISABLED_BY_CONFIG";

/** Normalized anchor readiness for dashboards (observability only). */
export interface AnchorReadinessSnapshot {
  /** `ANCHOR_STRATEGY_ENABLED=true` in environment. */
  anchorConfigured: boolean;
  anchorTradingEnabled: boolean;
  anchorFastLaneEnabled: boolean;
  anchorCadence: AnchorCadence;
  anchorBlockReason: string | null;
  anchorDiagnostics: string[];
  anchorStatusSummary: string;
  /** True when anchor could send real CLOB orders (LIVE + gates + not dry-run). */
  liveExecutionAvailable: boolean;
  /** Why `liveExecutionAvailable` is false when anchor is otherwise enabled. */
  liveExecutionReason: AnchorLiveExecutionReason | null;
  /** Single-line banner for the anchor card (indicator + copy). */
  liveExecutionBanner: { indicator: "green" | "yellow"; text: string };
}

export interface LiveReadinessSnapshot {
  level: LiveReadinessLevel;
  summary: string;
}

/** Whether the selected entry strategy can place auto-trade orders in the current mode (SIM paper vs LIVE CLOB). */
export interface ExecutionEligibilityWire {
  eligibleStrategies: EntryStrategyKind[];
  blockedReasons: string[];
  selectedEligible: boolean;
  /** First entry in `blockedReasons` when non-empty; for dashboard copy. */
  primaryBlockedReason?: string;
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
  /** From `UPDOWN_ASSETS` / `UPDOWN_ASSET` in server `.env`. */
  updownAssetsConfigured: string[];
  /**
   * Per configured asset: whether **auto-trading** may enter that market (round-robin respects only enabled).
   * Manual trades are unchanged. Omitted keys default to true until toggled.
   */
  assetAutoTradeEnabled: Record<string, boolean>;
  /** Gamma-resolved 5m windows (parallel markets). Odds/oracle aligned with Polymarket (Gamma + RTDS). */
  updownWindows: Array<{
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
    /** `gamma` = Gamma outcomePrices (same as site headline); else CLOB mid. */
    oddsSource?: "gamma" | "clob" | null;
    /** Polymarket RTDS Chainlink (BTC/ETH/SOL/XRP) or Binance (DOGE). */
    oracleSpotUsd?: number | null;
    /** Age of the oracle tick used for `oracleSpotUsd` (ms). */
    oracleAgeMs?: number | null;
    /** Data source for `oracleSpotUsd`. */
    oracleSource?: "chainlink" | "rtds" | "cache" | null;
    /** Gamma eventMetadata or RTDS snapshot at window open. */
    priceToBeatUsd?: number | null;
    diffUsd?: number | null;
    /** Per-market expiry; falls back in UI to primary `market.secondsToExpiry`. */
    secondsToExpiry?: number | null;
  }>;
  riskSettings: RiskSettingsSnapshot;
  entryStrategy: EntryStrategyState;
  /** Dashboard toggle: isolated BTC 5m last-30s snipe; disables auto-exit (GTC + LIVE flatten). */
  lagSnipeEnabled: boolean;
  lagSnipeBanner?: string;
  /** Anchor env/runtime/cadence — use instead of raw `tradingDiagnostics` tokens for anchor. */
  anchorReadiness: AnchorReadinessSnapshot;
  /** Overall live-trading readiness vs connectivity (anchor may be partial when env disables it). */
  liveReadiness: LiveReadinessSnapshot;
  /** True when the selected strategy can execute; blockedReasons explain startup/signal gaps. */
  executionEligibility: ExecutionEligibilityWire;
  executionTruth?: ExecutionTruthSnapshot;
  sessionTelemetry?: SessionTelemetrySnapshot;
  /**
   * Compact engine snapshot aligned with CLOB book refresh + signal logic.
   * Lets `/trading-state` polling stay in sync with live APIs when WebSocket is quiet.
   */
  liveEngine: LiveEngineSnapshot;
  /** Same payload as WS `prediction` — REST parity when socket is slow or disconnected. */
  predictionLive: PredictionLiveSnapshot;
  /** Anchor Strategy: book + Chainlink snapshot for dashboard (optional on older servers). */
  anchorStrategy?: AnchorStrategySnapshot;
  /** Synthesis market-data provider (dashboard / optional bot fallback) — omitted when disabled. */
  synthesis?: {
    telemetry: SynthesisTelemetryPayload;
    dashboardOrderbookSource: DashboardOrderbookSource;
    /** Recent venue trades from Synthesis (truncated). */
    recentTrades: NormalizedSynthesisTradePayload[];
    health?: SynthesisMarketDataHealthPayload;
  };
}

/** Polymarket Anchor Strategy — bid dominance + Chainlink momentum (server-driven). */
export interface AnchorStrategySnapshot {
  envEnabled: boolean;
  runtimeEnabled: boolean;
  /** True only when Anchor is the selected entry strategy and env+runtime toggles allow it. */
  effectiveEnabled: boolean;
  /** ENTRY_STRATEGY / dashboard override is `anchor`. */
  selectedAsEntryStrategy: boolean;
  /** `ANCHOR_ALLOW_FALLBACK=true`: Anchor may run after non-anchor auto path skips. */
  fallbackEnabled: boolean;
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

/** Feed-aligned status (books, discovery, RTDS) bundled for dashboard polling. */
export interface LiveEngineSnapshot {
  phase: BotPhase;
  phaseReason?: string;
  running: boolean;
  autoTrading: boolean;
  lastBookRefreshMs: number | null;
  /** Seconds since `lastBookRefreshMs` (server clock); null if never refreshed. */
  secondsSinceBookRefresh: number | null;
  discoveredSlotCount: number;
  hasLiveMarketData: boolean;
  rtdsConnected: boolean;
  lagSnipeEnabled: boolean;
  lastAutoTradeTickMs?: number | null;
  lastAutoTradeDecisionMs?: number | null;
  lastAutoTradeSkipReason?: string | null;
  discoveryGraceActive?: boolean;
  /** Wall-clock ms of last WS `market` / `buildMarketWsPayload` broadcast. */
  lastMarketPayloadMs?: number | null;
  /** Wall-clock ms of last primary chart point append. */
  lastChartUpdateMs?: number | null;
  /** Chart-only: last resolved layer per asset (e.g. `rest_coinbase_binance`, `rtds`). */
  lastChartSourceByAsset?: Record<string, string>;
  marketDataHealthy?: boolean;
  marketDataBlockReason?: string | null;
  /** General engine diagnostics (human-readable; not anchor-specific). */
  tradingDiagnostics?: string[];
  /** From `lastAnchorSignal` after anchor evaluation (best signal for why anchor did not enter). */
  anchorLastSkipCategory?: string | null;
  anchorLastSkipReason?: string | null;
  anchorFastLaneEnabled?: boolean;
  /** True when anchor is selected and optional ~250ms fast lane is off (5s auto-trade cadence only). */
  anchorUsingNormalCadence?: boolean;
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

/** Entry-only BONE_* filter blocks (SIM + LIVE); execution/exits unchanged. */
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
  /** Trades blocked by SIGNAL_MODE=highConf when mid & conf×mid gates fail. */
  highConfMidBlocked: number;
  boneEntryFilters: BoneFilterBlocks;
}

/** Persisted adaptive learning snapshot (`config/adaptiveConfig.json`). */
export interface AdaptiveConfigFile {
  lastRunMs: number;
  hint?: string;
  demoSample?: number;
  liveSample?: number;
  demoPnlSum?: number;
  livePnlSum?: number;
  observedMaxSpread?: number;
}

export type AlertSeverity = "info" | "warn" | "error";

export interface AlertEvent {
  id: string;
  severity: AlertSeverity;
  source: string;
  message: string;
  ts: number;
}

export interface ApiHealthResultRow {
  name: string;
  ok: boolean;
  ms?: number;
  detail?: string;
}

export interface ApiHealthSnapshot {
  ts: number;
  ok: boolean;
  results: ApiHealthResultRow[];
}
