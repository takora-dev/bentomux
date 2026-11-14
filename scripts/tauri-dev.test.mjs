import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

for (const { name, args, exitCode } of [
  { name: 'default', args: [], exitCode: 0 },
  { name: 'lean', args: ['--lean'], exitCode: 0 },
  { name: 'CLI failure', args: [], exitCode: 7 },
]) {
  test(`Tauri dev launcher: ${name}`, (t) => {
    // Spaces exercise Windows path handling; the fixture avoids starting Cargo/Vite.
    const root = mkdtempSync(join(tmpdir(), 'bentomux tauri dev '));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const cliDir = join(root, 'node_modules', '@tauri-apps', 'cli');
    mkdirSync(cliDir, { recursive: true });
    copyFileSync(new URL('./tauri-dev.mjs', import.meta.url), join(root, 'tauri-dev.mjs'));
    writeFileSync(join(cliDir, 'tauri.js'), `
      console.log(JSON.stringify({
        args: process.argv.slice(2),
        suffix: process.env.BENTOMUX_USER_DATA_SUFFIX,
        debug: process.env.CARGO_PROFILE_DEV_DEBUG,
        incremental: process.env.CARGO_PROFILE_DEV_INCREMENTAL,
      }));
      process.exit(Number(process.env.TAURI_TEST_EXIT_CODE));
    `);

    const result = spawnSync(process.execPath, [join(root, 'tauri-dev.mjs'), ...args], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        BENTOMUX_USER_DATA_SUFFIX: '-should-be-overridden',
        CARGO_PROFILE_DEV_DEBUG: '2',
        CARGO_PROFILE_DEV_INCREMENTAL: 'true',
        TAURI_TEST_EXIT_CODE: String(exitCode),
      },
    });

    assert.ifError(result.error);
    assert.equal(result.status, exitCode, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ['dev', '--config', 'src-tauri/tauri.dev.conf.json'],
      suffix: '-dev',
      debug: args.includes('--lean') ? '0' : '2',
      incremental: args.includes('--lean') ? 'false' : 'true',
    });
  });
}
