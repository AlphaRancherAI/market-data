// runner.js — supervisor for the market-data scraper. Designed to run under launchd
// with KeepAlive (launchd restarts the runner; the runner restarts its children).
//
// Responsibilities:
//   1. Keep the passive capture daemon (src/daemon.js) alive (respawn on exit).
//   2. During CME futures hours, periodically run the UI driver (src/ui-driver.js) for
//      each configured symbol to (re)establish organic subscriptions (quotes, MIN1 chart,
//      tape, option chain). Subscriptions/tokens drift, so we refresh on an interval.
//   3. Outside futures hours, idle (daemon stays up but nothing new is driven).
//   4. Check login status before driving; if logged out, attempt auto-login.
//
// Env:
//   SYMBOLS         comma list, default "/ES:XCME,/NQ:XCME"
//   DRIVE_INTERVAL  ms between ui-driver refresh cycles, default 900000 (15 min)
//   FORCE_OPEN      "1" to ignore the market-hours gate (testing)
const path = require('path');
const { spawn } = require('child_process');
const { isFuturesOpen } = require('./market-hours');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const SYMBOLS = (process.env.SYMBOLS || '/ES:XCME').split(',').map((s) => s.trim()).filter(Boolean);
const DRIVE_INTERVAL = parseInt(process.env.DRIVE_INTERVAL || '900000', 10);
const FORCE_OPEN = process.env.FORCE_OPEN === '1';

const log = (...a) => console.error(`[runner ${new Date().toISOString()}]`, ...a);

// --- 1. Keep the daemon alive -------------------------------------------------
let daemon = null;
let stopping = false;

function startDaemon() {
  if (stopping) return;
  log('starting daemon');
  daemon = spawn(NODE, [path.join(ROOT, 'src', 'daemon.js')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  });
  daemon.on('exit', (code, sig) => {
    daemon = null;
    if (stopping) return;
    log(`daemon exited (code=${code} sig=${sig}), restarting in 3s`);
    setTimeout(startDaemon, 3000);
  });
}

// --- 2. Check login and auto-login if needed ------------------------------------
async function ensureLoggedIn() {
  try {
    const p = spawn(NODE, [path.join(ROOT, 'src', 'auto-login.js')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    return new Promise((resolve) => {
      let stdout = '';
      p.stdout.on('data', (d) => { stdout += d.toString(); });
      p.on('exit', (code) => {
        try {
          const result = JSON.parse(stdout);
          if (code === 0) {
            log(`login successful in ${result.loginTime}ms`);
            resolve(true);
          } else if (result.reason === 'already_authed') {
            log('already logged in');
            resolve(true);
          } else {
            log(`auto-login failed: ${result.reason || 'unknown'}`);
            resolve(false);
          }
        } catch (e) {
          log(`auto-login output parse error: ${e.message}`);
          resolve(false);
        }
      });
    });
  } catch (e) {
    log(`auto-login error: ${e.message}`);
    return false;
  }
}

// --- 3. Drive the UI on an interval, only while the market is open ------------
let driving = false;

function runUiDriver(symbol) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [path.join(ROOT, 'src', 'ui-driver.js'), symbol], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });
    p.on('exit', (code) => resolve(code));
    // hard cap so a hung driver never blocks the cycle
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 120000);
  });
}

async function driveCycle() {
  if (driving) return;
  if (!FORCE_OPEN && !isFuturesOpen()) { log('market closed, skipping drive cycle'); return; }
  driving = true;
  try {
    // Check login before driving
    const loggedIn = await ensureLoggedIn();
    if (!loggedIn) {
      log('not logged in and auto-login failed, skipping drive cycle');
      return;
    }

    for (const sym of SYMBOLS) {
      log(`driving ${sym}`);
      const code = await runUiDriver(sym);
      log(`ui-driver ${sym} exited code=${code}`);
    }
  } finally {
    driving = false;
  }
}

// --- lifecycle ----------------------------------------------------------------
function shutdown() {
  stopping = true;
  log('shutting down');
  try { if (daemon) daemon.kill('SIGINT'); } catch {}
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log(`runner up. symbols=${SYMBOLS.join(',')} driveInterval=${DRIVE_INTERVAL}ms forceOpen=${FORCE_OPEN}`);
startDaemon();
// give the daemon a few seconds to attach before first drive
setTimeout(driveCycle, 5000);
setInterval(driveCycle, DRIVE_INTERVAL);
