import { randomUUID } from "node:crypto";
import type {
  BetLogEntry,
  BotTradeHistoryRecord,
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
  Prediction,
  RiskSettingsSnapshot,
  Status,
  Trade,
  TradingState,
  AnchorStrategySnapshot
} from "../types/index.js";
import {
  executePaperLimitBuyOrder,
  normalizeRawOrderBook,
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
import { computeEnsemble, type MidSample } from "./ensembleStrategy.js";
import { evaluateWhaleEdgeGate, whalePaperTakeProfitMid } from "./whaleStrategy.js";
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
import { BinanceAggTradeFeed } from "./binanceAggTradeFeed.js";
import {
  OLA_KILL_SWITCH_LOSS_FRAC,
  OLA_KILL_WINDOW_MS,
  olaBookSnipeAllowed,
  olaDirectionFromOracle,
  olaOracleVersusTarget,
  olaSecondsToExpiryAbort,
  olaSlippageExceeded,
  olaSnipeAskCap,
  olaThresholdUsd,
  olaWindowSpendCap,
  OLA_SLIPPAGE_FRAC
} from "./olaStrategy.js";
import {
  loadBotFiltersConfig,
  tradeAssetAllowedByConfig,
  bookMidSpread01,
  slippageFracFromConfig,
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

/** Default true: paper fills settle vs oracle/PTB at $1/share (avoids thin-bid market-exit losses). Set false to use simulated book SELL. */
function paperBinarySettleEnabled() {
  return String(process.env.PAPER_BINARY_SETTLE ?? "true").toLowerCase() !== "false";
}

/** Min ms after paper entry fill before oracle-binary settlement (stops same-second settle vs stale PTB). Default 5m. */
function paperOracleMinHoldMs() {
  const n = envNum("PAPER_ORACLE_MIN_HOLD_MS", 300_000);
  return Number.isFinite(n) && n >= 0 ? n : 300_000;
}

/** Skip new paper entries when Gamma window ends sooner than this (oracle settle race). Default 60s. */
function paperEntryMinMsToWindowEnd() {
  const n = envNum("PAPER_ENTRY_MIN_MS_TO_WINDOW_END", 60_000);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

/** Auto-entry: max oracle tick age (ms) vs freshest of raw Chainlink `updatedAt` and RTDS (see `getOracleAgeMsForTrend`). Default 15s (~Polygon CL heartbeat). */
function oracleMaxAgeMsForEntry() {
  const n = envNum("ORACLE_MAX_AGE_MS_ENTRY", 15_000);
  return Number.isFinite(n) && n >= 250 ? n : 15_000;
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

/** When using ensemble, apply whale_edge liquidity/time/spread gates on the combined vote (default on). */
function ensembleApplyWhaleFilter(): boolean {
  const v = process.env.ENSEMBLE_APPLY_WHALE_FILTER;
  if (v == null || v === "") return true;
  return String(v).toLowerCase() !== "false" && String(v) !== "0";
}

function olaUseWhaleFilter(): boolean {
  return String(process.env.OLA_USE_WHALE_FILTER ?? "").toLowerCase() === "true";
}

/** Exact high-conf scalping defaults (60% depth + 0.60 conf×mid floor + mid≥HIGH_CONF_MID_THRESHOLD OR). */
const BONE_SCALP_MIN_CONF_PCT = 96;
const BONE_SCALP_MIN_CONF_TIMES_MID = 0.6;
const BONE_SCALP_WHALE_FRAC = 0.6;

/** Parsed from `ENTRY_STRATEGY` only (contrarian is .env-only). Empty env defaults to ensemble (all legs). */
function parseEnvEntryStrategy(): EntryStrategyKind {
  const raw = process.env.ENTRY_STRATEGY;
  const s = String(raw == null || String(raw).trim() === "" ? "ensemble" : raw).toLowerCase().trim();
  if (s === "spot_poly_lag" || s === "spot-poly-lag" || s === "spl") return "spot_poly_lag";
  if (s === "contrarian" || s === "fade") return "contrarian";
  if (s === "orderbook" || s === "book") return "orderbook";
  if (s === "mean_revert" || s === "revert" || s === "fade_odds") return "mean_revert";
  if (s === "chart" || s === "pseudo" || s === "synthetic") return "chart";
  if (s === "whale_edge" || s === "whale" || s === "edge") return "whale_edge";
  if (s === "ensemble" || s === "all" || s === "combined") return "ensemble";
  if (s === "ola" || s === "latency" || s === "oracle_latency") return "ola";
  if (s === "anchor" || s === "book_imbalance") return "anchor";
  return "momentum";
}

function parseDashboardEntryStrategyId(raw: unknown): DashboardEntryStrategyId | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "momentum") return "momentum";
  if (s === "spot_poly_lag" || s === "spot-poly-lag" || s === "spl") return "spot_poly_lag";
  if (s === "orderbook" || s === "book") return "orderbook";
  if (s === "mean_revert" || s === "revert" || s === "fade_odds") return "mean_revert";
  if (s === "chart") return "chart";
  if (s === "whale_edge" || s === "whale" || s === "edge") return "whale_edge";
  if (s === "ensemble" || s === "all" || s === "combined") return "ensemble";
  if (s === "ola" || s === "latency" || s === "oracle_latency") return "ola";
  if (s === "anchor" || s === "book_imbalance") return "anchor";
  return null;
}

/** How momentum is measured when ENTRY_STRATEGY=momentum (ignored for orderbook signal path). */
type MomentumModeKind = "ticks" | "weighted" | "from_open";

function momentumMode(): MomentumModeKind {
  const s = String(process.env.MOMENTUM_MODE ?? "ticks").toLowerCase();
  if (s === "weighted" || s === "w") return "weighted";
  if (s === "from_open" || s === "window" || s === "open") return "from_open";
  return "ticks";
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
  /** Rolling UP/DOWN mids per Gamma slug — mid-flip / LSC / reversal legs (ensemble). */
  private ensembleMidBySlug = new Map<string, MidSample[]>();
  /** Per-asset UP/DOWN book snapshot (all discovered slots), updated with the 4s refresh. */
  private multiSlotBooks: Record<
    string,
    {
      up: { mid: number; spread: number; badge: string };
      down: { mid: number; spread: number; badge: string };
    }
  > | null = null;
  private betLogs: BetLogEntry[] = [];
  /** Paper fills / exits (same schema intent as live logs for 1:1 comparison). */
  private botTradeHistory: BotTradeHistoryRecord[] = [];
  private lastBookRefreshMs: number | null = null;
  /** Tracks 5m window (Gamma slug time or local 5m bucket in SIM). */
  private lastTrackedWindowKey: string | null = null;
  private btcTargetUsd: number | null = null;
  /** Rate-limited runtime health logging (RTDS/oracle/cache + positions). */
  private lastRuntimeHealthLogMs: number | null = null;
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
  /** On-chain Chainlink BTC/USD (authoritative) oracle + staleness protection. */
  private chainlinkFeed = new ChainlinkFeedService();
  /** Cached latest Chainlink tick; used as “oracle spot” for multi-asset strike/oracle. */
  private chainlinkUsdByAsset = new Map<string, ChainlinkUsdPriceTick>();
  private gammaDisplayByAsset = new Map<
    string,
    { up: number; down: number; priceToBeat?: number; updatedMs: number }
  >();
  private priceToBeatByAsset = new Map<string, number>();
  private oracleWindowTrackedByAsset = new Map<string, number>();
  /** Binance spot @aggTrade — OLA signal vs Gamma price-to-beat. */
  private binanceAgg = new BinanceAggTradeFeed();
  /** OLA: USDC spent this 5m window per slug (key slug|windowStartSec). */
  private olaSpendByWindowKey = new Map<string, number>();
  /** OLA: settled trade PnL samples for rolling 1h kill switch. */
  private olaPnlHourly: Array<{ t: number; pnl: number }> = [];
  private olaKillTriggered = false;
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

  /** Anchor Strategy: bid-depth imbalance history (5s cadence, max 10). */
  private anchorImbalanceHistoryUp: number[] = [];
  private anchorImbalanceHistoryDown: number[] = [];
  private lastAnchorSignal: AnchorSignal | null = null;
  private lastAnchorWindowKey: string | null = null;
  private anchorTradedThisWindow = false;
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
   * (so fast OLA polls don’t starve ETH/SOL/XRP when BTC has stronger books).
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

  /** Freshest of Chainlink on-chain age and RTDS age for auto-entry / anchor oracle gates. */
  private oracleMergedAgeMsForEntryGate(asset: string): number | null {
    return getOracleAgeMsForTrend(
      this.oracleChainlinkRawAgeMsForAsset(asset),
      this.polymarketRtds.getAgeMsForAsset(asset)
    );
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
      case "spot_poly_lag":
        return "Spot-Poly Lag [SPL]";
      case "orderbook":
        return "Order book (mid tilt)";
      case "mean_revert":
        return "Mean reversion";
      case "chart":
        return "Chart tilt (synthetic)";
      case "whale_edge":
        return "Whale edge (time + spread + tilt + optional oracle)";
      case "ensemble":
        return "Ensemble (momentum+book+MR+chart+mid-flip+LSC+reversal)";
      case "ola":
        return "OLA — Binance vs price-to-beat + CLOB discount snipe";
      case "anchor":
        return "Anchor (book+Chainlink)";
      case "contrarian":
        return "Contrarian (.env)";
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
          reason:
            "strategy must be momentum, spot_poly_lag, orderbook, mean_revert, chart, whale_edge, ensemble, ola, or anchor"
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

  private buildMarketWsPayload(): MarketWsPayload {
    const byAsset: Record<string, MarketPoint[]> = {};
    for (const [k, v] of this.assetSpotSeries.entries()) {
      if (v.length > 0) byAsset[k] = v;
    }
    return { primary: this.marketData, byAsset };
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

  /** Fade synthetic chart UP% when it leans away from 50. */
  private basePredictMeanRevert(): { prediction: Direction; confidence: number; ts: number } {
    const lb = Math.max(3, Math.min(30, envNum("MEAN_REVERT_LOOKBACK", 8)));
    const recent = this.marketData.slice(-lb);
    const ts = Date.now();
    if (recent.length === 0) {
      return { prediction: "UP", confidence: 92, ts };
    }
    const avgUp = recent.reduce((s, p) => s + p.up, 0) / recent.length;
    const thr = envNum("MEAN_REVERT_THRESHOLD", 2);
    const direction: Direction = avgUp >= 50 ? "DOWN" : "UP";
    const edge = Math.abs(avgUp - 50);
    const strong = edge > thr;
    const confidence = strong
      ? Math.min(100, Number((92 + Math.min(6, (edge - thr) * 0.45) + Math.random() * 2).toFixed(2)))
      : Math.min(93, Number((87 + Math.random() * 2).toFixed(2)));
    return { prediction: direction, confidence, ts };
  }

  /** Follow latest chart bar synthetic UP/DOWN tilt. */
  private basePredictChart(): { prediction: Direction; confidence: number; ts: number } {
    const last = this.marketData[this.marketData.length - 1];
    const ts = Date.now();
    if (!last) return { prediction: "UP", confidence: 92, ts };
    const direction: Direction = last.up >= 50 ? "UP" : "DOWN";
    const tilt = Math.abs(last.up - 50);
    const confidence = Math.min(
      100,
      Number((91 + Math.min(8, tilt * 0.35) + Math.random() * 3).toFixed(2))
    );
    return { prediction: direction, confidence, ts };
  }

  private basePredict(): { prediction: Direction; confidence: number; ts: number } {
    if (this.lagSnipeEnabled) {
      const ev = this.evaluateLagSnipeDisplay();
      return { prediction: ev.prediction, confidence: ev.confidence, ts: Date.now() };
    }
    const strat = this.effectiveEntryStrategy();
    if (strat === "ola") {
      const c = this.getOlaSignalCore();
      return { prediction: c.prediction, confidence: c.confidence, ts: Date.now() };
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
    if (strat === "ensemble") {
      const r = this.buildEnsembleResult();
      const conf = Math.min(99, 80 + Math.min(18, Math.abs(r.score) * 2.2));
      return {
        prediction: r.direction,
        confidence: Number(conf.toFixed(2)),
        ts: Date.now()
      };
    }
    if ((strat === "orderbook" || strat === "whale_edge") && this.directionalContext) {
      const { up, down } = this.directionalContext;
      const direction: Direction = up.mid >= down.mid ? "UP" : "DOWN";
      const edge = Math.abs(up.mid - down.mid);
      const confidenceBase = 92 + Math.min(6, edge * 40);
      const confidence = Math.min(100, Number((confidenceBase + Math.random() * 2).toFixed(2)));
      return { prediction: direction, confidence, ts: Date.now() };
    }
    if (strat === "mean_revert") return this.basePredictMeanRevert();
    if (strat === "chart") return this.basePredictChart();

    const predictLb = envNum("MOMENTUM_PREDICT_LOOKBACK", 10);
    const trend = this.momentumScalar(predictLb);
    let direction: Direction = trend >= 0 ? "UP" : "DOWN";
    if (strat === "contrarian") direction = direction === "UP" ? "DOWN" : "UP";
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
    const raw = momentum >= 0 ? "UP" : "DOWN";
    if (this.effectiveEntryStrategy() === "contrarian") return raw === "UP" ? "DOWN" : "UP";
    return raw;
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
   * OLA: only TRADE_ASSETS + MIN_SIGNAL_CONF; book-spread + momentum gates are non-OLA.
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

    if (strat === "ola" || strat === "anchor") {
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
    if (es === "ola") {
      const ev = this.getOlaEntryEvaluation();
      const core = this.getOlaSignalCore();
      const base = {
        prediction: ev.skipReason ? core.prediction : ev.direction,
        confidence: core.confidence,
        ts: Date.now()
      };
      let recommendation: "TRADE" | "NO_TRADE" = ev.skipReason ? "NO_TRADE" : "TRADE";
      let reason = ev.skipReason ?? ev.reasonLine;

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
        : es === "mean_revert"
          ? `Mean-revert: ${base.prediction} (${base.confidence.toFixed(0)}%)`
          : es === "chart"
            ? `Chart tilt: ${base.prediction} (${base.confidence.toFixed(0)}%)`
            : es === "orderbook"
              ? `Order book: ${base.prediction} (${base.confidence.toFixed(0)}%)`
              : es === "whale_edge"
                ? `Whale edge tilt: ${base.prediction} (${base.confidence.toFixed(0)}%)`
                : es === "ensemble"
                  ? `Ensemble: ${base.prediction} (${base.confidence.toFixed(0)}%)`
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
      anchorStrategy: this.buildAnchorStrategySnapshotPayload()
    };
  }

  private chooseDirectionalEntry(): { direction: Direction; reason: string } {
    /** OLA must never use book-only or momentum fallbacks — oracle + snipe only. */
    if (this.effectiveEntryStrategy() === "ola") {
      const ev = this.getOlaEntryEvaluation();
      if (ev.skipReason) {
        return { direction: ev.direction, reason: ev.skipReason };
      }
      return { direction: ev.direction, reason: ev.reasonLine };
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

    if (this.effectiveEntryStrategy() === "ensemble") {
      if (this.directionalContext && this.wallet.hasLiveMarketData()) {
        const { up, down } = this.directionalContext;
        const upOk = this.liveBookTradability(up).ok;
        const downOk = this.liveBookTradability(down).ok;
        if (upOk && downOk) {
          const r = this.buildEnsembleResult();
          return {
            direction: r.direction,
            reason: `ensemble score=${r.score.toFixed(3)} | ${r.parts.join(" · ")}`
          };
        }
      }
      const r = this.buildEnsembleResult();
      return {
        direction: r.direction,
        reason: `ensemble(fallback) score=${r.score.toFixed(3)} | ${r.parts.join(" · ")}`
      };
    }

    const esChoose = this.effectiveEntryStrategy();
    if ((esChoose === "orderbook" || esChoose === "whale_edge") && this.directionalContext) {
      const { up, down } = this.directionalContext;
      const upOk = this.liveBookTradability(up).ok;
      const downOk = this.liveBookTradability(down).ok;
      if (upOk && downOk) {
        const direction: Direction = up.mid >= down.mid ? "UP" : "DOWN";
        const edge = Math.abs(up.mid - down.mid);
        return {
          direction,
          reason:
            esChoose === "whale_edge"
              ? `whale_edge: UP=${up.mid.toFixed(4)} DN=${down.mid.toFixed(4)} edge=${edge.toFixed(4)}`
              : `orderbook: mid UP=${up.mid.toFixed(4)} DOWN=${down.mid.toFixed(4)}`
        };
      }
    }

    const strat = this.effectiveEntryStrategy();
    if (strat === "mean_revert" || strat === "chart") {
      return {
        direction: this.prediction.prediction,
        reason: `${strat}: signal ${this.prediction.prediction} @ ${this.prediction.confidence.toFixed(1)}%`
      };
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

  private getEnsembleSamplesForActive(): MidSample[] {
    const slug = this.wallet.getActiveDiscoveredSlug() ?? "_default";
    return [...(this.ensembleMidBySlug.get(slug) ?? [])];
  }

  private pushEnsembleSampleForSlug(slug: string, upMid: number, downMid: number) {
    const row: MidSample = { t: Date.now(), upMid, downMid };
    let ring = this.ensembleMidBySlug.get(slug) ?? [];
    ring = [...ring, row];
    const maxR = Math.max(8, Math.min(80, envNum("ENSEMBLE_MID_RING_MAX", 40)));
    while (ring.length > maxR) ring.shift();
    this.ensembleMidBySlug.set(slug, ring);
    while (this.ensembleMidBySlug.size > 36) {
      const k = this.ensembleMidBySlug.keys().next().value;
      if (k) this.ensembleMidBySlug.delete(k);
      else break;
    }
  }

  /** One sample per asset/slug each book refresh (multi-asset round-robin gets correct history). */
  private recordEnsembleRingsForAllSlots(
    slots: Array<{ asset: string; slug: string }>,
    entries: Array<readonly [string, { up: { mid: number }; down: { mid: number } }]>
  ) {
    const byAsset = new Map<string, { up: { mid: number }; down: { mid: number } }>(entries);
    for (const s of slots) {
      const b = byAsset.get(s.asset);
      if (!b) continue;
      this.pushEnsembleSampleForSlug(s.slug, b.up.mid, b.down.mid);
    }
  }

  private recordEnsembleMidSample() {
    if (!this.directionalContext) return;
    const slug = this.wallet.getActiveDiscoveredSlug() ?? "_default";
    const { up, down } = this.directionalContext;
    this.pushEnsembleSampleForSlug(slug, up.mid, down.mid);
  }

  /** OLA: Binance last trade vs engine price-to-beat (Gamma / RTDS anchor). */
  private getOlaSignalCore(): {
    prediction: Direction;
    confidence: number;
    oracle: ReturnType<typeof olaOracleVersusTarget>;
    binance: number | null;
    target: number | null;
    asset: string | null;
    binanceStale: boolean;
  } {
    const asset = this.wallet.getActiveDiscoveredAsset();
    const staleMax = envNum("OLA_BINANCE_MAX_STALE_MS", 3000);
    if (!asset) {
      return {
        prediction: "UP",
        confidence: 55,
        oracle: { kind: "flat", edgeUsd: 0 },
        binance: null,
        target: null,
        asset: null,
        binanceStale: true
      };
    }
    const bin = this.binanceAgg.getPrice(asset);
    const stale = bin == null || this.binanceAgg.ageMs(asset) > staleMax;
    const targetN = this.priceToBeatByAsset.get(asset);
    const target = targetN != null && Number.isFinite(targetN) && targetN > 0 ? targetN : null;
    const th = olaThresholdUsd();
    const oracle =
      bin != null && target != null ? olaOracleVersusTarget(bin, target, th) : { kind: "flat" as const, edgeUsd: 0 };
    const dir = olaDirectionFromOracle(oracle) ?? ("UP" as Direction);
    const edgeUsd = oracle.edgeUsd;
    const confBase = oracle.kind === "flat" ? 58 : 84;
    const confidence = Math.min(
      99,
      Number((confBase + Math.min(14, edgeUsd / Math.max(1, (target ?? 1) * 0.00015))).toFixed(2))
    );
    return {
      prediction: dir,
      confidence,
      oracle,
      binance: bin,
      target,
      asset,
      binanceStale: stale
    };
  }

  /** OLA entry path: oracle direction + CLOB “discount” snipe on the winning side. */
  private getOlaEntryEvaluation(): {
    skipReason: string | null;
    direction: Direction;
    reasonLine: string;
  } {
    const core = this.getOlaSignalCore();
    if (!this.wallet.hasLiveMarketData() || !this.directionalContext) {
      return {
        skipReason: "OLA_SKIP: live UP/DOWN books required",
        direction: core.prediction,
        reasonLine: ""
      };
    }
    if (!core.asset) {
      return { skipReason: "OLA_SKIP: no active asset", direction: "UP", reasonLine: "" };
    }
    if (core.binanceStale || core.binance == null) {
      return {
        skipReason: "OLA_SKIP: Binance aggTrade stale or missing",
        direction: core.prediction,
        reasonLine: ""
      };
    }
    if (core.target == null) {
      return {
        skipReason: "OLA_SKIP: no price-to-beat",
        direction: core.prediction,
        reasonLine: ""
      };
    }
    const oracleDir = olaDirectionFromOracle(core.oracle);
    if (!oracleDir) {
      return {
        skipReason: `OLA_SKIP: oracle flat (within ±$${olaThresholdUsd()})`,
        direction: core.prediction,
        reasonLine: ""
      };
    }
    const { up, down } = this.directionalContext;
    const snipe = olaBookSnipeAllowed(oracleDir, up, down, olaSnipeAskCap());
    if (!snipe.ok) {
      return { skipReason: snipe.detail, direction: oracleDir, reasonLine: "" };
    }
    const reasonLine =
      `OLA: ${oracleDir} Binance=${core.binance.toFixed(2)} target=${core.target.toFixed(2)} edge~${core.oracle.edgeUsd.toFixed(2)} USD | UPmid=${up.mid.toFixed(3)} DNmid=${down.mid.toFixed(3)}`;
    return { skipReason: null, direction: oracleDir, reasonLine };
  }

  private maybeRecordOlaPnlAndCheckKill(trade: Trade, pnl: number) {
    const dr = trade.decisionReason ?? "";
    if (!dr.startsWith("OLA:") || dr.startsWith("OLA_SKIP")) return;
    const now = Date.now();
    const winStart = now - OLA_KILL_WINDOW_MS;
    this.olaPnlHourly = this.olaPnlHourly.filter((e) => e.t > winStart);
    this.olaPnlHourly.push({ t: now, pnl });
    const net = this.olaPnlHourly.reduce((s, e) => s + e.pnl, 0);
    const bal = Math.max(1, this.balance);
    const thrLoss = bal * OLA_KILL_SWITCH_LOSS_FRAC;
    if (net <= -thrLoss) {
      this.olaKillTriggered = true;
      this.running = false;
      this.autoTrading = false;
      this.log(
        "ERROR",
        `OLA_KILL_SWITCH: 1h net PnL $${net.toFixed(2)} (≤ -${(OLA_KILL_SWITCH_LOSS_FRAC * 100).toFixed(0)}% of balance ~$${thrLoss.toFixed(2)}) — engine stopped (admin alert)`
      );
      this.setPhase("ERROR", "OLA hourly loss kill switch");
    }
  }

  private buildEnsembleResult() {
    const samples = this.getEnsembleSamplesForActive();
    const predictLb = envNum("MOMENTUM_PREDICT_LOOKBACK", 10);
    const mt = this.momentumScalar(predictLb);
    const div = momentumMode() === "from_open" ? 500 : 120;
    const momNorm = Math.max(-1, Math.min(1, mt / div));
    const last = this.marketData.at(-1);
    const chartUp = last?.up ?? null;
    const useCtr = String(process.env.ENSEMBLE_USE_CONTRARIAN_MOMENTUM ?? "false").toLowerCase() === "true";
    const meta = this.wallet.getDiscoveredMeta();
    let secondsToExpiry: number | null = null;
    if (meta?.endDateIso) {
      const end = new Date(meta.endDateIso).getTime();
      if (!Number.isNaN(end)) secondsToExpiry = Math.floor((end - Date.now()) / 1000);
    }
    if (!this.directionalContext) {
      const direction: Direction = momNorm >= 0 ? "UP" : "DOWN";
      return { score: momNorm, direction, parts: [`mom_only:${momNorm.toFixed(2)}`] };
    }
    const { up, down } = this.directionalContext;
    return computeEnsemble({
      samples,
      up,
      down,
      secondsToExpiry,
      momentumTrend: momNorm,
      chartUpPct: chartUp,
      useContrarianMomentum: useCtr
    });
  }

  /** Auto-trade: whale_edge gates, or ensemble + ENSEMBLE_APPLY_WHALE_FILTER. */
  private whaleEdgeGateOrOk(direction: Direction): { ok: true } | { ok: false; reason: string } {
    if (this.lagSnipeEnabled) return { ok: true };
    const strat = this.effectiveEntryStrategy();
    const useWhale =
      strat === "whale_edge" ||
      (strat === "ensemble" && ensembleApplyWhaleFilter()) ||
      (strat === "ola" && olaUseWhaleFilter());
    if (!useWhale) return { ok: true };
    if (!this.directionalContext || !this.wallet.hasLiveMarketData()) {
      return {
        ok: false,
        reason: strat === "ensemble" ? "ensemble_whale: need live UP/DOWN books" : "whale_edge: need live UP/DOWN books"
      };
    }
    const timing = this.wallet.getTimingForBetLog();
    const meta = this.wallet.getDiscoveredMeta();
    let secondsToExpiry: number | null = null;
    if (meta?.endDateIso) {
      const end = new Date(meta.endDateIso).getTime();
      if (!Number.isNaN(end)) secondsToExpiry = Math.floor((end - Date.now()) / 1000);
    }
    const asset = this.wallet.getActiveDiscoveredAsset();
    let oracleDiffUsd: number | null = null;
    if (asset) {
      const spot = this.oracleSpotUsdForAsset(asset);
      const ptb = this.priceToBeatByAsset.get(asset);
      if (spot != null && ptb != null && Number.isFinite(spot) && Number.isFinite(ptb)) {
        oracleDiffUsd = spot - ptb;
      }
    }
    const { up, down } = this.directionalContext;
    return evaluateWhaleEdgeGate({
      direction,
      up,
      down,
      secondsSinceWindowStart: timing.secondsSinceWindowStart,
      secondsToExpiry,
      warmupWindow: timing.warmupWindow,
      oracleDiffUsd
    });
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
    const target = whalePaperTakeProfitMid(entryVwap, tpRelative);
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

    const pending = this.trades.filter((t) => t.status === "PENDING").length;
    const finished = this.trades.filter((t) => t.status !== "PENDING" && !t.paper?.missed);
    const wins = finished.filter((t) => t.status === "WIN").length;
    const losses = finished.filter((t) => t.status === "LOSS").length;

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
  }

  onMarket?: (data: MarketWsPayload) => void;
  onPrediction?: (data: Prediction) => void;
  onTrades?: (data: Trade[]) => void;
  onStatus?: (data: Status) => void;
  onLog?: (data: { ts: number; level: LogLevel; message: string }) => void;
  onBetLog?: (data: BetLogEntry) => void;

  /**
   * Auto-trade tick. When `olaFastLane` is true, only runs if ENTRY_STRATEGY is OLA (fast poll, default 250ms).
   * Otherwise runs on the 5s cadence for all non-OLA strategies.
   */
  private async runAutoTradeOnce(olaFastLane: boolean) {
    if (!this.running || !this.autoTrading) return;
    if (this.olaKillTriggered) return;
    const strategy = this.effectiveEntryStrategy();
    const isOla = strategy === "ola";
    const isAnchor = strategy === "anchor";
    const allowAnchorFastLane = isAnchor && this.anchorFastLaneEnabled();
    if (this.lagSnipeEnabled) {
      if (olaFastLane) return;
    } else {
      if (olaFastLane && !isOla && !allowAnchorFastLane) return;
      if (!olaFastLane && (isOla || allowAnchorFastLane)) return;
    }
    if (this.bookRefreshInFlight) return;
    this.maybeLogRuntimeHealth();
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

      if (isAnchor) {
        this.maybeRotateAnchorWindow();
        await this.recordAnchorBuffers();
        if (!olaFastLane) {
          await this.monitorAnchorExits();
        }
        const asset = this.wallet.getActiveDiscoveredAsset() ?? "?";
        const wk = this.getAnchorWindowKey() ?? "?";
        this.log(
          "SIGNAL",
          `[ANCHOR][PRIMARY] asset=${asset} window=${wk} runtimeEnabled=${this.anchorRuntimeEnabled} selected=true`
        );
        await this.maybeRunAnchorStrategy();
        return;
      }

      if (
        this.wallet.getMode() === "SIMULATION" &&
        paperBinarySettleEnabled() &&
        !this.lagSnipeEnabled &&
        !isOla
      ) {
        const meta = this.wallet.getDiscoveredMeta();
        if (meta?.endDateIso) {
          const endMs = new Date(meta.endDateIso).getTime();
          if (!Number.isNaN(endMs)) {
            const msLeft = endMs - Date.now();
            const minLeftMs = paperEntryMinMsToWindowEnd();
            if (msLeft < minLeftMs && msLeft > -60_000) {
              const asset = this.wallet.getActiveDiscoveredAsset() ?? "?";
              this.log(
                "SIGNAL",
                `[AUTO][SKIP] ORACLE_TOO_CLOSE asset=${asset} ms_to_window_end=${Math.round(msLeft)} min_required_ms=${minLeftMs}`
              );
              await this.runAnchorFallbackNonPrimary();
              return;
            }
          }
        }
      }

      const assetGate = this.wallet.getActiveDiscoveredAsset() ?? "BTC";
      if (!this.lagSnipeEnabled && !isOla) {
        const maxOracleAge = oracleMaxAgeMsForEntry();
        const gateAgeMs = this.oracleMergedAgeMsForEntryGate(assetGate);
        if (gateAgeMs == null || gateAgeMs > maxOracleAge) {
          const ageDisp = gateAgeMs == null ? "null" : String(Math.round(gateAgeMs));
          this.log(
            "SIGNAL",
            `[AUTO][SKIP] ORACLE_STALE asset=${assetGate} ageMs=${ageDisp} max_ms=${maxOracleAge}`
          );
          await this.runAnchorFallbackNonPrimary();
          return;
        }
      }

      if (!this.lagSnipeEnabled && !isOla) {
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
      if (!olaFastLane) {
        await this.monitorAnchorExits();
      }

      const choice = this.chooseDirectionalEntry();
      if (choice.reason.startsWith("OLA_SKIP:") || choice.reason.startsWith("LAG_SNIPE_SKIP:")) {
        const asset = this.wallet.getActiveDiscoveredAsset() ?? "?";
        const r = choice.reason.startsWith("OLA_SKIP:") ? "ola_skip" : "lag_snipe_skip";
        this.log("SIGNAL", `[AUTO][SKIP] asset=${asset} reason=${r} detail=${choice.reason}`);
        return;
      }

      this.log(
        "SIGNAL",
        `[AUTO] asset=${this.wallet.getActiveDiscoveredAsset() ?? "?"} dir=${choice.direction} ${choice.reason}`
      );
      const direction = choice.direction;
      /** OLA ignores global NO_TRADE from chart/volatility — entries follow oracle+book snipe only. */
      if (
        !isOla &&
        !this.lagSnipeEnabled &&
        this.prediction.recommendation === "NO_TRADE" &&
        !this.canIgnoreNoTradeForBookOnlyBlock("AUTO")
      ) {
        this.log("SIGNAL", `Auto-trade skipped (${this.prediction.reason ?? "direction mismatch"})`);
        await this.runAnchorFallbackNonPrimary();
        return;
      }
      if (!isOla && !this.lagSnipeEnabled) {
        const ot = this.oracleTrendForAutoTradeGate(assetGate);
        if (ot.kind === "insufficient") {
          this.log(
            "SIGNAL",
            `[AUTO][SKIP] ORACLE_TREND_INSUFFICIENT asset=${assetGate} samples=${ot.samples} min_samples=${ot.min}`
          );
          await this.runAnchorFallbackNonPrimary();
          return;
        }
        if (ot.kind === "stale") {
          const ageDisp = ot.ageMs == null ? "null" : String(Math.round(ot.ageMs));
          this.log(
            "SIGNAL",
            `[AUTO][SKIP] ORACLE_TREND_STALE asset=${assetGate} ageMs=${ageDisp} max_ms=${ot.max}`
          );
          await this.runAnchorFallbackNonPrimary();
          return;
        }
        const oracleTrend = ot.trend;
        const momentumSide = this.rawMomentumSide();
        if (momentumSide !== oracleTrend) {
          this.log(
            "SIGNAL",
            `[AUTO][SKIP] ORACLE_TREND_MISMATCH asset=${assetGate} momentum=${momentumSide} oracle_trend=${oracleTrend}`
          );
          await this.runAnchorFallbackNonPrimary();
          return;
        }
        if (direction !== oracleTrend) {
          this.log(
            "SIGNAL",
            `[AUTO][SKIP] DIRECTION_MISMATCH asset=${assetGate} dir=${direction} oracle_trend=${oracleTrend}`
          );
          await this.runAnchorFallbackNonPrimary();
          return;
        }
      }
      const whaleGate = this.whaleEdgeGateOrOk(direction);
      if (!whaleGate.ok) {
        this.log("SIGNAL", whaleGate.reason);
        await this.runAnchorFallbackNonPrimary();
        return;
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
        const allowLargeLive = String(process.env.LIVE_TRADE_ABOVE_1_USD_OK ?? "").toLowerCase() === "true";
        if (!allowLargeLive) {
          this.log(
            "SIGNAL",
            `[AUTO][SKIP] LIVE_MAX_ENTRY_USD_1 size_usd=${riskAmount.toFixed(2)} (set LIVE_TRADE_ABOVE_1_USD_OK=true to allow larger LIVE auto-entries)`
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
    const hasPending = this.trades.some((t) => t.status === "PENDING");

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
    const oracleAgeMs =
      this.oracleMergedAgeMsForEntryGate("BTC") ?? this.oracleAgeMsForAsset("BTC");

    const sig = evaluateAnchorStrategy(
      snap,
      hist,
      upMid,
      downMid,
      [...this.anchorImbalanceHistoryUp],
      [...this.anchorImbalanceHistoryDown],
      cfg,
      oracleAgeMs,
      tsMs
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
      (t) => t.status === "PENDING" && String(t.decisionReason ?? "").includes("ANCHOR:")
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
      } else if (this.wallet.getMode() === "LIVE") {
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
      eff === "ola"
        ? "OLA=oracle+Binance only (MOMENTUM_MODE ignored)"
        : `MOMENTUM_MODE=${momentumMode()}`;
    this.log(
      "SIGNAL",
      `Engine initialized in ${this.wallet.getMode()} mode (ENTRY_STRATEGY=${eff}${this.entryStrategyRuntime ? ` override=${this.entryStrategyRuntime}` : ""}, ${stratNote}, UPDOWN_5M=${updAssets})`
    );

    const execMode = this.wallet.getMode();
    this.log(
      "SIGNAL",
      `Execution: ${execMode === "LIVE" ? "LIVE (real USDC)" : "SIMULATION (paper)"}`
    );
    console.log(
      `[EXECUTION] Execution: ${execMode === "LIVE" ? "LIVE (real USDC)" : "SIMULATION (paper)"}`
    );
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
    this.syncAssetAutoTradeKeysFromConfigured();
    this.binanceAgg.start(this.wallet.getUpdownAssetsConfigured());
    this.running = autoStart;
    this.autoTrading = autoStart;
    this.setPhase(autoStart ? "STARTING" : "STOPPED", autoStart ? "AutoStart enabled" : undefined);
    if (autoStart) {
      this.log("TRADE", "Auto-trading enabled on startup");
    }
    if (this.effectiveEntryStrategy() === "ola") {
      const core = this.getOlaSignalCore();
      this.prediction = {
        prediction: core.prediction,
        confidence: core.confidence,
        ts: Date.now(),
        recommendation: "TRADE",
        reason: "OLA: Binance + price-to-beat (no momentum blend)"
      };
    } else if (this.effectiveEntryStrategy() === "anchor") {
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
                if (tick) chainlinkTicksByAsset.set(chainlinkAssetsToPoll[i], tick);
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
            }

            this.multiSlotBooks = Object.fromEntries(entries);
            this.recordEnsembleRingsForAllSlots(slots, entries);

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
                        )} source=chainlink`
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
            this.recordEnsembleMidSample();
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
        this.recordEnsembleMidSample();
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
      olaKillTriggered: this.olaKillTriggered,
      phase: this.phase,
      phaseReason: this.phaseReason
    };
  }

  getTrades() {
    return this.trades;
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
    const finished = this.trades.filter((t) => t.status !== "PENDING" && !t.paper?.missed);
    const wins = finished.filter((t) => t.status === "WIN");
    const losses = finished.filter((t) => t.status === "LOSS");
    const grouped = new Map<string, { wins: number; total: number }>();
    finished.forEach((t) => {
      const cur = grouped.get(t.market) ?? { wins: 0, total: 0 };
      cur.total += 1;
      if (t.status === "WIN") cur.wins += 1;
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

  getBotTradeHistory(): BotTradeHistoryRecord[] {
    return [...this.botTradeHistory];
  }

  private pushBotTradeHistory(row: BotTradeHistoryRecord) {
    this.botTradeHistory = [row, ...this.botTradeHistory].slice(0, 250);
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
    if (this.effectiveEntryStrategy() === "ola" || this.effectiveEntryStrategy() === "anchor") {
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
          if (trade.status !== "PENDING") break;

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
    if (this.olaKillTriggered) {
      this.setPhase("ERROR", "OLA hourly kill switch");
      return { accepted: false, reason: "OLA hourly kill switch triggered" };
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

    if (strat === "ola") {
      const meta = this.wallet.getDiscoveredMeta();
      const endParsed = meta?.endDateIso ? new Date(meta.endDateIso).getTime() : NaN;
      const secLeft = !Number.isNaN(endParsed) ? Math.floor((endParsed - Date.now()) / 1000) : null;
      if (olaSecondsToExpiryAbort(secLeft)) {
        this.setPhase("RISK_BLOCKED", "OLA: <10s to expiry");
        return { accepted: false, reason: "OLA: <10s to window end — no new trades" };
      }
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
      strat !== "ola" &&
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
    if (strat !== "ola" && strat !== "anchor" && !this.lagSnipeEnabled && signalModeHighConf()) {
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
    if (this.wallet.getMode() === "LIVE") {
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

    if (strat === "ola") {
      const slug = this.wallet.getActiveDiscoveredSlug();
      const wk = this.wallet.getDiscoveredMeta()?.windowStartSec;
      if (slug != null) {
        const spendKey = `${slug}|${wk ?? "_"}`;
        const cap = olaWindowSpendCap();
        const cur = this.olaSpendByWindowKey.get(spendKey) ?? 0;
        if (cur + effectiveAmount > cap + 1e-9) {
          this.setPhase("RISK_BLOCKED", "OLA window cap");
          return {
            accepted: false,
            reason: `OLA: per-window cap (${cur.toFixed(2)} + ${effectiveAmount.toFixed(2)} > $${cap} USDC)`
          };
        }
      }
      const olaAsset = this.wallet.getActiveDiscoveredAsset();
      if (olaAsset) {
        const p0 = this.binanceAgg.getPrice(olaAsset);
        const txMs = Math.max(0, envNum("OLA_TRANSMIT_SIM_MS", 25));
        if (txMs > 0) await new Promise((r) => setTimeout(r, txMs));
        const p1 = this.binanceAgg.getPrice(olaAsset);
        const slipFrac = slippageFracFromConfig(botCfg, OLA_SLIPPAGE_FRAC);
        if (p0 != null && p1 != null && olaSlippageExceeded(p0, p1, slipFrac)) {
          this.setPhase("RISK_BLOCKED", "OLA Binance slippage");
          return {
            accepted: false,
            reason: `OLA: Binance moved >${(slipFrac * 100).toFixed(2)}% during transmit (aborted)`
          };
        }
      }
    }

    this.lastTradeAtBySlug.set(cdKey, Date.now());
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
      status: "PENDING",
      direction,
      asset: entrySnap.asset,
      upPriceAtEntry: entrySnap.upPriceAtEntry,
      downPriceAtEntry: entrySnap.downPriceAtEntry,
      targetPriceUsdAtEntry: targetAtEntry,
      spotPriceUsdAtEntry: spotAtEntry,
      decisionReason,
      ...(this.lagSnipeEnabled ? { lagSnipeHold: true as const } : {})
    };
    this.trades = [pending, ...this.trades].slice(0, 250);
    if (strat === "ola") {
      const slug = this.wallet.getActiveDiscoveredSlug();
      const wk = this.wallet.getDiscoveredMeta()?.windowStartSec;
      if (slug != null) {
        const spendKey = `${slug}|${wk ?? "_"}`;
        this.olaSpendByWindowKey.set(
          spendKey,
          (this.olaSpendByWindowKey.get(spendKey) ?? 0) + effectiveAmount
        );
      }
    }
    this.onTrades?.(this.trades);
    this.log("TRADE", `[${source}] Placed ${direction} $${effectiveAmount.toFixed(2)}`);
    this.setPhase("EXECUTING", `Submitting order (${source})`);

    if (this.externalExecution) {
      this.pushBetLog(this.buildBetLog("placed", direction, book, {}));
      this.setPhase("WAITING_RESOLUTION", "External execution: waiting for MetaMask fill confirmation");
      return { accepted: true, trade: pending };
    }

    if (this.wallet.getMode() === "LIVE") {
      try {
        const order = await this.wallet.placeOrder({
          direction,
          amount: effectiveAmount,
          price: book.mid
        });
        if (order.orderID === "unknown" || order.sizeFilled <= 0) {
          this.pushBetLog(
            this.buildBetLog("blocked", direction, book, {
              blockReason: "Live order rejected (orderID unknown or sizeFilled ≤ 0)"
            })
          );
          this.log("ERROR", "Live order rejected by validation");
          return { accepted: false, reason: "Live order validation failed" };
        }
        this.pushBetLog(this.buildBetLog("placed", direction, book, {}));
        const oid = String(order.orderID);
        const idx = this.trades.findIndex((t) => t.id === pending.id);
        if (idx >= 0) {
          this.trades[idx] = { ...this.trades[idx], clobOrderId: oid };
          this.onTrades?.([...this.trades]);
        }
        void this.reconcileServerOrder(pending.id, oid);
        const entryShares = Number(order.sizeFilled);
        const skipGtcBecauseClose = liveCloseEntryOnFill() && !pending.lagSnipeHold;
        if (
          Number.isFinite(entryShares) &&
          entryShares > 0 &&
          gtcExitEnabled() &&
          !skipGtcBecauseClose &&
          !pending.lagSnipeHold
        ) {
          await this.postGtcExit(book.tokenID, entryShares, "BUY", direction, pending.id);
        }
        this.setPhase("WAITING_RESOLUTION", "Live order posted; waiting for CLOB fill");
        return { accepted: true, trade: pending };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Live order request failed";
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

    this.pushBetLog(this.buildBetLog("placed", direction, book, {}));
    const tid = String(book.tokenID ?? "");
    if (this.wallet.hasLiveMarketData() && tid && !tid.toLowerCase().startsWith("sim-")) {
      this.setPhase("EXECUTING", "Paper: limit fill vs live CLOB depth");
      void this.resolvePaperTradeAsync(pending.id, book, effectiveAmount);
      return { accepted: true, trade: pending };
    }
    this.setPhase("WAITING_RESOLUTION", "Trade accepted; waiting 5s for resolution");
    setTimeout(() => this.resolveTrade(pending.id), 5000);
    return { accepted: true, trade: pending };
  }

  /** Paper: live book + virtual fill (latency, walk, timeout, fees, rejection coin-flip). */
  private async resolvePaperTradeAsync(tradeId: string, book: MarketContext, collateralUsd: number) {
    const tokenId = book.tokenID;
    const slipRaw = Number(process.env.SIMULATION_SLIPPAGE_PCT ?? 0.015);
    const slip = Number.isFinite(slipRaw) ? Math.min(0.5, Math.max(0, slipRaw)) : 0.015;
    const limitPrice = Math.min(0.999, book.mid * (1 + slip));
    const targetShares = limitPrice > 0 ? collateralUsd / limitPrice : 0;
    const sizeShares = Number(Math.max(1e-12, targetShares).toFixed(6));

    let fill: Awaited<ReturnType<typeof executePaperLimitBuyOrder>>;
    try {
      fill = await executePaperLimitBuyOrder({
        limitPrice,
        sizeShares,
        fetchBook: () => this.wallet.getRawOrderBook(tokenId)
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log("ERROR", `PAPER entry exception: ${msg}`);
      fill = { ok: false, reason: `exception:${msg}`, latencyMs: 0 };
    }

    const idx = this.trades.findIndex((t) => t.id === tradeId && t.status === "PENDING");
    if (idx < 0) return;

    if (!fill.ok) {
      this.trades[idx] = {
        ...this.trades[idx],
        status: "LOSS",
        pnl: 0,
        paper: { missed: true, tokenId },
        decisionReason: `PAPER: ${fill.reason}`
      };
      this.pushBotTradeHistory({
        ts: Date.now(),
        mode: "paper",
        trade_id: tradeId,
        token_id: tokenId,
        side: "buy",
        phase: "missed",
        missed: true,
        latency_ms: fill.latencyMs,
        reason: fill.reason
      });
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
        entryLatencyMs: fill.latencyMs
      },
      clobOrderId: `paper-${tradeId.slice(0, 8)}`
    };
    this.pushBotTradeHistory({
      ts: Date.now(),
      mode: "paper",
      trade_id: tradeId,
      token_id: tokenId,
      side: "buy",
      phase: "entry",
      entry_price: limitPrice,
      fill_price_actual: fill.vwap,
      slippage_bps: fill.slippageBps,
      partial_fill: fill.partial,
      latency_ms: fill.latencyMs,
      fees: fill.feesUsd,
      size_shares: fill.filledShares,
      notional_usd: fill.notionalUsd
    });
    this.log(
      "TRADE",
      `PAPER entry vwap=${fill.vwap.toFixed(4)} shares=${fill.filledShares.toFixed(4)} slip=${fill.slippageBps}bps (limit×${(1 + slip).toFixed(4)})`
    );
    console.log("TRADE_FULL", {
      phase: "entry",
      direction: this.trades[idx]!.direction,
      entryPrice: fill.vwap,
      pnl: 0,
      slipPct: slip
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
    this.log("TRADE", `PAPER: oracle settlement in ~${Math.round(delayMs / 1000)}s`);
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

  /**
   * Paper settlement at $1/share redemption (oracle vs price-to-beat) — same economics as Lag Snipe.
   * Avoids `finalizePaperTradeExit` market-sell path where extreme bids can flip a winning side to negative P&L.
   */
  private async finalizePaperOracleBinarySettlement(idx: number) {
    const t = this.trades[idx];
    if (!t || t.status !== "PENDING") return;
    const asset = (t.asset ?? "BTC").toUpperCase();
    const settle = this.evaluateSessionCloseOutcome(t.direction, asset, t.targetPriceUsdAtEntry, {
      preferEntryTarget: true
    });
    if (!settle.ready) {
      this.scheduleSettleRetry(t.id, settle.reason, 1200, "Lag Snipe settle waiting feed");
      return;
    }
    const isWin = settle.isWin;
    const shares = Number(t.paper?.entryShares ?? 0);
    const vwap = Number(t.paper?.entryVwap ?? 0.5);
    const fees = Number(t.paper?.entryFeesUsd ?? 0);
    const cost = Number(t.paper?.entryCostUsd ?? shares * vwap);
    const entryTotal = cost + fees;
    const marketId = this.wallet.getActiveDiscoveredSlug() ?? "";
    const sr = settleReal({
      marketId,
      direction: t.direction,
      entryPricePerShare: vwap,
      shares,
      entryCostUsd: cost,
      entryFeesUsd: fees,
      tokenWins: isWin
    });
    const pnl = Number(sr.pnl.toFixed(2));
    logRealSettlement({
      entry: vwap,
      outcome: sr.outcome,
      finalPrice: sr.finalPrice,
      pnl: sr.pnl,
      marketId
    });
    const exitPricePerShare = sr.finalPrice;
    const pnlPerShare = isWin ? 1 - vwap - fees / Math.max(shares, 1e-12) : -(entryTotal / Math.max(shares, 1e-12));
    console.log("EXIT_DEBUG", {
      mode: "oracle_binary",
      entryPrice: vwap,
      exitPrice: exitPricePerShare,
      pnlPerShare: Number(pnlPerShare.toFixed(6)),
      shares,
      entryFeesUsd: fees,
      isWin
    });
    const settled: Trade = {
      ...t,
      status: isWin ? "WIN" : "LOSS",
      pnl,
      paper: { ...t.paper!, exitPartial: false }
    };
    console.log("TRADE_FULL", {
      direction: settled.direction,
      asset,
      entryPrice: vwap,
      exitPrice: exitPricePerShare,
      pnl: settled.pnl,
      settle: isWin ? "WIN" : "LOSS"
    });
    this.balance += settled.pnl;
    this.trades[idx] = settled;
    this.maybeRecordOlaPnlAndCheckKill(settled, settled.pnl);
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
      `PAPER oracle-binary settle ${settled.direction} P&L $${settled.pnl.toFixed(2)} (oracle vs entry-PTB; min-hold ok)`
    );
    if (this.stopLossTriggered) {
      this.setPhase("ERROR", "Stop loss reached; engine stopped");
    } else {
      this.setPhase("SIGNAL_READY");
    }
  }

  private async finalizePaperTradeExit(idx: number) {
    const t = this.trades[idx];
    if (!t) return;
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
        fetchBook: () => this.wallet.getRawOrderBook(tokenId)
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log("ERROR", `PAPER exit exception: ${msg}`);
      fill = { ok: false, reason: `exception:${msg}`, latencyMs: 0 };
    }

    const entryTotal = (t.paper?.entryCostUsd ?? 0) + (t.paper?.entryFeesUsd ?? 0);
    let pnl = 0;
    if (fill.ok) {
      const sold = fill.filledShares;
      const frac = shares > 0 ? Math.min(1, sold / shares) : 1;
      const costAlloc = entryTotal * frac;
      const exitNet = fill.notionalUsd - fill.feesUsd;
      pnl = exitNet - costAlloc;
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
      this.pushBotTradeHistory({
        ts: Date.now(),
        mode: "paper",
        trade_id: t.id,
        token_id: tokenId,
        side: "sell",
        phase: "exit",
        exit_price: fill.referencePrice,
        fill_price_actual: fill.vwap,
        slippage_bps: fill.slippageBps,
        partial_fill: fill.partial,
        latency_ms: fill.latencyMs,
        fees: fill.feesUsd,
        pnl_usd: Number(pnl.toFixed(4)),
        size_shares: fill.filledShares
      });
    } else {
      pnl = -entryTotal;
      console.log("EXIT_DEBUG", {
        mode: "market_sell",
        entryPrice: shares > 0 ? entryTotal / shares : 0,
        exitPrice: 0,
        pnlPerShare: shares > 0 ? pnl / shares : 0,
        shares,
        sold: 0,
        reason: fill.reason
      });
      this.pushBotTradeHistory({
        ts: Date.now(),
        mode: "paper",
        trade_id: t.id,
        token_id: tokenId,
        side: "sell",
        phase: "error",
        missed: false,
        latency_ms: fill.latencyMs,
        reason: fill.reason,
        pnl_usd: Number(pnl.toFixed(4))
      });
      this.log("ERROR", `PAPER exit failed ${fill.reason} — marking full loss of entry premium`);
    }

    const status = pnl >= 0 ? "WIN" : "LOSS";
    const settled: Trade = {
      ...t,
      status,
      pnl: Number(pnl.toFixed(2)),
      paper: {
        ...t.paper!,
        exitVwap: fill.ok ? fill.vwap : undefined,
        exitProceedsUsd: fill.ok ? fill.notionalUsd : undefined,
        exitFeesUsd: fill.ok ? fill.feesUsd : undefined,
        exitSlippageBps: fill.ok ? fill.slippageBps : undefined,
        exitLatencyMs: fill.ok ? fill.latencyMs : undefined,
        exitPartial: fill.ok ? fill.partial : undefined
      }
    };
    const entryPxFull = shares > 0 ? entryTotal / shares : Number(t.paper?.entryVwap ?? 0);
    console.log("TRADE_FULL", {
      direction: settled.direction,
      asset: (t.asset ?? "").toUpperCase(),
      entryPrice: entryPxFull,
      exitPrice: fill.ok ? fill.vwap : 0,
      pnl: settled.pnl,
      settle: status,
      mode: "market_sell"
    });
    this.balance += settled.pnl;
    this.trades[idx] = settled;
    this.maybeRecordOlaPnlAndCheckKill(settled, settled.pnl);

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

    if (this.stopLossTriggered) {
      this.setPhase("ERROR", "Stop loss reached; engine stopped");
    } else {
      this.setPhase("SIGNAL_READY");
    }
  }

  /** Synthetic book settlement (no live token). GTC already cancelled in resolveTrade. */
  private applyLegacySimSettlement(idx: number) {
    const t = this.trades[idx];
    if (!t || t.status !== "PENDING") return;
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
      finalPrice: sr.finalPrice,
      pnl: sr.pnl,
      marketId
    });
    const pnl = Number(sr.pnl.toFixed(2));
    const settled: Trade = { ...t, status: isWin ? "WIN" : "LOSS", pnl };
    this.balance += settled.pnl;
    this.trades[idx] = settled;
    this.maybeRecordOlaPnlAndCheckKill(settled, settled.pnl);
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
    if (this.stopLossTriggered) {
      this.setPhase("ERROR", "Stop loss reached; engine stopped");
    } else {
      this.setPhase("SIGNAL_READY");
    }
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
    const idx = this.trades.findIndex((t) => t.id === tradeId && t.status === "PENDING");
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
    if (t.status !== "PENDING") {
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
    const settled: Trade = { ...t, status: isWin ? "WIN" : "LOSS", pnl };
    this.balance += settled.pnl;
    this.trades[idx] = settled;
    this.maybeRecordOlaPnlAndCheckKill(settled, settled.pnl);

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

    if (this.stopLossTriggered) {
      this.setPhase("ERROR", "Stop loss reached; engine stopped");
    } else {
      this.setPhase("SIGNAL_READY");
    }
  }
}
