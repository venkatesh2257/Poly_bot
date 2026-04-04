import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { BRAND_LOGO_SRC } from "./branding";
import type { RiskSettingsSnapshot } from "./types";
import type { SnipeRoute } from "./snipeUi";

export type OverviewSubTab = "live" | "configuration" | "stats" | "faq";

const MAIN_TABS: { id: SnipeRoute; label: string }[] = [
  { id: "dashboard", label: "Overview" },
  { id: "strategies", label: "Strategies" },
  { id: "tools", label: "Tools" },
  { id: "settings", label: "Configuration" },
  { id: "journal", label: "Logs" }
];

export function CopyProTopBar(props: {
  wsConnected: boolean;
  running: boolean;
  isLoggedIn: boolean;
  isAuthenticating: boolean;
  modeLive: boolean;
  modeToggleLoading: boolean;
  metaMaskAutoEnabled: boolean;
  onStop: () => void;
  onStart: () => void;
  onPaper: () => void;
  onLive: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onOpenRiskSettings?: () => void;
}) {
  const {
    wsConnected,
    running,
    isLoggedIn,
    isAuthenticating,
    modeLive,
    modeToggleLoading,
    metaMaskAutoEnabled,
    onStop,
    onStart,
    onPaper,
    onLive,
    onLogin,
    onLogout,
    onOpenRiskSettings
  } = props;

  return (
    <header className="border-b border-copy-border/60 bg-copy-surface/95 px-4 py-3 shadow-copy-glow backdrop-blur sm:px-6">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <img
            src={BRAND_LOGO_SRC}
            alt="Polypredator — Polymarket 5m"
            className="h-9 w-auto max-w-[min(100%,320px)] object-contain object-left sm:h-10"
            width={320}
            height={40}
            decoding="async"
          />
          <p className="mt-1 text-[10px] font-medium italic tracking-wide text-slate-500">5m Alpha Hunter</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold " +
              (running
                ? "border-copy-green/50 bg-copy-green/10 text-copy-green"
                : "border-slate-700 bg-slate-900 text-slate-400")
            }
          >
            {running ? (
              <>
                <span className="h-2 w-2 rounded-full bg-copy-green shadow-[0_0_8px_#4ade80]" aria-hidden />
                Running
              </>
            ) : (
              "Stopped"
            )}
          </span>
          <span
            className={
              "rounded px-2 py-1 text-[10px] font-semibold uppercase " +
              (wsConnected ? "bg-copy-green/15 text-copy-green" : "bg-rose-950/50 text-rose-300")
            }
          >
            {wsConnected ? "API" : "Offline"}
          </span>
          <button
            type="button"
            onClick={() => onOpenRiskSettings?.()}
            disabled={!isLoggedIn || !onOpenRiskSettings}
            title={
              !isLoggedIn
                ? "Login to change server risk and bet size"
                : "Auto-trade entry USD, min/max, cooldown, paper stop loss"
            }
            className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-copy-green/40 hover:text-copy-green disabled:cursor-not-allowed disabled:opacity-40"
          >
            Risk &amp; bet
          </button>
          <button
            type="button"
            onClick={onStop}
            disabled={!isLoggedIn || !running}
            title={!isLoggedIn ? "Login first" : !running ? "Bot is not running" : "Stop the bot"}
            className="rounded-lg border border-rose-800/80 bg-rose-950/80 px-3 py-1.5 text-xs font-bold text-rose-200 transition hover:bg-rose-900 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Stop Bot
          </button>
          <button
            type="button"
            onClick={onStart}
            disabled={!isLoggedIn || running || isAuthenticating}
            title={
              !isLoggedIn
                ? "Login first"
                : isAuthenticating
                  ? "Signing in…"
                  : running
                    ? "Bot already running"
                    : "Start the bot"
            }
            className="rounded-lg border border-copy-green/40 bg-copy-green/10 px-3 py-1.5 text-xs font-bold text-copy-green transition hover:bg-copy-green/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Start Bot
          </button>
          <button
            type="button"
            disabled={!isLoggedIn || modeToggleLoading || modeLive}
            onClick={onLive}
            className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              !isLoggedIn
                ? "Login first"
                : modeLive
                  ? "Already in LIVE"
                  : metaMaskAutoEnabled
                    ? "Click to confirm: turns off MetaMask auto, then switches to server LIVE"
                    : "Switch to server LIVE (Polymarket CLOB)"
            }
          >
            {modeToggleLoading ? "…" : "Go LIVE"}
          </button>
          <button
            type="button"
            disabled={!isLoggedIn || modeToggleLoading || !modeLive}
            onClick={onPaper}
            title={
              !isLoggedIn
                ? "Login first"
                : !modeLive
                  ? "Already in PAPER"
                  : "Switch to simulated (paper) trading"
            }
            className="rounded-lg border border-copy-green/30 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-copy-green transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {modeToggleLoading ? "…" : "Switch to PAPER"}
          </button>
          {isLoggedIn ? (
            <button
              type="button"
              onClick={onLogout}
              className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-slate-500"
            >
              Logout
            </button>
          ) : (
            <button
              type="button"
              onClick={onLogin}
              className="rounded-lg border border-copy-green/50 px-3 py-1.5 text-xs font-bold text-copy-green"
            >
              Login
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

export function CopyProMetricsRow(props: {
  mode: string;
  balance: string;
  todayOrSessionPnl: string;
  allPnl: string;
  wl: string;
  polymarketLine?: ReactNode;
}) {
  const Metric = ({ label, value }: { label: string; value: string }) => (
    <div className="rounded-xl border border-copy-border/70 bg-[#0d0f0d] px-4 py-3 shadow-inner">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-lg font-bold text-copy-green">{value}</p>
    </div>
  );

  return (
    <div className="border-b border-copy-border/40 bg-black/40 px-4 py-3 sm:px-6">
      <div className="mx-auto grid max-w-[1800px] gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Metric label="Mode" value={props.mode} />
        <Metric label="Balance" value={props.balance} />
        <Metric label="Session P&amp;L" value={props.todayOrSessionPnl} />
        <Metric label="All P&amp;L" value={props.allPnl} />
        <Metric label="W / L" value={props.wl} />
        <div className="rounded-xl border border-slate-800 bg-[#0d0f0d] px-4 py-3 text-xs text-slate-400 lg:col-span-1">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Collateral</p>
          <div className="mt-1 text-slate-300">{props.polymarketLine ?? "—"}</div>
        </div>
      </div>
    </div>
  );
}

export function CopyProMainNav(props: { route: SnipeRoute; onRoute: (r: SnipeRoute) => void }) {
  return (
    <nav className="border-b border-copy-border/40 bg-black/30 px-4 sm:px-6">
      <div className="mx-auto flex max-w-[1800px] flex-wrap gap-1 py-2">
        {MAIN_TABS.map((t) => {
          const on = props.route === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => props.onRoute(t.id)}
              aria-current={on ? "page" : undefined}
              className={
                "rounded-lg px-4 py-2 text-sm font-semibold transition " +
                (on
                  ? "bg-copy-green/15 text-copy-green shadow-[inset_0_0_0_1px_rgba(74,222,128,0.35)]"
                  : "text-slate-500 hover:bg-white/[0.04] hover:text-slate-200")
              }
            >
              {t.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => props.onRoute("wizard")}
          className="rounded-lg px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-400"
        >
          Wizard
        </button>
      </div>
    </nav>
  );
}

export function StrategyModulesStrip(props: { onOpenStrategies?: () => void }) {
  return (
    <div className="flex flex-col gap-3 border-b border-copy-border/30 bg-[#080808] px-4 py-2.5 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Strategy modules</span>
          <button
            type="button"
            disabled
            className="rounded-lg border border-slate-800 px-3 py-1 text-xs text-slate-600"
            title="Not included in this build"
          >
            Copy trading
          </button>
          <button
            type="button"
            onClick={() => props.onOpenStrategies?.()}
            className="rounded-lg border border-copy-green/50 bg-copy-green/10 px-3 py-1 text-xs font-bold text-copy-green transition hover:bg-copy-green/20"
          >
            Crypto markets snipe
          </button>
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded-lg border border-slate-800 px-3 py-1 text-xs text-slate-600"
          >
            Crypto fun (beta)
          </button>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-slate-500">
          <span className="rounded border border-slate-800 px-2 py-1">Auto claim: server only</span>
        </div>
      </div>
    </div>
  );
}

export function OverviewSubNav(props: { value: OverviewSubTab; onChange: (v: OverviewSubTab) => void }) {
  const tabs: { id: OverviewSubTab; label: string }[] = [
    { id: "configuration", label: "Configuration" },
    { id: "live", label: "Live status" },
    { id: "stats", label: "Stats" },
    { id: "faq", label: "FAQ" }
  ];
  return (
    <div className="flex flex-wrap gap-1 border-b border-copy-border/25 px-4 py-2 sm:px-6">
      {tabs.map((t) => {
        const on = props.value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => props.onChange(t.id)}
            aria-current={on ? "true" : undefined}
            className={
              "rounded-md px-3 py-1.5 text-xs font-semibold " +
              (on ? "bg-slate-800 text-copy-green" : "text-slate-500 hover:text-slate-300")
            }
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function fmtUsd(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Parse `{asset}-updown-5m-{unix}` → canonical symbol (BTC, ETH, …). */
function assetKeyFromGammaSlug(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const m = /^([a-z0-9]+)-updown-5m-/i.exec(slug);
  if (!m) return null;
  const p = m[1].toUpperCase();
  if (p === "DOGE" || p === "DOG") return "DOGE";
  return p;
}

const ASSET_ROW_ORDER = ["BTC", "ETH", "SOL", "XRP"] as const;

export function SnipeAssetCardsRow(props: {
  /** Legacy: primary Gamma slug (still passed from App for chart context). */
  btcSlug: string | null;
  secsLeft: number | null;
  upMid: number | null;
  downMid: number | null;
  priceToBeat: number | null;
  currentBtc: number | null;
  diffUsd: number | null;
  statusLine: string;
  updownAssetsConfigured?: string[];
  updownWindows?: Array<{
    asset: string;
    slug: string;
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
    oracleAgeMs?: number | null;
    oracleSource?: "chainlink" | "rtds" | "cache" | null;
    priceToBeatUsd?: number | null;
    diffUsd?: number | null;
    secondsToExpiry?: number | null;
  }>;
  primarySlug?: string | null;
  /** When set, each configured asset shows an Auto-trade checkbox. */
  assetAutoTradeEnabled?: Record<string, boolean>;
  onToggleAssetAutoTrade?: (asset: string, enabled: boolean) => void;
  assetAutoTradeBusy?: string | null;
}) {
  const { secsLeft, upMid, downMid, priceToBeat, currentBtc, diffUsd, statusLine } = props;

  /**
   * Always union the 4 strip symbols with the server list so legacy `UPDOWN_ASSET=BTC`
   * (API returns only ["BTC"]) does not show ETH/SOL/XRP/DOGE as Off.
   */
  const cfgRaw = props.updownAssetsConfigured ?? [];
  /** Symbols actually listed in server `UPDOWN_ASSETS` (controls Auto-trade toggles only). */
  const serverAssetsOnly = new Set(cfgRaw.map((a) => a.trim().toUpperCase()));
  const configured = [...new Set([...ASSET_ROW_ORDER, ...cfgRaw])].map((a) => a.trim().toUpperCase());
  const windows = props.updownWindows ?? [];
  const primaryAsset = assetKeyFromGammaSlug(props.primarySlug ?? null);

  const assets = ASSET_ROW_ORDER.map((sym) => {
    const win = windows.find((w) => w.asset === sym);
    const inCfg = configured.includes(sym);
    const isPrimaryTile = primaryAsset === sym && Boolean(win);

    const slugLine =
      (win?.slug ?? (inCfg ? "Resolving Gamma slug…" : "—")) +
      (win?.oddsSource === "gamma" ? " · headline odds (Gamma)" : "");

    const lines: { k: string; v: string }[] = [];

    if (win) {
      const useServerOdds = win.upMid != null && win.downMid != null;
      const um = useServerOdds
        ? (win.upMid! * 100).toFixed(1)
        : isPrimaryTile && upMid != null
          ? (upMid * 100).toFixed(1)
          : "—";
      const dm = useServerOdds
        ? (win.downMid! * 100).toFixed(1)
        : isPrimaryTile && downMid != null
          ? (downMid * 100).toFixed(1)
          : "—";
      const ptb =
        win.priceToBeatUsd != null && Number.isFinite(win.priceToBeatUsd)
          ? win.priceToBeatUsd
          : isPrimaryTile
            ? priceToBeat
            : null;
      const spot =
        win.oracleSpotUsd != null && Number.isFinite(win.oracleSpotUsd)
          ? win.oracleSpotUsd
          : isPrimaryTile
            ? currentBtc
            : null;
      const oracleAgeMs =
        win.oracleAgeMs != null && Number.isFinite(win.oracleAgeMs) ? win.oracleAgeMs : null;
      let diff: number | null =
        win.diffUsd != null && Number.isFinite(win.diffUsd)
          ? win.diffUsd
          : isPrimaryTile
            ? diffUsd
            : null;
      if (diff == null && spot != null && ptb != null && Number.isFinite(spot) && Number.isFinite(ptb)) {
        diff = spot - ptb;
      }
      const sec =
        win.secondsToExpiry != null && Number.isFinite(win.secondsToExpiry)
          ? win.secondsToExpiry
          : secsLeft;
      lines.push(
        { k: "UP (¢)", v: um },
        { k: "DOWN (¢)", v: dm },
        { k: "Price to beat", v: ptb != null ? `$${fmtUsd(ptb)}` : "—" },
        { k: `Spot ${sym}`, v: spot != null ? `$${fmtUsd(spot)}` : "—" },
        { k: "Oracle age", v: oracleAgeMs != null ? `${Math.max(0, Math.round(oracleAgeMs / 1000))}s` : "—" },
        {
          k: "Oracle source",
          v:
            win.oracleSource === "chainlink"
              ? "Chainlink"
              : win.oracleSource === "rtds"
                ? "RTDS"
                : win.oracleSource === "cache"
                  ? "Cache"
                  : "—"
        },
        {
          k: "Diff",
          v:
            diff != null && Number.isFinite(diff) ? `${diff >= 0 ? "+" : ""}$${fmtUsd(diff)}` : "—"
        },
        { k: "Secs left", v: sec != null ? String(Math.max(0, sec)) : "—" }
      );
    } else if (inCfg) {
      lines.push(
        { k: "Status", v: "Waiting for discovery" },
        { k: "Note", v: "Listed in UPDOWN_ASSETS; next Gamma poll will attach the market." }
      );
    } else {
      lines.push(
        { k: "Status", v: "Not configured" },
        { k: "Note", v: "Add symbol to UPDOWN_ASSETS in server .env." }
      );
    }

    let badge: "live" | "pending" | "off";
    if (win) badge = "live";
    else if (inCfg) badge = "pending";
    else badge = "off";

    return {
      sym,
      slugLine,
      lines,
      badge,
      showStatus: badge === "live" || badge === "pending",
      inCfg,
      showAutoToggle: serverAssetsOnly.has(sym)
    };
  });

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {assets.map((a) => (
        <div
          key={a.sym}
          className={
            "flex flex-col rounded-xl border p-3 " +
            (a.badge === "live"
              ? "border-copy-green/45 bg-[#0c120f] shadow-copy-glow"
              : a.badge === "pending"
                ? "border-amber-500/35 bg-amber-950/15"
                : "border-slate-800/80 bg-[#0a0a0a] opacity-80")
          }
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-bold text-white">{a.sym}</span>
            <div className="flex flex-wrap items-center gap-2">
              {a.badge === "live" ? (
                <span className="rounded bg-copy-green/20 px-1.5 py-0.5 text-[10px] font-bold text-copy-green">Live</span>
              ) : a.badge === "pending" ? (
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-200">Pending</span>
              ) : (
                <span className="text-[10px] text-slate-600">Off</span>
              )}
              {a.showAutoToggle ? (
                <label
                  className="flex cursor-pointer items-center gap-1.5 text-[10px] text-slate-400"
                  title="When off, the auto-trader skips this asset (manual trades unchanged)."
                >
                  <input
                    type="checkbox"
                    className="rounded border-slate-600 bg-slate-900"
                    checked={props.assetAutoTradeEnabled?.[a.sym] !== false}
                    disabled={!props.onToggleAssetAutoTrade || props.assetAutoTradeBusy === a.sym}
                    onChange={(e) => props.onToggleAssetAutoTrade?.(a.sym, e.target.checked)}
                  />
                  Auto
                </label>
              ) : null}
            </div>
          </div>
          <p className="mb-2 break-all font-mono text-[10px] leading-snug text-slate-500">{a.slugLine}</p>
          <dl className="space-y-1 text-[11px]">
            {a.lines.map((row, i) => (
              <div key={i} className="flex justify-between gap-2">
                <dt className="text-slate-500">{row.k}</dt>
                <dd className="font-mono text-right text-slate-200">{row.v}</dd>
              </div>
            ))}
          </dl>
          {a.showStatus ? (
            <p className="mt-2 border-t border-white/[0.06] pt-2 font-mono text-[10px] leading-relaxed text-slate-500">
              {a.badge === "live" && primaryAsset === a.sym ? statusLine || "Waiting for signal…" : ""}
              {a.badge === "live" && primaryAsset !== a.sym
                ? "Auto-traded in round-robin with other UPDOWN windows."
                : null}
              {a.badge === "pending" ? "Server will resolve this window when the market exists on Polymarket." : null}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function parseNum(s: string): number | null {
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function parseRiskFormInputs(
  entryUsd: string,
  minTrade: string,
  maxTrade: string,
  stopLossUsd: string,
  cooldownMs: string
): { ok: true; values: { entryUsd: number; minTrade: number; maxTrade: number; stopLossUsd: number; cooldownMs: number } } | { ok: false; error: string } {
  const e = parseNum(entryUsd);
  const lo = parseNum(minTrade);
  const hi = parseNum(maxTrade);
  const sl = parseNum(stopLossUsd);
  const cd = parseNum(cooldownMs);
  if (e == null || lo == null || hi == null || sl == null || cd == null) {
    return { ok: false, error: "All fields must be valid numbers." };
  }
  if (lo < 0.01) {
    return { ok: false, error: "Min trade must be at least 0.01." };
  }
  if (hi < lo) {
    return { ok: false, error: "Max trade must be greater than or equal to min trade." };
  }
  if (e < lo || e > hi) {
    return { ok: false, error: `Entry USD must be between min (${lo}) and max (${hi}).` };
  }
  if (sl < 1) {
    return { ok: false, error: "Stop loss must be at least 1." };
  }
  if (cd < 0 || cd > 3_600_000) {
    return { ok: false, error: "Cooldown must be between 0 and 3,600,000 ms." };
  }
  return {
    ok: true,
    values: {
      entryUsd: e,
      minTrade: lo,
      maxTrade: hi,
      stopLossUsd: sl,
      cooldownMs: Math.round(cd)
    }
  };
}

export function RiskBetSettingsModal(props: {
  open: boolean;
  onClose: () => void;
  settings: RiskSettingsSnapshot | null | undefined;
  busy: boolean;
  error: string | null;
  onApply: (patch: {
    reset?: boolean;
    entryUsd?: number;
    minTrade?: number;
    maxTrade?: number;
    stopLossUsd?: number;
    cooldownMs?: number;
  }) => Promise<void>;
  /** Writes `server/.env` and clears runtime overrides (same auth as Apply). */
  onPersistToEnv: (values: {
    entryUsd: number;
    minTrade: number;
    maxTrade: number;
    stopLossUsd: number;
    cooldownMs: number;
  }) => Promise<void>;
}) {
  const [entryUsd, setEntryUsd] = useState("");
  const [minTrade, setMinTrade] = useState("");
  const [maxTrade, setMaxTrade] = useState("");
  const [stopLossUsd, setStopLossUsd] = useState("");
  const [cooldownMs, setCooldownMs] = useState("");
  const [localErr, setLocalErr] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open || !props.settings) return;
    const r = props.settings;
    setEntryUsd(String(r.entryUsd));
    setMinTrade(String(r.minTrade));
    setMaxTrade(String(r.maxTrade));
    setStopLossUsd(String(r.stopLossUsd));
    setCooldownMs(String(Math.round(r.cooldownMs)));
    setLocalErr(null);
  }, [props.open, props.settings]);

  if (!props.open) return null;

  const base = props.settings;
  const envLine = base
    ? `.env defaults: entry $${base.env.entryUsd} · min $${base.env.minTrade} · max $${base.env.maxTrade} · stop $${base.env.stopLossUsd} · cd ${base.env.cooldownMs}ms`
    : "Connect to server to load risk settings.";

  const handleApply = async () => {
    setLocalErr(null);
    const parsed = parseRiskFormInputs(entryUsd, minTrade, maxTrade, stopLossUsd, cooldownMs);
    if (!parsed.ok) {
      setLocalErr(parsed.error);
      return;
    }
    await props.onApply(parsed.values);
  };

  const handleOk = async () => {
    setLocalErr(null);
    const parsed = parseRiskFormInputs(entryUsd, minTrade, maxTrade, stopLossUsd, cooldownMs);
    if (!parsed.ok) {
      setLocalErr(parsed.error);
      return;
    }
    await props.onPersistToEnv(parsed.values);
  };

  const handleReset = async () => {
    setLocalErr(null);
    await props.onApply({ reset: true });
  };

  const displayErr = localErr || props.error;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="risk-modal-title"
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-copy-border/50 bg-[#0c0e0c] p-5 shadow-copy-glow">
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 id="risk-modal-title" className="font-display text-lg font-bold text-white">
            Risk &amp; bet size
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-lg px-2 py-1 text-sm text-slate-400 hover:bg-slate-800 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <p className="mb-4 text-[11px] leading-relaxed text-slate-500">{envLine}</p>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          <span className="font-semibold text-slate-400">OK</span> updates <code className="text-slate-400">server/.env</code>{" "}
          (ENTRY_USD, MIN_TRADE, MAX_TRADE, STOP_LOSS, COOLDOWN_MS) and the running server.{" "}
          <span className="font-semibold text-slate-400">Apply</span> only changes this session (runtime override).
        </p>
        {base?.overridesActive ? (
          <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-950/20 px-2 py-1.5 text-[11px] text-amber-100/90">
            Runtime overrides active — use <span className="font-semibold">OK</span> to write the form into{" "}
            <code className="text-amber-200/90">.env</code> and clear overrides, or <span className="font-semibold">Reset to .env</span>{" "}
            to discard overrides without editing the file.
          </p>
        ) : null}

        <div className="grid gap-3">
          <label className="grid gap-1 text-xs">
            <span className="text-slate-400">Entry USD (auto-trade target)</span>
            <input
              value={entryUsd}
              onChange={(ev) => setEntryUsd(ev.target.value)}
              inputMode="decimal"
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-copy-green/50"
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-slate-400">Min trade USD</span>
            <input
              value={minTrade}
              onChange={(ev) => setMinTrade(ev.target.value)}
              inputMode="decimal"
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-copy-green/50"
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-slate-400">Max trade USD</span>
            <input
              value={maxTrade}
              onChange={(ev) => setMaxTrade(ev.target.value)}
              inputMode="decimal"
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-copy-green/50"
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-slate-400">Paper stop loss USD (drawdown vs start balance)</span>
            <input
              value={stopLossUsd}
              onChange={(ev) => setStopLossUsd(ev.target.value)}
              inputMode="decimal"
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-copy-green/50"
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="text-slate-400">Cooldown (ms) between entries per market</span>
            <input
              value={cooldownMs}
              onChange={(ev) => setCooldownMs(ev.target.value)}
              inputMode="numeric"
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-copy-green/50"
            />
          </label>
        </div>

        {displayErr ? (
          <p className="mt-3 rounded-lg border border-rose-500/40 bg-rose-950/30 px-2 py-2 text-xs text-rose-200">{displayErr}</p>
        ) : null}

        <div className="mt-5 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={props.busy}
              onClick={() => void handleOk()}
              className="min-w-[120px] flex-1 rounded-xl bg-copy-green py-2.5 text-xs font-bold text-[#061016] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              title="Save to server/.env and apply to running process"
            >
              {props.busy ? "Saving…" : "OK"}
            </button>
            <button
              type="button"
              disabled={props.busy}
              onClick={() => void handleApply()}
              className="min-w-[120px] flex-1 rounded-xl border border-copy-green/50 bg-copy-green/5 py-2.5 text-xs font-bold text-copy-green transition hover:bg-copy-green/15 disabled:cursor-not-allowed disabled:opacity-40"
              title="Runtime override only (not written to .env)"
            >
              Apply (session)
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={props.busy}
              onClick={() => void handleReset()}
              className="rounded-xl border border-slate-600 px-4 py-2.5 text-xs font-semibold text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset to .env
            </button>
            <button
              type="button"
              disabled={props.busy}
              onClick={props.onClose}
              className="rounded-xl border border-slate-600 px-4 py-2.5 text-xs font-semibold text-slate-400 hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
