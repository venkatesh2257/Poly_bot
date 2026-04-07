/**
 * Optional `server/config.json` + env overrides for trade filters.
 * Copy `config.example.json` → `config.json` and adjust.
 *
 * Env (override file): TRADE_ASSETS_JSON, MIN_EDGE, MIN_SIGNAL_CONF,
 * MAX_SLIPPAGE_PCT, REQUIRE_MOMENTUM_SIGNAL_AGREE (true/false)
 *
 * Window-end paper / oracle-binary guard (ORACLE_TOO_CLOSE) lives in `engine.ts` + `oracleWindowGuards.ts`:
 * MIN_MS_TO_WINDOW_END (global), MIN_MS_TO_WINDOW_END_BTC (BTC 5m only), legacy PAPER_ENTRY_MIN_MS_TO_WINDOW_END.
 * BTC 5m: if MIN_MS_TO_WINDOW_END_BTC is unset, default 500ms (not global 20s). Optional BTC_5M_POST_WINDOW_END_BUFFER_MS.
 * Logs `ORACLE_TOO_CLOSE_BTC_5M` / `ENTRY_TIME_BTC_5M` with `windowSec` for histograms.
 * Example:
 *   MIN_MS_TO_WINDOW_END=20000
 *   MIN_MS_TO_WINDOW_END_BTC=500
 *
 * BTC 5m entry/result analytics (SIGNAL only, `engine.ts`): ENTRY_TIME_BTC_5M, BTC_5M_TRADE_RESULT,
 * BTC_5M_ENTRY_BUCKETS every N results — `BTC_5M_ENTRY_BUCKET_ROLLUP_EVERY` (default 10).
 * Orphan context TTL: `BTC_5M_ENTRY_CONTEXT_TTL_MS` (default 900000).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BotFiltersConfig = {
  TRADE_ASSETS?: Record<string, boolean>;
  MIN_EDGE?: number;
  MIN_SIGNAL_CONF?: number;
  MAX_SLIPPAGE_PCT?: number;
  REQUIRE_MOMENTUM_SIGNAL_AGREE?: boolean;
};

function configJsonPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, "../../config.json");
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v == null || v === "") return undefined;
  const s = v.toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return undefined;
}

function numEnv(key: string): number | undefined {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : undefined;
}

/** Read file + merge env. Safe to call every trade (small file). */
export function loadBotFiltersConfig(): BotFiltersConfig {
  let file: BotFiltersConfig = {};
  try {
    const p = configJsonPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      const j = JSON.parse(raw) as BotFiltersConfig;
      if (j && typeof j === "object") file = j;
    }
  } catch {
    /* invalid JSON — ignore */
  }

  const envTa = process.env.TRADE_ASSETS_JSON;
  if (envTa && envTa.trim()) {
    try {
      const parsed = JSON.parse(envTa) as Record<string, boolean>;
      file.TRADE_ASSETS = { ...file.TRADE_ASSETS, ...parsed };
    } catch {
      /* */
    }
  }

  const me = numEnv("MIN_EDGE");
  if (me !== undefined) file.MIN_EDGE = me;

  const msc = numEnv("MIN_SIGNAL_CONF");
  if (msc !== undefined) file.MIN_SIGNAL_CONF = msc;

  const msp = numEnv("MAX_SLIPPAGE_PCT");
  if (msp !== undefined) file.MAX_SLIPPAGE_PCT = msp;

  const rms = parseBool(process.env.REQUIRE_MOMENTUM_SIGNAL_AGREE);
  if (rms !== undefined) file.REQUIRE_MOMENTUM_SIGNAL_AGREE = rms;

  return file;
}

/**
 * When `false`, anchor live-executor readiness reports `LIVE_EXECUTOR_DISABLED_BY_CONFIG` (default: true).
 * Set to `false` only in dev to simulate a missing executor without changing trading code.
 */
export function anchorLiveExecutorEnvConfigured(): boolean {
  const v = process.env.ANCHOR_LIVE_EXECUTOR_AVAILABLE;
  if (v == null || String(v).trim() === "") return true;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/**
 * If `TRADE_ASSETS` is absent from config → no restriction.
 * If present (including `{}`) → only assets with `true` may trade; unknown symbols are blocked.
 */
export function tradeAssetAllowedByConfig(asset: string | null | undefined, cfg: BotFiltersConfig): boolean {
  const ta = cfg.TRADE_ASSETS;
  if (ta == null || typeof ta !== "object") return true;
  const k = String(asset ?? "")
    .trim()
    .toUpperCase();
  if (!k) return false;
  return ta[k] === true;
}

/** Book tilt: |UP mid − DOWN mid| on 0–1 scale. */
export function bookMidSpread01(ctx: { up: { mid: number }; down: { mid: number } } | null): number | null {
  if (!ctx) return null;
  return Math.abs(ctx.up.mid - ctx.down.mid);
}

export function slippageFracFromConfig(cfg: BotFiltersConfig, fallbackFrac: number): number {
  const p = cfg.MAX_SLIPPAGE_PCT;
  if (p == null || !Number.isFinite(p) || p <= 0) return fallbackFrac;
  return Math.min(0.5, Math.max(1e-6, p / 100));
}
