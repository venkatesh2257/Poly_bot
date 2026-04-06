import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateAnchorStrategy, loadAnchorConfigFromEnv, type OrderBookSnapshot } from "../src/strategies/anchorStrategy.js";
import { loadProfessionalTraderConfigFromEnv } from "../src/strategies/professionalTrader/config.js";
import { shouldSkipMarket } from "../src/strategies/professionalTrader/marketFilter.js";
import { ProfessionalTradingStateMachine } from "../src/strategies/professionalTrader/stateMachine.js";
import type { OhlcCandle, ProfessionalTickInput } from "../src/strategies/professionalTrader/professionalTypes.js";

type ReplayInput = {
  anchor?: {
    orderBook: OrderBookSnapshot;
    chainlinkPriceHistory: number[];
    anchorYesPrice: number;
    anchorNoPrice: number;
    imbalanceHistoryUp: number[];
    imbalanceHistoryDown: number[];
    oracleLatestAgeMs?: number | null;
  };
  professional?: {
    candles: OhlcCandle[];
    imbalanceHistoryUp: number[];
    ticks: ProfessionalTickInput[];
  };
};

function readInput(): ReplayInput {
  const arg = process.argv[2];
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const fallback = path.join(dir, "replay.sample.json");
  const srcPath = arg ? path.resolve(process.cwd(), arg) : fallback;
  const raw = readFileSync(srcPath, "utf8");
  return JSON.parse(raw) as ReplayInput;
}

function runAnchor(inp: ReplayInput["anchor"]): void {
  if (!inp) return;
  const cfg = loadAnchorConfigFromEnv(1);
  const sig = evaluateAnchorStrategy(
    inp.orderBook,
    inp.chainlinkPriceHistory,
    inp.anchorYesPrice,
    inp.anchorNoPrice,
    inp.imbalanceHistoryUp,
    inp.imbalanceHistoryDown,
    cfg,
    inp.oracleLatestAgeMs
  );
  console.log(
    JSON.stringify(
      {
        path: "anchor",
        decision: sig.shouldTrade ? "enter" : "skip",
        side: sig.side,
        skipCategory: sig.skipCategory ?? null,
        reason: sig.reason,
        keyInputs: {
          yes: inp.anchorYesPrice,
          no: inp.anchorNoPrice,
          historyN: inp.chainlinkPriceHistory.length
        }
      },
      null,
      2
    )
  );
}

function runProfessional(inp: ReplayInput["professional"]): void {
  if (!inp) return;
  const cfg = loadProfessionalTraderConfigFromEnv();
  const fsm = new ProfessionalTradingStateMachine(cfg);
  const filter = shouldSkipMarket({
    candles: inp.candles,
    imbalanceFlipsLast10: 0,
    anchorUsd: inp.ticks[0]?.anchorUsd ?? 0
  });
  console.log(
    JSON.stringify(
      {
        path: "professional",
        preFilter: filter,
        candles: inp.candles.length,
        ticks: inp.ticks.length
      },
      null,
      2
    )
  );
  inp.ticks.forEach((t, i) => {
    const out = fsm.step(t, inp.candles, inp.imbalanceHistoryUp);
    console.log(
      JSON.stringify(
        {
          path: "professional",
          tick: i,
          decision: out.decision.kind,
          detail: out.decision,
          logs: out.logs.slice(-2)
        },
        null,
        2
      )
    );
  });
}

const input = readInput();
runAnchor(input.anchor);
runProfessional(input.professional);
