/**
 * Synthesis (synthesis.trade) market-data integration — config only, no secrets in source.
 */

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  if (v == null || String(v).trim() === "") return fallback;
  return String(v).trim();
}

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v == null || v === "") return fallback;
  const s = String(v).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

export type SynthesisRuntimeConfig = {
  enabled: boolean;
  baseUrl: string;
  wsBaseUrl: string;
  apiKey: string;
  dashboardPreferred: boolean;
  botFallbackEnabled: boolean;
  staleMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  tradesHistoryLimit: number;
  chartPollSmoothMs: number;
};

export function loadSynthesisConfigFromEnv(): SynthesisRuntimeConfig {
  return {
    enabled: envBool("SYNTHESIS_ENABLED", false),
    baseUrl: envStr("SYNTHESIS_BASE_URL", "https://synthesis.trade"),
    wsBaseUrl: envStr("SYNTHESIS_WS_URL", "wss://synthesis.trade"),
    apiKey: envStr("SYNTHESIS_API_KEY", ""),
    dashboardPreferred: envBool("SYNTHESIS_DASHBOARD_PREFERRED", true),
    botFallbackEnabled: envBool("SYNTHESIS_BOT_FALLBACK_ENABLED", false),
    staleMs: Math.max(500, envNum("SYNTHESIS_STALE_MS", 15_000)),
    reconnectMinMs: Math.max(200, envNum("SYNTHESIS_RECONNECT_MIN_MS", 1000)),
    reconnectMaxMs: Math.max(1000, envNum("SYNTHESIS_RECONNECT_MAX_MS", 60_000)),
    tradesHistoryLimit: Math.min(10_000, Math.max(10, Math.floor(envNum("SYNTHESIS_TRADES_LIMIT", 200)))),
    chartPollSmoothMs: Math.max(200, envNum("SYNTHESIS_CHART_SMOOTH_MS", 2000))
  };
}
