import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "../..");

export type RiskEnvValues = {
  entryUsd: number;
  minTrade: number;
  maxTrade: number;
  stopLossUsd: number;
  cooldownMs: number;
};

export function resolveServerDotEnvPath(): string {
  return path.resolve(serverRoot, ".env");
}

export async function writeRiskSettingsToDotEnv(
  envPath: string,
  input: RiskEnvValues
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    let raw = "";
    try {
      raw = await readFile(envPath, "utf8");
    } catch {
      raw = "";
    }
    const updates: Record<string, string> = {
      ENTRY_USD: String(input.entryUsd),
      MIN_TRADE: String(input.minTrade),
      MAX_TRADE: String(input.maxTrade),
      STOP_LOSS: String(input.stopLossUsd),
      COOLDOWN_MS: String(Math.round(input.cooldownMs))
    };
    const keys = new Set(Object.keys(updates));
    const lines = raw.split(/\r?\n/);
    const result: string[] = [];
    const replaced = new Set<string>();
    for (const line of lines) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
      if (m && keys.has(m[1])) {
        result.push(`${m[1]}=${updates[m[1]]}`);
        replaced.add(m[1]);
      } else {
        result.push(line);
      }
    }
    for (const k of keys) {
      if (!replaced.has(k)) result.push(`${k}=${updates[k]}`);
    }
    await writeFile(envPath, result.join("\n").replace(/\n+$/, "\n"), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function applyRiskToProcessEnv(input: RiskEnvValues) {
  process.env.ENTRY_USD = String(input.entryUsd);
  process.env.MIN_TRADE = String(input.minTrade);
  process.env.MAX_TRADE = String(input.maxTrade);
  process.env.STOP_LOSS = String(input.stopLossUsd);
  process.env.COOLDOWN_MS = String(Math.round(input.cooldownMs));
}
