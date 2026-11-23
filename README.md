# BTC Race Bot — Washout Recovery Hybrid

[![make.fun bounty](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![make.fun rank](https://make.fun/badge/aryaadityam/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![make.fun reward](https://make.fun/badge/aryaadityam/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

A BTC trading bot for the make.fun competition
[btc-race-24h-20261123-0511](https://make.fun/bounty/btc-race-24h-20261123-0511)
("Race a BTC trading bot live for 24 hours"). It speaks the
`agent-fun/bars-replay/v1` line protocol directly: newline-delimited JSON on
stdin/stdout, one reply per batch, no dependencies, Node 22 standard runtime
only.

## Strategy

**Washout Recovery Hybrid** — long only, at most one open position, at most
one order per batch, sized at 92% of cash.

Entries (only when flat, warmed up, past the slow EMA warm-up, out of
cooldown, and with the equity brake off):

1. **Washout recovery.** A washout arms when the close falls at least 55 bps
   below the rolling 90-bar high. While armed, the washout low is tracked.
   The bot buys when the close reclaims at least 10 bps above that low and
   the current close is above the previous close, i.e. a bounce has begun.
2. **Trend rider.** The close is above the 60-bar EMA, the 12-bar EMA is
   above the 60-bar EMA, and the return over the last 10 bars is positive.

Exits (whole position):

- Trailing stop: close falls 180 bps below the peak close since entry.
- Hard stop: close falls 90 bps below the entry reference close (the close
  of the bar on which the buy was decided).
- Time stop: 1440 bars since entry.

Risk controls: a 15-bar cooldown after every sell, and a permanent brake on
new buys if equity drops below 97.5% of the starting capital. Every order
uses `max_slippage_bps` 250.

The bot is deterministic: it never reads the clock, the environment, files,
or unseeded randomness, so repeated grading runs produce byte-identical
replies. Position state is always read from the account in each batch, and
malformed input lines can never crash the process or stop the replies.

## Run it

```sh
node main.ts
```

The process then speaks the bars-replay protocol on stdin/stdout: send a
`hello` line, then one `batch` line per bar (each is answered with exactly
one `reply` line echoing its `seq`), and finish with a `done` line, on
which the bot exits cleanly with code 0.

## License

MIT — see [LICENSE](LICENSE).
