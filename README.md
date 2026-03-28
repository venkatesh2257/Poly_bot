# PolyBot Full-Stack Dashboard

Production-ready Polymarket-style prediction trading dashboard with:

- React + TypeScript frontend
- Express + WebSocket backend
- Bot engine module
- Simulation mode (default)
- Optional live wallet mode with `ethers` + `@polymarket/clob-client`

## Project Structure

```
/frontend  React UI (chart, trading panel, history, stats, logs)
/server    API + websocket + trade engine + wallet integration
/bot       Prediction engine (trend + randomness)
```

## Features

- Real-time BTC-style market chart updates every `800ms` (80 points retained)
- Prediction signal every `5s` with `92-100%` confidence
- Instant P&L preview before placing trade
- 5-second trade resolution lifecycle
- Full trade history + filters (`ALL/WIN/LOSS`)
- Stats: win rate, profit factor, net P&L, gross win/loss
- Colored live logs (`WIN`, `ERROR`, `SIGNAL`, `TRADE`)
- Safety: min/max trade, cooldown, stop-loss
- Mode system: `SIMULATION` (default) and `LIVE`

## Environment

Copy `server/.env.example` to `server/.env` and configure:

```
MODE=SIMULATION
PORT=4000
WS_PORT=4001
START_BALANCE=1000
MIN_TRADE=1
MAX_TRADE=300
ENTRY_USD=1
COOLDOWN_MS=1500
STOP_LOSS=300
EVM_PRIVATE_KEY=your_key
RPC_URL=https://polygon-rpc.com
PROXY_URL=eu_proxy
PROXY_SECRET=secret
```

## Install and Run

From repo root:

```bash
npm install
npm run dev:server
npm run dev:frontend
```

Frontend: `http://localhost:5173`  
Backend API: `http://localhost:4000/api`  
WebSocket: `ws://localhost:4001`

## API

- `POST /api/start`
- `POST /api/stop`
- `POST /api/trade`
- `GET /api/status`
- `GET /api/trades`
- `GET /api/wallet`

## Live Order Validation

Trade accepted only when:

- `result.orderID !== "unknown"`
- `result.sizeFilled > 0`

## Security

- Private key is backend-only (never sent to frontend)
- Frontend only calls backend `/api` endpoints
