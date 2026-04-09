import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  BTC_5M_ORACLE_CLOSE_MIN_MS_DEFAULT,
  btc5mChainlinkWindowStateLabel,
  btc5mOracleCloseMinEffectiveMs,
  btc5mPostWindowEndBufferMs,
  paperOracleTooCloseBtc5m
} from "../src/services/oracleWindowGuards.js";

describe("paperOracleTooCloseBtc5m", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    process.env = { ...prev };
    delete process.env.MIN_MS_TO_WINDOW_END_BTC;
    delete process.env.BTC_5M_POST_WINDOW_END_BUFFER_MS;
  });

  afterEach(() => {
    process.env = { ...prev };
  });

  it("does not block when ms_to_window_end is -200 and minEffective is 500 (post-window)", () => {
    expect(paperOracleTooCloseBtc5m(-200, 500, 0)).toBe(false);
  });

  it("blocks in last 500ms before end when minEffective is 500", () => {
    expect(paperOracleTooCloseBtc5m(200, 500, 0)).toBe(true);
  });

  it("does not block when 600ms remain and minEffective is 500", () => {
    expect(paperOracleTooCloseBtc5m(600, 500, 0)).toBe(false);
  });

  it("with postEndBuffer 500, blocks only just after end (within 500ms)", () => {
    expect(paperOracleTooCloseBtc5m(-200, 500, 500)).toBe(true);
    expect(paperOracleTooCloseBtc5m(-600, 500, 500)).toBe(false);
  });

  it("default min constant matches BTC_DEFAULT policy", () => {
    expect(BTC_5M_ORACLE_CLOSE_MIN_MS_DEFAULT).toBe(500);
    expect(btc5mOracleCloseMinEffectiveMs()).toBe(500);
  });

  it("btc5mChainlinkWindowStateLabel: -200 with min 500 and post 0 is JUST_CLOSED", () => {
    expect(btc5mChainlinkWindowStateLabel(-200, 500, 0)).toBe("JUST_CLOSED");
  });

  it("btc5mChainlinkWindowStateLabel: 200 with min 500 is TOO_CLOSE", () => {
    expect(btc5mChainlinkWindowStateLabel(200, 500, 0)).toBe("TOO_CLOSE");
  });

  it("btc5mPostWindowEndBufferMs reads env", () => {
    process.env.BTC_5M_POST_WINDOW_END_BUFFER_MS = "250";
    expect(btc5mPostWindowEndBufferMs()).toBe(250);
  });
});
