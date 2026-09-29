import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.argv[2] || 'src-tauri/target/release/bundle';

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

const files = await walk(root);
/* Resources the app cannot work without. The plugin platform's resources are
   here for the same reason as the hook: a build that drops them ships a
   Plugin Studio with no templates and an authoring skill that cannot be
   installed — all of which fail silently at runtime. */
const required = [
  'bentomux-hook.cjs',
  'remote-page.html',
  'plugin-schema.json',
  join('plugin-templates', 'basic', 'plugin.json'),
  join('plugin-skill', 'bentomux-plugin-author', 'SKILL.md'),
  join('plugin-sdk', 'bentomux-plugin-sdk.d.ts'),
];
const appPresent = files.some(file => file.includes('.app/Contents/'));
for (const name of required) {
  const bundled = files.some(file => file.endsWith(`/${name}`) || file.endsWith(`\\${name}`));
  if (appPresent && !bundled) throw new Error(`missing bundled resource: ${name}`);
  if (!bundled) console.log(`resource check deferred: ${name} (installer packaging removed unpacked app)`);
}

// Verify cloudflared is present in source resources as the .gz the bundler
// ships (remote.rs inflates it into the app cache on first tunnel use). Missing
// archives mean remote control shows 'install cloudflared' at runtime.
const cloudflaredTargets = {
  macOS: ['darwin-x86_64/cloudflared.gz', 'darwin-aarch64/cloudflared.gz'],
  Linux: ['linux-x86_64/cloudflared.gz'],
  Windows: ['windows-x86_64/cloudflared.exe.gz'],
};
const runnerOs = process.env.RUNNER_OS; // set by GitHub Actions
const expectedTargets = cloudflaredTargets[runnerOs] || [];
for (const t of expectedTargets) {
  const p = join('resources', 'cloudflared', t);
  const { existsSync } = await import('node:fs');
  if (!existsSync(p)) throw new Error(`missing cloudflared archive: ${p} — run 'npm run prepare:cloudflared' before bundling`);
}
if (expectedTargets.length) console.log(`cloudflared archives verified: ${expectedTargets.join(', ')}`);

// tauri.conf.json bundles the whole resources/cloudflared directory, so the raw
// 39.8 MB binaries must not be sitting in it: only the ~20.3 MB .gz may be.
// A raw binary here means every install carries ~20 MB per arch it doesn't need.
const rawsInSource = (await walk('resources/cloudflared')).filter(file => /(^|[\\/])cloudflared(\.exe)?$/i.test(file));
if (rawsInSource.length) {
  throw new Error(`uncompressed cloudflared left in resources (expected only .gz): ${rawsInSource.join(', ')} — delete it; remote.rs inflates the .gz`);
}

const sourceResources = await walk('resources');
for (const name of required) {
  if (!sourceResources.some(file => file.endsWith(`/${name}`) || file.endsWith(`\\${name}`))) {
    throw new Error(`missing source resource: ${name}`);
  }
}

const artifacts = files.filter(file => /\.(app|dmg|AppImage|msi|deb)$/i.test(file) || /-setup\.exe$/i.test(file));
if (artifacts.length === 0) throw new Error(`no installer artifact found under ${root}`);

// The raw binaries must never reach a bundle either: only the .gz does.
const rawBundled = files.filter(file => /(^|[\\/])cloudflared(\.exe)?$/i.test(file));
if (rawBundled.length) {
  throw new Error(`uncompressed cloudflared bundled (expected only .gz): ${rawBundled.map(file => relative(root, file)).join(', ')}`);
}

for (const file of artifacts) {
  const bytes = (await stat(file)).size;
  if (bytes === 0) throw new Error(`empty installer artifact: ${relative(root, file)}`);
  console.log(`${relative(root, file)}\t${bytes} bytes`);
}

console.log(`bundled resources: ${required.join(', ')}`);
