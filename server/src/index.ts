import express from "express";
import cors from "cors";
import { config } from "dotenv";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiRouter } from "./routes/api.js";
import { TradingEngine } from "./services/engine.js";
import { AuthService } from "./services/auth.js";
import { TradeLogger } from "./services/tradeLogger.js";
import { applyDefaultPaperTestEnv } from "./services/executionFlags.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.resolve(__dirname, "../.env") });
applyDefaultPaperTestEnv();
{
  const modeRaw = String(process.env.MODE ?? "").trim().toUpperCase();
  const ex = String(process.env.EXECUTE_TRADES ?? "").trim().toLowerCase();
  if (modeRaw === "LIVE" && ex !== "true") {
    console.warn(
      "[STARTUP][WARN] MODE=LIVE but EXECUTE_TRADES is not true; live orders will not be sent"
    );
  }
}

const PORT = Number(process.env.PORT ?? 4000);
const WS_PORT = Number(process.env.WS_PORT ?? 4001);

const app = express();
const engine = new TradingEngine();
const auth = new AuthService();
const tradeLogger = new TradeLogger();
const seenSettled = new Set<string>();
const strategyRegistry = ["momentum", "lag_snipe", "anchor"];

app.use(cors());
app.use(express.json());
app.use(
  "/api",
  createApiRouter(engine, auth, tradeLogger, (payload) => send({ type: "inspection", payload }))
);

/** Avoid 404 confusion: API has no HTML; point clients at this host + optional dashboard URL. */
app.get("/", (req, res) => {
  const host = req.get("host") || `127.0.0.1:${PORT}`;
  const xfProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const proto =
    xfProto === "https" || req.secure ? "https" : xfProto === "http" ? "http" : "http";
  const base = `${proto}://${host}`;
  const wsProto = proto === "https" ? "wss" : "ws";
  const wsHost = host.includes(":") ? host.split(":")[0]! : host;
  const dashboardPublic = process.env.DASHBOARD_PUBLIC_URL?.trim();
  const dashboard =
    dashboardPublic ||
    (process.env.NODE_ENV === "production"
      ? null
      : `${proto}://127.0.0.1:${String(process.env.VITE_PORT ?? 5174)}`);
  res.type("application/json").send(
    JSON.stringify(
      {
        service: "PolyBot API",
        dashboard,
        api: `${base}/api`,
        websocket: `${wsProto}://${wsHost}:${WS_PORT}`,
        hint:
          "Open the dashboard URL in a browser for the UI. Set DASHBOARD_PUBLIC_URL when the UI is not on localhost. The app connects to `websocket` automatically (do not paste it into the address bar)."
      },
      null,
      2
    )
  );
});

const wsServer = new WebSocketServer({ port: WS_PORT });
const send = (payload: unknown) => {
  const msg = JSON.stringify(payload);
  wsServer.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
};

wsServer.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "status", payload: engine.status() }));
  socket.send(JSON.stringify({ type: "trade", payload: engine.getTrades() }));
  socket.send(JSON.stringify({ type: "market", payload: engine.getMarketData() }));
  socket.send(JSON.stringify({ type: "prediction", payload: engine.getPrediction() }));
  socket.send(JSON.stringify({ type: "betLogs", payload: engine.getBetLogs() }));
});

engine.onMarket = (data) => send({ type: "market", payload: data });
engine.onPrediction = (data) => send({ type: "prediction", payload: data });
engine.onTrades = () => send({ type: "trade", payload: engine.getTrades() });
engine.onStatus = (data) => send({ type: "status", payload: data });
engine.onLog = (data) => send({ type: "log", payload: data });
engine.onBetLog = (data) => send({ type: "betLog", payload: data });

void (async () => {
  // Force Chainlink RPC resolve + 4-asset probe before wallet/markets (always logs on clean boot).
  try {
    await engine.bootChainlink();
  } catch (e) {
    console.error("[BOOT] Chainlink boot error:", e);
  }
  await Promise.all([engine.init(), tradeLogger.init()]);
  console.log(`[BOOT] Strategy registry: ${strategyRegistry.join(", ")}`);
  setInterval(() => {
    const trades = engine.getTrades();
    for (const t of trades) {
      if (t.status !== "WIN" && t.status !== "LOSS" && t.status !== "CLOSED") continue;
      const key = `${t.id}:${t.status}:${Number(t.pnl ?? 0).toFixed(4)}`;
      if (seenSettled.has(key)) continue;
      seenSettled.add(key);
      void tradeLogger.recordSettledTrade(t).catch((e) => {
        console.error("trade log persist failed", e);
      });
    }
  }, 2500);
  app.listen(PORT, () => {
    console.log(`API running on :${PORT}`);
    console.log(`WS running on :${WS_PORT}`);
  });
})().catch((e) => {
  console.error("Fatal server startup:", e);
  process.exitCode = 1;
});
