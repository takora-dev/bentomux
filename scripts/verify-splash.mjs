/* Headless verification for the boot splash and the close-button wiring.
   Loads the built renderer (out/renderer) in Chromium with a stubbed Tauri IPC
   bridge and asserts:
     1. the splash is on screen before boot resolves, in both OS color schemes
        (the pre-theme fallback path — the persisted theme is not readable yet);
     2. the splash is removed once boot finishes;
     3. the X button invokes win_close, which the backend turns into a hide
        (tray.rs) — quitting for real is the tray menu's Quit item.

   Run `npm run build` first, then: node scripts/verify-splash.mjs
   Exits non-zero on the first failed assertion. */

import { chromium } from 'playwright';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'out', 'renderer');

/* The built page uses absolute asset paths (`/assets/...`), which a file://
   origin cannot load; serve out/renderer over HTTP instead. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
function startServer() {
  const server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^[/\\]+/, '');
    const file = rel === '' ? join(distDir, 'index.html') : join(distDir, rel);
    if (!file.startsWith(distDir) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* Prefer Playwright's own resolution; fall back to whatever Chromium revision
   the local cache already holds (revisions drift, and a mismatch otherwise
   forces a fresh download just to run a smoke check). */
function cachedChromium() {
  const cacheRoot = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!existsSync(cacheRoot)) return null;
  for (const dir of readdirSync(cacheRoot)) {
    if (!dir.startsWith('chromium-')) continue;
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const candidate = join(cacheRoot, dir, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/* One saved shell so boot renders a terminal route rather than the welcome page. */
const STATE = {
  workspaces: [{ id: 'ws1', path: 'C:\\code\\demo', name: 'demo' }],
  activeWorkspaceId: 'ws1',
  openTabs: [],
  prefs: { theme: 'system', palette: 'default', paneHidden: false, sidebarWidth: 248 },
  safeMode: false,
  bootAttempts: 0,
};
const TABS = [{ id: 'pane1', workspaceId: 'ws1', title: 'demo', cwd: 'C:\\code\\demo' }];

/* Installed before any page script: a minimal __TAURI_INTERNALS__ covering the
   surface @tauri-apps/api touches, plus a call log for the button assertion. */
function installStub({ state, tabs, holdBoot }) {
  let nextId = 1;
  const callbacks = new Map();
  window.__IPC_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    transformCallback(cb, once) {
      const id = nextId++;
      callbacks.set(id, { cb, once });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc(p) { return p; },
    async invoke(cmd) {
      window.__IPC_CALLS__.push(cmd);
      switch (cmd) {
        case 'get_state':
          /* never resolves: holds the splash on screen for inspection */
          return holdBoot ? new Promise(() => {}) : state;
        /* held briefly so the splash is inspectable in its pre-boot state,
           exactly as a cold start (pty host handshake + shell spawns) shows it */
        case 'tab_restore': await new Promise(r => setTimeout(r, 1200)); return tabs;
        case 'plugin_list': return [];
        case 'plugin_safe_mode': return { safeMode: false, attempts: 0, requested: false };
        case 'agent_approval_pending': return null;
        case 'git_branch_for': return 'main';
        case 'git_diff_stat': return { files: 0, insertions: 0, deletions: 0 };
        case 'remote_info': return null;
        default: return null;
      }
    },
  };
}

const failures = [];
function check(name, ok, detail) {
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + detail}`);
}

async function main() {
  const server = await startServer();
  const pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;

  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    const fallback = cachedChromium();
    if (!fallback) throw error;
    console.log(`[info] using cached Chromium: ${fallback}`);
    browser = await chromium.launch({ executablePath: fallback });
  }

  /* --- 1. splash on screen pre-boot, both color schemes --- */
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, colorScheme: scheme });
    await page.addInitScript(installStub, { state: STATE, tabs: TABS, holdBoot: true });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    const info = await page.evaluate(() => {
      const el = document.getElementById('bootSplash');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0,
        covers: cs.position === 'fixed' && cs.zIndex === '2000',
        bg: cs.backgroundColor,
        spinner: !!el.querySelector('.boot-spinner'),
        name: el.querySelector('.boot-name')?.textContent ?? '',
      };
    });
    check(`splash present (${scheme})`, !!info && info.visible && info.covers, JSON.stringify(info));
    check(`splash content (${scheme})`, info?.spinner === true && info?.name === 'Bentomux', JSON.stringify(info));
    const wantBg = scheme === 'dark' ? 'rgb(23, 24, 27)' : 'rgb(241, 242, 244)';
    check(`splash follows OS scheme (${scheme})`, info?.bg === wantBg, `bg=${info?.bg} want=${wantBg}`);
    await page.screenshot({ path: join(root, 'out', `splash-${scheme}.png`) });
    await page.close();
  }

  /* --- 2. splash removed after boot + 3. X minimizes --- */
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.addInitScript(installStub, { state: STATE, tabs: TABS, holdBoot: false });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

  const removed = await page
    .waitForFunction(() => !document.getElementById('bootSplash'), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('splash removed after boot', removed, 'still present after 15s');

  const shellRendered = await page.evaluate(() => document.querySelectorAll('#tabstrip .tab, #content .page').length > 0);
  check('shell rendered after splash', shellRendered, 'no tab strip or page content');

  await page.click('#winCloseBtn');
  await page.waitForTimeout(150);
  const winCalls = await page.evaluate(() => window.__IPC_CALLS__.filter(c => c.startsWith('win_')));
  check('X invokes win_close only', winCalls.length === 1 && winCalls[0] === 'win_close', JSON.stringify(winCalls));
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  await page.screenshot({ path: join(root, 'out', 'splash-after.png') });

  await browser.close();
  server.close();

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch(e => { console.error(e); process.exit(1); });
