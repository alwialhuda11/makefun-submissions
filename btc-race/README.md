# BTC race bot

A long-only trend-following bot for make.fun's "Race a BTC trading bot live for 24 hours"
bounty. It trades Coinbase Wrapped BTC (cbBTC) against USDC on the bars-replay protocol.

## Run it

```sh
node --experimental-strip-types main.ts
```

The bot reads newline-delimited JSON on stdin (hello, then one batch per minute)
and writes replies on stdout.
