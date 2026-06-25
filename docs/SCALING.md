# Scaling & Storage Plan

How to scale from ES/NQ to all futures, stocks, and commodities, and the most efficient
storage format for later analysis.

## Part 1 — Concurrent Per-Strike Capture (the immediate question)

**Yes, you can capture all strike deltas concurrently.** The `quotes` service takes a
`symbols` array and streams independent per-symbol patches over ONE socket. Mechanics:

1. Resolve the contract: `instrument_search` `/ES` → `/ES:XCME` (`/ES[M26]`).
2. Get the chain structure: `optionSeries/quotes` gives the expirations (36 for /ES).
3. For each expiration you care about, enumerate strike symbols (calls + puts).
4. Subscribe ONCE: `quotes` with `symbols:[...all strike symbols...]`, the greek fields
   (`DELTA, GAMMA, THETA, VEGA, IMPLIED_VOLATILITY, BID, ASK, MARK, LAST, VOLUME,
   OPEN_INT`).
5. Server sends a snapshot then continuous `patch` deltas per strike. You now have
   concurrent price deltas for the entire chain on a single connection.

**Throughput reality:** a full ES chain is thousands of strikes × multiple expirations.
The server may cap symbols per subscribe or per socket. Strategy:
- Batch strikes into multiple subscribes (each with its own `id`) over the same socket.
- If one socket saturates, open N sockets (each its own login) and shard symbols across
  them. The protocol is stateless per-`id`, so sharding is trivial.

## Part 2 — Most Efficient Storage Format (for later analysis)

Different data shapes want different formats. Recommendation: **capture raw, store
columnar.**

### Tier 0 — Raw capture (append-only, lossless)
- Write every frame as-is to **newline-delimited JSON (JSONL)**, optionally zstd-compressed
  (`.jsonl.zst`). Cheap, lossless, replayable. This is your source of truth / audit log.
- Partition by `date / service / symbol`.

### Tier 1 — Analysis store (columnar)
Convert raw frames into typed columnar files. **Apache Parquet** is the right default:
- Columnar → fast scans of single fields (e.g. just `price` across millions of ticks).
- Excellent compression (dictionary + RLE + zstd). Tick data compresses 5-10x.
- Native to pandas/polars/DuckDB/Spark/Arrow. Zero-friction analysis later.
- Schema-on-write catches malformed data early.

For **time & sales / tick data** specifically, the shape is perfect for columnar:
```
schema: symbol(dict), price(float64), size(int32), sizeDecimal(float64),
        exchangeCode(dict), time(timestamp[ms]), sequence(int64),
        ingest_ts(timestamp[ms])
```
Partition Parquet by `symbol` and `date`. Sort within file by `sequence`.

For **quote/greek snapshots** (futures + options), two viable layouts:
- **Wide**: one row per (symbol, timestamp) with a column per field. Good if field set is
  stable. Sparse if many fields are null.
- **Long/EAV**: one row per (symbol, timestamp, field, value). Better for the patch-delta
  nature of the feed (you receive individual field updates). Recommended for options
  greeks because updates are field-granular.

### Tier 2 — Hot query layer (optional)
- **DuckDB** over the Parquet files = serverless analytical SQL, no infra. Best starting
  point for research/backtests.
- If you need real-time dashboards or heavy time-series ops, a **TimescaleDB**
  (PostgreSQL) hypertable or **ClickHouse** (better for tick scale) is the upgrade path.
  Note: alpharancher already runs TimescaleDB on :5435 — could reuse.

### Why not just a relational DB for raw ticks?
Row-store + per-tick INSERT is slow and storage-heavy at futures tick rates. Append to
JSONL/Parquet, batch-load to TS DB only what you query interactively.

### Recommended default
```
raw:      ~/workspace/market-data/data/raw/<date>/<service>/<symbol>.jsonl.zst
curated:  ~/workspace/market-data/data/parquet/<dataset>/symbol=<X>/date=<Y>/*.parquet
query:    DuckDB over the parquet/ tree
```
Delta encoding for `price`/`time`/`sequence` inside Parquet (it does this automatically
with the right column types) gives near-optimal size. Add `ingest_ts` to every row so you
can measure feed latency and dedup by `sequence`.

## Part 3 — Scaling to All Instruments

### Symbol universe
- Futures: enumerate roots (/ES /NQ /YM /RTY /CL /GC /SI /NG /ZB /ZN /ZC /ZS ...).
  Resolve front (and back) contracts via `instrument_search`.
- Stocks: large universe (thousands). Subscribe in sharded batches.
- Each instrument type uses the SAME `quotes` service; tape uses `time_sales` per symbol.

### Architecture
```
[Auth/Token Manager] → keeps fresh session token(s)
        │
[Subscription Planner] → builds symbol shards, assigns to sockets
        │
[N Socket Workers] → each: 1 WsJson connection, login, subscribe its shard,
        │             decode frames, apply patches, emit normalized events
        │
[Writer] → append JSONL (raw) + batch to Parquet (curated)
        │
[DuckDB / TS DB] → analysis
```

### Practical constraints & risks
- **Market data licensing**: CME/Nasdaq data is licensed to your account for personal
  use. Mass capture + storage + any redistribution likely violates exchange agreements.
  Keep it personal-use; do not redistribute.
- **Account flagging**: "Usage will be monitored." Many sockets / huge symbol counts from
  one account may trip abuse detection. Throttle, mimic human session patterns, limit
  socket count.
- **Token lifecycle**: tokens expire; build refresh/reconnect with backoff. Re-subscribe
  on reconnect (server state is per-connection).
- **Snapshot vs patch correctness**: you MUST apply patches against the right snapshot per
  `id`. Persist the reconstructed state, not just patches, or store both and reconstruct
  offline.
- **Symbol caps per subscribe**: unknown exact limit; discover empirically and shard.

### Alternative worth weighing
The official **Schwab Trader API** (former TDA API) provides licensed real-time quotes,
price history, option chains, and a streaming feed with a supported contract and no
scraping fragility. For a durable pipeline it is lower-risk than scraping the web app.
You chose ToS-web-only for now; revisit if this needs to run unattended at scale.
