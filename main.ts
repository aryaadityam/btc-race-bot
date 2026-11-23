// Washout Recovery Hybrid
//
// Strategy for the make.fun BTC race (agent-fun/bars-replay/v1).
// Long only, at most one open position, at most one order per batch.
//
// How it works:
//   1. Washout recovery: when the close falls at least WASH_DROP_BPS below the
//      rolling HIGH_WIN-bar high, a washout is "armed" and its low is tracked.
//      The bot buys once the close reclaims RECLAIM_BPS above that low and the
//      current close is above the previous close (a bounce has begun).
//   2. Trend rider: otherwise, the bot buys when the close is above the slow
//      EMA, the fast EMA is above the slow EMA, and the 10-bar return is
//      positive.
//   Exits are a trailing stop off the peak close since entry, a hard stop off
//   the entry reference close, and a MAX_HOLD time stop. After a sell a
//   COOLDOWN applies. A permanent brake stops new buys if equity falls below
//   97.5% of the starting capital.
//
// The bot is fully deterministic: it reads no clock, no environment, no files
// and no randomness. All state comes from the hello and batch messages, and
// the position is always taken from the account in each batch (authoritative),
// never from assumed fills.

// ---------------------------------------------------------------------------
// Tunable strategy constants (the coordinator may tune these)
// ---------------------------------------------------------------------------
const EMA_FAST = 12; // fast EMA period over closes
const EMA_SLOW = 60; // slow EMA period over closes; no buys before seq >= EMA_SLOW
const HIGH_WIN = 90; // rolling-high window in bars
const WASH_DROP_BPS = 55; // drop below rolling high (bps) that arms a washout
const RECLAIM_BPS = 10; // rise above the washout low (bps) that triggers a buy
const TRAIL_BPS = 180; // trailing stop distance below peak close since entry (bps)
const STOP_BPS = 90; // hard stop distance below the entry reference close (bps)
const MAX_HOLD = 1440; // maximum bars to hold a position
const COOLDOWN = 15; // bars to wait after a sell before buying again
const SIZE_BPS = 9200; // buy size as bps of cash (9200 = 92%)
const MIN_NOTIONAL = 1000000; // skip buys smaller than this (quote units, scale 6)
const MAX_SLIPPAGE_BPS = 250; // max_slippage_bps sent on every order
const BRAKE_BPS = 9750; // brake engages below 97.5% of starting equity
const TREND_LOOKBACK = 10; // bars for the trend rider's return check
const SYMBOL = "CBBTC";

// ---------------------------------------------------------------------------
// Mutable run state (derived only from hello / batch messages)
// ---------------------------------------------------------------------------
let warmupBars = 0;
let startEquity = 1000000000n;
let closes: number[] = [];
let emaFast = 0;
let emaSlow = 0;
let emaInit = false;
let orderCounter = 0;
let brakeOn = false;

// Washout state.
let washoutArmed = false;
let washoutLow = 0;

// Open-position bookkeeping. entrySeq / entryRef refer to the bar on which
// the buy was *decided* (its close is the entry reference price).
let entrySeq = -1;
let entryRef = 0;
let peakSinceEntry = 0;
let pendingEntrySeq = -1;
let pendingEntryRef = 0;

// Seq of the bar on which the last sell was decided (-1 = never sold).
let lastSellSeq = -1;

function nextClientId(): string {
  orderCounter += 1;
  return "o" + orderCounter;
}

function sendReply(seq: number, orders: unknown[]): void {
  const line = JSON.stringify({ type: "reply", seq: seq, orders: orders });
  process.stdout.write(line + "\n");
}

// Extract a seq from a raw line even when full JSON parsing failed, so a
// malformed batch can still be answered with an empty reply.
function salvageSeq(line: string): number {
  const m = /"seq"\s*:\s*(-?\d+)/.exec(line);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return -1;
}

function rollingHigh(): number {
  const n = closes.length;
  const from = Math.max(0, n - HIGH_WIN);
  let hi = 0;
  for (let i = from; i < n; i++) {
    if (closes[i] > hi) hi = closes[i];
  }
  return hi;
}

function handleHello(msg: any): void {
  try {
    if (msg && typeof msg.warmup_bars === "number" && msg.warmup_bars > 0) {
      warmupBars = Math.floor(msg.warmup_bars);
    }
    if (msg && msg.capital && typeof msg.capital.quote_units === "string") {
      try {
        startEquity = BigInt(msg.capital.quote_units);
      } catch {
        // Keep the default starting equity.
      }
    }
  } catch {
    // A malformed hello must never crash the process.
  }
}

// Decide orders for one batch. Returns an array with at most one order.
function decide(msg: any): unknown[] {
  const seq: number = typeof msg.seq === "number" ? msg.seq : -1;
  const account = msg.account;
  if (!account) return [];

  // --- Account state (authoritative) ---
  let cash = 0n;
  try {
    cash = BigInt(String(account.cash_quote_units ?? "0"));
  } catch {
    cash = 0n;
  }
  let equity = startEquity;
  try {
    equity = BigInt(String(account.equity_quote_units ?? "0"));
  } catch {
    equity = startEquity;
  }
  let qtyStr = "0";
  const positions = Array.isArray(account.positions) ? account.positions : [];
  for (const p of positions) {
    if (p && p.symbol === SYMBOL && typeof p.qty === "string") {
      qtyStr = p.qty;
    }
  }
  const inPosition = qtyStr !== "0" && qtyStr !== "";

  // --- Latest close for our symbol ---
  let close = 0;
  let haveBar = false;
  const bars = Array.isArray(msg.bars) ? msg.bars : [];
  for (const b of bars) {
    if (b && b.symbol === SYMBOL && typeof b.c === "string") {
      const v = Number(b.c);
      if (Number.isFinite(v) && v > 0) {
        close = v;
        haveBar = true;
      }
    }
  }
  if (!haveBar) return [];

  const prevClose = closes.length > 0 ? closes[closes.length - 1] : 0;
  closes.push(close);

  // --- Indicators ---
  if (!emaInit) {
    emaFast = close;
    emaSlow = close;
    emaInit = true;
  } else {
    const aF = 2 / (EMA_FAST + 1);
    const aS = 2 / (EMA_SLOW + 1);
    emaFast += aF * (close - emaFast);
    emaSlow += aS * (close - emaSlow);
  }

  // --- Brake (latched) ---
  if (startEquity > 0n && equity * 10000n < startEquity * BigInt(BRAKE_BPS)) {
    brakeOn = true;
  }

  // --- Position lifecycle bookkeeping ---
  if (inPosition) {
    if (entrySeq < 0) {
      // Position appeared: adopt the pending decision if there is one,
      // otherwise fall back to this bar as the entry reference.
      if (pendingEntrySeq >= 0) {
        entrySeq = pendingEntrySeq;
        entryRef = pendingEntryRef;
        peakSinceEntry = entryRef;
      } else {
        entrySeq = seq;
        entryRef = close;
        peakSinceEntry = close;
      }
      pendingEntrySeq = -1;
      pendingEntryRef = 0;
    }
    if (close > peakSinceEntry) peakSinceEntry = close;
  } else {
    // Flat: a pending buy older than one bar never filled; drop it.
    if (pendingEntrySeq >= 0 && seq - pendingEntrySeq > 1) {
      pendingEntrySeq = -1;
      pendingEntryRef = 0;
    }
    if (entrySeq >= 0) {
      // Position closed since the last batch.
      entrySeq = -1;
      entryRef = 0;
      peakSinceEntry = 0;
    }
  }

  // --- Washout arming / tracking (uses closes including the current bar) ---
  const hi = rollingHigh();
  if (hi > 0) {
    if (close >= hi) {
      // New high: any old washout is over.
      washoutArmed = false;
      washoutLow = 0;
    } else if (close * 10000 <= hi * (10000 - WASH_DROP_BPS)) {
      if (!washoutArmed) {
        washoutArmed = true;
        washoutLow = close;
      }
    }
    if (washoutArmed && close < washoutLow) {
      washoutLow = close;
    }
  }

  const warmingUp = warmupBars > 0 && seq < warmupBars;
  if (warmingUp) return [];

  // --- SELL: whole position on any exit trigger ---
  if (inPosition && entrySeq >= 0) {
    const barsSinceEntry = seq - entrySeq;
    const trailHit =
      peakSinceEntry > 0 && close * 10000 <= peakSinceEntry * (10000 - TRAIL_BPS);
    const stopHit = entryRef > 0 && close * 10000 <= entryRef * (10000 - STOP_BPS);
    const timeHit = barsSinceEntry >= MAX_HOLD;
    if (trailHit || stopHit || timeHit) {
      lastSellSeq = seq;
      washoutArmed = false;
      washoutLow = 0;
      return [
        {
          side: "sell",
          client_id: nextClientId(),
          symbol: SYMBOL,
          qty: qtyStr,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  // --- BUY: only when flat ---
  if (!inPosition) {
    // A buy decided on the previous bar fills at this bar's open. If the
    // account still shows flat, that decision is still settling (or was
    // rejected): never stack a second buy on top of a pending one. The
    // pending entry expires above once it is more than one bar old.
    if (pendingEntrySeq >= 0) return [];
    if (brakeOn) return [];
    if (seq < EMA_SLOW) return [];
    if (lastSellSeq >= 0 && seq - lastSellSeq < COOLDOWN) return [];

    let buySignal = false;

    // (a) Washout recovery: reclaim above the washout low with a rising close.
    if (
      washoutArmed &&
      washoutLow > 0 &&
      prevClose > 0 &&
      close > prevClose &&
      close * 10000 >= washoutLow * (10000 + RECLAIM_BPS)
    ) {
      buySignal = true;
    }

    // (b) Trend rider.
    if (!buySignal) {
      if (close > emaSlow && emaFast > emaSlow && closes.length > TREND_LOOKBACK) {
        const past = closes[closes.length - 1 - TREND_LOOKBACK];
        if (past > 0 && close > past) buySignal = true;
      }
    }

    if (!buySignal) return [];

    const notional = (cash * BigInt(SIZE_BPS)) / 10000n;
    if (notional < BigInt(MIN_NOTIONAL)) return [];

    pendingEntrySeq = seq;
    pendingEntryRef = close;
    washoutArmed = false;
    washoutLow = 0;
    return [
      {
        side: "buy",
        client_id: nextClientId(),
        symbol: SYMBOL,
        notional_quote_units: notional.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }

  return [];
}

function handleLine(line: string): boolean {
  // Returns true when the process should exit (a "done" message was seen).
  let msg: any = null;
  try {
    msg = JSON.parse(line);
  } catch {
    // Not JSON: if it still looks like a batch, answer it empty.
    if (line.indexOf('"batch"') >= 0) {
      const seq = salvageSeq(line);
      if (seq >= 0) sendReply(seq, []);
    }
    return false;
  }
  try {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "hello") {
      handleHello(msg);
      return false;
    }
    if (msg.type === "done") {
      return true;
    }
    if (msg.type === "batch") {
      const seq: number = typeof msg.seq === "number" ? msg.seq : salvageSeq(line);
      let orders: unknown[] = [];
      try {
        orders = decide(msg);
      } catch {
        orders = [];
      }
      sendReply(seq, orders);
      return false;
    }
    return false;
  } catch {
    // Last-resort guard: never crash, and still answer a batch if we can.
    try {
      if (msg && msg.type === "batch" && typeof msg.seq === "number") {
        sendReply(msg.seq, []);
      }
    } catch {
      // Nothing more can be done for this line.
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Line-delimited stdin loop
// ---------------------------------------------------------------------------
let buffer = "";
let finished = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (finished) return;
  buffer += chunk;
  let idx = buffer.indexOf("\n");
  while (idx >= 0) {
    let line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length > 0) {
      if (handleLine(line)) {
        finished = true;
        process.exit(0);
      }
    }
    idx = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (!finished) {
    const line = buffer.trim();
    if (line.length > 0) {
      if (handleLine(line)) {
        finished = true;
        process.exit(0);
      }
    }
    process.exit(0);
  }
});
