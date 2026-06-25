// daemon.js — long-running ToS market-data capture daemon.
//
// Pipeline:
//   CDP passive frames (src/cdp.js)
//     -> RawWriter   : every frame, append to hourly zstd JSONL (data/raw/)
//     -> StateReconstructor : apply snapshot+patch, emit normalized events
//          -> CuratedWriter : quotes / tape / candles to per-day JSONL (data/curated/)
//
// Passive only. All subscriptions are made by the ToS web app itself (driven separately
// by the UI driver). The daemon never sends app frames — it only observes.
//
// Auto-reconnects to the CDP target if the socket drops or the tab navigates.
const path = require('path');
const { attachAll } = require('./cdp');
const { RawWriter } = require('./raw-writer');
const { CuratedWriter } = require('./curated-writer');
const { StateReconstructor } = require('./state');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = process.env.RAW_DIR || path.join(ROOT, 'data', 'raw');
const CURATED_DIR = process.env.CURATED_DIR || path.join(ROOT, 'data', 'curated');

const raw = new RawWriter(RAW_DIR);
const curated = new CuratedWriter(CURATED_DIR);

const stats = { frames: 0, recv: 0, sent: 0, quotes: 0, optQuotesDeduped: 0, chainDeduped: 0, tape: 0, candlesClosed: 0, candlesForming: 0, reconnects: 0 };

// option_quotes dedupe: ToS re-dumps every strike across every expiry on each refresh,
// so the same values repeat ~2M lines/min. We only write a contract when its values
// actually change. lastOptSig maps contract symbol -> signature of last-written values.
const lastOptSig = new Map();
const lastChainSig = new Map();
// Coarse dedupe: only write when a field moves past a meaningful threshold, so micro-jitter
// (delta wiggling 0.0001, prob_itm flickering) doesn't force a row every patch. Per-field
// quantization step; OI/VOLUME are exact integers so step=1 (any change counts).
const OPT_FIELDS = ['BID', 'ASK', 'DELTA', 'OPEN_INT', 'VOLUME', 'PROBABILITY_ITM'];
const OPT_QUANT = { BID: 0.01, ASK: 0.01, DELTA: 0.01, PROBABILITY_ITM: 0.01, OPEN_INT: 1, VOLUME: 1 };
function optSig(values) {
  let s = '';
  for (const f of OPT_FIELDS) {
    if (f in values) {
      const v = values[f];
      const step = OPT_QUANT[f] || 0.01;
      s += (typeof v === 'number' ? Math.round(v / step) : v);
    }
    s += '|';
  }
  return s;
}

const state = new StateReconstructor({
  onQuote(symbol, values, ts, isOpt) {
    stats.quotes++;
    if (isOpt) {
      const sig = optSig(values);
      if (lastOptSig.get(symbol) === sig) { stats.optQuotesDeduped++; return; }
      lastOptSig.set(symbol, sig);
      curated.write('option_quotes', { symbol, ts, ...values });
    } else {
      curated.write('quotes', { symbol, ts, ...values });
    }
  },
  onChain(series) {
    // Static strike->symbol reference grid. The grid arrives incrementally (patches fill in
    // strikes), so we only write when the strike SET for an expiration grows or changes —
    // skipping the redundant re-dumps of an already-seen grid. Keyed by expiration; value is
    // the set of strikes already written. Write if any new strike appears.
    const strikes = (series.pairs || []).map((p) => p.strike);
    const prev = lastChainSig.get(series.expiration);
    if (prev) {
      let hasNew = false;
      for (const s of strikes) { if (!prev.has(s)) { hasNew = true; break; } }
      if (!hasNew) { stats.chainDeduped++; return; }
      for (const s of strikes) prev.add(s);
    } else {
      lastChainSig.set(series.expiration, new Set(strikes));
    }
    curated.write('option_chain', { ts: Date.now(), ...series });
  },
  onTape(print) {
    stats.tape++;
    // print: { symbol, price, size, sizeDecimal, time, sequence, exchangeCode }
    curated.write('tape', print);
  },
  onCandle(bar, meta) {
    if (meta.closed) { stats.candlesClosed++; curated.write('candles_closed', bar); }
    else { stats.candlesForming++; /* forming bars are high-volume; keep in raw only */ }
  },
});

function onEvent(ev) {
  stats.frames++;
  // tag raw frame with capture timestamp + originating tab target
  raw.write({ ts: ev.ts, ev: ev.ev, url: ev.url, targetId: ev.targetId, requestId: ev.requestId, opcode: ev.opcode, len: ev.len, payload: ev.payload });
  if (ev.ev === 'recv') {
    stats.recv++;
    if (ev.opcode === 1 && ev.payload) {
      let j; try { j = JSON.parse(ev.payload); } catch { return; }
      // namespace state by socket so identical service ids across tabs don't collide
      if (j && j.payload) state.ingest(j, ev.requestId);
    }
  } else if (ev.ev === 'sent') {
    stats.sent++;
  }
}

let controller = null;
let stopping = false;

async function connect() {
  try {
    controller = await attachAll(onEvent, {
      onAttach: (url, tid) => console.error(`[daemon] attached tab ${tid} ${url}`),
      onError: (e) => console.error('[daemon] CDP error:', e.message),
    });
    console.error(`[daemon] watching ${controller.count()} thinkorswim tab(s)`);
  } catch (e) {
    console.error('[daemon] attach failed:', e.message, '- retry in 5s');
    setTimeout(connect, 5000);
  }
}

const startedAt = Date.now();
setInterval(() => {
  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.error(`[daemon] +${mins}m frames=${stats.frames} recv=${stats.recv} quotes=${stats.quotes} optDedup=${stats.optQuotesDeduped} tape=${stats.tape} candlesClosed=${stats.candlesClosed} reconnects=${stats.reconnects} raw=${(raw.stats().bytesIn/1e6).toFixed(1)}MB`);
}, 60000);

function shutdown() {
  stopping = true;
  console.error('[daemon] shutting down, flushing writers...');
  try { if (controller) controller.stop(); } catch {}
  raw.close();
  curated.close();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.error('[daemon] starting. raw:', RAW_DIR, 'curated:', CURATED_DIR);
connect();
