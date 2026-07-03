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
const { spawn } = require('child_process');
const { isFuturesOpen } = require('./market-hours');

const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = process.env.CDP_PORT || '19222';
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

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
const BROWSER_ALERT_FLAG = process.env.BROWSER_ALERT_FLAG || path.join(os.tmpdir(), 'market-data-browser-alert.json');
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

function lastBrowserAlertAt() {
  try { return JSON.parse(fs.readFileSync(BROWSER_ALERT_FLAG, 'utf8')).at || 0; } catch { return 0; }
}
function markBrowserAlerted() {
  try { fs.writeFileSync(BROWSER_ALERT_FLAG, JSON.stringify({ at: Date.now() })); } catch {}
}
function clearBrowserAlerted() {
  try { fs.unlinkSync(BROWSER_ALERT_FLAG); } catch {}
}

// Debounce: a real logout persists across many polls; a tab mid-navigation (our own
// re-drive, or any page transition) can momentarily look login-ish for a single poll
// and then read AUTHED again on the next tick. Require LOGGED_OUT to hold across
// CONSECUTIVE_LOGOUTS polls before alerting, so one-tick blips never page the user.
const CONSECUTIVE_LOGOUTS = parseInt(process.env.LOGIN_CONSECUTIVE || '3', 10);
let _consecutiveLoggedOut = 0;

async function alertIfLoggedOut() {
  const { status, detail } = await checkLogin();
  if (status === 'LOGGED_OUT') {
    _consecutiveLoggedOut += 1;
    // Only alert once the logout has held across enough consecutive polls.
    if (_consecutiveLoggedOut >= CONSECUTIVE_LOGOUTS) {
      const since = Date.now() - lastAlertAt();
      if (since >= ALERT_COOLDOWN_MS) {
        const ok = await sendTelegram(
          'thinkorswim is logged out — market-data capture is paused.\n'
          + 'Re-auth in Chrome Canary (one click, your saved password autofills) and capture resumes automatically.',
        );
        if (ok) markAlerted();
      }
    }
  } else {
    // Any non-logged-out reading (AUTHED or NO_TAB) breaks the streak.
    _consecutiveLoggedOut = 0;
    if (status === 'AUTHED') {
      // back in: reset the throttle so the next genuine logout alerts immediately
      if (lastAlertAt()) clearAlerted();
    }
  }
  return status;
}

// --- Stall watchdog ----------------------------------------------------------
// Separate failure mode from logout: the session is AUTHED but the daemon stopped
// receiving data (subscriptions went stale after a re-login, or the socket wedged).
// We detect it by watching the curated capture files; if they stop growing while
// authed + during market hours, we re-drive the UI to re-establish subscriptions.
// This recovers from a stall on its own. It does NOT log in (that stays manual).
const CURATED_DIR = process.env.CURATED_DIR || path.join(ROOT, 'data', 'curated');
const STALL_THRESHOLD_MS = parseInt(process.env.STALL_THRESHOLD || '90000', 10); // 90s
const REDRIVE_COOLDOWN_MS = parseInt(process.env.REDRIVE_COOLDOWN || '180000', 10); // 3 min
const REDRIVE_SYMBOL = process.env.STALL_DRIVE_SYMBOL || (process.env.SYMBOLS || '/ES:XCME').split(',')[0].trim();

function ymd(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}${p.month}${p.day}`;
}

// Total bytes of today's primary capture streams (tape + quotes). Growth => data flowing.
function captureBytes() {
  let total = 0;
  const day = ymd();
  for (const stream of ['tape', 'quotes', 'option_quotes']) {
    try { total += fs.statSync(path.join(CURATED_DIR, `${stream}-${day}.jsonl`)).size; } catch {}
  }
  return total;
}

let _lastBytes = null;
let _lastGrowAt = Date.now();
// Start "long ago" so the first detected stall can recover immediately (don't let the
// cooldown gate the very first re-drive).
let _lastRedriveAt = Date.now() - REDRIVE_COOLDOWN_MS;

function reDrive() {
  console.error(`[login-watch ${new Date().toISOString()}] STALL detected — re-driving ${REDRIVE_SYMBOL}`);
  const p = spawn(NODE, [path.join(ROOT, 'src', 'ui-driver.js'), REDRIVE_SYMBOL], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, FORCE_OPEN: '1' },
  });
  // hard cap so a hung driver never lingers
  const cap = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 120000);
  p.on('exit', (code) => { clearTimeout(cap); console.error(`[login-watch] re-drive exited code=${code}`); });
}

// Returns true if it took a recovery action this tick.
function checkStall(status) {
  // Only meaningful when authed and the market is open.
  if (status !== 'AUTHED' || !isFuturesOpen()) {
    _lastBytes = null; // reset baseline so we don't count a closed-market gap as a stall
    return false;
  }
  const bytes = captureBytes();
  if (_lastBytes === null) { _lastBytes = bytes; _lastGrowAt = Date.now(); return false; }
  if (bytes > _lastBytes) { _lastBytes = bytes; _lastGrowAt = Date.now(); return false; }

  // No growth since _lastGrowAt.
  const stalledFor = Date.now() - _lastGrowAt;
  if (stalledFor >= STALL_THRESHOLD_MS && (Date.now() - _lastRedriveAt) >= REDRIVE_COOLDOWN_MS) {
    _lastRedriveAt = Date.now();
    _lastGrowAt = Date.now(); // give the re-drive time to take effect before re-triggering
    reDrive();
    return true;
  }
  return false;
}

// Long-running loop: poll on an interval, alert on logout, recover from stalls. Used by launchd.
const POLL_INTERVAL_MS = parseInt(process.env.LOGIN_POLL_INTERVAL || '30000', 10); // 30s

async function loop() {
  console.error(`[login-watch] up. poll=${POLL_INTERVAL_MS}ms loginCooldown=${ALERT_COOLDOWN_MS}ms stall=${STALL_THRESHOLD_MS}ms redriveCooldown=${REDRIVE_COOLDOWN_MS}ms`);
  let last = null;
  for (;;) {
    let status;
    try { status = await alertIfLoggedOut(); }
    catch (e) { status = 'ERROR'; console.error('[login-watch] check error:', e.message); }
    if (status !== last) {
      console.error(`[login-watch ${new Date().toISOString()}] ${status}`);
      last = status;
    }

    // Alert if browser is unreachable (crashed/closed) — separate from logout alert
    if (status === 'NO_TAB') {
      const since = Date.now() - lastBrowserAlertAt();
      if (since >= ALERT_COOLDOWN_MS) {
        const ok = await sendTelegram(
          '⚠️ Chrome Canary is unreachable (CDP port 19222 down) — market-data capture is stopped.\n'
          + 'Auto-login will attempt to restart Chrome automatically. Check if the machine is responsive.',
        );
        if (ok) markBrowserAlerted();
      }
    } else {
      if (lastBrowserAlertAt()) clearBrowserAlerted();
    }

    try { checkStall(status); }
    catch (e) { console.error('[login-watch] stall check error:', e.message); }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

module.exports = { checkLogin, alertIfLoggedOut, sendTelegram, loop, captureBytes, checkStall };

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
