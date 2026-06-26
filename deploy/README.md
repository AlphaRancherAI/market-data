# Deploying the market-data scraper

Continuous capture of ES/NQ futures quotes, time & sales, MIN1 OHLC, and the option
chain from the authenticated thinkorswim web app, via passive CDP frame capture.

## Components

| Process | File | Role |
|---------|------|------|
| runner  | `src/runner.js` | launchd-supervised. Keeps the daemon alive, drives the UI on an interval during market hours. |
| daemon  | `src/daemon.js` | Passive CDP frame capture → raw zstd JSONL + curated per-stream JSONL. Never sends app frames. |
| ui-driver | `src/ui-driver.js` | Clicks real DOM buttons to (re)establish subscriptions: quotes, MIN1 chart, tape, option chain. |

## Prerequisite (manual, not automated)

The scraper observes the ToS web app's own socket. That requires, **at all times**:

1. **Chrome Canary running with remote debugging** on `localhost:19222`
   (the jarvis browser profile, persistent auth).
2. **An authenticated `trade.thinkorswim.com` tab** logged into the Schwab/ToS account.

The runner does NOT launch the browser or log in. If the session expires, re-auth the tab
manually.

### Login-wall watcher (detect + alert)

`src/login-watch.js` is a standalone monitor (separate launchd agent
`com.henry.marketdata-loginwatch`). It polls the ToS tab via CDP and, when it detects the
login wall, sends a Telegram alert so you can re-auth the tab in Canary by hand (one click;
Chrome autofills the saved password). It does **not** log in or touch credentials. Capture
resumes automatically once the tab is authenticated again.

```bash
# one-shot check (prints AUTHED / LOGGED_OUT / NO_TAB)
node src/login-watch.js

# install the watcher agent (loop mode, KeepAlive)
cp deploy/com.henry.marketdata-loginwatch.plist ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.henry.marketdata-loginwatch.plist

# logs / status / stop
tail -f logs/loginwatch.err.log
launchctl print "gui/$(id -u)/com.henry.marketdata-loginwatch" | grep -E "state =|pid ="
launchctl bootout "gui/$(id -u)/com.henry.marketdata-loginwatch"
```

The same watcher also runs a **stall watchdog**: a separate failure mode where the session
is authed but the daemon stops receiving data (subscriptions go stale after a re-login, or
the socket wedges). It watches the curated capture files (`tape`/`quotes`/`option_quotes`)
and, if they stop growing while authed + during CME futures hours for `STALL_THRESHOLD`,
re-runs the UI driver to re-establish subscriptions — recovering from a stall on its own. It
does **not** log in (that stays manual).

Watcher env (plist): `LOGIN_POLL_INTERVAL` (default 30000 ms), `LOGIN_ALERT_COOLDOWN`
(default 1800000 ms — throttles repeat logout alerts), `STALL_THRESHOLD` (default 90000 ms —
no capture-file growth this long while authed/open => stalled), `REDRIVE_COOLDOWN` (default
180000 ms — min gap between stall re-drives), `SYMBOLS` (first symbol is re-driven on stall),
`CDP_HOST`/`CDP_PORT`.

## Install (launchd, KeepAlive)

```bash
cd ~/workspace/market-data
bash deploy/install.sh
```

This copies `deploy/com.henry.marketdata.plist` to `~/Library/LaunchAgents/` and bootstraps it.
The runner starts at load and on every login, and launchd restarts it if it crashes.

### Config (plist `EnvironmentVariables`)

- `SYMBOLS` — comma list, default `/ES:XCME,/NQ:XCME`
- `DRIVE_INTERVAL` — ms between UI refresh cycles, default `900000` (15 min)
- `CDP_HOST` / `CDP_PORT` — DevTools endpoint, default `localhost:19222`

## Capture window

The runner only drives subscriptions during CME equity-index futures hours
(`src/market-hours.js`): Sun 17:00 CT → Fri 16:00 CT, skipping the 16:00–17:00 CT daily
maintenance break and weekends. The daemon stays attached the whole time but only records
what the app streams.

## Operate

```bash
# logs
tail -f logs/runner.out.log logs/runner.err.log

# status
launchctl print "gui/$(id -u)/com.henry.marketdata" | grep -E "state =|pid ="

# stop / uninstall
launchctl bootout "gui/$(id -u)/com.henry.marketdata"

# one-off manual run (ignores market-hours gate)
FORCE_OPEN=1 SYMBOLS=/ES:XCME node src/runner.js
```

## Data layout

```
data/raw/frames-YYYYMMDD-HH.jsonl.zst     every frame, zstd-compressed (replayable)
data/curated/quotes-YYYYMMDD.jsonl        ES/NQ futures quotes
data/curated/tape-YYYYMMDD.jsonl          time & sales prints
data/curated/candles_closed-YYYYMMDD.jsonl  MIN1 OHLCV (chart floor)
data/curated/option_quotes-YYYYMMDD.jsonl   per-strike BID/ASK/DELTA/OI/VOLUME/PROB_ITM
data/curated/option_chain-YYYYMMDD.jsonl    strike → call/put symbol reference grid
```

## Validate OHLC

```bash
node scripts/validate-ohlc.js YYYYMMDD
```

Reconstructs 1-minute bars from the tape and compares against the chart's MIN1 closes.
(The web chart floor is MIN1; sub-minute/seconds OHLC is reconstructed from the tape.)
