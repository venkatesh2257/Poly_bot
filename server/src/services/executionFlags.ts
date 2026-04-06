/**
 * Live vs paper execution (read after `dotenv.config` in `index.ts`).
 * SIMULATION always uses the paper fill path; LIVE posts only when enabled below.
 */

export function readEnvBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === "") return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return defaultValue;
}

export function paperTradingEnv(): boolean {
  return readEnvBool("PAPER_TRADING", true);
}

/** When true with MODE=LIVE, post signed CLOB orders (entries / cancels / market sells). */
export function executeTradesEnv(): boolean {
  return readEnvBool("EXECUTE_TRADES", false);
}

/** Hard block on all mutating CLOB HTTP even if MODE=LIVE and EXECUTE_TRADES=true. */
export function paperOnlyEnv(): boolean {
  return readEnvBool("PAPER_ONLY", false);
}

/** Paper-test defaults only when not explicitly running LIVE from .env (avoids fighting Go LIVE / CLOB). */
export function applyDefaultPaperTestEnv(): void {
  const modeRaw = String(process.env.MODE ?? "").trim().toUpperCase();
  if (modeRaw === "LIVE") {
    // MODE=LIVE with omitted flags used to leave PAPER_TRADING defaulting to true and EXECUTE_TRADES to false
    // (readEnvBool defaults) — that blocks all CLOB posts. Only fill blanks so explicit .env still wins.
    if (process.env.PAPER_TRADING === undefined || String(process.env.PAPER_TRADING).trim() === "") {
      process.env.PAPER_TRADING = "false";
    }
    if (process.env.PAPER_ONLY === undefined || String(process.env.PAPER_ONLY).trim() === "") {
      process.env.PAPER_ONLY = "false";
    }
    if (process.env.EXECUTE_TRADES === undefined || String(process.env.EXECUTE_TRADES).trim() === "") {
      process.env.EXECUTE_TRADES = "true";
    }
    if (!readEnvBool("PAPER_TRADING", true) && readEnvBool("PAPER_ONLY", false)) {
      process.env.PAPER_ONLY = "false";
    }
    return;
  }
  if (process.env.PAPER_TRADING === undefined || String(process.env.PAPER_TRADING).trim() === "") {
    process.env.PAPER_TRADING = "true";
  }
  if (process.env.EXECUTE_TRADES === undefined || String(process.env.EXECUTE_TRADES).trim() === "") {
    process.env.EXECUTE_TRADES = "false";
  }
  // PAPER_TRADING=false must not pair with PAPER_ONLY=true (would block CLOB with no paper path).
  if (!readEnvBool("PAPER_TRADING", true) && readEnvBool("PAPER_ONLY", false)) {
    process.env.PAPER_ONLY = "false";
  }
}

/**
 * Session overrides for UI/API mode switches. Unconditional writes — server owns flags (body ignored for values).
 */
export function syncExecutionEnvForUiMode(mode: "SIMULATION" | "LIVE", _body?: Record<string, unknown>): void {
  if (mode === "LIVE") {
    process.env.MODE = "LIVE";
    process.env.PAPER_TRADING = "false";
    process.env.PAPER_ONLY = "false";
    process.env.EXECUTE_TRADES = "true";
    console.log("[ENV] env set: PAPER_TRADING=false PAPER_ONLY=false EXECUTE_TRADES=true (mode=LIVE)");
  } else {
    process.env.MODE = "SIMULATION";
    process.env.PAPER_TRADING = "true";
    process.env.PAPER_ONLY = "true";
    process.env.EXECUTE_TRADES = "false";
    console.log("[ENV] env set: PAPER_TRADING=true PAPER_ONLY=true EXECUTE_TRADES=false (mode=SIMULATION)");
  }
}

/** Snapshot for API responses (reads current process.env after sync). */
export function executionEnvSnapshotStrings() {
  return {
    mode: (process.env.MODE ?? "") as "SIMULATION" | "LIVE" | string,
    paperTrading: paperTradingEnv(),
    executeTrades: executeTradesEnv(),
    paperOnly: paperOnlyEnv(),
    PAPER_TRADING: process.env.PAPER_TRADING ?? "",
    PAPER_ONLY: process.env.PAPER_ONLY ?? "",
    EXECUTE_TRADES: process.env.EXECUTE_TRADES ?? ""
  };
}
