/* ---------------- terminal view (xterm.js over node-pty) ----------------
   Each pane owns a persistent xterm instance living in a parking-lot div;
   switching tabs MOVES the DOM nodes, preserving scrollback and state.
   A tab may hold up to two panes side by side (split view). */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { openUrl } from '@tauri-apps/plugin-opener';
import '@xterm/xterm/css/xterm.css';
import { h, $ } from '../dom';
import { openContextMenu, type MenuEntry } from '../components/menu';
import { emitPaneFocused } from '../main';
import { renderSidebar } from '../render';
import { leafIds, type PaneNode } from '../../shared/split-tree';
import type { FileDropEvent } from '../../shared/types';
import { db } from '../store';
import { xtermTheme } from '../terminal-theme';
import { splitTerminalPane, closeTerminalPane, setNodeDir, syncWorkspaceForPane } from './tabs';
import api from '../../preload/bentomux';

interface Live {
  id: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLElement;
  observer: ResizeObserver | null;
  lastCols: number;
  lastRows: number;
  /* how many times the daemon was asked to match this pane's grid, and the
     grid it last reported. Both drive reconcileGrid(). */
  gridRetries: number;
  daemonRows: number;
  daemonCols: number;
  /* the daemon does not own this pane (a stale tab after a restart): it can
     never be resized or replayed, so stop asking */
  gone: boolean;
}

const lives = new Map<string, Live>();
const pending = new Map<string, string>();
const lastFocus = new Map<string, number>();
const outputQueue = new Map<Live, string>();
let outputFrame: number | null = null;
let outputTimer: number | null = null;

/* xterm parses asynchronously and only calls a write's callback once the chunk
   is through the parser. A pane whose oldest chunk has been outstanding this
   long has a parser that stopped: its screen and its byte stream no longer
   agree, so it gets replayed from the daemon instead of rendering over a hole. */
const WRITE_STALL_MS = 8000;
/* how often the stall watchdog looks at the panes it is watching */
const WRITE_WATCHDOG_MS = 1000;
let writeWatchdog: number | null = null;
const stalledSince = new Map<string, number>();

/* Output for a pane that is not mounted yet (its workspace is not the active
   one) is buffered until it mounts. Without a cap a busy agent in a
   background workspace grows that string forever; keep the tail, which is
   what the screen shows. */
const PENDING_MAX = 256 * 1024;
/* A frame for a visible pane past this size is written immediately instead of
   waiting for the next rAF. The queue holds that pane's bytes in order and
   nothing moved on without them, so a big frame costs latency and never
   correctness — replaying the daemon's screen over it would trade a slow frame
   for a full-screen repaint, and every repaint is another chance for the pane
   and the daemon to disagree. */
const PTY_FRAME_MAX = 512 * 1024;
/* how long a queued frame may wait for rAF before a timer drains it */
const PTY_FLUSH_FALLBACK_MS = 32;

/* Panes whose buffered output was dropped for size. The daemon owns the
   authoritative vt100 screen for every pane, so a pane in this set asks for a
   formatted replay when it mounts instead of guessing from a truncated tail. */
const resyncNeeded = new Set<string>();

function bufferPending(id: string, chunk: string): void {
  const buf = (pending.get(id) || '') + chunk;
  if (buf.length > PENDING_MAX) {
    /* A truncated tail cannot be replayed safely. It starts mid-escape and
       lands on top of a screen that has scrolled on without it, so the pane
       rendered whatever half-sequence happened to survive — the garbled text
       users see after leaving an agent running in a background tab. Drop the
       bytes and let the daemon replay the real screen on mount. */
    pending.delete(id);
    resyncNeeded.add(id);
    return;
  }
  pending.set(id, buf);
}
/* per-axis divider position within a session ('%' of the axis) */
const ratioByNode = new Map<string, number>();
let parking: HTMLElement;

const MIN_RATIO_PCT = 15;
const MAX_RATIO_PCT = 85;
const FOCUS_TOGGLE_SELECTOR = '.workspace-child[data-pane]';

/* POSIX single-quote escaping (same rules as Python's shlex.quote): keeps
   spaces, quotes, `$`, backticks and globs in a path from being re-read by
   the shell once we type the path into the PTY. */
function quotePath(path: string): string {
  return /[^\w@%+=:,./-]/.test(path) ? "'" + path.replace(/'/g, "'\\''") + "'" : path;
}

function writePaths(tabId: string, paths: string[]): void {
  api.writeTab(tabId, paths.map(quotePath).join(' '));
}

/* re-theme every live terminal in place — palette and custom-color changes
   repaint the stylesheet without a full render() */
export function applyTerminalTheme(): void {
  if (!lives.size) return;
  const theme = xtermTheme() as never;
  for (const live of lives.values()) live.term.options.theme = theme;
}

function monoFont(): string {
  const pref = db.prefs.font;
  if (pref) return pref;
  /* SF Mono/Menlo guaranteed on macOS with box-drawing support.
     ui-monospace can resolve to proportional fonts (Verdana) → skip it */
  const fallback = '"SF Mono", Menlo, Monaco, Consolas, "Courier New", monospace';
  return fallback;
}

/* One place decides whether the PTY hears about a grid size. Both the refit
   path and xterm's own onResize land here, and the last-sent grid is the gate:
   notifying twice resizes the pty twice, and a TUI answers every resize with a
   full redraw — which is what flickers while an agent streams. */
function notifyResize(live: Live): void {
  if (live.term.cols === live.lastCols && live.term.rows === live.lastRows) return;
  live.lastCols = live.term.cols;
  live.lastRows = live.term.rows;
  api.resizeTab(live.id, live.lastCols, live.lastRows);
}

function refitTerminal(live: Live, notifyPty = false): void {
  if (!live.host.isConnected || parking.contains(live.host)) return;
  try {
    /* FitAddon floors its proposal at one row and two columns. A pane that
       is momentarily shorter than a single cell (first mount, a split being
       dragged, a window restore) would otherwise resize the grid to one row:
       the app reflows its entire screen into that row and the backend parser
       drops below the smallest grid vt100 survives. Keep the last good grid
       and wait for a real one. */
    const proposal = live.fit.proposeDimensions();
    if (!proposal || proposal.rows < 2) return;
    /* fit() clears the renderer before it compares sizes, so calling it on a
       grid that already matches still repaints every cell. ResizeObserver
       fires on every layout pass — and a sidebar status tick is a layout
       pass — so an unconditional fit() flickers the pane once a second while
       an agent works. Only resize when the proposal really differs. */
    if (proposal.cols !== live.term.cols || proposal.rows !== live.term.rows) {
      live.fit.fit();
    }
    if (notifyPty) notifyResize(live);
  } catch {
    /* terminal may be between tab mounts */
  }
}

/* both flush triggers are armed together and disarmed together, so one frame
   is never written twice */
function disarmFlush(): void {
  if (outputFrame !== null) {
    cancelAnimationFrame(outputFrame);
    outputFrame = null;
  }
  if (outputTimer !== null) {
    clearTimeout(outputTimer);
    outputTimer = null;
  }
}

function armFlush(): void {
  if (outputFrame !== null || outputTimer !== null) return;
  outputFrame = requestAnimationFrame(flushTerminalOutput);
  /* rAF is throttled to nothing in an occluded or minimized window even
     though visibilityState still reads 'visible'. Without this the queue
     only drains when the window comes back, which is the freeze-then-dump
     the user sees. */
  outputTimer = window.setTimeout(flushTerminalOutput, PTY_FLUSH_FALLBACK_MS);
}

function flushTerminalOutput(): void {
  disarmFlush();
  for (const [live, output] of outputQueue) {
    /* host detached between enqueue and frame: keep the bytes for the next
       mount instead of dropping them (dropped escape state can leave the
       pane blank while the shell is still running) */
    if (!live.host.isConnected || parking.contains(live.host)) {
      bufferPending(live.id, output);
      continue;
    }
    writeToTerminal(live, output);
  }
  outputQueue.clear();
}

/* Hand one chunk to xterm and put the pane on the stall watch.

   Two failures live here and only one of them can be caught. When xterm's own
   write buffer is past its flow-control ceiling, `write()` throws outright and
   the bytes are discarded — that is the catch below. When the *parser* throws,
   xterm rethrows it on a microtask far from this stack, skips the chunk's
   callback, and carries on writing every later byte into a screen that is one
   frame of escape state short. The callback is the only receipt we get, so a
   receipt that never arrives is what the watchdog looks for. */
function writeToTerminal(live: Live, output: string): void {
  if (!stalledSince.has(live.id)) stalledSince.set(live.id, Date.now());
  armWriteWatchdog();
  try {
    live.term.write(output, () => {
      /* any receipt proves the parser is still moving through this pane's
         stream, which is all the watchdog needs to know */
      stalledSince.delete(live.id);
    });
  } catch {
    stalledSince.delete(live.id);
    dropAndResync(live);
  }
}

function armWriteWatchdog(): void {
  if (writeWatchdog !== null) return;
  writeWatchdog = window.setInterval(() => {
    if (!stalledSince.size) {
      if (writeWatchdog !== null) window.clearInterval(writeWatchdog);
      writeWatchdog = null;
      return;
    }
    const now = Date.now();
    for (const [id, since] of stalledSince) {
      if (now - since < WRITE_STALL_MS) continue;
      stalledSince.delete(id);
      const live = lives.get(id);
      if (!live) continue;
      console.error('[terminal] pane stopped parsing its output, replaying screen:', id);
      dropAndResync(live);
    }
  }, WRITE_WATCHDOG_MS);
}

/* this pane's local bytes can no longer be trusted: throw them away and let
   the daemon replay its authoritative screen */
function dropAndResync(live: Live): void {
  pending.delete(live.id);
  /* a pane on screen has no mount coming, so ask for the replay now. The
     replay opens with a screen clear and a DEC-state reset (terminal.rs
     state_formatted), so it repaints over whatever partial frame is showing
     and takes the pane's leftover charsets and scroll region with it — and
     unlike term.reset() it leaves the pane's input and resize handlers intact. */
  if (live.host.isConnected && !parking.contains(live.host)) {
    api.attachTab(live.id);
  } else {
    resyncNeeded.add(live.id);
  }
}

function writeTerminalOutput(live: Live, chunk: string): void {
  /* requestAnimationFrame does not run while the window is hidden or
     minimized, so queueing behind it during a background run grows the string
     until the window comes back — and then one enormous write blocks the
     parser: the pane sits frozen and then dumps everything at once. Buffer
     through the capped path instead, which is exactly what it exists for. */
  if (document.visibilityState === 'hidden') {
    bufferPending(live.id, chunk);
    return;
  }
  const queued = (outputQueue.get(live) || '') + chunk;
  outputQueue.set(live, queued);
  if (queued.length > PTY_FRAME_MAX) {
    flushTerminalOutput();
    return;
  }
  armFlush();
}

function repaintTerminals(): void {
  if (document.visibilityState !== 'visible') return;
  requestAnimationFrame(() => {
    for (const live of lives.values()) {
      /* output that arrived while the window was hidden went to the capped
         buffer (rAF does not run there); mount it now or the pane shows a
         screen that stopped updating the moment the user looked away */
      if (live.host.isConnected && !parking.contains(live.host)) {
        /* this pane overflowed its buffer while hidden: the daemon's replay is
           the only truthful screen left, and the pane is on screen to take it */
        if (resyncNeeded.delete(live.id)) {
          pending.delete(live.id);
          api.attachTab(live.id);
        } else {
          const buffered = pending.get(live.id);
          if (buffered) {
            pending.delete(live.id);
            writeTerminalOutput(live, buffered);
          }
        }
      }
      refitTerminal(live);
    }
  });
}

const DEFAULT_TERM_FONT_SIZE = 12.5;

function termFontSize(): number {
  return db.prefs.fontSize || DEFAULT_TERM_FONT_SIZE;
}

/* push prefs font onto every live terminal, including parked panes */
export function applyTerminalFont(): void {
  for (const live of lives.values()) {
    live.term.options.fontFamily = monoFont();
    live.term.options.fontSize = termFontSize();
    /* cell metrics changed; refit so lines fill the pane again.
       Parked hosts have no layout, so fit() would throw. */
    refitTerminal(live, true);
  }
}

/* ---------------- grid reconciliation ----------------

   A resize is a request, not a command: the daemon clamps it to 2x2 and drops
   it silently for an id it does not have. Until it answers with the grid it
   actually applied, the renderer cannot tell "landed" from "ignored", and a
   pane drawing at 100 cols into a pty reflowing at 80 renders every line of a
   TUI in the wrong place. The daemon now echoes the applied grid; this is the
   other half — ask again when it disagrees, then draw at the pty's size. */
function reconcileGrid(live: Live, rows: number, cols: number): void {
  if (rows < 2 || cols < 2) return;
  live.daemonRows = rows;
  live.daemonCols = cols;
  if (live.term.rows === rows && live.term.cols === cols) {
    live.gridRetries = 0;
    return;
  }
  if (live.gridRetries < 3) {
    live.gridRetries += 1;
    live.lastCols = live.term.cols;
    live.lastRows = live.term.rows;
    api.resizeTab(live.id, live.lastCols, live.lastRows);
    return;
  }
  /* three requests and the daemon still runs a different grid: stop fighting
     it. Draw at the pty's size so the pane and the shell agree, even if the
     text area shrinks — a slightly smaller pane beats every line misplaced. */
  console.warn(
    '[terminal] daemon grid does not match the pane, drawing at the pty size:',
    live.id, { daemon: [cols, rows], pane: [live.term.cols, live.term.rows] },
  );
  live.gridRetries = 0;
  /* set the sent grid first so the onResize this triggers does not bounce a
     fourth request back at the daemon */
  live.lastCols = cols;
  live.lastRows = rows;
  try { live.term.resize(cols, rows); } catch { /* pane between mounts */ }
}

export function initTerminalEvents(): void {
  parking = $('#termParking');
  window.addEventListener('focus', repaintTerminals);
  document.addEventListener('visibilitychange', repaintTerminals);
  api.onPtyData((id, chunk) => {
    const live = lives.get(id);

    if (
      live &&
      live.host.isConnected &&
      live.host.parentElement &&
      !parking.contains(live.host)
    ) {
      /* Batch PTY chunks before xterm parses them. Busy agents often emit many
         small chunks; one write per frame avoids repeated parser overhead. */
      writeTerminalOutput(live, chunk);
    } else {
      bufferPending(id, chunk);
    }
  });
  api.onPtyExit((id, _code) => {
    /* keep the dead shell visible until the user closes the pane/tab */
    const live = lives.get(id);
    if (live) live.term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n');
  });
  /* the grid the daemon actually applied — see reconcileGrid */
  api.onPtyGrid((id, rows, cols) => {
    const live = lives.get(id);
    if (live) reconcileGrid(live, rows, cols);
  });
  api.onPtyGridGone(id => {
    const live = lives.get(id);
    if (!live || live.gone) return;
    /* the daemon has no such pane: resize and replay are both no-ops there, so
       stop asking and keep whatever the pane already shows */
    live.gone = true;
    console.warn('[terminal] pane is not running in the pty daemon:', id);
  });
  api.onFileDrop(handleFileDrop);
}
function createXterm(tabId: string): { term: Terminal; fit: FitAddon; host: HTMLElement } {
  const fontFamily = monoFont();
  const fontSize = termFontSize();
  const term = new Terminal({
    theme: xtermTheme(),
    fontFamily,
    fontSize,
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    letterSpacing: 0,
    cursorBlink: false,
    allowProposedApi: true,
    /* the workspace wallpaper (html.bg-content) shows through the pane, so
       the renderer must accept a transparent theme background; with no
       wallpaper the theme keeps an opaque color and nothing changes */
    allowTransparency: true,
    scrollback: 1000,
    fastScrollSensitivity: 10,
    /* apps emit truecolor that assumes a dark canvas; on light backgrounds
       plain white must darken rather than vanish into the page */
    minimumContrastRatio: 3,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_, uri) => {
    try {
      const url = new URL(uri);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      void openUrl(url).catch(error => {
        console.error('[terminal] failed to open link:', error);
      });
    } catch (error) {
      console.error('[terminal] invalid link:', error);
    }
  }));
  const host = h('div', { class: 'terminal-host', 'data-tab-id': tabId });

  // MUST call term.open() before term.element is available
  term.open(host);

  wireXtermEvents(term, tabId);
  wireFocusIn(host, tabId);
  const result = { term, fit, host };
  return result;
}

function wireXtermEvents(term: Terminal, tabId: string): void {
  term.attachCustomKeyEventHandler(e => {
    /* Ctrl+C / Cmd+C dengan selection aktif → copy; tanpa selection → biarkan SIGINT lewat */
    const isCopy = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && term.hasSelection();
    if (isCopy) {
      const sel = term.getSelection();
      if (sel) {
        e.preventDefault();
        void navigator.clipboard.writeText(sel);
        term.clearSelection();
      }
      return false;
    }
    /* Cmd/Ctrl+Home → scroll to top instantly */
    if ((e.metaKey || e.ctrlKey) && e.key === 'Home' && e.type === 'keydown') {
      e.preventDefault();
      term.scrollToTop();
      return false;
    }
    /* Cmd/Ctrl+End → scroll to bottom instantly */
    if ((e.metaKey || e.ctrlKey) && e.key === 'End' && e.type === 'keydown') {
      e.preventDefault();
      term.scrollToBottom();
      return false;
    }
    /* Shift+Enter → send a literal newline (\n) instead of the carriage
       return Enter sends, so AI CLIs insert a new line instead of submitting.
       xterm calls this handler for keydown *and* keypress, and its keypress
       path derives '\r' from the Enter charCode: block both, but write once. */
    if (e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      if (e.type === 'keydown') api.writeTab(tabId, '\n');
      return false;
    }
    return true;
  });
  term.onData(d => api.writeTab(tabId, d));
  term.onResize(() => {
    const live = lives.get(tabId);
    if (live) notifyResize(live);
  });
  wireClipboardPaste(term, tabId);
}

/* Cmd+V of an image or a file → stage the bytes in the temp dir and type the
   resulting absolute path into the PTY. A WebView exposes no filesystem path
   for clipboard files, so without this the terminal only ever received the
   bare name ("image.png"). Plain text falls through to xterm's own paste. */
function wireClipboardPaste(term: Terminal, tabId: string): void {
  const textarea = term.textarea;
  if (!textarea) return;
  textarea.addEventListener('paste', e => {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = Array.from(cd.files);
    if (!files.length) {
      for (const item of Array.from(cd.items)) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    void Promise.all(files.map(stageClipboardFile)).then(paths => writePaths(tabId, paths));
  });
}

/* resolves with the temp path, or with the clipboard's own file name when the
   blob cannot be read — a bare name beats writing nothing at all */
function stageClipboardFile(file: File): Promise<string> {
  const name = file.name || 'paste.png';
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onerror = () => resolve(name);
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      resolve(api.saveTempFile(name, b64).catch(() => name));
    };
    reader.readAsDataURL(file);
  });
}

function markFocusedPane(host: HTMLElement, tabId: string): void {
  const pane = host.closest('.pane');
  if (pane) {
    for (const el of document.querySelectorAll('.pane.focused')) el.classList.remove('focused');
    pane.classList.add('focused');
    /* the class above is the only record of pane focus, and a plugin watching
       `tab:activated` needs to know which pane is on screen */
    emitPaneFocused(tabId);
  }
  /* keep the sidebar's per-pane item in step without a re-render */
  for (const el of document.querySelectorAll(FOCUS_TOGGLE_SELECTOR)) {
    el.classList.toggle('active', el.getAttribute('data-pane') === tabId);
  }
  /* focusing a pane makes its workspace the active one, so the Changes pill,
     the rail, and an open Git panel follow the shell the user is looking at
     even when the marker went stale through a path that skipped activate() */
  if (syncWorkspaceForPane(tabId)) renderSidebar();
}

/* xterm has no public focus event; its hidden textarea bubbles focusin */
function wireFocusIn(host: HTMLElement, tabId: string): void {
  host.addEventListener('focusin', () => {
    lastFocus.set(tabId, Date.now());
    markFocusedPane(host, tabId);
  });
}

/* Tauri hands the whole window's OS drops to one webview event, so pick the
   pane under the cursor ourselves. `x`/`y` arrive as CSS pixels. A drop aimed
   at a divider, a gutter, or a point a few pixels off (the position mapping
   is not testable here) still targets the pane the pointer last resolved to. */
let lastDropHost: HTMLElement | null = null;

function clearDropHighlight(): void {
  for (const el of document.querySelectorAll('.terminal-host.drop-active')) el.classList.remove('drop-active');
}

function handleFileDrop(e: FileDropEvent): void {
  clearDropHighlight();
  if (e.type === 'leave') {
    lastDropHost = null;
    return;
  }
  const hit = document.elementFromPoint(e.x, e.y)?.closest('.terminal-host') as HTMLElement | null;
  if (hit) lastDropHost = hit;
  const host = hit ?? lastDropHost;
  if (e.type !== 'drop') {
    host?.classList.add('drop-active');
    return;
  }
  const tabId = host?.dataset.tabId;
  if (tabId && e.paths.length) writePaths(tabId, e.paths);
}

function ensureLive(tabId: string): Live {
  let live = lives.get(tabId);
  if (!live) {
    const { term, fit, host } = createXterm(tabId);
    live = {
      id: tabId,
      term,
      fit,
      host,
      observer: null,
      lastCols: 0,
      lastRows: 0,
      gridRetries: 0,
      daemonRows: 0,
      daemonCols: 0,
      gone: false,
    };
    lives.set(tabId, live);
  }
  return live;
}

export function clearTerminalSelections(): void {
  for (const live of lives.values()) live.term.clearSelection();
  document.getSelection()?.removeAllRanges();
}

export function disposeTerminal(tabId: string): void {
  const live = lives.get(tabId);
  if (!live) return;
  if (live.observer) live.observer.disconnect();
  try { live.term.dispose(); } catch { /* already gone */ }
  pending.delete(tabId);
  resyncNeeded.delete(tabId);
  outputQueue.delete(live);
  stalledSince.delete(tabId);
  lastFocus.delete(tabId);
  lives.delete(tabId);
}

function observe(container: HTMLElement, live: Live): void {
  requestAnimationFrame(() => {
    if (live.observer) live.observer.disconnect();
    live.observer = new ResizeObserver(() => {
      requestAnimationFrame(() => refitTerminal(live, true));
    });
    live.observer.observe(container);
    try {
      /* xterm does not emit resize when restored dimensions already match;
         still notify the persistent PTY so TUI apps redraw after reconnect. */
      refitTerminal(live, true);
    } catch {
      /* tiny container on first paint */
    }
  });
}

/* the pane the user worked in most recently (default: the first) */
export function mostRecentPane(ids: string[]): string {
  return [...ids].sort((x, y) => (lastFocus.get(y) || 0) - (lastFocus.get(x) || 0))[0] || ids[0];
}

/* a sidebar item picked this pane: make it the focus target on next mount */
export function primePaneFocus(paneId: string): void {
  lastFocus.set(paneId, Date.now());
}

/* move focus to a specific pane of the active tab (keyboard focus actions) */
export function focusPane(paneId: string): void {
  lastFocus.set(paneId, Date.now());
  const live = lives.get(paneId);
  if (live) { try { live.term.focus(); } catch { /* pane gone */ } }
}

/* cycle focus through the tab's panes in creation order (Ghostty's
   goto_split:previous / :next) */
export function focusRelativePane(ids: string[], dir: -1 | 1): void {
  if (ids.length < 2) return;
  const current = mostRecentPane(ids);
  const idx = ids.indexOf(current);
  const next = ids[(idx + dir + ids.length) % ids.length];
  if (next) focusPane(next);
}

/* move focus to the nearest pane in a screen direction (Ghostty/iTerm2's
   directional split navigation). Panes are laid out by flexbox, so the
   geometry is read from the DOM: pick the pane whose centre lies in the
   requested direction and is closest, penalising off-axis drift so a pane
   straight ahead beats one that is only diagonally over. */
export function focusPaneInDirection(ids: string[], dir: 'left' | 'right' | 'up' | 'down'): void {
  if (ids.length < 2) return;
  const current = mostRecentPane(ids);
  const curEl = document.querySelector(`.pane[data-pane="${CSS.escape(current)}"]`);
  if (!curEl) return;
  const cur = curEl.getBoundingClientRect();
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;
  const horizontal = dir === 'left' || dir === 'right';
  const sign = dir === 'left' || dir === 'up' ? -1 : 1;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const id of ids) {
    if (id === current) continue;
    const el = document.querySelector(`.pane[data-pane="${CSS.escape(id)}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    const primary = horizontal ? dx : dy;
    const secondary = horizontal ? dy : dx;
    if (Math.sign(primary) !== sign || primary === 0) continue;
    const score = Math.abs(primary) + Math.abs(secondary) * 2;
    if (score < bestScore) { bestScore = score; best = id; }
  }
  if (best) focusPane(best);
}

/* drop a remembered divider position so that axis returns to 50/50 */
export function resetPaneRatio(nodeKey: string): void {
  ratioByNode.delete(nodeKey);
  savePaneRatios();
}

/* divider positions survive a relaunch: they are persisted per axis key in
prefs.paneRatios and re-applied by mountAxis when the tree is built */
export function seedPaneRatios(saved: Record<string, number> | undefined): void {
  for (const [key, pct] of Object.entries(saved ?? {})) {
    if (typeof pct === 'number' && Number.isFinite(pct)) ratioByNode.set(key, clampRatio(pct));
  }
}

/* one write per interaction (not per pointermove); the backend debounces the
actual disk write */
function savePaneRatios(): void {
  const ratios: Record<string, number> = {};
  for (const [key, pct] of ratioByNode) ratios[key] = Math.round(pct * 100) / 100;
  db.prefs.paneRatios = ratios;
  void api.setPrefs({ paneRatios: ratios });
}

/* draggable boundary between two branches; ResizeObservers refit both sides.
   Position is remembered per axis for the session. */
function wireDivider(divider: HTMLElement, first: HTMLElement, axis: HTMLElement, stacked: boolean, key: string): void {
  let dragging = false;
  const dragClass = stacked ? 'resizing-stacked' : 'resizing-panes';
  divider.addEventListener('pointerdown', e => {
    dragging = true;
    divider.setPointerCapture(e.pointerId);
    document.body.classList.add(dragClass);
  });
  divider.addEventListener('pointermove', e => {
    if (!dragging) return;
    applyDividerPosition(e, axis, first, stacked, key);
  });
  const stop = (): void => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove(dragClass);
    savePaneRatios();
  };
  divider.addEventListener('pointerup', stop);
  divider.addEventListener('pointercancel', stop);
}

function applyDividerPosition(e: PointerEvent, axis: HTMLElement, first: HTMLElement, stacked: boolean, key: string): void {
  const r = axis.getBoundingClientRect();
  const pos = stacked ? e.clientY - r.top : e.clientX - r.left;
  const span = stacked ? r.height : r.width;
  if (span <= 0) return;
  const pct = clampRatio((pos / span) * 100);
  first.style.flex = '0 0 ' + pct + '%';
  ratioByNode.set(key, pct);
}

function clampRatio(pct: number): number {
  return Math.max(MIN_RATIO_PCT, Math.min(MAX_RATIO_PCT, pct));
}

function paneMenu(e: MouseEvent, ids: string[]): void {
  const paneEl = (e.target as HTMLElement).closest('.pane');
  const targetId = paneEl?.getAttribute('data-pane') || ids[0];
  const entries: MenuEntry[] = [
    { label: 'Split right', action: () => void splitTerminalPane(targetId, 'v') },
    { label: 'Split left', action: () => void splitTerminalPane(targetId, 'v', true) },
    { label: 'Split down', action: () => void splitTerminalPane(targetId, 'h') },
    { label: 'Split up', action: () => void splitTerminalPane(targetId, 'h', true) },
  ];
  if (ids.length > 1) entries.push({ label: 'Close pane', action: () => void closeTerminalPane(targetId) });
  openContextMenu(e.clientX, e.clientY, entries);
}

function dividerMenu(e: MouseEvent, key: string, dir: 'v' | 'h'): void {
  openContextMenu(e.clientX, e.clientY, [
    { label: dir === 'v' ? 'Switch to stacked' : 'Switch to side by side', action: () => setNodeDir(key, dir === 'v' ? 'h' : 'v') },
  ]);
}

/* build the DOM for one tree node; leaves host their xterm instance */
function mountAxis(parent: HTMLElement, node: PaneNode): HTMLElement {
  if (node.kind === 'leaf') {
    const live = ensureLive(node.id);
    const pane = h('div', { class: 'pane', 'data-pane': node.id });
    parent.append(pane);
    pane.append(live.host); /* moves out of the parking lot */
    observe(pane, live);
    return pane;
  }
  const axis = h('div', { class: 'split-axis' + (node.dir === 'h' ? ' stacked' : '') });
  parent.append(axis);
  const first = mountAxis(axis, node.first);
  const divider = h('div', { class: 'pane-divider', title: 'Drag to resize · right-click to switch direction' });
  divider.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    dividerMenu(e, node.key, node.dir);
  });
  axis.append(divider);
  mountAxis(axis, node.second);
  const saved = ratioByNode.get(node.key);
  if (saved != null) first.style.flex = '0 0 ' + saved + '%';
  wireDivider(divider, first, axis, node.dir === 'h', node.key);
  return axis;
}

export function terminalPage(start: PaneNode | string): HTMLElement {
  try {
    const root = h('div', { class: 'terminal-page' });
    const body = h('div', { class: 'mux-body' + (typeof start === 'string' ? '' : ' split') });
    root.append(body);

    const ids = typeof start === 'string' ? [start] : leafIds(start);
    const pageLives = ids.map(id => ensureLive(id));

    /* refresh palette in case the theme toggled since creation */
    for (const live of pageLives) {
      live.term.options.theme = xtermTheme() as never;
      live.term.options.fontFamily = monoFont();
    }

    if (typeof start === 'string') {
      body.append(pageLives[0].host); /* moves out of the parking lot */
      observe(body, pageLives[0]);
    } else {
      mountAxis(body, start);
    }

    for (const id of ids) {
      const live = lives.get(id);
      if (!live) continue;
      /* this pane's buffered output was dropped for size: the daemon replays
         its authoritative screen, which beats writing a truncated tail onto a
         screen that moved on without it */
      if (resyncNeeded.delete(id)) {
        pending.delete(id);
        api.attachTab(id);
        continue;
      }
      const buffered = pending.get(id);
      if (buffered) {
        pending.delete(id);
        writeTerminalOutput(live, buffered);
      }
    }

    const focusLive = lives.get(mostRecentPane(ids));
    if (focusLive) {
      requestAnimationFrame(() => {
        try { focusLive.term.focus(); } catch { /* pane gone */ }
      });
    }

    root.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      paneMenu(e, ids);
    });

    return root;
  } catch (error) {
    console.error('[terminalPage] Error creating terminal:', error);
    const errorDiv = h('div', { class: 'page' }, h('p', {}, 'Terminal error: ' + (error instanceof Error ? error.message : String(error))));
    return errorDiv;
  }
}
