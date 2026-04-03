import type { ApiHealthSnapshot } from "../types/index.js";
import type { PingResult } from "../services/apiPings.js";

export type HealthPingFn = () => Promise<{
  ts: number;
  results: PingResult[];
}>;

export function createApiHealthMonitor(ping: HealthPingFn) {
  let last: ApiHealthSnapshot = { ts: 0, ok: true, results: [] };
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    try {
      const r = await ping();
      last = {
        ts: r.ts,
        ok: r.results.every((x) => x.ok),
        results: r.results.map((x) => ({
          name: x.label ?? x.id,
          ok: x.ok,
          ms: x.ms,
          detail: x.error ?? x.note
        }))
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      last = {
        ts: Date.now(),
        ok: false,
        results: [{ name: "health_ping", ok: false, detail: msg }]
      };
    }
  };

  return {
    start(intervalMs = 30_000) {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    getSnapshot(): ApiHealthSnapshot {
      return { ...last, results: [...last.results] };
    }
  };
}
