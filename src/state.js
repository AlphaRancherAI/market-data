// StateReconstructor — applies WsJson snapshot + RFC-6902 JSON Patch deltas to maintain
// live per-(service,id) state, and emits normalized curated events via callbacks.
//
// The ToS gateway sends, per subscription id:
//   type:"snapshot" -> full body (the base tree)
//   type:"patch"    -> body.patches = [{op,path,value}] applied against that base
//
// We keep the base tree per id and mutate it in place on each patch, then surface
// normalized events: quote, tape, candle (closed + forming).

function applyPatch(root, op) {
  // Minimal RFC-6902 subset observed on the wire: replace, add, remove.
  // path like "/candles/closes/51" or "/items" or "" (whole-doc replace).
  if (op.path === '' || op.path == null) {
    return op.value; // whole-document replace
  }
  const parts = op.path.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (node == null) return root;
    node = Array.isArray(node) ? node[parseInt(key, 10)] : node[key];
  }
  const last = parts[parts.length - 1];
  if (node == null) return root;
  if (Array.isArray(node)) {
    const idx = last === '-' ? node.length : parseInt(last, 10);
    if (op.op === 'remove') node.splice(idx, 1);
    else if (op.op === 'add') node.splice(idx, 0, op.value);
    else node[idx] = op.value; // replace
  } else {
    if (op.op === 'remove') delete node[last];
    else node[last] = op.value; // add or replace
  }
  return root;
}

class StateReconstructor {
  constructor(handlers = {}) {
    // handlers: { onQuote(symbol, values, ts), onTape(print), onCandle(bar, {closed}), onRaw(svc,id,type,body) }
    this.h = handlers;
    this.state = new Map(); // key `${service}::${id}` -> base tree
    // chart: track last-known forming bar index per id so we can tell closed vs forming
    this.chartForming = new Map(); // id -> last index
  }

  _key(svc, id, ns) { return ns ? `${ns}::${svc}::${id}` : `${svc}::${id}`; }

  ingest(frame, ns) {
    // frame: parsed { payload:[ {header:{service,id,type}, body} ] }
    // ns: optional per-socket namespace so identical service ids across tabs don't collide
    if (!frame || !Array.isArray(frame.payload)) return;
    for (const p of frame.payload) {
      const hdr = p.header || {};
      const svc = hdr.service;
      const id = hdr.id;
      const type = hdr.type;
      if (!svc) continue;
      const key = this._key(svc, id, ns);

      if (type === 'snapshot') {
        this.state.set(key, p.body);
      } else if (type === 'patch') {
        let base = this.state.get(key);
        if (base === undefined) base = {};
        for (const op of (p.body?.patches || [])) {
          base = applyPatch(base, op);
        }
        this.state.set(key, base);
      } else {
        // non-stateful service responses (instrument_search, etc.)
        if (this.h.onRaw) this.h.onRaw(svc, id, type, p.body);
        continue;
      }

      this._emit(svc, key, type, this.state.get(key));
      if (this.h.onRaw) this.h.onRaw(svc, id, type, p.body);
    }
  }

  _emit(svc, id, type, body) {
    if (!body) return;
    if (svc === 'quotes' || svc === 'quotes/options') {
      const items = body.items || [];
      const isOpt = svc === 'quotes/options';
      for (const it of items) {
        if (it && it.symbol && it.values && this.h.onQuote) {
          this.h.onQuote(it.symbol, it.values, Date.now(), isOpt);
        }
      }
    } else if (svc === 'option_chain/get') {
      // Static reference: strike grid -> call/put contract symbols per series.
      if (type === 'snapshot' && this.h.onChain) {
        for (const ser of (body.optionSeries || [])) {
          if (!ser) continue; // patched arrays can carry null holes
          this.h.onChain({
            underlying: body.underlyingSymbol,
            expiration: ser.expiration,
            expirationString: ser.expirationString,
            pairs: ser.optionPairs || [],
          });
        }
      }
    } else if (svc === 'time_sales') {
      const arr = body.timeSales || [];
      if (this.h.onTape) {
        for (const t of arr) this.h.onTape(t);
      }
    } else if (svc === 'chart') {
      const c = body.candles;
      if (!c || !c.timestamps) return;
      const n = c.timestamps.length;
      if (n === 0) return;
      const lastIdx = n - 1;
      const mkBar = (i) => ({
        symbol: body.symbol,
        t: c.timestamps[i],
        o: c.opens?.[i], h: c.highs?.[i], l: c.lows?.[i],
        c: c.closes?.[i], v: c.volumes?.[i],
      });
      if (type === 'snapshot') {
        // emit all closed bars (everything except the forming last bar)
        if (this.h.onCandle) {
          for (let i = 0; i < lastIdx; i++) this.h.onCandle(mkBar(i), { closed: true });
          this.h.onCandle(mkBar(lastIdx), { closed: false });
        }
        this.chartForming.set(id, lastIdx);
      } else {
        // patch: detect bar rollover (new index appeared)
        const prev = this.chartForming.get(id);
        if (prev != null && lastIdx > prev && this.h.onCandle) {
          // the previously-forming bar(s) are now closed
          for (let i = prev; i < lastIdx; i++) this.h.onCandle(mkBar(i), { closed: true });
        }
        this.chartForming.set(id, lastIdx);
        if (this.h.onCandle) this.h.onCandle(mkBar(lastIdx), { closed: false });
      }
    }
  }
}

module.exports = { StateReconstructor, applyPatch };
