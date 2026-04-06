import { Router, type Request, type Response } from "express";
import { TradingEngine } from "../services/engine.js";
import { AuthService } from "../services/auth.js";
import { PolymarketPublicService } from "../services/polymarket.js";
import { TradeLogger } from "../services/tradeLogger.js";
import { executionEnvSnapshotStrings, syncExecutionEnvForUiMode } from "../services/executionFlags.js";

export type InspectionPayload = {
  ts: number;
  method: string;
  path: string;
  status: number;
  ms: number;
};

function shouldInspectApiPath(path: string, method: string): boolean {
  const p = path.replace(/\/$/, "") || "/";
  if (
    method === "POST" &&
    (p.startsWith("/trades/") ||
      [
        "/start",
        "/stop",
        "/trade",
        "/market/select",
        "/mode",
        "/execution/external",
        "/risk-settings",
        "/risk-settings/persist-env",
        "/entry-strategy",
        "/anchor-strategy",
        "/lag-snipe",
        "/asset-auto-trade",
        "/auth/password-login",
        "/auth/verify",
        "/debug/live-env"
      ].includes(p))
  ) {
    return true;
  }
  if (
    method === "GET" &&
    (p.startsWith("/polymarket/clob/") || p === "/ping" || p.startsWith("/trade-log/"))
  ) {
    return true;
  }
  return false;
}

export function createApiRouter(
  engine: TradingEngine,
  auth: AuthService,
  tradeLogger: TradeLogger,
  broadcastInspection?: (payload: InspectionPayload) => void
) {
  const router = Router();
  const poly = new PolymarketPublicService();

  router.use((req, res, next) => {
    if (!broadcastInspection) return next();
    const started = Date.now();
    const path = req.path;
    const method = req.method;
    res.on("finish", () => {
      if (!shouldInspectApiPath(path, method)) return;
      const fullPath = String(req.originalUrl ?? path).split("?")[0].slice(0, 200);
      broadcastInspection({
        ts: Date.now(),
        method,
        path: fullPath,
        status: res.statusCode,
        ms: Date.now() - started
      });
    });
    next();
  });
  /** Comma/semicolon/whitespace-separated allowlist. Empty = allow any (dev). */
  const allowedWalletSet = new Set(
    String(process.env.ALLOWED_WALLET ?? "")
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const isWalletAuthorized = (address?: string) => {
    if (!address) return false;
    if (allowedWalletSet.size === 0) return true;
    return allowedWalletSet.has(address.toLowerCase());
  };

  const getBearerToken = (header: string | undefined) => {
    if (!header) return undefined;
    const [kind, token] = header.split(" ");
    if (kind !== "Bearer") return undefined;
    return token;
  };

  type DashboardSession = NonNullable<ReturnType<typeof auth.getSession>>;

  /** Same rules as other dashboard control routes: session + wallet allowlist when applicable. */
  const requireDashboardAuth = (req: Request, res: Response): DashboardSession | null => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) {
      res.status(401).json({ ok: false, reason: "Login required" });
      return null;
    }
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
      return null;
    }
    return session;
  };

  router.get("/auth/nonce", (req, res) => {
    const address = String(req.query.address ?? "");
    if (!/^0x[a-fA-F0-9]{40}$/i.test(address.trim())) {
      return res.status(400).json({ error: "Invalid address" });
    }
    const nonce = auth.createNonce(address);
    const message = auth.buildMessage(address, nonce);
    return res.json({ nonce, message });
  });

  router.post("/auth/verify", (req, res) => {
    const { address, signature } = req.body;
    if (typeof address !== "string" || typeof signature !== "string") {
      return res.status(400).json({ error: "Invalid payload" });
    }
    if (!isWalletAuthorized(address)) {
      return res.status(403).json({ error: "This wallet is not allowed for this dashboard" });
    }
    const verified = auth.verifySignature({ address, signature });
    if (!verified) return res.status(401).json({ error: "Signature verification failed" });
    return res.json(verified);
  });

  router.post("/auth/password-login", (req, res) => {
    if (!auth.isPasswordAuthConfigured()) {
      return res.status(503).json({
        error: "Password authentication is not configured",
        reason: "Set APP_USER_ID and APP_PASSWORD in the server environment."
      });
    }
    const { userId, password } = req.body;
    if (typeof userId !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Invalid payload" });
    }
    const result = auth.loginWithPassword({ userId, password });
    if (!result) return res.status(401).json({ error: "Invalid user ID or password" });
    return res.json(result);
  });

  router.get("/auth/me", (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ authenticated: false });
    return res.json({ authenticated: true, address: session.address, userId: session.userId, authType: session.authType });
  });

  router.post("/start", (_req, res) => {
    const token = getBearerToken(_req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    engine.start();
    return res.json({ ok: true });
  });

  router.post("/stop", (_req, res) => {
    const token = getBearerToken(_req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    engine.stop();
    return res.json({ ok: true });
  });

  router.post("/mode", async (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    const mode = req.body?.mode;
    if (mode !== "SIMULATION" && mode !== "LIVE") {
      return res.status(400).json({ ok: false, reason: "mode must be SIMULATION or LIVE" });
    }
    syncExecutionEnvForUiMode(mode, req.body as Record<string, unknown>);
    const result = await engine.setMode(mode);
    const st = engine.status();
    const env = executionEnvSnapshotStrings();
    return res.json({
      ok: result.ok,
      mode: st.mode,
      reason: result.reason,
      paperTrading: env.paperTrading,
      executeTrades: env.executeTrades,
      paperOnly: env.paperOnly,
      PAPER_TRADING: env.paperTrading,
      EXECUTE_TRADES: env.executeTrades,
      envMode: env.mode
    });
  });

  /**
   * Alias for execution-mode toggle.
   * Body: { simulation: boolean } where true = SIMULATION (paper), false = LIVE (real CLOB).
   */
  router.post("/config", async (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    const simulation = req.body?.simulation;
    if (typeof simulation !== "boolean") {
      return res.status(400).json({ ok: false, reason: "config.simulation must be boolean" });
    }
    const mode = simulation ? "SIMULATION" : "LIVE";
    syncExecutionEnvForUiMode(mode, req.body as Record<string, unknown>);
    const result = await engine.setMode(mode);
    const st = engine.status();
    const env = executionEnvSnapshotStrings();
    return res.json({
      ok: result.ok,
      mode: st.mode,
      reason: result.reason,
      paperTrading: env.paperTrading,
      executeTrades: env.executeTrades,
      paperOnly: env.paperOnly,
      PAPER_TRADING: env.paperTrading,
      EXECUTE_TRADES: env.executeTrades,
      envMode: env.mode
    });
  });

  router.post("/debug/live-env", (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    return res.json({ ok: true, ...engine.getLiveExecutionDebugSnapshot() });
  });

  // When enabled, the engine will generate pending trades + execution phases,
  // but it will not post any LIVE orders itself (browser wallet is expected to execute).
  router.post("/execution/external", async (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }

    const enabled = Boolean(req.body?.enabled);
    engine.setExternalExecutionEnabled(enabled);
    return res.json({ ok: true, enabled });
  });

  router.get("/ping", async (_req, res) => {
    try {
      const payload = await engine.runConnectivityPings();
      return res.json(payload);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.status(500).json({ error: msg, ts: Date.now(), results: [] });
    }
  });

  router.get("/status", (_req, res) => res.json(engine.status()));
  router.get("/trading-state", (_req, res) => res.json(engine.getTradingState()));

  router.post("/risk-settings", (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    const body = req.body ?? {};
    const reset = Boolean(body.reset);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const out = engine.setRiskSettings({
      reset,
      entryUsd: num(body.entryUsd),
      minTrade: num(body.minTrade),
      maxTrade: num(body.maxTrade),
      stopLossUsd: num(body.stopLossUsd),
      cooldownMs: num(body.cooldownMs)
    });
    if (!out.ok) return res.status(400).json(out);
    return res.json(out);
  });

  router.post("/risk-settings/persist-env", async (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    const body = req.body ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const entryUsd = num(body.entryUsd);
    const minTrade = num(body.minTrade);
    const maxTrade = num(body.maxTrade);
    const stopLossUsd = num(body.stopLossUsd);
    const cooldownMs = num(body.cooldownMs);
    if (
      entryUsd === undefined ||
      minTrade === undefined ||
      maxTrade === undefined ||
      stopLossUsd === undefined ||
      cooldownMs === undefined
    ) {
      return res.status(400).json({
        ok: false,
        reason: "All of entryUsd, minTrade, maxTrade, stopLossUsd, cooldownMs are required"
      });
    }
    const out = await engine.persistRiskSettingsToEnv({
      entryUsd,
      minTrade,
      maxTrade,
      stopLossUsd,
      cooldownMs
    });
    if (!out.ok) return res.status(400).json(out);
    const wm = engine.status().mode;
    syncExecutionEnvForUiMode(wm === "LIVE" ? "LIVE" : "SIMULATION", {});
    return res.json(out);
  });

  router.post("/entry-strategy", (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    const body = req.body ?? {};
    const reset = Boolean(body.reset);
    const strategy = typeof body.strategy === "string" ? body.strategy : undefined;
    const out = engine.setEntryStrategy({ reset, strategy });
    if (!out.ok) return res.status(400).json(out);
    return res.json(out);
  });

  router.post("/anchor-strategy", (req, res) => {
    if (!requireDashboardAuth(req, res)) return;
    try {
      const enabled = Boolean((req.body as { enabled?: boolean })?.enabled);
      const r = engine.setAnchorStrategyEnabled(enabled);
      res.json({ ok: true as const, anchorStrategy: r.anchorStrategy });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.post("/lag-snipe", (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    const enabled = Boolean(req.body?.enabled);
    const out = engine.setLagSnipe(enabled);
    return res.json(out);
  });

  router.post("/asset-auto-trade", (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    const body = req.body ?? {};
    const asset = typeof body.asset === "string" ? body.asset : "";
    const enabled = body.enabled;
    if (!asset || typeof enabled !== "boolean") {
      return res.status(400).json({ ok: false, reason: "Body must include asset (string) and enabled (boolean)" });
    }
    const out = engine.setAssetAutoTradeEnabled(asset, enabled);
    if (!out.ok) return res.status(400).json(out);
    return res.json(out);
  });

  router.get("/bet-logs", (_req, res) => res.json(engine.getBetLogs()));
  /** @deprecated Prefer GET /trades; same queue as dashboard, filtered to PAPER rows. */
  router.get("/paper-trade-history", (_req, res) =>
    res.json(engine.getTrades().filter((t) => t.executionMode === "PAPER"))
  );
  /** Full engine trade queue (PAPER + LIVE); no server-side filtering. */
  router.get("/trades", (_req, res) => res.json(engine.getTrades()));
  router.get("/trade-log/query", async (req, res) => {
    if (!requireDashboardAuth(req, res)) return;
    const q = req.query as Record<string, string | undefined>;
    const fromMs = q.from ? Date.parse(q.from) : undefined;
    const toMs = q.to ? Date.parse(q.to) : undefined;
    const rows = await tradeLogger.query({
      fromMs: Number.isFinite(fromMs) ? fromMs : undefined,
      toMs: Number.isFinite(toMs) ? toMs : undefined,
      asset: q.asset,
      strategy: q.strategy,
      session: q.session === "AM" || q.session === "PM" || q.session === "24h" ? q.session : "24h"
    });
    return res.json({ rows, stats: tradeLogger.summarize(rows) });
  });
  router.get("/trade-log/export.csv", async (req, res) => {
    if (!requireDashboardAuth(req, res)) return;
    const q = req.query as Record<string, string | undefined>;
    const fromMs = q.from ? Date.parse(q.from) : undefined;
    const toMs = q.to ? Date.parse(q.to) : undefined;
    const rows = await tradeLogger.query({
      fromMs: Number.isFinite(fromMs) ? fromMs : undefined,
      toMs: Number.isFinite(toMs) ? toMs : undefined,
      asset: q.asset,
      strategy: q.strategy,
      session: q.session === "AM" || q.session === "PM" || q.session === "24h" ? q.session : "24h"
    });
    const csv = tradeLogger.toCsv(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=trade-log-export.csv");
    return res.send(csv);
  });
  router.get("/wallet", async (req, res) => {
    if (!requireDashboardAuth(req, res)) return;
    return res.json(await engine.getWalletSummary());
  });
  router.get("/markets", (_req, res) => res.json(engine.getMarkets()));
  router.get("/insights", (_req, res) => res.json(engine.getInsights()));
  router.get("/polymarket/gamma/markets", async (req, res) => res.json(await poly.gammaMarkets(req.query as any)));
  router.get("/polymarket/gamma/events", async (req, res) => res.json(await poly.gammaEvents(req.query as any)));
  router.get("/polymarket/gamma/search", async (req, res) => res.json(await poly.gammaSearch(req.query as any)));
  router.get("/polymarket/gamma/tags", async (req, res) => res.json(await poly.gammaTags(req.query as any)));
  router.get("/polymarket/data/positions", async (req, res) => res.json(await poly.dataPositions(req.query as any)));
  router.get("/polymarket/data/activity", async (req, res) => {
    const user = req.query.user;
    if (typeof user !== "string" || !/^0x[a-fA-F0-9]{40}$/i.test(user.trim())) {
      return res.status(400).json({
        error: "Missing or invalid user",
        reason: "Polymarket Data API /activity requires user=<proxy wallet 0x…> (e.g. CLOB_FUNDER_ADDRESS)."
      });
    }
    try {
      return res.json(await poly.dataActivity(req.query as any));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.status(502).json({ error: msg });
    }
  });
  router.get("/polymarket/data/trades", async (req, res) => res.json(await poly.dataTrades(req.query as any)));
  router.get("/polymarket/data/holders", async (req, res) => res.json(await poly.dataHolders(req.query as any)));
  router.get("/polymarket/clob/book", async (req, res) => {
    const tokenID = String(req.query.tokenID ?? "");
    if (!tokenID) return res.status(400).json({ error: "tokenID required" });
    return res.json(await engine.getMarketContext(tokenID));
  });
  /** Public CLOB host/chain/token IDs for MetaMask browser signing (no API secrets). */
  router.get("/polymarket/clob/signing-config", (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ error: "Login required" });
    const cfg = engine.getClobSigningConfig();
    if (!cfg) {
      return res.status(503).json({
        error: "Signing config unavailable",
        reason: "Set CLOB_FUNDER_ADDRESS and CLOB_TOKEN_ID_UP/DOWN (or enable AUTO_DISCOVER_UPDOWN and LIVE/DEMO_LIVE_MARKETS)."
      });
    }
    return res.json(cfg);
  });
  router.get("/polymarket/clob/open-orders", async (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ error: "Login required" });
    return res.json(await engine.getOpenOrders());
  });
  router.get("/polymarket/clob/balance-allowance", async (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ error: "Login required" });
    return res.json(await engine.getBalanceAllowance());
  });
  router.get("/polymarket/clob/user-trades", async (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ error: "Login required" });
    return res.json(await engine.getUserTrades());
  });

  /** LIVE: CLOB balance minus reserved notional from open BUY orders. */
  router.get("/polymarket/clob/available-collateral", async (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ error: "Login required" });
    const d = await engine.getAvailableCollateralBudget();
    if (!d) return res.json({ balanceUsdc: null, reservedUsdc: null, availableUsdc: null, reason: "LIVE CLOB not active" });
    return res.json(d);
  });

  /** After MetaMask fills an order (browser polled CLOB), settle the engine trade row. */
  router.post("/trades/:tradeId/confirm-fill", (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    const tradeId = String(req.params.tradeId ?? "");
    const out = engine.confirmBrowserTradeFill(tradeId);
    return res.json(out);
  });

  router.post("/trades/:tradeId/clob-order", (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ ok: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ ok: false, reason: "Logged in wallet not allowed" });
    }
    const tradeId = String(req.params.tradeId ?? "");
    const orderId = typeof req.body?.orderId === "string" ? req.body.orderId : "";
    if (!orderId) return res.status(400).json({ ok: false, reason: "orderId required" });
    const ok = engine.attachClobOrderId(tradeId, orderId);
    return res.json({ ok });
  });

  router.post("/market/select", (req, res) => {
    if (!requireDashboardAuth(req, res)) return;
    const { tokenID } = req.body;
    if (typeof tokenID !== "string") return res.status(400).json({ ok: false, reason: "Invalid tokenID" });
    const ok = engine.selectMarket(tokenID);
    if (!ok) return res.status(404).json({ ok: false, reason: "Market not found" });
    return res.json({ ok: true });
  });

  router.post("/trade", async (req, res) => {
    const token = getBearerToken(req.headers.authorization);
    const session = auth.getSession(token);
    if (!session) return res.status(401).json({ accepted: false, reason: "Login required" });
    if (session.authType === "wallet" && !isWalletAuthorized(session.address)) {
      return res.status(403).json({ accepted: false, reason: "Logged in wallet not allowed" });
    }

    const { direction, amount } = req.body;
    if (!["UP", "DOWN"].includes(direction) || typeof amount !== "number") {
      return res.status(400).json({ accepted: false, reason: "Invalid payload" });
    }
    const result = await engine.trade(direction, amount);
    if (!result.accepted) return res.status(400).json(result);
    return res.json(result);
  });

  return router;
}
