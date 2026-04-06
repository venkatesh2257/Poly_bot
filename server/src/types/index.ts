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

/** WebSocket `market` message: primary series (first UPDOWN asset, momentum engine) + per-asset spot charts. */
export interface MarketWsPayload {
  primary: MarketPoint[];
  byAsset: Record<string, MarketPoint[]>;
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
}

/** Effective + env defaults for auto size, limits, cooldown, paper stop (runtime overrides via API). */
/** Engine / .env entry strategy union. */
export type EntryStrategyKind =
  | "momentum"
  | "anchor"
  | "market_making"
  | "fair_value_arb"
  | "selective_momentum";

/** Dashboard-selectable strategies (API). */
export type DashboardEntryStrategyId =
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
  /**
   * Compact engine snapshot aligned with CLOB book refresh + signal logic.
   * Lets `/trading-state` polling stay in sync with live APIs when WebSocket is quiet.
   */
  liveEngine: LiveEngineSnapshot;
  /** Same payload as WS `prediction` — REST parity when socket is slow or disconnected. */
  predictionLive: PredictionLiveSnapshot;
  /** Anchor Strategy: book + Chainlink snapshot for dashboard (optional on older servers). */
  anchorStrategy?: AnchorStrategySnapshot;
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
