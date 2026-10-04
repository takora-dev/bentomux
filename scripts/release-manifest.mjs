#!/usr/bin/env node
/* Merges the per-runner checksum lists produced by the build matrix into the
   release manifest (`latest.json`) that installers/install.sh and
   installers/install.ps1 read, and renders the Homebrew cask for the tap repo.

   The manifest is emitted as pretty JSON with a fixed key order — each asset
   is always `{"format": …, "url": …, "sha256": …}` and assets are sorted by
   target — because install.sh extracts a single asset from it with plain
   `sed`. The installers must run on hosts without jq, python or node.
   `--selftest` runs that exact sed expression against a generated manifest so
   a key-order change breaks here instead of on a user's machine. */

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { glob } from 'node:fs/promises';

const REPO = 'takora-dev/bentomux';
const SCHEMA_VERSION = 1;
const PRODUCT = 'Bentomux';
const DESCRIPTION = 'Calm desktop for AI agent runtime workspaces';

/** Target key installers ask for, plus the bundle format it carries. */
export function classify(file) {
  const name = basename(file);
  const arm = /(aarch64|arm64)/i.test(name);
  if (/\.dmg$/i.test(name)) {
    return { key: 'macos', format: 'dmg', rank: /universal/i.test(name) ? 0 : 1 };
  }
  if (/\.AppImage$/i.test(name)) {
    return { key: arm ? 'linux-aarch64' : 'linux-x86_64', format: 'appimage' };
  }
  if (/\.deb$/i.test(name)) {
    return { key: arm ? 'linux-deb-aarch64' : 'linux-deb-x86_64', format: 'deb' };
  }
  if (/-setup\.exe$/i.test(name)) {
    return { key: arm ? 'windows-aarch64' : 'windows-x86_64', format: 'nsis' };
  }
  if (/\.msi$/i.test(name)) {
    return { key: arm ? 'windows-aarch64-msi' : 'windows-x86_64-msi', format: 'msi' };
  }
  return null;
}

/** `sha256sum`/`shasum -a 256` output: `<hex>  <path>`, binary mode adds `*`. */
export function parseChecksums(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) entries.push({ sha256: match[1].toLowerCase(), file: match[2] });
  }
  return entries;
}

export function buildAssets(checksums, { repo, tag }) {
  const chosen = new Map();
  for (const { sha256, file } of checksums) {
    const target = classify(file);
    if (!target) continue;
    const rank = target.rank ?? 0;
    const existing = chosen.get(target.key);
    /* A universal dmg wins over an arch-suffixed one from the same release. */
    if (existing && existing.rank <= rank) continue;
    chosen.set(target.key, {
      rank,
      format: target.format,
      url: `https://github.com/${repo}/releases/download/${tag}/${basename(file)}`,
      sha256,
    });
  }
  const assets = {};
  for (const key of [...chosen.keys()].sort()) {
    const { format, url, sha256 } = chosen.get(key);
    assets[key] = { format, url, sha256 };
  }
  return assets;
}

export function buildManifest({ version, tag, repo, checksums }) {
  return {
    schema_version: SCHEMA_VERSION,
    version,
    tag,
    assets: buildAssets(checksums, { repo, tag }),
  };
}

export function renderManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function renderCask(manifest, { repo }) {
  const macos = manifest.assets.macos;
  if (!macos) throw new Error('manifest has no macOS asset; refusing to render a broken cask');
  return `cask "bentomux" do
  version "${manifest.version}"
  sha256 "${macos.sha256}"

  url "${macos.url}"
  name "${PRODUCT}"
  desc "${DESCRIPTION}"
  homepage "https://github.com/${repo}"

  app "${PRODUCT}.app"

  caveats <<~EOS
    ${PRODUCT} is not notarized yet, so macOS may refuse the first launch.
    If it does, run:
      xattr -dr com.apple.quarantine "/Applications/${PRODUCT}.app"
  EOS
end
`;
}

/* The extraction install.sh performs, kept here so it is tested, not assumed:
   whitespace is stripped first (`tr -d ' \t\n\r'` in the installer) and the
   single asset object is then pulled out of the resulting one-liner. Quotes stay
   unescaped inside the BRE — BSD sed mis-parses `\"` and drops the group. */
const SH_ASSET_SED = 's/.*"TARGET":\\({"format":"[^"]*","url":"[^"]*","sha256":"[^"]*"}\\).*/\\1/p';

function sedExtract(json, targetName) {
  const dir = mkdtempSync(join(tmpdir(), 'bentomux-manifest-'));
  try {
    const file = join(dir, 'latest.json');
    writeFileSync(file, json.replace(/[ \t\r\n]/g, ''));
    const expression = SH_ASSET_SED.replace('TARGET', targetName);
    return execFileSync('sed', ['-n', expression, file], { encoding: 'utf8' }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selftest() {
  assert.deepEqual(classify('Bentomux_0.1.0_aarch64.dmg'), { key: 'macos', format: 'dmg', rank: 1 });
  assert.deepEqual(classify('Bentomux_0.1.0_universal.dmg'), { key: 'macos', format: 'dmg', rank: 0 });
  assert.deepEqual(classify('Bentomux_0.1.0_amd64.AppImage'), { key: 'linux-x86_64', format: 'appimage' });
  assert.deepEqual(classify('bentomux_0.1.0_amd64.deb'), { key: 'linux-deb-x86_64', format: 'deb' });
  assert.deepEqual(classify('Bentomux_0.1.0_x64-setup.exe'), { key: 'windows-x86_64', format: 'nsis' });
  assert.deepEqual(classify('Bentomux_0.1.0_x64_en-US.msi'), { key: 'windows-x86_64-msi', format: 'msi' });
  assert.deepEqual(classify('bentomux_0.1.0_arm64.deb'), { key: 'linux-deb-aarch64', format: 'deb' });
  assert.equal(classify('source.tar.gz'), null);

  assert.deepEqual(parseChecksums('a'.repeat(64) + '  *bentomux.AppImage\n').length, 1);
  assert.equal(parseChecksums(`${'A'.repeat(64)}  x.zip\r\n`)[0].sha256, 'a'.repeat(64));
  assert.equal(parseChecksums('not-a-hash  file\n').length, 0);

  // updater platform mapping must cover what tauri v2 actually emits
  assert.deepEqual(updaterPlatforms('Bentomux.app.tar.gz'), ['darwin-aarch64', 'darwin-x86_64']);
  assert.deepEqual(updaterPlatforms('Bentomux_0.2.9_amd64.AppImage'), ['linux-x86_64']);
  assert.deepEqual(updaterPlatforms('Bentomux_0.2.9_x64-setup.exe'), ['windows-x86_64']);
  assert.deepEqual(updaterPlatforms('bentomux_0.2.9_aarch64.AppImage'), ['linux-aarch64']);
  assert.deepEqual(updaterPlatforms('bentomux_0.2.9_amd64.deb'), []);

  const dmgSha = 'b'.repeat(64);
  const checksums = [
    { sha256: '1'.repeat(64), file: 'Bentomux_0.1.0_aarch64.dmg' },
    { sha256: dmgSha, file: 'Bentomux_0.1.0_universal.dmg' },
    { sha256: '2'.repeat(64), file: 'Bentomux_0.1.0_amd64.AppImage' },
    { sha256: '3'.repeat(64), file: 'bentomux_0.1.0_amd64.deb' },
    { sha256: '4'.repeat(64), file: 'Bentomux_0.1.0_x64-setup.exe' },
    { sha256: '5'.repeat(64), file: 'Bentomux_0.1.0_x64_en-US.msi' },
  ];
  const manifest = buildManifest({ version: '0.1.0', tag: 'v0.1.0', repo: REPO, checksums });
  assert.equal(manifest.assets.macos.sha256, dmgSha, 'universal dmg must win');
  assert.deepEqual(Object.keys(manifest.assets), [
    'linux-deb-x86_64',
    'linux-x86_64',
    'macos',
    'windows-x86_64',
    'windows-x86_64-msi',
  ]);
  assert.equal(
    manifest.assets['linux-x86_64'].url,
    'https://github.com/takora-dev/bentomux/releases/download/v0.1.0/Bentomux_0.1.0_amd64.AppImage',
  );

  /* install.sh must recover every asset from the emitted JSON alone. */
  const json = renderManifest(manifest);
  for (const [target, asset] of Object.entries(manifest.assets)) {
    const entry = sedExtract(json, target);
    assert.ok(entry, `install.sh sed found no entry for ${target}`);
    assert.ok(entry.includes(`"url":"${asset.url}"`), `install.sh sed lost the url for ${target}`);
    assert.ok(entry.includes(`"sha256":"${asset.sha256}"`), `install.sh sed lost the sha256 for ${target}`);
  }

  const cask = renderCask(manifest, { repo: REPO });
  assert.ok(cask.includes(`sha256 "${dmgSha}"`));
  assert.ok(cask.includes('app "Bentomux.app"'));
  assert.throws(() => renderCask({ version: '0.1.0', assets: {} }, { repo: REPO }));

  console.log('release-manifest selftest: ok');
}

/* ---------------- Tauri updater manifest (updater.json) ----------------
   Tauri updater format: { version, notes, pub_date, platforms: {
     "darwin-aarch64": { url, signature }, ... } }
   .sig files contain the raw minisign signature string. */

/** Map a bundle file basename to Tauri updater platform key(s).
 *  Tauri v2 updater artifacts: macOS .app.tar.gz; Linux AppImage (signed
 *  directly); Windows NSIS setup .exe (signed directly). */
export function updaterPlatforms(file) {
  const name = basename(file);
  // macOS: .app.tar.gz → both arm64 and x86_64 (universal binary covers both)
  if (/\.app\.tar\.gz$/i.test(name)) return ['darwin-aarch64', 'darwin-x86_64'];
  // Linux AppImage
  if (/\.AppImage$/i.test(name)) {
    return [/(aarch64|arm64)/i.test(name) ? 'linux-aarch64' : 'linux-x86_64'];
  }
  // Windows NSIS setup
  if (/setup\.exe$/i.test(name)) {
    return [/(aarch64|arm64)/i.test(name) ? 'windows-aarch64' : 'windows-x86_64'];
  }
  return [];
}

/** Build the updater fragment for one runner's bundle dir. */
export async function buildUpdaterFragment(bundleDir, { repo, tag }) {
  const platforms = {};
  // walk bundleDir recursively for *.sig files next to the artifact they sign
  for await (const sigPath of glob('**/*.sig', { cwd: bundleDir })) {
    const artifactPath = sigPath.slice(0, -4); // strip .sig
    const artifactName = basename(artifactPath);
    const keys = updaterPlatforms(artifactName);
    if (!keys.length) continue;
    const [sig] = await Promise.all([readFile(join(bundleDir, sigPath), 'utf8')]);
    const url = `https://github.com/${repo}/releases/download/${tag}/${artifactName}`;
    for (const key of keys) {
      platforms[key] = { url, signature: sig.trim() };
    }
  }
  return platforms;
}

/** Merge per-runner fragment files into a Tauri updater.json. */
export async function buildUpdaterManifest(fragmentsDir, { tag }) {
  const version = tag.replace(/^v/, '');
  const platforms = {};
  const files = await readdir(fragmentsDir);
  for (const file of files.filter(f => f.endsWith('.json'))) {
    const data = JSON.parse(await readFile(join(fragmentsDir, file), 'utf8'));
    Object.assign(platforms, data);
  }
  return {
    version,
    notes: '',
    pub_date: new Date().toISOString(),
    platforms,
  };
}

function parseArgs(argv) {
  const args = { checksums: [], repo: REPO };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--selftest') args.selftest = true;
    else if (flag === '--tag') { args.tag = value; i += 1; }
    else if (flag === '--checksums') { args.checksums.push(value); i += 1; }
    else if (flag === '--out') { args.out = value; i += 1; }
    else if (flag === '--cask') { args.cask = value; i += 1; }
    else if (flag === '--repo') { args.repo = value; i += 1; }
    else if (flag === '--updater-fragment') { args.updaterFragment = true; }
    else if (flag === '--bundle') { args.bundle = value; i += 1; }
    else if (flag === '--updater-manifest') { args.updaterManifest = true; }
    else if (flag === '--updater-fragments') { args.updaterFragments = value; i += 1; }
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

async function collectChecksums(paths) {
  const entries = [];
  for (const path of paths) {
    const stats = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (stats) {
      for (const entry of stats) {
        if (entry.isFile() && entry.name.endsWith('.sha256')) {
          entries.push(...parseChecksums(await readFile(join(path, entry.name), 'utf8')));
        }
      }
      continue;
    }
    entries.push(...parseChecksums(await readFile(path, 'utf8')));
  }
  return entries;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) {
    selftest();
    return;
  }

  /* --updater-fragment: emit per-runner platform fragment from bundle dir */
  if (args.updaterFragment) {
    if (!args.bundle) throw new Error('--bundle is required with --updater-fragment');
    if (!args.tag) throw new Error('--tag is required with --updater-fragment');
    const fragment = await buildUpdaterFragment(args.bundle, { repo: args.repo, tag: args.tag });
    if (Object.keys(fragment).length === 0) {
      console.log('no updater artifacts found in', args.bundle, '(signing key absent? skipping)');
      return;
    }
    const out = args.out;
    if (out) {
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify(fragment, null, 2) + '\n');
      console.log(`wrote ${out} (${Object.keys(fragment).join(', ')})`);
    } else {
      process.stdout.write(JSON.stringify(fragment, null, 2) + '\n');
    }
    return;
  }

  /* --updater-manifest: merge fragments into Tauri updater.json */
  if (args.updaterManifest) {
    if (!args.updaterFragments) throw new Error('--updater-fragments is required with --updater-manifest');
    if (!args.tag) throw new Error('--tag is required with --updater-manifest');
    const manifest = await buildUpdaterManifest(args.updaterFragments, { tag: args.tag });
    const json = JSON.stringify(manifest, null, 2) + '\n';
    if (args.out) {
      await mkdir(dirname(args.out), { recursive: true });
      await writeFile(args.out, json);
      console.log(`wrote ${args.out} (platforms: ${Object.keys(manifest.platforms).join(', ') || 'none'})`);
    } else {
      process.stdout.write(json);
    }
    return;
  }

  if (!args.tag) throw new Error('--tag is required');
  if (args.checksums.length === 0) throw new Error('--checksums is required');

  const checksums = await collectChecksums(args.checksums);
  if (checksums.length === 0) throw new Error('no checksums found; did the build matrix upload them?');

  const manifest = buildManifest({
    version: args.tag.replace(/^v/, ''),
    tag: args.tag,
    repo: args.repo,
    checksums,
  });
  for (const expected of ['macos', 'linux-x86_64', 'windows-x86_64']) {
    if (!manifest.assets[expected]) {
      console.log(`::warning::manifest has no asset for ${expected}`);
    }
  }

  const json = renderManifest(manifest);
  if (args.out) await writeFile(args.out, json);
  else process.stdout.write(json);

  if (args.cask) {
    await mkdir(dirname(args.cask), { recursive: true });
    await writeFile(args.cask, renderCask(manifest, { repo: args.repo }));
    console.log(`wrote ${args.cask}`);
  }
  if (args.out) console.log(`wrote ${args.out} (${Object.keys(manifest.assets).join(', ')})`);
}

main().catch((error) => {
  console.error(`release-manifest: ${error.message}`);
  process.exit(1);
});
