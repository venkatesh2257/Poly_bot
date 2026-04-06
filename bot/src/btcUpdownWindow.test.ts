import { describe, expect, it } from "vitest";
import {
  BTC_UPDOWN_MARKET_WINDOW_SEC,
  btcUpdown15mEventSlug,
  currentBtcUpdownWindowStartSec,
} from "./btcUpdownWindow.js";

describe("btcUpdown15m window helpers", () => {
  it("uses 15-minute (900s) windows", () => {
    expect(BTC_UPDOWN_MARKET_WINDOW_SEC).toBe(900);
  });

  it("floors wall time to window start", () => {
    expect(currentBtcUpdownWindowStartSec(0)).toBe(0);
    expect(currentBtcUpdownWindowStartSec(899)).toBe(0);
    expect(currentBtcUpdownWindowStartSec(900)).toBe(900);
    expect(currentBtcUpdownWindowStartSec(901)).toBe(900);
  });

  it("builds gamma slug for window start", () => {
    expect(btcUpdown15mEventSlug(1_740_000_000)).toBe("btc-updown-15m-1740000000");
  });
});
