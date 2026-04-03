import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AdaptiveConfigFile } from "../types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "../..");
const configDir = path.resolve(serverRoot, "config");
const adaptivePath = path.resolve(configDir, "adaptiveConfig.json");

export type AdaptiveStatsInput = {
  demoRows: { pnl: number; status: string }[];
  liveRows: { pnl: number; status: string }[];
  currentMaxSpread?: number;
};

export function createAdaptiveLearningJob(
  loadStats: () => Promise<AdaptiveStatsInput>,
  onSaved?: (cfg: AdaptiveConfigFile) => void
) {
  let timer: ReturnType<typeof setInterval> | null = null;

  const run = async () => {
    try {
      await mkdir(configDir, { recursive: true });
      const s = await loadStats();
      const dPnL = s.demoRows.reduce((a, b) => a + b.pnl, 0);
      const lPnL = s.liveRows.reduce((a, b) => a + b.pnl, 0);
      const dN = s.demoRows.length;
      const hint =
        dN < 3 && s.liveRows.length < 3
          ? "insufficient_history"
          : dPnL < lPnL - 1
            ? "demo_underperforming_vs_live"
            : "nominal";
      const next: AdaptiveConfigFile = {
        lastRunMs: Date.now(),
        hint,
        demoSample: dN,
        liveSample: s.liveRows.length,
        demoPnlSum: dPnL,
        livePnlSum: lPnL
      };
      if (typeof s.currentMaxSpread === "number" && Number.isFinite(s.currentMaxSpread)) {
        next.observedMaxSpread = s.currentMaxSpread;
      }
      await writeFile(adaptivePath, JSON.stringify(next, null, 2), "utf8");
      onSaved?.(next);
    } catch {
      /* ignore */
    }
  };

  return {
    async runOnce() {
      await run();
    },
    startHourly() {
      if (timer) return;
      void run();
      timer = setInterval(() => void run(), 3_600_000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    async readConfig(): Promise<AdaptiveConfigFile> {
      try {
        const raw = await readFile(adaptivePath, "utf8");
        return JSON.parse(raw) as AdaptiveConfigFile;
      } catch {
        return { lastRunMs: 0 };
      }
    }
  };
}
