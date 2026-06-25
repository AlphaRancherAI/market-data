// CDP connection manager — attaches to the thinkorswim tab's DevTools target, enables
// the Network domain, and surfaces websocket frames via a callback. Auto-reconnects if
// the CDP socket drops or the tab navigates. Passive only: never sends app frames.
const WebSocket = require('ws');
const http = require('http');

const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = process.env.CDP_PORT || '19222';

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// onEvent(ev) where ev = { ev:'created'|'sent'|'recv', url, opcode, len, payload, requestId, ts }
async function attach(onEvent, opts = {}) {
  const matchUrl = opts.matchUrl || 'thinkorswim';
  const targets = await getTargets();
  const tab = targets.find((t) => t.type === 'page' && t.url.includes(matchUrl));
  if (!tab) throw new Error(`No tab matching "${matchUrl}" found`);

  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 1;
  const wsMeta = {};

  ws.on('open', () => {
    ws.send(JSON.stringify({ id: id++, method: 'Network.enable' }));
    if (opts.onAttach) opts.onAttach(tab.url);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const m = msg.method;
    const p = msg.params || {};
    const ts = Date.now();
    if (m === 'Network.webSocketCreated') {
      wsMeta[p.requestId] = p.url;
      onEvent({ ev: 'created', url: p.url, requestId: p.requestId, ts });
    } else if (m === 'Network.webSocketFrameReceived') {
      const pl = p.response?.payloadData || '';
      onEvent({ ev: 'recv', url: wsMeta[p.requestId], opcode: p.response?.opcode, len: pl.length, payload: pl, requestId: p.requestId, ts });
    } else if (m === 'Network.webSocketFrameSent') {
      const pl = p.response?.payloadData || '';
      onEvent({ ev: 'sent', url: wsMeta[p.requestId], opcode: p.response?.opcode, len: pl.length, payload: pl, requestId: p.requestId, ts });
    }
  });

  return ws;
}

// attachAll(onEvent, opts) — attach to EVERY thinkorswim page target and keep watching
// for new ones (so opening a tab per instrument is captured automatically). Each frame
// is tagged with the originating target id/url via the event the caller already receives
// (ev.requestId is per-socket; ev.url is the ws url). Returns a controller with stop().
function attachOne(target, onEvent, opts) {
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 1;
  const wsMeta = {};
  ws.on('open', () => {
    ws.send(JSON.stringify({ id: id++, method: 'Network.enable' }));
    if (opts.onAttach) opts.onAttach(target.url, target.id);
  });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const m = msg.method;
    const p = msg.params || {};
    const ts = Date.now();
    if (m === 'Network.webSocketCreated') {
      wsMeta[p.requestId] = p.url;
      onEvent({ ev: 'created', url: p.url, requestId: p.requestId, targetId: target.id, ts });
    } else if (m === 'Network.webSocketFrameReceived') {
      const pl = p.response?.payloadData || '';
      onEvent({ ev: 'recv', url: wsMeta[p.requestId], opcode: p.response?.opcode, len: pl.length, payload: pl, requestId: p.requestId, targetId: target.id, ts });
    } else if (m === 'Network.webSocketFrameSent') {
      const pl = p.response?.payloadData || '';
      onEvent({ ev: 'sent', url: wsMeta[p.requestId], opcode: p.response?.opcode, len: pl.length, payload: pl, requestId: p.requestId, targetId: target.id, ts });
    }
  });
  return ws;
}

async function attachAll(onEvent, opts = {}) {
  const matchUrl = opts.matchUrl || 'thinkorswim';
  const pollMs = opts.pollMs || 5000;
  const attached = new Map(); // targetId -> ws
  let stopped = false;

  async function sync() {
    if (stopped) return;
    let targets;
    try { targets = await getTargets(); } catch (e) {
      if (opts.onError) opts.onError(e);
      return;
    }
    const tos = targets.filter((t) => t.type === 'page' && (t.url || '').includes(matchUrl));
    const liveIds = new Set(tos.map((t) => t.id));
    // attach new
    for (const t of tos) {
      if (attached.has(t.id)) continue;
      const ws = attachOne(t, onEvent, opts);
      attached.set(t.id, ws);
      ws.on('close', () => { attached.delete(t.id); });
      ws.on('error', (e) => { if (opts.onError) opts.onError(e); });
    }
    // drop closed
    for (const [tid, ws] of attached) {
      if (!liveIds.has(tid)) { try { ws.close(); } catch {} attached.delete(tid); }
    }
  }

  await sync();
  const timer = setInterval(sync, pollMs);
  return {
    stop() { stopped = true; clearInterval(timer); for (const ws of attached.values()) { try { ws.close(); } catch {} } },
    count() { return attached.size; },
  };
}

module.exports = { attach, attachAll, getTargets };
