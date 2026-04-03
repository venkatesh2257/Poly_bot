/**
 * Layout blocks matching the PolySnipe reference screenshots (visual only).
 * Strategy numbers are illustrative; live behavior remains server-driven (.env).
 */

import { BRAND_LOGO_SRC } from "./branding";

export function StrategyConfigScreen(props: {
  botRunning: boolean;
  onBacktest?: (strategyTitle: string) => void;
}) {
  return (
    <div className="space-y-4">
      {props.botRunning ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-950/40 px-4 py-3 text-sm text-amber-100/95">
          <span>The bot is running. Stop it before editing strategy settings.</span>
          <button
            type="button"
            disabled
            title="Strategy parameters are read from server/.env — stop the bot, edit the file, then restart the API."
            className="cursor-not-allowed rounded-lg border border-slate-600 bg-slate-800/80 px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            Save (use .env)
          </button>
        </div>
      ) : null}

      <div>
        <h2 className="font-display text-2xl font-bold text-white">Low Risk Low Reward</h2>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          Higher-confirmation setups that prioritize cleaner fills, tighter behavior, and smaller payout multiples. Tune live
          behavior via <code className="text-snipe-accent">ENTRY_STRATEGY</code>, <code className="text-snipe-accent">MOMENTUM_MODE</code>, and{" "}
          <code className="text-snipe-accent">BONE_*</code> in <code className="text-snipe-accent">server/.env</code>.
        </p>
      </div>

      <StrategyCard
        title="Scalp"
        enabled
        onBacktest={props.onBacktest}
        riskTag="LOW RISK"
        description="Mid-price scalp that requires enough directional edge and a fast token target to justify the quick exit."
        conflictNote="Conflicts with Conviction because both consume the same mid-window directional setups. Position size still comes from the global Trade Size in Settings."
        sections={[
          {
            title: "1. ENTRY GATES (When the detector is allowed to fire)",
            rows: [
              ["MIN WIN PROB", "0.80"],
              ["MIN WINDOW SEC", "10"],
              ["MAX WINDOW SEC", "210"],
              ["MIN TOKEN PRICE", "0.62"],
              ["MAX TOKEN PRICE", "0.75"],
              ["MIN BTC GAP USD", "12"],
              ["MAX BTC GAP USD", "50"]
            ]
          },
          {
            title: "2. EXECUTION (How orders are placed and sized on CLOB)",
            rows: [
              ["BUY ORDER TYPE", "GTC"],
              ["SELL ORDER TYPE", "GTC"],
              ["GTC BUY OFFSET CENTS", "2"],
              ["GTC SELL OFFSET CENTS", "2"]
            ]
          },
          {
            title: "3. EXIT + RISK (How profits are locked and downside is cut)",
            rows: [
              ["TARGET CENTS", "8"],
              ["MAX HOLD SEC", "7"],
              ["SAFE EXIT BUFFER SEC", "20"],
              ["STOP LOSS CENTS", "6"],
              ["STOP LOSS MIN HOLD SEC", "4"],
              ["REQUIRE BTC FLIP FOR STOP", "Disabled"],
              ["BTC FLIP MIN TOKEN PRICE", "0"]
            ]
          }
        ]}
      />

      <StrategyCard
        title="Resolution Snipe"
        enabled={false}
        onBacktest={props.onBacktest}
        riskTag="LOW RISK"
        description="Late winner-following entry that buys the already-winning side near the end when BTC conviction and token pricing both say the market is effectively resolved."
        conflictNote="Conflicts with Reversal Snipe and Late Flip because it uses the same final-window directional inventory, but from a hold-the-winner assumption instead of a flip assumption."
        sections={[
          {
            title: "1. ENTRY GATES",
            rows: [
              ["MIN WINDOW SEC", "10"],
              ["MAX WINDOW SEC", "35"],
              ["MIN TOKEN PRICE", "0.15"],
              ["MAX TOKEN PRICE", "0.35"],
              ["MIN BTC GAP USD", "6"],
              ["MIN WIN PROB", "0.75"]
            ]
          },
          {
            title: "2. EXECUTION",
            rows: [
              ["TRADE SIZE USD", "3"],
              ["BUY ORDER TYPE", "GTC"],
              ["SELL ORDER TYPE", "GTC"],
              ["GTC BUY OFFSET CENTS", "2"],
              ["GTC SELL OFFSET CENTS", "2"],
              ["BUY LIMIT PRICE", "0.35"]
            ]
          }
        ]}
      />
    </div>
  );
}

function StrategyCard(props: {
  title: string;
  enabled: boolean;
  onBacktest?: (strategyTitle: string) => void;
  riskTag: string;
  description: string;
  conflictNote: string;
  sections: { title: string; rows: [string, string][] }[];
}) {
  return (
    <div
      className={
        "rounded-2xl border p-5 " +
        (props.enabled ? "border-snipe-accent/35 bg-snipe-accent/[0.04]" : "border-snipe-border bg-snipe-panel/60")
      }
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-xl font-bold text-white">{props.title}</h3>
          <p className="mt-1 text-sm text-slate-400">{props.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span
            className={
              "rounded-md px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide " +
              (props.enabled ? "bg-snipe-accent text-[#061016]" : "bg-slate-700 text-slate-300")
            }
          >
            {props.enabled ? "ENABLED" : "DISABLED"}
          </span>
          <span className="rounded-md bg-sky-500/20 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-sky-300">
            {props.riskTag}
          </span>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {props.sections.map((sec) => (
          <div key={sec.title} className="rounded-xl border border-snipe-border/80 bg-[#0a0c10]/90 p-3">
            <h4 className="mb-2 text-[10px] font-bold uppercase leading-snug tracking-wide text-snipe-accent">{sec.title}</h4>
            <dl className="space-y-1.5 text-xs">
              {sec.rows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 border-b border-white/[0.04] pb-1.5 last:border-0">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="font-mono text-slate-200">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{props.conflictNote}</p>
      <button
        type="button"
        onClick={() => props.onBacktest?.(props.title)}
        disabled={!props.onBacktest}
        title={
          props.onBacktest
            ? "Open Logs with guidance: forward-test in PAPER mode (no historical CSV replay in this build)"
            : "Backtest handler not wired"
        }
        className="mt-3 rounded-lg border border-snipe-border bg-snipe-bg px-4 py-2 text-xs font-semibold text-slate-300 hover:border-snipe-accent/40 hover:text-snipe-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        Backtest
      </button>
    </div>
  );
}

export function SettingsScreenPoly() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold text-white">Settings</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Operational controls stay here: bankroll limits, webhook alerts, and claim execution. Strategy-specific tuning remains
            on the Strategies page so this screen stays focused and faster to use on mobile.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-lg bg-snipe-accent/20 px-3 py-2 text-xs font-bold uppercase tracking-wide text-snipe-accent">
            Operational only
          </span>
          <span className="rounded-lg border border-sky-500/50 px-3 py-2 text-xs font-bold uppercase tracking-wide text-sky-400">
            Mobile-safe layout
          </span>
        </div>
      </div>

      <section className="rounded-2xl border border-snipe-border bg-snipe-panel/50 p-5">
        <h3 className="mb-4 font-display text-lg font-bold text-white">Change Password</h3>
        <div className="max-w-md space-y-3">
          <Field label="Current Password" placeholder="••••••••" />
          <Field label="New Password" placeholder="••••••••" />
          <Field label="Confirm New Password" placeholder="••••••••" />
          <button
            type="button"
            disabled
            title="Change APP_PASSWORD in server/.env and restart"
            className="mt-2 w-full cursor-not-allowed rounded-xl bg-snipe-accent py-3 text-sm font-bold text-[#061016] opacity-50"
          >
            Update Password
          </button>
          <p className="text-[11px] text-slate-500">Dashboard auth is configured on the server (.env). No remote password API yet.</p>
        </div>
      </section>

      <div className="rounded-xl border border-amber-500/35 bg-amber-950/25 px-4 py-3 text-sm text-amber-100/90">
        Stop the bot before editing operational settings.
      </div>

      <section className="rounded-2xl border border-snipe-border bg-snipe-panel/50 p-5">
        <h3 className="mb-1 font-display text-lg font-bold text-white">Risk Controls</h3>
        <p className="mb-4 text-xs text-slate-500">
          Strategy-specific entry and exit controls live on the Strategies page. These mirror common presets — set real limits in{" "}
          <code className="text-snipe-accent">server/.env</code> (<code className="text-snipe-accent">ENTRY_USD</code>,{" "}
          <code className="text-snipe-accent">STOP_LOSS</code>, <code className="text-snipe-accent">MAX_TRADE</code>, …).
        </p>
        <div className="grid max-w-xl gap-3 sm:grid-cols-2">
          <RiskField label="Trade Size (USD)" value="2.5" />
          <RiskField label="Max Session Loss USD" value="20" />
          <RiskField label="Max Session Profit USD" value="2000" />
          <RiskField label="Max Trades / Session" value="0" hint="0 = unlimited in this demo UI" />
          <RiskField label="Max Consecutive Losses" value="0" />
        </div>
      </section>

      <section className="rounded-2xl border border-snipe-border bg-snipe-panel/50 p-5">
        <h3 className="mb-4 font-display text-lg font-bold text-white">Discord Notifications</h3>
        <label className="flex cursor-pointer items-center gap-3 text-sm text-slate-300">
          <input type="checkbox" defaultChecked className="h-4 w-4 rounded border-snipe-border text-snipe-accent" readOnly />
          <span className="font-semibold uppercase tracking-wide text-xs">Send completed trade embeds to Discord</span>
        </label>
        <input
          readOnly
          placeholder="https://discord.com/api/webhooks/…"
          className="mt-3 w-full max-w-xl rounded-xl border border-snipe-border bg-[#0a0c10] px-3 py-2.5 font-mono text-xs text-slate-400"
        />
        <p className="mt-2 text-[11px] text-slate-500">Wire webhooks in a future release; values apply the next time Start is pressed.</p>
      </section>
    </div>
  );
}

function Field(props: { label: string; placeholder: string }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500">{props.label}</label>
      <input
        readOnly
        placeholder={props.placeholder}
        className="w-full rounded-xl border border-snipe-border bg-[#0a0c10] px-3 py-2.5 text-sm text-slate-300"
      />
    </div>
  );
}

function RiskField(props: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-slate-500">{props.label}</label>
      <input
        readOnly
        value={props.value}
        className="w-full rounded-xl border border-snipe-border bg-[#0a0c10] px-3 py-2.5 font-mono text-sm text-snipe-accent"
      />
      {props.hint ? <p className="mt-0.5 text-[10px] text-slate-600">{props.hint}</p> : null}
    </div>
  );
}

export function WizardScreenPoly(props: { onExit?: () => void }) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <img
          src={BRAND_LOGO_SRC}
          alt="Polypredator — Polymarket 5m"
          className="mb-4 h-10 w-auto max-w-full object-contain object-left sm:h-12"
          width={280}
          height={48}
          decoding="async"
        />
        <h2 className="font-display text-2xl font-bold text-white">Setup Wizard</h2>
        <p className="mt-2 text-sm text-slate-400">
          <span className="font-semibold text-snipe-accent">What you need:</span> Ethereum signer, signature type, and Polymarket API
          credentials — configured on the <strong className="text-slate-200">server</strong> for this dashboard build.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          <span className="font-semibold text-slate-300">What happens next:</span> saving here is a preview only; use{" "}
          <code className="text-snipe-accent">server/.env</code> and restart the API, then open Live Dashboard.
        </p>
      </div>

      <div className="rounded-2xl border border-snipe-border bg-snipe-panel/60 p-6">
        <p className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-snipe-muted">
          Step 1 of 4 · Wallet &amp; signature type
        </p>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase text-slate-500">Private key (hex)</label>
            <input
              disabled
              placeholder="•••••••••••••••• (set EVM_PRIVATE_KEY in server/.env — never commit)"
              className="w-full rounded-xl border border-snipe-border bg-[#0a0c10] px-3 py-2.5 font-mono text-xs text-slate-500"
            />
          </div>
          <div className="rounded-xl border border-snipe-border/80 bg-[#0a0c10]/80 p-3 text-xs text-slate-400">
            Derived EOA address: <span className="font-mono text-snipe-accent">from server wallet</span>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase text-slate-500">Signature / account type</label>
            <select disabled className="w-full rounded-xl border border-snipe-border bg-[#0a0c10] px-3 py-2.5 text-sm text-slate-300">
              <option>2 — POLY_GNOSIS_SAFE / MetaMask (recommended)</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase text-slate-500">Proxy / funder address</label>
            <div className="flex gap-2">
              <input
                disabled
                placeholder="CLOB_FUNDER_ADDRESS in server/.env"
                className="min-w-0 flex-1 rounded-xl border border-snipe-border bg-[#0a0c10] px-3 py-2.5 font-mono text-xs text-slate-500"
              />
              <button
                type="button"
                disabled
                className="shrink-0 rounded-xl border border-snipe-border px-4 py-2 text-xs font-semibold text-slate-500"
              >
                Get
              </button>
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-between border-t border-snipe-border pt-4">
          <button
            type="button"
            title={props.onExit ? "Return to Overview" : "Use the Wizard link in the top bar to leave this page"}
            onClick={() => props.onExit?.()}
            className="rounded-xl px-4 py-2 text-sm text-slate-500 transition hover:bg-slate-800 hover:text-slate-300"
          >
            Exit
          </button>
          <button
            type="button"
            disabled
            title="Wizard steps are informational — configure the server, then use Overview."
            className="cursor-not-allowed rounded-xl bg-snipe-accent/40 px-6 py-2.5 text-sm font-bold text-[#061016]/50"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
