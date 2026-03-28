import type { BetLogEntry } from "./types";

type LogEntry = { ts: number; level: string; message: string };

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function triggerDownload(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadBetLogsCsv(rows: BetLogEntry[]) {
  const headers = [
    "ts_iso",
    "trading_mode",
    "outcome",
    "market_title",
    "token_id",
    "direction",
    "best_bid",
    "best_ask",
    "spread",
    "mid",
    "liquidity",
    "price_unit",
    "seconds_since_window_start",
    "warmup_window",
    "block_reason",
    "max_spread",
    "min_liquidity"
  ];
  const lines = [headers.join(",")];
  for (const b of rows) {
    const iso = new Date(b.ts).toISOString();
    const mode = b.tradingMode ?? "";
    const row = [
      iso,
      mode,
      b.outcome,
      b.marketTitle,
      b.tokenId,
      b.direction,
      String(b.bestBid),
      String(b.bestAsk),
      String(b.spread),
      String(b.mid),
      String(b.liquidity),
      b.priceUnit,
      b.secondsSinceWindowStart == null ? "" : String(b.secondsSinceWindowStart),
      b.warmupWindow ? "true" : "false",
      b.blockReason ?? "",
      b.maxSpread != null ? String(b.maxSpread) : "",
      b.minLiquidity != null ? String(b.minLiquidity) : ""
    ].map((c) => escapeCsvCell(String(c)));
    lines.push(row.join(","));
  }
  const body = "\uFEFF" + lines.join("\r\n");
  triggerDownload(`polybot-bet-logs-${Date.now()}.csv`, body, "text/csv;charset=utf-8");
}

export function downloadLiveLogsCsv(rows: LogEntry[]) {
  const headers = ["ts_iso", "level", "message"];
  const lines = [headers.join(",")];
  for (const l of rows) {
    const iso = new Date(l.ts).toISOString();
    const row = [iso, l.level, l.message].map((c) => escapeCsvCell(String(c)));
    lines.push(row.join(","));
  }
  const body = "\uFEFF" + lines.join("\r\n");
  triggerDownload(`polybot-live-logs-${Date.now()}.csv`, body, "text/csv;charset=utf-8");
}
