const WebSocket = require("ws");

const RTDS_URL = "wss://ws-live-data.polymarket.com";
const subs = [{ topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"eth/usd"}' }];

const WS_CONNECT_OPTS = { perMessageDeflate: false, handshakeTimeout: 12000 };
const ws = new WebSocket(RTDS_URL, WS_CONNECT_OPTS);
const counts = new Map();
const firstPerSym = new Set();
ws.on("open", () => {
  ws.send(JSON.stringify({ action: "subscribe", subscriptions: subs }));
  console.log("subscribed");
});

ws.on("message", (data) => {
  const s = data.toString();
  if (!s.startsWith("{")) return;
  try {
    const j = JSON.parse(s);
    if (j.topic === "crypto_prices_chainlink" && j.payload && j.payload.symbol) {
      console.log("msg", {
        symbol: j.payload.symbol,
        symbolJson: JSON.stringify(j.payload.symbol),
        symbolLen: j.payload.symbol?.length,
        value: j.payload.value,
        type: typeof j.payload.value
      });
      counts.set(j.payload.symbol, (counts.get(j.payload.symbol) ?? 0) + 1);
      if (!firstPerSym.has(j.payload.symbol)) {
        firstPerSym.add(j.payload.symbol);
        console.log("first", j.payload.symbol, "value", j.payload.value, "type", typeof j.payload.value);
      }
    }
  } catch {
    // ignore non-json
  }
});

ws.on("close", () => process.exit(0));
ws.on("error", (e) => {
  console.error("err", e);
  process.exit(1);
});
setTimeout(() => {
  console.log("counts", Object.fromEntries(counts.entries()));
  ws.close();
}, 25000);

