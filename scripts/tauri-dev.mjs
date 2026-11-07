import { spawn } from 'node:child_process';

const command = process.platform === 'win32' ? 'tauri.cmd' : 'tauri';
/* --lean drops debug info and incremental artifacts: target/ stays roughly
halved, at the cost of a coarser backtrace and slower rebuilds */
const lean = process.argv.includes('--lean')
  ? { CARGO_PROFILE_DEV_DEBUG: '0', CARGO_PROFILE_DEV_INCREMENTAL: 'false' }
  : {};
const child = spawn(command, ['dev', '--config', 'src-tauri/tauri.dev.conf.json'], {
  env: { ...process.env, ...lean, BENTOMUX_USER_DATA_SUFFIX: '-dev' },
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`Failed to start Tauri dev: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
