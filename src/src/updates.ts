/* ---------------- auto-update state + logic ----------------
   Uses tauri-plugin-updater for download/install and
   tauri-plugin-process for restart. Falls back to a release-page
   link when the plugin errors (e.g. macOS without the update key). */

import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { raw } from '../preload/bentomux';

export type UpdatePhase =
  | 'idle'        // no check done yet
  | 'checking'    // check in flight
  | 'current'     // up to date
  | 'available'   // update found, not yet installing
  | 'downloading' // download+install in progress
  | 'ready'       // installed, waiting for restart
  | 'error';      // check or install failed

export interface UpdateStatus {
  phase: UpdatePhase;
  version: string;       // installed version (filled after first getVersion())
  available: string;     // available version tag (when phase === 'available'|'downloading'|'ready')
  notes: string;
  progress: number;      // 0-100 during 'downloading'
  error: string;
  releaseUrl: string;    // fallback link to GitHub release
}

const REPO = 'https://github.com/takora-dev/bentomux';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

export const updateStatus: UpdateStatus = {
  phase: 'idle',
  version: '',
  available: '',
  notes: '',
  progress: 0,
  error: '',
  releaseUrl: REPO + '/releases/latest',
};

const listeners = new Set<() => void>();
export function onUpdateChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notify(): void { listeners.forEach(cb => cb()); }

function set(patch: Partial<UpdateStatus>): void {
  Object.assign(updateStatus, patch);
  notify();
}

let cachedUpdate: Update | null = null;

export async function checkForUpdate(): Promise<void> {
  if (updateStatus.phase === 'checking' || updateStatus.phase === 'downloading') return;

  if (!updateStatus.version) {
    try { set({ version: await getVersion() }); } catch { /* ignore */ }
  }

  set({ phase: 'checking', error: '' });
  try {
    cachedUpdate = await check();
    if (cachedUpdate) {
      set({
        phase: 'available',
        available: cachedUpdate.version,
        notes: cachedUpdate.body ?? '',
        releaseUrl: `${REPO}/releases/tag/v${cachedUpdate.version}`,
      });
    } else {
      set({ phase: 'current' });
    }
  } catch (e) {
    set({ phase: 'error', error: describeCheckError(e) });
  }
}

/* the plugin reports a release with no updater manifest as a transport detail
   ("Could not fetch a valid release JSON from the remote"); say what it means /
   what to do instead of echoing the plugin */
function describeCheckError(e: unknown): string {
  const msg = String(e);
  return /valid release JSON/i.test(msg)
    ? 'no update manifest published for this release - download from the release page'
    : msg;
}

export async function installUpdate(): Promise<void> {
  if (!cachedUpdate) return;
  set({ phase: 'downloading', progress: 0 });
  try {
    let downloaded = 0;
    let total = 0;
    /* download and install are separate calls so the daemon stays alive for
       the whole download: only the install step replaces the binary, and
       killing the pty host before it killed every pane and left every new
       terminal unable to start until the app was restarted. */
    await cachedUpdate.download(event => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0;
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        set({ progress: total > 0 ? Math.round((downloaded / total) * 100) : 0 });
      }
    });
    // release the files the installer cannot overwrite (Windows file locks)
    await raw.invoke('shutdown_for_update').catch(() => {});
    set({ phase: 'ready', progress: 100 });
    await cachedUpdate.install();
  } catch (e) {
    set({ phase: 'error', error: String(e) });
  }
}

export async function restartApp(): Promise<void> {
  await relaunch();
}

let intervalId: ReturnType<typeof setInterval> | null = null;

/** Call on boot. Skips check if autoUpdate pref is off. */
export function initAutoUpdate(autoUpdateEnabled: boolean): void {
  if (intervalId) clearInterval(intervalId);
  if (!autoUpdateEnabled) return;

  void checkForUpdate();
  intervalId = setInterval(() => { void checkForUpdate(); }, CHECK_INTERVAL_MS);
}
