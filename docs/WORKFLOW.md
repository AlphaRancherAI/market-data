# Capture Workflow (Reproducible)

How the ToS web data layer was reverse-engineered. Repeat these steps to re-capture or
extend coverage.

## Prerequisites

- Chrome Canary installed (dedicated automation browser):
  `brew install --cask google-chrome@canary`
- Canary launched with CDP enabled on port 19222 + persistent profile:
  ```
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
    --remote-debugging-port=19222 \
    --user-data-dir="$HOME/.jarvis/browser/profile" \
    --no-first-run --no-default-browser-check
  ```
  (jarvis browser tool auto-launches this; config at `~/.jarvis/config.json`.)
- Node.js with the `ws` module (present in the jarvis repo's node_modules).

## Steps

1. **Open and log in.** Navigate to `https://trade.thinkorswim.com`. Log in manually
   (credentials + 2FA). Session persists in the Canary profile for future runs.

2. **Identify the data socket.** The app opens
   `wss://thinkorswim-services.schwab.com/Services/WsJson` on load. It is established
   before you can attach if the page is already loaded — reload the page while the
   sniffer is running to catch the handshake + initial subscription burst.

3. **Run the CDP sniffer** (`scripts/cdp-capture.js`):
   ```
   node scripts/cdp-capture.js <durationMs>
   ```
   It connects to the CDP endpoint, finds the thinkorswim tab, enables the Network
   domain, and logs `Network.webSocketCreated` / `webSocketFrameSent` /
   `webSocketFrameReceived` to `/tmp/tos-frames.jsonl`.

4. **Trigger the data you want** in the browser while capturing:
   - Futures quote: enter `/ES` or `/NQ` in the symbol box → resolves to `/ES:XCME`.
   - Time & sales: click "Time and Sales" under the chart.
   - Option chain: expand the "Option Chain" section; expand a specific expiration to
     trigger the per-strike `quotes` subscribe.

5. **Analyze frames.** Parse the JSONL, group by `header.service` and `id`, separate
   `sent` (subscribes) from `recv` (snapshots/patches). See `PROTOCOL.md`.

## Capture Script Notes

- Frames are logged raw with `{ev, url, opcode, len, payload}`.
- `webSocketCreated` only fires if you attach BEFORE the socket opens → reload to catch.
- The script uses `perMessageDeflate:false` on the CDP control socket (CDP itself is not
  compressed; the captured payloads are already-decoded application frames).

## Gotchas

- The session `token` in the `login` frame is short-lived. For an independent harvester
  you must extract a fresh token from the authenticated page context (e.g. read it from
  app state / a network response) rather than replaying an old one.
- Tape and chain use month-coded contract symbols (`/ESM26:XCME`), not the generic root.
  Always resolve via `instrument_search` first.
- Browser refs invalidate after navigation — re-snapshot after each symbol change.
