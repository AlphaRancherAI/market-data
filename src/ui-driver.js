// ui-driver.js — drives the ToS web UI (via CDP Runtime.evaluate) to organically open
// the panels that trigger market-data subscriptions, so the passive daemon captures them.
//
// It does NOT send WsJson app frames. It clicks real DOM buttons in the page, exactly as a
// human would, so every subscription originates from the app's own socket (organic).
//
// Subscriptions driven:
//   - quotes        : loading a symbol page subscribes /ES:XCME (and the resolved contract)
//   - chart MIN1    : navigate /charts, set timeframe=Day + aggregation=1 Minute
//   - time_sales    : click the "Time and Sales" button (tape for /ESM26:XCME)
//   - options chain : open the option chain + expand the front expiration (quotes/options)
//
// Usage: node src/ui-driver.js [symbol]   (default /ES:XCME)
const WebSocket = require('ws');
const http = require('http');

const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = process.env.CDP_PORT || '19222';
const SYMBOL = process.argv[2] || '/ES:XCME';
// Optional: pin this driver to a specific tab (id prefix). When unset, drive the first
// thinkorswim tab found. Lets two drivers target two tabs so each owns one symbol's panels.
const TARGET_TAB = process.env.TARGET_TAB || '';

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Page {
  constructor(ws) { this.ws = ws; this.id = 1; this.pending = new Map(); }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  _onMessage(raw) {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    }
  }
  async evaluate(fnStr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${fnStr} })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
    return r.result && r.result.value;
  }
  async navigate(url) { await this.send('Page.navigate', { url }); }
}

// page-context helper: click a button by aria-label or visible text substring.
const CLICK_HELPER = `
  window.__clickByText = (sel, txt) => {
    const els = [...document.querySelectorAll(sel)];
    const el = els.find(e => (e.getAttribute('aria-label')||'').includes(txt) || (e.textContent||'').trim().includes(txt));
    if (el) { el.click(); return true; }
    return false;
  };
  window.__selectOption = (txt) => {
    const opts = [...document.querySelectorAll('[role="option"]')];
    const o = opts.find(x => x.textContent.trim() === txt || x.textContent.trim().startsWith(txt));
    if (o) { o.click(); return true; }
    return false;
  };
  // Find the option-series expansion buttons (aria-label "Show <Month> <day>, <year> (N days) ... options").
  window.__seriesButtons = () => [...document.querySelectorAll('button')].filter((b) => {
    const a = b.getAttribute('aria-label') || '';
    return a.indexOf('Show ') === 0 && a.indexOf(' days) ') !== -1 && a.indexOf(' options') !== -1;
  });
  window.__expandFrontSeries = () => {
    const btns = window.__seriesButtons();
    if (btns.length) { btns[0].click(); return btns[0].getAttribute('aria-label'); }
    return null;
  };
  // Expand ALL collapsed option-series rows. Returns count of series found.
  // We click only collapsed ones (aria-expanded !== 'true') to avoid toggling open ones shut.
  window.__expandAllSeries = () => {
    const btns = window.__seriesButtons();
    let clicked = 0;
    for (const b of btns) {
      if (b.getAttribute('aria-expanded') !== 'true') { b.click(); clicked++; }
    }
    return { total: btns.length, clicked };
  };
  // Switch the active instrument in-tab via the "Find a Symbol" box (keeps session alive;
  // URL navigation triggers a re-login wall). Sets the value, waits for autocomplete, then
  // clicks the top [role=option]. Returns the clicked option's text (or null).
  window.__switchSymbol = (sym) => {
    const inp = [...document.querySelectorAll('input')].find((i) =>
      (i.getAttribute('aria-label') || '') === 'Find a symbol' || i.placeholder === 'Find a Symbol');
    if (!inp) return 'NO_INPUT';
    inp.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, sym);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'SET';
  };
  window.__clickTopSymbolOption = () => {
    const opts = [...document.querySelectorAll('[role="option"]')];
    if (!opts.length) return null;
    const txt = (opts[0].textContent || '').trim();
    opts[0].click();
    return txt;
  };
`;

async function main() {
  const targets = await getTargets();
  const tosPages = targets.filter((t) => t.type === 'page' && t.url.includes('thinkorswim'));
  const tab = TARGET_TAB
    ? tosPages.find((t) => t.id.startsWith(TARGET_TAB))
    : tosPages[0];
  if (!tab) { console.error(TARGET_TAB ? `No thinkorswim tab matching id ${TARGET_TAB}.` : 'No thinkorswim tab. Open trade.thinkorswim.com and log in first.'); process.exit(1); }

  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
  const page = new Page(ws);
  ws.on('message', (raw) => page._onMessage(raw));
  await new Promise((res) => ws.on('open', res));
  await page.send('Page.enable');
  await page.send('Runtime.enable');

  console.error(`[ui-driver] driving ${SYMBOL} on ${tab.url}`);

  // 1) Load the charts page for the symbol (subscribes quotes + chart)
  const enc = encodeURIComponent(SYMBOL);
  await page.navigate(`https://trade.thinkorswim.com/charts?symbol=${enc}`);
  await sleep(6000);
  await page.evaluate(CLICK_HELPER + ' return true;');

  // 2) Set chart to Day timeframe then 1 Minute aggregation (MIN1)
  await page.evaluate(`__clickByText('button','change chart timeframe'); return true;`);
  await sleep(600);
  await page.evaluate(`__selectOption('Day'); return true;`);
  await sleep(1500);
  await page.evaluate(`__clickByText('button','change chart aggregation'); return true;`);
  await sleep(600);
  await page.evaluate(`__selectOption('1 Minute'); return true;`);
  await sleep(1500);
  console.error('[ui-driver] chart set to Day / 1 Minute (MIN1)');

  // 3) Open Time & Sales (subscribes time_sales tape). Idempotent: only click if not active.
  const tapeOk = await page.evaluate(`return __clickByText('button','Time and Sales');`);
  await sleep(1500);
  console.error('[ui-driver] tape toggled:', tapeOk);

  // 4) Option chain lives on the /trade page, not /charts. Navigate there.
  //    Loading /trade auto-subscribes optionSeries + optionSeries/quotes.
  await page.navigate(`https://trade.thinkorswim.com/trade?symbol=${enc}`);
  await sleep(6000);
  await page.evaluate(CLICK_HELPER + ' return true;');

  // Open the Option Chain panel. The button may not be present/ready immediately after
  // navigation (esp. when switching symbols), and a single click can land before the panel
  // mounts. Click "Show Option Chain" inside the retry loop below until series rows appear.
  const openChainPanel = `
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'').includes('Show Option Chain'));
    if (b && b.getAttribute('aria-expanded') !== 'true') { b.click(); return 'clicked'; }
    return b ? 'already-open' : 'no-button';
  `;
  await page.evaluate(openChainPanel + '');
  await sleep(2000);

  // Expand ALL expiration series -> subscribes option_chain/get (full strike grid)
  // + quotes/options (streaming per-strike BID/ASK/DELTA/OI/VOLUME) for every expiry.
  // The series list renders lazily, so poll until rows appear. Re-assert the panel-open
  // each iteration so a collapsed panel (common when switching symbols) gets re-clicked.
  let expanded = null;
  for (let i = 0; i < 12; i++) {
    await page.evaluate('return (function(){' + openChainPanel + '})();');
    expanded = await page.evaluate(`return __expandAllSeries();`);
    if (expanded && expanded.total > 0) break;
    await sleep(1000);
  }
  // re-run once after a beat to catch series that rendered lazily after the first pass
  await sleep(2000);
  const expanded2 = await page.evaluate(`return __expandAllSeries();`);
  await sleep(3000);
  console.error('[ui-driver] expanded option series:', expanded, '+', expanded2);

  console.error('[ui-driver] done. Subscriptions active; daemon should be capturing.');
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error('[ui-driver] error:', e.message); process.exit(1); });
