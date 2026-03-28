import { useEffect, useMemo, useRef, useState } from "react";
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
  Direction,
  Insights,
  MarketOption,
  MarketPoint,
  Mode,
  PolymarketAccountSummary,
  Prediction,
  Trade,
  TradingState,
  WalletSummary
} from "./types";

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

function calcStats(trades: Trade[]) {
  const wins = trades.filter((t) => t.status === "WIN");
  const losses = trades.filter((t) => t.status === "LOSS");
  const grossWin = wins.reduce((a, b) => a + Math.max(0, b.pnl), 0);
  const grossLoss = losses.reduce((a, b) => a + Math.abs(Math.min(0, b.pnl)), 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin;
  const net = trades.reduce((a, b) => a + b.pnl, 0);
  return { winRate, profitFactor, net, grossWin, grossLoss };
}

/** Polymarket-style right-axis ticks in $25 steps. */
const Y_TICK_USD = 25;

function buildYTicksUsd25(points: MarketPoint[], anchorUsd?: number | null): number[] {
  const prices = points.map((p) => p.btcUsd).filter((v): v is number => v != null && Number.isFinite(v));
  if (prices.length === 0) return [];
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (typeof anchorUsd === "number" && Number.isFinite(anchorUsd)) {
    min = Math.min(min, anchorUsd);
    max = Math.max(max, anchorUsd);
  }
  const pad = 100;
  const low = Math.floor((min - pad) / Y_TICK_USD) * Y_TICK_USD;
  const high = Math.ceil((max + pad) / Y_TICK_USD) * Y_TICK_USD;
  const ticks: number[] = [];
  for (let t = low; t <= high; t += Y_TICK_USD) ticks.push(t);
  return ticks;
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
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [betLogs, setBetLogs] = useState<BetLogEntry[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [wallet, setWallet] = useState<WalletSummary | null>(null);
  const [amount, setAmount] = useState(1);
  const [historyFilter, setHistoryFilter] = useState<"ALL" | "WIN" | "LOSS">("ALL");
  const [loadingTrade, setLoadingTrade] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [markets, setMarkets] = useState<MarketOption[]>([]);
  const [selectedTokenID, setSelectedTokenID] = useState("");
  const [insights, setInsights] = useState<Insights | null>(null);
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
  const [metaMaskOrderBusy, setMetaMaskOrderBusy] = useState(false);
  const [metaMaskConnected, setMetaMaskConnected] = useState(false);
  const [metaMaskAddress, setMetaMaskAddress] = useState<string | null>(null);
  const [metaMaskAutoEnabled, setMetaMaskAutoEnabled] = useState(true);
  const lastAutoMetaMaskTsRef = useRef(0);
  const lastMetaMaskTradeIdRef = useRef<string | null>(null);
  const mmAutoExitAbortRef = useRef<AbortController | null>(null);
  const [metaMaskPolymarketUsdc, setMetaMaskPolymarketUsdc] = useState<number | null>(null);
  const [metaMaskUsdcLoading, setMetaMaskUsdcLoading] = useState(false);
  const [capitalPctPerEntry, setCapitalPctPerEntry] = useState<number>(10);
  const [amountSource, setAmountSource] = useState<"PERCENT" | "MANUAL">("MANUAL");

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
  const lastMetaMaskBalanceGateLogRef = useRef(0);
  const pushLog = (level: LogLevel, message: string) => {
    setLogs((prev) => [{ ts: Date.now(), level, message }, ...prev].slice(0, 120));
  };
  const pushInspectionUi = (text: string) => {
    setInspectionLogs((prev) => [{ ts: Date.now(), kind: "ui" as const, text }, ...prev].slice(0, 400));
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

  const expected = useMemo(() => {
    const conf = prediction?.confidence ?? 0;
    const profit = amount * (conf / 100);
    const loss = amount * ((100 - conf) / 100);
    return { profit, loss };
  }, [amount, prediction]);

  const stats = useMemo(() => calcStats(trades), [trades]);
  const filteredTrades = useMemo(
    () => (historyFilter === "ALL" ? trades : trades.filter((t) => t.status === historyFilter)),
    [historyFilter, trades]
  );
  const chartTargetUsd = chartData[chartData.length - 1]?.btcTargetUsd;
  const chartYTicks = useMemo(
    () => buildYTicksUsd25(chartData, chartTargetUsd ?? null),
    [chartData, chartTargetUsd]
  );
  const chartXTickTimes = useMemo(() => buildXTickTimes(chartData, 12), [chartData]);
  const chartYDomain = useMemo((): [number, number] | undefined => {
    if (chartYTicks.length < 2) return undefined;
    return [chartYTicks[0], chartYTicks[chartYTicks.length - 1]];
  }, [chartYTicks]);

  const suggestion = useMemo(() => {
    const conf = prediction?.confidence ?? 0;
    const pred = prediction?.prediction ?? "UP";
    if (prediction?.recommendation === "NO_TRADE") {
      return `No trade now: ${prediction.reason ?? "risk filter active"}.`;
    }

    if (chartData.length < 3) {
      return "Waiting for live BTC data to generate investment suggestion.";
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
        return `BTC moved down ($${delta.toFixed(2)} over recent ticks). Suggestion: invest on DOWN.`;
      }
      if (delta >= 12) {
        return `BTC moved up (+$${delta.toFixed(2)} over recent ticks). Suggestion: invest on UP.`;
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
  }, [prediction, chartData]);
  const selectedMarketLabel = useMemo(
    () => markets.find((m) => m.tokenID === selectedTokenID)?.label ?? "BTC 5s Market",
    [markets, selectedTokenID]
  );
  const portfolioData = useMemo(() => {
    if (!status) return [];
    const ordered = [...trades].reverse();
    const realizedPnl = ordered.reduce((sum, t) => sum + (t.status === "PENDING" ? 0 : t.pnl), 0);
    let balance = status.balance - realizedPnl;
    const now = Date.now();
    return ordered.map((t, idx) => {
      if (t.status !== "PENDING") balance += t.pnl;
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
      const [s, t, w, m, i] = await Promise.all([api.status(), api.trades(), api.wallet(), api.markets(), api.insights()]);
      setStatus(s);
      setTrades(t);
      setWallet(w);
      setMarkets(m);
      setSelectedTokenID(m[0]?.tokenID ?? "");
      setInsights(i);
      try {
        const me = await api.authMe();
        if (me.authenticated) {
          if (me.authType === "wallet" && me.address) setWalletAddress(me.address);
          if (me.authType === "password" && me.userId) setWalletAddress(`user:${me.userId}`);
          setIsLoggedIn(true);
          setLoginHint("Logged in and ready to invest.");
        } else {
          localStorage.removeItem("polybot_auth_token");
          setIsLoggedIn(false);
          setLoginHint("Session mismatch. Reconnect your allowed wallet.");
        }
      } catch {
        localStorage.removeItem("polybot_auth_token");
        setIsLoggedIn(false);
        setLoginHint("Login required before investing.");
      }
    };
    loadInitial().catch(console.error);
  }, []);

  useEffect(() => {
    api
      .betLogs()
      .then(setBetLogs)
      .catch(() => setBetLogs([]));
  }, []);

  useEffect(() => {
    const tick = () => api.tradingState().then(setTradingState).catch(() => undefined);
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (status?.mode !== "LIVE") return;
    const refreshPm = () => api.wallet().then(setWallet).catch(() => undefined);
    refreshPm();
    const id = setInterval(refreshPm, 15000);
    return () => clearInterval(id);
  }, [status?.mode]);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "market") setChartData(msg.payload);
      if (msg.type === "prediction") setPrediction(msg.payload);
      if (msg.type === "trade") setTrades(msg.payload);
      if (msg.type === "trade") api.insights().then(setInsights).catch(() => undefined);
      if (msg.type === "status") {
        setStatus(msg.payload);
        if (msg.payload?.mode === "LIVE") {
          api.wallet().then(setWallet).catch(() => undefined);
        }
      }
      if (msg.type === "log") setLogs((prev) => [msg.payload, ...prev].slice(0, 120));
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

  const doTrade = async () => {
    pushLog("SIGNAL", "Auto-only mode enabled. Use Start Bot to let strategy place entries.");
  };

  const MIN_TRADE_USD = 1;

  /** MetaMask CLOB: size to available − reservations, post order, poll fill, confirm trade on server. */
  const placeBetMetaMask = async (direction: "UP" | "DOWN", tradeId: string) => {
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
      let effAmount = Math.min(amount, budget.availableUsdc * 0.998);
      effAmount = Math.max(0, Number(effAmount.toFixed(2)));
      pushInspectionUi(
        `UI: MetaMask collateral — balance $${budget.balanceUsdc.toFixed(2)} | reserved $${budget.reservedUsdc.toFixed(2)} | available $${budget.availableUsdc.toFixed(2)} → size $${effAmount}`
      );
      if (effAmount < MIN_TRADE_USD) {
        pushLog(
          "ERROR",
          `MetaMask: available USDC after open orders ($${budget.availableUsdc.toFixed(2)}) below min $${MIN_TRADE_USD}`
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
          let eff2 = Math.min(amount, budget2.availableUsdc * 0.998);
          eff2 = Math.max(0, Number(eff2.toFixed(2)));
          if (eff2 < MIN_TRADE_USD) throw new Error("Available USDC still below min after re-approve");
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
      const s = await api.status();
      setStatus(s);
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
      pushLog("TRADE", "Bot started: directional momentum auto-trading active.");
      setLoginHint("Bot is running. Auto-investing with momentum strategy.");
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
    const pending = trades.find((t) => t.status === "PENDING");
    if (!pending) return;
    if (pending.id && pending.id === lastMetaMaskTradeIdRef.current) return;
    lastMetaMaskTradeIdRef.current = pending.id ?? null;
    void placeBetMetaMask(pending.direction, pending.id);
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
      pushLog("ERROR", "Bot stopped.");
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

  const badgeClass = (badge: string) => {
    if (badge === "tradable") return "bg-emerald-500/25 text-emerald-200";
    if (badge === "wide_spread") return "bg-amber-500/25 text-amber-200";
    if (badge === "extreme_quotes") return "bg-orange-500/25 text-orange-200";
    if (badge === "low_liquidity") return "bg-rose-500/25 text-rose-200";
    if (badge === "no_book") return "bg-slate-600 text-slate-300";
    return "bg-slate-600 text-slate-300";
  };

  const setTradingMode = async (target: Mode) => {
    if (!isLoggedIn) {
      pushLog("ERROR", "Login to switch between Demo and Real.");
      setLoginHint("Sign in first, then choose Demo (paper) or Real (Polymarket CLOB).");
      return;
    }
    if (status?.mode === target) return;
    setModeToggleLoading(true);
    pushInspectionUi(`Mode → POST /api/mode (${target})`);
    try {
      const r = await api.setMode(target);
      const [s, m, w, ts] = await Promise.all([
        api.status(),
        api.markets(),
        api.wallet(),
        api.tradingState()
      ]);
      setStatus(s);
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

  return (
    <div className="min-h-screen bg-bg pb-44 text-slate-200">
      <header className="border-b border-slate-700 bg-[#111a2e]/90 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="text-xl font-bold">PolyBot</div>
            <input className="rounded-lg bg-panel px-3 py-2 text-sm outline-none" placeholder="Search markets" />
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">Trading mode</span>
              <div className="flex items-center gap-1 rounded-lg border border-slate-600 bg-slate-800/90 p-0.5">
                <button
                  type="button"
                  disabled={!isLoggedIn || modeToggleLoading}
                  onClick={() => void setTradingMode("SIMULATION")}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition ${
                    status?.mode !== "LIVE"
                      ? "bg-sky-600 text-white shadow"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  Demo
                </button>
                <button
                  type="button"
                  disabled={!isLoggedIn || modeToggleLoading}
                  onClick={() => {
                    if (metaMaskAutoEnabled) {
                      pushInspectionUi(
                        "UI: Real mode blocked while MetaMask auto-trading is ON. Turn it off to let the server place LIVE orders."
                      );
                      pushLog(
                        "ERROR",
                        "Turn off “Auto place trades from MetaMask” to enable Real mode (server LIVE execution)."
                      );
                      return;
                    }
                    void setTradingMode("LIVE");
                  }}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition ${
                    status?.mode === "LIVE"
                      ? "bg-amber-600 text-white shadow"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                  title="Real = server places Polymarket CLOB orders (requires server LIVE keys)."
                >
                  {modeToggleLoading ? "…" : "Real"}
                </button>
              </div>
            </div>
            <div className={`rounded px-2 py-1 text-xs ${wsConnected ? "bg-gain/20 text-gain" : "bg-loss/20 text-loss"}`}>
              {wsConnected ? "Backend Connected" : "Backend Disconnected"}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-lg bg-panel px-3 py-2 text-sm">
              Bot balance: ${status?.balance.toFixed(2) ?? "0.00"}
            </div>
            <div
              className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-200"
              title={
                headerPolymarketUsdc
                  ? `CLOB collateral (LIVE uses server read when available). ${headerPolymarketUsdc.hint ?? ""} Funder: ${funderDisplay}`
                  : `USDC on Polymarket CLOB (funder ${funderDisplay})`
              }
            >
              Polymarket USDC:{" "}
              {headerPolymarketUsdc
                ? `$${headerPolymarketUsdc.value.toFixed(2)}`
                : status?.mode === "LIVE"
                  ? metaMaskUsdcLoading
                    ? "…"
                    : "—"
                  : "—"}
            </div>
            <button className="rounded-lg bg-gain/20 px-3 py-2 text-sm text-gain">Deposit</button>
            <button
              onClick={() => setShowPasswordLogin(true)}
              className="rounded-lg bg-sky-500/20 px-3 py-2 text-sm text-sky-300 transition hover:bg-sky-500/30"
            >
              {isAuthenticating
                ? "Signing..."
                : isLoggedIn && walletAddress
                  ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
                  : "User Login"}
            </button>
          </div>
        </div>
      </header>

      {tradingState ? (
        <div className="border-b border-slate-700 bg-[#0d1520] px-4 py-2.5 text-center text-sm">
          <span
            className={
              tradingState.executionLabel === "LIVE_ONLY"
                ? "font-semibold text-amber-300"
                : "font-semibold text-sky-300"
            }
          >
            Current execution:{" "}
            {tradingState.executionLabel === "LIVE_ONLY"
              ? "LIVE ONLY — orders can go to Polymarket CLOB"
              : "PAPER ONLY — simulated balance, no live orders"}
          </span>
        </div>
      ) : null}

      <main className="mx-auto grid max-w-[1400px] grid-cols-12 gap-4 p-4">
        <section className="card col-span-12 grid gap-3 md:grid-cols-2">
          <div className="space-y-2 rounded-lg border border-slate-700/80 bg-slate-900/40 p-3">
            <h3 className="text-sm font-semibold text-slate-200">Market window & books</h3>
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
                    <span className={badgeClass(tradingState.books.up?.badge ?? "no_book")}>
                      {tradingState.books.up?.badge ?? "no_book"}
                    </span>
                    <span className="ml-2 text-slate-400">
                      spread {tradingState.books.up?.spread?.toFixed(4) ?? "—"}
                    </span>
                  </div>
                  <div className="rounded border border-slate-700 p-2">
                    <div className="mb-1 font-medium text-slate-300">DOWN</div>
                    <span className={badgeClass(tradingState.books.down?.badge ?? "no_book")}>
                      {tradingState.books.down?.badge ?? "no_book"}
                    </span>
                    <span className="ml-2 text-slate-400">
                      spread {tradingState.books.down?.spread?.toFixed(4) ?? "—"}
                    </span>
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

        <section className="card col-span-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{selectedMarketLabel}</h2>
            <div className="flex items-center gap-2">
              <select
                value={selectedTokenID}
                onChange={(e) => onSelectMarket(e.target.value)}
                className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-100 outline-none"
              >
                {markets.map((m) => (
                  <option key={m.tokenID} value={m.tokenID}>
                    {m.label}
                  </option>
                ))}
              </select>
              <div className="rounded bg-slate-700 px-2 py-1 text-xs">
                Prediction: {prediction?.prediction ?? "--"} ({prediction?.confidence ?? 0}%)
              </div>
            </div>
          </div>
          {(() => {
            const last = chartData[chartData.length - 1];
            return last?.btcUsd != null ? (
              <div className="mb-2 flex flex-wrap items-baseline gap-3 text-sm">
                <span className="text-2xl font-semibold tracking-tight text-white">
                  ${last.btcUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                {last.btcTargetUsd != null && (
                  <>
                    <span className="text-slate-500">Target</span>
                    <span className="font-mono text-slate-200">
                      ${last.btcTargetUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span
                      className={
                        last.btcUsd - last.btcTargetUsd >= 0 ? "font-medium text-emerald-400" : "font-medium text-rose-400"
                      }
                    >
                      {last.btcUsd - last.btcTargetUsd >= 0 ? "+" : ""}$
                      {(last.btcUsd - last.btcTargetUsd).toFixed(2)}
                    </span>
                  </>
                )}
              </div>
            ) : null;
          })()}
          {chartData.length > 0 && chartData.some((p) => p.btcUsd != null) ? (
            <div className="h-[360px] rounded-lg bg-[#0f1114]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 10, right: 52, left: 4, bottom: 8 }}
                >
                  <CartesianGrid stroke="#1a1d22" strokeOpacity={0.9} vertical={false} />
                  <XAxis
                    dataKey="time"
                    stroke="#52525b"
                    tick={{ fill: "#a1a1aa", fontSize: 11 }}
                    ticks={chartXTickTimes}
                    interval={0}
                  />
                  <YAxis
                    orientation="right"
                    stroke="#52525b"
                    tick={{ fill: "#a1a1aa", fontSize: 11 }}
                    ticks={chartYTicks}
                    domain={chartYDomain ?? ["auto", "auto"]}
                    tickFormatter={(v) =>
                      typeof v === "number"
                        ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                        : String(v)
                    }
                    width={64}
                  />
                  {chartData[chartData.length - 1]?.btcTargetUsd != null && (
                    <ReferenceLine
                      y={chartData[chartData.length - 1]!.btcTargetUsd}
                      stroke="rgba(255,255,255,0.88)"
                      strokeDasharray="4 4"
                      label={{
                        value: "Target",
                        position: "right",
                        fill: "#cbd5e1",
                        fontSize: 11,
                        fontWeight: 500
                      }}
                    />
                  )}
                  <Tooltip
                    contentStyle={{ background: "#1a1d23", border: "1px solid #334155", borderRadius: 8 }}
                    formatter={(v: number | string) => [
                      typeof v === "number"
                        ? `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : v,
                      "BTC"
                    ]}
                    labelFormatter={(l) => String(l)}
                  />
                  <Line
                    type="monotone"
                    dataKey="btcUsd"
                    stroke="#F7931A"
                    strokeWidth={2}
                    dot={(props: { cx?: number; cy?: number; index?: number }) => {
                      const { cx, cy, index } = props;
                      if (cx == null || cy == null || index !== chartData.length - 1) return <g />;
                      return <circle cx={cx} cy={cy} r={4} fill="#F7931A" stroke="#F7931A" />;
                    }}
                    activeDot={{ r: 5, fill: "#F7931A", stroke: "#fff", strokeWidth: 1 }}
                    isAnimationActive={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-[360px] items-center justify-center rounded-lg bg-[#0f1114] text-sm text-slate-500">
              Loading live BTC/USD spot…
            </div>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            Updates every ~4s (Polymarket-style cadence). Spot from Coinbase / Binance fallback; axis ticks in $25 steps. Polymarket
            resolution may use a different oracle than this line.
          </p>
        </section>

        <aside className="card col-span-4 space-y-3">
          <h3 className="text-lg font-semibold">Buy / Sell</h3>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={startBot}
              className="rounded-lg bg-gain/20 py-2 text-xs font-semibold text-gain transition hover:bg-gain/30"
            >
              Start Bot
            </button>
            <button
              onClick={stopBot}
              className="rounded-lg bg-loss/20 py-2 text-xs font-semibold text-loss transition hover:bg-loss/30"
            >
              Stop Bot
            </button>
          </div>
          <div className="text-xs text-slate-300">
            Bot State: {status?.running ? "Running" : "Stopped"} | Auto: {status?.autoTrading ? "ON" : "OFF"} | Phase:{" "}
            <span className="font-medium text-slate-100">{status?.phase ?? "—"}</span>
            {status?.phaseReason ? (
              <span className="text-slate-400"> — {status.phaseReason}</span>
            ) : null}
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200">
            Direction is auto-selected by bot strategy (momentum + orderbook + signal).
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-slate-400">% of capital per entry</span>
              <select
                value={capitalPctPerEntry}
                onChange={(e) => {
                  setCapitalPctPerEntry(Number(e.target.value));
                  setAmountSource("PERCENT");
                }}
                className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-100 outline-none"
              >
                {([1, 2, 5, 10, 15, 20, 25, 33, 50] as const).map((p) => (
                  <option key={p} value={p}>
                    {p}%
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[11px] text-slate-500">
              Capital available: ${capitalUsd.toFixed(2)} → recommended bet: $
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
              className="w-full rounded-lg bg-slate-800 px-3 py-2"
            />
            <p className="text-[11px] text-slate-500">
              {amountSource === "PERCENT" ? "Auto-calculated (editing switches to manual)." : "Manual override."}
            </p>
          </div>
          <div className="rounded-lg bg-slate-800 p-3 text-sm">
            <p>You can earn ${expected.profit.toFixed(2)} in 5 seconds</p>
            <p className="text-loss">You can lose ${expected.loss.toFixed(2)}</p>
          </div>
          <button
            disabled
            onClick={doTrade}
            className="w-full rounded-lg bg-indigo-500 py-2 transition disabled:opacity-50"
          >
            Auto-only mode
          </button>
          <div className="space-y-2 rounded-lg border border-sky-800/60 bg-sky-950/30 px-3 py-2">
            <p className="text-xs font-medium text-sky-200">MetaMask Auto-Trading</p>
            <p className="text-[11px] leading-snug text-slate-400">
              One click to connect MetaMask, then press Start Bot. New TRADE signals are posted automatically from your MetaMask
              account (Polygon).
            </p>
            <button
              type="button"
              disabled={metaMaskOrderBusy}
              onClick={() => void connectMetaMaskTrading()}
              className="w-full rounded-lg bg-sky-600 py-2 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:opacity-50"
            >
              {metaMaskConnected ? `MetaMask Connected (${metaMaskAddress?.slice(0, 6)}...${metaMaskAddress?.slice(-4)})` : "Connect MetaMask"}
            </button>
            <label className="flex items-center justify-between rounded bg-slate-900/60 px-2 py-2 text-xs text-slate-200">
              <span>Auto place trades from MetaMask</span>
              <input
                type="checkbox"
                checked={metaMaskAutoEnabled}
                onChange={(e) => setMetaMaskAutoEnabled(e.target.checked)}
              />
            </label>
            <p className="text-[11px] text-slate-500">
              When enabled, Start Bot runs strategy on server and places real CLOB orders through your browser wallet.
            </p>
          </div>
          <p className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200">
            Bot Suggestion: {suggestion}
          </p>
          <p className={`text-xs ${prediction?.recommendation === "NO_TRADE" ? "text-yellow-300" : "text-gain"}`}>
            Strategy: {prediction?.recommendation ?? "TRADE"} {prediction?.reason ? `- ${prediction.reason}` : ""}
          </p>
          <div className="text-xs text-slate-400">
            Mode: {status?.mode ?? "SIMULATION"} | CLOB: {wallet?.connected ? "Connected" : "Not connected"}
            {wallet?.polymarketUsdc != null ? ` | Server CLOB $${wallet.polymarketUsdc.toFixed(2)}` : ""}
            {metaMaskPolymarketUsdc != null ? ` | MetaMask $${metaMaskPolymarketUsdc.toFixed(2)}` : ""}
          </div>
          <div className={`text-xs ${isLoggedIn ? "text-gain" : "text-yellow-300"}`}>{loginHint}</div>
        </aside>

        <section className="card col-span-12">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-lg font-semibold">Account Portfolio</h3>
            <div className="flex items-center gap-2">
              {(["1m", "1h", "day", "month", "year"] as const).map((range) => (
                <button
                  key={range}
                  onClick={() => setPortfolioRange(range)}
                  className={`rounded px-2 py-1 text-xs ${
                    portfolioRange === range ? "bg-sky-500/30 text-sky-200" : "bg-slate-700 text-slate-200"
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>
          </div>
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={filteredPortfolioData}>
                <CartesianGrid stroke="#334155" />
                <XAxis dataKey="ts" stroke="#94a3b8" type="number" tickFormatter={formatPortfolioTick} domain={["dataMin", "dataMax"]} />
                <YAxis stroke="#94a3b8" />
                <Tooltip
                  formatter={(value: number, name: string) =>
                    name === "balance" ? [`$${value.toFixed(2)}`, "Balance"] : [value, name]
                  }
                  labelFormatter={(label) => new Date(Number(label)).toLocaleString()}
                />
                <Line
                  type="monotone"
                  dataKey="balance"
                  stroke="#60a5fa"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card col-span-8">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-lg font-semibold">Order History</h3>
            <div className="flex gap-2">
              {(["ALL", "WIN", "LOSS"] as const).map((f) => (
                <button key={f} onClick={() => setHistoryFilter(f)} className="rounded bg-slate-700 px-2 py-1 text-xs">
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-[260px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-slate-400">
                <tr>
                  <th>Time</th>
                  <th>Market</th>
                  <th>Price</th>
                  <th>Amount</th>
                  <th>P&L</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredTrades.map((t) => (
                  <tr key={t.id}>
                    <td>{t.time}</td>
                    <td>{t.market}</td>
                    <td>{t.price.toFixed(3)}</td>
                    <td>${t.amount.toFixed(2)}</td>
                    <td className={t.pnl >= 0 ? "text-gain" : "text-loss"}>{t.pnl.toFixed(2)}</td>
                    <td>{t.status}</td>
                    <td className="max-w-[240px] truncate text-xs text-slate-300">{t.decisionReason ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card col-span-4 space-y-2">
          <h3 className="text-lg font-semibold">Stats</h3>
          <p>Win Rate: {stats.winRate.toFixed(2)}%</p>
          <p>Profit Factor: {stats.profitFactor.toFixed(2)}</p>
          <p>Net P&L: ${stats.net.toFixed(2)}</p>
          <p>Gross Win: ${stats.grossWin.toFixed(2)}</p>
          <p>Gross Loss: ${stats.grossLoss.toFixed(2)}</p>
          <div className="mt-3 rounded-lg bg-slate-900/70 p-2 text-xs">
            <p>Bot Activity Trades: {insights?.totalTrades ?? 0}</p>
            <p>No-Trade Signals: {insights?.noTradeSignals ?? 0}</p>
            {(insights?.marketWinRates ?? []).slice(0, 3).map((m) => (
              <p key={m.market}>
                {m.market}: {m.winRate.toFixed(1)}% ({m.trades})
              </p>
            ))}
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
                    <span className="text-slate-100">{b.bestBid.toFixed(4)}</span>
                    {" · "}
                    <span className="text-slate-500">Best ask</span>{" "}
                    <span className="text-slate-100">{b.bestAsk.toFixed(4)}</span>
                    {" · "}
                    <span className="text-slate-500">Computed spread</span>{" "}
                    <span className="text-slate-100">{b.spread.toFixed(4)}</span>
                    <span className="text-slate-500"> (= ask − bid)</span>
                  </p>
                  <p>
                    <span className="text-slate-500">Mid / liquidity</span>{" "}
                    <span className="text-slate-100">{b.mid.toFixed(4)}</span> ·{" "}
                    <span className="text-slate-100">{b.liquidity.toFixed(0)}</span>
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
      </main>

      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-600 bg-[#0b1220]/98 shadow-[0_-4px_24px_rgba(0,0,0,0.35)] backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-1 px-4 py-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-sky-300">API inspection (live)</h3>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500">UI = your clicks · API = backend response</span>
              <button
                type="button"
                onClick={() => setInspectionLogs([])}
                className="rounded bg-slate-700 px-2 py-0.5 text-[10px] text-slate-200 hover:bg-slate-600"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-panel p-4">
            <h4 className="mb-2 text-lg font-semibold">Wallet Required</h4>
            <p className="mb-4 text-sm text-slate-300">
              MetaMask wallet extension was not detected. Install it, then retry login.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => window.open("https://metamask.io/download/", "_blank", "noopener,noreferrer")}
                className="flex-1 rounded-lg bg-sky-500/20 px-3 py-2 text-sm text-sky-300"
              >
                Install MetaMask
              </button>
              <button
                onClick={async () => {
                  const ok = await connectAndLogin();
                  if (ok) setShowWalletHelp(false);
                }}
                className="flex-1 rounded-lg bg-gain/20 px-3 py-2 text-sm text-gain"
              >
                Retry Login
              </button>
            </div>
            <button onClick={() => setShowWalletHelp(false)} className="mt-3 w-full rounded-lg bg-slate-700 py-2 text-sm">
              Close
            </button>
          </div>
        </div>
      ) : null}
      {showPasswordLogin ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-panel p-4">
            <h4 className="mb-2 text-lg font-semibold">User login → Polymarket</h4>
            <p className="mb-3 text-sm text-slate-300">
              Enter <strong>APP_USER_ID</strong> and <strong>APP_PASSWORD</strong> from <code className="text-sky-300">server/.env</code>.
              This unlocks the dashboard. The same button then loads your <strong>Polymarket CLOB</strong> balance and orders using the
              wallet configured on the server (not polymarket.com email login).
            </p>
            <input
              value={userIdInput}
              onChange={(e) => setUserIdInput(e.target.value)}
              placeholder="User ID"
              className="mb-2 w-full rounded-lg bg-slate-800 px-3 py-2 text-sm outline-none"
            />
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Password"
              className="mb-3 w-full rounded-lg bg-slate-800 px-3 py-2 text-sm outline-none"
            />
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={signInAndConnectPolymarket}
                className="w-full rounded-lg bg-sky-500/30 px-3 py-2.5 text-sm font-semibold text-sky-100 transition hover:bg-sky-500/40"
                disabled={isAuthenticating || isPolyConnecting}
              >
                {isAuthenticating || isPolyConnecting ? "Working…" : "Sign in & connect Polymarket"}
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={passwordLogin}
                  className="flex-1 rounded-lg bg-slate-700 px-3 py-2 text-xs text-slate-200"
                  disabled={isAuthenticating || isPolyConnecting}
                >
                  Sign in only
                </button>
                <button
                  type="button"
                  onClick={refreshPolymarketAccount}
                  className="flex-1 rounded-lg bg-gain/15 px-3 py-2 text-xs text-gain"
                  disabled={isPolyConnecting || !isLoggedIn}
                >
                  {isPolyConnecting ? "…" : "Refresh Polymarket"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowPasswordLogin(false)}
                  className="flex-1 rounded-lg bg-slate-700 px-3 py-2 text-xs"
                >
                  Close
                </button>
              </div>
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
      ) : null}
    </div>
  );
}
