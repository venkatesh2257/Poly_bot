# Poly Bot Runbook

Operational source of truth for paper/live expectations across repo bots.

## 1) Dashboard Server Bot (`server` + `frontend`)

- **Paper mode**
  - Set server mode to `SIMULATION` (UI mode switch or env defaults).
  - Keep `EXECUTE_TRADES=false` (or `PAPER_TRADING=true` / `PAPER_ONLY=true`).
  - Check `tradingState.executionLabel=PAPER_ONLY`.
- **Live mode requirements**
  - `MODE=LIVE`
  - CLOB auth ready (`tradingState.clobAuthenticated=true`)
  - execution env allows posting (`EXECUTE_TRADES=true`, not paper-only flags)
  - selected strategy must be execution-eligible (`tradingState.executionEligibility.selectedEligible=true`)
- **Primary status fields**
  - `tradingState.executionTruth` (signal/decision/attempt/block/posted order)
  - `tradingState.sessionTelemetry` (top skips/blockers this session)
  - `tradingState.liveReadiness`, `tradingState.executionEligibility`
- **Common failure checks**
  - No entries: `executionTruth.lastExecutionBlockReason`, `sessionTelemetry.topExecutionBlocks`
  - Discovery idle: `liveEngine.discoveryGraceActive`, `sessionTelemetry.topDiscoveryFailures`
  - Oracle stale: `liveEngine.marketDataBlockReason`, `sessionTelemetry.topOracleStaleEvents`

## 2) Standalone TS Bot (`bot`)

- **Paper mode**
  - `state.config.dryRun=true` OR missing `EVM_PRIVATE_KEY`.
  - Missing key now forces **runtime-only** dry-run (does not overwrite saved config).
- **Live mode requirements**
  - `state.config.dryRun=false` and valid `EVM_PRIVATE_KEY`.
  - CLOB client auth succeeds at startup.
- **Not fully live-capable means**
  - If key/auth missing, it remains safe dry-run for that session.
- **Common failure checks**
  - Startup logs: mode line + `[bot] CLOB client authenticated` status.
  - `/status` response `dryRun` reflects effective runtime mode.

## 3) PM5M Bot (`pm5m_bot`)

- **Paper mode**
  - Use dry-run/paper executor settings in PM5M env.
- **Live mode requirements**
  - Live executor env + credentials configured; SM enabled as needed.
- **Common failure checks**
  - PM5M logs for `SM_ENABLED`, live executor availability, and order placement path.

## 4) HF Anchor Bot (`hf_anchor_bot`)

- **Paper mode**
  - `DRY_RUN=true` (default safe).
- **Live mode requirements**
  - `DRY_RUN=false`
  - live executor wired (`HF_ANCHOR_LIVE_EXECUTOR_AVAILABLE=true` + executor implementation)
- **Not fully live-capable means**
  - If executor flag/config missing, signals may still compute but orders will not route live.
- **Common failure checks**
  - `ANCHOR_SKIP` categories and execution logs.
  - `.env.example` comments for smoke logs and live executor wiring.

## Quick startup diagnostics checklist

1. Confirm selected strategy and mode.
2. Confirm execution eligibility for that strategy.
3. Confirm auth/executor readiness (live only).
4. Confirm discovery + market data freshness.
5. Confirm `executionTruth` transitions:
   - signal recommendation -> strategy decision -> execution attempt -> posted order or block reason.

## Developer replay/debug utility

- Command: `npm --workspace server run replay:decisions`
- Optional input file: `npm --workspace server run replay:decisions -- ./server/scripts/replay.sample.json`
- Output: compact JSON lines for:
  - `anchor` decision (`enter` vs `skip`, category/reason)
  - `professional` tick-by-tick state-machine decisions/log tail
