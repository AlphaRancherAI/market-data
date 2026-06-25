// validate-ohlc.js — reconstruct 1-minute OHLC bars from the time_sales tape and
// compare against the chart service's MIN1 closed candles for the same minutes.
//
// The ToS web chart's finest resolution is MIN1, so seconds-resolution OHLC must be
// reconstructed from the tape. This script validates that reconstruction by checking
// the per-minute tape bars line up with the authoritative MIN1 chart closes.
//
// Usage: node scripts/validate-ohlc.js [YYYYMMDD]
const fs = require('fs');
const path = require('path');

const day = process.argv[2] || new Date().toISOString().slice(0, 10).replace(/-/g, '');
const CUR = path.resolve(__dirname, '..', 'data', 'curated');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const tape = readJsonl(path.join(CUR, `tape-${day}.jsonl`));
const candles = readJsonl(path.join(CUR, `candles_closed-${day}.jsonl`));

if (!tape.length || !candles.length) {
  console.error(`Need both tape and candles for ${day}. tape=${tape.length} candles=${candles.length}`);
  process.exit(1);
}

// Reconstruct 1-minute bars from tape (bucket by floor(time/60000)).
const bars = new Map(); // minuteEpochMs -> {o,h,l,c,v,n,firstSeq,lastSeq}
for (const t of tape) {
  const ms = Date.parse(t.time);
  if (Number.isNaN(ms)) continue;
  const min = Math.floor(ms / 60000) * 60000;
  const px = t.price;
  const sz = t.sizeDecimal != null ? t.sizeDecimal : (t.size || 0);
  let b = bars.get(min);
  if (!b) { b = { o: px, h: px, l: px, c: px, v: 0, n: 0, firstSeq: t.sequence, lastSeq: t.sequence }; bars.set(min, b); }
  if (px > b.h) b.h = px;
  if (px < b.l) b.l = px;
  // c is the last by sequence; tape arrives roughly in order, take latest seq
  if (t.sequence == null || t.sequence >= b.lastSeq) { b.c = px; b.lastSeq = t.sequence; }
  b.v += sz;
  b.n++;
}

// Dedupe chart candles by t (re-subscribe can emit overlapping snapshots), keep latest.
const chart = new Map();
for (const c of candles) chart.set(c.t, c);

// Compare overlapping minutes.
const sortedMins = [...bars.keys()].sort((a, b) => a - b);
let compared = 0, closeMatches = 0, closeWithinTick = 0, highOk = 0, lowOk = 0;
const TICK = 0.25; // ES tick size
const mismatches = [];

for (const min of sortedMins) {
  const cc = chart.get(min);
  if (!cc) continue; // chart may not have that minute (different symbol coverage / forming)
  const tb = bars.get(min);
  compared++;
  const dClose = Math.abs(tb.c - cc.c);
  if (dClose === 0) closeMatches++;
  if (dClose <= TICK) closeWithinTick++;
  // Tape high/low should be within the chart bar's range (chart aggregates all venues,
  // tape is the single-venue print stream, so tape range ⊆ chart range expected).
  if (tb.h <= cc.h + TICK) highOk++;
  if (tb.l >= cc.l - TICK) lowOk++;
  if (dClose > TICK) {
    mismatches.push({ min: new Date(min).toISOString(), tapeClose: tb.c, chartClose: cc.c, d: dClose, prints: tb.n });
  }
}

console.log(`=== OHLC validation for ${day} ===`);
console.log(`tape prints: ${tape.length}  reconstructed minutes: ${bars.size}  chart MIN1 bars: ${chart.size}`);
console.log(`overlapping minutes compared: ${compared}`);
if (compared > 0) {
  console.log(`close exact match:     ${closeMatches}/${compared}  (${(100 * closeMatches / compared).toFixed(1)}%)`);
  console.log(`close within 1 tick:   ${closeWithinTick}/${compared}  (${(100 * closeWithinTick / compared).toFixed(1)}%)`);
  console.log(`tape high <= chart high: ${highOk}/${compared}  (${(100 * highOk / compared).toFixed(1)}%)`);
  console.log(`tape low  >= chart low:  ${lowOk}/${compared}  (${(100 * lowOk / compared).toFixed(1)}%)`);
}
if (mismatches.length) {
  console.log(`\nclose mismatches > 1 tick (first 10):`);
  for (const m of mismatches.slice(0, 10)) {
    console.log(`  ${m.min}  tape=${m.tapeClose} chart=${m.chartClose} Δ=${m.d} prints=${m.prints}`);
  }
}
