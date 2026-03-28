import { randomUUID } from "node:crypto";
import type {
  BetLogEntry,
  Direction,
  DirectionalContext,
  BotPhase,
  GtcExitMetrics,
  Insights,
  LogLevel,
  MarketContext,
  MarketOption,
  MarketPoint,
  Prediction,
  Status,
  Trade,
  TradingState
} from "../types/index.js";
import { fetchBtcUsd } from "./btcPriceFeed.js";
import { WalletService } from "./wallet.js";

const START_BALANCE = Number(process.env.START_BALANCE ?? 1000);
const MIN_TRADE = Number(process.env.MIN_TRADE ?? 1);
const MAX_TRADE = Number(process.env.MAX_TRADE ?? 300);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 1500);
const STOP_LOSS = Number(process.env.STOP_LOSS ?? 300);
/** Fixed USD collateral per entry (auto + manual sizing baseline). Override with ENTRY_USD in .env */
const ENTRY_USD = Number(process.env.ENTRY_USD ?? 1);
/** Default caps; effective values read inside trade() after dotenv (engine imports before index loads .env). */
const DEFAULT_MAX_SPREAD = 0.15;
const DEFAULT_MIN_LIQUIDITY = 80;
/** Polymarket-style ~4s cadence; 75 pts ≈ last 5 minutes. */
const CHART_POLL_MS = Number(process.env.CHART_POLL_MS ?? 4000);
const CHART_MAX_POINTS = Number(process.env.CHART_MAX_POINTS ?? 75);
/** USD short-term volatility cap for NO_TRADE (live tick-to-tick deltas). */
const PREDICTION_VOLATILITY_USD = Number(process.env.PREDICTION_VOLATILITY_USD ?? 15);

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

export class TradingEngine {
  private wallet = new WalletService();
  private running = false;
  private autoTrading = false;
  private balance = START_BALANCE;
  private trades: Trade[] = [];
  private marketData: MarketPoint[] = [];
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
  private lastTradeAt = 0;
  private stopLossTriggered = false;
  private noTradeSignals = 0;
  private markets: MarketOption[] = [{ tokenID: "sim-btc-up", label: "BTC 5s UP", outcome: "UP" }];
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
  private betLogs: BetLogEntry[] = [];
  private lastBookRefreshMs: number | null = null;
  /** Tracks 5m window (Gamma slug time or local 5m bucket in SIM). */
  private lastTrackedWindowKey: string | null = null;
  private btcTargetUsd: number | null = null;

  private gtcMetrics: GtcExitMetrics = {
    postsAttempted: 0,
    postsAccepted: 0,
    fillLogEvents: 0,
    profitLocks: 0,
    preResolveCancels: 0,
    settleCancels: 0,
    fillRatioSum: 0
  };

  /** Stops the 50ms GTC fill / pre-resolve monitor loop. */
  private stopGtcMonitor: (() => void) | null = null;

  private setPhase(phase: BotPhase, phaseReason?: string) {
    this.phase = phase;
    this.phaseReason = phaseReason;
    // Update UI immediately when the phase changes.
    this.onStatus?.(this.status());
  }

  private currentWindowKey(): string {
    const meta = this.wallet.getDiscoveredMeta();
    if (meta?.windowStartSec != null) return String(meta.windowStartSec);
    return String(Math.floor(Date.now() / 300_000));
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

  private basePredict() {
    const recent = this.marketData.slice(-10);
    const trend = recent.reduce((acc, p) => acc + p.movement, 0);
    const direction: Direction = trend >= 0 ? "UP" : "DOWN";
    const confidenceBase = 92 + Math.random() * 8;
    const trendBoost = Math.min(2, Math.abs(trend) * 0.2);
    return {
      prediction: direction,
      confidence: Math.min(100, Number((confidenceBase + trendBoost).toFixed(2))),
      ts: Date.now()
    };
  }

  private momentumDirection(): Direction {
    const recent = this.marketData.slice(-8);
    const momentum = recent.reduce((sum, p) => sum + p.movement, 0);
    return momentum >= 0 ? "UP" : "DOWN";
  }

  private getRiskSizedAmount() {
    const target = Number.isFinite(ENTRY_USD) && ENTRY_USD > 0 ? ENTRY_USD : 1;
    const capped = Math.min(this.balance, Math.max(MIN_TRADE, Math.min(MAX_TRADE, target)));
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
    const target = Number.isFinite(ENTRY_USD) && ENTRY_USD > 0 ? ENTRY_USD : 1;
    const capped = Math.min(budget.availableUsdc, Math.max(MIN_TRADE, Math.min(MAX_TRADE, target)));
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
    if (book.liquidity < minLiq) {
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
      }
    };
  }

  private chooseDirectionalEntry(): { direction: Direction; reason: string } {
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

  onMarket?: (data: MarketPoint[]) => void;
  onPrediction?: (data: Prediction) => void;
  onTrades?: (data: Trade[]) => void;
  onStatus?: (data: Status) => void;
  onLog?: (data: { ts: number; level: LogLevel; message: string }) => void;
  onBetLog?: (data: BetLogEntry) => void;

  async init() {
    const autoStart = String(process.env.AUTO_START_BOT ?? "true").toLowerCase() === "true";
    await this.wallet.init();
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
    this.log("SIGNAL", `Engine initialized in ${this.wallet.getMode()} mode`);
    this.running = autoStart;
    this.autoTrading = autoStart;
    this.setPhase(autoStart ? "STARTING" : "STOPPED", autoStart ? "AutoStart enabled" : undefined);
    if (autoStart) {
      this.log("TRADE", "Auto-trading enabled on startup");
    }
    this.prediction = { ...this.basePredict(), recommendation: "TRADE", reason: "Warm start" };
    this.onPrediction?.(this.prediction);
    const tickBtcChart = async () => {
      try {
        const p = await fetchBtcUsd();
        this.pushMarketPointFromLiveBtc(p);
        this.onMarket?.(this.marketData);
      } catch (e) {
        this.log("ERROR", `BTC chart feed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void tickBtcChart();
    setInterval(() => void tickBtcChart(), CHART_POLL_MS);
    setInterval(() => {
      const base = this.basePredict();
      const recent = this.marketData.slice(-12);
      const moves = recent.map((r) => r.movement);
      const avgMove = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : 0;
      const volatility = moves.length ? Math.sqrt(moves.reduce((a, b) => a + b * b, 0) / moves.length) : 0;
      let recommendation: "TRADE" | "NO_TRADE" =
        this.prediction.confidence < 94 || volatility > PREDICTION_VOLATILITY_USD ? "NO_TRADE" : "TRADE";
      let reason =
        recommendation === "NO_TRADE"
          ? this.prediction.confidence < 94
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

      this.prediction = { ...base, recommendation, reason };
      if (recommendation === "NO_TRADE" && reason.includes("Live books not tradable")) {
        this.setPhase("MARKET_NOT_TRADABLE", reason);
      } else if (recommendation === "TRADE") {
        this.setPhase("SIGNAL_READY", `Signal: ${base.prediction} (${base.confidence.toFixed(0)}%)`);
      } else {
        // Signal generator blocked; execution will also block.
        this.setPhase("SIGNAL_READY", reason);
      }
      if (recommendation === "NO_TRADE") this.noTradeSignals += 1;
      this.onPrediction?.(this.prediction);
      this.log(
        "SIGNAL",
        `${this.prediction.prediction} ${this.prediction.confidence}% (${this.prediction.recommendation})`
      );
    }, 5000);
    setInterval(async () => {
      if (!this.running || !this.autoTrading) return;
      const choice = this.chooseDirectionalEntry();
      const direction = choice.direction;
      if (this.prediction.recommendation === "NO_TRADE") {
        this.log("SIGNAL", `Auto-trade skipped (${this.prediction.reason ?? "direction mismatch"})`);
        return;
      }
      const { amount: riskAmount, budget } = await this.computeAutoTradeAmount();
      if (riskAmount < MIN_TRADE) {
        if (!budget) {
          this.log(
            "SIGNAL",
            `Skipped because budget unavailable (wallet.getAvailableCollateralBudget() returned null). MIN_TRADE=${MIN_TRADE}`
          );
        } else {
          const total = budget.balanceUsdc;
          const reserved = budget.reservedUsdc;
          const available = budget.availableUsdc;
          this.log(
            "SIGNAL",
            `Skipped because available collateral ${available.toFixed(6)} < MIN_TRADE ${MIN_TRADE} (total ${total.toFixed(
              6
            )}; reserved ${reserved.toFixed(6)})`
          );
        }
        return;
      }
      const result = await this.trade(direction, riskAmount, "AUTO", choice.reason);
      if (!result.accepted) this.log("ERROR", `Auto-trade blocked: ${result.reason ?? "unknown"}`);
    }, 5000);
    setInterval(async () => {
      try {
        const rolled = await this.wallet.refreshActiveUpDownMarket();
        if (rolled) {
          this.setPhase("ROLLOVER", "Active 5m window rolled; refreshing token IDs");
          const sel = this.wallet.getDiscoveredSelection();
          if (sel) {
            this.selectedMarket = { tokenID: sel.tokenID, label: sel.label, outcome: "AUTO" };
            this.log("SIGNAL", `Active market rolled: ${sel.label}`);
          }
        }
        this.setPhase("BOOK_LOADING", "Refreshing order books / directional contexts");
        this.marketContext = await this.wallet.getMarketContext(this.selectedMarket.tokenID);
        this.directionalContext = await this.wallet.getDirectionalContext();
        this.lastBookRefreshMs = Date.now();
      } catch {
        this.log("ERROR", "Failed to refresh market context");
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
      this.marketContext = await this.wallet.getMarketContext(this.selectedMarket.tokenID);
      this.directionalContext = await this.wallet.getDirectionalContext();
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
      cooldownMs: COOLDOWN_MS,
      stopLossTriggered: this.stopLossTriggered,
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

  getClobSigningConfig() {
    return this.wallet.getPublicSigningConfig();
  }

  getMarketData() {
    return this.marketData;
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
    const finished = this.trades.filter((t) => t.status !== "PENDING");
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
      gtcExit: { ...this.gtcMetrics }
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
    if (this.stopLossTriggered) {
      this.setPhase("ERROR", "Stop loss triggered");
      return { accepted: false, reason: "Stop loss triggered" };
    }
    if (amount < MIN_TRADE || amount > MAX_TRADE) {
      this.setPhase("RISK_BLOCKED", "Trade limits violated");
      return { accepted: false, reason: "Trade limits violated" };
    }
    if (this.wallet.getMode() === "SIMULATION" && amount > this.balance) {
      this.setPhase("RISK_BLOCKED", "Insufficient balance");
      return { accepted: false, reason: "Insufficient balance" };
    }
    if (Date.now() - this.lastTradeAt < COOLDOWN_MS) {
      this.setPhase("RISK_BLOCKED", "Cooldown active");
      return { accepted: false, reason: "Cooldown active" };
    }

    if (this.prediction.recommendation === "NO_TRADE") {
      this.setPhase("SIGNAL_READY", this.prediction.reason);
      return { accepted: false, reason: `No-trade signal: ${this.prediction.reason}` };
    }
    const book = this.liveBookForDirection(direction);
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

    let effectiveAmount = amount;
    if (this.wallet.getMode() === "LIVE") {
      const budget = await this.wallet.getAvailableCollateralBudget();
      if (budget) {
        if (budget.availableUsdc < MIN_TRADE) {
          const reason = `Skipped because available collateral ${budget.availableUsdc.toFixed(6)} < MIN_TRADE ${MIN_TRADE}`;
          this.log(
            "SIGNAL",
            `Collateral filter: total=${budget.balanceUsdc.toFixed(6)} reserved=${budget.reservedUsdc.toFixed(
              6
            )} available=${budget.availableUsdc.toFixed(6)} MIN_TRADE=${MIN_TRADE}`
          );
          this.setPhase("RISK_BLOCKED", reason);
          return { accepted: false, reason };
        }

        effectiveAmount = Math.min(amount, budget.availableUsdc);
        effectiveAmount = Math.min(MAX_TRADE, Math.max(MIN_TRADE, effectiveAmount));
        if (effectiveAmount < amount) {
          this.log(
            "SIGNAL",
            `Sized entry to $${effectiveAmount.toFixed(2)} (available $${budget.availableUsdc.toFixed(2)}; reserved $${budget.reservedUsdc.toFixed(2)})`
          );
        }
      }
    }

    this.lastTradeAt = Date.now();
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
      decisionReason
    };
    this.trades = [pending, ...this.trades].slice(0, 250);
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
        const skipGtcBecauseClose = liveCloseEntryOnFill();
        if (Number.isFinite(entryShares) && entryShares > 0 && gtcExitEnabled() && !skipGtcBecauseClose) {
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
    this.setPhase("WAITING_RESOLUTION", "Trade accepted; waiting 5s for resolution");
    setTimeout(() => this.resolveTrade(pending.id), 5000);
    return { accepted: true, trade: pending };
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
        let okToSettle = true;
        if (this.wallet.getMode() === "LIVE" && !this.externalExecution && liveCloseEntryOnFill()) {
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
        if (okToSettle) {
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
    if (idx < 0) return;
    const t = this.trades[idx];
    if (t.status !== "PENDING") return;

    if (t.gtcExitOrderId) {
      void this.wallet.cancelClobOrder(t.gtcExitOrderId);
      this.gtcMetrics.settleCancels += 1;
      this.log("TRADE", `GTC_CANCEL: reason=settle order=${t.gtcExitOrderId}`);
    }

    const predictedDirection = this.prediction.prediction;
    const isWin = t.direction === predictedDirection;

    let pnl = 0;
    if (this.wallet.getMode() === "SIMULATION") {
      pnl = isWin ? t.amount * (this.prediction.confidence / 100) : -t.amount;
    } else {
      const price = 0.5;
      pnl = isWin ? (1 - price) * t.amount : -(price * t.amount);
    }

    const settled: Trade = { ...t, status: isWin ? "WIN" : "LOSS", pnl: Number(pnl.toFixed(2)) };
    this.balance += settled.pnl;
    this.trades[idx] = settled;

    const drawdown = START_BALANCE - this.balance;
    if (drawdown >= STOP_LOSS) {
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
