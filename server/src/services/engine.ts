import { randomUUID } from "node:crypto";
import type { StrategyEvaluation } from "../strategy/strategyTypes.js";
import type {
  BetLogEntry,
  DashboardEntryStrategyId,
  Direction,
  DirectionalContext,
  BotPhase,
  EntryStrategyKind,
  EntryStrategyState,
  GtcExitMetrics,
  Insights,
  LogLevel,
  MarketContext,
  MarketOption,
  MarketPoint,
  MarketWsPayload,
  NormalizedSynthesisTradePayload,
  SynthesisMarketDataHealthPayload,
  DriftStatusLevel,
  Prediction,
  RiskSettingsSnapshot,
  Status,
  Trade,
  TradeStatus,
  TradingState,
  AnchorStrategySnapshot,
  ClobPlaceOrderResult
} from "../types/index.js";
import {
  executePaperLimitBuyOrder,
  normalizeRawOrderBook,
  paperEntrySlippageFraction,
  paperTakerFeeRate,
  simulatePaperMarketSell
} from "./paperExecution.js";
import { logRealSettlement, settleReal } from "./polymarketSettlement.js";
import {
  anchorEntryPreflight,
  anchorShouldExitDownOnMomentum,
  anchorShouldExitUpOnMomentum,
  evaluateAnchorStrategy,
  loadAnchorConfigFromEnv,
  type AnchorSignal,
  type OrderBookSnapshot
} from "../strategies/anchorStrategy.js";
import {
  evaluateOracleTrendBufferGate,
  getChainlinkPriceHistoryBuffer,
  getChainlinkPriceHistoryBufferForAsset,
  getOracleAgeMsForTrend
} from "../realtime.js";
import {
  classifyOracleStale,
  evaluateOracleDirectionFlipGate,
  evaluateOracleWindowMinTrendGate,
  freshOracleWindowState,
  loadOracleGateEnv,
  updateOracleWindowStateFromChainlink,
  type OracleWindowState
} from "./oracleWindowGate.js";
import { runConnectivityPings } from "./apiPings.js";
import { fetchBtcUsd } from "./btcPriceFeed.js";
import { fetchUsdSpot } from "./cryptoPriceFeed.js";
import { fetchGammaDisplayStats } from "./gammaDisplayStats.js";
import { ChainlinkFeedService, type ChainlinkUsdPriceTick } from "./chainlinkFeed.js";
import { PolymarketRtdsFeed } from "./polymarketRtdsFeed.js";
import {
  applyRiskToProcessEnv,
  resolveServerDotEnvPath,
  writeRiskSettingsToDotEnv,
  type RiskEnvValues
} from "./envFile.js";
import { WalletService } from "./wallet.js";
import {
  executeTradesEnv,
  paperOnlyEnv,
  paperTradingEnv,
  syncExecutionEnvForUiMode
} from "./executionFlags.js";
import { BinanceAggTradeFeed } from "./binanceAggTradeFeed.js";
import {
  loadBotFiltersConfig,
  tradeAssetAllowedByConfig,
  bookMidSpread01,
  type BotFiltersConfig
} from "./botFiltersConfig.js";
import {
  fetchLastFiveClosed1mBtcUsdt,
  fetchLastFiveClosed1mEthUsdt,
  type KlineOhlc
} from "./binance1mKlines.js";
import {
  candleSignalFromFive,
  lagSnipeCalcSizeFromDepth,
  lagSnipeConfirmationsRequired,
  lagSnipeDirectionFromUpProb,
  lagSnipeInWindow,
  lagSnipeLiquidityConfirmation,
  lagSnipeMaxSecondsLeft,
  lagSnipeMinProb,
  lagSnipePremiumDirectionFromOracleDiff,
  lagSnipeSrOk
} from "./lagSnipeStrategy.js";
import { isPolymarketCryptoUpDown5mWindow, polymarket5mWindowKey } from "../strategy/polymarket5mCrypto.js";
import {
  evaluatePolymarket5mFairValueArb,
  loadPolymarket5mFairValueArbConfigFromEnv
} from "./fairValueArbStrategy.js";
import {
  evaluatePolymarket5mMarketMaking,
  loadPolymarket5mMarketMakingConfigFromEnv
} from "./marketMakingStrategy.js";
import {
  evaluatePolymarket5mSelectiveMomentum,
  loadPolymarket5mSelectiveMomentumConfigFromEnv
} from "./selectiveMomentumStrategy.js";
import { loadSynthesisConfigFromEnv, type SynthesisRuntimeConfig } from "./synthesisConfig.js";
import { SynthesisMarketDataHub } from "./synthesisHub.js";
import { resolveDashboardChartMode, resolveDashboardOrderbookSource } from "./marketDataProvider.js";
import {
  loadSynthesisGuardrailConfigFromEnv,
  computeNativeSynthesisDrift,
  driftResultToTelemetryPayload,
  computeNativeOrderbookStale,
  computeAgeStale,
  evaluateSynthesisBotFallbackEligibility
} from "./marketDataHealth.js";
import { SynthesisMarketDataHistory } from "./marketDataHistory.js";

const START_BALANCE = Number(process.env.START_BALANCE ?? 1000);
/** Default caps; effective values read inside trade() after dotenv (engine imports before index loads .env). */
const DEFAULT_MAX_SPREAD = 0.15;
const DEFAULT_MIN_LIQUIDITY = 80;
/** Polymarket-style ~4s cadence; 75 pts ≈ last 5 minutes. */
const CHART_POLL_MS = Number(process.env.CHART_POLL_MS ?? 4000);
const CHART_MAX_POINTS = Number(process.env.CHART_MAX_POINTS ?? 75);
/** USD short-term volatility cap for NO_TRADE (live tick-to-tick deltas). */
const PREDICTION_VOLATILITY_USD = Number(process.env.PREDICTION_VOLATILITY_USD ?? 15);
/** Auto-trade focuses one asset per wall-clock bucket (default 300s = 5m), in this order. */
const UPDOWN_ROTATION_ASSETS = ["BTC", "ETH", "SOL", "XRP"] as const;

/** Read in methods that use env (after dotenv in index). */
function envNum(key: string, fallback: number) {
  return Number(process.env[key] ?? fallback);
}

function gtcExitEnabled() {
  return String(process.env.GTC_EXIT_ENABLED ?? "true").toLowerCase() !== "false";
}

/** After a BUY fill, market-SELL the same outcome token so Polymarket position matches the dashboard. */
function liveCloseEntryOnFill() {
  return String(process.env.LIVE_CLOSE_ENTRY_ON_FILL ?? "true").toLowerCase() !== "false";
}

/** Optional: `highConf` requires mid ≥ threshold OR (confidence×mid) ≥ threshold before book checks. */
function signalModeHighConf() {
  return String(process.env.SIGNAL_MODE ?? "").toLowerCase() === "highconf";
}

function highConfMidThreshold() {
  const t = envNum("HIGH_CONF_MID_THRESHOLD", 0.92);
  if (!Number.isFinite(t) || t <= 0 || t > 1) return 0.92;
  return t;
}

/**
 * When true (default): at scheduled window-end settlement, redeem at $1/$0 per share from the same UP/DOWN vs
 * price-to-beat rule as the market (not a mid-quote shortcut), with exit fees applied. Set false to use only
 * simulated book SELL at timer (can hit empty bids — retries instead of instant full loss).
 */
function paperBinarySettleEnabled() {
  return String(process.env.PAPER_BINARY_SETTLE ?? "true").toLowerCase() !== "false";
}

/** Min ms after paper entry fill before oracle-binary settlement (stops same-second settle vs stale PTB). Default 5m. */
function paperOracleMinHoldMs() {
  const n = envNum("PAPER_ORACLE_MIN_HOLD_MS", 300_000);
  return Number.isFinite(n) && n >= 0 ? n : 300_000;
}

/**
 * Global min ms remaining before Gamma window end to allow paper oracle-binary entries (ORACLE_TOO_CLOSE).
 * Precedence: MIN_MS_TO_WINDOW_END → PAPER_ENTRY_MIN_MS_TO_WINDOW_END → default (tuned for more usable window vs legacy 60s).
 */
function minMsToWindowEndGlobal(): number {
  const primary = Number(process.env.MIN_MS_TO_WINDOW_END);
  if (Number.isFinite(primary) && primary >= 0) return primary;
  const legacy = Number(process.env.PAPER_ENTRY_MIN_MS_TO_WINDOW_END);
  if (Number.isFinite(legacy) && legacy >= 0) return legacy;
  return 20_000;
}

/** True when active slot is BTC and Gamma window length ≈ 300s (5m up/down). */
function isBtcFiveMinuteWindow(
  asset: string | null | undefined,
  meta: { endDateIso: string; windowStartSec?: number } | null | undefined
): boolean {
  const a = String(asset ?? "")
    .trim()
    .toUpperCase();
  if (a !== "BTC" || !meta?.endDateIso) return false;
  const end = new Date(meta.endDateIso).getTime();
  if (Number.isNaN(end)) return false;
  const ws = meta.windowStartSec;
  if (ws == null || !Number.isFinite(ws)) return false;
  const durMs = end - ws * 1000;
  return durMs >= 285_000 && durMs <= 315_000;
}

/**
 * Effective threshold for ORACLE_TOO_CLOSE: BTC 5m may use MIN_MS_TO_WINDOW_END_BTC when set; else global.
 */
function resolveMinMsToWindowEndForOracleClose(
  asset: string | null | undefined,
  meta: { endDateIso: string; windowStartSec?: number } | null | undefined
): { minGlobal: number; minEffective: number; effectiveSource: "GLOBAL" | "BTC_OVERRIDE" } {
  const minGlobal = minMsToWindowEndGlobal();
  if (!isBtcFiveMinuteWindow(asset, meta)) {
    return { minGlobal, minEffective: minGlobal, effectiveSource: "GLOBAL" };
  }
  const btc = Number(process.env.MIN_MS_TO_WINDOW_END_BTC);
  if (Number.isFinite(btc) && btc >= 0) {
    return { minGlobal, minEffective: btc, effectiveSource: "BTC_OVERRIDE" };
  }
  return { minGlobal, minEffective: minGlobal, effectiveSource: "GLOBAL" };
}

/** Skip auto-entries when less than this many ms remain in the Gamma window (last-2m style guard). Default 120s. */
function lateEntryMinMsToWindowEnd() {
  const n = envNum("LATE_ENTRY_MIN_MS_TO_WINDOW_END", 120_000);
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
}

/** Min samples in per-asset oracle buffer before trend is valid for auto-trade gates. Default 2. */
function oracleTrendMinSamples() {
  const n = envNum("ORACLE_TREND_MIN_SAMPLES", 2);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 2;
}

/** Max age (ms) of newest buffer sample for oracle trend to be valid. Default 20s. */
function oracleTrendMaxSampleAgeMs() {
  const n = envNum("ORACLE_TREND_MAX_SAMPLE_AGE_MS", 20_000);
  return Number.isFinite(n) && n >= 500 ? n : 20_000;
}

function simKellySizingEnabled() {
  return String(process.env.KELLY_SIZING ?? "true").toLowerCase() !== "false";
}

function clampGtcPrice(): number {
  const target = envNum("GTC_EXIT_PRICE", 0.95);
  const min = envNum("GTC_PRICE_MIN", 0.9);
  const max = envNum("GTC_PRICE_MAX", 0.98);
  return Math.min(max, Math.max(min, target));
}

function gtcFillLockPct(): number {
  const p = envNum("GTC_FILL_LOCK_PCT", 80) / 100;
  if (!Number.isFinite(p) || p <= 0 || p > 1) return 0.8;
  return p;
}

function boneEnvTrue(key: string): boolean {
  return String(process.env[key] ?? "").toLowerCase() === "true";
}

/** Exact high-conf scalping defaults (60% depth + 0.60 conf×mid floor + mid≥HIGH_CONF_MID_THRESHOLD OR). */
const BONE_SCALP_MIN_CONF_PCT = 96;
const BONE_SCALP_MIN_CONF_TIMES_MID = 0.6;
const BONE_SCALP_WHALE_FRAC = 0.6;

/** Parsed from `ENTRY_STRATEGY`. Empty or legacy/removed values default to `momentum` (with optional warn). */
function parseEnvEntryStrategy(): EntryStrategyKind {
  const raw = process.env.ENTRY_STRATEGY;
  const s = String(raw == null || String(raw).trim() === "" ? "momentum" : raw).toLowerCase().trim();
  if (s === "anchor" || s === "book_imbalance") return "anchor";
  if (s === "momentum") return "momentum";
  if (s === "market_making" || s === "mm") return "market_making";
  if (s === "fair_value_arb" || s === "fva") return "fair_value_arb";
  if (s === "selective_momentum" || s === "sm") return "selective_momentum";
  if (raw != null && String(raw).trim() !== "") {
    console.warn(
      `[ENTRY_STRATEGY] Unknown value "${String(raw).trim()}" — using momentum. Valid: momentum, anchor, market_making, fair_value_arb, selective_momentum.`
    );
  }
  return "momentum";
}

function parseDashboardEntryStrategyId(raw: unknown): DashboardEntryStrategyId | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "momentum") return "momentum";
  if (s === "anchor" || s === "book_imbalance") return "anchor";
  if (s === "market_making" || s === "mm") return "market_making";
  if (s === "fair_value_arb" || s === "fva") return "fair_value_arb";
  if (s === "selective_momentum" || s === "sm") return "selective_momentum";
  return null;
}

/** How momentum is measured when ENTRY_STRATEGY=momentum (ignored when ENTRY_STRATEGY=anchor). */
type MomentumModeKind = "ticks" | "weighted" | "from_open";

function momentumMode(): MomentumModeKind {
  const s = String(process.env.MOMENTUM_MODE ?? "ticks").toLowerCase();
  if (s === "weighted" || s === "w") return "weighted";
  if (s === "from_open" || s === "window" || s === "open") return "from_open";
  return "ticks";
}

function tradeRowIsOpen(status: TradeStatus): boolean {
  return status === "PENDING" || status === "OPEN";
}

function tradeRowInsightWin(t: Trade): boolean {
  return t.status === "WIN" || (t.status === "CLOSED" && Number(t.pnl ?? 0) > 0);
}

function tradeRowInsightLoss(t: Trade): boolean {
  return t.status === "LOSS" || (t.status === "CLOSED" && Number(t.pnl ?? 0) <= 0);
}

/** In-memory only: join ENTRY_TIME_BTC_5M → settlement for MIN_MS_TO_WINDOW_END_BTC tuning. */
type Btc5mAutoEntryContext = {
  windowSec: number;
  asset: string;
  direction: Direction;
  trade_type: string;
  ms_before_window_end: number;
  signalPercent: number;
  entryPrice: number;
  createdAtMs: number;
  /** Optional lifecycle hint for debugging (e.g. orphaned TTL cleanup). */
  lastSeenState?: string;
};

const BTC_5M_ENTRY_BUCKET_KEYS = ["0-5s", "5-8s", "8-12s", "12-20s", ">20s"] as const;
type Btc5mEntryBucketKey = (typeof BTC_5M_ENTRY_BUCKET_KEYS)[number];

function btc5mEntryBucketForMsBeforeEnd(msBeforeWindowEnd: number): Btc5mEntryBucketKey {
  const s = msBeforeWindowEnd / 1000;
  if (s < 5) return "0-5s";
  if (s < 8) return "5-8s";
  if (s < 12) return "8-12s";
  if (s < 20) return "12-20s";
  return ">20s";
}

function btc5mEntryBucketRollupEveryN(): number {
  const n = Number(process.env.BTC_5M_ENTRY_BUCKET_ROLLUP_EVERY ?? 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
}

function btc5mEntryContextTtlMs(): number {
  const n = Number(process.env.BTC_5M_ENTRY_CONTEXT_TTL_MS ?? 900_000);
  return Number.isFinite(n) && n >= 60_000 ? Math.floor(n) : 900_000;
}

function btc5mFreshBucketStats(): Record<Btc5mEntryBucketKey, { trades: number; wins: number; pnlSum: number }> {
  return {
    "0-5s": { trades: 0, wins: 0, pnlSum: 0 },
    "5-8s": { trades: 0, wins: 0, pnlSum: 0 },
    "8-12s": { trades: 0, wins: 0, pnlSum: 0 },
    "12-20s": { trades: 0, wins: 0, pnlSum: 0 },
    ">20s": { trades: 0, wins: 0, pnlSum: 0 }
  };
}

export class TradingEngine {
  private wallet = new WalletService();
  private running = false;
  private autoTrading = false;
  private balance = START_BALANCE;
  private trades: Trade[] = [];
  private marketData: MarketPoint[] = [];
  /** Per-asset spot vs target for UI charts (same cadence as primary series). */
  private assetSpotSeries = new Map<string, MarketPoint[]>();
  private assetSpotChartWindowKey = new Map<string, string>();
  private phase: BotPhase = "STOPPED";
  private phaseReason?: string;
  /**
   * When true, the backend engine will generate trade recommendations + pending trades,
   * but it will not post live orders itself. Browser wallets (MetaMask) are expected
   * to execute orders externally.
   */
  private externalExecution = false;
  private prediction: Prediction = {
    prediction: "UP",
    confidence: 96,
    ts: Date.now(),
    recommendation: "TRADE",
    reason: "Warm start"
  };
  /** Cooldown keyed by Gamma slug (separate 5m markets can trade in parallel). */
  private lastTradeAtBySlug = new Map<string, number>();
  /** Last `AUTO_TRADE_ROTATION_SEC` bucket we logged `ASSET_DEBUG` for (throttle). */
  private lastAssetDebugBucket: number | null = null;
  /** Multi-asset: last time we forced rotation among `enabledIndices` (see `ROTATION_FORCE_MS`). */
  private lastMultiAssetForcedRotateMs = Date.now();
  private multiAssetForcedCursor = 0;
  private stopLossTriggered = false;
  private noTradeSignals = 0;
  private markets: MarketOption[] = [
    { tokenID: "sim-btc-up", label: "BTC 5s UP", outcome: "UP" },
    { tokenID: "sim-btc-down", label: "BTC 5s DOWN", outcome: "DOWN" },
    { tokenID: "sim-eth-up", label: "ETH 5s UP", outcome: "UP" },
    { tokenID: "sim-eth-down", label: "ETH 5s DOWN", outcome: "DOWN" },
    { tokenID: "sim-sol-up", label: "SOL 5s UP", outcome: "UP" },
    { tokenID: "sim-sol-down", label: "SOL 5s DOWN", outcome: "DOWN" },
    { tokenID: "sim-xrp-up", label: "XRP 5s UP", outcome: "UP" },
    { tokenID: "sim-xrp-down", label: "XRP 5s DOWN", outcome: "DOWN" }
  ];
  private selectedMarket: MarketOption = this.markets[0];
  private marketContext: MarketContext = {
    tokenID: "sim-btc-up",
    mid: 0.5,
    spread: 0.02,
    liquidity: 1500,
    bestBid: 0.49,
    bestAsk: 0.51
  };
  private directionalContext: DirectionalContext | null = null;
  /** Per-asset UP/DOWN book snapshot (all discovered slots), updated with the 4s refresh. */
  private multiSlotBooks: Record<
    string,
    {
      up: { mid: number; spread: number; badge: string };
      down: { mid: number; spread: number; badge: string };
    }
  > | null = null;
  private betLogs: BetLogEntry[] = [];
  private lastBookRefreshMs: number | null = null;
  /** Tracks 5m window (Gamma slug time or local 5m bucket in SIM). */
  private lastTrackedWindowKey: string | null = null;
  private btcTargetUsd: number | null = null;
  /** Rate-limited runtime health logging (RTDS/oracle/cache + positions). */
  private lastRuntimeHealthLogMs: number | null = null;
  /** Throttle `[EXECUTION] Mode=LIVE …` in `runAutoTradeOnce` (anchor fast-lane tick is sub-second). */
  private lastLiveExecEnvLogMs = 0;
  /** When Chainlink never yields a fresh tick, remind about RPC env vars. */
  private chainlinkMissingStreak = 0;
  private lastChainlinkRpcReminderMs: number | null = null;
  /** Throttle `[ORACLE][SOURCE]` logs: only when source/reason/window changes (not every book refresh). */
  private lastOracleSourceLogKeyByAsset = new Map<string, string>();
  /** Per UPDOWN asset: window key + spot at first tick in that window (BONE_LATENCY on non-BTC). */
  private spotWindowByAsset = new Map<string, { windowKey: string; openUsd: number }>();
  private lastSpotUsdByAsset = new Map<string, number>();

  /** Polymarket RTDS — Chainlink/Binance feeds used on polymarket.com for crypto Up/Down. */
  private polymarketRtds = new PolymarketRtdsFeed();
  /** Optional Synthesis (synthesis.trade) market-data hub — never used for order placement. */
  private synthesisHub: SynthesisMarketDataHub | null = null;
  private synthesisRuntimeConfig: SynthesisRuntimeConfig = loadSynthesisConfigFromEnv();
  private lastSynthFallbackLogMs = 0;
  /** Throttle `[SYNTHESIS]` guardrail logs (drift / stale / fallback). */
  private lastSynthHealthLogKey = "";
  private lastSynthDriftGuardLogMs = 0;
  private lastSynthDriftLevel: DriftStatusLevel = "ok";
  private lastSynthStalenessSig = "";
  private lastSynthAnyStale = false;
  private lastSynthFbBlockReason = "";
  private readonly synthesisMarketDataHistory = new SynthesisMarketDataHistory();
  /** On-chain Chainlink BTC/USD (authoritative) oracle + staleness protection. */
  private chainlinkFeed = new ChainlinkFeedService();
  /** Cached latest Chainlink tick; used as “oracle spot” for multi-asset strike/oracle. */
  private chainlinkUsdByAsset = new Map<string, ChainlinkUsdPriceTick>();
  /** Wall-clock time of last successful Chainlink RPC tick per asset (canonical freshness with on-chain `updatedAt`). */
  private chainlinkLastSuccessfulFetchMs = new Map<string, number>();
  /** Per-asset 5m window oracle strike / flip / strike-based trend (BTC/ETH/SOL/XRP). */
  private oracleWindowStateByAsset = new Map<string, OracleWindowState>();
  private lastOracleWindowLogKeyByAsset = new Map<string, string>();
  private lastChainlinkLiveLogKeyByAsset = new Map<string, string>();
  private chainlinkInvalidAnswerTsWarned = new Set<string>();
  private gammaDisplayByAsset = new Map<
    string,
    { up: number; down: number; priceToBeat?: number; updatedMs: number }
  >();
  private priceToBeatByAsset = new Map<string, number>();
  private oracleWindowTrackedByAsset = new Map<string, number>();
  /** Binance spot @aggTrade — used by lag snipe / shared diagnostics. */
  private binanceAgg = new BinanceAggTradeFeed();
  /** Lag Snipe mode: BTC+ETH, last N seconds, 1m candles; disables GTC + live auto-flatten. */
  private lagSnipeEnabled = false;
  private lagSnipeKlinesCache:
    | {
        asset: "BTC" | "ETH";
        candles: KlineOhlc[];
        fetchedAt: number;
      }
    | null = null;
  private lagSnipeKlineTimer: ReturnType<typeof setInterval> | null = null;
  /** Per UPDOWN asset: allow auto-trader to rotate into this market (default true). */
  private assetAutoTradeEnabled = new Map<string, boolean>();

  /** Runtime overrides (API); unset fields fall back to process.env. */
  private riskOverrides: Partial<{
    entryUsd: number;
    minTrade: number;
    maxTrade: number;
    stopLossUsd: number;
    cooldownMs: number;
  }> = {};

  /** Runtime override from dashboard API; null = follow `ENTRY_STRATEGY` in .env. */
  private entryStrategyRuntime: DashboardEntryStrategyId | null = null;

  private gtcMetrics: GtcExitMetrics = {
    postsAttempted: 0,
    postsAccepted: 0,
    fillLogEvents: 0,
    profitLocks: 0,
    preResolveCancels: 0,
    settleCancels: 0,
    fillRatioSum: 0
  };

  /** Count of entries blocked by highConf mid gate (replay / stats). */
  private highConfMidBlocked = 0;

  /** BONE_* optional entry filters — blocked counts for replay / insights. */
  private boneHighConfBlocked = 0;
  private boneEqBlocked = 0;
  private boneLongshotBlocked = 0;
  private boneLatencyBlocked = 0;

  /** Stops the 50ms GTC fill / pre-resolve monitor loop. */
  private stopGtcMonitor: (() => void) | null = null;
  /** Per-trade settle retry timer guard to avoid duplicate loops/log spam. */
  private settleRetryTimerByTradeId = new Map<string, ReturnType<typeof setTimeout>>();
  /** Paper early-exit: retry simulated market sell when book had no bid liquidity (do not force −entry as final P&amp;L). */
  private paperExitRetryTimerByTradeId = new Map<string, ReturnType<typeof setTimeout>>();
  private paperExitInFlightIds = new Set<string>();

  /** AUTO BTC ~5m: entry snapshot by trade id → result log + entry-time buckets (measurement only). */
  private btc5mAutoEntryByTradeId = new Map<string, Btc5mAutoEntryContext>();
  private btc5mEntryBucketStats = btc5mFreshBucketStats();
  private btc5mTradeResultCount = 0;

  /** Anchor Strategy: bid-depth imbalance history (5s cadence, max 10). */
  private anchorImbalanceHistoryUp: number[] = [];
  private anchorImbalanceHistoryDown: number[] = [];
  private lastAnchorSignal: AnchorSignal | null = null;
  private lastAnchorWindowKey: string | null = null;
  private anchorTradedThisWindow = false;
  /** Samples for selective momentum persistence (newest at end). */
  private selectiveMomentumRecent: number[] = [];
  /** Virtual MM inventory notionals for logging (SIM). */
  /** Simulated Polymarket YES-token notional (UP vs DOWN outcome) for MM[PM5m] inventory skew. */
  private mmPm5mYesUpNotionalUsd = 0;
  private mmPm5mYesDownNotionalUsd = 0;
  private mmLastLogMs = 0;
  /** UI/API toggle; Anchor still requires ANCHOR_STRATEGY_ENABLED in .env. */
  private anchorRuntimeEnabled = true;
  /** Skip redundant WS `status` when phase copy is unchanged. */
  private lastBroadcastPredKey = "";
  private lastBroadcastPhaseKey = "";
  /** Avoid stacked chart / book timers when upstream APIs are slow (keeps data coherent). */
  private chartPollInFlight = false;
  private bookRefreshInFlight = false;

  private setPhase(phase: BotPhase, phaseReason?: string) {
    const nextReason = phaseReason ?? "";
    const prevReason = this.phaseReason ?? "";
    if (this.phase === phase && prevReason === nextReason) return;
    this.phase = phase;
    this.phaseReason = phaseReason;
    this.onStatus?.(this.status());
  }

  private currentWindowKey(): string {
    const meta = this.wallet.getDiscoveredMeta();
    if (meta?.windowStartSec != null) return String(meta.windowStartSec);
    return String(Math.floor(Date.now() / 300_000));
  }

  private chainlinkAsset(asset: string): string | null {
    const a = asset.trim().toUpperCase();
    if (a === "BTC" || a === "ETH" || a === "SOL" || a === "XRP") return a;
    return null;
  }

  /** On-chain `updatedAt` age tolerance — do not inherit RTDS_MAX_STALE_MS. */
  private chainlinkStaleMs(): number {
    const raw = process.env.CHAINLINK_MAX_STALE_MS;
    const parsed = Number(raw);
    if (raw !== undefined && raw !== "" && Number.isFinite(parsed) && parsed > 0) {
      return Math.max(500, parsed);
    }
    return 120_000;
  }

  private oracleSourcePrefersChainlink(): boolean {
    const s = String(process.env.ORACLE_SOURCE ?? "chainlink").trim().toLowerCase();
    return s === "" || s === "chainlink";
  }

  private isValidChainlinkAnswerTimestamp(updatedAtMs: number, nowMs: number): boolean {
    if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return false;
    if (updatedAtMs > nowMs + 120_000) return false;
    const age = nowMs - updatedAtMs;
    if (!Number.isFinite(age) || age < 0) return false;
    if (age > 86400 * 365 * 1000) return false;
    return true;
  }

  /**
   * Chainlink entry-gating freshness: authoritative = on-chain answer `updatedAt` age when valid;
   * else receipt age (last successful transport). `fetchAgeMs` mirrors transport latency diagnostic only.
   */
  private chainlinkFreshnessDiagnostics(asset: string): {
    gateAgeMs: number | null;
    answerAgeMs: number | null;
    fetchAgeMs: number | null;
    receiptAgeMs: number | null;
  } {
    const a = this.chainlinkAsset(asset);
    if (!a) {
      return { gateAgeMs: null, answerAgeMs: null, fetchAgeMs: null, receiptAgeMs: null };
    }
    const now = Date.now();
    const tick = this.chainlinkUsdByAsset.get(a);
    const fetchMs = this.chainlinkLastSuccessfulFetchMs.get(a);
    const fetchAgeMs =
      fetchMs != null && Number.isFinite(fetchMs) ? Math.max(0, now - fetchMs) : null;
    const receiptAgeMs = fetchAgeMs;

    let answerAgeMs: number | null = null;
    if (tick != null && this.isValidChainlinkAnswerTimestamp(tick.updatedAt, now)) {
      answerAgeMs = Math.max(0, now - tick.updatedAt);
    } else if (tick != null && Number.isFinite(tick.updatedAt)) {
      if (!this.chainlinkInvalidAnswerTsWarned.has(a)) {
        this.chainlinkInvalidAnswerTsWarned.add(a);
        this.log(
          "SIGNAL",
          `[CHAINLINK][WARN] asset=${a} invalid_or_ignored_answer_timestamp updatedAt=${tick.updatedAt} — using receipt age for gate if available`
        );
      }
    }

    const gateAgeMs = answerAgeMs != null ? answerAgeMs : receiptAgeMs;
    return { gateAgeMs, answerAgeMs, fetchAgeMs, receiptAgeMs };
  }

  private oracleChainlinkGateAgeMs(asset: string): number | null {
    return this.chainlinkFreshnessDiagnostics(asset).gateAgeMs;
  }

  /** Canonical age for auto-trade oracle gates (Chainlink-first when ORACLE_SOURCE=chainlink). */
  private oracleEntryAgeMsForGate(asset: string): number | null {
    const rawCl = this.oracleChainlinkRawAgeMsForAsset(asset);
    const rtds = this.polymarketRtds.getAgeMsForAsset(asset);
    if (this.oracleSourcePrefersChainlink() && this.chainlinkAsset(asset)) {
      const g = this.oracleChainlinkGateAgeMs(asset);
      if (g != null) return g;
      return getOracleAgeMsForTrend(rawCl, rtds);
    }
    return getOracleAgeMsForTrend(rawCl, rtds);
  }

  /** Wall-clock bucket length for which asset is “in focus” (default 300s = 5m). */
  private autoTradeRotationSec(): number {
    return Math.max(60, envNum("AUTO_TRADE_ROTATION_SEC", 300));
  }

  private buildEnabledAutoTradeIndices(slots: Array<{ asset: string }>): number[] {
    let enabledIndices = slots
      .map((s, i) => (this.isAssetAutoTradeEnabled(s.asset) ? i : -1))
      .filter((i) => i >= 0);
    if (this.lagSnipeEnabled) {
      enabledIndices = enabledIndices.filter(
        (i) => slots[i]?.asset === "BTC" || slots[i]?.asset === "ETH"
      );
    }
    return enabledIndices;
  }

  /** Max ms on one discovered slot before advancing among `enabledIndices` (multi-asset only). */
  private rotationForceMs(): number {
    return Math.max(15_000, envNum("ROTATION_FORCE_MS", 60_000));
  }

  private rotationDebugLogs(): boolean {
    return String(process.env.ROTATION_DEBUG_LOGS ?? "true").toLowerCase() !== "false";
  }

  /**
   * Pick active slot from `UPDOWN_ROTATION_ASSETS` order × time bucket — not per-tick round-robin
   * (so fast anchor-lane ticks don’t starve ETH/SOL/XRP when BTC has stronger books).
   * When several markets are discovered, also advance every `ROTATION_FORCE_MS` so BTC slot 0 cannot monopolize.
   */
  private pickAutoTradeSlotIndex(slots: Array<{ asset: string }>, enabledIndices: number[]): number {
    if (enabledIndices.length === 0) return 0;
    const now = Date.now();
    const forceMs = this.rotationForceMs();
    // 1) Periodic advance across discovered markets (stops BTC slot-0 monopoly when Gamma returns many assets).
    if (enabledIndices.length > 1 && now - this.lastMultiAssetForcedRotateMs >= forceMs) {
      this.lastMultiAssetForcedRotateMs = now;
      this.multiAssetForcedCursor = (this.multiAssetForcedCursor + 1) % enabledIndices.length;
      return enabledIndices[this.multiAssetForcedCursor]!;
    }
    // 2) Otherwise: 5m wall-clock bucket → preferred asset.
    const rotSec = this.autoTradeRotationSec();
    const bucket = Math.floor(now / 1000 / rotSec);
    const desired = UPDOWN_ROTATION_ASSETS[bucket % UPDOWN_ROTATION_ASSETS.length];
    let pick = enabledIndices.find((i) => slots[i]?.asset === desired);
    if (pick == null) {
      for (const want of UPDOWN_ROTATION_ASSETS) {
        const f = enabledIndices.find((i) => slots[i]?.asset === want);
        if (f != null) {
          pick = f;
          break;
        }
      }
    }
    return pick ?? enabledIndices[0]!;
  }

  /** Book refresh + auto-trade: align active market with rotation bucket (keeps UI/API off BTC-only). */
  private syncAutoTradeRotationActiveSlot(slots: Array<{ asset: string; slug: string }>) {
    const dbg = this.rotationDebugLogs();
    if (slots.length === 0) {
      if (dbg) {
        console.log("MARKET_DISCOVERY", { slots: [], note: "no discovered slots — check Gamma / AUTO_DISCOVER_UPDOWN" });
      }
      return;
    }
    const enabled = this.buildEnabledAutoTradeIndices(slots);
    const rotSec = this.autoTradeRotationSec();
    const bucket = Math.floor(Date.now() / 1000 / rotSec);
    const desired = UPDOWN_ROTATION_ASSETS[bucket % UPDOWN_ROTATION_ASSETS.length];

    if (dbg) {
      console.log("MARKET_DISCOVERY", {
        slots: slots.map((s) => `${s.asset}(${s.slug?.slice(-14) ?? "?"})`),
        slotCount: slots.length
      });
    }

    if (enabled.length === 0) {
      if (dbg) {
        console.log("ASSET_DEBUG_FULL", {
          bucket,
          desired,
          enabledIndices: [],
          fallbackAsset: slots[0]?.asset ?? null,
          reason: "no_auto_trade_enabled_assets",
          ts: Date.now()
        });
      }
      return;
    }

    const pick = this.pickAutoTradeSlotIndex(slots, enabled);
    const fallbackAsset = slots[enabled[0]!]?.asset ?? "?";

    if (dbg) {
      console.log("ENABLED_INDICES:", enabled.map((i) => `${i}:${slots[i]?.asset ?? "?"}`));
      console.log("ASSET_DEBUG_FULL", {
        bucket,
        desired,
        enabledIndices: enabled,
        pickedIndex: pick,
        pickedAsset: slots[pick]?.asset ?? null,
        fallbackAsset,
        rotationForceMs: this.rotationForceMs(),
        lastForcedAgeMs: Date.now() - this.lastMultiAssetForcedRotateMs
      });
    }

    if (this.lastAssetDebugBucket !== bucket) {
      this.lastAssetDebugBucket = bucket;
      console.log("ASSET_DEBUG", {
        asset: slots[pick]?.asset,
        bucket,
        rotationSec: rotSec,
        desired,
        markets: slots.map((s) => ({ asset: s.asset, slug: s.slug })),
        ts: Date.now()
      });
    }
    this.wallet.setActiveSlot(pick);
  }

  private oracleSpotUsdForAsset(asset: string): number | null {
    const a = this.chainlinkAsset(asset);
    if (a) {
      const tick = this.chainlinkUsdByAsset.get(a);
      const staleMs = this.chainlinkStaleMs();
      if (tick && Number.isFinite(tick.price) && tick.price > 0) {
        const ageMs = Date.now() - tick.updatedAt;
        if (Number.isFinite(ageMs) && ageMs <= staleMs) return tick.price;
      }
      // If Chainlink tick is missing/stale, fall back to RTDS spot.
      const rtdsSpot = this.polymarketRtds.getUsdForAsset(asset);
      if (rtdsSpot != null && Number.isFinite(rtdsSpot) && rtdsSpot > 0) return rtdsSpot;
      const spotAnchor = this.lastSpotUsdByAsset.get(a);
      return spotAnchor != null && Number.isFinite(spotAnchor) && spotAnchor > 0 ? spotAnchor : null;
    }
    return this.polymarketRtds.getUsdForAsset(asset);
  }

  private oracleAgeMsForAsset(asset: string): number | null {
    const a = this.chainlinkAsset(asset);
    if (a) {
      const tick = this.chainlinkUsdByAsset.get(a);
      const staleMs = this.chainlinkStaleMs();
      if (tick && Number.isFinite(tick.updatedAt)) {
        const ageMs = Math.max(0, Date.now() - tick.updatedAt);
        if (Number.isFinite(ageMs) && ageMs <= staleMs) return ageMs;
      }
      // If Chainlink tick is missing/stale, fall back to RTDS age.
      return this.polymarketRtds.getAgeMsForAsset(asset);
    }
    return this.polymarketRtds.getAgeMsForAsset(asset);
  }

  /** Raw Chainlink tick age for entry gating (even when older than `chainlinkStaleMs()`, so RTDS fallback does not hide staleness). */
  private oracleChainlinkRawAgeMsForAsset(asset: string): number | null {
    const a = this.chainlinkAsset(asset);
    if (!a) return null;
    const tick = this.chainlinkUsdByAsset.get(a);
    if (!tick || !Number.isFinite(tick.updatedAt)) return null;
    return Math.max(0, Date.now() - tick.updatedAt);
  }

  /** Per-asset oracle trend for auto-trade (min samples + fresh last tick). Anchor BTC buffer unchanged. */
  private oracleTrendForAutoTradeGate(asset: string) {
    return evaluateOracleTrendBufferGate(
      getChainlinkPriceHistoryBufferForAsset(asset),
      Date.now(),
      oracleTrendMinSamples(),
      oracleTrendMaxSampleAgeMs()
    );
  }

  private formatOracleTrendHealthSegment(sym: string, now: number): string {
    const buf = getChainlinkPriceHistoryBufferForAsset(sym);
    const samples = buf.sampleCount();
    const lastTs = buf.lastTimestampMs();
    const ageMs = lastTs != null ? now - lastTs : null;
    const r = evaluateOracleTrendBufferGate(buf, now, oracleTrendMinSamples(), oracleTrendMaxSampleAgeMs());
    const trend = r.kind === "ok" ? r.trend : "NA";
    const ageStr = ageMs != null ? String(Math.round(ageMs)) : "NA";
    return `${sym}:${samples}/${ageStr}/${trend}`;
  }

  private formatOracleTrendHealthBracket(): string {
    const now = Date.now();
    const segs = (["BTC", "ETH", "SOL", "XRP"] as const).map((s) => this.formatOracleTrendHealthSegment(s, now));
    return `oracleTrendHealth {${segs.join(" ")}}`;
  }

  /** Full oracle attribution for UI + throttled `[ORACLE][SOURCE]` logs. */
  private oracleSourceMetaForAsset(asset: string): {
    source: "chainlink" | "rtds" | "cache" | null;
    reason?: string;
    ageMs: number | null;
  } {
    const a = asset.trim().toUpperCase();
    const chain = this.chainlinkAsset(a);
    const staleMs = this.chainlinkStaleMs();
    const rtdsOk = () => {
      const s = this.polymarketRtds.getUsdForAsset(asset);
      return s != null && Number.isFinite(s) && s > 0;
    };
    const cacheOk = () => {
      if (!chain) return false;
      const s = this.lastSpotUsdByAsset.get(chain);
      return s != null && Number.isFinite(s) && s > 0;
    };
    if (chain) {
      const tick = this.chainlinkUsdByAsset.get(chain);
      if (tick && Number.isFinite(tick.price) && tick.price > 0) {
        const ageMs = Math.max(0, Date.now() - tick.updatedAt);
        if (Number.isFinite(ageMs) && ageMs <= staleMs) {
          return { source: "chainlink", ageMs };
        }
        if (rtdsOk()) {
          return {
            source: "rtds",
            reason: "chainlink_stale",
            ageMs: this.polymarketRtds.getAgeMsForAsset(asset)
          };
        }
        if (cacheOk()) {
          return { source: "cache", reason: "chainlink_stale_and_rtds_missing", ageMs: null };
        }
        return { source: null, reason: "chainlink_stale", ageMs: null };
      }
      if (rtdsOk()) {
        return {
          source: "rtds",
          reason: "chainlink_missing",
          ageMs: this.polymarketRtds.getAgeMsForAsset(asset)
        };
      }
      if (cacheOk()) {
        return { source: "cache", reason: "chainlink_missing_and_rtds_missing", ageMs: null };
      }
      return { source: null, reason: "chainlink_missing", ageMs: null };
    }
    if (rtdsOk()) return { source: "rtds", ageMs: this.polymarketRtds.getAgeMsForAsset(asset) };
    return { source: null, ageMs: null };
  }

  /** Data source for `oracleSpotUsd` (used for UI + runtime transparency). */
  private oracleSourceForAsset(asset: string): "chainlink" | "rtds" | "cache" | null {
    return this.oracleSourceMetaForAsset(asset).source;
  }

  private oracleStaleMsForAsset(asset: string): number {
    const a = this.chainlinkAsset(asset);
    if (a) return this.chainlinkStaleMs();
    return Math.max(500, envNum("RTDS_MAX_STALE_MS", 8000));
  }

  /** Logs `[ORACLE][SOURCE]` only when window or source/reason changes (not every refresh). */
  private logOracleSourceIfChanged(chainlinkAssetsToPoll: string[]) {
    const windowKey = this.currentWindowKey();
    for (const asset of chainlinkAssetsToPoll) {
      const meta = this.oracleSourceMetaForAsset(asset);
      const logKey = `${windowKey}|${meta.source ?? "null"}|${meta.reason ?? ""}`;
      if (this.lastOracleSourceLogKeyByAsset.get(asset) === logKey) continue;
      this.lastOracleSourceLogKeyByAsset.set(asset, logKey);
      const parts: string[] = [`[ORACLE][SOURCE] asset=${asset} source=${meta.source ?? "null"}`];
      if (meta.reason) parts.push(`reason=${meta.reason}`);
      else if (meta.source === "chainlink" && meta.ageMs != null) parts.push(`ageMs=${Math.round(meta.ageMs)}`);
      else if (meta.source === "rtds" && meta.ageMs != null) parts.push(`ageMs=${Math.round(meta.ageMs)}`);
      console.log(parts.join(" "));
    }
  }

  /** Poll Coinbase/Binance for each configured UPDOWN symbol (parallel); anchors BONE_LATENCY per asset. */
  private async refreshSpotAnchorsForConfiguredAssets() {
    const assets = this.wallet.getUpdownAssetsConfigured();
    if (assets.length === 0) return;
    const wk = this.currentWindowKey();
    const results = await Promise.all(
      assets.map(async (a) => {
        try {
          const p = await fetchUsdSpot(a);
          return [a, p] as const;
        } catch {
          return [a, null] as const;
        }
      })
    );
    for (const [a, p] of results) {
      if (p == null || !Number.isFinite(p) || p <= 0) continue;
      const prev = this.spotWindowByAsset.get(a);
      if (!prev || prev.windowKey !== wk) {
        this.spotWindowByAsset.set(a, { windowKey: wk, openUsd: p });
      }
      this.lastSpotUsdByAsset.set(a, p);
    }
  }

  private envMinTrade(): number {
    const n = Number(process.env.MIN_TRADE ?? 1);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  private envMaxTrade(): number {
    const n = Number(process.env.MAX_TRADE ?? 300);
    return Number.isFinite(n) && n > 0 ? n : 300;
  }

  private envEntryUsd(): number {
    const n = Number(process.env.ENTRY_USD ?? 1);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  private envCooldownMs(): number {
    const n = Number(process.env.COOLDOWN_MS ?? 1500);
    return Number.isFinite(n) && n >= 0 ? n : 1500;
  }

  private envStopLossUsd(): number {
    const n = Number(process.env.STOP_LOSS ?? 300);
    return Number.isFinite(n) && n > 0 ? n : 300;
  }

  private effMinTrade(): number {
    const o = this.riskOverrides.minTrade;
    return o != null && Number.isFinite(o) && o > 0 ? o : this.envMinTrade();
  }

  private effMaxTrade(): number {
    const o = this.riskOverrides.maxTrade;
    const v = o != null && Number.isFinite(o) && o > 0 ? o : this.envMaxTrade();
    return Math.max(v, this.effMinTrade());
  }

  private effEntryUsd(): number {
    const o = this.riskOverrides.entryUsd;
    const base = o != null && Number.isFinite(o) && o > 0 ? o : this.envEntryUsd();
    const lo = this.effMinTrade();
    const hi = this.effMaxTrade();
    return Math.min(hi, Math.max(lo, base));
  }

  private effCooldownMs(): number {
    const o = this.riskOverrides.cooldownMs;
    return o != null && Number.isFinite(o) && o >= 0 ? o : this.envCooldownMs();
  }

  private effStopLossUsd(): number {
    const o = this.riskOverrides.stopLossUsd;
    return o != null && Number.isFinite(o) && o > 0 ? o : this.envStopLossUsd();
  }

  getRiskSettingsSnapshot(): RiskSettingsSnapshot {
    const env = {
      entryUsd: this.envEntryUsd(),
      minTrade: this.envMinTrade(),
      maxTrade: Math.max(this.envMaxTrade(), this.envMinTrade()),
      stopLossUsd: this.envStopLossUsd(),
      cooldownMs: this.envCooldownMs()
    };
    const o = this.riskOverrides;
    const overridesActive = Object.keys(o).some(
      (k) => o[k as keyof typeof o] !== undefined && o[k as keyof typeof o] !== null
    );
    return {
      entryUsd: this.effEntryUsd(),
      minTrade: this.effMinTrade(),
      maxTrade: this.effMaxTrade(),
      stopLossUsd: this.effStopLossUsd(),
      cooldownMs: this.effCooldownMs(),
      env,
      overridesActive
    };
  }

  /**
   * Update runtime risk/size (auto-trades + validation gates). Use `reset: true` to clear overrides.
   */
  setRiskSettings(input: {
    reset?: boolean;
    entryUsd?: number;
    minTrade?: number;
    maxTrade?: number;
    stopLossUsd?: number;
    cooldownMs?: number;
  }): { ok: true; riskSettings: RiskSettingsSnapshot } | { ok: false; reason: string } {
    if (input.reset) {
      this.riskOverrides = {};
      this.log("SIGNAL", "Risk settings: cleared runtime overrides (using .env)");
      this.pushStatus();
      return { ok: true, riskSettings: this.getRiskSettingsSnapshot() };
    }

    const touched =
      input.entryUsd !== undefined ||
      input.minTrade !== undefined ||
      input.maxTrade !== undefined ||
      input.stopLossUsd !== undefined ||
      input.cooldownMs !== undefined;
    if (!touched) {
      return { ok: true, riskSettings: this.getRiskSettingsSnapshot() };
    }

    const next = { ...this.riskOverrides };
    const minBound = 0.01;
    const maxCooldown = 3_600_000;

    if (input.minTrade !== undefined) {
      if (!Number.isFinite(input.minTrade) || input.minTrade < minBound) {
        return { ok: false, reason: `minTrade must be ≥ ${minBound}` };
      }
      next.minTrade = input.minTrade;
    }
    if (input.maxTrade !== undefined) {
      if (!Number.isFinite(input.maxTrade) || input.maxTrade < minBound) {
        return { ok: false, reason: `maxTrade must be ≥ ${minBound}` };
      }
      next.maxTrade = input.maxTrade;
    }
    const tryMin = next.minTrade ?? this.envMinTrade();
    const tryMax = next.maxTrade ?? this.envMaxTrade();
    if (tryMax < tryMin) {
      return { ok: false, reason: "maxTrade must be >= minTrade" };
    }

    if (input.entryUsd !== undefined) {
      if (!Number.isFinite(input.entryUsd) || input.entryUsd < minBound) {
        return { ok: false, reason: `entryUsd must be ≥ ${minBound}` };
      }
      next.entryUsd = input.entryUsd;
    }

    if (input.stopLossUsd !== undefined) {
      if (!Number.isFinite(input.stopLossUsd) || input.stopLossUsd < 1) {
        return { ok: false, reason: "stopLossUsd must be >= 1" };
      }
      next.stopLossUsd = input.stopLossUsd;
    }

    if (input.cooldownMs !== undefined) {
      if (!Number.isFinite(input.cooldownMs) || input.cooldownMs < 0 || input.cooldownMs > maxCooldown) {
        return { ok: false, reason: `cooldownMs must be 0..${maxCooldown}` };
      }
      next.cooldownMs = input.cooldownMs;
    }

    this.riskOverrides = next;

    const lo = this.effMinTrade();
    const hi = this.effMaxTrade();
    const ent = this.effEntryUsd();
    if (ent < lo || ent > hi) {
      this.riskOverrides.entryUsd = Math.min(hi, Math.max(lo, ent));
    }

    this.log(
      "SIGNAL",
      `Risk settings: entry=$${this.effEntryUsd().toFixed(2)} min=$${this.effMinTrade().toFixed(2)} max=$${this.effMaxTrade().toFixed(2)} stopLoss=$${this.effStopLossUsd().toFixed(2)} cooldown=${this.effCooldownMs()}ms`
    );
    this.pushStatus();
    return { ok: true, riskSettings: this.getRiskSettingsSnapshot() };
  }

  /**
   * Writes risk fields to `server/.env`, updates `process.env`, and clears runtime overrides
   * so values match the file after restart.
   */
  async persistRiskSettingsToEnv(input: RiskEnvValues): Promise<
    { ok: true; riskSettings: RiskSettingsSnapshot } | { ok: false; reason: string }
  > {
    const minBound = 0.01;
    const maxCooldown = 3_600_000;
    if (!Number.isFinite(input.minTrade) || input.minTrade < minBound) {
      return { ok: false, reason: `minTrade must be ≥ ${minBound}` };
    }
    if (!Number.isFinite(input.maxTrade) || input.maxTrade < minBound) {
      return { ok: false, reason: `maxTrade must be ≥ ${minBound}` };
    }
    if (input.maxTrade < input.minTrade) {
      return { ok: false, reason: "maxTrade must be >= minTrade" };
    }
    if (!Number.isFinite(input.entryUsd) || input.entryUsd < minBound) {
      return { ok: false, reason: `entryUsd must be ≥ ${minBound}` };
    }
    if (input.entryUsd < input.minTrade || input.entryUsd > input.maxTrade) {
      return { ok: false, reason: "entryUsd must be between minTrade and maxTrade" };
    }
    if (!Number.isFinite(input.stopLossUsd) || input.stopLossUsd < 1) {
      return { ok: false, reason: "stopLossUsd must be >= 1" };
    }
    if (!Number.isFinite(input.cooldownMs) || input.cooldownMs < 0 || input.cooldownMs > maxCooldown) {
      return { ok: false, reason: `cooldownMs must be 0..${maxCooldown}` };
    }

    const envPath = resolveServerDotEnvPath();
    const wrote = await writeRiskSettingsToDotEnv(envPath, input);
    if (!wrote.ok) return wrote;

    applyRiskToProcessEnv(input);
    this.riskOverrides = {};

    this.log(
      "SIGNAL",
      `Risk settings saved to .env (${envPath}): entry=$${input.entryUsd} min=$${input.minTrade} max=$${input.maxTrade} stopLoss=$${input.stopLossUsd} cooldown=${Math.round(input.cooldownMs)}ms`
    );
    this.pushStatus();
    return { ok: true, riskSettings: this.getRiskSettingsSnapshot() };
  }

  private effectiveEntryStrategy(): EntryStrategyKind {
    return this.entryStrategyRuntime ?? parseEnvEntryStrategy();
  }

  private entryStrategyLabel(kind: EntryStrategyKind): string {
    switch (kind) {
      case "momentum":
        return "Momentum (chart trend)";
      case "anchor":
        return "Anchor (book+Chainlink)";
      case "market_making":
        return "Market making (maker sim / gated live)";
      case "fair_value_arb":
        return "Fair value arb (executable edge)";
      case "selective_momentum":
        return "Selective momentum (sparse)";
      default:
        return kind;
    }
  }

  private getEntryStrategyState(): EntryStrategyState {
    const fromEnv = parseEnvEntryStrategy();
    const effective = this.effectiveEntryStrategy();
    return {
      effective,
      runtimeOverride: this.entryStrategyRuntime,
      fromEnv,
      label: this.entryStrategyLabel(effective)
    };
  }

  setEntryStrategy(input: {
    reset?: boolean;
    strategy?: string;
  }): { ok: true; entryStrategy: EntryStrategyState } | { ok: false; reason: string } {
    if (input.reset) {
      this.entryStrategyRuntime = null;
      this.log("SIGNAL", "Entry strategy: cleared runtime override (using ENTRY_STRATEGY from .env)");
      if (!this.livePhaseSyncFrozen()) {
        this.synchronizeLivePredictionAndPhase(false);
        this.onPrediction?.(this.prediction);
      }
      this.pushStatus();
      return { ok: true, entryStrategy: this.getEntryStrategyState() };
    }
    if (input.strategy !== undefined) {
      const id = parseDashboardEntryStrategyId(input.strategy);
      if (!id) {
        return {
          ok: false,
          reason: "strategy must be momentum, anchor, market_making, fair_value_arb, or selective_momentum"
        };
      }
      this.entryStrategyRuntime = id;
      this.log("SIGNAL", `Entry strategy: ${id} (dashboard override)`);
      if (!this.livePhaseSyncFrozen()) {
        this.synchronizeLivePredictionAndPhase(false);
        this.onPrediction?.(this.prediction);
      }
      this.pushStatus();
      return { ok: true, entryStrategy: this.getEntryStrategyState() };
    }
    return { ok: true, entryStrategy: this.getEntryStrategyState() };
  }

  private anchorFallbackEnabled(): boolean {
    return String(process.env.ANCHOR_ALLOW_FALLBACK ?? "false").toLowerCase() === "true";
  }

  private anchorFastLaneEnabled(): boolean {
    return String(process.env.ANCHOR_FAST_LANE ?? "false").toLowerCase() === "true";
  }

  private validateAnchorLiveTestConfig(): void {
    const mode = String(process.env.MODE ?? "").trim().toUpperCase();
    const rawEntry = String(process.env.ENTRY_STRATEGY ?? "").trim().toLowerCase();
    const anchorEntry = rawEntry === "anchor" || rawEntry === "book_imbalance";
    if (mode !== "LIVE" || !anchorEntry) return;
    if (String(process.env.ANCHOR_STRATEGY_ENABLED ?? "").toLowerCase() !== "true") {
      this.log("SIGNAL", "[ANCHOR][WARN] LIVE anchor selected but ANCHOR_STRATEGY_ENABLED is not true");
    }
    if (this.anchorFallbackEnabled()) {
      this.log("SIGNAL", "[ANCHOR][WARN] LIVE anchor selected but ANCHOR_ALLOW_FALLBACK is not false");
    }
    const szRaw = process.env.ANCHOR_TRADE_SIZE;
    const szTrim = szRaw != null ? String(szRaw).trim() : "";
    if (szTrim === "") {
      this.log("SIGNAL", "[ANCHOR][WARN] LIVE anchor selected but ANCHOR_TRADE_SIZE is missing/invalid");
    } else {
      const n = Number(szTrim);
      if (!Number.isFinite(n) || n <= 0) {
        this.log("SIGNAL", "[ANCHOR][WARN] LIVE anchor selected but ANCHOR_TRADE_SIZE is missing/invalid");
      }
    }
  }

  /** Once per `init()`: resolved Anchor knobs (actual mode/size/toggles). */
  private logAnchorStartupResolvedConfig(): void {
    const cfg = loadAnchorConfigFromEnv(this.effEntryUsd());
    const mode = this.wallet.getMode();
    const selected = this.effectiveEntryStrategy() === "anchor";
    this.log(
      "SIGNAL",
      `[ANCHOR][CONFIG] selected=${selected} mode=${mode} tradeSizeUsd=${cfg.tradeSize.toFixed(2)} allowFallback=${this.anchorFallbackEnabled()} fastLane=${this.anchorFastLaneEnabled()} enabled=${cfg.enabled && this.anchorRuntimeEnabled}`
    );
  }

  /** Non–anchor strategy path only: optional rescue when `ANCHOR_ALLOW_FALLBACK=true`. */
  private async runAnchorFallbackNonPrimary(): Promise<void> {
    if (!this.anchorFallbackEnabled()) return;
    const asset = this.wallet.getActiveDiscoveredAsset() ?? "?";
    this.log("SIGNAL", `[ANCHOR][FALLBACK] asset=${asset} trigger=non_anchor_skip`);
    await this.maybeRunAnchorStrategy();
  }

  /**
   * Merge keys from `UPDOWN_ASSETS` — new symbols default to auto-trade **on**; removed symbols drop from the map.
   */
  private syncAssetAutoTradeKeysFromConfigured() {
    const assets = this.wallet.getUpdownAssetsConfigured().map((a) => a.trim().toUpperCase());
    const allow = new Set(assets);
    for (const a of assets) {
      if (!this.assetAutoTradeEnabled.has(a)) {
        this.assetAutoTradeEnabled.set(a, true);
      }
    }
    for (const k of [...this.assetAutoTradeEnabled.keys()]) {
      if (!allow.has(k)) this.assetAutoTradeEnabled.delete(k);
    }
  }

  /** Auto-trader may rotate into this asset’s discovered slot (default true). */
  private isAssetAutoTradeEnabled(asset: string): boolean {
    const k = asset.trim().toUpperCase();
    return this.assetAutoTradeEnabled.get(k) !== false;
  }

  private getAssetAutoTradeEnabledSnapshot(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const a of this.wallet.getUpdownAssetsConfigured()) {
      const k = a.trim().toUpperCase();
      out[k] = this.isAssetAutoTradeEnabled(k);
    }
    return out;
  }

  setAssetAutoTradeEnabled(
    asset: string,
    enabled: boolean
  ): { ok: true; assetAutoTradeEnabled: Record<string, boolean> } | { ok: false; reason: string } {
    const k = asset.trim().toUpperCase();
    const allowed = new Set(this.wallet.getUpdownAssetsConfigured().map((a) => a.trim().toUpperCase()));
    if (!allowed.has(k)) {
      return {
        ok: false,
        reason: `Asset ${k} is not in UPDOWN_ASSETS — add it in server .env first`
      };
    }
    this.assetAutoTradeEnabled.set(k, enabled);
    this.log("SIGNAL", `Auto-trade ${k}: ${enabled ? "ON" : "OFF"}`);
    this.pushStatus();
    return { ok: true, assetAutoTradeEnabled: this.getAssetAutoTradeEnabledSnapshot() };
  }

  private pushMarketPointFromLiveBtc(price: number) {
    const windowKey = this.currentWindowKey();
    if (this.lastTrackedWindowKey !== windowKey) {
      this.lastTrackedWindowKey = windowKey;
      this.btcTargetUsd = price;
      this.marketData = [];
    }

    const last = this.marketData[this.marketData.length - 1];
    const movement = last?.btcUsd != null ? Number((price - last.btcUsd).toFixed(4)) : 0;
    const ts = Date.now();
    const time = new Date(ts).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    });
    const pseudo = Math.max(-2.5, Math.min(2.5, movement / 40));
    const up = Math.max(1, Math.min(99, Number((50 + pseudo).toFixed(3))));
    const down = Number((100 - up).toFixed(3));

    const point: MarketPoint = {
      time,
      ts,
      up,
      down,
      movement,
      btcUsd: price,
      btcTargetUsd: this.btcTargetUsd ?? undefined
    };
    this.marketData = [...this.marketData.slice(-(CHART_MAX_POINTS - 1)), point];
  }

  private pushAssetSpotChartPoint(asset: string, spotUsd: number) {
    const a = asset.trim().toUpperCase();
    const wk = this.currentWindowKey();
    if (this.assetSpotChartWindowKey.get(a) !== wk) {
      this.assetSpotChartWindowKey.set(a, wk);
      this.assetSpotSeries.set(a, []);
    }
    const series = this.assetSpotSeries.get(a) ?? [];
    const last = series[series.length - 1];
    const movement =
      last?.btcUsd != null && Number.isFinite(last.btcUsd)
        ? Number((spotUsd - last.btcUsd).toFixed(8))
        : 0;
    const ptb = this.priceToBeatByAsset.get(a);
    const sw = this.spotWindowByAsset.get(a);
    let targetUsd: number;
    if (ptb != null && Number.isFinite(ptb) && ptb > 0) {
      targetUsd = ptb;
    } else if (sw != null && sw.windowKey === wk && Number.isFinite(sw.openUsd) && sw.openUsd > 0) {
      targetUsd = sw.openUsd;
    } else {
      targetUsd = spotUsd;
    }
    const sens = Math.max(spotUsd * 0.00012, a === "BTC" ? 40 : spotUsd * 0.00018);
    const pseudo = Math.max(-2.5, Math.min(2.5, movement / sens));
    const up = Math.max(1, Math.min(99, Number((50 + pseudo).toFixed(3))));
    const down = Number((100 - up).toFixed(3));
    const ts = Date.now();
    const time = new Date(ts).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    });
    const point: MarketPoint = {
      time,
      ts,
      up,
      down,
      movement,
      btcUsd: spotUsd,
      btcTargetUsd: targetUsd
    };
    this.assetSpotSeries.set(a, [...series.slice(-(CHART_MAX_POINTS - 1)), point]);
  }

  private buildSynthesisMarketDataHealth(nowMs: number): SynthesisMarketDataHealthPayload | null {
    const hub = this.synthesisHub;
    if (!hub || !this.synthesisRuntimeConfig.enabled) return null;
    const guard = loadSynthesisGuardrailConfigFromEnv();
    this.synthesisRuntimeConfig = loadSynthesisConfigFromEnv();
    const snap = hub.getSnapshot();
    const native = this.directionalContext;
    const driftRaw = computeNativeSynthesisDrift(native, snap.books.up, snap.books.down, guard, nowMs);
    const driftTelemetry = driftResultToTelemetryPayload(driftRaw);
    const nativeSt = computeNativeOrderbookStale(this.lastBookRefreshMs, nowMs, guard.nativeBookStaleMs);
    const tel = hub.getTelemetry();
    const synOb = computeAgeStale(tel.lastOrderbookMsgMs, nowMs, guard.synthesisOrderbookStaleMs);
    const synTr = computeAgeStale(tel.lastTradesMsgMs, nowMs, guard.synthesisTradesStaleMs);
    const prWall = hub.getPricesBufferLastUpdateMs();
    const synPr = computeAgeStale(prWall > 0 ? prWall : null, nowMs, guard.synthesisPriceStaleMs);
    const synthesisOrderbookStale = synOb.stale || snap.books.stale;
    const syn = hub.getDirectionalContextFromSynthesis();
    const fb = evaluateSynthesisBotFallbackEligibility({
      synthesisEnabled: this.synthesisRuntimeConfig.enabled,
      botFallbackEnabled: this.synthesisRuntimeConfig.botFallbackEnabled,
      nativeBookStale: nativeSt.stale,
      synthesisOrderbookStale,
      synthesisReady: syn != null,
      drift: driftRaw,
      guard
    });
    return {
      drift: driftTelemetry,
      staleness: {
        nativeOrderbook: nativeSt,
        synthesisOrderbook: synOb,
        synthesisTrades: synTr,
        synthesisPrices: synPr
      },
      fallbackEligible: fb.allowed,
      fallbackBlockReason: fb.reason
    };
  }

  private maybeLogSynthesisGuardrails(health: SynthesisMarketDataHealthPayload, nowMs: number): void {
    const guard = loadSynthesisGuardrailConfigFromEnv();
    const key = `${health.drift.level}|${health.fallbackBlockReason}`;
    const staleSig = [
      health.staleness.nativeOrderbook.stale ? 1 : 0,
      health.staleness.synthesisOrderbook.stale ? 1 : 0,
      health.staleness.synthesisTrades.stale ? 1 : 0,
      health.staleness.synthesisPrices.stale ? 1 : 0
    ].join("");
    if (staleSig !== this.lastSynthStalenessSig) {
      const wasInit = this.lastSynthStalenessSig === "";
      this.lastSynthStalenessSig = staleSig;
      const s = health.staleness;
      const anyStale = staleSig !== "0000";
      if (!wasInit && this.lastSynthAnyStale && !anyStale) {
        this.log("SIGNAL", "[SYNTHESIS][stale] recovered to healthy (all sources fresh)");
      }
      this.lastSynthAnyStale = anyStale;
      if (!wasInit) {
        this.log(
          "SIGNAL",
          `[SYNTHESIS][stale] nativeOb=${s.nativeOrderbook.stale ? "stale" : "fresh"} synOb=${s.synthesisOrderbook.stale ? "stale" : "fresh"} trades=${s.synthesisTrades.stale ? "stale" : "fresh"} prices=${s.synthesisPrices.stale ? "stale" : "fresh"}`
        );
      }
    }
    if (key === this.lastSynthHealthLogKey && nowMs - this.lastSynthDriftGuardLogMs < guard.driftLogThrottleMs) {
      return;
    }
    this.lastSynthDriftGuardLogMs = nowMs;
    this.lastSynthHealthLogKey = key;
    if (this.lastSynthDriftLevel !== "ok" && health.drift.level === "ok") {
      this.log("SIGNAL", "[SYNTHESIS][drift] recovered to ok");
    } else if (this.lastSynthDriftLevel === "ok" && health.drift.level === "warn") {
      this.log("SIGNAL", `[SYNTHESIS][drift] warn threshold maxBps=${health.drift.maxBps.toFixed(0)}`);
    } else if (this.lastSynthDriftLevel !== "critical" && health.drift.level === "critical") {
      this.log("SIGNAL", `[SYNTHESIS][drift] critical maxBps=${Number.isFinite(health.drift.maxBps) ? health.drift.maxBps.toFixed(0) : "inf"}`);
    }
    if (health.fallbackBlockReason === "drift_too_high" && this.lastSynthFbBlockReason !== "drift_too_high") {
      this.log("SIGNAL", "[SYNTHESIS][fallback] blocked: drift above SYNTHESIS_BOT_FALLBACK_MAX_DRIFT_BPS");
    }
    this.lastSynthFbBlockReason = health.fallbackBlockReason;
    this.lastSynthDriftLevel = health.drift.level;
    this.log(
      "SIGNAL",
      `[SYNTHESIS][guard] drift=${health.drift.level} maxBps=${health.drift.maxBps.toFixed(0)} fb=${
        health.fallbackBlockReason
      } eligible=${health.fallbackEligible}`
    );
  }

  private buildMarketWsPayload(): MarketWsPayload {
    const byAsset: Record<string, MarketPoint[]> = {};
    for (const [k, v] of this.assetSpotSeries.entries()) {
      if (v.length > 0) byAsset[k] = v;
    }
    const base: MarketWsPayload = { primary: this.marketData, byAsset };
    this.synthesisRuntimeConfig = loadSynthesisConfigFromEnv();
    const hub = this.synthesisHub;
    if (!hub || !this.synthesisRuntimeConfig.enabled) {
      return base;
    }
    const snap = hub.getSnapshot();
    const tel = snap.telemetry;
    const hasBooks = Boolean(snap.books.up && snap.books.down);
    const orderbookSource = resolveDashboardOrderbookSource({
      synthesisEnabled: tel.enabled,
      dashboardPreferred: tel.dashboardPreferred,
      synthesisStale: tel.stale,
      synthesisHasBooks: hasBooks
    });
    const chartMode = resolveDashboardChartMode({
      synthesisEnabled: tel.enabled,
      synthesisHasPrices: snap.priceSeries.length > 0
    });
    const trades: NormalizedSynthesisTradePayload[] = snap.trades.map((t) => ({
      venue: "polymarket",
      tokenId: t.tokenId,
      price: t.price,
      shares: t.shares,
      notionalUsd: t.notionalUsd,
      side: t.side,
      createdAtMs: t.createdAtMs
    }));
    const priceOverlayUsd = snap.priceSeries.map((p) => ({ t: p.t, priceUsd: p.priceUsd }));
    const nowMs = Date.now();
    const health = this.buildSynthesisMarketDataHealth(nowMs);
    if (health) {
      this.maybeLogSynthesisGuardrails(health, nowMs);
      this.synthesisMarketDataHistory.observe(nowMs, health);
    }
    base.synthesis = {
      telemetry: {
        enabled: tel.enabled,
        orderbookConnected: tel.orderbookConnected,
        tradesConnected: tel.tradesConnected,
        dataConnected: tel.dataConnected,
        subscribedTokenIds: tel.subscribedTokenIds,
        conditionId: tel.conditionId,
        activeAsset: tel.activeAsset,
        lastOrderbookMsgMs: tel.lastOrderbookMsgMs,
        lastTradesMsgMs: tel.lastTradesMsgMs,
        lastDataMsgMs: tel.lastDataMsgMs,
        stale: tel.stale,
        dashboardPreferred: tel.dashboardPreferred,
        botFallbackEnabled: tel.botFallbackEnabled,
        lastError: tel.lastError
      },
      trades,
      booksSynthesis: {
        up: snap.books.up,
        down: snap.books.down,
        stale: snap.books.stale
      },
      orderbookSource,
      chartMode,
      priceOverlayUsd,
      health: health
        ? { ...health, history: this.synthesisMarketDataHistory.getWirePayload() }
        : undefined
    };
    return base;
  }

  /** Native CLOB books only — execution / Anchor / settlement. */
  private effectiveStrategyDirectionalContext(): DirectionalContext | null {
    const native = this.directionalContext;
    this.synthesisRuntimeConfig = loadSynthesisConfigFromEnv();
    const hub = this.synthesisHub;
    const syn = hub?.getDirectionalContextFromSynthesis() ?? null;
    const health = this.buildSynthesisMarketDataHealth(Date.now());
    if (health?.fallbackEligible && syn != null) {
      const now = Date.now();
      if (now - this.lastSynthFallbackLogMs > 30_000) {
        this.lastSynthFallbackLogMs = now;
        this.log(
          "SIGNAL",
          "[BOOK][synthesis] Strategy eval using Synthesis books (fallback_ok). Execution still native CLOB."
        );
      }
      return syn;
    }
    return native;
  }

  /** Net momentum: positive → UP bias. `from_open` uses last BTC vs 5m window open. */
  private momentumScalar(lookback: number): number {
    const mode = momentumMode();
    if (mode === "from_open") {
      const last = this.marketData[this.marketData.length - 1];
      if (last?.btcUsd == null || this.btcTargetUsd == null) return 0;
      return last.btcUsd - this.btcTargetUsd;
    }
    const n = Math.max(2, Math.min(50, lookback));
    const recent = this.marketData.slice(-n);
    if (recent.length === 0) return 0;
    if (mode === "weighted") {
      let sum = 0;
      for (let i = 0; i < recent.length; i++) {
        sum += (i + 1) * recent[i].movement;
      }
      return sum;
    }
    return recent.reduce((acc, p) => acc + p.movement, 0);
  }

  private trendBoostFromScalar(trend: number): number {
    if (momentumMode() === "from_open") {
      const cap = envNum("MOMENTUM_MAX_CONF_BOOST", 4);
      const usdPer = envNum("MOMENTUM_FROM_OPEN_USD_PER_CONF", 25);
      const div = !Number.isFinite(usdPer) || usdPer <= 0 ? 25 : usdPer;
      return Math.min(cap, Math.abs(trend) / div);
    }
    const scale = envNum("MOMENTUM_TICK_SCALE", 0.2);
    return Math.min(2, Math.abs(trend) * scale);
  }

  private basePredict(): { prediction: Direction; confidence: number; ts: number } {
    if (this.lagSnipeEnabled) {
      const ev = this.evaluateLagSnipeDisplay();
      return { prediction: ev.prediction, confidence: ev.confidence, ts: Date.now() };
    }
    const strat = this.effectiveEntryStrategy();
    if (strat === "fair_value_arb") {
      const ev = this.buildFairValueArbEvaluation();
      return { prediction: ev.prediction, confidence: ev.confidence, ts: Date.now() };
    }
    if (strat === "selective_momentum") {
      const ev = this.buildSelectiveMomentumEvaluation();
      return { prediction: ev.prediction, confidence: ev.confidence, ts: Date.now() };
    }
    if (strat === "market_making") {
      return { prediction: "UP", confidence: 50, ts: Date.now() };
    }
    if (strat === "anchor") {
      const side = this.lastAnchorSignal?.side;
      if (side === "UP" || side === "DOWN") {
        return { prediction: side, confidence: 94, ts: Date.now() };
      }
      if (this.directionalContext) {
        const { up, down } = this.directionalContext;
        const direction: Direction = up.mid >= down.mid ? "UP" : "DOWN";
        const edge = Math.abs(up.mid - down.mid);
        const confidenceBase = 90 + Math.min(6, edge * 40);
        const confidence = Math.min(100, Number((confidenceBase + Math.random() * 2).toFixed(2)));
        return { prediction: direction, confidence, ts: Date.now() };
      }
      return { prediction: "UP", confidence: 88, ts: Date.now() };
    }
    const predictLb = envNum("MOMENTUM_PREDICT_LOOKBACK", 10);
    const trend = this.momentumScalar(predictLb);
    const direction: Direction = trend >= 0 ? "UP" : "DOWN";
    const confidenceBase = 92 + Math.random() * 8;
    const trendBoost = this.trendBoostFromScalar(trend);
    return {
      prediction: direction,
      confidence: Math.min(100, Number((confidenceBase + trendBoost).toFixed(2))),
      ts: Date.now()
    };
  }

  private momentumDirection(): Direction {
    const scoreLb = envNum("MOMENTUM_SCORE_LOOKBACK", 8);
    const momentum = this.momentumScalar(scoreLb);
    return momentum >= 0 ? "UP" : "DOWN";
  }

  /** Raw chart momentum (no contrarian flip) — for BOT_FILTER momentum vs signal agreement. */
  private rawMomentumSide(): Direction {
    const scoreLb = envNum("MOMENTUM_SCORE_LOOKBACK", 8);
    const momentum = this.momentumScalar(scoreLb);
    return momentum >= 0 ? "UP" : "DOWN";
  }

  private async refreshLagSnipeKlinesIfEnabled() {
    if (!this.lagSnipeEnabled) return;
    try {
      const asset = this.wallet.getActiveDiscoveredAsset();
      if (asset !== "BTC" && asset !== "ETH") return;
      const candles =
        asset === "BTC" ? await fetchLastFiveClosed1mBtcUsdt() : await fetchLastFiveClosed1mEthUsdt();
      if (candles) {
        this.lagSnipeKlinesCache = { asset, candles, fetchedAt: Date.now() };
      }
    } catch {
      /* ignore */
    }
  }

  private evaluateLagSnipeDisplay(): {
    prediction: Direction;
    confidence: number;
    recommendation: "TRADE" | "NO_TRADE";
    reason: string;
  } {
    const asset = this.wallet.getActiveDiscoveredAsset();
    if (asset !== "BTC" && asset !== "ETH") {
      return {
        prediction: "UP",
        confidence: 50,
        recommendation: "NO_TRADE",
        reason: `Lag Snipe: BTC+ETH only (active slot is ${asset ?? "unknown"})`
      };
    }

    const meta = this.wallet.getDiscoveredMeta();
    const endParsed = meta?.endDateIso ? new Date(meta.endDateIso).getTime() : NaN;
    const secLeft = !Number.isNaN(endParsed) ? Math.floor((endParsed - Date.now()) / 1000) : null;

    if (!lagSnipeInWindow(secLeft)) {
      return {
        prediction: "UP",
        confidence: 55,
        recommendation: "NO_TRADE",
        reason: `Lag Snipe: enter only in last ${lagSnipeMaxSecondsLeft()}s (left ${secLeft ?? "n/a"}s)`
      };
    }

    const k = this.lagSnipeKlinesCache;
    const candles = k?.asset === asset ? k.candles : null;
    if (!candles) {
      return {
        prediction: "UP",
        confidence: 50,
        recommendation: "NO_TRADE",
        reason: `Lag Snipe: loading last 5×1m ${asset} candles…`
      };
    }
    if (candles.length < 5) {
      return {
        prediction: "UP",
        confidence: 52,
        recommendation: "NO_TRADE",
        reason: `Lag Snipe: need 5×1m candles (have ${candles.length})`
      };
    }

    if (!this.directionalContext || !this.wallet.hasLiveMarketData()) {
      return {
        prediction: candleSignalFromFive(candles) ?? "UP",
        confidence: 72,
        recommendation: "NO_TRADE",
        reason: "Lag Snipe: need live UP/DOWN books"
      };
    }

    const { up, down } = this.directionalContext;

    // 1) Min-prob "0% fees" gate (approx by CLOB UP probability; direction is forced).
    const direction = lagSnipeDirectionFromUpProb(up.mid, lagSnipeMinProb());
    if (!direction) {
      return {
        prediction: "UP",
        confidence: 55,
        recommendation: "NO_TRADE",
        reason: `Lag Snipe: min-prob gate failed (need up>=${lagSnipeMinProb()} or down>=${lagSnipeMinProb()}; up=${up.mid.toFixed(
          3
        )})`
      };
    }

    // 2) 4-minute candle analysis confirmation.
    const candleSignal = candleSignalFromFive(candles);
    const candleConfirm = candleSignal != null && candleSignal === direction;

    // 3) Dynamic liquidity confirmation.
    const depth = direction === "UP" ? up.liquidity : down.liquidity;
    const sizeUsd = lagSnipeCalcSizeFromDepth(depth);
    const liquidityConfirm = lagSnipeLiquidityConfirmation(depth, sizeUsd);

    // 4) S/R cap confirmation (simple outcome-mid cap in this codebase).
    const srConfirm = lagSnipeSrOk(direction, up, down);

    // 5) Premium signal confirmation (oracle spot vs strike/price-to-beat).
    const spot = this.oracleSpotUsdForAsset(asset);
    const ptb = this.priceToBeatByAsset.get(asset);
    const oracleDiffUsd =
      spot != null && ptb != null && Number.isFinite(spot) && Number.isFinite(ptb) ? spot - ptb : null;
    const spotAgeMs = this.oracleAgeMsForAsset(asset);
    const staleMs = this.oracleStaleMsForAsset(asset);
    const premiumFresh = spotAgeMs == null || spotAgeMs <= staleMs;
    const premiumDir = lagSnipePremiumDirectionFromOracleDiff(oracleDiffUsd);
    const premiumConfirm = premiumFresh && premiumDir != null && premiumDir === direction;

    const required = lagSnipeConfirmationsRequired();
    const confirmations = [candleConfirm, liquidityConfirm, srConfirm, premiumConfirm].filter(Boolean).length;

    if (confirmations < required) {
      return {
        prediction: direction,
        confidence: 60 + confirmations * 6,
        recommendation: "NO_TRADE",
        reason: `Lag Snipe: confirms ${confirmations}/${required} (candle=${candleConfirm ? "Y" : "N"}, liq=${
          liquidityConfirm ? "Y" : "N"
        }, sr=${srConfirm ? "Y" : "N"}, premium=${premiumConfirm ? "Y" : "N"}${
          premiumFresh ? "" : ", premiumFeed=STALE"
        })`
      };
    }

    const confidence = Math.min(100, 75 + confirmations * 7 + Math.random() * 2);
    return {
      prediction: direction,
      confidence: Number(confidence.toFixed(2)),
      recommendation: "TRADE",
      reason: `Lag Snipe: HOLD Manual Exit | ${direction} | Confirms ${confirmations}/${required} -> TRADE FIRED | $${sizeUsd} size | ~${secLeft ?? "?"}s left`
    };
  }

  private chooseLagSnipeEntry(): { direction: Direction; reason: string } {
    const ev = this.evaluateLagSnipeDisplay();
    if (ev.recommendation === "NO_TRADE") {
      return { direction: ev.prediction, reason: `LAG_SNIPE_SKIP: ${ev.reason}` };
    }
    return {
      direction: ev.prediction,
      reason: `LAG_SNIPE: ${ev.prediction} | HOLD Manual Exit | King confirms`
    };
  }

  setLagSnipe(enabled: boolean): { ok: true; lagSnipeEnabled: boolean; banner?: string } {
    this.lagSnipeEnabled = enabled;
    if (this.lagSnipeKlineTimer) {
      clearInterval(this.lagSnipeKlineTimer);
      this.lagSnipeKlineTimer = null;
    }
    if (enabled) {
      void this.refreshLagSnipeKlinesIfEnabled();
      this.lagSnipeKlineTimer = setInterval(() => void this.refreshLagSnipeKlinesIfEnabled(), 20_000);
      this.log(
        "SIGNAL",
        `Lag Snipe ON — BTC+ETH 5m only, last ${lagSnipeMaxSecondsLeft()}s window, auto-exit disabled`
      );
    } else {
      this.lagSnipeKlinesCache = null;
      this.log("SIGNAL", "Lag Snipe OFF — restored normal strategies + auto-exit");
    }
    if (!this.livePhaseSyncFrozen()) {
      this.synchronizeLivePredictionAndPhase(false);
      this.onPrediction?.(this.prediction);
    }
    this.pushStatus();
    return {
      ok: true,
      lagSnipeEnabled: enabled,
      banner: enabled ? "Lag Snipe: HOLD Manual Exit" : undefined
    };
  }

  /**
   * Optional `server/config.json`: TRADE_ASSETS, MIN_SIGNAL_CONF, MIN_EDGE, REQUIRE_MOMENTUM_SIGNAL_AGREE.
   * Anchor bypasses spread/momentum filters (handled in anchor path).
   */
  private checkConfigTradeFilters(strat: EntryStrategyKind, cfg: BotFiltersConfig): { ok: true } | { ok: false; reason: string } {
    if (this.lagSnipeEnabled) return { ok: true };
    const asset = this.wallet.getActiveDiscoveredAsset();
    if (!tradeAssetAllowedByConfig(asset, cfg)) {
      return {
        ok: false,
        reason: `BOT_FILTER: asset ${asset ?? "?"} not allowed (TRADE_ASSETS in config.json)`
      };
    }

    const minConf = cfg.MIN_SIGNAL_CONF;
    if (minConf != null && Number.isFinite(minConf) && this.prediction.confidence < minConf) {
      return {
        ok: false,
        reason: `BOT_FILTER: signal conf ${this.prediction.confidence.toFixed(1)}% < MIN_SIGNAL_CONF ${minConf}`
      };
    }

    if (strat === "anchor") {
      return { ok: true };
    }

    const minEdge = cfg.MIN_EDGE;
    if (minEdge != null && Number.isFinite(minEdge) && minEdge > 0) {
      const spread = bookMidSpread01(this.directionalContext);
      if (spread == null) {
        return { ok: false, reason: "BOT_FILTER: MIN_EDGE requires live UP/DOWN books" };
      }
      if (spread < minEdge) {
        return {
          ok: false,
          reason: `BOT_FILTER: book spread ${spread.toFixed(4)} < MIN_EDGE ${minEdge}`
        };
      }
    }

    if (cfg.REQUIRE_MOMENTUM_SIGNAL_AGREE === true) {
      const mom = this.rawMomentumSide();
      if (mom !== this.prediction.prediction) {
        return {
          ok: false,
          reason: `BOT_FILTER: momentum ${mom} ≠ signal ${this.prediction.prediction}`
        };
      }
    }

    return { ok: true };
  }

  private getRiskSizedAmount() {
    const target = this.effEntryUsd();
    const capped = Math.min(this.balance, Math.max(this.effMinTrade(), Math.min(this.effMaxTrade(), target)));
    return Number(capped.toFixed(2));
  }

  /** LIVE: size from real CLOB available collateral (minus open BUY reservations). SIM: paper balance. */
  private async computeAutoTradeAmount(): Promise<{
    amount: number;
    budget?: { balanceUsdc: number; reservedUsdc: number; availableUsdc: number } | null;
  }> {
    if (this.wallet.getMode() !== "LIVE") {
      return { amount: this.getRiskSizedAmount() };
    }
    const budget = await this.wallet.getAvailableCollateralBudget();
    if (!budget || budget.availableUsdc <= 0) return { amount: 0, budget };
    const target = this.effEntryUsd();
    const capped = Math.min(
      budget.availableUsdc,
      Math.max(this.effMinTrade(), Math.min(this.effMaxTrade(), target))
    );
    return { amount: Number(capped.toFixed(2)), budget };
  }

  /** Why live CLOB posts are blocked (null = allowed). */
  private liveOrdersDisabledReason(): string | null {
    if (this.wallet.getMode() !== "LIVE") return "MODE!=LIVE";
    if (paperTradingEnv()) return "PAPER_TRADING=true";
    if (!executeTradesEnv()) return "EXECUTE_TRADES=false";
    if (paperOnlyEnv()) return "PAPER_ONLY=true";
    return null;
  }

  /** True when MODE=LIVE, paper rail off, EXECUTE_TRADES on, and not PAPER_ONLY. */
  private canExecuteLiveOrders(): boolean {
    return this.liveOrdersDisabledReason() === null;
  }

  /**
   * Simulated fills: always in SIMULATION; on LIVE when paperTrading is on and real posts are disabled.
   */
  private shouldExecutePaperTrade(): boolean {
    if (this.wallet.getMode() === "SIMULATION") return true;
    return this.wallet.getMode() === "LIVE" && paperTradingEnv() && !this.canExecuteLiveOrders();
  }

  /**
   * Single gate for execution: spread/liquidity plus extreme-quote filter (stub 0.01 / 0.99 books).
   * Uses the same rules for demo synthetic books and live CLOB.
   */
  private liveBookTradability(book: MarketContext): { ok: boolean; detail: string } {
    const maxSpread = envNum("MAX_SPREAD", DEFAULT_MAX_SPREAD);
    const minLiq = envNum("MIN_LIQUIDITY", DEFAULT_MIN_LIQUIDITY);
    const minBid = envNum("LIVE_MIN_BEST_BID", 0.05);
    const maxAsk = envNum("LIVE_MAX_BEST_ASK", 0.95);
    const ctx =
      `bestBid=${book.bestBid.toFixed(4)} bestAsk=${book.bestAsk.toFixed(4)} ` +
      `(minBid=${minBid}, maxAsk=${maxAsk}, minLiq=${minLiq}, maxSpread=${maxSpread})`;
    if (book.spread > maxSpread) {
      return {
        ok: false,
        detail: `spread filter: spread ${book.spread.toFixed(4)} > MAX_SPREAD ${maxSpread} | ${ctx}`
      };
    }
    const paperLiq =
      this.wallet.getMode() === "SIMULATION" &&
      String(process.env.PAPER_OVERRIDE_LIQUIDITY_GUARD ?? "true").toLowerCase() === "true";
    if (book.liquidity < minLiq && !paperLiq) {
      return {
        ok: false,
        detail: `liquidity filter: liquidity ${book.liquidity.toFixed(0)} < MIN_LIQUIDITY ${minLiq} | ${ctx}`
      };
    }
    if (book.bestBid < minBid) {
      return {
        ok: false,
        detail: `quote filter: bestBid ${book.bestBid.toFixed(4)} < LIVE_MIN_BEST_BID ${minBid} | ${ctx}`
      };
    }
    if (book.bestAsk > maxAsk) {
      return {
        ok: false,
        detail: `quote filter: bestAsk ${book.bestAsk.toFixed(4)} > LIVE_MAX_BEST_ASK ${maxAsk} | ${ctx}`
      };
    }
    return { ok: true, detail: "" };
  }

  /** Maps execution rules to short UI badges. */
  /**
   * Global NO_TRADE can reflect slot-0 books only; AUTO on another slot with tradable books should still run.
   */
  private canIgnoreNoTradeForBookOnlyBlock(source: "MANUAL" | "AUTO"): boolean {
    if (this.prediction.recommendation !== "NO_TRADE") return false;
    const r = this.prediction.reason ?? "";
    if (!r.includes("Live books not tradable")) return false;
    if (source !== "AUTO") return false;
    return (
      this.wallet.hasLiveMarketData() &&
      !!this.directionalContext &&
      this.liveBookTradability(this.directionalContext.up).ok &&
      this.liveBookTradability(this.directionalContext.down).ok
    );
  }

  /** Do not override phase from feed tickers while executing or stopped. */
  private livePhaseSyncFrozen(): boolean {
    switch (this.phase) {
      case "EXECUTING":
      case "WAITING_RESOLUTION":
      case "RISK_BLOCKED":
      case "ERROR":
      case "STOPPED":
      case "AUTH_CHECK":
      case "STARTING":
      case "CONFIG_INVALID":
        return true;
      default:
        return false;
    }
  }

  /** Dashboard sync for MM / FVA / SM — overlays book tradability on strategy evaluation. */
  private finalizeStrategyPrediction(ev: StrategyEvaluation, fromTimer: boolean): void {
    let recommendation = ev.recommendation;
    let reason = ev.reason;
    const base = { prediction: ev.prediction, confidence: ev.confidence, ts: Date.now() };
    if (this.wallet.hasLiveMarketData() && this.directionalContext) {
      const upT = this.liveBookTradability(this.directionalContext.up);
      const downT = this.liveBookTradability(this.directionalContext.down);
      if (!upT.ok && !downT.ok) {
        recommendation = "NO_TRADE";
        reason = `Live books not tradable (both sides): UP — ${upT.detail}; DOWN — ${downT.detail}`;
      }
    }
    const next: Prediction = { ...base, recommendation, reason };
    let nextPhase: BotPhase;
    let nextPhaseReason: string;
    if (recommendation === "NO_TRADE" && reason.includes("Live books not tradable")) {
      nextPhase = "MARKET_NOT_TRADABLE";
      nextPhaseReason = reason;
    } else if (recommendation === "TRADE") {
      nextPhase = "SIGNAL_READY";
      nextPhaseReason = `Signal: ${base.prediction} (${base.confidence.toFixed(0)}%)`;
    } else {
      nextPhase = "SIGNAL_READY";
      nextPhaseReason = reason;
    }
    const predKey = `${next.prediction}|${next.recommendation}|${next.reason}|${Math.round(next.confidence)}`;
    const phaseKey = `${nextPhase}|${nextPhaseReason}`;
    const signalUnchanged = predKey === this.lastBroadcastPredKey && phaseKey === this.lastBroadcastPhaseKey;
    this.prediction = next;
    if (!signalUnchanged) {
      this.lastBroadcastPredKey = predKey;
      this.lastBroadcastPhaseKey = phaseKey;
      this.setPhase(nextPhase, nextPhaseReason);
      this.onPrediction?.(this.prediction);
    }
    if (recommendation === "NO_TRADE" && fromTimer) this.noTradeSignals += 1;
    if (fromTimer && !signalUnchanged) {
      this.log(
        "SIGNAL",
        `${this.prediction.prediction} ${this.prediction.confidence}% (${this.prediction.recommendation})`
      );
    }
  }

  /**
   * One source of truth for prediction + phase from chart volatility, strategy, and live CLOB books.
   * Called on the 5s timer (`fromTimer`) and after each CLOB/Gamma book refresh (~4s) so status matches APIs.
   */
  private synchronizeLivePredictionAndPhase(fromTimer: boolean) {
    if (this.livePhaseSyncFrozen()) return;

    if (this.lagSnipeEnabled) {
      void this.refreshLagSnipeKlinesIfEnabled();
      const ev = this.evaluateLagSnipeDisplay();
      const base = { prediction: ev.prediction, confidence: ev.confidence, ts: Date.now() };
      const recommendation = ev.recommendation;
      const reason = ev.reason;
      const next: Prediction = { ...base, recommendation, reason };
      let nextPhase: BotPhase;
      let nextPhaseReason: string;
      if (recommendation === "NO_TRADE" && reason.includes("Live books not tradable")) {
        nextPhase = "MARKET_NOT_TRADABLE";
        nextPhaseReason = reason;
      } else if (recommendation === "TRADE") {
        nextPhase = "SIGNAL_READY";
        nextPhaseReason = `Lag Snipe: ${base.prediction} (${base.confidence.toFixed(0)}%)`;
      } else {
        nextPhase = "SIGNAL_READY";
        nextPhaseReason = reason;
      }
      const predKey = `${next.prediction}|${next.recommendation}|${next.reason}|${Math.round(next.confidence)}`;
      const phaseKey = `${nextPhase}|${nextPhaseReason}`;
      const signalUnchanged = predKey === this.lastBroadcastPredKey && phaseKey === this.lastBroadcastPhaseKey;
      this.prediction = next;
      if (!signalUnchanged) {
        this.lastBroadcastPredKey = predKey;
        this.lastBroadcastPhaseKey = phaseKey;
        this.setPhase(nextPhase, nextPhaseReason);
        this.onPrediction?.(this.prediction);
      }
      if (recommendation === "NO_TRADE" && fromTimer) this.noTradeSignals += 1;
      if (fromTimer && !signalUnchanged) {
        this.log(
          "SIGNAL",
          `${this.prediction.prediction} ${this.prediction.confidence}% (${this.prediction.recommendation})`
        );
      }
      return;
    }

    const es = this.effectiveEntryStrategy();
    if (es === "anchor") {
      const base = this.basePredict();
      let recommendation: "TRADE" | "NO_TRADE" = "TRADE";
      let reason = `Anchor (book+Chainlink): tilt ${base.prediction} (${base.confidence.toFixed(0)}%)`;
      if (this.wallet.hasLiveMarketData() && this.directionalContext) {
        const upT = this.liveBookTradability(this.directionalContext.up);
        const downT = this.liveBookTradability(this.directionalContext.down);
        if (!upT.ok && !downT.ok) {
          recommendation = "NO_TRADE";
          reason = `Live books not tradable (both sides): UP — ${upT.detail}; DOWN — ${downT.detail}`;
        }
      }
      const next: Prediction = { ...base, recommendation, reason };
      let nextPhase: BotPhase;
      let nextPhaseReason: string;
      if (recommendation === "NO_TRADE" && reason.includes("Live books not tradable")) {
        nextPhase = "MARKET_NOT_TRADABLE";
        nextPhaseReason = reason;
      } else if (recommendation === "TRADE") {
        nextPhase = "SIGNAL_READY";
        nextPhaseReason = `Signal: ${base.prediction} (${base.confidence.toFixed(0)}%)`;
      } else {
        nextPhase = "SIGNAL_READY";
        nextPhaseReason = reason;
      }
      const predKey = `${next.prediction}|${next.recommendation}|${next.reason}|${Math.round(next.confidence)}`;
      const phaseKey = `${nextPhase}|${nextPhaseReason}`;
      const signalUnchanged = predKey === this.lastBroadcastPredKey && phaseKey === this.lastBroadcastPhaseKey;
      this.prediction = next;
      if (!signalUnchanged) {
        this.lastBroadcastPredKey = predKey;
        this.lastBroadcastPhaseKey = phaseKey;
        this.setPhase(nextPhase, nextPhaseReason);
        this.onPrediction?.(this.prediction);
      }
      if (recommendation === "NO_TRADE" && fromTimer) this.noTradeSignals += 1;
      if (fromTimer && !signalUnchanged) {
        this.log(
          "SIGNAL",
          `${this.prediction.prediction} ${this.prediction.confidence}% (${this.prediction.recommendation})`
        );
      }
      return;
    }

    if (es === "market_making") {
      const ev = this.buildMarketMakingEvaluation();
      this.finalizeStrategyPrediction(ev, fromTimer);
      return;
    }
    if (es === "fair_value_arb") {
      const ev = this.buildFairValueArbEvaluation();
      this.finalizeStrategyPrediction(ev, fromTimer);
      return;
    }
    if (es === "selective_momentum") {
      const ev = this.buildSelectiveMomentumEvaluation();
      this.finalizeStrategyPrediction(ev, fromTimer);
      if (fromTimer) {
        const lb = envNum("MOMENTUM_SCORE_LOOKBACK", 8);
        const sc = this.momentumScalar(lb);
        this.selectiveMomentumRecent.push(sc);
        if (this.selectiveMomentumRecent.length > 32) this.selectiveMomentumRecent.shift();
      }
      return;
    }

    const base = this.basePredict();
    const volLb = Math.max(4, Math.min(50, envNum("MOMENTUM_VOLATILITY_LOOKBACK", 12)));
    const recent = this.marketData.slice(-volLb);
    const moves = recent.map((r) => r.movement);
    const avgMove = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : 0;
    const volatility = moves.length ? Math.sqrt(moves.reduce((a, b) => a + b * b, 0) / moves.length) : 0;
    let recommendation: "TRADE" | "NO_TRADE" =
      base.confidence < 94 || volatility > PREDICTION_VOLATILITY_USD ? "NO_TRADE" : "TRADE";
    let reason =
      recommendation === "NO_TRADE"
        ? base.confidence < 94
          ? "Signal confidence too low"
          : `Short-term volatility high (~$${volatility.toFixed(1)} tick stdev)`
        : avgMove >= 0
          ? "Momentum supports UP bias"
          : "Momentum supports DOWN bias";

    if (this.wallet.hasLiveMarketData() && this.directionalContext) {
      const upT = this.liveBookTradability(this.directionalContext.up);
      const downT = this.liveBookTradability(this.directionalContext.down);
      if (!upT.ok && !downT.ok) {
        recommendation = "NO_TRADE";
        reason = `Live books not tradable (both sides): UP — ${upT.detail}; DOWN — ${downT.detail}`;
      }
    }

    const next: Prediction = { ...base, recommendation, reason };
    let nextPhase: BotPhase;
    let nextPhaseReason: string;
    if (recommendation === "NO_TRADE" && reason.includes("Live books not tradable")) {
      nextPhase = "MARKET_NOT_TRADABLE";
      nextPhaseReason = reason;
    } else if (recommendation === "TRADE") {
      nextPhase = "SIGNAL_READY";
      nextPhaseReason = `Signal: ${base.prediction} (${base.confidence.toFixed(0)}%)`;
    } else {
      nextPhase = "SIGNAL_READY";
      nextPhaseReason = reason;
    }

    const predKey = `${next.prediction}|${next.recommendation}|${next.reason}|${Math.round(next.confidence)}`;
    const phaseKey = `${nextPhase}|${nextPhaseReason}`;
    const signalUnchanged = predKey === this.lastBroadcastPredKey && phaseKey === this.lastBroadcastPhaseKey;

    this.prediction = next;
    if (!signalUnchanged) {
      this.lastBroadcastPredKey = predKey;
      this.lastBroadcastPhaseKey = phaseKey;
      this.setPhase(nextPhase, nextPhaseReason);
      this.onPrediction?.(this.prediction);
    }

    if (recommendation === "NO_TRADE" && fromTimer) this.noTradeSignals += 1;
    if (fromTimer && !signalUnchanged) {
      this.log(
        "SIGNAL",
        `${this.prediction.prediction} ${this.prediction.confidence}% (${this.prediction.recommendation})`
      );
    }
  }

  private composeUpdownWindows(): TradingState["updownWindows"] {
    const m = this.multiSlotBooks;
    const summary = this.wallet.getDiscoveredWindowsSummary();
    const snapByAsset = new Map(this.wallet.getDiscoveredSlotsSnapshot().map((s) => [s.asset, s]));
    return summary.map((w) => {
      const snap = m?.[w.asset];
      const g = this.gammaDisplayByAsset.get(w.asset);
      const slot = snapByAsset.get(w.asset);
      const spot = this.oracleSpotUsdForAsset(w.asset);
      const meta = this.oracleSourceMetaForAsset(w.asset);
      const oracleSource = meta.source;
      const oracleAgeMs = meta.ageMs ?? this.oracleAgeMsForAsset(w.asset);
      const ptbMap = this.priceToBeatByAsset.get(w.asset);
      const ptbGamma = g?.priceToBeat;
      const isChainlink = this.chainlinkAsset(w.asset) != null;
      const ptb = isChainlink
        ? ptbMap != null && Number.isFinite(ptbMap)
          ? ptbMap
          : null
        : ptbMap != null && Number.isFinite(ptbMap)
          ? ptbMap
          : ptbGamma != null && Number.isFinite(ptbGamma)
            ? ptbGamma
            : null;
      const endParsed = slot?.endDateIso ? new Date(slot.endDateIso).getTime() : NaN;
      const secondsToExpiry =
        slot?.endDateIso && !Number.isNaN(endParsed)
          ? Math.floor((endParsed - Date.now()) / 1000)
          : null;
      const upMid =
        g != null && Number.isFinite(g.up) ? g.up : snap != null ? snap.up.mid : null;
      const downMid =
        g != null && Number.isFinite(g.down) ? g.down : snap != null ? snap.down.mid : null;
      return {
        asset: w.asset,
        slug: w.slug,
        activeMarketSlug: w.slug,
        label: w.label,
        upMid,
        downMid,
        upSpread: snap?.up.spread ?? null,
        downSpread: snap?.down.spread ?? null,
        upBadge: snap?.up.badge ?? null,
        downBadge: snap?.down.badge ?? null,
        oddsSource: g ? "gamma" : snap ? "clob" : null,
        oracleSpotUsd: spot ?? null,
        oracleAgeMs: oracleAgeMs ?? null,
        oracleSource: oracleSource ?? null,
        priceToBeatUsd: ptb,
        diffUsd: spot != null && ptb != null ? spot - ptb : null,
        secondsToExpiry
      };
    });
  }

  private bookQuality(book: MarketContext | null): { badge: string; detail: string; spread: number } {
    if (!book) return { badge: "no_book", detail: "No order book loaded yet", spread: 0 };
    const t = this.liveBookTradability(book);
    if (t.ok) return { badge: "tradable", detail: "", spread: book.spread };
    let badge = "untradable";
    if (t.detail.includes("MAX_SPREAD") || t.detail.includes("spread")) badge = "wide_spread";
    else if (t.detail.includes("MIN_LIQUIDITY") || t.detail.includes("liquidity")) badge = "low_liquidity";
    else if (t.detail.includes("bestBid") || t.detail.includes("bestAsk")) badge = "extreme_quotes";
    return { badge, detail: t.detail, spread: book.spread };
  }

  getTradingState(): TradingState {
    this.synthesisRuntimeConfig = loadSynthesisConfigFromEnv();
    const mode = this.wallet.getMode();
    const meta = this.wallet.getDiscoveredMeta();
    const endParsed = meta?.endDateIso ? new Date(meta.endDateIso).getTime() : NaN;
    const endMs = meta?.endDateIso && !Number.isNaN(endParsed) ? endParsed : null;
    const ws = meta?.windowStartSec;
    const windowStartMs = ws != null ? ws * 1000 : null;
    const now = Date.now();
    const secondsToExpiry = endMs != null ? Math.floor((endMs - now) / 1000) : null;
    const windowActive = endMs != null ? endMs > now : mode === "SIMULATION";
    const marketExpired = endMs != null ? endMs <= now : false;

    const up = this.directionalContext?.up ?? null;
    const down = this.directionalContext?.down ?? null;
    const qu = this.bookQuality(up);
    const qd = this.bookQuality(down);

    return {
      executionMode: mode,
      executionLabel: mode === "LIVE" ? "LIVE_ONLY" : "PAPER_ONLY",
      clobAuthenticated: this.wallet.isClobAuthenticated(),
      autoDiscoverEnabled: this.wallet.isAutoDiscoverEnabled(),
      lastBookRefreshMs: this.lastBookRefreshMs,
      updownAssetsConfigured: this.wallet.getUpdownAssetsConfigured(),
      assetAutoTradeEnabled: this.getAssetAutoTradeEnabledSnapshot(),
      updownWindows: this.composeUpdownWindows(),
      market: meta
        ? {
            label: meta.label,
            slug: meta.slug,
            endMs,
            windowStartMs,
            secondsToExpiry,
            windowActive,
            marketExpired,
            tokenIdUp: meta.tokenIdUp,
            tokenIdDown: meta.tokenIdDown
          }
        : {
            label: this.selectedMarket.label,
            slug: null,
            endMs: null,
            windowStartMs: null,
            secondsToExpiry: null,
            windowActive: mode === "SIMULATION",
            marketExpired: false,
            tokenIdUp: null,
            tokenIdDown: null
          },
      books: {
        up: up ? { spread: qu.spread, badge: qu.badge, detail: qu.detail } : null,
        down: down ? { spread: qd.spread, badge: qd.badge, detail: qd.detail } : null
      },
      riskSettings: this.getRiskSettingsSnapshot(),
      entryStrategy: this.getEntryStrategyState(),
      lagSnipeEnabled: this.lagSnipeEnabled,
      lagSnipeBanner: this.lagSnipeEnabled ? "Lag Snipe: HOLD Manual Exit" : undefined,
      liveEngine: {
        phase: this.phase,
        phaseReason: this.phaseReason,
        running: this.running,
        autoTrading: this.autoTrading,
        lastBookRefreshMs: this.lastBookRefreshMs,
        secondsSinceBookRefresh:
          this.lastBookRefreshMs != null
            ? Math.max(0, Math.round((Date.now() - this.lastBookRefreshMs) / 1000))
            : null,
        discoveredSlotCount: this.wallet.getDiscoveredSlotCount(),
        hasLiveMarketData: this.wallet.hasLiveMarketData(),
        rtdsConnected: this.polymarketRtds.isSocketOpen(),
        lagSnipeEnabled: this.lagSnipeEnabled
      },
      predictionLive: {
        prediction: this.prediction.prediction,
        confidence: this.prediction.confidence,
        ts: this.prediction.ts,
        recommendation: this.prediction.recommendation,
        reason: this.prediction.reason
      },
      anchorStrategy: this.buildAnchorStrategySnapshotPayload(),
      synthesis: (() => {
        const hub = this.synthesisHub;
        if (!hub || !this.synthesisRuntimeConfig.enabled) return undefined;
        const snap = hub.getSnapshot();
        const tel = snap.telemetry;
        const hasBooks = Boolean(snap.books.up && snap.books.down);
        const dashboardOrderbookSource = resolveDashboardOrderbookSource({
          synthesisEnabled: tel.enabled,
          dashboardPreferred: tel.dashboardPreferred,
          synthesisStale: tel.stale,
          synthesisHasBooks: hasBooks
        });
        const recentTrades: NormalizedSynthesisTradePayload[] = snap.trades.slice(0, 80).map((t) => ({
          venue: "polymarket",
          tokenId: t.tokenId,
          price: t.price,
          shares: t.shares,
          notionalUsd: t.notionalUsd,
          side: t.side,
          createdAtMs: t.createdAtMs
        }));
        const health = this.buildSynthesisMarketDataHealth(Date.now());
        return {
          telemetry: {
            enabled: tel.enabled,
            orderbookConnected: tel.orderbookConnected,
            tradesConnected: tel.tradesConnected,
            dataConnected: tel.dataConnected,
            subscribedTokenIds: tel.subscribedTokenIds,
            conditionId: tel.conditionId,
            activeAsset: tel.activeAsset,
            lastOrderbookMsgMs: tel.lastOrderbookMsgMs,
            lastTradesMsgMs: tel.lastTradesMsgMs,
            lastDataMsgMs: tel.lastDataMsgMs,
            stale: tel.stale,
            dashboardPreferred: tel.dashboardPreferred,
            botFallbackEnabled: tel.botFallbackEnabled,
            lastError: tel.lastError
          },
          dashboardOrderbookSource,
          recentTrades,
          health: health
            ? { ...health, history: this.synthesisMarketDataHistory.getWirePayload() }
            : undefined
        };
      })()
    };
  }

  /** Target mid for paper TP: entry × (1 + relative); capped below 1 (`WHALE_PAPER_TP_*` env). */
  private paperTakeProfitTargetMid(entryVwap: number, relativeGain: number): number {
    const r = Math.max(0, relativeGain);
    return Math.min(0.985, entryVwap * (1 + r));
  }

  private buildFairValueArbEvaluation(): StrategyEvaluation {
    const cfg = loadPolymarket5mFairValueArbConfigFromEnv();
    const asset = this.wallet.getActiveDiscoveredAsset() ?? "BTC";
    const spot = this.oracleSpotUsdForAsset(asset);
    const strike = this.priceToBeatByAsset.get(asset) ?? null;
    const ctx = this.effectiveStrategyDirectionalContext();
    const meta = this.wallet.getDiscoveredMeta();
    const secLeft =
      meta?.endDateIso != null
        ? Math.floor((new Date(meta.endDateIso).getTime() - Date.now()) / 1000)
        : null;
    const is5m = isPolymarketCryptoUpDown5mWindow(asset, meta ?? undefined);
    if (!ctx) {
      return {
        prediction: "UP",
        confidence: 50,
        recommendation: "NO_TRADE",
        reason: "FVA[PM5m]: no Polymarket CLOB books for UP/DOWN YES tokens"
      };
    }
    return evaluatePolymarket5mFairValueArb(cfg, {
      isPolymarketCryptoUpDown5m: is5m,
      spotUsd: spot,
      strikeUsd: strike,
      yesUpTokenBestAsk: ctx.up.bestAsk,
      yesUpTokenBestBid: ctx.up.bestBid,
      yesDownTokenBestAsk: ctx.down.bestAsk,
      yesDownTokenBestBid: ctx.down.bestBid,
      secToGammaExpiry: secLeft
    });
  }

  private buildSelectiveMomentumEvaluation(): StrategyEvaluation {
    const cfg = loadPolymarket5mSelectiveMomentumConfigFromEnv();
    const lb = envNum("MOMENTUM_SCORE_LOOKBACK", 8);
    const momentumScalar = this.momentumScalar(lb);
    const ctx = this.effectiveStrategyDirectionalContext();
    const meta = this.wallet.getDiscoveredMeta();
    const secLeft =
      meta?.endDateIso != null
        ? Math.floor((new Date(meta.endDateIso).getTime() - Date.now()) / 1000)
        : null;
    const asset = this.wallet.getActiveDiscoveredAsset();
    const is5m = isPolymarketCryptoUpDown5mWindow(asset, meta ?? undefined);
    if (!ctx) {
      return {
        prediction: "UP",
        confidence: 50,
        recommendation: "NO_TRADE",
        reason: "SM[PM5m]: no Polymarket CLOB books for YES tokens"
      };
    }
    const chosenYesTokenAsk = momentumScalar >= 0 ? ctx.up.bestAsk : ctx.down.bestAsk;
    const chosenYesTokenBid = momentumScalar >= 0 ? ctx.up.bestBid : ctx.down.bestBid;
    return evaluatePolymarket5mSelectiveMomentum(cfg, {
      isPolymarketCryptoUpDown5m: is5m,
      momentumScalar,
      recentScalars: this.selectiveMomentumRecent,
      yesUpOutcome: {
        mid: ctx.up.mid,
        spread: ctx.up.spread,
        bestBid: ctx.up.bestBid,
        bestAsk: ctx.up.bestAsk
      },
      yesDownOutcome: {
        mid: ctx.down.mid,
        spread: ctx.down.spread,
        bestBid: ctx.down.bestBid,
        bestAsk: ctx.down.bestAsk
      },
      chosenYesTokenAsk,
      chosenYesTokenBid,
      secToGammaExpiry: secLeft
    });
  }

  /** Maker path: logs / SIM inventory only — no `trade()` taker entries. */
  private async runMarketMakingAutoOnce(anchorFastLaneTick: boolean): Promise<void> {
    if (anchorFastLaneTick) return;
    const cfg = loadPolymarket5mMarketMakingConfigFromEnv();
    const ctx = this.effectiveStrategyDirectionalContext();
    const meta = this.wallet.getDiscoveredMeta();
    const asset = this.wallet.getActiveDiscoveredAsset();
    const secLeft =
      meta?.endDateIso != null
        ? Math.floor((new Date(meta.endDateIso).getTime() - Date.now()) / 1000)
        : null;
    const ws = meta?.windowStartSec;
    const secSinceOpen = ws != null ? Math.max(0, Math.floor(Date.now() / 1000 - ws)) : null;
    const wk = polymarket5mWindowKey(meta);
    const is5m = isPolymarketCryptoUpDown5mWindow(asset, meta ?? undefined);
    const isLive = this.wallet.getMode() === "LIVE";
    if (!ctx || !this.wallet.hasLiveMarketData()) {
      return;
    }
    const ev = evaluatePolymarket5mMarketMaking(cfg, {
      isPolymarketCryptoUpDown5m: is5m,
      gammaWindowKey: wk,
      secToGammaExpiry: secLeft,
      secSinceWindowOpen: secSinceOpen,
      yesUpOutcome: {
        bestBid: ctx.up.bestBid,
        bestAsk: ctx.up.bestAsk,
        spread: ctx.up.spread,
        depthLiquidity: ctx.up.liquidity
      },
      yesDownOutcome: {
        bestBid: ctx.down.bestBid,
        bestAsk: ctx.down.bestAsk,
        spread: ctx.down.spread,
        depthLiquidity: ctx.down.liquidity
      },
      inventoryYesUpUsd: this.mmPm5mYesUpNotionalUsd,
      inventoryYesDownUsd: this.mmPm5mYesDownNotionalUsd,
      isLive
    });
    const now = Date.now();
    if (now - this.mmLastLogMs >= cfg.repriceMinMs) {
      this.mmLastLogMs = now;
      this.log("SIGNAL", `[MM][PM5m][AUTO] ${ev.reason} quote=${ev.quoteNote}`);
    }
    if (!isLive && ev.recommendation === "TRADE" && ev.quoteNote === "quote_ok") {
      const tiny = Math.max(0, Number(process.env.MM_SIM_INVENTORY_TICK_USD ?? 0.01));
      if (Number.isFinite(tiny) && tiny > 0) {
        this.mmPm5mYesUpNotionalUsd += tiny;
        this.mmPm5mYesDownNotionalUsd += tiny;
      }
    }
  }

  private buildMarketMakingEvaluation(): StrategyEvaluation & { quoteNote: string } {
    const cfg = loadPolymarket5mMarketMakingConfigFromEnv();
    const ctx = this.effectiveStrategyDirectionalContext();
    const meta = this.wallet.getDiscoveredMeta();
    const asset = this.wallet.getActiveDiscoveredAsset();
    const secLeft =
      meta?.endDateIso != null
        ? Math.floor((new Date(meta.endDateIso).getTime() - Date.now()) / 1000)
        : null;
    const ws = meta?.windowStartSec;
    const secSinceOpen = ws != null ? Math.max(0, Math.floor(Date.now() / 1000 - ws)) : null;
    const wk = polymarket5mWindowKey(meta);
    const is5m = isPolymarketCryptoUpDown5mWindow(asset, meta ?? undefined);
    const isLive = this.wallet.getMode() === "LIVE";
    if (!ctx) {
      return {
        prediction: "UP",
        confidence: 50,
        recommendation: "NO_TRADE",
        reason: "MM[PM5m]: no Polymarket CLOB books for YES tokens",
        quoteNote: "none"
      };
    }
    return evaluatePolymarket5mMarketMaking(cfg, {
      isPolymarketCryptoUpDown5m: is5m,
      gammaWindowKey: wk,
      secToGammaExpiry: secLeft,
      secSinceWindowOpen: secSinceOpen,
      yesUpOutcome: {
        bestBid: ctx.up.bestBid,
        bestAsk: ctx.up.bestAsk,
        spread: ctx.up.spread,
        depthLiquidity: ctx.up.liquidity
      },
      yesDownOutcome: {
        bestBid: ctx.down.bestBid,
        bestAsk: ctx.down.bestAsk,
        spread: ctx.down.spread,
        depthLiquidity: ctx.down.liquidity
      },
      inventoryYesUpUsd: this.mmPm5mYesUpNotionalUsd,
      inventoryYesDownUsd: this.mmPm5mYesDownNotionalUsd,
      isLive
    });
  }

  private chooseDirectionalEntry(): { direction: Direction; reason: string } {
    const strat = this.effectiveEntryStrategy();
    if (strat === "fair_value_arb") {
      const ev = this.buildFairValueArbEvaluation();
      return { direction: ev.prediction, reason: ev.reason };
    }
    if (strat === "selective_momentum") {
      const ev = this.buildSelectiveMomentumEvaluation();
      return { direction: ev.prediction, reason: ev.reason };
    }
    if (this.wallet.hasLiveMarketData() && this.directionalContext) {
      const { up, down } = this.directionalContext;
      const upOk = this.liveBookTradability(up).ok;
      const downOk = this.liveBookTradability(down).ok;
      if (upOk && !downOk) {
        return { direction: "UP", reason: "Books: only UP passes filters (DOWN untradeable)" };
      }
      if (!upOk && downOk) {
        return { direction: "DOWN", reason: "Books: only DOWN passes filters (UP untradeable)" };
      }
    }

    let scoreUp = 0;
    const reasons: string[] = [];
    scoreUp += this.momentumDirection() === "UP" ? 1 : -1;
    reasons.push(`momentum:${this.momentumDirection()}`);
    scoreUp += this.prediction.prediction === "UP" ? 1 : -1;
    reasons.push(`signal:${this.prediction.prediction} ${this.prediction.confidence.toFixed(2)}%`);

    if (this.directionalContext) {
      const { up, down } = this.directionalContext;
      scoreUp += up.spread <= down.spread ? 0.5 : -0.5;
      reasons.push(`spread:${up.spread <= down.spread ? "UP better" : "DOWN better"}`);
      scoreUp += up.liquidity >= down.liquidity ? 0.5 : -0.5;
      reasons.push(`liquidity:${up.liquidity >= down.liquidity ? "UP deeper" : "DOWN deeper"}`);
      scoreUp += up.mid >= down.mid ? 0.25 : -0.25;
      reasons.push(`mid:${up.mid >= down.mid ? "UP stronger" : "DOWN stronger"}`);
    }
    const direction = scoreUp >= 0 ? "UP" : "DOWN";
    return { direction, reason: reasons.join(" | ") };
  }

  /**
   * Paper: optional take-profit while waiting for settle timer — exit when mid ≥ entry×(1+WHALE_PAPER_TP_RELATIVE).
   * Example: WHALE_PAPER_TP_RELATIVE=0.5 → ~50% lift in implied probability vs entry VWAP before simulated exit.
   */
  private schedulePaperExitWithWhaleTp(tradeId: string, tokenId: string, entryVwap: number) {
    const delayRaw = Number(process.env.PAPER_SETTLE_DELAY_MS ?? process.env.SIM_RESOLVE_MS ?? 5000);
    const delayMs = Number.isFinite(delayRaw) ? Math.max(500, delayRaw) : 5000;
    const tpRaw = process.env.WHALE_PAPER_TP_RELATIVE;
    const tpRel = tpRaw !== undefined && String(tpRaw).trim() !== "" ? Number(tpRaw) : NaN;
    const useTp = Number.isFinite(tpRel) && tpRel > 0;
    if (!useTp) {
      setTimeout(() => this.resolveTrade(tradeId), delayMs);
      return;
    }
    void this.pollPaperTakeProfitThenSettle(tradeId, tokenId, entryVwap, delayMs, tpRel);
  }

  private async pollPaperTakeProfitThenSettle(
    tradeId: string,
    tokenId: string,
    entryVwap: number,
    maxWaitMs: number,
    tpRelative: number
  ) {
    const target = this.paperTakeProfitTargetMid(entryVwap, tpRelative);
    const pollMs = Math.max(500, Number(process.env.WHALE_PAPER_TP_POLL_MS ?? 2000));
    const t0 = Date.now();
    while (Date.now() - t0 < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      const idx = this.trades.findIndex((t) => t.id === tradeId && t.status === "PENDING");
      if (idx < 0) return;
      try {
        const raw = await this.wallet.getRawOrderBook(tokenId);
        const nb = normalizeRawOrderBook(raw);
        if (!nb || nb.bestBid == null || nb.bestAsk == null) continue;
        const mid = (nb.bestBid + nb.bestAsk) / 2;
        if (mid >= target - 1e-9) {
          this.log(
            "TRADE",
            `PAPER whale TP: mid ${mid.toFixed(4)} ≥ ${target.toFixed(4)} (entryVWAP ${entryVwap.toFixed(4)}, +${(tpRelative * 100).toFixed(0)}% rel)`
          );
          this.resolveTrade(tradeId);
          return;
        }
      } catch {
        /* next poll */
      }
    }
    this.resolveTrade(tradeId);
  }

  /** Guardrails for safe multi-asset auto-trading (per-asset values must exist + be usable). */
  private autoTradeSkipReasonForActiveAsset(): string | null {
    const assetRaw = this.wallet.getActiveDiscoveredAsset();
    const slug = this.wallet.getActiveDiscoveredSlug();
    const asset = assetRaw ? assetRaw.trim().toUpperCase() : null;

    if (!asset || !slug) return "missing_active_market";
    if (!this.selectedMarket?.tokenID || this.selectedMarket.tokenID === "unknown") return "missing_active_market";

    const ptb = this.priceToBeatByAsset.get(asset);
    if (ptb == null || !Number.isFinite(ptb) || ptb <= 0) return "missing_price_to_beat";

    const spot = this.oracleSpotUsdForAsset(asset);
    if (spot == null || !Number.isFinite(spot) || spot <= 0) return "missing_oracle_spot";

    const ageMs = this.oracleAgeMsForAsset(asset);
    const staleMs = this.oracleStaleMsForAsset(asset);
    if (ageMs != null && Number.isFinite(ageMs) && ageMs > staleMs) {
      // If oracle is too old and we have no alternative spot fallback, skip cleanly.
      const rtdsSpot = this.polymarketRtds.getUsdForAsset(asset);
      const cacheSpot = this.lastSpotUsdByAsset.get(asset);
      const hasFallbackSpot =
        (rtdsSpot != null && Number.isFinite(rtdsSpot) && rtdsSpot > 0) ||
        (cacheSpot != null && Number.isFinite(cacheSpot) && cacheSpot > 0);
      if (!hasFallbackSpot) return "oracle_stale_no_fallback";
    }

    return null;
  }

  private maybeLogRuntimeHealth() {
    const minMs = envNum("RUNTIME_HEALTH_LOG_MS", 20_000);
    const now = Date.now();
    if (this.lastRuntimeHealthLogMs != null && now - this.lastRuntimeHealthLogMs < minMs) return;
    this.lastRuntimeHealthLogMs = now;

    const assets = ["BTC", "ETH", "SOL", "XRP"] as const;
    const rtdsConnected = this.polymarketRtds.isSocketOpen();
    const bookAgeSec =
      this.lastBookRefreshMs != null ? Math.max(0, Math.round((now - this.lastBookRefreshMs) / 1000)) : null;

    const pending = this.trades.filter((t) => tradeRowIsOpen(t.status)).length;
    const finished = this.trades.filter((t) => !tradeRowIsOpen(t.status) && !t.paper?.missed);
    const wins = finished.filter((t) => tradeRowInsightWin(t)).length;
    const losses = finished.filter((t) => tradeRowInsightLoss(t)).length;

    const oracleAges = assets
      .map((a) => {
        const ageMs = this.oracleAgeMsForAsset(a);
        return Number.isFinite(ageMs ?? NaN) ? `${a}:${ageMs}` : `${a}:—`;
      })
      .join(" ");

    const rtdsAges = assets
      .map((a) => {
        const ageMs = this.polymarketRtds.getAgeMsForAsset(a);
        return Number.isFinite(ageMs ?? NaN) ? `${a}:${ageMs}` : `${a}:—`;
      })
      .join(" ");

    const oracleSources = assets
      .map((a) => {
        const src = this.oracleSourceForAsset(a);
        return `${a}:${src ?? "—"}`;
      })
      .join(" ");

    this.log(
      "SIGNAL",
      `[HEALTH] rtds=${rtdsConnected ? "OK" : "OFF"} bookAgeSec=${bookAgeSec ?? "—"} pos pending=${pending} wins=${wins} losses=${losses} rtdsAgeMs {${rtdsAges}} cache/oracleAgeMs {${oracleAges}} oracleSource {${oracleSources}} ${this.formatOracleTrendHealthBracket()}`
    );
    this.cleanupStaleBtc5mAutoEntryContexts(now);
  }

  /** Drop orphaned BTC 5m analytics contexts (no settlement); measurement logs unchanged for live paths. */
  private cleanupStaleBtc5mAutoEntryContexts(nowMs: number): void {
    const ttl = btc5mEntryContextTtlMs();
    const before = this.btc5mAutoEntryByTradeId.size;
    if (before === 0) return;
    let removed = 0;
    for (const [tradeId, ctx] of [...this.btc5mAutoEntryByTradeId.entries()]) {
      const ageMs = nowMs - ctx.createdAtMs;
      if (ageMs <= ttl) continue;
      this.btc5mAutoEntryByTradeId.delete(tradeId);
      removed += 1;
      this.log(
        "SIGNAL",
        `[BTC_5M_CONTEXT_CLEANUP] tradeId=${tradeId} windowSec=${ctx.windowSec} ageMs=${Math.round(ageMs)} reason=TTL_EXPIRED`
      );
    }
    if (removed > 0) {
      this.log(
        "SIGNAL",
        `[BTC_5M_CONTEXT_HEALTH] activeContexts=${this.btc5mAutoEntryByTradeId.size} removed=${removed} ttlMs=${ttl}`
      );
    }
  }

  onMarket?: (data: MarketWsPayload) => void;
  onPrediction?: (data: Prediction) => void;
  onTrades?: (data: Trade[]) => void;
  onStatus?: (data: Status) => void;
  onLog?: (data: { ts: number; level: LogLevel; message: string }) => void;
  onBetLog?: (data: BetLogEntry) => void;

  /**
   * BTC ~5m AUTO commit: log ENTRY_TIME_BTC_5M and store context on trade id for [BTC_5M_TRADE_RESULT] at close.
   */
  private registerAndLogBtc5mAutoEntry(
    tradeId: string,
    direction: Direction,
    tradeType: string,
    signalPercent: number,
    entryPrice: number
  ): void {
    const asset = this.wallet.getActiveDiscoveredAsset() ?? "?";
    const meta = this.wallet.getDiscoveredMeta();
    if (!isBtcFiveMinuteWindow(asset, meta) || meta?.windowStartSec == null || !meta.endDateIso) return;
    const end = new Date(meta.endDateIso).getTime();
    if (Number.isNaN(end)) return;
    const msBefore = Math.round(end - Date.now());
    const sp = Number.isFinite(signalPercent) ? signalPercent : 0;
    this.log(
      "SIGNAL",
      `[ENTRY_TIME_BTC_5M] windowSec=${meta.windowStartSec} ms_before_window_end=${msBefore} signalPercent=${sp.toFixed(1)} trade_type=${tradeType}`
    );
    const createdAtMs = Date.now();
    this.btc5mAutoEntryByTradeId.set(tradeId, {
      windowSec: meta.windowStartSec,
      asset: "BTC",
      direction,
      trade_type: tradeType,
      ms_before_window_end: msBefore,
      signalPercent: sp,
      entryPrice,
      createdAtMs,
      lastSeenState: "REGISTERED"
    });
  }

  /** On settlement / close: correlate with entry context; update buckets; periodic [BTC_5M_ENTRY_BUCKETS]. */
  private finalizeBtc5mAutoAnalytics(tradeId: string, settled: Trade, exitPrice: number, pnl: number): void {
    const ctx = this.btc5mAutoEntryByTradeId.get(tradeId);
    if (!ctx) return;
    this.btc5mAutoEntryByTradeId.delete(tradeId);
    const win = tradeRowInsightWin(settled);
    const result: "WIN" | "LOSS" = win ? "WIN" : "LOSS";
    this.log(
      "SIGNAL",
      `[BTC_5M_TRADE_RESULT] windowSec=${ctx.windowSec} asset=${ctx.asset} direction=${ctx.direction} trade_type=${ctx.trade_type} ms_before_window_end=${ctx.ms_before_window_end} signalPercent=${ctx.signalPercent.toFixed(1)} entryPrice=${ctx.entryPrice.toFixed(4)} exitPrice=${Number.isFinite(exitPrice) ? exitPrice.toFixed(4) : "nan"} pnl=${Number(pnl).toFixed(2)} result=${result}`
    );
    const bucket = btc5mEntryBucketForMsBeforeEnd(ctx.ms_before_window_end);
    const agg = this.btc5mEntryBucketStats[bucket];
    agg.trades += 1;
    if (win) agg.wins += 1;
    agg.pnlSum += pnl;
    this.btc5mTradeResultCount += 1;
    const every = btc5mEntryBucketRollupEveryN();
    if (this.btc5mTradeResultCount % every === 0) {
      for (const b of BTC_5M_ENTRY_BUCKET_KEYS) {
        const s = this.btc5mEntryBucketStats[b];
        const winRatePct = s.trades > 0 ? (100 * s.wins) / s.trades : 0;
        const avgPnl = s.trades > 0 ? s.pnlSum / s.trades : 0;
        this.log(
          "SIGNAL",
          `[BTC_5M_ENTRY_BUCKETS] bucket=${b} trades=${s.trades} winRate=${winRatePct.toFixed(1)}% avgPnl=${avgPnl.toFixed(2)}`
        );
      }
    }
  }

  /**
   * Auto-trade tick. Fast lane (~250ms) when anchor fast lane is enabled; otherwise 5s cadence for momentum.
   */
  private async runAutoTradeOnce(anchorFastLaneTick: boolean) {
    if (!this.running || !this.autoTrading) return;
    const strategy = this.effectiveEntryStrategy();
    const isAnchor = strategy === "anchor";
    const allowAnchorFastLane = isAnchor && this.anchorFastLaneEnabled();
    if (this.lagSnipeEnabled) {
      if (anchorFastLaneTick) return;
    } else {
      if (anchorFastLaneTick && !allowAnchorFastLane) return;
      if (!anchorFastLaneTick && allowAnchorFastLane) return;
    }
    if (this.bookRefreshInFlight) return;
    this.maybeLogRuntimeHealth();
    if (this.wallet.getMode() === "LIVE") {
      const now = Date.now();
      if (now - this.lastLiveExecEnvLogMs >= 8_000) {
        this.lastLiveExecEnvLogMs = now;
        const liveOk = this.canExecuteLiveOrders();
        const pt = process.env.PAPER_TRADING ?? "";
        const ex = process.env.EXECUTE_TRADES ?? "";
        const po = process.env.PAPER_ONLY ?? "";
        this.log(
          "SIGNAL",
          `[EXECUTION] Mode=LIVE liveEnabled=${liveOk} PAPER_TRADING=${pt} EXECUTE_TRADES=${ex} PAPER_ONLY=${po}`
        );
        if (!executeTradesEnv()) {
          this.log(
            "SIGNAL",
            "[MODE] LIVE wallet is ON but EXECUTE_TRADES=false. Please press Go LIVE on the UI once to enable live execution."
          );
        }
      }
    }
    const n = this.wallet.getDiscoveredSlotCount();
    try {
      if (this.lagSnipeEnabled) {
        await this.refreshLagSnipeKlinesIfEnabled();
      }
      if (n > 0) {
        const slots = this.wallet.getDiscoveredSlotsSnapshot();
        const enabledIndices = this.buildEnabledAutoTradeIndices(slots);
        if (enabledIndices.length === 0) {
          return;
        }
        const pick = this.pickAutoTradeSlotIndex(slots, enabledIndices);
        this.wallet.setActiveSlot(pick);
        this.directionalContext = await this.wallet.getDirectionalContext();
        const sel = this.wallet.getDiscoveredSelection();
        if (sel) {
          this.selectedMarket = { tokenID: sel.tokenID, label: sel.label, outcome: "AUTO" };
        }
      }

      const skipReason = this.autoTradeSkipReasonForActiveAsset();
      if (skipReason) {
        const asset = this.wallet.getActiveDiscoveredAsset() ?? "?";
        this.log("SIGNAL", `[AUTO][SKIP] asset=${asset} reason=${skipReason}`);
        return;
      }

      if (
        this.wallet.getMode() === "SIMULATION" &&
        paperBinarySettleEnabled() &&
        !this.lagSnipeEnabled
      ) {
        const metaClose = this.wallet.getDiscoveredMeta();
        if (metaClose?.endDateIso) {
          const endClose = new Date(metaClose.endDateIso).getTime();
          if (!Number.isNaN(endClose)) {
            const msLeftClose = endClose - Date.now();
            const asset = this.wallet.getActiveDiscoveredAsset() ?? "?";
            const { minGlobal, minEffective, effectiveSource } = resolveMinMsToWindowEndForOracleClose(
              asset,
              metaClose
            );
            if (msLeftClose < minEffective && msLeftClose > -60_000) {
              const ws = metaClose.windowStartSec;
              if (isBtcFiveMinuteWindow(asset, metaClose)) {
                this.log(
                  "SIGNAL",
                  `[ORACLE_TOO_CLOSE_BTC_5M] windowSec=${ws ?? "?"} ms_to_window_end=${Math.round(msLeftClose)} min_required_ms=${minGlobal} min_required_ms_effective=${minEffective} effective_source=${effectiveSource} btc_5m_end_buffer_ms=${minEffective}`
                );
              } else {
                this.log(
                  "SIGNAL",
                  `[AUTO][SKIP] ORACLE_TOO_CLOSE asset=${asset} ms_to_window_end=${Math.round(msLeftClose)} min_required_ms=${minGlobal} min_required_ms_effective=${minEffective} effective_source=${effectiveSource}`
                );
              }
              return;
            }
          }
        }
      }

      if (isAnchor) {
        this.maybeRotateAnchorWindow();
        await this.recordAnchorBuffers();
        if (!anchorFastLaneTick) {
          await this.monitorAnchorExits();
        }
        const asset = this.wallet.getActiveDiscoveredAsset() ?? "?";
        const oEnvA = loadOracleGateEnv();
        const metaA = this.wallet.getDiscoveredMeta();
        const wsA = metaA?.windowStartSec;
        let owA =
          this.oracleWindowStateByAsset.get(asset) ??
          freshOracleWindowState(wsA ?? 0, this.priceToBeatByAsset.get(asset) ?? null, Date.now());
        if (this.chainlinkAsset(asset) && (owA.strikePrice == null || owA.strikePrice <= 0)) {
          const skA = this.priceToBeatByAsset.get(asset);
          if (skA != null && Number.isFinite(skA) && skA > 0 && wsA != null) {
            owA = freshOracleWindowState(wsA, skA, Date.now());
          }
        }
        const wMin = evaluateOracleWindowMinTrendGate(asset.trim().toUpperCase(), owA, oEnvA);
        if (!wMin.ok) {
          if (wMin.code === "WINDOW_ORACLE_FLAT") {
            this.log(
              "SIGNAL",
              `[AUTO][SKIP] WINDOW_ORACLE_FLAT asset=${asset} trend=${owA.trend} deltaBps=${owA.trendDeltaBps.toFixed(2)} min_bps=${oEnvA.minWindowDeltaBps}`
            );
          } else {
            this.log(
              "SIGNAL",
              `[AUTO][SKIP] WINDOW_DELTA_BELOW_MIN asset=${asset} absDeltaBps=${Math.abs(owA.trendDeltaBps).toFixed(2)} min=${oEnvA.minWindowDeltaBps} trend=${owA.trend}`
            );
          }
          return;
        }
        const wk = this.getAnchorWindowKey() ?? "?";
        this.log(
          "SIGNAL",
          `[ANCHOR][PRIMARY] asset=${asset} window=${wk} runtimeEnabled=${this.anchorRuntimeEnabled} selected=true`
        );
        await this.maybeRunAnchorStrategy();
        return;
      }

      if (strategy === "market_making") {
        await this.runMarketMakingAutoOnce(anchorFastLaneTick);
        return;
      }

      const assetGate = this.wallet.getActiveDiscoveredAsset() ?? "BTC";
      if (!this.lagSnipeEnabled) {
        const oEnv = loadOracleGateEnv();
        const gateAgeMs = this.oracleEntryAgeMsForGate(assetGate);
        const staleCls = classifyOracleStale(gateAgeMs, oEnv);
        const clStaleLog = () => {
          if (!this.chainlinkAsset(assetGate)) {
            const g = gateAgeMs == null ? "null" : String(Math.round(gateAgeMs));
            return `gateAgeMs=${g}`;
          }
          const d = this.chainlinkFreshnessDiagnostics(assetGate);
          const g = gateAgeMs == null ? "null" : String(Math.round(gateAgeMs));
          const a = d.answerAgeMs == null ? "null" : String(Math.round(d.answerAgeMs));
          const f = d.fetchAgeMs == null ? "null" : String(Math.round(d.fetchAgeMs));
          return `gateAgeMs=${g} answerAgeMs=${a} fetchAgeMs=${f}`;
        };
        if (staleCls === "hard") {
          this.log("SIGNAL", `[AUTO][SKIP] ORACLE_STALE_HARD asset=${assetGate} ${clStaleLog()}`);
          await this.runAnchorFallbackNonPrimary();
          return;
        }
        if (staleCls === "soft") {
          this.log("SIGNAL", `[AUTO][SKIP] ORACLE_STALE_SOFT asset=${assetGate} ${clStaleLog()}`);
          await this.runAnchorFallbackNonPrimary();
          return;
        }
      }

      if (!this.lagSnipeEnabled) {
        const metaLw = this.wallet.getDiscoveredMeta();
        if (metaLw?.endDateIso) {
          const endLw = new Date(metaLw.endDateIso).getTime();
          if (!Number.isNaN(endLw)) {
            const msLeftLw = endLw - Date.now();
            const minRemMs = lateEntryMinMsToWindowEnd();
            if (msLeftLw < minRemMs && msLeftLw > -60_000) {
              this.log(
                "SIGNAL",
                `[AUTO][SKIP] LATE_WINDOW asset=${assetGate} ms_to_window_end=${Math.round(msLeftLw)} min_remaining_ms=${minRemMs}`
              );
              await this.runAnchorFallbackNonPrimary();
              return;
            }
          }
        }
      }

      this.maybeRotateAnchorWindow();
      await this.recordAnchorBuffers();
      if (!anchorFastLaneTick) {
        await this.monitorAnchorExits();
      }

      const choice = this.chooseDirectionalEntry();

      this.log(
        "SIGNAL",
        `[AUTO] asset=${this.wallet.getActiveDiscoveredAsset() ?? "?"} dir=${choice.direction} ${choice.reason}`
      );
      const direction = choice.direction;
      if (
        !this.lagSnipeEnabled &&
        this.prediction.recommendation === "NO_TRADE" &&
        !this.canIgnoreNoTradeForBookOnlyBlock("AUTO")
      ) {
        this.log("SIGNAL", `Auto-trade skipped (${this.prediction.reason ?? "direction mismatch"})`);
        await this.runAnchorFallbackNonPrimary();
        return;
      }
      if (!this.lagSnipeEnabled) {
        const oEnv = loadOracleGateEnv();
        const metaOg = this.wallet.getDiscoveredMeta();
        const wsSec = metaOg?.windowStartSec;
        const windowStartMs = wsSec != null ? wsSec * 1000 : null;
        let owState =
          this.oracleWindowStateByAsset.get(assetGate) ??
          freshOracleWindowState(wsSec ?? 0, this.priceToBeatByAsset.get(assetGate) ?? null, Date.now());
        if (this.chainlinkAsset(assetGate) && (owState.strikePrice == null || owState.strikePrice <= 0)) {
          const sk = this.priceToBeatByAsset.get(assetGate);
          if (sk != null && Number.isFinite(sk) && sk > 0 && wsSec != null) {
            owState = freshOracleWindowState(wsSec, sk, Date.now());
          }
        }
        const dirGate = evaluateOracleDirectionFlipGate({
          assetUpper: assetGate.trim().toUpperCase(),
          intendedDir: direction,
          state: owState,
          nowMs: Date.now(),
          windowStartMs,
          env: oEnv
        });
        if (!dirGate.ok) {
          if (dirGate.code === "STRIKE_PENDING") {
            this.log(
              "SIGNAL",
              `[AUTO][SKIP] ORACLE_TREND_INSUFFICIENT asset=${assetGate} samples=0 min_samples=1 (strike/window pending)`
            );
            await this.runAnchorFallbackNonPrimary();
            return;
          }
          if (dirGate.code === "WINDOW_ORACLE_FLAT") {
            this.log(
              "SIGNAL",
              `[AUTO][SKIP] WINDOW_ORACLE_FLAT asset=${assetGate} trend=${owState.trend} deltaBps=${owState.trendDeltaBps.toFixed(2)} min_bps=${oEnv.minWindowDeltaBps}`
            );
            await this.runAnchorFallbackNonPrimary();
            return;
          }
          if (dirGate.code === "WINDOW_DELTA_BELOW_MIN") {
            this.log(
              "SIGNAL",
              `[AUTO][SKIP] WINDOW_DELTA_BELOW_MIN asset=${assetGate} absDeltaBps=${Math.abs(owState.trendDeltaBps).toFixed(2)} min=${oEnv.minWindowDeltaBps} trend=${owState.trend}`
            );
            await this.runAnchorFallbackNonPrimary();
            return;
          }
          this.log(
            "SIGNAL",
            `[AUTO][SKIP] ORACLE_TREND_MISMATCH_CONFIRMED asset=${assetGate} momentum=${this.rawMomentumSide()} oracle_trend=${owState.trend} deltaBps=${owState.trendDeltaBps.toFixed(0)} flips=${owState.flipCountInWindow} oppTicks=${owState.consecutiveOppositeTicks}`
          );
          await this.runAnchorFallbackNonPrimary();
          return;
        }
        const ageOk = this.oracleEntryAgeMsForGate(assetGate);
        const okDiag = this.chainlinkAsset(assetGate) ? this.chainlinkFreshnessDiagnostics(assetGate) : null;
        const okExtra =
          okDiag != null
            ? ` gateAgeMs=${ageOk == null ? "null" : Math.round(ageOk)} answerAgeMs=${okDiag.answerAgeMs == null ? "null" : Math.round(okDiag.answerAgeMs)} fetchAgeMs=${okDiag.fetchAgeMs == null ? "null" : Math.round(okDiag.fetchAgeMs)}`
            : ` ageMs=${ageOk == null ? "null" : Math.round(ageOk)}`;
        this.log(
          "SIGNAL",
          `[AUTO][ORACLE_OK] asset=${assetGate} trend=${dirGate.trend} deltaBps=${dirGate.deltaBps.toFixed(0)} flips=${dirGate.flips} oppTicks=${dirGate.oppTicks}${okExtra}`
        );
      }
      const { amount: riskAmount, budget } = await this.computeAutoTradeAmount();
      if (riskAmount < this.effMinTrade()) {
        if (!budget) {
          this.log(
            "SIGNAL",
            `Skipped because budget unavailable (wallet.getAvailableCollateralBudget() returned null). MIN_TRADE=${this.effMinTrade()}`
          );
        } else {
          const total = budget.balanceUsdc;
          const reserved = budget.reservedUsdc;
          const available = budget.availableUsdc;
          this.log(
            "SIGNAL",
            `Skipped because available collateral ${available.toFixed(6)} < MIN_TRADE ${this.effMinTrade()} (total ${total.toFixed(
              6
            )}; reserved ${reserved.toFixed(6)})`
          );
        }
        await this.runAnchorFallbackNonPrimary();
        return;
      }
      if (this.wallet.getMode() === "LIVE" && riskAmount > 1 + 1e-9) {
        const rawCap = process.env.LIVE_TRADE_ABOVE_1_USD_OK;
        const blockLargeLive =
          rawCap !== undefined &&
          String(rawCap).trim() !== "" &&
          ["0", "false", "no", "off"].includes(String(rawCap).trim().toLowerCase());
        if (blockLargeLive) {
          this.log(
            "SIGNAL",
            `[AUTO][SKIP] LIVE_MAX_ENTRY_USD_1 size_usd=${riskAmount.toFixed(2)} (unset LIVE_TRADE_ABOVE_1_USD_OK or set true to allow; set false to block entries > $1)`
          );
          await this.runAnchorFallbackNonPrimary();
          return;
        }
      }
      const result = await this.trade(direction, riskAmount, "AUTO", choice.reason);
      if (!result.accepted) {
        this.log("ERROR", `Auto-trade blocked: ${result.reason ?? "unknown"}`);
        await this.runAnchorFallbackNonPrimary();
      } else {
        this.anchorTradedThisWindow = true;
        return;
      }
    } catch (e) {
      this.log("ERROR", `Auto-trade tick: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (this.wallet.getMode() === "SIMULATION" && this.syncPaperOpenMarksFromDirectionalBooks()) {
        this.onTrades?.([...this.trades]);
        this.pushStatus();
      }
    }
  }

  private getAnchorWindowKey(): string | null {
    const meta = this.wallet.getDiscoveredMeta();
    if (!meta?.slug) return null;
    return `${meta.slug}|${meta.windowStartSec ?? 0}`;
  }

  private maybeRotateAnchorWindow() {
    const key = this.getAnchorWindowKey();
    if (key !== this.lastAnchorWindowKey) {
      this.lastAnchorWindowKey = key;
      this.anchorTradedThisWindow = false;
      void this.primeOracleTrendBuffersForCoreAssets();
    }
  }

  /** Seed per-asset trend buffers on 5m window roll so non-active assets (ETH/SOL/XRP) are not stuck at 0 samples. */
  private async primeOracleTrendBuffersForCoreAssets(): Promise<void> {
    const assets = ["BTC", "ETH", "SOL", "XRP"] as const;
    const now = Date.now();
    for (const asset of assets) {
      const spot = this.oracleSpotUsdForAsset(asset);
      if (spot != null && Number.isFinite(spot) && spot > 0) {
        getChainlinkPriceHistoryBufferForAsset(asset).push(spot, now);
      }
    }
  }

  private sumDepthFromRaw(raw: unknown): { bid: number; ask: number } {
    const nb = normalizeRawOrderBook(raw);
    if (!nb) return { bid: 0, ask: 0 };
    const bid = nb.bids.slice(0, 12).reduce((s, l) => s + l.size, 0);
    const ask = nb.asks.slice(0, 12).reduce((s, l) => s + l.size, 0);
    return { bid, ask };
  }

  private async buildAnchorOrderBookSnapshot(): Promise<OrderBookSnapshot | null> {
    const ctx = this.directionalContext;
    if (!ctx) return null;
    const [rawUp, rawDown] = await Promise.all([
      this.wallet.getRawOrderBook(ctx.up.tokenID),
      this.wallet.getRawOrderBook(ctx.down.tokenID)
    ]);
    const u = this.sumDepthFromRaw(rawUp);
    const d = this.sumDepthFromRaw(rawDown);
    return {
      bidDepthUp: u.bid,
      askDepthUp: u.ask,
      bidDepthDown: d.bid,
      askDepthDown: d.ask
    };
  }

  private async recordAnchorBuffers(): Promise<void> {
    const now = Date.now();
    const core = ["BTC", "ETH", "SOL", "XRP"] as const;
    for (const asset of core) {
      const spot = this.oracleSpotUsdForAsset(asset);
      if (spot != null && Number.isFinite(spot) && spot > 0) {
        getChainlinkPriceHistoryBufferForAsset(asset).push(spot, now);
      }
    }
    const snap = await this.buildAnchorOrderBookSnapshot();
    if (!snap) return;
    const upImb =
      snap.bidDepthUp / (snap.bidDepthUp + snap.askDepthUp + 1e-12);
    const downImb =
      snap.bidDepthDown / (snap.bidDepthDown + snap.askDepthDown + 1e-12);
    this.anchorImbalanceHistoryUp.push(upImb);
    this.anchorImbalanceHistoryDown.push(downImb);
    while (this.anchorImbalanceHistoryUp.length > 10) this.anchorImbalanceHistoryUp.shift();
    while (this.anchorImbalanceHistoryDown.length > 10) this.anchorImbalanceHistoryDown.shift();
  }

  private buildAnchorStrategySnapshotPayload(): AnchorStrategySnapshot {
    const cfg = loadAnchorConfigFromEnv(this.effEntryUsd());
    const last = this.lastAnchorSignal;
    const selectedAsEntry = this.effectiveEntryStrategy() === "anchor";
    return {
      envEnabled: cfg.enabled,
      runtimeEnabled: this.anchorRuntimeEnabled,
      effectiveEnabled: cfg.enabled && this.anchorRuntimeEnabled && selectedAsEntry,
      selectedAsEntryStrategy: selectedAsEntry,
      fallbackEnabled: this.anchorFallbackEnabled(),
      stabilityTicks: cfg.stabilityTicks,
      ticksRecorded: this.anchorImbalanceHistoryUp.length,
      lastSignal: last
        ? {
            shouldTrade: last.shouldTrade,
            side: last.side,
            imbalanceScore: last.imbalanceScore,
            stabilityMet: last.stabilityMet,
            chainlinkMom: last.chainlinkMom,
            anchorPrice: last.anchorPrice,
            reason: last.reason,
            skipCategory: last.skipCategory
          }
        : null
    };
  }

  setAnchorStrategyEnabled(enabled: boolean): { ok: true; anchorStrategy: AnchorStrategySnapshot } {
    this.anchorRuntimeEnabled = enabled;
    this.pushStatus();
    return { ok: true, anchorStrategy: this.buildAnchorStrategySnapshotPayload() };
  }

  private anchorLogStructured(
    event: "ANCHOR_SKIP" | "ANCHOR_SIGNAL" | "ANCHOR_ENTRY" | "ANCHOR_EXIT",
    payload: Record<string, unknown>
  ) {
    const cfg = loadAnchorConfigFromEnv(this.effEntryUsd());
    const line = JSON.stringify({ event, ts: Date.now(), ...payload });
    if (event === "ANCHOR_SIGNAL" && !cfg.anchorDebugLogs) return;
    this.log(event === "ANCHOR_ENTRY" || event === "ANCHOR_EXIT" ? "TRADE" : "SIGNAL", line);
  }

  private async maybeRunAnchorStrategy(): Promise<void> {
    const cfg = loadAnchorConfigFromEnv(this.effEntryUsd());
    if (!cfg.enabled) return;
    if (!this.anchorRuntimeEnabled) return;

    const meta = this.wallet.getDiscoveredMeta();
    const endMs = meta?.endDateIso ? new Date(meta.endDateIso).getTime() : NaN;
    const secs = !Number.isNaN(endMs) ? Math.floor((endMs - Date.now()) / 1000) : null;
    const hasPending = this.trades.some((t) => tradeRowIsOpen(t.status));

    const pre = anchorEntryPreflight({
      cfg,
      envEnabled: cfg.enabled,
      runtimeEnabled: this.anchorRuntimeEnabled,
      lagSnipeEnabled: this.lagSnipeEnabled,
      hasLiveMarketData: this.wallet.hasLiveMarketData(),
      hasDirectionalContext: this.directionalContext != null,
      secondsToExpiry: secs,
      hasPendingTrade: hasPending,
      anchorTradedThisWindow: this.anchorTradedThisWindow
    });

    if (!pre.ok) {
      this.lastAnchorSignal = {
        shouldTrade: false,
        side: null,
        imbalanceScore: 0,
        stabilityMet: false,
        chainlinkMom: 0,
        anchorPrice: 0,
        reason: `ANCHOR_SKIP ${pre.category}: ${pre.reason}`,
        skipCategory: pre.category
      };
      if (pre.category !== "DISABLED" || cfg.anchorDebugLogs) {
        this.anchorLogStructured("ANCHOR_SKIP", {
          category: pre.category,
          reason: pre.reason,
          secondsToExpiry: secs,
          windowKey: this.getAnchorWindowKey()
        });
      }
      return;
    }

    const snap = await this.buildAnchorOrderBookSnapshot();
    if (!snap) {
      this.lastAnchorSignal = {
        shouldTrade: false,
        side: null,
        imbalanceScore: 0,
        stabilityMet: false,
        chainlinkMom: 0,
        anchorPrice: 0,
        reason: "ANCHOR_SKIP NO_LIVE_BOOK: snapshot null",
        skipCategory: "NO_LIVE_BOOK"
      };
      this.anchorLogStructured("ANCHOR_SKIP", { category: "NO_LIVE_BOOK", reason: "order book snapshot null" });
      return;
    }

    const ctx = this.directionalContext!;
    const upMid = ctx.up.mid;
    const downMid = ctx.down.mid;
    const buf = getChainlinkPriceHistoryBuffer();
    const hist = buf.snapshot();
    const tsMs = buf.snapshotTimestampsMs();
    const anchorAsset = this.wallet.getActiveDiscoveredAsset() ?? "BTC";
    const oracleAgeMs =
      this.oracleEntryAgeMsForGate(anchorAsset) ?? this.oracleAgeMsForAsset(anchorAsset);

    const sig = evaluateAnchorStrategy(
      snap,
      hist,
      upMid,
      downMid,
      [...this.anchorImbalanceHistoryUp],
      [...this.anchorImbalanceHistoryDown],
      cfg,
      oracleAgeMs,
      tsMs,
      Date.now()
    );
    this.lastAnchorSignal = sig;

    if (cfg.anchorDebugLogs) {
      this.anchorLogStructured("ANCHOR_SIGNAL", {
        sideCandidate: sig.side,
        upBidDepthShare: sig.upBidDepthShare,
        downBidDepthShare: sig.downBidDepthShare,
        chainlinkMom: sig.chainlinkMom,
        anchorYesPrice: upMid,
        anchorNoPrice: downMid,
        stabilityTicksRequired: cfg.stabilityTicks,
        stabilityDetail: sig.stabilityDetail,
        oracleAgeMs: oracleAgeMs ?? sig.oracleAgeMs,
        decision: sig.shouldTrade ? "ENTER" : "SKIP",
        skipCategory: sig.skipCategory,
        reason: sig.reason
      });
    }

    if (!sig.shouldTrade) {
      if (sig.skipCategory) {
        this.anchorLogStructured("ANCHOR_SKIP", {
          category: sig.skipCategory,
          reason: sig.reason,
          upBidDepthShare: sig.upBidDepthShare,
          downBidDepthShare: sig.downBidDepthShare,
          chainlinkMom: sig.chainlinkMom
        });
      } else {
        this.log("SIGNAL", sig.reason);
      }
      return;
    }

    const ref = sig.side === "UP" ? ctx.up : ctx.down;
    const slipEst = Number.isFinite(ref.bestAsk) && Number.isFinite(ref.mid) ? ref.bestAsk - ref.mid : null;
    const metaNow = this.wallet.getDiscoveredMeta();
    this.anchorLogStructured("ANCHOR_ENTRY", {
      side: sig.side,
      expectedMid: ref.mid,
      bestBid: ref.bestBid,
      bestAsk: ref.bestAsk,
      spread: ref.spread,
      slippageEstimateVsMid: slipEst,
      anchorTokenPrice: sig.anchorPrice,
      imbalanceScore: sig.imbalanceScore,
      chainlinkMom: sig.chainlinkMom,
      windowKey: this.getAnchorWindowKey(),
      marketSlug: metaNow?.slug ?? null
    });

    const amountUsd = cfg.tradeSize;
    if (this.wallet.getMode() === "LIVE") {
      this.log(
        "TRADE",
        `[ANCHOR][LIVE_TEST] amountUsd=${amountUsd.toFixed(2)} strategy=anchor fallback=${this.anchorFallbackEnabled()} mode=${this.wallet.getMode()}`
      );
    }
    const result = await this.trade(sig.side!, amountUsd, "AUTO", `ANCHOR: ${sig.reason}`);
    if (result.accepted) {
      this.anchorTradedThisWindow = true;
    }
  }

  private async monitorAnchorExits(): Promise<void> {
    const cfg = loadAnchorConfigFromEnv(this.effEntryUsd());
    if (!cfg.enabled || !this.anchorRuntimeEnabled) return;
    const pending = this.trades.filter(
      (t) => tradeRowIsOpen(t.status) && String(t.decisionReason ?? "").includes("ANCHOR:")
    );
    if (pending.length === 0) return;

    const snap = await this.buildAnchorOrderBookSnapshot();
    if (!snap) return;
    const upImb = snap.bidDepthUp / (snap.bidDepthUp + snap.askDepthUp + 1e-12);
    const downImb = snap.bidDepthDown / (snap.bidDepthDown + snap.askDepthDown + 1e-12);
    const hist = getChainlinkPriceHistoryBuffer().snapshot();
    let mom = 0;
    if (hist.length >= 4) {
      const now = hist[hist.length - 1]!;
      const ago = hist[hist.length - 4]!;
      if (Number.isFinite(now) && Number.isFinite(ago) && ago > 0) mom = (now - ago) / ago;
    }

    const meta = this.wallet.getDiscoveredMeta();
    const endMs = meta?.endDateIso ? new Date(meta.endDateIso).getTime() : NaN;
    const secs = !Number.isNaN(endMs) ? Math.floor((endMs - Date.now()) / 1000) : null;

    for (const t of pending) {
      const idx = this.trades.findIndex((x) => x.id === t.id);
      if (idx < 0) continue;
      let exitCategory: "RESOLUTION_BUFFER" | "IMBALANCE_FLIP" | "MOMENTUM_REVERSAL" | null = null;
      let why = "";
      if (secs != null && secs <= cfg.exitBufferSeconds) {
        exitCategory = "RESOLUTION_BUFFER";
        why = `resolution buffer (${secs}s <= ${cfg.exitBufferSeconds}s)`;
      } else if (t.direction === "UP" && upImb < 0.5) {
        exitCategory = "IMBALANCE_FLIP";
        why = "imbalance flip (UP book bid share < 0.5)";
      } else if (t.direction === "DOWN" && downImb > 0.5) {
        exitCategory = "IMBALANCE_FLIP";
        why = "imbalance flip (DOWN book bid share > 0.5)";
      } else if (t.direction === "UP" && anchorShouldExitUpOnMomentum(mom, cfg)) {
        exitCategory = "MOMENTUM_REVERSAL";
        why = `Chainlink momentum reversed (${mom.toFixed(6)})`;
      } else if (t.direction === "DOWN" && anchorShouldExitDownOnMomentum(mom, cfg.chainlinkMomThreshold)) {
        exitCategory = "MOMENTUM_REVERSAL";
        why = `Chainlink momentum reversed (${mom.toFixed(6)})`;
      }
      if (!exitCategory) continue;
      this.anchorLogStructured("ANCHOR_EXIT", {
        category: exitCategory,
        tradeId: t.id.slice(0, 8),
        direction: t.direction,
        reason: why,
        secondsToExpiry: secs,
        chainlinkMom: mom,
        upBidDepthShare: upImb,
        downBidDepthShare: downImb,
        entryPrice: t.price,
        note: "pnl not realized until exit fill confirms"
      });
      if (this.wallet.getMode() === "SIMULATION" && t.paper?.entryShares && t.paper?.tokenId) {
        await this.finalizePaperTradeExit(idx);
      } else if (this.wallet.getMode() === "LIVE" && !paperOnlyEnv()) {
        const tid =
          t.direction === "UP"
            ? this.directionalContext?.up.tokenID
            : this.directionalContext?.down.tokenID;
        const sh =
          t.paper?.entryShares ??
          (t.price > 1e-9 ? t.amount / t.price : 0);
        if (tid && sh > 0) {
          const r = await this.wallet.postMarketSellShares(tid, sh);
          if (r?.orderID) {
            this.log("TRADE", `ANCHOR_EXIT LIVE market SELL posted ${r.orderID.slice(0, 12)}…`);
          }
        }
      }
    }
  }

  /**
   * Run before wallet/markets init so Chainlink RPC + 4-asset probe always log on every server boot.
   * (Also safe to call once from `init()` if entry point does not await it.)
   */
  async bootChainlink(): Promise<void> {
    try {
      await this.chainlinkFeed.initializeRpc();
      await this.chainlinkFeed.testStartupConnectivity();
      console.log("[BOOT] Chainlink: initialized");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[BOOT] Chainlink failed: ${msg}`);
      console.warn("[BOOT] Chainlink: continuing without on-chain feeds (RTDS/cache may still apply).");
    }
  }

  async init() {
    const autoStart = String(process.env.AUTO_START_BOT ?? "true").toLowerCase() === "true";
    await this.wallet.init();
    if (this.wallet.getMode() === "LIVE") {
      syncExecutionEnvForUiMode("LIVE", {});
    }
    this.validateAnchorLiveTestConfig();
    this.logAnchorStartupResolvedConfig();
    try {
      this.markets = await this.wallet.getMarkets(25);
      const autoSel = this.wallet.getDiscoveredSelection();
      if (autoSel) {
        this.selectedMarket = { tokenID: autoSel.tokenID, label: autoSel.label, outcome: "AUTO" };
      } else {
        this.selectedMarket = this.markets[0] ?? this.selectedMarket;
      }
    } catch {
      this.log("ERROR", "Could not load markets, using fallback market list");
    }
    const updAssets = process.env.UPDOWN_ASSETS ?? process.env.UPDOWN_ASSET ?? "BTC";
    const eff = parseEnvEntryStrategy();
    const stratNote =
      eff === "anchor" ? "ANCHOR_STRATEGY (MOMENTUM_MODE ignored for signal path)" : `MOMENTUM_MODE=${momentumMode()}`;
    this.log(
      "SIGNAL",
      `Engine initialized in ${this.wallet.getMode()} mode (ENTRY_STRATEGY=${eff}${this.entryStrategyRuntime ? ` override=${this.entryStrategyRuntime}` : ""}, ${stratNote}, UPDOWN_5M=${updAssets})`
    );

    const execMode = this.wallet.getMode();
    const execFlags = `EXECUTE_TRADES=${executeTradesEnv()} PAPER_TRADING=${paperTradingEnv()} PAPER_ONLY=${paperOnlyEnv()}`;
    this.log(
      "SIGNAL",
      `Execution: ${execMode === "LIVE" ? "LIVE (real USDC)" : "SIMULATION (paper)"} | ${execFlags}`
    );
    console.log(
      `[EXECUTION] Execution: ${execMode === "LIVE" ? "LIVE (real USDC)" : "SIMULATION (paper)"} | ${execFlags}`
    );
    if (execMode === "LIVE" && String(process.env.EXECUTE_TRADES ?? "").trim() !== "true") {
      console.warn(
        "[STARTUP][WARN] MODE=LIVE but EXECUTE_TRADES is not true; live orders will not be sent"
      );
    }
    this.log(
      "SIGNAL",
      `[BOOT][CHECKLIST] mode=${execMode} simBalance=$${START_BALANCE} rtdsConnected=${
        this.polymarketRtds.isSocketOpen() ? "yes" : "no"
      } updownAssetsConfigured=${this.wallet.getUpdownAssetsConfigured().join(", ")}`
    );
    console.log(
      `[BOOT][CHECKLIST] mode=${execMode} simBalance=$${START_BALANCE} rtdsConnected=${
        this.polymarketRtds.isSocketOpen() ? "yes" : "no"
      } updownAssetsConfigured=${this.wallet.getUpdownAssetsConfigured().join(", ")}`
    );
    const boneActive = ["BONE_HIGH_CONF", "BONE_EQ", "BONE_LONGSHOT", "BONE_LATENCY"].filter((k) => boneEnvTrue(k));
    if (boneActive.length) {
      this.log("SIGNAL", `BONE entry filters enabled: ${boneActive.join(", ")}`);
    }
    this.polymarketRtds.start();
    this.synthesisRuntimeConfig = loadSynthesisConfigFromEnv();
    if (this.synthesisRuntimeConfig.enabled) {
      this.synthesisHub = new SynthesisMarketDataHub(this.synthesisRuntimeConfig);
      this.synthesisHub.start();
    } else {
      this.synthesisHub?.stop();
      this.synthesisHub = null;
    }
    this.syncAssetAutoTradeKeysFromConfigured();
    this.binanceAgg.start(this.wallet.getUpdownAssetsConfigured());
    this.running = autoStart;
    this.autoTrading = autoStart;
    this.setPhase(autoStart ? "STARTING" : "STOPPED", autoStart ? "AutoStart enabled" : undefined);
    if (autoStart) {
      this.log("TRADE", "Auto-trading enabled on startup");
    }
    if (this.effectiveEntryStrategy() === "anchor") {
      const b = this.basePredict();
      this.prediction = {
        ...b,
        recommendation: "TRADE",
        reason: "Anchor (book+Chainlink) warm start"
      };
    } else {
      this.prediction = { ...this.basePredict(), recommendation: "TRADE", reason: "Warm start" };
    }
    this.onPrediction?.(this.prediction);
    const tickBtcChart = async () => {
      if (this.chartPollInFlight) return;
      this.chartPollInFlight = true;
      try {
        try {
          await this.refreshSpotAnchorsForConfiguredAssets();
        } catch (e) {
          this.log("ERROR", `Multi-asset spot feed: ${e instanceof Error ? e.message : String(e)}`);
        }
        const cfgs = this.wallet.getUpdownAssetsConfigured();
        for (const sym of cfgs) {
          const s = this.lastSpotUsdByAsset.get(sym);
          if (s != null && Number.isFinite(s) && s > 0) {
            this.pushAssetSpotChartPoint(sym, s);
          }
        }
        const primarySym = cfgs[0] ?? "BTC";
        let primarySpot = this.lastSpotUsdByAsset.get(primarySym);
        if (primarySpot == null || !Number.isFinite(primarySpot) || primarySpot <= 0) {
          try {
            primarySpot = primarySym === "BTC" ? await fetchBtcUsd() : await fetchUsdSpot(primarySym);
            this.lastSpotUsdByAsset.set(primarySym, primarySpot);
          } catch (e) {
            this.log(
              "ERROR",
              `Chart primary feed (${primarySym}): ${e instanceof Error ? e.message : String(e)}`
            );
            this.onMarket?.(this.buildMarketWsPayload());
            return;
          }
        }
        this.pushMarketPointFromLiveBtc(primarySpot);
        this.onMarket?.(this.buildMarketWsPayload());
      } catch (e) {
        this.log("ERROR", `Chart feed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.chartPollInFlight = false;
      }
    };
    void tickBtcChart();
    setInterval(() => void tickBtcChart(), CHART_POLL_MS);
    setInterval(() => {
      this.synchronizeLivePredictionAndPhase(true);
    }, 5000);
    setInterval(() => void this.runAutoTradeOnce(false), 5000);
    setInterval(() => void this.runAutoTradeOnce(true), Math.max(50, envNum("OLA_AUTO_MS", 250)));
    setInterval(async () => {
      if (this.bookRefreshInFlight) return;
      this.bookRefreshInFlight = true;
      try {
        const rolled = await this.wallet.refreshActiveUpDownMarket();
        if (rolled) {
          this.setPhase("ROLLOVER", "Active 5m window rolled; refreshing token IDs");
          this.lastBroadcastPredKey = "";
          this.lastBroadcastPhaseKey = "";
          const sel = this.wallet.getDiscoveredSelection();
          if (sel) {
            this.selectedMarket = { tokenID: sel.tokenID, label: sel.label, outcome: "AUTO" };
            this.log("SIGNAL", `Active market rolled: ${sel.label}`);
          }
        }
        const slots = this.wallet.getDiscoveredSlotsSnapshot();
        this.syncAssetAutoTradeKeysFromConfigured();
        this.syncAutoTradeRotationActiveSlot(slots);
        const sel0 = this.wallet.getDiscoveredSelection();
        if (sel0) {
          this.selectedMarket = { tokenID: sel0.tokenID, label: sel0.label, outcome: "AUTO" };
        }
        const bookIds = new Set<string>();
        if (this.selectedMarket.tokenID) bookIds.add(this.selectedMarket.tokenID);
        for (const s of this.wallet.getDiscoveredSlotsSnapshot()) {
          bookIds.add(s.tokenIdUp);
          bookIds.add(s.tokenIdDown);
        }
        await this.wallet.primeBooksForTokens([...bookIds]);
        try {
          const [mc, dc] = await Promise.all([
            this.wallet.getMarketContext(this.selectedMarket.tokenID),
            this.wallet.getDirectionalContext()
          ]);
          this.marketContext = mc;
          this.directionalContext = dc;
          const metaSyn = this.wallet.getDiscoveredMeta();
          const assetSyn = this.wallet.getActiveDiscoveredAsset() ?? "BTC";
          if (this.synthesisHub && metaSyn?.tokenIdUp && metaSyn?.tokenIdDown) {
            this.synthesisHub.resyncSubscription({
              tokenIdUp: metaSyn.tokenIdUp,
              tokenIdDown: metaSyn.tokenIdDown,
              conditionId: metaSyn.conditionId,
              asset: assetSyn
            });
          }
          if (slots.length > 0) {
            this.polymarketRtds.start();
            const chainlinkAssets = ["BTC", "ETH", "SOL", "XRP"] as const;
            const chainlinkSet = new Set<string>(chainlinkAssets as unknown as string[]);
            const [entries, gammaResults] = await Promise.all([
              Promise.all(
                slots.map(async (s) => {
                  const [up, down] = await Promise.all([
                    this.wallet.getMarketContext(s.tokenIdUp),
                    this.wallet.getMarketContext(s.tokenIdDown)
                  ]);
                  const qu = this.bookQuality(up);
                  const qd = this.bookQuality(down);
                  return [
                    s.asset,
                    {
                      up: { mid: up.mid, spread: qu.spread, badge: qu.badge },
                      down: { mid: down.mid, spread: qd.spread, badge: qd.badge }
                    }
                  ] as const;
                })
              ),
              Promise.all(
                slots.map(async (s) => {
                  const g = await fetchGammaDisplayStats(s.slug);
                  return { s, g } as const;
                })
              )
            ]);

            // Per-asset window starts (for strike bump detection).
            const windowStartByChainlinkAsset = new Map<string, number>();
            for (const { s } of gammaResults) {
              const assetUpper = s.asset.trim().toUpperCase();
              if (!chainlinkSet.has(assetUpper)) continue;
              const ws = s.windowStartSec;
              if (ws == null) continue;
              windowStartByChainlinkAsset.set(assetUpper, ws);
            }

            // Poll Chainlink every book refresh for active UPDOWN slots — not only on 5m window bumps (otherwise
            // chainlinkUsdByAsset stays empty and UI shows RTDS/cache despite a working RPC).
            const chainlinkAssetsToPoll = chainlinkAssets.filter((a) =>
              slots.some((s) => s.asset.trim().toUpperCase() === a)
            );
            const shouldPollChainlink = slots.length > 0 && chainlinkAssetsToPoll.length > 0;

            const chainlinkTicksByAsset = new Map<string, ChainlinkUsdPriceTick>();
            if (shouldPollChainlink) {
              const staleMs = this.chainlinkStaleMs();
              let anyFreshChainlinkTick = false;
              const ticks = await Promise.all(
                chainlinkAssetsToPoll.map((a) => this.chainlinkFeed.getLatestUsdPrice(a))
              );
              for (let i = 0; i < chainlinkAssetsToPoll.length; i++) {
                const tick = ticks[i];
                const sym = chainlinkAssetsToPoll[i];
                if (tick) {
                  chainlinkTicksByAsset.set(sym, tick);
                  this.chainlinkLastSuccessfulFetchMs.set(sym, Date.now());
                }
              }
              // Always keep oracle spot + age from Chainlink only when it's fresh.
              for (const [asset, tick] of chainlinkTicksByAsset.entries()) {
                const ageMs = Date.now() - tick.updatedAt;
                if (ageMs <= staleMs) {
                  anyFreshChainlinkTick = true;
                  this.chainlinkUsdByAsset.set(asset, tick);
                }
                else this.chainlinkUsdByAsset.delete(asset);
              }
              // If we couldn't read a tick for a polled asset, don't keep an older stale tick around.
              for (const a of chainlinkAssetsToPoll) {
                if (!chainlinkTicksByAsset.has(a)) this.chainlinkUsdByAsset.delete(a);
              }

              // Production guardrail: if Chainlink never yields a fresh tick, remind about RPC placeholders.
              if (!anyFreshChainlinkTick) {
                this.chainlinkMissingStreak += 1;
                const now = Date.now();
                if (
                  this.chainlinkMissingStreak >= 3 &&
                  (this.lastChainlinkRpcReminderMs == null || now - this.lastChainlinkRpcReminderMs > 60_000)
                ) {
                  this.lastChainlinkRpcReminderMs = now;
                  this.log(
                    "SIGNAL",
                    `[RPC][REMINDER] Chainlink ticks are missing/stale (fallback likely active). Set a real Polygon RPC URL in POLYGON_RPC_URL or RPC_URL (no YOUR_KEY/YOUR_PROXY_URL placeholders). Current window starts may still trade using RTDS/cache.`
                  );
                }
              } else {
                this.chainlinkMissingStreak = 0;
              }

              this.logOracleSourceIfChanged(chainlinkAssetsToPoll);

              const gateEnv = loadOracleGateEnv();
              const nowOr = Date.now();
              for (const a of chainlinkAssetsToPoll) {
                const tick = chainlinkTicksByAsset.get(a);
                if (!tick) continue;
                const ws = windowStartByChainlinkAsset.get(a);
                const strike = this.priceToBeatByAsset.get(a);
                if (ws == null || strike == null || !Number.isFinite(strike) || strike <= 0) continue;
                let st = this.oracleWindowStateByAsset.get(a);
                if (!st || st.windowSec !== ws) {
                  st = freshOracleWindowState(ws, strike, nowOr);
                } else if (st.strikePrice != null && Math.abs(st.strikePrice - strike) > 1e-6) {
                  st = freshOracleWindowState(ws, strike, nowOr);
                }
                const prevFlips = st.flipCountInWindow;
                const fetchT = this.chainlinkLastSuccessfulFetchMs.get(a);
                const fetchAgeMs = fetchT != null ? Math.max(0, nowOr - fetchT) : null;
                const answerTsOk = this.isValidChainlinkAnswerTimestamp(tick.updatedAt, nowOr);
                const answerAgeMs = answerTsOk ? Math.max(0, nowOr - tick.updatedAt) : null;
                const gateAgeMsLive =
                  answerAgeMs != null ? answerAgeMs : fetchAgeMs != null ? fetchAgeMs : null;
                const liveKey = `${tick.price.toFixed(1)}|${gateAgeMsLive == null ? "na" : Math.floor(gateAgeMsLive / 2000)}`;
                if (this.lastChainlinkLiveLogKeyByAsset.get(a) !== liveKey) {
                  this.lastChainlinkLiveLogKeyByAsset.set(a, liveKey);
                  const aa = answerAgeMs == null ? "null" : String(Math.round(answerAgeMs));
                  const fa = fetchAgeMs == null ? "null" : String(Math.round(fetchAgeMs));
                  const ga = gateAgeMsLive == null ? "null" : String(Math.round(gateAgeMsLive));
                  this.log(
                    "SIGNAL",
                    `[CHAINLINK][LIVE] asset=${a} price=${tick.price.toFixed(2)} answerAgeMs=${aa} fetchAgeMs=${fa} gateAgeMs=${ga} source=chainlink`
                  );
                }
                const next = updateOracleWindowStateFromChainlink(st, tick.price, nowOr, gateEnv);
                this.oracleWindowStateByAsset.set(a, next);
                const winKey = `${next.windowSec}|${next.trend}|${next.trendDeltaBps.toFixed(1)}|${strike.toFixed(1)}`;
                if (this.lastOracleWindowLogKeyByAsset.get(a) !== winKey) {
                  this.lastOracleWindowLogKeyByAsset.set(a, winKey);
                  this.log(
                    "SIGNAL",
                    `[CHAINLINK][WINDOW] asset=${a} windowSec=${next.windowSec} strike=${strike.toFixed(2)} trend=${next.trend} deltaBps=${next.trendDeltaBps.toFixed(1)}`
                  );
                }
                if (next.flipCountInWindow > prevFlips) {
                  this.log(
                    "SIGNAL",
                    `[CHAINLINK][FLIP] asset=${a} windowSec=${ws} flipCount=${next.flipCountInWindow} side=${next.lastSideAboveStrike ?? "?"} deltaBps=${next.trendDeltaBps.toFixed(0)}`
                  );
                }
              }
            }

            this.multiSlotBooks = Object.fromEntries(entries);

            for (const { s, g } of gammaResults) {
              const assetUpper = s.asset.trim().toUpperCase();
              if (g) {
                this.gammaDisplayByAsset.set(assetUpper, {
                  up: g.up,
                  down: g.down,
                  priceToBeat: g.priceToBeat,
                  updatedMs: Date.now()
                });
              }
              const ws = s.windowStartSec;
              if (ws == null) continue;
              const prevWs = this.oracleWindowTrackedByAsset.get(assetUpper);
              const windowBumped = prevWs !== ws;

              // Chainlink strike capture for BTC/ETH/SOL/XRP:
              // - freshest Chainlink tick => strike from Chainlink
              // - stale Chainlink => RTDS mid fallback (no Gamma fallback)
              if (chainlinkSet.has(assetUpper)) {
                if (windowBumped) {
                  this.priceToBeatByAsset.delete(assetUpper);
                  const tick = chainlinkTicksByAsset.get(assetUpper) ?? null;
                  const staleMs = this.chainlinkStaleMs();
                  const now = Date.now();
                  if (tick && tick.price > 0) {
                    const ageMs = now - tick.updatedAt;
                    if (ageMs <= staleMs) {
                      this.priceToBeatByAsset.set(assetUpper, tick.price);
                      this.oracleWindowTrackedByAsset.set(assetUpper, ws);
                      this.log(
                        "SIGNAL",
                        `[CHAINLINK] strike captured asset=${assetUpper} windowSec=${ws} price=$${tick.price.toFixed(
                          2
                        )} source=chainlink deltaBps=0 flipsReset=1`
                      );
                      // Ensure oracle spot uses Chainlink for this asset during the window.
                      this.chainlinkUsdByAsset.set(assetUpper, tick);
                    } else {
                      const rtdsSpot = this.polymarketRtds.getUsdForAsset(assetUpper);
                      const spotAnchor = this.lastSpotUsdByAsset.get(assetUpper);
                      const fallbackSpot =
                        rtdsSpot != null ? rtdsSpot : spotAnchor != null ? spotAnchor : null;
                      const hasRtdsSpot = rtdsSpot != null && Number.isFinite(rtdsSpot) && rtdsSpot > 0;
                      const hasCacheSpot = spotAnchor != null && Number.isFinite(spotAnchor) && spotAnchor > 0;
                      const source = hasRtdsSpot ? "rtds" : hasCacheSpot ? "cache" : "—";
                      this.chainlinkUsdByAsset.delete(assetUpper);
                      if (fallbackSpot != null && Number.isFinite(fallbackSpot) && fallbackSpot > 0) {
                        this.priceToBeatByAsset.set(assetUpper, fallbackSpot);
                        this.oracleWindowTrackedByAsset.set(assetUpper, ws);
                      }
                      this.log(
                        "SIGNAL",
                        `[CHAINLINK][STALE] asset=${assetUpper} ageMs=${ageMs} > ${staleMs} — fallback strike=$${(
                          fallbackSpot ?? NaN
                        ).toFixed(2)} (source=${source}, windowSec=${ws})`
                      );
                    }
                  } else {
                    // Missing tick: fail safe to RTDS mid.
                    const rtdsSpot = this.polymarketRtds.getUsdForAsset(assetUpper);
                    const spotAnchor = this.lastSpotUsdByAsset.get(assetUpper);
                    const fallbackSpot =
                      rtdsSpot != null ? rtdsSpot : spotAnchor != null ? spotAnchor : null;
                    const hasRtdsSpot = rtdsSpot != null && Number.isFinite(rtdsSpot) && rtdsSpot > 0;
                    const hasCacheSpot = spotAnchor != null && Number.isFinite(spotAnchor) && spotAnchor > 0;
                    const source = hasRtdsSpot ? "rtds" : hasCacheSpot ? "cache" : "—";
                    this.chainlinkUsdByAsset.delete(assetUpper);
                    if (fallbackSpot != null && Number.isFinite(fallbackSpot) && fallbackSpot > 0) {
                      this.priceToBeatByAsset.set(assetUpper, fallbackSpot);
                      this.oracleWindowTrackedByAsset.set(assetUpper, ws);
                    }
                    this.log(
                      "SIGNAL",
                      `[CHAINLINK][MISSING] asset=${assetUpper} no tick — fallback strike=$${(
                        fallbackSpot ?? NaN
                      ).toFixed(2)} (source=${source}, windowSec=${ws})`
                    );
                  }
                }
              } else {
                if (g?.priceToBeat != null && Number.isFinite(g.priceToBeat)) {
                  this.priceToBeatByAsset.set(assetUpper, g.priceToBeat);
                  this.oracleWindowTrackedByAsset.set(assetUpper, ws);
                } else if (windowBumped) {
                  const spot = this.polymarketRtds.getUsdForAsset(assetUpper);
                  if (spot != null) this.priceToBeatByAsset.set(assetUpper, spot);
                  this.oracleWindowTrackedByAsset.set(assetUpper, ws);
                }
              }
            }
          } else {
            this.multiSlotBooks = null;
            this.gammaDisplayByAsset.clear();
            this.priceToBeatByAsset.clear();
            this.oracleWindowTrackedByAsset.clear();
            this.chainlinkUsdByAsset.clear();
            this.oracleWindowStateByAsset.clear();
            this.lastOracleWindowLogKeyByAsset.clear();
            this.chainlinkLastSuccessfulFetchMs.clear();
            this.lastChainlinkLiveLogKeyByAsset.clear();
            this.chainlinkInvalidAnswerTsWarned.clear();
          }
          this.lastBookRefreshMs = Date.now();
          this.synchronizeLivePredictionAndPhase(false);
        } finally {
          this.wallet.clearBookPrime();
        }
      } catch {
        this.log("ERROR", "Failed to refresh market context");
      } finally {
        this.bookRefreshInFlight = false;
      }
    }, 4000);
  }

  start() {
    this.running = true;
    this.autoTrading = false; // enable only after auth/health gates
    this.log("TRADE", "Bot started (directional momentum auto-trading enabled)");
    this.setPhase("STARTING", "User pressed Start Bot");

    // Auth gate is evaluated synchronously. Wallet already initialized on server boot.
    const mode = this.wallet.getMode();
    if (mode === "LIVE" && !this.wallet.isClobAuthenticated()) {
      this.setPhase("AUTH_CHECK", "LIVE selected but CLOB auth is not ready; refusing execution");
      this.autoTrading = false;
      return;
    }
    this.setPhase("INFRA_HEALTHY", "Wallet ready");
    this.autoTrading = true;
    this.pushStatus();
  }

  stop() {
    this.running = false;
    this.autoTrading = false;
    this.externalExecution = false;
    this.stopGtcMonitor?.();
    this.stopGtcMonitor = null;
    this.log("ERROR", "Bot stopped by user");
    this.setPhase("STOPPED");
    this.pushStatus();
  }

  setExternalExecutionEnabled(enabled: boolean) {
    this.externalExecution = enabled;
    this.pushStatus();
  }

  /** Switch demo (SIMULATION) vs real CLOB (LIVE). Stops the bot first. */
  async setMode(mode: "SIMULATION" | "LIVE"): Promise<{ ok: boolean; reason?: string }> {
    this.running = false;
    this.autoTrading = false;
    const r = await this.wallet.setMode(mode);
    const actual = this.wallet.getMode();
    if (actual !== mode) {
      syncExecutionEnvForUiMode(actual, {});
    }
    try {
      this.markets = await this.wallet.getMarkets(25);
      const autoSel = this.wallet.getDiscoveredSelection();
      if (autoSel) {
        this.selectedMarket = { tokenID: autoSel.tokenID, label: autoSel.label, outcome: "AUTO" };
      } else {
        this.selectedMarket = this.markets[0] ?? this.selectedMarket;
      }
      const bookIds = new Set<string>();
      if (this.selectedMarket.tokenID) bookIds.add(this.selectedMarket.tokenID);
      for (const s of this.wallet.getDiscoveredSlotsSnapshot()) {
        bookIds.add(s.tokenIdUp);
        bookIds.add(s.tokenIdDown);
      }
      await this.wallet.primeBooksForTokens([...bookIds]);
      try {
        const [mc2, dc2] = await Promise.all([
          this.wallet.getMarketContext(this.selectedMarket.tokenID),
          this.wallet.getDirectionalContext()
        ]);
        this.marketContext = mc2;
        this.directionalContext = dc2;
      } finally {
        this.wallet.clearBookPrime();
      }
    } catch {
      this.log("ERROR", "Could not refresh markets after mode change");
    }
    this.log(
      "SIGNAL",
      `Mode: ${this.wallet.getMode()}${r.ok ? "" : ` — ${r.reason ?? "LIVE unavailable"}`}`
    );
    this.pushStatus();
    return r;
  }

  status(): Status {
    return {
      running: this.running,
      autoTrading: this.autoTrading,
      mode: this.wallet.getMode(),
      balance: this.balance,
      cooldownMs: this.effCooldownMs(),
      stopLossTriggered: this.stopLossTriggered,
      phase: this.phase,
      phaseReason: this.phaseReason,
      paperTrading: paperTradingEnv(),
      paperOnly: paperOnlyEnv(),
      executeTrades: executeTradesEnv()
    };
  }

  /** Debug only: live execution env + gate (authenticated POST /api/debug/live-env). */
  getLiveExecutionDebugSnapshot() {
    return {
      MODE: process.env.MODE ?? "",
      PAPER_TRADING: process.env.PAPER_TRADING ?? "",
      PAPER_ONLY: process.env.PAPER_ONLY ?? "",
      EXECUTE_TRADES: process.env.EXECUTE_TRADES ?? "",
      walletMode: this.wallet.getMode(),
      canExecuteLiveOrders: this.canExecuteLiveOrders()
    };
  }

  /**
   * Per-row execution channel for dashboard: same `this.trades` queue; rows get `executionMode` at enqueue;
   * `getTrades()` adds `executionMode` via infer only when missing (legacy rows).
   */
  private inferTradeExecutionMode(t: Trade): "PAPER" | "LIVE" {
    if (this.wallet.getMode() === "SIMULATION") return "PAPER";
    if (this.externalExecution) return "LIVE";
    const oid = String(t.clobOrderId ?? "");
    if (oid.startsWith("paper-")) return "PAPER";
    if (t.paper != null) return "PAPER";
    if (!this.canExecuteLiveOrders() && paperTradingEnv()) return "PAPER";
    return "LIVE";
  }

  private mapTradesForApi(rows: Trade[]): Trade[] {
    return rows.map((t) => ({
      ...t,
      executionMode: t.executionMode ?? this.inferTradeExecutionMode(t)
    }));
  }

  getTrades(): Trade[] {
    return this.mapTradesForApi(this.trades);
  }

  async getWalletSummary() {
    const base = this.wallet.getSummary();
    if (base.mode !== "LIVE") {
      return { ...base, polymarketUsdc: null as number | null };
    }
    const polymarketUsdc = await this.wallet.getCollateralUsdc();
    return { ...base, polymarketUsdc };
  }

  getOpenOrders() {
    return this.wallet.getOpenOrders();
  }

  getBalanceAllowance() {
    return this.wallet.getBalanceAllowance();
  }

  getUserTrades() {
    return this.wallet.getUserTrades();
  }

  getMarketContext(tokenID: string) {
    return this.wallet.getMarketContext(tokenID);
  }

  /** Polymarket + spot + RPC + CLOB book (engine) latency snapshot for dashboard. */
  runConnectivityPings() {
    return runConnectivityPings({
      getMarketContext: (tokenID) => this.wallet.getMarketContext(tokenID),
      getClobHost: () => this.wallet.getClobHostForPing(),
      getSampleTokenId: () =>
        this.wallet.getSampleTokenIdForPing() ?? this.selectedMarket.tokenID ?? null
    });
  }

  getClobSigningConfig() {
    return this.wallet.getPublicSigningConfig();
  }

  getMarketData(): MarketWsPayload {
    return this.buildMarketWsPayload();
  }

  getPrediction() {
    return this.prediction;
  }

  getMarkets() {
    return this.markets;
  }

  selectMarket(tokenID: string) {
    const selected = this.markets.find((m) => m.tokenID === tokenID);
    if (!selected) return false;
    this.selectedMarket = selected;
    this.marketContext = { tokenID, mid: 0.5, spread: 0.02, liquidity: 1500, bestBid: 0.49, bestAsk: 0.51 };
    this.log("SIGNAL", `Selected market: ${selected.label}`);
    return true;
  }

  getInsights(): Insights {
    const finished = this.trades.filter((t) => !tradeRowIsOpen(t.status) && !t.paper?.missed);
    const wins = finished.filter((t) => tradeRowInsightWin(t));
    const losses = finished.filter((t) => tradeRowInsightLoss(t));
    const grouped = new Map<string, { wins: number; total: number }>();
    finished.forEach((t) => {
      const cur = grouped.get(t.market) ?? { wins: 0, total: 0 };
      cur.total += 1;
      if (tradeRowInsightWin(t)) cur.wins += 1;
      grouped.set(t.market, cur);
    });
    return {
      totalTrades: finished.length,
      wins: wins.length,
      losses: losses.length,
      noTradeSignals: this.noTradeSignals,
      marketWinRates: [...grouped.entries()].map(([market, v]) => ({
        market,
        winRate: v.total ? (v.wins / v.total) * 100 : 0,
        trades: v.total
      })),
      gtcExit: { ...this.gtcMetrics },
      highConfMidBlocked: this.highConfMidBlocked,
      boneEntryFilters: {
        highConf: this.boneHighConfBlocked,
        equilibrium: this.boneEqBlocked,
        longshot: this.boneLongshotBlocked,
        latency: this.boneLatencyBlocked
      }
    };
  }

  private pushStatus() {
    this.onStatus?.(this.status());
  }

  private log(level: LogLevel, message: string) {
    this.onLog?.({ ts: Date.now(), level, message });
  }

  getBetLogs(): BetLogEntry[] {
    return [...this.betLogs];
  }

  private pushBetLog(entry: BetLogEntry) {
    this.betLogs = [entry, ...this.betLogs].slice(0, 80);
    this.onBetLog?.(entry);
  }

  /** Snapshot of pair mids + asset at trade entry (for history / UI). */
  private tradeEntrySnapshot(): {
    asset?: string;
    upPriceAtEntry?: number;
    downPriceAtEntry?: number;
  } {
    const asset = this.wallet.getActiveDiscoveredAsset() ?? undefined;
    const dc = this.directionalContext;
    if (dc && this.wallet.hasLiveMarketData()) {
      return {
        asset,
        upPriceAtEntry: dc.up.mid,
        downPriceAtEntry: dc.down.mid
      };
    }
    const last = this.marketData.at(-1);
    if (last) {
      return {
        asset,
        upPriceAtEntry: last.up / 100,
        downPriceAtEntry: last.down / 100
      };
    }
    return { asset };
  }

  private buildBetLog(
    outcome: BetLogEntry["outcome"],
    direction: Direction,
    book: MarketContext,
    extra: Partial<BetLogEntry> = {}
  ): BetLogEntry {
    const timing = this.wallet.getTimingForBetLog();
    return {
      ts: Date.now(),
      tradingMode: this.wallet.getMode(),
      outcome,
      marketTitle: this.selectedMarket.label,
      tokenId: book.tokenID,
      direction,
      bestBid: book.bestBid,
      bestAsk: book.bestAsk,
      mid: book.mid,
      spread: book.spread,
      liquidity: book.liquidity,
      priceUnit: "decimal_0_1",
      secondsSinceWindowStart: timing.secondsSinceWindowStart,
      warmupWindow: timing.warmupWindow,
      ...extra
    };
  }

  /** LIVE: use UP/DOWN token book for the side we trade; else selected market (sim uses synthetic book). */
  private liveBookForDirection(direction: Direction): MarketContext {
    if (this.wallet.hasLiveMarketData() && this.directionalContext) {
      return direction === "UP" ? this.directionalContext.up : this.directionalContext.down;
    }
    return this.marketContext;
  }

  /**
   * Incremental entry filters (BONE_* env flags). When enabled, all enabled gates must pass.
   * Does not replace SIGNAL_MODE / risk limits / execution or exits.
   */
  private checkBoneEntryFilters(
    direction: Direction,
    book: MarketContext
  ): { ok: true } | { ok: false; code: string; detail: string } {
    if (this.lagSnipeEnabled) return { ok: true };
    if (this.effectiveEntryStrategy() === "anchor") {
      return { ok: true };
    }
    const c = this.prediction.confidence;
    const conf01 = c > 1 ? c / 100 : c;

    if (boneEnvTrue("BONE_HIGH_CONF")) {
      const minPctRaw = envNum("BONE_HIGH_CONF_MIN_PCT", BONE_SCALP_MIN_CONF_PCT);
      const minPct =
        !Number.isFinite(minPctRaw) || minPctRaw < 50 || minPctRaw > 100 ? BONE_SCALP_MIN_CONF_PCT : minPctRaw;
      const minCmRaw = envNum("BONE_HIGH_CONF_MIN_CM", BONE_SCALP_MIN_CONF_TIMES_MID);
      const minCmEff =
        !Number.isFinite(minCmRaw) || minCmRaw <= 0 || minCmRaw > 1
          ? BONE_SCALP_MIN_CONF_TIMES_MID
          : minCmRaw;
      const midThr = highConfMidThreshold();
      if (c < minPct) {
        this.boneHighConfBlocked += 1;
        return { ok: false, code: "BONE_HIGH_CONF", detail: `conf ${c.toFixed(2)}% < min ${minPct}% (scalp)` };
      }
      const prod = conf01 * book.mid;
      const bookHighConf = book.mid >= midThr || prod >= minCmEff;
      if (!bookHighConf) {
        this.boneHighConfBlocked += 1;
        return {
          ok: false,
          code: "BONE_HIGH_CONF",
          detail:
            `scalp book gate: need mid≥${midThr} OR conf×mid≥${minCmEff} — got mid=${book.mid.toFixed(4)} conf×mid=${prod.toFixed(4)}`
        };
      }
      const ctx = this.directionalContext;
      if (ctx && this.wallet.hasLiveMarketData()) {
        const whaleFrac = envNum("BONE_HIGH_CONF_WHALE_FRAC", BONE_SCALP_WHALE_FRAC);
        const wf =
          !Number.isFinite(whaleFrac) || whaleFrac <= 0 || whaleFrac > 1 ? BONE_SCALP_WHALE_FRAC : whaleFrac;
        const maxL = Math.max(ctx.up.liquidity, ctx.down.liquidity);
        const sideL = direction === "UP" ? ctx.up.liquidity : ctx.down.liquidity;
        if (maxL > 0 && sideL < wf * maxL) {
          this.boneHighConfBlocked += 1;
          return {
            ok: false,
            code: "BONE_HIGH_CONF",
            detail: `side liquidity ${sideL.toFixed(0)} < ${(wf * 100).toFixed(0)}% of pair max ${maxL.toFixed(0)} (whale-depth)`
          };
        }
      }
    }

    if (boneEnvTrue("BONE_EQ")) {
      const band = envNum("BONE_EQ_BAND", 0.08);
      const b = !Number.isFinite(band) || band <= 0 || band > 0.5 ? 0.08 : band;
      const ctx = this.directionalContext;
      if (ctx && this.wallet.hasLiveMarketData()) {
        if (Math.abs(ctx.up.mid - 0.5) > b || Math.abs(ctx.down.mid - 0.5) > b) {
          this.boneEqBlocked += 1;
          return {
            ok: false,
            code: "BONE_EQ",
            detail: `UP/DOWN mids not in equilibrium band ±${b} around 0.5`
          };
        }
      } else if (Math.abs(book.mid - 0.5) > b) {
        this.boneEqBlocked += 1;
        return {
          ok: false,
          code: "BONE_EQ",
          detail: `mid ${book.mid.toFixed(4)} outside ±${b} of 0.5 (SIM/single book)`
        };
      }
    }

    if (boneEnvTrue("BONE_LONGSHOT")) {
      const mode = String(process.env.BONE_LONGSHOT_MODE ?? "cheap").toLowerCase();
      if (mode === "favorite" || mode === "rich") {
        const minMid = envNum("BONE_LONGSHOT_MIN_MID", 0.58);
        const mm = !Number.isFinite(minMid) || minMid <= 0 || minMid >= 1 ? 0.58 : minMid;
        if (book.mid < mm) {
          this.boneLongshotBlocked += 1;
          return {
            ok: false,
            code: "BONE_LONGSHOT",
            detail: `mid ${book.mid.toFixed(4)} < ${mm} (favorite-only mode)`
          };
        }
      } else {
        const maxMid = envNum("BONE_LONGSHOT_MAX_MID", 0.42);
        const xm = !Number.isFinite(maxMid) || maxMid <= 0 || maxMid >= 1 ? 0.42 : maxMid;
        if (book.mid > xm) {
          this.boneLongshotBlocked += 1;
          return {
            ok: false,
            code: "BONE_LONGSHOT",
            detail: `mid ${book.mid.toFixed(4)} > ${xm} (longshot/cheap-side only)`
          };
        }
      }
    }

    if (boneEnvTrue("BONE_LATENCY")) {
      const minBps = envNum("BONE_LATENCY_MIN_MOVE_BPS", 5);
      const need = !Number.isFinite(minBps) || minBps < 0 ? 5 : minBps;
      const sym = this.wallet.getActiveDiscoveredAsset();
      if (sym) {
        const lastUsd = this.lastSpotUsdByAsset.get(sym);
        const win = this.spotWindowByAsset.get(sym);
        if (lastUsd != null && win != null && win.openUsd > 0) {
          const bps = (Math.abs(lastUsd - win.openUsd) / win.openUsd) * 10_000;
          if (bps < need) {
            this.boneLatencyBlocked += 1;
            return {
              ok: false,
              code: "BONE_LATENCY",
              detail: `window ${sym} move ${bps.toFixed(2)} bps < min ${need} bps (latency proxy)`
            };
          }
        } else {
          this.boneLatencyBlocked += 1;
          return {
            ok: false,
            code: "BONE_LATENCY",
            detail: `missing ${sym} spot or window-open ref for move bps`
          };
        }
      } else {
        const last = this.marketData[this.marketData.length - 1];
        if (last?.btcUsd == null || this.btcTargetUsd == null || this.btcTargetUsd <= 0) {
          this.boneLatencyBlocked += 1;
          return { ok: false, code: "BONE_LATENCY", detail: "missing BTC or window-open ref for move bps" };
        }
        const bps = (Math.abs(last.btcUsd - this.btcTargetUsd) / this.btcTargetUsd) * 10_000;
        if (bps < need) {
          this.boneLatencyBlocked += 1;
          return {
            ok: false,
            code: "BONE_LATENCY",
            detail: `window BTC move ${bps.toFixed(2)} bps < min ${need} bps (latency proxy)`
          };
        }
      }
    }

    return { ok: true };
  }

  getGtcExitMetrics(): GtcExitMetrics {
    return { ...this.gtcMetrics };
  }

  /**
   * Post GTC limit on the opposite outcome token after a successful entry (LIVE: clob-client only).
   * Entry is always BUY today; maps to SELL on opposite @ GTC_EXIT_PRICE (clamped).
   */
  private async postGtcExit(
    entryTokenId: string,
    entryShares: number,
    entrySide: "BUY" | "SELL",
    direction: Direction,
    tradeId: string
  ) {
    const row = this.trades.find((t) => t.id === tradeId);
    if (row?.lagSnipeHold) return;
    if (!gtcExitEnabled()) return;
    this.gtcMetrics.postsAttempted += 1;
    const maxShares = envNum("MAX_GTC_SIZE", 100);
    const gtcPrice = clampGtcPrice();
    const r = await this.wallet.postGtcOppositeExit({
      direction,
      entrySide,
      entryShares,
      gtcPrice,
      maxShares
    });
    if (!r) {
      this.log("ERROR", `GTC_POST failed token=${entryTokenId} shares=${entryShares} price=${gtcPrice}`);
      return;
    }
    this.gtcMetrics.postsAccepted += 1;
    this.log(
      "TRADE",
      `GTC_POST: token=${r.tokenID} price=${gtcPrice} shares=${r.size} hash=${r.orderID} latency=${r.latencyMs}ms`
    );
    const idx = this.trades.findIndex((t) => t.id === tradeId);
    if (idx >= 0) {
      this.trades[idx] = {
        ...this.trades[idx],
        gtcExitOrderId: r.orderID,
        gtcExitTargetShares: r.size
      };
      this.onTrades?.([...this.trades]);
    }
    this.startGtcExitMonitor(tradeId, r.orderID, r.tokenID, r.size);
  }

  /**
   * Poll CLOB `getOrder` every 50ms (fills proxy for getOrderFills). Pre-resolve: cancel opposite-asset orders.
   */
  private startGtcExitMonitor(
    tradeId: string,
    gtcOrderId: string,
    oppositeTokenId: string,
    targetShares: number
  ) {
    this.stopGtcMonitor?.();
    let alive = true;
    const releaseMonitor = () => {
      alive = false;
    };
    this.stopGtcMonitor = releaseMonitor;

    const preResolveSec = envNum("CANCEL_PRE_RESOLVE_SEC", 30);
    const lockPct = gtcFillLockPct();

    void (async () => {
      try {
        let lastMatched = -1;
        let preResolveDone = false;
        while (alive) {
          await new Promise((r) => setTimeout(r, 100));
          if (!alive) break;

          const tIdx = this.trades.findIndex((t) => t.id === tradeId);
          if (tIdx < 0) break;
          const trade = this.trades[tIdx];
          if (!tradeRowIsOpen(trade.status)) break;

          const meta = this.wallet.getDiscoveredMeta();
          const endParsed = meta?.endDateIso ? new Date(meta.endDateIso).getTime() : NaN;
          const secLeft = !Number.isNaN(endParsed) ? Math.floor((endParsed - Date.now()) / 1000) : null;

          if (secLeft != null && secLeft <= preResolveSec && secLeft >= 0 && !preResolveDone) {
            preResolveDone = true;
            await this.wallet.cancelMarketOrdersForAsset(oppositeTokenId);
            this.gtcMetrics.preResolveCancels += 1;
            this.log("TRADE", `GTC_CANCEL: pre-resolve time=${secLeft}s`);
            break;
          }

          const o = await this.wallet.getOrder(gtcOrderId);
          if (!o) continue;
          const matched = Number(o.size_matched ?? 0);
          const orig = Number(o.original_size ?? targetShares) || targetShares;
          if (matched !== lastMatched) {
            lastMatched = matched;
            this.gtcMetrics.fillLogEvents += 1;
            this.gtcMetrics.fillRatioSum += orig > 0 ? matched / orig : 0;
            this.log("TRADE", `GTC_FILL: ${matched}/${orig} shares filled rebate=n/a`);
          }
          if (orig > 0 && matched >= orig * lockPct && !trade.gtcProfitLocked) {
            const uIdx = this.trades.findIndex((t) => t.id === tradeId);
            if (uIdx >= 0) {
              this.trades[uIdx] = { ...this.trades[uIdx], gtcProfitLocked: true };
              this.onTrades?.([...this.trades]);
            }
            this.gtcMetrics.profitLocks += 1;
            this.log(
              "TRADE",
              `GTC_PROFIT_LOCK: ${matched}/${orig} >= ${(lockPct * 100).toFixed(0)}% threshold`
            );
          }
          if (orig > 0 && matched >= orig * 0.999) break;
        }
      } finally {
        if (this.stopGtcMonitor === releaseMonitor) {
          this.stopGtcMonitor = null;
        }
      }
    })();
  }

  async trade(direction: Direction, amount: number, source: "MANUAL" | "AUTO" = "MANUAL", decisionReason?: string) {
    if (!this.running) return { accepted: false, reason: "Engine is stopped" };
    const strat = this.effectiveEntryStrategy();
    const anchorAutoAnchorPath =
      strat === "anchor" &&
      source === "AUTO" &&
      typeof decisionReason === "string" &&
      decisionReason.startsWith("ANCHOR:");
    const botCfg = loadBotFiltersConfig();
    if (this.stopLossTriggered) {
      this.setPhase("ERROR", "Stop loss triggered");
      return { accepted: false, reason: "Stop loss triggered" };
    }
    if (this.lagSnipeEnabled) {
      // User override: lock Lag Snipe to fixed $1 entries.
      amount = 1;
    }
    if (amount < this.effMinTrade() || amount > this.effMaxTrade()) {
      this.setPhase("RISK_BLOCKED", "Trade limits violated");
      return { accepted: false, reason: "Trade limits violated" };
    }
    if (this.wallet.getMode() === "SIMULATION" && amount > this.balance) {
      this.setPhase("RISK_BLOCKED", "Insufficient balance");
      return { accepted: false, reason: "Insufficient balance" };
    }
    const cdKey = this.wallet.getActiveDiscoveredSlug() ?? "__default__";
    const lastCd = this.lastTradeAtBySlug.get(cdKey) ?? 0;
    if (Date.now() - lastCd < this.effCooldownMs()) {
      this.setPhase("RISK_BLOCKED", "Cooldown active");
      return { accepted: false, reason: "Cooldown active" };
    }

    if (this.lagSnipeEnabled) {
      const ev = this.evaluateLagSnipeDisplay();
      if (ev.recommendation !== "TRADE" || ev.prediction !== direction) {
        this.setPhase("SIGNAL_READY", ev.reason);
        return { accepted: false, reason: ev.reason };
      }
    }

    const minConfPct = Number(process.env.MIN_SIGNAL_CONF_PCT ?? 75);
    if (
      !anchorAutoAnchorPath &&
      !this.lagSnipeEnabled &&
      source === "AUTO" &&
      Number.isFinite(minConfPct) &&
      minConfPct > 0 &&
      minConfPct <= 100
    ) {
      const c = this.prediction.confidence;
      const conf01 = c > 1 ? c / 100 : c;
      if (conf01 < minConfPct / 100 - 1e-9) {
        this.setPhase("RISK_BLOCKED", "Signal below confidence threshold");
        return {
          accepted: false,
          reason: `MIN_SIGNAL_CONF: ${(conf01 * 100).toFixed(1)}% < ${minConfPct}%`
        };
      }
    }

    if (
      !anchorAutoAnchorPath &&
      !this.lagSnipeEnabled &&
      this.prediction.recommendation === "NO_TRADE" &&
      !this.canIgnoreNoTradeForBookOnlyBlock(source)
    ) {
      this.setPhase("SIGNAL_READY", this.prediction.reason);
      return { accepted: false, reason: `No-trade signal: ${this.prediction.reason}` };
    }

    const cfgGate = this.checkConfigTradeFilters(strat, botCfg);
    if (!cfgGate.ok) {
      this.setPhase("RISK_BLOCKED", cfgGate.reason);
      return { accepted: false, reason: cfgGate.reason };
    }

    const book = this.liveBookForDirection(direction);
    if (strat !== "anchor" && !this.lagSnipeEnabled && signalModeHighConf()) {
      const thr = highConfMidThreshold();
      const mid = book.mid;
      const c = this.prediction.confidence;
      const conf01 = c > 1 ? c / 100 : c;
      const prod = conf01 * mid;
      const passes = mid >= thr || prod >= thr;
      if (!passes) {
        this.highConfMidBlocked += 1;
        const projectedSimWin = amount * (this.prediction.confidence / 100);
        this.log(
          "SIGNAL",
          `LOW_CONF_MID mid=${mid.toFixed(4)} conf=${c.toFixed(2)}% conf×mid=${prod.toFixed(4)} need≥${thr} ` +
            `| proj.simWinPnL_if_taken=$${projectedSimWin.toFixed(2)} on $${amount.toFixed(2)} stake | blocked#${this.highConfMidBlocked}`
        );
        this.setPhase("RISK_BLOCKED", "LOW_CONF_MID");
        this.pushBetLog(
          this.buildBetLog("blocked", direction, book, {
            blockReason: `LOW_CONF_MID: mid=${mid.toFixed(4)} conf×mid=${prod.toFixed(4)} < ${thr} (proj.simWinPnL $${projectedSimWin.toFixed(2)})`
          })
        );
        return { accepted: false, reason: "LOW_CONF_MID" };
      }
    }
    const exec = this.liveBookTradability(book);
    if (!exec.ok) {
      const paperCtx =
        this.wallet.getMode() === "SIMULATION" || paperTradingEnv();
      if (paperCtx) {
        const a = this.wallet.getActiveDiscoveredAsset() ?? "?";
        this.log(
          "TRADE",
          `[PAPER][SKIP] BOOKS_NOT_TRADABLE asset=${a} side=${direction} reason=${exec.detail}`
        );
      }
      this.setPhase("MARKET_NOT_TRADABLE", `Execution gate failed: ${exec.detail}`);
      this.pushBetLog(
        this.buildBetLog("blocked", direction, book, {
          blockReason: `Execution filter: ${exec.detail}`
        })
      );
      return {
        accepted: false,
        reason: `Execution filter: ${exec.detail}`
      };
    }

    const bone = this.checkBoneEntryFilters(direction, book);
    if (!bone.ok) {
      this.setPhase("RISK_BLOCKED", bone.code);
      const replay = `BONE_BLOCK ${bone.code}: ${bone.detail}`;
      this.log("SIGNAL", replay);
      this.pushBetLog(
        this.buildBetLog("blocked", direction, book, {
          blockReason: replay
        })
      );
      return { accepted: false, reason: bone.detail };
    }

    let effectiveAmount = amount;
    if (this.lagSnipeEnabled) {
      effectiveAmount = 1;
    }
    if (
      this.wallet.getMode() === "SIMULATION" &&
      !this.lagSnipeEnabled &&
      simKellySizingEnabled()
    ) {
      const bankroll = this.balance;
      const kFrac = Number(process.env.KELLY_BANKROLL_FRAC ?? 0.02);
      const mid = book.mid;
      if (mid > 0 && Number.isFinite(bankroll) && bankroll > 0 && Number.isFinite(kFrac) && kFrac > 0) {
        const kellyUsd = (kFrac * bankroll) / mid;
        const maxPos = Number(process.env.MAX_POSITION_USD ?? this.effMaxTrade());
        const capped = Math.min(kellyUsd, Number.isFinite(maxPos) ? maxPos : this.effMaxTrade(), bankroll);
        effectiveAmount = Math.min(this.effMaxTrade(), Math.max(this.effMinTrade(), capped));
      }
    }
    // --- Live execution: collateral reads only when real CLOB posts are allowed. ---
    if (this.canExecuteLiveOrders()) {
      const budget = await this.wallet.getAvailableCollateralBudget();
      if (budget) {
        if (budget.availableUsdc < this.effMinTrade()) {
          const reason = `Skipped because available collateral ${budget.availableUsdc.toFixed(6)} < MIN_TRADE ${this.effMinTrade()}`;
          this.log(
            "SIGNAL",
            `Collateral filter: total=${budget.balanceUsdc.toFixed(6)} reserved=${budget.reservedUsdc.toFixed(
              6
            )} available=${budget.availableUsdc.toFixed(6)} MIN_TRADE=${this.effMinTrade()}`
          );
          this.setPhase("RISK_BLOCKED", reason);
          return { accepted: false, reason };
        }

        effectiveAmount = Math.min(amount, budget.availableUsdc);
        effectiveAmount = Math.min(this.effMaxTrade(), Math.max(this.effMinTrade(), effectiveAmount));
        if (effectiveAmount < amount) {
          this.log(
            "SIGNAL",
            `Sized entry to $${effectiveAmount.toFixed(2)} (available $${budget.availableUsdc.toFixed(2)}; reserved $${budget.reservedUsdc.toFixed(2)})`
          );
        }
      }
    }

    const entrySnap = this.tradeEntrySnapshot();
    const entryAsset = (entrySnap.asset ?? this.wallet.getActiveDiscoveredAsset() ?? "").toUpperCase();
    const targetAtEntry =
      entryAsset && Number.isFinite(this.priceToBeatByAsset.get(entryAsset) ?? NaN)
        ? Number(this.priceToBeatByAsset.get(entryAsset))
        : undefined;
    const spotAtEntry =
      entryAsset && Number.isFinite(this.oracleSpotUsdForAsset(entryAsset) ?? NaN)
        ? Number(this.oracleSpotUsdForAsset(entryAsset))
        : undefined;
    const pending: Trade = {
      id: randomUUID(),
      time: new Date().toLocaleTimeString(),
      market: this.selectedMarket.label,
      price: Number(
        (this.wallet.hasLiveMarketData()
          ? book.mid
          : (this.marketData.at(-1)?.up ?? 50) / 100).toFixed(3)
      ),
      amount: effectiveAmount,
      pnl: 0,
      status: this.shouldExecutePaperTrade() ? "PENDING" : "OPEN",
      direction,
      asset: entrySnap.asset,
      upPriceAtEntry: entrySnap.upPriceAtEntry,
      downPriceAtEntry: entrySnap.downPriceAtEntry,
      targetPriceUsdAtEntry: targetAtEntry,
      spotPriceUsdAtEntry: spotAtEntry,
      decisionReason,
      ...(this.lagSnipeEnabled ? { lagSnipeHold: true as const } : {})
    };

    const executionMode: "PAPER" | "LIVE" = this.shouldExecutePaperTrade() ? "PAPER" : "LIVE";
    const pendingRow: Trade = { ...pending, executionMode };

    const commitTradeEntry = () => {
      if (source === "AUTO") {
        const tradeType = anchorAutoAnchorPath ? "anchor" : strat;
        this.registerAndLogBtc5mAutoEntry(
          pendingRow.id,
          direction,
          tradeType,
          this.prediction.confidence,
          Number(pendingRow.price)
        );
      }
      this.lastTradeAtBySlug.set(cdKey, Date.now());
      this.trades = [pendingRow, ...this.trades].slice(0, 250);
      this.onTrades?.(this.trades);
      const metaPlaced = this.wallet.getDiscoveredMeta();
      const wsSuffix =
        source === "AUTO" && isBtcFiveMinuteWindow(this.wallet.getActiveDiscoveredAsset(), metaPlaced)
          ? ` windowSec=${metaPlaced?.windowStartSec ?? "?"}`
          : "";
      this.log("TRADE", `[${source}] Placed ${direction} $${effectiveAmount.toFixed(2)}${wsSuffix}`);
      this.setPhase("EXECUTING", `Submitting order (${source})`);
    };

    if (this.externalExecution) {
      commitTradeEntry();
      this.pushBetLog(this.buildBetLog("placed", direction, book, {}));
      this.setPhase("WAITING_RESOLUTION", "External execution: waiting for MetaMask fill confirmation");
      return { accepted: true, trade: pendingRow };
    }

    const liveExec = this.canExecuteLiveOrders();
    const execAsset = this.wallet.getActiveDiscoveredAsset() ?? entryAsset ?? "?";
    const exEn = process.env.EXECUTE_TRADES ?? "";
    const ptEn = process.env.PAPER_TRADING ?? "";
    const poEn = process.env.PAPER_ONLY ?? "";
    const modeEn = process.env.MODE ?? "";

    if (pendingRow.executionMode === "LIVE" && !liveExec) {
      const rsn = this.liveOrdersDisabledReason() ?? "?";
      this.log(
        "TRADE",
        `[EXECUTION][LIVE_DISABLED] reason=${rsn} MODE=${modeEn} PAPER_TRADING=${ptEn} EXECUTE_TRADES=${exEn} PAPER_ONLY=${poEn}`
      );
      this.setPhase("SIGNAL_READY", "LIVE execution disabled by env");
      return { accepted: false, reason: "LIVE_DISABLED" };
    }

    if (pendingRow.executionMode === "LIVE" && liveExec) {
      this.log(
        "TRADE",
        `[EXECUTION][LIVE_ENABLED] asset=${execAsset} side=${direction} mode=${modeEn}`
      );
    }

    // --- Live execution: real CLOB post (wallet LIVE + !PAPER_TRADING + EXECUTE_TRADES + !PAPER_ONLY). ---
    if (liveExec && pendingRow.executionMode === "LIVE") {
      commitTradeEntry();
      try {
        const order: ClobPlaceOrderResult = await this.wallet.placeOrder({
          direction,
          amount: effectiveAmount,
          price: book.mid
        });
        if (!order.ok) {
          const detail = order.errorMsg ?? "CLOB placeOrder failed";
          this.log("TRADE", `[EXECUTION][LIVE_DISABLED] reason=clob_error msg=${detail.replace(/\s+/g, " ").slice(0, 240)}`);
          this.pushBetLog(
            this.buildBetLog("blocked", direction, book, {
              blockReason: `Live CLOB: ${detail}`
            })
          );
          this.setPhase("ERROR", `Live CLOB: ${detail}`);
          return { accepted: false, reason: detail };
        }
        const oidRaw = String(order.orderID ?? order.orderId ?? "");
        if (oidRaw === "" || oidRaw === "unknown") {
          this.log("TRADE", `[EXECUTION][LIVE_DISABLED] reason=no_order_id orderID=${oidRaw}`);
          this.pushBetLog(
            this.buildBetLog("blocked", direction, book, {
              blockReason: "Live order rejected (no order id from CLOB)"
            })
          );
          this.log("ERROR", "Live order rejected: missing order id");
          return { accepted: false, reason: "Live order validation failed" };
        }
        if (order.sizeFilled <= 0) {
          this.log("TRADE", `[CLOB][NO_FILL] order accepted but no fill orderId=${oidRaw}`);
        }
        this.pushBetLog(this.buildBetLog("placed", direction, book, {}));
        const oid = oidRaw;
        const idx = this.trades.findIndex((t) => t.id === pendingRow.id);
        if (idx >= 0) {
          this.trades[idx] = { ...this.trades[idx], clobOrderId: oid };
          if (order.sizeFilled > 0 && Number.isFinite(order.price)) {
            this.mergeLiveClobEntryFill(idx, {
              size_matched: order.sizeFilled,
              price: order.price,
              asset_id: order.tokenID,
              fee: 0
            });
          } else {
            this.onTrades?.([...this.trades]);
          }
        }
        void this.reconcileServerOrder(pendingRow.id, oid);
        const entryShares = Number(order.sizeFilled);
        const skipGtcBecauseClose = liveCloseEntryOnFill() && !pendingRow.lagSnipeHold;
        if (
          Number.isFinite(entryShares) &&
          entryShares > 0 &&
          gtcExitEnabled() &&
          !skipGtcBecauseClose &&
          !pendingRow.lagSnipeHold
        ) {
          await this.postGtcExit(book.tokenID, entryShares, "BUY", direction, pendingRow.id);
        }
        this.setPhase("WAITING_RESOLUTION", "Live order posted; waiting for CLOB fill");
        return { accepted: true, trade: pendingRow };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Live order request failed";
        this.log("TRADE", `[EXECUTION][LIVE_DISABLED] reason=exception msg=${reason.replace(/\s+/g, " ").slice(0, 200)}`);
        this.setPhase("ERROR", `Live execution failed: ${reason}`);
        this.pushBetLog(
          this.buildBetLog("blocked", direction, book, {
            blockReason: `Live order error: ${reason}`
          })
        );
        this.log("ERROR", `Live order error: ${reason}`);
        return { accepted: false, reason };
      }
    }

    // --- Paper execution: SIMULATION, or LIVE with paperTrading when real posts are off / PAPER_ONLY. ---
    if (this.shouldExecutePaperTrade()) {
      commitTradeEntry();
      this.pushBetLog(this.buildBetLog("placed", direction, book, {}));
      this.executePaperTrade(pendingRow, book, effectiveAmount, direction, source, decisionReason);
      return { accepted: true, trade: pendingRow };
    }

    this.setPhase("SIGNAL_READY", "LIVE execution disabled by env");
    return { accepted: false, reason: "LIVE_DISABLED" };
  }

  /**
   * Paper/sim fill path after gates: logs explicit [PAPER][EXECUTED], then depth-based simulate or legacy settle timer.
   */
  private executePaperTrade(
    pending: Trade,
    book: MarketContext,
    effectiveAmount: number,
    direction: Direction,
    source: string,
    decisionReason?: string
  ) {
    const asset = this.wallet.getActiveDiscoveredAsset() ?? "?";
    const slug = this.wallet.getActiveDiscoveredSlug() ?? "";
    const signalPct = Number.isFinite(book.mid) ? (book.mid * 100).toFixed(2) : "?";
    const reasonSnippet = (decisionReason ?? "").replace(/\s+/g, " ").slice(0, 160);
    const tokShort = String(book.tokenID ?? "").slice(0, 12);
    this.log(
      "TRADE",
      `[PAPER][EXECUTED] asset=${asset} side=${direction} price=${Number.isFinite(book.mid) ? book.mid.toFixed(4) : "?"} ` +
        `bestAsk=${Number.isFinite(book.bestAsk) ? book.bestAsk.toFixed(4) : "?"} bestBid=${Number.isFinite(book.bestBid) ? book.bestBid.toFixed(4) : "?"} ` +
        `size_usd=${effectiveAmount.toFixed(2)} signal=${signalPct}% market=${this.selectedMarket.label} slug=${slug} ` +
        `token=${tokShort}${tokShort ? "…" : ""} source=${source}` +
        (reasonSnippet ? ` reason=${reasonSnippet}` : "")
    );
    const tid = String(book.tokenID ?? "");
    if (this.wallet.hasLiveMarketData() && tid && !tid.toLowerCase().startsWith("sim-")) {
      this.setPhase("EXECUTING", "Paper: limit fill vs live CLOB depth");
      void this.resolvePaperTradeAsync(pending.id, book, effectiveAmount);
    } else {
      this.setPhase("WAITING_RESOLUTION", "Trade accepted; waiting 5s for resolution");
      setTimeout(() => this.resolveTrade(pending.id), 5000);
    }
  }

  /** Mark open paper rows from the active slot’s UP/DOWN books (WS/API freshness). */
  private syncPaperOpenMarksFromDirectionalBooks(): boolean {
    const ctx = this.directionalContext;
    if (!ctx || !this.wallet.hasLiveMarketData()) return false;
    const markToBid = String(process.env.PAPER_MARK_TO_BID ?? "true").toLowerCase() !== "false";
    const fee = paperTakerFeeRate();
    let changed = false;
    for (let i = 0; i < this.trades.length; i++) {
      const t = this.trades[i];
      if (t.executionMode === "LIVE") continue;
      if (t.status !== "PENDING" || !t.paper?.tokenId || t.paper.missed) continue;
      const tok = t.paper.tokenId;
      const book = ctx.up.tokenID === tok ? ctx.up : ctx.down.tokenID === tok ? ctx.down : null;
      if (!book) continue;
      const mark = markToBid
        ? book.bestBid
        : book.bestBid != null && book.bestAsk != null
          ? (book.bestBid + book.bestAsk) / 2
          : book.bestBid ?? book.bestAsk;
      if (mark == null || !Number.isFinite(mark)) continue;
      const shares = Number(t.paper.entryShares ?? 0);
      const vwap = Number(t.paper.entryVwap ?? 0);
      const entryFees = Number(t.paper.entryFeesUsd ?? 0);
      const cost = Number(t.paper.entryCostUsd ?? shares * vwap);
      const totalEntry = cost + entryFees;
      const exitFeesEst = shares * mark * fee;
      const unrealizedPnl =
        shares > 0 && Number.isFinite(mark) ? Number((shares * mark - exitFeesEst - totalEntry).toFixed(4)) : 0;
      const prevM = t.paper.markPrice;
      const prevU = t.paper.unrealizedPnlUsd;
      if (
        prevM != null &&
        Math.abs(prevM - mark) < 1e-6 &&
        prevU != null &&
        Math.abs(prevU - unrealizedPnl) < 1e-3
      ) {
        continue;
      }
      changed = true;
      this.trades[i] = {
        ...t,
        paper: { ...t.paper!, markPrice: mark, unrealizedPnlUsd: unrealizedPnl }
      };
    }
    return changed;
  }

  /** Paper: live book + virtual fill (latency, walk, timeout, fees, rejection coin-flip). */
  private async resolvePaperTradeAsync(tradeId: string, book: MarketContext, collateralUsd: number) {
    const tokenId = book.tokenID;
    const slipFrac = (() => {
      const rawBps = process.env.PAPER_SLIPPAGE_BPS;
      if (rawBps !== undefined && String(rawBps).trim() !== "") {
        return paperEntrySlippageFraction();
      }
      const slipRaw = Number(process.env.SIMULATION_SLIPPAGE_PCT ?? 0.015);
      return Number.isFinite(slipRaw) ? Math.min(0.5, Math.max(0, slipRaw)) : 0.015;
    })();
    const limitPrice = Math.min(0.999, book.mid * (1 + slipFrac));
    const targetShares = limitPrice > 0 ? collateralUsd / limitPrice : 0;
    const sizeShares = Number(Math.max(1e-12, targetShares).toFixed(6));

    let nbPre: ReturnType<typeof normalizeRawOrderBook> = null;
    try {
      const rawPre = await this.wallet.getRawOrderBook(tokenId);
      nbPre = normalizeRawOrderBook(rawPre);
    } catch {
      nbPre = null;
    }

    let fill: Awaited<ReturnType<typeof executePaperLimitBuyOrder>>;
    try {
      fill = await executePaperLimitBuyOrder({
        limitPrice,
        sizeShares,
        fetchBook: () => this.wallet.getRawOrderBook(tokenId),
        feeRate: paperTakerFeeRate()
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log("ERROR", `PAPER entry exception: ${msg}`);
      fill = { ok: false, reason: `exception:${msg}`, latencyMs: 0 };
    }

    const idx = this.trades.findIndex(
      (t) => t.id === tradeId && t.status === "PENDING" && t.executionMode !== "LIVE"
    );
    if (idx < 0) return;

    if (!fill.ok) {
      this.trades[idx] = {
        ...this.trades[idx],
        status: "LOSS",
        pnl: 0,
        paper: { missed: true, tokenId },
        decisionReason: `PAPER: ${fill.reason}`
      };
      this.log("SIGNAL", `PAPER missed entry ${tradeId.slice(0, 8)}… ${fill.reason}`);
      this.setPhase("SIGNAL_READY");
      this.onTrades?.([...this.trades]);
      this.pushStatus();
      return;
    }

    this.trades[idx] = {
      ...this.trades[idx],
      price: fill.vwap,
      paper: {
        missed: false,
        tokenId,
        entryFilledAtMs: Date.now(),
        entryVwap: fill.vwap,
        entryShares: fill.filledShares,
        entryCostUsd: fill.notionalUsd,
        entryFeesUsd: fill.feesUsd,
        entrySlippageBps: fill.slippageBps,
        entryLatencyMs: fill.latencyMs,
        entryBestBid: nbPre?.bestBid ?? undefined,
        entryBestAsk: nbPre?.bestAsk ?? undefined
      },
      clobOrderId: `paper-${tradeId.slice(0, 8)}`
    };
    this.log(
      "TRADE",
      `PAPER entry filled asset=${this.wallet.getActiveDiscoveredAsset() ?? "?"} side=${this.trades[idx]!.direction} ` +
        `entry=${fill.vwap.toFixed(4)} bid=${nbPre?.bestBid != null ? nbPre.bestBid.toFixed(4) : "—"} ask=${nbPre?.bestAsk != null ? nbPre.bestAsk.toFixed(4) : "—"} ` +
        `shares=${fill.filledShares.toFixed(4)} fees=${fill.feesUsd.toFixed(4)} slip=${fill.slippageBps}bps`
    );
    console.log("TRADE_FULL", {
      phase: "entry",
      direction: this.trades[idx]!.direction,
      entryPrice: fill.vwap,
      pnl: 0,
      slipFrac
    });
    this.setPhase(
      "WAITING_RESOLUTION",
      paperBinarySettleEnabled()
        ? "Paper position; oracle settle at window end"
        : "Paper position; settlement vs live book"
    );
    this.onTrades?.([...this.trades]);
    this.pushStatus();

    const row = this.trades[idx];
    if (row?.lagSnipeHold) {
      this.schedulePaperSettlementTimer(tradeId);
    } else if (paperBinarySettleEnabled()) {
      this.schedulePaperSettlementTimer(tradeId);
    } else {
      this.schedulePaperExitWithWhaleTp(tradeId, tokenId, fill.vwap);
    }
  }

  /**
   * Paper: dry-run live — real book entry, then oracle $1/$0 redemption.
   * Default 5m per position (`PAPER_SETTLE_DELAY_MS`); set `PAPER_SETTLE_AT_WINDOW_END=true` to settle at window end instead.
   */
  private schedulePaperSettlementTimer(tradeId: string) {
    const defaultMs = 5 * 60 * 1000;
    const raw = Number(process.env.PAPER_SETTLE_DELAY_MS ?? defaultMs);
    const timerMs = Number.isFinite(raw) && raw >= 1000 ? raw : defaultMs;
    let delayMs = timerMs;
    if (String(process.env.PAPER_SETTLE_AT_WINDOW_END ?? "").toLowerCase() === "true") {
      const meta = this.wallet.getDiscoveredMeta();
      const endParsed = meta?.endDateIso ? new Date(meta.endDateIso).getTime() : NaN;
      if (!Number.isNaN(endParsed)) {
        delayMs = Math.max(1500, endParsed - Date.now() + 1200);
      }
    }
    setTimeout(() => this.resolveTrade(tradeId), delayMs);
    this.log(
      "TRADE",
      `PAPER: binary settlement (PTB vs oracle) in ~${Math.round(delayMs / 1000)}s (exit fees applied at close)`
    );
  }

  /**
   * Oracle-binary paper settle must not run in the same moment as entry fill (stale PTB/oracle race).
   * Re-queues `resolveTrade` until `PAPER_ORACLE_MIN_HOLD_MS` have passed since `entryFilledAtMs`.
   */
  private deferPaperOracleSettlementIfNeeded(t: Trade, tradeId: string): boolean {
    const minHoldMs = paperOracleMinHoldMs();
    if (minHoldMs <= 0) return false;
    const entryTs = t.paper?.entryFilledAtMs;
    if (entryTs == null || entryTs <= 0) return false;
    const elapsed = Date.now() - entryTs;
    if (elapsed >= minHoldMs) return false;
    const wait = Math.max(250, minHoldMs - elapsed);
    this.log(
      "SIGNAL",
      `PAPER_ORACLE_SETTLE_DEFER trade=${tradeId.slice(0, 8)}… wait_ms=${Math.round(wait)} min_hold_ms=${minHoldMs} elapsed_ms=${Math.round(elapsed)}`
    );
    setTimeout(() => this.resolveTrade(tradeId), wait);
    return true;
  }

  /**
   * Session-close outcome source of truth:
   * - UP wins only when close spot > target.
   * - DOWN wins only when close spot < target.
   * Uses oracle spot (BTC from on-chain Chainlink) + per-window price-to-beat.
   * If feed is stale/missing, caller should retry shortly.
   */
  private evaluateSessionCloseOutcome(
    direction: Direction,
    asset: string,
    targetFallbackUsd?: number,
    opts?: { preferEntryTarget?: boolean }
  ): { ready: true; isWin: boolean } | { ready: false; reason: string } {
    const a = asset.trim().toUpperCase();
    const fromMap = this.priceToBeatByAsset.get(a);
    const entryOk =
      targetFallbackUsd != null && Number.isFinite(targetFallbackUsd) && targetFallbackUsd > 0;
    const ptb =
      opts?.preferEntryTarget && entryOk ? targetFallbackUsd : (fromMap ?? targetFallbackUsd ?? null);
    if (ptb == null || !Number.isFinite(ptb) || ptb <= 0) {
      return { ready: false, reason: `target missing for ${a}` };
    }
    const spot = this.oracleSpotUsdForAsset(a);
    if (spot == null || !Number.isFinite(spot) || spot <= 0) {
      return { ready: false, reason: `spot missing for ${a}` };
    }
    const ageMs = this.oracleAgeMsForAsset(a);
    const staleMs = this.oracleStaleMsForAsset(a);
    if (ageMs != null && ageMs > staleMs) {
      return { ready: false, reason: `spot stale for ${a}: ${ageMs}ms > ${staleMs}ms` };
    }
    if (direction === "UP") {
      return { ready: true, isWin: spot > ptb };
    }
    return { ready: true, isWin: spot < ptb };
  }

  private scheduleSettleRetry(tradeId: string, reason: string, waitMs = 1200, prefix = "Settle waiting feed") {
    if (this.settleRetryTimerByTradeId.has(tradeId)) return;
    this.log("SIGNAL", `${prefix}: ${reason}; retry in ${waitMs}ms`);
    const timer = setTimeout(() => {
      this.settleRetryTimerByTradeId.delete(tradeId);
      this.resolveTrade(tradeId);
    }, waitMs);
    this.settleRetryTimerByTradeId.set(tradeId, timer);
  }

  private clearPaperExitRetry(tradeId: string) {
    const existing = this.paperExitRetryTimerByTradeId.get(tradeId);
    if (existing) {
      clearTimeout(existing);
      this.paperExitRetryTimerByTradeId.delete(tradeId);
    }
  }

  private schedulePaperExitRetry(tradeId: string, reason: string, waitMs = 1200) {
    if (this.paperExitRetryTimerByTradeId.has(tradeId)) return;
    this.log("SIGNAL", `PAPER exit retry: ${reason}; in ${waitMs}ms`);
    const timer = setTimeout(() => {
      this.paperExitRetryTimerByTradeId.delete(tradeId);
      const idx = this.trades.findIndex(
        (x) => x.id === tradeId && x.status === "PENDING" && x.executionMode !== "LIVE"
      );
      if (idx >= 0) void this.finalizePaperTradeExit(idx);
    }, waitMs);
    this.paperExitRetryTimerByTradeId.set(tradeId, timer);
  }

  /**
   * Paper window-end settlement: same UP/DOWN vs price-to-beat rule as the binary, $1/$0 payout per share,
   * minus entry cost and entry + exit taker fees (`PAPER_FEE_BPS` / `PAPER_TAKER_FEE_RATE`).
   */
  private async finalizePaperOracleBinarySettlement(idx: number) {
    const t = this.trades[idx];
    if (!t || !tradeRowIsOpen(t.status) || t.executionMode === "LIVE") return;
    this.clearPaperExitRetry(t.id);
    const asset = (t.asset ?? "BTC").toUpperCase();
    const settle = this.evaluateSessionCloseOutcome(t.direction, asset, t.targetPriceUsdAtEntry, {
      preferEntryTarget: true
    });
    if (!settle.ready) {
      this.scheduleSettleRetry(t.id, settle.reason, 1200, "Paper settlement waiting feed");
      return;
    }
    const isWin = settle.isWin;
    const shares = Number(t.paper?.entryShares ?? 0);
    const vwap = Number(t.paper?.entryVwap ?? 0.5);
    const fees = Number(t.paper?.entryFeesUsd ?? 0);
    const cost = Number(t.paper?.entryCostUsd ?? shares * vwap);
    const entryTotal = cost + fees;
    const marketId = this.wallet.getActiveDiscoveredSlug() ?? "";
    const payoutPerShare = isWin ? 1 : 0;
    const grossExit = shares * payoutPerShare;
    const exitFeesUsd = grossExit * paperTakerFeeRate();
    const pnl = Number((grossExit - exitFeesUsd - entryTotal).toFixed(2));
    const sr = settleReal({
      marketId,
      direction: t.direction,
      entryPricePerShare: vwap,
      shares,
      entryCostUsd: cost,
      entryFeesUsd: fees,
      tokenWins: isWin
    });
    logRealSettlement({
      entry: vwap,
      outcome: sr.outcome,
      finalPrice: payoutPerShare,
      pnl: grossExit - exitFeesUsd - entryTotal,
      marketId
    });
    const closeMethod: NonNullable<Trade["paper"]>["closeMethod"] =
      t.direction === "UP" ? (isWin ? "SETTLEMENT_YES" : "SETTLEMENT_NO") : isWin ? "SETTLEMENT_NO" : "SETTLEMENT_YES";
    console.log("EXIT_DEBUG", {
      mode: "paper_binary_payout",
      entryPrice: vwap,
      payoutPerShare,
      exitFeesUsd,
      pnl,
      shares,
      entryFeesUsd: fees,
      isWin,
      closeMethod
    });
    const settled: Trade = {
      ...t,
      status: isWin ? "WIN" : "LOSS",
      pnl,
      paper: {
        ...t.paper!,
        exitPartial: false,
        closeMethod,
        exitVwap: payoutPerShare,
        exitProceedsUsd: grossExit,
        exitFeesUsd,
        exitSlippageBps: 0,
        markPrice: undefined,
        unrealizedPnlUsd: undefined
      }
    };
    console.log("TRADE_FULL", {
      direction: settled.direction,
      asset,
      entryPrice: vwap,
      exitPrice: payoutPerShare,
      pnl: settled.pnl,
      settle: isWin ? "WIN" : "LOSS"
    });
    this.balance += settled.pnl;
    this.trades[idx] = settled;
    this.finalizeBtc5mAutoAnalytics(t.id, settled, payoutPerShare, pnl);
    const drawdown = START_BALANCE - this.balance;
    if (drawdown >= this.effStopLossUsd()) {
      this.stopLossTriggered = true;
      this.running = false;
      this.autoTrading = false;
      this.log("ERROR", "Stop loss reached, engine stopped");
    }
    this.onTrades?.([...this.trades]);
    this.pushStatus();
    this.log(
      isWin ? "WIN" : "ERROR",
      `PAPER settled ${settled.direction} P&L $${settled.pnl.toFixed(2)} (binary payout ${payoutPerShare.toFixed(2)}/sh; fees in+out)`
    );
    this.log(
      "TRADE",
      `[PAPER][CLOSED] asset=${asset} side=${t.direction} entry=${vwap.toFixed(4)} exit=${payoutPerShare.toFixed(4)} payout=${grossExit.toFixed(4)} shares=${shares.toFixed(4)} ` +
        `feesEntry=${fees.toFixed(4)} feesExit=${exitFeesUsd.toFixed(4)} pnl=${pnl.toFixed(2)} closeMethod=${closeMethod}`
    );
    if (this.stopLossTriggered) {
      this.setPhase("ERROR", "Stop loss reached; engine stopped");
    } else {
      this.setPhase("SIGNAL_READY");
    }
  }

  private async finalizePaperTradeExit(idx: number) {
    const t = this.trades[idx];
    if (!t || t.executionMode === "LIVE") return;
    if (this.paperExitRetryTimerByTradeId.has(t.id)) return;
    if (this.paperExitInFlightIds.has(t.id)) return;
    this.paperExitInFlightIds.add(t.id);
    try {
      const tokenId = t.paper?.tokenId;
      const shares = t.paper?.entryShares;
      if (!tokenId || shares == null || shares <= 0) {
        this.applyLegacySimSettlement(idx);
        return;
      }

      let fill: Awaited<ReturnType<typeof simulatePaperMarketSell>>;
      try {
        fill = await simulatePaperMarketSell({
          sizeShares: shares,
          fetchBook: () => this.wallet.getRawOrderBook(tokenId),
          feeRate: paperTakerFeeRate()
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.log("ERROR", `PAPER exit exception: ${msg}`);
        fill = { ok: false, reason: `exception:${msg}`, latencyMs: 0 };
      }

      if (!fill.ok) {
        console.log("EXIT_DEBUG", {
          mode: "market_sell",
          entryPrice: shares > 0 ? ((t.paper?.entryCostUsd ?? 0) + (t.paper?.entryFeesUsd ?? 0)) / shares : 0,
          exitPrice: null,
          shares,
          sold: 0,
          reason: fill.reason
        });
        this.schedulePaperExitRetry(t.id, fill.reason);
        return;
      }

      const entryTotal = (t.paper?.entryCostUsd ?? 0) + (t.paper?.entryFeesUsd ?? 0);
      const sold = fill.filledShares;
      const frac = shares > 0 ? Math.min(1, sold / shares) : 1;
      const costAlloc = entryTotal * frac;
      const exitNet = fill.notionalUsd - fill.feesUsd;
      const pnl = exitNet - costAlloc;
      const entryPrice = shares > 0 ? costAlloc / sold : 0;
      const exitPrice = fill.vwap;
      const pnlPerShare = sold > 0 ? pnl / sold : 0;
      console.log("EXIT_DEBUG", {
        mode: "market_sell",
        entryPrice,
        exitPrice,
        pnlPerShare: Number(pnlPerShare.toFixed(6)),
        shares,
        sold,
        exitNet,
        costAlloc
      });
      this.clearPaperExitRetry(t.id);

      const status = pnl >= 0 ? "WIN" : "LOSS";
      const feesEntry = Number(t.paper?.entryFeesUsd ?? 0);
      const settled: Trade = {
        ...t,
        status,
        pnl: Number(pnl.toFixed(2)),
        paper: {
          ...t.paper!,
          closeMethod: "EARLY_EXIT",
          exitVwap: fill.vwap,
          exitProceedsUsd: fill.notionalUsd,
          exitFeesUsd: fill.feesUsd,
          exitSlippageBps: fill.slippageBps,
          exitLatencyMs: fill.latencyMs,
          exitPartial: fill.partial,
          markPrice: undefined,
          unrealizedPnlUsd: undefined
        }
      };
      const entryPxFull = shares > 0 ? entryTotal / shares : Number(t.paper?.entryVwap ?? 0);
      console.log("TRADE_FULL", {
        direction: settled.direction,
        asset: (t.asset ?? "").toUpperCase(),
        entryPrice: entryPxFull,
        exitPrice: fill.vwap,
        pnl: settled.pnl,
        settle: status,
        mode: "market_sell"
      });
      this.balance += settled.pnl;
      this.trades[idx] = settled;
      this.finalizeBtc5mAutoAnalytics(t.id, settled, fill.vwap, settled.pnl);

      const drawdown = START_BALANCE - this.balance;
      if (drawdown >= this.effStopLossUsd()) {
        this.stopLossTriggered = true;
        this.running = false;
        this.autoTrading = false;
        this.log("ERROR", "Stop loss reached, engine stopped");
      }

      this.onTrades?.([...this.trades]);
      this.pushStatus();
      this.log(
        status === "WIN" ? "WIN" : "ERROR",
        `PAPER settle ${settled.direction} P&L $${settled.pnl.toFixed(2)} (book VWAP)`
      );
      const pa = (t.asset ?? "?").toUpperCase();
      const enPx = Number(t.paper?.entryVwap ?? entryPxFull);
      const payoutApprox = fill.notionalUsd;
      this.log(
        "TRADE",
        `[PAPER][CLOSED] asset=${pa} side=${t.direction} entry=${enPx.toFixed(4)} exit=${fill.vwap.toFixed(4)} payout=${payoutApprox.toFixed(4)} shares=${sold.toFixed(4)} ` +
          `feesEntry=${feesEntry.toFixed(4)} feesExit=${fill.feesUsd.toFixed(4)} pnl=${settled.pnl.toFixed(2)} closeMethod=EARLY_EXIT`
      );

      if (this.stopLossTriggered) {
        this.setPhase("ERROR", "Stop loss reached; engine stopped");
      } else {
        this.setPhase("SIGNAL_READY");
      }
    } finally {
      this.paperExitInFlightIds.delete(t.id);
    }
  }

  /** Synthetic book settlement (no live token). GTC already cancelled in resolveTrade. */
  private applyLegacySimSettlement(idx: number) {
    const t = this.trades[idx];
    if (!t || !tradeRowIsOpen(t.status) || t.executionMode === "LIVE") return;
    this.clearPaperExitRetry(t.id);
    const asset = (t.asset ?? this.wallet.getActiveDiscoveredAsset() ?? "BTC").toUpperCase();
    const settle = this.evaluateSessionCloseOutcome(t.direction, asset, t.targetPriceUsdAtEntry, {
      preferEntryTarget: true
    });
    if (!settle.ready) {
      this.scheduleSettleRetry(t.id, settle.reason, 1200, "Settle waiting feed");
      return;
    }
    const isWin = settle.isWin;
    const entryPx = Math.min(1, Math.max(0, Number(t.price ?? 0.5)));
    const shares = entryPx > 1e-12 ? t.amount / entryPx : 0;
    const cost = shares * entryPx;
    const marketId = this.wallet.getActiveDiscoveredSlug() ?? "";
    const payoutPerShare = isWin ? 1 : 0;
    const grossExit = shares * payoutPerShare;
    const exitFeesUsd = grossExit * paperTakerFeeRate();
    const entryFeesUsd = 0;
    const entryTotal = cost + entryFeesUsd;
    const pnl = Number((grossExit - exitFeesUsd - entryTotal).toFixed(2));
    const sr = settleReal({
      marketId,
      direction: t.direction,
      entryPricePerShare: entryPx,
      shares,
      entryCostUsd: cost,
      entryFeesUsd: 0,
      tokenWins: isWin
    });
    logRealSettlement({
      entry: entryPx,
      outcome: sr.outcome,
      finalPrice: payoutPerShare,
      pnl: grossExit - exitFeesUsd - entryTotal,
      marketId
    });
    const closeMethod: NonNullable<Trade["paper"]>["closeMethod"] =
      t.direction === "UP" ? (isWin ? "SETTLEMENT_YES" : "SETTLEMENT_NO") : isWin ? "SETTLEMENT_NO" : "SETTLEMENT_YES";
    const settled: Trade = {
      ...t,
      status: isWin ? "WIN" : "LOSS",
      pnl,
      paper: {
        ...t.paper,
        closeMethod,
        exitVwap: payoutPerShare,
        exitProceedsUsd: grossExit,
        exitFeesUsd,
        exitSlippageBps: 0,
        markPrice: undefined,
        unrealizedPnlUsd: undefined
      }
    };
    this.balance += settled.pnl;
    this.trades[idx] = settled;
    this.finalizeBtc5mAutoAnalytics(t.id, settled, payoutPerShare, pnl);
    const drawdown = START_BALANCE - this.balance;
    if (drawdown >= this.effStopLossUsd()) {
      this.stopLossTriggered = true;
      this.running = false;
      this.autoTrading = false;
      this.log("ERROR", "Stop loss reached, engine stopped");
    }
    this.onTrades?.([...this.trades]);
    this.pushStatus();
    this.log(isWin ? "WIN" : "ERROR", `${settled.status} ${settled.direction} P&L $${settled.pnl.toFixed(2)}`);
    this.log(
      "TRADE",
      `[PAPER][CLOSED] asset=${asset} side=${t.direction} entry=${entryPx.toFixed(4)} exit=${payoutPerShare.toFixed(4)} payout=${grossExit.toFixed(4)} shares=${shares.toFixed(4)} ` +
        `feesEntry=${entryFeesUsd.toFixed(4)} feesExit=${exitFeesUsd.toFixed(4)} pnl=${pnl.toFixed(2)} closeMethod=${closeMethod}`
    );
    if (this.stopLossTriggered) {
      this.setPhase("ERROR", "Stop loss reached; engine stopped");
    } else {
      this.setPhase("SIGNAL_READY");
    }
  }

  /** Mirror LIVE CLOB entry fill into `paper`-shaped fields (same queue/schema as paper rows). */
  private mergeLiveClobEntryFill(idx: number, order: Record<string, unknown>) {
    const t = this.trades[idx];
    if (!t || t.executionMode !== "LIVE") return;
    const matched = Number(order.size_matched ?? order.sizeMatched ?? 0);
    const px = Number(order.price ?? t.price ?? 0);
    const assetId = String(order.asset_id ?? order.assetId ?? "");
    if (!Number.isFinite(matched) || matched <= 0 || !Number.isFinite(px) || px <= 0) return;
    const cost = matched * px;
    const feeRaw = order.fee ?? order.fees_paid ?? order.total_fees;
    const entryFeesUsd = Number.isFinite(Number(feeRaw)) ? Number(Number(feeRaw).toFixed(6)) : 0;
    this.trades[idx] = {
      ...t,
      price: Number(px.toFixed(6)),
      paper: {
        ...t.paper,
        missed: false,
        tokenId: assetId || t.paper?.tokenId,
        entryFilledAtMs: Date.now(),
        entryVwap: px,
        entryShares: matched,
        entryCostUsd: Number(cost.toFixed(6)),
        entryFeesUsd
      }
    };
    this.onTrades?.([...this.trades]);
  }

  /** Poll CLOB until entry BUY is matched; optionally market-SELL shares before dashboard settle. */
  private async reconcileServerOrder(tradeId: string, orderId: string) {
    const maxAttempts = 45;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const o = await this.wallet.getOrder(orderId);
      if (!o) continue;
      const orig = Number(o.original_size);
      const matched = Number(o.size_matched);
      const filled = orig > 0 && matched >= orig * 0.999;
      if (filled) {
        this.log("TRADE", `CLOB order ${orderId.slice(0, 10)}… filled (${matched}/${orig})`);
        const idxFill = this.trades.findIndex((x) => x.id === tradeId);
        if (idxFill >= 0) {
          this.mergeLiveClobEntryFill(idxFill, o as unknown as Record<string, unknown>);
        }
        const holdRow = this.trades.find((t) => t.id === tradeId);
        const skipLiveFlatten = holdRow?.lagSnipeHold === true;
        let okToSettle = true;
        if (
          this.wallet.getMode() === "LIVE" &&
          !this.externalExecution &&
          liveCloseEntryOnFill() &&
          !skipLiveFlatten
        ) {
          const assetId = String((o as { asset_id?: string }).asset_id ?? "");
          if (assetId && matched > 0) {
            okToSettle = await this.flattenLiveEntryPosition(tradeId, assetId, matched);
          } else {
            okToSettle = false;
            this.log(
              "ERROR",
              "LIVE_CLOSE_ENTRY_ON_FILL: missing asset_id on order — cannot auto-sell; trade stays PENDING"
            );
          }
        }
        if (skipLiveFlatten) {
          this.log(
            "TRADE",
            "Lag Snipe: entry filled — HOLD Manual Exit (no auto-flatten; settling at window end)"
          );
          const meta = this.wallet.getDiscoveredMeta();
          const endParsed = meta?.endDateIso ? new Date(meta.endDateIso).getTime() : NaN;
          const delayMs = !Number.isNaN(endParsed) && endParsed > Date.now() ? Math.max(1500, endParsed - Date.now() + 1200) : 5000;
          this.log(
            "TRADE",
            `Lag Snipe: live settlement scheduled in ~${Math.round(delayMs / 1000)}s (window end)`
          );
          this.setPhase("WAITING_RESOLUTION", "Lag Snipe: HOLD Manual Exit");
          setTimeout(() => this.resolveTrade(tradeId), delayMs);
        } else if (okToSettle) {
          this.resolveTrade(tradeId);
        } else {
          this.log(
            "TRADE",
            `PENDING: trade ${tradeId.slice(0, 8)}… — not settled until shares are sold on Polymarket`
          );
        }
        return;
      }
    }
    this.log("ERROR", `CLOB order ${orderId.slice(0, 10)}… reconcile timeout (still open or unmatched)`);
  }

  /** Cancel optional GTC hedge, post FAK market SELL on entry token, poll until mostly filled. */
  private async flattenLiveEntryPosition(tradeId: string, entryTokenId: string, shares: number): Promise<boolean> {
    const tIdx = this.trades.findIndex((t) => t.id === tradeId);
    const row = tIdx >= 0 ? this.trades[tIdx] : null;
    if (row?.gtcExitOrderId && tIdx >= 0) {
      await this.wallet.cancelClobOrder(row.gtcExitOrderId);
      this.gtcMetrics.settleCancels += 1;
      this.log("TRADE", `LIVE_CLOSE: cancelled GTC hedge ${row.gtcExitOrderId.slice(0, 12)}…`);
      this.trades[tIdx] = {
        ...this.trades[tIdx],
        gtcExitOrderId: undefined,
        gtcExitTargetShares: undefined
      };
      this.onTrades?.([...this.trades]);
    }

    const sell = await this.wallet.postMarketSellShares(entryTokenId, shares);
    if (!sell) {
      this.log(
        "ERROR",
        "LIVE_CLOSE: market SELL failed — shares may still be open on Polymarket (CTF approval or inventory)"
      );
      return false;
    }
    this.log("TRADE", `LIVE_CLOSE: market SELL posted ${sell.orderID.slice(0, 12)}…`);
    const maxSellPoll = 40;
    for (let j = 0; j < maxSellPoll; j++) {
      await new Promise((r) => setTimeout(r, 1500));
      const so = await this.wallet.getOrder(sell.orderID);
      if (!so) continue;
      const om = Number(so.size_matched);
      const oo = Number(so.original_size);
      if (oo > 0 && om >= oo * 0.92) {
        this.log("TRADE", `LIVE_CLOSE: SELL matched ${om}/${oo} — position flattened on CLOB`);
        return true;
      }
    }
    this.log("ERROR", "LIVE_CLOSE: SELL fill not confirmed in time — verify Polymarket portfolio");
    return false;
  }

  attachClobOrderId(tradeId: string, orderId: string) {
    const idx = this.trades.findIndex((t) => t.id === tradeId);
    if (idx < 0) return false;
    this.trades[idx] = { ...this.trades[idx], clobOrderId: orderId };
    this.onTrades?.([...this.trades]);
    return true;
  }

  /** Call after MetaMask order is fully filled (browser polled CLOB). */
  confirmBrowserTradeFill(tradeId: string) {
    const idx = this.trades.findIndex((t) => t.id === tradeId && tradeRowIsOpen(t.status));
    if (idx < 0) return { ok: false as const, reason: "Pending trade not found" };
    this.setPhase("WAITING_RESOLUTION", "Browser-reported fill; settling");
    setTimeout(() => this.resolveTrade(tradeId), 50);
    return { ok: true as const };
  }

  async getAvailableCollateralBudget() {
    return this.wallet.getAvailableCollateralBudget();
  }

  private resolveTrade(tradeId: string) {
    const idx = this.trades.findIndex((t) => t.id === tradeId);
    if (idx < 0) {
      const staleTimer = this.settleRetryTimerByTradeId.get(tradeId);
      if (staleTimer) {
        clearTimeout(staleTimer);
        this.settleRetryTimerByTradeId.delete(tradeId);
      }
      return;
    }
    const t = this.trades[idx];
    if (!tradeRowIsOpen(t.status)) {
      const staleTimer = this.settleRetryTimerByTradeId.get(tradeId);
      if (staleTimer) {
        clearTimeout(staleTimer);
        this.settleRetryTimerByTradeId.delete(tradeId);
      }
      return;
    }
    const existingRetry = this.settleRetryTimerByTradeId.get(tradeId);
    if (existingRetry) {
      clearTimeout(existingRetry);
      this.settleRetryTimerByTradeId.delete(tradeId);
    }
    this.clearPaperExitRetry(tradeId);

    if (t.gtcExitOrderId) {
      void this.wallet.cancelClobOrder(t.gtcExitOrderId);
      this.gtcMetrics.settleCancels += 1;
      this.log("TRADE", `GTC_CANCEL: reason=settle order=${t.gtcExitOrderId}`);
    }

    if (
      this.wallet.getMode() === "SIMULATION" &&
      t.paper &&
      !t.paper.missed &&
      t.paper.entryVwap != null &&
      t.paper.entryShares != null
    ) {
      const useOracleBinary = Boolean(t.lagSnipeHold) || paperBinarySettleEnabled();
      if (useOracleBinary) {
        if (this.deferPaperOracleSettlementIfNeeded(t, tradeId)) return;
        void this.finalizePaperOracleBinarySettlement(idx);
      } else {
        void this.finalizePaperTradeExit(idx);
      }
      return;
    }

    if (this.wallet.getMode() === "SIMULATION") {
      this.applyLegacySimSettlement(idx);
      return;
    }

    const asset = (t.asset ?? this.wallet.getActiveDiscoveredAsset() ?? "BTC").toUpperCase();
    const settle = this.evaluateSessionCloseOutcome(t.direction, asset, t.targetPriceUsdAtEntry);
    if (!settle.ready) {
      this.scheduleSettleRetry(t.id, settle.reason, 1200, "Live settle waiting feed");
      return;
    }
    const isWin = settle.isWin;
    const entryPx = Math.min(1, Math.max(0, Number(t.paper?.entryVwap ?? t.price ?? 0.5)));
    const shares =
      t.paper?.entryShares ?? (entryPx > 1e-12 ? t.amount / entryPx : 0);
    const cost = t.paper?.entryCostUsd ?? shares * entryPx;
    const fees = t.paper?.entryFeesUsd ?? 0;
    const marketId = this.wallet.getActiveDiscoveredSlug() ?? "";
    const sr = settleReal({
      marketId,
      direction: t.direction,
      entryPricePerShare: entryPx,
      shares,
      entryCostUsd: cost,
      entryFeesUsd: fees,
      tokenWins: isWin
    });
    logRealSettlement({
      entry: entryPx,
      outcome: sr.outcome,
      finalPrice: sr.finalPrice,
      pnl: sr.pnl,
      marketId
    });
    const pnl = Number(sr.pnl.toFixed(2));
    const payoutPerShare = isWin ? 1 : 0;
    const grossExit = shares * payoutPerShare;
    const liveCloseMethod: NonNullable<Trade["paper"]>["closeMethod"] =
      t.direction === "UP" ? (isWin ? "SETTLEMENT_YES" : "SETTLEMENT_NO") : isWin ? "SETTLEMENT_NO" : "SETTLEMENT_YES";
    const settled: Trade = {
      ...t,
      status: "CLOSED",
      pnl,
      paper: {
        ...t.paper,
        closeMethod: liveCloseMethod,
        exitVwap: payoutPerShare,
        exitProceedsUsd: grossExit,
        markPrice: undefined,
        unrealizedPnlUsd: undefined
      }
    };
    this.balance += settled.pnl;
    this.trades[idx] = settled;
    this.finalizeBtc5mAutoAnalytics(t.id, settled, payoutPerShare, pnl);

    const drawdown = START_BALANCE - this.balance;
    if (drawdown >= this.effStopLossUsd()) {
      this.stopLossTriggered = true;
      this.running = false;
      this.autoTrading = false;
      this.log("ERROR", "Stop loss reached, engine stopped");
    }

    this.onTrades?.([...this.trades]);
    this.pushStatus();
    this.log(isWin ? "WIN" : "ERROR", `LIVE CLOSED ${settled.direction} P&L $${settled.pnl.toFixed(2)}`);

    if (this.stopLossTriggered) {
      this.setPhase("ERROR", "Stop loss reached; engine stopped");
    } else {
      this.setPhase("SIGNAL_READY");
    }
  }
}
