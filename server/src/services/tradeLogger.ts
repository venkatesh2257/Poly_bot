import path from "node:path";
import { mkdir, appendFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import type { Trade } from "../types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "../..");
const logsDir = path.resolve(serverRoot, "logs");
const backupDir = path.resolve(logsDir, "backup");
const dbPath = path.resolve(serverRoot, "trades.db");

export type TradeLogFilters = {
  fromMs?: number;
  toMs?: number;
  asset?: string;
  strategy?: string;
  session?: "24h" | "AM" | "PM";
};

export type TradeLogRow = {
  id: string;
  timeIso: string;
  asset: string;
  strategy: string;
  side: "UP" | "DOWN";
  prob: number | null;
  entry: number;
  exit: number | null;
  pnl: number;
  status: "WIN" | "LOSS";
};

function csvEscape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function localDateParts(ts: number) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return { yyyy, mm, dd };
}

function strategyFromDecisionReason(reason?: string): string {
  const s = String(reason ?? "").toUpperCase();
  if (s.startsWith("LAG_SNIPE")) return "lag_snipe";
  if (s.startsWith("OLA")) return "ola";
  if (s.startsWith("WHALE")) return "whale_edge";
  if (s.startsWith("ENSEMBLE")) return "ensemble";
  if (s.startsWith("ORDERBOOK")) return "orderbook";
  if (s.startsWith("MEAN_REVERT")) return "mean_revert";
  if (s.startsWith("CHART")) return "chart";
  return "momentum";
}

function toProb(t: Trade): number | null {
  if (t.direction === "UP") return Number.isFinite(t.upPriceAtEntry ?? NaN) ? Number(t.upPriceAtEntry) : null;
  return Number.isFinite(t.downPriceAtEntry ?? NaN) ? Number(t.downPriceAtEntry) : null;
}

function toExitPrice(t: Trade): number | null {
  if (t.status === "WIN") return 1;
  if (t.status === "LOSS") return 0;
  return null;
}

export class TradeLogger {
  private db: Database | null = null;

  async init() {
    await mkdir(logsDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });
    this.db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        time_iso TEXT NOT NULL,
        closed_at_ms INTEGER NOT NULL,
        asset TEXT NOT NULL,
        strategy TEXT NOT NULL,
        side TEXT NOT NULL,
        prob REAL,
        entry REAL NOT NULL,
        exit REAL,
        pnl REAL NOT NULL,
        status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_at_ms);
      CREATE INDEX IF NOT EXISTS idx_trades_asset ON trades(asset);
      CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
    `);
  }

  private ensureDb(): Database {
    if (!this.db) throw new Error("TradeLogger not initialized");
    return this.db;
  }

  async recordSettledTrade(t: Trade, ts = Date.now()) {
    if (t.status !== "WIN" && t.status !== "LOSS") return;
    const db = this.ensureDb();
    const row: TradeLogRow = {
      id: t.id,
      timeIso: new Date(ts).toISOString(),
      asset: (t.asset ?? "UNKNOWN").toUpperCase(),
      strategy: strategyFromDecisionReason(t.decisionReason),
      side: t.direction,
      prob: toProb(t),
      entry: Number(t.price ?? 0),
      exit: toExitPrice(t),
      pnl: Number(t.pnl ?? 0),
      status: t.status
    };
    await db.run(
      `INSERT INTO trades (id, time_iso, closed_at_ms, asset, strategy, side, prob, entry, exit, pnl, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         time_iso=excluded.time_iso,
         closed_at_ms=excluded.closed_at_ms,
         asset=excluded.asset,
         strategy=excluded.strategy,
         side=excluded.side,
         prob=excluded.prob,
         entry=excluded.entry,
         exit=excluded.exit,
         pnl=excluded.pnl,
         status=excluded.status`,
      row.id,
      row.timeIso,
      ts,
      row.asset,
      row.strategy,
      row.side,
      row.prob,
      row.entry,
      row.exit,
      row.pnl,
      row.status
    );
    await this.appendDailyCsv(row);
  }

  private async appendDailyCsv(row: TradeLogRow) {
    const ts = Date.parse(row.timeIso);
    const { yyyy, mm, dd } = localDateParts(ts);
    const line = [
      row.timeIso,
      row.asset,
      row.strategy,
      row.side,
      row.prob == null ? "" : row.prob.toFixed(4),
      row.entry.toFixed(6),
      row.exit == null ? "" : row.exit.toFixed(6),
      row.pnl.toFixed(6),
      row.status
    ]
      .map((v) => csvEscape(String(v)))
      .join(",");
    const header = "time,asset,strategy,side,prob,entry,exit,pnl,status\n";
    const dayFile = path.resolve(logsDir, `${yyyy}-${mm}-${dd}.csv`);
    const backupMonth = path.resolve(backupDir, `${yyyy}-${mm}`);
    await mkdir(backupMonth, { recursive: true });
    const backupFile = path.resolve(backupMonth, `${yyyy}-${mm}-${dd}.csv`);
    const dayExists = await stat(dayFile).then(() => true).catch(() => false);
    const backupExists = await stat(backupFile).then(() => true).catch(() => false);
    await appendFile(dayFile, `${dayExists ? "" : header}${line}\n`, "utf8");
    await appendFile(backupFile, `${backupExists ? "" : header}${line}\n`, "utf8");
  }

  async query(filters: TradeLogFilters): Promise<TradeLogRow[]> {
    const db = this.ensureDb();
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filters.fromMs != null) {
      where.push("closed_at_ms >= ?");
      args.push(filters.fromMs);
    }
    if (filters.toMs != null) {
      where.push("closed_at_ms <= ?");
      args.push(filters.toMs);
    }
    if (filters.asset && filters.asset !== "ALL") {
      where.push("asset = ?");
      args.push(filters.asset.toUpperCase());
    }
    if (filters.strategy && filters.strategy !== "ALL") {
      where.push("strategy = ?");
      args.push(filters.strategy.toLowerCase());
    }
    let sql = `SELECT id, time_iso as timeIso, asset, strategy, side, prob, entry, exit, pnl, status, closed_at_ms as closedAtMs FROM trades`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY closed_at_ms DESC LIMIT 5000";
    const rows = (await db.all(sql, ...args)) as Array<TradeLogRow & { closedAtMs: number }>;
    const session = filters.session ?? "24h";
    if (session === "24h") return rows;
    return rows.filter((r) => {
      const h = new Date(r.closedAtMs).getHours();
      return session === "AM" ? h < 12 : h >= 12;
    });
  }

  summarize(rows: TradeLogRow[]) {
    const total = rows.length;
    const wins = rows.filter((r) => r.status === "WIN").length;
    const pnl = rows.reduce((s, r) => s + r.pnl, 0);
    const avgPnl = total > 0 ? pnl / total : 0;
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    const byAsset = new Map<string, { n: number; pnl: number }>();
    const byStrategy = new Map<string, { n: number; pnl: number }>();
    for (const r of rows) {
      const a = byAsset.get(r.asset) ?? { n: 0, pnl: 0 };
      a.n += 1;
      a.pnl += r.pnl;
      byAsset.set(r.asset, a);
      const st = byStrategy.get(r.strategy) ?? { n: 0, pnl: 0 };
      st.n += 1;
      st.pnl += r.pnl;
      byStrategy.set(r.strategy, st);
    }
    const bestAsset = [...byAsset.entries()].sort((x, y) => y[1].pnl - x[1].pnl)[0]?.[0] ?? null;
    const bestStrategy = [...byStrategy.entries()].sort((x, y) => y[1].pnl - x[1].pnl)[0]?.[0] ?? null;
    return { total, wins, winRate, pnl, avgPnl, bestAsset, bestStrategy };
  }

  toCsv(rows: TradeLogRow[]): string {
    const header = "time,asset,strategy,side,prob,entry,exit,pnl,status";
    const lines = rows.map((r) =>
      [
        r.timeIso,
        r.asset,
        r.strategy,
        r.side,
        r.prob == null ? "" : r.prob.toFixed(4),
        r.entry.toFixed(6),
        r.exit == null ? "" : r.exit.toFixed(6),
        r.pnl.toFixed(6),
        r.status
      ]
        .map((v) => csvEscape(String(v)))
        .join(",")
    );
    return [header, ...lines].join("\n");
  }
}

