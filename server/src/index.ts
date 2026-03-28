import express from "express";
import cors from "cors";
import { config } from "dotenv";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiRouter } from "./routes/api.js";
import { TradingEngine } from "./services/engine.js";
import { AuthService } from "./services/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.resolve(__dirname, "../.env") });

const PORT = Number(process.env.PORT ?? 4000);
const WS_PORT = Number(process.env.WS_PORT ?? 4001);

const app = express();
const engine = new TradingEngine();
const auth = new AuthService();

app.use(cors());
app.use(express.json());
app.use(
  "/api",
  createApiRouter(engine, auth, (payload) => send({ type: "inspection", payload }))
);

/** Avoid 404 confusion: API has no HTML; point users to the Vite app. */
app.get("/", (_req, res) => {
  res.type("application/json").send(
    JSON.stringify(
      {
        service: "PolyBot API",
        dashboard: "http://localhost:5173",
        api: `http://localhost:${PORT}/api`,
        websocket: `ws://localhost:${WS_PORT}`,
        hint: "Open `dashboard` for the UI. Do not paste `websocket` into Chrome — the app connects to it automatically."
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
engine.onTrades = (data) => send({ type: "trade", payload: data });
engine.onStatus = (data) => send({ type: "status", payload: data });
engine.onLog = (data) => send({ type: "log", payload: data });
engine.onBetLog = (data) => send({ type: "betLog", payload: data });

engine.init().then(() => {
  app.listen(PORT, () => {
    console.log(`API running on :${PORT}`);
    console.log(`WS running on :${WS_PORT}`);
  });
});
