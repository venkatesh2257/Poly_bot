import type { ReactNode } from "react";
import { BRAND_LOGO_SRC } from "./branding";

export type SnipeRoute = "dashboard" | "strategies" | "tools" | "settings" | "journal" | "wizard";

const NAV: { id: SnipeRoute; label: string; sub: string }[] = [
  { id: "dashboard", label: "Overview", sub: "Live status · chart" },
  { id: "strategies", label: "Strategies", sub: "Modules · env" },
  { id: "tools", label: "Tools", sub: "MetaMask · wallet" },
  { id: "settings", label: "Configuration", sub: "Mode · risk" },
  { id: "wizard", label: "Setup Wizard", sub: "Connect → configure" },
  { id: "journal", label: "Logs", sub: "Journal · P&L" }
];

export const POLYSNIPE_STRATEGIES = [
  {
    id: "reversal",
    name: "Reversal Snipe",
    active: true,
    window: "Last 10–40s",
    tag: "Cheap token, market mispriced",
    desc: "Strikes in the final seconds while the token is still cheap and the market hasn't caught up. Multiple signals must align before a single share is bought."
  },
  {
    id: "collapse",
    name: "Collapse Snipe",
    active: false,
    window: "Last 4–9s",
    tag: "Near-settled, one side crushed",
    desc: "Ultra-late entry when one outcome is about to be confirmed. Pure asymmetric payoff — tiny cost, large payout if the direction holds."
  },
  {
    id: "conviction",
    name: "Conviction",
    active: false,
    window: "60–90s remaining",
    tag: "Mid-range token, high confidence",
    desc: "Fires mid-window when multiple internal confidence measures peak simultaneously."
  },
  {
    id: "late_flip",
    name: "Late Flip",
    active: false,
    window: "15–30s remaining",
    tag: "Strong momentum, fast-breaking move",
    desc: "Catches late-breaking directional moves with fewer simultaneous confirmations required."
  },
  {
    id: "mid_flip",
    name: "Mid Flip",
    active: false,
    window: "40–120s remaining",
    tag: "Cheap side, direction accelerating",
    desc: "Enters earlier in the window when the consensus is shifting and the token hasn't priced the move yet."
  },
  {
    id: "scalp",
    name: "Scalp",
    active: false,
    window: "Mid-window",
    tag: "Aligned price + probability window",
    desc: "Short-duration entries targeting a quick take-profit rather than holding to resolution."
  },
  {
    id: "fade",
    name: "Deep Discount Fade",
    active: false,
    window: "40–120s remaining",
    tag: "Extreme discount, contrarian setup",
    desc: "Contrarian. Buys the side the market has nearly written off. High risk — high reward."
  },
  {
    id: "resolution",
    name: "Resolution Snipe",
    active: false,
    window: "Last 8–60s",
    tag: "Near-settled winner token",
    desc: "Follows the near-certain winner in the final stretch. Lower upside per trade, higher win rate."
  }
] as const;

export function SnipeSidebar(props: {
  route: SnipeRoute;
  onRoute: (r: SnipeRoute) => void;
  footer?: ReactNode;
}) {
  return (
    <aside className="snipe-sidebar flex w-[248px] shrink-0 flex-col border-r border-snipe-border bg-snipe-sidebar">
      <div className="border-b border-snipe-border px-5 py-6">
        <img
          src={BRAND_LOGO_SRC}
          alt="Polypredator — Polymarket 5m"
          className="h-8 w-auto max-w-[200px] object-contain object-left"
          width={200}
          height={32}
          decoding="async"
        />
        <p className="mt-2 text-[10px] font-medium italic tracking-wide text-snipe-muted">5m Alpha Hunter</p>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 p-3">
        {NAV.map((item) => {
          const on = props.route === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => props.onRoute(item.id)}
              aria-current={on ? "page" : undefined}
              className={
                "rounded-xl px-3 py-2.5 text-left transition " +
                (on
                  ? "bg-snipe-accent/15 text-snipe-accent shadow-[inset_0_0_0_1px_rgba(45,212,191,0.4)]"
                  : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200")
              }
            >
              <div className="text-sm font-semibold">{item.label}</div>
              <div className="text-[11px] text-slate-500">{item.sub}</div>
            </button>
          );
        })}
      </nav>
      <div className="border-t border-snipe-border p-4 text-[10px] leading-relaxed text-slate-600">
        {props.footer}
      </div>
    </aside>
  );
}

export function SnipeStrategiesGrid() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-bold text-white">Strategy Configuration</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          Eight profiles targeting microstructure windows in the BTC 5-minute market. One active out of the box — tune via{" "}
          <code className="rounded bg-snipe-panel px-1 py-0.5 text-snipe-accent">server/.env</code> (ENTRY_STRATEGY, MOMENTUM_MODE,
          BONE_*).
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {POLYSNIPE_STRATEGIES.map((s) => (
          <div
            key={s.id}
            className={
              "snipe-card flex flex-col rounded-2xl border p-4 " +
              (s.active ? "border-snipe-accent/40 bg-snipe-accent/[0.06]" : "border-snipe-border bg-snipe-panel/80")
            }
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <h3 className="text-sm font-bold text-white">{s.name}</h3>
              {s.active ? (
                <span className="shrink-0 rounded-md bg-snipe-accent/25 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-snipe-accent">
                  Active
                </span>
              ) : (
                <span className="shrink-0 rounded-md bg-slate-700/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Configurable
                </span>
              )}
            </div>
            <p className="mb-2 text-[11px] text-snipe-accent">
              <span className="opacity-90">⏱</span> {s.window}
            </p>
            <p className="mb-2 text-[11px] text-slate-500">
              <span className="text-slate-400">📍</span> {s.tag}
            </p>
            <p className="flex-1 text-xs leading-relaxed text-slate-400">{s.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SnipeWizardSteps(props: { step: number; onStep: (n: number) => void }) {
  const steps = [
    { n: 1, title: "Secure access", body: "Sign in with dashboard credentials and connect Polymarket / MetaMask when trading live." },
    { n: 2, title: "Choose mode", body: "Demo for paper balance, Real for CLOB — confirm keys and collateral on the server." },
    { n: 3, title: "Strategy & risk", body: "Adjust entry size, capital %, and optional BONE filters in server environment." },
    { n: 4, title: "Arm the bot", body: "Open Live Dashboard, press Start Bot, and monitor the journal + live logs." }
  ];
  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-bold text-white">Setup Wizard</h2>
        <p className="mt-1 text-sm text-slate-500">From login to first snipe — same flow as a product tour.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {steps.map((s) => (
          <button
            key={s.n}
            type="button"
            onClick={() => props.onStep(s.n)}
            className={
              "rounded-full px-4 py-2 text-xs font-semibold transition " +
              (props.step === s.n ? "bg-snipe-accent text-snipe-bg" : "bg-snipe-panel text-slate-400 hover:text-white")
            }
          >
            Step {s.n}
          </button>
        ))}
      </div>
      <div className="snipe-card rounded-2xl border border-snipe-border bg-snipe-panel/90 p-6">
        <h3 className="text-lg font-bold text-white">{steps.find((x) => x.n === props.step)?.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">{steps.find((x) => x.n === props.step)?.body}</p>
      </div>
    </div>
  );
}
