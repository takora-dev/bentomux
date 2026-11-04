/* Visual verification for the titlebar restyle, the radius scale and the
   agent status dot. Loads the built renderer (out/renderer) in Chromium with a
   stubbed Tauri IPC bridge, then asserts the things a grep cannot see:
     1. every rendered tab carries an icon tile and its own workspace colour;
     2. the strip is one rounded trough and the active tab is a raised pill;
     3. no corner in the app escapes the --r-* scale;
     4. the live agent states run the ping animation and idle does not;
     5. the static titlebar buttons actually got their glyph from icons.ts.

   Run `npm run build` first, then: node scripts/verify-titlebar.mjs
   Screenshots land in out/titlebar-*.png. Exits non-zero on the first failure. */

import { chromium } from 'playwright';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'out', 'renderer');

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

function cachedChromium() {
  const cacheRoot = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cacheRoot)) return null;
  for (const dir of readdirSync(cacheRoot)) {
    if (!dir.startsWith('chromium-')) continue;
    const candidate = join(cacheRoot, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/* Two workspaces and three panes, so the strip has to render several groups
   with different tile colours. */
const STATE = {
  workspaces: [
    { id: 'ws1', path: '/code/demo', name: 'demo' },
    { id: 'ws2', path: '/code/api', name: 'api' },
  ],
  activeWorkspaceId: 'ws1',
  openTabs: [],
  prefs: { theme: 'light', palette: 'default', paneHidden: false, sidebarWidth: 248 },
  safeMode: false,
  bootAttempts: 0,
};
const TABS = [
  { id: 'pane1', workspaceId: 'ws1', title: 'demo', cwd: '/code/demo' },
  { id: 'pane2', workspaceId: 'ws1', title: 'demo-2', cwd: '/code/demo' },
  { id: 'pane3', workspaceId: 'ws2', title: 'api', cwd: '/code/api' },
];

function installStub({ state, tabs }) {
  let nextId = 1;
  const callbacks = new Map();
  window.__IPC_CALLS__ = [];
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(cb, once) { const id = nextId++; callbacks.set(id, { cb, once }); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc(p) { return p; },
    async invoke(cmd) {
      window.__IPC_CALLS__.push(cmd);
      switch (cmd) {
        case 'get_state': return state;
        case 'tab_restore': await new Promise(r => setTimeout(r, 60)); return tabs;
        case 'plugin_list': return [];
        case 'plugin_safe_mode': return { safeMode: false, attempts: 0, requested: false };
        case 'agent_approval_pending': return null;
        case 'git_branch_for': return 'main';
        case 'git_diff_stat': return { files: 2, insertions: 12, deletions: 3 };
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

  const page = await browser.newPage({ viewport: { width: 1180, height: 620 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.addInitScript(installStub, { state: STATE, tabs: TABS });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.getElementById('bootSplash'), null, { timeout: 20000 });
  await page.waitForSelector('#tabstrip .tab', { timeout: 10000 });

  /* --- 1. every tab has an icon tile with a workspace colour --- */
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#tabstrip .tab')].map(el => {
    const tile = el.querySelector('.tab-tile');
    const cs = tile && getComputedStyle(tile);
    return {
      label: el.querySelector('.tabname')?.textContent ?? '',
      hasTile: !!tile,
      hasSvg: !!tile?.querySelector('svg'),
      tileBg: cs?.backgroundColor ?? '',
      tileRadius: cs?.borderTopLeftRadius ?? '',
      tabRadius: getComputedStyle(el).borderTopLeftRadius,
      active: el.classList.contains('active'),
    };
  }));
  check('tabs render', tabs.length >= 3, `got ${tabs.length}`);
  check('every tab has an icon tile', tabs.every(t => t.hasTile && t.hasSvg), JSON.stringify(tabs));
  check('tiles are coloured, not grey', tabs.every(t => t.tileBg && t.tileBg !== 'rgb(138, 145, 155)'), JSON.stringify(tabs.map(t => t.tileBg)));
  check('tile radius is --r-sm (4px)', tabs.every(t => t.tileRadius === '4px'), JSON.stringify(tabs.map(t => t.tileRadius)));

  /* the tile must not sit flush against the pill's left edge: the reference is
     a 6-7px inset at this pill height, and 4px read as "stuck to the left" */
  const geometry = await page.evaluate(() => {
    const tab = document.querySelector('#tabstrip .tab');
    const tile = tab.querySelector('.tab-tile');
    const name = tab.querySelector('.tabname');
    const tr = tab.getBoundingClientRect();
    const ir = tile.getBoundingClientRect();
    const nr = name.getBoundingClientRect();
    const svg = tile.querySelector('svg').getBoundingClientRect();
    const bb = tile.querySelector('svg').getBBox();
    return {
      inset: ir.x - tr.x,
      tileSize: ir.width,
      tileToLabel: nr.x - ir.right,
      /* where the glyph ink actually lands, not where its box lands */
      inkOffsetX: (svg.x + (bb.x + bb.width / 2) * (svg.width / 24)) - (ir.x + ir.width / 2),
      inkOffsetY: (svg.y + (bb.y + bb.height / 2) * (svg.height / 24)) - (ir.y + ir.height / 2),
    };
  });
  check('tile inset from pill edge is 6px', Math.abs(geometry.inset - 6) < 0.6, JSON.stringify(geometry));
  check('tile is 17px', Math.abs(geometry.tileSize - 17) < 0.6, JSON.stringify(geometry));
  check('glyph ink is centred in the tile',
    Math.abs(geometry.inkOffsetX) < 1 && Math.abs(geometry.inkOffsetY) < 1, JSON.stringify(geometry));
  check('tab radius is --r-full (999px)', tabs.every(t => t.tabRadius === '999px'), JSON.stringify(tabs.map(t => t.tabRadius)));
  check('exactly one active tab', tabs.filter(t => t.active).length === 1, JSON.stringify(tabs.map(t => t.active)));
  check('workspaces get distinct tile colours',
    new Set(tabs.map(t => t.tileBg)).size >= 2, JSON.stringify(tabs.map(t => t.tileBg)));

  /* --- 2. the strip is a bare track, not a boxed trough --- */
  const strip = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('tabstrip'));
    return { radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, border: cs.borderTopWidth };
  });
  check('strip is a bare track',
    strip.radius === '0px' && strip.border === '0px' && /rgba\(0, 0, 0, 0\)|transparent/.test(strip.bg),
    JSON.stringify(strip));

  /* --- 3. no corner escapes the radius scale --- */
  const radii = await page.evaluate(() => {
    const tokens = new Set(['0px', '4px', '8px', '12px', '999px', '2px']);
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      for (const corner of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']) {
        const v = cs[corner];
        if (!v || tokens.has(v)) continue;
        /* 50% resolves to a px value on a sized element; a full circle is a
           legal exception because --r-full on a square is the same shape */
        if (parseFloat(v) >= Math.min(el.clientWidth, el.clientHeight) / 2 - 0.5 && el.clientWidth > 0) continue;
        bad.push(`${el.tagName.toLowerCase()}.${el.className || '-'} ${corner}=${v}`);
      }
    }
    return [...new Set(bad)].slice(0, 12);
  });
  check('no off-scale corner radius', radii.length === 0, radii.join(' | '));

  /* --- 4. the status dot animates only while the agent is live --- */
  const dots = await page.evaluate(() => {
    const out = {};
    for (const state of ['idle', 'working', 'blocked']) {
      const el = document.createElement('span');
      el.className = 'agent-status ' + state;
      el.textContent = state;
      document.body.append(el);
      const cs = getComputedStyle(el, '::after');
      const core = getComputedStyle(el, '::before');
      out[state] = {
        animation: cs.animationName,
        duration: cs.animationDuration,
        coreShadow: core.boxShadow,
        color: getComputedStyle(el).color,
      };
      el.remove();
    }
    return out;
  });
  check('working pings', dots.working.animation === 'agent-ping', JSON.stringify(dots.working));
  check('blocked pings', dots.blocked.animation === 'agent-ping', JSON.stringify(dots.blocked));
  check('idle pings too', dots.idle.animation === 'agent-ping', JSON.stringify(dots.idle));
  check('each state beats at its own tempo',
    new Set([dots.idle.duration, dots.working.duration, dots.blocked.duration]).size === 3,
    JSON.stringify([dots.idle.duration, dots.working.duration, dots.blocked.duration]));
  check('the dot carries a halo', /rgb/.test(dots.working.coreShadow), JSON.stringify(dots.working.coreShadow));

  /* The ripple expands to 3.2x its 7px core, so the row that holds it must not
     clip: a 14.5px-tall row with overflow:hidden sliced it into a square. The
     check stops at the pane row — .nav and .sidebar are scroll containers and
     are supposed to clip at the panel boundary. */
  const clipping = await page.evaluate(() => {
    const st = document.querySelector('.agent-status');
    const bad = [];
    let el = st;
    while (el && !el.classList.contains('workspace-child')) {
      const cs = getComputedStyle(el);
      if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        bad.push(`${el.className || el.tagName}:${cs.overflow}`);
      }
      el = el.parentElement;
    }
    return bad;
  });
  check('the pane row does not clip the status ripple', clipping.length === 0, clipping.join(' | '));

  /* and the label has to sit above the ring or the first letter washes out */
  const layering = await page.evaluate(() => {
    const st = document.querySelector('.agent-status');
    const label = st.querySelector('.agent-status-label');
    return {
      ripple: getComputedStyle(st, '::after').zIndex,
      pulse: st.querySelector('.pulse') ? getComputedStyle(st.querySelector('.pulse')).zIndex : null,
      label: label ? getComputedStyle(label).zIndex : null,
    };
  });
  /* The ripple scales to 3.2x from a 7px core, so it reaches 14.7px from the
     element's left edge. The label has to start past that or the ring washes
     over its first letter on every beat. */
  const spacing = await page.evaluate(() => {
    const st = document.querySelector('.agent-status');
    const label = st.querySelector('.agent-status-label');
    const cs = getComputedStyle(st);
    const gap = parseFloat(cs.gap);
    const core = 7;
    const reach = core / 2 + (core / 2) * 3.2;
    return { gap, labelStart: core + gap, rippleReach: reach, clearance: core + gap - reach };
  });
  check('the ripple clears the label',
    spacing.clearance > 0.5, JSON.stringify(spacing));
  check('gap is 9px', Math.abs(spacing.gap - 9) < 0.6, JSON.stringify(spacing));

  check('label paints above the ripples',
    layering.label !== 'auto' && Number(layering.label) > Number(layering.ripple),
    JSON.stringify(layering));
  check('states use distinct colours',
    new Set([dots.idle.color, dots.working.color, dots.blocked.color]).size === 3,
    JSON.stringify([dots.idle.color, dots.working.color, dots.blocked.color]));

  /* a strip of the three states at sidebar scale, for eyeballing the halo */
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'statusPreview';
    box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;display:flex;gap:18px;padding:10px 14px;background:var(--surface);border:1px solid var(--line);border-radius:12px;font-size:11px';
    for (const state of ['idle', 'working', 'blocked']) {
      const row = document.createElement('span');
      row.className = 'agent-status ' + state;
      const pulse = document.createElement('span');
      pulse.className = 'pulse';
      row.append(pulse, state);
      box.append(row);
    }
    document.body.append(box);
  });
  await page.screenshot({ path: join(root, 'out', 'status-dots.png'), clip: { x: 0, y: 540, width: 300, height: 70 } });
  await page.evaluate(() => document.getElementById('statusPreview')?.remove());

  /* --- 5. the static titlebar buttons got their glyphs --- */
  const glyphs = await page.evaluate(() =>
    ['#backTopBtn', '#redoTopBtn', '#themeBtn', '#compactAddBtn', '#compactSettingsBtn', '#winMinBtn', '#winCloseBtn']
      .map(sel => [sel, !!document.querySelector(sel + ' svg')]));
  check('static buttons have lucide glyphs', glyphs.every(([, has]) => has), JSON.stringify(glyphs));

  await page.screenshot({ path: join(root, 'out', 'titlebar-light.png'), clip: { x: 0, y: 0, width: 1180, height: 60 } });

  /* dark pass: the tiles and the halo must survive the theme flip */
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(120);
  const darkGlyph = await page.evaluate(() => document.querySelector('#themeBtn svg') !== null);
  check('theme button repaints on toggle', darkGlyph, 'glyph missing after theme change');
  await page.screenshot({ path: join(root, 'out', 'titlebar-dark.png'), clip: { x: 0, y: 0, width: 1180, height: 60 } });

  /* squared palettes must flatten through the tokens, not through new rules */
  await page.evaluate(() => document.documentElement.classList.add('palette-pixelated'));
  await page.waitForTimeout(120);
  const squared = await page.evaluate(() => {
    const tab = document.querySelector('#tabstrip .tab');
    return tab ? getComputedStyle(tab).borderTopLeftRadius : null;
  });
  check('pixelated palette squares the tabs', squared === '0px', String(squared));

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  server.close();

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch(e => { console.error(e); process.exit(1); });
