import type { SynthesisMarketDataHealthPayload } from "./types";

const EVENT_LABEL: Record<string, string> = {
  drift_warn: "Drift warn",
  drift_crit: "Drift critical",
  drift_ok: "Drift OK",
  syn_stale: "Synthesis stale",
  syn_ok: "Synthesis fresh",
  nat_stale: "Native book stale",
  nat_ok: "Native book fresh",
  fb_drift: "Fallback off (drift)",
  fb_ok: "Fallback on"
};

function levelBadgeClass(lv: string): string {
  if (lv === "critical") return "border-rose-500/60 bg-rose-950/50 text-rose-200";
  if (lv === "warn") return "border-amber-500/50 bg-amber-950/40 text-amber-200";
  return "border-emerald-600/50 bg-emerald-950/40 text-emerald-200";
}

function SparklineMb(props: { mb: number[]; w: number; h: number }) {
  const { mb, w, h } = props;
  if (mb.length < 2) {
    return (
      <div className="text-[10px] text-slate-500" style={{ width: w, height: h }}>
        —
      </div>
    );
  }
  const max = Math.max(...mb, 1);
  const pts = mb.map((v, i) => {
    const x = (i / (mb.length - 1)) * w;
    const y = h - (v / max) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={w} height={h} className="shrink-0 text-violet-400/90" aria-hidden>
      <polyline fill="none" stroke="currentColor" strokeWidth={1.25} points={pts.join(" ")} />
    </svg>
  );
}

export function MarketDataHealthPanel(props: { health: SynthesisMarketDataHealthPayload | null }) {
  const { health } = props;
  if (!health) return null;

  const { drift, staleness, fallbackEligible, fallbackBlockReason, history } = health;
  const natAge = staleness.nativeOrderbook.ageMs;
  const synObAge = staleness.synthesisOrderbook.ageMs;
  const synPrAge = staleness.synthesisPrices.ageMs;
  const fmtAge = (a: number | null | undefined) =>
    a == null || !Number.isFinite(a) ? "—" : `${Math.round(a / 1000)}s`;

  const recentEvents = history?.events?.slice(-6) ?? [];

  return (
    <div className="rounded-lg border border-violet-900/50 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-300">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-slate-200">Market data health</span>
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${levelBadgeClass(drift.level)}`}>
          {drift.level}
        </span>
        <span className="font-mono text-slate-400">{Number.isFinite(drift.maxBps) ? `${drift.maxBps.toFixed(0)} bps` : "—"}</span>
        <span
          className={
            "rounded border px-1.5 py-0.5 text-[10px] font-semibold " +
            (fallbackEligible ? "border-emerald-800/60 text-emerald-300" : "border-slate-600 text-slate-400")
          }
        >
          Fallback {fallbackEligible ? "yes" : "no"}
        </span>
        {!fallbackEligible ? (
          <span className="truncate text-[10px] text-slate-500" title={fallbackBlockReason}>
            {fallbackBlockReason}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-slate-500">Drift (max bps)</div>
          <SparklineMb mb={history?.mb ?? []} w={120} h={36} />
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-[10px] text-slate-400">
          <span>Native age</span>
          <span>{fmtAge(natAge)}</span>
          <span>Syn OB age</span>
          <span>{fmtAge(synObAge)}</span>
          <span>Syn price age</span>
          <span>{fmtAge(synPrAge)}</span>
        </div>
      </div>
      {history?.lastEvent ? (
        <p className="mt-1.5 text-[10px] text-slate-500">
          Last event: {EVENT_LABEL[history.lastEvent.k] ?? history.lastEvent.k}
          {history.lastEvent.d ? ` · ${history.lastEvent.d}` : ""}
        </p>
      ) : null}
      {recentEvents.length > 0 ? (
        <ul className="mt-1.5 max-h-16 overflow-y-auto border-t border-slate-800/80 pt-1.5 text-[10px] text-slate-500">
          {recentEvents.map((e, i) => (
            <li key={`${e.t}-${e.k}-${i}`} className="truncate">
              {EVENT_LABEL[e.k] ?? e.k}
              {e.d ? ` · ${e.d}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {history ? (
        <p className="mt-1 text-[9px] text-slate-600">
          History: ≤{history.maxPoints} pts · sample ~{history.sampleMs}ms · events ≤{history.maxEvents}
        </p>
      ) : null}
    </div>
  );
}
