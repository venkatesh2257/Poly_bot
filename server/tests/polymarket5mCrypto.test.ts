import { describe, expect, it } from "vitest";
import { isPolymarketCryptoUpDown5mWindow, polymarket5mWindowKey } from "../src/strategy/polymarket5mCrypto.js";

describe("polymarket5mCrypto", () => {
  it("detects ~300s BTC Up/Down window from Gamma timing", () => {
    const ws = Math.floor(Date.now() / 1000) - 120;
    const end = new Date((ws + 300) * 1000).toISOString();
    expect(isPolymarketCryptoUpDown5mWindow("BTC", { endDateIso: end, windowStartSec: ws })).toBe(true);
  });

  it("accepts ETH/SOL/XRP", () => {
    const ws = 1_700_000_000;
    const end = new Date((ws + 300) * 1000).toISOString();
    expect(isPolymarketCryptoUpDown5mWindow("ETH", { endDateIso: end, windowStartSec: ws })).toBe(true);
    expect(isPolymarketCryptoUpDown5mWindow("SOL", { endDateIso: end, windowStartSec: ws })).toBe(true);
    expect(isPolymarketCryptoUpDown5mWindow("XRP", { endDateIso: end, windowStartSec: ws })).toBe(true);
  });

  it("rejects non-crypto asset", () => {
    const ws = 1000;
    const end = new Date((ws + 300) * 1000).toISOString();
    expect(isPolymarketCryptoUpDown5mWindow("ABC", { endDateIso: end, windowStartSec: ws })).toBe(false);
  });

  it("rejects window duration outside 285–315s", () => {
    const ws = 1000;
    const end = new Date((ws + 600) * 1000).toISOString();
    expect(isPolymarketCryptoUpDown5mWindow("BTC", { endDateIso: end, windowStartSec: ws })).toBe(false);
  });

  it("polymarket5mWindowKey formats slug|windowStart", () => {
    expect(polymarket5mWindowKey({ slug: "btc-updown-5m-1", windowStartSec: 123 })).toBe("btc-updown-5m-1|123");
    expect(polymarket5mWindowKey(null)).toBe("unknown|?");
  });
});
