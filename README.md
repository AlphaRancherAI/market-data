# Market Data Harvesting (thinkorswim Web)

Data pipeline for harvesting market data from the Charles Schwab thinkorswim web app
(`trade.thinkorswim.com`) for personal trading research. The ToS web feed exposes richer data
than the official API: full time & sales tape, all option strikes with live per-strike deltas,
and futures quotes/greeks.

## How it works

Passive capture via Chrome DevTools Protocol: the daemon attaches to the authenticated ToS tab
and records the WebSocket frames the app already receives, reconstructing state from the JSON
patches. The UI driver opens panels (chart, tape, option chain) to trigger the app's own
subscriptions. See `docs/PROTOCOL.md` and `docs/WORKFLOW.md`.

## Layout

```
src/         capture daemon, CDP attach, state reconstruction, writers, UI driver, runner
scripts/     CDP sniffer, OHLC validation
docs/        PROTOCOL.md, WORKFLOW.md, SCALING.md
data/raw/    raw frames (hourly zstd JSONL)
data/curated/ per-stream JSONL (DuckDB-ready)
deploy/      launchd agent
```

## Storage

- Tier 0: raw JSONL.zst (lossless audit/replay).
- Tier 1: curated per-stream JSONL → Parquet (DuckDB/polars).

## Notes

- Exchange data (CME/Nasdaq) is personal-use only; no redistribution.
- ToS enforces a single authenticated web session, so multi-instrument capture cycles symbols
  through the one tab via the in-app symbol search.

## `schwab/` (alternative, not in use)

`schwab/` holds an experimental pipeline against the official Schwab Trader API (`schwab-py`).
Kept for reference; the ToS web feed is the primary source because it exposes more data.
