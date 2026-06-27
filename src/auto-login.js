// auto-login.js — use Playwright to automate login across iframes
//
// Playwright works at the browser level, so it can interact with elements
// across iframe boundaries without same-origin restrictions.
//
// IMPORTANT: Browser's password autofill cannot be triggered programmatically for security.
// So this script automates to the password field, then you click manually (1 sec).
//
// Usage: node src/auto-login.js [password]
//   If password provided, uses it directly
//   If no password, script navigates to password field and waits for you to click + autofill

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CDP_PORT = process.env.CDP_PORT || '19222';
const PROFILE_DIR = path.join(os.homedir(), '.jarvis', 'browser', 'profile');

const log = (msg) => console.error(`[auto-login ${new Date().toISOString()}]`, msg);

async function getAuthenticatedPage() {
  try {
    // Connect to the existing Chromium instance via CDP
    const browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    const contexts = browser.contexts();
    if (!contexts.length) {
      log('no browser contexts found');
      return null;
    }

    const context = contexts[0];
    const pages = context.pages();

    // Find the thinkorswim page
    const tosPage = pages.find(p => p.url().includes('thinkorswim') || p.url().includes('trade.thinkorswim'));

    if (!tosPage) {
      log('no thinkorswim page found');
      return null;
    }

    return { browser, page: tosPage };
  } catch (e) {
    log(`failed to connect to browser: ${e.message}`);
    return null;
  }
}

async function autoLogin(passwordArg) {
  try {
    const browserSession = await getAuthenticatedPage();
    if (!browserSession) {
      return { success: false, reason: 'could_not_connect_to_browser' };
    }

    const { browser, page } = browserSession;

    try {
      const startTime = Date.now();

      log('checking current auth state');
      const title = await page.title();
      const isLoggedOut = title.toLowerCase().includes('login');

      if (!isLoggedOut) {
        log('already authenticated');
        return { success: false, reason: 'already_authed' };
      }

      log('page is logged out, attempting auto-login');

      // Bring tab to front so Chrome doesn't throttle JS execution
      await page.bringToFront();
      await page.waitForTimeout(300);

      // Always navigate to the full trade page so the Schwab SSO iframe loads with the
      // proper redirect state (?clientID=TOSWeb&redirectUri=...&state=symbol%3D%2FES...).
      // Without this, the iframe URL is just #/login with no state, and Schwab doesn't
      // know where to redirect after auth — login completes but the session goes nowhere.
      log('navigating to trade page so SSO iframe loads with correct redirect state');
      await page.goto('https://trade.thinkorswim.com/trade?symbol=%2FES%3AXCME');
      await page.waitForTimeout(3000);

      // Schwab has a two-step login: first Login ID, then Password
      // Get the iframe that contains the login form
      const frames = page.frames();
      const iframeFrame = frames.find(f => f.url().includes('sws-gateway-nr'));

      if (!iframeFrame) {
        log('login iframe not found');
        return { success: false, reason: 'no_login_iframe' };
      }

      // Step 1: Check if login ID field is visible and submit it
      log('checking for login ID field');
      const loginIdField = await iframeFrame.locator('#loginIdInput').first();

      if (loginIdField && await loginIdField.isVisible()) {
        log('found login ID field, clicking Continue to proceed to password step');

        // Click Continue button to go to password step
        const continueBtn = await iframeFrame.locator('button:has-text("Continue")').first();
        if (continueBtn && await continueBtn.isVisible()) {
          await continueBtn.click();
          await page.waitForTimeout(1500);
          log('clicked Continue, waiting for password field to appear');
        } else {
          log('Continue button not found');
          return { success: false, reason: 'continue_button_not_found' };
        }
      }

      // Step 2: Wait for and interact with password field
      let passwordField = null;
      for (let i = 0; i < 15; i++) {
        try {
          passwordField = await iframeFrame.locator('input[type="password"]').first();
          if (passwordField && await passwordField.isVisible()) {
            log('found password field after continue');
            break;
          }
        } catch (e) {}

        if (i < 14) await page.waitForTimeout(300);
      }

      if (!passwordField || !await passwordField.isVisible()) {
        log('password field did not appear after continue');
        return { success: false, reason: 'no_password_field_after_continue' };
      }

      // Click the password field to trigger autofill
      log('clicking password field to trigger autofill');
      await passwordField.click();
      await page.waitForTimeout(800);

      // If password was provided, fill it directly
      if (passwordArg) {
        log('filling password field with provided password');
        await passwordField.fill(passwordArg);
        await page.waitForTimeout(300);
      } else {
        // Try to get autofill to work by pressing arrow key or waiting
        log('attempting to trigger browser autofill');

        // Try pressing down arrow to open autofill
        await passwordField.press('ArrowDown');
        await page.waitForTimeout(400);

        // Try clicking on autofill suggestion if visible
        let autofillClicked = false;
        try {
          const autofillOption = await iframeFrame.locator('[role="option"]').first();
          if (autofillOption) {
            const isVisible = await autofillOption.isVisible().catch(() => false);
            if (isVisible) {
              log('found autofill suggestion, clicking it');
              await autofillOption.click();
              autofillClicked = true;
              await page.waitForTimeout(1000);
            }
          }
        } catch (e) {
          log(`autofill click failed: ${e.message}`);
        }

        // Check if password was auto-filled
        const pwValue = await passwordField.inputValue().catch(() => '');
        log(`password field value: ${pwValue ? '***' : '(empty)'}`);

        if (!pwValue && !autofillClicked) {
          log('warning: password field appears empty and autofill did not click');
        }
      }

      // Find and click the login/submit button
      log('looking for sign-in button');
      let signInBtn = null;

      // Try different button text patterns
      const buttonTexts = ['Sign In', 'Sign in', 'Log In', 'Submit', 'Continue'];
      for (const text of buttonTexts) {
        try {
          const btn = await iframeFrame.locator(`button:has-text("${text}")`).first();
          if (btn && await btn.isVisible()) {
            signInBtn = btn;
            log(`found button with text: ${text}`);
            break;
          }
        } catch (e) {}
      }

      if (signInBtn) {
        log('clicking sign-in button');
        await signInBtn.click();
        await page.waitForTimeout(800);
      } else {
        log('sign-in button not found, password may auto-submit');
      }

      // Wait for successful authentication (page title changes or app loads)
      log('waiting for authentication to complete');
      const maxWait = 40000;
      const pollStart = Date.now();

      while (Date.now() - pollStart < maxWait) {
        try {
          const currentTitle = await page.title();
          const isApp = !currentTitle.toLowerCase().includes('login');

          if (isApp) {
            const waitTime = Date.now() - startTime;
            log(`login successful (${waitTime}ms)`);
            return { success: true, title: currentTitle, loginTime: waitTime };
          }
        } catch (e) {}

        await page.waitForTimeout(500);
      }

      log(`timeout waiting for authentication after ${maxWait}ms`);
      return { success: false, reason: 'timeout_waiting_for_auth' };

    } finally {
      await browser.close();
    }
  } catch (e) {
    console.error('[auto-login] fatal error:', e.message);
    return { success: false, reason: 'exception', error: e.message };
  }
}

// CLI
const passwordArg = process.argv[2] || process.env.SCHWAB_PASSWORD;

if (!passwordArg) {
  console.log(JSON.stringify({
    success: false,
    reason: 'no_password',
    error: 'Password not provided via argument or SCHWAB_PASSWORD env var'
  }));
  process.exit(2);
}

autoLogin(passwordArg).then((result) => {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 2);
}).catch((e) => {
  console.error('[auto-login] unexpected error:', e);
  process.exit(2);
});
