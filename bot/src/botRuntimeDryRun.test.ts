import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("bot runtime dry-run safety", () => {
  it("does not persistently overwrite config.dryRun when key is missing", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const botPath = path.join(dir, "./bot.ts");
    const src = readFileSync(botPath, "utf8");

    expect(src).toContain("function effectiveDryRunMode()");
    expect(src).toContain("return state.config.dryRun || !hasPrivateKey();");
    expect(src).not.toContain("state.config.dryRun = true;");
    expect(src).toContain("forcing dry-run mode for this session");
  });
});
