import path from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { AlertEvent, AlertSeverity } from "../types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "../..");
const alertsLog = path.resolve(serverRoot, "logs", "alerts.log");

export type AlertSink = (ev: AlertEvent) => void;

export class AlertEngine {
  private recent = new Map<string, number>();
  private readonly dedupeMs: number;

  constructor(
    private readonly broadcast: AlertSink,
    opts?: { dedupeMs?: number }
  ) {
    this.dedupeMs = opts?.dedupeMs ?? 60_000;
  }

  async emit(severity: AlertSeverity, source: string, message: string) {
    const key = `${source}:${message}`;
    const now = Date.now();
    const prev = this.recent.get(key) ?? 0;
    if (now - prev < this.dedupeMs) return;
    this.recent.set(key, now);
    const ev: AlertEvent = {
      id: randomUUID(),
      severity,
      source,
      message,
      ts: now
    };
    this.broadcast(ev);
    try {
      await mkdir(path.dirname(alertsLog), { recursive: true });
      await appendFile(alertsLog, `${new Date(ev.ts).toISOString()} [${ev.severity}] ${ev.source}: ${ev.message}\n`, "utf8");
    } catch {
      /* ignore disk */
    }
  }
}
