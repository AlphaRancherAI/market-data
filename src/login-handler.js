// login-handler.js — automatically log in to thinkorswim using saved browser password.
//
// When clicked, the password field triggers Chrome's autofill dropdown. This handler:
//   1. Finds and clicks the password field (triggers autofill UI)
//   2. Waits briefly for the autofill dropdown to appear
//   3. Clicks the first (saved) password option
//   4. Waits for login to complete and app to load
//
// Usage:
//   node src/login-handler.js                 # single login attempt
//   node src/login-handler.js --loop [ms]     # retry until success (default 30s between attempts)
//
// Exit codes: 0 = success, 1 = already logged in, 2 = login failed, 3 = no tab

const WebSocket = require('ws');
const http = require('http');
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
}

// Check current auth state (same logic as login-watch.js)
const AUTH_CHECK = `
  (function () {
    const lc = (s) => (s || '').toLowerCase();
    const title = lc(document.title);
    const inputs = [...document.querySelectorAll('input')];
    const hasPassword = inputs.some((i) => i.type === 'password');
    const btns = [...document.querySelectorAll('button, input[type=submit], a')];
    const hasLoginBtn = btns.some((b) => {
      const t = lc((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.value || ''));
      return t.includes('log in') || t.includes('sign in');
    });
    const titleSaysLogin = title.includes('log in') || title.includes('login') || title.includes('sign in');
    const titleSaysApp = (title.includes('thinkorswim web') && !titleSaysLogin)
      || title.includes('trade /') || title.includes('positions') || title.includes('charts |');
    const appChrome = !!document.querySelector('[class*="account" i], [aria-label*="chart" i], [class*="position" i], [aria-label*="Find a symbol" i], #navigation-symbol-search')
      && !hasPassword;
    const isAuthed = (titleSaysApp || appChrome) && !titleSaysLogin;
    return { isAuthed, titleSaysLogin, hasPassword, hasLoginBtn, title };
  })()
`;

// Auto-login flow: multi-step login handling with iframe support
const AUTO_LOGIN = `
  (async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const lc = (s) => (s || '').toLowerCase();
    const title = lc(document.title);
    const titleSaysApp = (title.includes('thinkorswim web') && !title.includes('log in'))
      || title.includes('trade /') || title.includes('positions') || title.includes('charts |');
    if (titleSaysApp) return { success: false, reason: 'already_authed', title: document.title };

    try {
      // NOTE: due to CSP/CORS, we can't access contentDocument on Schwab iframe
      // Instead, we work with what's visible in the main document
      // Schwab likely has the password field rendered outside the iframe or in shadow DOM

      // For now, just try clicking any password field in the document
      // and handling the autofill dropdown
      let pwInput = document.querySelector('input[type="password"]');

      // If no password input visible yet, wait a moment for the page to render
      if (!pwInput) {
        for (let i = 0; i < 20; i++) {
          await sleep(300);
          pwInput = document.querySelector('input[type="password"]');
          if (pwInput) break;
        }
      }

      if (!pwInput) {
        return { success: false, reason: 'no_password_field_found', availableInputs: document.querySelectorAll('input').length };
      }

      let targetDoc = document;

      // If no password field, look for username/login ID field
      if (!pwInput) {
        const userInput = allInputs.find(i => {
          const hint = lc((i.getAttribute('aria-label') || '') + ' ' + (i.placeholder || '') + ' ' + (i.name || '') + ' ' + (i.id || ''));
          return hint.includes('login id') || hint.includes('user id') || hint.includes('username') || hint.includes('user name');
        });

        if (userInput && userInput.value) {
          // Username field is already filled; submit the form
          const submitBtn = [...targetDoc.querySelectorAll('button, input[type=submit]')].find(b => {
            const t = lc((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.value || ''));
            return t.includes('next') || t.includes('continue') || t.includes('submit') || t.includes('sign in');
          });
          if (submitBtn) {
            submitBtn.click();
            // Wait for password field to appear
            for (let i = 0; i < 30; i++) {
              await sleep(200);
              try {
                pwInput = targetDoc.querySelector('input[type="password"]');
              } catch (e) { pwInput = null; }
              if (pwInput) break;
            }
          }
        }
      }

      if (!pwInput) {
        const inputInfo = allInputs.map(i => ({ type: i.type, name: i.name, id: i.id }));
        return { success: false, reason: 'no_password_field', availableInputs: inputInfo, title, frameInputsFound: frameInputs.length };
      }

      // Click password field to trigger autofill dropdown
      pwInput.focus();
      pwInput.click();
      await sleep(500);

      // Wait for autofill dropdown option to appear (check both main doc and iframe)
      let option = null;
      for (let i = 0; i < 40; i++) {
        try {
          // Check main document first
          let opts = [...document.querySelectorAll('[role="option"]')];
          option = opts.find(o => o.offsetHeight > 0);
          if (option) break;

          // Check iframe if main doc has none
          try {
            const iframe = document.querySelector('iframe');
            if (iframe && iframe.contentDocument) {
              opts = [...iframe.contentDocument.querySelectorAll('[role="option"]')];
              option = opts.find(o => o.offsetHeight > 0);
              if (option) break;
            }
          } catch (e) {}
        } catch (e) {}

        await sleep(100);
      }

      if (!option) {
        // Fallback: try keyboard arrow to trigger autofill
        pwInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await sleep(500);
        let opts = [...document.querySelectorAll('[role="option"]')];
        option = opts.find(o => o.offsetHeight > 0);
      }

      if (!option) {
        return { success: false, reason: 'no_autofill_dropdown_after_waiting', pwFieldFound: true };
      }

      // Click the saved password option (triggers autofill)
      option.click();
      await sleep(800);

      // After clicking autofill, check if password field was filled and if we need to submit
      const pwFilled = pwInput.value && pwInput.value.length > 0;

      // Find and click the login button if the password wasn't auto-submitted
      if (pwFilled) {
        const btns = [...targetDoc.querySelectorAll('button, input[type=submit], a')];
        const loginBtn = btns.find(b => {
          const t = lc((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.value || ''));
          return t.includes('log in') || t.includes('sign in') || t.includes('submit');
        });
        if (loginBtn) {
          loginBtn.click();
          await sleep(500);
        }
      }

      // Wait for the page to load and auth to complete
      const maxWait = 20000;
      const startTime = Date.now();
      let finalTitle = document.title;

      while (Date.now() - startTime < maxWait) {
        await sleep(500);
        finalTitle = document.title;
        const currentTitleLc = finalTitle.toLowerCase();

        // Check if we're back at the authenticated app
        const isAppTitle = (currentTitleLc.includes('thinkorswim web') && !currentTitleLc.includes('log in'))
          || currentTitleLc.includes('trade /') || currentTitleLc.includes('positions') || currentTitleLc.includes('charts |');
        if (isAppTitle) {
          return { success: true, title: finalTitle, loginTime: Date.now() - startTime };
        }

        // Check for app chrome/UI elements
        const appChrome = !!document.querySelector('[aria-label*="chart" i], [class*="position" i], #navigation-symbol-search');
        if (appChrome) {
          return { success: true, title: finalTitle, loginTime: Date.now() - startTime };
        }
      }

      return { success: false, reason: 'timeout_waiting_for_auth', title: finalTitle, waited: maxWait };
    } catch (err) {
      return { success: false, reason: 'exception', error: String(err).slice(0, 100) };
    }
  })()
`;

async function probeTab(tab, action = 'check') {
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
    const timer = setTimeout(() => {
      console.error(`[login-handler] probe timeout after 25s`);
      done(null);
    }, 25000);
    ws.on('open', async () => {
      try {
        await send('Runtime.enable');
        const expression = action === 'login' ? AUTO_LOGIN : AUTH_CHECK;
        console.error(`[login-handler] evaluating ${action} expression`);
        const r = await send('Runtime.evaluate', { expression, returnByValue: true });
        clearTimeout(timer);
        console.error(`[login-handler] evaluate response:`, JSON.stringify(r).slice(0, 200));
        if (!r) {
          console.error('[login-handler] CDP response was null');
          done(null);
        } else if (r.exceptionDetails) {
          console.error('[login-handler] CDP exception:', r.exceptionDetails.text);
          done(null);
        } else {
          const result = r.result && r.result.value;
          console.error(`[login-handler] returning result:`, JSON.stringify(result).slice(0, 200));
          done(result);
        }
      } catch (e) { clearTimeout(timer); console.error('[login-handler] probe error:', e.message); done(null); }
    });
    ws.on('error', (err) => { clearTimeout(timer); console.error('[login-handler] ws error:', err.message); done(null); });
  });
}

async function checkAuth() {
  let targets;
  try { targets = await getTargets(); }
  catch (e) { return { status: 'NO_TAB', detail: e.message }; }

  const tosPages = targets.filter((t) => t.type === 'page' && (t.url || '').includes('thinkorswim'));
  if (!tosPages.length) return { status: 'NO_TAB', detail: 'no thinkorswim tab' };

  for (const tab of tosPages) {
    const r = await probeTab(tab);
    if (r && r.isAuthed) return { status: 'AUTHED', detail: r };
  }
  return { status: 'NEEDS_LOGIN', detail: { tabs: tosPages.length } };
}

async function attemptLogin() {
  let targets;
  try { targets = await getTargets(); }
  catch (e) { return { success: false, reason: 'cdp_unreachable', detail: e.message }; }

  const tosPages = targets.filter((t) => t.type === 'page' && (t.url || '').includes('thinkorswim'));
  if (!tosPages.length) return { success: false, reason: 'no_tab' };

  for (const tab of tosPages) {
    // Attempt login on this tab
    const loginResult = await probeTab(tab, 'login');
    console.error('[login-handler] probe result:', JSON.stringify(loginResult));
    if (loginResult) return loginResult;
  }
  return { success: false, reason: 'no_thinkorswim_tab' };
}

async function waitForLogin() {
  const log = (msg) => console.error(`[login-handler ${new Date().toISOString()}]`, msg);

  try {
    // First check if already authed
    log('checking auth status');
    const authCheck = await checkAuth();
    if (authCheck.status === 'AUTHED') {
      log('already authenticated');
      return { code: 1, status: 'AUTHED' };
    }
    if (authCheck.status === 'NO_TAB') {
      log('no thinkorswim tab found');
      return { code: 3, status: 'NO_TAB' };
    }

    // Logged out - wait for user to manually login
    // The user will see the saved password suggestion and click it to autofill
    log('waiting for manual login (Schwab autofill - just click the saved password)');
    const maxWait = 300000; // 5 minutes
    const pollInterval = 5000; // check every 5 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await sleep(pollInterval);

      const check = await checkAuth();
      if (check.status === 'AUTHED') {
        log(`login detected! waited ${Date.now() - startTime}ms`);
        return { code: 0, status: 'SUCCESS', waitTime: Date.now() - startTime };
      }
    }

    log(`timeout waiting for login after ${maxWait}ms`);
    return { code: 2, status: 'TIMEOUT', waited: maxWait };
  } catch (e) {
    console.error('[login-handler] fatal error:', e.message);
    return { code: 2, status: 'ERROR', detail: e.message };
  }
}

async function login() {
  return waitForLogin();
}

if (require.main === module) {
  const isLoop = process.argv.includes('--loop');
  const interval = parseInt(process.argv[process.argv.indexOf('--loop') + 1], 10) || 30000;

  async function run() {
    const result = await login();
    console.log(JSON.stringify(result));
    return result.code;
  }

  if (isLoop) {
    (async () => {
      let lastCode = 2; // Start as failed
      for (;;) {
        const result = await login();
        console.log(JSON.stringify(result));
        lastCode = result.code;
        if (lastCode === 0) break; // Success
        await sleep(interval);
      }
      process.exit(lastCode);
    })();
  } else {
    run().then((code) => process.exit(code)).catch((e) => {
      console.error('[login-handler] unexpected error:', e);
      process.exit(2);
    });
  }
}
