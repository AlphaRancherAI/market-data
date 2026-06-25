# thinkorswim WsJson Protocol Reference

Reverse-engineered from live capture on 2026-06-12. All frames are WebSocket **text**
frames (opcode 1) carrying UTF-8 JSON.

## Gateway

```
wss://thinkorswim-services.schwab.com/Services/WsJson
```

A second socket (`wss://p0017.glance.net/visitorws`) is co-browse/support tooling and
is irrelevant to market data.

## Connection Lifecycle

### 1. Handshake (client → server, first frame)

```json
{"ver": "27.*.*", "fmt": "json-patches-structured", "heartbeat": "2s"}
```

- `fmt: json-patches-structured` → server sends initial `snapshot` then `patch` deltas
  using RFC-6902 JSON Patch ops (`replace`, `add`, `remove`) against the snapshot tree.

### 2. Login (client → server)

```json
{"payload":[{"header":{"service":"login","id":"login","ver":0},
  "params":{"domain":"TOS","platform":"PROD","token":"<SESSION_TOKEN>","tag":"TOSWeb"}}]}
```

- `token` is a short-lived session token (~32 char). It is obtained by the web app
  during the OAuth/login flow and lives in app memory / a prior auth response. NOT the
  gateway-token. You harvest it from the authenticated page, not by logging in via WS.

### 3. Heartbeats (server → client)

```json
{"heartbeat": 68010}
```

Sent every ~2s. Client must keep the socket alive; mirror cadence if needed.

## Request Envelope

Every request is an array of one or more service calls:

```json
{"payload":[
  {"header":{"service":"<name>","id":"<client-chosen-id>","ver":0},
   "params":{ ... service-specific ... }}
]}
```

- `id` is echoed back in responses so you can correlate. Choose unique ids per stream.
- Multiple service calls can be batched in one `payload` array.

## Response Envelope

```json
{"payload":[
  {"header":{"service":"<name>","id":"<id>","ver":0,"type":"snapshot|patch"},
   "body":{ ... }}
]}
```

- `type: snapshot` → full initial state.
- `type: patch` → `body.patches` is an array of JSON Patch ops against the prior
  snapshot for that `id`.

---

## Services

### `quotes` — real-time quotes (futures, stocks, AND individual options)

**Subscribe:**
```json
{"payload":[{"header":{"service":"quotes","id":"esQuotes","ver":0},
  "params":{"account":"COMBINED ACCOUNT",
            "symbols":["/ES:XCME","/NQ:XCME"],
            "fields":["BID","ASK","LAST","MARK","VOLUME","OPEN","HIGH","LOW",
                      "OPEN_INT","DELTA","GAMMA","THETA","VEGA","IMPLIED_VOLATILITY",
                      "LAST_SIZE","BID_SIZE","ASK_SIZE","NET_CHANGE","VWAP"]}}]}
```

**Key point — concurrent multi-symbol:** `symbols` is an array. Pass futures, stocks,
and option contract symbols together. Server returns one item per symbol and streams
independent patches per symbol. This is how you capture all option strikes concurrently:
build the strike symbol list and subscribe once.

**Snapshot response:**
```json
{"header":{"service":"quotes","id":"esQuotes","type":"snapshot"},
 "body":{"items":[
   {"symbol":"/ES:XCME","isDelayed":false,
    "values":{"BID":7394.25,"ASK":7394.5,"LAST":7396.0,"MARK":7394.5,"VOLUME":77882,
              "OPEN_INT":1912622, ...}}]}}
```

**Full field list captured** (from a real subscribe):
```
MARK, MARK_CHANGE, MARK_PERCENT_CHANGE, NET_CHANGE, NET_CHANGE_PERCENT,
BID, BID_EXCHANGE, ASK, ASK_EXCHANGE, BID_SIZE, ASK_SIZE, VOLUME, OPEN,
HIGH52, LOW52, HIGH, LOW, VWAP, VOLATILITY_INDEX, IMPLIED_VOLATILITY,
MARKET_MAKER_MOVE, PUT_CALL_RATIO, PERCENTILE_IV, HISTORICAL_VOLATILITY_30_DAYS,
MARKET_CAP, BETA, PE, INITIAL_MARGIN, LAST, LAST_SIZE, LAST_EXCHANGE,
RHO, BORROW_STATUS, DELTA, GAMMA, THETA, VEGA, DIV_AMOUNT, EPS, EXD_DIV_DATE,
YIELD, FRONT_VOLATILITY, BACK_VOLATILITY, VOLATILITY_DIFFERENCE, CLOSE,
INTRINSIC, EXTRINSIC, SHARES, RETURN_ON_CAPITAL, RETURN_ON_RISK,
SHORT_SALE_BORROWING_RATE, PERCENT_CHANGE_SINCE_FIVE_DAYS,
PERCENT_CHANGE_SINCE_TWENTY_DAYS, PERCENT_CHANGE_SINCE_ONE_MONTH,
PERCENT_CHANGE_SINCE_SIX_MONTHS, PERCENT_CHANGE_SINCE_YTD,
APPROXIMATE_BORROW_SIZE, OPEN_INT, EPR_LOWER, EPR_UPPER
```

---

### `time_sales` — full trade tape (time & sales)

**Subscribe:**
```json
{"payload":[{"header":{"service":"time_sales","id":"esTape","ver":0},
  "params":{"symbol":"/ESM26:XCME","minSize":1,"refreshRate":300}}]}
```

- `minSize` filters out prints below N contracts (1 = everything).
- `refreshRate` in ms (300 = batched every 300ms).
- Note the symbol: the tape uses the **resolved contract** `/ESM26:XCME`
  (month-coded), not the generic `/ES:XCME`. Resolve via `instrument_search` first.

**Response (snapshot = backfill, then patch deltas):**
```json
{"header":{"service":"time_sales","id":"esTape","type":"snapshot"},
 "body":{"symbol":"/ESM26:XCME","timeSales":[
   {"symbol":"/ESM26:XCME","exchangeCode":"G","price":7396.0,"size":1,
    "sizeDecimal":1.0,"time":"2026-06-12T06:29:31.208Z","sequence":106685}, ...]}}
```

- Each print: `price`, `size`, `time` (ISO-8601 ms precision), `sequence` (monotonic,
  use for dedup/ordering), `exchangeCode`.
- Initial snapshot backfills recent history (~41 KB observed), then live prints stream
  in as small frames in real time.

---

### `optionSeries/quotes` — option chain expiration series

Provides the chain structure: list of expirations with series-level greeks/metrics
(e.g. `SERIES_EXPECTED_MOVE`). Indexed `/series/<n>/...` in patches.

**Response (patch):**
```json
{"header":{"service":"optionSeries/quotes","id":"optionSeriesQuotes-/ES:XCME-...","type":"patch"},
 "body":{"patches":[
   {"op":"replace","path":"/series/0/values/SERIES_EXPECTED_MOVE","value":67.912}, ...]}}
```

- 36 series observed for /ES (0..35) = the available expirations.

---

### `option_chain/get` — per-expiration strike → symbol map

Returns the full strike list for one (or more) expiration series, each with its
call/put contract symbols. This is how you enumerate every strike symbol.

**Subscribe:**
```json
{"payload":[{"header":{"service":"option_chain/get","id":"option_chain/get","ver":0},
  "params":{"underlyingSymbol":"/ES:XCME",
            "filter":{"strikeQuantity":2147483647,
                      "seriesNames":[" JUN '4' 26 1/50 (Monday) (Wk4)"]}}}]}
```

- `strikeQuantity:2147483647` (max int) = return ALL strikes.
- `seriesNames` come from the chain UI / `optionSeries/quotes` (note leading space + quirky quoting).

**Snapshot response:**
```json
{"optionSeries":[{"expiration":"JUN '4' 26","expirationString":"JUN '4' 26 (1 Wk4 Monday)",
  "fractionalType":"X10","optionPairs":[
    {"strike":7400,"callSymbol":"./E4AM26C7400:XCME","putSymbol":"./E4AM26P7400:XCME",
     "callDisplaySymbol":"./E4AM26C7400","putDisplaySymbol":"./E4AM26P7400"}, ...]}]}
```

**Option symbol format:** `./<root><monthCode><C|P><strike>:XCME`
- `./E4A` = ES weekly-Monday root (varies by weekday/series: E1A/E2A/E3A/E4A/E5A, EW for AM-settled, etc.)
- `M26` = month (M=Jun) + year (26)
- `C7400` / `P7400` = call/put + strike
- `:XCME` = exchange

---

### `quotes/options` — whole-chain per-strike streaming (THE option data service)

The efficient way to stream an entire expiration's strikes. One subscribe covers a
strike range; server streams per-strike greeks/quotes as JSON patches. No need to
enumerate individual symbols.

**Subscribe:**
```json
{"payload":[{"header":{"service":"quotes/options","id":"quotes/options","ver":0},
  "params":{"underlyingSymbol":"/ES:XCME","exchange":"BEST","refreshRate":300,
            "fields":["BID","ASK","PROBABILITY_ITM","DELTA","OPEN_INT","VOLUME"],
            "filter":{"seriesNames":[" JUN '4' 26 1/50 (Monday) (Wk4)"],
                      "minStrike":7330,"maxStrike":7450}}}]}
```

- `filter.minStrike`/`maxStrike` bound the strikes (widen to capture the full chain).
- `fields` can be extended with greeks (GAMMA, THETA, VEGA, IMPLIED_VOLATILITY, MARK, LAST).
- `refreshRate` ms throttle.

**Snapshot then patches:**
```json
{"items":[
  {"symbol":"./E4AM26C7400:XCME",
   "values":{"ASK":117,"BID":115.5,"DELTA":0.5988,"OPEN_INT":228,"PROBABILITY_ITM":0.6043}},
  {"symbol":"./E4AM26P7400:XCME",
   "values":{"ASK":64.25,"BID":63.25,"DELTA":-0.3999,"OPEN_INT":473,"PROBABILITY_ITM":0.397}}, ...],
 "exchanges":["AMEX","BATS","BEST","BOX","C2","CBOE","ISE","NASDAQ","NYSE","PHLX"]}
```

Patches arrive as `{"op":"replace","path":"","value":{"items":[...]}}` (full refresh) or
`{"op":"add","path":"/items","value":[...]}` (strikes added as you widen range/scroll).

**Two ways to get option data:**
1. `quotes/options` (recommended): per-series strike-range subscribe, returns greeks keyed
   by option symbol. Cleanest for full-chain capture.
2. `quotes` with a `symbols` array of `./...C/P<strike>:XCME` symbols (from `option_chain/get`):
   use when you want specific strikes mixed with futures/stocks in one subscribe.

---

### `chart` — OHLCV bars

**Subscribe** (service `chart`, id `chart-page-chart-1`):
```json
{"payload":[{"header":{"service":"chart","id":"chart-page-chart-1","ver":0},
  "params":{"symbol":"/ES:XCME","timeAggregation":"MIN1","studies":[],
            "range":"DAY1","extendedHours":true,"refreshRate":300}}]}
```

- `timeAggregation` values: `MIN1`, `MIN3`, `MIN5`, `MIN10`, `MIN15`, `MIN30`,
  `HOUR`, `HOUR2`(?), `DAY`, `WEEK`, `MONTH`. **MIN1 is the finest available** on the
  web platform (no seconds/tick bars in the web chart UI, confirmed at both DAY1 and
  TODAY ranges).
- `range` values: `TODAY`, `DAY1`, `DAY3`, `WEEK1`, `WEEK2`, `MONTH1`, `MONTH3`,
  `MONTH6`, `YTD`, `YEAR1`, `YEAR3`, `YEAR5`, `YEAR15`, `MAX`. The valid aggregation set
  depends on the range (e.g. YEAR1 only offers DAY/WEEK/MONTH; DAY1/TODAY offer the
  minute aggregations).
- `extendedHours:true` includes the full ETH session.

**Snapshot response — COLUMN-ORIENTED parallel arrays** (not row objects):
```json
{"header":{"service":"chart","id":"chart-page-chart-1","type":"snapshot"},
 "body":{"symbol":"/ES:XCME",
   "candles":{
     "timestamps":[1750050000000, 1750654800000, ...],   // epoch ms, bar open time
     "opens":[6001, 5964, ...],
     "highs":[6109, 6239, ...],
     "lows":[5969.5, 5959, ...],
     "closes":[6025, 6220.75, ...],
     "volumes":[6445963, 5391401, ...]}}}
```

All six arrays are parallel by index. Bar `i` = `(timestamps[i], opens[i], highs[i],
lows[i], closes[i], volumes[i])`.

**Patches** update the forming (last) bar in place by index, at ~300ms cadence
(`refreshRate`). Observed update fields on the forming bar:
```json
{"op":"replace","path":"/candles/closes/51","value":7388.75}   // running last price
{"op":"replace","path":"/candles/volumes/51","value":8173407}  // cumulative bar volume
{"op":"replace","path":"/candles/lows/51","value":7388.0}      // running min (when broken)
{"op":"replace","path":"/candles/highs/51","value":...}        // running max (when broken)
```
When a new bar opens, expect `add` ops appending to each array (and the index advances).

**Key insight — the forming bar IS a sub-minute feed.** Even though bar granularity is
1-minute, the forming-bar patches stream intra-minute: `closes[IDX]` tracks the latest
trade price every ~300ms, `volumes[IDX]` is the running cumulative volume for the minute,
and `lows[IDX]`/`highs[IDX]` move as the running min/max are broken. So the `chart` MIN1
stream gives:
- a cheap ~300ms "current price + running OHLC" feed for the live minute, AND
- exact closed-minute OHLCV once the bar finalizes (cross-check / ground truth for 1m).

For true tick/seconds OHLC, still use `time_sales` (every print, ms timestamp,
monotonic `sequence`). Use the chart forming-bar as a lightweight running-price cross-check
and the closed MIN1 bars to validate tape-reconstructed 1-second→1-minute rollups.

**Sub-minute OHLC:** the web chart caps at 1-minute. To get seconds-resolution OHLC,
aggregate the `time_sales` tape yourself (it carries tick prints with ms timestamps and
monotonic `sequence`). Reconstruct N-second bars from prints; validate the 1-second→
1-minute rollups against this `chart` MIN1 close for correctness.

---

### `instrument_search` — symbol resolution

**Subscribe:**
```json
{"payload":[{"header":{"service":"instrument_search","id":"search1","ver":0},
  "params":{"limit":5,"pattern":"/ES"}}]}
```

**Response:**
```json
{"body":{"instruments":[
  {"symbol":"/ES:XCME","displaySymbol":"/ES[M26]",
   "description":"E-mini S&P 500 Index Futures,ETH"}, ...]}}
```

Use this to map generic roots (`/ES`, `/NQ`) → tradeable contract symbols (`/ESM26:XCME`).

---

## Other services observed (not yet mapped)

`accounts`, `statement`, `positions`, `order_events`, `alerts/lookup`,
`alerts/subscribe`, `watchlist/categories`, `user_properties`, `market_hours`,
`disclosures`, `message_center/get`, `margin_calls`, `study/subscribe`, `unsubscribe`.

`unsubscribe` is how you tear down a stream by `id` — important for managing
subscription churn at scale.

## Symbol Reference

| Root | Resolved (Jun 2026) | Tape symbol | Exchange |
|------|--------------------|-----| ---------|
| /ES | /ES:XCME → /ES[M26] | /ESM26:XCME | XCME |
| /NQ | /NQ:XCME → /NQ[M26] | /NQM26:XCME | XCME |

Futures options symbols follow `./<contract><C|P><strike>` style (to be captured by
expanding a chain expiration).
