let binance_ob = { bids: [], asks: [] };
let binance_ob_ws = null;
let active_window_slug = null;
let window_entry_taken = false;
let spot_history_debug = [];
const TRADE_CONFIG = {
  target_pct: 0.15,
  stop_pct: 0.06,
  max_hold_sec: 240
};
let bot_context = {
  clob_client: null,
  coinbase_btc: null,
  binance_btc: null,
  get_active_btc_5m_market: null,
  emit_strategy_status: null,
  can_enter_window: null,
  check_kill_switch: null,
  lag_size: null,
  place_order: null,
  hard_settle_trade: null,
  wallet_balance: 0,
  log: (...args) => console.log(...args),
  detect_lag: null,
  update_btc_history: null
};

function log(msg) {
  try {
    bot_context.log?.(msg);
  } catch {
    console.log(msg);
  }
}

function normalizeSide(side) {
  const s = String(side ?? "").toUpperCase();
  if (s === "UP") return "YES";
  if (s === "DOWN") return "NO";
  return s;
}

function inverseSide(side) {
  return normalizeSide(side) === "YES" ? "NO" : "YES";
}

function get_window_slug(_market) {
  const d = new Date();
  const h = d.getHours();
  const m = Math.floor(d.getMinutes() / 5) * 5;
  return `btc-5m-${d.toDateString()}-${h}h${String(m).padStart(2, "0")}`;
}

function check_new_window(slug) {
  if (slug !== active_window_slug) {
    active_window_slug = slug;
    window_entry_taken = false;
    log(`[SPL] NEW WINDOW -> ${slug} | entry reset`);
  }
}

function can_enter_window() {
  if (window_entry_taken) {
    log("[SPL] SKIP -> entry already taken this window");
    return false;
  }
  return true;
}

function mark_entered() {
  window_entry_taken = true;
  log("[SPL] WINDOW LOCKED -> no more entries until next 5m candle");
}

function get_entry_window(tier) {
  const windows = {
    EXTREME: { min: 15, max: 270 },
    MEGA: { min: 15, max: 210 },
    STRONG: { min: 15, max: 150 },
    NORMAL: { min: 15, max: 90 }
  };
  return windows[String(tier ?? "").toUpperCase()] ?? windows.NORMAL;
}

function time_gate_passes(time_left, tier) {
  const w = get_entry_window(tier);
  const pass = time_left >= w.min && time_left <= w.max;
  log(`[SPL] TIME GATE: tier=${tier ?? "NORMAL"} | time_left=${time_left}s | window=${w.min}-${w.max}s | ${pass ? "PASS ✅" : "FAIL ❌"}`);
  return pass;
}

function confirmation_score(lag, imbalance, clob) {
  let score = 0;
  const reasons = [];
  const move = Math.abs(Number(lag?.move_pct ?? 0));
  if (move >= 0.2) {
    score += 2;
    reasons.push(`move=+${move.toFixed(3)}% STRONG`);
  } else if (move >= 0.08) {
    score += 1;
    reasons.push(`move=+${move.toFixed(3)}% OK`);
  } else {
    reasons.push(`move=+${move.toFixed(3)}% WEAK`);
  }

  if (imbalance?.valid) {
    const side = normalizeSide(lag?.direction);
    if (side === "YES" && Number(imbalance.ratio) >= 0.58) {
      score += 1;
      reasons.push(`OB=BULLISH ${Number(imbalance.ratio).toFixed(2)}`);
    } else if (side === "NO" && Number(imbalance.ratio) <= 0.42) {
      score += 1;
      reasons.push(`OB=BEARISH ${Number(imbalance.ratio).toFixed(2)}`);
    } else {
      reasons.push(`OB=NEUTRAL ${Number(imbalance.ratio).toFixed(2)}`);
    }
  } else {
    score += 1;
    reasons.push("OB=unavailable (allowed)");
  }

  if (clob?.valid && Number(clob.spread_pct) <= 5) {
    score += 1;
    reasons.push(`spread=${Number(clob.spread_pct).toFixed(1)}% TIGHT`);
  } else if (clob?.valid) {
    reasons.push(`spread=${Number(clob.spread_pct).toFixed(1)}% WIDE`);
  }

  log(`[SPL] CONFIRM SCORE: ${score}/4 | ${reasons.join(" | ")}`);
  return score;
}

function entry_confirmed(score, time_left) {
  if (time_left > 120) {
    if (score >= 3) {
      log(`[SPL] EARLY ENTRY CONFIRMED ✅ score=${score} at ${time_left}s left`);
      return true;
    }
    log(`[SPL] EARLY ENTRY REJECTED: score=${score} < 3 needed at ${time_left}s left`);
    return false;
  }
  if (score >= 2) {
    log(`[SPL] LATE ENTRY CONFIRMED ✅ score=${score} at ${time_left}s left`);
    return true;
  }
  log(`[SPL] LATE ENTRY REJECTED: score=${score} < 2 needed at ${time_left}s left`);
  return false;
}

function get_exit_config(time_left, entry_price) {
  if (time_left > 180) {
    return {
      quick_profit: entry_price + 0.08,
      good_profit: entry_price + 0.15,
      hard_stop: entry_price - 0.06,
      max_hold_sec: 120,
      poll_ms: 500,
      mode: "EARLY"
    };
  }
  if (time_left > 90) {
    return {
      quick_profit: entry_price + 0.05,
      good_profit: entry_price + 0.1,
      hard_stop: entry_price - 0.05,
      max_hold_sec: 75,
      poll_ms: 500,
      mode: "MID"
    };
  }
  return {
    quick_profit: entry_price + 0.03,
    good_profit: entry_price + 0.06,
    hard_stop: entry_price - 0.04,
    max_hold_sec: 45,
    poll_ms: 500,
    mode: "LATE"
  };
}

function configureSpotPolyLagContext(next) {
  bot_context = { ...bot_context, ...(next ?? {}) };
}

async function connect_binance_ob() {
  if (binance_ob_ws && (binance_ob_ws.readyState === 0 || binance_ob_ws.readyState === 1)) return;
  const WebSocketCtor = globalThis.WebSocket ?? (await import("ws")).WebSocket;
  binance_ob_ws = new WebSocketCtor("wss://stream.binance.com:9443/ws/btcusdt@depth10@100ms");

  binance_ob_ws.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      binance_ob.bids = Array.isArray(data?.bids) ? data.bids : [];
      binance_ob.asks = Array.isArray(data?.asks) ? data.asks : [];
    } catch (e) {
      log(`[SPL] BINANCE OB parse error: ${e?.message ?? String(e)}`);
    }
  };

  binance_ob_ws.onerror = (e) => log(`[SPL] BINANCE OB WS ERROR: ${e?.message ?? String(e)}`);
  binance_ob_ws.onclose = () => {
    log("[SPL] BINANCE OB WS closed -> reconnecting in 2s");
    setTimeout(() => {
      connect_binance_ob().catch((err) => log(`[SPL] BINANCE OB reconnect failed: ${err?.message ?? String(err)}`));
    }, 2000);
  };

  log("[SPL] Binance OB WebSocket connected");
}

function get_binance_imbalance() {
  log(`[SPL-OB] bids_len=${binance_ob.bids.length} | asks_len=${binance_ob.asks.length}`);
  log(`[SPL-OB] top_bid=${JSON.stringify(binance_ob.bids[0] ?? null)} | top_ask=${JSON.stringify(binance_ob.asks[0] ?? null)}`);
  if (!binance_ob.bids.length || !binance_ob.asks.length) return { ratio: 0.5, signal: "NEUTRAL", valid: false };

  const bid_vol = binance_ob.bids.slice(0, 5).reduce((s, [, q]) => s + Number.parseFloat(q), 0);
  const ask_vol = binance_ob.asks.slice(0, 5).reduce((s, [, q]) => s + Number.parseFloat(q), 0);
  const total = bid_vol + ask_vol;
  const ratio = total > 0 ? bid_vol / total : 0.5;
  log(`[SPL-OB] bid_vol=${bid_vol.toFixed(2)} | ask_vol=${ask_vol.toFixed(2)} | ratio=${ratio.toFixed(3)}`);

  let signal = "NEUTRAL";
  if (ratio >= 0.62) signal = "BULLISH";
  if (ratio <= 0.38) signal = "BEARISH";
  return { ratio, signal, bid_vol, ask_vol, valid: true };
}

function binance_ob_confirms(direction, imbalance) {
  if (!imbalance?.valid) return true;
  const side = normalizeSide(direction);
  if (side === "YES" && imbalance.ratio < 0.6) {
    log(`[SPL] OB REJECT: YES needs ratio>=0.60, got ${imbalance.ratio.toFixed(2)}`);
    return false;
  }
  if (side === "NO" && imbalance.ratio > 0.4) {
    log(`[SPL] OB REJECT: NO needs ratio<=0.40, got ${imbalance.ratio.toFixed(2)}`);
    return false;
  }
  log(`[SPL] OB CONFIRM OK: ${side} | ratio=${imbalance.ratio.toFixed(2)}`);
  return true;
}

async function get_poly_clob(market_slug, side) {
  const client = bot_context.clob_client;
  if (!client) return { valid: false };
  try {
    const book = await client.getOrderBook(market_slug, side);
    if (!book || !Array.isArray(book.asks) || book.asks.length === 0) return { valid: false };
    log(`[SPL-CLOB] raw asks[0]=${JSON.stringify(book.asks?.[0] ?? null)}`);
    log(`[SPL-CLOB] raw bids[0]=${JSON.stringify(book.bids?.[0] ?? null)}`);
    const best_ask = Number.parseFloat(book.asks[0]?.price);
    const best_bid = Number.parseFloat(book.bids?.[0]?.price ?? 0);
    const spread = best_ask - best_bid;
    const spread_pct = best_ask > 0 ? (spread / best_ask) * 100 : 999;
    const depth = book.asks.slice(0, 5).reduce((s, l) => s + Number.parseFloat(l?.size ?? 0), 0);
    log(
      `[SPL-CLOB] best_ask=${best_ask} | best_bid=${best_bid} | spread=${spread_pct.toFixed(2)}% | depth=${depth.toFixed(0)}`
    );
    return { valid: true, best_ask, best_bid, spread, spread_pct, depth, raw_book: book };
  } catch (e) {
    log(`[SPL] CLOB fetch error: ${e?.message ?? String(e)}`);
    return { valid: false };
  }
}

function poly_clob_valid(clob, direction, size) {
  if (!clob?.valid) return false;
  if (clob.spread_pct > 5) {
    log(`[SPL] CLOB REJECT: spread=${clob.spread_pct.toFixed(1)}% > 5% max`);
    return false;
  }
  if (clob.depth < size * 2) {
    log(`[SPL] CLOB REJECT: depth=${clob.depth.toFixed(1)} < ${(size * 2).toFixed(1)} required`);
    return false;
  }
  const side = normalizeSide(direction);
  if ((side === "YES" || side === "NO") && clob.best_ask > 0.82) {
    log(`[SPL] CLOB REJECT: ask=${clob.best_ask} lag already closed`);
    return false;
  }
  if (clob.best_bid < 0.02) {
    log(`[SPL] CLOB REJECT: best_bid=${clob.best_bid} ghost market`);
    return false;
  }
  log(`[SPL] CLOB OK: ask=${clob.best_ask} spread=${clob.spread_pct.toFixed(1)}% depth=${clob.depth.toFixed(0)}`);
  return true;
}

async function exit_position(trade, exit_price, reason) {
  try {
    await bot_context.place_order?.({
      market_slug: trade.market_slug,
      side: inverseSide(trade.side),
      size: trade.size,
      price: exit_price,
      order_type: "MARKET",
      strategy: "spot_poly_lag_EXIT",
      reason
    });
    log(`[SPL] EXIT: ${reason} | price=${exit_price} | size=${trade.size}`);
  } catch (e) {
    log(`[SPL] EXIT ERROR: ${e?.message ?? String(e)}`);
  }
}

function start_position_monitor(trade, time_left_at_entry) {
  const entry_price = Number(trade?.price ?? trade?.clob_ask ?? trade?.prob ?? 0);
  if (!Number.isFinite(entry_price) || entry_price <= 0) return;
  const cfg = get_exit_config(Number(time_left_at_entry ?? 0), entry_price);
  const entry_time = Date.now();
  const max_ms = cfg.max_hold_sec * 1000;
  const entrySide = normalizeSide(trade.side);

  log(
    `[SPL MONITOR] mode=${cfg.mode} | entry=${entry_price.toFixed(3)} | target1=${cfg.quick_profit.toFixed(3)} | target2=${cfg.good_profit.toFixed(3)} | stop=${cfg.hard_stop.toFixed(3)} | maxhold=${cfg.max_hold_sec}s`
  );

  const monitor = setInterval(async () => {
    try {
      const clob = await get_poly_clob(trade.market_slug, entrySide);
      if (!clob.valid) return;
      const mid = (clob.best_ask + clob.best_bid) / 2;
      const held_ms = Date.now() - entry_time;
      const pnl_raw = entrySide === "YES" ? (mid - entry_price) / entry_price : (entry_price - mid) / entry_price;
      const pnl_pct = (pnl_raw * 100).toFixed(2);
      const pnl = (mid - entry_price).toFixed(3);

      log(`[SPL MONITOR ${cfg.mode}] mid=${mid.toFixed(3)} pnl=${pnl} (${pnl_pct}%) ${Math.floor(held_ms / 1000)}s`);

      if ((entrySide === "YES" && mid >= cfg.good_profit) || (entrySide === "NO" && mid <= cfg.good_profit)) {
        clearInterval(monitor);
        await exit_position(trade, mid, `GOOD_PROFIT_${cfg.mode}`);
        log(`🟢🟢 [SPL] GOOD PROFIT: +${pnl} (+${pnl_pct}%) | ${Math.floor(held_ms / 1000)}s | mode=${cfg.mode}`);
        return;
      }
      if ((entrySide === "YES" && mid >= cfg.quick_profit) || (entrySide === "NO" && mid <= cfg.quick_profit)) {
        clearInterval(monitor);
        await exit_position(trade, mid, `QUICK_PROFIT_${cfg.mode}`);
        log(`🟢 [SPL] QUICK PROFIT: +${pnl} (+${pnl_pct}%) | ${Math.floor(held_ms / 1000)}s | mode=${cfg.mode}`);
        return;
      }
      if ((entrySide === "YES" && mid <= cfg.hard_stop) || (entrySide === "NO" && mid >= cfg.hard_stop)) {
        clearInterval(monitor);
        await exit_position(trade, mid, `HARD_STOP_${cfg.mode}`);
        log(`🔴 [SPL] HARD STOP: ${pnl} (${pnl_pct}%) | ${Math.floor(held_ms / 1000)}s | mode=${cfg.mode}`);
        return;
      }
      if (held_ms >= max_ms) {
        clearInterval(monitor);
        await exit_position(trade, mid, `TIME_STOP_${cfg.mode}`);
        log(`⏰ [SPL] TIME STOP: ${Math.floor(held_ms / 1000)}s | pnl=${pnl} | mode=${cfg.mode}`);
      }
    } catch (e) {
      log(`[SPL MONITOR ERROR] ${e?.message ?? String(e)}`);
    }
  }, cfg.poll_ms);
}

async function spot_poly_lag_engine() {
  try {
    let spot;
    try {
      spot = await bot_context.coinbase_btc?.();
    } catch {
      spot = await bot_context.binance_btc?.();
    }
    if (!Number.isFinite(spot)) return;

    spot_history_debug = [...spot_history_debug.slice(-59), { ts: Date.now(), price: Number(spot) }];
    bot_context.update_btc_history?.(spot);
    const market = bot_context.get_active_btc_5m_market?.();
    if (!market) return;

    const up_prob = market.up_prob;
    const time_left = market.time_remaining();
    const slug = get_window_slug(market);
    check_new_window(slug);
    log(`[SPL-GATE1] Window: ${slug} | locked=${window_entry_taken}`);
    const allowWindow = can_enter_window();
    log(`[SPL-GATE1] ${allowWindow ? "PASS ✅" : "FAIL ❌ already entered"}`);
    if (!allowWindow) return;
    log(`[SPL-DETECT] spot_now=${spot} | history_len=${spot_history_debug.length}`);
    if (spot_history_debug.length >= 5) {
      const spot_5s = Number(spot_history_debug[spot_history_debug.length - 5]?.price ?? 0);
      if (spot_5s > 0) {
        log(`[SPL-DETECT] spot_5s=${spot_5s} | move_pct=${(((Number(spot) - spot_5s) / spot_5s) * 100).toFixed(4)}%`);
      }
    }
    log(`[SPL-DETECT] up_prob=${up_prob} | dn_prob=${(1 - up_prob).toFixed(3)}`);
    const lag = bot_context.detect_lag?.(spot, up_prob);
    log(
      `[SPL-LAG] exists=${Boolean(lag?.exists)} | move=${lag?.move_pct?.toFixed?.(3) ?? "n/a"}% | tier=${lag?.tier ?? "undefined"} | direction=${lag?.direction ?? "undefined"} | edge=${lag?.edge_pct?.toFixed?.(1) ?? "n/a"}%`
    );
    const imbalance = get_binance_imbalance();
    const mode = time_left > 180 ? "EARLY" : time_left > 90 ? "MID" : "LATE";

    bot_context.emit_strategy_status?.("spot_poly_lag", {
      spot,
      move_5s: lag?.move_pct?.toFixed(3) || "0.000",
      lag: lag?.exists ? `${lag.tier} ⚡` : "none",
      edge: lag?.edge_pct?.toFixed(1) || "0",
      direction: lag?.direction || "—",
      up_prob: (up_prob * 100).toFixed(1),
      time_left,
      ob_signal: imbalance.signal,
      ob_ratio: imbalance.ratio?.toFixed(2) || "—",
      clob_ask: "fetching...",
      window: slug,
      locked: window_entry_taken ? "LOCKED" : "OPEN",
      mode
    });

    if (!lag?.exists) return;
    const tier = lag.tier || "NORMAL";
    const timeGatePass = time_gate_passes(time_left, tier);
    log(`[SPL-GATE2] time_left=${time_left}s | tier=${tier} | ${timeGatePass ? "PASS ✅" : "FAIL ❌"}`);
    if (!timeGatePass) return;
    const killActive = Boolean(bot_context.check_kill_switch?.());
    log(`[SPL-GATE3] kill_switch=${killActive ? "ACTIVE ❌" : "clear ✅"}`);
    if (killActive) return;
    const edgePass = Number(lag.edge_pct) > 10;
    log(`[SPL-GATE4] edge=${lag.edge_pct?.toFixed?.(1) ?? "n/a"}% | need >10% | ${edgePass ? "PASS ✅" : "FAIL ❌"}`);
    if (!edgePass) return;
    const size = bot_context.lag_size?.(lag.tier || "NORMAL", bot_context.wallet_balance) ?? 1;
    const clob = await get_poly_clob(market.slug, lag.direction);
    const obPass = binance_ob_confirms(lag.direction, imbalance);
    log(
      `[SPL-GATE5] OB: ratio=${imbalance.ratio?.toFixed?.(2) ?? "n/a"} | signal=${imbalance.signal ?? "n/a"} | valid=${Boolean(imbalance.valid)} | ${obPass ? "PASS ✅" : "FAIL ❌"}`
    );
    if (!obPass) return;
    log(
      `[SPL-GATE6] CLOB: ask=${clob.best_ask} | bid=${clob.best_bid} | spread=${clob.spread_pct?.toFixed?.(1)}% | depth=${clob.depth?.toFixed?.(0)} | valid=${Boolean(clob.valid)}`
    );
    const clobPass = poly_clob_valid(clob, lag.direction, size);
    log(`[SPL-GATE6] CLOB result: ${clobPass ? "PASS ✅" : "FAIL ❌"}`);
    if (!clobPass) return;
    const score = confirmation_score(lag, imbalance, clob);
    if (!entry_confirmed(score, time_left)) return;

    const trade = await bot_context.place_order?.({
      market_slug: market.slug,
      side: lag.direction,
      size,
      price: clob.valid ? clob.best_ask : undefined,
      order_type: clob.valid ? "LIMIT" : "MARKET",
      strategy: "spot_poly_lag",
      prob: up_prob,
      true_prob: lag.true_prob,
      edge_pct: lag.edge_pct,
      tier: lag.tier,
      spot_at_entry: spot,
      ob_ratio: imbalance.ratio,
      clob_ask: clob.best_ask,
      clob_spread: clob.spread_pct,
      price_to_beat: market.price_to_beat
    });
    if (!trade) return;
    mark_entered();
    start_position_monitor(
      { ...trade, clob_ask: clob.best_ask, market_slug: market.slug, side: normalizeSide(lag.direction), size },
      time_left
    );

    log(`[SPL] PRICE: $${spot} | 5s move: ${lag.move_pct?.toFixed(3)}%`);
    log(`[SPL] LAG: ${lag.tier} | edge=+${lag.edge_pct.toFixed(1)}% | direction=${normalizeSide(lag.direction)}`);
    log(`🎯 [SPL] FIRED ${normalizeSide(lag.direction)} $${size} | tier=${lag.tier} | mode=${mode} | edge=+${lag.edge_pct.toFixed(1)}% | ${time_left}s left`);
  } catch (e) {
    log(`[SPL] ERROR: ${e?.message ?? String(e)}`);
  }
}

module.exports = {
  configureSpotPolyLagContext,
  connect_binance_ob,
  get_binance_imbalance,
  binance_ob_confirms,
  get_poly_clob,
  poly_clob_valid,
  spot_poly_lag_engine
};

