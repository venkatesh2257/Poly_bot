import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("wallet auto reclaim wiring", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const walletPath = path.join(dir, "../src/services/wallet.ts");
  const src = readFileSync(walletPath, "utf8");

  it("includes a best-effort redeemWinningPosition helper", () => {
    expect(src).toContain("async redeemWinningPosition(");
    expect(src).toContain('process.env.AUTO_RECLAIM_WINNINGS ?? "true"');
    expect(src).toContain("funder_differs_from_signer");
    expect(src).toContain("redeemPositions(");
  });
});
