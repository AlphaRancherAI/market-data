// wake-chrome.js — force Chrome Canary out of blank/stalled rendering state
//
// Chrome Canary has a GPU compositor bug: the window goes blank but JS keeps running.
// Physical mouse hover over the window forces a repaint. We replicate this by:
//   1. AppleScript 'activate' — raises Chrome to OS foreground (Page.bringToFront
//      is Chrome-internal and doesn't tell macOS to surface the window).
//   2. Python ctypes CGWarpMouseCursorPosition — moves the OS cursor into the
//      Chrome window. No Accessibility permissions required; just repositions the
//      cursor so macOS sends hover events to the frontmost window (Chrome).
//   3. Page.captureScreenshot via CDP — forces the compositor to render a frame as
//      a last resort (must produce pixels to answer the request).

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = (msg) => console.error(`[wake-chrome ${new Date().toISOString()}]`, msg);

// Get Chrome Canary window center {x, y} via AppleScript. Returns null on failure.
function getChromeWindowCenter() {
  try {
    const script = [
      'tell application "Google Chrome Canary"',
      '  set b to bounds of front window',
      '  set cx to (item 1 of b) + ((item 3 of b) - (item 1 of b)) / 2',
      '  set cy to (item 2 of b) + ((item 4 of b) - (item 2 of b)) / 2',
      '  return (cx as integer as string) & "," & (cy as integer as string)',
      'end tell',
    ].join('\n');
    const out = execSync(`osascript << 'OSEOF'\n${script}\nOSOEF`, { timeout: 3000 }).toString().trim();
    const [x, y] = out.split(',').map(Number);
    if (isNaN(x) || isNaN(y)) return null;
    return { x, y };
  } catch { return null; }
}

// Move the OS cursor over the Chrome window using CoreGraphics (no Accessibility needed).
function moveCursorToChrome(cx, cy) {
  const py = `
import ctypes, time

class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

cg = ctypes.cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
cg.CGWarpMouseCursorPosition.argtypes = [CGPoint]
cg.CGWarpMouseCursorPosition.restype = ctypes.c_int

cx, cy = ${cx}, ${cy}
# Sweep the cursor around the window center to generate hover events
for dx, dy in [(-120,0),(0,-90),(120,0),(0,90),(-60,-60),(60,60),(-60,60),(60,-60),(0,0)]:
    cg.CGWarpMouseCursorPosition(CGPoint(cx + dx, cy + dy))
    time.sleep(0.07)
`;
  const tmp = path.join(os.tmpdir(), 'wake-chrome-cursor.py');
  fs.writeFileSync(tmp, py);
  execSync(`python3 ${tmp}`, { timeout: 5000 });
}

// page: optional CDP Page object with .send(method, params) — used for screenshot fallback.
async function wakeChrome(page) {
  log('waking Chrome Canary');

  // 1. Raise Chrome to OS foreground
  try {
    execSync(`osascript -e 'tell application "Google Chrome Canary" to activate'`, { timeout: 3000 });
  } catch (e) { log(`activate failed: ${e.message}`); }

  // Small pause so macOS finishes the window raise before we move the cursor
  await new Promise(r => setTimeout(r, 400));

  // 2. Move OS cursor into Chrome window
  const center = getChromeWindowCenter();
  if (center) {
    try {
      moveCursorToChrome(center.x, center.y);
      log(`cursor swept over Chrome window center ${center.x},${center.y}`);
    } catch (e) { log(`cursor move failed: ${e.message}`); }
  } else {
    log('could not get Chrome window bounds, skipping cursor move');
  }

  await new Promise(r => setTimeout(r, 400));

  // 3. Force a render frame via CDP screenshot (compositor must produce pixels)
  if (page) {
    try {
      await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 5 });
      log('screenshot forced a render frame');
    } catch (e) { log(`screenshot failed: ${e.message}`); }
  }

  await new Promise(r => setTimeout(r, 200));
  log('wake complete');
}

module.exports = { wakeChrome };
