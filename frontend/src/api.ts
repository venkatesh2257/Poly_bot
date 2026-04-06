import type {
  AuthMeResponse,
  AuthNonceResponse,
  AuthVerifyResponse,
  BetLogEntry,
  BotStatus,
  EntryStrategyState,
  RiskSettingsSnapshot,
  TradeLogQueryResponse,
  TradingState,
  Insights,
  MarketOption,
  Mode,
  SetModeResponse,
  PingResponse,
  PolymarketAccountSummary,
  PasswordLoginResponse,
  Trade,
  WalletSummary
} from "./types";
import { resolveApiBase } from "./apiConfig";

const API_BASE = resolveApiBase();

function mergeRequestHeaders(init: RequestInit | undefined): Headers {
  const token = localStorage.getItem("polybot_auth_token");
  const merged = new Headers();
  merged.set("Content-Type", "application/json");
  if (token) merged.set("Authorization", `Bearer ${token}`);
  if (init?.headers) {
    const extra = new Headers(init.headers);
    extra.forEach((value, key) => merged.set(key, value));
  }
  return merged;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: mergeRequestHeaders(init)
  });
  if (!res.ok) {
    const raw = await res.text();
    try {
      const parsed = JSON.parse(raw) as { error?: string; reason?: string; message?: string };
      throw new Error(parsed.error ?? parsed.reason ?? parsed.message ?? raw);
    } catch {
      throw new Error(raw || `Request failed (${res.status})`);
    }
  }
  return res.json() as Promise<T>;
}

export const api = {
  start: () => request<{ ok: true }>("/start", { method: "POST" }),
  stop: () => request<{ ok: true }>("/stop", { method: "POST" }),
  status: () => request<BotStatus>("/status"),
  ping: () => request<PingResponse>("/ping"),
  tradingState: () => request<TradingState>("/trading-state"),
  setRiskSettings: (body: {
    reset?: boolean;
    entryUsd?: number;
    minTrade?: number;
    maxTrade?: number;
    stopLossUsd?: number;
    cooldownMs?: number;
  }) =>
    request<{ ok: true; riskSettings: RiskSettingsSnapshot }>("/risk-settings", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  /** Writes `server/.env` (ENTRY_USD, MIN_TRADE, MAX_TRADE, STOP_LOSS, COOLDOWN_MS) and clears runtime overrides. */
  persistRiskSettingsToEnv: (body: {
    entryUsd: number;
    minTrade: number;
    maxTrade: number;
    stopLossUsd: number;
    cooldownMs: number;
  }) =>
    request<{ ok: true; riskSettings: RiskSettingsSnapshot }>("/risk-settings/persist-env", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  setEntryStrategy: (body: { reset?: boolean; strategy?: string }) =>
    request<{ ok: true; entryStrategy: EntryStrategyState }>("/entry-strategy", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  setAnchorStrategy: (enabled: boolean) =>
    request<{ ok: true; anchorStrategy: import("./types").AnchorStrategySnapshot }>("/anchor-strategy", {
      method: "POST",
      body: JSON.stringify({ enabled })
    }),
  setLagSnipe: (enabled: boolean) =>
    request<{ ok: true; lagSnipeEnabled: boolean; banner?: string }>("/lag-snipe", {
      method: "POST",
      body: JSON.stringify({ enabled })
    }),
  /** Per-asset auto-trade on/off (only symbols in UPDOWN_ASSETS). Manual trades unaffected. */
  setAssetAutoTrade: (asset: string, enabled: boolean) =>
    request<{ ok: true; assetAutoTradeEnabled: Record<string, boolean> }>("/asset-auto-trade", {
      method: "POST",
      body: JSON.stringify({ asset, enabled })
    }),
  setMode: (body: { mode: Mode }) =>
    request<SetModeResponse>("/mode", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  /**
   * Alias for execution-mode toggle.
   * Body: { simulation: boolean } where true = SIMULATION (paper), false = LIVE (real CLOB).
   */
  setConfig: (body: { simulation: boolean }) =>
    request<SetModeResponse>("/config", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  setExternalExecution: (enabled: boolean) =>
    request<{ ok: boolean; enabled: boolean }>("/execution/external", {
      method: "POST",
      body: JSON.stringify({ enabled })
    }),
  betLogs: () => request<BetLogEntry[]>("/bet-logs"),
  trades: () => request<Trade[]>("/trades"),
  wallet: () => request<WalletSummary>("/wallet"),
  markets: () => request<MarketOption[]>("/markets"),
  insights: () => request<Insights>("/insights"),
  selectMarket: (tokenID: string) =>
    request<{ ok: boolean; reason?: string }>("/market/select", {
      method: "POST",
      body: JSON.stringify({ tokenID })
    }),
  authNonce: (address: string) => request<AuthNonceResponse>(`/auth/nonce?address=${encodeURIComponent(address)}`),
  authVerify: (address: string, signature: string) =>
    request<AuthVerifyResponse>("/auth/verify", {
      method: "POST",
      body: JSON.stringify({ address, signature })
    }),
  authMe: () => request<AuthMeResponse>("/auth/me"),
  passwordLogin: (userId: string, password: string) =>
    request<PasswordLoginResponse>("/auth/password-login", {
      method: "POST",
      body: JSON.stringify({ userId, password })
    }),
  trade: (direction: "UP" | "DOWN", amount: number) =>
    request<{ accepted: boolean; trade?: Trade; reason?: string }>("/trade", {
      method: "POST",
      body: JSON.stringify({ direction, amount })
    }),
  polymarketClobSigningConfig: () =>
    request<{
      host: string;
      chainId: number;
      signatureType: number;
      funderAddress: string;
      tokenIdUp: string;
      tokenIdDown: string;
      /** Present when server has LIVE wallet; MetaMask EOA must match for GNOSIS_SAFE / POLY_PROXY. */
      signerAddress?: string;
    }>("/polymarket/clob/signing-config"),
  polymarketClobBook: (tokenID: string) =>
    request<{ mid: number; bestBid: number; bestAsk: number; spread: number }>(
      `/polymarket/clob/book?tokenID=${encodeURIComponent(tokenID)}`
    ),
  polymarketBalanceAllowance: () => request<unknown>("/polymarket/clob/balance-allowance"),
  polymarketOpenOrders: () => request<unknown[]>("/polymarket/clob/open-orders"),
  polymarketUserTrades: () => request<unknown[]>("/polymarket/clob/user-trades"),
  polymarketAvailableCollateral: () =>
    request<{
      balanceUsdc: number | null;
      reservedUsdc: number | null;
      availableUsdc: number | null;
      reason?: string;
    }>("/polymarket/clob/available-collateral"),
  confirmTradeFill: (tradeId: string) =>
    request<{ ok: boolean; reason?: string }>(`/trades/${encodeURIComponent(tradeId)}/confirm-fill`, {
      method: "POST"
    }),
  attachClobOrder: (tradeId: string, orderId: string) =>
    request<{ ok: boolean }>(`/trades/${encodeURIComponent(tradeId)}/clob-order`, {
      method: "POST",
      body: JSON.stringify({ orderId })
    }),
  tradeLogQuery: (q: {
    from?: string;
    to?: string;
    asset?: string;
    strategy?: string;
    session?: "24h" | "AM" | "PM";
  }) => {
    const params = new URLSearchParams();
    if (q.from) params.set("from", q.from);
    if (q.to) params.set("to", q.to);
    if (q.asset) params.set("asset", q.asset);
    if (q.strategy) params.set("strategy", q.strategy);
    if (q.session) params.set("session", q.session);
    return request<TradeLogQueryResponse>(`/trade-log/query?${params.toString()}`);
  },
  polymarketConnect: async (): Promise<PolymarketAccountSummary> => {
    const [wallet, balanceAllowanceRaw, openOrders, userTrades] = await Promise.all([
      request<WalletSummary>("/wallet"),
      request<unknown>("/polymarket/clob/balance-allowance"),
      request<unknown[]>("/polymarket/clob/open-orders"),
      request<unknown[]>("/polymarket/clob/user-trades")
    ]);
    return {
      connected: wallet.connected,
      address: wallet.address,
      signerAddress: wallet.signerAddress,
      funderAddress: wallet.funderAddress ?? wallet.address,
      mode: wallet.mode,
      network: wallet.network,
      polymarketUsdc: wallet.polymarketUsdc,
      balanceAllowanceRaw,
      openOrdersCount: Array.isArray(openOrders) ? openOrders.length : 0,
      userTradesCount: Array.isArray(userTrades) ? userTrades.length : 0
    };
  }
};
