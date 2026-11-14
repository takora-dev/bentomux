/* ---------------- diff page (full-width text-editor view) ----------------
   Renders a unified diff as a 4-column grid: old-line-number, new-line-number,
   sign (+/-/space), code. Per-line background colors flag additions (green
   tint), deletions (red tint), and hunk headers (italic on surface). Loads
   the diff via the existing `git:diff` IPC; no new main-side work. */

import { h } from '../dom';
import { closeTab } from './tabs';
import { go } from '../router';
import { ui } from '../state';
import type { GitFileDiff } from '../../shared/types';
import { detectLang } from './highlight/lang';
import { tokenize } from './highlight/tokenize';
import api from '../../preload/bentomux';

type LineKind = 'add' | 'del' | 'ctx' | 'hunk';

interface ParsedLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const SIGN_ADD = '+';
const SIGN_DEL = '-';
const SIGN_CTX = ' ';

/* parse a unified diff into typed lines. Each row carries both line numbers
   so the gutter can render old/new side by side. The hunk header itself
   becomes a `hunk` row that spans all 4 columns (oldNo/newNo ignored). */
function parseUnifiedDiff(patch: string): ParsedLine[] {
  const lines = patch.split(/\r?\n/);
  const out: ParsedLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of lines) {
    if (raw.startsWith('diff --git ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      /* file-level headers — skip; we render the path in the page header. */
      continue;
    }
    const m = HUNK_RE.exec(raw);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      inHunk = true;
      out.push({ kind: 'hunk', oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (!inHunk) continue; /* skip anything before the first @@ */
    if (raw.startsWith('\\ No newline')) continue; /* meta line, no row */
    if (raw.length === 0) continue; /* trailing blank line from split */

    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === SIGN_ADD) {
      out.push({ kind: 'add', oldNo: null, newNo: newLine, text });
      newLine++;
    } else if (sign === SIGN_DEL) {
      out.push({ kind: 'del', oldNo: oldLine, newNo: null, text });
      oldLine++;
    } else if (sign === SIGN_CTX) {
      out.push({ kind: 'ctx', oldNo: oldLine, newNo: newLine, text });
      oldLine++;
      newLine++;
    } else {
      /* "\ " or other meta — skip */
    }
  }
  return out;
}

function lineRow(l: ParsedLine, lang: ReturnType<typeof detectLang>): HTMLElement {
  const klass = 'diff-line diff-' + l.kind;
  const gutter = (n: number | null): HTMLElement => h('span', { class: 'gutter' }, n === null ? '' : String(n));
  const sign = l.kind === 'hunk' ? '' : (l.kind === 'add' ? SIGN_ADD : l.kind === 'del' ? SIGN_DEL : SIGN_CTX);
  return h('div', { class: klass },
    gutter(l.oldNo),
    gutter(l.newNo),
    h('span', { class: 'sign' }, sign),
    codeCell(l, lang));
}

/* render the code cell with per-token spans. h() escapes strings, so this
   is XSS-safe even when diff content is untrusted source. Hunk headers and
   unknown languages fall through to a single text span.

   The cell renders plain text synchronously, then asynchronously swaps in
   the highlighted token spans once Shiki has tokenized. This keeps the
   initial paint fast even for large diffs — the user sees a wall of
   monospace text appear immediately and tokens fade in as they resolve. */
function codeCell(l: ParsedLine, lang: ReturnType<typeof detectLang>): HTMLElement {
  const text = l.text || ' ';
  const cell = h('span', { class: 'code' }, text);
  if (l.kind === 'hunk' || !lang) return cell;

  void (async () => {
    let tokens: Awaited<ReturnType<typeof tokenize>>;
    try {
      tokens = await tokenize(text, lang);
    } catch {
      return; /* leave plain text in place on error */
    }
    if (!tokens.length || !cell.isConnected) return;
    cell.textContent = '';
    let cursor = 0;
    for (const t of tokens) {
      if (t.start > cursor) cell.append(text.slice(cursor, t.start));
      cell.append(h('span', { class: 'syn-' + t.kind }, text.slice(t.start, t.end)));
      cursor = t.end;
    }
    if (cursor < text.length) cell.append(text.slice(cursor));
  })();

  return cell;
}

function buildHeader(filePath: string, onBack: () => void): HTMLElement {
  return h('div', { class: 'page-head diff-head' },
    h('button', { class: 'btn ghost back-btn', type: 'button', onclick: onBack, 'aria-label': 'Back', title: 'Back' },
      h('span', { style: 'font-size:14px' }, '←')),
    h('div', { class: 'grow' },
      h('h1', { class: 'pg diff-path', title: filePath }, filePath),
      h('p', { class: 'resource-lede' }, 'Unified diff vs HEAD for the current workspace.')),
  );
}

function loadingBody(): HTMLElement {
  return h('div', { class: 'diff-editor diff-empty' }, 'Loading diff…');
}

export function emptyBody(): HTMLElement {
  return h('div', { class: 'diff-editor diff-empty' }, 'No changes.');
}

export function errorBody(msg: string): HTMLElement {
  return h('div', { class: 'diff-editor' },
    h('div', { class: 'diff-err' }, msg));
}

/* one file's patch, as the 4-column grid. Exported because the commit detail
   page renders a patch per changed file with the same rows. */
export function diffBody(file: GitFileDiff | null, filePath: string): HTMLElement {
  if (!file || !file.patch) return emptyBody();
  const parsed = parseUnifiedDiff(file.patch);
  if (!parsed.length) return emptyBody();
  const lang = detectLang(filePath);
  const root = h('div', { class: 'diff-editor' });
  for (const l of parsed) root.append(lineRow(l, lang));
  return root;
}

export function diffPage(workspaceId: string, filePath: string, staged = false): HTMLElement {
  const wrap = h('div', { class: 'page diff-page' });
  const slot = h('div', {});
  /* the diff lives in its own titlebar tab — going back just closes that
     tab; closeTab() re-activates the previous tab, or the agents page when
     it was the last one */
  const onBack = (): void => {
    if (ui.activeTab && ui.route.view === 'diff') void closeTab(ui.activeTab);
    else go({ view: 'welcome' });
  };
  wrap.append(buildHeader(filePath + (staged ? ' (staged)' : ''), onBack), slot);

  /* load on mount; render loading state synchronously so the user gets
     immediate feedback even if git takes a few hundred ms. */
  slot.append(loadingBody());

  void (async () => {
    try {
      const d = await api.gitDiff(workspaceId, filePath, staged);
      slot.innerHTML = '';
      if (!d.isRepo) {
        slot.append(errorBody('Not a git repository.'));
        return;
      }
      const file = d.files[0] ?? null;
      slot.append(diffBody(file, filePath));
    } catch (e: unknown) {
      slot.innerHTML = '';
      slot.append(errorBody(e instanceof Error ? e.message : String(e)));
    }
  })();

  return wrap;
}
