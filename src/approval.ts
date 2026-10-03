/* ============================================================
   Bentomux — calm desktop for AI agent runtime workspaces.
   Approval overlay page script (approval.html): the always-on-top pill
   shown when a PermissionRequest arrives while Bentomux is not focused.
   Port of the inline <script> from Electron's src/main/overlay.ts.

   The overlay has its OWN webview JS context, so it must import the IPC
   bridge itself, exactly as main.ts does for the main window. It then
   subscribes to the same `agent:approval` and `agent:approvalClosed`
   events the Rust bridge emits, and resolves/denies/jumps via the
   shared bridge methods.
   ============================================================ */

import { getCurrentWindow } from '@tauri-apps/api/window';
import './theme.css';
import { CUSTOM_KEYS, DEFAULT_CUSTOM_PALETTE, PALETTES } from './shared/types';
import type { CustomPalette, Prefs } from './shared/types';
import api from './preload/bentomux';

/* readiness + lifecycle surface in the window title: Rust gates the pill's
   visibility on the READY prefix (overlay.rs), and the suffix makes the
   page's state inspectable from outside while debugging the overlay */
const READY_TITLE = 'bentomux-approval-ready';
let renderSeq = 0;

void getCurrentWindow().setTitle(READY_TITLE).catch(() => {});

/* two-tone chime; subject to prefs.notifSound (rendered via CSS class) —
   recreated to mirror Electron's Web Audio implementation */
function playChime(): void {
  try {
    const Ctor = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      || (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    const note = (freq: number, at: number, dur: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(.16, at + .015);
      g.gain.exponentialRampToValueAtTime(.0001, at + dur);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(at);
      o.stop(at + dur);
    };
    note(880, now + .02, .16);
    note(1318.5, now + .13, .3);
  } catch {
    /* audio unavailable (autoplay policy) — ignore, overlay still usable */
  }
}

/* the island paints with the app's own token layer (theme.css): dark mode,
   the active palette, and the custom-palette source colors are mirrored from
   main.ts so the pill always matches whatever the app is running. */
const CUSTOM_VARS = { bg: '--c-bg', ink: '--c-ink', accent: '--c-accent' } as const;

function applyTheme(prefs: Prefs | undefined): void {
  const root = document.documentElement;
  const theme = prefs?.theme ?? 'system';
  const dark = theme === 'dark'
    || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.toggle('dark', dark);
  const palette = prefs?.palette;
  for (const p of PALETTES) root.classList.remove('palette-' + p);
  const custom: CustomPalette | null = palette === 'custom'
    ? (prefs?.customPalette || DEFAULT_CUSTOM_PALETTE)
    : null;
  for (const k of CUSTOM_KEYS) {
    if (custom) root.style.setProperty(CUSTOM_VARS[k], custom[k]);
    else root.style.removeProperty(CUSTOM_VARS[k]);
  }
  if (palette && palette !== 'default') root.classList.add('palette-' + palette);
}

function syncTheme(): void {
  api.getState()
    .then(s => applyTheme(s.prefs))
    .catch(() => { /* prefs read failure is non-fatal — token fallbacks hold */ });
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  void api.getState().then(s => {
    /* only 'system' follows the OS; explicit light/dark ignore it */
    if ((s.prefs?.theme ?? 'system') === 'system') applyTheme(s.prefs);
  }).catch(() => {});
});

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

let currentRequestId: string | null = null;
let currentPaneId: string | null = null;
let currentCwd: string | null = null;

function render(req: {
  requestId: string;
  paneId?: string | null;
  cwd?: string | null;
  toolName?: string;
  summary?: string;
}): void {
  currentRequestId = req.requestId;
  currentPaneId = req.paneId ?? null;
  currentCwd = req.cwd ?? null;
  const where = req.cwd?.split(/[\\/]/).filter(Boolean).pop() || '';
  const tool = req.toolName || 'Tool';
  const summary = req.summary || '';
  $('#where').textContent = where ? ' · ' + where : '';
  $('#tool').textContent = tool;
  $('#sum').textContent = summary;
  renderSeq += 1;
  void getCurrentWindow()
    .setTitle(READY_TITLE + ' | render#' + renderSeq + ' ' + tool)
    .catch(() => {});
  /* the overlay webview outlives individual requests — re-read prefs so a
     palette/theme switch in the app is picked up by the next pill */
  syncTheme();
  playChime();
}

/* resolved here or elsewhere (native prompt answered, pane died). The pill
   stays up as long as anything is still blocked: fall back to the next
   pending request, and only dismiss when the queue is empty. */
api.onAgentApprovalClosed(id => {
  if (currentRequestId === null || id !== currentRequestId) return;
  void api.approvalPending()
    .then(next => {
      if (next && next.requestId !== id) {
        render(next);
        /* the window may be hidden (post-Jump) — a still-blocked request
           always gets the pill back */
        void getCurrentWindow().show();
      } else {
        void getCurrentWindow()
          .setTitle(READY_TITLE + ' | closed, dismissing')
          .catch(() => {});
        /* window.close() is refused by WebView2 for windows not opened by
           script — ask Rust to destroy this window instead */
        void api.approvalDismiss();
      }
    })
    .catch(() => { void api.approvalDismiss(); });
});

/* any request that arrives renders the island */
api.onAgentApproval(r => {
  render(r);
});
/* A new WebView can miss the event emitted during creation. Replay the
   still-pending request so the message and request id are always populated. */
void api.approvalPending().then(req => {
  if (req && currentRequestId === null) render(req);
}).catch(() => { /* overlay remains usable if the bridge is unavailable */ });

/* apply the persisted theme immediately so the island matches the app */
syncTheme();

$('#approve').addEventListener('click', () => {
  if (!currentRequestId) return;
  /* the closed event that follows picks the next pending or dismisses the
     pill — hiding here would race it and strand the next blocked request */
  void api.resolveApproval(currentRequestId, 'allow').catch(() => {});
});
$('#deny').addEventListener('click', () => {
  if (!currentRequestId) return;
  void api.resolveApproval(currentRequestId, 'deny').catch(() => {});
});
$('#jump').addEventListener('click', () => {
  if (!currentRequestId) return;
  /* agent_approval_jump does the rest on the Rust side: hides this overlay,
     unminimizes/shows/focuses the main window (with a retry once the OS has
     registered it), and emits the jump notice the main renderer navigates
     on. The overlay JS only triggers it — no window dance here, it would
     just race the command's own foregrounding. */
  void api.approvalJump(currentPaneId, currentCwd)
    .catch(() => { void api.hideApproval(); });
});