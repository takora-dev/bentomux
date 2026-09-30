/* Generates the plugin-network section of the Tauri CSP from manifests.
 *
 * Run: node scripts/gen-plugin-csp.mjs
 * Check: node scripts/gen-plugin-csp.mjs --check   (CI; fails on drift)
 *
 * The problem it solves: every plugin that fetches an outside website needs
 * that origin in `connect-src`/`img-src`, and hand-editing tauri.conf.json
 * per plugin does not scale — N plugins mean N releases plus a forgotten
 * redirect host (petdex.dev → assets.petdex.dev) that blocks installs.
 *
 * Each plugin declares its origins in `plugin.json` under `network`:
 * bare `https://host[:port]` origins, no paths. This script collects them
 * from every known manifest (bundled plugins, first-party `plugins/`
 * working copies; templates declare none) and patches the two CSP strings
 * in `src-tauri/tauri.conf.json`, preserving every static token. CI re-runs
 * with --check so a manifest change that forgets the policy fails review,
 * not a user on Windows.
 *
 * Runtime-installed third-party plugins stay bounded by the baked policy:
 * a host outside the last build stays blocked until the next release. That
 * limit is stated in the Studio review screen, not hidden. */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CHECK = process.argv.includes('--check');
const ROOT = resolve(import.meta.dirname, '..');
const CONF_PATH = join(ROOT, 'src-tauri', 'tauri.conf.json');

/* Manifests this script reads. Bundled plugins ship with the app; the
   top-level `plugins/` dir holds first-party working copies (petdex) when
   present. `resources/plugin-network.json` pins the committed origins so CI
   (which never has `plugins/`) checks against the same input. Regenerate it
   with --write-baseline when a working-copy manifest changes.
   Templates intentionally declare no network access. */
const MANIFEST_DIRS = [
  join(ROOT, 'resources', 'plugin-bundled'),
  join(ROOT, 'plugins'),
];
const BASELINE_PATH = join(ROOT, 'resources', 'plugin-network.json');

/* Static https:// hosts that belong to the app itself, never plugin-managed.
   Today empty (the updater endpoint lives outside the CSP); listed here so a
   future one survives regeneration instead of being stripped as drift. */
const STATIC_KEEP = [];

function collectOrigins() {
  const origins = new Set();
  for (const dir of MANIFEST_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(dir, entry.name, 'plugin.json');
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        throw new Error(`could not parse ${manifestPath}`);
      }
      for (const origin of manifest.network ?? []) {
        if (typeof origin !== 'string') continue;
        origins.add(origin);
      }
    }
  }
  return [...origins].sort();
}

/* Sync the managed origins of one directive. Static tokens (schemes, data:,
   blob:, localhost, static https:// in STATIC_KEEP) survive untouched; every
   other https:// token is regenerated from manifests, so removing a plugin
   removes its origins. */
function withHosts(csp, directive, hosts) {
  const parts = csp.split(';').map(s => s.trim());
  const idx = parts.findIndex(p => p.startsWith(directive + ' '));
  if (idx === -1) throw new Error(`directive ${directive} missing from CSP`);
  const tokens = parts[idx].split(/\s+/);
  const kept = tokens.filter(t =>
    t === directive || !t.startsWith('https://') || STATIC_KEEP.includes(t),
  );
  parts[idx] = [...kept, ...hosts].join(' ');
  return parts.join('; ');
}

/* Surgical string patch: only the two CSP values change, byte-identical
   elsewhere (no JSON reformat noise on unrelated keys). */
function patchCsp(text, key, next) {
  const re = new RegExp(`"${key}": "([^"]*)"`);
  if (!re.test(text)) throw new Error(`"${key}" missing from tauri.conf.json`);
  return text.replace(re, `"${key}": "${next}"`);
}

/* Committed origins live in the baseline so CI — which never has the
   untracked `plugins/` working copies — checks the same input. Local runs
   merge manifest discoveries back into it; retiring a plugin means deleting
   its line here by hand (a stale entry only over-permits, never breaks). */
function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    return Array.isArray(parsed.origins) ? parsed.origins.filter(o => typeof o === 'string') : [];
  } catch {
    throw new Error(`could not parse ${BASELINE_PATH}`);
  }
}

const origins = [...new Set([...loadBaseline(), ...collectOrigins()])].sort();
const text = readFileSync(CONF_PATH, 'utf8');
const conf = JSON.parse(text);
const security = conf.app?.security;
if (!security?.csp || !security?.devCsp) throw new Error('app.security.csp/devCsp missing');

const nextCsp = withHosts(withHosts(security.csp, 'connect-src', origins), 'img-src', origins);
/* dev serves the renderer from Vite, so its policy is looser by design —
   but the plugin hosts still belong there or dev never reproduces prod. */
const nextDev = withHosts(security.devCsp, 'default-src', origins);

if (CHECK) {
  const drift = [];
  if (security.csp !== nextCsp) drift.push('csp');
  if (security.devCsp !== nextDev) drift.push('devCsp');
  if (drift.length) {
    console.error(`CSP drift in ${drift.join(', ')}: run node scripts/gen-plugin-csp.mjs`);
    console.error(`managed origins: ${origins.join(' ') || '(none)'}`);
    process.exit(1);
  }
  console.log(`ok: CSP covers ${origins.length} plugin origin(s)`);
} else {
  writeFileSync(CONF_PATH, patchCsp(patchCsp(text, 'csp', nextCsp), 'devCsp', nextDev));
  writeFileSync(BASELINE_PATH, JSON.stringify({ origins }, null, 2) + '\n');
  console.log(`wrote ${origins.length} plugin origin(s) into tauri.conf.json: ${origins.join(' ') || '(none)'}`);
}
