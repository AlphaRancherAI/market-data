// login-watch.js — detect when the ToS web tab has been logged out, and alert on Telegram.
//
// This is a MONITORING + ALERTING helper. It does NOT log in, fill credentials, or drive
// any auth flow. When it sees the ToS login wall it (a) reports loggedOut=true so the runner
// can skip pointless drive cycles, and (b) sends a Telegram nudge so Henry can re-auth in
// Canary himself (one click; Chrome autofills the saved password). Capture resumes
// automatically once he's back in.
//
// Usage (standalone check): node src/login-watch.js
//   prints "AUTHED" or "LOGGED_OUT" and (when logged out) sends one Telegram alert.

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = process.env.CDP_PORT || '19222';

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// --- Telegram (mirrors the schwab circuit_breaker pattern) -------------------
function telegramCreds() {
  let token = process.env.TELEGRAM_BOT_TOKEN;
  let chat = process.env.TELEGRAM_CHAT_ID;
  if (token && chat) return { token, chat };
  const cfgPath = process.env.JARVIS_CONFIG || path.join(os.homedir(), '.jarvis', 'config.json');
  try {
    const d = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const tg = (d.channels && d.channels.telegram) || {};
    token = token || tg.botToken;
    const allow = tg.allowFrom || [];
    chat = chat || (allow.length ? allow[0] : null);
  } catch { /* no config */ }
  return { token, chat };
}

function sendTelegram(text) {
  const { token, chat } = telegramCreds();
  if (!token || !chat) {
    console.error(`[login-watch] notify skipped (no telegram creds): ${text}`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: String(chat), text });
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode === 200)); },
    );
    req.on('error', (e) => { console.error('[login-watch] telegram failed:', e.message); resolve(false); });
    req.write(body); req.end();
  });
}

// page-context probe: is this the ToS login wall (not the authenticated app)?
// Heuristics, any of which means "logged out":
//   - a "Login ID"/"User ID" username field is present
//   - a password field is present AND a Log in / Continue control is present
//   - the document title / visible heading says Log in / Welcome (sign in)
const PROBE = `
  (function () {
    const lc = (s) => (s || '').toLowerCase();
    const title = lc(document.title);
    const bodyText = lc((document.body && document.body.innerText) || '').slice(0, 4000);

    const inputs = [...document.querySelectorAll('input')];
    const hasPassword = inputs.some((i) => i.type === 'password');
    const hasUserId = inputs.some((i) => {
      const hint = lc((i.getAttribute('aria-label') || '') + ' ' + (i.placeholder || '') + ' ' + (i.name || '') + ' ' + (i.id || ''));
      return hint.includes('login id') || hint.includes('user id') || hint.includes('username') || hint.includes('user name');
    });

    const btns = [...document.querySelectorAll('button, input[type=submit], a')];
    const hasLoginBtn = btns.some((b) => {
      const t = lc((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.value || ''));
      return t.trim() === 'log in' || t.trim() === 'login' || t.includes('log in') || t.includes('sign in');
    });

    // The title is the most reliable signal. The authed app titles itself
    // "Trade /ES[U26] | thinkorswim Web", "... Positions ...", etc. The logged-out page
    // titles itself "thinkorswim Web Login | Charles Schwab" (or "Sign in"). The actual
    // logout that bit us (Jun 23->24) had this title yet NO matched login button, because
    // the Schwab SSO form loads lazily / uses unmatched button text — so the old
    // "titleSaysLogin && hasLoginBtn" gate fell through to AUTHED. Treat the title as
    // authoritative now: "login"/"sign in" in the title => logged out, full stop.
    const titleSaysLogin = title.includes('log in') || title.includes('login') || title.includes('sign in');

    // Positive marker that we ARE in the app (used to suppress false positives only).
    const titleSaysApp = (title.includes('thinkorswim web') && !titleSaysLogin)
      || title.includes('trade /') || title.includes('positions') || title.includes('charts |');
    const appChrome = !!document.querySelector('[class*="account" i], [aria-label*="chart" i], [class*="position" i], [aria-label*="Find a symbol" i], #navigation-symbol-search')
      && !hasPassword;
    const looksLikeApp = titleSaysApp || appChrome;

    let loggedOut = false;
    if (titleSaysLogin) loggedOut = true;            // title is authoritative
    else if (hasUserId) loggedOut = true;            // Login ID / User ID field present
    else if (hasPassword && hasLoginBtn) loggedOut = true;

    // Never flag the authed app. (titleSaysApp can't co-occur with titleSaysLogin.)
    if (looksLikeApp) loggedOut = false;

    return { loggedOut, hasPassword, hasUserId, hasLoginBtn, titleSaysLogin, titleSaysApp, title: document.title, url: location.href };
  })()
`;

async function probeTab(tab) {
  return new Promise((resolve) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id; pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      }
    });
    const done = (val) => { try { ws.close(); } catch {} resolve(val); };
    const timer = setTimeout(() => done(null), 8000);
    ws.on('open', async () => {
      try {
        await send('Runtime.enable');
        const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
        clearTimeout(timer);
        done(r && r.result && r.result.value);
      } catch (e) { clearTimeout(timer); console.error('[login-watch] probe error:', e.message); done(null); }
    });
    ws.on('error', () => { clearTimeout(timer); done(null); });
  });
}

// Returns { status: 'AUTHED' | 'LOGGED_OUT' | 'NO_TAB', detail }
async function checkLogin() {
  let targets;
  try { targets = await getTargets(); }
  catch (e) { return { status: 'NO_TAB', detail: `CDP unreachable: ${e.message}` }; }

  const tosPages = targets.filter((t) => t.type === 'page' && (t.url || '').includes('thinkorswim'));
  if (!tosPages.length) return { status: 'NO_TAB', detail: 'no thinkorswim tab' };

  for (const tab of tosPages) {
    const r = await probeTab(tab);
    if (r && r.loggedOut) return { status: 'LOGGED_OUT', detail: r };
  }
  return { status: 'AUTHED', detail: { tabs: tosPages.length } };
}

// Throttled alert: writes a timestamp to a flag file so we don't re-spam every cycle.
const ALERT_FLAG = process.env.LOGIN_ALERT_FLAG || path.join(os.tmpdir(), 'market-data-login-alert.json');
const ALERT_COOLDOWN_MS = parseInt(process.env.LOGIN_ALERT_COOLDOWN || '1800000', 10); // 30 min

function lastAlertAt() {
  try { return JSON.parse(fs.readFileSync(ALERT_FLAG, 'utf8')).at || 0; } catch { return 0; }
}
function markAlerted() {
  try { fs.writeFileSync(ALERT_FLAG, JSON.stringify({ at: Date.now() })); } catch {}
}
function clearAlerted() {
  try { fs.unlinkSync(ALERT_FLAG); } catch {}
}

async function alertIfLoggedOut() {
  const { status, detail } = await checkLogin();
  if (status === 'LOGGED_OUT') {
    const since = Date.now() - lastAlertAt();
    if (since >= ALERT_COOLDOWN_MS) {
      const ok = await sendTelegram(
        'thinkorswim is logged out — market-data capture is paused.\n'
        + 'Re-auth in Chrome Canary (one click, your saved password autofills) and capture resumes automatically.',
      );
      if (ok) markAlerted();
    }
  } else if (status === 'AUTHED') {
    // back in: reset the throttle so the next logout alerts immediately
    if (lastAlertAt()) clearAlerted();
  }
  return status;
}

// Long-running loop: poll on an interval and alert on logout. Used by launchd.
const POLL_INTERVAL_MS = parseInt(process.env.LOGIN_POLL_INTERVAL || '120000', 10); // 2 min

async function loop() {
  console.error(`[login-watch] up. poll=${POLL_INTERVAL_MS}ms cooldown=${ALERT_COOLDOWN_MS}ms`);
  let last = null;
  for (;;) {
    let status;
    try { status = await alertIfLoggedOut(); }
    catch (e) { status = 'ERROR'; console.error('[login-watch] check error:', e.message); }
    if (status !== last) {
      console.error(`[login-watch ${new Date().toISOString()}] ${status}`);
      last = status;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = { checkLogin, alertIfLoggedOut, sendTelegram, loop };

// CLI: `--loop` runs forever (launchd); otherwise a single check + exit.
if (require.main === module) {
  if (process.argv.includes('--loop')) {
    loop().catch((e) => { console.error('[login-watch] fatal:', e.message); process.exit(1); });
  } else {
    alertIfLoggedOut().then((status) => {
      console.log(status);
      process.exit(0);
    }).catch((e) => { console.error('[login-watch]', e.message); process.exit(1); });
  }
}
