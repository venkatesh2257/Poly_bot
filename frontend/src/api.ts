import type {
  AuthMeResponse,
  AuthNonceResponse,
  AuthVerifyResponse,
  BetLogEntry,
  BotStatus,
  TradingState,
  Insights,
  MarketOption,
  Mode,
  PolymarketAccountSummary,
  PasswordLoginResponse,
  Trade,
  WalletSummary
} from "./types";

const API_BASE = "http://localhost:4000/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("polybot_auth_token");
  const customHeaders = init?.headers as Record<string, string> | undefined;
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(customHeaders ?? {})
    },
    ...init
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
  tradingState: () => request<TradingState>("/trading-state"),
  setMode: (mode: Mode) =>
    request<{ ok: boolean; mode: Mode; reason?: string }>("/mode", {
      method: "POST",
      body: JSON.stringify({ mode })
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
