// CDP websocket frame capture for thinkorswim web
// Connects to the ToS tab, enables Network, logs WS creation + frames.
const WebSocket = require('/Users/henry/workspace/jarvis/node_modules/ws');
const http = require('http');
const fs = require('fs');

const OUT = '/tmp/tos-frames.jsonl';
const DURATION_MS = parseInt(process.argv[2] || '20000', 10);

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:19222/json', (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getTargets();
  const tab = targets.find((t) => t.type === 'page' && t.url.includes('thinkorswim'));
  if (!tab) { console.error('No thinkorswim tab found'); process.exit(1); }
  console.error('Attaching to:', tab.url);

  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  const out = fs.createWriteStream(OUT, { flags: 'w' });
  let id = 1;
  const wsMeta = {}; // requestId -> url

  const stats = { created: 0, recv: 0, sent: 0, recvBytes: 0, sentBytes: 0 };

  ws.on('open', () => {
    ws.send(JSON.stringify({ id: id++, method: 'Network.enable' }));
    console.error('Network.enable sent. Capturing for', DURATION_MS, 'ms...');
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const m = msg.method;
    const p = msg.params || {};
    if (m === 'Network.webSocketCreated') {
      stats.created++;
      wsMeta[p.requestId] = p.url;
      console.error('[WS CREATED]', p.url);
      out.write(JSON.stringify({ ev: 'created', url: p.url, requestId: p.requestId }) + '\n');
    } else if (m === 'Network.webSocketFrameReceived') {
      stats.recv++;
      const pl = p.response?.payloadData || '';
      stats.recvBytes += pl.length;
      out.write(JSON.stringify({ ev: 'recv', url: wsMeta[p.requestId], opcode: p.response?.opcode, len: pl.length, payload: pl }) + '\n');
    } else if (m === 'Network.webSocketFrameSent') {
      stats.sent++;
      const pl = p.response?.payloadData || '';
      stats.sentBytes += pl.length;
      out.write(JSON.stringify({ ev: 'sent', url: wsMeta[p.requestId], opcode: p.response?.opcode, len: pl.length, payload: pl }) + '\n');
    }
  });

  ws.on('error', (e) => console.error('CDP ws error:', e.message));

  setTimeout(() => {
    out.end();
    console.error('DONE. stats:', JSON.stringify(stats));
    ws.close();
    process.exit(0);
  }, DURATION_MS);
})();
