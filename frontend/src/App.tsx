import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import siteBackgroundUrl from "./assets/site-background.png";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { api } from "./api";
import {
  getCollateralUsdcFromMetaMask,
  approveCollateralAllowanceFromMetaMask,
  getBalanceAllowanceFromMetaMask,
  getAvailableCollateralBudgetFromMetaMask,
  placeClobOrderFromMetaMask,
  pollOrderUntilFilledMetaMask,
  fetchOrderMatchedSharesMetaMask,
  placeClobMarketSellFromMetaMask,
  cancelClobMarketOrdersForAssetMetaMask,
  type ClobSigningConfig
} from "./clobMetamask";
import { downloadBetLogsCsv, downloadLiveLogsCsv } from "./csvExport";
import type {
  BetLogEntry,
  BotStatus,
  DashboardEntryStrategyId,
  Direction,
  EntryStrategyState,
  Insights,
  MarketOption,
  MarketPoint,
  Mode,
  PingResponse,
  PolymarketAccountSummary,
  Prediction,
  Trade,
  TradeLogQueryResponse,
  TradeLogRow,
  TradingState,
  WalletSummary,
  RiskSettingsSnapshot
} from "./types";
import {
  CopyProMainNav,
  CopyProMetricsRow,
  CopyProTopBar,
  OverviewSubNav,
  RiskBetSettingsModal,
  SnipeAssetCardsRow,
  StrategyModulesStrip,
  type OverviewSubTab
} from "./copyProUi";
import { SettingsScreenPoly, StrategyConfigScreen, WizardScreenPoly } from "./polySnipeScreens";
import type { SnipeRoute } from "./snipeUi";

/** Vite resolves the PNG URL; gradient kept lighter so dark artwork stays visible. */
const appShellBackground: CSSProperties = {
  backgroundColor: "#050508",
  backgroundImage: `linear-gradient(160deg, rgba(5, 5, 8, 0.48) 0%, rgba(5, 5, 8, 0.58) 38%, rgba(5, 5, 8, 0.7) 100%), url(${siteBackgroundUrl})`,
  backgroundSize: "cover",
  backgroundPosition: "center top",
  backgroundRepeat: "no-repeat",
  backgroundAttachment: "scroll"
};

type LogLevel = "WIN" | "ERROR" | "SIGNAL" | "TRADE";

interface LogEntry {
  ts: number;
  level: LogLevel;
  message: string;
}

type InspectionKind = "api" | "ui";

interface InspectionLine {
  ts: number;
  kind: InspectionKind;
  text: string;
}

type TradeLogPreset = "today" | "yesterday" | "7d" | "30d" | "custom";

function dayStartLocal(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

type PortfolioRange = "1m" | "1h" | "day" | "month" | "year";

const WS_URL = "ws://localhost:4011";

/**
 * MetaMask: always market-SELL entry shares before dashboard confirm (aligns with Polymarket inventory).
 * VITE_MM_AUTO_EXIT: if true, wait for profit/time monitor before SELL; if false, SELL immediately after fill.
 */
function readMmAutoExitEnv() {
  return {
    monitorBeforeClose: String(import.meta.env.VITE_MM_AUTO_EXIT ?? "true").toLowerCase() !== "false",
    profitMult: Math.max(1, Number(import.meta.env.VITE_MM_AUTO_EXIT_PROFIT_MULT ?? 2)),
    timeMs: Math.max(1000, Number(import.meta.env.VITE_MM_AUTO_EXIT_TIME_MS ?? 12_000)),
    monitorPollMs: Math.max(50, Number(import.meta.env.VITE_MM_AUTO_EXIT_MONITOR_MS ?? 100)),
    exitOrderPollMs: Math.max(50, Number(import.meta.env.VITE_MM_AUTO_EXIT_EXIT_POLL_MS ?? 200)),
    maxMonitorMs: Math.max(5000, Number(import.meta.env.VITE_MM_AUTO_EXIT_MAX_MS ?? 15_000))
  };
}

function tradePnlUsd(t: Trade): number {
  const x = Number(t.pnl);
  return Number.isFinite(x) ? x : 0;
}

function tradeRowOpenForUi(t: Trade): boolean {
  return t.status === "PENDING" || t.status === "OPEN";
}

function tradeRowClosedForUi(t: Trade): boolean {
  return t.status === "WIN" || t.status === "LOSS" || t.status === "CLOSED";
}

/** CLOB mid (0–1) → display % (e.g. 0.52 → 52.00). */
function fmtEntryMidPct(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v * 100).toFixed(2);
}

function isPaperNoFill(t: Trade): boolean {
  return Boolean(t.paper?.missed);
}

function tradeEntryFillPct(t: Trade): string {
  const v = t.paper?.entryVwap ?? t.price;
  const n = Number(v);
  return Number.isFinite(n) ? (n * 100).toFixed(2) : "—";
}

/** Exit / mark (¢): uses simulated exit VWAP, live mark while PENDING, or binary 100/0 fallback. */
function tradeExitDisplayPct(t: Trade): string {
  if (isPaperNoFill(t)) return "—";
  const ex = t.paper?.exitVwap;
  if (ex != null && Number.isFinite(ex)) return (ex * 100).toFixed(2);
  if ((t.status === "PENDING" || t.status === "OPEN") && t.paper && !t.paper.missed) {
    const m = t.paper.markPrice;
    if (m != null && Number.isFinite(m)) return `${(m * 100).toFixed(2)} mkt`;
  }
  if (t.status === "WIN") return "100.00";
  if (t.status === "LOSS") return "0.00";
  if (t.status === "CLOSED") {
    const ev = t.paper?.exitVwap;
    if (ev != null && Number.isFinite(ev)) return (ev * 100).toFixed(2);
    return tradePnlUsd(t) >= 0 ? "100.00" : "0.00";
  }
  return "—";
}

function formatTradePnlDisplay(t: Trade, digits: number): { text: string; className: string } {
  if (isPaperNoFill(t)) return { text: "NO FILL", className: "text-slate-500" };
  if (
    (t.status === "PENDING" || t.status === "OPEN") &&
    t.paper?.unrealizedPnlUsd != null &&
    Number.isFinite(t.paper.unrealizedPnlUsd)
  ) {
    const u = t.paper.unrealizedPnlUsd;
    return {
      text: `${u >= 0 ? "+" : ""}$${u.toFixed(digits)} u`,
      className: u >= 0 ? "text-emerald-400" : "text-rose-400"
    };
  }
  const p = Number(t.pnl ?? 0);
  return {
    text: `${p >= 0 ? "+" : ""}$${p.toFixed(digits)}`,
    className: p >= 0 ? "text-emerald-400" : "text-rose-400"
  };
}

/** Badge: server `executionMode` when present; else infer (legacy rows). */
function tradeExecutionModeLabel(t: Trade, walletMode?: Mode | null): "PAPER" | "LIVE" {
  if (t.executionMode === "PAPER" || t.executionMode === "LIVE") return t.executionMode;
  if (walletMode === "SIMULATION") return "PAPER";
  if (t.paper != null) return "PAPER";
  const oid = String(t.clobOrderId ?? "");
  if (oid.startsWith("paper-")) return "PAPER";
  return "LIVE";
}

function tradeReasonSummary(t: Trade): string {
  if (t.decisionReason) return t.decisionReason;
  return t.status === "PENDING" || t.status === "OPEN" ? "OPEN" : t.status;
}

function calcStats(trades: Trade[]) {
  const settled = trades.filter(
    (t) =>
      !t.paper?.missed && (t.status === "WIN" || t.status === "LOSS" || t.status === "CLOSED")
  );
  const wins = settled.filter(
    (t) => t.status === "WIN" || (t.status === "CLOSED" && tradePnlUsd(t) > 0)
  );
  const losses = settled.filter(
    (t) => t.status === "LOSS" || (t.status === "CLOSED" && tradePnlUsd(t) <= 0)
  );
  const grossWin = wins.reduce((a, b) => a + Math.max(0, tradePnlUsd(b)), 0);
  const grossLoss = losses.reduce((a, b) => a + Math.abs(Math.min(0, tradePnlUsd(b))), 0);
  const winRate = settled.length ? (wins.length / settled.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin;
  const net = settled.reduce((a, b) => a + tradePnlUsd(b), 0);
  return { winRate, profitFactor, net, grossWin, grossLoss };
}

/** Safe numeric display for API / websocket payloads that may omit or corrupt fields. */
function fmtNum(n: unknown, digits: number): string {
  const x = typeof n === "number" ? n : Number(n);
  return Number.isFinite(x) ? x.toFixed(digits) : "—";
}

function formatBookRefreshAge(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 3) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  return `${m}m ago`;
}

function yTickStepUsd(mid: number): number {
  if (!Number.isFinite(mid) || mid <= 0) return 25;
  if (mid >= 20_000) return 25;
  if (mid >= 5_000) return 10;
  if (mid >= 1_000) return 5;
  if (mid >= 200) return 2;
  if (mid >= 50) return 1;
  if (mid >= 10) return 0.5;
  if (mid >= 1) return 0.1;
  if (mid >= 0.2) return 0.02;
  return 0.01;
}

/** Right-axis ticks scaled to spot magnitude (BTC → ~$25 steps; alts / memes → tighter). */
function buildAdaptiveYTicks(points: MarketPoint[], anchorUsd?: number | null): number[] {
  const prices = points.map((p) => p.btcUsd).filter((v): v is number => v != null && Number.isFinite(v));
  if (prices.length === 0) return [];
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (typeof anchorUsd === "number" && Number.isFinite(anchorUsd)) {
    min = Math.min(min, anchorUsd);
    max = Math.max(max, anchorUsd);
  }
  const mid = (min + max) / 2;
  const step = yTickStepUsd(mid);
  const pad = step * 5;
  const low = Math.floor((min - pad) / step) * step;
  const high = Math.ceil((max + pad) / step) * step;
  const ticks: number[] = [];
  let t = low;
  let n = 0;
  const maxTicks = 72;
  while (t <= high + step * 0.001 && n < maxTicks) {
    ticks.push(Number(Number(t).toFixed(10)));
    t += step;
    n += 1;
  }
  return ticks;
}

function formatUsdSpot(n: number): string {
  if (n >= 1000) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

const ASSET_CHART_STROKE: Record<string, string> = {
  BTC: "#F7931A",
  ETH: "#627EEA",
  SOL: "#9945FF",
  XRP: "#38B6FF",
  DOGE: "#C2A633"
};

function chartStrokeForAsset(a: string): string {
  return ASSET_CHART_STROKE[a.toUpperCase()] ?? "#94a3b8";
}

function AssetSpotChartCard({
  asset,
  points,
  stroke
}: {
  asset: string;
  points: MarketPoint[];
  stroke: string;
}): ReactElement {
  const last = points[points.length - 1];
  const target = last?.btcTargetUsd ?? null;
  const spot = last?.btcUsd;
  const yTicks = useMemo(() => buildAdaptiveYTicks(points, target ?? null), [points, target]);
  const xTicks = useMemo(() => buildXTickTimes(points, 8), [points]);
  const yDomain = useMemo((): [number, number] | undefined => {
    if (yTicks.length < 2) return undefined;
    return [yTicks[0], yTicks[yTicks.length - 1]];
  }, [yTicks]);

  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-slate-800 bg-[#0f1114] p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-bold tracking-tight text-white">{asset}</span>
        {spot != null && Number.isFinite(spot) ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0 text-xs">
            <span className="text-lg font-semibold text-white">{formatUsdSpot(spot)}</span>
            {target != null && Number.isFinite(target) ? (
              <>
                <span className="text-slate-500">Target</span>
                <span className="font-mono text-slate-200">{formatUsdSpot(target)}</span>
                <span
                  className={
                    spot - target >= 0 ? "font-medium text-emerald-400" : "font-medium text-rose-400"
                  }
                >
                  {spot - target >= 0 ? "+" : ""}
                  {formatUsdSpot(spot - target)}
                </span>
              </>
            ) : null}
          </div>
        ) : (
          <span className="text-xs text-slate-500">No spot yet</span>
        )}
      </div>
      {points.length > 0 && points.some((p) => p.btcUsd != null) ? (
        <div className="h-[240px] min-h-[220px] w-full flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 48, left: 2, bottom: 4 }}>
              <CartesianGrid stroke="#1a1d22" strokeOpacity={0.9} vertical={false} />
              <XAxis
                dataKey="time"
                stroke="#52525b"
                tick={{ fill: "#a1a1aa", fontSize: 10 }}
                ticks={xTicks}
                interval={0}
              />
              <YAxis
                orientation="right"
                stroke="#52525b"
                tick={{ fill: "#a1a1aa", fontSize: 10 }}
                ticks={yTicks}
                domain={yDomain ?? ["auto", "auto"]}
                tickFormatter={(v) => (typeof v === "number" ? formatUsdSpot(v) : String(v))}
                width={56}
              />
              {target != null && Number.isFinite(target) ? (
                <ReferenceLine
                  y={target}
                  stroke="rgba(255,255,255,0.88)"
                  strokeDasharray="4 4"
                  label={{
                    value: "Target",
                    position: "right",
                    fill: "#cbd5e1",
                    fontSize: 10,
                    fontWeight: 500
                  }}
                />
              ) : null}
              <Tooltip
                contentStyle={{ background: "#1a1d23", border: "1px solid #334155", borderRadius: 8 }}
                formatter={(v: number | string) => [
                  typeof v === "number" ? formatUsdSpot(v) : v,
                  asset
                ]}
                labelFormatter={(l) => String(l)}
              />
              <Line
                type="monotone"
                dataKey="btcUsd"
                stroke={stroke}
                strokeWidth={2}
                dot={(props: { cx?: number; cy?: number; index?: number }) => {
                  const { cx, cy, index } = props;
                  if (cx == null || cy == null || index !== points.length - 1) return <g />;
                  return <circle cx={cx} cy={cy} r={3} fill={stroke} stroke={stroke} />;
                }}
                activeDot={{ r: 4, fill: stroke, stroke: "#fff", strokeWidth: 1 }}
                isAnimationActive={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex min-h-[220px] flex-1 items-center justify-center rounded-md bg-[#0a0c10] text-xs text-slate-500">
          Loading {asset} spot…
        </div>
      )}
    </div>
  );
}

/** Subsample time labels so the axis stays readable (underlying data stays full resolution). */
function buildXTickTimes(points: MarketPoint[], maxLabels = 12): string[] {
  const data = points.filter((p) => p.btcUsd != null);
  if (data.length === 0) return [];
  if (data.length === 1) return [data[0].time];
  const step = Math.max(1, Math.ceil(data.length / maxLabels));
  const out: string[] = [];
  for (let i = 0; i < data.length; i += step) out.push(data[i].time);
  const lastT = data[data.length - 1].time;
  if (out[out.length - 1] !== lastT) out.push(lastT);
  return out;
}

export function App() {
  const [chartData, setChartData] = useState<MarketPoint[]>([]);
  const [assetCharts, setAssetCharts] = useState<Record<string, MarketPoint[]>>({});
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [betLogs, setBetLogs] = useState<BetLogEntry[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [amount, setAmount] = useState(1);
  const [loadingTrade, setLoadingTrade] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [markets, setMarkets] = useState<MarketOption[]>([]);
  const [selectedTokenID, setSelectedTokenID] = useState("");
  const [insights, setInsights] = useState<Insights | null>(null);
  const insightsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loginHint, setLoginHint] = useState("Step 1: login with User ID and Password. Step 2: Start Bot.");
  const [showWalletHelp, setShowWalletHelp] = useState(false);
  const [showPasswordLogin, setShowPasswordLogin] = useState(false);
  const [userIdInput, setUserIdInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [portfolioRange, setPortfolioRange] = useState<PortfolioRange>("1h");
  const [polyAccount, setPolyAccount] = useState<PolymarketAccountSummary | null>(null);
  const [isPolyConnecting, setIsPolyConnecting] = useState(false);
  const [inspectionLogs, setInspectionLogs] = useState<InspectionLine[]>([]);
  const [modeToggleLoading, setModeToggleLoading] = useState(false);
  const [tradingState, setTradingState] = useState<TradingState | null>(null);
  const [assetAutoTradeBusy, setAssetAutoTradeBusy] = useState<string | null>(null);
  const [anchorBusy, setAnchorBusy] = useState(false);
  const [metaMaskOrderBusy, setMetaMaskOrderBusy] = useState(false);
  const [metaMaskConnected, setMetaMaskConnected] = useState(false);
  const [metaMaskAddress, setMetaMaskAddress] = useState<string | null>(null);
  /** Default off so server LIVE (“Go LIVE”) works without hunting for a checkbox; enable when you want client-signed orders only. */
  const [metaMaskAutoEnabled, setMetaMaskAutoEnabled] = useState(false);
  const lastAutoMetaMaskTsRef = useRef(0);
  const lastMetaMaskTradeIdRef = useRef<string | null>(null);
  /** First `/trading-state` response: align Execution & size with server risk (avoids stale default $1). */
  const didBootstrapAmountFromServerRef = useRef(false);
  const mmAutoExitAbortRef = useRef<AbortController | null>(null);
  const [metaMaskPolymarketUsdc, setMetaMaskPolymarketUsdc] = useState<number | null>(null);
  const [metaMaskUsdcLoading, setMetaMaskUsdcLoading] = useState(false);
  const [capitalPctPerEntry, setCapitalPctPerEntry] = useState<number>(10);
  const [amountSource, setAmountSource] = useState<"PERCENT" | "MANUAL">("MANUAL");
  const [snipeRoute, setSnipeRoute] = useState<SnipeRoute>("dashboard");
  const [overviewSub, setOverviewSub] = useState<OverviewSubTab>("live");
  const [riskModalOpen, setRiskModalOpen] = useState(false);
  const [riskModalBusy, setRiskModalBusy] = useState(false);
  const [riskModalError, setRiskModalError] = useState<string | null>(null);
  const [pingData, setPingData] = useState<PingResponse | null>(null);
  const [pingBusy, setPingBusy] = useState(false);
  const [tradeLogPreset, setTradeLogPreset] = useState<TradeLogPreset>("today");
  const [tradeLogFrom, setTradeLogFrom] = useState<string>(() => dayStartLocal().toISOString().slice(0, 10));
  const [tradeLogTo, setTradeLogTo] = useState<string>(() => dayStartLocal().toISOString().slice(0, 10));
  const [tradeLogAsset, setTradeLogAsset] = useState<string>("ALL");
  const [tradeLogStrategy, setTradeLogStrategy] = useState<string>("ALL");
  const [tradeLogSession, setTradeLogSession] = useState<"24h" | "AM" | "PM">("24h");
  const [tradeLogLoading, setTradeLogLoading] = useState(false);
  const [tradeLogRows, setTradeLogRows] = useState<TradeLogRow[]>([]);
  const [tradeLogStats, setTradeLogStats] = useState<TradeLogQueryResponse["stats"] | null>(null);

  const defaultRiskSnapshot = useMemo(
    (): RiskSettingsSnapshot => ({
      entryUsd: 1,
      minTrade: 1,
      maxTrade: 300,
      stopLossUsd: 300,
      cooldownMs: 1500,
      env: {
        entryUsd: 1,
        minTrade: 1,
        maxTrade: 300,
        stopLossUsd: 300,
        cooldownMs: 1500
      },
      overridesActive: false
    }),
    []
  );

  const riskSettingsForUi = tradingState?.riskSettings ?? defaultRiskSnapshot;

  const defaultEntryStrategy = useMemo<EntryStrategyState>(
    () => ({
      effective: "momentum",
      runtimeOverride: null,
      fromEnv: "momentum",
      label: "Momentum (chart trend)"
    }),
    []
  );
  const entryStrategyUi = tradingState?.entryStrategy ?? defaultEntryStrategy;
  const [entryStrategyBusy, setEntryStrategyBusy] = useState(false);

  const applyEntryStrategy = async (patch: { reset?: boolean; strategy?: DashboardEntryStrategyId }) => {
    if (!isLoggedIn) {
      setLoginHint("Sign in to change entry strategy.");
      setShowPasswordLogin(true);
      return;
    }
    setEntryStrategyBusy(true);
    try {
      const out = await api.setEntryStrategy(patch);
      setTradingState((prev) => (prev ? { ...prev, entryStrategy: out.entryStrategy } : prev));
      setLoginHint(
        patch.reset
          ? "Entry strategy follows server .env again."
          : `Entry strategy: ${out.entryStrategy.label}.`
      );
    } catch (e) {
      setLoginHint(e instanceof Error ? e.message : String(e));
    } finally {
      setEntryStrategyBusy(false);
    }
  };

  const [lagSnipeBusy, setLagSnipeBusy] = useState(false);
  const lagSnipeOn = Boolean(tradingState?.lagSnipeEnabled ?? tradingState?.liveEngine?.lagSnipeEnabled);
  const [spotPolyLagBusy, setSpotPolyLagBusy] = useState(false);
  const spotPolyLagOn = entryStrategyUi.effective === "spot_poly_lag";
  const [spotPolyLagStatus, setSpotPolyLagStatus] = useState<{
    ob_signal?: string;
    ob_ratio?: string;
    clob_ask?: string;
    clob_spread?: string;
    clob_depth?: string;
  }>({});

  const applyLagSnipe = async (enabled: boolean) => {
    if (!isLoggedIn) {
      setLoginHint("Sign in to toggle Lag Snipe.");
      setShowPasswordLogin(true);
      return;
    }
    setLagSnipeBusy(true);
    try {
      const out = await api.setLagSnipe(enabled);
      setTradingState((prev) =>
        prev
          ? {
              ...prev,
              lagSnipeEnabled: out.lagSnipeEnabled,
              lagSnipeBanner: out.banner,
              liveEngine: prev.liveEngine
                ? { ...prev.liveEngine, lagSnipeEnabled: out.lagSnipeEnabled }
                : prev.liveEngine
            }
          : prev
      );
      setLoginHint(
        out.lagSnipeEnabled
          ? "Lag Snipe ON — BTC 5m, last ~30s entries only; auto-exit off (manual hold)."
          : "Lag Snipe OFF — normal strategies and auto-exit restored."
      );
    } catch (e) {
      setLoginHint(e instanceof Error ? e.message : String(e));
    } finally {
      setLagSnipeBusy(false);
    }
  };

  const applySpotPolyLag = async (enabled: boolean) => {
    if (!isLoggedIn) {
      setLoginHint("Sign in to toggle Spot-Poly Lag.");
      setShowPasswordLogin(true);
      return;
    }
    setSpotPolyLagBusy(true);
    try {
      const out = await api.setSpotPolyLag(enabled);
      setTradingState((prev) =>
        prev
          ? {
              ...prev,
              entryStrategy: out.entryStrategy,
              spotPolyLagEnabled: Boolean(out.spotPolyLagEnabled),
              liveEngine: prev.liveEngine
                ? { ...prev.liveEngine, spotPolyLagEnabled: Boolean(out.spotPolyLagEnabled) }
                : prev.liveEngine
            }
          : prev
      );
      setLoginHint(Boolean(out.spotPolyLagEnabled) ? "Spot-Poly Lag ON." : "Spot-Poly Lag OFF.");
    } catch (e) {
      setLoginHint(e instanceof Error ? e.message : String(e));
    } finally {
      setSpotPolyLagBusy(false);
    }
  };

  const applyRiskSettings = async (patch: {
    reset?: boolean;
    entryUsd?: number;
    minTrade?: number;
    maxTrade?: number;
    stopLossUsd?: number;
    cooldownMs?: number;
  }) => {
    setRiskModalError(null);
    setRiskModalBusy(true);
    try {
      const out = await api.setRiskSettings(patch);
      setTradingState((prev) =>
        prev ? { ...prev, riskSettings: out.riskSettings } : prev
      );
      setAmount(out.riskSettings.entryUsd);
      setAmountSource("MANUAL");
      void api.status().then(setStatus);
      setRiskModalOpen(false);
      setLoginHint(
        patch.reset
          ? "Risk settings reset to server .env defaults."
          : `Risk updated: entry $${out.riskSettings.entryUsd} · min $${out.riskSettings.minTrade} · max $${out.riskSettings.maxTrade}.`
      );
    } catch (e) {
      setRiskModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setRiskModalBusy(false);
    }
  };

  const persistRiskSettingsToEnv = async (values: {
    entryUsd: number;
    minTrade: number;
    maxTrade: number;
    stopLossUsd: number;
    cooldownMs: number;
  }) => {
    setRiskModalError(null);
    setRiskModalBusy(true);
    try {
      const out = await api.persistRiskSettingsToEnv(values);
      setTradingState((prev) =>
        prev ? { ...prev, riskSettings: out.riskSettings } : prev
      );
      setAmount(out.riskSettings.entryUsd);
      setAmountSource("MANUAL");
      void api.status().then(setStatus);
      setRiskModalOpen(false);
      setLoginHint(
        `Saved to server/.env: entry $${out.riskSettings.entryUsd} · min $${out.riskSettings.minTrade} · max $${out.riskSettings.maxTrade} · stop $${out.riskSettings.stopLossUsd} · cd ${out.riskSettings.cooldownMs}ms.`
      );
    } catch (e) {
      setRiskModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setRiskModalBusy(false);
    }
  };

  const sessionIdsBeforeStartRef = useRef<Set<string>>(new Set());
  const [runningSince, setRunningSince] = useState<Date | null>(null);

  /** Prefer MetaMask CLOB read when present; else server CLOB USDC (LIVE); else bot paper balance. */
  const capitalUsd = metaMaskPolymarketUsdc ?? wallet?.polymarketUsdc ?? status?.balance ?? 0;

  /** Header: in LIVE, prefer server CLOB USDC (same as `CLOB_FUNDER` in .env); show MetaMask if server missing. */
  const headerPolymarketUsdc = useMemo(() => {
    const srv = wallet?.polymarketUsdc;
    const mm = metaMaskPolymarketUsdc;
    if (status?.mode === "LIVE") {
      if (srv != null && Number.isFinite(srv)) {
        return { value: srv, hint: mm != null && Number.isFinite(mm) && Math.abs(srv - mm) > 0.02 ? `MetaMask read: $${mm.toFixed(2)}` : undefined };
      }
      if (mm != null) return { value: mm, hint: undefined };
      return null;
    }
    if (mm != null) return { value: mm, hint: srv != null ? `Server: $${Number(srv).toFixed(2)}` : undefined };
    if (srv != null && Number.isFinite(srv)) return { value: srv, hint: undefined };
    return null;
  }, [status?.mode, wallet?.polymarketUsdc, metaMaskPolymarketUsdc]);

  const executionEnvBadge = useMemo(() => {
    const pt = status?.paperTrading;
    const ex = status?.executeTrades;
    if (pt === undefined && ex === undefined) return null;
    if (pt === true) return { label: "PAPER", tone: "paper" as const };
    if (ex === true) return { label: "LIVE", tone: "live" as const };
    return { label: "LIVE (TESTING)", tone: "liveTesting" as const };
  }, [status?.paperTrading, status?.executeTrades]);

  const lastMetaMaskBalanceGateLogRef = useRef(0);
  const pushLog = (level: LogLevel, message: string) => {
    setLogs((prev) => [{ ts: Date.now(), level, message }, ...prev].slice(0, 120));
  };
  const pushInspectionUi = (text: string) => {
    setInspectionLogs((prev) => [{ ts: Date.now(), kind: "ui" as const, text }, ...prev].slice(0, 400));
  };

  const runConnectivityPings = async () => {
    setPingBusy(true);
    try {
      const p = await api.ping();
      setPingData(p);
      const failed = p.results.filter((r) => !r.ok).length;
      pushLog(
        "SIGNAL",
        `Connectivity ping: ${p.results.length} checks, ${failed} failed (${new Date(p.ts).toLocaleTimeString()}).`
      );
    } catch (e) {
      setPingData(null);
      pushLog("ERROR", `Ping failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPingBusy(false);
    }
  };

  /** Polymarket funder (proxy/Safe or EOA) — from server `/wallet` after login. */
  const funderDisplay = wallet?.funderAddress ?? wallet?.address ?? "—";
  const hasAuthToken = () => Boolean(localStorage.getItem("polybot_auth_token"));
  const getInjectedProvider = () => {
    const w = window as any;
    const eth = w.ethereum;
    if (!eth) return null;
    const isRealMetaMask = (p: any) =>
      Boolean(p?.isMetaMask) && (p?._metamask != null || String(p?.name ?? "").toLowerCase().includes("metamask"));

    if (Array.isArray(eth.providers) && eth.providers.length > 0) {
      const mm = eth.providers.find((p: any) => isRealMetaMask(p));
      return mm ?? null;
    }
    return isRealMetaMask(eth) ? eth : null;
  };

  const formatWalletError = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    if (!error || typeof error !== "object") return String(error);
    const e = error as any;
    const msg =
      e?.message ??
      e?.data?.message ??
      e?.error?.message ??
      e?.reason ??
      e?.error ??
      null;
    if (typeof msg === "string" && msg.trim()) return msg;
    const code = e?.code != null ? ` (code: ${String(e.code)})` : "";
    try {
      return `MetaMask error${code}: ${JSON.stringify(e)}`;
    } catch {
      return `MetaMask error${code}: ${String(error)}`;
    }
  };
  const getWalletErrorMessage = (error: unknown) => {
    const err = error as { code?: number; message?: string; data?: { message?: string } };
    if (err?.code === 4001) return "Signature was rejected in wallet.";
    if (err?.code === -32002) return "Wallet request already pending. Approve it in MetaMask.";
    const msg = (err?.data?.message ?? err?.message ?? "").toLowerCase();
    if (msg.includes("user rejected")) return "Signature was rejected in wallet.";
    if (msg.includes("unauthorized")) return "Wallet is not authorized for this app.";
    if (msg.includes("not allowed")) return "Use your allowed wallet address to continue.";
    if (msg.includes("no active wallet")) return "No active wallet found. Open MetaMask and select an account.";
    if (msg.includes("no wallet account")) return "No wallet account found. Open MetaMask and unlock/connect your account.";
    const base = err?.message ?? "Wallet login failed.";
    // When clob-client fails, `message` can be generic; include API error data for debugging.
    try {
      const extraParts: string[] = [];
      const status = (error as any)?.status;
      if (status != null) extraParts.push(`status=${String(status)}`);
      const data = (err as any)?.data;
      if (data != null) extraParts.push(`data=${JSON.stringify(data)}`);
      if (extraParts.length) return `${base} (${extraParts.join(", ")})`;
    } catch {
      // ignore formatting errors
    }
    return base;
  };

  const stats = useMemo(() => calcStats(trades), [trades]);

  useEffect(() => {
    const today = dayStartLocal();
    if (tradeLogPreset === "today") {
      const d = today.toISOString().slice(0, 10);
      setTradeLogFrom(d);
      setTradeLogTo(d);
      return;
    }
    if (tradeLogPreset === "yesterday") {
      const y = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      setTradeLogFrom(y);
      setTradeLogTo(y);
      return;
    }
    if (tradeLogPreset === "7d") {
      const from = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      setTradeLogFrom(from);
      setTradeLogTo(today.toISOString().slice(0, 10));
      return;
    }
    if (tradeLogPreset === "30d") {
      const from = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      setTradeLogFrom(from);
      setTradeLogTo(today.toISOString().slice(0, 10));
    }
  }, [tradeLogPreset]);

  useEffect(() => {
    if (snipeRoute !== "journal") return;
    setTradeLogLoading(true);
    void api
      .tradeLogQuery({
        from: tradeLogFrom,
        to: tradeLogTo,
        asset: tradeLogAsset,
        strategy: tradeLogStrategy,
        session: tradeLogSession
      })
      .then((r) => {
        setTradeLogRows(r.rows);
        setTradeLogStats(r.stats);
      })
      .catch(() => {
        setTradeLogRows([]);
        setTradeLogStats(null);
      })
      .finally(() => setTradeLogLoading(false));
  }, [snipeRoute, tradeLogFrom, tradeLogTo, tradeLogAsset, tradeLogStrategy, tradeLogSession, trades.length]);
  const suggestion = useMemo(() => {
    const conf = prediction?.confidence ?? 0;
    const pred = prediction?.prediction ?? "UP";
    const primarySym = tradingState?.updownAssetsConfigured?.[0] ?? "BTC";
    if (prediction?.recommendation === "NO_TRADE") {
      return `No trade now: ${prediction.reason ?? "risk filter active"}.`;
    }

    if (chartData.length < 3) {
      return `Waiting for live ${primarySym} data to generate investment suggestion.`;
    }

    const recent = chartData.slice(-6);
    const firstPx = recent[0]?.btcUsd;
    const lastPx = recent[recent.length - 1]?.btcUsd;
    const delta =
      firstPx != null && lastPx != null ? lastPx - firstPx : (recent[0]?.up ?? 50) - (recent[recent.length - 1]?.up ?? 50);

    if (conf >= 98) {
      return pred === "UP"
        ? `High accuracy (${conf.toFixed(0)}%): invest on UP.`
        : `High accuracy (${conf.toFixed(0)}%): invest on DOWN.`;
    }

    if (firstPx != null && lastPx != null) {
      if (delta <= -12) {
        return `${primarySym} moved down ($${delta.toFixed(2)} over recent ticks). Suggestion: invest on DOWN.`;
      }
      if (delta >= 12) {
        return `${primarySym} moved up (+$${delta.toFixed(2)} over recent ticks). Suggestion: invest on UP.`;
      }
    } else if (delta <= -1.2) {
      return `Market is dropping (${delta.toFixed(2)}). Suggestion: invest on DOWN.`;
    } else if (delta >= 1.2) {
      return `Market is rising (+${delta.toFixed(2)}). Suggestion: invest on UP.`;
    }

    if (conf >= 95) {
      return `Strong signal (${conf.toFixed(0)}%): follow prediction and invest on ${pred}.`;
    }

    return `Moderate signal (${conf.toFixed(0)}%): use small amount or wait for a clearer move.`;
  }, [prediction, chartData, tradingState?.updownAssetsConfigured]);

  const chartAssetsList = useMemo(() => {
    const cfg = tradingState?.updownAssetsConfigured;
    if (cfg && cfg.length > 0) return cfg;
    const keys = Object.keys(assetCharts).filter((k) => (assetCharts[k]?.length ?? 0) > 0);
    return keys.sort();
  }, [tradingState?.updownAssetsConfigured, assetCharts]);

  const chartPrimaryAsset = tradingState?.updownAssetsConfigured?.[0] ?? chartAssetsList[0] ?? "BTC";
  const selectedMarketLabel = useMemo(
    () => markets.find((m) => m.tokenID === selectedTokenID)?.label ?? "BTC 5s Market",
    [markets, selectedTokenID]
  );
  const portfolioData = useMemo(() => {
    if (!status) return [];
    const ordered = [...trades].reverse();
    const realizedPnl = ordered.reduce((sum, t) => sum + (tradeRowOpenForUi(t) ? 0 : t.pnl), 0);
    let balance = Number(status.balance ?? 0) - realizedPnl;
    const now = Date.now();
    return ordered.map((t, idx) => {
      if (!tradeRowOpenForUi(t)) balance += t.pnl;
      return {
        idx,
        time: t.time,
        ts: now - (ordered.length - 1 - idx) * 60_000,
        balance: Number(balance.toFixed(2)),
        amount: t.amount,
        direction: t.direction,
        status: t.status
      };
    });
  }, [trades, status]);
  const filteredPortfolioData = useMemo(() => {
    if (portfolioData.length === 0) return [];
    const latest = portfolioData[portfolioData.length - 1]?.ts ?? Date.now();
    const windows: Record<PortfolioRange, number> = {
      "1m": 60_000,
      "1h": 60 * 60_000,
      day: 24 * 60 * 60_000,
      month: 30 * 24 * 60 * 60_000,
      year: 365 * 24 * 60 * 60_000
    };
    const cutoff = latest - windows[portfolioRange];
    return portfolioData.filter((p) => p.ts >= cutoff);
  }, [portfolioData, portfolioRange]);
  const formatPortfolioTick = (ts: number) => {
    const d = new Date(ts);
    if (portfolioRange === "1m" || portfolioRange === "1h") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (portfolioRange === "day") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (portfolioRange === "month") return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return d.toLocaleDateString([], { year: "2-digit", month: "short" });
  };

  useEffect(() => {
    const loadInitial = async () => {
      const errors: string[] = [];
      const run = async <T,>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
        try {
          return await p;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${label}: ${msg}`);
          return fallback;
        }
      };

      const s = await run("status", api.status(), null as BotStatus | null);
      const t = await run("trades", api.trades(), [] as Trade[]);
      const w = await run("wallet", api.wallet(), null as WalletSummary | null);
      const m = await run("markets", api.markets(), [] as MarketOption[]);
      const i = await run("insights", api.insights(), null as Insights | null);

      if (s) setStatus(s);
      setTrades(Array.isArray(t) ? t : []);
      if (w) setWallet(w);
      setMarkets(Array.isArray(m) ? m : []);
      setSelectedTokenID(Array.isArray(m) && m[0]?.tokenID ? m[0].tokenID : "");
      if (i) setInsights(i);

      if (errors.length > 0) {
        setLoginHint(
          `Some API calls failed (${errors.length}). Is the server running on :4000? ${errors[0]?.slice(0, 120) ?? ""}`
        );
        console.error("[PolyBot] loadInitial", errors);
      }

      try {
        const me = await api.authMe();
        if (me.authenticated) {
          if (me.authType === "wallet" && me.address) setWalletAddress(me.address);
          if (me.authType === "password" && me.userId) setWalletAddress(`user:${me.userId}`);
          setIsLoggedIn(true);
          if (errors.length === 0) setLoginHint("Logged in and ready to invest.");
        } else {
          localStorage.removeItem("polybot_auth_token");
          setIsLoggedIn(false);
          setLoginHint("Session mismatch. Sign in again (User ID / Password or wallet).");
        }
      } catch {
        localStorage.removeItem("polybot_auth_token");
        setIsLoggedIn(false);
        if (errors.length === 0) setLoginHint("Login required before investing.");
      }
    };
    void loadInitial();
  }, []);

  useEffect(() => {
    api
      .betLogs()
      .then(setBetLogs)
      .catch(() => setBetLogs([]));
  }, []);

  useEffect(() => {
    const tick = () =>
      api
        .tradingState()
        .then((ts) => {
          setTradingState(ts);
          if (!didBootstrapAmountFromServerRef.current && amountSource === "MANUAL") {
            const se = ts.riskSettings?.entryUsd;
            if (se != null && Number.isFinite(se) && se > 0) {
              didBootstrapAmountFromServerRef.current = true;
              setAmount(se);
            }
          }
          if (ts.liveEngine) {
            const le = ts.liveEngine;
            setStatus((prev) => {
              if (!prev) return prev;
              if (
                prev.running === le.running &&
                prev.autoTrading === le.autoTrading &&
                prev.phase === le.phase &&
                prev.phaseReason === le.phaseReason
              ) {
                return prev;
              }
              return {
                ...prev,
                running: le.running,
                autoTrading: le.autoTrading,
                phase: le.phase,
                phaseReason: le.phaseReason
              };
            });
          }
          if (ts.predictionLive) {
            const pl = ts.predictionLive;
            setPrediction((prev) => {
              if (prev && pl.ts < prev.ts) return prev;
              return {
                prediction: pl.prediction,
                confidence: pl.confidence,
                ts: pl.ts,
                recommendation: pl.recommendation,
                reason: pl.reason
              };
            });
          }
          if (ts.executionMode === "LIVE") {
            void api.wallet().then(setWallet).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    tick();
    const id = setInterval(tick, 4000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (insightsDebounceRef.current) {
        clearTimeout(insightsDebounceRef.current);
        insightsDebounceRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "market") {
        const p = msg.payload;
        if (Array.isArray(p)) {
          setChartData(p);
          setAssetCharts({});
        } else if (p && typeof p === "object") {
          const pack = p as { primary?: MarketPoint[]; byAsset?: Record<string, MarketPoint[]> };
          setChartData(Array.isArray(pack.primary) ? pack.primary : []);
          setAssetCharts(pack.byAsset && typeof pack.byAsset === "object" ? pack.byAsset : {});
        }
      }
      if (msg.type === "prediction") setPrediction(msg.payload);
      if (msg.type === "trade") {
        setTrades(msg.payload);
        if (insightsDebounceRef.current) clearTimeout(insightsDebounceRef.current);
        insightsDebounceRef.current = setTimeout(() => {
          insightsDebounceRef.current = null;
          void api.insights().then(setInsights).catch(() => undefined);
        }, 250);
      }
      if (msg.type === "status") {
        setStatus(msg.payload);
        if (msg.payload?.mode === "LIVE") {
          api.wallet().then(setWallet).catch(() => undefined);
        }
      }
      if (msg.type === "log") {
        setLogs((prev) => [msg.payload, ...prev].slice(0, 120));
        const text = String(msg?.payload?.message ?? "");
        if (text.includes("[SPL] OB:")) {
          const ratio = text.match(/ratio=([0-9.]+)/)?.[1];
          const signal = text.includes("BULLISH") ? "BULLISH" : text.includes("BEARISH") ? "BEARISH" : "NEUTRAL";
          setSpotPolyLagStatus((prev) => ({ ...prev, ob_signal: signal, ob_ratio: ratio ?? prev.ob_ratio ?? "—" }));
        }
        if (text.includes("[SPL] CLOB:")) {
          const ask = text.match(/ask=([0-9.]+)/)?.[1];
          const spread = text.match(/spread=([0-9.]+%)/)?.[1];
          const depth = text.match(/depth=([0-9.]+)/)?.[1];
          setSpotPolyLagStatus((prev) => ({
            ...prev,
            clob_ask: ask ?? prev.clob_ask ?? "—",
            clob_spread: spread ?? prev.clob_spread ?? "—",
            clob_depth: depth ?? prev.clob_depth ?? "—"
          }));
        }
      }
      if (msg.type === "betLogs") setBetLogs(Array.isArray(msg.payload) ? msg.payload : []);
      if (msg.type === "betLog") {
        const row = msg.payload as BetLogEntry;
        setBetLogs((prev) => [row, ...prev].slice(0, 80));
      }
      if (msg.type === "inspection") {
        const p = msg.payload as { ts: number; method: string; path: string; status: number; ms: number };
        const line = `${p.method} ${p.path} → HTTP ${p.status} (${p.ms}ms)`;
        setInspectionLogs((prev) => [{ ts: p.ts, kind: "api" as const, text: line }, ...prev].slice(0, 400));
      }
    };
    return () => ws.close();
  }, []);

  const MIN_TRADE_USD = 1;

  /** MetaMask CLOB: size from the server's PENDING trade (risk-sized), capped by wallet available USDC. */
  const placeBetMetaMask = async (pending: Trade) => {
    const direction = pending.direction;
    const tradeId = pending.id;
    pushInspectionUi(`UI: Auto post MetaMask order (${direction}) trade=${tradeId.slice(0, 8)}…`);
    if (!isLoggedIn) {
      pushLog("ERROR", "Log in first (wallet or password).");
      return;
    }
    const ethereum = getInjectedProvider();
    if (!ethereum) {
      pushLog("ERROR", "Install MetaMask to sign orders.");
      return;
    }
    setMetaMaskOrderBusy(true);
    try {
      const cfg = await api.polymarketClobSigningConfig();
      const tokenID = direction === "UP" ? cfg.tokenIdUp : cfg.tokenIdDown;
      const book = await api.polymarketClobBook(tokenID);
      const price = Number(book.mid.toFixed(4));

      const budget = await getAvailableCollateralBudgetFromMetaMask(cfg as ClobSigningConfig);
      setMetaMaskPolymarketUsdc(budget.balanceUsdc);
      const minUsd =
        tradingState?.riskSettings?.minTrade != null &&
        Number.isFinite(tradingState.riskSettings.minTrade) &&
        tradingState.riskSettings.minTrade > 0
          ? tradingState.riskSettings.minTrade
          : MIN_TRADE_USD;
      const serverUsd =
        Number.isFinite(pending.amount) && pending.amount > 0 ? pending.amount : amount;
      let effAmount = Math.min(serverUsd, budget.availableUsdc * 0.998);
      effAmount = Math.max(0, Number(effAmount.toFixed(2)));
      pushInspectionUi(
        `UI: MetaMask collateral — balance $${budget.balanceUsdc.toFixed(2)} | reserved $${budget.reservedUsdc.toFixed(2)} | available $${budget.availableUsdc.toFixed(2)} → size $${effAmount} (server trade $${serverUsd.toFixed(2)})`
      );
      if (effAmount < minUsd) {
        pushLog(
          "ERROR",
          `MetaMask: available USDC after open orders ($${budget.availableUsdc.toFixed(2)}) below min $${minUsd}`
        );
        return;
      }

      pushInspectionUi(
        `UI: MetaMask BUY ${direction} @ ~$${price} (size $${effAmount}) — confirm in wallet`
      );
      pushLog("SIGNAL", `MetaMask: ${direction} BUY ~${price} size $${effAmount} (confirm prompts in wallet)…`);

      const clobCfg = cfg as ClobSigningConfig;

      const runMmAutoMarketExit = async (
        reason: string,
        ctx: {
          tradeId: string;
          tokenID: string;
          entryCostUsd: number;
          shares: number;
          clob: ClobSigningConfig;
        }
      ) => {
        const pollCfg = readMmAutoExitEnv();
        const ts = new Date().toLocaleTimeString("en-US", { hour12: true });
        pushLog(
          "TRADE",
          `[${ts}] AUTO-EXIT ${reason}: MetaMask market SELL ${ctx.tokenID.slice(0, 14)}… x${ctx.shares}`
        );
        pushInspectionUi(`UI: AUTO-EXIT ${reason} — MetaMask market SELL (${ctx.shares} shares)`);
        try {
          const sellRes = await placeClobMarketSellFromMetaMask(ctx.tokenID, ctx.shares, ctx.clob);
          const exitOid =
            (sellRes as { orderID?: string; orderId?: string })?.orderID ??
            (sellRes as { orderId?: string }).orderId;
          if (!exitOid) throw new Error("No exit order id in CLOB response");
          const filledExit = await pollOrderUntilFilledMetaMask(String(exitOid), ctx.clob, {
            maxMs: 60_000,
            intervalMs: pollCfg.exitOrderPollMs,
            minMatchedRatio: 0.92
          });
          if (!filledExit) throw new Error("Exit fill timeout");
          const snap = await fetchOrderMatchedSharesMetaMask(String(exitOid), ctx.clob);
          pushLog(
            "TRADE",
            `[${ts}] EXIT COMPLETE: SELL matched ${snap.matched}/${snap.original} | reason=${reason}`
          );
          const out = await api.confirmTradeFill(ctx.tradeId);
          if (!out.ok) pushLog("ERROR", out.reason ?? "confirm-fill failed");
          else {
            pushLog("TRADE", `Order filled — trade ${ctx.tradeId.slice(0, 8)}… settled after auto-exit`);
            setLoginHint("Auto-exit complete; trade settled in the dashboard.");
          }
        } catch (e) {
          const msg = formatWalletError(e);
          pushLog("ERROR", `AUTO-EXIT FAILED: ${msg}`);
          await cancelClobMarketOrdersForAssetMetaMask(ctx.tokenID, ctx.clob);
          pushLog("ERROR", "EMERGENCY: cancelMarketOrders (entry token) best-effort");
          pushLog(
            "ERROR",
            "Trade left PENDING: Polymarket may still show an open position — complete a manual SELL there or retry"
          );
        }
      };

      const runMmPositionMonitor = async (
        ctx: {
          tradeId: string;
          tokenID: string;
          entryCostUsd: number;
          shares: number;
          clob: ClobSigningConfig;
        },
        signal: AbortSignal
      ) => {
        const ec = readMmAutoExitEnv();
        const start = Date.now();
        let lastLog = 0;
        const profitMarkUsd = ctx.entryCostUsd * ec.profitMult;

        while (Date.now() - start < ec.maxMonitorMs) {
          if (signal.aborted) {
            pushLog("SIGNAL", "MM auto-exit monitor aborted (bot stopped or new session)");
            return;
          }
          await new Promise((r) => setTimeout(r, ec.monitorPollMs));
          const heldMs = Date.now() - start;
          let markValue = 0;
          let pnlPct = 0;
          try {
            const b = await api.polymarketClobBook(ctx.tokenID);
            markValue = b.bestBid * ctx.shares;
            pnlPct =
              ctx.entryCostUsd > 0 ? ((markValue - ctx.entryCostUsd) / ctx.entryCostUsd) * 100 : 0;
          } catch {
            /* skip tick */
          }
          const tick = Date.now();
          if (tick - lastLog >= 2000) {
            lastLog = tick;
            const ts = new Date().toLocaleTimeString("en-US", { hour12: true });
            pushLog(
              "TRADE",
              `[${ts}] MONITOR: mark~$${markValue.toFixed(4)} (${pnlPct.toFixed(1)}% vs cost $${ctx.entryCostUsd.toFixed(
                2
              )}) | held ${(heldMs / 1000).toFixed(1)}s`
            );
          }
          if (markValue >= profitMarkUsd) {
            await runMmAutoMarketExit("PROFIT_TARGET", ctx);
            return;
          }
          if (heldMs >= ec.timeMs) {
            await runMmAutoMarketExit("TIME_STOP", ctx);
            return;
          }
        }
        await runMmAutoMarketExit("MONITOR_MAX", ctx);
      };

      const postAndReconcile = async (collateralUsd: number) => {
        const result = await placeClobOrderFromMetaMask(direction, collateralUsd, price, clobCfg);
        const oid =
          (result as { orderID?: string; orderId?: string })?.orderID ??
          (result as { orderId?: string }).orderId;
        if (!oid) {
          pushLog("TRADE", `CLOB response: ${JSON.stringify(result).slice(0, 200)}`);
          return;
        }
        pushLog("TRADE", `CLOB order submitted: ${oid}`);
        await api.attachClobOrder(tradeId, String(oid));
        pushInspectionUi("UI: Polling CLOB for fill…");
        const filled = await pollOrderUntilFilledMetaMask(String(oid), clobCfg);
        if (filled) {
          const snap = await fetchOrderMatchedSharesMetaMask(String(oid), clobCfg);
          const matchedShares = snap.matched > 0 ? snap.matched : snap.original;
          const entryTs = new Date().toLocaleTimeString("en-US", { hour12: true });
          pushLog(
            "TRADE",
            `[${entryTs}] ENTRY: ${tokenID} x${Number(matchedShares).toFixed(4)} @ ~$${price} | collateral $${collateralUsd.toFixed(2)}`
          );

          const exitEnv = readMmAutoExitEnv();
          const exitCtx = {
            tradeId,
            tokenID,
            entryCostUsd: collateralUsd,
            shares: matchedShares,
            clob: clobCfg
          };
          if (matchedShares > 0) {
            if (exitEnv.monitorBeforeClose) {
              const ac = new AbortController();
              mmAutoExitAbortRef.current?.abort();
              mmAutoExitAbortRef.current = ac;
              try {
                await runMmPositionMonitor(exitCtx, ac.signal);
              } finally {
                if (mmAutoExitAbortRef.current === ac) mmAutoExitAbortRef.current = null;
              }
            } else {
              await runMmAutoMarketExit("IMMEDIATE_AFTER_FILL", exitCtx);
            }
          } else {
            const out = await api.confirmTradeFill(tradeId);
            if (out.ok) {
              pushLog("TRADE", `Order ${oid} filled — trade ${tradeId.slice(0, 8)}… settled`);
              setLoginHint("Order filled and settled in the dashboard.");
            } else {
              pushLog("ERROR", out.reason ?? "confirm-fill failed");
            }
          }
        } else {
          pushLog("ERROR", `Fill not confirmed within timeout (order ${oid}). Check Polymarket — you may cancel manually.`);
        }
      };

      try {
        await postAndReconcile(effAmount);
      } catch (orderErr) {
        const msg = formatWalletError(orderErr);
        if (msg.toLowerCase().includes("allowance") || msg.toLowerCase().includes("balance")) {
          pushInspectionUi("UI: Order rejected (balance/allowance). Re-approving USDC spending cap then retry once…");
          pushLog("SIGNAL", "Re-approving USDC spending cap after balance/allowance failure");
          const before = await getBalanceAllowanceFromMetaMask(cfg as ClobSigningConfig).catch(() => null);
          if (before) {
            pushInspectionUi(
              `UI: Before approve — balance=$${before.balanceUsdc.toFixed(2)} allowance=$${before.allowanceUsdc.toFixed(2)}`
            );
          }
          await approveCollateralAllowanceFromMetaMask(cfg as ClobSigningConfig);
          await new Promise((r) => setTimeout(r, 1500));
          const after = await getBalanceAllowanceFromMetaMask(cfg as ClobSigningConfig).catch(() => null);
          if (after) {
            setMetaMaskPolymarketUsdc(after.balanceUsdc);
            pushInspectionUi(
              `UI: After approve — balance=$${after.balanceUsdc.toFixed(2)} allowance=$${after.allowanceUsdc.toFixed(2)}`
            );
          }
          const budget2 = await getAvailableCollateralBudgetFromMetaMask(cfg as ClobSigningConfig);
          let eff2 = Math.min(serverUsd, budget2.availableUsdc * 0.998);
          eff2 = Math.max(0, Number(eff2.toFixed(2)));
          if (eff2 < minUsd) throw new Error("Available USDC still below min after re-approve");
          await postAndReconcile(eff2);
        } else {
          throw orderErr;
        }
      }
    } catch (e) {
      const errAny = e as any;
      if (errAny?.code === 4001) {
        pushInspectionUi("UI: MetaMask signature rejected (4001). Auto-trading paused.");
        setMetaMaskAutoEnabled(false);
        // Keep the last trade id so we don't retry the same pending order
        // during the pause/race between state updates.
        setLoginHint("Auto-trading paused: please re-enable to continue.");
        pushLog("ERROR", "MetaMask signature rejected (4001). Pausing auto-trading.");
        return;
      }
      const msg = formatWalletError(e);
      pushInspectionUi(`UI: MetaMask order failed: ${msg}`);
      pushLog("ERROR", msg);
    } finally {
      setMetaMaskOrderBusy(false);
    }
  };

  const connectMetaMaskTrading = async (): Promise<boolean> => {
    pushInspectionUi("UI: Click Connect MetaMask");
    const ethereum = getInjectedProvider();
    if (!ethereum) {
      pushInspectionUi("UI: MetaMask not detected (check extensions).");
      pushLog("ERROR", "MetaMask not found. Disable Trust Wallet extension or install MetaMask.");
      return false;
    }
    try {
      // Helpful pre-check: if MetaMask has no accounts/unlocked wallet yet, it will be empty.
      pushInspectionUi("UI: Reading existing MetaMask accounts…");
      const existing = (await ethereum.request({ method: "eth_accounts" })) as string[];
      pushInspectionUi(`UI: MetaMask eth_accounts returned ${existing?.length ?? 0} accounts.`);
      if (!existing || existing.length === 0) {
        pushInspectionUi("UI: MetaMask has no accounts returned (unlock/create/import an account).");
      }
      pushInspectionUi("UI: Requesting MetaMask accounts…");
      const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
      const addr = accounts?.[0];
      if (!addr) throw new Error("No MetaMask account selected.");
      setMetaMaskConnected(true);
      setMetaMaskAddress(addr);
      pushInspectionUi(`UI: Connected signer wallet: ${addr}`);
      pushLog("SIGNAL", `MetaMask connected: ${addr}`);
      setLoginHint("MetaMask connected. Click Start Bot for auto trades.");
      if (isLoggedIn) {
        setMetaMaskUsdcLoading(true);
        try {
          const cfg = await api.polymarketClobSigningConfig();
          pushInspectionUi(
            (() => {
              const sigMode =
                cfg.signatureType === 2 ? "GNOSIS_SAFE (2)" : cfg.signatureType === 1 ? "POLY_PROXY (1)" : "EOA (0)";
              return `UI: Polymarket funder wallet: ${cfg.funderAddress}\nUI: Signature mode: ${sigMode}`;
            })()
          );
          pushInspectionUi("UI: [MM 3/4] Auto-approving USDC spending cap on Polymarket CLOB…");
          await approveCollateralAllowanceFromMetaMask(cfg as ClobSigningConfig);
          pushInspectionUi("UI: USDC spending cap approved.");
          const ba = await getBalanceAllowanceFromMetaMask(cfg as ClobSigningConfig);
          setMetaMaskPolymarketUsdc(ba.balanceUsdc);
          pushInspectionUi(
            `UI: [MM 4/4] MetaMask CLOB collateral — USDC $${ba.balanceUsdc.toFixed(2)} | allowance $${ba.allowanceUsdc.toFixed(2)} | balanceRaw=${ba.balanceRaw} allowanceRaw=${ba.allowanceRaw}`
          );
        } catch (e) {
          setMetaMaskPolymarketUsdc(null);
          const msg = formatWalletError(e);
          pushInspectionUi(`UI: MetaMask USDC fetch failed: ${msg}`);
          pushLog("ERROR", msg);
        } finally {
          setMetaMaskUsdcLoading(false);
        }
      }
      return true;
    } catch (e) {
      const msg = formatWalletError(e);
      if (msg.toLowerCase().includes("no active wallet found")) {
        pushInspectionUi("UI: MetaMask says 'No active wallet found' — create/import an account and unlock MetaMask.");
      }
      // Try a couple recovery steps:
      // 1) wallet_requestPermissions (may trigger unlock/account selection)
      // 2) eth_accounts (if it returns addresses, we can proceed)
      try {
        try {
          await ethereum.request({
            method: "wallet_requestPermissions",
            params: [{ eth_accounts: {} }]
          } as any);
        } catch {
          // ignore if not supported
        }
        const existing = (await ethereum.request({ method: "eth_accounts" })) as string[];
        const addr = existing?.[0];
        if (addr) {
          setMetaMaskConnected(true);
          setMetaMaskAddress(addr);
          pushInspectionUi(`UI: MetaMask connected (recovered via eth_accounts): ${addr}`);
          pushLog("SIGNAL", `MetaMask connected (recovered): ${addr}`);
          setLoginHint("MetaMask connected. Click Start Bot for auto trades.");
          return true;
        }
      } catch {
        // ignore secondary failure
      }

      pushInspectionUi(`UI: MetaMask connect failed: ${msg}`);
      pushLog("ERROR", msg);
      setMetaMaskConnected(false);
      return false;
    }
  };

  useEffect(() => {
    if (!isLoggedIn || !metaMaskConnected) return;
    if (metaMaskPolymarketUsdc != null) return; // already loaded
    setMetaMaskUsdcLoading(true);
    void (async () => {
      try {
        const cfg = await api.polymarketClobSigningConfig();
        const usdc = await getCollateralUsdcFromMetaMask(cfg as ClobSigningConfig);
        setMetaMaskPolymarketUsdc(usdc);
        pushInspectionUi(`UI: MetaMask CLOB collateral USDC: $${usdc.toFixed(2)}`);
      } catch (e) {
        setMetaMaskPolymarketUsdc(null);
        const msg = formatWalletError(e);
        pushInspectionUi(`UI: MetaMask USDC fetch failed: ${msg}`);
      } finally {
        setMetaMaskUsdcLoading(false);
      }
    })();
  }, [isLoggedIn, metaMaskConnected, status?.mode]);

  useEffect(() => {
    if (amountSource !== "PERCENT") return;
    if (!Number.isFinite(capitalUsd) || capitalUsd <= 0) return;
    const computed = Number(((capitalUsd * capitalPctPerEntry) / 100).toFixed(2));
    if (computed > 0 && computed !== amount) setAmount(computed);
  }, [amountSource, capitalUsd, capitalPctPerEntry, amount]);

  const startBot = async () => {
    pushInspectionUi("Button: Start Bot → will POST /api/start");
    try {
      const liveMode = (status?.mode ?? "SIMULATION") === "LIVE";
      if (!isLoggedIn) {
        const ok = await passwordLogin();
        if (!ok) {
          setLoginHint("Login failed. Enter valid User ID and Password.");
          return;
        }
      }
      if (metaMaskAutoEnabled && !metaMaskConnected) {
        const ok = await connectMetaMaskTrading();
        if (!ok) return;
      }
      // If MetaMask is responsible for posting real orders, tell the backend to
      // generate pending trades but not place LIVE orders itself.
      // In Demo/SIMULATION, never use external execution; trades must auto-resolve.
      await api.setExternalExecution(Boolean(metaMaskAutoEnabled && liveMode));
      await api.start();
      sessionIdsBeforeStartRef.current = new Set(trades.map((t) => t.id));
      setRunningSince(new Date());
      const [s, ts] = await Promise.all([api.status(), api.tradingState()]);
      setStatus(s);
      setTradingState(ts);
      const se = ts.riskSettings?.entryUsd;
      if (se != null && Number.isFinite(se) && se > 0 && amountSource === "MANUAL") {
        setAmount(se);
      }
      // Retry once on Start Bot when balance read is missing or appears stuck at 0.
      if (
        metaMaskAutoEnabled &&
        metaMaskConnected &&
        (metaMaskPolymarketUsdc === null || metaMaskPolymarketUsdc === 0) &&
        !metaMaskUsdcLoading
      ) {
        setMetaMaskUsdcLoading(true);
        try {
          const cfg = await api.polymarketClobSigningConfig();
          const ba = await getBalanceAllowanceFromMetaMask(cfg as ClobSigningConfig);
          setMetaMaskPolymarketUsdc(ba.balanceUsdc);
          pushInspectionUi(
            `UI: MetaMask CLOB collateral USDC (post-start): $${ba.balanceUsdc.toFixed(
              2
            )} | allowance: $${ba.allowanceUsdc.toFixed(2)} | funder=${(cfg as ClobSigningConfig).funderAddress} | signer=${(cfg as ClobSigningConfig).signerAddress ?? "—"}`
          );
        } catch (e) {
          setMetaMaskPolymarketUsdc(null);
          const msg = formatWalletError(e);
          pushInspectionUi(`UI: MetaMask USDC fetch after Start Bot failed: ${msg}`);
          pushLog("ERROR", msg);
        } finally {
          setMetaMaskUsdcLoading(false);
        }
      }
      pushLog("TRADE", "Bot started: auto-trading active.");
      setLoginHint("Bot is running. Auto-invest uses the entry strategy shown under Execution & size.");
    } catch (error) {
      pushLog("ERROR", error instanceof Error ? error.message : "Failed to start bot.");
    }
  };

  // Trigger MetaMask order only when the server engine accepted a trade (new PENDING trade id).
  // This prevents repeated signatures on prediction updates that are later blocked by risk/exec gates.
  useEffect(() => {
    if (!status?.running || !metaMaskAutoEnabled || !metaMaskConnected || metaMaskOrderBusy) return;
    // In Demo/SIMULATION, do not place real orders via MetaMask.
    if (status?.mode !== "LIVE") return;
    if (metaMaskUsdcLoading) return;
    // Avoid using server paper balance when MetaMask balance could not be fetched.
    // This prevents sending orders with collateral sizes that will be rejected.
    if (metaMaskPolymarketUsdc == null) {
      const now = Date.now();
      if (now - lastMetaMaskBalanceGateLogRef.current > 20_000) {
        lastMetaMaskBalanceGateLogRef.current = now;
        pushInspectionUi("UI: MetaMask PM USDC not loaded yet — pause auto-trading.");
      }
      return;
    }
    if (metaMaskPolymarketUsdc <= 0) {
      const now = Date.now();
      if (now - lastMetaMaskBalanceGateLogRef.current > 20_000) {
        lastMetaMaskBalanceGateLogRef.current = now;
        pushInspectionUi("UI: MetaMask PM USDC is 0 — pause auto-trading / deposit USDC.");
      }
      return;
    }
    const pending = trades.find((t) => tradeRowOpenForUi(t));
    if (!pending) return;
    if (pending.id && pending.id === lastMetaMaskTradeIdRef.current) return;
    lastMetaMaskTradeIdRef.current = pending.id ?? null;
    void placeBetMetaMask(pending);
  }, [
    trades,
    status?.running,
    status?.mode,
    metaMaskAutoEnabled,
    metaMaskConnected,
    metaMaskOrderBusy,
    metaMaskUsdcLoading
  ]);

  const stopBot = async () => {
    pushInspectionUi("Button: Stop Bot → POST /api/stop");
    mmAutoExitAbortRef.current?.abort();
    mmAutoExitAbortRef.current = null;
    try {
      await api.stop();
      const s = await api.status();
      setStatus(s);
      pushLog("SIGNAL", "Bot stopped.");
      setLoginHint("Bot stopped. Start bot to resume automatic investing.");
    } catch (error) {
      pushLog("ERROR", error instanceof Error ? error.message : "Failed to stop bot.");
    }
  };

  const onSelectMarket = async (tokenID: string) => {
    setSelectedTokenID(tokenID);
    pushInspectionUi(`Dropdown: market select → POST /api/market/select (${tokenID.slice(0, 12)}…)`);
    try {
      await api.selectMarket(tokenID);
      pushLog("SIGNAL", `Market switched to ${tokenID}`);
    } catch (error) {
      pushLog("ERROR", error instanceof Error ? error.message : "Market switch failed.");
    }
  };

  const connectAndLogin = async (): Promise<boolean> => {
    setIsAuthenticating(true);
    try {
      pushInspectionUi("UI: [Wallet auth 1/6] Starting MetaMask login (address must be allowed on server ALLOWED_WALLET)…");
      const ethereum = getInjectedProvider();
      if (!ethereum) {
        pushInspectionUi("UI: [Wallet auth] FAILED — no MetaMask/injected wallet.");
        pushLog("ERROR", "No wallet extension found. Install MetaMask.");
        setLoginHint("Install MetaMask to continue.");
        setShowWalletHelp(true);
        window.open("https://metamask.io/download/", "_blank", "noopener,noreferrer");
        setIsAuthenticating(false);
        return false;
      }
      // Fast path: if session token is valid and wallet is already connected, avoid signing again.
      const existingAccounts: string[] = await ethereum.request({ method: "eth_accounts" });
      const existingAddress = existingAccounts?.[0];
      if (existingAddress && hasAuthToken()) {
        const me = await api.authMe().catch(() => ({ authenticated: false } as const));
        if (me.authenticated && me.address && me.address.toLowerCase() === existingAddress.toLowerCase()) {
          pushInspectionUi(`UI: [Wallet auth 2/6] Session already valid — address ${existingAddress}`);
          setWalletAddress(existingAddress);
          setIsLoggedIn(true);
          setLoginHint("Logged in and ready to invest.");
          void fetchPolymarketAccount("After session restore → Polymarket CLOB summary");
          return true;
        }
      }

      pushInspectionUi("UI: [Wallet auth 2/6] Requesting MetaMask account…");
      const accounts: string[] = await ethereum.request({ method: "eth_requestAccounts" });
      const address = accounts?.[0] ?? existingAddress;
      if (!address) throw new Error("No wallet account found.");
      pushInspectionUi(`UI: [Wallet auth 3/6] Selected address ${address}`);
      pushInspectionUi("UI: [Wallet auth 4/6] GET /auth/nonce → sign message in MetaMask…");
      const { message } = await api.authNonce(address);
      const signature: string = await ethereum.request({
        method: "personal_sign",
        params: [message, address]
      });
      pushInspectionUi("UI: [Wallet auth 5/6] POST /auth/verify …");
      const verified = await api.authVerify(address, signature);
      localStorage.setItem("polybot_auth_token", verified.token);
      setWalletAddress(verified.address);
      setIsLoggedIn(true);
      setLoginHint("Login successful. Next step: click Start Bot.");
      pushInspectionUi(`UI: [Wallet auth 6/6] Login OK — authenticated wallet ${verified.address}`);
      pushLog("SIGNAL", `Authenticated as ${verified.address}`);
      void fetchPolymarketAccount("After MetaMask auth → Polymarket CLOB summary");
      return true;
    } catch (error) {
      const msg = getWalletErrorMessage(error);
      pushLog("ERROR", msg);
      setLoginHint(msg);
      if (msg.toLowerCase().includes("no active wallet") || msg.toLowerCase().includes("no wallet account")) {
        setShowWalletHelp(true);
      }
      setIsLoggedIn(false);
      localStorage.removeItem("polybot_auth_token");
      return false;
    } finally {
      setIsAuthenticating(false);
    }
  };

  /** Dashboard auth only (e.g. Start Bot when not logged in). Does not hit Polymarket. */
  const passwordLogin = async (): Promise<boolean> => {
    setIsAuthenticating(true);
    try {
      pushInspectionUi("UI: [Pwd 1/3] Checking fields — user ID and password must be non-empty (password not logged).");
      if (!userIdInput.trim() || !passwordInput.trim()) {
        pushInspectionUi("UI: [Pwd 1/3] FAILED — enter APP_USER_ID and APP_PASSWORD from server/.env.");
        setShowPasswordLogin(true);
        setLoginHint("Enter User ID and Password.");
        return false;
      }
      pushInspectionUi(
        `UI: [Pwd 2/3] POST /auth/password-login — userId="${userIdInput.trim()}" (dashboard account, not Polymarket email).`
      );
      const out = await api.passwordLogin(userIdInput.trim(), passwordInput.trim());
      localStorage.setItem("polybot_auth_token", out.token);
      setWalletAddress(`user:${out.userId}`);
      setIsLoggedIn(true);
      setShowPasswordLogin(false);
      setLoginHint("Login successful. Next step: click Start Bot.");
      pushInspectionUi(`UI: [Pwd 3/3] Login OK — dashboard userId="${out.userId}"`);
      pushLog("SIGNAL", `Dashboard authenticated — userId=${out.userId}`);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Invalid user ID or password";
      pushLog("ERROR", msg);
      setLoginHint(msg);
      setIsLoggedIn(false);
      localStorage.removeItem("polybot_auth_token");
      setShowPasswordLogin(true);
      return false;
    } finally {
      setIsAuthenticating(false);
    }
  };

  /** After session exists: load Polymarket CLOB summary (same wallet as server .env). */
  const fetchPolymarketAccount = async (inspectionLabel: string) => {
    pushInspectionUi(`${inspectionLabel}`);
    setIsPolyConnecting(true);
    try {
      pushInspectionUi("UI: [PM CLOB 1/5] GET /polymarket/clob/signing-config …");
      let cfg: { funderAddress: string; chainId: number; host: string; signatureType: number; signerAddress?: string } | null =
        null;
      try {
        cfg = await api.polymarketClobSigningConfig();
        pushInspectionUi(
          `UI: [PM CLOB 2/5] funder=${cfg.funderAddress} | signer EOA=${cfg.signerAddress ?? "—"} | signatureType=${cfg.signatureType}`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        pushInspectionUi(`UI: [PM CLOB 2/5] signing-config failed: ${msg} (LIVE + token IDs required on server).`);
      }

      pushInspectionUi("UI: [PM CLOB 3/5] GET /wallet + balance-allowance + open-orders + user-trades …");
      const account = await api.polymarketConnect();
      setPolyAccount(account);
      const w = await api.wallet();
      setWallet(w);
      pushInspectionUi(
        `UI: [PM CLOB 4/5] Wallet summary — mode=${w.mode} | CLOB address=${w.address ?? "—"} | connected=${w.connected} | server USDC=${w.polymarketUsdc != null ? `$${Number(w.polymarketUsdc).toFixed(2)}` : "—"}`
      );
      if (cfg && (w.signerAddress || w.funderAddress)) {
        pushInspectionUi(
          `UI: [PM CLOB 4b] Server: signer EOA=${w.signerAddress ?? "—"} | Polymarket funder=${w.funderAddress ?? w.address ?? "—"}`
        );
      }
      if (!account.connected) {
        setLoginHint(
          "Session OK but Polymarket CLOB inactive. Set MODE=LIVE, EVM_PRIVATE_KEY, POLY_* and token IDs in server/.env."
        );
        pushInspectionUi("UI: [PM CLOB 5/5] Polymarket CLOB not connected — see server logs / .env.");
        pushLog("ERROR", "Polymarket CLOB not active (check server wallet + API keys).");
        return;
      }
      pushInspectionUi(
        `UI: [PM CLOB 5/5] OK — Polymarket CLOB USDC (server) $${account.polymarketUsdc != null ? Number(account.polymarketUsdc).toFixed(2) : "—"} | open orders=${account.openOrdersCount} | user trades=${account.userTradesCount}`
      );
      pushLog(
        "SIGNAL",
        `Polymarket CLOB: address=${account.address ?? "?"} | USDC=$${account.polymarketUsdc != null ? Number(account.polymarketUsdc).toFixed(2) : "?"} | orders=${account.openOrdersCount} | trades=${account.userTradesCount}`
      );
      setLoginHint(`Polymarket linked (${account.mode}). USDC: $${account.polymarketUsdc != null ? Number(account.polymarketUsdc).toFixed(2) : "—"}. Open orders: ${account.openOrdersCount}. Start Bot when ready.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Polymarket fetch failed";
      pushLog("ERROR", msg);
      setLoginHint(msg);
    } finally {
      setIsPolyConnecting(false);
    }
  };

  /** One flow: User ID + password → session token → immediately load Polymarket CLOB data. */
  const signInAndConnectPolymarket = async () => {
    pushInspectionUi("UI: [SignIn+PM 1/4] Validate dashboard credentials (must match server APP_USER_ID / APP_PASSWORD).");
    if (!userIdInput.trim() || !passwordInput.trim()) {
      pushInspectionUi("UI: [SignIn+PM 1/4] FAILED — user ID or password empty.");
      setLoginHint("Enter User ID and Password (must match APP_USER_ID / APP_PASSWORD in server/.env).");
      return;
    }
    setIsAuthenticating(true);
    try {
      pushInspectionUi(`UI: [SignIn+PM 2/4] POST /auth/password-login — userId="${userIdInput.trim()}".`);
      const out = await api.passwordLogin(userIdInput.trim(), passwordInput.trim());
      localStorage.setItem("polybot_auth_token", out.token);
      setWalletAddress(`user:${out.userId}`);
      setIsLoggedIn(true);
      pushInspectionUi(
        `UI: [SignIn+PM 3/4] Login OK — dashboard userId="${out.userId}" | loading Polymarket CLOB…`
      );
      pushLog("SIGNAL", `Dashboard session: ${out.userId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Invalid user ID or password";
      pushInspectionUi(`UI: [SignIn+PM 2–3/4] FAILED — ${msg}`);
      pushLog("ERROR", msg);
      setLoginHint(msg);
      setIsLoggedIn(false);
      localStorage.removeItem("polybot_auth_token");
      return;
    } finally {
      setIsAuthenticating(false);
    }
    await fetchPolymarketAccount("SignIn+PM step 4 — CLOB summary");
    setShowPasswordLogin(false);
  };

  const refreshPolymarketAccount = async () => {
    if (!isLoggedIn) {
      setLoginHint("Sign in first (User ID / Password).");
      return;
    }
    await fetchPolymarketAccount("Refresh Polymarket → GET /wallet + /polymarket/clob/*");
  };

  const sessionStats = useMemo(() => {
    const baseline = sessionIdsBeforeStartRef.current;
    const sessionTrades = trades.filter(
      (t) => !baseline.has(t.id) && tradeRowClosedForUi(t)
    );
    const pnl = sessionTrades.reduce((a, t) => a + tradePnlUsd(t), 0);
    const wins = sessionTrades.filter(
      (t) => t.status === "WIN" || (t.status === "CLOSED" && tradePnlUsd(t) > 0)
    ).length;
    const losses = sessionTrades.filter(
      (t) => t.status === "LOSS" || (t.status === "CLOSED" && tradePnlUsd(t) <= 0)
    ).length;
    const n = sessionTrades.length;
    return { pnl, wins, losses, n, winRate: n ? (wins / n) * 100 : 0 };
  }, [trades, runningSince, status?.running]);

  const allTimePnl = useMemo(() => {
    const settled = trades.filter((t) => tradeRowClosedForUi(t));
    return settled.reduce((a, t) => a + tradePnlUsd(t), 0);
  }, [trades]);

  const wlCounts = useMemo(() => {
    const settled = trades.filter((t) => tradeRowClosedForUi(t));
    return {
      w: settled.filter(
        (t) => t.status === "WIN" || (t.status === "CLOSED" && tradePnlUsd(t) > 0)
      ).length,
      l: settled.filter(
        (t) => t.status === "LOSS" || (t.status === "CLOSED" && tradePnlUsd(t) <= 0)
      ).length
    };
  }, [trades]);

  const pnlCurveData = useMemo(() => {
    const closed = trades.filter((t) => tradeRowClosedForUi(t));
    const chrono = [...closed].reverse();
    let cum = 0;
    let hi = 0;
    let lo = 0;
    const pts: { idx: number; cum: number; t: string; win: boolean }[] = [];
    chrono.forEach((t) => {
      cum += tradePnlUsd(t);
      hi = Math.max(hi, cum);
      lo = Math.min(lo, cum);
      pts.push({
        idx: pts.length,
        cum,
        t: t.time,
        win: t.status === "WIN" || (t.status === "CLOSED" && tradePnlUsd(t) > 0)
      });
    });
    return { pts, net: cum, hi, lo };
  }, [trades]);

  const badgeClass = (badge: string) => {
    if (badge === "tradable") return "bg-emerald-500/25 text-emerald-200";
    if (badge === "wide_spread") return "bg-amber-500/25 text-amber-200";
    if (badge === "extreme_quotes") return "bg-orange-500/25 text-orange-200";
    if (badge === "low_liquidity") return "bg-rose-500/25 text-rose-200";
    if (badge === "no_book") return "bg-slate-600 text-slate-300";
    return "bg-slate-600 text-slate-300";
  };
  const fmtBookSpread = (spread: number | null | undefined) =>
    spread != null && Number.isFinite(spread) ? spread.toFixed(4) : "—";

  const setTradingMode = async (target: Mode) => {
    if (!isLoggedIn) {
      pushLog("ERROR", "Login to switch between Demo and Real.");
      setLoginHint("Sign in first, then choose Demo (paper) or Real (Polymarket CLOB).");
      setShowPasswordLogin(true);
      return;
    }
    if (status?.mode === target) return;
    setModeToggleLoading(true);
    pushInspectionUi(
      `Mode → POST /api/mode (${target === "LIVE" ? "LIVE + EXECUTE_TRADES=true" : "SIMULATION + paper rail"})`
    );
    try {
      const r = await api.setMode({ mode: target });
      const [s, m, w, ts] = await Promise.all([
        api.status(),
        api.markets(),
        api.wallet(),
        api.tradingState()
      ]);
      setStatus({
        ...s,
        mode: r.mode ?? s.mode,
        paperTrading: typeof r.paperTrading === "boolean" ? r.paperTrading : s.paperTrading,
        paperOnly: typeof r.paperOnly === "boolean" ? r.paperOnly : s.paperOnly,
        executeTrades: typeof r.executeTrades === "boolean" ? r.executeTrades : s.executeTrades
      });
      setMarkets(m);
      setWallet(w);
      setTradingState(ts);
      setSelectedTokenID((prev) => (m.some((x) => x.tokenID === prev) ? prev : m[0]?.tokenID ?? ""));
      if (r.ok) {
        pushLog("SIGNAL", `Trading mode: ${r.mode} (${r.mode === "LIVE" ? "real orders" : "paper balance"})`);
        setLoginHint(
          r.mode === "LIVE"
            ? "Real mode: orders go to Polymarket. Confirm wallet + USDC before Start Bot."
            : "Demo mode: simulated balance only, no live orders."
        );
      } else {
        pushLog("ERROR", r.reason ?? "Could not switch to LIVE (check server .env wallet + API keys).");
        setLoginHint(r.reason ?? "LIVE unavailable; staying on demo.");
      }
    } catch (error) {
      pushLog("ERROR", error instanceof Error ? error.message : "Mode switch failed");
    } finally {
      setModeToggleLoading(false);
    }
  };

  const requestLiveMode = () => {
    if (!isLoggedIn) {
      setLoginHint("Sign in first, then switch to LIVE.");
      setShowPasswordLogin(true);
      pushInspectionUi("UI: Go LIVE — open login (dashboard session required).");
      return;
    }
    if (metaMaskAutoEnabled) {
      const ok = window.confirm(
        "Server LIVE mode cannot run while “Auto place trades from MetaMask” is on (only one execution path).\n\nTurn off MetaMask auto-trading and switch to LIVE?"
      );
      if (!ok) {
        pushInspectionUi("UI: Go LIVE cancelled — MetaMask auto-trading still ON.");
        return;
      }
      setMetaMaskAutoEnabled(false);
      pushLog("SIGNAL", "MetaMask auto-trading turned off so the server can use LIVE mode.");
      pushInspectionUi("UI: MetaMask auto OFF → proceeding with POST /api/mode (LIVE).");
    }
    void setTradingMode("LIVE");
  };

  const openLoginModal = (hint: string) => {
    setLoginHint(hint);
    setShowPasswordLogin(true);
    pushInspectionUi(`UI: ${hint}`);
  };

  const anchorRuntimeOn = Boolean(tradingState?.anchorStrategy?.runtimeEnabled);
  const anchorEnvOff = tradingState?.anchorStrategy?.envEnabled === false;
  const anchorControlTitle = useMemo(() => {
    const a = tradingState?.anchorStrategy;
    const tail =
      "Choose Anchor ON or OFF below (same idea as picking an entry mode). Polymarket evaluation only runs when Effective is on (needs ANCHOR_STRATEGY_ENABLED=true in server/.env + restart).";
    if (!a) {
      return `Bid-depth + Chainlink momentum after main entry skips. ${tail}`;
    }
    const n = a.stabilityTicks ?? 3;
    const rec = Math.min(a.ticksRecorded ?? 0, n);
    const imb = a.lastSignal?.imbalanceScore;
    const imbS = imb != null && Number.isFinite(imb) ? imb.toFixed(2) : "—";
    const mom = a.lastSignal?.chainlinkMom;
    const momS = mom != null && Number.isFinite(mom) ? `${(mom * 100).toFixed(3)}%` : "—";
    const px = a.lastSignal?.anchorPrice != null ? a.lastSignal.anchorPrice.toFixed(3) : "—";
    return `Env ${a.envEnabled ? "on" : "off"} · Effective ${a.effectiveEnabled ? "on" : "off"} · Stability ${rec}/${n} · imbalance ${imbS} · CL mom ${momS} · Anchor px ${px}. ${tail}`;
  }, [tradingState?.anchorStrategy]);

  const handleAnchorRuntimeSet = (enabled: boolean) => {
    if (!isLoggedIn) {
      openLoginModal("Sign in to control Anchor strategy.");
      return;
    }
    if (Boolean(tradingState?.anchorStrategy?.runtimeEnabled) === enabled) return;
    setAnchorBusy(true);
    void api
      .setAnchorStrategy(enabled)
      .then(() => api.tradingState())
      .then(setTradingState)
      .catch((e) => pushLog("ERROR", e instanceof Error ? e.message : String(e)))
      .finally(() => setAnchorBusy(false));
  };

  const handleStartBotClick = () => {
    if (!isLoggedIn) {
      openLoginModal("Sign in with User ID / Password (server APP_USER_ID / APP_PASSWORD), then start the bot.");
      return;
    }
    void startBot();
  };

  const handleStopBotClick = () => {
    if (!isLoggedIn) {
      openLoginModal("Sign in to stop the bot (authenticated API).");
      return;
    }
    void stopBot();
  };

  const handleBacktestClick = (strategyTitle: string) => {
    pushInspectionUi(
      `UI: Backtest (${strategyTitle}) — no historical/CSV replay endpoint. Use Demo (PAPER), Start Bot, then review Logs → Journal.`
    );
    pushLog(
      "SIGNAL",
      `Backtest (${strategyTitle}): this build has no separate historical replay. Forward-test in PAPER with the bot running, then use the Logs tab for trades, P&L, and bet snapshots.`
    );
    setLoginHint(`Backtest: switch to PAPER, start the bot, then read Logs. (${strategyTitle})`);
    setSnipeRoute("journal");
  };

  const logoutDashboard = () => {
    localStorage.removeItem("polybot_auth_token");
    setIsLoggedIn(false);
    setWalletAddress(null);
    setPolyAccount(null);
    setLoginHint("Logged out. Sign in again to trade.");
    pushLog("SIGNAL", "Logged out");
  };

  const snipeCardsProps = useMemo(() => {
    const last = chartData[chartData.length - 1];
    const pt = last?.btcUsd;
    const tgt = last?.btcTargetUsd;
    const toMid = (x: number | undefined) =>
      x == null || !Number.isFinite(x) ? null : x > 1 ? x / 100 : x;
    return {
      btcSlug: tradingState?.market.slug ?? null,
      primarySlug: tradingState?.market.slug ?? null,
      updownAssetsConfigured: tradingState?.updownAssetsConfigured ?? [],
      updownWindows: tradingState?.updownWindows ?? [],
      secsLeft: tradingState?.market.secondsToExpiry ?? null,
      upMid: toMid(last?.up),
      downMid: toMid(last?.down),
      priceToBeat: typeof tgt === "number" && Number.isFinite(tgt) ? tgt : null,
      currentBtc: typeof pt === "number" && Number.isFinite(pt) ? pt : null,
      diffUsd:
        typeof pt === "number" && typeof tgt === "number" && Number.isFinite(pt) && Number.isFinite(tgt)
          ? pt - tgt
          : null,
      statusLine: [status?.phase, prediction?.recommendation, prediction?.reason, status?.phaseReason]
        .filter(Boolean)
        .join(" · ")
    };
  }, [chartData, tradingState, status, prediction]);

  return (
    <div
      className="flex min-h-[100dvh] flex-col pb-44 text-slate-200"
      style={appShellBackground}
    >
      <CopyProTopBar
        wsConnected={wsConnected}
        running={Boolean(status?.running)}
        isLoggedIn={isLoggedIn}
        isAuthenticating={isAuthenticating}
        modeLive={status?.mode === "LIVE"}
        modeToggleLoading={modeToggleLoading}
        metaMaskAutoEnabled={metaMaskAutoEnabled}
        executionEnvBadge={executionEnvBadge}
        onStop={handleStopBotClick}
        onStart={handleStartBotClick}
        onPaper={() => void setTradingMode("SIMULATION")}
        onLive={requestLiveMode}
        onLogin={() => openLoginModal("Enter dashboard User ID and Password from server/.env.")}
        onLogout={logoutDashboard}
        onOpenRiskSettings={() => {
          setRiskModalError(null);
          setRiskModalOpen(true);
        }}
      />
      <RiskBetSettingsModal
        open={riskModalOpen}
        onClose={() => {
          setRiskModalOpen(false);
          setRiskModalError(null);
        }}
        settings={riskSettingsForUi}
        busy={riskModalBusy}
        error={riskModalError}
        onApply={applyRiskSettings}
        onPersistToEnv={persistRiskSettingsToEnv}
      />
      <CopyProMetricsRow
        mode={status?.mode === "LIVE" ? "LIVE" : "PAPER"}
        balance={`$${Number(status?.balance ?? 0).toFixed(2)}`}
        todayOrSessionPnl={`${sessionStats.pnl >= 0 ? "+" : ""}$${sessionStats.pnl.toFixed(2)}`}
        allPnl={`${allTimePnl >= 0 ? "+" : ""}$${allTimePnl.toFixed(2)}`}
        wl={`${wlCounts.w} / ${wlCounts.l}`}
        polymarketLine={
          <>
            <span className="font-mono text-copy-green">
              {headerPolymarketUsdc && Number.isFinite(headerPolymarketUsdc.value)
                ? `$${headerPolymarketUsdc.value.toFixed(2)}`
                : status?.mode === "LIVE"
                  ? metaMaskUsdcLoading
                    ? "…"
                    : "—"
                  : "—"}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-slate-600" title={funderDisplay}>
              Funder {funderDisplay}
            </span>
          </>
        }
      />
      <CopyProMainNav route={snipeRoute} onRoute={setSnipeRoute} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <main className="mx-auto w-full max-w-[1800px] flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
        {snipeRoute === "dashboard" && (
          <>
            <StrategyModulesStrip onOpenStrategies={() => setSnipeRoute("strategies")} />
            <OverviewSubNav value={overviewSub} onChange={setOverviewSub} />
            {overviewSub === "configuration" ? (
              <div className="card border-copy-border/40">
                <StrategyConfigScreen
                  botRunning={Boolean(status?.running)}
                  onBacktest={handleBacktestClick}
                />
              </div>
            ) : overviewSub === "stats" ? (
              <div className="card border-copy-border/40 space-y-3 p-6">
                <h2 className="font-display text-lg font-bold text-white">Quick stats</h2>
                <p className="text-sm text-slate-400">
                  Win rate: {stats.winRate.toFixed(1)}% · Profit factor:{" "}
                  {Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "—"} · Net: $
                  {stats.net.toFixed(2)}
                </p>
                <div className="rounded-lg bg-slate-900/70 p-3 text-xs text-slate-300">
                  <p>Bot activity trades: {insights?.totalTrades ?? 0}</p>
                  <p>No-trade signals: {insights?.noTradeSignals ?? 0}</p>
                  <p>
                    BONE blocks — hc {insights?.boneEntryFilters?.highConf ?? 0}, eq{" "}
                    {insights?.boneEntryFilters?.equilibrium ?? 0}, ls {insights?.boneEntryFilters?.longshot ?? 0}, lat{" "}
                    {insights?.boneEntryFilters?.latency ?? 0}
                  </p>
                </div>
                <p className="text-[11px] text-slate-500">Full journal: open the Logs tab.</p>
              </div>
            ) : overviewSub === "faq" ? (
              <div className="card border-copy-border/40 space-y-3 p-6 text-sm leading-relaxed text-slate-400">
                <h2 className="font-display text-lg font-bold text-white">Disclosure</h2>
                <p>
                  PolyBot is self-hosted software for research and automation. Prediction markets involve risk of loss.
                  There is no guarantee of profit. You are responsible for API keys, wallet security, and compliance
                  with applicable law.
                </p>
                <p>
                  Strategy parameters and filters are configured via <code className="text-copy-green">server/.env</code>.
                  This UI does not move private keys off your machine unless you use MetaMask in the browser.
                </p>
              </div>
            ) : (
          <div className="space-y-4">
            <SnipeAssetCardsRow
              {...snipeCardsProps}
              assetAutoTradeEnabled={tradingState?.assetAutoTradeEnabled}
              assetAutoTradeBusy={assetAutoTradeBusy}
              onToggleAssetAutoTrade={(asset, enabled) => {
                if (!isLoggedIn) {
                  openLoginModal("Sign in to change per-asset auto-trade.");
                  return;
                }
                setAssetAutoTradeBusy(asset);
                void api
                  .setAssetAutoTrade(asset, enabled)
                  .then(() => api.tradingState())
                  .then(setTradingState)
                  .catch((e) => pushLog("ERROR", e instanceof Error ? e.message : String(e)))
                  .finally(() => setAssetAutoTradeBusy(null));
              }}
            />
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
              <aside className="card w-full shrink-0 space-y-4 border-snipe-border xl:w-[300px]">
                <h2 className="font-display text-[10px] font-bold uppercase tracking-[0.22em] text-slate-500">Bot status</h2>
                <div className="flex items-center gap-2">
                  <span
                    className={
                      "h-2 w-2 shrink-0 rounded-full " +
                      (status?.running ? "bg-emerald-400 shadow-[0_0_10px_#34d399]" : "bg-slate-600")
                    }
                  />
                  <span className="text-sm font-semibold text-white">{status?.running ? "Running" : "Stopped"}</span>
                </div>
                {runningSince && status?.running ? (
                  <p className="text-[11px] text-slate-500">Running since {runningSince.toLocaleString()}</p>
                ) : null}
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">Balance</p>
                  <p className="font-mono text-xl font-bold text-snipe-accent">${Number(status?.balance ?? 0).toFixed(2)}</p>
                </div>
                <p className="truncate font-mono text-[10px] text-slate-500" title={funderDisplay}>
                  {funderDisplay.length > 14
                    ? `${funderDisplay.slice(0, 6)}…${funderDisplay.slice(-4)}`
                    : funderDisplay}
                </p>
                <button
                  type="button"
                  onClick={handleStopBotClick}
                  disabled={!isLoggedIn || !status?.running}
                  title={!isLoggedIn ? "Login first" : !status?.running ? "Bot is not running" : "Stop the bot"}
                  className="w-full rounded-xl bg-rose-600 py-3 text-sm font-bold text-white shadow-lg shadow-rose-900/40 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Stop Bot
                </button>
                <button
                  type="button"
                  onClick={handleStartBotClick}
                  disabled={!isLoggedIn || Boolean(status?.running) || isAuthenticating}
                  title={
                    !isLoggedIn
                      ? "Login first"
                      : isAuthenticating
                        ? "Signing in…"
                        : status?.running
                          ? "Bot already running"
                          : "Start the bot"
                  }
                  className="w-full rounded-xl border border-snipe-accent/50 bg-snipe-accent/15 py-2.5 text-sm font-bold text-snipe-accent transition hover:bg-snipe-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Start Bot
                </button>
                <div className="space-y-2 border-t border-snipe-border pt-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Session P&amp;L</span>
                    <span className={sessionStats.pnl >= 0 ? "font-mono text-emerald-400" : "font-mono text-rose-400"}>
                      {sessionStats.pnl >= 0 ? "+" : ""}${sessionStats.pnl.toFixed(3)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">All-time P&amp;L</span>
                    <span className={allTimePnl >= 0 ? "font-mono text-emerald-400" : "font-mono text-rose-400"}>
                      {allTimePnl >= 0 ? "+" : ""}${allTimePnl.toFixed(3)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Trades</span>
                    <span>{sessionStats.n}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Win / Loss</span>
                    <span>
                      {sessionStats.wins} / {sessionStats.losses}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>Win rate</span>
                    <span>{sessionStats.winRate.toFixed(0)}%</span>
                  </div>
                </div>
                <div className="rounded-xl border border-snipe-border bg-[#0a0c10] p-3 text-[10px] leading-relaxed">
                  <p className="mb-1 font-bold uppercase tracking-wide text-slate-500">Last signal</p>
                  <p>
                    <span className="text-slate-500">Type:</span>{" "}
                    <span className="font-semibold text-snipe-accent">
                      {prediction?.prediction ?? "—"} {prediction?.recommendation ?? ""}
                    </span>
                  </p>
                  <p className="mt-1 text-slate-500">
                    At: {prediction?.ts ? new Date(prediction.ts).toLocaleTimeString() : "—"}
                  </p>
                  <p className="mt-1 break-words font-mono text-[9px] text-slate-500">
                    Gate: {prediction?.reason ?? "—"}
                  </p>
                </div>
              </aside>
              <div className="card min-w-0 flex-1 overflow-hidden border-snipe-border p-0">
                <div className="border-b border-snipe-border px-4 py-3">
                  <h2 className="font-display text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Recent trades</h2>
                </div>
                <div className="max-h-[min(520px,55vh)] overflow-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 z-10 bg-[#0c0f14] text-[10px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Time</th>
                        <th className="px-2 py-2">Exec</th>
                        <th className="px-2 py-2">Asset</th>
                        <th className="px-2 py-2">Strategy</th>
                        <th className="px-2 py-2">Side</th>
                        <th className="px-2 py-2">UP@entry</th>
                        <th className="px-2 py-2">DN@entry</th>
                        <th className="px-2 py-2">Entry</th>
                        <th className="px-2 py-2">Exit</th>
                        <th className="px-2 py-2">Spent</th>
                        <th className="px-2 py-2">P&amp;L</th>
                        <th className="px-2 py-2">Held</th>
                        <th className="px-2 py-2">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-[11px] text-slate-300">
                      {trades.map((t) => (
                        <tr key={t.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                          <td className="whitespace-nowrap px-3 py-2 text-slate-400">{t.time}</td>
                          <td className="px-2 py-2">
                            {(() => {
                              const em = tradeExecutionModeLabel(t, status?.mode);
                              return (
                                <span
                                  className={
                                    em === "PAPER"
                                      ? "rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-200"
                                      : "rounded bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-sky-200"
                                  }
                                >
                                  {em}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-2 py-2 font-semibold text-slate-300">{t.asset ?? "—"}</td>
                          <td className="px-2 py-2 text-slate-400">
                            {entryStrategyUi.effective.replace(/_/g, " ")}
                          </td>
                          <td className="px-2 py-2">
                            <span
                              className={
                                t.direction === "UP"
                                  ? "font-bold text-emerald-400"
                                  : "font-bold text-rose-400"
                              }
                            >
                              {t.direction === "UP" ? "YES" : "NO"}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-emerald-300/90">{fmtEntryMidPct(t.upPriceAtEntry)}</td>
                          <td className="px-2 py-2 text-rose-300/90">{fmtEntryMidPct(t.downPriceAtEntry)}</td>
                          <td className="px-2 py-2">{tradeEntryFillPct(t)}</td>
                          <td className="px-2 py-2 text-slate-400">{tradeExitDisplayPct(t)}</td>
                          <td className="px-2 py-2">${Number(t.amount ?? 0).toFixed(2)}</td>
                          <td className={`px-2 py-2 ${formatTradePnlDisplay(t, 3).className}`}>
                            {formatTradePnlDisplay(t, 3).text}
                          </td>
                          <td className="px-2 py-2 text-slate-500">
                            {tradeRowOpenForUi(t) ? "OPEN" : "—"}
                          </td>
                          <td
                            className="max-w-[200px] truncate px-2 py-2 text-[10px] text-slate-500"
                            title={tradeReasonSummary(t)}
                          >
                            {tradeReasonSummary(t)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

        <section className="card grid gap-3 md:grid-cols-2">
          <div className="space-y-2 rounded-lg border border-slate-700/80 bg-slate-900/40 p-3">
            <h3 className="text-sm font-semibold text-slate-200">Market window &amp; books</h3>
            {!tradingState ? (
              <p className="text-xs text-slate-500">Loading…</p>
            ) : (
              <>
                <p className="text-xs text-slate-400">Title: {tradingState.market.label}</p>
                {tradingState.market.slug ? (
                  <p className="break-all font-mono text-[11px] text-slate-500">Slug: {tradingState.market.slug}</p>
                ) : null}
                <div className="flex flex-wrap gap-2 text-xs">
                  {tradingState.market.marketExpired ? (
                    <span className="rounded bg-red-500/25 px-2 py-0.5 text-red-200">Expired (past Gamma end)</span>
                  ) : tradingState.market.windowActive ? (
                    <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-emerald-300">Window active</span>
                  ) : (
                    <span className="rounded bg-slate-600 px-2 py-0.5 text-slate-300">No Gamma end time (demo)</span>
                  )}
                  {tradingState.market.endMs != null ? (
                    <span className="text-slate-400">
                      Ends (local): {new Date(tradingState.market.endMs).toLocaleString()}
                    </span>
                  ) : null}
                  {tradingState.market.secondsToExpiry != null && !tradingState.market.marketExpired ? (
                    <span className="text-slate-400">
                      ~{Math.floor(tradingState.market.secondsToExpiry / 60)}m {tradingState.market.secondsToExpiry % 60}s
                      left
                    </span>
                  ) : null}
                </div>
                <p className="text-[11px] text-slate-500">
                  Last book refresh:{" "}
                  {tradingState.lastBookRefreshMs != null
                    ? new Date(tradingState.lastBookRefreshMs).toLocaleTimeString()
                    : "—"}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded border border-slate-700 p-2">
                    <div className="mb-1 font-medium text-slate-300">UP</div>
                    <span className={badgeClass(tradingState.books?.up?.badge ?? "no_book")}>
                      {tradingState.books?.up?.badge ?? "no_book"}
                    </span>
                    <span className="ml-2 text-slate-400">spread {fmtBookSpread(tradingState.books?.up?.spread)}</span>
                  </div>
                  <div className="rounded border border-slate-700 p-2">
                    <div className="mb-1 font-medium text-slate-300">DOWN</div>
                    <span className={badgeClass(tradingState.books?.down?.badge ?? "no_book")}>
                      {tradingState.books?.down?.badge ?? "no_book"}
                    </span>
                    <span className="ml-2 text-slate-400">spread {fmtBookSpread(tradingState.books?.down?.spread)}</span>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="space-y-2 rounded-lg border border-slate-700/80 bg-slate-900/40 p-3">
            <h3 className="text-sm font-semibold text-slate-200">Live trading readiness</h3>
            {!tradingState ? (
              <p className="text-xs text-slate-500">Loading…</p>
            ) : (
              <ul className="space-y-1.5 text-xs text-slate-300">
                <li>
                  <span className="text-slate-500">Backend:</span>{" "}
                  {wsConnected ? <span className="text-emerald-400">OK</span> : <span className="text-red-400">Disconnected</span>}
                </li>
                <li>
                  <span className="text-slate-500">CLOB L2 authenticated:</span>{" "}
                  {tradingState.clobAuthenticated ? (
                    <span className="text-emerald-400">Yes</span>
                  ) : tradingState.executionMode === "LIVE" ? (
                    <span className="text-amber-400">No (check keys / restart)</span>
                  ) : (
                    <span className="text-slate-500">N/A (paper)</span>
                  )}
                </li>
                <li>
                  <span className="text-slate-500">Auto-discover 5m market:</span>{" "}
                  {tradingState.autoDiscoverEnabled ? (
                    <span className="text-emerald-400">On</span>
                  ) : (
                    <span className="text-slate-400">Off (manual token IDs)</span>
                  )}
                </li>
                <li>
                  <span className="text-slate-500">Token IDs (UP / DOWN):</span>{" "}
                  {tradingState.market.tokenIdUp && tradingState.market.tokenIdDown ? (
                    <span className="break-all font-mono text-[10px] text-sky-300/90">
                      {tradingState.market.tokenIdUp.slice(0, 10)}… / {tradingState.market.tokenIdDown.slice(0, 10)}…
                    </span>
                  ) : (
                    <span className="text-slate-500">—</span>
                  )}
                </li>
              </ul>
            )}
          </div>
        </section>

        <section className="card">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-white">{selectedMarketLabel}</h2>
            <div className="flex items-center gap-2">
              <select
                value={
                  markets.length > 0 && !markets.some((m) => m.tokenID === selectedTokenID)
                    ? (markets[0]?.tokenID ?? "")
                    : selectedTokenID
                }
                onChange={(e) => onSelectMarket(e.target.value)}
                aria-label="Select market"
                className="rounded border border-transparent bg-slate-700 px-2 py-1 text-xs text-slate-100 outline-none focus:border-copy-green/50 focus:ring-2 focus:ring-copy-green/30"
              >
                {markets.length === 0 ? (
                  <option value="">No markets — start API on :4000</option>
                ) : (
                  markets.map((m) => (
                    <option key={m.tokenID} value={m.tokenID}>
                      {m.label}
                    </option>
                  ))
                )}
              </select>
              <div className="rounded bg-slate-700 px-2 py-1 text-xs">
                Prediction: {prediction?.prediction ?? "--"} ({prediction?.confidence ?? 0}%)
              </div>
            </div>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
            One chart per <span className="text-slate-400">UPDOWN_ASSETS</span> symbol. Line = exchange spot (Coinbase / Binance); dashed
            target = Polymarket price to beat when available, else window-open anchor. Engine momentum still tracks{" "}
            <span className="font-medium text-slate-400">{chartPrimaryAsset}</span> (first in list).
          </p>
          {chartAssetsList.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2">
              {chartAssetsList.map((a) => {
                const series =
                  assetCharts[a]?.length && assetCharts[a]!.some((p) => p.btcUsd != null)
                    ? assetCharts[a]!
                    : a === chartPrimaryAsset && chartData.length > 0 && chartData.some((p) => p.btcUsd != null)
                      ? chartData
                      : [];
                return (
                  <AssetSpotChartCard key={a} asset={a} points={series} stroke={chartStrokeForAsset(a)} />
                );
              })}
            </div>
          ) : chartData.length > 0 && chartData.some((p) => p.btcUsd != null) ? (
            <AssetSpotChartCard asset="Spot" points={chartData} stroke="#F7931A" />
          ) : (
            <div className="flex min-h-[240px] items-center justify-center rounded-lg bg-[#0f1114] text-sm text-slate-500">
              Loading spot feeds…
            </div>
          )}
        </section>

        <section className="card grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
          <h3 className="font-display text-lg font-bold text-white">Execution &amp; size</h3>
          <div className="text-xs text-slate-300">
            Bot State: {status?.running ? "Running" : "Stopped"} | Auto: {status?.autoTrading ? "ON" : "OFF"} | Phase:{" "}
            <span className="font-medium text-slate-100">{status?.phase ?? "—"}</span>
            {tradingState ? (
              <>
                {" "}
                | Exec:{" "}
                <span className={tradingState.executionMode === "LIVE" ? "text-emerald-300" : "text-sky-300"}>
                  {tradingState.executionMode === "LIVE" ? "LIVE" : "PAPER"}
                </span>
              </>
            ) : null}
            {status?.phaseReason ? (
              <span className="text-slate-400"> — {status.phaseReason}</span>
            ) : null}
          </div>
          {tradingState ? (
            <p className="text-[11px] leading-snug text-slate-500">
              {tradingState.executionLabel === "LIVE_ONLY"
                ? "LIVE — orders can route to Polymarket CLOB."
                : "PAPER — simulated."}
            </p>
          ) : null}
          {tradingState?.liveEngine ? (
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md border border-slate-800/90 bg-[#0a0c10]/90 px-2.5 py-1.5 font-mono text-[10px] leading-tight text-slate-500">
              <span>
                RTDS{" "}
                <span
                  className={
                    tradingState.liveEngine.rtdsConnected ? "font-semibold text-emerald-400" : "font-semibold text-amber-400"
                  }
                >
                  {tradingState.liveEngine.rtdsConnected ? "LIVE" : "…"}
                </span>
              </span>
              <span className="text-slate-700" aria-hidden>
                │
              </span>
              <span>
                CLOB+Γ{" "}
                <span className="text-slate-300">{formatBookRefreshAge(tradingState.liveEngine.secondsSinceBookRefresh)}</span>
                {tradingState.liveEngine.lastBookRefreshMs != null ? (
                  <span className="text-slate-600">
                    {" "}
                    @ {new Date(tradingState.liveEngine.lastBookRefreshMs).toLocaleTimeString()}
                  </span>
                ) : null}
                <span className="text-slate-600">
                  {" "}
                  · {tradingState.liveEngine.discoveredSlotCount} mkt
                  {tradingState.liveEngine.discoveredSlotCount === 1 ? "" : "s"}
                </span>
                {tradingState.executionMode === "LIVE" && !tradingState.liveEngine.hasLiveMarketData ? (
                  <span className="text-amber-400/90"> · books pending</span>
                ) : null}
              </span>
              <span className="text-slate-700" aria-hidden>
                │
              </span>
              <span title="REST poll matches book refresh; CLOB/Gamma requests coalesce when concurrent; WS skips duplicate signal payloads">
                sync 4s · coalesced fetches
              </span>
            </div>
          ) : null}
          <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200">
            <p>
              <span className="text-slate-400">Entry strategy: </span>
              <span className="font-medium text-slate-100">{entryStrategyUi.label}</span>
              {entryStrategyUi.runtimeOverride ? (
                <span className="ml-1 text-copy-green">· dashboard</span>
              ) : (
                <span className="ml-1 text-slate-500">· .env</span>
              )}
            </p>
            {entryStrategyUi.fromEnv === "contrarian" && entryStrategyUi.runtimeOverride == null ? (
              <p className="text-[10px] leading-snug text-amber-200/90">
                Contrarian is set in <code className="text-slate-300">ENTRY_STRATEGY</code>. Choose a mode below to override from the UI.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["ensemble", "Ensemble (all)"],
                  ["momentum", "Momentum"],
                  ["spot_poly_lag", "Spot-Poly Lag"],
                  ["orderbook", "Order book"],
                  ["whale_edge", "Whale edge"],
                  ["ola", "OLA (latency)"],
                  ["mean_revert", "Mean revert"],
                  ["chart", "Chart"]
                ] as const satisfies ReadonlyArray<readonly [DashboardEntryStrategyId, string]>
              ).map(([id, label]) => {
                const active = entryStrategyUi.effective === id;
                return (
                  <button
                    key={id}
                    type="button"
                    disabled={!isLoggedIn || entryStrategyBusy}
                    onClick={() => void applyEntryStrategy({ strategy: id })}
                    className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition ${
                      active
                        ? "bg-copy-green/30 text-copy-green ring-1 ring-copy-green/40"
                        : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {label}
                  </button>
                );
              })}
              <button
                type="button"
                disabled={!isLoggedIn || anchorBusy}
                onClick={() => handleAnchorRuntimeSet(true)}
                title={`${anchorControlTitle} — set runtime ON.`}
                className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition ${
                  anchorRuntimeOn
                    ? "bg-orange-500/20 text-orange-200 ring-1 ring-orange-400/45"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                Anchor ON
              </button>
              <button
                type="button"
                disabled={!isLoggedIn || anchorBusy}
                onClick={() => handleAnchorRuntimeSet(false)}
                title={`${anchorControlTitle} — set runtime OFF.`}
                className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition ${
                  !anchorRuntimeOn
                    ? "bg-slate-600/35 text-slate-100 ring-1 ring-slate-500/55"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                Anchor OFF
              </button>
              <button
                type="button"
                disabled={!isLoggedIn || entryStrategyBusy || entryStrategyUi.runtimeOverride == null}
                onClick={() => void applyEntryStrategy({ reset: true })}
                className="rounded-md border border-slate-600 px-2.5 py-1 text-[10px] text-slate-400 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Use .env
              </button>
              <button
                type="button"
                disabled={!isLoggedIn || lagSnipeBusy || entryStrategyBusy}
                onClick={() => void applyLagSnipe(!lagSnipeOn)}
                title="BTC 5m only, last ~30s of window, 2×1m candle + book gates; disables GTC and live auto-flatten"
                className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition ${
                  lagSnipeOn
                    ? "bg-amber-500/25 text-amber-200 ring-1 ring-amber-400/50"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                Lag Snipe {lagSnipeOn ? "ON" : "OFF"}
              </button>
              <button
                type="button"
                disabled={!isLoggedIn || spotPolyLagBusy || entryStrategyBusy}
                onClick={() => void applySpotPolyLag(!spotPolyLagOn)}
                className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition ${
                  spotPolyLagOn
                    ? "bg-fuchsia-500/25 text-fuchsia-200 ring-1 ring-fuchsia-400/50"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                Start Spot-Poly Lag 🎯
              </button>
            </div>
            {anchorEnvOff ? (
              <p className="text-[10px] leading-snug text-slate-500">
                Env flag off: you can still set Anchor ON/OFF above. Live evaluation needs{" "}
                <code className="text-slate-400">ANCHOR_STRATEGY_ENABLED=true</code> in{" "}
                <code className="text-slate-400">server/.env</code> and a server restart (until then, Effective stays off).
              </p>
            ) : null}
            {lagSnipeOn ? (
              <p className="text-[10px] font-medium text-amber-200/95">
                {tradingState?.lagSnipeBanner ?? "Lag Snipe: HOLD Manual Exit"} — other strategies paused for entries.
                {tradingState?.market?.secondsToExpiry != null
                  ? ` · window left ~${Math.max(0, Math.floor(tradingState.market.secondsToExpiry))}s`
                  : ""}
              </p>
            ) : null}
            <div className="rounded-md border border-fuchsia-700/70 bg-fuchsia-950/20 px-2.5 py-2 text-[10px] text-fuchsia-100">
              <p className="mb-1 font-semibold">🎯 Spot-Poly Lag</p>
              <div className="grid grid-cols-2 gap-y-1">
                <span className="text-fuchsia-200/80">OB Signal</span>
                <span
                  className={
                    spotPolyLagStatus.ob_signal === "BULLISH"
                      ? "text-emerald-300"
                      : spotPolyLagStatus.ob_signal === "BEARISH"
                        ? "text-rose-300"
                        : "text-amber-300"
                  }
                >
                  {spotPolyLagStatus.ob_signal ?? "NEUTRAL"}
                </span>
                <span className="text-fuchsia-200/80">OB Ratio</span>
                <span>{spotPolyLagStatus.ob_ratio ?? "—"}</span>
                <span className="text-fuchsia-200/80">CLOB Ask</span>
                <span>{spotPolyLagStatus.clob_ask ?? "—"}</span>
                <span className="text-fuchsia-200/80">CLOB Spread</span>
                <span>{spotPolyLagStatus.clob_spread ?? "—"}</span>
                <span className="text-fuchsia-200/80">CLOB Depth</span>
                <span>{spotPolyLagStatus.clob_depth ?? "—"}</span>
              </div>
            </div>
            <p className="text-[10px] leading-relaxed text-slate-500">
              <strong className="text-slate-400">Ensemble</strong> blends momentum, orderbook, mean-revert, chart, mid-flip,
              last-second collapse, and reversal snipe; optional whale filters via{" "}
              <code className="text-slate-400">ENSEMBLE_APPLY_WHALE_FILTER</code>. Other buttons force a single leg only.
            </p>
          </div>
          <p className="text-[11px] text-slate-500">
            Server auto-trade: ${riskSettingsForUi.entryUsd.toFixed(2)} target · min ${riskSettingsForUi.minTrade} · max $
            {riskSettingsForUi.maxTrade} · cooldown {riskSettingsForUi.cooldownMs}ms
            {riskSettingsForUi.overridesActive ? (
              <span className="text-copy-green"> · overrides .env</span>
            ) : null}
            . Use <span className="font-semibold text-slate-400">Risk &amp; bet</span> in the header to change.
          </p>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-slate-400">% of capital per entry</span>
              <select
                value={capitalPctPerEntry}
                onChange={(e) => {
                  setCapitalPctPerEntry(Number(e.target.value));
                  setAmountSource("PERCENT");
                }}
                aria-label="Percent of capital per entry"
                className="rounded border border-transparent bg-slate-700 px-2 py-1 text-xs text-slate-100 outline-none focus:border-copy-green/50 focus:ring-2 focus:ring-copy-green/30"
              >
                {([1, 2, 5, 10, 15, 20, 25, 33, 50] as const).map((p) => (
                  <option key={p} value={p}>
                    {p}%
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[11px] text-slate-500">
              {status?.mode === "LIVE" ? "Balance (reference):" : "Simulated balance:"}{" "}
              ${capitalUsd.toFixed(2)} → recommended bet: $
              {Number(((capitalUsd * capitalPctPerEntry) / 100).toFixed(2)).toFixed(2)}
            </p>
            <input
              type="number"
              min={0}
              step={0.01}
              value={amount}
              onChange={(e) => {
                setAmount(Number(e.target.value));
                setAmountSource("MANUAL");
              }}
              aria-label="Trade size override USD"
              className="w-full rounded-lg border border-transparent bg-slate-800 px-3 py-2 text-slate-200 outline-none focus:border-copy-green/40 focus:ring-2 focus:ring-copy-green/25"
            />
            <p className="text-[11px] text-slate-500">
              {amountSource === "PERCENT" ? "Auto-calculated (editing switches to manual)." : "Manual override."}
            </p>
          </div>
          <div className="rounded-lg bg-slate-800 p-3 text-sm">
            <p>Target stake per trade: ${fmtNum(amount, 2)}</p>
            <p className="mt-1 text-[11px] leading-snug text-slate-500">
              Actual risk depends on market and slippage.
            </p>
          </div>
          <button
            type="button"
            disabled
            title="Manual trade button is disabled; the bot places trades automatically."
            className="w-full rounded-xl bg-slate-700 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-50"
          >
            Auto-only mode
          </button>
          <p className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200">
            Bot Suggestion: {suggestion}
          </p>
          <p className={`text-xs ${prediction?.recommendation === "NO_TRADE" ? "text-yellow-300" : "text-gain"}`}>
            Strategy: {prediction?.recommendation ?? "TRADE"} {prediction?.reason ? `- ${prediction.reason}` : ""}
          </p>
          <div className="text-xs text-slate-400">
            {status?.mode === "LIVE" ? "LIVE" : "PAPER"} | CLOB: {wallet?.connected ? "Connected" : "Not connected"}
            {wallet?.polymarketUsdc != null ? ` | Server CLOB $${wallet.polymarketUsdc.toFixed(2)}` : ""}
            {metaMaskPolymarketUsdc != null ? ` | MetaMask $${metaMaskPolymarketUsdc.toFixed(2)}` : ""}
          </div>
          <div className={`text-xs ${isLoggedIn ? "text-gain" : "text-yellow-300"}`}>{loginHint}</div>
          </div>
          <div className="space-y-3 rounded-xl border border-snipe-border/80 bg-[#0a0c10]/50 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-snipe-accent">MetaMask</p>
            <button
              type="button"
              disabled={metaMaskOrderBusy}
              onClick={() => void connectMetaMaskTrading()}
              className="w-full rounded-xl bg-snipe-accent py-2.5 text-xs font-bold text-[#061016] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {metaMaskConnected
                ? `Connected ${metaMaskAddress?.slice(0, 6)}…${metaMaskAddress?.slice(-4)}`
                : "Connect MetaMask"}
            </button>
            <label className="flex items-center justify-between text-xs text-slate-300">
              <span>Auto place trades</span>
              <input
                type="checkbox"
                checked={metaMaskAutoEnabled}
                onChange={(e) => setMetaMaskAutoEnabled(e.target.checked)}
              />
            </label>
          </div>
        </section>
          </div>
            )}
          </>
        )}

        {snipeRoute === "strategies" && (
          <>
            <StrategyModulesStrip onOpenStrategies={() => setSnipeRoute("strategies")} />
            <div className="card border-copy-border/40 p-6">
              <StrategyConfigScreen
                botRunning={Boolean(status?.running)}
                onBacktest={handleBacktestClick}
              />
            </div>
          </>
        )}

        {snipeRoute === "tools" && (
          <div className="card border-copy-border/40 grid gap-4 p-6 lg:grid-cols-2">
            <div className="space-y-3">
              <h2 className="font-display text-lg font-bold text-white">MetaMask</h2>
              <p className="text-xs text-slate-400">
                Connect a signer for read-only CLOB balance or optional client-side orders. Server LIVE mode uses keys in{" "}
                <code className="text-copy-green">server/.env</code>.
              </p>
              <button
                type="button"
                disabled={metaMaskOrderBusy}
                onClick={() => void connectMetaMaskTrading()}
                className="w-full rounded-xl bg-copy-green py-2.5 text-xs font-bold text-black transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {metaMaskConnected
                  ? `Connected ${metaMaskAddress?.slice(0, 6)}…${metaMaskAddress?.slice(-4)}`
                  : "Connect MetaMask"}
              </button>
              <label className="flex items-center justify-between text-xs text-slate-300">
                <span>Auto place trades from MetaMask</span>
                <input
                  type="checkbox"
                  checked={metaMaskAutoEnabled}
                  onChange={(e) => setMetaMaskAutoEnabled(e.target.checked)}
                />
              </label>
            </div>
            <div className="space-y-2 text-xs text-slate-400">
              <h3 className="font-semibold text-slate-200">Session</h3>
              <p>
                <span className="text-slate-200">{status?.mode === "LIVE" ? "LIVE" : "PAPER"}</span> · CLOB:{" "}
                {wallet?.connected ? "connected" : "not connected"}
              </p>
              <p className="text-[11px] text-slate-500">
                Live chart, books, and API inspection stay on Overview → Live status. Use the bar at the bottom for request
                traces.
              </p>
            </div>
          </div>
        )}

        {snipeRoute === "wizard" && (
          <div className="card border-snipe-border p-6">
            <WizardScreenPoly onExit={() => setSnipeRoute("dashboard")} />
          </div>
        )}

        {snipeRoute === "settings" && (
          <div className="space-y-4">
            <div className="card border-snipe-border p-4">
              <h3 className="mb-2 font-display text-sm font-bold text-white">Trading mode</h3>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!isLoggedIn || modeToggleLoading}
                  onClick={() => void setTradingMode("SIMULATION")}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    status?.mode !== "LIVE" ? "bg-snipe-accent text-[#061016]" : "bg-snipe-panel text-slate-400"
                  }`}
                >
                  Demo
                </button>
                <button
                  type="button"
                  disabled={!isLoggedIn || modeToggleLoading}
                  onClick={() => requestLiveMode()}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    status?.mode === "LIVE" ? "bg-amber-500 text-slate-900" : "bg-snipe-panel text-slate-400"
                  }`}
                >
                  Real
                </button>
              </div>
            </div>
            <div className="card border-snipe-border p-6">
              <SettingsScreenPoly />
            </div>
          </div>
        )}

        {snipeRoute === "journal" && (
          <div className="grid grid-cols-12 gap-4">
        <section className="card col-span-12">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <h3 className="font-display text-xs font-bold uppercase tracking-[0.2em] text-slate-400">P&amp;L curve</h3>
            <div className="flex flex-wrap gap-4 text-xs">
              <div>
                <span className="text-slate-500">Net </span>
                <span className="font-mono font-bold text-snipe-accent">${pnlCurveData.net.toFixed(2)}</span>
              </div>
              <div>
                <span className="text-slate-500">High </span>
                <span className="font-mono text-emerald-400">${pnlCurveData.hi.toFixed(2)}</span>
              </div>
              <div>
                <span className="text-slate-500">Low </span>
                <span className="font-mono text-rose-400">${pnlCurveData.lo.toFixed(2)}</span>
              </div>
            </div>
          </div>
          <p className="mb-2 text-[11px] text-slate-500">Realized cumulative P&amp;L after each closed trade (chronological).</p>
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={pnlCurveData.pts} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid stroke="#1e293b" vertical={false} />
                <XAxis dataKey="idx" stroke="#64748b" tick={{ fill: "#64748b", fontSize: 10 }} />
                <YAxis stroke="#64748b" tick={{ fill: "#94a3b8", fontSize: 10 }} tickFormatter={(v) => `$${v}`} width={56} />
                <Tooltip
                  contentStyle={{ background: "#12161c", border: "1px solid #1c2230" }}
                  formatter={(v: number | string) => [`$${fmtNum(v, 2)}`, "Cum. P&L"]}
                  labelFormatter={(_, p) => (p?.[0]?.payload?.t ? String(p[0].payload.t) : "")}
                />
                <Line
                  type="monotone"
                  dataKey="cum"
                  stroke="#2dd4bf"
                  strokeWidth={2}
                  dot={(props: { cx?: number; cy?: number; payload?: { win: boolean } }) => {
                    const { cx, cy, payload } = props;
                    if (cx == null || cy == null) return <g />;
                    const fill = payload?.win ? "#34d399" : "#f87171";
                    return <circle cx={cx} cy={cy} r={4} fill={fill} stroke="#0a0c10" strokeWidth={1} />;
                  }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 border-t border-snipe-border pt-3">
            {(["1m", "1h", "day", "month", "year"] as const).map((range) => (
              <button
                key={range}
                type="button"
                onClick={() => setPortfolioRange(range)}
                className={`rounded-lg px-2 py-1 text-[10px] font-semibold uppercase ${
                  portfolioRange === range ? "bg-snipe-accent/20 text-snipe-accent" : "bg-snipe-panel text-slate-400"
                }`}
              >
                Balance {range}
              </button>
            ))}
          </div>
          <div className="mt-3 h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={filteredPortfolioData}>
                <CartesianGrid stroke="#1e293b" />
                <XAxis dataKey="ts" stroke="#64748b" type="number" tickFormatter={formatPortfolioTick} domain={["dataMin", "dataMax"]} />
                <YAxis stroke="#64748b" tick={{ fill: "#94a3b8", fontSize: 10 }} />
                <Tooltip
                  formatter={(value: number | string, name: string) =>
                    name === "balance" ? [`$${fmtNum(value, 2)}`, "Balance"] : [value, name]
                  }
                  labelFormatter={(label) => new Date(Number(label)).toLocaleString()}
                />
                <Line type="monotone" dataKey="balance" stroke="#60a5fa" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card col-span-12">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Trade log filters</h3>
            <button
              type="button"
              onClick={() => {
                const header = "time,asset,strategy,side,prob,entry,exit,pnl,status";
                const lines = tradeLogRows.map((r) =>
                  [
                    r.timeIso,
                    r.asset,
                    r.strategy,
                    r.side,
                    r.prob == null ? "" : r.prob.toFixed(4),
                    r.entry.toFixed(6),
                    r.exit == null ? "" : r.exit.toFixed(6),
                    r.pnl.toFixed(6),
                    r.status
                  ].join(",")
                );
                const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `trade-log-${tradeLogFrom}-to-${tradeLogTo}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              disabled={tradeLogRows.length === 0}
              className="rounded bg-slate-600 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Download CSV
            </button>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            {([
              ["today", "Today"],
              ["yesterday", "Yesterday"],
              ["7d", "7d"],
              ["30d", "30d"],
              ["custom", "Custom"]
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTradeLogPreset(id)}
                className={`rounded-lg px-2 py-1 text-[10px] font-bold uppercase ${
                  tradeLogPreset === id ? "bg-snipe-accent text-[#061016]" : "bg-snipe-panel text-slate-400"
                }`}
              >
                {label}
              </button>
            ))}
            <label className="ml-2 text-xs text-slate-400">
              From{" "}
              <input
                type="date"
                value={tradeLogFrom}
                onChange={(e) => {
                  setTradeLogPreset("custom");
                  setTradeLogFrom(e.target.value);
                }}
                className="rounded bg-slate-800 px-2 py-1 text-slate-200"
              />
            </label>
            <label className="text-xs text-slate-400">
              To{" "}
              <input
                type="date"
                value={tradeLogTo}
                onChange={(e) => {
                  setTradeLogPreset("custom");
                  setTradeLogTo(e.target.value);
                }}
                className="rounded bg-slate-800 px-2 py-1 text-slate-200"
              />
            </label>
            <select
              value={tradeLogAsset}
              onChange={(e) => setTradeLogAsset(e.target.value)}
              className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-200"
            >
              <option value="ALL">Asset: All</option>
              <option value="BTC">BTC</option>
              <option value="ETH">ETH</option>
              <option value="SOL">SOL</option>
              <option value="XRP">XRP</option>
              <option value="DOGE">DOGE</option>
            </select>
            <select
              value={tradeLogStrategy}
              onChange={(e) => setTradeLogStrategy(e.target.value)}
              className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-200"
            >
              <option value="ALL">Strategy: All</option>
              <option value="lag_snipe">lag_snipe</option>
              <option value="ola">ola</option>
              <option value="ensemble">ensemble</option>
              <option value="whale_edge">whale_edge</option>
              <option value="orderbook">orderbook</option>
              <option value="mean_revert">mean_revert</option>
              <option value="chart">chart</option>
              <option value="momentum">momentum</option>
            </select>
            <select
              value={tradeLogSession}
              onChange={(e) => setTradeLogSession(e.target.value as "24h" | "AM" | "PM")}
              className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-200"
            >
              <option value="24h">Session: 24h</option>
              <option value="AM">Session: AM</option>
              <option value="PM">Session: PM</option>
            </select>
          </div>
          <p className="mb-2 text-xs text-slate-400">
            {tradeLogStats
              ? `Trades ${tradeLogStats.total} · Win ${tradeLogStats.winRate.toFixed(1)}% · PnL ${
                  tradeLogStats.pnl >= 0 ? "+" : ""
                }$${tradeLogStats.pnl.toFixed(2)} · Avg ${tradeLogStats.avgPnl >= 0 ? "+" : ""}$${tradeLogStats.avgPnl.toFixed(
                  2
                )} · Best asset ${tradeLogStats.bestAsset ?? "—"} · Best strategy ${tradeLogStats.bestStrategy ?? "—"}`
              : "Loading trade log stats..."}
          </p>
          <div className="max-h-[300px] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-[#0c0f14] text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-2">Time</th>
                  <th className="px-2 py-2">Asset</th>
                  <th className="px-2 py-2">Strategy</th>
                  <th className="px-2 py-2">Side</th>
                  <th className="px-2 py-2">Prob</th>
                  <th className="px-2 py-2">Entry</th>
                  <th className="px-2 py-2">Exit</th>
                  <th className="px-2 py-2">PnL</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[11px]">
                {tradeLogLoading ? (
                  <tr>
                    <td colSpan={8} className="px-2 py-4 text-slate-500">
                      Loading...
                    </td>
                  </tr>
                ) : tradeLogRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-2 py-4 text-slate-500">
                      No rows for this filter.
                    </td>
                  </tr>
                ) : (
                  tradeLogRows.map((r) => (
                    <tr key={r.id} className="border-b border-white/[0.04]">
                      <td className="px-2 py-2 text-slate-400">{new Date(r.timeIso).toLocaleString()}</td>
                      <td className="px-2 py-2 text-slate-300">{r.asset}</td>
                      <td className="px-2 py-2 text-slate-400">{r.strategy}</td>
                      <td className={`px-2 py-2 font-bold ${r.side === "UP" ? "text-emerald-400" : "text-rose-400"}`}>
                        {r.side === "UP" ? "YES" : "NO"}
                      </td>
                      <td className="px-2 py-2">{r.prob == null ? "—" : `${(r.prob * 100).toFixed(1)}%`}</td>
                      <td className="px-2 py-2">{(r.entry * 100).toFixed(2)}</td>
                      <td className="px-2 py-2 text-slate-400">{r.exit == null ? "—" : (r.exit * 100).toFixed(2)}</td>
                      <td className={`px-2 py-2 ${r.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(3)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card col-span-12 lg:col-span-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Recent sample trades</h3>
          </div>
          <div className="max-h-[320px] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-[#0c0f14] text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-2">Time</th>
                  <th className="px-2 py-2">Exec</th>
                  <th className="px-2 py-2">Asset</th>
                  <th className="px-2 py-2">Side</th>
                  <th className="px-2 py-2">UP@entry</th>
                  <th className="px-2 py-2">DN@entry</th>
                  <th className="px-2 py-2">In</th>
                  <th className="px-2 py-2">Out</th>
                  <th className="px-2 py-2">P&amp;L</th>
                  <th className="px-2 py-2">Reason</th>
                  <th className="px-2 py-2">Market</th>
                </tr>
              </thead>
              <tbody className="font-mono text-[11px]">
                {trades.map((t) => (
                  <tr key={t.id} className="border-b border-white/[0.04]">
                    <td className="px-2 py-2 text-slate-400">{t.time}</td>
                    <td className="px-2 py-2">
                      {(() => {
                        const em = tradeExecutionModeLabel(t, status?.mode);
                        return (
                          <span
                            className={
                              em === "PAPER"
                                ? "rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-200"
                                : "rounded bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-sky-200"
                            }
                          >
                            {em}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-2 py-2 font-semibold text-slate-300">{t.asset ?? "—"}</td>
                    <td className={`px-2 py-2 font-bold ${t.direction === "UP" ? "text-emerald-400" : "text-rose-400"}`}>
                      {t.direction === "UP" ? "YES" : "NO"}
                    </td>
                    <td className="px-2 py-2 text-emerald-300/90">{fmtEntryMidPct(t.upPriceAtEntry)}</td>
                    <td className="px-2 py-2 text-rose-300/90">{fmtEntryMidPct(t.downPriceAtEntry)}</td>
                    <td className="px-2 py-2">{tradeEntryFillPct(t)}</td>
                    <td className="px-2 py-2 text-slate-400">{tradeExitDisplayPct(t)}</td>
                    <td className={`px-2 py-2 ${formatTradePnlDisplay(t, 2).className}`}>
                      {formatTradePnlDisplay(t, 2).text}
                    </td>
                    <td className="max-w-[180px] truncate px-2 py-2 text-[10px] text-slate-500" title={tradeReasonSummary(t)}>
                      {tradeReasonSummary(t)}
                    </td>
                    <td className="px-2 py-2 text-slate-500">{t.market}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card col-span-12 lg:col-span-4 space-y-2">
          <h3 className="text-lg font-semibold">Stats</h3>
          <p>Win Rate: {fmtNum(stats.winRate, 2)}%</p>
          <p>Profit Factor: {Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "—"}</p>
          <p>
            Net P&amp;L: ${fmtNum(stats.net, 2)}
          </p>
          <p>Gross Win: ${stats.grossWin.toFixed(2)}</p>
          <p>Gross Loss: ${stats.grossLoss.toFixed(2)}</p>
          <div className="mt-3 rounded-lg bg-slate-900/70 p-2 text-xs">
            <p>Bot Activity Trades: {insights?.totalTrades ?? 0}</p>
            <p>No-Trade Signals: {insights?.noTradeSignals ?? 0}</p>
            <p>HighConf mid blocks (SIGNAL_MODE=highConf): {insights?.highConfMidBlocked ?? 0}</p>
            <p className="text-slate-400">
              BONE entry blocks — highConf: {insights?.boneEntryFilters?.highConf ?? 0}, eq:{" "}
              {insights?.boneEntryFilters?.equilibrium ?? 0}, longshot: {insights?.boneEntryFilters?.longshot ?? 0}, latency:{" "}
              {insights?.boneEntryFilters?.latency ?? 0}
            </p>
            {(insights?.marketWinRates ?? []).slice(0, 3).map((m, idx) => (
              <p key={m?.market ?? `mwr-${idx}`}>
                {m?.market ?? "—"}: {fmtNum(m?.winRate, 1)}% ({fmtNum(m?.trades, 0)})
              </p>
            ))}
          </div>
        </section>

        <section className="card col-span-12 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <h3 className="text-lg font-semibold">API connectivity</h3>
              <p className="max-w-3xl text-xs text-slate-400">
                Covers integrations used by this app: Gamma (tags, markets, events), Data API (activity, trades), CLOB REST (/,
                /time, public /book), <code className="text-slate-300">@polymarket/clob-client</code> book path via the engine,
                RTDS (shared socket, PING→PONG RTT — not a cold connect per refresh), optional{" "}
                <code className="text-slate-300">RPC_URL</code>, and Coinbase /
                Binance spot (BTC + ETH). Measured from the server. No login required.
              </p>
              {pingData ? (
                <p className="text-[11px] text-slate-500">
                  Last run: {new Date(pingData.ts).toLocaleString()} · {pingData.results.filter((r) => r.ok).length}/
                  {pingData.results.length} OK
                </p>
              ) : (
                <p className="text-[11px] text-slate-500">No results yet — press Refresh.</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void runConnectivityPings()}
              disabled={pingBusy}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pingBusy ? "Pinging…" : "Refresh"}
            </button>
          </div>
          <div className="max-h-[360px] overflow-auto rounded-lg border border-white/[0.06] bg-slate-950/60">
            {pingData && pingData.results.length > 0 ? (
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-[#0c0f14] text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Check</th>
                    <th className="px-3 py-2">Latency</th>
                    <th className="px-3 py-2">HTTP</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">URL / error</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-[11px]">
                  {pingData.results.map((r) => (
                    <tr key={r.id} className="border-b border-white/[0.04]">
                      <td className="px-3 py-2 text-slate-200">{r.label}</td>
                      <td className="px-3 py-2">{r.ms} ms</td>
                      <td className="px-3 py-2 text-slate-400">{r.httpStatus || "—"}</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            r.ok
                              ? "rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-400"
                              : "rounded bg-rose-500/20 px-1.5 py-0.5 text-rose-400"
                          }
                        >
                          {r.ok ? "OK" : "FAIL"}
                        </span>
                      </td>
                      <td className="max-w-[min(520px,50vw)] truncate px-3 py-2 text-slate-500" title={r.url}>
                        {r.error ?? r.note ?? r.url}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="p-4 text-sm text-slate-500">
                {pingBusy ? "Running checks (up to ~12s each)…" : "Click Refresh to measure endpoints from the server."}
              </p>
            )}
          </div>
        </section>

        <section className="card col-span-12 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <h3 className="text-lg font-semibold">Bet logs</h3>
              <p className="max-w-3xl text-xs text-slate-400">
                Demo and Real: each trade attempt records bid/ask, spread, liquidity, and mode. Live uses CLOB books; demo uses
                the same gates on the synthetic book. Prices are <strong className="text-slate-300">0–1 decimals</strong>, not
                cents.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => downloadBetLogsCsv(betLogs)}
                disabled={betLogs.length === 0}
                className="rounded bg-slate-600 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Download CSV
              </button>
              <button
                type="button"
                onClick={() => setBetLogs([])}
                className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-600"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="max-h-[420px] space-y-3 overflow-auto rounded-lg bg-slate-950/80 p-3">
            {betLogs.length === 0 ? (
              <p className="text-sm text-slate-500">
                No bet snapshots yet. Run the bot in Demo or Real: blocked trades and accepted orders both log a row here.
              </p>
            ) : (
              betLogs.map((b, idx) => (
                <div
                  key={`${b.ts}-${idx}`}
                  className={
                    "rounded-lg border p-3 font-mono text-xs leading-relaxed " +
                    (b.outcome === "placed"
                      ? "border-emerald-500/40 bg-emerald-950/20"
                      : "border-amber-500/35 bg-amber-950/15")
                  }
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                    <span>{new Date(b.ts).toLocaleString()}</span>
                    <span
                      className={
                        b.outcome === "placed"
                          ? "rounded bg-emerald-500/25 px-1.5 py-0.5 text-emerald-300"
                          : "rounded bg-amber-500/25 px-1.5 py-0.5 text-amber-200"
                      }
                    >
                      {b.outcome.toUpperCase()}
                    </span>
                    <span className="text-slate-300">Side {b.direction}</span>
                    <span
                      className={
                        (b.tradingMode ?? "LIVE") === "LIVE"
                          ? "rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-200"
                          : "rounded bg-sky-500/20 px-1.5 py-0.5 text-sky-200"
                      }
                    >
                      {(b.tradingMode ?? "LIVE") === "LIVE" ? "Real" : "Demo"}
                    </span>
                  </div>
                  <p>
                    <span className="text-slate-500">Market title</span>{" "}
                    <span className="text-slate-100">{b.marketTitle}</span>
                  </p>
                  <p className="break-all">
                    <span className="text-slate-500">Token ID</span>{" "}
                    <span className="text-sky-300/95">{b.tokenId}</span>
                  </p>
                  <p>
                    <span className="text-slate-500">Best bid</span>{" "}
                    <span className="text-slate-100">{fmtNum(b.bestBid, 4)}</span>
                    {" · "}
                    <span className="text-slate-500">Best ask</span>{" "}
                    <span className="text-slate-100">{fmtNum(b.bestAsk, 4)}</span>
                    {" · "}
                    <span className="text-slate-500">Computed spread</span>{" "}
                    <span className="text-slate-100">{fmtNum(b.spread, 4)}</span>
                    <span className="text-slate-500"> (= ask − bid)</span>
                  </p>
                  <p>
                    <span className="text-slate-500">Mid / liquidity</span>{" "}
                    <span className="text-slate-100">{fmtNum(b.mid, 4)}</span> ·{" "}
                    <span className="text-slate-100">{fmtNum(b.liquidity, 0)}</span>
                  </p>
                  <p>
                    <span className="text-slate-500">Time since market rollover</span>{" "}
                    <span className="text-slate-100">
                      {b.secondsSinceWindowStart == null
                        ? "unknown (manual token IDs or no window in slug)"
                        : `${b.secondsSinceWindowStart}s`}
                    </span>
                    {" · "}
                    <span className="text-slate-500">Post-rollover warm-up</span>{" "}
                    <span className={b.warmupWindow ? "text-amber-300" : "text-slate-300"}>
                      {b.warmupWindow ? "yes (within MARKET_WARMUP_SEC)" : "no"}
                    </span>
                  </p>
                  <p>
                    <span className="text-slate-500">Price unit</span>{" "}
                    <span className="text-slate-100">
                      {b.priceUnit === "decimal_0_1"
                        ? (b.tradingMode ?? "LIVE") === "SIMULATION"
                          ? "Demo: synthetic book; same 0–1 decimal convention as CLOB (not cents)."
                          : "Real: Polymarket CLOB 0–1 decimal prices (not cents); spread = ask − bid in those units."
                        : b.priceUnit}
                    </span>
                  </p>
                  {(b.blockReason || b.maxSpread != null || b.minLiquidity != null) && (
                    <p className="mt-2 border-t border-slate-700/80 pt-2 text-amber-200/90">
                      {b.blockReason && <span>{b.blockReason}</span>}
                      {b.maxSpread != null && (
                        <span>
                          {b.blockReason ? " · " : ""}
                          MAX_SPREAD threshold: {b.maxSpread}
                        </span>
                      )}
                      {b.minLiquidity != null && (
                        <span>
                          {(b.blockReason || b.maxSpread != null) && " · "}
                          MIN_LIQUIDITY threshold: {b.minLiquidity}
                        </span>
                      )}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="card col-span-12">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-semibold">Live Logs</h3>
            <button
              type="button"
              onClick={() => downloadLiveLogsCsv(logs)}
              disabled={logs.length === 0}
              className="rounded bg-slate-600 px-3 py-1.5 text-xs text-slate-100 hover:bg-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Download CSV
            </button>
          </div>
          <div className="max-h-[180px] overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-xs">
            {logs.map((l, idx) => (
              <div
                key={`${l.ts}-${idx}`}
                className={
                  l.level === "WIN"
                    ? "text-gain"
                    : l.level === "ERROR"
                      ? "text-loss"
                      : l.level === "SIGNAL"
                        ? "text-yellow-400"
                        : "text-sky-400"
                }
              >
                [{new Date(l.ts).toLocaleTimeString()}] {l.level}: {l.message}
              </div>
            ))}
          </div>
        </section>
          </div>
        )}
      </main>
      <p className="mx-auto max-w-[1800px] px-4 py-2 text-[10px] leading-snug text-slate-600 sm:px-6">
        PolyBot is self-hosted software provided as-is. Automated trading and prediction markets involve substantial risk;
        you are responsible for keys, configuration, and compliance with applicable law.
      </p>

      </div>

      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-snipe-border bg-snipe-sidebar/98 shadow-[0_-8px_32px_rgba(0,0,0,0.5)] backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-1 px-5 py-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-sky-300">API inspection (live)</h3>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500">UI = your clicks · API = backend response</span>
              <button
                type="button"
                onClick={() => setInspectionLogs([])}
                className="rounded bg-slate-700 px-2 py-0.5 text-[10px] text-slate-200 transition hover:bg-slate-600"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="max-h-36 overflow-auto rounded border border-slate-700 bg-slate-950/90 p-2 font-mono text-[11px] leading-relaxed">
            {inspectionLogs.length === 0 ? (
              <div className="text-slate-500">Waiting for clicks and API traffic… (Start/Stop Bot, market, Connect Polymarket)</div>
            ) : (
              inspectionLogs.map((line, idx) => (
                <div
                  key={`${line.ts}-${idx}`}
                  className={
                    line.kind === "api"
                      ? "text-emerald-300/95"
                      : "text-amber-200/90"
                  }
                >
                  [{new Date(line.ts).toLocaleTimeString()}]
                  <span className={line.kind === "api" ? " text-emerald-400/80" : " text-amber-400/80"}>
                    {" "}
                    {line.kind === "api" ? "API" : "UI"}{" "}
                  </span>
                  {line.text}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showWalletHelp ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wallet-help-title"
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-panel p-4">
            <h4 id="wallet-help-title" className="mb-2 text-lg font-semibold">
              Wallet Required
            </h4>
            <p className="mb-4 text-sm text-slate-300">
              MetaMask wallet extension was not detected. Install it, then retry login.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => window.open("https://metamask.io/download/", "_blank", "noopener,noreferrer")}
                className="flex-1 rounded-lg bg-sky-500/20 px-3 py-2 text-sm text-sky-300 transition hover:bg-sky-500/30"
              >
                Install MetaMask
              </button>
              <button
                type="button"
                onClick={async () => {
                  const ok = await connectAndLogin();
                  if (ok) setShowWalletHelp(false);
                }}
                className="flex-1 rounded-lg bg-gain/20 px-3 py-2 text-sm text-gain transition hover:bg-gain/30"
              >
                Retry Login
              </button>
            </div>
            <button
              type="button"
              onClick={() => setShowWalletHelp(false)}
              className="mt-3 w-full rounded-lg bg-slate-700 py-2 text-sm transition hover:bg-slate-600"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
      {showPasswordLogin ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="login-dialog-title"
        >
          <div className="w-full max-w-md rounded-2xl bg-gradient-to-br from-snipe-accent/25 via-snipe-border to-transparent p-[1px] shadow-[0_0_60px_rgba(52,211,153,0.12)]">
            <div className="rounded-2xl border border-snipe-border bg-[#0d1118] px-8 py-8">
            <div className="mb-1 flex items-center gap-2">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden className="text-snipe-accent">
                <path
                  d="M13 2L3 14h8l-1 8 10-12h-8l1-8z"
                  fill="currentColor"
                  opacity="0.95"
                />
              </svg>
              <span id="login-dialog-title" className="font-display text-2xl font-bold tracking-tight">
                <span className="text-snipe-accent">Poly</span>
                <span className="text-[#e2e8f0]">Bot</span>
              </span>
            </div>
            <p className="mb-6 text-sm text-slate-500">Authorized buyer access only.</p>
            <div className="mb-6 inline-flex rounded-full border border-snipe-accent/60 bg-snipe-accent/10 px-3 py-1.5">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-snipe-accent">Secure local login</span>
            </div>
            <div className="mb-4">
              <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-500">User ID</label>
              <input
                value={userIdInput}
                onChange={(e) => setUserIdInput(e.target.value)}
                placeholder="APP_USER_ID from server/.env"
                className="w-full rounded-xl border border-snipe-border bg-[#080a0f] px-4 py-3 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-snipe-accent/50 focus:ring-2 focus:ring-snipe-accent/25"
              />
            </div>
            <div className="mb-6">
              <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-500">Password</label>
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Enter dashboard password"
                className="w-full rounded-xl border border-snipe-border bg-[#080a0f] px-4 py-3 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-snipe-accent/50 focus:ring-2 focus:ring-snipe-accent/25"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void passwordLogin();
                }}
              />
            </div>
            <button
              type="button"
              onClick={signInAndConnectPolymarket}
              className="mb-4 w-full rounded-xl bg-snipe-accent py-3.5 text-base font-bold text-[#061016] shadow-lg shadow-snipe-accent/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isAuthenticating || isPolyConnecting}
            >
              {isAuthenticating || isPolyConnecting ? "Working…" : "Sign In"}
            </button>
            <p className="mb-4 text-center text-[11px] leading-relaxed text-slate-600">
              If sign-in is locked after repeated failures, restart the bot process to clear the lockout.
            </p>
            <div className="flex flex-wrap gap-2 border-t border-snipe-border/80 pt-4">
              <button
                type="button"
                onClick={passwordLogin}
                className="flex-1 rounded-lg bg-snipe-panel px-3 py-2 text-xs font-medium text-slate-300 ring-1 ring-snipe-border transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isAuthenticating || isPolyConnecting}
              >
                Sign in only
              </button>
              <button
                type="button"
                onClick={refreshPolymarketAccount}
                className="flex-1 rounded-lg bg-snipe-panel px-3 py-2 text-xs font-medium text-snipe-accent ring-1 ring-snipe-accent/30 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isPolyConnecting || !isLoggedIn}
              >
                {isPolyConnecting ? "…" : "Refresh Polymarket"}
              </button>
              <button
                type="button"
                onClick={() => setShowPasswordLogin(false)}
                className="rounded-lg bg-snipe-panel px-3 py-2 text-xs text-slate-500 ring-1 ring-snipe-border transition hover:bg-slate-800 hover:text-slate-300"
              >
                Close
              </button>
            </div>
            {polyAccount ? (
              <div className="mt-3 rounded-lg border border-slate-700 bg-slate-900/70 p-3 text-xs text-slate-200">
                <p>Status: {polyAccount.connected ? "Connected" : "Disconnected"}</p>
                <p>Mode: {polyAccount.mode}</p>
                <p>Address: {polyAccount.address ?? "-"}</p>
                <p>
                  Polymarket USDC (CLOB):{" "}
                  {polyAccount.polymarketUsdc != null
                    ? `$${Number(polyAccount.polymarketUsdc).toFixed(2)} (server)`
                    : "—"}
                  {metaMaskPolymarketUsdc != null ? ` | MetaMask read: $${metaMaskPolymarketUsdc.toFixed(2)}` : ""}
                </p>
                <p>Open Orders: {polyAccount.openOrdersCount}</p>
                <p>User Trades: {polyAccount.userTradesCount}</p>
                <p className="mt-1 break-all text-slate-400">
                  Balance/Allowance: {JSON.stringify(polyAccount.balanceAllowanceRaw)}
                </p>
              </div>
            ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
